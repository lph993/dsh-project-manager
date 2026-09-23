/**
 * 工作区文件遍历与快照排除规则（纯逻辑，§7.5 / §9.2b）。
 *
 * 这一层刻意**不碰文件系统**：只负责"该看哪些路径、该跳过什么、快照能不能建"的判定，
 * 因此可以完全单测。真正的 IO 在 `src/adapter/workspace.ts`。
 *
 * 排除规则（§7.5）：`.pm/`（事实源自身 + snapshots/ + wal/）、`.git`、`node_modules`、
 * 构建产物目录。**排除 `.pm/` 是硬要求**：否则快照会吞掉存储自身，回滚越滚越大。
 */

/** 快照原因（与存储 schema 的枚举一致）。 */
export type SnapshotReason = 'pause' | 'hold' | 'manual' | 'pre-rollback';

/** 快照档位。 */
export type SnapshotMode = 'git' | 'patch' | 'full';

/** 辅助层：git 档下记录"未跟踪文件"的方式。 */
export type SnapshotAux = 'patch' | 'none';

/** 默认排除目录名（任一层级出现即排除）。 */
export const EXCLUDED_DIR_NAMES: readonly string[] = [
  '.git',
  '.pm',
  'node_modules',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.DS_Store',
];

/** 单文件大小上限：超过则不纳入快照（避免把大二进制仓库吃进来）。 */
export const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;

/** 快照文件总数上限：超过则拒绝建点（宁可拒绝也不做半截快照）。 */
export const MAX_SNAPSHOT_FILES = 20000;

/**
 * 判断一个**工作区相对路径**是否应被快照排除。
 *
 * @param relativePath 形如 `src/foo/bar.ts`（分隔符统一为 `/`）
 */
export function isExcludedPath(relativePath: string): boolean {
  if (relativePath === '' || relativePath === '.') return true;
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (EXCLUDED_DIR_NAMES.includes(segment)) return true;
  }
  // 编辑器交换文件与常见二进制产物
  const last = segments[segments.length - 1] ?? '';
  if (last.endsWith('.swp') || last.endsWith('.swo') || last.endsWith('~')) return true;
  if (last === 'project-manager.md.tmp') return true;
  return false;
}

/** 判断路径是否落在某个子树下（用于"永不回滚事实源/快照目录"的判定）。 */
export function isWithin(relativePath: string, prefix: string): boolean {
  if (prefix === '') return true;
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return relativePath === prefix || relativePath.startsWith(normalized);
}

/** 文件是否可纳入快照（大小与类型门槛）。 */
export function isSnapshotableFile(input: {
  relativePath: string;
  sizeBytes: number;
}): boolean {
  if (isExcludedPath(input.relativePath)) return false;
  if (input.sizeBytes > MAX_SNAPSHOT_FILE_BYTES) return false;
  return true;
}

/** 单个文件在快照中的记录。内容按需存放（未变化文件不重复存）。 */
export interface SnapshotFileEntry {
  /** 工作区相对路径（`/` 分隔）。 */
  path: string;
  /** 内容哈希（用于跳过未变化文件与比对 diff）。 */
  hash: string;
  sizeBytes: number;
  /** 内容；**仅当内容与当前磁盘不同**时才需要存放（按需内联，见 buildManifest）。 */
  content?: string;
}

/** diff 与哈希只需要 (path, hash)；清单条目是它的超集。 */
export interface FileHashEntry {
  path: string;
  hash: string;
}

/** 一份文件清单（快照的骨架）。 */
export interface FileManifest {
  files: SnapshotFileEntry[];
  /** 清单整体哈希，用于"内容无变化 → 跳过建点"的判定。 */
  manifestHash: string;
  /** 被排除/跳过的文件数（诚实交代，FR-126）。 */
  skipped: number;
  /** 清单是否因规模上限被截断（截断即视为不完整，不允许建点）。 */
  truncated: boolean;
}

/**
 * 由文件条目算出清单哈希。
 *
 * 只依赖 (path, hash) 排序后的拼接，因此与遍历顺序无关、可复现。
 */
export function computeManifestHash(
  entries: ReadonlyArray<{ path: string; hash: string }>,
): string {
  const parts = entries
    .map((entry) => `${entry.path}\u0000${entry.hash}`)
    .sort()
    .join('\n');
  return fnv1a64(parts);
}

/**
 * 内容哈希：FNV-1a 64 位（BigInt 实现）。
 *
 * 为什么不用 node:crypto：领域层要能被 Host 与 Client 两侧编译（§12.4 不变量 6），
 * 而 `node:crypto` 在浏览器里要用 `crypto.subtle`（异步）。这里只需要"变更检测"，
 * 不需要密码学强度，自实现一个确定性哈希即可。
 */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 判定两清单之间"新增/修改/删除"的文件（回滚差异计算的输入之一）。 */
export interface ManifestDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

/** 只依赖 (path, hash) 的清单形态（`FileManifest` 是它的超集）。 */
export interface HashManifest {
  files: ReadonlyArray<FileHashEntry>;
}

export function diffManifests(before: HashManifest, after: HashManifest): ManifestDiff {
  const beforeMap = new Map(before.files.map((f) => [f.path, f.hash]));
  const afterMap = new Map(after.files.map((f) => [f.path, f.hash]));
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of afterMap) {
    const previous = beforeMap.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== hash) modified.push(path);
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(path);
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
  };
}

// ── 建点节流（§9.2b：哈希无变化或 60s 内重复则跳过不建）────────────

/** 同一节点的建点最小间隔（毫秒）。 */
export const SNAPSHOT_THROTTLE_MS = 60_000;

/** 一次建点决策的输入。 */
export interface SnapshotDecisionInput {
  /** 该节点是否已有**有效**回滚点（FR-61 首次执行前建点用）。 */
  hasValidPoint: boolean;
  /** 上一点的清单哈希（用于内容无变化判定）。 */
  lastManifestHash: string | undefined;
  /** 本次清单哈希。 */
  currentManifestHash: string;
  /** 上一点的建立时间（ISO）。 */
  lastCreatedAt: string | undefined;
  /** 当前时间（ISO）。 */
  now: string;
  /** 是否强制建点（手动「打回滚点」与暂停/拦停时为 true）。 */
  force: boolean;
}

/** 建点决策。 */
export type SnapshotDecision =
  | { create: true; reason: string }
  | { create: false; reason: string };

/**
 * 决定是否建点（纯函数）。
 *
 * 规则（§9.2b）：
 * - `force`（手动/暂停/拦停）→ 建；
 * - 已有有效点且内容未变化 → 跳过（不产生冗余快照）；
 * - 距上一点 < 60s → 节流跳过；
 * - 其余 → 建。
 */
export function decideSnapshot(input: SnapshotDecisionInput): SnapshotDecision {
  if (input.force) return { create: true, reason: '显式请求（手动/暂停/拦停）' };
  if (input.hasValidPoint && input.lastManifestHash === input.currentManifestHash) {
    return { create: false, reason: '工作区自上次快照以来无变化，跳过建点' };
  }
  if (input.lastCreatedAt !== undefined) {
    const elapsed = Date.parse(input.now) - Date.parse(input.lastCreatedAt);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < SNAPSHOT_THROTTLE_MS) {
      return {
        create: false,
        reason: `距上次建点不足 ${Math.round(SNAPSHOT_THROTTLE_MS / 1000)}s，节流跳过`,
      };
    }
  }
  return { create: true, reason: input.hasValidPoint ? '内容已变化' : '该节点尚无有效回滚点' };
}

// ── 容量治理（§7.5：容量为主、份数为兜底）──────────────────────────

/** 单快照体积判定的结果（§7.5 / FR-88）。 */
export interface SingleSnapshotVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * 单个快照是否超出体积上限。
 *
 * **全量档（`full`）豁免**：它是"没有 git 兜底"时最稳的一档，拿单体上限卡它
 * 等于让大工作区永远用不上最稳档；此时只受**总占用**上限约束（见 `planCleanup`）。
 *
 * 抽成纯函数是为了能单测——这条规则此前只在领域层声明了常量、**没有任何地方执行**，
 * 于是"全量档例外"一直是句空话（实测核对时发现的）。
 */
export function checkSingleSnapshotLimit(input: {
  mode: 'git' | 'patch' | 'full';
  sizeBytes: number;
  limit: number;
}): SingleSnapshotVerdict {
  if (input.mode === 'full') return { ok: true };
  if (input.sizeBytes <= input.limit) return { ok: true };
  const mb = (value: number): number => Math.round(value / 1024 / 1024);
  return {
    ok: false,
    reason:
      `单个快照 ${mb(input.sizeBytes)} MB 超过上限 ${mb(input.limit)} MB。` +
      '可改用 git 档（增量、体积小），或在设置里提高上限 / 切到全量档（全量档豁免单体上限）。',
  };
}

/** 快照容量与保留参数（与设置项 FR-88 对应）。 */
export interface SnapshotCapacity {
  /** 总占用上限（字节），默认 1 GB。 */
  totalBytesLimit: number;
  /** 份数兜底上限，默认 200。 */
  countLimit: number;
  /** 单快照体积上限（字节），默认 100 MB。 */
  singleBytesLimit: number;
}

export const DEFAULT_SNAPSHOT_CAPACITY: SnapshotCapacity = {
  totalBytesLimit: 1024 * 1024 * 1024,
  countLimit: 200,
  singleBytesLimit: 100 * 1024 * 1024,
};

/** 清理决策所需的快照元信息（不携带内容，便于纯函数判定）。 */
export interface SnapshotMeta {
  snapshotId: string;
  nodeIds: string[];
  reason: SnapshotReason;
  sizeBytes: number;
  createdAt: string;
  /** 每个被覆盖节点当前是否仍未完成（未完成 → 其最新点永不清理）。 */
  coversUnfinishedNode: boolean;
  /** 覆盖的节点是否已被删除或已回滚（优先清理）。 */
  coversRemovedOrRolledBack: boolean;
}

/** 清理决策结果。 */
export interface CleanupPlan {
  /** 建议清理的 id（按优先级从先到后）。 */
  evict: string[];
  /** 清理后预计占用。 */
  projectedBytes: number;
  /** 是否仍超限且无可清理（此时应停止建点并告警）。 */
  stillOverLimit: boolean;
  /** 是否触发 80% 告警。 */
  warn: boolean;
}

/**
 * 计算清理计划（纯函数，§7.5 清理优先级）。
 *
 * 优先级（从先到后）：
 * ① 已删除/已回滚节点的历史点 → ② 已完成节点的中点（保留每枝最新一个）
 * → ③ 已完成节点的最旧点 → ④ 暂停/拦停点（保留最新）
 *
 * **永不清理**：每个未完成节点的最新回滚点、`pre-rollback` 快照。
 */
export function planCleanup(
  snapshots: readonly SnapshotMeta[],
  capacity: SnapshotCapacity,
): CleanupPlan {
  const mustKeep = new Set<string>();
  // 永不清理：每个未完成节点的最新点 + 所有 pre-rollback
  const byNodeNewest = newestPerNode(snapshots);
  for (const meta of snapshots) {
    if (meta.reason === 'pre-rollback') mustKeep.add(meta.snapshotId);
    if (meta.coversUnfinishedNode) {
      for (const nodeId of meta.nodeIds) {
        if (byNodeNewest.get(nodeId) === meta.snapshotId) mustKeep.add(meta.snapshotId);
      }
    }
  }

  let total = snapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
  const evict: string[] = [];

  const overLimit = total > capacity.totalBytesLimit || snapshots.length > capacity.countLimit;
  if (!overLimit) {
    return {
      evict,
      projectedBytes: total,
      stillOverLimit: false,
      warn: total >= capacity.totalBytesLimit * 0.8,
    };
  }

  const candidates = (predicate: (meta: SnapshotMeta) => boolean): SnapshotMeta[] =>
    snapshots
      .filter((meta) => !mustKeep.has(meta.snapshotId) && !evict.includes(meta.snapshotId))
      .filter(predicate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const stages: Array<(meta: SnapshotMeta) => boolean> = [
    // ① 已删除/已回滚节点的历史点
    (meta) => meta.coversRemovedOrRolledBack,
    // ② 已完成节点的中点：保留每枝最新一个 → 这里按"较早的已完成点"清
    (meta) => !meta.coversUnfinishedNode,
    // ③ 其余（含暂停/拦停点）：最旧优先
    () => true,
  ];

  for (const stage of stages) {
    for (const meta of candidates(stage)) {
      if (total <= capacity.totalBytesLimit && snapshots.length - evict.length <= capacity.countLimit) {
        break;
      }
      evict.push(meta.snapshotId);
      total -= meta.sizeBytes;
    }
  }

  return {
    evict,
    projectedBytes: total,
    stillOverLimit: total > capacity.totalBytesLimit || snapshots.length - evict.length > capacity.countLimit,
    warn: total >= capacity.totalBytesLimit * 0.8,
  };
}

/** 每个节点的最新快照 id。 */
function newestPerNode(snapshots: readonly SnapshotMeta[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const meta of snapshots) {
    for (const nodeId of meta.nodeIds) {
      const current = out.get(nodeId);
      if (current === undefined) {
        out.set(nodeId, meta.snapshotId);
        continue;
      }
      const currentMeta = snapshots.find((s) => s.snapshotId === current);
      if (!currentMeta || meta.createdAt > currentMeta.createdAt) out.set(nodeId, meta.snapshotId);
    }
  }
  return out;
}

// ── 回滚范围裁决（§9.2b / FR-66/69）────────────────────────────────

/** 回滚范围。 */
export type RollbackScope = 'code' | 'state' | 'both';

/** 单节点回滚的文件选择结果。 */
export interface RollbackFilePlan {
  /** 需要还原的文件（已剔除共享文件）。 */
  restore: string[];
  /** 因属于多节点共享而被拦下的文件（需二次确认，FR-69）。 */
  sharedBlocked: string[];
  /** 永不还原的路径（事实源与快照目录，FR-69d）。 */
  neverRestore: string[];
}

/**
 * 决定一次单节点回滚要还原哪些文件。
 *
 * @param touched 该节点记录的 touchedPaths（优先级 1 来源）
 * @param sharedPaths 被多个节点写过的路径（需二次确认）
 * @param manifestChanged 快照与当前的 diff（优先级 2 来源）
 * @param confirmedShared 用户是否已确认"连共享文件一起还原"
 */
export function planRollbackFiles(input: {
  touched: readonly string[];
  sharedPaths: readonly string[];
  manifestChanged: readonly string[];
  confirmedShared: boolean;
}): RollbackFilePlan {
  const neverRestore = ['.pm', '.pm/snapshots', '.pm/wal'];
  const inNever = (path: string): boolean => neverRestore.some((prefix) => isWithin(path, prefix));

  const candidates = new Set<string>();
  for (const path of input.touched) candidates.add(path);
  // 优先级 3：无从属记录时也不猜测归属 —— 只在有 touchedPaths 为空时才退化为清单 diff
  if (input.touched.length === 0) {
    for (const path of input.manifestChanged) candidates.add(path);
  }
  // 无论哪条来源，事实源与快照目录都不还原
  for (const path of input.manifestChanged) {
    if (inNever(path)) candidates.delete(path);
  }

  const shared = new Set(input.sharedPaths);
  const restore: string[] = [];
  const sharedBlocked: string[] = [];
  const never: string[] = [];

  for (const path of candidates) {
    if (inNever(path)) {
      never.push(path);
      continue;
    }
    if (isExcludedPath(path)) continue;
    if (shared.has(path) && !input.confirmedShared) {
      sharedBlocked.push(path);
      continue;
    }
    restore.push(path);
  }

  return {
    restore: restore.sort(),
    sharedBlocked: sharedBlocked.sort(),
    neverRestore: never.sort(),
  };
}

/** 回滚后节点状态口径（§9.2b）：回到快照点记录的状态；缺失则回落 pending。 */
export function rollbackNodeState(
  recorded:
    | { selfState: string; progress: number; gate: string | null }
    | undefined,
): { selfState: string; progress: number; gate: string | null } {
  if (!recorded) return { selfState: 'pending', progress: 0, gate: null };
  return {
    selfState: recorded.selfState,
    progress: recorded.progress,
    gate: recorded.gate,
  };
}

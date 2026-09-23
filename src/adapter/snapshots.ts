/**
 * 快照管理器（§7.5 / §9.2b / §6.6b）。
 *
 * 职责边界：
 * - **何时建点**：`domain/snapshot.ts` 的 `decideSnapshot`（纯函数，已单测）
 * - **建什么**：本文件把"工作区文件清单 + 节点状态"打包为 `SnapshotContent`
 * - **怎么还原**：`domain/snapshot.ts` 的 `planRollbackFiles` 决定范围，
 *   本文件执行写盘与节点状态回写
 * - **容量**：`planCleanup` 决定清理谁，本文件执行删除（索引 + 内容文件）
 *
 * 诚实边界（§0.1，必须写进确认框）：只覆盖**已记录路径与工作区 diff**；
 * 外部进程、其他工具、用户手动改动产生的副作用不在覆盖范围内。
 */

import type { Gate, GraphSnapshot, NodeRecord, SelfState } from '../shared/types.ts';
import {
  DEFAULT_SNAPSHOT_CAPACITY,
  decideSnapshot,
  diffManifests,
  planCleanup,
  planRollbackFiles,
  type RollbackScope,
  type SnapshotCapacity,
  type SnapshotMeta,
  type SnapshotMode,
  type SnapshotReason,
} from '../domain/snapshot.ts';
import type { Clock, RandomSource } from '../domain/mutate.ts';
import type { StoragePort } from '../storage/port.ts';
import type { SnapshotRecord } from '../storage/schema.ts';
import {
  deleteSnapshotContent,
  deleteWorkspaceFile,
  readSnapshotContent,
  walkWorkspace,
  writeSnapshotContent,
  writeWorkspaceFile,
  type SnapshotContent,
} from './workspace.ts';
import {
  SNAPSHOT_REF_PREFIX,
  gitCapture,
  gitDeleteSnapshotRef,
  gitDiffAgainstTree,
  gitRefReachable,
  gitRemovePaths,
  gitRestorePaths,
  gitTreePaths,
} from './git.ts';

/** 建点结果。 */
export interface CaptureResult {
  created: boolean;
  snapshotId?: string;
  reason: string;
  /** 覆盖的文件数（供确认框展示）。 */
  fileCount?: number;
  /** 被排除/跳过的文件数（诚实交代）。 */
  skipped?: number;
  sizeBytes?: number;
  /** 清理掉的旧快照数量。 */
  evicted?: number;
  /** 是否因容量超限而停止建点。 */
  capacityBlocked?: boolean;
}

/** 回滚结果。 */
export interface RollbackResult {
  ok: boolean;
  reason: string;
  /** 被还原的文件。 */
  restoredFiles: string[];
  /** 被删除的文件（快照中不存在 → 该文件是后来新增的）。 */
  deletedFiles: string[];
  /** 被重置的节点数。 */
  resetNodes: number;
  /** 因共享而未还原的文件（需二次确认）。 */
  sharedBlocked: string[];
  /** 回滚前的现场快照 id（用于撤销）。 */
  preRollbackSnapshotId?: string;
}

export interface SnapshotManagerDeps {
  port: StoragePort;
  clock: Clock;
  random: RandomSource;
  projectId: string;
  workspaceRoot: string;
  /** 档位偏好（`auto` 时由 adapter 裁决后传入实际档位）。 */
  mode: SnapshotMode;
  /** 档位裁决原因（看板与设置页展示，FR-89d）。 */
  modeReason?: string;
  reason?: string;
  capacity?: SnapshotCapacity;
}

export class SnapshotManager {
  private readonly port: StoragePort;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly projectId: string;
  private readonly workspaceRoot: string;
  private readonly mode: SnapshotMode;
  private readonly modeReason: string;
  private readonly capacity: SnapshotCapacity;

  constructor(deps: SnapshotManagerDeps) {
    this.port = deps.port;
    this.clock = deps.clock;
    this.random = deps.random;
    this.projectId = deps.projectId;
    this.workspaceRoot = deps.workspaceRoot;
    this.mode = deps.mode;
    this.modeReason = deps.modeReason ?? '由能力探测裁决';
    this.capacity = deps.capacity ?? DEFAULT_SNAPSHOT_CAPACITY;
  }

  get snapshotMode(): SnapshotMode {
    return this.mode;
  }

  get snapshotModeReason(): string {
    return this.modeReason;
  }

  /** 该节点最近一次有效回滚点（按时间最新）。 */
  async latestFor(nodeId: string): Promise<SnapshotRecord | undefined> {
    const all = await this.port.listSnapshots(this.projectId);
    const mine = all.filter((s) => s.nodeIds.includes(nodeId));
    return mine.length === 0 ? undefined : mine[mine.length - 1];
  }

  /**
   * 建点（§6.6b）。
   *
   * @param force 手动「打回滚点」与暂停/拦停时为 true（绕过节流与"无变化"判定）
   */
  async capture(input: {
    graph: GraphSnapshot;
    nodeIds: readonly string[];
    reason: SnapshotReason;
    force: boolean;
    /** 该节点是否仍未完成（决定其最新点不可清理）。 */
    coversUnfinishedNode: boolean;
  }): Promise<CaptureResult> {
    const existing = await this.port.listSnapshots(this.projectId);
    const relevant = existing.filter((s) =>
      input.nodeIds.some((id) => s.nodeIds.includes(id)),
    );
    const last = relevant[relevant.length - 1];

    // 两种档位的"内容载体"不同：
    // - git 档：树对象（尊重 .gitignore，二进制文件也能进）
    // - 补丁档：全量文本清单（排除表 + NUL 二进制探测）
    // 节流判定用的"上次清单哈希"必须从**记录**里读（`manifestHash` 列），
    // 否则"无变化跳过"永远失效（曾因此每次建点）。
    const walked = await walkWorkspace(this.workspaceRoot);
    if (walked.manifest.truncated) {
      return {
        created: false,
        reason: '工作区文件数超过快照上限，已拒绝建点（宁可拒绝也不做半截快照）',
      };
    }
    const currentManifestHash = walked.manifest.manifestHash;

    const decision = decideSnapshot({
      hasValidPoint: last !== undefined,
      lastManifestHash: last?.manifestHash,
      currentManifestHash,
      lastCreatedAt: last?.createdAt,
      now: this.clock.now(),
      force: input.force,
    });
    if (!decision.create) return { created: false, reason: decision.reason };

    const snapshotId = `snap_${this.clock.now().replace(/[:.]/g, '-')}_${this.random.uuid().slice(0, 8)}`;
    const nodeState: SnapshotContent['nodeState'] = {};
    for (const nodeId of input.nodeIds) {
      const node = input.graph.nodes[nodeId];
      if (!node) continue;
      nodeState[nodeId] = {
        selfState: node.selfState,
        progress: node.progress,
        gate: node.gate,
      };
    }

    // ── git 档：先建 git 树/ref，再写索引记录 ─────────────────────
    if (this.mode === 'git') {
      const captured = await gitCapture({
        cwd: this.workspaceRoot,
        snapshotId,
        message: `pm snapshot ${snapshotId} (${input.reason})`,
      });
      if (!captured.ok) {
        // git 档失败 → 明确失败，不静默降级为"没有快照"（否则回滚能力会静默失效）
        return {
          created: false,
          reason: `git 档建点失败：${captured.reason ?? '未知原因'}（可改用补丁档）`,
        };
      }
      const record: SnapshotRecord = {
        snapshotId,
        projectId: this.projectId,
        nodeIds: [...input.nodeIds],
        reason: input.reason,
        mode: 'git',
        aux: 'patch',
        auxPaths: [],
        ref: captured.ref ?? `${SNAPSHOT_REF_PREFIX}/${snapshotId}`,
        ...(captured.tree !== undefined ? { tree: captured.tree } : {}),
        manifestHash: currentManifestHash,
        touchedPaths: collectTouched(input.graph, input.nodeIds),
        sharedPaths: collectShared(input.graph, input.nodeIds),
        nodeState,
        sizeBytes: 0,
        createdAt: this.clock.now(),
        createdBy: 'user',
      };
      await this.port.putSnapshot(record);
      const cleanup = await this.prune();
      return {
        created: true,
        snapshotId,
        reason: decision.reason,
        fileCount: captured.fileCount ?? 0,
        skipped: walked.manifest.skipped ?? 0,
        sizeBytes: 0,
        evicted: cleanup.evicted,
        capacityBlocked: cleanup.stillOverLimit,
      };
    }

    const content: SnapshotContent = {
      snapshotId,
      createdAt: this.clock.now(),
      files: walked.manifest.files
        .map((file) => ({
          path: file.path,
          hash: file.hash,
          content: walked.contents.get(file.path) ?? '' ,
        }))
        .filter((file) => file.content !== ''),
      nodeState,
      manifestHash: currentManifestHash,
    };

    const written = await writeSnapshotContent(this.workspaceRoot, content);
    const record: SnapshotRecord = {
      snapshotId,
      projectId: this.projectId,
      nodeIds: [...input.nodeIds],
      reason: input.reason,
      mode: this.mode,
      // 走到这里说明不是 git 档（git 档在上面提前 return 了），因此没有辅助层。
      aux: 'none',
      auxPaths: [],
      ref: written.ref,
      manifestHash: currentManifestHash,
      touchedPaths: collectTouched(input.graph, input.nodeIds),
      sharedPaths: collectShared(input.graph, input.nodeIds),
      nodeState,
      sizeBytes: written.sizeBytes,
      createdAt: content.createdAt,
      createdBy: 'user',
    };
    await this.port.putSnapshot(record);

    // 容量治理：超限时按优先级清理；无可清理则停止建点并告警（§7.5）
    const cleanup = await this.prune();

    return {
      created: true,
      snapshotId,
      reason: decision.reason,
      fileCount: content.files.length,
      skipped: walked.manifest.skipped,
      sizeBytes: written.sizeBytes,
      evicted: cleanup.evicted,
      capacityBlocked: cleanup.stillOverLimit,
    };
  }

  /** 容量治理：返回清理结果。 */
  async prune(): Promise<{ evicted: number; stillOverLimit: boolean; warn: boolean }> {
    const all = await this.port.listSnapshots(this.projectId);
    const unfinishedNodes = await this.unfinishedNodeIds();
    const metas: SnapshotMeta[] = all.map((s) => ({
      snapshotId: s.snapshotId,
      nodeIds: s.nodeIds,
      reason: s.reason,
      sizeBytes: s.sizeBytes,
      createdAt: s.createdAt,
      coversUnfinishedNode: s.nodeIds.some((id) => unfinishedNodes.has(id)),
      coversRemovedOrRolledBack: false,
    }));
    const plan = planCleanup(metas, this.capacity);
    for (const snapshotId of plan.evict) {
      const record = all.find((s) => s.snapshotId === snapshotId);
      if (record) {
        if (record.mode === 'git') {
          // 清理前置动作顺序写死：先摘 refs/pm/keep 再删 ref，否则 keep 让对象永久可达、清理无效
          await gitDeleteSnapshotRef({ cwd: this.workspaceRoot, snapshotId: record.snapshotId });
        } else {
          await deleteSnapshotContent(this.workspaceRoot, record.ref);
        }
      }
      await this.port.deleteSnapshot(snapshotId);
    }
    return { evicted: plan.evict.length, stillOverLimit: plan.stillOverLimit, warn: plan.warn };
  }

  /** 补丁档的差异计算：清单哈希比对。 */
  private async patchDiff(content: SnapshotContent): Promise<{
    added: string[];
    modified: string[];
    removed: string[];
  }> {
    const current = await walkWorkspace(this.workspaceRoot);
    return diffManifests(
      { files: content.files.map((f) => ({ path: f.path, hash: f.hash })) },
      current.manifest,
    );
  }

  /** 未完成节点 id（其最新回滚点永不清理）。 */
  private async unfinishedNodeIds(): Promise<Set<string>> {
    const graph = await this.port.readGraph(this.projectId);
    const out = new Set<string>();
    if (!graph) return out;
    for (const node of Object.values(graph.nodes)) {
      if (node.selfState !== 'done' && node.selfState !== 'removed') out.add(node.id);
    }
    return out;
  }

  /**
   * 回滚到某个快照（§9.2b / FR-62–69）。
   *
   * @param nodeIds 本次回滚覆盖的节点（整枝回滚 = 该枝全部子孙；缺省为 `[nodeId]`）。
   *   文件集合取这些节点 refs 的**并集**，节点状态重置覆盖 `record.nodeState` 里出现的所有节点。
   * @param confirmShared 触碰共享文件时**必须**二次确认（FR-69）
   */
  async rollback(input: {
    graph: GraphSnapshot;
    nodeId: string;
    nodeIds?: readonly string[];
    snapshotId?: string;
    scope: RollbackScope;
    confirmShared: boolean;
  }): Promise<RollbackResult> {
    const record = input.snapshotId
      ? await this.port.getSnapshot(input.snapshotId)
      : await this.latestFor(input.nodeId);
    if (!record) {
      return {
        ok: false,
        reason: '该节点尚无回滚点（无可用锚点，菜单项不应显示）',
        restoredFiles: [],
        deletedFiles: [],
        resetNodes: 0,
        sharedBlocked: [],
      };
    }
    // 覆盖面：缺省只含自己；整枝回滚传整枝。始终把 nodeId 自己算进去。
    const covered = [...new Set([input.nodeId, ...(input.nodeIds ?? [])])];

    // 内容载体依档位不同：git 档是树对象，补丁档是快照内容文件。
    const isGitTier = record.mode === 'git' && typeof record.tree === 'string';
    const content = isGitTier ? undefined : await readSnapshotContent(this.workspaceRoot, record.ref);
    if (!isGitTier && !content) {
      return {
        ok: false,
        reason: `快照内容不可读（可能已被清理或损坏）：${record.ref}`,
        restoredFiles: [],
        deletedFiles: [],
        resetNodes: 0,
        sharedBlocked: [],
      };
    }

    // ① 回滚前先备份现场（FR-65：支持"撤销这次回滚"）
    const preCapture = await this.capture({
      graph: input.graph,
      nodeIds: covered,
      reason: 'pre-rollback',
      force: true,
      coversUnfinishedNode: true,
    });

    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];

    if (input.scope !== 'state') {
      // 差异来源：git 档由 git 算（且**必须**带 intent-to-add，否则漏掉未跟踪文件）；
      // 补丁档由清单哈希比对算。两支分开写，避免联合类型在分支里失去判别。
      let changedPaths: string[] = [];
      let addedPaths: string[] = [];
      let gitTree: string | undefined;

      if (isGitTier) {
        gitTree = record.tree as string;
        const gitDiff = await gitDiffAgainstTree({ cwd: this.workspaceRoot, tree: gitTree });
        if (!gitDiff.ok) {
          return {
            ok: false,
            reason: `git 档无法计算差异：${gitDiff.reason ?? '未知原因'}`,
            restoredFiles: [],
            deletedFiles: [],
            resetNodes: 0,
            sharedBlocked: [],
          };
        }
        changedPaths = gitDiff.changed;
        addedPaths = gitDiff.added;
      } else {
        const patchDiff = await this.patchDiff(content as SnapshotContent);
        changedPaths = patchDiff.modified;
        addedPaths = patchDiff.added;
      }

      // 触碰过的文件 = 覆盖节点 refs 的并集（整枝回滚必须把整枝的文件都算进来，
      // 否则"整枝回滚"只会还原枝根自己那几个文件 —— 那是半截回滚）
      const touched = [
        ...new Set(
          covered.flatMap((id) => input.graph.nodes[id]?.refs?.map((r) => r.target) ?? []),
        ),
      ];
      const plan = planRollbackFiles({
        touched,
        sharedPaths: record.sharedPaths,
        manifestChanged: [...changedPaths, ...addedPaths],
        confirmedShared: input.confirmShared,
      });
      if (plan.sharedBlocked.length > 0) {
        return {
          ok: false,
          reason: `有 ${plan.sharedBlocked.length} 个文件被多个节点写过，需二次确认后才能还原`,
          restoredFiles: [],
          deletedFiles: [],
          resetNodes: 0,
          sharedBlocked: plan.sharedBlocked,
          ...(preCapture.snapshotId !== undefined
            ? { preRollbackSnapshotId: preCapture.snapshotId }
            : {}),
        };
      }

      if (isGitTier) {
        // 只还原**快照里确实存在**的路径：差异集合里的"新增文件"不在树里，
        // 交给 `git checkout <tree> -- <path>` 会报 pathspec 错误（实测踩过）。
        // 求交集的代价是一次 ls-tree，换来还原的确定性。
        const treePaths = new Set(await gitTreePaths(this.workspaceRoot, gitTree as string));
        const restoreThese = plan.restore.filter((path) => treePaths.has(path));
        const toRemove = addedPaths.filter((path) => !plan.neverRestore.includes(path));

        if (restoreThese.length > 0) {
          const restore = await gitRestorePaths({
            cwd: this.workspaceRoot,
            tree: gitTree as string,
            paths: restoreThese,
          });
          if (!restore.ok) {
            return {
              ok: false,
              reason: `git 档还原失败：${restore.reason ?? '未知原因'}`,
              restoredFiles: [],
              deletedFiles: [],
              resetNodes: 0,
              sharedBlocked: [],
            };
          }
          restoredFiles.push(...restoreThese);
        }
        if (toRemove.length > 0) {
          await gitRemovePaths({ cwd: this.workspaceRoot, paths: toRemove });
          deletedFiles.push(...toRemove);
        }
      } else {
        const byPath = new Map((content as SnapshotContent).files.map((f) => [f.path, f.content]));
        for (const path of plan.restore) {
          const text = byPath.get(path);
          if (text === undefined) {
            // 快照里没有 → 该文件是快照之后新增的，回滚即删除
            await deleteWorkspaceFile(this.workspaceRoot, path);
            deletedFiles.push(path);
          } else {
            await writeWorkspaceFile(this.workspaceRoot, path, text);
            restoredFiles.push(path);
          }
        }
      }
    }

    // ② 节点状态回到快照点记录的状态（FR-67）
    // 节点状态始终记在**索引记录**的 `nodeState` 里（两种档位都有），
    // 因此这里不依赖补丁档的内容文件 —— git 档下 `content` 本来就是 undefined。
    let resetNodes = 0;
    if (input.scope !== 'code') {
      // 整枝回滚要数**覆盖范围内**真正被重置的节点数，而不是"有没有 nodeState"的 0/1
      resetNodes = covered.filter((id) => record.nodeState[id] !== undefined).length;
    }

    return {
      ok: true,
      reason: `已还原 ${restoredFiles.length} 个文件、删除 ${deletedFiles.length} 个新增文件、重置 ${resetNodes} 个节点状态`,
      restoredFiles,
      deletedFiles,
      resetNodes,
      sharedBlocked: [],
      ...(preCapture.snapshotId !== undefined
        ? { preRollbackSnapshotId: preCapture.snapshotId }
        : {}),
    };
  }

  /** 撤销上一次回滚：用 `pre-rollback` 快照还原（FR-65）。 */
  async undoRollback(input: {
    graph: GraphSnapshot;
    nodeId: string;
  }): Promise<RollbackResult> {
    const all = await this.port.listSnapshots(this.projectId);
    const pre = [...all].reverse().find(
      (s) => s.reason === 'pre-rollback' && s.nodeIds.includes(input.nodeId),
    );
    if (!pre) {
      return {
        ok: false,
        reason: '没有可用的 `pre-rollback` 快照，无法撤销回滚',
        restoredFiles: [],
        deletedFiles: [],
        resetNodes: 0,
        sharedBlocked: [],
      };
    }
    return this.rollback({
      graph: input.graph,
      nodeId: input.nodeId,
      snapshotId: pre.snapshotId,
      scope: 'both',
      confirmShared: true,
    });
  }

  /** 列出某节点的可用回滚点（`pm_snapshots`）。 */
  async list(nodeId: string): Promise<SnapshotRecord[]> {
    const all = await this.port.listSnapshots(this.projectId);
    return all.filter((s) => s.nodeIds.includes(nodeId));
  }

  /**
   * 快照可达性自检（FR-89b）：检查索引项在磁盘上是否仍可读。
   *
   * 只回答"能不能读回来"——这是 gc/误删唯一会静默失效的地方，
   * 也正是最需要提前发现的那类损坏（等真要回滚时才发现就晚了）。
   */
  async checkReachability(): Promise<{
    total: number;
    orphaned: Array<{ snapshotId: string; ref: string; reason: string }>;
  }> {
    const all = await this.port.listSnapshots(this.projectId);
    const orphaned: Array<{ snapshotId: string; ref: string; reason: string }> = [];
    for (const record of all) {
      if (record.mode === 'git') {
        // git 档：ref 必须仍可解析（被 gc 回收时这里会报出来）
        const reachable = await gitRefReachable({ cwd: this.workspaceRoot, ref: record.ref });
        if (!reachable.reachable) {
          orphaned.push({
            snapshotId: record.snapshotId,
            ref: record.ref,
            reason: 'git ref 不可解析（可能被 gc 回收，或仓库已变动）',
          });
        }
        continue;
      }
      const content = await readSnapshotContent(this.workspaceRoot, record.ref);
      if (!content) {
        orphaned.push({ snapshotId: record.snapshotId, ref: record.ref, reason: '内容不可读' });
        continue;
      }
      if (Object.keys(content.nodeState).length === 0 && record.nodeIds.length > 0) {
        orphaned.push({
          snapshotId: record.snapshotId,
          ref: record.ref,
          reason: '快照未记录任何节点状态（回滚将回落 pending）',
        });
      }
    }
    return { total: all.length, orphaned };
  }
}

/** 收集整枝内的 touchedPaths（来自节点 refs 的记录，§9.2b 优先级 1）。 */
function collectTouched(graph: GraphSnapshot, nodeIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const nodeId of nodeIds) {
    const node: NodeRecord | undefined = graph.nodes[nodeId];
    for (const ref of node?.refs ?? []) out.add(ref.target);
  }
  return [...out].sort();
}

/** 被多个节点写过的路径（共享文件，FR-69 二次确认）。 */
function collectShared(graph: GraphSnapshot, nodeIds: readonly string[]): string[] {
  const ownerCount = new Map<string, Set<string>>();
  for (const node of Object.values(graph.nodes)) {
    for (const ref of node.refs ?? []) {
      const owners = ownerCount.get(ref.target) ?? new Set<string>();
      owners.add(node.id);
      ownerCount.set(ref.target, owners);
    }
  }
  const inside = new Set(nodeIds);
  const out: string[] = [];
  for (const [path, owners] of ownerCount) {
    if (owners.size > 1 && [...owners].some((id) => inside.has(id))) out.push(path);
  }
  return out.sort();
}



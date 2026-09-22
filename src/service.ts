/**
 * 项目服务（Host 面应用层）：把**纯领域层**、**存储端口**、**文档投影**与**确认通道**串起来。
 *
 * 本文件是唯一持有"可变世界"的地方：
 * - 领域函数负责判定（纯、可测）
 * - 本服务负责读快照 → 调领域 → 原子写回 → 投影文档 → 记审计
 *
 * 所有写入都经过同一入口（§12.4 不变量 2：无旁路）。
 */

import type { Context } from '@deepseek-ai/cordis';
// 纯类型导入：加载 DSH 的服务接口增补（`ctx.fs` / `ctx.storageDomain` / `ctx.settings`）。
// 这些增补写在各自包的 `.d.ts` 里，只有该模块进入编译图时才会生效。
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-settings';

import type { ConfirmRouter } from './adapter/confirm.ts';
import { resolveSnapshotMode, serviceOf, type CapabilityReport } from './adapter/capabilities.ts';
import { SnapshotManager, type CaptureResult, type RollbackResult } from './adapter/snapshots.ts';
import {
  deleteWorkspaceFile,
  listHandoffFiles,
  readWorkspaceFile,
  resolveSnapshotCapability,
  scanWorkspaceEntries,
  writeHandoffFile,
} from './adapter/workspace.ts';
import {
  HANDOFF_DIR,
  buildHandoffDocument,
  parseHandoff,
  parseHandoffFileName,
  sliceHandoffByBytes,
  type ParsedHandoffName,
  type HandoffDocument,
  type HandoffKind,
  type HandoffSupplements,
} from './domain/handoff.ts';
import { utf8ByteLength } from './shared/bytes.ts';
import { deriveGraph, statsForRoots, unfinishedLeaves, type DerivedGraph } from './domain/progress.ts';
import type { WatchEventKind } from './domain/watch.ts';
import { startWatching, type WatchEvent, type WatcherHandle } from './adapter/watcher.ts';
import { debugBus } from './adapter/debug.ts';
import {
  normalizeRootPath,
  resolveWorkspaceRoot,
  type WorkspaceRootResolution,
} from './adapter/workspace-root.ts';
import { focusedRoots, buildIndex, subtreeIds } from './domain/graph.ts';
import type { RollbackScope, SnapshotReason } from './domain/snapshot.ts';
import {
  DEFAULT_SCAN_OPTIONS,
  buildSuggestedTree,
  type ScanOptions,
  type ScanResult,
  type SuggestedNode,
} from './domain/scanner.ts';

/** 扫描默认排除项（FR-39h）。 */
export const DEFAULT_SCAN_EXCLUDE: readonly string[] = [
  'node_modules',
  '.git',
  '.pm',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out',
];
import {
  blockOf,
  emptyGraph,
  mutateAdd,
  mutateFlags,
  mutateFocus,
  mutateGate,
  mutatePatch,
  mutateRemove,
  mutateSubscribe,
  mutateUnsubscribe,
  type Clock,
  type MutationContext,
  type MutationResult,
  type RandomSource,
} from './domain/mutate.ts';
import {
  checkDocument,
  type DocCheckResult,
} from './domain/docFormat.ts';
import { projectDocument, projectionFingerprint, branchPath } from './domain/project.ts';
import type {
  GraphSnapshot,
  NodeFlag,
  NodeKind,
  NodeRecord,
  ProgressStats,
  Ref,
  SelfState,
} from './shared/types.ts';
import type { ConflictPolicy, PatchFields } from './domain/validate.ts';
import { KvStoragePort, newProjectId } from './storage/kv-port.ts';
import { openFileStorage, PM_DIR } from './storage/file-port.ts';
import type { StoragePort } from './storage/port.ts';
import type { AuditRecord, ProjectMetaRecord } from './storage/schema.ts';
import { DATA_FORMAT } from './storage/schema.ts';

/** 插件配置（与 `src/index.ts` 的 schemastery Config 对应）。 */
export interface ProjectServiceConfig {
  refreshIntervalMs: number;
  conflictPolicy: ConflictPolicy;
  documentPath: string;
  snapshotMode: 'auto' | 'git' | 'patch' | 'full';
  aiWeightMeasurement: boolean;
}

export interface ProjectServiceDeps {
  config: ProjectServiceConfig;
  capabilities: CapabilityReport;
  clock: Clock;
  random: RandomSource;
  /**
   * 工作区根（可选）。
   *
   * 兜底文件存储需要它才能落盘到 `.pm/`；主路线不需要。
   * DSH 的 cwd 是 per-call 值，所以这里通常是 undefined，
   * 由工具层随后用 `noteWorkspaceRoot()` 补上。
   */
  workspaceRoot?: string;
}

/** 一个节点的看板视图（供 UI / 工具返回）。 */
export interface NodeView {
  id: string;
  name: string;
  parentId: string | null;
  kind: NodeKind;
  selfState: SelfState;
  derivedState: string;
  progress: number;
  weight: number;
  focus: boolean;
  gate: NodeRecord['gate'];
  flags: NodeFlag[];
  description?: string;
  refs?: Ref[];
  autoCreated: boolean;
  childCount: number;
  leafCount: number;
  unfinishedLeafCount: number;
  blockedBy: string[];
  revision: number;
  updatedAt: string;
  updatedBy: string;
  addedMidway: boolean;
  subscriptionCount: number;
  branchPath: string[];
}

/** 看板整体快照（面板一次拉取的全部内容）。 */
export interface BoardSnapshot {
  projectId: string;
  projectName: string;
  nodes: NodeView[];
  overall: ProgressStats;
  focused: ProgressStats;
  focusedRootIds: string[];
  unfinished: NodeView[];
  conflicts: Array<{ conflictId: string; nodeId: string; code: string; message: string }>;
  /** 未完成扫描带（FR-46c）：叶节点按图序。 */
  scanBand: Array<{ nodeId: string; name: string; derivedState: string; isFocus: boolean }>;
  degradation: string[];
  snapshot: { mode: 'git' | 'patch' | 'full'; reason: string };
  confirmChannel: string;
  document: { path: string; exists: boolean; legal: boolean; violations: string[] };
  dataFormat: number;
  /** 最近一次外部改动（R4/R6）；无则为 null。 */
  externalChange: {
    kind: string;
    path: string;
    at: string;
    documentLegal?: boolean;
  } | null;
  /** 当前监听目标（诊断用）。 */
  watchTargets: string[];
  /**
   * 工作区根的解析结果（诊断用）。
   *
   * 面板空着的头号原因就是这里为 `none` —— 让它直接可见，省得再猜。
   */
  workspaceRoot: { value: string | null; source: string; detail: string };
}

/** 一次写入的对外结果（工具返回与 UI 都用它，保证行为一致 FR-71）。 */
export type ApplyResult =
  | { status: 'ok'; nodeId: string; revision: number; autoFixes: string[]; attempts: number }
  | {
      status: 'denied';
      reason: string;
      code: string;
      message: string;
      hint?: string;
      latestRev?: number;
    }
  | { status: 'needs-confirm'; confirmToken: string; preview: string; action: string }
  | { status: 'arbitrate'; conflictId: string; code: string; message: string };

/**
 * 项目服务。
 */
export class ProjectService {
  readonly route: StoragePort['route'];

  private readonly ctx: Context;
  private readonly port: StoragePort;
  private readonly deps: ProjectServiceDeps;
  private projectId = '';
  private confirm: ConfirmRouter | undefined;
  /** 回滚锁（C9）：被锁定的子树根 id 集合。 */
  private readonly rollbackLocks = new Set<string>();
  /** 待确认停止的节点（C10）。 */
  private readonly needsConfirmNodes = new Set<string>();
  /** 最近一次工具调用报告的工作区根（DSH 的 cwd 是 per-call 值）。 */
  private workspaceRootOverride: string | undefined;
  /** 报告该 cwd 的会话（undefined = 无会话上下文的调用，如用户/后台任务）。 */
  private workspaceRootOverrideSession: string | undefined;
  /** 每个会话最近一次报告的工作区根（多会话/多工作区的精确来源）。 */
  private readonly sessionRoots = new Map<string, string>();
  /**
   * 当前**已绑定**的工作区根（项目绑定跟着它走）。
   *
   * KV 路线是全机器共享一份存储，因此必须按根把项目分开，
   * 否则"切换工作区"会把两棵互不相干的树混成一棵（FR-124 的口径一致性要求）。
   */
  private boundRoot: string | undefined;
  /** 待绑定：工具层是同步入口，真正的项目切换延到下一个异步入口。 */
  private pendingRoot: string | undefined;
  /** `pendingRoot` 的来源（面板会话解析 / 工具调用报告），用于如实标注。 */
  private pendingRootSource: WorkspaceRootResolution['source'] | undefined;

  /**
   * 记下"最近一次明确指定的工作区根"。
   *
   * 两条路径会调用它：工具调用（per-call cwd）与面板按会话解析。
   * 后写者赢 —— 这正是我们想要的"最后意图优先"。
   */
  private notePendingRoot(resolution: WorkspaceRootResolution): void {
    if (resolution.root === undefined || resolution.root === '') return;
    this.pendingRoot = resolution.root;
    this.pendingRootSource = resolution.source;
  }
  /** 快照管理器（首次需要时惰性创建，因为要先知道工作区根）。 */
  private snapshots: SnapshotManager | undefined;
  private snapshotDecision: { mode: 'git' | 'patch' | 'full'; reason: string } | undefined;
  /** 外部改动监听句柄（惰性启动；工作区根变化时重建）。 */
  private watcher: WatcherHandle | undefined;
  /** 是否已被显式关闭（关闭后不再惰性启动，除非工作区根变化）。 */
  private watcherStopped = false;
  /** 最近一次外部改动（看板面包屑；R4/R6）。 */
  private externalChange:
    | {
        kind: WatchEventKind;
        path: string;
        at: string;
        /** 外部改动后的文档校验结论（仅 document-changed 有值）。 */
        documentLegal?: boolean;
      }
    | undefined;

  private constructor(ctx: Context, port: StoragePort, deps: ProjectServiceDeps) {
    this.ctx = ctx;
    this.port = port;
    this.deps = deps;
    this.route = port.route;
  }

  /**
   * 创建服务：打开存储、解析/初始化当前项目。
   *
   * 主路线不可用时回落兜底路线（FR-124）：`ctx.storageDomain` 缺失 → `.pm/` 下的
   * append-only 文件存储。两条路线跑**同一组契约测试**、行为等价（FR-123）。
   */
  static async create(ctx: Context, deps: ProjectServiceDeps): Promise<ProjectService> {
    let port: StoragePort;
    if (deps.capabilities.storageDomain) {
      port = await KvStoragePort.create(ctx);
      if (port instanceof KvStoragePort) port.attachChangeEvents();
      debugBus.info('storage', '使用主路线：ctx.storageDomain（KV 领域）');
    } else {
      // 与实例方法走**同一套**解析（工具 cwd → 工作区注册表 → 环境变量）。
      // 之前这里单独用了环境变量回落，于是"用户选过工作区"这条路走不通（实测踩过）。
      const resolution = resolveWorkspaceRoot({
        ctx,
        ...(deps.workspaceRoot !== undefined ? { reported: deps.workspaceRoot } : {}),
      });
      if (resolution.root === undefined) {
        throw new Error(
          `storageDomain 不可用，且无法确定工作区根目录，兜底文件存储无从落盘。${resolution.detail}`,
        );
      }
      port = await openFileStorage({ workspaceRoot: resolution.root });
      debugBus.warn('storage', `使用兜底路线：${PM_DIR}/ 下的 append-only 文件存储（能力有差异）`);
    }

    const service = new ProjectService(ctx, port, deps);
    await service.ensureProject();
    // 启动时先按"已能确定的根"绑一次项目：KV 路线是全机器共享存储，
    // 不绑就会读到别人的项目（live 环境实测：面板显示"未命名项目"、节点 0）。
    await service.bindProjectToRoot(service.resolveRoot().root);
    return service;
  }

  /** 注入确认路由（避免 storage 与服务之间的循环依赖）。 */
  attachConfirm(confirm: ConfirmRouter): void {
    this.confirm = confirm;
  }

  get storage(): StoragePort {
    return this.port;
  }

  get currentProjectId(): string {
    return this.projectId;
  }

  /** 当前项目绑定的工作区根（诊断用；未绑定时 undefined）。 */
  get boundWorkspaceRoot(): string | undefined {
    return this.boundRoot;
  }

  /**
   * 工作区根目录。
   *
   * DSH 把会话工作区 cwd 作为**每次调用**的值（`exec.agent.session.header.cwd`）传给工具，
   * 宿主 `ctx` 上没有它；工具层每次调用都会用 `noteWorkspaceRoot()` 告知本服务。
   *
   * **但面板读看板时没有工具调用** —— 那时必须靠工作区注册表兜底，
   * 否则插件不知道"该管哪个工作区"，看板只能空着（实测踩过）。
   * 解析优先级与理由见 `adapter/workspace-root.ts`。
   */
  workspaceRoot(): string | undefined {
    return this.operationRoot().root;
  }

  /**
   * 面向"操作"（快照、监听、扫描、派生）的根解析。
   *
   * 与 {@link resolveRoot} 的区别：优先用**已绑定**的根。
   * 已绑定的根是本服务真正在读写的那个项目所属的工作区；
   * 如果退回"注册表最近使用"，快照/监听就会落到与当前项目**不同的**根上。
   */
  private operationRoot(): WorkspaceRootResolution {
    if (this.pendingRoot !== undefined && this.pendingRoot !== '') {
      return {
        root: this.pendingRoot,
        source: this.pendingRootSource ?? 'tool-call',
        detail: '最近一次明确指定的工作区根（面板会话解析或工具调用报告）',
      };
    }
    if (this.workspaceRootOverride !== undefined && this.workspaceRootOverride !== '') {
      return {
        root: this.workspaceRootOverride,
        source: 'tool-call',
        detail: '由工具调用报告的会话 cwd',
      };
    }
    if (this.boundRoot !== undefined && this.boundRoot !== '') {
      return {
        root: this.boundRoot,
        source: 'bound',
        detail: '沿用当前项目已绑定的工作区根',
      };
    }
    return this.resolveRoot();
  }

  /** 工作区根的解析结果（含来源，供诊断页显示"根从哪来"）。 */
  rootResolution(sessionId?: string): WorkspaceRootResolution {
    return this.resolveRoot(sessionId);
  }

  private resolveRoot(sessionId?: string): WorkspaceRootResolution {
    // ① 该会话自己的工具调用报告过 cwd → 这就是它的工作区（最精确，且不会串会话）
    if (sessionId !== undefined && sessionId !== '') {
      const own = this.sessionRoots.get(sessionId);
      if (own !== undefined && own !== '') {
        return {
          root: own,
          source: 'tool-call',
          detail: `由会话 ${sessionId} 的工具调用报告的 cwd`,
        };
      }
    }
    // ② 全局最近一次工具调用报告：只对"无会话上下文"的调用，或同一个会话生效。
    //    否则 A 会话的工具调用会把 B 会话的面板带到 A 的工作区去。
    const sameSession =
      this.workspaceRootOverrideSession === undefined ||
      this.workspaceRootOverrideSession === sessionId;
    const reported =
      this.workspaceRootOverride !== undefined &&
      (sessionId === undefined || sessionId === '' || sameSession)
        ? this.workspaceRootOverride
        : undefined;
    return resolveWorkspaceRoot({
      ctx: this.ctx,
      ...(reported !== undefined ? { reported } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    });
  }

  /**
   * 由工具层在每次执行时写入当前会话的工作区根。
   *
   * @param root - `exec.agent.session.header.cwd`
   * @param sessionId - 发起该调用的会话（`exec.agent.id ?? session.id`）；
   *                    省略表示无会话上下文，此时只作全局最近值使用
   */
  noteWorkspaceRoot(root: string | undefined, sessionId?: string): void {
    if (root === undefined || root === '') return;
    if (sessionId !== undefined && sessionId !== '') this.sessionRoots.set(sessionId, root);
    this.workspaceRootOverride = root;
    this.workspaceRootOverrideSession = sessionId;
    // 快照管理器与监听都绑定了工作区根；根变了必须重建（否则在新根上操作旧根的快照）
    if (this.boundRoot === undefined || !isSameRoot(this.boundRoot, root)) {
      this.snapshots = undefined;
      this.snapshotDecision = undefined;
      this.watcherStopped = false; // 允许在新工作区上重新惰性启动
      // 已启动的监听必须立刻切到新根；没启动就啥也不做（惰性）
      if (this.watcher !== undefined) void this.restartWatcher();
    }
    // 真正的项目绑定在下一个异步入口（derive/scan/board）完成 —— 那些地方才能 await 存储
    this.notePendingRoot({
      root,
      source: 'tool-call',
      detail: '由工具调用报告的会话 cwd',
    });
  }

  /**
   * 把当前项目**绑定到**工作区根（KV 路线按根分项目）。
   *
   * 三种情况：
   * ① 已经有一个项目记录了这个根 → 直接切过去；
   * ② 库里只有一个**没记录过根**的项目（老数据）→ 认领它（不孤立用户已有的树）；
   * ③ 其余 → 为该根新建项目。
   */
  private async bindProjectToRoot(root: string | undefined): Promise<void> {
    if (root === undefined || root === '') return;
    if (this.boundRoot !== undefined && isSameRoot(this.boundRoot, root)) return;

    const projects = await this.listProjects();
    const match = projects.find(
      (meta) => meta.workspaceRoot !== undefined && isSameRoot(meta.workspaceRoot, root),
    );
    if (match) {
      this.switchProject(match.projectId, root);
      return;
    }

    // 老数据认领：只有一个"无根"项目时才认领（多个就说明有歧义，宁可新建）
    const adoptable = projects.filter((meta) => meta.workspaceRoot === undefined);
    if (adoptable.length === 1 && adoptable[0] !== undefined) {
      const meta = adoptable[0];
      await this.port.putMeta({
        ...meta,
        workspaceRoot: root,
        updatedAt: this.deps.clock.now(),
      });
      this.switchProject(meta.projectId, root);
      debugBus.info('project', `项目 ${meta.projectId} 认领工作区根 ${root}（老数据迁移）`);
      return;
    }

    const projectId = newProjectId();
    const ts = this.deps.clock.now();
    await this.port.openProject({
      projectId,
      projectName: '未命名项目',
      dataFormat: DATA_FORMAT,
      createdAt: ts,
      updatedAt: ts,
      rootIds: [],
      workspaceRoot: root,
    });
    this.switchProject(projectId, root);
    debugBus.info('project', `为工作区根 ${root} 新建项目 ${projectId}`);
  }

  /** 切换项目并重置所有"绑定在根上"的缓存。 */
  private switchProject(projectId: string, root: string): void {
    const changed = this.projectId !== projectId;
    this.projectId = projectId;
    this.boundRoot = root;
    this.snapshots = undefined;
    this.snapshotDecision = undefined;
    this.externalChange = undefined;
    this.watcherStopped = false;
    if (this.watcher !== undefined) void this.restartWatcher();
    if (changed) debugBus.info('project', `已切换到项目 ${projectId}（根 ${root}）`);
  }

  // ── 外部改动监听（§15 R4/R6）──────────────────────────────────

  /**
   * 惰性确保监听已启动（**由读方触发**，不在启动路径上主动起）。
   *
   * 为什么惰性：监听是资源（chokidar watcher + 事件循环句柄）。宿主启动时工作区根还未知，
   * 而"无所事事也挂一个 watcher"既浪费又会在测试里泄漏。读看板/读诊断时才需要它。
   */
  private ensureWatcher(): void {
    if (this.watcher !== undefined || this.watcherStopped) return;
    const root = this.workspaceRoot();
    if (!root) return;
    // 刻意不用 `DSH_WORKSPACE` / `PWD` 回落：DSH 的 cwd 是 per-call 值，
    // 宿主环境变量往往指向**另一个**目录（实测会让测试监听到真实仓库）。
    if (this.workspaceRootOverride === undefined) return;

    const handle = startWatching({
      workspaceRoot: root,
      documentPath: this.deps.config.documentPath,
      onEvent: (event) => {
        void this.handleExternalChange(event);
      },
    });
    this.watcher = handle;
    if (handle) {
      debugBus.info('watch', '已启动外部改动监听', { targets: handle.targets });
    } else {
      debugBus.warn('watch', '监听启动失败（可选能力，已跳过）');
    }
  }

  /** 启动/重启监听（供显式调用；一般用 `ensureWatcher`）。 */
  async restartWatcher(): Promise<void> {
    await this.stopWatcher();
    this.watcherStopped = false;
    this.ensureWatcher();
  }

  /** 关闭监听（并阻止再次惰性启动，直到工作区根变化或显式重启）。 */
  async stopWatcher(): Promise<void> {
    const handle = this.watcher;
    this.watcher = undefined;
    this.watcherStopped = true;
    if (handle) await handle.close();
  }

  /**
   * 处理一次外部改动。
   *
   * 关键语义：**文档只是投影**，外部改动永远不会被当权威值读回来（§12.4 不变量 1）。
   * 这里只做两件事：记下来给用户看；文档被改时重新校验合法性并提示。
   */
  private async handleExternalChange(event: WatchEvent): Promise<void> {
    const change: NonNullable<ProjectService['externalChange']> = {
      kind: event.kind,
      path: event.path,
      at: event.at,
    };
    if (event.kind === 'document-changed') {
      const check = await this.checkDocumentFile();
      change.documentLegal = check.check?.ok ?? false;
      debugBus.warn(
        'watch',
        `检测到外部改动：${event.path}（${event.type}）—— 文档合法性：${
          check.check?.ok === true ? '合法' : '不合法'
        }`,
      );
    } else {
      debugBus.info('watch', `检测到外部改动：${event.path}（${event.type}）`);
    }
    this.externalChange = change;
  }

  /** 最近一次外部改动（看板面包屑；读它会惰性启动监听）。 */
  lastExternalChange(): ProjectService['externalChange'] {
    this.ensureWatcher();
    return this.externalChange;
  }

  /** 清掉外部改动提示（用户确认后调用）。 */
  clearExternalChange(): void {
    this.externalChange = undefined;
  }

  /** 当前监听目标（诊断用；读它会惰性启动监听）。 */
  watchTargets(): string[] {
    this.ensureWatcher();
    return this.watcher?.targets ?? [];
  }

  // ── 快照与回滚（§6.6b / §7.5）────────────────────────────────

  /** 当前快照档位与裁决原因（看板与设置页要显示，FR-89d）。 */
  snapshotStatus(): { mode: 'git' | 'patch' | 'full'; reason: string } {
    if (this.snapshotDecision) return this.snapshotDecision;
    const root = this.workspaceRoot();
    const fromSandbox = resolveSnapshotMode(this.deps.config.snapshotMode, this.deps.capabilities);
    if (this.deps.config.snapshotMode !== 'auto') return fromSandbox;
    const fromWorkspace = root
      ? resolveSnapshotCapability({ workspaceRoot: root, sandboxMode: this.deps.capabilities.sandboxMode })
      : undefined;
    const decision = fromWorkspace ?? fromSandbox;
    this.snapshotDecision = decision;
    return decision;
  }

  /**
   * 快照管理器（惰性创建）。
   *
   * 没有工作区根时返回 undefined —— 此时**不能**假装快照可用（§7.5：回滚点会静默失效）。
   */
  snapshotManager(): SnapshotManager | undefined {
    if (this.snapshots) return this.snapshots;
    const root = this.workspaceRoot();
    if (!root) return undefined;
    const decision = this.snapshotStatus();
    this.snapshots = new SnapshotManager({
      port: this.port,
      clock: this.deps.clock,
      random: this.deps.random,
      projectId: this.projectId,
      workspaceRoot: root,
      mode: decision.mode,
      modeReason: decision.reason,
    });
    return this.snapshots;
  }

  // ── 项目初始化 ────────────────────────────────────────────────
  private async ensureProject(): Promise<void> {
    const ts = this.deps.clock.now();
    const existing = await this.port.listProjects();
    const first = existing[0];
    if (first) {
      this.projectId = first;
      return;
    }
    const projectId = newProjectId();
    const meta: ProjectMetaRecord = {
      projectId,
      projectName: '未命名项目',
      dataFormat: DATA_FORMAT,
      createdAt: ts,
      updatedAt: ts,
      rootIds: [],
    };
    await this.port.openProject(meta);
    this.projectId = projectId;
  }

  /** 切换当前项目（多项目工作区）。 */
  async selectProject(projectId: string): Promise<void> {
    const meta = await this.port.getMeta(projectId);
    if (!meta) throw new Error(`项目 ${projectId} 不存在`);
    this.projectId = projectId;
  }

  async listProjects(): Promise<ProjectMetaRecord[]> {
    const ids = await this.port.listProjects();
    const out: ProjectMetaRecord[] = [];
    for (const id of ids) {
      const meta = await this.port.getMeta(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  private async readGraph(): Promise<GraphSnapshot> {
    const graph = await this.port.readGraph(this.projectId);
    if (graph) return graph;
    const ts = this.deps.clock.now();
    return emptyGraph('未命名项目', ts);
  }

  private mutationContext(): MutationContext {
    const base: MutationContext = {
      clock: this.deps.clock,
      random: this.deps.random,
      policy: this.deps.config.conflictPolicy,
      rollbackLocked: (nodeId) => this.isRollbackLocked(nodeId),
    };
    return base;
  }

  private isRollbackLocked(nodeId: string): boolean {
    if (this.rollbackLocks.has(nodeId)) return true;
    const locked = [...this.rollbackLocks];
    return locked.some((rootId) => nodeId.startsWith(rootId));
  }

  /** 把领域结果落盘（含审计）。审计失败不得回滚已提交的写入。 */
  private async persist(result: MutationResult): Promise<ApplyResult> {
    if (result.kind === 'reject') {
      return {
        status: 'denied',
        reason: 'validation',
        code: result.code,
        message: result.message,
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
        ...(result.latestRev !== undefined ? { latestRev: result.latestRev } : {}),
      };
    }
    if (result.kind === 'arbitrate') {
      const ts = this.deps.clock.now();
      await this.port.putConflict({
        conflictId: result.conflictId,
        projectId: this.projectId,
        nodeId: '',
        code: result.code,
        message: result.message,
        candidates: [],
        status: 'pending',
        createdAt: ts,
      });
      return {
        status: 'arbitrate',
        conflictId: result.conflictId,
        code: result.code,
        message: result.message,
      };
    }

    const before = await this.port.readGraph(this.projectId);
    const changedIds = diffNodeIds(before, result.graph);
    for (const nodeId of changedIds) {
      const node = result.graph.nodes[nodeId];
      if (!node) continue;
      await this.port.putNode(this.projectId, node);
    }

    // meta 同步（rootIds / projectName / 投影指纹）
    const meta = await this.port.getMeta(this.projectId);
    if (meta) {
      await this.port.putMeta({
        ...meta,
        projectName: result.graph.projectName,
        rootIds: result.graph.rootIds,
        updatedAt: this.deps.clock.now(),
      });
    }

    const auditRows: AuditRecord[] = result.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      projectId: this.projectId,
      nodeId: attempt.nodeId,
      block: attempt.block,
      op: attempt.op,
      by: attempt.by.label ?? attempt.by.by,
      rev: attempt.rev,
      ts: attempt.ts,
    }));
    if (result.autoFixes.length > 0) {
      auditRows.push({
        attemptId: this.deps.random.uuid(),
        projectId: this.projectId,
        nodeId: null,
        block: 'state',
        op: {},
        by: 'system',
        rev: 0,
        ts: this.deps.clock.now(),
        note: `自动修正：${result.autoFixes.join('、')}`,
      });
    }
    for (const row of auditRows) await this.port.appendAudit(row);

    const firstChanged = changedIds[0];
    const node = firstChanged ? result.graph.nodes[firstChanged] : undefined;
    return {
      status: 'ok',
      nodeId: firstChanged ?? '',
      revision: node?.revision ?? 0,
      autoFixes: result.autoFixes,
      attempts: auditRows.length,
    };
  }

  // ── 写入操作（UI 与工具共用，保证行为一致 FR-71）────────────────

  /** 新增节点。 */
  async addNode(input: {
    parentId: string | null;
    name: string;
    kind?: NodeKind;
    description?: string;
    refs?: Ref[];
    addedMidway?: boolean;
    autoCreated?: boolean;
    by?: 'user' | 'session' | 'subagent' | 'job';
    actorId?: string;
  }): Promise<ApplyResult & { nodeId?: string }> {
    const graph = await this.readGraph();
    const result = mutateAdd(
      graph,
      {
        parentId: input.parentId,
        name: input.name,
        by: input.by ?? 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.refs !== undefined ? { refs: input.refs } : {}),
        ...(input.addedMidway !== undefined ? { addedMidway: input.addedMidway } : {}),
        ...(input.autoCreated !== undefined ? { autoCreated: input.autoCreated } : {}),
      },
      this.mutationContext(),
    );
    const applied = await this.persist(result);
    if (applied.status === 'ok' && result.kind === 'ok') {
      const newId = diffNodeIds(graph, result.graph)[0];
      return { ...applied, ...(newId !== undefined ? { nodeId: newId } : {}) };
    }
    return applied;
  }

  /** 更新节点字段（`pm_update` 内核）。 */
  async patchNode(input: {
    nodeId: string;
    patch: PatchFields;
    rev?: number;
    structRev?: number;
    force?: boolean;
    by?: 'user' | 'session' | 'subagent' | 'job';
    actorId?: string;
    reason?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const node = graph.nodes[input.nodeId];
    if (node?.flags?.includes('needsConfirm')) this.needsConfirmNodes.add(input.nodeId);
    const result = mutatePatch(
      graph,
      {
        nodeId: input.nodeId,
        patch: input.patch,
        by: input.by ?? 'session',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.rev !== undefined ? { rev: input.rev } : {}),
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 推进进度/状态（`pm_progress`）。 */
  async progress(input: {
    nodeId: string;
    progress?: number;
    selfState?: SelfState;
    rev?: number;
    force?: boolean;
    reason?: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    const patch: PatchFields = {};
    if (input.progress !== undefined) patch.progress = input.progress;
    if (input.selfState !== undefined) patch.selfState = input.selfState;
    return this.patchNode({
      nodeId: input.nodeId,
      patch,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });
  }

  /** 标记完成（`pm_finish`）：同时置 `progress = 1`，避免触发 C3。 */
  async finish(input: {
    nodeId: string;
    rev?: number;
    evidence?: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    return this.patchNode({
      nodeId: input.nodeId,
      patch: { selfState: 'done', progress: 1 },
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.evidence !== undefined ? { reason: input.evidence } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });
  }

  /**
   * 删除整枝（`pm_remove`）—— **破坏性操作，必须取得一次性授权**（§13.1 / FR-135–138）。
   *
   * 未带 `confirmToken` 时只返回 `needs-confirm` + preview，**不执行任何动作**。
   */
  async removeBranch(input: {
    nodeId: string;
    policy: 'record' | 'code' | 'comment';
    rev?: number;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const node = graph.nodes[input.nodeId];
    if (!node) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NOT_FOUND',
        message: `节点 ${input.nodeId} 不存在`,
      };
    }

    const preview = this.previewRemove(graph, input.nodeId, input.policy);

    if (input.confirmToken === undefined) {
      return {
        status: 'needs-confirm',
        confirmToken: this.deps.random.uuid(),
        preview,
        action: 'remove-branch',
      };
    }

    // 准入：一次性授权（fail-closed，FR-136）
    const authorized = await this.authorize({
      action: 'remove-branch',
      toolName: input.toolName ?? 'pm_remove',
      reason: `删除整枝「${node.name}」（policy=${input.policy}）`,
      agent: input.agent,
      callId: input.callId,
    });
    if (!authorized.ok) {
      return {
        status: 'denied',
        reason: authorized.reason,
        code: authorized.reason,
        message: authorized.message,
        hint: authorized.hint,
      };
    }

    const result = mutateRemove(
      graph,
      {
        nodeId: input.nodeId,
        policy: input.policy,
        by: 'user',
        ...(input.rev !== undefined ? { rev: input.rev } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 预览删除影响范围（FR-64/R10：必须明示覆盖范围与未覆盖项）。 */
  previewRemove(graph: GraphSnapshot, nodeId: string, policy: string): string {
    const index = buildIndex(graph);
    const node = index.byId.get(nodeId);
    if (!node) return '节点不存在';
    const descendants = collectSubtree(index, nodeId);
    const leaves = descendants.filter((id) => (index.childrenOf.get(id) ?? []).length === 0);
    const touched = new Set<string>();
    for (const id of descendants) {
      for (const path of graph.nodes[id]?.refs?.map((r) => r.target) ?? []) touched.add(path);
    }
    return [
      `将删除整枝「${node.name}」`,
      `- 覆盖节点：${descendants.length} 个（其中叶节点 ${leaves.length} 个）`,
      `- 方案：${policy === 'record' ? '仅删枝的记录（可恢复）' : policy === 'code' ? '代码一并删除' : '代码仅注释（保留后期恢复可能）'}`,
      `- 已记录的引用路径：${touched.size} 个`,
      '- 未覆盖项：shell 命令产生的写入、外部进程与其他工具的改动不在回滚/删除范围内',
      '- 本操作不可保证完整恢复，请自行确认',
    ].join('\n');
  }

  /** 设置关注（`pm_focus`，含归一化）。 */
  async setFocus(input: {
    nodeId: string;
    focus: boolean;
    structRev?: number;
    by?: 'user' | 'session';
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateFocus(
      graph,
      {
        nodeId: input.nodeId,
        focus: input.focus,
        by: input.by ?? 'user',
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 设置门控（暂停/拦停/放行/继续）。 */
  async setGate(input: {
    nodeId: string;
    gate: NodeRecord['gate'];
    structRev?: number;
    by?: 'user' | 'session';
    reason?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateGate(
      graph,
      {
        nodeId: input.nodeId,
        gate: input.gate,
        by: input.by ?? 'user',
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  // ── 暂停 / 拦停 / 继续 / 放行（§9.2 / §9.6.4 / FR-51–54）────────

  /**
   * 暂停（FR-51）：置门控 `paused` + 生成《继续交接文档》+ **自动建立回滚点**。
   *
   * 交接文档的机械部分零 token；模型补写部分（下一步 / 关键决策与坑）由 `src/ai/` 那条
   * 路径提供，缺失即降级标注，**不阻塞暂停**（§9.6.4）。
   */
  async pauseNode(input: {
    nodeId: string;
    reason?: string;
    supplements?: HandoffSupplements;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; snapshot?: CaptureResult }> {
    return this.gateWithHandoff({ ...input, gate: 'paused' });
  }

  /**
   * 拦停（FR-53，**仅父节点**）：置门控 `held` + 生成《放行交接文档》（多任务）+
   * 为整枝建立回滚点。
   */
  async holdNode(input: {
    nodeId: string;
    reason?: string;
    supplements?: HandoffSupplements;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; snapshot?: CaptureResult }> {
    return this.gateWithHandoff({ ...input, gate: 'held' });
  }

  private async gateWithHandoff(input: {
    nodeId: string;
    gate: 'paused' | 'held';
    reason?: string;
    supplements?: HandoffSupplements;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; snapshot?: CaptureResult }> {
    // ① 先建回滚点（§9.2b：暂停/拦停必建）——失败不阻塞门控，但必须如实报告
    const capture = await this.captureSnapshot({
      nodeId: input.nodeId,
      reason: input.gate === 'paused' ? 'pause' : 'hold',
      force: true,
    });

    // ② 再写门控
    const gated = await this.setGate({
      nodeId: input.nodeId,
      gate: input.gate,
      by: input.by ?? 'user',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    if (gated.status !== 'ok') {
      return { ...gated, ...(capture.created ? { snapshot: capture } : {}) };
    }

    // ③ 生成交接文档（机械部分零 token）
    const handoff = await this.writeHandoff({
      nodeId: input.nodeId,
      kind: input.gate === 'paused' ? 'pause' : 'hold',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.supplements !== undefined ? { supplements: input.supplements } : {}),
    });

    return {
      ...gated,
      ...(handoff !== undefined ? { handoff } : {}),
      ...(capture.created ? { snapshot: capture } : {}),
    };
  }

  /**
   * 生成并写入一份交接文档（机械部分零 token）。
   *
   * 工作区根不可用时**不写**、并如实返回 undefined —— 不假装生成。
   */
  async writeHandoff(input: {
    nodeId: string;
    kind: HandoffKind;
    reason?: string;
    supplements?: HandoffSupplements;
    maxBytes?: number;
    excludePaths?: readonly string[];
  }): Promise<HandoffDocument | undefined> {
    const root = this.workspaceRoot();
    if (!root) return undefined;
    const { graph, derived } = await this.derive();
    const index = buildIndex(graph);
    const covered = [input.nodeId, ...subtreeIds(index, input.nodeId)];

    const doc = buildHandoffDocument(graph, derived, {
      kind: input.kind,
      nodeIds: input.kind === 'hold' ? [input.nodeId] : covered,
      rootNodeId: input.nodeId,
      now: new Date(this.deps.clock.now()),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.supplements !== undefined ? { supplements: input.supplements } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      ...(input.excludePaths !== undefined ? { excludePaths: input.excludePaths } : {}),
    });

    await writeHandoffFile({ root, relativePath: doc.relativePath, content: doc.markdown });
    await this.port.appendAudit({
      attemptId: this.deps.random.uuid(),
      projectId: this.projectId,
      nodeId: input.nodeId,
      block: 'gate',
      op: {
        handoff: doc.relativePath,
        kind: doc.kind,
        nodes: doc.nodeCount,
        bytes: doc.bytes,
        truncated: doc.truncated,
        supplementsSkipped: doc.supplementsSkipped,
      },
      by: input.kind === 'hold' ? 'user' : 'user',
      rev: 0,
      ts: this.deps.clock.now(),
    });
    return doc;
  }

  /**
   * 继续（FR-52）：解除门控 + 把《继续交接文档》内容作为**上下文注入**返回，
   * 再按参数删除文档。
   *
   * 说明：插件没有直接向会话注入消息的公开接口（§13 没有该能力），
   * 因此"注入"以**工具返回值**的形式交付给模型 —— 这是当前能真正工作的路径，
   * 比假装注入更诚实。
   */
  async resumeNode(input: {
    nodeId: string;
    consumeDoc?: boolean;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; resumed?: boolean }> {
    return this.releaseGate({ ...input, kind: 'pause' });
  }

  /** 放行（FR-54）：解除门控 + 消费《放行交接文档》（多任务）。 */
  async releaseNode(input: {
    nodeId: string;
    consumeDoc?: boolean;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; resumed?: boolean }> {
    return this.releaseGate({ ...input, kind: 'hold' });
  }

  private async releaseGate(input: {
    nodeId: string;
    kind: HandoffKind;
    consumeDoc?: boolean;
    by?: 'user' | 'session';
  }): Promise<ApplyResult & { handoff?: HandoffDocument; resumed?: boolean }> {
    const root = this.workspaceRoot();
    const doc = root ? await this.readLatestHandoff(root, input.nodeId, input.kind) : undefined;

    const result = await this.setGate({
      nodeId: input.nodeId,
      gate: null,
      by: input.by ?? 'user',
    });
    if (result.status !== 'ok') return result;

    const consume = input.consumeDoc !== false;
    if (doc && consume && root) {
      // 消费语义：返回内容供会话续接，然后按参数删除
      try {
        const absolute = `${HANDOFF_DIR}/${doc.fileName}`;
        await deleteWorkspaceFile(root, absolute);
      } catch {
        // 删除失败不影响恢复（文档留着当归档）
      }
    }

    return {
      ...result,
      resumed: true,
      ...(doc !== undefined ? { handoff: doc } : {}),
    };
  }

  /** 读取某节点最近一份指定种类的交接文档。 */
  async readLatestHandoff(
    root: string,
    nodeId: string,
    kind?: HandoffKind,
  ): Promise<HandoffDocument | undefined> {
    const files = await listHandoffFiles(root);
    // 文件名是 `<kind>-<nodeId>-<yyyymmdd-HHmmss>.md`。
    // **不能用 `split('-')`**：node id 本身含连字符（`pm_xxx-<uuid>`），
    // 按连字符切会读不到自己刚写的文档（实测踩过）。
    const parsed = files
      .map((name) => parseHandoffFileName(name))
      .filter((item): item is ParsedHandoffName => item !== undefined)
      .filter((item) => item.nodeId === nodeId)
      .filter((item) => kind === undefined || item.kind === kind);
    // listHandoffFiles 按文件名倒序 → 时间戳字典序 = 时间序，第一份即最新
    const match = parsed[0];
    if (!match) return undefined;
    const relativePath = `${HANDOFF_DIR}/${match.fileName}`;
    const text = await readWorkspaceFile(root, relativePath);
    if (text === undefined) return undefined;
    const document = parseHandoff(text);
    return {
      kind: match.kind,
      fileName: match.fileName,
      relativePath,
      markdown: text,
      bytes: utf8ByteLength(text),
      truncated: /已截断/.test(text),
      supplementsSkipped: document.supplementsSkipped,
      nodeCount: 0,
    };
  }

  /**
   * 分页读取交接文档（`pm_handoff_read`，§13.2：默认 ≤ 32 KB/次）。
   *
   * 200 KB 的文档**绝不**允许一次性进上下文。
   */
  async readHandoffPage(input: {
    nodeId: string;
    kind?: HandoffKind;
    offset?: number;
    limitBytes?: number;
  }): Promise<{
    found: boolean;
    fileName?: string;
    text?: string;
    nextOffset?: number | null;
    truncated?: boolean;
    supplementsSkipped?: boolean;
    reason?: string;
  }> {
    const root = this.workspaceRoot();
    if (!root) return { found: false, reason: '无法确定工作区根目录' };
    const doc = await this.readLatestHandoff(root, input.nodeId, input.kind);
    if (!doc) return { found: false, reason: '该节点没有交接文档' };
    const page = sliceHandoffByBytes(doc.markdown, input.offset ?? 0, input.limitBytes ?? 32 * 1024);
    return {
      found: true,
      fileName: doc.fileName,
      text: page.text,
      nextOffset: page.nextOffset,
      truncated: page.truncated,
      supplementsSkipped: doc.supplementsSkipped,
    };
  }

  /** 设置标记位（回滚过、待确认停止等）。 */
  async setFlags(input: {
    nodeId: string;
    add?: NodeFlag[];
    remove?: NodeFlag[];
    lastRollbackAt?: string;
    by?: 'user' | 'session';
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateFlags(
      graph,
      {
        nodeId: input.nodeId,
        by: input.by ?? 'user',
        ...(input.add !== undefined ? { add: input.add } : {}),
        ...(input.remove !== undefined ? { remove: input.remove } : {}),
        ...(input.lastRollbackAt !== undefined ? { lastRollbackAt: input.lastRollbackAt } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 申请订阅（`pm_watch`）。 */
  async subscribe(input: {
    nodeId: string;
    actor: 'session' | 'subagent' | 'job' | 'user';
    actorId: string;
    intent: 'read' | 'write' | 'exclusive';
    touchedPaths?: string[];
    notify?: 'key' | 'full' | 'none';
    expiresAt?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateSubscribe(
      graph,
      {
        nodeId: input.nodeId,
        by: input.actor,
        actorId: input.actorId,
        subscription: {
          subscriptionId: this.deps.random.uuid(),
          actor: input.actor,
          actorId: input.actorId,
          intent: input.intent,
          notify: input.notify ?? 'key',
          touchedPaths: input.touchedPaths ?? [],
        },
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 释放订阅。 */
  async unsubscribe(input: {
    nodeId: string;
    subscriptionId: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateUnsubscribe(
      graph,
      {
        nodeId: input.nodeId,
        subscriptionId: input.subscriptionId,
        by: input.by ?? 'session',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  // ── 快照操作（工具与菜单共用）───────────────────────────────────

  /**
   * 打回滚点（`pm_snapshot` / 菜单「打回滚点」）。
   *
   * 手动打点与暂停/拦停一样是**显式请求**，因此 `force: true`（绕过节流与无变化判定）。
   */
  async captureSnapshot(input: {
    nodeId: string;
    reason?: SnapshotReason;
    force?: boolean;
  }): Promise<CaptureResult & { nodeId: string }> {
    const manager = this.snapshotManager();
    if (!manager) {
      return {
        created: false,
        reason: '无法确定工作区根目录（缺少会话上下文），已拒绝建点而不是假装成功',
        nodeId: input.nodeId,
      };
    }
    const { graph, derived } = await this.derive();
    const branch = buildIndex(graph);
    const ids = [input.nodeId, ...collectBranch(branch, input.nodeId)];
    const node = derived.nodes.get(input.nodeId);
    const result = await manager.capture({
      graph,
      nodeIds: ids,
      reason: input.reason ?? 'manual',
      force: input.force ?? true,
      coversUnfinishedNode:
        node === undefined || (node.derivedState !== 'done' && node.derivedState !== 'removed'),
    });
    return { ...result, nodeId: input.nodeId };
  }

  /** 列出某节点的可用回滚点（`pm_snapshots`）。 */
  async listSnapshots(nodeId: string): Promise<
    Array<{ snapshotId: string; reason: string; createdAt: string; mode: string; sizeBytes: number }>
  > {
    const manager = this.snapshotManager();
    if (!manager) return [];
    const rows = await manager.list(nodeId);
    return rows.map((r) => ({
      snapshotId: r.snapshotId,
      reason: r.reason,
      createdAt: r.createdAt,
      mode: r.mode,
      sizeBytes: r.sizeBytes,
    }));
  }

  /**
   * 回滚（`pm_rollback`）——**破坏性操作，必须取得一次性授权**（§13.1 / FR-64/136）。
   *
   * 未带 `confirmToken` 时只返回 `needs-confirm` + 影响范围，**不执行任何动作**。
   */
  async rollback(input: {
    nodeId: string;
    snapshotId?: string;
    scope: RollbackScope;
    confirmToken?: string;
    confirmShared?: boolean;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    const manager = this.snapshotManager();
    if (!manager) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NO_WORKSPACE',
        message: '无法确定工作区根目录，回滚不可用（不做半截回滚）',
        hint: '在有会话上下文的工具调用中重试',
      };
    }
    const { graph } = await this.derive();
    const node = graph.nodes[input.nodeId];
    if (!node) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NOT_FOUND',
        message: `节点 ${input.nodeId} 不存在`,
      };
    }

    const available = await manager.list(input.nodeId);
    const chosen = input.snapshotId
      ? available.find((s) => s.snapshotId === input.snapshotId)
      : available[available.length - 1];
    const preview = [
      `将回滚「${node.name}」到 ${chosen ? `${chosen.createdAt}（${chosen.reason}）` : '最近一个回滚点'}`,
      `- 可用回滚点：${available.length} 个`,
      `- 回滚范围：${input.scope === 'both' ? '代码 + 节点状态' : input.scope === 'code' ? '仅代码' : '仅节点状态'}`,
      '- 覆盖范围：仅节点已记录的路径与工作区 diff',
      '- 未覆盖项：shell 命令产生的写入、外部进程、其他工具与用户手动改动',
      '- 回滚前会先建 `pre-rollback` 快照，可「撤销这次回滚」',
      '- 本操作不可保证完整恢复，请自行确认',
    ].join('\n');

    if (input.confirmToken === undefined) {
      return {
        status: 'needs-confirm',
        confirmToken: this.deps.random.uuid(),
        preview,
        action: 'rollback',
      };
    }

    const authorized = await this.authorize({
      action: 'rollback',
      toolName: input.toolName ?? 'pm_rollback',
      reason: `回滚「${node.name}」（scope=${input.scope}）`,
      agent: input.agent,
      callId: input.callId,
    });
    if (!authorized.ok) {
      return {
        status: 'denied',
        reason: authorized.reason,
        code: authorized.reason,
        message: authorized.message,
        hint: authorized.hint,
      };
    }

    // C9：回滚期间锁定该子树，拒绝并发写入
    this.lockSubtree(input.nodeId);
    try {
      const result = await manager.rollback({
        graph,
        nodeId: input.nodeId,
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
        scope: input.scope,
        confirmShared: input.confirmShared === true,
      });

      if (!result.ok) {
        return {
          status: 'denied',
          reason: result.sharedBlocked.length > 0 ? 'validation' : 'unavailable',
          code: result.sharedBlocked.length > 0 ? 'C_SHARED' : 'E_ROLLBACK',
          message: result.reason,
          ...(result.sharedBlocked.length > 0
            ? { hint: `以下文件被多个节点写过，确认后带 confirmShared=true 重试：${result.sharedBlocked.join('、')}` }
            : {}),
        };
      }

      // 节点状态回到快照点记录的状态（FR-67），并打 rolledBack 标记（§9.2b）
      const snapshot = chosen;
      if (snapshot && input.scope !== 'code') {
        const recorded = snapshot.nodeState[input.nodeId];
        if (recorded) {
          await this.patchNode({
            nodeId: input.nodeId,
            patch: {
              selfState: recorded.selfState as SelfState,
              progress: recorded.progress,
              gate: recorded.gate,
            },
            force: true,
            by: 'user',
            reason: `回滚到 ${snapshot.snapshotId}`,
          });
        }
      }
      await this.setFlags({
        nodeId: input.nodeId,
        add: ['rolledBack'],
        lastRollbackAt: this.deps.clock.now(),
        by: 'user',
      });

      // 回滚留痕（FR-68）
      await this.port.appendAudit({
        attemptId: this.deps.random.uuid(),
        projectId: this.projectId,
        nodeId: input.nodeId,
        block: 'rollback',
        op: {
          scope: input.scope,
          snapshotId: snapshot?.snapshotId ?? null,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          preRollbackSnapshotId: result.preRollbackSnapshotId ?? null,
        },
        by: 'user',
        rev: 0,
        ts: this.deps.clock.now(),
      });

      return {
        status: 'ok',
        nodeId: input.nodeId,
        revision: 0,
        autoFixes: [],
        attempts: 1,
      };
    } finally {
      this.unlockSubtree(input.nodeId);
    }
  }

  /** 撤销上一次回滚（`pm_rollback_undo`）。 */
  async undoRollback(input: {
    nodeId: string;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    const manager = this.snapshotManager();
    if (!manager) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NO_WORKSPACE',
        message: '无法确定工作区根目录，撤销回滚不可用',
      };
    }
    if (input.confirmToken === undefined) {
      return {
        status: 'needs-confirm',
        confirmToken: this.deps.random.uuid(),
        preview: '将用 `pre-rollback` 快照撤销上一次回滚（恢复回滚前的现场）。',
        action: 'rollback-undo',
      };
    }
    const authorized = await this.authorize({
      action: 'rollback-undo',
      toolName: input.toolName ?? 'pm_rollback_undo',
      reason: '撤销上一次回滚',
      agent: input.agent,
      callId: input.callId,
    });
    if (!authorized.ok) {
      return {
        status: 'denied',
        reason: authorized.reason,
        code: authorized.reason,
        message: authorized.message,
        hint: authorized.hint,
      };
    }
    const { graph } = await this.derive();
    const result = await manager.undoRollback({ graph, nodeId: input.nodeId });
    if (!result.ok) {
      return {
        status: 'denied',
        reason: 'unavailable',
        code: 'E_UNDO',
        message: result.reason,
      };
    }
    return { status: 'ok', nodeId: input.nodeId, revision: 0, autoFixes: [], attempts: 1 };
  }

  /** 快照可达性自检（FR-89b）。 */
  async checkSnapshotReachability(): Promise<{
    available: boolean;
    total?: number;
    orphaned?: Array<{ snapshotId: string; ref: string; reason: string }>;
    reason?: string;
  }> {
    const manager = this.snapshotManager();
    if (!manager) return { available: false, reason: '无法确定工作区根目录' };
    const result = await manager.checkReachability();
    return { available: true, total: result.total, orphaned: result.orphaned };
  }

  // ── 读视图 ────────────────────────────────────────────────────

  /** 派生图（UI 与工具共用同一口径）。 */
  async derive(): Promise<{ graph: GraphSnapshot; derived: DerivedGraph }> {
    // 多工作区：读之前先把项目绑到"当前操作根"（绑过就只剩一次字符串比较）
    await this.bindProjectToRoot(this.operationRoot().root);
    const graph = await this.readGraph();
    return { graph, derived: deriveGraph(graph) };
  }

  /**
   * 看板快照（面板一次拉全，避免多次往返）。
   *
   * @param sessionId 面板当前会话 id。带上它才能**精确**报告/解析工作区根
   *                  （见 `adapter/workspace-root.ts` 的解析顺序）。
   */
  async board(sessionId?: string): Promise<BoardSnapshot> {
    // 面板是"用户正在看的那个会话" → 先按会话把根定下来并绑定项目，
    // 再派生（否则会读到"上一个操作根"的项目）。
    const resolution = this.resolveRoot(sessionId);
    if (resolution.root !== undefined) {
      // 面板正在看这个会话 → 它的工作区就是"当前意图"，与工具调用报告同级（后写者赢）
      this.notePendingRoot(resolution);
      await this.bindProjectToRoot(resolution.root);
    }
    const { graph, derived } = await this.derive();
    const focusRoots = focusedRoots(derived.index);
    const views = [...derived.nodes.values()].map((d) =>
      this.toView(derived, d.node.id),
    ).filter((v): v is NodeView => v !== undefined);

    const conflicts = await this.port.listConflicts(this.projectId, 'pending');
    const snapshotDecision = resolveSnapshotMode(
      this.deps.config.snapshotMode,
      this.deps.capabilities,
    );
    const doc = await this.checkDocumentFile(graph);
    const meta = await this.port.getMeta(this.projectId);

    return {
      projectId: this.projectId,
      projectName: graph.projectName,
      nodes: views,
      overall: derived.overall,
      focused: statsForRoots(derived, focusRoots),
      focusedRootIds: focusRoots,
      unfinished: unfinishedLeaves(derived).map((d) => this.toView(derived, d.node.id)).filter(
        (v): v is NodeView => v !== undefined,
      ),
      conflicts: conflicts.map((c) => ({
        conflictId: c.conflictId,
        nodeId: c.nodeId,
        code: c.code,
        message: c.message,
      })),
      scanBand: [...derived.nodes.values()]
        .filter((d) => (derived.index.childrenOf.get(d.node.id) ?? []).length === 0)
        .map((d) => ({
          nodeId: d.node.id,
          name: d.node.name,
          derivedState: d.derivedState,
          isFocus: d.node.focus,
        })),
      degradation: this.deps.capabilities.degradations,
      snapshot: snapshotDecision,
      confirmChannel: this.confirm?.describeChannel() ?? '确认路由未装配',
      document: {
        path: this.deps.config.documentPath,
        exists: doc.exists,
        legal: doc.check?.ok ?? false,
        violations: (doc.check?.violations ?? []).map(
          (v) => `${v.rule}: ${v.message}（${v.hint}）`,
        ),
      },
      dataFormat: meta?.dataFormat ?? DATA_FORMAT,
      // 外部改动面包屑（R4/R6）：文档被外部工具改了、或 .pm/ 被动过
      externalChange: this.externalChange ?? null,
      workspaceRoot: {
        value: resolution.root ?? null,
        source: resolution.source,
        detail: resolution.detail,
      },
      // 读看板即视为需要外部改动感知 → 在这里惰性启动监听
      watchTargets: this.watchTargets(),
    };
  }

  /** 单节点视图。 */
  async nodeView(nodeId: string): Promise<NodeView | undefined> {
    const { derived } = await this.derive();
    return this.toView(derived, nodeId);
  }

  private toView(derived: DerivedGraph, nodeId: string): NodeView | undefined {
    const d = derived.nodes.get(nodeId);
    if (!d) return undefined;
    const view: NodeView = {
      id: d.node.id,
      name: d.node.name,
      parentId: d.node.parentId,
      kind: d.node.kind,
      selfState: d.node.selfState,
      derivedState: d.derivedState,
      progress: d.progress,
      weight: d.weight,
      focus: d.node.focus,
      gate: d.node.gate,
      flags: d.node.flags ?? [],
      autoCreated: d.node.autoCreated === true,
      childCount: d.childCount,
      leafCount: d.leafCount,
      unfinishedLeafCount: d.unfinishedLeafCount,
      blockedBy: (d.node.dependsOn ?? []).filter((id) => {
        const dep = derived.nodes.get(id);
        return dep !== undefined && dep.derivedState !== 'done' && dep.derivedState !== 'removed';
      }),
      revision: d.node.revision,
      updatedAt: d.node.updatedAt,
      updatedBy: d.node.updatedBy,
      addedMidway: (d.node.flags ?? []).includes('addedMidway'),
      subscriptionCount: (d.node.bindings ?? []).length,
      branchPath: branchPath(derived.index, nodeId),
    };
    if (d.node.description !== undefined) view.description = d.node.description;
    if (d.node.refs !== undefined) view.refs = d.node.refs;
    return view;
  }

  /** 树形返回（`pm_tree`）：按父子关系嵌套，返回极简字段（FR-74）。 */
  async tree(options: {
    rootId?: string;
    depth?: number;
    detail?: boolean;
    limit?: number;
  }): Promise<{ nodes: unknown[]; truncated: boolean; totalNodes: number }> {
    const { graph, derived } = await this.derive();
    const index = derived.index;
    const roots = options.rootId ? [options.rootId] : graph.rootIds;
    const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;
    const limit = options.limit ?? 50;
    const flat: NodeView[] = [];
    let truncated = false;

    const walk = (id: string, depth: number): void => {
      if (flat.length >= limit) {
        truncated = true;
        return;
      }
      const view = this.toView(derived, id);
      if (view) flat.push(view);
      if (depth >= maxDepth) return;
      for (const childId of index.childrenOf.get(id) ?? []) walk(childId, depth + 1);
    };
    for (const rootId of roots) walk(rootId, 1);

    return { nodes: flat, truncated, totalNodes: derived.nodes.size };
  }

  // ── 文档 ─────────────────────────────────────────────────────

  /**
   * 文件系统服务。
   *
   * 走 `serviceOf` 而不是直接写 `ctx.fs`：属性访问依赖模块增补被加载，
   * 且无法在测试替身下注入；两条路都试更稳（判定见 `adapter/capabilities.ts`）。
   */
  private fileSystem(): {
    resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
    readText(target: unknown): Promise<string>;
    writeText(target: unknown, content: string): Promise<unknown>;
  } {
    const fs = serviceOf<{
      resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
      readText(target: unknown): Promise<string>;
      writeText(target: unknown, content: string): Promise<unknown>;
    }>(this.ctx, 'fs');
    if (!fs) throw new Error('文件系统服务不可用（ctx.fs / ctx.get("fs") 均未解析到）');
    return fs;
  }

  /** 文档合法性检查（FR-02/04）。 */
  async checkDocumentFile(
    graph?: GraphSnapshot,
  ): Promise<{ exists: boolean; check?: DocCheckResult; markdown?: string }> {
    const snapshot = graph ?? (await this.readGraph());
    try {
      const root = this.workspaceRoot();
      const fs = this.fileSystem();
      const target = await fs.resolve(this.deps.config.documentPath, {
        ...(root !== undefined ? { cwd: root } : {}),
      });
      const text = await fs.readText(target);
      const known = new Set(Object.values(snapshot.nodes).map((n) => n.name));
      return { exists: true, check: checkDocument(text, known), markdown: text };
    } catch {
      return { exists: false };
    }
  }

  /** 投影文档内容（不写盘）。 */
  async renderDocument(): Promise<{ markdown: string; overflow: boolean; fingerprint: string }> {
    const graph = await this.readGraph();
    const projection = projectDocument(graph);
    return {
      markdown: projection.markdown,
      overflow: projection.overflow,
      fingerprint: projectionFingerprint(graph),
    };
  }

  /**
   * 把投影写入 `project-manager.md`（经 `ctx.fs` 版本守卫，FR-127）。
   *
   * 结构未变（指纹一致）时**短路不写**，避免无意义写盘与文件监听抖动。
   */
  async projectDocumentToDisk(): Promise<{
    written: boolean;
    reason: string;
    path: string;
  }> {
    const rendered = await this.renderDocument();
    if (rendered.overflow) {
      return {
        written: false,
        reason: '投影超过行数上限，已拒绝写入（避免静默截断）',
        path: this.deps.config.documentPath,
      };
    }
    const meta = await this.port.getMeta(this.projectId);
    if (meta?.projectionFingerprint === rendered.fingerprint) {
      return { written: false, reason: '结构未变化，跳过写入', path: this.deps.config.documentPath };
    }

    const root = this.workspaceRoot();
    try {
      const fs = this.fileSystem();
      const target = await fs.resolve(this.deps.config.documentPath, {
        ...(root !== undefined ? { cwd: root } : {}),
      });
      await fs.writeText(target, rendered.markdown);
    } catch (error) {
      return {
        written: false,
        reason: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        path: this.deps.config.documentPath,
      };
    }

    if (meta) {
      await this.port.putMeta({
        ...meta,
        projectionFingerprint: rendered.fingerprint,
        updatedAt: this.deps.clock.now(),
      });
    }
    return { written: true, reason: '已投影', path: this.deps.config.documentPath };
  }

  // ── 确认 ─────────────────────────────────────────────────────

  /** 取得一次性授权（fail-closed，FR-136）。 */
  async authorize(input: {
    action: Parameters<ConfirmRouter['authorize']>[0]['action'];
    toolName: string;
    reason: string;
    agent?: unknown;
    callId?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string; message: string; hint: string }> {
    if (!this.confirm) {
      return {
        ok: false,
        reason: 'no-channel',
        message: '确认路由未装配，破坏性操作一律拒绝',
        hint: '请在面板内右键确认',
      };
    }
    // 把 `undefined` 归一化为"没有归属会话"：确认路由据此返回 needs-human（FR-138a）。
    // 反过来（有 agent 却当 undefined）会误判成子代理/作业，必须避免。
    const result = await this.confirm.authorize({
      action: input.action,
      toolName: input.toolName,
      reason: input.reason,
      ...(input.agent === undefined || input.agent === null
        ? {}
        : { agent: input.agent as never }),
      ...(input.callId !== undefined ? { callId: input.callId as never } : {}),
    });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      hint: result.hint,
    };
  }

  // ── 回滚锁（C9）──────────────────────────────────────────────
  lockSubtree(rootId: string): void {
    this.rollbackLocks.add(rootId);
  }

  unlockSubtree(rootId: string): void {
    this.rollbackLocks.delete(rootId);
  }

  markNeedsConfirm(nodeId: string): void {
    this.needsConfirmNodes.add(nodeId);
  }

  clearNeedsConfirm(nodeId: string): void {
    this.needsConfirmNodes.delete(nodeId);
  }

  /** 审计读取（状态条展示）。 */
  async recentAudit(limit = 50): Promise<AuditRecord[]> {
    return this.port.listAudit(this.projectId, limit);
  }

  // ── 首次扫描（阶段 A：零 token 骨架，FR-38/39a）─────────────────

  /**
   * 零 token 扫描：只看文件树与关键文件，**不调任何 AI**。
   *
   * @param input.sessionId 面板当前会话 id（带上它才能精确解析到该会话的工作区；
   *                        否则退回"工作区注册表里最近使用的那个"）
   * @returns 建议节点树 + 诚实标注（跳过数、截断、未展开的层）
   */
  async scan(input?: {
    maxDepth?: number;
    maxChildrenPerDir?: number;
    maxNodes?: number;
    include?: string[];
    exclude?: string[];
    sessionId?: string;
  }): Promise<ScanResult & { available: boolean; reason?: string }> {
    const resolution = this.resolveRoot(input?.sessionId);
    const root = resolution.root;
    if (root !== undefined) {
      this.notePendingRoot(resolution);
      await this.bindProjectToRoot(root);
    }
    if (!root) {
      return {
        available: false,
        reason: '无法确定工作区根目录（缺少会话上下文），已拒绝扫描而不是假装扫过',
        projectName: '',
        nodes: [],
        scanned: 0,
        skipped: 0,
        truncated: false,
        notes: [],
      };
    }

    const excluded: string[] = [...(input?.exclude ?? DEFAULT_SCAN_EXCLUDE)];
    const walked = await scanWorkspaceEntries({
      root,
      maxDepth: input?.maxDepth ?? 6,
      exclude: excluded,
    });

    const options: ScanOptions = {
      ...DEFAULT_SCAN_OPTIONS,
      ...(input?.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
      ...(input?.maxChildrenPerDir !== undefined
        ? { maxChildrenPerDir: input.maxChildrenPerDir }
        : {}),
      ...(input?.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
      ...(input?.include !== undefined ? { include: input.include } : {}),
      exclude: excluded,
      rootDirName: walked.rootDirName,
      ...(walked.packageName !== undefined ? { packageName: walked.packageName } : {}),
    };

    const result = buildSuggestedTree(walked.entries, options);
    result.skipped += walked.skipped;
    return { available: true, ...result };
  }

  /**
   * 应用扫描结果：把建议树落库（FR-39e）。
   *
   * 幂等性（FR-39f）：按 `key` 去重 —— 已存在的（同名同父）节点跳过，不重复建。
   * 中途失败不丢已建节点（FR-39g）：逐个写入，返回已完成数与失败原因。
   */
  async applyScan(input: {
    nodes: SuggestedNode[];
    projectName?: string;
  }): Promise<{
    created: number;
    skipped: number;
    failures: Array<{ key: string; reason: string }>;
    rootId?: string;
  }> {
    const { graph } = await this.derive();
    const index = buildIndex(graph);

    // 已有节点按 (parentKey 映射出的 id, name) 去重
    const existingByParentAndName = new Map<string, string>();
    for (const node of Object.values(graph.nodes)) {
      existingByParentAndName.set(`${node.parentId ?? 'root'}\u0000${node.name}`, node.id);
    }

    let created = 0;
    let skippedCount = 0;
    const failures: Array<{ key: string; reason: string }> = [];
    const idByKey = new Map<string, string>();

    // 先复用已存在的根（同名根不重复建）
    const existingRoot = graph.rootIds
      .map((id) => graph.nodes[id])
      .find((node) => node && node.parentId === null);
    if (existingRoot) {
      idByKey.set('root', existingRoot.id);
    }

    if (input.projectName !== undefined && input.projectName.trim() !== '') {
      const meta = await this.port.getMeta(this.projectId);
      if (meta) await this.port.putMeta({ ...meta, projectName: input.projectName, updatedAt: this.deps.clock.now() });
    }

    for (const suggested of input.nodes) {
      const parentId =
        suggested.parentKey === null ? null : (idByKey.get(suggested.parentKey) ?? null);
      if (suggested.parentKey !== null && parentId === null) {
        failures.push({ key: suggested.key, reason: `父节点 ${suggested.parentKey} 未建成，跳过` });
        continue;
      }
      const existing = existingByParentAndName.get(`${parentId ?? 'root'}\u0000${suggested.name}`);
      if (existing) {
        idByKey.set(suggested.key, existing);
        skippedCount += 1;
        continue;
      }
      const added = await this.addNode({
        parentId,
        name: suggested.name,
        kind: suggested.kind,
        autoCreated: true,
        ...(suggested.description !== undefined ? { description: suggested.description } : {}),
        ...(suggested.refs.length > 0
          ? { refs: suggested.refs.map((ref) => ({ type: ref.type, target: ref.target })) }
          : {}),
        by: 'user',
      });
      if (added.status === 'ok' && added.nodeId !== undefined) {
        idByKey.set(suggested.key, added.nodeId);
        created += 1;
      } else {
        const reason =
          'message' in added && typeof added.message === 'string'
            ? added.message
            : `写入被拒（${'code' in added ? String(added.code) : 'unknown'}）`;
        failures.push({ key: suggested.key, reason });
      }
    }

    void index;
    const rootId = idByKey.get('root');
    return { created, skipped: skippedCount, failures, ...(rootId !== undefined ? { rootId } : {}) };
  }

  /** 写入块归属（供工具做 rev/structRev 校验说明）。 */
  static blockOfPatch(patch: PatchFields): string {
    return blockOf(patch);
  }
}

/** 计算两份图的节点差异（用于只写变化的记录）。 */
function diffNodeIds(
  before: GraphSnapshot | undefined,
  after: GraphSnapshot,
): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(after.nodes)) {
    const prev = before?.nodes[id];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(node)) out.push(id);
  }
  return out;
}

/** 收集整枝 id（含自身）。 */
function collectSubtree(index: ReturnType<typeof buildIndex>, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const childId of index.childrenOf.get(current) ?? []) stack.push(childId);
  }
  return out;
}

/** 整枝（不含自身），用于快照覆盖范围。 */
function collectBranch(index: ReturnType<typeof buildIndex>, rootId: string): string[] {
  return collectSubtree(index, rootId).filter((id) => id !== rootId);
}

/**
 * 两条路径是否指向同一个工作区。
 *
 * 用归一化比较（大小写/斜杠/结尾斜杠/`\\?\` 前缀），否则"同一个工作区"会被认成两个，
 * 于是每个写法都新建一个项目。
 */
function isSameRoot(a: string, b: string): boolean {
  return normalizeRootPath(a) === normalizeRootPath(b);
}

/**
 * 尽力从环境推断工作区根。
 *
 * DSH 的工作区 cwd 是 **per-call** 值（`exec.agent.session.header.cwd`），
 * 不在 `ctx` 上；因此在没有 agent 上下文时回落到 `DSH_WORKSPACE`/`PWD`，
 * 有 agent 上下文时由工具层显式传入（见 `src/tools/`）。
 */
function readWorkspaceRootFromEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return undefined;
  return env['DSH_WORKSPACE'] ?? env['PWD'] ?? env['INIT_CWD'] ?? undefined;
}







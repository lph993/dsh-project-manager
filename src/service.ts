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

/**
 * 扫描默认排除项（FR-39h：默认排除 `node_modules`、**构建产物**、`.git`）。
 *
 * 目录名按前缀排除；文件用 glob（`**.map` 这类要跨目录，`*` 不跨 `/`）。
 * 注意：`lib` 也被排除 —— 本插件自己的工作区就是反例（首版扫描把 `lib/index.js`、
 * `client.js`、`.map` 全建成了"任务点"，用户一眼就看出不对）。
 */
export const DEFAULT_SCAN_EXCLUDE: readonly string[] = [
  'node_modules',
  '.git',
  '.pm',
  'dist',
  'build',
  'lib',
  'out',
  'esm',
  'cjs',
  'umd',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.output',
  'storybook-static',
  'tmp',
  '**.map',
  '**.min.js',
  '**.min.css',
  '**.tsbuildinfo',
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
import type { HeuristicCoefficients } from './weight/heuristic.ts';
import { collectSkeleton } from './ai/skeleton.ts';
import {
  AI_TREE_SYSTEM_PROMPT,
  buildTreePrompt,
  describeEstimate,
  estimateAiBuild,
  type AiEstimate,
} from './ai/prompt.ts';
import { callTreeBuilder, llmStreamOf, type LlmStreamLike } from './ai/tree-builder.ts';
import { llmAvailable, resolveAiRoute } from './ai/route.ts';
import type { AiTree } from './ai/parse.ts';
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
  /** 零 token 启发式权重轨开关（§9.3a），默认关闭 —— 默认口径是按件数。 */
  heuristicWeight: boolean;
  /** 零 token 启发式权重系数（§9.3a）。 */
  heuristicCoefficients: HeuristicCoefficients;
  /** AI 建树用的模型路由（FR-81a）；留空则跟随宿主默认模型。 */
  aiProvider?: string;
  aiModel?: string;
  /** 单次 AI 建树的输出 token 上限（FR-81b 的预算闸门）。 */
  aiMaxOutputTokens: number;
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
  /** 权重来源（`heuristic` = 零 token 结构评分；`ai` = 模型测量）。 */
  weightSource?: 'ai' | 'heuristic';
  /** 权重依据（信号构成 / AI 评语），供 UI 展示"为什么是这个权重"。 */
  weightDetail?: Record<string, unknown>;
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
    //
    // 但"工具调用报告过"不是唯一可信信号：面板按会话解析出的根、以及**已绑定的项目根**
    // 同样是明确意图（否则"只开面板不开工具"的会话永远没有外部改动感知——实测踩过）。
    const explicit =
      this.workspaceRootOverride ?? this.pendingRoot ?? this.boundRoot;
    if (explicit === undefined) return;
    // 只在"要监听的根"就是当前操作根时才起，避免监听到另一个工作区
    if (!isSameRoot(explicit, root)) return;

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
    /** 零 token 启发式权重（阶段 A 建树时一并写入，§9.3a）。 */
    weight?: number;
    weightSource?: 'ai' | 'heuristic';
    weightDetail?: Record<string, unknown>;
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
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.weightSource !== undefined ? { weightSource: input.weightSource } : {}),
        ...(input.weightDetail !== undefined ? { weightDetail: input.weightDetail } : {}),
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

  /**
   * 面板内确认后的整枝删除（FR-57 的**面板路径**）。
   *
   * 与 {@link removeBranch}（模型路径）的区别：模型路径必须过 `ctx.approval` 一次性授权，
   * 不可用时**拒绝**（FR-136）；而面板路径的确认人是**当场在场的用户**，
   * 由面板自己的确认框承载（§6.7f 第 2 行），因此不占用审批通道。
   * 模型无法调用本方法：它只挂在 HTTP 路由上，模型只有 `pm_*` 工具。
   *
   * 两阶段：先返回 preview（影响范围），确认后才真正落库。
   */
  async removeBranchFromPanel(input: {
    nodeId: string;
    policy: 'record' | 'code' | 'comment';
    confirm?: boolean;
    rev?: number;
  }): Promise<
    | { status: 'needs-confirm'; preview: string; action: 'remove-branch' }
    | ApplyResult
  > {
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
    if (input.confirm !== true) {
      return { status: 'needs-confirm', preview, action: 'remove-branch' };
    }
    debugBus.info('remove', `面板确认删除整枝「${node.name}」（policy=${input.policy}）`, {
      nodeId: input.nodeId,
      channel: 'panel',
    });
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
    // 墓碑（已删除节点）不进看板：删除是 tombstone 记录（留作回滚/审计），
    // 但画布上再显示出来会让用户以为删除没生效（§9.1 墓碑不变量 T-c）
    const liveNodes = [...derived.nodes.values()].filter((d) => d.derivedState !== 'removed');
    const views = liveNodes
      .map((d) => this.toView(derived, d.node.id))
      .filter((v): v is NodeView => v !== undefined);

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
      scanBand: liveNodes
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
    if (d.node.weightSource !== undefined) view.weightSource = d.node.weightSource;
    if (d.node.weightDetail !== undefined) view.weightDetail = d.node.weightDetail;
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
    /** 是否附零 token 启发式权重（默认取设置项，默认关闭 —— 默认口径是按件数）。 */
    attachWeights?: boolean;
    /** 启发式权重系数覆盖（仅在开启权重时生效）。 */
    coefficients?: HeuristicCoefficients;
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
    // 权重默认关闭（节点是功能点/任务点，进度不该由代码行数决定）→ 也就**不必**读盘数行数。
    // 关掉之后阶段 A 是真正的"只看文件树"，不读任何文件内容。
    const attachWeights = input?.attachWeights ?? this.deps.config.heuristicWeight;
    const walked = await scanWorkspaceEntries({
      root,
      maxDepth: input?.maxDepth ?? 6,
      exclude: excluded,
      countLines: attachWeights,
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
      ...(attachWeights
        ? {
            attachWeights: true,
            coefficients: input?.coefficients ?? this.deps.config.heuristicCoefficients,
          }
        : {}),
    };

    const result = buildSuggestedTree(walked.entries, options);
    result.skipped += walked.skipped;
    // 如实交代行数统计的代价与估算占比（只有开了权重才会读盘）
    const stats = walked.lineCountStats;
    if (attachWeights && stats.estimated > 0) {
      result.notes.push(
        `行数统计：实测 ${stats.filesRead} 个文件（${Math.round(stats.bytesRead / 1024)} KB），` +
          `${stats.estimated} 个文件按字节数**估算**行数（过大/非文本/超出读盘预算）。` +
          '估算值已在权重依据里标注。',
      );
    }
    if (!attachWeights) {
      result.notes.push(
        '口径：按件数（每个任务点等权）。节点是功能点/任务点，进度由任务本身的完成度决定，' +
          '不从代码行数推算 —— "还要写多少代码"这类周期/体量估算本插件不做（§9.4）。',
      );
    }
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
    const { graph, derived } = await this.derive();
    const index = buildIndex(graph);
    /** 墓碑（已删除）不参与去重：删了再扫必须能重建同名节点（§9.1 墓碑不变量 T-b）。 */
    const isRemoved = (nodeId: string): boolean =>
      derived.nodes.get(nodeId)?.derivedState === 'removed';

    // 已有**活**节点按 (parentId, name) 去重
    const existingByParentAndName = new Map<string, string>();
    for (const node of Object.values(graph.nodes)) {
      if (isRemoved(node.id)) continue;
      existingByParentAndName.set(`${node.parentId ?? 'root'}\u0000${node.name}`, node.id);
    }

    let created = 0;
    let skippedCount = 0;
    const failures: Array<{ key: string; reason: string }> = [];
    const idByKey = new Map<string, string>();

    // 先复用已存在的根（同名根不重复建；墓碑根不算）
    const existingRoot = graph.rootIds
      .map((id) => graph.nodes[id])
      .find((node) => node !== undefined && node.parentId === null && !isRemoved(node.id));
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
        // 零 token 启发式权重随建树一起落库（§9.3a）：否则"刚建好的树"没有权重，
        // 百分比会先按件数显示、下一次写才跳变
        ...(suggested.weight !== undefined ? { weight: suggested.weight } : {}),
        ...(suggested.weightSource !== undefined
          ? { weightSource: suggested.weightSource }
          : {}),
        ...(suggested.weightDetail !== undefined
          ? { weightDetail: { ...suggested.weightDetail } }
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

  // ── AI 建树（阶段 B：唯一会花 token 的路径）────────────────────────

  /**
   * 单次 AI 调用的输出 token 上限。
   *
   * 配置缺失/非法时回落到保守默认值：早先直接把 `config.aiMaxOutputTokens` 往下传，
   * 在"配置不全"的宿主上会算出 `totalTokens: null` 并把档位误判成 large
   * （面板上就是一句吓人的假数字）。
   */
  private aiMaxOutputTokens(): number {
    const configured = this.deps.config.aiMaxOutputTokens;
    return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 8192;
  }

  /**
   * AI 建树的成本预估（**不调用模型**）。
   *
   * 只用手上已有的元数据：遍历到的目录/文件数、关键文件签名字节。
   * 用户要先看到这个数字，才会被允许真正发起调用（§9.5 T3 / FR-39b）。
   */
  async aiBuildEstimate(input?: { sessionId?: string }): Promise<
    | { available: true; estimate: AiEstimate; description: string; route: string }
    | { available: false; reason: string; hint: string; estimate?: AiEstimate }
  > {
    const root = this.resolveRoot(input?.sessionId).root;
    if (root === undefined) {
      return {
        available: false,
        reason: 'no-workspace-root',
        hint: '还没解析到工作区根，AI 建树不知道要读哪个仓库。',
      };
    }

    const route = resolveAiRoute({
      ctx: this.ctx,
      configProvider: this.deps.config.aiProvider,
      configModel: this.deps.config.aiModel,
    });
    const collected = await this.collectAiSkeleton(root);
    const estimate = estimateAiBuild({
      entries: collected.skeleton.length,
      signatureBytes: collected.signatureBytes,
      promptBytes: collected.promptBytes,
      maxOutputTokens: this.aiMaxOutputTokens(),
    });

    if (!route.ok) return { available: false, reason: route.reason, hint: route.hint, estimate };
    if (!llmAvailable(this.ctx)) {
      return {
        available: false,
        reason: 'llm-unavailable',
        hint: '宿主没有 llm 服务（ctx.llm 缺失），无法发起 AI 调用。',
        estimate,
      };
    }
    return {
      available: true,
      estimate,
      description: describeEstimate(estimate),
      route: `${route.route.provider} / ${route.route.model}（${route.route.source === 'config' ? '设置' : '跟随默认模型'}）`,
    };
  }

  /**
   * 用 AI 从仓库生成功能/任务树（FR-39 默认建树路径）。
   *
   * 两阶段：`confirm !== true` 只回成本预估；确认后才调用模型并落库。
   * **确认人是面板前的用户**（§6.7f 第 2 行）；模型侧要走这条路必须显式说明来源，
   * 且本方法不经过 `ctx.approval` —— 因此**不注册成工具**，只挂 HTTP 路由。
   */
  async aiBuildTree(input: {
    confirm?: boolean;
    sessionId?: string;
    maxNodes?: number;
    /**
     * 是否先清掉"上次自动建出的草稿节点"（默认 true）。
     *
     * 阶段 A 的草稿（目录骨架）与阶段 B 的 AI 树是**两套命名**，追加会得到一堆重复语义的节点。
     * 默认按 §6.4b 的语义"阶段 B 改写骨架"：只清掉**没人动过**的自动节点
     * （`autoCreated` 且 `pending` 且进度 0），人已经推进过的一律保留。
     */
    replaceAutoDraft?: boolean;
    /** 测试注入：假的流式实现（生产传 undefined，走 ctx.llm）。 */
    stream?: LlmStreamLike;
    signal?: AbortSignal;
  }): Promise<
    | { status: 'needs-confirm'; estimate: AiEstimate; description: string; route: string }
    | { status: 'denied'; reason: string; hint: string; estimate?: AiEstimate }
    | { status: 'error'; reason: string; message: string; rawText?: string }
    | {
        status: 'ok';
        projectName: string;
        created: number;
        updated: number;
        /** 清掉的阶段 A 草稿枝数（`replaceAutoDraft` 生效时 > 0）。 */
        removed: number;
        failures: Array<{ name: string; reason: string }>;
        notes: string[];
        estimate: AiEstimate;
        /** 模型给的节点数（落库前的原始数量）。 */
        proposed: number;
      }
  > {
    const preflight = await this.aiBuildEstimate(
      input.sessionId !== undefined ? { sessionId: input.sessionId } : {},
    );
    if (!preflight.available) {
      return {
        status: 'denied',
        reason: preflight.reason,
        hint: preflight.hint,
        ...(preflight.estimate !== undefined ? { estimate: preflight.estimate } : {}),
      };
    }
    if (input.confirm !== true) {
      return {
        status: 'needs-confirm',
        estimate: preflight.estimate,
        description: preflight.description,
        route: preflight.route,
      };
    }

    const root = this.resolveRoot(input.sessionId).root;
    if (root === undefined) {
      return { status: 'denied', reason: 'no-workspace-root', hint: '工作区根丢失，请刷新后重试。' };
    }
    const route = resolveAiRoute({
      ctx: this.ctx,
      configProvider: this.deps.config.aiProvider,
      configModel: this.deps.config.aiModel,
    });
    if (!route.ok) return { status: 'denied', reason: route.reason, hint: route.hint };

    const collected = await this.collectAiSkeleton(root);
    const prompt = buildTreePrompt({
      projectName: collected.projectName,
      skeleton: collected.skeleton,
      maxNodes: input.maxNodes ?? 60,
      ...(collected.truncated ? { truncated: true } : {}),
      ...(collected.skipped > 0 ? { skipped: collected.skipped } : {}),
    });

    const call = await callTreeBuilder({
      ctx: this.ctx,
      route: route.route,
      system: AI_TREE_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: this.aiMaxOutputTokens(),
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!call.ok) {
      debugBus.error('ai', `AI 建树失败：${call.message}`, { reason: call.reason });
      return {
        status: 'error',
        reason: call.reason,
        message: call.message,
        ...(call.rawText !== undefined ? { rawText: call.rawText } : {}),
      };
    }

    const applied = await this.applyAiTree(call.parsed.value, call.parsed.notes, {
      replaceAutoDraft: input.replaceAutoDraft !== false,
    });
    debugBus.info(
      'ai',
      `AI 建树完成：新建 ${applied.created}，更新 ${applied.updated}，失败 ${applied.failures.length}`,
    );
    return {
      status: 'ok',
      projectName: applied.projectName,
      created: applied.created,
      updated: applied.updated,
      removed: applied.removed,
      failures: applied.failures,
      notes: [...call.parsed.notes, ...applied.notes],
      estimate: preflight.estimate,
      proposed: call.parsed.value.nodes.length,
    };
  }

  /** 采集骨架 + 组装提示词（估成本与实际调用共用同一份输入）。 */
  private async collectAiSkeleton(root: string): Promise<{
    skeleton: Awaited<ReturnType<typeof collectSkeleton>>['skeleton'];
    signatureBytes: number;
    promptBytes: number;
    truncated: boolean;
    skipped: number;
    projectName: string;
  }> {
    const walked = await scanWorkspaceEntries({
      root,
      maxDepth: 6,
      exclude: [...DEFAULT_SCAN_EXCLUDE],
      countLines: false,
    });
    const collected = await collectSkeleton({ root, entries: walked.entries });
    if (collected.unreadable.length > 0) {
      debugBus.warn('ai', `有 ${collected.unreadable.length} 个关键文件读不到签名（已如实跳过）`);
    }
    const promptBytes = Buffer.byteLength(
      buildTreePrompt({
        projectName: walked.packageName ?? walked.rootDirName,
        skeleton: collected.skeleton,
        maxNodes: 60,
      }),
      'utf8',
    );
    return {
      skeleton: collected.skeleton,
      signatureBytes: collected.signatureBytes,
      promptBytes,
      truncated: collected.truncated,
      skipped: walked.skipped,
      projectName: walked.packageName ?? walked.rootDirName,
    };
  }

  /**
   * 把模型给的树落库。
   *
   * 约定（§9.3a/§9.3b）：
   * - `weight` → `weightSource: 'ai'` + `weightDetail = { source:'ai', note }`（可核对）；
   * - `progress` → 通过 `progress()` 写，**记为 AI 初判**（不会覆盖人写过的值，见下）；
   * - 已存在同名同父的**活**节点 → 复用并更新（幂等重跑不重复建树）。
   */
  private async applyAiTree(
    tree: AiTree,
    _notes: string[],
    options?: { replaceAutoDraft?: boolean },
  ): Promise<{
    projectName: string;
    created: number;
    updated: number;
    removed: number;
    failures: Array<{ name: string; reason: string }>;
    notes: string[];
  }> {
    const notes: string[] = [];
    const { graph, derived } = await this.derive();
    const failures: Array<{ name: string; reason: string }> = [];
    let created = 0;
    let updated = 0;
    let removed = 0;
    let workingGraph = graph;

    // ① 先清掉"没人动过的**阶段 A** 草稿"（阶段 B 改写阶段 A 的骨架，§6.4b）
    //
    // 只清阶段 A 的目录骨架（`autoCreated` 且**没有** AI 权重来源），理由：
    // ① AI 树的命名与目录骨架完全不同，追加会得到一堆语义重复的节点；
    // ② AI 上次建出的树**必须留着** —— 否则"重跑一次"会把人工已经推进过的
    //    AI 节点连同进度一起埋掉，那是最不能接受的一种自动清理。
    if (options?.replaceAutoDraft !== false) {
      const untouchedAuto = new Set(
        Object.values(workingGraph.nodes)
          .filter((node) => {
            const state = derived.nodes.get(node.id);
            return (
              node.autoCreated === true &&
              node.weightSource !== 'ai' &&
              state !== undefined &&
              state.derivedState !== 'removed' &&
              node.selfState === 'pending' &&
              state.progress === 0
            );
          })
          .map((node) => node.id),
      );
      // 只删"最上层"的那些（子孙跟着整枝走）
      const topmost = [...untouchedAuto].filter((id) => {
        const parentId = workingGraph.nodes[id]?.parentId ?? null;
        return parentId === null || !untouchedAuto.has(parentId);
      });
      for (const id of topmost) {
        const name = workingGraph.nodes[id]?.name ?? id;
        const result = mutateRemove(
          workingGraph,
          { nodeId: id, policy: 'record', by: 'user' },
          this.mutationContext(),
        );
        const applied = await this.persist(result);
        if (applied.status === 'ok') {
          removed += 1;
        } else {
          notes.push(`清理自动草稿「${name}」失败，已保留`);
        }
      }
      if (removed > 0) {
        notes.push(`已先清掉 ${removed} 个自动生成的草稿枝（仅删记录，可回滚）`);
        const refreshed = await this.derive();
        workingGraph = refreshed.graph;
      }
    }

    const idByIndex: Array<string | null> = [];

    for (const [index, node] of tree.nodes.entries()) {
      const parentId = node.parent === null ? null : (idByIndex[node.parent] ?? null);
      if (node.parent !== null && parentId === null) {
        failures.push({ name: node.name, reason: `父节点 #${node.parent} 未建成` });
        idByIndex[index] = null;
        continue;
      }
      const existing = Object.values(graph.nodes).find(
        (candidate) =>
          candidate.parentId === parentId &&
          candidate.name === node.name &&
          derived.nodes.get(candidate.id)?.derivedState !== 'removed',
      );
      if (existing) {
        idByIndex[index] = existing.id;
        updated += 1;
      } else {
        const added = await this.addNode({
          parentId,
          name: node.name,
          kind: node.kind,
          autoCreated: true,
          by: 'user',
          ...(node.refs.length > 0 ? { refs: node.refs } : {}),
          ...(node.note !== undefined ? { description: node.note } : {}),
          ...(node.weight !== undefined
            ? {
                weight: node.weight,
                weightSource: 'ai' as const,
                weightDetail: {
                  source: 'ai',
                  ...(node.note !== undefined ? { note: node.note } : {}),
                },
              }
            : {}),
        });
        if (added.status === 'ok' && added.nodeId !== undefined) {
          idByIndex[index] = added.nodeId;
          created += 1;
        } else {
          idByIndex[index] = null;
          failures.push({
            name: node.name,
            reason:
              'message' in added && typeof added.message === 'string'
                ? added.message
                : `写入被拒（${'code' in added ? String(added.code) : 'unknown'}）`,
          });
          continue;
        }
      }

      // 完成度初判：只在**从未写过进度**的节点上写，绝不覆盖人/会话写过的值（§9.3b 优先级）
      const nodeId = idByIndex[index];
      if (nodeId !== null && node.progress !== undefined && node.progress > 0) {
        const current = await this.nodeView(nodeId);
        const untouched =
          current !== undefined && current.selfState === 'pending' && current.progress === 0;
        if (untouched) {
          const written = await this.progress({
            nodeId,
            progress: node.progress,
            by: 'user',
            reason: 'AI 建树时的完成度初判（依据仓库现状；可被后续人工/会话值覆盖）',
          });
          if (written.status !== 'ok') {
            notes.push(
              `「${node.name}」的完成度初判未写入（${
                'message' in written && typeof written.message === 'string'
                  ? written.message
                  : written.status
              }）`,
            );
          } else {
            notes.push(`「${node.name}」完成度初判 ${Math.round(node.progress * 100)}%（来源：AI 初判）`);
          }
        } else if (current !== undefined && current.selfState !== 'pending') {
          notes.push(`「${node.name}」已有状态/进度，跳过 AI 初判`);
        }
      }
    }

    if (tree.projectName !== undefined && tree.projectName.trim() !== '') {
      const meta = await this.port.getMeta(this.projectId);
      if (meta) {
        await this.port.putMeta({
          ...meta,
          projectName: tree.projectName.trim(),
          updatedAt: this.deps.clock.now(),
        });
      }
    }

    return {
      projectName: tree.projectName?.trim() ?? workingGraph.projectName,
      created,
      updated,
      removed,
      failures,
      notes,
    };
  }

  // ── 面板右键菜单的动作分发（FR-50–58b 的面板路径）────────────────────

  /**
   * 面板内发起的节点动作（右键菜单）。
   *
   * **为什么是一个分发口而不是十个路由**：这些动作的确认语义完全一样
   * （面板前的用户点了一下 = 确认，§6.7f 第 2 行），合并成一个入口后
   * "哪些动作需要二次确认"就只有一处判据，不会漏。
   *
   * 模型侧走不到这里（模型只有 `pm_*` 工具，那条路必须过 `ctx.approval` 且 fail-closed）。
   */
  async panelNodeAction(input: {
    action:
      | 'focus'
      | 'unfocus'
      | 'pause'
      | 'resume'
      | 'hold'
      | 'release'
      | 'add-child'
      | 'rename'
      | 'describe'
      | 'snapshot';
    nodeId: string;
    /** 需要二次确认的动作：`confirm !== true` 时只回影响范围。 */
    confirm?: boolean;
    /** `add-child` / `rename` / `describe` 的文本输入。 */
    text?: string;
    reason?: string;
    by?: 'user' | 'session';
  }): Promise<{
    status: 'ok' | 'needs-confirm' | 'denied';
    action: string;
    /** 需要确认时的说明（面板直接显示）。 */
    preview?: string;
    message?: string;
    code?: string;
    /** 让面板把结果说得更具体（如新节点 id、交接文档名）。 */
    detail?: Record<string, unknown>;
  }> {
    const { graph, derived } = await this.derive();
    const node = graph.nodes[input.nodeId];
    if (!node) {
      return { status: 'denied', action: input.action, code: 'E_NOT_FOUND', message: '节点不存在' };
    }
    const view = await this.nodeView(input.nodeId);
    const isLeaf = (view?.childCount ?? 0) === 0;
    const by = input.by ?? 'user';

    /** 破坏性动作：先给影响范围，确认后再执行。 */
    const destructive =
      input.action === 'pause' || input.action === 'hold' || input.action === 'snapshot';
    if (destructive && input.confirm !== true) {
      const lines = [
        input.action === 'pause'
          ? `将暂停「${node.name}」及其整枝，并生成《继续交接文档》+ 自动回滚点`
          : input.action === 'hold'
            ? `将拦停「${node.name}」及其整枝（仅父节点），生成《放行交接文档》+ 整枝回滚点`
            : `将为「${node.name}」建立一个手动回滚点（不暂停任务）`,
        `- 节点：${node.name}（${isLeaf ? '叶任务' : `枝，含 ${view?.leafCount ?? 0} 个叶节点`}）`,
        '- 未覆盖项：shell 命令产生的写入、外部进程与其他工具的改动不在回滚范围内',
      ];
      return { status: 'needs-confirm', action: input.action, preview: lines.join('\n') };
    }

    switch (input.action) {
      case 'focus':
      case 'unfocus': {
        const result = await this.setFocus({
          nodeId: input.nodeId,
          focus: input.action === 'focus',
          by,
        });
        return this.panelResult(input.action, result);
      }
      case 'pause': {
        const result = await this.pauseNode({
          nodeId: input.nodeId,
          by,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        return this.panelResult('pause', result, {
          ...(result.handoff !== undefined ? { handoff: result.handoff.fileName } : {}),
          ...(result.snapshot !== undefined ? { snapshot: result.snapshot.snapshotId } : {}),
          ...(result.snapshot === undefined ? { snapshotSkipped: true } : {}),
        });
      }
      case 'hold': {
        const result = await this.holdNode({
          nodeId: input.nodeId,
          by,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        });
        return this.panelResult('hold', result, {
          ...(result.handoff !== undefined ? { handoff: result.handoff.fileName } : {}),
          ...(result.snapshot !== undefined ? { snapshot: result.snapshot.snapshotId } : {}),
        });
      }
      case 'resume': {
        const result = await this.resumeNode({ nodeId: input.nodeId, by });
        return this.panelResult('resume', result, {
          ...(result.handoff !== undefined ? { handoff: result.handoff.fileName } : {}),
        });
      }
      case 'release': {
        const result = await this.releaseNode({ nodeId: input.nodeId, by });
        return this.panelResult('release', result, {
          ...(result.handoff !== undefined ? { handoff: result.handoff.fileName } : {}),
        });
      }
      case 'add-child': {
        const name = (input.text ?? '').trim();
        if (name === '') {
          return { status: 'denied', action: 'add-child', code: 'E_NAME', message: '节点名称不能为空' };
        }
        const added = await this.addNode({ parentId: input.nodeId, name, by });
        return this.panelResult('add-child', added, {
          ...(added.nodeId !== undefined ? { nodeId: added.nodeId } : {}),
        });
      }
      case 'rename': {
        const name = (input.text ?? '').trim();
        if (name === '') {
          return { status: 'denied', action: 'rename', code: 'E_NAME', message: '节点名称不能为空' };
        }
        const renamed = await this.patchNode({ nodeId: input.nodeId, patch: { name }, by });
        return this.panelResult('rename', renamed);
      }
      case 'describe': {
        const description = (input.text ?? '').trim();
        if (description === '') {
          return { status: 'denied', action: 'describe', code: 'E_NAME', message: '描述不能为空' };
        }
        const described = await this.patchNode({
          nodeId: input.nodeId,
          patch: { description },
          by,
        });
        return this.panelResult('describe', described);
      }
      case 'snapshot': {
        const captured = await this.captureSnapshot({
          nodeId: input.nodeId,
          reason: 'manual',
          force: true,
        });
        // CaptureResult 用 `created` 表达"这次是否真的建了点"（内容没变时 created=false）
        if (captured.created && captured.snapshotId !== undefined) {
          return {
            status: 'ok',
            action: 'snapshot',
            message: `已建立回滚点 ${captured.snapshotId}`,
            detail: { snapshot: captured.snapshotId, reason: captured.reason },
          };
        }
        return {
          status: 'ok',
          action: 'snapshot',
          message: `未新建回滚点：${captured.reason}`,
          detail: { created: false, reason: captured.reason },
        };
      }
      default: {
        // 穷尽检查：新增动作时这里会编译报错，避免"加了菜单项却没有实现"
        const exhaustive: never = input.action;
        return { status: 'denied', action: String(exhaustive), message: '未知动作' };
      }
    }
  }

  /** 把 `ApplyResult` 归一化成面板需要的形状（成功/拒绝 + 说明）。 */
  private panelResult(
    action: string,
    result: ApplyResult,
    detail?: Record<string, unknown>,
  ): {
    status: 'ok' | 'denied';
    action: string;
    message?: string;
    code?: string;
    detail?: Record<string, unknown>;
  } {
    if (result.status === 'ok') {
      return {
        status: 'ok',
        action,
        message: '已完成',
        ...(detail !== undefined ? { detail } : {}),
      };
    }
    const message =
      'message' in result && typeof result.message === 'string'
        ? result.message
        : `被拒绝（${'code' in result ? String(result.code) : result.status}）`;
    return {
      status: 'denied',
      action,
      message,
      ...('code' in result ? { code: String(result.code) } : {}),
    };
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












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
  mutateReparent,
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
  DerivedState,
  Gate,
  ProgressStats,
  Ref,
  SelfState,
  Subscription,
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
import {
  cacheKey,
  decideCache,
  diffSignatures,
  signaturesOf,
  type CacheVerdict,
  type SignatureDiff,
  type SignatureMap,
} from './ai/cache.ts';
import { readAiCache, writeAiCacheEntry } from './adapter/ai-cache-store.ts';
import { readAiUsage, writeAiUsage } from './adapter/ai-usage-store.ts';
import {
  emptyUsageLedger,
  formatUsageLine,
  recordUsage,
  usageStatsOf,
  type AiUsageCall,
  type AiUsageScenario,
  type AiUsageStats,
} from './ai/usage.ts';
import {
  HANDOFF_PROMPT_VERSION,
  HANDOFF_SYSTEM_PROMPT,
  buildHandoffPrompt,
  callHandoffSupplement,
  estimateHandoffSupplement,
  type HandoffEstimate,
  type HandoffSupplementText,
} from './ai/handoff.ts';
import { llmAvailable, resolveAiRoute, type AiRoute } from './ai/route.ts';
import { FileLockManager } from './subscriptions/locks.ts';
import { NotifyLedger, inSessionScope, noticeFor, type NotifyNode } from './notify/index.ts';
import {
  boundaryReminderText,
  planBoundaryWriteback,
  shouldHandleBoundary,
  type BoundNode,
  type BoundaryKind,
} from './session/boundary.ts';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { clampTimeout } from '@deepseek-ai/dsh-timeout';

/**
 * 订阅的风险等级与等待数（FR-110）。
 *
 * 等级取**最高**意图：`read < write < exclusive` —— 一个节点上只要有一条独占订阅，
 * 看板就该按"独占"提示（那才是用户需要知道的并行风险）。
 */
function subscriptionRiskOf(
  bindings: readonly Subscription[],
  locks: FileLockManager,
): { subscriptionRisk?: 'read' | 'write' | 'exclusive'; subscriptionWaiting?: number } {
  if (bindings.length === 0) return {};
  const rank = { read: 0, write: 1, exclusive: 2 } as const;
  let top: 'read' | 'write' | 'exclusive' = 'read';
  for (const binding of bindings) {
    if (rank[binding.intent] > rank[top]) top = binding.intent;
  }
  const waiting = bindings.filter(
    (binding) =>
      binding.intent !== 'read' && !locks.isHeldBy(binding.subscriptionId),
  ).length;
  return { subscriptionRisk: top, ...(waiting > 0 ? { subscriptionWaiting: waiting } : {}) };
}
import type { AiTree } from './ai/parse.ts';
import { parseTreeResponse, type ParseOutcome } from './ai/parse.ts';
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
  /** 扫描参数（FR-81）：深度 / 单目录子项上限 / 节点数上限 / 包含排除 glob。 */
  scanMaxDepth?: number;
  scanMaxChildrenPerDir?: number;
  scanMaxNodes?: number;
  scanInclude?: string[];
  scanExclude?: string[];
  /**
   * 关键事件回写会话（FR-112/113/81d），**默认开启**。
   *
   * 只发关键事件（完成/异常/枝完成/门控变化）且按会话裁剪 —— 这不是"全量播报"开关。
   */
  notifyKeyEvents?: boolean;
  /** 静默模式（FR-116）：彻底关闭回写（写入面与锁不受影响）。 */
  notifySilent?: boolean;
  /**
   * 会话边界（子代理 / 回合 / 会话结束）上的进度修正，**默认开启**。
   *
   * 零 token：只把该 actor 订阅过、且仍是 `pending` 的节点推成 `running`，
   * 并提醒模型用 `pm_report` 汇报真实进度。关掉它就完全不介入。
   */
  sessionBoundaryWriteback?: boolean;
  /**
   * 把"进度纪律"讲给模型听（FR-104a 外的零成本通道），**默认开启**。
   *
   * 两个机制都来自官方 system-prompt 文档：静态段（`section`）+ 缓存安全的动态事实（`context`），
   * 外加边界时往 inbox 投一条提醒（`agent.inject`，**不会唤醒** agent，因此不产生 token）。
   * 关掉它只影响"模型被告知"，不影响边界上的零 token 状态推进。
   */
  sessionBoundaryPrompt?: boolean;
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

/**
 * 提示词/解析口径的版本号。
 *
 * **改这个常量 = 让所有旧缓存失效**：解析规则变了还复用旧结论，会给出与当前口径不符的树。
 * 提示词本身已经参与哈希（改了提示词自然失效）；这个版本号管的是"提示词没变但解析口径变了"。
 */
const AI_PROMPT_VERSION = 'tree-v3';

/** 把增量压成"给人看的一小段"（完整列表可能很长，全塞进返回值只会淹没重点）。 */
function changedSummary(diff: SignatureDiff): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  return {
    added: diff.added.slice(0, 20),
    removed: diff.removed.slice(0, 20),
    changed: diff.changed.slice(0, 20),
  };
}

/**
 * 解析缓存里的半份文本（T9 续跑）。
 *
 * 复用**同一套**容错解析器：续跑不能因为"少了尾巴"就整份丢弃 —— 解析器本来就允许部分树。
 */
function safeParseCached(rawText: string | undefined): Extract<ParseOutcome, { ok: true }> | undefined {
  if (rawText === undefined || rawText.trim() === '') return undefined;
  try {
    const parsed = parseTreeResponse(rawText);
    return parsed.ok ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把缓存里的 `tree` 还原成"和解析结果同形"的东西。
 *
 * 缓存是 JSON 落盘的，读回来是 `unknown`：这里做一次**结构自检**再复用 ——
 * 手工改坏的缓存文件不该被当成有效结论（宁可当成未命中，重新调模型）。
 */
function completeTreeOf(tree: unknown): Extract<ParseOutcome, { ok: true }> | undefined {
  if (tree === null || typeof tree !== 'object') return undefined;
  const candidate = tree as { nodes?: unknown; notes?: unknown };
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) return undefined;
  return {
    ok: true,
    value: tree as AiTree,
    notes: Array.isArray(candidate.notes)
      ? candidate.notes.filter((note): note is string => typeof note === 'string')
      : [],
  };
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
  /** 每个节点有几个可用回滚点（`nodeId → 数量`）；菜单据此决定「回滚」显不显示。 */
  rollbackPoints: Record<string, number>;
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
 * 一次会话边界修正的结果（`sessionBoundary`）。
 *
 * `reminder` 是**给模型看的那句话**本身：调用方（`src/index.ts`）可以直接把它投进会话，
 * 也可以只记日志 —— 但服务自己已经投过一次（`injected`），所以正常路径不需要再投。
 */
export interface BoundaryOutcome {
  /** 本次推进的节点数（`pending + 0` → `running`）。 */
  patches: number;
  /** 是否真的把提醒投进了会话（`agent.inject` 成功）。 */
  reminded: boolean;
  /** 仍在进行中的节点名（最多 8 个，用于展示）。 */
  stillRunning: string[];
  /** 仍未完成的进行中节点**总数**（提醒里说的是这个数）。 */
  runningTotal: number;
  /** 提醒原文（没有可提醒的内容时为 undefined）。 */
  reminder?: string;
  /** 没做任何事的原因（去抖 / 没订阅 / 设置关掉了）。 */
  skipped?: string;
}

/**
 * 项目服务。
 */
export class ProjectService {
  readonly route: StoragePort['route'];

  private readonly ctx: Context;
  private readonly port: StoragePort;
  private deps: ProjectServiceDeps;

  /**
   * 文件级锁与等待队列（FR-106/107/108/110，§13.4）。
   *
   * 进程内内存态：锁是"同一时刻谁在写"的运行时事实，不落库（重启即全部释放 —— 这正是
   * FR-108 想要的"不留僵尸锁"）；订阅记录本身仍然落库（那是可审计的事实）。
   */
  private readonly locks = new FileLockManager();
  /**
   * 回写去重账本（FR-116）。
   *
   * 记的是"每个节点最后一次**已通知**的状态"：同一状态不重复推，状态再变还能继续推。
   * **只有真的投递成功才记账** —— 没有会话可投时不记，否则会话后来订阅了就永远收不到。
   */
  private readonly notifyLedger = new NotifyLedger();
  /** 边界修正的去抖记录（actorId → 上次处理时间）。 */
  private readonly boundarySeen = new Map<string, number>();
  /**
   * 绑定事实的**同步**快照（actorId → 该 actor 订阅的节点）。
   *
   * 存在的唯一理由：`ctx.systemPrompt.context()` 的 provider 是**同步函数**，
   * 而事实源在存储里、只能异步读。所以每次 `derive()` 顺手刷新这份投影，
   * provider 读它 —— 代价是一次 O(节点×绑定) 的内存整理，换掉"provider 里 await"这种不可能的事。
   */
  private readonly boundFacts = new Map<string, BoundNode[]>();
  /** 边界修正的累计统计（诊断页/设置页显示"这一层到底有没有在干活"）。 */
  private readonly boundaryStats = {
    runs: 0,
    patches: 0,
    reminders: 0,
    injected: 0,
    lastKind: '' as string,
    lastActorId: '',
    lastAt: '',
  };
  /**
   * 提示词层的注册状态。
   *
   * 为什么要记它：设置页会写"开启（状态推进 + 提示词纪律）"，而**真机上这一层曾经静默没挂上**
   * （未在 `inject` 里声明的服务在 cordis 里是 PENDING 的，属性读回来是个没有方法的待定对象，
   * 结构化探测于是判定"不可用"）。显示"已生效"而实际没生效，正是本项目最不能接受的那类
   * 不实陈述 —— 所以这个状态必须可见（设置页据此改口径）。
   */
  private promptRegistration: 'pending' | 'registered' | 'unavailable' = 'pending';
  /**
   * 官方注入进来的 `agents` 注册表（`ctx.inject(['agents'], …)` 交进来的）。
   *
   * 不写进插件的 `inject` 数组：`notify` 是可选能力，缺了它插件仍应正常工作
   * （§19.4 不变量：可选能力缺失不得阻断加载）。
   */
  private agentsService: { get?: (id: string) => unknown } | undefined;
  /** agents 缺失只警告一次。 */
  private agentsMissingWarned = false;
  /** 投递通道形状不对只警告一次（见 warnDeliveryShape）。 */
  private deliveryShapeWarned = false;
  /**
   * 插件自身的 AI 用量账本（`.pm/ai-usage.json`，懒加载）。
   *
   * 为什么要自己记：`ctx.llm.stream()` 是插件**直接发起**的调用，不走 agent 循环，
   * 因此**不在宿主的会话 token 计量里** —— 不自己记，这些花费就是不可见的
   * （用户诉求："这个插件可以出 token 使用统计，是插件自身的 AI 调用 token"）。
   */
  private aiUsage = emptyUsageLedger();
  private aiUsageLoaded = false;
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
        nodeId: result.nodeId,
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

    // 关键事件回写会话（FR-112–117）：**在写入成功之后**做，失败不影响写入本身。
    // 只对本次真正变动的节点判定事件，且只发关键事件（progress 微增不发）。
    try {
      await this.emitNotices(changedIds);
    } catch (error) {
      debugBus.warn(
        'notify',
        `回写失败（不影响写入）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

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
    /**
     * 回滚还原通道（FR-67）。只有回滚路径传 true：它要能写回快照点的**任意**状态
     * （含 `done → pending`），且不被回滚锁挡住自己的还原写入。
     */
    restore?: boolean;
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
        ...(input.restore !== undefined ? { restore: input.restore } : {}),
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
   * 批量汇报（`pm_report`）：一次调用改多个节点。
   *
   * 为什么需要它：会话/子任务收尾时模型要"补账"，一个个 `pm_progress` 调用既慢又容易漏；
   * 批量入口把"收尾汇报"变成**一次**工具调用，这也是"AI 主动在会话结束时修正进度"的落地方式。
   *
   * 纪律：
   * - 逐项**独立**判定与落库（一项失败不影响其它项），每项结果如实回传；
   * - 与单条路径**共用**同一实现（`progress` / `finish`），不存在第二套写入规则（§12.4 不变量 2）；
   * - 上限 50 项：超出部分不执行、并在返回值里如实说明（不静默截断）。
   */
  async reportBatch(input: {
    updates: ReadonlyArray<{
      nodeId: string;
      progress?: number;
      selfState?: SelfState;
      /** 等价于 `pm_finish`：置 done 且 progress = 1。 */
      finish?: boolean;
      rev?: number;
      evidence?: string;
    }>;
    reason?: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<{
    applied: number;
    failed: number;
    truncated: number;
    results: Array<{
      nodeId: string;
      status: ApplyResult['status'];
      revision?: number;
      code?: string;
      message?: string;
    }>;
  }> {
    const limit = 50;
    const updates = input.updates.slice(0, limit);
    const truncated = Math.max(0, input.updates.length - updates.length);
    const results: Array<{
      nodeId: string;
      status: ApplyResult['status'];
      revision?: number;
      code?: string;
      message?: string;
    }> = [];
    let applied = 0;
    let failed = 0;
    for (const update of updates) {
      let result: ApplyResult;
      try {
        result =
          update.finish === true
            ? await this.finish({
                nodeId: update.nodeId,
                ...(update.rev !== undefined ? { rev: update.rev } : {}),
                ...(update.evidence !== undefined
                  ? { evidence: update.evidence }
                  : input.reason !== undefined
                    ? { evidence: input.reason }
                    : {}),
                ...(input.by !== undefined ? { by: input.by } : {}),
                ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
              })
            : await this.progress({
                nodeId: update.nodeId,
                ...(update.progress !== undefined ? { progress: update.progress } : {}),
                ...(update.selfState !== undefined ? { selfState: update.selfState } : {}),
                ...(update.rev !== undefined ? { rev: update.rev } : {}),
                ...(input.reason !== undefined ? { reason: input.reason } : {}),
                ...(input.by !== undefined ? { by: input.by } : {}),
                ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
              });
      } catch (error) {
        // 单项异常不外溢：批量汇报在收尾时调用，一项炸掉不该让整次汇报白做
        result = {
          status: 'denied',
          reason: 'error',
          code: 'E_REPORT_ITEM',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status === 'ok') {
        applied += 1;
        results.push({ nodeId: update.nodeId, status: 'ok', revision: result.revision });
      } else {
        failed += 1;
        results.push({
          nodeId: update.nodeId,
          status: result.status,
          ...('code' in result ? { code: result.code } : {}),
          ...('message' in result ? { message: result.message } : {}),
        });
      }
    }
    if (applied > 0) {
      debugBus.info('session', `批量汇报：${applied} 项成功 / ${failed} 项失败（by=${input.by ?? 'session'}）`, {
        actorId: input.actorId ?? null,
      });
    }
    return { applied, failed, truncated, results };
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
   * 交接文档的**模型补写**（FR-104a 场景⑤、§9.6.4）。
   *
   * 两条纪律写在这里：
   * - **预算前置**：`confirm !== true` 时只回估算，**一次调用都不发**（FR-101）；
   * - **不阻塞**：模型不可用/失败/被拒 → 交接文档照常产出，只在文首标注「模型补写部分已跳过」。
   */
  async estimateHandoffSupplement(input: { nodeId: string; kind: HandoffKind; reason?: string }): Promise<
    | { available: true; estimate: HandoffEstimate; route: string; cache: 'hit' | 'miss'; savedTokens?: number }
    | { available: false; reason: string; hint: string }
  > {
    const route = resolveAiRoute({
      ctx: this.ctx,
      configProvider: this.deps.config.aiProvider,
      configModel: this.deps.config.aiModel,
    });
    if (!route.ok) return { available: false, reason: route.reason, hint: route.hint };
    if (!llmAvailable(this.ctx)) {
      return {
        available: false,
        reason: 'llm-unavailable',
        hint: '宿主没有 llm 服务（ctx.llm 缺失）：交接文档仍会生成，只是不含模型补写。',
      };
    }
    const prepared = await this.prepareHandoffSupplement(input);
    const estimate = estimateHandoffSupplement({
      promptBytes: Buffer.byteLength(prepared.prompt, 'utf8'),
      maxOutputTokens: this.aiMaxOutputTokens(),
    });
    return {
      available: true,
      estimate,
      route: `${route.route.provider} / ${route.route.model}`,
      cache: prepared.cached === undefined ? 'miss' : 'hit',
      ...(prepared.cached !== undefined ? { savedTokens: estimate.totalTokens } : {}),
    };
  }

  /** 组装补写提示词 + 查缓存（估成本与实际调用**共用同一份**提示词，缓存键才可信）。 */
  private async prepareHandoffSupplement(input: {
    nodeId: string;
    kind: HandoffKind;
    reason?: string;
  }): Promise<{
    prompt: string;
    route: AiRoute;
    maxTokens: number;
    cached?: HandoffSupplementText;
  }> {
    const { graph, derived } = await this.derive();
    const index = buildIndex(graph);
    const record = graph.nodes[input.nodeId];
    const view = derived.nodes.get(input.nodeId);
    const unfinished: string[] = [];
    for (const id of [input.nodeId, ...subtreeIds(index, input.nodeId)]) {
      const node = derived.nodes.get(id);
      const nodeRecord = graph.nodes[id];
      if (node === undefined || nodeRecord === undefined) continue;
      if (node.childCount > 0) continue; // 只列任务点（叶）；枝的进展由机械小节交代
      if (node.derivedState === 'done' || node.derivedState === 'removed') continue;
      unfinished.push(`${nodeRecord.name}（进度 ${Math.round(node.progress * 100)}%）`);
    }
    const prompt = buildHandoffPrompt({
      kind: input.kind === 'hold' ? 'hold' : 'pause',
      nodeName: record?.name ?? input.nodeId,
      branchPath: branchPath(index, input.nodeId),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(record?.description !== undefined ? { description: record.description } : {}),
      unfinished,
      doneLeaves: Math.max(0, (view?.leafCount ?? 0) - (view?.unfinishedLeafCount ?? 0)),
      totalLeaves: view?.leafCount ?? 0,
      refs: (record?.refs ?? []).map((ref) => ref.target),
      flags: record?.flags ?? [],
    });
    const maxTokens = this.aiMaxOutputTokens();
    const route = resolveAiRoute({
      ctx: this.ctx,
      configProvider: this.deps.config.aiProvider,
      configModel: this.deps.config.aiModel,
    });
    if (!route.ok) return { prompt, route: { provider: '', model: '', source: 'config' }, maxTokens };
    const key = cacheKey({
      prompt,
      provider: route.route.provider,
      model: route.route.model,
      maxTokens,
      promptVersion: HANDOFF_PROMPT_VERSION,
    });
    const entries = await readAiCache(this.ctx);
    const verdict = decideCache(entries, key, {});
    const cached =
      verdict.kind === 'hit' ? (verdict.entry.tree as HandoffSupplementText | undefined) : undefined;
    return {
      prompt,
      route: route.route,
      maxTokens,
      ...(cached !== undefined && typeof cached.nextSteps === 'string' ? { cached } : {}),
    };
  }

  /** 真正发一次补写调用（含缓存命中与落盘）。失败**不抛**，由调用方决定降级。 */
  private async runHandoffSupplement(input: {
    nodeId: string;
    kind: HandoffKind;
    reason?: string;
    stream?: LlmStreamLike;
  }): Promise<
    | { ok: true; supplements: HandoffSupplementText; fromCache: boolean; tokens: number }
    | { ok: false; message: string }
  > {
    const prepared = await this.prepareHandoffSupplement(input);
    const estimate = estimateHandoffSupplement({
      promptBytes: Buffer.byteLength(prepared.prompt, 'utf8'),
      maxOutputTokens: prepared.maxTokens,
    });
    if (prepared.cached !== undefined) {
      debugBus.info('handoff', '交接补写命中缓存：零 token 复用');
      // 用量账本：复用 = 0 token，但把省下的量记上
      await this.recordAiUsage({
        at: this.deps.clock.now(),
        scenario: 'handoff',
        route: `${prepared.route.provider} / ${prepared.route.model}`,
        outcome: 'reused',
        estimatedTokens: estimate.totalTokens,
        usageSource: 'none',
      });
      return { ok: true, supplements: prepared.cached, fromCache: true, tokens: 0 };
    }
    const called = await callHandoffSupplement({
      route: prepared.route,
      system: HANDOFF_SYSTEM_PROMPT,
      user: prepared.prompt,
      maxTokens: prepared.maxTokens,
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
    });
    // 用量账本：失败也烧了 token（有真实用量就记真实值）
    await this.recordAiUsage({
      at: this.deps.clock.now(),
      scenario: 'handoff',
      route: `${prepared.route.provider} / ${prepared.route.model}`,
      outcome: called.ok ? 'ok' : 'error',
      estimatedTokens: estimate.totalTokens,
      ...(called.usage !== undefined ? { usage: called.usage } : {}),
      usageSource: called.usage !== undefined ? 'provider' : 'estimate',
    });
    if (!called.ok) return { ok: false, message: called.message };
    await writeAiCacheEntry(this.ctx, {
      key: cacheKey({
        prompt: prepared.prompt,
        provider: prepared.route.provider,
        model: prepared.route.model,
        maxTokens: prepared.maxTokens,
        promptVersion: HANDOFF_PROMPT_VERSION,
      }),
      status: 'complete',
      createdAt: this.deps.clock.now(),
      signatures: {},
      tree: called.supplements,
      tokens: estimate.totalTokens,
      route: `${prepared.route.provider} / ${prepared.route.model}`,
      maxTokens: prepared.maxTokens,
    });
    return {
      ok: true,
      supplements: called.supplements,
      fromCache: false,
      tokens: estimate.totalTokens,
    };
  }

  /**
   * 收集某个 actor（会话/子代理）订阅过的节点事实。
   *
   * 口径：只认**绑定记录**里出现的 `actorId` —— "谁订了"是唯一可审计的证据，
   * 不用"猜谁在做这个节点"。
   */
  private collectBoundNodes(
    graph: GraphSnapshot,
    derived: DerivedGraph,
    actorId: string,
  ): BoundNode[] {
    const bound: BoundNode[] = [];
    for (const [nodeId, record] of Object.entries(graph.nodes)) {
      const subscriber = (record.bindings ?? []).find((binding) => binding.actorId === actorId);
      if (subscriber === undefined) continue;
      const view = derived.nodes.get(nodeId);
      if (view === undefined) continue;
      bound.push({
        nodeId,
        name: record.name,
        selfState: record.selfState,
        derivedState: view.derivedState,
        gate: record.gate,
        progress: record.progress,
        // C5：父节点不能写自身状态 → 边界修正必须知道谁是叶节点
        leaf: (derived.index.childrenOf.get(nodeId) ?? []).length === 0,
      });
    }
    return bound;
  }

  /**
   * 同步读某个 actor 的绑定事实（提示词 provider 用，**不能 await**）。
   *
   * 数据由 `derive()` 顺手刷新；没刷新过就返回空数组 —— 宁可不显示，也不返回过期结论。
   */
  boundFactsOf(actorId: string | undefined): BoundNode[] {
    if (actorId === undefined) return [];
    return this.boundFacts.get(actorId) ?? [];
  }

  /** 用一次派生结果刷新同步快照（actorId → 绑定节点）。 */
  private refreshBoundFacts(graph: GraphSnapshot, derived: DerivedGraph): void {
    const actors = new Set<string>();
    for (const record of Object.values(graph.nodes)) {
      for (const binding of record.bindings ?? []) actors.add(binding.actorId);
    }
    this.boundFacts.clear();
    for (const actorId of actors) this.boundFacts.set(actorId, this.collectBoundNodes(graph, derived, actorId));
  }

  /**
   * **会话边界上的进度修正**（子代理 / 子任务回合 / 会话结束）。
   *
   * 由 `src/index.ts` 挂在 DSH 的 `agent/status`（→idle）与 `agent/disposed` 上调用。
   * 两层都不花 token：① 把该 actor 订阅过的 `pending` 节点推进为 `running`；
   * ② 给仍在进行中的节点投一条**不唤醒**的上下文（`agent.inject`），让模型在下一个
   * 真正需要动脑的时刻把数字补上（FR-114 口径）。
   *
   * 纪律：**绝不覆盖**人写过的进度（只推 `pending + 0`）、不碰已完成/已删除/被门控的节点、
   * 每个节点都写审计（谁在什么时候因为什么把它标成进行中）。
   */
  async sessionBoundary(input: {
    kind: BoundaryKind;
    actorId: string;
    now?: number;
    /**
     * 是否把提醒投进会话（`agent.inject`）。默认 true；`agent/disposed` 时调用方传 false
     * —— agent 都要没了，投进去也没人能看见。
     */
    remind?: boolean;
  }): Promise<BoundaryOutcome> {
    const now = input.now ?? Date.now();
    if (this.deps.config.sessionBoundaryWriteback === false) {
      return { patches: 0, reminded: false, stillRunning: [], runningTotal: 0, skipped: '设置里关掉了边界修正' };
    }
    if (!shouldHandleBoundary({ kind: input.kind, actorId: input.actorId, now, lastSeen: this.boundarySeen })) {
      return { patches: 0, reminded: false, stillRunning: [], runningTotal: 0, skipped: '去抖窗口内' };
    }
    this.boundarySeen.set(input.actorId, now);

    const { graph, derived } = await this.derive();
    const bound = this.collectBoundNodes(graph, derived, input.actorId);
    if (bound.length === 0) {
      return { patches: 0, reminded: false, stillRunning: [], runningTotal: 0, skipped: '该会话没有订阅任何节点' };
    }

    const plan = planBoundaryWriteback({ kind: input.kind, actorId: input.actorId, bound });
    // 只统计**真的落库成功**的写入：被校验拒绝（如 C5/C6）却报"已推进"是假汇报。
    const applied: string[] = [];
    for (const patch of plan.patches) {
      // 走 patchNode：`running` 是正常推进（不需要 force），且不覆盖已有进度
      const result = await this.patchNode({
        nodeId: patch.nodeId,
        patch: { selfState: patch.to },
        by: 'session',
        reason: patch.reason,
      });
      if (result.status === 'ok') {
        applied.push(patch.nodeId);
      } else {
        debugBus.warn(
          'session',
          `边界修正被拒（${patch.nodeId}）：${'code' in result ? result.code : result.status}`,
        );
      }
    }
    if (applied.length > 0) {
      debugBus.info(
        'session',
        `边界修正（${input.kind}）：${applied.length} 个节点 pending → running`,
        { actorId: input.actorId },
      );
    }
    // 审计：边界修正是"谁在什么时候因为什么把一个节点标成进行中"的事实记录。
    // **必须 try/catch**：审计写失败不该把已经落库的推进和提醒一起吞掉（这个 bug 真发生过 ——
    // 早先这里写 `nodeId: ''`，而 schema 是 `min(1)`，于是整个边界回调在写审计时抛掉，
    // 后面的统计与提醒全都没了，表面上却只看到"节点被推成 running 了"）。
    try {
      await this.port.appendAudit({
        attemptId: this.deps.random.uuid(),
        projectId: this.projectId,
        nodeId: null,
        block: 'session-boundary',
        op: {
          kind: input.kind,
          actorId: input.actorId,
          patched: applied,
          stillRunning: plan.stillRunning,
        },
        by: 'session',
        rev: 0,
        ts: this.deps.clock.now(),
      });
    } catch (error) {
      debugBus.warn(
        'session',
        `边界修正的审计写入失败（推进与提醒照常）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 提醒：走 `agent.inject`（**不唤醒** driver）—— 这是官方文档里 "添加模型可见上下文"
    // 的那条路：idle 的 agent 会把它挂到下一次 pre-step，因此**不会**在回合边界自动烧 token。
    const reminder = boundaryReminderText(plan);
    let reminded = false;
    if (
      reminder !== undefined &&
      input.remind !== false &&
      this.deps.config.notifySilent !== true &&
      input.kind !== 'agent-disposed'
    ) {
      reminded = this.injectContext(input.actorId, reminder);
      if (reminded) this.boundaryStats.injected += 1;
    }

    this.boundaryStats.runs += 1;
    this.boundaryStats.patches += applied.length;
    if (reminded) this.boundaryStats.reminders += 1;
    this.boundaryStats.lastKind = input.kind;
    this.boundaryStats.lastActorId = input.actorId;
    this.boundaryStats.lastAt = this.deps.clock.now();

    return {
      patches: applied.length,
      reminded,
      stillRunning: plan.stillRunning,
      runningTotal: plan.runningTotal,
      ...(reminder !== undefined ? { reminder } : {}),
    };
  }

  /**
   * 是否把"进度纪律"讲给模型听（配置开关的**同步**读法）。
   *
   * 存在的理由：提示词段的 provider 是同步函数，改设置时不可能重新注册段 ——
   * 所以 provider 每次组装都问一遍这个开关，关掉时返回空文本（官方口径：空段不贡献内容）。
   */
  boundaryPromptEnabled(): boolean {
    return this.deps.config.sessionBoundaryPrompt !== false;
  }

  /** 边界修正统计（FR-117 的同一份口径：设置页/诊断页可查）。 */
  boundaryStatsOf(): {
    runs: number;
    patches: number;
    reminders: number;
    injected: number;
    lastKind: string;
    lastActorId: string;
    lastAt: string;
    enabled: boolean;
    prompt: boolean;
    promptState: 'pending' | 'registered' | 'unavailable';
    promptRegistered: boolean;
  } {
    return {
      ...this.boundaryStats,
      enabled: this.deps.config.sessionBoundaryWriteback !== false,
      prompt: this.deps.config.sessionBoundaryPrompt !== false,
      promptState: this.promptRegistration,
      promptRegistered: this.promptRegistration === 'registered',
    };
  }

  /** 记录提示词层的注册结果（由 `src/index.ts` 在注册成功后/失败后调用）。 */
  notePromptRegistration(state: 'pending' | 'registered' | 'unavailable'): void {
    this.promptRegistration = state;
  }

  /** 读一次用量账本（懒加载：只有真要读/写统计时才碰盘）。 */
  private async ensureAiUsage(): Promise<void> {
    if (this.aiUsageLoaded) return;
    this.aiUsageLoaded = true;
    this.aiUsage = await readAiUsage(this.ctx);
  }

  /**
   * 记一次插件自身的 AI 调用（并落盘）。
   *
   * 落盘失败**只留诊断、绝不抛出**：调用已经花过钱了，不能因为统计写不进去就丢掉结果。
   */
  private async recordAiUsage(call: AiUsageCall): Promise<void> {
    await this.ensureAiUsage();
    this.aiUsage = recordUsage(this.aiUsage, call);
    await writeAiUsage(this.ctx, this.aiUsage);
    debugBus.debug('ai', `用量已记账：${call.outcome} · ${formatUsageLine(usageStatsOf(this.aiUsage))}`);
  }

  /**
   * 插件自身 AI 调用的 token 统计（设置页 / 诊断 / 工具共用同一份口径）。
   *
   * **只统计插件发起的调用**（建树、交接补写这类）；会话本身的 token 由宿主计量，不在这里。
   */
  async aiUsageStats(): Promise<AiUsageStats> {
    await this.ensureAiUsage();
    return usageStatsOf(this.aiUsage);
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
  }): Promise<
    ApplyResult & {
      subscriptionId?: string;
      lock?: { kind: 'granted' | 'queued' | 'rejected'; blockedBy: string[]; reason?: string };
    }
  > {
    const graph = await this.readGraph();
    const subscriptionId = this.deps.random.uuid();
    const touchedPaths = input.touchedPaths ?? [];
    /**
     * **先取文件锁，再登记订阅**（FR-107）。
     *
     * 排队/被拒时**仍然登记**订阅：`pm_watch_wait` 要能按 `subscriptionId` 等锁，
     * 用户也要在看板上看到"这条订阅在等"。锁状态本身就是返回值的一部分，不藏在日志里。
     */
    const outcome = this.locks.acquire({
      subscriptionId,
      nodeId: input.nodeId,
      intent: input.intent,
      touchedPaths,
      at: this.deps.clock.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      onConflict: this.deps.config.conflictPolicy === 'always-arbitrate' ? 'reject' : 'queue',
    });
    if (outcome.kind === 'rejected' && input.intent === 'exclusive') {
      // 独占被拒时**不登记**订阅：登记了却拿不到锁，只会让人以为"订阅成功了"
      return {
        status: 'denied',
        reason: 'validation',
        code: 'C_EXCLUSIVE',
        message: outcome.reason,
        hint: '等对方释放，或改用 write 并声明互不相交的 touchedPaths',
      } as ApplyResult & { lock?: never };
    }
    const result = mutateSubscribe(
      graph,
      {
        nodeId: input.nodeId,
        by: input.actor,
        actorId: input.actorId,
        subscription: {
          subscriptionId,
          actor: input.actor,
          actorId: input.actorId,
          intent: input.intent,
          notify: input.notify ?? 'key',
          touchedPaths,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        },
      },
      this.mutationContext(),
    );
    const applied = await this.persist(result);
    if (applied.status !== 'ok') {
      // 登记失败就把刚拿到的锁还回去，别留下没人认领的锁
      this.locks.release(subscriptionId, this.deps.clock.now());
    }
    return {
      ...applied,
      subscriptionId,
      lock: {
        kind: outcome.kind,
        blockedBy: outcome.kind === 'rejected' ? outcome.blockedBy : outcome.kind === 'queued' ? outcome.waitingFor : [],
        ...(outcome.kind === 'rejected' ? { reason: outcome.reason } : {}),
      },
    };
  }

  /** 释放订阅（同时释放它持有的文件锁，并让路给排队者）。 */
  async unsubscribe(input: {
    nodeId: string;
    subscriptionId: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult & { releasedTo?: string[] }> {
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
    const applied = await this.persist(result);
    const releasedTo = this.locks.release(input.subscriptionId, this.deps.clock.now());
    if (releasedTo.length > 0) {
      debugBus.info('watch', `释放订阅 ${input.subscriptionId}，锁让给 ${releasedTo.join('、')}`, {
        nodeId: input.nodeId,
      });
    }
    return { ...applied, releasedTo };
  }

  /**
   * 请求人工裁决（`pm_watch_arbitrate`，§13.3 / FR-138a）。
   *
   * **子代理不得自行放行**：来源是 `subagent` / `job` 时直接回 `needs-human`，
   * 附一句话冲突说明 + preview，让父会话或面板去裁决 —— 与破坏性操作同一套 fail-closed 纪律。
   */
  async requestArbitration(input: {
    nodeId: string;
    reason: string;
    conflict: unknown;
    by: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<{
    status: 'needs-human' | 'accepted';
    nodeId: string;
    reason: string;
    preview: string;
    hint?: string;
  }> {
    const preview = `${input.reason}\n当前锁冲突：${JSON.stringify(input.conflict)}`;
    await this.port.appendAudit({
      attemptId: this.deps.random.uuid(),
      projectId: this.projectId,
      nodeId: input.nodeId,
      block: 'watch-arbitrate',
      op: { reason: input.reason, by: input.by, conflict: input.conflict },
      by: input.by,
      rev: 0,
      ts: this.deps.clock.now(),
    });
    if (input.by === 'subagent' || input.by === 'job') {
      return {
        status: 'needs-human',
        nodeId: input.nodeId,
        reason: input.reason,
        preview,
        hint: '子代理不得自行裁决锁冲突：请由父会话或面板确认后重试（§13.3/FR-138a）',
      };
    }
    return {
      status: 'accepted',
      nodeId: input.nodeId,
      reason: input.reason,
      preview,
      hint: '已记入审计；可在看板/诊断里看冲突详情，或改用互不相交的 touchedPaths 重试',
    };
  }

  /** 某节点的订阅列表 + 锁状态（`pm_watchers`）。 */
  async watchers(nodeId: string): Promise<{
    nodeId: string;
    subscriptions: Array<{
      subscriptionId: string;
      actor: string;
      actorId: string;
      intent: string;
      notify: string;
      touchedPaths: string[];
      claimedAt: string;
      expiresAt?: string;
      holdsLock: boolean;
      blockedBy: string[];
    }>;
    conflicts: ReturnType<FileLockManager['snapshot']>['conflicts'];
  }> {
    const { graph } = await this.derive();
    const node = graph.nodes[nodeId];
    const snapshot = this.locks.snapshot();
    const conflicts = snapshot.conflicts.filter((entry) =>
      (node?.bindings ?? []).some((subscription) => subscription.touchedPaths.includes(entry.path)),
    );
    return {
      nodeId,
      subscriptions: (node?.bindings ?? []).map((subscription) => ({
        subscriptionId: subscription.subscriptionId,
        actor: subscription.actor,
        actorId: subscription.actorId,
        intent: subscription.intent,
        notify: subscription.notify,
        touchedPaths: [...subscription.touchedPaths],
        claimedAt: subscription.claimedAt,
        ...(subscription.expiresAt !== undefined ? { expiresAt: subscription.expiresAt } : {}),
        holdsLock: this.locks.isHeldBy(subscription.subscriptionId),
        blockedBy: this.locks.blockedBy(subscription.subscriptionId),
      })),
      conflicts,
    };
  }

  // ── 进度回写会话投影（Q6 / FR-112–118）─────────────────────────

  /**
   * 把关键事件回写到相关会话（FR-112–117）。
   *
   * 投递面用官方 `agent.inbox.append('next-step', …)`：那是"插件把一条 user-role 消息
   * 交给模型在下一个步边界看到"的正式通道（`source.kind = 'plugin'` 标明来源）。
   * **只发给相关会话**：订阅过该节点的会话，或该节点在关注枝上时的本项目会话。
   */
  private async emitNotices(changedNodeIds: readonly string[]): Promise<void> {
    if (this.deps.config.notifySilent === true) return;
    if (this.deps.config.notifyKeyEvents === false) return;
    if (changedNodeIds.length === 0) return;
    const { graph, derived } = await this.derive();
    const focusIds = new Set<string>();
    for (const rootId of focusedRoots(derived.index)) {
      focusIds.add(rootId);
      for (const id of subtreeIds(derived.index, rootId)) focusIds.add(id);
    }
    /**
     * 每条会话"订阅过哪些节点"（FR-115 裁剪的依据）。
     *
     * **这里是按会话建索引**：`subscribedNodeIds` 的含义是"这条会话订阅的节点集合"，
     * 不是"订阅了这个节点的会话集合"。早先把两者写反了，于是 `inSessionScope` 永远判 false、
     * 一条回写都发不出去（e2e 当场抓到，记在这里免得再犯）。
     */
    const subscribedBySession = new Map<string, Set<string>>();
    for (const [id, record] of Object.entries(graph.nodes)) {
      for (const binding of record.bindings ?? []) {
        if (binding.actor !== 'session') continue;
        const known = subscribedBySession.get(binding.actorId) ?? new Set<string>();
        known.add(id);
        subscribedBySession.set(binding.actorId, known);
      }
    }
    // 关注枝是项目级语义：绑定了本项目的会话都算"相关"
    const projectSessions = new Set(subscribedBySession.keys());
    for (const [sessionId, root] of this.sessionRoots) {
      if (this.boundRoot !== undefined && isSameRoot(root, this.boundRoot)) {
        projectSessions.add(sessionId);
      }
    }
    const noNodes = new Set<string>();

    for (const nodeId of changedNodeIds) {
      const node = derived.nodes.get(nodeId);
      const record = graph.nodes[nodeId];
      if (node === undefined || record === undefined) continue;
      const change: NotifyNode = {
        id: node.node.id,
        name: record.name,
        derivedState: node.derivedState,
        progress: node.progress,
        gate: record.gate,
        childCount: node.childCount,
        unfinishedLeafCount: node.unfinishedLeafCount,
        leafCount: node.leafCount,
      };
      // 先算裁剪，再判事件：不在任何会话范围内就**不值得记账**（没打扰任何人）
      const targets = [...projectSessions].filter((sessionId) =>
        inSessionScope(nodeId, {
          subscribedNodeIds: subscribedBySession.get(sessionId) ?? noNodes,
          focusedNodeIds: focusIds,
        }),
      );
      if (targets.length === 0) {
        this.notifyLedger.countSuppressed();
        continue;
      }
      const notice = noticeFor(this.notifyLedger, change);
      if (notice === undefined) continue;
      let delivered = 0;
      for (const sessionId of targets) {
        if (this.deliverNotice(sessionId, notice.text)) delivered += 1;
      }
      // 一条都没真送达（如 agent 查不到）：**不记账**，否则这条变化被永久吃掉，
      // 等会话回来时再也收不到
      if (delivered > 0) {
        this.notifyLedger.commit(nodeId, change);
        for (let index = 0; index < delivered; index += 1) this.notifyLedger.countSent();
      }
    }
  }

  /**
   * 按 id 找活跃 agent（官方注入路优先，其余读法作为回退）。
   *
   * **真机实测教训（第二次踩同一个坑）**：未在插件 `inject` 里声明的服务在 cordis 里是 PENDING 的 ——
   * `ctx.get('agents')` 返回 undefined，属性读回来也不是可用的 agent 注册表。于是
   * "关键事件回写会话"（FR-112）与"边界提醒"**在真实宿主里全都没投出去**：
   * 表面上只是 `notify.sent = 0`（统计里看不出来是失败），调试页也一片安静。
   * 现在 `src/index.ts` 用官方 `ctx.inject(['agents'], …)` 把服务交进来（`attachAgents`），
   * 只有拿不到时才回退到旧读法。
   */
  attachAgents(agents: unknown): void {
    const candidate = agents as { get?: (id: string) => unknown } | undefined;
    if (candidate !== undefined && candidate !== null && typeof candidate.get === 'function') {
      this.agentsService = candidate;
      this.agentsMissingWarned = false;
    }
  }

  private agentFor(id: string):
    | {
        inbox?: { append?: (target: string, message: unknown) => void };
        inject?: (message: unknown) => void;
        /** 官方投递入口（`dsh-agent` 文档：`send(message, target, wakeup)`）。 */
        send?: (message: unknown, target: string, wakeup: boolean) => void;
      }
    | undefined {
    const read = (
      registry: { get?: (id: string) => unknown } | undefined,
    ):
      | {
          inbox?: { append?: (target: string, message: unknown) => void };
          inject?: (message: unknown) => void;
          send?: (message: unknown, target: string, wakeup: boolean) => void;
        }
      | undefined => {
      try {
        return registry?.get?.(id) as
          | {
              inbox?: { append?: (target: string, message: unknown) => void };
              inject?: (message: unknown) => void;
              send?: (message: unknown, target: string, wakeup: boolean) => void;
            }
          | undefined;
      } catch {
        return undefined;
      }
    };
    const viaInjected = read(this.agentsService);
    if (viaInjected !== undefined) return viaInjected;
    try {
      const holder = this.ctx as unknown as {
        agents?: { get?: (id: string) => unknown };
        get?: (name: string) => unknown;
        reflect?: { get?: (name: string, strict?: boolean) => unknown };
      };
      // 依次尝试：属性 → ctx.get → 反射（非严格）
      return (
        read(holder.agents) ??
        read(holder.get?.('agents') as { get?: (id: string) => unknown } | undefined) ??
        read(holder.reflect?.get?.('agents', false) as { get?: (id: string) => unknown } | undefined)
      );
    } catch {
      return undefined;
    }
  }

  /** agents 服务拿不到时，**只警告一次**（否则每次关键事件都刷一条，反而淹掉别的日志）。 */
  private warnAgentsMissing(where: string): void {
    if (this.agentsMissingWarned) return;
    this.agentsMissingWarned = true;
    debugBus.warn(
      'notify',
      `${where}：拿不到 agents 服务（未声明的服务在 cordis 里是 PENDING 的），本条与后续投递都会失败；` +
        '提示：由 `src/index.ts` 的 ctx.inject([\'agents\']) 注入后即可恢复',
    );
  }

  /**
   * 投递一条**模型可见的上下文**到某会话（`agent.inject`）。
   *
   * 这是官方文档明确的口径：`inject()` = "queue model-facing context for the next pre-step
   * **without waking the driver**"。对"会话边界上的进度修正"这一点是决定性的：
   * 回合结束时自动唤醒 agent 就会自动花钱（T11 禁止），而不唤醒的上下文会在下一次
   * 真正有用户输入时随首步一起被认领 —— 提醒到了，钱没花。
   */
  injectContext(sessionId: string, text: string): boolean {
    const agent = this.agentFor(sessionId);
    if (typeof agent?.inject !== 'function') {
      this.warnAgentsMissing(`注入上下文（${sessionId}）失败`);
      return false;
    }
    try {
      agent.inject(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'dsh-project-manager' },
        }) as never,
      );
      return true;
    } catch (error) {
      debugBus.warn(
        'session',
        `注入上下文到会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** 投递到某会话的 inbox；拿不到 agent 就**如实失败**（不假装送达）。 */
  /**
   * 回写到某会话（关键事件，FR-112）。
   *
   * **真机诊断记录（含一次自我纠正）**：
   * ① 一开始 `sent` 一直是 0，我先怀疑 `inbox.append` 这条调用姿势有问题，于是改成
   *    "有 `agent.send(message, target, wakeup)` 就用它（官方文档入口，且能显式 `wakeup=false`），
   *    `inbox` 只作回退"；顺手修掉一个真实隐患：`append.call(agent?.inbox, …)` **两次读 `agent.inbox`**，
   *    若它是 getter（每次返回新包装），`this` 就不是同一个对象。
   * ② **但真机随后证明主因不是它**：重新用 `pm_watch` 登记订阅后，在**未加载本次修改**的宿主上
   *    就成功投出了（`notify.sent=1`，我自己的上下文里收到 `[pm] … done 100%`）。
   *    真正的原因是"订阅是上一个宿主进程建的" —— 新进程里按 actorId 查不到活着的 agent，
   *    于是投递被正确判为"没送达"（不记账、等会话回来再试，这条设计是对的）。
   * 结论：`send` 优先保留（文档入口 + wakeup 语义明确），但**不要再把它说成"修好了回写"**；
   * 回写之前不通，是因为订阅与新进程的时序，不是因为 `inbox.append` 坏了。
   */
  private deliverNotice(sessionId: string, text: string): boolean {
    const agent = this.agentFor(sessionId);
    if (agent === undefined) {
      this.warnAgentsMissing(`回写会话（${sessionId}）失败`);
      return false;
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-project-manager' },
    });
    try {
      if (typeof agent.send === 'function') {
        // 官方入口：target 用文档里的 'next-step'，wakeup=false（不唤醒 agent ⇒ 不产生 token）
        agent.send(message, 'next-step', false);
        return true;
      }
      // 回退：直接写 inbox。**一次抓取**（见上面 ① 的坑）
      const inbox = agent.inbox;
      const append = inbox?.append;
      if (typeof append === 'function') {
        append.call(inbox, 'next-step', message);
        return true;
      }
      this.warnDeliveryShape(sessionId, agent);
      return false;
    } catch (error) {
      debugBus.warn('notify', `回写会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** 投递通道形状不对时只警告一次（把"找到了什么"写出来，便于下一次真机定位）。 */
  private warnDeliveryShape(sessionId: string, agent: { inbox?: unknown; inject?: unknown }): void {
    if (this.deliveryShapeWarned) return;
    this.deliveryShapeWarned = true;
    debugBus.warn(
      'notify',
      `回写通道不可用（${sessionId}）：agent 上既没有 send 也没有 inbox.append` +
        `（inbox=${agent.inbox === undefined ? 'undefined' : typeof agent.inbox}、inject=${typeof agent.inject}）`,
    );
  }

  /** 回写统计（FR-117：设置页可查看）。 */
  notifyStats(): { sent: number; suppressed: number; tracked: number; enabled: boolean } {
    return {
      ...this.notifyLedger.stats(),
      enabled: this.deps.config.notifySilent !== true && this.deps.config.notifyKeyEvents !== false,
    };
  }

  /** 全部锁冲突与等待队列（`pm_watch_conflicts`）。 */  watchConflicts(): ReturnType<FileLockManager['snapshot']> {
    this.expireSubscriptions();
    return this.locks.snapshot();
  }

  /**
   * 释放已过期的订阅与锁（FR-108：不留僵尸锁）。
   *
   * 订阅记录里的 `expiresAt` 到期就**同时**释放锁并写审计 —— 只放锁不记审计，
   * 事后没人知道"这把锁为什么没了"。
   */
  private expireSubscriptions(): string[] {
    const now = this.deps.clock.now();
    const expired = this.locks.sweepExpired(now);
    if (expired.length === 0) return expired;
    for (const subscriptionId of expired) {
      debugBus.info('watch', `订阅 ${subscriptionId} 已过期，自动释放其文件锁`, {});
    }
    void this.port.appendAudit({
      attemptId: this.deps.random.uuid(),
      projectId: this.projectId,
      nodeId: null,
      block: 'watch-expire',
      op: { released: expired, at: now },
      by: 'session',
      rev: 0,
      ts: now,
    });
    return expired;
  }

  /**
   * 释放某节点**及其整枝**上所有订阅的文件锁（回滚 FR-109 / 暂停拦停的挂起）。
   *
   * 为什么要按整枝算：锁是按 `nodeId` 挂的，但"回滚一个节点"要停的是**整枝**的写入
   * （子孙的订阅同样在写这棵子树的文件）。只按单节点释放会漏掉它们，留下僵尸锁。
   *
   * @returns 被释放的订阅 id（订阅记录本身由各自的生命周期释放）
   */
  async releaseLocksInBranch(nodeId: string): Promise<string[]> {
    const { graph } = await this.derive();
    const index = buildIndex(graph);
    const branchIds = new Set<string>([nodeId, ...collectBranch(index, nodeId)]);
    const now = this.deps.clock.now();
    const released: string[] = [];
    for (const held of this.locks.snapshot().holds) {
      if (!branchIds.has(held.nodeId)) continue;
      released.push(held.subscriptionId);
      this.locks.release(held.subscriptionId, now);
    }
    if (released.length > 0) {
      debugBus.info('watch', `整枝锁已释放（${released.length} 个订阅）：${released.join('、')}`, {
        nodeId,
      });
    }
    return released;
  }

  /**
   * 等待让路（`pm_watch_wait`，FR-129：截止时间语义）。
   *
   * 用轮询而不是 Promise 队列：锁的释放可能来自**另一个进程/另一个工具的调用**，
   * 这里没有可供注入回调的单一入口；轮询间隔 200ms、上限由调用方给（默认 30s）。
   */
  async watchWait(input: {
    subscriptionId: string;
    timeoutMs?: number;
  }): Promise<{ status: 'granted' | 'timeout' | 'unknown'; waitedMs: number; blockedBy: string[] }> {
    const timeoutMs = clampTimeout(input.timeoutMs, 30_000, 600_000, 'timeoutMs');
    const started = Date.now();
    for (;;) {
      this.expireSubscriptions();
      if (this.locks.isHeldBy(input.subscriptionId)) {
        return { status: 'granted', waitedMs: Date.now() - started, blockedBy: [] };
      }
      const blockedBy = this.locks.blockedBy(input.subscriptionId);
      const known =
        blockedBy.length > 0 ||
        this.locks.snapshot().holds.some((hold) => hold.subscriptionId === input.subscriptionId);
      if (blockedBy.length === 0 && !known) {
        // 既没持锁、也不在队列里：这个 subscriptionId 不是等待者（可能早就被拒或释放了）
        return { status: 'unknown', waitedMs: Date.now() - started, blockedBy: [] };
      }
      if (Date.now() - started >= timeoutMs) {
        return { status: 'timeout', waitedMs: Date.now() - started, blockedBy };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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

  /**
   * 每个节点有几个可用回滚点（看板用；菜单据此决定「回滚」显不显示）。
   *
   * 一次读全量快照记录再按 `nodeIds` 归并 —— 比"每个节点查一次"少 n-1 次存储读。
   */
  async rollbackPointCounts(nodeIds: readonly string[]): Promise<Record<string, number>> {
    const manager = this.snapshotManager();
    const out: Record<string, number> = {};
    if (!manager) return out;
    const wanted = new Set(nodeIds);
    const rows = await this.port.listSnapshots(this.projectId);
    for (const row of rows) {
      for (const id of row.nodeIds) {
        if (!wanted.has(id)) continue;
        out[id] = (out[id] ?? 0) + 1;
      }
    }
    return out;
  }

  /**
   * 列出未清的 checkpoint（诊断用）。
   *
   * 多记录操作（整枝回滚/批量删除…）没有事务（§7.1），靠 checkpoint + 幂等重放收敛；
   * 因此"还留着 `running` 的 checkpoint"= **有一个多记录操作没走完**。
   * 这条信息出现在 `/pm/debug` 里，用户与后来的人都能看见"上次是不是半途断了"。
   */
  async listCheckpoints(): Promise<
    Array<{ checkpointId: string; kind: string; status: string; doneSteps: number; totalSteps: number; startedAt: string }>
  > {
    const rows = await this.port.listCheckpoints(this.projectId);
    return rows.map((row) => ({
      checkpointId: row.checkpointId,
      kind: row.kind,
      status: row.status,
      doneSteps: row.doneSteps.length,
      totalSteps: row.totalSteps,
      startedAt: row.startedAt,
    }));
  }

  /**
   * 运行期套用新配置（设置页改动 → 立即生效，FR-80/81/81a/81b/82/87/88）。
   *
   * **只覆盖传进来的字段**：设置页是"改一项存一项"的补丁语义，没传的字段必须保持原样
   * （否则一次保存会把其它字段悄悄重置成默认值）。
   *
   * 影响面如实说明：快照档位/冲突策略等**每次用到时都读配置**，所以立刻生效；
   * 已经在跑的扫描/建树不会被打断（下一次扫描才用新 glob）。
   */
  applyConfig(patch: Partial<ProjectServiceConfig>): void {
    const before = { ...this.deps.config };
    this.deps.config = { ...this.deps.config, ...patch };
    // 工作区根变了要丢掉快照管理器（档位可能因此改变）—— 这里只处理档位本身
    if (patch.snapshotMode !== undefined && patch.snapshotMode !== before.snapshotMode) {
      this.snapshotDecision = undefined;
    }
    debugBus.info('settings', '配置已更新', {
      changed: Object.keys(patch),
    });
  }

  /**
   * 当前生效的配置（设置页读回用）。
   *
   * **必须把扫描参数的默认值补齐**：宿主没配过这些字段时（`cordis.patch.yml` 里没写、
   * 单测直接传对象），真实生效的是内置默认值而不是 `undefined`。设置页显示 `undefined`
   * 会让人以为"这项没配"，而实际上扫描用的是 6 层 / 200 个节点。
   */
  effectiveConfig(): ProjectServiceConfig {
    const c = this.deps.config;
    return {
      ...c,
      scanMaxDepth: c.scanMaxDepth ?? DEFAULT_SCAN_OPTIONS.maxDepth,
      scanMaxChildrenPerDir: c.scanMaxChildrenPerDir ?? DEFAULT_SCAN_OPTIONS.maxChildrenPerDir,
      scanMaxNodes: c.scanMaxNodes ?? DEFAULT_SCAN_OPTIONS.maxNodes,
      scanInclude: c.scanInclude ?? DEFAULT_SCAN_OPTIONS.include,
      scanExclude: c.scanExclude ?? DEFAULT_SCAN_OPTIONS.exclude,
    };
  }

  /** 列出某节点的可用回滚点（`pm_snapshots`）。 */  async listSnapshots(
    nodeId: string,
    sessionId?: string,
  ): Promise<
    Array<{ snapshotId: string; reason: string; createdAt: string; mode: string; sizeBytes: number }>
  > {
    // 面板带上会话 id 时，先把项目绑到"你正在看的那个工作区"，否则会读到上一个操作根的快照
    const resolution = this.resolveRoot(sessionId);
    if (resolution.root !== undefined) {
      this.notePendingRoot(resolution);
      await this.bindProjectToRoot(resolution.root);
    }
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
      // git 档如实交代未跟踪文件的覆盖情况（它们是**被覆盖**的，别让用户以为漏了）
      ...(chosen !== undefined && chosen.auxPaths.length > 0
        ? [
            `- 含 ${chosen.auxPaths.length} 个未跟踪文件（已随树对象一并记录，无需另行补丁）`,
          ]
        : []),
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
    // FR-109：回滚一个节点必须**停掉整枝的全部订阅**（不止主订阅）——
    // 它们的文件锁在回滚期间只会挡路，回滚后再按需重新申请。
    const releasedSubscriptions = await this.releaseLocksInBranch(input.nodeId);
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
      // **注意 `restore: true`**：还原要能写回快照点的任意状态（含 done→pending），
      // 而且此时子树正被回滚锁保护 —— 不放这个标记，还原会被 C6/C9 拒掉、静默失败
      // （实测踩过：文件回来了、节点状态原地不动，看起来像"回滚只做了一半"）。
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
            restore: true,
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

  /**
   * **面板路径**的回滚 / 整枝回滚（FR-51b / FR-53b，§6.7f 第 2 行）。
   *
   * 确认人是**面板前的当场用户**，所以确认由面板自己的确认框承载（与删除整枝同一条规矩）；
   * 模型走的 `rollback()` 那条路必须过 `ctx.approval` 且 fail-closed，两者不共用入口。
   *
   * **整枝回滚是多记录操作，而存储没有跨记录事务**（§7.1 known limitations）：
   * 因此先写一条 `checkpoint`（目标快照 + 覆盖节点 + 已完成步骤），逐条应用，成功后删掉 checkpoint。
   * 中途崩溃再点一次 = 重放，不会产生新的副作用（幂等）。
   */
  async panelRollback(input: {
    nodeId: string;
    /** true = 整枝回滚（该节点及其全部子孙）。 */
    branch?: boolean;
    snapshotId?: string;
    scope: RollbackScope;
    confirmShared?: boolean;
    confirm?: boolean;
    /** 面板当前会话 id：据此把项目绑到"你正在看的那个工作区"。 */
    sessionId?: string;
  }): Promise<
    | { status: 'needs-confirm'; preview: string; action: 'rollback' | 'branch-rollback' }
    | ApplyResult
    | { status: 'ok'; nodeId: string; revision: number; restoredFiles: string[]; deletedFiles: string[]; resetNodes: number; preRollbackSnapshotId?: string }
  > {
    const branchRollback = input.branch === true;
    const action = branchRollback ? 'branch-rollback' : 'rollback';
    const resolution = this.resolveRoot(input.sessionId);
    if (resolution.root !== undefined) {
      this.notePendingRoot(resolution);
      await this.bindProjectToRoot(resolution.root);
    }
    const manager = this.snapshotManager();
    if (!manager) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NO_WORKSPACE',
        message: '无法确定工作区根目录，回滚不可用（不做半截回滚）',
        hint: '先在工作区里打开会话或让工具调用上报 cwd',
      };
    }
    const { graph, derived } = await this.derive();
    const branch = buildIndex(graph);
    const record = graph.nodes[input.nodeId];
    const node = derived.nodes.get(input.nodeId);
    if (!node || !record) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NOT_FOUND',
        message: `节点 ${input.nodeId} 不存在`,
      };
    }

    const available = await manager.list(input.nodeId);
    if (available.length === 0) {
      // FR：无可用回滚点时不显示「回滚」；真被调到也如实说清，不假装成功
      return {
        status: 'denied',
        reason: 'unavailable',
        code: 'E_NO_SNAPSHOT',
        message: `「${record.name}」还没有回滚点`,
        hint: '先「打回滚点」，或让该节点执行/暂停一次（暂停与拦停会自动建点）',
      };
    }
    const chosen = input.snapshotId
      ? available.find((s) => s.snapshotId === input.snapshotId)
      : available[available.length - 1];
    if (!chosen) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NOT_FOUND',
        message: `回滚点 ${input.snapshotId ?? ''} 不属于该节点`,
      };
    }

    const ids = branchRollback
      ? [input.nodeId, ...collectBranch(branch, input.nodeId)]
      : [input.nodeId];
    const touched = new Set<string>();
    for (const id of ids) {
      for (const ref of graph.nodes[id]?.refs ?? []) touched.add(ref.target);
    }
    const scopeLabel =
      input.scope === 'both' ? '代码 + 节点状态' : input.scope === 'code' ? '仅代码' : '仅节点状态';
    const preview = [
      branchRollback
        ? `将**整枝回滚**「${record.name}」到 ${chosen.createdAt}（${chosen.reason}）`
        : `将回滚「${record.name}」到 ${chosen.createdAt}（${chosen.reason}）`,
      `- 覆盖节点：${ids.length} 个${branchRollback ? '（含全部子孙）' : ''}`,
      `- 已记录的引用路径：${touched.size} 个`,
      `- 回滚范围：${scopeLabel}`,
      `- 共享文件（多节点写过）：${chosen.sharedPaths.length > 0 ? chosen.sharedPaths.join('、') : '无'}`,
      '- 覆盖范围：仅节点已记录的路径与工作区 diff',
      '- 未覆盖项：shell 命令产生的写入、外部进程、其他工具与用户手动改动',
      '- 回滚前会先建 `pre-rollback` 快照，可「撤销这次回滚」',
      '- 本操作不可保证完整恢复，请自行确认',
    ].join('\n');

    if (input.confirm !== true) {
      return { status: 'needs-confirm', preview, action };
    }

    debugBus.info('rollback', `${action}（面板确认）：「${record.name}」→ ${chosen.snapshotId}`, {
      nodeId: input.nodeId,
      nodes: ids.length,
      channel: 'panel',
    });

    const checkpointId = this.deps.random.uuid();
    const now = this.deps.clock.now();
    await this.port.putCheckpoint({
      checkpointId,
      projectId: this.projectId,
      kind: 'branch-rollback',
      doneSteps: [],
      totalSteps: 1,
      payload: {
        nodeId: input.nodeId,
        nodeIds: ids,
        snapshotId: chosen.snapshotId,
        scope: input.scope,
      },
      status: 'running',
      startedAt: now,
      updatedAt: now,
    });

    this.lockSubtree(input.nodeId);
    try {
      const result = await manager.rollback({
        graph,
        nodeId: input.nodeId,
        nodeIds: ids,
        snapshotId: chosen.snapshotId,
        scope: input.scope,
        confirmShared: input.confirmShared === true,
      });

      if (!result.ok) {
        await this.port.deleteCheckpoint(checkpointId);
        return {
          status: 'denied',
          reason: result.sharedBlocked.length > 0 ? 'validation' : 'unavailable',
          code: result.sharedBlocked.length > 0 ? 'C_SHARED' : 'E_ROLLBACK',
          message: result.reason,
          ...(result.sharedBlocked.length > 0
            ? {
                hint: `以下文件被多个节点写过，确认后带“同时还原共享文件”重试：${result.sharedBlocked.join('、')}`,
              }
            : {}),
        };
      }

      // 节点状态：**覆盖范围内**每个在快照里记过状态的节点都回到那一刻（FR-67）
      if (input.scope !== 'code') {
        for (const id of ids) {
          const recorded = chosen.nodeState[id];
          if (!recorded) continue;
          await this.patchNode({
            nodeId: id,
            patch: {
              selfState: recorded.selfState as SelfState,
              progress: recorded.progress,
              gate: recorded.gate,
            },
            force: true,
            // 还原 ≠ 状态迁移：要能写回快照点的任意状态，且不被回滚锁挡住自己
            restore: true,
            by: 'user',
            reason: `回滚到 ${chosen.snapshotId}`,
          });
        }
      }
      for (const id of ids) {
        await this.setFlags({
          nodeId: id,
          add: ['rolledBack'],
          lastRollbackAt: this.deps.clock.now(),
          by: 'user',
        });
      }

      await this.port.appendAudit({
        attemptId: this.deps.random.uuid(),
        projectId: this.projectId,
        nodeId: input.nodeId,
        block: branchRollback ? 'branch-rollback' : 'rollback',
        op: {
          scope: input.scope,
          snapshotId: chosen.snapshotId,
          nodeIds: ids,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          preRollbackSnapshotId: result.preRollbackSnapshotId ?? null,
          channel: 'panel',
        },
        by: 'user',
        rev: 0,
        ts: this.deps.clock.now(),
      });

      await this.port.deleteCheckpoint(checkpointId);
      return {
        status: 'ok',
        nodeId: input.nodeId,
        revision: 0,
        restoredFiles: result.restoredFiles,
        deletedFiles: result.deletedFiles,
        resetNodes: result.resetNodes,
        ...(result.preRollbackSnapshotId !== undefined
          ? { preRollbackSnapshotId: result.preRollbackSnapshotId }
          : {}),
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
    const derived = deriveGraph(graph);
    // 顺手刷新"绑定事实"的同步快照：提示词 provider 是同步函数，只能读内存。
    // 放在这里而不是别处的原因：**所有**读写路径最终都会经过 derive（面板轮询、工具调用、边界修正）。
    this.refreshBoundFacts(graph, derived);
    return { graph, derived };
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
      // 每个节点有几个可用回滚点：菜单要**同步**决定「回滚 / 整枝回滚」显不显示
      // （FR：没有回滚点时不显示，而不是画一个点了没反应的项）
      rollbackPoints: await this.rollbackPointCounts(liveNodes.map((d) => d.node.id)),
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
      // FR-110：数量之外还要**风险等级**与"有几条在等锁"，
      // 否则用户看到"2 个订阅"也不知道该不该担心（只读两条 vs 独占两条是两回事）
      ...subscriptionRiskOf(d.node.bindings ?? [], this.locks),
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

    // 扫描参数优先级：**本次调用显式传入 > 设置页里改过的配置 > 内置默认**。
    // 设置页能改扫描 glob/深度（FR-81），改了立即对下一次扫描生效。
    const cfg = this.deps.config;
    const maxDepth = input?.maxDepth ?? cfg.scanMaxDepth ?? DEFAULT_SCAN_OPTIONS.maxDepth;
    const excluded: string[] = [
      ...(input?.exclude ?? [...(cfg.scanExclude ?? []), ...DEFAULT_SCAN_EXCLUDE]),
    ];
    // 权重默认关闭（节点是功能点/任务点，进度不该由代码行数决定）→ 也就**不必**读盘数行数。
    // 关掉之后阶段 A 是真正的"只看文件树"，不读任何文件内容。
    const attachWeights = input?.attachWeights ?? cfg.heuristicWeight;
    const walked = await scanWorkspaceEntries({
      root,
      maxDepth,
      exclude: excluded,
      countLines: attachWeights,
    });

    const options: ScanOptions = {
      ...DEFAULT_SCAN_OPTIONS,
      maxDepth,
      ...(input?.maxChildrenPerDir !== undefined
        ? { maxChildrenPerDir: input.maxChildrenPerDir }
        : cfg.scanMaxChildrenPerDir !== undefined
          ? { maxChildrenPerDir: cfg.scanMaxChildrenPerDir }
          : {}),
      ...(input?.maxNodes !== undefined
        ? { maxNodes: input.maxNodes }
        : cfg.scanMaxNodes !== undefined
          ? { maxNodes: cfg.scanMaxNodes }
          : {}),
      ...(input?.include !== undefined
        ? { include: input.include }
        : cfg.scanInclude !== undefined
          ? { include: cfg.scanInclude }
          : {}),
      exclude: excluded,
      rootDirName: walked.rootDirName,
      ...(walked.packageName !== undefined ? { packageName: walked.packageName } : {}),
      ...(attachWeights
        ? {
            attachWeights: true,
            coefficients: input?.coefficients ?? cfg.heuristicCoefficients,
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
    | {
        available: true;
        estimate: AiEstimate;
        description: string;
        route: string;
        /** T6/T9：这次会走缓存还是真调模型（预估与实际共用同一份判定）。 */
        cache: {
          state: 'hit' | 'resume' | 'miss';
          savedTokens?: number;
          changed?: { added: string[]; removed: string[]; changed: string[] };
        };
      }
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
    const maxTokens = this.aiMaxOutputTokens();
    const collected = await this.collectAiSkeleton(root);
    const estimate = estimateAiBuild({
      entries: collected.skeleton.length,
      signatureBytes: collected.signatureBytes,
      promptBytes: collected.promptBytes,
      maxOutputTokens: maxTokens,
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
    // T6/T9：**预估时就把缓存判定算出来**，让确认框能说"这次要不要花钱"。
    // 预估说命中、实际却调了模型（或反过来）都是欺骗，两者必须走同一份判定。
    const cache = await this.inspectAiCache(collected.prompt, route.route, maxTokens, collected.skeleton);
    return {
      available: true,
      estimate,
      description: describeEstimate(estimate),
      route: `${route.route.provider} / ${route.route.model}（${route.route.source === 'config' ? '设置' : '跟随默认模型'}）`,
      cache: {
        state: cache.verdict.kind === 'hit' ? 'hit' : cache.verdict.kind === 'resume' ? 'resume' : 'miss',
        ...(cache.diff !== undefined ? { changed: changedSummary(cache.diff) } : {}),
        ...(cache.verdict.kind === 'hit' || cache.verdict.kind === 'resume'
          ? { savedTokens: cache.verdict.entry.tokens ?? estimate.totalTokens }
          : {}),
      },
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
    /**
     * 忽略缓存、强制重新调用模型（T6 的逃生口）。
     *
     * 为什么必须有：非关键文件的指纹是**大小 + 修改时间**（不读内容，见 §9.5 T3/T8），
     * 因此"同一时间刻度内的同尺寸改动"可能漏检。与其假装缓存永远对，
     * 不如把这件事说清楚并给用户一个"我就是要重算"的开关。
     */
    forceRebuild?: boolean;
  }): Promise<
    | {
        status: 'needs-confirm';
        estimate: AiEstimate;
        description: string;
        route: string;
        cache: {
          state: 'hit' | 'resume' | 'miss';
          savedTokens?: number;
          changed?: { added: string[]; removed: string[]; changed: string[] };
        };
      }
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
        /**
         * 缓存走的哪条路（T6/T9）：`hit` 整份复用、`resume` 复用上次被中断的结果、
         * `miss` 真的调了模型。`savedTokens` 是这次省下的（估算口径）。
         */
        cache: {
          state: 'hit' | 'resume' | 'miss';
          savedTokens: number;
          changedPaths: { added: string[]; removed: string[]; changed: string[] };
        };
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
        // T6/T9：把缓存判定**在确认前**就交给面板 —— 用户要先知道这次花不花钱
        cache: preflight.cache,
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
    const maxTokens = this.aiMaxOutputTokens();
    const cache = await this.inspectAiCache(prompt, route.route, maxTokens, collected.skeleton);
    // 强制重算：把命中/续跑一律降级为"未命中"（仍然照常写回新缓存）
    const verdict: CacheVerdict =
      input.forceRebuild === true ? { kind: 'miss' } : cache.verdict;

    // ── 缓存命中：**一次模型调用都不发**（T6/FR-104）────────────────
    if (verdict.kind === 'hit' || verdict.kind === 'resume') {
      const entryTokens = verdict.entry.tokens;
      const candidate =
        verdict.kind === 'hit'
          ? completeTreeOf(verdict.entry.tree)
          : safeParseCached(verdict.entry.rawText);
      if (candidate !== undefined) {
        const applied = await this.applyAiTree(candidate.value, candidate.notes, {
          replaceAutoDraft: input.replaceAutoDraft !== false,
        });
        const kind = verdict.kind;
        const savedTokens = entryTokens ?? preflight.estimate.totalTokens;
        debugBus.info('ai', `AI 建树走缓存（${kind}）：零 token，新建 ${applied.created}`);
        // 用量账本：**命中缓存不是一次调用**，但它省下的量必须记（T6/T9 的价值证明）
        await this.recordAiUsage({
          at: this.deps.clock.now(),
          scenario: 'tree',
          route: `${route.route.provider} / ${route.route.model}`,
          outcome: 'reused',
          estimatedTokens: savedTokens,
          usageSource: 'none',
        });
        return {
          status: 'ok',
          projectName: applied.projectName,
          created: applied.created,
          updated: applied.updated,
          removed: applied.removed,
          failures: applied.failures,
          notes: [
            ...candidate.notes,
            ...applied.notes,
            kind === 'hit'
              ? '命中内容哈希缓存（输入与上次逐字节相同），本次**未发起任何模型调用**。'
              : '复用上次被中断时**已经拿到的结果**（续跑），本次未发起模型调用。',
          ],
          estimate: { ...preflight.estimate, calls: 0, totalTokens: 0 },
          proposed: candidate.value.nodes.length,
          cache: {
            state: kind,
            // 走到这里 `verdict` 必然是 hit/resume，`entry` 一定在
            savedTokens: entryTokens ?? preflight.estimate.totalTokens,
            changedPaths: cache.diff ? changedSummary(cache.diff) : { added: [], removed: [], changed: [] },
          },
        };
      }
      // 半份结果解析不出来（例如上次截断得太早）：如实说明，然后照常调模型
      debugBus.warn('ai', '缓存里的半份结果解析失败，改为重新调用模型');
    }

    const call = await callTreeBuilder({
      ctx: this.ctx,
      route: route.route,
      system: AI_TREE_SYSTEM_PROMPT,
      user: prompt,
      maxTokens,
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (!call.ok) {
      debugBus.error('ai', `AI 建树失败：${call.message}`, { reason: call.reason });
      // 失败也烧了 token：如实记一笔（有提供方用量就用真实值，否则标"粗估"）
      await this.recordAiUsage({
        at: this.deps.clock.now(),
        scenario: 'tree',
        route: `${route.route.provider} / ${route.route.model}`,
        outcome: 'error',
        estimatedTokens: preflight.estimate.totalTokens,
        ...(call.usage !== undefined ? { usage: call.usage } : {}),
        usageSource: call.usage !== undefined ? 'provider' : 'estimate',
      });
      // T9：被取消/截断的那次**也要把已得文本落盘**，下次能续跑而不是从头再来
      if (call.rawText !== undefined && call.rawText.trim() !== '' && cache.key !== undefined) {
        await writeAiCacheEntry(this.ctx, {
          key: cache.key,
          status: 'partial',
          createdAt: this.deps.clock.now(),
          signatures: cache.signatures,
          rawText: call.rawText,
          route: `${route.route.provider} / ${route.route.model}`,
          maxTokens,
        });
        debugBus.info('ai', `已把本次已得输出存为 partial 缓存（${call.rawText.length} 字符），下次可续跑`);
      }
      return {
        status: 'error',
        reason: call.reason,
        message: call.message,
        ...(call.rawText !== undefined ? { rawText: call.rawText } : {}),
      };
    }

    // 成功：落一份 complete 缓存（下次同样输入零 token 复用）
    if (cache.key !== undefined) {
      await writeAiCacheEntry(this.ctx, {
        key: cache.key,
        status: 'complete',
        createdAt: this.deps.clock.now(),
        signatures: cache.signatures,
        tree: call.parsed.value,
        tokens: preflight.estimate.totalTokens,
        route: `${route.route.provider} / ${route.route.model}`,
        maxTokens,
      });
    }

    const applied = await this.applyAiTree(call.parsed.value, call.parsed.notes, {
      replaceAutoDraft: input.replaceAutoDraft !== false,
    });
    // 用量账本：真实用量优先（提供方回的 usage），拿不到才标"粗估"
    const treeCall: AiUsageCall = {
      at: this.deps.clock.now(),
      scenario: 'tree',
      route: `${route.route.provider} / ${route.route.model}`,
      outcome: 'ok',
      estimatedTokens: preflight.estimate.totalTokens,
      ...(call.usage !== undefined ? { usage: call.usage } : {}),
      usageSource: call.usage !== undefined ? 'provider' : 'estimate',
    };
    await this.recordAiUsage(treeCall);
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
      notes: [
        ...call.parsed.notes,
        ...applied.notes,
        ...(cache.diff && cache.diff.dirty
          ? [
              `增量：相比上次建树，文件新增 ${cache.diff.added.length}、删除 ${cache.diff.removed.length}、内容变化 ${cache.diff.changed.length}。`,
            ]
          : []),
      ],
      estimate: preflight.estimate,
      proposed: call.parsed.value.nodes.length,
      cache: {
        state: 'miss',
        savedTokens: 0,
        changedPaths: cache.diff ? changedSummary(cache.diff) : { added: [], removed: [], changed: [] },
      },
    };
  }

  /**
   * 看一眼缓存会怎么走（估成本与实际调用共用，保证"预估说的"和"实际做的"一致）。
   *
   * @returns 输入指纹、骨架指纹、判定结果、以及与上一次完整结论的增量
   */
  private async inspectAiCache(
    prompt: string,
    route: { provider: string; model: string },
    maxTokens: number,
    skeleton: ReadonlyArray<{ path: string; signature?: string; sizeBytes?: number }>,
  ): Promise<{
    key: string | undefined;
    signatures: SignatureMap;
    verdict: CacheVerdict;
    diff?: SignatureDiff;
  }> {
    const signatures = signaturesOf(skeleton);
    if (!llmAvailable(this.ctx)) {
      // 没有 llm 时不必算键（也不会走到调用），保持 estimate 的既有语义
      return { key: undefined, signatures, verdict: { kind: 'miss' } };
    }
    const key = cacheKey({
      prompt,
      provider: route.provider,
      model: route.model,
      maxTokens,
      promptVersion: AI_PROMPT_VERSION,
    });
    const entries = await readAiCache(this.ctx);
    const verdict = decideCache(entries, key, signatures);
    const previous =
      verdict.kind === 'miss' ? verdict.previous : entries.find((entry) => entry.status === 'complete');
    const diff = previous === undefined ? undefined : diffSignatures(previous.signatures, signatures);
    return { key, signatures, verdict, ...(diff !== undefined ? { diff } : {}) };
  }

  /** 采集骨架 + 组装提示词（估成本与实际调用共用同一份输入）。 */
  private async collectAiSkeleton(root: string, maxNodes = 60): Promise<{
    skeleton: Awaited<ReturnType<typeof collectSkeleton>>['skeleton'];
    signatureBytes: number;
    /** 渲染好的提示词（估成本与实际调用共用**同一份字符串**，缓存键才可信）。 */
    prompt: string;
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
    const projectName = walked.packageName ?? walked.rootDirName;
    const prompt = buildTreePrompt({
      projectName,
      skeleton: collected.skeleton,
      maxNodes,
      ...(collected.truncated ? { truncated: true } : {}),
      ...(walked.skipped > 0 ? { skipped: walked.skipped } : {}),
    });
    return {
      skeleton: collected.skeleton,
      signatureBytes: collected.signatureBytes,
      prompt,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      truncated: collected.truncated,
      skipped: walked.skipped,
      projectName,
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
      /** 这次模型提出的名字集合（这些不算草稿，见下面的过滤条件）。 */
      const proposedNames = new Set(tree.nodes.map((node) => node.name));
      /**
       * **清理范围扩到"上次 AI 建出的、没人动过的"节点**（用户反馈："节点在增加，没有收缩"）。
       *
       * 早先只清阶段 A 的目录骨架（`autoCreated` 且无 AI 权重），理由是"绝不碰上次 AI 建出的树"——
       * 那条保守规则防住了"重跑埋掉人工进度"，但也让**每跑一次 AI 建树就只增不减**：
       * 模型换个说法（实测：根名从「侧边栏实时进度看板」变成「…插件」）就长出一批新节点，
       * 旧的全都留着 ⇒ 同义节点这里一个那里一个。
       *
       * 现在判据仍然**保守**：只有"没人碰过"的自动节点才算草稿 ——
       * `pending` 且进度 0、没有门控、没有 `needsConfirm`/`rolledBack`；
       * 只要有人报过进度、置过状态、挂过门控，就一律保留（那是人的劳动，不许自动清）。
       */
      const untouchedAuto = new Set(
        Object.values(workingGraph.nodes)
          .filter((node) => {
            const state = derived.nodes.get(node.id);
            if (state === undefined || state.derivedState === 'removed') return false;
            if (node.selfState !== 'pending' || state.progress !== 0) return false;
            if (node.gate !== null) return false;
            if (node.flags?.includes('needsConfirm') || node.flags?.includes('rolledBack')) return false;
            /**
             * **这次模型仍然提出的名字不算草稿**：它们会被下面"同名复用"接住。
             * 少了这个条件，缓存命中路径（同一份树再应用一次）会先把节点清掉、再复用它们的 id
             * ⇒ 树上凭空少节点（实测：e2e "重复建树后节点数不变" 从 3 掉到 2）。
             * 换句话说：**只有"这次没再提到"的自动节点才叫遗留**。
             */
            if (proposedNames.has(node.name)) return false;
            // 阶段 A 的目录骨架，或上次 AI 建出的树（两者都是"自动生成"）
            return node.autoCreated === true || node.weightSource === 'ai';
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
        notes.push(
          `已先清掉 ${removed} 个**没人动过**的自动节点（阶段 A 骨架 + 上次 AI 建出且进度仍为 0 的），` +
            '避免"重跑只增不减"；有过进度 / 状态 / 门控的一律保留（仅删记录，可回滚）',
        );
        const refreshed = await this.derive();
        workingGraph = refreshed.graph;
      }
    }

    const idByIndex: Array<string | null> = [];
    /**
     * 全树（活节点）按名字索引。
     *
     * 用户反馈："相同的节点这里有一个那里有一个" —— 原来只在**同一个父**下按名字查重，
     * 模型把同一个功能点挂到别处（或两次建树根名不同）就会再建一个同名节点。
     */
    const liveByName = new Map<string, NodeRecord>();
    for (const candidate of Object.values(graph.nodes)) {
      if (derived.nodes.get(candidate.id)?.derivedState === 'removed') continue;
      if (!liveByName.has(candidate.name)) liveByName.set(candidate.name, candidate);
    }
    /** 本轮已经复用/用过的既有节点（同一个节点不该被两个位置同时认领）。 */
    const usedIds = new Set<string>();
    let reused = 0;
    const reusedNames: string[] = [];
    /** 单一根规范化要如实说出来的两件事（改了什么、为什么改）。 */
    const rootNotes: string[] = [];
    /** 模型给的顶级节点里，哪一个已经被认成"既有根本身"（只认一次）。 */
    let usedRootAsItself = false;

    /**
     * **单一根不变量**（用户实测反馈："顶级节点按理就只有一个，我用它看了 dsh-project-manager
     * 出现好几个顶级节点"）。
     *
     * 根因：模型给的 `parent: null` 有几个，就建几个顶级节点；跑两次 AI 建树、两次根名不一样
     * （实测那棵树就是 `侧边栏实时进度看板` 与 `侧边栏实时进度看板插件` 两个根），于是多根。
     *
     * 规则（项目根是**项目本身**，不由模型决定）：
     * - 已有活根 → 模型给的顶级节点全部挂到**既有根**下；
     * - 还没有根 → 用模型的**第一个**顶级节点当根，其余顶级节点挂到它下面（并如实记一条说明）。
     */
    const liveRootOf = (snapshot: typeof workingGraph): string | undefined =>
      snapshot.rootIds
        .map((id) => snapshot.nodes[id])
        .find(
          (candidate) =>
            candidate !== undefined &&
            candidate.parentId === null &&
            derived.nodes.get(candidate.id)?.derivedState !== 'removed',
        )?.id;
    let rootId = liveRootOf(workingGraph);
    /** 还没有根时，采用**第一个**顶级节点当项目根（其余顶级节点挂到它下面）。 */
    const topLevelIndexes = tree.nodes
      .map((node, index) => (node.parent === null ? index : -1))
      .filter((index) => index >= 0);
    const adoptedRootIndex = rootId === undefined ? (topLevelIndexes[0] ?? -1) : -1;
    const modelRootCount = topLevelIndexes.length;
    const adoptedRootName = adoptedRootIndex >= 0 ? tree.nodes[adoptedRootIndex]?.name : undefined;
    if (rootId !== undefined && modelRootCount > 0) {
      rootNotes.push(
        `模型给了 ${modelRootCount} 个顶级节点，已全部挂到**既有项目根**下（项目根唯一：根不由模型决定）`,
      );
    } else if (adoptedRootIndex >= 0) {
      if (modelRootCount > 1) {
        rootNotes.push(
          `模型给了 ${modelRootCount} 个顶级节点，已把第一个「${adoptedRootName ?? ''}」当项目根，其余挂到它下面（项目根唯一）`,
        );
      }
    }

    for (const [index, node] of tree.nodes.entries()) {
      /**
       * 已有活根时：**模型给的顶级节点若就是那个根本身**（名字相同），仍然按"它就是根"处理
       * （parentId 保持 null，于是在 `existing` 查找里命中既有根 → 记 updated，而不是又建一个）。
       * 少了这一步，重复建树会把根挂到自己下面，凭空多出同名节点（实测：e2e "重复建树不得再新建节点" 立刻红）。
       */
      const isExistingRootItself =
        node.parent === null && rootId !== undefined && !usedRootAsItself && node.name === workingGraph.nodes[rootId]?.name;
      if (isExistingRootItself) usedRootAsItself = true;
      const parentId =
        node.parent !== null
          ? (idByIndex[node.parent] ?? null)
          : index === adoptedRootIndex || isExistingRootItself
            ? null // 项目根（第一个顶级节点，或既有根本身）
            : rootId !== undefined
              ? rootId // 已有根 → 挂到既有根下
              : (idByIndex[adoptedRootIndex] ?? null); // 刚建出的新根 → 挂在它下面
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
      } else if (
        /**
         * **同名节点全树复用**（用户反馈："相同的节点这里有一个那里有一个"）。
         *
         * 找到就复用，不再建一个孪生节点；并在 notes 里如实说明。
         * 为什么是"复用"而不是"搬过去"：搬动会改掉用户已经整理好的结构（还可能撞 C12/C9），
         * 复用只是"不重复建"，最保守。根节点不参与复用（它由单根规则决定）。
         */
        liveByName.has(node.name) &&
        (liveByName.get(node.name)?.parentId ?? null) !== null &&
        !usedIds.has((liveByName.get(node.name) as NodeRecord).id)
      ) {
        const sameName = liveByName.get(node.name) as NodeRecord;
        idByIndex[index] = sameName.id;
        usedIds.add(sameName.id);
        reused += 1;
        reusedNames.push(node.name);
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
          usedIds.add(added.nodeId);
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
      // 单一根规范化与"同名复用"的说明放在最前面：它们改的是**结构**，比"新建了几个节点"更该先看到
      notes: [
        ...rootNotes,
        ...(reused > 0
          ? [
              `有 ${reused} 个节点与已有节点同名（${reusedNames.slice(0, 5).join('、')}${
                reusedNames.length > 5 ? ' 等' : ''
              }），已**复用**而不是再建一个 —— 避免"同名节点这里一个那里一个"`,
            ]
          : []),
        ...notes,
      ],
    };
  }

  // ── 面板右键菜单的动作分发（FR-50–58b 的面板路径）────────────────────

  /**
   * **整理为单一根**（用户反馈"顶级节点按理就只有一个"，那是 AI 建树留下的历史数据）。
   *
   * 规范根取**子树任务点最多**的那一个（并列时取 `rootIds` 里靠前的，保证可重复）；
   * 其余顶级节点整枝并入它下面。逐枝独立判定：某一枝被拒（同名/成环/回滚锁）不影响其他枝，
   * 结果如实逐条返回。**只改父子关系，不删任何节点**（审计留 `reparent` 记录）。
   */
  async mergeRoots(): Promise<
    | { status: 'ok'; canonical: { id: string; name: string }; merged: Array<{ id: string; name: string }>; failures: Array<{ id: string; name: string; reason: string }> }
    | { status: 'noop'; message: string }
  > {
    const { graph, derived } = await this.derive();
    const alive = (id: string): boolean =>
      graph.nodes[id] !== undefined && derived.nodes.get(id)?.derivedState !== 'removed';
    const roots = graph.rootIds.filter((id) => alive(id) && graph.nodes[id]!.parentId === null);
    if (roots.length <= 1) {
      return { status: 'noop', message: `顶级节点只有 ${roots.length} 个，无需整理` };
    }
    let canonical = roots[0]!;
    let best = -1;
    for (const id of roots) {
      const leaves = (await this.nodeView(id))?.leafCount ?? 0;
      if (leaves > best) {
        best = leaves;
        canonical = id;
      }
    }
    const merged: Array<{ id: string; name: string }> = [];
    const failures: Array<{ id: string; name: string; reason: string }> = [];
    for (const id of roots) {
      if (id === canonical) continue;
      const name = graph.nodes[id]?.name ?? id;
      const result = await this.reparentSubtree({
        nodeId: id,
        parentId: canonical,
        reason: `整理为单一根：把「${name}」并入「${graph.nodes[canonical]?.name ?? canonical}」（顶级节点应唯一）`,
      });
      if (result.status === 'ok') merged.push({ id, name });
      else {
        failures.push({
          id,
          name,
          reason: 'message' in result && typeof result.message === 'string' ? result.message : result.status,
        });
      }
    }
    debugBus.info('structure', `整理为单一根：并入 ${merged.length} 枝，失败 ${failures.length}`);
    return {
      status: 'ok',
      canonical: { id: canonical, name: graph.nodes[canonical]?.name ?? canonical },
      merged,
      failures,
    };
  }

  /** 调整父子关系（面板路径；模型侧不开放）。走同一套落库与审计。 */
  private async reparentSubtree(input: {
    nodeId: string;
    parentId: string | null;
    reason?: string;
    by?: 'user' | 'session';
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateReparent(
      graph,
      {
        nodeId: input.nodeId,
        parentId: input.parentId,
        by: input.by ?? 'user',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

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












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
import { effectiveSandboxMode, resolveSnapshotMode, serviceOf, type CapabilityReport } from './adapter/capabilities.ts';
import { sessionOfAgent } from './adapter/exec-view.ts';
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
// FR-174 的警示口径在独立模块里（可单测），这里只消费
import { alertsOf, type BoardAlerts } from './adapter/alerts.ts';
import {
  normalizeRootPath,
  resolveWorkspaceRoot,
  type WorkspaceRootResolution,
} from './adapter/workspace-root.ts';
import { ancestorIds, focusedRoots, buildIndex, subtreeIds } from './domain/graph.ts';
import {
  findReusableNode,
  identityKeyOf,
  keyOfExisting,
  refTokensOf,
  type IdentityNode,
} from './domain/identity.ts';
import type { RollbackScope, SnapshotReason } from './domain/snapshot.ts';
import { nextTaskOf, type TaskCandidate } from './domain/next-task.ts';
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
import { AI_BUILD_EXCLUDE } from './ai/scope.ts';
import {
  AI_TREE_SYSTEM_PROMPT,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  buildTreePrompt,
  describeEstimate,
  estimateAiBuild,
  type AiEstimate,
  type SkeletonEntry,
} from './ai/prompt.ts';
import { callTreeBuilder, llmStreamOf, type BuildTreeCallInput, type BuildTreeCallResult, type LlmStreamLike } from './ai/tree-builder.ts';
import { aiRunProgressOf, type AiRunProgress } from './ai/progress.ts';
import { shouldShard, shardSkeleton, type Shard } from './ai/shard.ts';
import {
  cacheKey,
  decideCache,
  diffSignatures,
  isReusableEntry,
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
  lastProviderMeasuredTreeCall,
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
import { parseTreeResponse, treeFromCached, type ParseOutcome } from './ai/parse.ts';
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
  /**
   * **自动接续**（FR-162 ②），**默认关**。
   *
   * 开启后提示词里会多一句"做完一个节点就 `pm_next` 取下一条接着做"。
   * **它只是一句话**：插件不因此唤醒会话、不发注入（T11：唤醒 = 自动花钱），
   * 所以效果发生在用户下一次自然输入时，而不是"半夜自己开工"。
   */
  autoContinue?: boolean;
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
 * 把缓存里那份**已解析的树**还原成"和解析结果同形"的东西。
 *
 * 实现收在 `ai/parse.ts` 的 `treeFromCached`（纯函数、可单测）——因为**预览与执行必须共用同一判据**，
 * 见 `ai/cache.ts` 的 `isReusableEntry`。这里只做类型收窄。
 */
function completeTreeOf(tree: unknown): Extract<ParseOutcome, { ok: true }> | undefined {
  const outcome = treeFromCached(tree);
  return outcome !== undefined && outcome.ok ? outcome : undefined;
}

/**
 * 缓存条目到底**能不能真的复用**（预览与执行必须共用这一个判据）。
 *
 * 实现收在 `ai/cache.ts` 的 `isReusableEntry`：它比 `decideCache` 严格 —— 指纹相同只是必要条件，
 * 条目结构还得过自检（空树 / 半份解析不出来 ⇒ 不可复用）。
 * 首版只在执行阶段做结构自检，预览却只看指纹，于是出现"确认框说不花钱、点下去调了模型"。
 */
function canReuseCached(verdict: CacheVerdict): boolean {
  if (verdict.kind === 'miss') return false;
  return isReusableEntry(verdict.entry);
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
  /**
   * FR-158 ③：本轮建树没再提到它 → 疑似遗留（**只标不删**，等用户确认）。
   *
   * 注意它**照常计入统计**：`stale` 是"建议你决定去留"，不是"不算数"。
   * 客户端 `client/contract.ts` 里有一份同名字段（跨 HTTP 传输，两处必须同步）。
   */
  stale?: boolean;
  /** 优先级 1..10（1 最高）：只服务"未完成的先做哪个"，**不参与完成度**。 */
  priority?: number;
  /** 优先级来源：`ai` = 建树时模型估的；`user` = 人改过（模型不覆盖）。 */
  prioritySource?: 'ai' | 'user';
  /** 待审查（FR-164）：画布显示审查角标；取任务时压过关注；审完消失、父审通整枝。 */
  needsReview?: boolean;
  /** 完成简报里还有"需要补充/处理"的事 ⇒ 界面黄底 + 感叹号示警。 */
  hasFollowUp?: boolean;
  /** 最后一次改动这个节点的会话 id（供"跳转到该会话"用；人手动改不覆盖）。 */
  lastSessionId?: string;
  subscriptionCount: number;
  branchPath: string[];
}

/** 看板整体快照（面板一次拉取的全部内容）。 */
/**
 * 待确认的整枝删除（`nodeId → 待确认信息`）。
 *
 * **由 AI/会话发起**的删除在这里登记，看板据此把这枝标红（用户口径："由会话引起的节点删除需要审核，
 * 并在流程图上红色高亮标记，知道要删哪个"）。用户确认/拒绝后清除。
 * 只放内存：确认令牌本身也是内存态（重启即失效），两者生命周期一致 —— 不假装持久化。
 */
/**
 * 会话"忙"标记的有效期（毫秒）。
 *
 * 为什么需要：`agent/status: running` 之后可能**再也没有** `idle`（会话被强杀、宿主重启等），
 * 留着一条永不失效的"忙"会让图标永远转圈 —— 那比不转更糟（谎称有人在干活）。
 * 超过这个时长没有新信号就视为失联，退回按节点 `updatedAt` 判断。
 */
const BUSY_SESSION_TTL_MS = 5 * 60_000;
interface PendingRemoval {
  confirmToken: string;
  policy: 'record' | 'code' | 'comment';
  preview: string;
  origin: string;
  at: string;
}

/** 待确认删除的登记表（只放内存：确认句柄本身也是内存态，两者生命周期一致）。 */
type PendingRemovalMap = Map<string, PendingRemoval>;


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
  /** FR-174：宿主侧的 error/warn 警示（口径见 `alertsOf`）。 */
  alerts: BoardAlerts;
  snapshot: { mode: 'git' | 'patch' | 'full'; reason: string };
  /** 每个节点有几个可用回滚点（`nodeId → 数量`）；菜单据此决定「回滚」显不显示。 */
  rollbackPoints: Record<string, number>;
  confirmChannel: string;
  /**
   * **当前正在真干活的会话 id**（`agent/status: running` 且尚未 `idle`/`disposed`）。
   *
   * 为什么给"具体是哪些"而不是"有几个"：客户端能拿它跟**自己的会话 id** 对上，
   * 从而判断"这个面板对应的会话是不是正在跑" —— 计数做不到这件事。
   *
   * 为什么要它：`derivedState === 'running'` 只说明"被启动过"，而"有没有人在跑"是**会话的事**。
   * 只看节点自己的 `updatedAt`（`client/liveness.ts` 的 90s 窗口）会把"会话正在跑但这一会儿没写节点"
   * 误判成没人跑、画成 ▶（用户口径："正在会话的没有从播放三角切换到 loading"）。
   */
  busySessionIds: string[];
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
  /** 由 AI 发起、等待人工确认的整枝删除（画布据此**标红**：审核时要知道删的是哪一个）。 */
  pendingRemovals: Array<{
    nodeId: string;
    name: string;
    policy: 'record' | 'code' | 'comment';
    preview: string;
    origin: string;
    at: string;
  }>;
  /**
   * **正在跑的 AI 建树进度**（FR-167）；没有在跑时为 `null`。
   *
   * 为什么放进看板载荷而不是新开一条通道：面板本来就在轮询/接收看板快照，
   * 复用它是"一处数据、一处渲染"，不必为一条进度条再引一套订阅。
   */
  aiRun: AiRunProgress | null;
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
 * **批量删除整枝的结果**（会话工具 `pm_remove` 的批量形态）。
 *
 * 批量删除刻意做成"**逐枝独立判定**"：某一枝被拒（回滚锁 / CAS 过期 / 树已变）
 * **不影响**其他枝被删掉，并把失败逐条如实回报 —— 而不是"一半成功却报整体失败"
 * 或"一条失败就全撤"（后者会让"删 5 个 stale 节点"永远做不到）。
 */
export interface RemoveBatchResult {
  status: 'ok' | 'partial' | 'denied' | 'needs-confirm';
  /** 实际删掉的枝根节点 id（含被并入上层目标、因而没单独删的节点）。 */
  removed: string[];
  /** 逐条失败原因（节点名 + 为什么），空数组表示全部成功。 */
  failures: Array<{ nodeId: string; name: string; reason: string }>;
  /** 只有一个目标节点时给 `nodeId`（供既有单节点调用方读取）。 */
  nodeId?: string;
  revision?: number;
  confirmToken?: string;
  preview?: string;
  action?: string;
  code?: string;
  message?: string;
  hint?: string;
}

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
 * 哪些失败原因值得**改成分批重试**。
 *
 * 只挑"**规模**导致的失败"：空返回、被 token 上限截断 —— 这两样的共同点是
 * **把一次大请求拆成几次小请求就可能好**。
 *
 * `llm-unavailable` / `call-failed` / `aborted` 不在此列：模型没了/网络断了/人取消了，
 * 分十批也一样失败，重试只是多花钱。
 *
 * **`invalid-output` 也不在此列**（这是被 e2e 抓出来后收紧的）：它的典型情形是
 * "模型压根没按格式答"（写了一整段解释），那种情况分批同样救不了；
 * 而"被截断导致的 JSON 不闭合"现在有自己的原因码 `truncated`（判据同源，见 `tree-builder.ts`）。
 */
const SHARD_RETRY_REASONS: ReadonlySet<string> = new Set([
  'empty-output',
  'truncated',
]);

/**
 * AI 建树的**成功**返回。
 *
 * 抽成类型别名是为了让"分批路径"与"单次路径"共用同一份形状 ——
 * 两条路径各写一份返回类型，迟早会漂移成"面板上有的字段分批时没有"。
 */
export interface AiBuildTreeOk {
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
   * `miss` 真的调了模型。
   */
  cache: {
    state: 'hit' | 'resume' | 'miss';
    savedTokens: number;
    changedPaths: { added: string[]; removed: string[]; changed: string[] };
  };
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
  /**
   * 待确认的整枝删除登记表（FR-158 之外的"审核可见性"）。
   *
   * **由 AI/会话发起**的删除在这里登记：看板据此把这枝**标红**，用户在流程图上一眼看出"要删哪个"。
   * 用户确认（或拒绝）后立即清除。只放内存 —— 确认句柄本身也是内存态（重启即失效），生命周期一致。
   */
  private readonly pendingRemovals: PendingRemovalMap = new Map();
  /**
   * 运行中的建树进度（FR-167）。
   *
   * **只在真的在跑时有值**，跑完/失败/取消立刻清掉 —— 留着它会让面板显示一条"永远 90%"的假进度条。
   */
  private aiRunProgress: AiRunProgress | null = null;
  /**
   * **正在跑的建树调用的中止句柄**（FR-168）；没有在跑时为 `null`。
   *
   * 为什么要显式通道而不是"连接断了就中止"：后者是**推断**（宿主/代理/浏览器任何一环都可能
   * 让连接状态变得难以解释），而取消是用户的一次**明确表态**。两者混在一起，会出现
   * "用户没点取消，调用却被中断"这种无从解释的现象。
   */
  private aiBuildAbort: AbortController | null = null;
  /** 用户是否已经明确要求取消这一轮建树（分批时用来不再发起下一片）。 */
  private aiCancelRequested = false;
  /**
   * **这一轮建树的实际用量**（提供方回报的真实 `usage`，分批时逐片累加）。
   *
   * 单独存一份而不是去账本里现查：账本是**跨轮次**的流水（还混着别的场景），
   * 而面板要显示的是"**刚刚这一轮**花了多少"。第 1 片开始时清零（见 `callTreeBuilderWithProgress`）。
   */
  private aiRunActual: { inputTokens?: number; outputTokens?: number } | undefined;
  /**
   * **会话忙闲表**（会话 id → 最后一次"已知在忙"的时刻）。
   *
   * 由 `src/index.ts` 挂在 DSH 的 `agent/status`（`running` 记忙、`idle` 记闲）与
   * `agent/disposed`（移除）上。只放内存：会话本身也是进程内对象，进程重启后重新记账即可。
   */
  private readonly busySessions = new Map<string, string>();
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
  /** 已经说明过"这个会话不在注册表里"的会话 id（有界，见 `noteAgentGone`）。 */
  private readonly agentGoneNoted = new Set<string>();
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

  /**
   * **算出"本轮只需要给哪些节点补描述"**（用户口径："修剪树时已有简述和简报的不必再次要求
   * AI 生成…省 token"）。
   *
   * 判据（与 `applyAiTree` 落库那四档闸门一致，避免"提示词让它写、落库又不写"的错位）：
   * - **已完成**节点不列（它的描述是完成简报，会话/人改写的，AI 不许盖）；
   * - **已有描述**的节点不列（没有变化就不重生成）；
   * - **没有描述**的节点才列。
   *
   * 返回值语义：
   * - `undefined` ⇒ **不启用按需模式**（让模型按常规给每个节点都写描述）。两种情况：
   *   ① 树还是空的（首次建树，每个节点都是新的，全都需要描述）；
   *   ② 缺描述的节点太多（清单本身会占掉提示词，得不偿失）。
   * - `[]` ⇒ 一个都不缺，明确告诉模型"别输出 description"。
   * - `[名字…]` ⇒ 只给这些节点生成。
   */
  private async planDescriptionTargets(): Promise<string[] | undefined> {
    const { graph, derived } = await this.derive();
    const live = Object.values(graph.nodes).filter(
      (node) => derived.nodes.get(node.id)?.derivedState !== 'removed',
    );
    if (live.length === 0) return undefined; // 首次建树：照常全员生成
    const targets = live
      .filter(
        (node) =>
          derived.nodes.get(node.id)?.derivedState !== 'done' &&
          (node.description === undefined || node.description.trim() === ''),
      )
      .map((node) => node.name);
    // 缺描述的太多时，清单本身就变成噪声：这时按常规全员生成，别把提示词撑大
    if (targets.length > 60) return undefined;
    return targets;
  }

  /**
   * **下一个该做的**（FR-162）—— 按 **关注点 → 优先级 → 进度** 取一条；只读，不改任何状态。
   *
   * 用户口径："完成一个阶段后，从项目进度工具里获取下个阶段任务继续跑，无需用户一直写入继续"。
   * 排序实现在纯函数 `domain/next-task.ts::nextTaskOf`（有单测），这里只负责**喂数据**：
   * ① 只取**可执行的任务点**（叶节点）—— 功能点不是"能动手做"的单元；
   * ② 算好"是否在**关注链路**内"（关注枝的子树 + 它的祖先链，与其它"关注"口径同源）。
   */
  async nextTask(): Promise<{
    status: 'ok' | 'empty';
    nodeId?: string;
    name?: string;
    progress?: number;
    priority?: number;
    inFocusChain?: boolean;
    /** 一句话说明"为什么是它"，让人/模型能核对排序是否合理。 */
    reason?: string;
  }> {
    const { graph, derived } = await this.derive();
    const focusRoots = focusedRoots(derived.index);
    /** 关注链路 = 关注枝本身 / 它的子孙 / 它的祖先（人已表态"我盯这条"）。 */
    const inFocusChain = (id: string): boolean => {
      for (const rootId of focusRoots) {
        if (rootId === id) return true;
        if (subtreeIds(derived.index, rootId).includes(id)) return true;
        if (ancestorIds(derived.index, rootId).includes(id)) return true;
      }
      return false;
    };
    const candidates: TaskCandidate[] = [];
    for (const node of Object.values(graph.nodes)) {
      const state = derived.nodes.get(node.id);
      if (state === undefined || state.derivedState === 'removed') continue;
      // 只要"能动手做"的单元：叶节点（含还没细分的大功能点）
      if (state.childCount > 0) continue;
      candidates.push({
        id: node.id,
        name: node.name,
        derivedState: state.derivedState,
        progress: state.progress,
        ...(node.priority !== undefined ? { priority: node.priority } : {}),
        /** FR-164：待审查压过关注（用户口径："审查优先级大于关注"）。 */
        ...(node.needsReview === true ? { needsReview: true } : {}),
        inFocusChain: inFocusChain(node.id),
      });
    }
    const picked = nextTaskOf(candidates);
    if (picked === undefined) return { status: 'empty' };
    return {
      status: 'ok',
      nodeId: picked.id,
      name: picked.name,
      progress: picked.progress,
      ...(picked.priority !== undefined ? { priority: picked.priority } : {}),
      ...(picked.needsReview === true ? { needsReview: true } : {}),
      inFocusChain: picked.inFocusChain,
      reason:
        picked.needsReview === true
          ? '待审查（审过的活才算数，它压过关注与优先级）'
          : picked.inFocusChain
            ? '在关注链路内（关注点优先）'
            : picked.priority !== undefined
              ? `按优先级 ${picked.priority}（1 最高）取到`
              : '按进度取到（没给优先级的排在有优先级的后面）',
    };
  }

  /** 新增节点。 */
  async addNode(input: {    parentId: string | null;
    name: string;
    kind?: NodeKind;
    description?: string;
    refs?: Ref[];
    /** 稳定身份键（FR-158）：建树时一并写入，让"同一个功能点"在下次建树时能按 refs 认出来。 */
    identity?: string;
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
        ...(input.identity !== undefined ? { identity: input.identity } : {}),
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
  /**
   * 收集并校验一次删除请求的**目标枝根集合**（单节点与批量走同一条路）。
   *
   * 两件事容易做错，都固化在这里：
   * ① **去掉被别的目标包含的节点**：祖先已在目标里时，整枝删除会顺带带走它，
   *    再删一次只会得到 `E_NOT_FOUND` 这种噪音失败（用户会误以为"有一半没删掉"）；
   * ② 目标不存在 / 重复 ⇒ 直接拒绝，**不半执行**（否则批量的语义会变得不可预期）。
   */
  private async collectRemoveTargets(input: {
    nodeIds: string[];
  }): Promise<{ ok: true; nodeIds: string[] } | { ok: false; result: ApplyResult }> {
    const unique = [...new Set(input.nodeIds)];
    if (unique.length === 0) {
      return {
        ok: false,
        result: {
          status: 'denied',
          reason: 'validation',
          code: 'E_NO_TARGET',
          message: '没有给出要删除的节点',
        },
      };
    }
    const { graph, derived } = await this.derive();
    const missing = unique.filter((id) => graph.nodes[id] === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        result: {
          status: 'denied',
          reason: 'validation',
          code: 'E_NOT_FOUND',
          message: `节点不存在：${missing.join('、')}`,
        },
      };
    }
    // 祖先已在目标集合里 ⇒ 本节点会被顺带删掉，不必单列
    const targetSet = new Set(unique);
    const topmost = unique.filter((id) => {
      const ancestors = ancestorIds(derived.index, id);
      return !ancestors.some((ancestor) => targetSet.has(ancestor));
    });
    return { ok: true, nodeIds: topmost };
  }

  /**
   * 删除整枝（`pm_remove`）—— **破坏性操作，必须取得一次性授权**（§13.1 / FR-135–138）。
   *
   * **批量 = 一次确认覆盖整批**（用户口径："删除批量只存在会话工具中，平时由右键删除整枝决定"）：
   * 面板只提供右键「删除整枝」（它本身就是递归删整棵子树），
   * "一次删多个枝"属于会话工具的能力，所以这里支持多个目标，但**令牌与授权都按批算一次**。
   *
   * 未带 `confirmToken` 时只返回 `needs-confirm` + preview，**不执行任何动作**。
   */
  async removeBranch(input: {
    nodeIds: string[];
    policy: 'record' | 'code' | 'comment';
    rev?: number;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<RemoveBatchResult> {
    const collected = await this.collectRemoveTargets({ nodeIds: input.nodeIds });
    if (!collected.ok) {
      return {
        status: 'denied',
        removed: [],
        failures: [],
        ...('code' in collected.result ? { code: String(collected.result.code) } : {}),
        ...('message' in collected.result ? { message: String(collected.result.message) } : {}),
      };
    }
    const targets = collected.nodeIds;
    const { graph, derived } = await this.derive();
    let workingGraph = graph;

    // 影响范围：逐枝列出（顶层序），批量时前缀汇总数字 —— 用户确认前必须看懂"一共要动多少"
    const perTarget = targets.map((id) => ({
      nodeId: id,
      name: workingGraph.nodes[id]?.name ?? id,
      preview: this.previewRemove(workingGraph, id, input.policy),
    }));
    const preview =
      perTarget.length === 1
        ? (perTarget[0]?.preview ?? '')
        : [`**批量删除 ${perTarget.length} 枝**（一次确认覆盖全部）：`, ...perTarget.map((item) => `- ${item.preview}`)].join(
            '\n',
          );

    if (input.confirmToken === undefined) {
      const confirmToken = this.deps.random.uuid();
      /**
       * 红线登记（FR-159）：**每个目标节点各登记一条，共用同一个令牌**。
       * 于是一次审批覆盖整批，而画布上**每一枝都会标红**（这才是"知道要删哪个"）。
       */
      const now = this.deps.clock.now();
      const origin = this.pendingRemovalOrigin(input.agent);
      for (const id of targets) {
        this.pendingRemovals.set(id, {
          confirmToken,
          policy: input.policy,
          preview: this.previewRemove(workingGraph, id, input.policy),
          origin,
          at: now,
        });
      }
      return { status: 'needs-confirm', removed: [], failures: [], confirmToken, preview, action: 'remove-branch' };
    }

    // 令牌校验：必须是**本插件为这批节点签发的那个**（自造/重放/参数变更一律失效）
    const pending = this.pendingRemovals.get(targets[0] ?? '');
    if (pending === undefined || pending.confirmToken !== input.confirmToken) {
      return {
        status: 'denied',
        removed: [],
        failures: [],
        code: 'E_STALE_CONFIRM_TOKEN',
        message: '确认句柄无效或已过期：请重新发起删除（会重新签发句柄），或改用面板右键确认。',
        hint: '面板路径：侧边栏「项目进度」→ 右键该节点 → 删除整枝',
      };
    }

    /**
     * 准入：**按节点类型分级**（用户口径："动功能点（删除／性质上的修改）属于**危险操作**，任务点没问题"）。
     * 批量时只要有**任一功能点**，整批过一次授权 —— 一次确认覆盖整批，不逐个打扰。
     */
    const featureTargets = targets.filter((id) => workingGraph.nodes[id]?.kind === 'feature');
    const needsApproval = featureTargets.length > 0;
    const authorized = needsApproval
      ? await this.authorize({
          action: 'remove-branch',
          toolName: input.toolName ?? 'pm_remove',
          reason:
            targets.length === 1
              ? `删除功能点「${workingGraph.nodes[targets[0] ?? '']?.name ?? ''}」（policy=${input.policy}）`
              : `批量删除 ${targets.length} 枝（其中 ${featureTargets.length} 个功能点：${featureTargets
                  .slice(0, 3)
                  .map((id) => workingGraph.nodes[id]?.name ?? id)
                  .join('、')}${featureTargets.length > 3 ? ' 等' : ''}）`,
          agent: input.agent,
          callId: input.callId,
        })
      : { ok: true as const };
    // 用户已经表过态（无论通过还是被拒），待确认标记都该撤掉
    for (const id of targets) this.pendingRemovals.delete(id);
    if (!authorized.ok) {
      return {
        status: 'denied',
        removed: [],
        failures: [],
        code: authorized.reason,
        message: authorized.message,
        ...(authorized.hint !== undefined ? { hint: authorized.hint } : {}),
      };
    }

    /**
     * 逐枝独立执行：一枝失败不影响其他枝，失败原因逐条回报（见 {@link RemoveBatchResult}）。
     * 每删一枝都用**最新图**（前一次删除会改变父子关系与墓碑），否则第二枝会撞 CAS。
     */
    const removedIds: string[] = [];
    const failures: Array<{ nodeId: string; name: string; reason: string }> = [];
    let lastRevision: number | undefined;
    for (const id of targets) {
      const fresh = await this.readGraph();
      const name = fresh.nodes[id]?.name ?? id;
      if (fresh.nodes[id] === undefined) {
        // 被上一枝顺带删掉了（理论上 collectRemoveTargets 已排除，这里兜底）——不算失败
        removedIds.push(id);
        continue;
      }
      const applied = await this.persist(
        mutateRemove(
          fresh,
          {
            nodeId: id,
            policy: input.policy,
            by: 'user',
            ...(input.rev !== undefined && targets.length === 1 ? { rev: input.rev } : {}),
          },
          this.mutationContext(),
        ),
      );
      if (applied.status === 'ok') {
        removedIds.push(id);
        lastRevision = applied.revision;
      } else {
        failures.push({
          nodeId: id,
          name,
          reason:
            'message' in applied && typeof applied.message === 'string' ? applied.message : applied.status,
        });
      }
    }

    if (removedIds.length === 0) {
      return {
        status: 'denied',
        removed: [],
        failures,
        code: 'E_REMOVE_FAILED',
        message: `一枝都没删掉：${failures.map((item) => `${item.name}（${item.reason}）`).join('；')}`,
      };
    }
    return {
      status: failures.length > 0 ? 'partial' : 'ok',
      removed: removedIds,
      failures,
      ...(targets.length === 1 && removedIds[0] !== undefined ? { nodeId: removedIds[0] } : {}),
      ...(lastRevision !== undefined ? { revision: lastRevision } : {}),
    };
  }

  /**
   * **单节点删除**（既有调用方与工具的兼容入口）：语义等价于 `removeBranchBatch`，只是把返回值
   * 按 `ApplyResult` 的形状转出来（`status: 'partial'` 对单节点不会出现）。
   */
  async removeBranchSingle(input: {
    nodeId: string;
    policy: 'record' | 'code' | 'comment';
    rev?: number;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    const result = await this.removeBranch({
      nodeIds: [input.nodeId],
      policy: input.policy,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.confirmToken !== undefined ? { confirmToken: input.confirmToken } : {}),
      ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
    });
    if (result.status === 'ok' && result.nodeId !== undefined && result.revision !== undefined) {
      return { status: 'ok', nodeId: result.nodeId, revision: result.revision, autoFixes: [], attempts: result.removed.length };
    }
    if (result.status === 'needs-confirm' && result.confirmToken !== undefined) {
      return {
        status: 'needs-confirm',
        confirmToken: result.confirmToken,
        preview: result.preview ?? '',
        action: result.action ?? 'remove-branch',
      };
    }
    return {
      status: 'denied',
      reason: 'validation',
      code: result.code ?? 'E_REMOVE_FAILED',
      message: result.message ?? '删除未执行',
      ...(result.hint !== undefined ? { hint: result.hint } : {}),
    };
  }

  /** 旧签名（单节点）保留为薄包装：内部一律走 {@link removeBranch}。 */
  async removeOne(input: {
    nodeId: string;
    policy: 'record' | 'code' | 'comment';
    rev?: number;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    return this.removeBranchSingle(input);
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

  /**
   * 是否开启**自动接续**（FR-162 ② 配置开关的同步读法），**默认关**。
   *
   * 与 `boundaryPromptEnabled` 同款理由：提示词 provider 是同步函数、改设置时不重新注册，
   * 所以每次组装都问一遍这个开关。**它不触发任何动作** —— 没有任何事件回调读它去唤醒会话，
   * 因此"开着"也只会让模型在用户下一次输入时自己接着做（T11：唤醒 = 自动花钱）。
   */
  autoContinueEnabled(): boolean {
    return this.deps.config.autoContinue === true;
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
    return readRegistry(this.agentsRegistry(), id) as
      | {
          inbox?: { append?: (target: string, message: unknown) => void };
          inject?: (message: unknown) => void;
          send?: (message: unknown, target: string, wakeup: boolean) => void;
        }
      | undefined;
  }

  /**
   * **agents 注册表本身**（服务在不在），与"某个会话在不在"是**两件事** —— 必须分开判。
   *
   * 为什么要拆：真机诊断里出现过这样一条 warn：
   * `回写会话（session-9f2b…）失败：拿不到 agents 服务（…PENDING…）`，而它发生在**加载后 4 分半**、
   * 服务其实好好的 —— 真因是那条订阅属于**上一个宿主进程的会话**，新进程的注册表里按 id 查不到人。
   * 两件事被 `agentFor` 的同一个 `undefined` 合并了，于是消息把"会话已不在"说成了"服务拿不到"。
   * 在"拿本插件当项目自测"的场景里这尤其误导：树上留着历史会话建的订阅，是**正常现象**，
   * 而它会把状态条上的警示角标**长期点亮**（FR-174）—— 一个永远亮着的告警等于没有告警。
   */
  private agentsRegistry(): { get?: (id: string) => unknown } | undefined {
    if (this.agentsService !== undefined) return this.agentsService;
    try {
      const holder = this.ctx as unknown as {
        agents?: { get?: (id: string) => unknown };
        get?: (name: string) => unknown;
        reflect?: { get?: (name: string, strict?: boolean) => unknown };
      };
      const candidate =
        holder.agents ??
        holder.get?.('agents') ??
        holder.reflect?.get?.('agents', false);
      return candidate === undefined || candidate === null
        ? undefined
        : (candidate as { get?: (id: string) => unknown });
    } catch {
      return undefined;
    }
  }

  /**
   * **主动查一个会话现在是不是在跑**（`agent.status === 'running'`）。
   *
   * 为什么不只靠 `agent/status` 事件记账：实测"会话明明在跑、图上却没有 loading" ——
   * 事件可能因 scope 过滤/时序没到我们手里，而**查询是拉取**，不依赖事件送达。
   * 拿不到 agent 或它没有 `status` ⇒ 返回 `undefined`（**不确定**，调用方据此回落到事件记账，
   * 绝不把"查不到"当成"没在跑"）。
   */
  private sessionStatusOf(sessionId: string): 'running' | 'idle' | undefined {
    try {
      const agent = this.agentFor(sessionId) as unknown as { status?: unknown } | undefined;
      const status = agent?.status;
      return status === 'running' || status === 'idle' ? status : undefined;
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
   * **服务在、但注册表里没有这个会话** ⇒ 记 info，**不是 warn**。
   *
   * 这是**正常现象**：订阅是上一个宿主进程/已结束的会话建的，新进程里按 actorId 查不到活着的 agent。
   * 设计上就该"不送达、不记账、等它回来再试"（FR-112 的既有口径），不该报警告 ——
   * 否则状态条的警示角标会被它长期点亮（见 `agentsRegistry` 的说明）。
   * 按会话去重（有界保留），免得同一个死会话反复刷屏。
   */
  private noteAgentGone(sessionId: string, where: string): void {
    if (this.agentGoneNoted.has(sessionId)) return;
    if (this.agentGoneNoted.size >= 50) this.agentGoneNoted.clear();
    this.agentGoneNoted.add(sessionId);
    debugBus.info(
      'notify',
      `${where}：会话 ${sessionId} 不在活跃注册表里（多半是上一个宿主进程留下的订阅、或已结束的会话）` +
        '⇒ 本条不送达、不记账，等它回来再试',
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
    if (agent === undefined) {
      if (this.agentsRegistry() === undefined) this.warnAgentsMissing(`注入上下文（${sessionId}）失败`);
      else this.noteAgentGone(sessionId, '注入上下文');
      return false;
    }
    if (typeof agent.inject !== 'function') {
      // 会话在、但这条通道没有 inject ⇒ 是**形状**问题（第三种情形，不能和服务不可用混说）
      this.warnDeliveryShape(sessionId, agent);
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
      // 分两件事：服务拿不到（真降级 → warn）/ 会话不在注册表里（正常 → info）
      if (this.agentsRegistry() === undefined) this.warnAgentsMissing(`回写会话（${sessionId}）失败`);
      else this.noteAgentGone(sessionId, '回写会话');
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
      // FR-174：宿主自己的错误/告警也要能被看见（钩子抛错、事件异常、降级路线……）
      alerts: alertsOf(debugBus),
      snapshot: snapshotDecision,
      /**
       * 正在真干活的会话 id（客户端拿它跟自己的会话对一下，就知道该不该转圈）。
       * 判据见 `client/liveness.ts`：`updatedAt` 窗口 **或** 会话正在忙 —— 任一成立即"在跑"。
       */
      busySessionIds: await this.busySessionIdList(),
      // 每个节点有几个可用回滚点：菜单要**同步**决定「回滚 / 整枝回滚」显不显示
      // （FR：没有回滚点时不显示，而不是画一个点了没反应的项）
      rollbackPoints: await this.rollbackPointCounts(liveNodes.map((d) => d.node.id)),
      // AI 发起的待确认删除：画布据此把那枝标红（"知道要删哪个"）。
      // 这里**不做超时清理** —— 红线的生命周期跟着 ask 走，由用户交互或节点消失决定（见 removeBranch）。
      pendingRemovals: [...this.pendingRemovals].flatMap(([nodeId, entry]) => {
        if (graph.nodes[nodeId] === undefined) {
          // 节点已经没了（人从面板删了 / 别的路径删了）：记录留着没意义，顺手清掉
          this.pendingRemovals.delete(nodeId);
          return [];
        }
        return [{
          nodeId,
          name: graph.nodes[nodeId].name,
          policy: entry.policy,
          preview: entry.preview,
          origin: entry.origin,
          at: entry.at,
        }];
      }),
      confirmChannel: this.confirm?.describeChannel() ?? '确认路由未装配',
      // FR-167：正在跑的建树进度（没在跑就是 null，面板据此隐藏那一行）
      aiRun: this.aiRunProgress ?? null,
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
    // FR-158 ③：疑似遗留（本轮建树没再提到）。**照常计入统计**，只是可被看板标出来让用户决定去留。
    if (d.node.stale === true) view.stale = true;
    // 优先级（1 最高）：只服务"未完成的先做哪个"，不参与完成度
    if (d.node.priority !== undefined) view.priority = d.node.priority;
    if (d.node.prioritySource !== undefined) view.prioritySource = d.node.prioritySource;
    /** 待审查（FR-164）：画布要显示审查图标、取任务时它压过关注。 */
    if (d.node.needsReview === true) view.needsReview = true;
    // 完成后仍有遗留 ⇒ 界面要示警（黄底 + 感叹号），所以必须暴露出去
    if (d.node.hasFollowUp === true) view.hasFollowUp = true;
    // 「跳到处理它的那个会话」要有据可依：把最后写入它的会话带出去
    if (d.node.lastSessionId !== undefined) view.lastSessionId = d.node.lastSessionId;
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
   * FR-161 判据的输入：**只看结构**的节点投影（`id / name / parentId / focus / refs`）。
   *
   * 为什么另开一个方法而不是用 `board()`：写入类工具**每次调用**都要判一次
   * （`tools/pre-execute` 里），而 `board()` 会顺带算回滚点数量、文档合法性、未完成扫描带、
   * 待确认删除……那些与"这条改动会不会影响别的任务线"毫无关系，白花时间。
   * 这里只取判据真正要的五个字段，墓碑（已删除）不进。
   */
  async reviewIndexOf(): Promise<
    Array<{
      id: string;
      name: string;
      parentId: string | null;
      focus: boolean;
      kind: string;
      description?: string;
      progress: number;
      refs: string[];
    }>
  > {
    const { derived } = await this.derive();
    return [...derived.nodes.values()]
      .filter((entry) => entry.derivedState !== 'removed')
      .map((entry) => ({
        id: entry.node.id,
        name: entry.node.name,
        parentId: entry.node.parentId ?? null,
        focus: entry.node.focus === true,
        // 判据（重复枝合并、审查对象判定）要这几项：都从事实源直接取，不做推断
        kind: entry.node.kind,
        ...(entry.node.description !== undefined ? { description: entry.node.description } : {}),
        progress: entry.node.progress ?? 0,
        refs: (entry.node.refs ?? []).map((ref) => ref.target),
      }));
  }

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
    /**
     * **完全权限 ⇒ 免审核**（FR-163，用户口径："完全权限是能删除且不审核的"）。
     *
     * 为什么必须在这里也判一次：`tools/pre-execute` 那道门只管"这次工具调用要不要弹窗"，
     * 而功能点的删除**在这里还有第二道**（`removeBranch` 按 `kind` 分级再要一次授权）。
     * 只在钩子里放行、这里照样问 ⇒ 表现仍然是"完全权限下删功能点被确定性拒绝"（策略 `never` 时），
     * 也就是**需求只落地了一半** —— 真机上正是这么表现的。
     *
     * 判据与钩子**同一处**（`effectiveSandboxMode`：会话实际生效档位，不是部署默认），
     * 免得两处各判一套、各自漂移。
     */
    const liveMode =
      effectiveSandboxMode(this.ctx, sessionOfAgent(this.ctx, input.agent)) ??
      this.deps.capabilities.sandboxMode;
    if (liveMode === 'danger-full-access') {
      debugBus.info('confirm', `完全权限：${input.action} 免审核直接执行（FR-163）`, {
        toolName: input.toolName,
      });
      return { ok: true };
    }
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
    // 兜底值与设置页 schema 的默认值**同一份常量**（各写一个数迟早会漂）。
    // `0`（默认）= 跟随宿主，不设闸门 —— 见 `effectiveOutputLimit`。
    return Number.isFinite(configured) && configured > 0
      ? Math.round(configured)
      : DEFAULT_AI_MAX_OUTPUT_TOKENS;
  }

  /**
   * **宿主要为这个模型用的输出上限**（`LlmResolvedModelInfo.defaultMaxTokens`）。
   *
   * 语义（宿主类型注释原话）："**Adapter-configured per-request output cap materialized when
   * callers omit one**" —— 也就是"我们不传 `maxTokens` 时，宿主会自己按模型设置落地"的那个值
   * （本机模型设置里写着 256K）。
   *
   * 读它只为了**显示与估算**：真正的上限由宿主决定（用户口径："上限应该和 harness 参数持平"）。
   * 读不到就返回 `undefined` —— **不猜、不兜一个假数字**。
   */
  private async hostMaxOutputTokens(route: AiRoute): Promise<number | undefined> {
    try {
      const llm = (this.ctx as unknown as { get?: (key: string) => unknown }).get?.('llm') as
        | {
            resolveModelInfo?: (
              provider: string,
              model: string,
            ) => Promise<{ defaultMaxTokens?: number } | undefined>;
          }
        | undefined;
      if (typeof llm?.resolveModelInfo !== 'function') return undefined;
      const info = await llm.resolveModelInfo(route.provider, route.model);
      const value = info?.defaultMaxTokens;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
    } catch (error) {
      // 读不到不是错误：退回"插件不设限"，照常能建树（缺的只是显示用的那个数）
      debugBus.debug('ai', `未能读到宿主的模型输出上限：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * **本次建树的输出上限**：用户设了就用用户的，否则跟随宿主。
   *
   * 三者必须分清（混在一起就会出现"插件替模型设限"或"显示了编造的数字"）：
   * - `plugin`：用户在设置里填了数字（预算闸门）⇒ **真的传** `maxTokens`；
   * - `host`：用户没填，但读到了宿主的模型上限 ⇒ **不传** `maxTokens`（让宿主落地），只拿它显示；
   * - `unknown`：用户没填、宿主也读不到 ⇒ 不传、也不显示数字，如实说"跟随宿主（未读到具体值）"。
   */
  private async effectiveOutputLimit(
    route: AiRoute,
  ): Promise<{ limit: number | undefined; source: 'plugin' | 'host' | 'unknown' }> {
    const configured = this.aiMaxOutputTokens();
    if (configured > 0) return { limit: configured, source: 'plugin' };
    const host = await this.hostMaxOutputTokens(route);
    return host === undefined ? { limit: undefined, source: 'unknown' } : { limit: host, source: 'host' };
  }

  /**
   * AI 建树的成本预估（**不调用模型**）。
   *
   * 只用手上已有的元数据：遍历到的目录/文件数、关键文件签名字节。
   * 用户要先看到这个数字，才会被允许真正发起调用（§9.5 T3 / FR-39b）。
   */
  async aiBuildEstimate(input?: { sessionId?: string; maxNodes?: number }): Promise<
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
    /**
     * **输出上限从哪来**（FR-172 修正版）：用户设了就用用户的，否则跟随宿主的模型设置。
     * `maxTokens`（真的发给模型的参数）只有 `plugin` 时才传 —— 见 `effectiveOutputLimit`。
     *
     * 放在 `route.ok` 之后：读宿主的模型信息需要 provider/model，路由没定就没得读。
     */
    const collected = await this.collectAiSkeleton(root);
    /** 面板路径的节点上限（默认 60，与 `aiBuildTree` 的默认一致）。 */
    const maxNodesForEstimate = input?.maxNodes ?? 60;
    /**
     * **上次实测**（FR-171）：账本里最近一次"成功 + 提供方真实用量"的建树调用。
     * 拿不到就**没有这个字段**（界面上也不会出现"上次实测"那句话）—— 不编。
     */
    await this.ensureAiUsage();
    const lastActual = lastProviderMeasuredTreeCall(this.aiUsage);
    if (!route.ok) {
      // 路由没定：上限也无从读起（读宿主的模型信息需要 provider/model），如实回"未知"
      const estimate = estimateAiBuild({
        entries: collected.skeleton.length,
        signatureBytes: collected.signatureBytes,
        promptBytes: collected.promptBytes,
        outputLimitSource: 'unknown',
        maxNodes: maxNodesForEstimate,
        likelyTooLarge: shouldShard(collected.skeleton),
        ...(lastActual !== undefined ? { lastActual } : {}),
      });
      return { available: false, reason: route.reason, hint: route.hint, estimate };
    }
    const outputLimit = await this.effectiveOutputLimit(route.route);
    const maxTokens = outputLimit.limit;
    const estimate = estimateAiBuild({
      entries: collected.skeleton.length,
      signatureBytes: collected.signatureBytes,
      promptBytes: collected.promptBytes,
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
      outputLimitSource: outputLimit.source,
      maxNodes: maxNodesForEstimate,
      // 事前提示（不是判定）：文件数超过单次请求的常规范围时，确认框里直说"可能被截断"
      likelyTooLarge: shouldShard(collected.skeleton),
      ...(lastActual !== undefined ? { lastActual } : {}),
    });

    if (!llmAvailable(this.ctx)) {
      return {
        available: false,
        reason: 'llm-unavailable',
        hint: '宿主没有 llm 服务（ctx.llm 缺失），无法发起 AI 调用。',
        estimate,
      };
    }
    // T6/T9：**预估时就把缓存判定算出来**，让确认框能说"这次要不要花钱"。
    // 判据与执行阶段**完全同一份**（`canReuseCached`）：说不用花钱就真的一次调用都不发；
    // 条目结构不可用时如实降级为 miss（宁可说"要花钱"，也不能说"不花钱"却偷偷调模型）。
    const cache = await this.inspectAiCache(collected.prompt, route.route, maxTokens, collected.skeleton);
    const reusable = canReuseCached(cache.verdict);
    return {
      available: true,
      estimate,
      description: describeEstimate(estimate),
      route: `${route.route.provider} / ${route.route.model}（${route.route.source === 'config' ? '设置' : '跟随默认模型'}）`,
      cache: {
        state: reusable && cache.verdict.kind === 'hit'
          ? 'hit'
          : reusable && cache.verdict.kind === 'resume'
            ? 'resume'
            : 'miss',
        ...(cache.diff !== undefined ? { changed: changedSummary(cache.diff) } : {}),
        ...(reusable && (cache.verdict.kind === 'hit' || cache.verdict.kind === 'resume')
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
    /**
     * 发起方（会话/子代理）。**只有它存在时，"覆盖人改过的优先级"才可能拿到 ask 授权**。
     *
     * 面板路径（`POST /pm/ai/build`）没有 agent —— 那是"用户当场点的"，按既定纪律不占审批通道，
     * 所以那种情况下覆盖会被 fail-closed 拒绝并如实记进 notes（**不会静默覆盖**）。
     */
    agent?: unknown;
    callId?: string;
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
    | AiBuildTreeOk
  > {
    const preflight = await this.aiBuildEstimate({
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
    });
    if (!preflight.available) {
      return {
        status: 'denied',
        reason: preflight.reason,
        hint: preflight.hint,
        ...(preflight.estimate !== undefined ? { estimate: preflight.estimate } : {}),
      };
    }
    // 新一轮建树开始：清掉上一轮的取消标记（否则这一轮会被上一轮的取消"继承"掉）
    if (input.confirm === true) this.aiCancelRequested = false;
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
    /**
     * **本轮只需给"缺描述"的节点生成描述**（用户口径："修剪树时已有简述和简报的不必再次要求
     * AI 生成…省 token"）。
     *
     * 为什么要在**提示词**层做而不是落库时过滤：落库丢弃省不到钱 —— 模型已经把 token 吐出来了。
     * 把清单写进提示词、并明确"清单外一律不要输出 description"，省的是**输出 token**。
     */
    const describeOnly = await this.planDescriptionTargets();
    const prompt = buildTreePrompt({
      projectName: collected.projectName,
      skeleton: collected.skeleton,
      maxNodes: input.maxNodes ?? 60,
      ...(collected.truncated ? { truncated: true } : {}),
      ...(collected.skipped > 0 ? { skipped: collected.skipped } : {}),
      ...(describeOnly !== undefined ? { describeOnly } : {}),
    });
    /**
     * **输出上限**：用户设了闸门才真的传 `maxTokens`；没设就跟随宿主的模型设置
     * （`outputLimit.source === 'host'` ⇒ `limit` 只用于显示/估算，**不进请求**）。
     */
    const outputLimit = await this.effectiveOutputLimit(route.route);
    const maxTokens = outputLimit.limit;
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
          agent: input.agent,
          callId: input.callId,
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

    const call = await this.callTreeBuilderWithProgress(
      {
        ctx: this.ctx,
        route: route.route,
        system: AI_TREE_SYSTEM_PROMPT,
        user: prompt,
        // 只有用户设了闸门才真的传上限；跟随宿主时省略（宿主按模型设置落地）
        ...(outputLimit.source === 'plugin' && maxTokens !== undefined ? { maxTokens } : {}),
        ...(input.stream !== undefined ? { stream: input.stream } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
      {
        mode: 'single',
        shardIndex: 1,
        shardTotal: 1,
        ...(maxTokens !== undefined ? { displayLimit: maxTokens } : {}),
      },
    );
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
      /**
       * **大项目分批重试**（用户口径："由于项目大了可能出现空返回情况，需要分批处理"）。
       *
       * 判据 = **失败原因正是规模导致的**（空返回 / 输出不合法 / 被截断），
       * 并且骨架**确实能切出 ≥2 片**（那一条由 `aiBuildTreeSharded` 自己判，切不出就如实放弃）。
       *
       * **为什么不再要求"文件数 > 80"**：那个阈值本意是"单次请求大概够用"，但它是**代理指标**，
       * 而且刚被 FR-170 的范围收窄打了个正着 —— 本仓排除测试/脚本后只剩 75 个文件，
       * 于是"输出被截断"时反而**永远不会**再分批（截断本身就是"一次请求不够"的**直接证据**，
       * 有证据还去问代理指标，等于把已经发生的失败当没发生）。
       * 现在的分工：**事前**用 `shouldShard`（文件数）提示"这个仓库偏大、可能被截断"；
       * **事后**只看"失败原因 + 能不能切"，不做事后诸葛亮。
       */
      if (SHARD_RETRY_REASONS.has(call.reason)) {
        const retry = await this.aiBuildTreeSharded({
          skeleton: collected.skeleton,
          projectName: collected.projectName,
          maxNodes: input.maxNodes ?? 60,
          describeOnly,
          replaceAutoDraft: input.replaceAutoDraft !== false,
          estimate: preflight.estimate,
          route: route.route,
          // 只有用户设了闸门才真的传上限；跟随宿主时省略（让宿主按模型设置落地）
          ...(outputLimit.source === 'plugin' && maxTokens !== undefined ? { maxTokens } : {}),
          ...(maxTokens !== undefined ? { displayLimit: maxTokens } : {}),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.callId !== undefined ? { callId: input.callId } : {}),
          ...(input.stream !== undefined ? { stream: input.stream } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        if (retry.status === 'ok') {
          debugBus.info(
            'ai',
            `分批建树成功：${retry.shards} 片，新建 ${retry.result.created}、更新 ${retry.result.updated}`,
          );
          return retry.result;
        }
        debugBus.error('ai', `分批建树也没成：${retry.message}`, { shards: retry.shards });
        return {
          status: 'error',
          reason: call.reason,
          message:
            `${call.message}\n已按顶层目录分批重试（${retry.shards} 片），分批也没成：${retry.message}`,
          ...(call.rawText !== undefined ? { rawText: call.rawText } : {}),
        };
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
      agent: input.agent,
      callId: input.callId,
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
   * **带运行中进度**地调一次建树模型（FR-167 的唯一落点）。
   *
   * 为什么单独包一层：进度的生命周期（开始置零 → 流式更新 → 结束清理）必须只有一处实现 ——
   * 分散在"单次调用"和"分批 N 次调用"两处，迟早出现"分批跑完还挂着一条 90% 的假进度条"。
   *
   * **结束时的语义**（都对面板可见，不做假动作）：
   * - 正常结束 / 其它失败 ⇒ **清空**（没有在跑就不该有进度条）；
   * - 被上限截断 ⇒ **留着最后一份并标记 `truncated`** —— 那正是用户最需要看见的一行，
   *   下一次建树开始时会被覆盖。
   */
  private async callTreeBuilderWithProgress(
    input: Omit<BuildTreeCallInput, 'onProgress'>,
    meta: {
      mode: 'single' | 'shard';
      shardIndex: number;
      shardTotal: number;
      /**
       * **显示用**的输出上限（可能来自宿主模型设置）。
       *
       * 与 `input.maxTokens`（真正发给模型的参数）**故意分开**：用户没设闸门时我们**不传** `maxTokens`
       * （交给宿主按模型配置落地），但进度条仍需要一个分母来显示"跑到哪了"。
       * 混成一个字段的话，"跟随宿主"就没法既省略参数又显示数字。
       */
      displayLimit?: number | undefined;
    },
  ): Promise<BuildTreeCallResult> {
    const startedAt = this.deps.clock.now();
    /**
     * 每片都从"第 1 片"开始计数（单次调用也是 1）⇒ 这里正好是**一轮建树的开端**，
     * 用它把"本轮实际用量"清零；否则上一轮的数字会被累加进这一轮。
     */
    if (meta.shardIndex === 1) this.aiRunActual = undefined;
    const limit = meta.displayLimit ?? input.maxTokens ?? 0;
    let lastChars = 0;
    const snapshot = (outputChars: number, truncated = false, phase?: 'running' | 'done' | 'error'): AiRunProgress =>
      aiRunProgressOf({
        startedAt,
        mode: meta.mode,
        shardIndex: meta.shardIndex,
        shardTotal: meta.shardTotal,
        outputChars,
        outputLimit: limit,
        truncated,
        ...(phase !== undefined ? { phase } : {}),
        ...(this.aiRunActual !== undefined ? { actual: this.aiRunActual } : {}),
      });
    /**
     * **调用前先看有没有被取消**（FR-168）：分批时用户在第二片点了取消，
     * 后面的片就不该再发起调用 —— 否则"取消"只是取消了当前这一次。
     */
    if (this.aiCancelRequested) {
      return { ok: false, reason: 'aborted', message: '这一轮建树已被用户取消。' };
    }
    const controller = new AbortController();
    const external = input.signal;
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.aiBuildAbort = controller;
    this.aiRunProgress = snapshot(0);
    try {
      const result = await callTreeBuilder({
        ...input,
        signal: controller.signal,
        onProgress: ({ outputChars }) => {
          lastChars = outputChars;
          this.aiRunProgress = snapshot(outputChars);
        },
      });
      /**
       * **实际用量逐次累加**（提供方回报才算）：分批时这一轮是 N 次调用，
       * 面板要显示的是"这一轮总共花了多少"，不是最后一片的。
       */
      const usage = result.usage;
      if (usage !== undefined) {
        const prev = this.aiRunActual ?? {};
        this.aiRunActual = {
          ...(typeof usage.inputTokens === 'number'
            ? { inputTokens: (prev.inputTokens ?? 0) + usage.inputTokens }
            : prev.inputTokens !== undefined
              ? { inputTokens: prev.inputTokens }
              : {}),
          ...(typeof usage.outputTokens === 'number'
            ? { outputTokens: (prev.outputTokens ?? 0) + usage.outputTokens }
            : prev.outputTokens !== undefined
              ? { outputTokens: prev.outputTokens }
              : {}),
        };
      }
      /**
       * **结束也留着这一份快照**（用户口径："生成后，进度条保留，保持 100%"）：
       * 清掉它，用户就看不到"刚刚花了多少 token" —— 而那正是他要看的东西。
       * 下一次建树开始时会被新的第 1 片覆盖。
       */
      this.aiRunProgress = snapshot(lastChars, !result.ok && result.reason === 'truncated', result.ok ? 'done' : 'error');
      return result;
    } catch (error) {
      // 理论上 `callTreeBuilder` 不抛（它把失败都转成结构化结果），但这层不能因此挂着"进行中"
      this.aiRunProgress = snapshot(lastChars, false, 'error');
      throw error;
    } finally {
      if (this.aiBuildAbort === controller) this.aiBuildAbort = null;
    }
  }

  /**
   * **取消正在跑的 AI 建树**（FR-168，用户明确表态走这条）。
   *
   * 语义写清楚：
   * ① 中止**当前这一次模型调用**；分批时**剩下的片不再发起**（不是只取消当前片）；
   * ② 已经拿到的输出会被存成 partial 缓存（T9）⇒ 下次可续跑，**不白花**；
   * ③ 没有在跑时调用是**无害的**（返回 `cancelled: false`），不抛错。
   */
  cancelAiBuild(): { cancelled: boolean } {
    if (this.aiBuildAbort === null) return { cancelled: false };
    this.aiCancelRequested = true;
    this.aiBuildAbort.abort();
    return { cancelled: true };
  }

  /**
   * **按顶层目录分批建树**（大项目专用；分片口径与边界都在 `ai/shard.ts`）。
   *
   * ## 为什么不做"树合并"
   *
   * 落库本来就是**按身份键 upsert**（FR-158）：N 片依次 `applyAiTree` 天然等价于"合并后的树"。
   * 自己再写一个树合并器只会多一处能出错的地方，而且它要处理跨片同名/同路径冲突 ——
   * 那正是 FR-158 已经解决过的问题（重复实现 = 两套判据，迟早打架）。
   *
   * ## 三个必须守住的边界
   *
   * ① **`replaceAutoDraft` 只在第一片生效**：它清的是"没人动过的自动草稿"，
   *    如果每片都清，第二片会把第一片**刚建好的新节点**当草稿删掉（同一次建树内部自相残杀）；
   * ② **单片失败不放弃整轮**：如实写进 `failures` 继续下一片（部分成果比全灭有用）；
   *    但**一片都没成功**时必须如实返回失败 —— 不能让"分批"把失败伪装成成功；
   * ③ **不写整份树缓存**：缓存条目是"这份提示词 → 这棵树"的对应关系，
   *    分批路径没有这样一份产物；写进去会让下次命中一棵**不完整**的树（比慢更糟）。
   */
  private async aiBuildTreeSharded(input: {
    skeleton: ReadonlyArray<SkeletonEntry>;
    projectName: string;
    maxNodes: number;
    describeOnly?: readonly string[] | undefined;
    replaceAutoDraft: boolean;
    estimate: AiEstimate;
    route: AiRoute;
    /** 真正发给模型的上限（**只有用户设了闸门时才有**；跟随宿主时省略）。 */
    maxTokens?: number | undefined;
    /** 显示用的上限（可能来自宿主模型设置）；进度条靠它算比例。 */
    displayLimit?: number | undefined;
    agent?: unknown;
    callId?: string;
    stream?: LlmStreamLike;
    signal?: AbortSignal;
  }): Promise<
    | { status: 'ok'; shards: number; result: AiBuildTreeOk }
    | { status: 'fail'; shards: number; message: string }
  > {
    const shards = shardSkeleton(input.skeleton);
    if (shards.length <= 1) {
      return {
        status: 'fail',
        shards: shards.length,
        message: '按顶层目录只切得出 1 片，分批没有意义（不重复烧一遍同样的请求）。',
      };
    }
    const totalEntries = Math.max(1, input.skeleton.length);
    /**
     * **整轮的节点预算是 `maxNodes`，不是"每片各给一份"**。
     *
     * 不这么收的话，"最多 60 个节点"到了分批路径就变成 6 × 60 = 360 个 ——
     * 用户看到的承诺与实际能建的量对不上，而且每片都按 60 个要，输出照样会被上限截断。
     * 所以按**文件占比**分摊（纯比例，不引入任何"每节点多少 token"的猜测）：
     * 文件多的片分到的节点预算多。
     */
    const totalFiles = Math.max(
      1,
      input.skeleton.filter((entry) => entry.kind === 'file').length,
    );
    let created = 0;
    let updated = 0;
    let removed = 0;
    let proposed = 0;
    let calls = 0;
    let okShards = 0;
    let projectName = input.projectName;
    const failures: Array<{ name: string; reason: string }> = [];
    const notes: string[] = [
      `单次建树失败后改为**按顶层目录分批**（共 ${shards.length} 片），逐片建树并直接落库` +
        `（沿用同一套身份键 upsert 口径，不做树合并）。`,
    ];

    for (const [index, shard] of shards.entries()) {
      /**
       * **取消就停在当下**（FR-168）：已经从"用户明确表态"出发，不该再拿下一片去赌。
       * 已成功落库的片照常计入结果，只是剩下的不再发起调用。
       */
      if (this.aiCancelRequested) {
        notes.push(`已按用户请求取消：成功 ${okShards} 片后停止，剩下的 ${shards.length - index} 片未发起调用。`);
        break;
      }
      /**
       * **每片的节点上限按这一片的文件占比分摊整轮预算**：
       * 片里只有 9 个文件却要求它建 60 个节点，等于逼模型把模块拆成碎块（也会因此吐不完被截断）。
       * 下限给 4：小片（如只有 2 个文件的 docs）也该能拆出几个任务点。
       */
      const shardFiles = shard.entries.filter((entry) => entry.kind === 'file').length;
      const shardMaxNodes = Math.min(
        input.maxNodes,
        Math.max(4, Math.round((input.maxNodes * shardFiles) / totalFiles)),
      );
      const prompt = buildTreePrompt({
        projectName: input.projectName,
        skeleton: shard.entries,
        maxNodes: shardMaxNodes,
        ...(input.describeOnly !== undefined ? { describeOnly: input.describeOnly } : {}),
      });
      const call = await this.callTreeBuilderWithProgress(
        {
          ctx: this.ctx,
          route: input.route,
          system: AI_TREE_SYSTEM_PROMPT,
          user: prompt,
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.stream !== undefined ? { stream: input.stream } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        {
          mode: 'shard',
          shardIndex: index + 1,
          shardTotal: shards.length,
          ...(input.displayLimit !== undefined ? { displayLimit: input.displayLimit } : {}),
        },
      );
      calls += 1;
      /**
       * 这一轮的用量要**逐片记**：它是 N 次调用，不是一次。
       *
       * 没有提供方用量时按**条目占比**粗分：按片数均分会把"一小片"和"一大片"算成一个价。
       */
      const share = Math.max(1, Math.round((input.estimate.totalTokens * shard.entries.length) / totalEntries));
      const label = shard.rootDir === '' ? '(仓库根)' : shard.rootDir;

      if (!call.ok) {
        failures.push({ name: label, reason: call.message });
        await this.recordAiUsage({
          at: this.deps.clock.now(),
          scenario: 'tree',
          route: `${input.route.provider} / ${input.route.model}`,
          outcome: 'error',
          estimatedTokens: share,
          ...(call.usage !== undefined ? { usage: call.usage } : {}),
          usageSource: call.usage !== undefined ? 'provider' : 'estimate',
        });
        continue;
      }

      const applied = await this.applyAiTree(call.parsed.value, call.parsed.notes, {
        // ① 只有第一片清理阶段 A 草稿（见方法头注释）
        replaceAutoDraft: input.replaceAutoDraft && index === 0,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
      });
      okShards += 1;
      created += applied.created;
      updated += applied.updated;
      removed += applied.removed;
      proposed += call.parsed.value.nodes.length;
      if (applied.projectName !== '') projectName = applied.projectName;
      failures.push(...applied.failures);
      await this.recordAiUsage({
        at: this.deps.clock.now(),
        scenario: 'tree',
        route: `${input.route.provider} / ${input.route.model}`,
        outcome: 'ok',
        estimatedTokens: share,
        ...(call.usage !== undefined ? { usage: call.usage } : {}),
        usageSource: call.usage !== undefined ? 'provider' : 'estimate',
      });
    }

    if (okShards === 0) {
      return {
        status: 'fail',
        shards: shards.length,
        message: failures[0]?.reason ?? '每一片都没成功。',
      };
    }

    notes.push(`分批结果：成功 ${okShards}/${shards.length} 片；没成功的片已如实写进 failures。`);
    notes.push(
      '分批路径**不写整份树缓存**（没有"一份提示词对应一棵树"的产物），所以下次会重新调用模型 —— ' +
        '这是刻意的：宁可慢，也不要下次命中一棵不完整的树。',
    );
    return {
      status: 'ok',
      shards: shards.length,
      result: {
        status: 'ok',
        projectName,
        created,
        updated,
        removed,
        failures,
        notes,
        // 真实成本是 N 次调用：**调用次数如实改掉**，token 总量仍用同一份粗估
        estimate: { ...input.estimate, calls },
        proposed,
        cache: {
          state: 'miss',
          savedTokens: 0,
          changedPaths: { added: [], removed: [], changed: [] },
        },
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
    maxTokens: number | undefined,
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
      /**
       * **用骨架当输入指纹，而不是整份提示词的哈希**。
       *
       * 提示词里夹着"本轮只需给哪些节点补描述"这种**随树状态变化**的清单，
       * 若让它参与指纹，"某条描述被补上"就会把缓存打穿（实测：同骨架第二次建树从 hit 变 miss）。
       * 缓存该失效的判据只有一个：**仓库内容变了没有** —— 那是 `signatures`（路径 + 签名 + 大小）。
       */
      skeletonFingerprint: JSON.stringify(
        Object.entries(signatures)
          .map(([path, signature]) => `${path}:${String(signature)}`)
          .sort(),
      ),
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
      /**
       * 排除项三层叠加（顺序即优先级，都是"排除"）：
       * ① 通用排除（`node_modules` / `dist` / `lib` …）；
       * ② **建树专用范围**（FR-170：示例 / 测试 / 生成物 / 配置 —— 用户口径"仅主要代码就行"）；
       * ③ 用户自己配的 `scanExclude`（设置页那一项写着"叠加在内置排除项之上"，
       *    建树这条路径此前**没有**读它 —— 那条说明与实现不一致，一并修掉）。
       */
      exclude: [...DEFAULT_SCAN_EXCLUDE, ...AI_BUILD_EXCLUDE, ...(this.deps.config.scanExclude ?? [])],
      countLines: false,
    });
    const collected = await collectSkeleton({ root, entries: walked.entries });
    if (collected.unreadable.length > 0) {
      debugBus.warn('ai', `有 ${collected.unreadable.length} 个关键文件读不到签名（已如实跳过）`);
    }
    const projectName = walked.packageName ?? walked.rootDirName;
    /**
     * 估算用的提示词必须与**实际调用**的那份一致（T6：预估与实际不一致就是在骗人），
     * 所以这里同样带上"只需补描述的节点"清单。
     */
    const describeOnlyForEstimate = await this.planDescriptionTargets();
    const prompt = buildTreePrompt({
      projectName,
      skeleton: collected.skeleton,
      maxNodes,
      ...(collected.truncated ? { truncated: true } : {}),
      ...(walked.skipped > 0 ? { skipped: walked.skipped } : {}),
      ...(describeOnlyForEstimate !== undefined ? { describeOnly: describeOnlyForEstimate } : {}),
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
    options?: { replaceAutoDraft?: boolean; agent?: unknown; callId?: string },
  ): Promise<{
    projectName: string;
    created: number;
    updated: number;
    removed: number;
    failures: Array<{ name: string; reason: string }>;
    notes: string[];
    /** FR-158 ③：本轮标了 `stale` 的节点数（只标不删，等用户确认后清理）。 */
    staleMarked: number;
    /** 曾标过 `stale`、本轮又被提到因而撤销标记的节点数。 */
    staleCleared: number;
  }> {
    const notes: string[] = [];
    const { graph, derived } = await this.derive();
    const failures: Array<{ name: string; reason: string }> = [];
    /**
     * 本轮会被 AI 覆盖的、**人改过优先级的**节点（循环里收集，循环后一次性审核）。
     * 逐节点弹窗是不可接受的打扰 —— 见循环末尾那段说明。
     */
    const pendingPriorityOverwrites: Array<{ nodeId: string; name: string; priority: number }> = [];
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
    /**
     * **本轮"提到过"的判据：名字 + 身份键 + 引用路径**（FR-158）。
     *
     * 为什么三样都要收：下面"清自动草稿"要判"这条枝本轮是不是没再被提到"，
     * 而复用层（`findReusableNode`：身份 → 同名 → 引用重叠）判的是**同一件事**。
     * **两处各判一套就是 bug**（2026-09-25 补 e2e 时抓到）：
     * 模型**换了说法**重提同一批路径（`{a,b}` → `{a}`）时，清理只比名字 ⇒ 先把这条枝当草稿删掉，
     * 复用层再找不到它 ⇒ 这一轮的工作**整枝丢掉**、下一轮又建回来（节点数来回抖，
     * 正是用户那句"节点一直在变、进度推不动"）。
     * e2e「同父下已有 `{a,b}` 的枝，再提 `{a}` ⇒ 必须复用而不是新建」第一次跑就红在这里，
     * 所以这份判据**只留一处**：清理与复用都从这里读。
     */
    const proposedNames = new Set<string>();
    const proposedIdentities = new Set<string>();
    const proposedTokens: string[][] = [];
    for (const proposed of tree.nodes) {
      proposedNames.add(proposed.name);
      proposedIdentities.add(identityKeyOf({ name: proposed.name, refs: proposed.refs }));
      const tokens = refTokensOf({ refs: proposed.refs });
      if (tokens.length > 0) proposedTokens.push(tokens);
    }
    /**
     * 某个既有节点本轮**有没有被提到**（判据与复用层同一口径）。
     *
     * ⚠️ **只对"上次 AI 建出的树"（`weightSource === 'ai'`）用**：阶段 A 的目录/关键文件骨架
     * 是被整体改写的对象，"引路径重叠"在那里不算"提到过"（见下面清理循环里的分档说明）。
     *
     * 判据方向刻意**偏保守**：只要名字、身份键、引用路径任一条对得上就算"提到过" ⇒
     * 结果只会是"少删几个空壳"，绝不会是"删掉本轮刚要复用的那条枝"。
     */
    const mentionedThisRound = (node: NodeRecord): boolean => {
      if (proposedNames.has(node.name)) return true;
      const identity =
        node.identity !== undefined && node.identity !== ''
          ? node.identity
          : identityKeyOf({ name: node.name, refs: node.refs });
      if (proposedIdentities.has(identity)) return true;
      const tokens = refTokensOf({ refs: node.refs });
      if (tokens.length === 0) return false;
      return proposedTokens.some((proposal) => proposal.some((token) => tokens.includes(token)));
    };

    if (options?.replaceAutoDraft !== false) {
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
             * **这次模型仍然提到过的节点不算草稿**（它们会被下面"身份 / 同名 / 引用重叠"那层接住并复用）。
             *
             * 判据**按节点的出身分两档**，这不是两套判据，而是"提到过"在两种东西上意思不同：
             *
             * - **上次 AI 建出的功能树**（`weightSource === 'ai'`）：模型**换了说法**重提同一批路径
             *   = 同一个功能点改名 ⇒ 用 `mentionedThisRound`（名字 + 身份 + 引用路径，与复用层同一口径）。
             *   只比名字的后果实测过：这条枝先被当草稿删掉，复用层再找不到它，**本轮整枝的工作丢掉**、
             *   下一轮又建回来（节点数来回抖）。e2e「同父下已有 `{a,b}`，再提 `{a}`」第一版就红在这里。
             * - **阶段 A 的目录/关键文件骨架**（`autoCreated`，没有 AI 权重）：它是被阶段 B **整体改写**的
             *   对象（§6.4b）——"引路径重叠"在这里**不代表**"模型重提了这个节点"，恰恰相反：
             *   AI 的功能树覆盖同一批代码正是它该被替换的理由。所以这一档只认**名字**
             *   （实测：把引用重叠也算进去之后，"阶段 A 草稿应被清掉"那条老测试立刻红 —— 它是对的）。
             */
            if (node.weightSource === 'ai') {
              if (mentionedThisRound(node)) return false;
            } else if (proposedNames.has(node.name)) {
              return false;
            }
            // 阶段 A 的目录骨架，或上次 AI 建出的树（两者都是"自动生成"）
            return node.autoCreated === true || node.weightSource === 'ai';
          })
          .map((node) => node.id),
      );
      /**
       * **整枝保护**：子树里只要有一个"动过"的活节点，这条枝就不许当草稿删。
       *
       * 为什么必须有：下面的删除是**整枝**（`mutateRemove` 连子孙一起走），而"没人动过"是
       * **逐节点**判的 ⇒ 一个 pending、进度 0、无门控的父节点，完全可以带着一个**报过进度**的子节点
       * 一起被删掉。那句"有过进度 / 状态 / 门控的一律保留"（本函数上面自己写的承诺）就成了一句谎话。
       * 保留优先于收缩：多留一个空壳只是难看，少一个报过进度的节点是**埋掉人的劳动**。
       */
      const childrenOfAll = new Map<string, string[]>();
      for (const node of Object.values(workingGraph.nodes)) {
        if (node.parentId === null) continue;
        const bucket = childrenOfAll.get(node.parentId);
        if (bucket === undefined) childrenOfAll.set(node.parentId, [node.id]);
        else bucket.push(node.id);
      }
      const subtreeIsAllDraft = (rootId: string): boolean => {
        const stack = [rootId];
        const seen = new Set<string>();
        while (stack.length > 0) {
          const current = stack.pop() as string;
          if (seen.has(current)) continue;
          seen.add(current);
          const state = derived.nodes.get(current);
          if (state !== undefined && state.derivedState === 'removed') continue;
          if (current !== rootId && !untouchedAuto.has(current)) return false;
          stack.push(...(childrenOfAll.get(current) ?? []));
        }
        return true;
      };
      // 只删"最上层"的那些（子孙跟着整枝走），且整枝都是草稿
      const topCandidates = [...untouchedAuto].filter((id) => {
        const parentId = workingGraph.nodes[id]?.parentId ?? null;
        return parentId === null || !untouchedAuto.has(parentId);
      });
      const topmost = topCandidates.filter((id) => subtreeIsAllDraft(id));
      const keptForWork = topCandidates.length - topmost.length;
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
      if (keptForWork > 0) {
        notes.push(
          `另有 ${keptForWork} 个"没人动过"的自动枝**没清**：它们的子树里还有动过的节点` +
            '—— 删除是整枝的，会连带埋掉那些（保留优先于收缩，只删记录那套不适用这里）',
        );
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
    /**
     * **本轮某个身份键已经被哪个节点占住**（FR-158 ⑤：提案 ↔ 提案 的去重）。
     *
     * 与 `usedIds` 的区别：`usedIds` 是"既有节点只能被认领一次"，而这张表还要把
     * **本轮新建/复用的结果**记下来，好让后面那些"引用相同"的提案并进同一个节点
     * —— 少了它，同一轮里重复的分支就会各自新建（实测：5 棵 refs 全为 `src/ai` 的分支）。
     */
    const claimedKeyToId = new Map<string, string>();
    /**
     * 本轮树里提出过的**身份键**与**名称**（FR-158 ③：判断"某个旧节点本轮是不是没再被提到"）。
     *
     * 两者在函数开头就收了（`proposedIdentities` / `proposedNames`）—— 因为**草稿清理**也要用
     * 同一份判据，早先这里另外收一份、只比名字，两套判据当场就打起来了（见函数开头那段说明）。
     */
    let reused = 0;
    const reusedNames: string[] = [];
    /**
     * 既有活节点（FR-158 ③ 的 stale 处理与"回归撤销"都要用）。
     *
     * 刻意在循环**之前**建好：循环内的"新建分支"也要查它（同名回归要撤销老标记），
     * 放在循环后面会踩 TDZ。
     */
    const liveNodesForStale = Object.values(graph.nodes).filter(
      (candidate) => derived.nodes.get(candidate.id)?.derivedState !== 'removed',
    );
    /** FR-158 ③ 的计数与名单（循环内与收尾都要用，所以在这里先声明）。 */
    let staleMarked = 0;
    let staleCleared = 0;
    const staleNames: string[] = [];
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

    /**
     * 既有节点的**身份键索引**（FR-158）。
     *
     * 只收已登记的 `identity`：没有登记的老节点不在这里"现算身份"——
     * 现算会把 `weight` 这类非功能点节点按目录路径误配成功能点。
     * 它们的身份在**首次被复用时补录**（见下面的 reuseKey），第二次建树起就能按身份认了。
     */
    const identityByNodeId = new Map<string, string>();
    for (const candidate of Object.values(graph.nodes)) {
      if (derived.nodes.get(candidate.id)?.derivedState === 'removed') continue;
      if (candidate.identity !== undefined && candidate.identity !== '') {
        identityByNodeId.set(candidate.id, candidate.identity);
      }
    }
    /** 身份键 → 既有节点（首个命中者）。 */
    const identityIndex = new Map<string, NodeRecord>();
    for (const candidate of Object.values(graph.nodes)) {
      if (derived.nodes.get(candidate.id)?.derivedState === 'removed') continue;
      const key = identityByNodeId.get(candidate.id);
      if (key !== undefined && !identityIndex.has(key)) identityIndex.set(key, candidate);
    }

    for (const [index, node] of tree.nodes.entries()) {
      const reuseKey = identityKeyOf({ name: node.name, refs: node.refs });
      /**
       * **同一轮里"引用相同"的提案必须并进同一个节点**（FR-158 ⑤，本条是"重复分支"的真凶修法）。
       *
       * 实测现场：树上有 **5 棵 refs 全是 `src/ai` 的分支**（`AI 建树与推理` / `AI 驱动建树` /
       * `AI 辅助建树` / `AI 建树能力` / `AI 解析与建树`），外加两条 refs 全是 `src/ai/prompt.ts`
       * 的叶子（`建树提示词编排` / `建树提示词组织`）。
       *
       * 根因**不是**身份匹配没写，而是它只做了一半：`findReusableNode` 会把提案匹配到**既有**节点，
       * 但 `claimedIds` 又规定"一个既有节点只能被认领一次" —— 于是**同一次建树里**模型提出的
       * 第 2、3 个同引用提案找不到可认领对象，就被**当成新节点建了出来**。
       * 换句话说：去重只做了"提案 ↔ 既有"，漏了"**提案 ↔ 提案**"。
       *
       * 现在的判据：身份键（`refs` 派生）在本轮已经被某个节点占住 ⇒ **这一支并进去**，
       * 记一条 note 说明并到谁身上，然后不再新建。模型"换个说法再提一次"是常态，
       * 靠这一条才能真正收敛（用户口径："让建树认领既有分支"）。
       */
      const claimedEarlier = claimedKeyToId.get(reuseKey);
      if (claimedEarlier !== undefined) {
        idByIndex[index] = claimedEarlier;
        usedIds.add(claimedEarlier);
        notes.push(
          `「${node.name}」与「${workingGraph.nodes[claimedEarlier]?.name ?? claimedEarlier}」引用相同` +
            `（${reuseKey}）：并进同一个节点，本支不再新建。`,
        );
        continue;
      }
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
      /**
       * ── 复用既有节点：**先按身份键，再按同父同名**（FR-158，本轮才真正接线） ──────────
       *
       * ⚠️ **这里曾经漏接了身份匹配**：`domain/identity.ts::findReusableNode` 写好了却**没有任何调用方**，
       * 于是建树实际只按"同父 + 同名"匹配 ⇒ 模型换个说法（`领域模型与进度计算` → `项目扫描与领域模型`）
       * 就长出一个**新节点**，旧节点留着 ⇒ 节点只增不减、分母被灌水、进度推不动。
       * 这正是用户最初那个痛点的真正病根（此前只修了"同名复用"这一半）。
       *
       * 现在的判据顺序（命中即止）：
       * 1. **身份键相同**（`refs` 路径派生）→ 复用，并顺手补登记 `identity`（存量树靠这一步收敛）；
       * 2. **同父同名** → 复用（老的兜底路径）；
       * 3. 都不中 ⇒ 下面按"同名全树复用"或新建处理。
       */
      const identityOfNode = (id: string): string => identityByNodeId.get(id) ?? '';
      const claimedIdentity = (key: string): boolean => {
        for (const id of usedIds) if (identityOfNode(id) === key) return true;
        return false;
      };
      const existingById = new Map<string, IdentityNode>();
      for (const candidate of Object.values(graph.nodes)) {
        if (derived.nodes.get(candidate.id)?.derivedState === 'removed') continue;
        existingById.set(candidate.id, {
          id: candidate.id,
          name: candidate.name,
          parentId: candidate.parentId,
          ...(candidate.refs !== undefined ? { refs: candidate.refs } : {}),
          ...(candidate.identity !== undefined ? { identity: candidate.identity } : {}),
        });
      }
      const match = findReusableNode({
        name: node.name,
        ...(node.refs !== undefined ? { refs: node.refs } : {}),
        existingById,
        claimedIds: usedIds,
        identityOf: identityOfNode,
        hasLiveRoot: rootId !== undefined,
        /**
         * 引用路径读取器：给"目录改名/移动"兜底（身份键是**整串路径集合**的指纹，改名后整体变掉）。
         * 排在**同名之后** —— 同名是更强的语义信号，不能反过来。
         */
        refsOf: (id) => refTokensOf({ refs: existingById.get(id)?.refs }),
      });
      /**
       * ── 这里曾有一支"**并列副本预防**"（批次 64 加、批次 74 删）────────────────────────
       *
       * 原意：上面三层只回答"提案 ↔ **既有节点**"，所以模型把同一批路径挂到**同一个父**下时会各建一份
       * （真机后果：一棵树下五个 `refs=src/ai` 的并排分支）。于是补了一层"同父下已有 refs 互为子集的
       * 活节点 ⇒ 复用"。
       *
       * **删掉的理由：它结构上不可达。** 上面第 ③ 层（`findReusableNode` 的"引用路径有重叠就复用"）
       * 是**全树**扫的，而"互为子集"必然"有交集"，两层的"未被认领"守卫又是同一个 `usedIds`
       * ⇒ 只要这一支能命中，第 ③ 层早就命中了（甚至可能命中别的节点，那时 `match` 已有值，这一支照样不跑）。
       * 批次 74 补 e2e 时确认：`{a,b}` → `{a}` 这个形状就是第 ③ 层接住的。
       *
       * 留一个"看起来在保护、实际永不触发"的判据，正是本项目最忌讳的坑（"实现了但不生效"），
       * 所以直接删。**别再把它当兜底**：真要收紧第 ③ 层的宽口径（它对跨父也生效），
       * 那是改第 ③ 层本身，而不是在这里并排再写一套判据。
       */
      const existing: NodeRecord | undefined =
        match === undefined ? undefined : graph.nodes[match.id];

      if (existing !== undefined) {
        idByIndex[index] = existing.id;
        updated += 1;
        usedIds.add(existing.id);
        // 认领既有节点后也要占住这个身份键（FR-158 ⑤），否则同一轮后面的同引用提案会另起一枝
        claimedKeyToId.set(reuseKey, existing.id);
        const structural: string[] = [];
        /**
         * **换名 / 挂父**：身份相同 ⇒ 就是同一个功能点，模型这次的说法与位置应当接受。
         *
         * 不这么做的后果（实测推演过）：复用 A 却留着名字 A，下次模型再提新名 B 又匹配不上
         * ⇒ 又新建一个 B ⇒ 节点照样增长。"身份相同就跟着改名"才是收敛的关键一步。
         * 挂父前查环：绝不能把一个节点挂到自己的子孙下面（那会把树撕成环）。
         */
        const subtree = subtreeIds(derived.index, existing.id);
        if (
          existing.parentId !== parentId &&
          parentId !== existing.id &&
          (parentId === null || !subtree.includes(parentId))
        ) {
          structural.push('parentId');
        }
        if (existing.name !== node.name) structural.push('name');
        if (structural.length > 0) {
          /**
           * 改名与挂父走**两个不同的内核**：`patchNode` 管字段（`PatchFields` 里**没有** `parentId`，
           * 硬塞进去会被静默忽略 —— 所以这里绝不能图省事塞一个 `parentId`），
           * 父子关系必须走 `reparentSubtree`（它带重复枝/成环保护与自己的审计记录）。
           */
          if (structural.includes('name')) {
            const renamed = await this.patchNode({
              nodeId: existing.id,
              patch: { name: node.name },
              by: 'user',
              reason: '按身份复用并按本轮改名 —— FR-158：同一功能点只该有一个节点',
            });
            if (renamed.status !== 'ok') {
              notes.push(
                `「${existing.name}」按身份复用成功，但改名为「${node.name}」被拒（${
                  'message' in renamed && typeof renamed.message === 'string' ? renamed.message : renamed.status
                }），仍叫原名`,
              );
            }
          }
          if (structural.includes('parentId')) {
            const moved = await this.reparentSubtree({
              nodeId: existing.id,
              parentId,
              by: 'user',
              reason: '按身份复用并按本轮挂点 —— FR-158：结构变化跟着模型走，但不新建节点',
            });
            if (moved.status !== 'ok') {
              notes.push(
                `「${node.name}」按身份复用成功，但挂到新父节点被拒（${
                  'message' in moved && typeof moved.message === 'string' ? moved.message : moved.status
                }），保持在原位置`,
              );
            }
          }
        }
        if (match?.note !== undefined) notes.push(match.note);
        /**
         * **给已存在的节点补/刷描述 —— 但要省 token**（用户口径："修剪树时已有简述和简报的
         * 不必再次要求 AI 生成…省 token" + "未完成的如果某些会话动了节点功能是需要刷新描述的"）。
         *
         * 四档判据，只有"该写"的才写：
         * ① **已完成**（`done`）⇒ **跳过**：它的描述是**完成简报**（会话/人在收尾时改写的），
         *    AI 不许拿任务简述盖掉简报；
         * ② **没有描述** ⇒ 补上（建树/同步时顺手补全，树才越用越有信息量）；
         * ③ **有描述且没变旧**（`descriptionUpdatedAt` 不早于节点 `updatedAt`）⇒ **跳过**：
         *    描述还有效，重新生成纯属浪费 token（这是省 token 的主要来源）；
         * ④ **有描述但已变旧**（节点在描述写入之后又被改动过）⇒ **刷新**：
         *    用户说的"某些会话动了节点功能是需要刷新描述的"就是这一档。
         *
         * 判据用 `descriptionUpdatedAt` 而**不是** `updatedAt` 自己跟自己比 ——
         * 后者任何一次进度写入都会刷新，会把"报过一次进度"误判成"功能变了"（见 `mutatePatch` 的说明）。
         */
        if (node.description !== undefined && derived.nodes.get(existing.id)?.derivedState !== 'done') {
          const had = (existing.description ?? '').trim();
          const writtenAt = Date.parse(existing.descriptionUpdatedAt ?? '');
          const changedAt = Date.parse(existing.updatedAt);
          /** 描述是否"变旧"：写描述**之后**节点又被改过（时间戳都可信时才算）。 */
          const staleDescription =
            had !== '' &&
            Number.isFinite(writtenAt) &&
            Number.isFinite(changedAt) &&
            writtenAt < changedAt &&
            had !== node.description;
          if (had === '' || staleDescription) {
            const described = await this.patchNode({
              nodeId: existing.id,
              patch: { description: node.description },
              by: 'user',
              reason:
                had === ''
                  ? '建树时补充描述（原本没有；已完成节点不补，那是简报）'
                  : '描述已过时（写描述之后功能又被改动），按本轮刷新',
            });
            if (described.status === 'ok') {
              notes.push(had === '' ? `「${node.name}」补上了描述` : `「${node.name}」描述已刷新（功能有改动）`);
            }
          }
        }
        /**
         * **匹配即补录身份键**（FR-158）：老节点还没有 `identity` 就顺手登记，
         * 下次建树它就能按 `refs` 被认出来 —— 存量树靠这一步逐步收敛。
         * 只补空、不改已有值：身份一旦固定就不该被后续的 `refs` 漂移改写（否则认领链会断）。
         */
        if (!identityByNodeId.has(existing.id)) {
          const marked = await this.patchNode({
            nodeId: existing.id,
            patch: { identity: reuseKey },
            by: 'user',
            reason: '补登记稳定身份键（FR-158：建树幂等，存量树收敛）',
          });
          if (marked.status === 'ok') {
            identityByNodeId.set(existing.id, reuseKey);
          } else {
            notes.push(`「${node.name}」身份键未登记（${marked.status}），本次仍按名字复用`);
          }
        }
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
        // 全树同名复用同样要占住身份键（FR-158 ⑤），否则同轮后面的同引用提案会另起一枝
        claimedKeyToId.set(reuseKey, sameName.id);
        reused += 1;
        reusedNames.push(node.name);
      } else {
        const added = await this.addNode({
          parentId,
          name: node.name,
          kind: node.kind,
          autoCreated: true,
          by: 'user',
          // 新节点一开始就带稳定身份键（FR-158）：下次建树按 `refs` 认它，模型换名字也不会再建一个
          identity: reuseKey,
          ...(node.refs.length > 0 ? { refs: node.refs } : {}),
          /**
           * **AI 给的描述直接写进 `description`**（用户诉求："AI 建树/修剪树/同步树时直接补充描述信息"）。
           *
           * **不做 `note` 回落**：`note` 的本义是"我凭什么这么判断"，它只留在 `weightDetail` 里供追溯。
           * 早先两者混用（`note` 被当成描述写进节点），于是节点描述里全是判断依据、
           * 而不是"这块要做什么" —— 语义一旦混过就再也分不开，宁可空着。
           */
          ...(node.description !== undefined ? { description: node.description } : {}),
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
          // 记下"这个身份键已经被它占了"（FR-158 ⑤）：后面同引用的提案并进它，不再新建
          claimedKeyToId.set(reuseKey, added.nodeId);
          created += 1;
          /**
           * FR-158 ③ 的"回归"路径：本轮**新建**的节点如果与某个带 `stale` 的老节点同名，
           * 说明那个功能点又回来了 —— 必须把老标记撤销，否则界面上会同时挂着一个"疑似遗留"和一个新节点，
           * 用户看到的是"它又要走、又刚来"这种自相矛盾的状态。
           */
          const revived = liveNodesForStale.find(
            (candidate) => candidate.stale === true && candidate.name === node.name,
          );
          if (revived !== undefined) {
            const cleared = await this.patchNode({
              nodeId: revived.id,
              patch: { stale: false },
              by: 'user',
              reason: '本轮建树又提到了这个节点（按名字回归），撤销 stale 标记（FR-158 ③）',
            });
            if (cleared.status === 'ok') staleCleared += 1;
          }
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
      /**
       * **优先级初判**（用户诉求："优先级针对未完成的排序，优先做哪个"）。
       *
       * 两条纪律：
       * ① **人改过的不许覆盖**（`prioritySource === 'user'`）—— 与进度、权重同一个优先级口径：
       *    模型只能填"人还没表过态"的地方；
       * ② **已完成的节点不写** —— 优先级只服务"未完成里先做哪个"，给已完成节点标级没有意义，
       *    只会让界面多出一堆永远用不上的数字。
       */
      if (nodeId !== null && node.priority !== undefined) {
        const current = await this.nodeView(nodeId);
        if (current !== undefined && current.derivedState !== 'done') {
          /**
           * **人改过的优先级：允许 AI 覆盖，但必须过一次 ask 审核**（用户口径：
           * "人改过的节点可以被AI覆盖，需要项目进度审核权限(ask弹窗)"）。
           *
           * 这三者的差别很重要：
           * - 人**没**表过态 ⇒ 直接写（AI 初判本来就是干这个的）；
           * - 人**改过** ⇒ 先收集，循环走完**一次性**弹窗（逐节点弹窗会烦死人），
           *   批准才覆盖、拒绝就保留人的值并如实记进 notes；
           * - 通道不可用（无应答者 / 策略 never）⇒ `authorize` 返回拒绝 ⇒ 同样保留人的值，
           *   **fail-closed**，绝不静默覆盖。
           */
          if (current.prioritySource === 'user') {
            pendingPriorityOverwrites.push({ nodeId, name: node.name, priority: node.priority });
          } else {
            const marked = await this.patchNode({
              nodeId,
              patch: { priority: node.priority, prioritySource: 'ai' },
              by: 'user',
              reason: 'AI 建树时的优先级初判（未完成的先做哪个；人没表过态）',
            });
            if (marked.status === 'ok') {
              notes.push(`「${node.name}」优先级初判 ${node.priority}（1 最高，来源：AI）`);
            }
          }
        }
      }
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

    /**
     * ── FR-158 ③：**本轮建树没再提到的自动节点 → 记 `stale`，不删** ───────────────
     *
     * ## 为什么需要这一步（这是用户最初那个痛点的最后一块）
     *
     * 上面的"自动草稿清理"只覆盖**没人动过**的节点（`pending` + 进度 0 + 无门控）。
     * 凡是**报过一次进度**的旧自动节点就永久保留 —— 于是每跑一次建树，
     * 模型换个说法长出一批新节点、旧的又删不掉 ⇒ **只增不减、分母被灌水**
     * （用户原话："节点一直在变化…进度就无法推进甚至越来越小"）。
     *
     * 但也不能直接删：那些节点上有**人报过的进度**，自动删就是埋掉人的劳动。
     * 所以口径是 **标记 + 等用户确认**：`stale` 只是"疑似该走了"，**照常计入统计、照常参与进度**。
     *
     * ## 判据（保守）
     *
     * 同时满足才标：① 是自动生成的（`autoCreated`）；② **本轮没被认领**（`usedIds` 之外）；
     * ③ 状态已被推进（非 `pending` 或进度 > 0 —— 否则它早被上面的草稿清理删掉了）。
     * 另外：按**身份键**与**名称**双重判断"本轮是否真的没再提到"，两者有一个命中就不标。
     */
    for (const candidate of liveNodesForStale) {
      // ③ 被再次认领/复用 ⇒ 它又出现了，撤销 stale（"回来了就不算遗留"）
      if (usedIds.has(candidate.id)) {
        if (candidate.stale !== true) continue;
        const cleared = await this.patchNode({
          nodeId: candidate.id,
          patch: { stale: false },
          by: 'user',
          reason: '本轮建树又提到了这个节点，撤销 stale 标记（FR-158 ③）',
        });
        if (cleared.status === 'ok') staleCleared += 1;
        continue;
      }
      // ② 本轮没被认领才算"遗留"
      if (candidate.autoCreated !== true) continue;
      const state = derived.nodes.get(candidate.id);
      // ③ 没被推进过的自动节点归"草稿清理"管（上面已删），这里只处理"有人动过、删不掉"的那批
      if (state === undefined || (candidate.selfState === 'pending' && state.progress === 0)) continue;
      if (candidate.stale === true) continue;
      // 双重判断：按身份键（老节点没登记就现算）**或**按名字，只要命中就说明"本轮其实还提到了它"
      const key = keyOfExisting(candidate);
      if (proposedIdentities.has(key) || proposedNames.has(candidate.name)) continue;
      const marked = await this.patchNode({
        nodeId: candidate.id,
        patch: { stale: true },
        by: 'user',
        reason: '本轮建树没再提到这个自动节点：记 stale 等确认（FR-158 ③，不静默删除）',
      });
      if (marked.status === 'ok') {
        staleMarked += 1;
        if (staleNames.length < 20) staleNames.push(candidate.name);
      }
    }

    /**
     * ── **人改过的优先级：一次性 ask 审核后才覆盖**（用户口径见循环内那段说明）────
     *
     * 放在循环**之后**是刻意的：逐节点 `authorize` 会给用户弹 N 次窗（243 个节点的树不可用）。
     * 一次弹窗覆盖整批，拒绝时**全部保留**人的值 —— 半覆盖比不覆盖更难解释。
     */
    if (pendingPriorityOverwrites.length > 0) {
      const authorized = await this.authorize({
        action: 'ai-build-priority-overwrite',
        toolName: 'panel:ai-build',
        reason: `AI 建树想覆盖 ${pendingPriorityOverwrites.length} 个节点的优先级（这些是你手动改过的）：${pendingPriorityOverwrites
          .slice(0, 5)
          .map((item) => `「${item.name}」→${item.priority}`)
          .join('、')}${pendingPriorityOverwrites.length > 5 ? ' 等' : ''}`,
        agent: options?.agent,
        callId: options?.callId,
      });
      if (!authorized.ok) {
        notes.push(
          `有 ${pendingPriorityOverwrites.length} 个节点的优先级是**你手动改过的**，` +
            `本次 AI 建树想覆盖但未获授权（${authorized.message}）⇒ 已全部保留你的值`,
        );
      } else {
        let overwritten = 0;
        for (const item of pendingPriorityOverwrites) {
          const marked = await this.patchNode({
            nodeId: item.nodeId,
            patch: { priority: item.priority, prioritySource: 'ai' },
            by: 'user',
            reason: 'AI 建树覆盖优先级（已经人工审核授权）',
          });
          if (marked.status === 'ok') overwritten += 1;
        }
        notes.push(
          `已按审核授权覆盖 ${overwritten} 个**你手动改过**的节点优先级` +
            `（${pendingPriorityOverwrites.slice(0, 5).map((item) => `「${item.name}」→${item.priority}`).join('、')}` +
            `${pendingPriorityOverwrites.length > 5 ? ' 等' : ''}）；来源重新标为 AI`,
        );
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
      staleMarked,
      staleCleared,
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
        /**
         * FR-158 ③ 的如实交代：标了哪些、影响是什么、怎么处理。
         * **必须说清"还照常计入统计"** —— 否则用户会以为分母已经变小了。
         */
        ...(staleMarked > 0
          ? [
              `有 ${staleMarked} 个自动建的节点本轮没再被提到（${staleNames.slice(0, 5).join('、')}${
                staleNames.length > 5 ? ' 等' : ''
              }），已标为「疑似遗留」而不是直接删除 —— 它们上面可能有已报过的进度。` +
                '这些节点**照常计入统计**；确认确实不用了，再右键删除（看板与属性栏都会标出来）',
            ]
          : []),
        ...(staleCleared > 0
          ? [`有 ${staleCleared} 个曾标为「疑似遗留」的节点本轮又被提到，已撤销标记`]
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
  /**
   * **会话忙闲记账**（由 `src/index.ts` 的 `agent/status` / `agent/disposed` 调用）。
   *
   * `running` = 这个会话开始干活；`idle` = 一次回合结束；`disposed` = 会话结束。
   * 看板据此告诉客户端"有没有人在跑"，好让进行中的图标在**会话真的在跑**时转圈，
   * 而不是只靠节点自己的 `updatedAt` 窗口去猜（那会漏掉"会话在跑但没写节点"的情形）。
   */
  noteSessionActivity(sessionId: string, status: 'running' | 'idle' | 'disposed' | string): void {
    if (sessionId === '') return;
    if (status === 'disposed') {
      this.busySessions.delete(sessionId);
      return;
    }
    if (status === 'running') {
      this.busySessions.set(sessionId, this.deps.clock.now());
      return;
    }
    if (status === 'idle') {
      // 回合结束 = 这一刻没在跑；不进 `busySessions` 即可（保留旧值会让它一直"忙"）
      this.busySessions.delete(sessionId);
    }
  }

  /** 当前正在真干活的会话 id（看板用；超过 5 分钟没有新信号视为失联、不再算忙）。 */
  private async busySessionIdList(): Promise<string[]> {
    const now = Date.parse(this.deps.clock.now());
    const busy: string[] = [];
    for (const [id, at] of this.busySessions) {
      const stamp = Date.parse(at);
      if (Number.isFinite(stamp) && Number.isFinite(now) && now - stamp <= BUSY_SESSION_TTL_MS) busy.push(id);
    }
    /**
     * **兜底：主动问一次 agent 的实时状态**。
     *
     * 实测问题："当前正在运行会话，流程图上却没有 loading" —— 靠 `agent/status` 事件记账会漏
     * （事件带 scope 过滤、时序也可能错过），而 agent 对象上就有 `status`。
     * 这里把**树上出现过的会话**（节点 `lastSessionId` / 订阅 `actorId`）逐个问一遍：
     * 谁在 running 就补进去。**拉取不依赖事件送达**，所以能兜住事件漏掉的情况。
     */
    const known = new Set<string>(busy);
    try {
      const graph = await this.readGraph();
      for (const node of Object.values(graph.nodes)) {
        if (node.lastSessionId !== undefined) known.add(node.lastSessionId);
        for (const binding of node.bindings ?? []) {
          if (binding.actor === 'session') known.add(binding.actorId);
        }
      }
    } catch {
      // 读不到图就只用事件记账的结果（保守，不抛）
    }
    for (const id of known) {
      if (busy.includes(id)) continue;
      if (this.sessionStatusOf(id) === 'running') busy.push(id);
    }
    return busy;
  }

  /** 待确认删除的发起方（取不到会话 id 就如实记 `session:unknown`，不猜）。 */
  private pendingRemovalOrigin(agent: unknown): string {
    if (agent !== null && typeof agent === 'object') {
      const record = agent as { sessionId?: unknown; id?: unknown };
      const id =
        typeof record.sessionId === 'string'
          ? record.sessionId
          : typeof record.id === 'string'
            ? record.id
            : undefined;
      if (id !== undefined && id !== '') return `session:${id}`;
    }
    return 'session:unknown';
  }

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
  /**
   * **改父节点**（会话工具 `pm_move` 与面板拖拽共用的对外入口）。
   *
   * 只把 `reparentSubtree` 暴露出来，**不在这里重写判据**：
   * 成环保护、重复枝检查、审计记录都在领域层（`mutateReparent`）里，两处各写一遍迟早打架。
   * 用户口径："拖动能力 AI 有也就是你有就行了" —— 会话侧需要一个**能修树**的工具，
   * 而不是让人一个个手拖（重复分支这种活儿，判断依据在数据里，不在手感里）。
   */
  async reparentNode(input: {
    nodeId: string;
    parentId: string | null;
    reason?: string;
    /** 调用方来源（`callerOf` 会给 `session` / `subagent` / `user`）。 */
    by?: 'user' | 'session' | 'subagent';
    actorId?: string;
  }): Promise<ApplyResult> {
    return this.reparentSubtree({
      nodeId: input.nodeId,
      parentId: input.parentId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      // 领域层只区分"人/会话"两类来源；子代理按会话记（它就是会话派出去的活）
      ...(input.by !== undefined ? { by: input.by === 'user' ? ('user' as const) : ('session' as const) } : {}),
    });
  }

  /**
   * **审查通过的级联清理**（FR-164 的"遗传"）：清掉该节点**及其整枝**的待审标记。
   *
   * 为什么必须级联：用户口径是"父节点审查了，通审整枝"。只清自己会留下
   * "父审过了、子还在待审"的自相矛盾状态 —— 而且取任务时那些子节点还会挡在最前面。
   *
   * 面板右键（`clear-review`）与会话工具（`pm_review pass`）**共用这一份**实现。
   */
  async clearReviewFlags(input: { nodeId: string; by?: 'user' | 'session' }): Promise<{
    cleared: number;
    failed: string[];
    subtree: number;
  }> {
    const { graph, derived } = await this.derive();
    const subtree = subtreeIds(derived.index, input.nodeId);
    let cleared = 0;
    const failed: string[] = [];
    for (const id of subtree) {
      if (graph.nodes[id]?.needsReview !== true) continue;
      const done = await this.patchNode({
        nodeId: id,
        patch: { needsReview: false },
        by: input.by ?? 'user',
        reason:
          id === input.nodeId
            ? '审查通过（FR-164）'
            : '父节点审查通过 ⇒ 整枝视为已审（FR-164 遗传）',
      });
      if (done.status === 'ok') cleared += 1;
      else failed.push(id);
    }
    return { cleared, failed, subtree: subtree.length };
  }

  /**
   * **待审查队列**（FR-164）：供会话工具 `pm_review list` 与界面读取。
   *
   * 按 `nextTask` 的口径排序（待审 > 关注 > 优先级 > 进度），但**不筛掉有子节点的枝** ——
   * 审查常常是针对一整块的（用户可以标一个功能点，让它整枝进入待审视野）。
   */
  async reviewQueue(): Promise<
    Array<{ id: string; name: string; derivedState: string; progress: number; refs: Array<{ type: string; target: string }> }>
  > {
    const { graph, derived } = await this.derive();
    const out: Array<{
      id: string;
      name: string;
      derivedState: string;
      progress: number;
      refs: Array<{ type: string; target: string }>;
    }> = [];
    for (const node of Object.values(graph.nodes)) {
      if (node.needsReview !== true) continue;
      const state = derived.nodes.get(node.id);
      if (state === undefined || state.derivedState === 'removed') continue;
      out.push({
        id: node.id,
        name: node.name,
        derivedState: state.derivedState,
        progress: state.progress,
        refs: (node.refs ?? []).map((ref) => ({ type: ref.type, target: ref.target })),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

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
      | 'set-priority'
      | 'set-parent'
      | 'mark-review'
      | 'clear-review'
      | 'snapshot';
    nodeId: string;
    /** 需要二次确认的动作：`confirm !== true` 时只回影响范围。 */
    confirm?: boolean;
    /** `add-child` / `rename` / `describe` 的文本输入；`set-priority` 传 1–10（空串=清除）；`set-parent` 传目标父节点 id。 */
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
      case 'mark-review': {
        /**
         * **标记待审查**（FR-164，右键入口）。
         *
         * 只是一个旗标：告诉"取下一个该做的"这条**排在最前**（用户口径："审查优先级大于关注"）。
         * 不动进度、不改状态 —— 审查是"回头看质量"，不是"往前干活"。
         */
        const marked = await this.patchNode({
          nodeId: input.nodeId,
          patch: { needsReview: true },
          by,
          reason: '面板标记待审查（FR-164）',
        });
        return this.panelResult('mark-review', marked, { needsReview: true });
      }
      case 'clear-review': {
        /**
         * **审查通过**（FR-164）：标记消失，且**整枝视为已审**（遗传）。
         *
         * 用户口径："审查可遗传，就是父节点审查了，通审整枝。审查标记在审查完成后消失"。
         * 级联实现在 `clearReviewFlags`（与会话工具 `pm_review` **共用同一份**，不写两遍）。
         */
        const outcome = await this.clearReviewFlags({ nodeId: input.nodeId, by });
        return {
          status: 'ok',
          action: 'clear-review',
          message:
            outcome.failed.length === 0
              ? `审查通过：清掉 ${outcome.cleared} 个待审标记${outcome.subtree > 1 ? '（含整枝）' : ''}`
              : `审查通过：清掉 ${outcome.cleared} 个，${outcome.failed.length} 个未清掉`,
          detail: { cleared: outcome.cleared, failed: outcome.failed.length, subtree: outcome.subtree },
        };
      }
      case 'set-parent': {        /**
         * **改父节点**（用户诉求："移到…/拖拽改父"）。
         *
         * 内核直接复用 `reparentSubtree` —— 它本来就带**成环保护**（不许挂到自己的子孙下面）
         * 与**重复枝保护**，还自带审计记录（`applyAiTree` 里"按身份复用 + 挂点"走的就是它）。
         * 这里只负责把 `text`（目标节点 id）翻译成参数并做最基本的存在性检查，
         * **不另写一套移动逻辑**（两套判据迟早打架）。
         */
        const targetId = (input.text ?? '').trim();
        if (targetId === '') {
          return {
            status: 'denied',
            action: 'set-parent',
            code: 'E_PARENT',
            message: '要指定目标父节点的 id（拖拽时会自动带上）。',
          };
        }
        if (targetId === input.nodeId) {
          return { status: 'denied', action: 'set-parent', code: 'E_SELF', message: '不能把节点挂到它自己下面。' };
        }
        const target = graph.nodes[targetId];
        if (target === undefined) {
          return { status: 'denied', action: 'set-parent', code: 'E_NOT_FOUND', message: '目标父节点不存在。' };
        }
        const moved = await this.reparentSubtree({
          nodeId: input.nodeId,
          parentId: targetId,
          by,
          reason: '面板拖拽改父节点（用户当场操作）',
        });
        if (moved.status !== 'ok') return this.panelResult('set-parent', moved);
        return this.panelResult('set-parent', moved, {
          parentId: targetId,
          parentName: target.name,
        });
      }
      case 'set-priority': {        /**
         * **优先级由人改**（FR-162 ② 的"人可改"）：1 最高、10 最低；空串 = 清除（回到"未设置"）。
         *
         * 关键在 `prioritySource: 'user'`：AI 建树时有**"人改过的不许覆盖"**的保护
         * （见 `applyAiTree` 里的 `prioritySource === 'user'` 分支），
         * 所以这一笔一旦落下，后面的 AI 建树就不能悄悄把它改回去 —— 只会走审核（或如实记进 notes）。
         * 少了这个来源标记，"人改的优先级"下一轮建树就没了。
         */
        const raw = (input.text ?? '').trim();
        if (raw === '') {
          const cleared = await this.patchNode({ nodeId: input.nodeId, patch: { priority: undefined }, by });
          return this.panelResult('set-priority', cleared, { priority: null });
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          return {
            status: 'denied',
            action: 'set-priority',
            code: 'E_PRIORITY',
            message: '优先级要填 1–10 的整数（1 最高）；留空表示清除。',
          };
        }
        const patched = await this.patchNode({
          nodeId: input.nodeId,
          patch: { priority: value, prioritySource: 'user' },
          by,
        });
        return this.panelResult('set-priority', patched, { priority: value });
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

/**
 * 从 agents 注册表按 id 取 agent（**读法只此一处**）。
 *
 * 单独抽出来是因为它有个容易踩的语义：注册表在、`get` 抛错、`get` 返回 undefined 是**三种**情况，
 * 而调用方只需要知道"拿到没有"。把不可达与查不到合并成一个 `undefined` 之前，
 * 至少要让"注册表本身在不在"能被单独问到（见 `agentsRegistry`）。
 */
function readRegistry(
  registry: { get?: (id: string) => unknown } | undefined,
  id: string,
): unknown {
  try {
    return registry?.get?.(id);
  } catch {
    return undefined;
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












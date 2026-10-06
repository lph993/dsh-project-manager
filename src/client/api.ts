/**
 * 面板数据客户端（浏览器侧）。
 *
 * 用**同源 HTTP** 取数据，而不是 DSH Remote —— 原因见 `src/adapter/http.ts` 顶部说明
 * （三方包无法新增 `ctx.remote.<ns>` 命名空间）。
 *
 * 关键细节：URL 用 `new URL(相对, document.baseURI)` 解析，**不要**写成根绝对路径。
 * Harness 可能被反代在子路径下（如 `/dsh/`），根绝对路径会丢前缀。第三方 UI 插件
 * `dshmarket` 正是这么处理的。
 */

import type { BoardSnapshot, NodeView, ProgressStats } from './contract.ts';
import { countRatio, nodeCountHint } from './labels.ts';

export const ROUTE_PREFIX = '/pm';

/** 相对 baseURI 解析出可用的请求路径。 */
export function resolveRoute(path: string): string {
  return new URL(`${ROUTE_PREFIX}${path}`.replace(/^\/+/, ''), document.baseURI).pathname;
}

/**
 * 诊断页的**可点**地址（FR-174：状态条的警示角标点它去看详情）。
 *
 * 拼法与 `resolveRoute` 同源（都用 `document.baseURI` 解析），所以算出来的地址与请求走的
 * 是同一处 —— 不会出现"数据能拿到、链接却 404"。
 *
 * **没有 `document` 时也要能算**：面板会被 SSR 渲染（`pnpm run render-check` 就是 SSR，
 * 宿主侧预渲染同理）。早先这里直接读 `document.baseURI`，一进 SSR 就
 * `ReferenceError: document is not defined`，整个面板渲染炸掉 —— 一个诊断链接没资格
 * 把主面板搞崩，所以这里退回根相对路径（浏览器里点它一样对）。
 */
export function debugUrl(): string {
  if (typeof document === 'undefined') return `${ROUTE_PREFIX}/debug`;
  return new URL(`${ROUTE_PREFIX}/debug`, document.baseURI).pathname;
}

export interface FetchOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}async function getJson<T>(path: string, signal?: AbortSignal): Promise<FetchOutcome<T>> {
  try {
    const url = new URL(`./${ROUTE_PREFIX}${path}`.replace(/\/+/g, '/'), document.baseURI);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const value = (await response.json()) as T;
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 会话查询串（带上它宿主才能把工作区根精确解析到该会话的工作区）。 */
function sessionQuery(sessionId?: string): string {
  return sessionId !== undefined && sessionId !== '' ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
}

/** 拉取看板快照。 */
export function fetchBoard(signal?: AbortSignal, sessionId?: string): Promise<FetchOutcome<BoardSnapshot>> {
  return getJson<BoardSnapshot>(`/board${sessionQuery(sessionId)}`, signal);
}

/** 拉取项目列表。 */
export function fetchProjects(
  signal?: AbortSignal,
): Promise<FetchOutcome<{ projects: unknown[]; current: string }>> {
  return getJson('/projects', signal);
}

/** 拉取最近审计。 */
export function fetchAudit(signal?: AbortSignal): Promise<FetchOutcome<{ rows: unknown[] }>> {
  return getJson('/audit', signal);
}

async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<FetchOutcome<T>> {
  try {
    const url = new URL(`./${ROUTE_PREFIX}${path}`.replace(/\/+/g, '/'), document.baseURI);
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 整枝删除的两阶段结果（`confirm: false` 先拿 preview）。 */
export type BranchRemoveOutcome =
  | { status: 'needs-confirm'; preview: string; action: string }
  | { status: 'ok' | 'denied'; code?: string; message?: string; reason?: string };

/**
 * 删除一个项目（连同节点/审计/冲突/快照）。
 *
 * 两阶段：`confirm: false` 只拿影响范围（先给用户看）；服务端**不允许删当前绑定的项目**
 * （会把读路径静默带到别的项目）—— 那种情况回 400 + `code: 'E_PROJECT_BOUND'`。
 */
export type DeleteProjectOutcome =
  | { status: 'needs-confirm'; preview: string; action: 'delete-project' }
  | { status: 'denied'; code: string; message: string; hint?: string }
  | { status: 'ok'; projectId: string; removedNodes: number };

export async function deleteProject(
  body: { projectId: string; confirm?: boolean },
  signal?: AbortSignal,
): Promise<FetchOutcome<DeleteProjectOutcome>> {
  try {
    const url = new URL(`./${ROUTE_PREFIX}/projects`.replace(/\/+/g, '/'), document.baseURI);
    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const value = (await response.json()) as DeleteProjectOutcome;
    if (!response.ok) {
      // 4xx 也带着结构化原因回来（denied），别把它丢成一个泛泛的 HTTP 错误
      return { ok: false, value, error: 'message' in value ? value.message : `HTTP ${response.status}` };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 面板路径的整枝删除（FR-57）。
 *
 * **确认语义**：面板的确认人是当场用户，因此由面板自己的确认框承载（§6.7f 第 2 行）；
 * 模型走不了这个接口（模型只有 `pm_*` 工具，那条路必须过 `ctx.approval` 且 fail-closed）。
 */
export async function postRemoveBranch(
  body: { nodeId: string; policy: 'record' | 'code' | 'comment'; confirm: boolean },
  signal?: AbortSignal,
): Promise<FetchOutcome<BranchRemoveOutcome>> {
  return postJson<BranchRemoveOutcome>('/branch/remove', body, signal);
}

/** 「整理为单一根」的结果（顶级节点应唯一；只改父子关系，不删节点）。 */
export interface MergeRootsOutcome {
  status: 'ok' | 'noop';
  message?: string;
  canonical?: { id: string; name: string };
  merged?: Array<{ id: string; name: string }>;
  failures?: Array<{ id: string; name: string; reason: string }>;
}

/** 把多余的顶级节点整枝并入任务点最多的那个。 */
export async function postMergeRoots(
  signal?: AbortSignal,
): Promise<FetchOutcome<MergeRootsOutcome>> {
  return postJson<MergeRootsOutcome>('/roots/merge', {}, signal);
}

/** AI 建树的成本预估（不调模型）。 */
export interface AiEstimateView {
  entries: number;
  signatureBytes: number;
  promptBytes: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  level: 'small' | 'medium' | 'large';
}

/** T6/T9：这次建树会走缓存还是真调模型（面板要在**确认前**说清花不花钱）。 */
export interface AiCacheView {
  state: 'hit' | 'resume' | 'miss';
  savedTokens?: number;
  changed?: { added: string[]; removed: string[]; changed: string[] };
}

export type AiEstimateOutcome =
  // `cache` 允许缺席：宿主可能是**旧版本**（版本错位在插件生态里是常态），客户端必须能降级渲染
  | { available: true; estimate: AiEstimateView; description: string; route: string; cache?: AiCacheView }
  | { available: false; reason: string; hint: string; estimate?: AiEstimateView };

export type AiBuildOutcome =
  | {
      status: 'needs-confirm';
      estimate: AiEstimateView;
      description: string;
      route: string;
      /** 旧宿主不返回它 → 面板按"未知/未命中"渲染，而不是崩。 */
      cache?: AiCacheView;
    }
  | { status: 'denied'; reason: string; hint: string }
  | { status: 'error'; reason: string; message: string; rawText?: string }
  | {
      status: 'ok';
      projectName: string;
      created: number;
      updated: number;
      /** 清掉的阶段 A 草稿枝数。 */
      removed: number;
      failures: Array<{ name: string; reason: string }>;
      notes: string[];
      proposed: number;
      /** 这次是复用缓存还是真调了模型（旧宿主不返回）。 */
      cache?: AiCacheView & { changedPaths: { added: string[]; removed: string[]; changed: string[] } };
    };

/** 只算成本（面板必须先展示给用户看）。 */
export function postAiEstimate(
  sessionId?: string,
  signal?: AbortSignal,
): Promise<FetchOutcome<AiEstimateOutcome>> {
  return postJson<AiEstimateOutcome>(
    '/ai/estimate',
    sessionId !== undefined && sessionId !== '' ? { sessionId } : undefined,
    signal,
  );
}

/** 用 AI 从仓库生成功能/任务树；`confirm: false` 只拿成本预估。 */
export function postAiBuild(  body: {
    confirm: boolean;
    sessionId?: string;
    maxNodes?: number;
    replaceAutoDraft?: boolean;
    /** T6 逃生口：忽略缓存强制重算（会花钱）。 */
    forceRebuild?: boolean;
  },
  signal?: AbortSignal,
): Promise<FetchOutcome<AiBuildOutcome>> {
  return postJson<AiBuildOutcome>('/ai/build', body, signal);
}

/**
 * **显式中止正在跑的建树**（FR-168）。
 *
 * 宿主没在跑时返回 `cancelled: false`（无害，不报错）—— 面板据此说"没有正在跑的调用"，
 * 而不是弹一个吓人的失败。
 */
export function postAiCancel(
  signal?: AbortSignal,
): Promise<FetchOutcome<{ ok: boolean; cancelled: boolean }>> {
  return postJson<{ ok: boolean; cancelled: boolean }>('/ai/cancel', {}, signal);
}

/** 面板右键菜单的动作（FR-50–58b 的面板路径）。 */
export type PanelNodeAction =
  | 'focus'
  | 'unfocus'
  | 'pause'
  | 'resume'
  | 'hold'
  | 'release'
  | 'add-child'
  | 'rename'
  | 'describe'
  /** 设置/清除优先级（1 最高；`text` 传 1–10，空串=清除）。落 `prioritySource: 'user'`，AI 以后不覆盖。 */
  | 'set-priority'
  /** 改父节点（`text` = 目标父节点 id）：拖拽改父走这条，内核是 `reparentSubtree`（带成环保护）。 */
  | 'set-parent'
  /** 标记待审查（FR-164）：取任务时它压过关注。 */
  | 'mark-review'
  /** 审查通过（FR-164）：标记消失，且**整枝视为已审**（遗传）。 */
  | 'clear-review'
  | 'snapshot';

export interface PanelActionOutcome {
  status: 'ok' | 'needs-confirm' | 'denied';
  action: string;
  preview?: string;
  message?: string;
  code?: string;
  detail?: Record<string, unknown>;
}

/** 面板内发起节点动作；`confirm: false` 只回影响范围（破坏性动作）。 */
export function postNodeAction(
  body: {
    action: PanelNodeAction;
    nodeId: string;
    confirm?: boolean;
    text?: string;
    reason?: string;
  },
  signal?: AbortSignal,
): Promise<FetchOutcome<PanelActionOutcome>> {
  return postJson<PanelActionOutcome>('/node/action', body, signal);
}

/** 一个可用的回滚点（FR-51b：确认框里要列出快照与时间）。 */
export interface SnapshotRow {
  snapshotId: string;
  reason: string;
  createdAt: string;
  mode: string;
  sizeBytes: number;
}

/** 拉某节点的回滚点清单（菜单里据此决定「回滚」显不显示，以及列出哪几个点）。 */
export async function fetchSnapshots(
  nodeId: string,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<FetchOutcome<{ nodeId: string; snapshots: SnapshotRow[] }>> {
  const query = new URLSearchParams({ nodeId });
  if (sessionId !== undefined && sessionId !== '') query.set('sessionId', sessionId);
  return getJson(`/snapshots?${query.toString()}`, signal);
}

/** 面板路径回滚 / 整枝回滚的两阶段结果（`confirm: false` 先拿影响范围）。 */
export type RollbackOutcome =
  | { status: 'needs-confirm'; preview: string; action: 'rollback' | 'branch-rollback' }
  | { status: 'denied'; code?: string; message?: string; reason?: string; hint?: string }
  | {
      status: 'ok';
      nodeId: string;
      restoredFiles: string[];
      deletedFiles: string[];
      resetNodes: number;
      preRollbackSnapshotId?: string;
    };

/**
 * 面板路径的回滚（FR-51b/53b）。
 *
 * **确认语义**：确认人是面板前的当场用户，由面板确认框承载（§6.7f 第 2 行）。
 * 模型走不到这里 —— 那条路必须过 `ctx.approval` 且 fail-closed。
 */
export async function postRollback(
  body: {
    nodeId: string;
    branch?: boolean;
    snapshotId?: string;
    scope: 'code' | 'state' | 'both';
    confirm?: boolean;
    confirmShared?: boolean;
    sessionId?: string;
  },
  signal?: AbortSignal,
): Promise<FetchOutcome<RollbackOutcome>> {
  return postJson<RollbackOutcome>('/rollback', body, signal);
}

/** 设置页读回（`GET /pm/settings`）。 */
export interface SettingsView {
  namespace: string;
  applies: 'live' | 'restart';
  /** 当前**生效**值（默认层 + 组合层 + 用户层已合并）。 */
  effective: Record<string, unknown>;
  /** 宿主是否提供 settings 服务（false = 只能改 cordis.patch.yml 后重启）。 */
  configurable: boolean;
  /** 回写消耗统计（FR-117）：旧宿主不返回该字段（UI 按"未知"处理）。 */
  notify?: { sent: number; suppressed: number; tracked: number; enabled: boolean };
  /**
   * 会话边界修正统计：旧宿主不返回该字段（UI 按"未知"处理）。
   *
   * `injected` 是"真的投进会话的提醒条数" —— 它是这一层唯一可能引起模型行为的动作，
   * 所以必须和"推了几个状态"分开显示。
   */
  boundary?: {
    runs: number;
    patches: number;
    reminders: number;
    injected: number;
    lastKind: string;
    lastActorId: string;
    lastAt: string;
    enabled: boolean;
    prompt: boolean;
    /** 提示词段的注册结果（`pending` = 在等 systemPrompt 就绪）。旧宿主不返回该字段。 */
    promptState?: 'pending' | 'registered' | 'unavailable';
    /** 提示词段是否真的挂上了 —— 设置页据此决定能不能说"提示词纪律"这四个字。 */
    promptRegistered?: boolean;
  };
  note: string;
  /**
   * **插件自身** AI 调用的 token 统计（FR-147）：旧宿主不返回该字段（UI 按"未知"处理）。
   *
   * 注意口径：只统计插件发起的调用（建树 / 交接补写），**不含会话本身的 token**
   * —— 后者由宿主的会话计量负责，插件看不见也不该假装知道。
   */
  aiUsage?: AiUsageView;
}

/** 插件自身 AI 用量（与 `src/ai/usage.ts` 的 `AiUsageStats` 对齐的只读视图）。 */
export interface AiUsageView {
  calls: number;
  reused: number;
  failed: number;
  providerReported: number;
  estimatedOnly: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedTokens: number;
  savedTokens: number;
  byScenario: Array<{
    scenario: string;
    label: string;
    calls: number;
    reused: number;
    totalTokens: number;
  }>;
  last?: {
    at: string;
    scenario: string;
    route: string;
    outcome: 'ok' | 'error' | 'reused';
    estimatedTokens: number;
    usageSource: 'provider' | 'estimate' | 'none';
  };
  window: number;
}

/** 读当前生效设置。 */
export async function fetchSettings(
  signal?: AbortSignal,
): Promise<FetchOutcome<SettingsView>> {
  return getJson('/settings', signal);
}

/**
 * 写设置（`POST /pm/settings`）。
 *
 * 走宿主官方的 `settings.update()`：schema 校验与持久化都在那边，
 * 非法值会被拒（面板原样显示拒绝原因，不吞掉）。
 */
export async function postSettings(
  patch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FetchOutcome<{ ok: boolean; effective?: Record<string, unknown>; message?: string }>> {
  return postJson('/settings', { patch }, signal);
}

/** 健康检查（用于面板显示数据通道是否可用）。 */export function fetchHealth(
  signal?: AbortSignal,
): Promise<FetchOutcome<{ ok: boolean; route: string }>> {
  return getJson('/health', signal);
}

/** 诊断快照（`/pm/debug?format=json`）。 */
export function fetchDebug(signal?: AbortSignal): Promise<
  FetchOutcome<{
    report: Record<string, unknown>;
    client: Record<string, unknown> | null;
    capabilities: Record<string, unknown>;
    storage: { route: string; projectId: string };
    http: { requestCount: number; lastRequestAt: string | null; lastPaths: string[] };
    logs: Array<{ seq: number; ts: string; level: string; scope: string; message: string }>;
    logCount: number;
  }>
> {
  return getJson('/debug?format=json', signal);
}

/**
 * 客户端自我上报：让宿主的 `/pm/debug` 能显示"客户端这一侧到底加载成什么样"。
 *
 * 浏览器全局被严格限制（宿主只注入 `__DSH_BOOT__` / `__ModuleLoader__`，不含插件数据），
 * 所以插件自己的可观测点必须**主动上报**，否则宿主无法知道面板是否真的跑起来了。
 * 上报失败不影响插件功能（诊断是附加能力）。
 */
export function reportClient(input: {
  panelId: string;
  bundleId: string;
  registeredSlots: string[];
  /**
   * 客户端抛错（可选）。
   *
   * 面板渲染炸掉时槽位错误边界只留下一个空 div —— 用户看到"点开一片空白"，
   * 宿主侧完全不知情。把错误报上来，`/pm/debug?format=json` 里就能看到哪一行炸的。
   */
  error?: { kind: string; message: string; stack?: string };
}): void {
  try {
    const target = (path: string): string =>
      new URL(`./${ROUTE_PREFIX}${path}`.replace(/\/+/g, '/'), document.baseURI).toString();
    void fetch(target('/debug/client'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        boardUrl: target('/board'),
        userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      }),
    }).catch(() => {
      // 静默：诊断上报失败不应产生噪音
    });
  } catch {
    // 同上
  }
}

/** 格式化百分比（看板口径：按工作量；括号内给件数）。 */
export function formatPercent(stats: ProgressStats | undefined): string {
  if (!stats || stats.totalLeaves === 0) return '—';
  return `${Math.round(stats.ratio * 100)}%`;
}

/**
 * 件数比展示（**总数在前**：`140/1` = 总 140、已完成 1）。
 *
 * 口径串的**唯一实现**在 `labels.ts` 的 `countRatio`（FR-153：一个位置只放一个数字串、顺序写死
 * `总/已完成`）；这里只负责"没有统计时给空串"这一层外壳，不再自己拼——同一口径两处实现迟早会漂移（FR-71）。
 */
export function formatCounts(stats: ProgressStats | undefined): string {
  if (!stats) return '';
  return countRatio(stats.totalLeaves, stats.doneLeaves);
}

/** 口径标注（FR-34：必须标注权重口径与来源）。 */
export function formatBasis(stats: ProgressStats | undefined): string {
  if (!stats) return '';
  if (stats.basis === 'weight') {
    // §9.3a 的诚实降级：权重没有结构区分度时，加权结果与按件数一致，不得继续声称工作量口径
    return stats.structuralDegenerate === true ? '按件数·无结构数据' : '按工作量';
  }
  return '按件数';
}

/** 计算状态 → 中文标签。 */
export const DERIVED_STATE_LABEL: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  error: '异常',
  paused: '已暂停',
  held: '已拦停',
  removed: '已删除',
};

/** 计算状态 → 颜色（无障碍：颜色之外还有标签与角标）。 */
export const DERIVED_STATE_COLOR: Record<string, string> = {
  pending: '#9aa4b2',
  running: '#3b82f6',
  done: '#22c55e',
  error: '#ef4444',
  paused: '#f59e0b',
  held: '#b91c1c',
  removed: '#6b7280',
};

/** 一个节点在列表里的单行文案。 */
export function nodeRowLabel(node: NodeView): string {
  const path = node.branchPath.length > 0 ? `${node.branchPath.join(' / ')} / ` : '';
  return `${path}${node.name}`;
}

/**
 * 节点的悬停说明。
 *
 * **默认不显示权重**：默认口径是**按件数**（每个任务点等权），
 * 编一个"权重 1.00"只会让人以为系统偷偷算过什么（§9.3a 修订）。
 * 只有当权重真有来源（AI 估算 / 人工填写）时才把它连同证据摆出来（FR-34）。
 *
 * 数字口径与画布节点**同源**（`client/labels.ts`）：画布上只写纯数字，
 * 含义在这里一句话讲清（否则框里的 `33 / 21` 就是"看着像写错了"）。
 */
export function nodeRowTitle(node: NodeView): string {
  const lines = [nodeRowLabel(node)];
  lines.push(nodeCountHint(node));
  if (node.weightSource === undefined) {
    lines.push('权重口径：按件数（每个任务点等权）');
  } else {
    const source = node.weightSource === 'ai' ? 'AI 估算' : '人工填写';
    lines.push(`权重 ${node.weight.toFixed(2)}（${source}）`);
  }
  if (node.blockedBy.length > 0) lines.push(`被前置阻塞：${node.blockedBy.length} 项`);
  return lines.join('\n');
}


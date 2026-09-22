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

export const ROUTE_PREFIX = '/pm';

/** 相对 baseURI 解析出可用的请求路径。 */
export function resolveRoute(path: string): string {
  return new URL(`${ROUTE_PREFIX}${path}`.replace(/^\/+/, ''), document.baseURI).pathname;
}

export interface FetchOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<FetchOutcome<T>> {
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

/** 扫描建议（零 token 骨架）。 */
export interface ScanPreview {
  available: boolean;
  reason?: string;
  projectName: string;
  nodes: Array<{
    key: string;
    name: string;
    kind: string;
    parentKey: string | null;
    origin: string;
  }>;
  scanned: number;
  skipped: number;
  truncated: boolean;
  notes: string[];
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

/** 触发一次零 token 扫描（只建议，不落库）。 */
export async function postScan(
  signal?: AbortSignal,
  sessionId?: string,
): Promise<FetchOutcome<ScanPreview>> {
  return postJson<ScanPreview>(`/scan${sessionQuery(sessionId)}`, undefined, signal);
}

/** 应用扫描结果建树（不带参数时服务端自己扫一次）。 */
export async function postScanApply(
  body?: { nodes?: unknown[]; projectName?: string },
  signal?: AbortSignal,
  sessionId?: string,
): Promise<FetchOutcome<{ created: number; skipped: number; failures: unknown[] }>> {
  return postJson(`/scan/apply${sessionQuery(sessionId)}`, body, signal);
}

/** 整枝删除的两阶段结果（`confirm: false` 先拿 preview）。 */
export type BranchRemoveOutcome =
  | { status: 'needs-confirm'; preview: string; action: string }
  | { status: 'ok' | 'denied'; code?: string; message?: string; reason?: string };

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

/** 健康检查（用于面板显示数据通道是否可用）。 */
export function fetchHealth(
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

/** 件数比展示。 */
export function formatCounts(stats: ProgressStats | undefined): string {
  if (!stats) return '';
  return `${stats.doneLeaves}/${stats.totalLeaves}`;
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
 * 节点的悬停说明：**把权重依据摆出来**（FR-34：口径必须可核对）。
 *
 * 用户看到"为什么这个大任务只占 3%"，应该能查到它是怎么算出来的，
 * 而不是只能相信一个数字。
 */
export function nodeRowTitle(node: NodeView): string {
  const lines = [nodeRowLabel(node)];
  const detail = node.weightDetail;
  const source = node.weightSource === 'ai' ? 'AI 测量' : '零 token 启发式';
  lines.push(`权重 ${node.weight.toFixed(2)}（${source}）`);
  if (detail !== undefined && detail['source'] === 'heuristic') {
    const signals = detail['signals'] as
      | { fileCount?: number; lineCount?: number; lineCountEstimated?: boolean; subtreeCount?: number }
      | undefined;
    if (signals) {
      lines.push(
        `信号：文件 ${signals.fileCount ?? 0}、行数 ${signals.lineCount ?? 0}` +
          `${signals.lineCountEstimated === true ? '（估算）' : ''}、子树叶 ${signals.subtreeCount ?? 0}`,
      );
    }
    const score = detail['score'];
    const k = detail['k'];
    if (typeof score === 'number' && typeof k === 'number') {
      lines.push(`结构分 ${score.toFixed(2)}${k === 1 ? '（无 AI 样本，k=1）' : `，对标 k=${k.toFixed(2)}`}`);
    }
    if (detail['degenerate'] === true) lines.push('⚠ 无结构差异：该权重与按件数一致');
  }
  if (node.blockedBy.length > 0) lines.push(`被前置阻塞：${node.blockedBy.length} 项`);
  return lines.join('\n');
}

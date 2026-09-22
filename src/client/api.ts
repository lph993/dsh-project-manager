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

/** 拉取看板快照。 */
export function fetchBoard(signal?: AbortSignal): Promise<FetchOutcome<BoardSnapshot>> {
  return getJson<BoardSnapshot>('/board', signal);
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
export async function postScan(signal?: AbortSignal): Promise<FetchOutcome<ScanPreview>> {
  return postJson<ScanPreview>('/scan', undefined, signal);
}

/** 应用扫描结果建树（不带参数时服务端自己扫一次）。 */
export async function postScanApply(
  body?: { nodes?: unknown[]; projectName?: string },
  signal?: AbortSignal,
): Promise<FetchOutcome<{ created: number; skipped: number; failures: unknown[] }>> {
  return postJson('/scan/apply', body, signal);
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
  return stats.basis === 'weight' ? '按工作量' : '按件数';
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

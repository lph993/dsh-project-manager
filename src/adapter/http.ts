/**
 * 宿主 HTTP 路由（Client 面板的数据通路 + 诊断入口）。
 *
 * **为什么走 HTTP 而不是 DSH Remote**（实测结论，DSH 0.1.5-rc.2）：
 * 三方包**无法新增** `ctx.remote.<ns>` 命名空间 —— 客户端可见的命名空间集合是
 * `@deepseek-ai/dsh-api-remotes` 里一份**构建期硬编码的导入清单**（15 个
 * `TYPERT_REMOTE` 贡献），且生成器 `@deepseek-ai/dsh-typert-generator` 未随发行版安装。
 * 而宿主 HTTP 路由是公开 API，且第三方 UI 插件 `dshmarket` 正是这么做的（26 条路由）。
 *
 * 客户端侧用 `new URL(relative, document.baseURI)` 解析，避免反代前缀丢失（见 `client/api.ts`）。
 *
 * 路由一览：
 * | 方法 | 路径 | 用途 |
 * |---|---|---|
 * | GET | `/pm/board` | 看板快照（面板主数据） |
 * | GET | `/pm/projects` | 项目列表 |
 * | GET | `/pm/audit` | 最近写入审计 |
 * | GET | `/pm/health` | 存活与存储路线 |
 * | POST | `/pm/scan` | 零 token 扫描（只建议，不落库） |
 * | POST | `/pm/scan/apply` | 应用扫描结果建树 |
 * | POST | `/pm/ai/estimate` | AI 建树成本预估（不调模型） |
 * | POST | `/pm/ai/build` | AI 建树（两阶段：先成本后确认） |
 * | POST | `/pm/node/action` | 节点菜单动作（FR-50–58b 的面板路径） |
 * | POST | `/pm/branch/remove` | 整枝删除（先 preview 后确认） |
 * | GET | `/pm/snapshots` | 某节点可用的回滚点（`?nodeId=`；菜单要列出快照） |
 * | POST | `/pm/rollback` | 回滚 / 整枝回滚（先 preview 后确认；面板路径） |
 * | GET | `/pm/settings` | 当前生效的设置 + 哪些字段被用户改过 |
 * | POST | `/pm/settings` | 改设置（走官方 `settings.update()`，非法值被拒） |
 * | GET | `/pm/handoffs` | 交接文档清单 |
 * | GET | `/pm/debug` | **诊断页**（HTML；`?format=json` 给机器，`?format=json` 便于脚本） |
 * | GET | `/pm/debug/logs` | 诊断记录（JSON） |
 * | POST | `/pm/debug/client` | 客户端 bundle 上报自我描述 |
 */

import type { Context } from '@deepseek-ai/cordis';

import type { CapabilityReport } from './capabilities.ts';
import { debugBus, type ClientSelfReport, type PluginSelfReport } from './debug.ts';
import { readPluginRegistry, type RegistryView } from './registry.ts';
import type { ProjectService } from '../service.ts';

/** 从 body 或 query 里取会话 id（面板会带上它来精确解析工作区根）。 */
function readSessionId(body: string, params: URLSearchParams): string | undefined {
  const fromQuery = params.get('sessionId');
  if (fromQuery !== null && fromQuery !== '') return fromQuery;
  if (body === '') return undefined;
  try {
    const parsed = JSON.parse(body) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
      ? parsed.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

/** 面板与诊断路由前缀。 */
export const ROUTE_PREFIX = '/pm';

/** 设置命名空间（与 `src/index.ts` 注册的一致）。 */
const SETTINGS_NAMESPACE = 'project-manager';

/**
 * 官方 `SettingsScope` 的最小面（owner 句柄）。
 *
 * 由 `index.ts` 在注册设置命名空间时拿到并**显式传进来** —— 不用"从 ctx 上摸一个约定属性"，
 * 那种隐式约定一旦改名就是静默失效。
 */
export interface SettingsScopeLike {
  get(): unknown;
  update(patch: object): Promise<void>;
  replace(section: object): Promise<void>;
}

/** 全部路由（诊断页与自我描述都展示它）。 */
export const ROUTES: readonly string[] = [
  'GET /pm/board',
  'GET /pm/projects',
  'GET /pm/audit',
  'GET /pm/health',
  'POST /pm/scan',
  'POST /pm/scan/apply',
  'POST /pm/ai/estimate',
  'POST /pm/ai/build',
  'POST /pm/node/action',
  'POST /pm/branch/remove',
  'GET /pm/snapshots',
  'POST /pm/rollback',
  'GET /pm/settings',
  'POST /pm/settings',
  'GET /pm/handoffs',
  'GET /pm/debug',
  'GET /pm/debug/logs',
  'POST /pm/debug/client',
];

/** 宿主 web 服务器的最小接口形态（避免耦合具体包类型）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: unknown, res: ResponseLike) => void | Promise<void>;
  }): () => void;
}

interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function webServerOf(ctx: Context): WebServerLike | undefined {
  try {
    const value = (ctx as unknown as { get?: (key: string) => unknown }).get?.('webServer');
    if (value && typeof (value as WebServerLike).register === 'function') {
      return value as WebServerLike;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 诊断状态：宿主自我描述 + 客户端上报（路由注册后仍可更新）。 */
export interface DebugState {
  report: PluginSelfReport;
  client?: ClientSelfReport;
  requestCount: number;
  lastRequestAt?: string;
  lastPaths: string[];
}

export interface RouteRegistration {
  dispose: () => void;
  state: DebugState;
}

/**
 * 注册面板数据与诊断路由。
 *
 * @returns 卸载函数与可更新的诊断状态；宿主没有 webServer 时返回 `undefined`
 *          （面板将显示"数据通道不可用"，而不是让插件加载失败 —— §19.4 不变量）。
 */
export function registerRoutes(
  ctx: Context,
  service: ProjectService,
  capabilities: CapabilityReport,
  report: PluginSelfReport,
  /** 设置 owner 句柄（`index.ts` 注册时拿到）。拿不到时设置路由如实回 409。 */
  settingsScope?: SettingsScopeLike,
): RouteRegistration | undefined {
  const webServer = webServerOf(ctx);
  if (!webServer) {
    debugBus.warn('http', 'ctx.webServer 不可用：面板与诊断路由未注册');
    return undefined;
  }

  const state: DebugState = { report, requestCount: 0, lastPaths: [] };

  const sendJson = (res: ResponseLike, status: number, payload: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };

  const sendHtml = (res: ResponseLike, status: number, html: string): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  };

  const dispose = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const request = req as { url?: unknown; method?: unknown; on?: unknown };
      const url = typeof request.url === 'string' ? request.url : '';
      const method = typeof request.method === 'string' ? request.method : 'GET';
      const [path = '', query = ''] = url.split('?');
      const params = new URLSearchParams(query);

      state.requestCount += 1;
      state.lastRequestAt = new Date().toISOString();
      state.lastPaths = [...state.lastPaths, `${method} ${path}`].slice(-20);

      try {
        switch (`${method} ${path}`) {
          case 'GET /pm/health':
            sendJson(res, 200, {
              ok: true,
              route: service.route,
              instanceId: state.report.instanceId,
              toolCount: state.report.registeredTools.length,
            });
            return;

          case 'GET /pm/board': {
            // 面板带上当前会话 id 时，工作区根可以**精确**解析到那个会话的工作区
            const sessionId = params.get('sessionId');
            sendJson(res, 200, await service.board(sessionId ?? undefined));
            return;
          }

          case 'GET /pm/projects':
            sendJson(res, 200, {
              projects: await service.listProjects(),
              current: service.currentProjectId,
            });
            return;

          case 'GET /pm/audit':
            sendJson(res, 200, { rows: await service.recentAudit(50) });
            return;

          case 'GET /pm/handoffs': {
            // 只读列出交接文档（面板显示"这个枝有交接文档可读"）
            const nodeId = params.get('nodeId');
            const kindParam = params.get('kind');
            const kind =
              kindParam === 'pause' || kindParam === 'hold' ? kindParam : undefined;
            if (nodeId === null) {
              sendJson(res, 400, { ok: false, error: 'nodeId-required' });
              return;
            }
            const page = await service.readHandoffPage({
              nodeId,
              ...(kind !== undefined ? { kind } : {}),
              offset: 0,
              limitBytes: 2048,
            });
            sendJson(res, 200, page);
            return;
          }

          case 'POST /pm/scan': {
            // 零 token 骨架扫描：面板首屏"扫一下"按钮走这里
            // 带上 sessionId 时按该会话的工作区根扫描（与 /pm/board 同一个根）
            const sessionId = params.get('sessionId');
            const scan = await service.scan({
              ...(sessionId !== null && sessionId !== '' ? { sessionId } : {}),
            });
            debugBus.info('scan', `扫描完成：条目 ${scan.scanned}，建议节点 ${scan.nodes.length}`, {
              skipped: scan.skipped,
              truncated: scan.truncated,
            });
            sendJson(res, 200, scan);
            return;
          }

          case 'POST /pm/scan/apply': {
            const body = (await readBody(request)).trim();
            let nodes: unknown[] = [];
            let projectName: string | undefined;
            if (body !== '') {
              try {
                const parsed = JSON.parse(body) as {
                  nodes?: unknown[];
                  projectName?: string;
                };
                nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
                projectName = typeof parsed.projectName === 'string' ? parsed.projectName : undefined;
              } catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
              }
            }
            // 不带 nodes 时：服务端自己扫一次再落库（面板一键操作）
            const sessionId = params.get('sessionId');
            let scannedName: string | undefined;
            let suggestions: Parameters<typeof service.applyScan>[0]['nodes'];
            if (nodes.length > 0) {
              suggestions = nodes as Parameters<typeof service.applyScan>[0]['nodes'];
            } else {
              const fresh = await service.scan({
                ...(sessionId !== null && sessionId !== '' ? { sessionId } : {}),
              });
              suggestions = fresh.nodes;
              // 扫出来的项目名也要用上：否则"一键建树"会把项目名丢成「未命名项目」
              if (fresh.projectName.trim() !== '') scannedName = fresh.projectName;
            }
            const applied = await service.applyScan({
              nodes: suggestions,
              ...(projectName !== undefined
                ? { projectName }
                : scannedName !== undefined
                  ? { projectName: scannedName }
                  : {}),
            });
            debugBus.info(
              'scan',
              `建树完成：新建 ${applied.created}，跳过 ${applied.skipped}，失败 ${applied.failures.length}`,
            );
            sendJson(res, 200, applied);
            return;
          }

          case 'POST /pm/ai/estimate': {
            // 只算成本、不调模型：面板必须先让用户看到这个数字（§9.5 T3）
            const body = (await readBody(request)).trim();
            const sessionId = readSessionId(body, params);
            const estimate = await service.aiBuildEstimate(
              sessionId !== undefined ? { sessionId } : {},
            );
            sendJson(res, 200, estimate);
            return;
          }

          case 'POST /pm/ai/build': {
            // 两阶段：confirm!==true 只回成本预估；确认后才真的调模型并落库。
            // 确认人是面板前的用户（§6.7f 第 2 行）；模型侧走不到这里（只有 pm_* 工具）。
            const body = (await readBody(request)).trim();
            let parsed: {
              confirm?: unknown;
              maxNodes?: unknown;
              sessionId?: unknown;
              replaceAutoDraft?: unknown;
              forceRebuild?: unknown;
            } = {};
            if (body !== '') {
              try {
                parsed = JSON.parse(body) as typeof parsed;
              } catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
              }
            }
            const sessionId =
              typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
                ? parsed.sessionId
                : (params.get('sessionId') ?? undefined);
            const outcome = await service.aiBuildTree({
              confirm: parsed.confirm === true,
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(typeof parsed.maxNodes === 'number' ? { maxNodes: parsed.maxNodes } : {}),
              ...(parsed.replaceAutoDraft === false ? { replaceAutoDraft: false } : {}),
              // T6 逃生口：忽略缓存强制重算（面板上是个明确的勾选框）
              ...(parsed.forceRebuild === true ? { forceRebuild: true } : {}),
            });
            if (outcome.status === 'needs-confirm') {
              debugBus.info('ai', `AI 建树待确认：${outcome.description}`, { route: outcome.route });
            }
            sendJson(res, 200, outcome);
            return;
          }

          case 'POST /pm/node/action': {
            // 面板右键菜单的动作分发（FR-50–58b 的面板路径）。
            // 需要二次确认的动作在 `confirm!==true` 时只回影响范围。
            const body = (await readBody(request)).trim();
            if (body === '') {
              sendJson(res, 400, { ok: false, error: 'empty-body' });
              return;
            }
            let parsed: {
              action?: unknown;
              nodeId?: unknown;
              confirm?: unknown;
              text?: unknown;
              reason?: unknown;
            };
            try {
              parsed = JSON.parse(body) as typeof parsed;
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid-json' });
              return;
            }
            const allowed = [
              'focus',
              'unfocus',
              'pause',
              'resume',
              'hold',
              'release',
              'add-child',
              'rename',
              'describe',
              'snapshot',
            ] as const;
            type PanelAction = (typeof allowed)[number];
            const action = allowed.find((candidate) => candidate === parsed.action);
            if (action === undefined) {
              sendJson(res, 400, { ok: false, error: 'unknown-action' });
              return;
            }
            if (typeof parsed.nodeId !== 'string' || parsed.nodeId === '') {
              sendJson(res, 400, { ok: false, error: 'nodeId-required' });
              return;
            }
            const outcome = await service.panelNodeAction({
              action: action as PanelAction,
              nodeId: parsed.nodeId,
              confirm: parsed.confirm === true,
              ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
              ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
            });
            if (outcome.status !== 'ok') {
              debugBus.info('panel', `节点动作 ${action} → ${outcome.status}`, {
                nodeId: parsed.nodeId,
                message: outcome.message,
              });
            }
            sendJson(res, 200, outcome);
            return;
          }

          case 'POST /pm/branch/remove': {
            // 面板路径的整枝删除（FR-57）：两阶段 —— 先给 preview，确认后才落库。
            // 面板的确认人是当场用户，由面板确认框承载（§6.7f 第 2 行）；
            // 模型路径走的仍是 pm_remove 工具 + ctx.approval（fail-closed）。
            const body = (await readBody(request)).trim();
            let parsed: { nodeId?: unknown; policy?: unknown; confirm?: unknown } = {};
            if (body !== '') {
              try {
                parsed = JSON.parse(body) as typeof parsed;
              } catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
              }
            }
            const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId : '';
            if (nodeId === '') {
              sendJson(res, 400, { ok: false, error: 'nodeId-required' });
              return;
            }
            const policy =
              parsed.policy === 'code' || parsed.policy === 'comment' ? parsed.policy : 'record';
            const outcome = await service.removeBranchFromPanel({
              nodeId,
              policy,
              confirm: parsed.confirm === true,
            });
            sendJson(res, 200, outcome);
            return;
          }

          case 'GET /pm/snapshots': {
            // 某个节点可用的回滚点（FR-51b/53b：菜单里要列出快照并标时间）。
            const nodeId = params.get('nodeId') ?? '';
            if (nodeId === '') {
              sendJson(res, 400, { ok: false, error: 'nodeId-required' });
              return;
            }
            service.noteWorkspaceRoot(undefined, readSessionId('', params));
            const snapshots = await service.listSnapshots(nodeId, readSessionId('', params));
            sendJson(res, 200, { nodeId, snapshots });
            return;
          }

          case 'POST /pm/rollback': {
            // 面板路径的回滚 / 整枝回滚（FR-51b/53b）：两阶段 —— 先 preview，确认后才执行。
            // 确认人是面板前的当场用户，由面板确认框承载（§6.7f 第 2 行）；
            // 模型路径走 pm_rollback + ctx.approval，两者不共用入口。
            const body = (await readBody(request)).trim();
            let parsed: {
              nodeId?: unknown;
              branch?: unknown;
              snapshotId?: unknown;
              scope?: unknown;
              confirm?: unknown;
              confirmShared?: unknown;
              sessionId?: unknown;
            } = {};
            if (body !== '') {
              try {
                parsed = JSON.parse(body) as typeof parsed;
              } catch {
                sendJson(res, 400, { ok: false, error: 'invalid-json' });
                return;
              }
            }
            const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId : '';
            if (nodeId === '') {
              sendJson(res, 400, { ok: false, error: 'nodeId-required' });
              return;
            }
            const scope =
              parsed.scope === 'code' || parsed.scope === 'state' ? parsed.scope : 'both';
            // 面板带上会话 id，宿主才能把工作区根解析到"你正在看的那个工作区"
            service.noteWorkspaceRoot(undefined, readSessionId('', params));
            const sessionId =
              typeof parsed.sessionId === 'string' && parsed.sessionId !== ''
                ? parsed.sessionId
                : readSessionId('', params);
            const outcome = await service.panelRollback({
              nodeId,
              branch: parsed.branch === true,
              scope,
              confirm: parsed.confirm === true,
              confirmShared: parsed.confirmShared === true,
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(typeof parsed.snapshotId === 'string' && parsed.snapshotId !== ''
                ? { snapshotId: parsed.snapshotId }
                : {}),
            });
            sendJson(res, 200, outcome);
            return;
          }

          case 'GET /pm/settings': {
            // 设置页读回：**当前生效值**（默认层 + 组合层 + 用户层已经合过的那一份）
            const scope = settingsScope;
            sendJson(res, 200, {
              namespace: SETTINGS_NAMESPACE,
              applies: 'live',
              effective: service.effectiveConfig(),
              configurable: scope !== undefined,
              // FR-117：回写消耗要**看得见**（发了多少 / 压掉多少），而不是只在日志里
              notify: service.notifyStats(),
              note:
                scope !== undefined
                  ? '改动立即生效（扫描 glob / AI 路由 / 刷新间隔都是"下次用到时读"）；已经在跑的那一次调用不会被打断。'
                  : '宿主未提供 settings 服务：只能改 cordis.patch.yml 后重启宿主。',
            });
            return;
          }

          case 'POST /pm/settings': {
            // 设置页写入：**走官方 settings scope.update()**（schema 校验 + 持久化都在那儿）。
            // 我们不自己写配置文件、也不绕过校验 —— 非法值必须被拒，而不是存进去等着炸。
            const scope = settingsScope;
            if (scope === undefined) {
              sendJson(res, 409, { ok: false, error: 'settings-unavailable' });
              return;
            }
            const body = (await readBody(request)).trim();
            if (body === '') {
              sendJson(res, 400, { ok: false, error: 'empty-body' });
              return;
            }
            let parsed: { patch?: unknown };
            try {
              parsed = JSON.parse(body) as typeof parsed;
            } catch {
              sendJson(res, 400, { ok: false, error: 'invalid-json' });
              return;
            }
            if (parsed.patch === null || typeof parsed.patch !== 'object') {
              sendJson(res, 400, { ok: false, error: 'patch-required' });
              return;
            }
            try {
              await scope.update(parsed.patch as object);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              debugBus.warn('settings', `设置写入被拒：${message}`);
              sendJson(res, 400, { ok: false, error: 'invalid-value', message });
              return;
            }
            // watch 已把变更套用到服务上；这里回读一遍，让面板显示**真正生效**的值
            sendJson(res, 200, { ok: true, effective: service.effectiveConfig() });
            return;
          }

          case 'GET /pm/debug': {            const snapshot = buildDebugSnapshot(ctx, state, service, capabilities);
            if (params.get('format') === 'json') {
              sendJson(res, 200, snapshot);
            } else {
              sendHtml(res, 200, renderDebugPage(snapshot));
            }
            return;
          }

          case 'GET /pm/debug/logs': {
            const limit = Number(params.get('limit') ?? 100);
            sendJson(res, 200, {
              entries: debugBus.tail(Number.isFinite(limit) && limit > 0 ? limit : 100),
              total: debugBus.size,
            });
            return;
          }

          case 'POST /pm/debug/client': {
            const body = (await readBody(request)).trim();
            // 空 body 不是"合法的空上报"，而是客户端根本没发出数据：
            // 判为非法，避免把"上报逻辑坏了"伪装成"上报成功但字段为空"。
            if (body === '') {
              debugBus.warn('client', '客户端上报为空 body，已拒绝');
              sendJson(res, 400, { ok: false, error: 'empty-body' });
              return;
            }
            try {
              const parsed = JSON.parse(body) as Partial<ClientSelfReport>;
              const errorReport =
                parsed.error !== undefined &&
                typeof parsed.error === 'object' &&
                typeof (parsed.error as { message?: unknown }).message === 'string'
                  ? {
                      kind: String((parsed.error as { kind?: unknown }).kind ?? 'error'),
                      message: String((parsed.error as { message: string }).message),
                      ...(typeof (parsed.error as { stack?: unknown }).stack === 'string'
                        ? { stack: String((parsed.error as { stack: string }).stack) }
                        : {}),
                      at: new Date().toISOString(),
                    }
                  : undefined;
              if (errorReport !== undefined) {
                // 客户端崩了必须在宿主日志里留痕：否则用户只看到"点开一片空白"
                debugBus.error('client', `客户端报错：${errorReport.message}`, {
                  kind: errorReport.kind,
                });
              }
              state.client = {
                panelId: String(parsed.panelId ?? 'unknown'),
                bundleId: String(parsed.bundleId ?? 'unknown'),
                registeredSlots: Array.isArray(parsed.registeredSlots)
                  ? parsed.registeredSlots.map(String)
                  : [],
                boardUrl: String(parsed.boardUrl ?? ''),
                reportedAt: new Date().toISOString(),
                ...(typeof parsed.userAgent === 'string' ? { userAgent: parsed.userAgent } : {}),
                ...(errorReport !== undefined ? { error: errorReport } : {}),
              };
              if (errorReport === undefined) {
                debugBus.info('client', '客户端 bundle 已上报自我描述', {
                  slots: state.client.registeredSlots,
                });
              }
              sendJson(res, 200, { ok: true });
            } catch (error) {
              debugBus.warn('client', '客户端上报解析失败', error);
              sendJson(res, 400, { ok: false, error: 'invalid-json' });
            }
            return;
          }

          default:
            sendJson(res, 404, { error: 'not-found', path, method });
        }
      } catch (error) {
        debugBus.error('http', `路由处理失败：${method} ${path}`, error);
        sendJson(res, 500, {
          error: 'internal',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  debugBus.info('http', `已注册路由前缀 ${ROUTE_PREFIX}`, { routes: [...ROUTES] });

  return { dispose, state };
}

/** 读取请求体（带大小上限，避免被超大 body 拖垮）。 */
function readBody(request: { on?: unknown }): Promise<string> {
  return new Promise((resolve) => {
    if (typeof request.on !== 'function') {
      resolve('');
      return;
    }
    const chunks: string[] = [];
    let size = 0;
    const MAX = 64 * 1024;
    const on = request.on as (event: string, listener: (...args: unknown[]) => void) => void;
    on.call(request, 'data', (chunk: unknown) => {
      size += typeof chunk === 'string' ? chunk.length : 0;
      if (size > MAX) {
        resolve('');
        return;
      }
      chunks.push(String(chunk));
    });
    on.call(request, 'end', () => resolve(chunks.join('')));
    on.call(request, 'error', () => resolve(''));
  });
}

/** 组装一份完整诊断快照。 */
function buildDebugSnapshot(
  ctx: Context,
  state: DebugState,
  service: ProjectService,
  capabilities: CapabilityReport,
): Record<string, unknown> {
  return {
    report: state.report,
    client: state.client ?? null,
    capabilities,
    storage: {
      route: service.route,
      projectId: service.currentProjectId,
      // 多工作区：诊断里必须能看出"当前项目绑到哪个根、根从哪来"
      boundRoot: service.boundWorkspaceRoot ?? null,
      resolution: service.rootResolution(),
    },
    http: {
      requestCount: state.requestCount,
      lastRequestAt: state.lastRequestAt ?? null,
      lastPaths: state.lastPaths,
    },
    // 官方调试口径：插件静默不加载 = fiber 停在 PENDING（无报错、无输出）。
    // 把整个注册表状态列出来，PENDING 一眼可见。
    registry: readPluginRegistry(ctx, state.report.pluginName),
    logs: debugBus.tail(80),
    logCount: debugBus.size,
  };
}

/** HTML 转义。 */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 渲染插件注册表区块（官方口径：PENDING 即"静默不加载"）。 */
function renderRegistry(registry: RegistryView | undefined): string {
  if (!registry) return '<div class="muted">注册表不可读（内部结构可能随 rc 变化）。</div>';

  const counts = Object.entries(registry.counts)
    .map(([name, count]) => `<span class="b">${esc(name)}: ${esc(count)}</span>`)
    .join(' ');

  const pendingBlock =
    registry.pending.length === 0
      ? '<div class="ok">没有 PENDING 插件（没有静默等待依赖的条目）。</div>'
      : `<div class="bad">⚠ ${registry.pending.length} 个插件停在 PENDING —— 它声明的服务没人提供，因此**永远不会加载且不报错**：<ul>${registry.pending
          .map(
            (p) =>
              `<li><code>${esc(p.name)}</code>${
                p.missing && p.missing.length > 0 ? ` — 等待：${esc(p.missing.join(', '))}` : ''
              }</li>`,
          )
          .join('')}</ul></div>`;

  const failedBlock =
    registry.failed.length === 0
      ? ''
      : `<div class="bad">${registry.failed.length} 个插件 FAILED：<ul>${registry.failed
          .map((f) => `<li><code>${esc(f.name)}</code></li>`)
          .join('')}</ul></div>`;

  const rows = registry.runtimes
    .flatMap((runtime) =>
      runtime.fibers.map(
        (fiber) =>
          `<tr><td>${esc(runtime.id)}</td><td>${esc(fiber.name)}</td><td class="lvl-${
            fiber.stateName === 'FAILED' ? 'error' : fiber.stateName === 'PENDING' ? 'warn' : 'debug'
          }">${esc(fiber.stateName)}</td><td class="muted">${esc(
            fiber.missing?.join(', ') ?? '',
          )}</td></tr>`,
      ),
    )
    .join('');

  return `
<div>${counts} <span class="b ${registry.selfActive ? 'ok' : 'bad'}">本插件: ${
    registry.selfActive ? 'ACTIVE' : '未 ACTIVE'
  }</span></div>
${pendingBlock}
${failedBlock}
<table>
 <tr><th>条目 id</th><th>插件</th><th>状态</th><th>缺失服务</th></tr>
 ${rows}
</table>`;
}

/** 人可读的诊断页（零依赖 inline HTML；面板前端崩了也能看）。 */
function renderDebugPage(snapshot: Record<string, unknown>): string {
  const report = snapshot['report'] as PluginSelfReport;
  const client = snapshot['client'] as ClientSelfReport | null;
  const capabilities = snapshot['capabilities'] as CapabilityReport;
  const registry = snapshot['registry'] as RegistryView | undefined;
  const storage = snapshot['storage'] as {
    route: string;
    projectId: string;
    boundRoot: string | null;
    resolution: { root: string | undefined; source: string; detail: string };
  };
  const http = snapshot['http'] as {
    requestCount: number;
    lastRequestAt: string | null;
    lastPaths: string[];
  };
  const logs = snapshot['logs'] as Array<{
    seq: number;
    ts: string;
    level: string;
    scope: string;
    message: string;
  }>;

  const badge = (ok: boolean, label: string): string =>
    `<span class="b ${ok ? 'ok' : 'bad'}">${esc(label)}: ${ok ? '可用' : '不可用'}</span>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Project Manager · 诊断</title>
<style>
 :root { color-scheme: light dark; }
 body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; max-width: 1100px; }
 h1 { font-size: 16px; } h2 { font-size: 13px; margin-top: 22px; opacity: .75; }
 .b { display: inline-block; padding: 1px 7px; border-radius: 9px; border: 1px solid currentColor; margin: 0 6px 6px 0; }
 .ok { color: #16a34a; } .bad { color: #dc2626; }
 table { border-collapse: collapse; width: 100%; }
 td, th { text-align: left; padding: 3px 10px 3px 0; vertical-align: top; border-bottom: 1px solid rgba(128,128,128,.2); }
 .lvl-error { color: #dc2626; } .lvl-warn { color: #d97706; } .lvl-debug { opacity: .6; }
 pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
 .muted { opacity: .6; }
</style></head><body>
<h1>Project Manager 诊断</h1>
<div class="muted">插件 <b>${esc(report.pluginName)}</b> v${esc(report.pluginVersion)} · 包名 <b>${esc(report.packageId)}</b></div>
<div class="muted">实例 <code>${esc(report.instanceId)}</code> · 加载于 ${esc(report.loadedAt)}</div>

<h2>能力探测</h2>
<div>
 ${badge(capabilities.approval, '审批通道')}
 ${badge(capabilities.userQuestions, '提问通道')}
 ${badge(capabilities.sandbox, '沙箱策略')}
 ${badge(capabilities.storageDomain, 'storageDomain')}
 <span class="b">沙箱模式: ${esc(capabilities.sandboxMode ?? '未知')}</span>
</div>
${
  capabilities.degradations.length > 0
    ? `<div class="bad">降级项：<ul>${capabilities.degradations.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`
    : '<div class="ok">无降级项</div>'
}

<h2>存储与项目</h2>
<table>
 <tr><th>存储路线</th><td>${esc(storage.route)}</td></tr>
 <tr><th>当前项目</th><td>${esc(storage.projectId)}</td></tr>
 <tr><th>已绑定工作区根</th><td>${esc(storage.boundRoot ?? '（未绑定）')}</td></tr>
 <tr><th>根从哪来</th><td>${esc(storage.resolution.source)} — ${esc(storage.resolution.detail)}${
   storage.resolution.root !== undefined ? `<br><code>${esc(storage.resolution.root)}</code>` : ''
 }</td></tr>
 <tr><th>已注册工具</th><td>${report.registeredTools.length} 个：${esc(report.registeredTools.join(', '))}</td></tr>
 <tr><th>设置命名空间</th><td>${esc(report.settingsNamespaces.join(', ') || '（无）')}</td></tr>
</table>

<h2>HTTP</h2>
<table>
 <tr><th>请求计数</th><td>${esc(http.requestCount)}</td></tr>
 <tr><th>最近请求</th><td>${esc(http.lastRequestAt ?? '（尚无）')}</td></tr>
 <tr><th>最近路径</th><td>${http.lastPaths.map((p) => `<code>${esc(p)}</code>`).join('<br>')}</td></tr>
 <tr><th>路由</th><td>${report.routes.map((r) => `<code>${esc(r)}</code>`).join('<br>')}</td></tr>
</table>

<h2>插件注册表（官方调试口径：PENDING = 静默不加载）</h2>
${renderRegistry(registry)}

<h2>客户端 bundle</h2>
${
  client
    ? `<table>
      <tr><th>panelId / key</th><td>${esc(client.panelId)}</td></tr>
      <tr><th>bundle id</th><td>${esc(client.bundleId)}</td></tr>
      <tr><th>已注册槽位</th><td>${esc(client.registeredSlots.join(', ') || '（无）')}</td></tr>
      <tr><th>数据地址</th><td>${esc(client.boardUrl)}</td></tr>
      <tr><th>上报时间</th><td>${esc(client.reportedAt)}</td></tr>
      <tr><th>UA</th><td class="muted">${esc(client.userAgent ?? '')}</td></tr>
    </table>
    ${
      client.error
        ? `<div class="bad">⚠ 客户端最近抛错（${esc(client.error.at)} · ${esc(client.error.kind)}）：<br><code>${esc(client.error.message)}</code>${
            client.error.stack !== undefined
              ? `<details><summary>堆栈</summary><pre class="muted">${esc(client.error.stack)}</pre></details>`
              : ''
          }</div>`
        : '<div class="ok">客户端未上报过错误。</div>'
    }`
    : '<div class="muted">尚未收到客户端上报。若面板已打开仍为空，说明客户端 bundle 未运行（查浏览器控制台与 /pm/debug/logs）。</div>'
}

<h2>最近诊断记录（最新在最后，${logs.length}/${esc(snapshot['logCount'])}）</h2>
<table>
 <tr><th>#</th><th>时间</th><th>级别</th><th>范围</th><th>内容</th></tr>
 ${logs
   .map(
     (l) => `<tr>
   <td>${esc(l.seq)}</td>
   <td class="muted">${esc(l.ts.replace('T', ' ').replace('Z', ''))}</td>
   <td class="lvl-${esc(l.level)}">${esc(l.level)}</td>
   <td>${esc(l.scope)}</td>
   <td><pre>${esc(l.message)}</pre></td>
 </tr>`,
   )
   .join('')}
</table>
<p class="muted">JSON 版本：<a href="?format=json">?format=json</a> · 仅日志：<a href="/pm/debug/logs">/pm/debug/logs</a></p>
</body></html>`;
}

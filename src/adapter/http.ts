/**
 * 宿主 HTTP 路由（Client 面板的数据通路）。
 *
 * **为什么走 HTTP 而不是 DSH Remote**（实测结论，DSH 0.1.5-rc.2）：
 * 三方包**无法新增** `ctx.remote.<ns>` 命名空间 —— 客户端可见的命名空间集合是
 * `@deepseek-ai/dsh-api-remotes` 里一份**构建期硬编码的导入清单**（15 个
 * `TYPERT_REMOTE` 贡献），且生成器 `@deepseek-ai/dsh-typert-generator` 未随发行版安装。
 * 而宿主 HTTP 路由是公开 API，且第三方 UI 插件 `dshmarket` 正是这么做的（26 条路由）。
 *
 * 客户端侧用 `new URL(relative, document.baseURI)` 解析，避免反代前缀丢失（见 `client/api.ts`）。
 */

import type { Context } from '@deepseek-ai/cordis';

import type { ProjectService } from '../service.ts';

/** 面板数据路由前缀。 */
export const ROUTE_PREFIX = '/pm';

/** 宿主 web 服务器的最小接口形态（避免耦合具体包类型）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (
      req: unknown,
      res: {
        writeHead(status: number, headers?: Record<string, string>): void;
        end(body?: string): void;
      },
    ) => void | Promise<void>;
  }): () => void;
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

/**
 * 注册面板数据路由。
 *
 * @returns 卸载函数；宿主没有 webServer 时返回 `undefined`（面板将显示"数据通道不可用"，
 *          而不是让插件加载失败 —— §19.4 不变量）。
 */
export function registerBoardRoutes(
  ctx: Context,
  service: ProjectService,
): (() => void) | undefined {
  const webServer = webServerOf(ctx);
  if (!webServer) return undefined;

  const sendJson = (
    res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void },
    status: number,
    payload: unknown,
  ): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const dispose = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = typeof req === 'object' && req !== null && 'url' in req
        ? String((req as { url?: unknown }).url ?? '')
        : '';
      const path = url.split('?')[0] ?? '';
      try {
        switch (path) {
          case `${ROUTE_PREFIX}/board`: {
            sendJson(res, 200, await service.board());
            return;
          }
          case `${ROUTE_PREFIX}/projects`: {
            sendJson(res, 200, { projects: await service.listProjects(), current: service.currentProjectId });
            return;
          }
          case `${ROUTE_PREFIX}/audit`: {
            sendJson(res, 200, { rows: await service.recentAudit(50) });
            return;
          }
          case `${ROUTE_PREFIX}/health`: {
            sendJson(res, 200, { ok: true, route: service.route });
            return;
          }
          default:
            sendJson(res, 404, { error: 'not-found', path });
        }
      } catch (error) {
        sendJson(res, 500, {
          error: 'internal',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  return dispose;
}

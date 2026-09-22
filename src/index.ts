/**
 * Host 面入口（§4 入口表 / §12.2）。
 *
 * 形态取自 DSH 实测契约：函数式插件导出 `name` / `inject` / `Config` / `apply`，
 * **不得有 `export default`**（否则 Loader 的 `unwrapExports` 会丢掉 `inject`）。
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

import { capabilityProbe } from './adapter/capabilities.ts';
import { createConfirmRouter } from './adapter/confirm.ts';
import { registerBoardRoutes, ROUTE_PREFIX } from './adapter/http.ts';
import { systemClock, dshRandom } from './adapter/runtime.ts';
import { ProjectService } from './service.ts';
import { registerTools } from './tools/index.ts';

export const name = 'project-manager';
/**
 * 本插件的依赖面。
 *
 * 只列出**不注入就无法工作**的服务；可选能力（approval / userQuestions / sandboxPolicy /
 * webServer）刻意不放进 `inject`，改为运行时用 `ctx.get()` 探测并按 FR-139 降级 ——
 * 否则一个可选服务缺失会让整个插件加载失败（§19.4 不变量）。
 */
export const inject = ['tools', 'storageDomain', 'fs', 'settings'];

export interface Config {
  /** 刷新间隔（毫秒），仅影响客户端轮询兜底；事件推送为主。 */
  refreshIntervalMs: number;
  /** 冲突策略（FR-82）。 */
  conflictPolicy: 'auto-fix-first' | 'always-arbitrate';
  /** 项目文档文件名（FR-01），工作区根下。 */
  documentPath: string;
  /** 快照档位偏好（FR-88）：auto 会按沙箱可写性自动裁决。 */
  snapshotMode: 'auto' | 'git' | 'patch' | 'full';
  /** AI 权重测量开关，默认关闭（FR-87/103）。 */
  aiWeightMeasurement: boolean;
}

export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number().default(1000),
  conflictPolicy: z.union([z.const('auto-fix-first'), z.const('always-arbitrate')]).default('auto-fix-first'),
  documentPath: z.string().default('project-manager.md'),
  snapshotMode: z.union([z.const('auto'), z.const('git'), z.const('patch'), z.const('full')]).default('auto'),
  aiWeightMeasurement: z.boolean().default(false),
});

/**
 * 插件主体：注册服务、工具、确认路由与能力台账。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // 1) 能力探测（FR-91/139）：任何可选能力缺失都不得阻断加载
  const capabilities = capabilityProbe(ctx);

  // 2) 存储：主路线 storageDomain；不可用时回落兜底路线（FR-124）
  const service = await ProjectService.create(ctx, {
    config,
    capabilities,
    clock: systemClock,
    random: dshRandom,
  });

  // 3) 确认路由（§6.7f / FR-135–139）：审批与提问两条 seam 的唯一出口
  const confirm = createConfirmRouter(ctx, {
    capabilities,
    clock: systemClock,
    random: dshRandom,
  });
  service.attachConfirm(confirm);

  // 4) 面板数据通路：宿主 HTTP 路由（Client 面 fetch 它）
  const disposeRoutes = registerBoardRoutes(ctx, service);

  // 5) 工具集（§13）
  const disposeTools = registerTools(ctx, service);

  // 6) 设置命名空间（schemastery；Client 侧用 ctx.settingsScope.bind 读同一份）
  try {
    ctx.settings.register('project-manager', Config);
  } catch (error) {
    ctx.logger?.warn?.(
      `[project-manager] 设置命名空间注册失败（将使用组合配置默认值）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 7) 注册为 Cordis 服务。
  //    注意：**新**服务必须用 `ctx.provide()`；`ctx.set()` 只允许覆盖**已提供**的服务，
  //    否则抛 `cannot set property "x" without provide`（首次装入 web profile 时就是这么炸的）。
  //    `provide()` 返回 disposer，随本插件 fiber 卸载自动注销。
  ctx.effect(() => {
    const disposeService = ctx.provide('projectManager', service);
    const disposeConfirm = ctx.provide('projectManagerConfirm', confirm);
    return () => {
      disposeConfirm();
      disposeService();
    };
  }, 'project-manager: services');

  ctx.effect(() => () => {
    disposeRoutes?.();
    disposeTools();
  }, 'project-manager: routes + tools');

  ctx.logger?.info?.(
    `[project-manager] 已加载：存储路线=${service.route}，审批=${capabilities.approval ? '可用' : '不可用'}，` +
      `提问=${capabilities.userQuestions ? '可用' : '不可用'}，沙箱=${capabilities.sandboxMode ?? '未知'}，` +
      `面板路由=${disposeRoutes ? ROUTE_PREFIX : '不可用'}`,
  );
}

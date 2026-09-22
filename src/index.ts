/**
 * Host 面入口（§4 入口表 / §12.2）。
 *
 * 形态取自 DSH 实测契约：函数式插件导出 `name` / `inject` / `Config` / `apply`，
 * **不得有 `export default`**（否则 Loader 的 `unwrapExports` 会丢掉 `inject`）。
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

import { capabilityProbe, type CapabilityReport } from './adapter/capabilities.ts';
import { createConfirmRouter } from './adapter/confirm.ts';
import { debugBus, newInstanceId, type PluginSelfReport } from './adapter/debug.ts';
import { registerRoutes, ROUTES, ROUTE_PREFIX } from './adapter/http.ts';
import { systemClock, dshRandom } from './adapter/runtime.ts';
import { ProjectService } from './service.ts';
import { registerTools } from './tools/index.ts';

/** 插件名（Cordis 插件名，非包名）。 */
export const name = 'project-manager';

/** 包名：CLI 读 package.json 的 name，这里保持一致（诊断页要显示它）。 */
const PACKAGE_ID = 'dsh-project-manager';

/** 构建期版本占位（未注入时回落 dev）。 */
declare const __PM_VERSION__: string | undefined;
const VERSION = typeof __PM_VERSION__ === 'string' ? __PM_VERSION__ : '0.0.0-dev';

/** 工具名清单（诊断自我描述与测试共用同一份）。 */
export const TOOL_NAMES: readonly string[] = [
  'pm_tree',
  'pm_node',
  'pm_add',
  'pm_progress',
  'pm_finish',
  'pm_focus',
  'pm_gate',
  'pm_watch',
  'pm_remove',
  'pm_board',
  'pm_doc_check',
  'pm_audit',
  'pm_snapshot',
  'pm_snapshots',
  'pm_rollback',
  'pm_rollback_undo',
  'pm_snapshot_health',
  'pm_scan',
  'pm_pause',
  'pm_hold',
  'pm_resume',
  'pm_release',
  'pm_handoff_read',
];

/** 设置命名空间。 */
export const SETTINGS_NAMESPACE = 'project-manager';

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
  /** 零 token 启发式权重系数（§9.3a：α 行数 / β 文件数 / γ 子树叶 / δ 类型）。 */
  heuristicCoefficients: {
    alpha: number;
    beta: number;
    gamma: number;
    delta: number;
  };
  /** 调试日志开关：额外的 debug 级记录进诊断总线（`/pm/debug`）。 */
  debugLogging: boolean;
}

export const Config: z<Config> = z.object({
  refreshIntervalMs: z.number().default(1000),
  conflictPolicy: z
    .union([z.const('auto-fix-first'), z.const('always-arbitrate')])
    .default('auto-fix-first'),
  documentPath: z.string().default('project-manager.md'),
  snapshotMode: z
    .union([z.const('auto'), z.const('git'), z.const('patch'), z.const('full')])
    .default('auto'),
  aiWeightMeasurement: z.boolean().default(false),
  heuristicCoefficients: z
    .object({
      alpha: z.number().min(0).default(1),
      beta: z.number().min(0).default(0.5),
      gamma: z.number().min(0).default(0.3),
      delta: z.number().min(0).default(1),
    })
    .default({ alpha: 1, beta: 0.5, gamma: 0.3, delta: 1 }),
  debugLogging: z.boolean().default(false),
});

/**
 * 插件主体：注册服务、工具、确认路由、HTTP 路由与能力台账。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = newInstanceId();
  const loadedAt = new Date().toISOString();

  // 1) 能力探测（FR-91/139）：任何可选能力缺失都不得阻断加载
  const capabilities = capabilityProbe(ctx);
  debugBus.info('apply', `开始加载实例 ${instanceId}`, capabilitySummary(capabilities));
  for (const item of capabilities.degradations) debugBus.warn('capabilities', item);

  // 2) 存储：主路线 storageDomain；不可用时回落兜底路线（FR-124）
  let service: ProjectService;
  try {
    service = await ProjectService.create(ctx, {
      config: {
        refreshIntervalMs: config.refreshIntervalMs,
        conflictPolicy: config.conflictPolicy,
        documentPath: config.documentPath,
        snapshotMode: config.snapshotMode,
        aiWeightMeasurement: config.aiWeightMeasurement,
        heuristicCoefficients: config.heuristicCoefficients,
      },
      capabilities,
      clock: systemClock,
      random: dshRandom,
    });
  } catch (error) {
    // 加载期失败必须留下可诊断的痕迹（否则只会看到一句 "plugin tree failed to load"）
    debugBus.error('storage', '存储初始化失败，插件加载中止', error);
    ctx.logger?.error?.(
      `[project-manager] 存储初始化失败：${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  debugBus.info('storage', `存储路线=${service.route}，项目=${service.currentProjectId}`);

  // 3) 确认路由（§6.7f / FR-135–139）：审批与提问两条 seam 的唯一出口
  const confirm = createConfirmRouter(ctx, {
    capabilities,
    clock: systemClock,
    random: dshRandom,
  });
  service.attachConfirm(confirm);
  debugBus.info('confirm', confirm.describeChannel());

  // 4) 工具集（§13）
  let toolNames: string[] = [];
  try {
    const disposeTools = registerTools(ctx, service);
    toolNames = [...TOOL_NAMES];
    debugBus.info('tools', `已注册 ${toolNames.length} 个工具`, { tools: toolNames });
    ctx.effect(() => () => {
      disposeTools();
      debugBus.debug('tools', '工具已注销');
    }, 'project-manager: tools');
  } catch (error) {
    debugBus.error('tools', '工具注册失败', error);
    throw error;
  }

  // 5) 设置命名空间（schemastery；Client 侧用 ctx.settingsScope.bind 读同一份）
  try {
    ctx.settings.register(SETTINGS_NAMESPACE, Config);
    debugBus.info('settings', `已注册设置命名空间 ${SETTINGS_NAMESPACE}`);
  } catch (error) {
    debugBus.warn(
      'settings',
      `设置命名空间注册失败（将使用组合配置默认值）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 6) 面板数据通路与诊断路由
  const report = buildSelfReport({
    instanceId,
    loadedAt,
    capabilities,
    storageRoute: service.route,
    toolNames,
  });
  const routes = registerRoutes(ctx, service, capabilities, report);
  if (routes) {
    ctx.effect(() => () => {
      routes.dispose();
      debugBus.debug('http', '路由已注销');
    }, 'project-manager: routes');
  }

  // 7) 外部改动监听（§15 R4/R6）：**只在被明确告知工作区根之后**启动。
  //
  //    刻意不在这里用 `DSH_WORKSPACE` / `PWD` 回落去启动 —— DSH 的 cwd 是 per-call 值，
  //    宿主进程的环境变量往往指向**另一个**目录（实测：测试进程因此监听了整个真实仓库，
  //    既误报又拖慢）。工具层第一次调用会通过 `noteWorkspaceRoot()` 告知真实 cwd，
  //    服务据此启动监听。
  debugBus.debug('watch', '监听推迟到首次工具调用（需要 per-call 的 cwd）');

  // 8) 注册为 Cordis 服务。
  //    注意：**新**服务必须用 `ctx.provide()`；`ctx.set()` 只允许覆盖**已提供**的服务，
  //    否则抛 `cannot set property "x" without provide`（首次装入 web profile 时就是这么炸的）。
  //    `provide()` 返回 disposer，随本插件 fiber 卸载自动注销。
  ctx.effect(() => {
    const disposeService = ctx.provide('projectManager', service);
    const disposeConfirm = ctx.provide('projectManagerConfirm', confirm);
    debugBus.info('services', '已 provide projectManager / projectManagerConfirm');
    return () => {
      disposeConfirm();
      disposeService();
      // 监听与路由一样必须在卸载时释放
      void service.stopWatcher();
      debugBus.info('services', '服务已注销');
    };
  }, 'project-manager: services');

  if (config.debugLogging) {
    debugBus.debug('apply', 'debugLogging 已开启：后续会记录更细的调试记录');
  }

  ctx.logger?.info?.(
    `[project-manager] 已加载：实例=${instanceId} 存储=${service.route} ` +
      `审批=${capabilities.approval ? '可用' : '不可用'} ` +
      `提问=${capabilities.userQuestions ? '可用' : '不可用'} ` +
      `沙箱=${capabilities.sandboxMode ?? '未知'} ` +
      `面板路由=${routes ? ROUTE_PREFIX : '不可用'} 诊断=${routes ? `${ROUTE_PREFIX}/debug` : '不可用'}`,
  );
}

/** 能力摘要（诊断页与日志共用）。 */
function capabilitySummary(capabilities: CapabilityReport): Record<string, unknown> {
  return {
    approval: capabilities.approval,
    userQuestions: capabilities.userQuestions,
    sandbox: capabilities.sandbox,
    sandboxMode: capabilities.sandboxMode ?? null,
    storageDomain: capabilities.storageDomain,
  };
}

/** 组装插件自我描述（诊断页显示"你到底加载成什么样"）。 */
function buildSelfReport(input: {
  instanceId: string;
  loadedAt: string;
  capabilities: CapabilityReport;
  storageRoute: string;
  toolNames: string[];
}): PluginSelfReport {
  return {
    pluginName: name,
    pluginVersion: VERSION,
    packageId: PACKAGE_ID,
    loadedAt: input.loadedAt,
    instanceId: input.instanceId,
    storageRoute: input.storageRoute,
    capabilities: {
      approval: input.capabilities.approval,
      userQuestions: input.capabilities.userQuestions,
      sandbox: input.capabilities.sandbox,
      sandboxMode: input.capabilities.sandboxMode,
      storageDomain: input.capabilities.storageDomain,
      webServer: true,
    },
    degradations: input.capabilities.degradations,
    registeredTools: input.toolNames,
    settingsNamespaces: [SETTINGS_NAMESPACE],
    routes: [...ROUTES],
    client: undefined,
  };
}

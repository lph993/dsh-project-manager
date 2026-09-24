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
import {
  registerRoutes,
  ROUTES,
  ROUTE_PREFIX,
  type SettingsScopeLike,
} from './adapter/http.ts';
import { systemClock, dshRandom } from './adapter/runtime.ts';
import {
  PM_CONTEXT_NAME,
  PM_CONTEXT_ORDER,
  PM_SECTION_NAME,
  PM_SECTION_ORDER,
  boundFactsText,
  progressDisciplineText,
} from './session/prompt.ts';
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
  'pm_unwatch',
  'pm_watchers',
  'pm_watch_conflicts',
  'pm_watch_wait',
  'pm_watch_arbitrate',
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
  'pm_report',
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
  /**
   * 零 token 启发式权重轨开关（§9.3a），**默认关闭**。
   *
   * 节点是功能点/任务点：进度说的是"这个任务做完多少"，而"已有代码的行数"
   * 回答不了"还剩多少要写"（未写的代码没有行数）。默认口径为**按件数**。
   */
  heuristicWeight: boolean;
  /** 零 token 启发式权重系数（§9.3a：α 行数 / β 文件数 / γ 子树叶 / δ 类型）。 */
  heuristicCoefficients: {
    alpha: number;
    beta: number;
    gamma: number;
    delta: number;
  };
  /** AI 建树的模型路由（FR-81a）；留空则跟随宿主默认模型。 */
  aiProvider: string;
  aiModel: string;
  /** 单次 AI 建树的输出 token 上限（FR-81b 的预算闸门）。 */
  aiMaxOutputTokens: number;
  /** 阶段 A 扫描的目录深度上限（FR-81）。 */
  scanMaxDepth: number;
  /** 关键事件回写会话（FR-112/113），默认开启。 */
  notifyKeyEvents: boolean;
  /** 静默模式（FR-116）：彻底关闭回写（写入面与文件锁不受影响）。 */
  notifySilent: boolean;
  /** 单目录最多展开多少子项（FR-81，防根目录巨大时节点爆炸）。 */
  scanMaxChildrenPerDir: number;
  /** 单次扫描最多产出多少节点（硬上限，超出即截断并如实标注）。 */
  scanMaxNodes: number;
  /** 包含 glob（空数组 = 全部）；FR-81。 */
  scanInclude: string[];
  /** 排除 glob；会**叠加**在内置默认排除项之上（`node_modules` 等始终排除）。 */
  scanExclude: string[];
  /** 调试日志开关：额外的 debug 级记录进诊断总线（`/pm/debug`）。 */
  debugLogging: boolean;
  /**
   * 会话边界（子代理 / 回合 / 会话结束）上的进度修正，**默认开启**（零 token）。
   *
   * 关掉它 = 插件完全不介入边界：既不推状态，也不提醒。
   */
  sessionBoundaryWriteback: boolean;
  /**
   * 把"进度纪律"讲给模型听（系统提示词静态段 + 缓存安全的动态事实），**默认开启**。
   *
   * 只影响"模型被告知"：关掉后边界上的零 token 状态推进照旧生效。
   */
  sessionBoundaryPrompt: boolean;
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
  heuristicWeight: z.boolean().default(false),
  heuristicCoefficients: z
    .object({
      alpha: z.number().min(0).default(1),
      beta: z.number().min(0).default(0.5),
      gamma: z.number().min(0).default(0.3),
      delta: z.number().min(0).default(1),
    })
    .default({ alpha: 1, beta: 0.5, gamma: 0.3, delta: 1 }),
  aiProvider: z.string().default(''),
  aiModel: z.string().default(''),
  aiMaxOutputTokens: z.number().min(1).default(8192),
  // 扫描默认值对齐 FR-81（深度 3；排除 node_modules/dist/.git），
  // 与 `domain/scanner.ts` 的 DEFAULT_SCAN_OPTIONS 保持同一份口径。
  scanMaxDepth: z.number().min(1).max(12).default(3),
  scanMaxChildrenPerDir: z.number().min(1).max(200).default(12),
  scanMaxNodes: z.number().min(1).max(2000).default(200),
  notifyKeyEvents: z.boolean().default(true),
  notifySilent: z.boolean().default(false),
  scanInclude: z.array(z.string()).default([]),
  scanExclude: z.array(z.string()).default([]),
  debugLogging: z.boolean().default(false),
  sessionBoundaryWriteback: z.boolean().default(true),
  sessionBoundaryPrompt: z.boolean().default(true),
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
        heuristicWeight: config.heuristicWeight,
        heuristicCoefficients: config.heuristicCoefficients,
        aiProvider: config.aiProvider,
        aiModel: config.aiModel,
        aiMaxOutputTokens: config.aiMaxOutputTokens,
        scanMaxDepth: config.scanMaxDepth,
        scanMaxChildrenPerDir: config.scanMaxChildrenPerDir,
        scanMaxNodes: config.scanMaxNodes,
        notifyKeyEvents: config.notifyKeyEvents,
        notifySilent: config.notifySilent,
        scanInclude: config.scanInclude,
        scanExclude: config.scanExclude,
        sessionBoundaryWriteback: config.sessionBoundaryWriteback,
        sessionBoundaryPrompt: config.sessionBoundaryPrompt,
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
  //
  //    这里**保留 scope 句柄**并订阅变更：设置页改一项 → 立即套用到运行中的服务
  //    （`applies: 'live'`，因为扫描 glob / AI 路由 / 刷新间隔都是"下次用到时读"，
  //    不需要重启宿主）。改不了的是"已经发出去的调用"，如实写在设置页的说明里。
  let disposeSettingsWatch: (() => void) | undefined;
  let settingsScope: SettingsScopeLike | undefined;
  try {
    const scope = ctx.settings.register(SETTINGS_NAMESPACE, Config, { applies: 'live' });
    settingsScope = scope as unknown as SettingsScopeLike;
    const applyPatch = (next: Config, prev: Config): void => {
      const patch: Partial<Config> = {};
      for (const key of Object.keys(next) as Array<keyof Config>) {
        if (next[key] !== prev[key]) (patch as Record<string, unknown>)[key] = next[key];
      }
      if (Object.keys(patch).length === 0) return;
      service.applyConfig(patch);
      debugBus.info('settings', `设置变更已生效：${Object.keys(patch).join(', ')}`);
    };
    disposeSettingsWatch = scope.watch((next, prev) => {
      try {
        applyPatch(next, prev);
      } catch (error) {
        debugBus.error('settings', '套用设置变更失败', error);
      }
    });
    ctx.effect(() => () => disposeSettingsWatch?.(), 'project-manager: settings watch');
    debugBus.info('settings', `已注册设置命名空间 ${SETTINGS_NAMESPACE}（applies=live，已订阅变更）`);
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
  const routes = registerRoutes(ctx, service, capabilities, report, settingsScope);
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

  // 9) **会话边界 → 进度修正**（本次新增的核心能力）。
  //
  //    官方口径（`docs/agent-lifecycle.zh.md` 与 cordis Events 目录）：
  //    - `agent/status` 的 `idle` = 一次回合关闭（子任务做完一段）；
  //    - `agent/disposed` = 子代理/会话结束，最后一次机会。
  //    两者都是 **emit**（非 waterfall）事件：不能拦截流程，只能做副作用 —— 正好，这里的
  //    副作用就是"零 token 的状态推进 + 一条不唤醒 agent 的上下文"。
  //
  //    为什么不用 `agent/turn-stopping`：那是 serial 事件、在别人的回合收尾路径上 await，
  //    写盘/投递会拖慢（或拖坏）别人的回合。边界修正不是"回合的一部分"，是**事后**补救。
  const onBoundary = (kind: 'turn-end' | 'agent-disposed', actorId: string): void => {
    void service
      .sessionBoundary({ kind, actorId })
      .then((outcome) => {
        if (outcome.patches > 0 || outcome.reminded) {
          debugBus.debug(
            'session',
            `边界修正（${kind}）：推进 ${outcome.patches} 项，提醒=${outcome.reminded ? '已投递' : '无'}`,
            { actorId },
          );
        }
      })
      .catch((error) => {
        // 边界回调抛错会污染别人的回合/卸载路径：必须吞掉，但**留下痕迹**（不静默）
        debugBus.warn(
          'session',
          `边界修正失败（${kind}）：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', (payload) => {
      if (payload.status !== 'idle') return; // running 只表示"开始干活"，不是边界
      onBoundary('turn-end', payload.agent.id);
    });
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      onBoundary('agent-disposed', payload.agent.id);
    });
    debugBus.info('session', '已挂载 agent/status(idle) 与 agent/disposed 的边界修正');
    return () => {
      offDisposed();
      offStatus();
      debugBus.debug('session', '边界修正已卸载');
    };
  }, 'project-manager: session-boundary');

  // 10) 把"进度纪律"讲给模型听：静态段 + 缓存安全的动态事实（官方 system-prompt 两个机制）。
  //     这一层与第 9 步互补：宿主只能推 `pending → running`，**真实数字只有干活的模型知道**，
  //     所以要给它一条"收尾前用 pm_report 汇报"的纪律，以及"你绑了哪些还没做完"的实时事实。
  registerProgressPrompt(ctx, service);

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

/**
 * 宿主 system-prompt 服务的最小结构面。
 *
 * 刻意**不** `import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'`：
 * 那会把该包的类型增补拉进编译图（进而把 `ctx.systemPrompt` 变成"必需服务"），
 * 而这里要表达的是"有就用、没有就如实降级"。契约本身就是这两个方法。
 */
interface SystemPromptLike {
  section(section: {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
    complete?: boolean;
  }): () => void;
  context(context: {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
  }): () => void;
}

/**
 * 取宿主 system-prompt 服务。
 *
 * **实测教训（真机发现的）**：只靠"属性 + `ctx.get()`"两种读法在真宿主上**拿不到**服务 ——
 * 未在 `inject` 里声明的服务在 cordis 里是 PENDING 的：属性读回来是个**不是 null 但没有方法**的
 * 待定对象，于是结构化检查（`typeof section === 'function'`）判定为"不可用"，
 * 结果整个提示词层**静默没注册**（`/pm/debug` 里只留一句"宿主未提供 systemPrompt 服务"）。
 * 假上下文测试完全看不到这一点（替身没有 PENDING 语义）。
 *
 * 正确姿态是官方文档给的那条：`ctx.inject(['systemPrompt'], (scoped) => …)` —— 声明依赖，
 * 等服务就绪后再注册。这里保留直读作为**测试替身/旧宿主**的回退路径。
 */
function systemPromptOf(ctx: Context): SystemPromptLike | undefined {
  try {
    const holder = ctx as unknown as Record<string, unknown>;
    const candidates = [
      holder['systemPrompt'],
      (holder['get'] as ((name: string) => unknown) | undefined)?.call(ctx, 'systemPrompt'),
      // 官方反射读法：`ctx.reflect.get(name, strict=false)` —— 不要求已在 inject 里声明
      (
        (holder['reflect'] as { get?: (name: string, strict?: boolean) => unknown } | undefined)?.get
      )?.call(holder['reflect'], 'systemPrompt', false),
    ];
    for (const service of candidates) {
      if (service === undefined || service === null) continue;
      const candidate = service as Partial<SystemPromptLike>;
      if (typeof candidate.section === 'function' && typeof candidate.context === 'function') {
        return candidate as SystemPromptLike;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 把"到底读到了什么"写进诊断（下次真机再拿不到时，不用再猜）。 */
function describeSystemPromptProbe(ctx: Context): string {
  const describe = (value: unknown): string => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const candidate = value as Partial<SystemPromptLike>;
    if (typeof candidate.section === 'function') return 'service(section✓)';
    return `${typeof value}(无 section)`;
  };
  try {
    const holder = ctx as unknown as Record<string, unknown>;
    return [
      `property=${describe(holder['systemPrompt'])}`,
      `get=${describe((holder['get'] as ((name: string) => unknown) | undefined)?.call(ctx, 'systemPrompt'))}`,
      `reflect=${describe(
        (
          (holder['reflect'] as { get?: (name: string, strict?: boolean) => unknown } | undefined)?.get
        )?.call(holder['reflect'], 'systemPrompt', false),
      )}`,
      `inject=${typeof holder['inject']}`,
    ].join(' ');
  } catch (error) {
    return `探测抛错：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 注册"进度纪律"提示词（静态段）与"你绑了哪些未完成节点"（动态、缓存安全）。
 *
 * 两个 provider 都返回**当前配置下**的文本：关掉开关后返回空串，官方口径是"空段不贡献内容"，
 * 于是设置页改一项就立刻生效，不需要重新注册（注册是 apply 期的一次性动作）。
 *
 * 注册结果如实写回服务（设置页据此显示"提示词纪律到底有没有挂上"）—— 早先这里只写日志，
 * 而设置页照样显示"状态推进 + 提示词纪律"，**那是一句不实的陈述**。
 */
function registerProgressPrompt(ctx: Context, service: ProjectService): void {
  const attempt = (host: Context): void => {
    const systemPrompt = systemPromptOf(host);
    if (systemPrompt === undefined) {
      service.notePromptRegistration('unavailable');
      debugBus.warn(
        'prompt',
        `宿主未提供 systemPrompt 服务：进度纪律段未注册（边界上的零 token 状态推进不受影响）｜${describeSystemPromptProbe(host)}`,
      );
      return;
    }
    host.effect(() => {
      // 静态段：provider 每次组装都被调用，但**返回常量** → 渲染不变 → 前缀缓存不动。
      const disposeSection = systemPrompt.section({
        name: PM_SECTION_NAME,
        order: PM_SECTION_ORDER,
        text: () => (service.boundaryPromptEnabled() ? progressDisciplineText() : ''),
      });
      // 动态事实：官方语义是"缓存安全的持久快照"，只在快照变化时重新记录。
      const disposeContext = systemPrompt.context({
        name: PM_CONTEXT_NAME,
        order: PM_CONTEXT_ORDER,
        text: (assembly: unknown) => {
          if (!service.boundaryPromptEnabled()) return '';
          const actorId = (assembly as { agent?: { id?: string } } | undefined)?.agent?.id;
          return boundFactsText(service.boundFactsOf(actorId)) ?? '';
        },
      });
      debugBus.info(
        'prompt',
        `已注册提示词段 ${PM_SECTION_NAME}（order=${PM_SECTION_ORDER}）与动态事实 ${PM_CONTEXT_NAME}（order=${PM_CONTEXT_ORDER}）`,
      );
      service.notePromptRegistration('registered');
      return () => {
        disposeContext();
        disposeSection();
        debugBus.debug('prompt', '提示词贡献已注销');
      };
    }, 'project-manager: progress prompt');
  };

  // 官方姿态：声明依赖，服务就绪后再注册（未就绪时该注入纤维保持 PENDING，不影响插件其余部分）。
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (scoped: Context) => void) => unknown;
  }).inject;
  if (typeof inject === 'function') {
    service.notePromptRegistration('pending');
    inject.call(ctx, ['systemPrompt'], (scoped: Context) => attempt(scoped));
    return;
  }
  // 回退：测试替身 / 不提供 inject 的旧宿主 —— 直接试一次
  attempt(ctx);
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


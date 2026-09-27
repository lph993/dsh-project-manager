/**
 * Host 面入口（§4 入口表 / §12.2）。
 *
 * 形态取自 DSH 实测契约：函数式插件导出 `name` / `inject` / `Config` / `apply`，
 * **不得有 `export default`**（否则 Loader 的 `unwrapExports` 会丢掉 `inject`）。
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

import { capabilityProbe, effectiveSandboxMode, serviceOf, type CapabilityReport } from './adapter/capabilities.ts';
import { execViewOf, sessionOfAgent, touchedPathsOf } from './adapter/exec-view.ts';
import { crossProjectVerdict, describeReviewVerdict } from './domain/review-gate.ts';
import { createConfirmRouter } from './adapter/confirm.ts';
import { debugBus, newInstanceId, type PluginSelfReport } from './adapter/debug.ts';
import { guardAskFor } from './tools/guard.ts';
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
import { DEFAULT_AI_MAX_OUTPUT_TOKENS } from './ai/prompt.ts';
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
  'pm_next',
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
  /** 改父节点（修正建树留下的层级/重复分支）。内核是 `reparentSubtree`（成环保护 + 审计）。 */
  'pm_move',
  /** 节点审查（FR-164）：list / mark / pass（pass 连带整枝一起清 = 遗传）。 */
  'pm_review',
  /**
   * 重复枝合并**计划**（FR-158 ⑥ 的执行体，只读）：把"先搬谁、并哪处进度、删哪个空壳"
   * 直接算给会话看 —— 以前这活儿是我人肉读脚本 + 手工 pm_move/pm_remove，那是数据操作不是能力。
   */
  'pm_consolidate',
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
  /**
   * 单次 AI 建树的输出 token 上限（FR-81b 的预算闸门）。
   *
   * **`0`（默认）= 跟随宿主**：不向模型传 `maxTokens`，由宿主的适配器按该模型配置的上限落地
   * （`LlmResolvedModelInfo.defaultMaxTokens`，即模型设置里的"最大输出 token 数"）。
   * 用户口径："上限应该和 harness 参数持平"。
   */
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
  /**
   * **自动接续**（FR-162 ②），**默认关**。
   *
   * 开启后提示词里多一句"做完一个节点就用 `pm_next` 取下一条接着做，不必等用户说继续"。
   * **绝不自动唤醒会话**（T11：唤醒 = 自动花钱）——它只改"模型被告知什么"。
   */
  autoContinue: boolean;
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
  aiMaxOutputTokens: z.number().min(0).default(DEFAULT_AI_MAX_OUTPUT_TOKENS),
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
  autoContinue: z.boolean().default(false),
});

/**
 * 插件主体：注册服务、工具、确认路由、HTTP 路由与能力台账。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  /**
   * **装配失败必须喊出来**（2026-09-25 真机教训）。
   *
   * 起因：打开 HMR 后构建 `lib/`，插件被卸载（`/pm/*` 全 404）却**装不回来**，
   * 而宿主终端（`dsh web 2>&1 | Tee-Object .tmp-web.log`）里**一行报错都没有** ——
   * "哪一步失败"完全靠猜；插件侧更看不到：没装起来就没有 `/pm/debug`。
   *
   * 所以这里在**唯一入口**兜一层：任何一步抛错都写到 `ctx.logger.error`（宿主终端 + 日志文件）
   * 与诊断总线（若随后装起来还能在 `/pm/debug` 看到），然后**原样重抛** ——
   * 只加可观测性，不改失败语义（宿主该判加载失败还是判加载失败）。
   */
  try {
    await applyInner(ctx, config);
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
    debugBus.error('apply', `装配失败：${detail}`, error);
    ctx.logger?.error?.(`[project-manager] 装配失败：${detail}`);
    throw error;
  }
}

async function applyInner(ctx: Context, config: Config): Promise<void> {
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
        autoContinue: config.autoContinue,
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
  /**
   * **宿主错误 → 诊断总线**（FR-174："failed hook、错误日志警示"）。
   *
   * 为什么值得单独挂：插件/hook 抛错时，宿主往往**只在终端里打一行**，
   * 而面板那侧什么都看不到 —— 用户看到的现象是"某个功能就是不动"，
   * 却没有任何线索说"有一次 hook 失败了"。这里把它收进诊断总线，
   * 状态条就能显示"最近有 N 条错误"并一步跳到 `/pm/debug` 看原文。
   *
   * **绝不改行为**：只记录，不 `preventDefault`、不返回任何值（错误语义归宿主）。
   */
  ctx.effect(() => {
    const describeError = (payload: unknown): string => {
      if (payload instanceof Error) return payload.message;
      if (payload === null || typeof payload !== 'object') return String(payload);
      const record = payload as Record<string, unknown>;
      for (const key of ['message', 'reason', 'error', 'detail']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '') return value;
        if (value instanceof Error) return value.message;
      }
      try {
        return JSON.stringify(payload).slice(0, 300);
      } catch {
        return String(payload);
      }
    };
    const offError = ctx.on('agent/error', (payload: { error?: unknown }) => {
      debugBus.error('host', `会话出错：${describeError(payload?.error ?? payload)}`, payload);
    });
    /**
     * `agent/request-error` 是**单步瀑布**（`payload + next → RequestErrorAction`）：
     * 我们只记录、**必须把 `next()` 的结果原样返回**，绝不改重试判定（那是宿主的事）。
     */
    const offRequestError = ctx.on('agent/request-error', (payload: { failure?: unknown }, next) => {
      debugBus.error('host', `模型请求失败：${describeError(payload?.failure ?? payload)}`, payload);
      return next();
    });
    return () => {
      offError();
      offRequestError();
    };
  }, 'project-manager: host-error-capture');

  ctx.effect(() => {
    const offStatus = ctx.on('agent/status', (payload) => {
      /**
       * **会话忙闲记账**（用户口径："正在会话的没有从播放三角切换到 loading"）。
       *
       * 早先这里只认 `idle`（那是"一次回合结束"的边界信号，用来做进度修正），
       * 于是面板**根本不知道会话正在干活**：一个节点被启动后只要 90s 内没有新的写入，
       * 就被判成"没人跑"、画成 ▶ 播放三角 —— 而会话其实正在跑。
       * 现在 `running` / `idle` 都记账，看板把它带给客户端，图标判据就能看见真相。
       */
      service.noteSessionActivity(payload.agent.id, payload.status);
      if (payload.status !== 'idle') return; // running 只表示"开始干活"，不是边界
      onBoundary('turn-end', payload.agent.id);
    });
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      service.noteSessionActivity(payload.agent.id, 'disposed');
      onBoundary('agent-disposed', payload.agent.id);
    });
    debugBus.info('session', '已挂载 agent/status(idle) 与 agent/disposed 的边界修正');
    return () => {
      offDisposed();
      offStatus();
      debugBus.debug('session', '边界修正已卸载');
    };
  }, 'project-manager: session-boundary');

  /**
   * **破坏性操作的审批门**（用户口径："动功能点（删除／性质上的修改）属于危险操作，任务点没问题"；
   * 并且"这个权限也需要弹窗审批的，但是不用弹其他不相关的"）。
   *
   * 宿主的审批策略只有一个会话级旋钮（`ask | never`），做不到"只弹该弹的" ——
   * 所以由本钩子**自己声明**：只对 `pm_remove` / `pm_rollback` / `pm_rollback_undo`
   * 返回 `ask`（宿主随后请求一次性授权），**其余 `pm_*` 一律 `next()` 放行**，不打扰用户。
   *
   * **完全权限（`danger-full-access`）⇒ 一律放行**（用户口径："完全权限不需要审核可以直接进行
   * 节点危险操作"）：那是用户在会话级显式选的"我信任你直接做"，再逐个弹窗等于把他的表态再问一遍。
   */
  ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as { kind?: string } | undefined;
      // 已经有人给了明确判断（deny 等）就尊重它，不覆盖
      if (decision !== undefined && decision.kind === 'deny') return decision as never;
      /**
       * **字段名必须按宿主契约读**（`exec.name` / `exec.agent`）——
       * 早先这里读的是 `exec.toolName` 与 `exec.session`，真机上是 `undefined`，
       * 于是这道审批门**静默失效**（返回值永远走 `next()`）。详见 `adapter/exec-view.ts`。
       */
      const view = execViewOf(exec);
      if (view.toolName === undefined) return decision as never;
      const toolName = view.toolName;
      /**
       * **判据必须是"这个会话此刻实际生效的档位"，不是"部署默认档位"**（真机实测踩到）。
       *
       * 起因：用户明明在**完全权限**下，插件却仍然请求审批，而本会话审批策略是 `never`
       * ⇒ 删除被**确定性拒绝**（`policy-never`），看起来像"完全权限也没用"。
       * 查下来：`ctx.sandboxPolicy.mode` 是 **`defaultMode`（部署默认）** —— 宿主自己的类型注释写着
       * "Phase：File-sandbox mode a session **starts from**"；用户在运行时切的档位记录成
       * 该会话的 **`sandbox/mode` 事件**，实际生效值是 `resolve({session})` 折出来的
       * （显式授权 > 会话 override > 部署默认）。
       * 我们此前只读了部署默认（本机 `cordis.patch.yml` 的「项目进度」档 = `workspace-write`），
       * 于是"完全权限免审核"（FR-163）在**运行时切档**的情形下从来没生效过。
       *
       * **第二处（同一次排查里发现）**：`resolve({session})` 要的是**会话对象**，而钩子拿到的
       * `exec.agent` 才携带它（`agent.session`）。会话对象读不到时用 `agent.id` 去 `agents`
       * 注册表换一个 —— 换不到才退到部署默认（保守：宁可多问一次，也不冒充"完全权限"）。
       */
      const session = sessionOfAgent(ctx, { session: view.session, id: view.sessionId });
      const liveMode = effectiveSandboxMode(ctx, session);
      const ask = guardAskFor(toolName, liveMode ?? capabilities.sandboxMode);
      if (ask === undefined) return decision as never;
      debugBus.info('tools', `破坏性操作请求审批：${toolName}（${ask.reason}）`);
      return ask as never;
    });
    return () => {
      off();
      debugBus.debug('tools', '破坏性操作审批门已卸载');
    };
  }, 'project-manager: destructive-guard');

  /**
   * **跨子项目写入的审核门**（FR-161）。
   *
   * 判据在纯函数里（`domain/review-gate.ts`，13 条单测钉住），这里只做三件事：
   * ① 只对**文件写入类**工具判（`write` / `edit` / `str_replace_editor`）—— 别的工具不改文件；
   * ② 路径从参数里读（`execViewOf` 一处收敛），读不出来 ⇒ 不拦（**不猜**）；
   * ③ 按"当场能不能征询"决定：完全权限不拦；策略 `never` 时**拦不了**，就如实留痕（不许装作问过了）。
   *
   * **为什么完全权限不拦**（与 FR-163 一致）：那是用户在会话级显式选的"我信任你直接做"；
   * 而 `never` 时**不拦**是因为拦的后果是**确定性拒绝**（写代码这种日常活儿被整片堵死），
   * 比"漏一次提醒"糟得多 —— 所以改为在诊断总线留一条 warn（状态条的警示角标会亮起来，
   * 用户看得到"哪些改动影响了别的任务线"），而不是假装审核过了。
   */
  ctx.effect(() => {
    const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);
    const off = ctx.on('tools/pre-execute', async (exec: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as { kind?: string } | undefined;
      if (decision !== undefined && decision.kind === 'deny') return decision as never;
      const view = execViewOf(exec);
      if (view.toolName === undefined || !WRITE_TOOLS.has(view.toolName)) return decision as never;
      const paths = touchedPathsOf(view.args);
      if (paths.length === 0) return decision as never;
      const nodes = await service.reviewIndexOf();
      const verdict = crossProjectVerdict(paths, nodes);
      if (!verdict.required) return decision as never;

      const reason = describeReviewVerdict(verdict);
      const session = sessionOfAgent(ctx, { session: view.session, id: view.sessionId });
      const liveMode = effectiveSandboxMode(ctx, session) ?? capabilities.sandboxMode;
      if (liveMode === 'danger-full-access') {
        debugBus.info('review', `跨任务线改动（完全权限，按用户表态放行）：${reason}`, { paths });
        return decision as never;
      }
      const policy =
        (serviceOf<{ overrideOf?: (session: unknown) => string | undefined }>(ctx, 'approval')?.overrideOf?.(
          session,
        ) ?? 'ask') as string;
      if (policy === 'never') {
        debugBus.warn('review', `跨任务线改动，但本会话审批策略为 never（无法征询，已如实放行）：${reason}`, {
          paths,
        });
        return decision as never;
      }
      debugBus.info('review', `跨任务线改动请求审核：${reason}`, { paths });
      return { kind: 'ask', reason } as never;
    });
    return () => {
      off();
      debugBus.debug('review', '跨子项目写入审核门已卸载');
    };
  }, 'project-manager: cross-project-review');

  // 10) 把"进度纪律"讲给模型听：静态段 + 缓存安全的动态事实（官方 system-prompt 两个机制）。
  //     这一层与第 9 步互补：宿主只能推 `pending → running`，**真实数字只有干活的模型知道**，
  //     所以要给它一条"收尾前用 pm_report 汇报"的纪律，以及"你绑了哪些还没做完"的实时事实。
  registerProgressPrompt(ctx, service);

  // 11) `agents` 注册表：**边界提醒与关键事件回写都靠它**，同样必须走官方声明式注入。
  //
  //     真机实测（同一个坑踩了第二次）：未在插件 `inject` 里声明的服务在 cordis 里是 PENDING 的，
  //     `ctx.get('agents')` 返回 undefined ⇒ "关键事件回写会话"（FR-112）与"边界提醒"在真实宿主里
  //     **一条都没投出去**，而统计里只看到 `notify.sent = 0`（看不出那是失败），调试页也一片安静。
  //     只读引用、缺了不阻断加载 ⇒ 用 `inject` 拿，而不是写进插件 `inject` 数组。
  //
  //     **必须包在 `ctx.effect` 里**（2026-09-25 修）：`inject` 的回调会注册在注入纤维上，
  //     而**卸载时只有 effect 会被回收**。早先这里是直接调用 ⇒ 任何"先卸载再装配"的路径
  //     （HMR 重载、升级、二次 apply）都会**再挂一个回调**：agents 服务会被重复 attach、
  //     日志重复打印，真机 HMR 实验里"卸载后装不回来"就是在这类未回收的注册上翻车的。
  ctx.effect(() => {
    const attach = (scoped: Context): void => {
      const holder = scoped as unknown as {
        agents?: unknown;
        get?: (name: string) => unknown;
        reflect?: { get?: (name: string, strict?: boolean) => unknown };
      };
      const agents =
        holder.agents ?? holder.get?.('agents') ?? holder.reflect?.get?.('agents', false);
      if (agents === undefined || agents === null) {
        debugBus.warn(
          'notify',
          'agents 服务不可用：关键事件回写与边界提醒将投不出去（其余功能不受影响）',
        );
        return;
      }
      service.attachAgents(agents);
      debugBus.info('notify', '已取得 agents 服务：关键事件回写与边界提醒可用');
    };
    const injectAgents = (ctx as unknown as {
      inject?: (deps: string[], callback: (scoped: Context) => void) => unknown;
    }).inject;
    /**
     * `inject` 返回它自己的 disposer（若宿主提供）⇒ 卸载时**一并释放**，
     * 免得重载后同一个回调挂着两遍。拿不到就退化为"只在 effect 卸载时标记失效"。
     */
    let disposed = false;
    const disposeInject =
      typeof injectAgents === 'function'
        ? (injectAgents.call(ctx, ['agents'], (scoped: Context) => {
            if (disposed) return;
            attach(scoped);
          }) as (() => void) | undefined)
        : (attach(ctx), undefined);
    return () => {
      disposed = true;
      try {
        disposeInject?.();
      } catch {
        // 卸载期异常忽略（与其它 effect 一致）
      }
    };
  }, 'project-manager: agents-inject');

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
        text: () => (service.boundaryPromptEnabled() ? progressDisciplineText(service.autoContinueEnabled()) : ''),
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


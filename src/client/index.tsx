/**
 * Client 面入口：侧边栏面板项 + 主面板 + 设置页分区（§4 入口表）。
 *
 * 关键契约（实测自 DSH 0.1.5-rc.2 的真实 bundle 调用点）：
 * - 侧边栏是 `sidebar.panellist`（**list** / root）：注册项要 `id` / `order` / `label`，
 *   **组件只渲染图标**（外层的按钮、tooltip、label 文案都由侧边栏自己渲染）。
 * - 主内容区是 `main`（**keyed** / root）：注册项要 `key`，其值**必须等于**侧边栏项的 `id`，
 *   否则 `ctx.layout.selectPanel()` 会抛 "main panel ... is not registered"。
 * - 设置页是 `settings.section`（**list** / root）：注册项要 `id` / `order` / `label`；
 *   没有 `title` 字段，分区标题就是 `label`。
 * - `export const inject` 用的是 **cordis 服务短名**（`slots` 等），
 *   与 package.json 里 `dsh.client.inject` 的**包名**是两回事。
 */

import * as React from 'react';

import type { ClientContext } from './dsh-client.d.ts';
import { reportClient } from './api.ts';
import { BoardPanel } from './board-panel.tsx';
import { setResourceOpener } from './navigation.ts';
import { RightProgressTab } from './right-tab.tsx';
import { SettingsSection } from './settings-section.tsx';

/** 侧边栏项 id 与 main 槽 key：两者必须一致。 */
export const PANEL_ID = 'project-manager';

/** 右栏页签的类型标识（stage 1 的 `kind`）与实现标识（stage 2 挂在它下面的 `key`）。 */
const RIGHT_TAB_KIND = 'project-manager-progress';
/** 实现 id 取包名：注册表要求它在所有注册里唯一（kind 才允许被扩展覆盖）。 */
const RIGHT_TAB_ID = 'dsh-project-manager';

/** HMR / 卸载时用于定位本插件注入的样式标签。 */
const PACKAGE_ID = 'dsh-project-manager';

/** 构建期版本占位（未注入时回落 dev）；宿主与客户端用同一个宏。 */
declare const __PM_VERSION__: string | undefined;

/**
 * cordis 服务依赖（短名）。
 *
 * **按官方姿态声明**（`dsh-client-ui-sidebar-documentpreview` 同款）：用到的服务一律写进 `inject`，
 * 由 cordis 保证"服务到位才装配"，而不是运行时探测 + 静默降级 —— 后者会让"右栏没加载"
 * 表现成"少了个页签但没有任何线索"，排查起来只能猜。
 */
export const inject: string[] = ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout'];

const CSS = `
.pm-glyph { display: block; }
.pm-glyph rect { transition: fill 120ms ease-out; }
`;

/** 注入样式：符合 DSH 约定（`data-plugin` + `data-plugin-css`，HMR 按属性回收）。 */
function injectStyles(): () => void {
  const existing = document.querySelector(`style[data-plugin="${PACKAGE_ID}"]`);
  if (existing) existing.remove();
  const tag = document.createElement('style');
  tag.dataset['plugin'] = PACKAGE_ID;
  tag.dataset['pluginCss'] = `${PACKAGE_ID}/client.css`;
  tag.textContent = CSS;
  document.head.append(tag);
  return () => tag.remove();
}

/**
 * 侧边栏图标：**只画图标**。
 *
 * 侧边栏会把它包进自己的 `<button aria-label>`，并在展开时在旁边渲染 label 文本；
 * 因此这里返回带文字的整行会导致标签重复。
 */
function PanelGlyph(props: { size?: number; active?: boolean }): React.ReactElement {
  const size = props.size ?? 16;
  const active = props.active === true;
  // 用 `currentColor` 让图标跟随侧边栏文字色（主题安全）；激活态靠不透明度区分层级，
  // 不写死颜色值 —— 避免在浅色/深色主题下撞色。
  const tone = active ? 1 : 0.85;
  return React.createElement(
    'svg',
    {
      className: 'pm-glyph',
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    // 进度看板意象：三根不同高度的柱 + 一条基线（形状区分，不只靠颜色）
    React.createElement('rect', {
      x: 2,
      y: 9,
      width: 3,
      height: 5,
      rx: 1,
      fill: 'currentColor',
      opacity: tone,
    }),
    React.createElement('rect', {
      x: 6.5,
      y: 5,
      width: 3,
      height: 9,
      rx: 1,
      fill: 'currentColor',
      opacity: active ? tone : 0.65,
    }),
    React.createElement('rect', {
      x: 11,
      y: 7,
      width: 3,
      height: 7,
      rx: 1,
      fill: 'currentColor',
      opacity: active ? tone : 0.45,
    }),
    React.createElement('rect', {
      x: 2,
      y: 14.4,
      width: 12,
      height: 1,
      rx: 0.5,
      fill: 'currentColor',
      opacity: 0.5,
    }),
  );
}

/**
 * 右侧边栏页签的注册（stage 1 类型 + stage 2 内容）。
 *
 * 形态取自官方 `dsh-client-ui-sidebar-documentpreview` 的真实 bundle 调用点：
 * - stage 1：`ctx.sidebarRightTabs.register({ id, kind, title, guide, priority })`
 *   —— **页码类型不写 `patterns`**（`patterns` 是给 `dsh-resource://…` 地址用的）；
 * - stage 2：`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))`，
 *   `key` 必须等于 stage 1 的 `id`（注册表按"在位的那个实现的 id"派发内容）。
 *
 * `guide` 是用户**打开**它的入口：右栏的 guide 页会列出这些胶囊，点一下按 kind 开页。
 * 没有 guide 项，页签类型就只能被代码打开，用户找不到。
 */
function registerRightTab(ctx: ClientContext, registeredSlots: string[]): void {
  const registry = ctx.sidebarRightTabs;
  if (registry === undefined || typeof registry.register !== 'function') {
    // 写了 `inject` 却还是拿不到：这是**装配出了问题**，必须留痕（而不是静默少个页签）
    reportRightTabFailure(new Error('sidebarRightTabs 服务不可用（inject 已声明）'), 'service');
    return;
  }

  try {
    ctx.effect(
      () =>
        registry.register({
          id: RIGHT_TAB_ID,
          kind: RIGHT_TAB_KIND,
          priority: 'extension',
          title: () => '项目进度',
          guide: [
            {
              order: 40,
              title: () => '项目进度',
              description: () => '当前工作区的完成度、关注枝与未完成项（只读快照）',
            },
          ],
        }),
      'project-manager: right tab type',
    );
  } catch (error) {
    reportRightTabFailure(error, 'type');
    return;
  }

  const openBoard = openBoardAction(ctx);
  const navigation = ctx.sidebarRight;
  // 诊断把手：右栏页签的正式入口是右栏 guide 里的胶囊；控制台里也留一句能直接开，
  // 排查"页签到底注册上没"时省事（`__PM_DEBUG__` 是本插件自己的诊断面）。
  try {
    const handle = (globalThis as Record<string, unknown>)['__PM_DEBUG__'] as
      | { openRightTab?: () => void }
      | undefined;
    if (handle && navigation !== undefined && typeof navigation.openTab === 'function') {
      handle.openRightTab = () => navigation.openTab(RIGHT_TAB_KIND);
    }
  } catch {
    // 全局只读时忽略
  }
  ctx.slots.inject('sidebar.right.pane.tab', () => {
    const dispose = ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: RIGHT_TAB_ID,
        ...(openBoard !== undefined ? { inject: () => ({ onOpenBoard: openBoard }) } : {}),
      },
      RightProgressTab,
    );
    registeredSlots.push('sidebar.right.pane.tab');
    reportClient({ panelId: PANEL_ID, bundleId: PACKAGE_ID, registeredSlots: [...registeredSlots] });
    return dispose;
  });
}

/**
 * 「打开完整看板」的动作：`ctx.layout.selectPanel('project-manager')`。
 *
 * 布局面也写在 `inject` 里（官方姿态）；仍留一层兜底：真拿不到就**不给这个按钮**，
 * 而不是画一个点了没反应的按钮。
 */
function openBoardAction(ctx: ClientContext): (() => void) | undefined {
  const layout = ctx.layout;
  if (layout === undefined || typeof layout.selectPanel !== 'function') return undefined;
  return () => {
    try {
      layout.selectPanel(PANEL_ID);
    } catch (error) {
      // 主面板没注册时 selectPanel 会抛；这是"打不开"，不是崩溃
      reportRightTabFailure(error, 'open-board');
    }
  };
}

/** 右栏注册失败不能让用户只看到"少了个页签"却没有任何线索：报到宿主诊断里。 */
function reportRightTabFailure(error: unknown, stage: string): void {
  reportClient({
    panelId: PANEL_ID,
    bundleId: PACKAGE_ID,
    registeredSlots: [`right-tab:${stage}`],
    error: {
      kind: 'right-tab-registration',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    },
  });
}

/** 右栏页签类型注册表的最小面（形态取自 `dsh-client-ui-sidebar-right` 的 `SidebarRightTabRegistry`）。 */
interface SidebarRightTabsLike {
  register(definition: {
    id: string;
    kind: string;
    priority?: 'extension' | 'builtin' | 'fallback';
    title: (address: string) => string;
    guide?: ReadonlyArray<{ order: number; title: () => string; description?: () => string }>;
  }): () => void;
}

/**
 * 客户端插件主体。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), 'project-manager: styles');

  /**
   * 把"打开工作区文件"接到右栏（节点引用点击 → 右栏文件预览，FR-46c 的延伸）。
   *
   * `ctx.sidebarRight` 已写进 `inject`，正常情况下必定可用；这里仍然判空 + try/catch，
   * 因为"打不开"（地址没有类型认领 / 右栏座位未挂载）是可预期的运行时状态，不是崩溃。
   */
  ctx.effect(() => {
    const navigation = ctx.sidebarRight;
    if (navigation === undefined || typeof navigation.openResource !== 'function') {
      setResourceOpener(undefined);
      return () => setResourceOpener(undefined);
    }
    setResourceOpener((address) => navigation.openResource(address));
    return () => setResourceOpener(undefined);
  }, 'project-manager: 右栏文件跳转');

  /** 已注册的槽位（错误上报里一并带上，便于判断"是注册失败还是渲染失败"）。 */
  const registeredSlots: string[] = [];

  /**
   * 客户端崩溃上报。
   *
   * **为什么必须有**：面板渲染抛错时，DSH 的槽位错误边界只会把主区域替换成一个
   * `data-slot-error` 空 div —— 用户看到的就是"点开一片空白"，而宿主侧**什么都不知道**
   * （实测踩过：排查只能靠猜）。这里把错误主动报到 `/pm/debug/client`，
   * 于是 `/pm/debug?format=json` 里能直接看到"哪一行炸的"。
   */
  ctx.effect(() => {
    const report = (kind: string, message: string, stack?: string): void => {
      reportClient({
        panelId: PANEL_ID,
        bundleId: PACKAGE_ID,
        registeredSlots: [...(registeredSlots ?? [])],
        error: { kind, message, ...(stack !== undefined ? { stack: stack.slice(0, 2000) } : {}) },
      });
    };
    const onError = (event: ErrorEvent): void => {
      report('error', event.message, event.error instanceof Error ? event.error.stack : undefined);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason;
      report(
        'unhandledrejection',
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined,
      );
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, 'project-manager: error reporter');

  // 浏览器控制台可见的诊断把手。
  // 说明：宿主**不**给插件注入数据全局（只有 `__DSH_BOOT__` / `__ModuleLoader__`），
  // 所以这里自己挂一个只读把手，便于在控制台确认"客户端这一侧到底加载成什么样"。
  try {
    (globalThis as Record<string, unknown>)['__PM_DEBUG__'] = {
      panelId: PANEL_ID,
      bundleId: PACKAGE_ID,
      version: typeof __PM_VERSION__ === 'string' ? __PM_VERSION__ : '0.0.0-dev',
      registeredSlots: [] as string[],
      routes: {
        board: './pm/board',
        health: './pm/health',
        debug: './pm/debug',
        debugJson: './pm/debug?format=json',
        logs: './pm/debug/logs',
      },
    };
  } catch {
    // 全局只读时忽略
  }

  // ① 侧边栏面板项（list / root）：只提供图标，文案由侧边栏渲染。
  ctx.slots.inject('sidebar.panellist', () => {
    const dispose = ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 50,
        label: () => '项目进度',
      },
      PanelGlyph,
    );
    registeredSlots.push('sidebar.panellist');
    reportClient({ panelId: PANEL_ID, bundleId: PACKAGE_ID, registeredSlots: [...registeredSlots] });
    return dispose;
  });

  // ② 主面板（keyed / root）：key 必须与上面 id 相同。
  //
  // 注意：面板要用的"当前会话 id"走的是 DSH 的**全局标准源** `useSessions`
  // （渲染器把 `{...kit}` 摊进每个 slot 条目的 props，见 dsh-client-ui-renderer
  // 的 standardKit/ContextualEntry），因此这里**不需要**自己注入任何 hook。
  // 我们只用 entry.inject 面把 props 固定下来，避免每次渲染重建。
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ hooks: {} }),
      },
      BoardPanel,
    );
    registeredSlots.push('main');
    reportClient({ panelId: PANEL_ID, bundleId: PACKAGE_ID, registeredSlots: [...registeredSlots] });
    return dispose;
  });

  // ③ 右侧边栏「实时进度」页签（两阶段注册，官方 documentpreview 是同款活证据）。
  //
  // 为什么走右栏：每个工作区都有自己的可观测进度，右栏与会话并排，利于观察/审查时盯进度。
  // 完整画布仍在主面板（这个页签里有按钮跳过去），右栏太窄放不下图。
  //
  // **注意这里不用 `inject` 声明 `sidebarRightTabs`**：cordis 的 `inject` 是"服务不到位就
  // 整个插件不装配"，而我们的主面板必须在**任何**宿主上都可用 —— 万一宿主没装右栏，
  // 不能把看板一起带走。所以改成运行时探测：没有这个服务就只少一个页签。
  registerRightTab(ctx, registeredSlots);

  // ④ 设置页分区（list / root）：label 决定分区标题。
  ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register(
      {
        name: 'settings.section',
        id: 'project-manager',
        order: 60,
        label: () => '项目进度',
        locale: 'projectManager',
      },
      SettingsSection,
    );
    registeredSlots.push('settings.section');
    try {
      const handle = (globalThis as Record<string, unknown>)['__PM_DEBUG__'] as
        | { registeredSlots: string[] }
        | undefined;
      if (handle) handle.registeredSlots = [...registeredSlots];
    } catch {
      // 忽略
    }
    reportClient({ panelId: PANEL_ID, bundleId: PACKAGE_ID, registeredSlots: [...registeredSlots] });
    return dispose;
  });
}


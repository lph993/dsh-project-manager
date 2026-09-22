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
import { SettingsSection } from './settings-section.tsx';

/** 侧边栏项 id 与 main 槽 key：两者必须一致。 */
export const PANEL_ID = 'project-manager';

/** HMR / 卸载时用于定位本插件注入的样式标签。 */
const PACKAGE_ID = 'dsh-project-manager';

/** 构建期版本占位（未注入时回落 dev）；宿主与客户端用同一个宏。 */
declare const __PM_VERSION__: string | undefined;

/** cordis 服务依赖（短名）。 */
export const inject: string[] = ['slots'];

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
 * 客户端插件主体。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), 'project-manager: styles');

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

  const registeredSlots: string[] = [];

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

  // ③ 设置页分区（list / root）：label 决定分区标题。
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


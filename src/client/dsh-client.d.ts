/**
 * Client 侧槽位服务的**结构化类型**（手写）。
 *
 * 为什么手写：`@deepseek-ai/dsh-client-ui-slots` 在本机**没有独立包目录**——
 * 它被内联进 shell 的冻结模块表里，运行时可 `require`，但没有 `.d.ts` 可 import type。
 * 因此这里只声明我们真正用到的成员（形态取自真实 bundle 的调用点）。
 *
 * 真实调用点证据：
 * - `dsh-client-ui-sidebar/lib/client.js`：`ctx.slots.entriesOfSlot("sidebar.panellist")`、
 *   `ctx.slots.subscribe(slot, cb)`、`ctx.slots.inject(slot, () => ctx.slots.register({...}))`
 * - `dsh-client-ui-layout/lib/client.js`：`ctx.slots.register({ name:"root", children:{ "main": {kind:"keyed",scope:"root"} } })`、
 *   `ctx.slots.provideRoot({hooks})`、`renderSlot("main", {}, { entryKey })`
 * - `dsh-client-ui-conversation/lib/client.js`：`slots.register({ name:"main", key:"conversation", ... })`
 */

/** 槽位基数：单值 / 列表 / 按键寻址 / 链。 */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';

/** 槽位作用域。 */
export type SlotScope = 'root' | 'session' | 'session-maybe';

/** 子槽声明。 */
export interface SlotChildDeclaration {
  kind: SlotKind;
  scope: SlotScope;
}

/** 注册选项（`options` 字段的实现相关部分）。 */
export interface SlotRegistrationOptions {
  /** 目标槽位名，如 `'sidebar.panellist'` / `'main'` / `'settings.section'`。 */
  name: string;
  /** `list` / `keyed` 槽位的身份键。 */
  id?: string;
  /** `keyed` 槽位的键（`main` 用它匹配 activePanelId）。 */
  key?: string;
  order?: number;
  /** 文案：字符串或随语言变化的函数。 */
  label?: string | (() => string);
  /** 文案命名空间。 */
  locale?: string;
  /** 声明本注册会填充的子槽。 */
  children?: Record<string, SlotChildDeclaration>;
  /** 注入给组件的额外 props（厂商自有）。 */
  inject?: () => Record<string, unknown>;
  /** 共享 store 等。 */
  store?: unknown;
  [key: string]: unknown;
}

/** 槽位条目。 */
export interface SlotEntry {
  options: SlotRegistrationOptions;
}

/** 客户端槽位服务（只声明本项目用到的成员）。 */
export interface ClientSlotsService {
  /** 注册一个组件到槽位；返回卸载函数（不保证存在）。 */
  register(options: SlotRegistrationOptions, component: unknown): unknown;
  /** 声明式依赖：等待目标槽位出现后再注册（`inject` 的 body 可为生成器）。 */
  inject(slot: string, body: () => unknown): void;
  /** 枚举某槽位的全部条目。 */
  entries(slot: string): SlotEntry[];
  /** 同上，别名（侧边栏用这个名字）。 */
  entriesOfSlot(slot: string): SlotEntry[];
  /** 订阅某槽位条目变化；返回取消订阅函数。 */
  subscribe(slot: string, listener: () => void): () => void;
  [key: string]: unknown;
}

/** 解析 `label`（字符串或函数）为当前语言下的文本。 */
export function resolveSlotLabel(label: SlotRegistrationOptions['label']): string | undefined {
  if (typeof label === 'function') {
    try {
      return label();
    } catch {
      return undefined;
    }
  }
  return label;
}

/** Client 根上下文的最小形态（避免依赖具体 cordis 版本的泛型细节）。 */
export interface ClientContext {
  slots: ClientSlotsService;
  effect(callback: () => (() => void) | void, label?: string): unknown;
  /**
   * cordis 的反射读取：**不声明 `inject` 也能读服务**，未提供时返回 `undefined`。
   *
   * 用途：可选服务（例如右栏的 `sidebarRightTabs`）—— 直接读 `ctx[name]` 在未注入时可能抛，
   * 而 `inject` 是硬依赖（服务不到位整个插件不装配），两者都不适合"有则用、没有就算"。
   */
  get?(name: string): unknown;
  locale?: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
    subscribe(listener: () => void): () => void;
  };
  [key: string]: unknown;
}

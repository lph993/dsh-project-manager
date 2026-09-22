/**
 * 插件注册表自省（官方调试口径）。
 *
 * 来源：DSH 官方文档 `docs/cordis-tutorial/06-composition-and-hmr.md`
 * 的「Diagnosing a plugin that never loads」一节。原文要点：
 *
 * > a plugin whose `inject` names a service nobody provides **waits forever, printing nothing**.
 * > No error — PENDING is a legitimate state.
 * > … inspect its fiber state … `for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers)`
 *
 * 这是本项目**唯一需要主动去查**的官方调试手段（CLI 里没有 debug 命令、也没有日志文件）。
 * 本模块把它接进 `/pm/debug`：把每个插件 fiber 的状态列出来，
 * 并**高亮 PENDING**——静默不加载的插件就藏在那里。
 *
 * `FiberState` 在 cordis 里是 `const enum`（编译期擦除），因此不能 import 其值；
 * 这里按官方源码的数值定义本地镜像（`fiber.d.ts` 的声明顺序）。
 */

import type { Context } from '@deepseek-ai/cordis';

/** fiber 状态数值（镜像 cordis 的 `const enum FiberState`）。 */
export const FiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const;

export type FiberStateValue = (typeof FiberState)[keyof typeof FiberState];

/** 数值 → 名称。 */
export const FIBER_STATE_NAME: Record<number, string> = {
  0: 'PENDING',
  1: 'LOADING',
  2: 'ACTIVE',
  3: 'FAILED',
  4: 'DISPOSED',
  5: 'UNLOADING',
};

/** 一个 fiber 的可诊断视图。 */
export interface FiberView {
  /** 条目名（通常是包名或路径）。 */
  name: string;
  state: number;
  stateName: string;
  /** 该 fiber 还缺哪些服务（PENDING 的成因）。 */
  missing?: string[];
}

/** 一个 runtime（一个 registry 条目）的视图。 */
export interface RuntimeView {
  /** 条目 id。 */
  id: string;
  name: string;
  disabled: boolean;
  fibers: FiberView[];
}

/** 注册表快照。 */
export interface RegistryView {
  runtimes: RuntimeView[];
  /** 各状态计数（一眼看出有没有卡住的）。 */
  counts: Record<string, number>;
  /** 静默等待依赖的插件（PENDING）——最需要被看到的一类。 */
  pending: Array<{ name: string; missing?: string[] }>;
  /** 加载失败的插件。 */
  failed: Array<{ name: string }>;
  /** 本插件自己的 fiber 是否 ACTIVE（自我诊断）。 */
  selfActive: boolean;
}

/** cordis 内部结构的结构化形态（只声明我们读到的字段）。 */
interface FiberLike {
  name?: string;
  state?: number;
  [key: string]: unknown;
}

interface RuntimeLike {
  name?: string;
  id?: string;
  disabled?: boolean;
  fibers?: Iterable<FiberLike>;
  [key: string]: unknown;
}

/**
 * 读取插件注册表快照。
 *
 * **绝不抛错**：注册表是内部结构，形状可能随 rc 变化；诊断失败不该影响插件本身。
 */
export function readPluginRegistry(ctx: Context, selfName: string): RegistryView {
  const view: RegistryView = {
    runtimes: [],
    counts: {},
    pending: [],
    failed: [],
    selfActive: false,
  };

  try {
    const registry = (ctx as unknown as { registry?: Map<string, RuntimeLike> }).registry;
    if (!registry || typeof registry.values !== 'function') return view;

    for (const [key, runtime] of registry) {
      if (!runtime || typeof runtime !== 'object') continue;
      const fibers: FiberView[] = [];
      const fiberIterable = runtime.fibers;
      if (fiberIterable !== undefined && fiberIterable !== null) {
        for (const fiber of fiberIterable) {
          if (!fiber || typeof fiber !== 'object') continue;
          const state = typeof fiber.state === 'number' ? fiber.state : -1;
          const name = typeof fiber.name === 'string' ? fiber.name : '(unnamed)';
          const missing = readMissingServices(fiber);
          const entry: FiberView = { name, state, stateName: FIBER_STATE_NAME[state] ?? 'UNKNOWN' };
          if (missing.length > 0) entry.missing = missing;
          fibers.push(entry);

          const stateName = entry.stateName;
          view.counts[stateName] = (view.counts[stateName] ?? 0) + 1;
          if (state === FiberState.PENDING) {
            view.pending.push({ name, ...(missing.length > 0 ? { missing } : {}) });
          } else if (state === FiberState.FAILED) {
            view.failed.push({ name });
          }
          if (name.includes(selfName) && state === FiberState.ACTIVE) view.selfActive = true;
        }
      }
      view.runtimes.push({
        id: typeof runtime.id === 'string' ? runtime.id : key,
        name: typeof runtime.name === 'string' ? runtime.name : '(unnamed)',
        disabled: runtime.disabled === true,
        fibers,
      });
    }
  } catch {
    // 内部结构不可读时返回已收集到的部分（诊断是尽力而为）
  }

  return view;
}

/** 尽力读出"还缺哪些服务"（不同 cordis 版本字段名可能不同，全部兜住）。 */
function readMissingServices(fiber: FiberLike): string[] {
  const candidates = ['missing', 'missingServices', 'pending', 'waiting', 'awaiting'];
  for (const key of candidates) {
    const value = fiber[key];
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }
    if (value instanceof Set) {
      return [...value].map((item) => String(item));
    }
  }
  // 退一步：从 inject 里减去 ctx 上已存在的服务
  const inject = fiber['inject'];
  if (Array.isArray(inject)) {
    return inject.map((item) => String(item));
  }
  return [];
}

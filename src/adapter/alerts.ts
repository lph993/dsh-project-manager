/**
 * FR-174「错误日志警示」的**宿主侧口径**（单独成文件，而不是塞在 `service.ts` 里）。
 *
 * 为什么单独一个模块：`service.ts` 是六千多行的装配体，任何东西放进去都没法单测
 * （一 import 就把整个服务拖起来）。而"什么算警示、警示里放什么"是**口径**，
 * 口径必须能被测试钉住 —— 所以它放在这里，只依赖诊断总线的**只读接口**。
 */

import type { DebugEntry } from './debug.ts';

/**
 * 看板/状态条要的警示摘要。
 *
 * `lastError` 只在**真的有 error** 时出现 —— 没有错误却给个空壳对象，
 * 会逼调用方去分辨"空"和"没有"两件事，纯属制造 bug。
 */
export interface BoardAlerts {
  /** 当前诊断缓冲区里的 error 条数。 */
  errors: number;
  /** 当前诊断缓冲区里的 warn 条数（降级/兜底路线这类"可接受但要知情"的）。 */
  warns: number;
  /** 最近一条 error 的原文摘要（谁在哪报的、说了什么）。 */
  lastError?: { at: string; scope: string; message: string };
}

/**
 * 把诊断总线收敛成看板可见的警示摘要。**口径唯一一处**，看板与 `/pm/debug` 必须是同一个数。
 *
 * - 计数 = 诊断总线**当前缓冲区**里的 error / warn 条数（有界 200 条）。
 *   刻意不另设累计计数器：累计数会出现"告警说 3 条错，可日志里一条都翻不到"的错位。
 * - `lastError` 取**最新**一条（从尾部往前找第一条），不是第一条 —— 要的是"现在出的问题"。
 * - 没有 error 时**不给** `lastError` 字段：调用方一个 `if` 就能判完。
 *
 * 参数用结构类型而不是 `DebugBus` 类：测试可以喂一个假总线，不必构造真实单例
 * （单例是进程级的，测试之间会互相污染）。
 */
export function alertsOf(bus: {
  counts(): Record<DebugEntry['level'], number>;
  lastError(): DebugEntry | undefined;
}): BoardAlerts {
  const counts = bus.counts();
  const last = bus.lastError();
  return {
    errors: counts.error,
    warns: counts.warn,
    ...(last === undefined
      ? {}
      : { lastError: { at: last.ts, scope: last.scope, message: last.message } }),
  };
}

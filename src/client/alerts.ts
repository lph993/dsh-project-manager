/**
 * FR-174「错误日志警示」的**客户端口径**（状态条角标该不该画、画成什么）。
 *
 * 为什么独立成 `.ts` 而不是留在 `board-panel.tsx` 里：`.tsx` 进不了 `node --test`
 * （Node 不会转 JSX），而"什么算警示"是**口径** —— 口径必须能被测试钉住。
 */

import type { BoardSnapshot } from './contract.ts';

/** 角标的形态（渲染层只负责把它画出来）。 */
export interface AlertChip {
  /** `error` = 红（异常），`warn` = 灰（需知情）。 */
  tone: 'error' | 'warn';
  /** 角标上那行字。 */
  label: string;
  /** 悬停说明（含最近一条错误的原文与时间）。 */
  title: string;
  /** 红标"知悉"要记住的时间戳（灰标没有）。 */
  ackAt?: string;
}

/**
 * 状态条警示角标的形态（**没有警示时返回 undefined**，而不是给个"0 错误"的绿标）。
 *
 * 口径：
 * - **红标（error）**：缓冲区里有 error，且最近一条 error 比"已知悉"的那条更新
 *   —— 红色语义 = 异常，所以它只在**真有错且还没被知悉**时出现。
 * - **灰标（warn）**：红标不画时，只要还有 warn 就报灰标（降级/兜底路线这类"需知情但可接受"）。
 *   落到这一档的三种情形都是同一件事：**当下没有"未读的异常"**——只剩告警、
 *   错误已被知悉、或数据里根本没有 `lastError` 可指。
 * - `alerts` 缺失（老宿主）⇒ 不画。**不画不等于绿标**：我们没有"宿主没出错"的依据。
 *
 * `ackedAt` 用**时间戳**而不是条数：缓冲区回卷时条数会变小，用条数会把"明明还有错"
 * 误判成已清。ISO-8601（同一个 `toISOString` 产出）按字典序比较即时间序，不必解析成 Date。
 */
export function alertChipOf(
  alerts: BoardSnapshot['alerts'],
  ackedAt: string | undefined,
): AlertChip | undefined {
  if (alerts === undefined) return undefined;
  const last = alerts.lastError;
  const fresh = last !== undefined && (ackedAt === undefined || last.at > ackedAt);
  if (alerts.errors > 0 && fresh && last !== undefined) {
    return {
      tone: 'error',
      label: `⚠ ${alerts.errors} 错误`,
      title: `最近一条错误（${last.scope}）：${last.message}\n${last.at}\n点击打开诊断页`,
      ackAt: last.at,
    };
  }
  if (alerts.warns > 0) {
    return {
      tone: 'warn',
      label: `${alerts.warns} 告警`,
      title: '有降级/兜底路线的记录（可接受但需知情）\n点击打开诊断页',
    };
  }
  return undefined;
}

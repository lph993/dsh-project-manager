/**
 * AI 用量账本落盘（`.pm/ai-usage.json`）。
 *
 * 为什么放 `.pm/` 而不是 KV 事实源：这是**统计**，不是事实源 ——
 * 坏了/删了只影响"历史消耗看得见多少"，不影响任何项目结论（与 AI 缓存同一个判断）。
 * 换个工作区就是另一份账本，符合"花费跟着项目走"的直觉。
 *
 * 读写在 adapter 层，**口径与聚合在 `src/ai/usage.ts`**（纯函数、可单测）。
 */

import type { Context } from '@deepseek-ai/cordis';

import {
  emptyUsageLedger,
  type AiUsageCall,
  type AiUsageLedger,
  type AiUsageScenario,
} from '../ai/usage.ts';
import { debugBus } from './debug.ts';

/** 账本文件（工作区根下）。 */
export const AI_USAGE_PATH = '.pm/ai-usage.json';

/** 文件结构（带版本号，改形状时能识别旧文件而不是崩）。 */
interface UsageFile {
  version: 1;
  entries: AiUsageCall[];
  /**
   * **从提供方拒绝里学到的模型窗口**（真机踩过：这台宿主对该模型不披露 `context.contextWindow`）。
   *
   * 为什么记在这里：它是"这个模型有多大"的事实，按工作区存就够了（换工作区重新学一次也无所谓），
   * 而且它与用法统计同源——都是"这次真机调用告诉了我们什么"。
   * 可选：老文件没有这个字段照常读。
   */
  learnedContextWindow?: number;
}

/** `ctx.fs` 的最小面（与 `ai-cache-store.ts` 同一套：先 resolve 拿 target 再读写）。 */
interface FsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
  readText(target: unknown): Promise<string>;
  writeText(target: unknown, content: string): Promise<unknown>;
}

function fsOf(ctx: Context): FsLike | undefined {
  try {
    const holder = ctx as unknown as {
      fs?: Partial<FsLike>;
      get?: (name: string) => unknown;
    };
    const fs = (holder.fs ?? holder.get?.('fs')) as Partial<FsLike> | undefined;
    if (
      fs === undefined ||
      typeof fs.resolve !== 'function' ||
      typeof fs.readText !== 'function' ||
      typeof fs.writeText !== 'function'
    ) {
      return undefined;
    }
    return fs as FsLike;
  } catch {
    return undefined;
  }
}

/** 只接受形状正确的条目（手工改坏的文件不该让统计页面崩）。 */
function isCall(value: unknown): value is AiUsageCall {
  if (value === null || typeof value !== 'object') return false;
  const call = value as Partial<AiUsageCall>;
  const scenarios: AiUsageScenario[] = ['tree', 'weights', 'handoff'];
  return (
    typeof call.at === 'string' &&
    typeof call.route === 'string' &&
    typeof call.estimatedTokens === 'number' &&
    scenarios.includes(call.scenario as AiUsageScenario) &&
    (call.outcome === 'ok' || call.outcome === 'error' || call.outcome === 'reused') &&
    (call.usageSource === 'provider' || call.usageSource === 'estimate' || call.usageSource === 'none')
  );
}

/** 读账本；任何异常都当"空账本"处理（统计坏了不该影响功能）。 */
export async function readAiUsage(
  ctx: Context,
): Promise<{ ledger: AiUsageLedger; learnedContextWindow?: number }> {
  const fs = fsOf(ctx);
  if (fs === undefined) return { ledger: emptyUsageLedger() };
  try {
    const target = await fs.resolve(AI_USAGE_PATH);
    const text = await fs.readText(target);
    if (text === undefined || text === '') return { ledger: emptyUsageLedger() };
    const parsed = JSON.parse(text) as Partial<UsageFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { ledger: emptyUsageLedger() };
    const learned = parsed.learnedContextWindow;
    return {
      ledger: { entries: parsed.entries.filter(isCall) },
      ...(typeof learned === 'number' && Number.isSafeInteger(learned) && learned > 0
        ? { learnedContextWindow: learned }
        : {}),
    };
  } catch (error) {
    debugBus.debug(
      'ai',
      `AI 用量账本读取未命中（首次运行或文件不存在）：${error instanceof Error ? error.message : String(error)}`,
    );
    return { ledger: emptyUsageLedger() };
  }
}

/**
 * 写账本。
 *
 * **失败只留诊断、绝不抛出**：统计写不进去不能影响这次 AI 调用的结果
 * （调用已经花过钱了，把结果丢掉是最亏的）。
 *
 * @param learnedContextWindow 已知的模型窗口（从拒绝里学到的）—— 省略表示"这次没有新值"，
 *                             但**已存在文件里的值必须保留**（所以调用方要把它读出来再传回）。
 */
export async function writeAiUsage(
  ctx: Context,
  ledger: AiUsageLedger,
  learnedContextWindow?: number,
): Promise<{ written: boolean; reason?: string }> {
  const fs = fsOf(ctx);
  if (fs === undefined) {
    return { written: false, reason: '宿主未提供 ctx.fs，用量账本无法落盘（功能不受影响）' };
  }
  try {
    const payload: UsageFile = {
      version: 1,
      entries: ledger.entries,
      ...(learnedContextWindow !== undefined && Number.isSafeInteger(learnedContextWindow) && learnedContextWindow > 0
        ? { learnedContextWindow }
        : {}),
    };
    const target = await fs.resolve(AI_USAGE_PATH);
    await fs.writeText(target, JSON.stringify(payload, null, 2));
    return { written: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugBus.warn('ai', `AI 用量账本写入失败（不影响本次结果）：${reason}`);
    return { written: false, reason };
  }
}

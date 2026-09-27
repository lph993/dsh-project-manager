/**
 * **插件自身的 AI 调用 token 统计**（用户诉求："这个插件可以出 token 使用统计，是插件自身的 AI 调用 token"）。
 *
 * 为什么要插件自己记：`ctx.llm.stream()` 是**插件直接发起**的调用，它不走 agent 循环，
 * 因此**不在宿主的会话 token 计量里**（会话计量只覆盖模型在回合里说的话）。
 * 换句话说：不自己记，这些花费就是不可见的。
 *
 * 口径（三条都要说清，否则数字会骗人）：
 * 1. **真实用量优先**：提供方在流末尾回的 `usage`（`BlockAssembler.usage`）是权威值，
 *    逐项记 input/output/total/cacheRead/cacheWrite/reasoning；
 * 2. **拿不到真实用量就标"估算"**：`usageSource` 如实写 `estimate`，
 *    UI 上"预估 vs 实际"要能分开看 —— 预算闸门本来就是粗估（FR-81b 的措辞就是"粗估"）；
 * 3. **缓存命中不算调用、但算节省**：没发出去就是 0 token，把它记成 `reused` 并把
 *    **这次省下的估算量**放进 `savedTokens`（这是 T6/T9 的价值证明，不能只算"没花钱"就完了）。
 *
 * 纯函数、零依赖：统计口径可单测，IO 在 `adapter/ai-usage-store.ts`。
 */

/** 与 `dsh-llm` 的 `TokenUsage` 对齐的最小面（只读我们要用的字段）。 */
export interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** FR-104a 的调用场景（**闭集**：新场景要显式加进来，不做"其它"兜底）。 */
export type AiUsageScenario = 'tree' | 'weights' | 'handoff';

/** 场景的中文名（UI 显示用，与 FR-104a 的措辞一致）。 */
export const AI_SCENARIO_LABEL: Record<AiUsageScenario, string> = {
  tree: 'AI 建树',
  weights: '权重测量',
  handoff: '交接文档补写',
};

/** 一次调用（或一次"本该调用但复用了缓存"）的记录。 */
export interface AiUsageCall {
  /** ISO 时间。 */
  at: string;
  scenario: AiUsageScenario;
  /** `provider / model`。 */
  route: string;
  /** `ok` 成功 / `error` 失败 / `reused` 缓存命中或续跑（**没有发出去**）。 */
  outcome: 'ok' | 'error' | 'reused';
  /** 发出去之前给用户看的粗估（成本前置那一份）。 */
  estimatedTokens: number;
  /** 提供方回报的真实用量；拿不到就是 undefined（**不编**）。 */
  usage?: TokenUsageLike;
  /** 数字的来源：提供方回报 / 自己的粗估 / 无（缓存复用时为 none）。 */
  usageSource: 'provider' | 'estimate' | 'none';
  /** 墙钟耗时（有的话）。 */
  durationMs?: number;
}

/** 明细账本（只保留最近 N 条，统计全部由它算出来 —— 单一来源，不会与累计值漂移）。 */
export interface AiUsageLedger {
  entries: AiUsageCall[];
}

/** 保留上限：一次 AI 调用都是用户显式动作，200 条在实际使用里等于"累计"。 */
export const MAX_USAGE_ENTRIES = 200;

/** 「上次建树实测」的结果（FR-171）：只有**提供方真实回报**的记录才算数。 */
export interface LastProviderMeasuredCall {
  at: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 最近一次**成功且由提供方回报真实用量**的建树调用（FR-171）。
 *
 * 为什么只认"提供方回报"：确认框里那个数字是要**给人当参考**的，
 * 拿我们自己的粗估冒充"上次实测"，比不说更糟 —— 口径必须是硬的。
 *
 * 为什么是"一次调用"而不是"上次建树合计"：账本里没有 buildId，
 * 分批建树的 N 条记录只靠时间戳区分并不可靠；而**每次调用会不会顶到上限**本来就是
 * 按单次调用算的（上限 `maxTokens` 也是每次调用一份），所以报单次才对应得上。
 */
export function lastProviderMeasuredTreeCall(
  ledger: AiUsageLedger,
): LastProviderMeasuredCall | undefined {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index];
    if (entry === undefined) continue;
    if (entry.scenario !== 'tree' || entry.outcome !== 'ok' || entry.usageSource !== 'provider') continue;
    const outputTokens = entry.usage?.outputTokens;
    const inputTokens = entry.usage?.inputTokens;
    if (typeof outputTokens !== 'number' || typeof inputTokens !== 'number') continue;
    return { at: entry.at, inputTokens, outputTokens };
  }
  return undefined;
}

/** 聚合统计（UI 与工具共用同一份口径）。 */export interface AiUsageStats {
  /** 真的发出去的调用次数。 */
  calls: number;
  /** 命中缓存/续跑的次数（0 token）。 */
  reused: number;
  /** 失败次数（失败也烧 token，必须计入）。 */
  failed: number;
  /** 其中拿到**提供方真实用量**的次数。 */
  providerReported: number;
  /** 只有估算的次数（UI 要据此说明数字来源）。 */
  estimatedOnly: number;
  /** 提供方回报的真实用量合计。 */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** 粗估合计（用于和真实值对照；没有提供方用量的项也计入）。 */
  estimatedTokens: number;
  /** 复用省下来的估算量（T6/T9 的价值证明）。 */
  savedTokens: number;
  /** 按场景拆分（只列出现过的场景，顺序固定：tree → weights → handoff）。 */
  byScenario: Array<{
    scenario: AiUsageScenario;
    label: string;
    calls: number;
    reused: number;
    totalTokens: number;
  }>;
  /** 最近一次调用（用于"上次调用：建树 · 12,345 token · 3 分钟前"）。 */
  last?: AiUsageCall;
  /** 账本里保留了多少条明细（透明交代统计窗口）。 */
  window: number;
}

/** 空账本。 */
export function emptyUsageLedger(): AiUsageLedger {
  return { entries: [] };
}

/** 记一条（超出上限丢最旧的）。 */
export function recordUsage(
  ledger: AiUsageLedger,
  call: AiUsageCall,
  max: number = MAX_USAGE_ENTRIES,
): AiUsageLedger {
  const entries = [...ledger.entries, call];
  const overflow = entries.length - Math.max(1, Math.trunc(max));
  return { entries: overflow > 0 ? entries.slice(overflow) : entries };
}

/** 真实用量合计（缺字段按 0 计，**不推算**）。 */
function usageOf(call: AiUsageCall): {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
} {
  const usage = call.usage ?? {};
  const input = numberOr0(usage.inputTokens);
  const output = numberOr0(usage.outputTokens);
  return {
    input,
    output,
    total: numberOr0(usage.totalTokens) || input + output,
    cacheRead: numberOr0(usage.cacheReadTokens),
    cacheWrite: numberOr0(usage.cacheWriteTokens),
    reasoning: numberOr0(usage.reasoningTokens),
  };
}

function numberOr0(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/** 从明细算聚合（纯函数：同一份账本永远得到同一个结论）。 */
export function usageStatsOf(ledger: AiUsageLedger): AiUsageStats {
  const stats: AiUsageStats = {
    calls: 0,
    reused: 0,
    failed: 0,
    providerReported: 0,
    estimatedOnly: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedTokens: 0,
    savedTokens: 0,
    byScenario: [],
    window: ledger.entries.length,
  };
  const scenarios = new Map<AiUsageScenario, { calls: number; reused: number; totalTokens: number }>();
  for (const call of ledger.entries) {
    stats.estimatedTokens += numberOr0(call.estimatedTokens);
    const bucket = scenarios.get(call.scenario) ?? { calls: 0, reused: 0, totalTokens: 0 };
    if (call.outcome === 'reused') {
      stats.reused += 1;
      bucket.reused += 1;
      // 复用省下的是"这次本该花的钱"（缓存里记的或当时的粗估）
      stats.savedTokens += numberOr0(call.estimatedTokens);
      scenarios.set(call.scenario, bucket);
      continue;
    }
    stats.calls += 1;
    bucket.calls += 1;
    if (call.outcome === 'error') stats.failed += 1;
    const usage = usageOf(call);
    if (call.usageSource === 'provider') {
      stats.providerReported += 1;
      stats.inputTokens += usage.input;
      stats.outputTokens += usage.output;
      stats.totalTokens += usage.total;
      stats.cacheReadTokens += usage.cacheRead;
      stats.cacheWriteTokens += usage.cacheWrite;
      stats.reasoningTokens += usage.reasoning;
      bucket.totalTokens += usage.total;
    } else {
      // 没有真实用量：把粗估计入"估算合计"，**不计入真实合计**（两笔账不能混）
      stats.estimatedOnly += 1;
      bucket.totalTokens += numberOr0(call.estimatedTokens);
    }
    scenarios.set(call.scenario, bucket);
  }
  const order: AiUsageScenario[] = ['tree', 'weights', 'handoff'];
  stats.byScenario = order
    .filter((scenario) => scenarios.has(scenario))
    .map((scenario) => ({
      scenario,
      label: AI_SCENARIO_LABEL[scenario],
      ...(scenarios.get(scenario) as { calls: number; reused: number; totalTokens: number }),
    }));
  const last = ledger.entries[ledger.entries.length - 1];
  if (last !== undefined) stats.last = last;
  return stats;
}

/**
 * 一行摘要（设置页的卡片副标题、日志、工具返回都能用同一句）。
 *
 * 措辞纪律：**有几次没拿到真实用量就直说**，不把估算混进"实际用量"里报数。
 */
export function formatUsageLine(stats: AiUsageStats): string {
  if (stats.calls === 0 && stats.reused === 0) {
    return '插件还没有发起过任何 AI 调用（缓存复用不算调用）。';
  }
  const parts = [`调用 ${stats.calls} 次`, `复用 ${stats.reused} 次`];
  if (stats.calls > 0) {
    parts.push(
      stats.providerReported > 0
        ? `实际用量 ${stats.totalTokens.toLocaleString('en-US')} token（提供方回报）`
        : '未拿到提供方用量，只有粗估',
    );
  }
  if (stats.estimatedOnly > 0 && stats.providerReported > 0) {
    parts.push(`其中 ${stats.estimatedOnly} 次只有粗估`);
  }
  if (stats.savedTokens > 0) parts.push(`复用省下约 ${stats.savedTokens.toLocaleString('en-US')} token`);
  return parts.join(' · ');
}

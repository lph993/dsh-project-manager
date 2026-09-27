/**
 * 插件自身 AI 用量口径的契约测试（FR-147：
 * 用户诉求"这个插件可以出 token 使用统计，是插件自身的 AI 调用 token"）。
 *
 * 这一层最怕的不是算错加法，而是**把不该混的混在一起**：
 * 真实用量 vs 粗估、调用 vs 缓存复用、成功 vs 失败（失败也烧了 token）。
 * 所以下面逐条钉住"哪些必须分开、哪些必须计入"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_USAGE_ENTRIES,
  emptyUsageLedger,
  formatUsageLine,
  lastProviderMeasuredTreeCall,
  recordUsage,
  usageStatsOf,
  type AiUsageCall,
} from '../../src/ai/usage.ts';

function call(partial: Partial<AiUsageCall> = {}): AiUsageCall {
  return {
    at: '2026-09-24T00:00:00.000Z',
    scenario: 'tree',
    route: 'deepseek / flash',
    outcome: 'ok',
    estimatedTokens: 5000,
    usageSource: 'provider',
    usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    ...partial,
  };
}

test('空账本：不编数字，也不假装有调用', () => {
  const stats = usageStatsOf(emptyUsageLedger());
  assert.equal(stats.calls, 0);
  assert.equal(stats.reused, 0);
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.savedTokens, 0);
  assert.equal(stats.last, undefined);
  assert.deepEqual(stats.byScenario, []);
  assert.match(formatUsageLine(stats), /还没有发起过任何 AI 调用/);
});

test('一次成功的调用：真实用量进"真实"账，粗估进"粗估"账，绝不混', () => {
  const stats = usageStatsOf(recordUsage(emptyUsageLedger(), call()));
  assert.equal(stats.calls, 1);
  assert.equal(stats.providerReported, 1);
  assert.equal(stats.estimatedOnly, 0);
  assert.equal(stats.totalTokens, 1500);
  assert.equal(stats.inputTokens, 1200);
  assert.equal(stats.outputTokens, 300);
  assert.equal(stats.estimatedTokens, 5000, '粗估单独一笔，用于对照"预估 vs 实际"');
  assert.equal(stats.failed, 0);
});

test('拿不到提供方用量：只算粗估，不计入真实用量（并标出来）', () => {
  const stats = usageStatsOf(
    recordUsage(
      emptyUsageLedger(),
      call({ usageSource: 'estimate', usage: undefined }),
    ),
  );
  assert.equal(stats.calls, 1);
  assert.equal(stats.providerReported, 0);
  assert.equal(stats.estimatedOnly, 1);
  assert.equal(stats.totalTokens, 0, '没有真实用量就是 0，不能拿粗估顶上');
  assert.equal(stats.estimatedTokens, 5000);
  assert.match(formatUsageLine(stats), /未拿到提供方用量/);
});

test('缓存复用：不算调用，但要把省下的量记进 savedTokens（T6/T9 的价值证明）', () => {
  const stats = usageStatsOf(
    recordUsage(
      emptyUsageLedger(),
      call({ outcome: 'reused', usageSource: 'none', usage: undefined, estimatedTokens: 4200 }),
    ),
  );
  assert.equal(stats.calls, 0, '复用不是调用');
  assert.equal(stats.reused, 1);
  assert.equal(stats.savedTokens, 4200);
  assert.equal(stats.totalTokens, 0);
  assert.match(formatUsageLine(stats), /复用省下约 4,200 token/);
});

test('失败也烧 token：必须计入调用与用量', () => {
  const stats = usageStatsOf(
    recordUsage(
      emptyUsageLedger(),
      call({ outcome: 'error', usage: { inputTokens: 800, outputTokens: 120 } }),
    ),
  );
  assert.equal(stats.calls, 1);
  assert.equal(stats.failed, 1);
  // total 缺失时用 入+出 兜底（提供方没给 total 也不能当 0）
  assert.equal(stats.totalTokens, 920);
});

test('按场景拆分：顺序固定（tree → weights → handoff），只列出现过的', () => {
  let ledger = emptyUsageLedger();
  ledger = recordUsage(ledger, call({ scenario: 'handoff', estimatedTokens: 1000 }));
  ledger = recordUsage(ledger, call({ scenario: 'tree' }));
  ledger = recordUsage(ledger, call({ scenario: 'tree', outcome: 'reused', usageSource: 'none', usage: undefined }));
  const stats = usageStatsOf(ledger);
  assert.deepEqual(
    stats.byScenario.map((item) => item.scenario),
    ['tree', 'handoff'],
    'weights 没出现过就不列；顺序固定，避免同一份数据两种排法',
  );
  assert.deepEqual(stats.byScenario[0], {
    scenario: 'tree',
    label: 'AI 建树',
    calls: 1,
    reused: 1,
    totalTokens: 1500,
  });
});

test('提供方缓存与推理字段原样累计（不推算、不重算）', () => {
  const stats = usageStatsOf(
    recordUsage(
      emptyUsageLedger(),
      call({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 300, reasoningTokens: 77 } }),
    ),
  );
  assert.equal(stats.cacheReadTokens, 900);
  assert.equal(stats.cacheWriteTokens, 300);
  assert.equal(stats.reasoningTokens, 77);
  assert.equal(stats.totalTokens, 15, 'total 缺失时按 入+出 兜底');
});

test('非法数字一律按 0（负数 / NaN 不许进统计，也不许变成 NaN）', () => {
  const stats = usageStatsOf(
    recordUsage(
      emptyUsageLedger(),
      call({
        estimatedTokens: Number.NaN,
        usage: { inputTokens: -50, outputTokens: Number.NaN, totalTokens: -1 },
      }),
    ),
  );
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.outputTokens, 0);
  assert.equal(stats.estimatedTokens, 0);
  assert.ok(Number.isFinite(stats.savedTokens));
});

test('账本有界：只保留最近 N 条（统计窗口要能如实说明）', () => {
  let ledger = emptyUsageLedger();
  for (let index = 0; index < MAX_USAGE_ENTRIES + 5; index += 1) {
    ledger = recordUsage(ledger, call({ estimatedTokens: index }));
  }
  assert.equal(ledger.entries.length, MAX_USAGE_ENTRIES);
  const stats = usageStatsOf(ledger);
  assert.equal(stats.window, MAX_USAGE_ENTRIES);
  assert.equal(stats.calls, MAX_USAGE_ENTRIES);
  assert.equal(ledger.entries[0]?.estimatedTokens, 5, '丢的是最旧的');
});

/**
 * 「上次实测」（FR-171）：确认框里那个数字要能当参考，**口径必须硬** ——
 * 只认"建树 + 成功 + 提供方真实回报"三条同时成立的记录。
 */
test('上次实测只认提供方回报的成功建树调用，且取最近一条', () => {
  assert.equal(lastProviderMeasuredTreeCall(emptyUsageLedger()), undefined, '空账本 → 没有实测，不许编');

  let ledger = emptyUsageLedger();
  // 只估算（没有提供方用量）⇒ 不算实测
  ledger = recordUsage(ledger, call({ usageSource: 'estimate', usage: undefined }));
  assert.equal(lastProviderMeasuredTreeCall(ledger), undefined, '粗估不能冒充实测');

  // 缓存复用（压根没发出去）⇒ 不算
  ledger = recordUsage(ledger, call({ outcome: 'reused', usageSource: 'none', usage: undefined }));
  assert.equal(lastProviderMeasuredTreeCall(ledger), undefined);

  // 失败 ⇒ 不算（失败也烧 token，但"上次实测"要是成功那次的参考值）
  ledger = recordUsage(ledger, call({ outcome: 'error' }));
  assert.equal(lastProviderMeasuredTreeCall(ledger), undefined);

  // 别的场景（交接文档补写）⇒ 不算
  ledger = recordUsage(ledger, call({ scenario: 'handoff' }));
  assert.equal(lastProviderMeasuredTreeCall(ledger), undefined);

  // 成功的建树 + 提供方真实用量 ⇒ 算，且取**最近一条**
  ledger = recordUsage(ledger, call({ usage: { inputTokens: 1111, outputTokens: 222 } }));
  ledger = recordUsage(ledger, call({ usage: { inputTokens: 3333, outputTokens: 444 } }));
  assert.deepEqual(lastProviderMeasuredTreeCall(ledger), {
    at: '2026-09-24T00:00:00.000Z',
    inputTokens: 3333,
    outputTokens: 444,
  });
});

test('提供方只回了总量、没回输入/输出明细时不算实测（缺哪个就不算哪个）', () => {
  let ledger = emptyUsageLedger();
  ledger = recordUsage(ledger, call({ usage: { totalTokens: 900 } }));
  assert.equal(
    lastProviderMeasuredTreeCall(ledger),
    undefined,
    '只有 total 无法回答"输出顶没顶到上限" —— 宁可不显示',
  );
});

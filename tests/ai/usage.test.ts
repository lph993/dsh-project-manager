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

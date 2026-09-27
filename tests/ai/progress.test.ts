/**
 * 运行中的建树进度（FR-167）纯函数契约。
 *
 * 这一层的价值全在**口径**：字符数是事实、token 是粗估、上限是确定值。
 * 三者混起来说，就会变成"实时显示了一个看起来很准、其实编的数字"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiRunProgressOf,
  describeAiRun,
  outputTokensEstimateOf,
  usedRatio,
} from '../../src/ai/progress.ts';

test('字符 → token 的粗估是向上取整，非法值一律当 0（不抛、不出 NaN）', () => {
  assert.equal(outputTokensEstimateOf(0), 0);
  assert.equal(outputTokensEstimateOf(3), 1);
  assert.equal(outputTokensEstimateOf(4), 2, '向上取整：宁可略高，不假装更省');
  assert.equal(outputTokensEstimateOf(-5), 0);
  assert.equal(outputTokensEstimateOf(Number.NaN), 0);
});

test('进度比例夹在 0..1；上限缺失/为 0 时返回 0（不画假进度）', () => {
  assert.equal(usedRatio({ outputChars: 0, outputLimit: 8192 }), 0);
  assert.equal(usedRatio({ outputChars: 8192 * 3, outputLimit: 8192 }), 1, '正好到上限 = 100%');
  assert.equal(usedRatio({ outputChars: 999999, outputLimit: 8192 }), 1, '超过也只显示 100%');
  assert.equal(usedRatio({ outputChars: 300, outputLimit: 0 }), 0, '上限是 0 时不除零');
  assert.equal(usedRatio({ outputChars: 300, outputLimit: Number.NaN }), 0);
});

test('快照字段都由输入决定，且分批信息如实带上', () => {
  const progress = aiRunProgressOf({
    startedAt: '2026-01-01T00:00:00.000Z',
    mode: 'shard',
    shardIndex: 2,
    shardTotal: 6,
    outputChars: 900,
    outputLimit: 8192,
  });
  assert.equal(progress.scenario, 'tree');
  assert.equal(progress.shardIndex, 2);
  assert.equal(progress.shardTotal, 6);
  assert.equal(progress.outputChars, 900);
  assert.equal(progress.outputTokensEstimate, 300);
  assert.equal(progress.outputLimit, 8192);
  assert.equal(progress.truncated, false, '不预测截断：只有真的发生才置真');
  assert.equal(aiRunProgressOf({ ...progress, shardIndex: 0 } as never).shardIndex, 1, '片号至少是 1');
});

test('人话里必须写明"粗估"，且截断与正常是两句不同的话', () => {
  const running = aiRunProgressOf({
    startedAt: 'now',
    mode: 'shard',
    shardIndex: 1,
    shardTotal: 3,
    outputChars: 600,
    outputLimit: 8192,
  });
  const text = describeAiRun(running);
  assert.match(text, /第 1\/3 片/, '分批时要说清第几片（否则进度条重置会被当成出错）');
  assert.match(text, /粗估 600 字符/);
  assert.match(text, /上限 8192/);
  assert.ok(!text.includes('截断'), '正常跑的时候不许说"截断"（那是另一回事）');

  const truncated = describeAiRun({ ...running, truncated: true } as never);
  assert.match(truncated, /被截断/);
});

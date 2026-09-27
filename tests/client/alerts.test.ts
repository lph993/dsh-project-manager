/**
 * FR-174 客户端警示角标的口径测试（`alertChipOf`）。
 *
 * 这块最容易出的错是**画了一个不该画的警示**（比如"0 错误"的绿标，或一条早已知悉的旧错误
 * 永远挂红），而它的代价和"该警示没警示"一样实在：用户会开始无视这个角标。
 * 所以边界（有无 lastError、是否已知悉、error 与 warn 谁优先）逐条钉住。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertChipOf } from '../../src/client/alerts.ts';

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-01-01T00:05:00.000Z';

describe('FR-174 状态条警示角标', () => {
  it('宿主没给 alerts（老宿主）⇒ 不画，而不是画"0 错误"', () => {
    assert.equal(alertChipOf(undefined, undefined), undefined);
  });

  it('没有 error 也没有 warn ⇒ 不画（不画 ≠ 绿标：我们没有"没出错"的依据）', () => {
    assert.equal(alertChipOf({ errors: 0, warns: 0 }, undefined), undefined);
  });

  it('有 error ⇒ 红标，条数直接写出来，并带上最新一条的原文与时间', () => {
    const chip = alertChipOf(
      { errors: 2, warns: 5, lastError: { at: T2, scope: 'ai', message: 'AI 建树失败：输出为空' } },
      undefined,
    );
    assert.equal(chip?.tone, 'error');
    assert.equal(chip?.label, '⚠ 2 错误');
    assert.match(chip?.title ?? '', /AI 建树失败：输出为空/);
    assert.match(chip?.title ?? '', /ai/, '要说清是哪个 scope 报的');
    assert.equal(chip?.ackAt, T2, '知悉记的是**这条**错误的时间戳');
  });

  it('有 error 的时候不报 warn（一句话说清一件事：严重程度不能被稀释）', () => {
    const chip = alertChipOf(
      { errors: 1, warns: 9, lastError: { at: T1, scope: 'storage', message: 'x' } },
      undefined,
    );
    assert.equal(chip?.tone, 'error');
    assert.doesNotMatch(chip?.label ?? '', /告警/);
  });

  it('error 条数 > 0 但缺 lastError（数据不全）⇒ 退回报 warn，不当成"该画红标"', () => {
    // 没有 lastError 就无法证明"这是新错误"，也没有可点的原文 —— 宁可退一档，不无依据地红
    const chip = alertChipOf({ errors: 1, warns: 3 }, undefined);
    assert.equal(chip?.tone, 'warn');
  });

  it('只有 warn ⇒ 灰标（红只留给异常）', () => {
    const chip = alertChipOf({ errors: 0, warns: 2 }, undefined);
    assert.equal(chip?.tone, 'warn');
    assert.equal(chip?.label, '2 告警');
  });

  it('已知悉的那条之后没有新错误 ⇒ 收起红标（日志仍在，去 /pm/debug 看）', () => {
    const alerts = { errors: 1, warns: 0, lastError: { at: T1, scope: 'ai', message: 'x' } };
    assert.equal(alertChipOf(alerts, T1), undefined, '同一时间戳 = 已经看过了');
    assert.equal(alertChipOf(alerts, T2), undefined, '知悉时间更晚 ⇒ 也是看过了');
  });

  it('知悉之后又出了新错误 ⇒ 重新红标（时间戳比较，不是条数比较）', () => {
    const alerts = { errors: 1, warns: 0, lastError: { at: T2, scope: 'ai', message: 'y' } };
    // 缓冲区回卷会让条数变小，所以"3 条已知悉"的条数法会把这条新错判成旧的
    const chip = alertChipOf(alerts, T1);
    assert.equal(chip?.tone, 'error');
    assert.equal(chip?.ackAt, T2);
  });

  it('已知悉红标、但缓冲区里还有别的 warn ⇒ 落回灰标（信息不丢）', () => {
    const alerts = { errors: 1, warns: 4, lastError: { at: T1, scope: 'ai', message: 'x' } };
    const chip = alertChipOf(alerts, T1);
    assert.equal(chip?.tone, 'warn');
    assert.equal(chip?.label, '4 告警');
  });
});

/**
 * FR-174 宿主侧警示摘要的口径测试（`alertsOf`）。
 *
 * 这里钉的是"看板上的数字与 `/pm/debug` 是同一个数"：
 * 计数取**当前缓冲区**（有界 200 条），不是累计；`lastError` 取**最新**一条。
 * 这两条一旦走偏，就会变成"告警说有错、日志里却翻不到"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alertsOf } from '../../src/adapter/alerts.ts';
import { debugBus, type DebugEntry } from '../../src/adapter/debug.ts';

/** 假总线：真实 `DebugBus` 是进程级单例，测试之间会互相污染，所以只用它的**只读形状**。 */
function fakeBus(entries: Array<{ level: DebugEntry['level']; ts: string; scope: string; message: string }>) {
  return {
    counts() {
      const out: Record<DebugEntry['level'], number> = { error: 0, warn: 0, info: 0, debug: 0 };
      for (const entry of entries) out[entry.level] += 1;
      return out;
    },
    lastError(): DebugEntry | undefined {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry !== undefined && entry.level === 'error') {
          return { seq: index + 1, ...entry };
        }
      }
      return undefined;
    },
  };
}

describe('FR-174 宿主侧警示摘要 alertsOf', () => {
  it('空缓冲 ⇒ 0/0 且**没有** lastError 字段（不给空壳对象）', () => {
    const alerts = alertsOf(fakeBus([]));
    assert.equal(alerts.errors, 0);
    assert.equal(alerts.warns, 0);
    assert.equal('lastError' in alerts, false);
  });

  it('按级别分开数：info/debug 不算警示', () => {
    const alerts = alertsOf(
      fakeBus([
        { level: 'info', ts: 't1', scope: 'storage', message: '用主路线' },
        { level: 'debug', ts: 't2', scope: 'ai', message: '用量已记账' },
        { level: 'warn', ts: 't3', scope: 'watch', message: '监听启动失败' },
        { level: 'error', ts: 't4', scope: 'ai', message: 'AI 建树失败' },
      ]),
    );
    assert.equal(alerts.errors, 1);
    assert.equal(alerts.warns, 1);
  });

  it('lastError 取**最新**一条（要的是"现在出的问题"，不是第一次出的）', () => {
    const alerts = alertsOf(
      fakeBus([
        { level: 'error', ts: 't1', scope: 'ai', message: '旧的' },
        { level: 'warn', ts: 't2', scope: 'watch', message: '中间' },
        { level: 'error', ts: 't3', scope: 'hook', message: '新的' },
      ]),
    );
    assert.equal(alerts.lastError?.message, '新的');
    assert.equal(alerts.lastError?.scope, 'hook');
    assert.equal(alerts.lastError?.at, 't3');
  });

  it('只有 warn ⇒ 有告警数、没有 lastError', () => {
    const alerts = alertsOf(fakeBus([{ level: 'warn', ts: 't1', scope: 'storage', message: '兜底路线' }]));
    assert.equal(alerts.warns, 1);
    assert.equal(alerts.errors, 0);
    assert.equal('lastError' in alerts, false);
  });

  it('与真实诊断总线对得上：record 之后计数即变（同一份数据，不是另设的累计器）', () => {
    const before = alertsOf(debugBus);
    debugBus.error('test-alerts', '口径测试写入的一条错误');
    const after = alertsOf(debugBus);
    assert.equal(after.errors, before.errors + 1, '缓冲区里加一条，计数就该加一');
    assert.equal(after.lastError?.scope, 'test-alerts');
    // 真实总线是单例：清掉，别把这条留给别的测试/诊断页
    debugBus.clear();
    assert.equal(alertsOf(debugBus).errors, 0, 'clear 之后必须归零（证明取的是缓冲区而不是累计器）');
  });
});

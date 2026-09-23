/**
 * 文件级锁与等待队列的契约测试（FR-106/107/108/110，§13.4）。
 *
 * 这里钉的是"两个 actor 会不会同时写同一个文件"这类**后果严重**的规矩：
 * 只读不占锁、写路径相交要排队、独占要挡住同节点的其它写、**不许插队**、
 * **要么全拿到要么一个都不拿**、释放后按 FIFO 让路、过期不留僵尸锁。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FileLockManager, normalizePaths } from '../../src/subscriptions/locks.ts';

const AT = '2026-01-01T00:00:00Z';

function manager(): FileLockManager {
  return new FileLockManager();
}

test('只读订阅：不占锁也不排队（可无限并行）', () => {
  const locks = manager();
  const a = locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'read',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const b = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'read',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(a.kind, 'granted');
  assert.equal(b.kind, 'granted', '只读之间永不冲突');
  assert.deepEqual(locks.snapshot().conflicts, []);
});

test('写订阅：路径互不相交 → 并行拿到', () => {
  const locks = manager();
  assert.equal(
    locks.acquire({
      subscriptionId: 's1',
      nodeId: 'n1',
      intent: 'write',
      touchedPaths: ['src/a.ts'],
      at: AT,
      onConflict: 'queue',
    }).kind,
    'granted',
  );
  assert.equal(
    locks.acquire({
      subscriptionId: 's2',
      nodeId: 'n2',
      intent: 'write',
      touchedPaths: ['src/b.ts'],
      at: AT,
      onConflict: 'queue',
    }).kind,
    'granted',
  );
});

test('写订阅：路径相交 → 排队，并说清被谁挡住', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/shared.ts', 'src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const second = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/shared.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(second.kind, 'queued');
  assert.deepEqual(second.kind === 'queued' ? second.waitingFor : [], ['s1']);
  assert.deepEqual(locks.blockedBy('s2'), ['s1']);
  assert.equal(locks.snapshot().waiting.length, 1);
  assert.deepEqual(locks.snapshot().conflicts, [
    { path: 'src/shared.ts', holders: ['s1'], waiters: ['s2'] },
  ]);
});

test('写订阅：策略为 reject 时直接拒绝，不排队', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const rejected = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'reject',
  });
  assert.equal(rejected.kind, 'rejected');
  assert.match(rejected.kind === 'rejected' ? rejected.reason : '', /s1/);
  assert.equal(locks.snapshot().waiting.length, 0, '拒绝的请求不进队列');
});

test('独占订阅：挡住同节点上的其它写订阅（哪怕路径不相交）', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const exclusiver = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n1',
    intent: 'exclusive',
    touchedPaths: ['src/z.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(exclusiver.kind, 'queued', '同节点已有写订阅 → 独占也要排队');

  // 反过来：独占持锁后，同节点的写订阅也进不来
  const locks2 = manager();
  locks2.acquire({
    subscriptionId: 'e1',
    nodeId: 'n9',
    intent: 'exclusive',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const writer = locks2.acquire({
    subscriptionId: 'w1',
    nodeId: 'n9',
    intent: 'write',
    touchedPaths: ['src/b.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(writer.kind, 'queued');
});

test('不许插队：前一个等待者还在排队时，后来的请求不能直接拿锁', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const first = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const second = locks.acquire({
    subscriptionId: 's3',
    nodeId: 'n3',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(first.kind, 'queued');
  assert.equal(second.kind, 'queued');
  assert.deepEqual(locks.blockedBy('s3'), ['s1', 's2'], 's3 要能看到排在前面的 s2');
});

test('要么全拿到要么一个都不拿：多路径时不会半持锁', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/b.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const multi = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/a.ts', 'src/b.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(multi.kind, 'queued');
  // s2 现在一个路径都没占到：它没进 holds
  assert.equal(locks.isHeldBy('s2'), false);
  assert.equal(locks.snapshot().holds.length, 1, '只应有 s1 一个持锁记录');
});

test('释放后按 FIFO 让路；让路时仍然整批判定', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's3',
    nodeId: 'n3',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const granted = locks.release('s1', AT);
  assert.deepEqual(granted, ['s2'], '只让给队首 s2，不能连带给 s3');
  assert.equal(locks.isHeldBy('s2'), true);
  assert.equal(locks.isHeldBy('s3'), false);
  assert.deepEqual(locks.blockedBy('s3'), ['s2']);

  const more = locks.release('s2', AT);
  assert.deepEqual(more, ['s3']);
  assert.equal(locks.isHeldBy('s3'), true);
});

test('释放不相关的订阅不会误伤别人的锁', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/b.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.release('s1', AT);
  assert.equal(locks.isHeldBy('s2'), true);
});

test('过期自动释放（FR-108：不留僵尸锁），并让路给等待者', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T00:10:00Z',
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: '2026-01-01T00:00:00Z',
    onConflict: 'queue',
  });
  // 还没到期：锁仍在
  assert.deepEqual(locks.sweepExpired('2026-01-01T00:05:00Z'), []);
  assert.equal(locks.isHeldBy('s1'), true);

  const released = locks.sweepExpired('2026-01-01T00:11:00Z');
  assert.deepEqual(released, ['s1']);
  assert.equal(locks.isHeldBy('s1'), false);
  assert.equal(locks.isHeldBy('s2'), true, '过期释放后要让路给排队者');
});

test('路径归一化：反斜杠 / 重复斜杠 / ./ 前缀 / 空白都视为同一把锁', () => {
  assert.deepEqual(normalizePaths(['src\\a.ts', 'src//a.ts', './src/a.ts', ' src/a.ts ']), ['src/a.ts']);
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src\\a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  const other = locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['./src//a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.equal(other.kind, 'queued', '写法不同但指向同一文件的路径必须判为冲突');
});

test('回滚要能查到某个节点上的全部持锁订阅（FR-109）', () => {
  const locks = manager();
  locks.acquire({
    subscriptionId: 's1',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/a.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's2',
    nodeId: 'n1',
    intent: 'write',
    touchedPaths: ['src/b.ts'],
    at: AT,
    onConflict: 'queue',
  });
  locks.acquire({
    subscriptionId: 's3',
    nodeId: 'n2',
    intent: 'write',
    touchedPaths: ['src/c.ts'],
    at: AT,
    onConflict: 'queue',
  });
  assert.deepEqual(locks.holdersOnNode('n1').sort(), ['s1', 's2']);
  assert.deepEqual(locks.holdersOnNode('n2'), ['s3']);
});

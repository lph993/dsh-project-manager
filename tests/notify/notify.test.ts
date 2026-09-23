/**
 * 进度回写规则的契约测试（Q6 / FR-112–118）。
 *
 * 这套规则的全部价值在于**省钱**：多发一条就多一份上下文成本，少发一条模型就看不见。
 * 所以这里逐条钉住"什么必须发、什么绝对不发"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NotifyLedger,
  formatNotice,
  inSessionScope,
  keyEventOf,
  noticeFor,
  type NotifyNode,
} from '../../src/notify/index.ts';

function node(partial: Partial<NotifyNode> & { id: string }): NotifyNode {
  return {
    name: partial.id,
    derivedState: 'pending',
    progress: 0,
    gate: null,
    childCount: 0,
    unfinishedLeafCount: 1,
    leafCount: 1,
    ...partial,
  };
}

test('只发关键事件：完成 / 异常 / 枝完成 / 门控置位与解除', () => {
  assert.equal(
    keyEventOf({ state: 'running', gate: null }, node({ id: 'a', derivedState: 'done', progress: 1 })),
    'node-done',
  );
  assert.equal(
    keyEventOf(
      { state: 'running', gate: null },
      node({ id: 'b', derivedState: 'done', childCount: 2, progress: 1, unfinishedLeafCount: 0, leafCount: 2 }),
    ),
    'branch-done',
    '枝完成比单个叶完成更值得通知',
  );
  assert.equal(
    keyEventOf({ state: 'running', gate: null }, node({ id: 'c', derivedState: 'error' })),
    'node-error',
  );
  assert.equal(
    keyEventOf({ state: 'running', gate: null }, node({ id: 'd', derivedState: 'running', gate: 'paused' })),
    'gate-on',
  );
  assert.equal(
    keyEventOf({ state: 'running', gate: 'paused' }, node({ id: 'd', derivedState: 'running' })),
    'gate-off',
  );
});

test('progress 微增绝不发事件（这是控 token 的关键一条）', () => {
  const before = { state: 'running', gate: null } as const;
  assert.equal(
    keyEventOf(before, node({ id: 'a', derivedState: 'running', progress: 0.5 })),
    undefined,
    '0.4 → 0.5 不该进上下文（FR-113）',
  );
  assert.equal(keyEventOf(before, node({ id: 'a', derivedState: 'running', progress: 1 })), undefined);
  // 首次见到一个"本就已完成"的节点也不该发：那不是"变化"
  assert.equal(keyEventOf(undefined, node({ id: 'z', derivedState: 'done', progress: 1 })), 'node-done');
});

test('单行文本：id + 名称 + 状态 + 完成度，枝额外带件数（FR-114）', () => {
  const leaf = formatNotice({
    kind: 'node-done',
    nodeId: 'n1',
    name: '登录页',
    state: 'done',
    progress: 1,
  });
  assert.equal(leaf, '[pm] n1 「登录页」 done 100%');
  assert.equal(leaf.includes('\n'), false, '必须是单行');

  const branch = formatNotice({
    kind: 'branch-done',
    nodeId: 'n2',
    name: '前端',
    state: 'done',
    progress: 1,
    counts: { unfinished: 0, total: 3 },
  });
  assert.match(branch, /branch done 100% \(3\/3\)/);

  const gate = formatNotice({
    kind: 'gate-on',
    nodeId: 'n3',
    name: '服务端',
    state: 'running',
    progress: 0.5,
    gate: 'held',
  });
  assert.match(gate, /gate=held 50%/);
});

test('去重：同一节点同一状态只发一次，状态再变还能继续发（FR-116）', () => {
  const ledger = new NotifyLedger();
  const done = node({ id: 'n1', derivedState: 'done', progress: 1 });

  const first = noticeFor(ledger, done);
  assert.ok(first);
  // 还没提交（没投递成功）时重复调用仍会给出通知 —— 提交由服务在**投递成功后**做
  ledger.commit('n1', done);

  const second = noticeFor(ledger, done);
  assert.equal(second, undefined, '同一状态不重复推');
  assert.equal(ledger.stats().suppressed, 1);

  const again = noticeFor(ledger, node({ id: 'n1', derivedState: 'running', progress: 0.2 }));
  assert.equal(again, undefined, 'running 不是关键事件');

  const reopened = noticeFor(ledger, node({ id: 'n1', derivedState: 'error' }));
  assert.ok(reopened, '状态再变化（完成 → 异常）应继续通知');
});

test('会话裁剪：只推"订阅过"或"关注枝上"的节点（FR-115）', () => {
  const scope = {
    subscribedNodeIds: new Set(['n1']),
    focusedNodeIds: new Set(['root', 'f1']),
  };
  assert.equal(inSessionScope('n1', scope), true, '订阅过 → 推');
  assert.equal(inSessionScope('f1', scope), true, '关注枝上 → 推');
  assert.equal(inSessionScope('n9', scope), false, '既没订阅也不在关注枝 → 不推（否则全树广播）');
});

test('统计能核对"省了多少"（FR-117）', () => {
  const ledger = new NotifyLedger();
  ledger.countSent();
  ledger.countSent();
  ledger.countSuppressed();
  assert.deepEqual(ledger.stats(), { sent: 2, suppressed: 1, tracked: 0 });
});

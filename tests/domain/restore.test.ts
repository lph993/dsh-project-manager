/**
 * 回滚还原通道（`PatchRequest.restore`）的契约测试。
 *
 * **为什么单独钉它**：整枝回滚的端到端测试当场抓到两个真 bug ——
 * ① 回滚锁（C9）把**回滚自己**的状态还原也挡了；
 * ② `done → pending` 在正常迁移表里根本不存在，于是"回到快照点的已完成/未完成"永远写不回去。
 * 两个都表现为"文件回来了、节点状态原地不动"，看板就成了半截回滚。
 *
 * 这里同时钉住**收紧**的一面：还原通道必须 force + user，普通写入一律拿不到它。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWrite, type PatchRequest, type ValidateContext } from '../../src/domain/validate.ts';
import type { NodeRecord } from '../../src/shared/types.ts';

function node(partial: Partial<NodeRecord> & { id: string }): NodeRecord {
  return {
    name: partial.id,
    kind: 'task',
    parentId: null,
    selfState: 'pending',
    progress: 0,
    weight: 1,
    focus: false,
    gate: null,
    flags: [],
    refs: [],
    autoCreated: false,
    blockedBy: [],
    revision: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'user',
    addedMidway: false,
    subscriptions: [],
    ...partial,
  } as NodeRecord;
}

function context(target: NodeRecord, extra: Partial<ValidateContext> = {}): ValidateContext {
  return { node: target, childCount: 0, policy: 'auto-fix-first', ...extra };
}

test('还原通道：done → pending 是"回到快照点"，不受迁移表限制', () => {
  const done = node({ id: 'n1', selfState: 'done', progress: 1 });
  const request: PatchRequest = {
    nodeId: 'n1',
    by: 'user',
    force: true,
    restore: true,
    patch: { selfState: 'pending', progress: 0 },
    reason: '回滚到 snap_x',
  };
  const decision = validateWrite(request, context(done));
  assert.equal(decision.kind, 'accept', `应放行：${JSON.stringify(decision)}`);
});

test('还原通道：回滚锁（C9）不挡回滚自己发出的还原写入', () => {
  const running = node({ id: 'n1', selfState: 'running', progress: 0.4 });
  const decision = validateWrite(
    {
      nodeId: 'n1',
      by: 'user',
      force: true,
      restore: true,
      patch: { selfState: 'pending', progress: 0 },
    },
    context(running, { rollbackLocked: true }),
  );
  assert.equal(decision.kind, 'accept');

  // 同样的写入，**不带** restore → 被锁拒绝（锁仍然对外人有效）
  const outsider = validateWrite(
    { nodeId: 'n1', by: 'user', force: true, patch: { selfState: 'pending', progress: 0 } },
    context(running, { rollbackLocked: true }),
  );
  assert.equal(outsider.kind, 'reject');
  assert.equal(outsider.kind === 'reject' ? outsider.code : '', 'C9');
});

test('还原通道：必须 force + 来源 user（收紧，不给普通写入开后门）', () => {
  const done = node({ id: 'n1', selfState: 'done', progress: 1 });
  const noForce = validateWrite(
    { nodeId: 'n1', by: 'user', restore: true, patch: { selfState: 'pending', progress: 0 } },
    context(done),
  );
  assert.equal(noForce.kind, 'reject');

  const asSession = validateWrite(
    {
      nodeId: 'n1',
      by: 'session',
      force: true,
      restore: true,
      patch: { selfState: 'pending', progress: 0 },
    },
    context(done),
  );
  assert.equal(asSession.kind, 'reject');

  // 普通写入（无 restore）依旧过不了 done → pending
  const normal = validateWrite(
    { nodeId: 'n1', by: 'user', force: true, patch: { selfState: 'pending', progress: 0 } },
    context(done),
  );
  assert.equal(normal.kind, 'reject');
  assert.equal(normal.kind === 'reject' ? normal.code : '', 'C6');
});

test('还原通道：不放过别的校验（引用逃逸仍然拒）', () => {
  const running = node({ id: 'n1', selfState: 'running' });
  const decision = validateWrite(
    {
      nodeId: 'n1',
      by: 'user',
      force: true,
      restore: true,
      patch: { selfState: 'pending', refs: [{ type: 'code', target: '../escape.ts' }] },
    },
    context(running, { escapingRefTargets: ['../escape.ts'] }),
  );
  assert.equal(decision.kind, 'reject');
  assert.equal(decision.kind === 'reject' ? decision.code : '', 'C7');
});

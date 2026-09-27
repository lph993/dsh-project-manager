/**
 * 节点进度摘要单测（用户诉求："从未完成节点发起会话进行开始处理的能力"）。
 *
 * 摘要的用处是"把现状带进新会话"，所以两条判据最重要：
 * ① **有依据的字段要写全**（路径、状态、描述、引用、未完成数）—— 少一项，新会话就少一点上下文；
 * ② **没依据的不许编** —— 没有描述就不出现"描述"行，也不替模型写"建议先做 X"这类结论。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNodeSummary } from '../../src/client/summary.ts';

const base = {
  name: '登录页',
  kind: 'task',
  derivedState: 'running',
  progress: 0.4,
  branchPath: ['示例项目', '前端'],
};

test('把有依据的字段都写进摘要（路径/状态/规模/描述/引用）', () => {
  const text = buildNodeSummary({
    ...base,
    description: '登录态与权限校验，含会话续期',
    refs: [{ type: 'dir', target: 'src/auth' }, { type: 'code', target: 'src/auth/index.ts' }],
    leafCount: 12,
    unfinishedLeafCount: 8,
    childCount: 2,
  });
  assert.ok(text.includes('示例项目 / 前端 / 登录页'), '要给出从根到它的路径');
  assert.ok(text.includes('进行中（40%）'), '状态用中文，且带百分比');
  assert.ok(text.includes('12 个任务点，其中未完成 8 个'));
  assert.ok(text.includes('登录态与权限校验，含会话续期'));
  assert.ok(text.includes('src/auth') && text.includes('src/auth/index.ts'));
});

test('没有的字段不许编：没描述就没有"描述"行，也不替模型下结论', () => {
  const text = buildNodeSummary({ ...base, leafCount: 1, unfinishedLeafCount: 1 });
  assert.ok(!text.includes('描述：'), '没有描述就不该出现这一行（而不是写"（无）"占地方）');
  assert.ok(!text.includes('引用：'), '没有引用同理');
  assert.ok(!/建议|应该|先做/.test(text), '不许替模型给结论 —— 摘要只陈述已知字段');
});

test('已完成 = 100%；未完成即使接近 1 也只写 99%（与界面口径同源）', () => {
  assert.ok(buildNodeSummary({ ...base, derivedState: 'done', progress: 1 }).includes('已完成（100%）'));
  assert.ok(
    buildNodeSummary({ ...base, derivedState: 'running', progress: 0.996 }).includes('进行中（99%）'),
    '没完成不许写 100%（用户实测提问："这个意思是还没完成吗？"）',
  );
});

test('优先级与前置只在有值时才写', () => {
  const withPriority = buildNodeSummary({ ...base, priority: 3 });
  assert.ok(withPriority.includes('优先级：3'));
  const withBlocked = buildNodeSummary({ ...base, blockedBy: ['a', 'b'] });
  assert.ok(withBlocked.includes('2 项未完成'));
  const plain = buildNodeSummary(base);
  assert.ok(!plain.includes('优先级') && !plain.includes('前置'), '没有的信息不要占行');
});

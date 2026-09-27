/**
 * "下一个该做的"排序单测（FR-162，用户口径："按**关注点 → 优先级 → 进度** 这样的排序获取"）。
 *
 * 这套口径的价值在于**可复现**：同一棵树、同一份优先级，永远取到同一条。
 * 所以下面既测"优先级顺序对不对"，也测"顺序稳不稳定"（不然使用者每次看到的下一步都不一样）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextTaskOf, type TaskCandidate } from '../../src/domain/next-task.ts';

const task = (partial: Partial<TaskCandidate> & { name: string }): TaskCandidate => ({
  id: partial.name,
  derivedState: 'pending',
  progress: 0,
  inFocusChain: false,
  ...partial,
});

test('第一级：关注链路内的优先（哪怕它优先级数字更大）', () => {
  const picked = nextTaskOf([
    task({ name: '旁枝高优先', priority: 1, inFocusChain: false }),
    task({ name: '关注枝低优先', priority: 9, inFocusChain: true }),
  ]);
  assert.equal(picked?.name, '关注枝低优先');
});

/**
 * **第 0 级：待审查**（FR-164）。用户口径原话："**审查优先级大于关注**"。
 *
 * 语义上说得通："审过的活才算数" —— 如果待审的活永远排在关注与优先级后面，
 * 那它就永远轮不到（每轮都有更高优先级的活插队），审不完的东西会一直堆着。
 */
test('第 0 级：待审查压过关注与优先级', () => {
  const picked = nextTaskOf([
    task({ name: '关注枝高优先', priority: 1, inFocusChain: true }),
    task({ name: '待审查的低优先', priority: 9, inFocusChain: false, needsReview: true }),
  ]);
  assert.equal(picked?.name, '待审查的低优先', '审查优先级大于关注（用户原话）');
  // 反过来：两条都待审时，才回到关注 → 优先级的老口径
  const both = nextTaskOf([
    task({ name: '待审A', priority: 9, inFocusChain: false, needsReview: true }),
    task({ name: '待审B', priority: 2, inFocusChain: true, needsReview: true }),
  ]);
  assert.equal(both?.name, '待审B', '同为待审 ⇒ 按关注 → 优先级');
});

test('待审节点不影响"不参与排序"的过滤（已完成/已删除仍然跳过）', () => {
  const picked = nextTaskOf([
    task({ name: '已完成的待审', derivedState: 'done', needsReview: true }),
    task({ name: '正常的', priority: 5 }),
  ]);
  assert.equal(picked?.name, '正常的', '已完成的不该因为"待审"又被捞回来');
});

test('第二级：同为关注链路时按优先级（1 最高）', () => {
  const picked = nextTaskOf([
    task({ name: '低优先', priority: 8, inFocusChain: true }),
    task({ name: '高优先', priority: 2, inFocusChain: true }),
  ]);
  assert.equal(picked?.name, '高优先');
});

test('第二级：**没给优先级的不许插队** —— 排在给了的后面', () => {
  const picked = nextTaskOf([
    task({ name: '没表态', inFocusChain: true }),
    task({ name: '明确低优先', priority: 10, inFocusChain: true }),
  ]);
  assert.equal(picked?.name, '明确低优先', 'undefined 优先级当"最后"，不当 0 也不当中位');
});

test('第三级：关注与优先级都相同时，进度低的优先', () => {
  const picked = nextTaskOf([
    task({ name: '快完成', priority: 5, progress: 0.9, inFocusChain: true }),
    task({ name: '刚开工', priority: 5, progress: 0.1, inFocusChain: true }),
  ]);
  assert.equal(picked?.name, '刚开工');
});

test('第四级：全都相同 → 按名称，**顺序可复现**（同输入两次结果一致）', () => {
  const pool = [task({ name: 'B 任务', priority: 5 }), task({ name: 'A 任务', priority: 5 })];
  const first = nextTaskOf(pool)?.name;
  const second = nextTaskOf([...pool].reverse())?.name;
  assert.equal(first, second, '输入顺序不同也必须取到同一条（否则每次刷新换一条）');
});

test('已完成 / 已删除不参与"下一个该做的"', () => {
  assert.equal(
    nextTaskOf([
      task({ name: '做完的', derivedState: 'done', priority: 1 }),
      task({ name: '删掉的', derivedState: 'removed', priority: 1 }),
    ]),
    undefined,
    '没有可做的时候要返回 undefined（而不是硬推一条已完成的）',
  );
  assert.equal(
    nextTaskOf([
      task({ name: '做完的', derivedState: 'done', priority: 1 }),
      task({ name: '还能做的', priority: 9 }),
    ])?.name,
    '还能做的',
  );
});

test('异常/暂停这些"要人管"的状态仍然参与（它们没做完，也常常最该先看）', () => {
  const picked = nextTaskOf([
    task({ name: '正常待办', priority: 3 }),
    task({ name: '出错了', derivedState: 'error', priority: 3 }),
  ]);
  // 同优先同时，按名称兜底；关键是 error 没被过滤掉
  assert.ok(picked !== undefined);
  const both = [task({ name: '正常待办', priority: 3 }), task({ name: '出错了', derivedState: 'error', priority: 3 })];
  assert.equal(nextTaskOf(both)?.name, nextTaskOf([...both].reverse())?.name, '顺序稳定');
});

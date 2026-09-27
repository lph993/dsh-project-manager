/**
 * 未完成列表排序口径的契约（FR-162 ②：优先级必须在 UI 上真正起作用）。
 *
 * 这一层为什么值得单测：排序规则被用户纠正过两次（"进度低的在前"把 0% 顶到最前是错的），
 * 而且**优先级与进度是两个轴**：优先级是"该不该先干"，进度是"干了多少"。
 * 一旦把未设置的优先级当成 0，它就会被当"最高优先级"顶到最前 —— 那是本文件最想钉住的一条。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orderUnfinished, type UnfinishedRow } from '../../src/client/unfinished-order.ts';

const row = (partial: Partial<UnfinishedRow> & { id: string }): UnfinishedRow => ({
  name: partial.id,
  derivedState: 'pending',
  progress: 0,
  ...partial,
});

test('done 沉底、running 最先（沿用用户认可的"活的任务优先"）', () => {
  const rows = orderUnfinished([
    row({ id: 'd', derivedState: 'done' }),
    row({ id: 'p', derivedState: 'pending' }),
    row({ id: 'r', derivedState: 'running' }),
    row({ id: 'h', derivedState: 'held' }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['r', 'p', 'h', 'd']);
});

test('优先级优先于进度：1 最高的排最前，哪怕它进度更低', () => {
  const rows = orderUnfinished([
    row({ id: 'low-prio-high-progress', priority: 9, progress: 0.8 }),
    row({ id: 'high-prio-low-progress', priority: 1, progress: 0.05 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['high-prio-low-progress', 'low-prio-high-progress'],
    '优先级是"该不该先干"，不该被"干了多少"盖过（FR-162 ②）',
  );
});

test('**未设置的优先级排最后**，不许当成 0（否则它会顶到最前）', () => {
  const rows = orderUnfinished([
    row({ id: 'unset' }),
    row({ id: 'prio-10', priority: 10 }),
    row({ id: 'prio-3', priority: 3 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['prio-3', 'prio-10', 'unset'],
    '未设置 = 没有依据，不该比"明确说了先做"的更靠前',
  );
});

test('同优先级内：进度高的在前，最后按名称兜底（顺序稳定）', () => {
  const rows = orderUnfinished([
    row({ id: 'b', priority: 5, progress: 0.1 }),
    row({ id: 'a', priority: 5, progress: 0.1 }),
    row({ id: 'c', priority: 5, progress: 0.4 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a', 'b']);
  // 同样的输入换顺序 ⇒ 同样的输出（刷新时列表不许跳来跳去）
  const again = orderUnfinished([
    row({ id: 'c', priority: 5, progress: 0.4 }),
    row({ id: 'a', priority: 5, progress: 0.1 }),
    row({ id: 'b', priority: 5, progress: 0.1 }),
  ]);
  assert.deepEqual(again.map((r) => r.id), ['c', 'a', 'b']);
});

test('**两条都没设优先级**时，必须继续按进度比（不许因 Infinity 相减而乱序）', () => {
  /**
   * 这是从渲染自检里抓回来的真 bug：`Infinity - Infinity = NaN`，
   * 比较器返回 NaN ⇒ 顺序未定义，实测"进度高的那条没排在前面"。
   * 只要库里还没有优先级（现在的树就是这样），这条就是**主路径**，不是边界情况。
   */
  const rows = orderUnfinished([
    row({ id: '没动过', progress: 0 }),
    row({ id: '已起头', progress: 0.3 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['已起头', '没动过']);
});

test('running 与 pending 分档：running 里的低优先级也排在 pending 的高优先级之前', () => {
  const rows = orderUnfinished([
    row({ id: 'pending-p1', derivedState: 'pending', priority: 1 }),
    row({ id: 'running-p9', derivedState: 'running', priority: 9 }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['running-p9', 'pending-p1'], '"正在跑"本身就该被看到');
});

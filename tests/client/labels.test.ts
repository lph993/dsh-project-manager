/**
 * 节点数字口径的契约测试（用户纠偏：**以项目进度为主**）。
 *
 * 这一层值得单测的理由：它是**五处界面共用的同一份数字**（画布节点、悬停提示、属性栏、
 * 右栏实时进度、看板指标行）。散着写必然漂移，而"同一份数据在两个地方说法不一致"
 * 正是本项目最不能接受的那类问题（口径必须同源，FR-71）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  doneCountOf,
  isBranch,
  nodeCountHint,
  nodeCountLabel,
  nodeHeadline,
  percentOf,
} from '../../src/client/labels.ts';

test('已完成数 = 总数 − 未完成数（坏数据也不会给出负数）', () => {
  assert.equal(doneCountOf({ leafCount: 33, unfinishedLeafCount: 12 }), 21);
  assert.equal(doneCountOf({ leafCount: 3, unfinishedLeafCount: 0 }), 3);
  assert.equal(doneCountOf({ leafCount: 0, unfinishedLeafCount: 0 }), 0);
  assert.equal(doneCountOf({ leafCount: 2, unfinishedLeafCount: 5 }), 0, '坏数据钳到 0');
  assert.equal(doneCountOf({ leafCount: -3, unfinishedLeafCount: 0 }), 0);
});

test('枝判据看 childCount（没有该字段时退回 leafCount > 1）', () => {
  assert.equal(isBranch({ childCount: 2, leafCount: 2 }), true);
  assert.equal(isBranch({ childCount: 0, leafCount: 1 }), false);
  assert.equal(isBranch({ childCount: 0, leafCount: 0 }), false);
  assert.equal(isBranch({ leafCount: 3 }), true);
  assert.equal(isBranch({ leafCount: 1 }), false);
});

test('画布节点文案：枝给「总 / 已完成」，叶给自身百分比', () => {
  // 枝：**纯数字**（用户原话"总功能/任务 / 已完成 这样纯数字的"）
  assert.equal(
    nodeCountLabel({ childCount: 4, leafCount: 33, unfinishedLeafCount: 12 }),
    '33 / 21',
  );
  assert.equal(
    nodeCountLabel({ childCount: 2, leafCount: 3, unfinishedLeafCount: 3 }),
    '3 / 0',
  );
  // 叶：单件没有"总数"可言，百分比就是它的进度
  assert.equal(nodeCountLabel({ childCount: 0, leafCount: 1, unfinishedLeafCount: 1, progress: 0.45 }), '45%');
  assert.equal(nodeCountLabel({ childCount: 0, leafCount: 1, unfinishedLeafCount: 0, progress: 1 }), '100%');
  assert.equal(nodeCountLabel({ childCount: 0, leafCount: 1, unfinishedLeafCount: 1, progress: 0 }), '0%');
});

test('口径说明：纯数字必须能在别处问到含义（否则就是"看着像写错了"）', () => {
  assert.equal(
    nodeCountHint({ childCount: 4, leafCount: 33, unfinishedLeafCount: 12 }),
    '总 33 个任务点 / 已完成 21 个',
  );
  assert.equal(
    nodeCountHint({ childCount: 0, leafCount: 1, unfinishedLeafCount: 1, progress: 0.3 }),
    '自身进度 30%',
  );
});

test('百分比：越界与非法值不渲染 NaN% / 1000%', () => {
  assert.equal(percentOf(0.456), 46);
  assert.equal(percentOf(1.7), 100);
  assert.equal(percentOf(-2), 0);
  assert.equal(percentOf(Number.NaN), 0);
  assert.equal(percentOf(undefined), 0);
});

test('属性栏顶部大号数字牌：枝给「总 / 已完成」，叶给自身百分比', () => {
  // 用户要求：「选中节点的『总 / 已完成』用大号数字放在右侧属性栏顶部」
  const branch = nodeHeadline({ childCount: 4, leafCount: 72, unfinishedLeafCount: 66, progress: 0.69 });
  assert.equal(branch.primary, '72 / 6');
  assert.equal(branch.caption, '总 72 个任务点 / 已完成 6');
  assert.equal(branch.percent, '69%', '件数与百分比都给，避免"只有件数"的割裂');

  const leaf = nodeHeadline({ childCount: 0, leafCount: 1, unfinishedLeafCount: 1, progress: 0.5 });
  assert.equal(leaf.primary, '50%', '叶节点写 1 / 0 是噪声，单件没有"总数"可言');
  assert.equal(leaf.caption, '自身进度');
  assert.equal(leaf.percent, '50%');
});

test('大号数字牌与画布节点口径一致（同一份数字，不允许两处说法不同）', () => {
  for (const node of [
    { childCount: 4, leafCount: 72, unfinishedLeafCount: 66, progress: 0.69 },
    { childCount: 0, leafCount: 1, unfinishedLeafCount: 0, progress: 1 },
    { childCount: 2, leafCount: 3, unfinishedLeafCount: 3, progress: 0 },
  ]) {
    assert.equal(nodeHeadline(node).primary, nodeCountLabel(node));
  }
});

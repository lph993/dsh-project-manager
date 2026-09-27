/**
 * 流程图"全部 / 仅功能 / 仅任务"过滤的单测。
 *
 * 用户诉求："任务和功能可以选择性展示，渲染流程图那加个 select：全部/功能/任务"。
 *
 * 这一层最容易错的地方**不是"筛掉不匹配的"**，而是"父节点被筛掉之后子节点去哪" ——
 * 直接丢会让图上出现悬空节点（树散了）。所以下面重点钉三件事：
 * ① 根永远保留（树的锚点）；② 父被筛掉时子节点提升到最近的保留祖先；
 * ③ 任何情况下都不产生"父不在结果里"的节点。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterByKind } from '../../src/client/flow-layout.ts';

interface Row {
  id: string;
  parentId: string | null;
  kind: string;
}

/**
 * 树：root(feature) → 前端(feature) → 登录页(task) / 路由(task)
 *                  → 后端(feature) → 接口(task)
 */
const TREE: Row[] = [
  { id: 'root', parentId: null, kind: 'feature' },
  { id: 'fe', parentId: 'root', kind: 'feature' },
  { id: 'fe-login', parentId: 'fe', kind: 'task' },
  { id: 'fe-router', parentId: 'fe', kind: 'task' },
  { id: 'be', parentId: 'root', kind: 'feature' },
  { id: 'be-api', parentId: 'be', kind: 'task' },
];

test('全部：原样返回（不过滤）', () => {
  assert.deepEqual(
    filterByKind(TREE, 'all').map((row) => row.id),
    ['root', 'fe', 'fe-login', 'fe-router', 'be', 'be-api'],
  );
});

test('仅功能：只留 feature（根 + 两个大功能），任务全下去', () => {
  const ids = filterByKind(TREE, 'feature').map((row) => row.id);
  assert.deepEqual(ids, ['root', 'fe', 'be']);
});

test('仅任务：任务留下，且**提升到根下**（中间的功能层被筛掉了）', () => {
  const out = filterByKind(TREE, 'task');
  assert.deepEqual(
    out.map((row) => row.id),
    ['root', 'fe-login', 'fe-router', 'be-api'],
    '根 + 三个任务',
  );
  for (const row of out) {
    if (row.id === 'root') continue;
    assert.equal(row.parentId, 'root', `${row.id} 的父被筛掉了，必须提升到根下（不能悬空）`);
  }
});

test('不变量：结果里任何节点（除根）的父都必须也在结果里', () => {
  for (const filter of ['all', 'feature', 'task'] as const) {
    const out = filterByKind(TREE, filter);
    const ids = new Set(out.map((row) => row.id));
    for (const row of out) {
      if (row.parentId === null) continue;
      assert.ok(ids.has(row.parentId), `[${filter}] ${row.id} 的父 ${row.parentId} 不在结果里 ⇒ 悬空`);
    }
  }
});

test('根永远保留：哪怕它的种类不匹配（它只是容器，不是被显示的那类节点）', () => {
  const rootIsTask: Row[] = [
    { id: 'root', parentId: null, kind: 'task' },
    { id: 'f1', parentId: 'root', kind: 'feature' },
  ];
  const onlyFeature = filterByKind(rootIsTask, 'feature');
  assert.deepEqual(onlyFeature.map((row) => row.id), ['root', 'f1'], '根必须留着（否则整棵树没有锚点）');
  // 「仅任务」时根本身恰好是 task：结果里只有它（没有别的 task 节点）
  assert.deepEqual(filterByKind(rootIsTask, 'task').map((row) => row.id), ['root']);
});

test('多层被筛掉时：提升到**最近的**保留祖先（不是一路提到根）', () => {
  const deep: Row[] = [
    { id: 'root', parentId: null, kind: 'feature' },
    { id: 'keep', parentId: 'root', kind: 'feature' },
    { id: 'skip', parentId: 'keep', kind: 'task' }, // 这一层会被筛掉
    { id: 'leaf', parentId: 'skip', kind: 'feature' }, // 它应该挂到 keep 下
  ];
  const out = filterByKind(deep, 'feature');
  assert.deepEqual(out.map((row) => row.id), ['root', 'keep', 'leaf']);
  assert.equal(out.find((row) => row.id === 'leaf')?.parentId, 'keep', '要挂到最近的保留祖先下');
});

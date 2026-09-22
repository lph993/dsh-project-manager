/**
 * 流程图布局（`src/client/flow-layout.ts`）的契约测试。
 *
 * 布局是**纯函数**，所以能被 `node --test` 直接跑（画布组件本身是 .tsx，Node 不认 JSX）。
 * 这里钉的是"图上不会自相矛盾"的几条：分层不重叠、父节点居中、折叠只隐藏子树、
 * 关注枝沿子树传播、数据成环也不死循环。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLOW_GAP_Y, FLOW_NODE_HEIGHT, layoutFlow } from '../../src/client/flow-layout.ts';
import type { NodeView } from '../../src/client/contract.ts';

/** 造一个最小 NodeView（只填布局用得到的字段）。 */
function node(partial: Partial<NodeView> & { id: string; name: string }): NodeView {
  return {
    parentId: null,
    kind: 'task',
    selfState: 'pending',
    derivedState: 'pending',
    progress: 0,
    weight: 1,
    focus: false,
    gate: null,
    flags: [],
    autoCreated: false,
    childCount: 0,
    leafCount: 1,
    unfinishedLeafCount: 1,
    blockedBy: [],
    revision: 0,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'user',
    addedMidway: false,
    subscriptionCount: 0,
    branchPath: [],
    ...partial,
  };
}

/** 根 → 两个子 → 每个子两个孩子。 */
const TREE: NodeView[] = [
  node({ id: 'root', name: '根', kind: 'feature', childCount: 2, leafCount: 4, unfinishedLeafCount: 3 }),
  node({ id: 'a', name: 'A', parentId: 'root', kind: 'feature', childCount: 2, leafCount: 2, unfinishedLeafCount: 2 }),
  node({ id: 'b', name: 'B', parentId: 'root', kind: 'feature', childCount: 2, leafCount: 2, unfinishedLeafCount: 1 }),
  node({ id: 'a1', name: 'A1', parentId: 'a' }),
  node({ id: 'a2', name: 'A2', parentId: 'a' }),
  node({ id: 'b1', name: 'B1', parentId: 'b' }),
  node({ id: 'b2', name: 'B2', parentId: 'b' }),
];

describe('流程图布局', () => {
  it('分层：y 只由深度决定，深度相同即同一行', () => {
    const { placed } = layoutFlow(TREE);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    assert.equal(byId.get('root')?.y, 0);
    assert.equal(byId.get('a')?.y, FLOW_NODE_HEIGHT + FLOW_GAP_Y);
    assert.equal(byId.get('b')?.y, byId.get('a')?.y);
    assert.equal(byId.get('a1')?.y, 2 * (FLOW_NODE_HEIGHT + FLOW_GAP_Y));
    assert.equal(byId.get('b2')?.y, byId.get('a1')?.y);
  });

  it('父节点横向居中于其可见子节点，且同层不重叠', () => {
    const { placed, nodeWidth } = layoutFlow(TREE);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    const a = byId.get('a')!;
    const a1 = byId.get('a1')!;
    const a2 = byId.get('a2')!;
    assert.ok(
      Math.abs(a.x + nodeWidth / 2 - (a1.x + a2.x + nodeWidth) / 2) < 1e-6,
      '父节点应居中于子节点',
    );
    const row = placed.filter((p) => p.depth === 2).sort((l, r) => l.x - r.x);
    for (let i = 1; i < row.length; i += 1) {
      assert.ok(row[i]!.x >= row[i - 1]!.x + nodeWidth, '同层节点不得重叠');
    }
  });

  it('折叠：只隐藏该节点的子树，并如实记下隐藏了几个孩子', () => {
    const { placed } = layoutFlow(TREE, { collapsed: new Set(['a']) });
    const ids = placed.map((p) => p.node.id);
    assert.deepEqual(ids.includes('a1'), false);
    assert.deepEqual(ids.includes('a2'), false);
    assert.ok(ids.includes('b1'), '另一个枝不受影响');
    const a = placed.find((p) => p.node.id === 'a')!;
    assert.equal(a.hiddenChildren, 2);
  });

  it('关注枝沿子树传播（关注根 = 整枝都是主枝）', () => {
    const focused = TREE.map((n) => (n.id === 'root' ? { ...n, focus: true } : n));
    const { placed } = layoutFlow(focused);
    assert.equal(placed.every((p) => p.inFocusBranch), true);
  });

  it('未关注枝标记为旁枝（供虚线/降饱和渲染）', () => {
    const { placed, edges } = layoutFlow(TREE);
    assert.equal(placed.every((p) => p.inFocusBranch === false), true);
    assert.equal(edges.length, TREE.length - 1, '树的边数 = 节点数 - 1');
  });

  it('空输入与成环数据都不会崩', () => {
    const empty = layoutFlow([]);
    assert.deepEqual(empty.placed, []);
    assert.equal(empty.height > 0, true);

    const cyclic: NodeView[] = [
      node({ id: 'x', name: 'X', parentId: 'y' }),
      node({ id: 'y', name: 'Y', parentId: 'x' }),
    ];
    const layout = layoutFlow(cyclic);
    assert.equal(layout.placed.length, 2);
  });

  it('画布尺寸覆盖全部节点（不会把节点画到框外）', () => {
    const { placed, width, height, nodeWidth, nodeHeight } = layoutFlow(TREE);
    for (const p of placed) {
      assert.ok(p.x >= 0 && p.x + nodeWidth <= width + 1, `节点 ${p.node.id} 横向越界`);
      assert.ok(p.y >= 0 && p.y + nodeHeight <= height + 1, `节点 ${p.node.id} 纵向越界`);
    }
  });
});

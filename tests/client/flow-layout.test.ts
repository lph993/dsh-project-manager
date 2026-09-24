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

  it('折叠：徽标数 = 被藏起来的整棵子树节点数（不是直接子节点数）', () => {
    // 折 B：B 下面只有两个叶子，所以"子树规模"恰好等于直接子节点数
    const shallow = layoutFlow(TREE, { collapsed: new Set(['b']) });
    const b = shallow.placed.find((p) => p.node.id === 'b')!;
    assert.equal(b.hiddenChildren, 2);
    assert.equal(b.hiddenDescendants, 2);

    // 折根才看得出两个数的区别：直接子节点只有 2 个，藏起来的却是全树 6 个
    const deep = layoutFlow(TREE, { collapsed: new Set(['root']) });
    const root = deep.placed[0]!;
    assert.equal(root.hiddenChildren, 2);
    assert.equal(root.hiddenDescendants, TREE.length - 1);

    // 没折的节点不该有"藏了多少"的说法
    const a = shallow.placed.find((p) => p.node.id === 'a')!;
    assert.equal(a.hiddenDescendants, 0);
  });

  it('折根：整棵树只剩根一个节点，且记号仍是全树的规模', () => {
    const { placed } = layoutFlow(TREE, { collapsed: new Set(['root']) });
    assert.deepEqual(placed.map((p) => p.node.id), ['root']);
    assert.equal(placed[0]!.hiddenDescendants, TREE.length - 1);
  });

  it('折叠集合里出现过期的 id 不会炸（节点已被删除）', () => {
    const { placed } = layoutFlow(TREE, { collapsed: new Set(['不存在', 'a']) });
    assert.equal(placed.some((p) => p.node.id === 'a1'), false);
    assert.ok(placed.some((p) => p.node.id === 'b1'));
  });

  it('枝信息：depth-1 开新枝并继承枝名，根不属于任何枝', () => {
    const { placed } = layoutFlow(TREE);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    assert.equal(byId.get('root')!.branchIndex, -1);
    assert.equal(byId.get('root')!.isBranchRoot, false);
    assert.equal(byId.get('a')!.isBranchRoot, true);
    assert.equal(byId.get('b')!.isBranchRoot, true);
    assert.notEqual(byId.get('a')!.branchIndex, byId.get('b')!.branchIndex, '不同枝给不同颜色');
    // 深层节点继承所在枝
    assert.equal(byId.get('a1')!.branchIndex, byId.get('a')!.branchIndex);
    assert.equal(byId.get('a1')!.branchLabel, byId.get('a')!.branchLabel);
  });

  it('枝名 = 该枝自己的名字，不是根的名字（实测踩过：每条枝都顶着根名）', () => {
    const { placed } = layoutFlow(TREE);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    assert.equal(byId.get('a')!.branchLabel, 'A');
    assert.equal(byId.get('b')!.branchLabel, 'B');
    assert.equal(byId.get('a1')!.branchLabel, 'A', '子孙沿用所在枝的枝名');
    assert.equal(byId.get('b2')!.branchLabel, 'B');
    assert.notEqual(byId.get('a')!.branchLabel, '根');
  });

  it('关注链路：焦点的祖先只标 onFocusPath（轻提示），不冒充主枝', () => {
    const focused = TREE.map((n) => (n.id === 'a2' ? { ...n, focus: true } : n));
    const { placed } = layoutFlow(focused);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    // 被关注的叶子自己是主枝
    assert.equal(byId.get('a2')!.inFocusBranch, true);
    // 它的祖先链（a、root）只是"通往焦点的链路"：要能顺着找回根，但不能和主枝一样抢眼
    assert.equal(byId.get('a')!.inFocusBranch, false);
    assert.equal(byId.get('a')!.onFocusPath, true);
    assert.equal(byId.get('root')!.onFocusPath, true);
    // b 枝与焦点无关：既不主枝也不在链路上
    assert.equal(byId.get('b')!.inFocusBranch, false);
    assert.equal(byId.get('b')!.onFocusPath, false);
  });

  it('关注枝本身（枝根被关注）：整枝都是主枝', () => {
    const focused = TREE.map((n) => (n.id === 'a' ? { ...n, focus: true } : n));
    const { placed } = layoutFlow(focused);
    const byId = new Map(placed.map((p) => [p.node.id, p]));
    for (const id of ['a', 'a1', 'a2']) {
      assert.equal(byId.get(id)!.inFocusBranch, true, `${id} 应在关注枝内`);
    }
    assert.equal(byId.get('b')!.inFocusBranch, false);
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

  it('hasFocus：没有关注时渲染端应当"全亮"，不做旁枝调暗（用户反馈"节点好轻啊"）', () => {
    assert.equal(layoutFlow(TREE).hasFocus, false, '一个关注都没有');
    const focused = TREE.map((n) => (n.id === 'a1' ? { ...n, focus: true } : n));
    assert.equal(layoutFlow(focused).hasFocus, true);
    // 关注节点被折叠掉时，画布上没有"亮着的枝"了：这时也不该把其余节点当旁枝调暗
    assert.equal(layoutFlow(focused, { collapsed: new Set(['root']) }).hasFocus, false);
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

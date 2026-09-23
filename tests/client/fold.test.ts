/**
 * 枝桠折叠语义的契约测试（`src/client/fold.ts`）。
 *
 * 这里钉的是用户明确要求的那套按键语义 —— 它是"做对了没有"的唯一判据，
 * 而且极易在后续改动里被无声改掉：
 * - 普通点击：整枝折起；再点 = **一层层**展开；
 * - Shift 点击：**从最下游一层层**折；再 Shift 点 = 全展开。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildFoldTree, foldToggle, hiddenBelow } from '../../src/client/fold.ts';
import type { NodeView } from '../../src/client/contract.ts';

function node(partial: Partial<NodeView> & { id: string; parentId: string | null }): NodeView {
  return {
    name: partial.id,
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
  } as NodeView;
}

/**
 * 三层树：root → (A → A1 → A1a) + (B → B1)。
 * A 是分叉根，A1 是单子链（真分叉判定用的是 ≥2 个子节点，那是 UI 的事，这里不管）。
 */
const TREE: NodeView[] = [
  node({ id: 'root', parentId: null }),
  node({ id: 'A', parentId: 'root' }),
  node({ id: 'A1', parentId: 'A' }),
  node({ id: 'A1a', parentId: 'A1' }),
  node({ id: 'B', parentId: 'root' }),
  node({ id: 'B1', parentId: 'B' }),
];
const tree = buildFoldTree(TREE);

/** 当前可见的节点，**逐层**列出（`visibleLayers` 是广度优先，所以顺序也是层序）。 */
const visible = (folded: ReadonlySet<string>): string[] =>
  tree.visibleLayers('root', folded).flat();

describe('枝桠折叠语义', () => {
  it('普通点击 = 整枝折起（只标记分叉根，藏掉整棵子树）', () => {
    const folded = foldToggle(tree, new Set(), 'A', false);
    assert.deepEqual([...folded], ['A']);
    // 注意：折的是 A **下面**的东西，A 自己还在图上（用户要看着折起来的是哪一枝）
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'B1']);
  });

  it('整枝折起后再普通点击 = 展开**一层**（不是全展开）', () => {
    const folded = foldToggle(tree, new Set(['A']), 'A', false);
    assert.equal(folded.has('A'), false, '标记从 A 挪走');
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1'], '只多露出一层 A1');
    assert.equal(folded.has('A1'), true, '标记挪到 A1：再点一次才继续往下');
  });

  it('一层层展开：连点三次才把 A 这枝全部展开', () => {
    let folded: ReadonlySet<string> = foldToggle(tree, new Set(), 'A', false); // 整枝折
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'B1']);
    folded = foldToggle(tree, folded, 'A', false); // 露 A1
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1']);
    folded = foldToggle(tree, folded, 'A', false); // 露 A1a
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1', 'A1a']);
    assert.equal(folded.size, 0, '全展开后没有残留标记');
    // 再点一次：枝里没有标记了 → 回到"整枝折起"
    folded = foldToggle(tree, folded, 'A', false);
    assert.deepEqual([...folded], ['A']);
  });

  it('Shift 折叠 = 从最下游逐层折，一次一层（连点会一直折到最上游）', () => {
    let folded: ReadonlySet<string> = foldToggle(tree, new Set(), 'A', true);
    // 最深一层有子节点的是 A1（A1a 是叶子）→ 先藏 A1a
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1']);
    assert.deepEqual([...folded], ['A1']);
    folded = foldToggle(tree, folded, 'A', true);
    // 再折一层：可见的、还有子节点的最深一层是 A
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'B1']);
    assert.deepEqual([...folded].sort(), ['A', 'A1']);
    // 已经折到底：这一下 Shift = 全展开（"展开时按 shift 全展开"）
    folded = foldToggle(tree, folded, 'A', true);
    assert.equal(folded.size, 0);
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1', 'A1a']);
  });

  it('Shift 展开 = 一次全展开（清掉深层标记）', () => {
    let folded: ReadonlySet<string> = new Set(['A', 'A1']);
    folded = foldToggle(tree, folded, 'A', true);
    assert.equal(folded.size, 0);
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'A1', 'B1', 'A1a']);
  });

  it('不同枝互不干扰：折 A 不影响 B', () => {
    const folded = foldToggle(tree, new Set(), 'A', false);
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'B1']);
    const alsoB = foldToggle(tree, folded, 'B', false);
    assert.deepEqual(visible(alsoB), ['root', 'A', 'B'], 'B 也折起来后，B 自己还在、B1 藏了');
  });

  it('+N 说实话：报整棵子树里被藏起来的节点数', () => {
    const foldedAll = foldToggle(tree, new Set(), 'A', false); // 整枝折 A
    // A 的子树 = A、A1、A1a（3 个），可见 1 个 → 藏了 2 个
    assert.equal(tree.subtree('A').length, 3);
    assert.equal(hiddenBelow(tree, foldedAll, 'A'), 2);
    // 没折的枝不说谎
    assert.equal(hiddenBelow(tree, foldedAll, 'B'), 0);
    assert.equal(hiddenBelow(tree, new Set(), 'A'), 0);
  });

  it('过期/不存在的 id 不会崩，也不影响可见性', () => {
    const folded = new Set(['不存在', 'A']);
    assert.deepEqual(visible(folded), ['root', 'A', 'B', 'B1']);
    assert.equal(hiddenBelow(tree, folded, 'A'), 2);
  });
});

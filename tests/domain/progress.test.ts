import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrateWeightScale,
  deriveGraph,
  effectiveWeight,
  statsForRoots,
  toHeuristicWeight,
  unfinishedLeaves,
} from '../../src/domain/progress.ts';
import type { GraphSnapshot, NodeRecord } from '../../src/shared/types.ts';

function node(partial: Partial<NodeRecord> & { id: string; name: string }): NodeRecord {
  return {
    parentId: null,
    kind: 'task',
    selfState: 'pending',
    progress: 0,
    focus: false,
    gate: null,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'user',
    ...partial,
  };
}

/** 根 R 下三个叶节点，权重按 §9.3 的示例：A=1(done), B=1(done), C=8(pending) */
function weightSample(): GraphSnapshot {
  return {
    projectName: '权重示例',
    rootIds: ['r'],
    dataFormat: 1,
    nodes: {
      r: node({ id: 'r', name: 'R', kind: 'feature' }),
      a: node({ id: 'a', name: 'A', parentId: 'r', selfState: 'done', progress: 1, weight: 1 }),
      b: node({ id: 'b', name: 'B', parentId: 'r', selfState: 'done', progress: 1, weight: 1 }),
      c: node({ id: 'c', name: 'C', parentId: 'r', selfState: 'pending', progress: 0, weight: 8 }),
    },
  };
}

test('按工作量口径：权重 1,1,8 → 20%（§9.3 示例）', () => {
  const derived = deriveGraph(weightSample());
  const stats = derived.overall;
  assert.equal(stats.basis, 'weight');
  assert.ok(Math.abs(stats.ratio - 0.2) < 1e-9, `期望 0.2，实际 ${stats.ratio}`);
  assert.equal(stats.doneLeaves, 2);
  assert.equal(stats.unfinishedLeaves, 1);
  assert.equal(stats.totalLeaves, 3);
});

test('父节点权重 = Σ 子权重，进度 = 加权平均', () => {
  const derived = deriveGraph(weightSample());
  const root = derived.nodes.get('r');
  assert.ok(root);
  assert.equal(root.weight, 10);
  assert.ok(Math.abs(root.progress - 0.2) < 1e-9);
});

test('全部完成后整枝进度为 1，未完成计数为 0', () => {
  const graph = weightSample();
  graph.nodes['c'] = node({
    id: 'c',
    name: 'C',
    parentId: 'r',
    selfState: 'done',
    progress: 1,
    weight: 8,
  });
  const derived = deriveGraph(graph);
  assert.equal(derived.nodes.get('r')?.progress, 1);
  assert.equal(derived.nodes.get('r')?.derivedState, 'done');
  assert.equal(derived.overall.unfinishedLeaves, 0);
  assert.ok(Math.abs(derived.overall.ratio - 1) < 1e-9);
});

test('等权时按工作量与按件数重合', () => {
  const graph = weightSample();
  graph.nodes['a'] = node({ id: 'a', name: 'A', parentId: 'r', selfState: 'done', progress: 1 });
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'r', selfState: 'done', progress: 1 });
  graph.nodes['c'] = node({ id: 'c', name: 'C', parentId: 'r', selfState: 'pending', progress: 0 });
  const stats = deriveGraph(graph).overall;
  assert.equal(stats.basis, 'count');
  assert.ok(Math.abs(stats.ratio - 2 / 3) < 1e-9);
});

test('tombstone 的节点及其子孙不计入分母与未完成计数', () => {
  const graph: GraphSnapshot = {
    projectName: '删除',
    rootIds: ['r'],
    dataFormat: 1,
    nodes: {
      r: node({ id: 'r', name: 'R', kind: 'feature' }),
      x: node({ id: 'x', name: 'X', parentId: 'r', kind: 'feature', selfState: 'removed' }),
      x1: node({ id: 'x1', name: 'X1', parentId: 'x' }),
      y: node({ id: 'y', name: 'Y', parentId: 'r', selfState: 'done', progress: 1 }),
    },
  };
  const derived = deriveGraph(graph);
  assert.equal(derived.nodes.get('x1')?.derivedState, 'removed');
  assert.equal(derived.overall.totalLeaves, 1, '只剩 Y 一个叶节点');
  assert.equal(derived.overall.unfinishedLeaves, 0);
});

test('门控沿枝继承：父节点拦停 → 全部子孙计算状态为 held', () => {
  const graph: GraphSnapshot = {
    projectName: '门控',
    rootIds: ['r'],
    dataFormat: 1,
    nodes: {
      r: node({ id: 'r', name: 'R', kind: 'feature' }),
      m: node({ id: 'm', name: 'M', parentId: 'r', kind: 'feature', gate: 'held' }),
      leaf: node({ id: 'leaf', name: 'L', parentId: 'm', selfState: 'running' }),
    },
  };
  const derived = deriveGraph(graph);
  assert.equal(derived.nodes.get('m')?.derivedState, 'held');
  assert.equal(derived.nodes.get('leaf')?.derivedState, 'held');
  // 门控只**向下**继承（规则 1/2 的"自身或任一祖先"），不向上传播：
  // 根自身无门控、也无 running/error 子孙，故按规则 6 呈现为 pending。
  assert.equal(derived.nodes.get('r')?.derivedState, 'pending');
});

test('关注枝统计只算并集内叶节点，且不重复计数', () => {
  const graph: GraphSnapshot = {
    projectName: '关注',
    rootIds: ['r'],
    dataFormat: 1,
    nodes: {
      r: node({ id: 'r', name: 'R', kind: 'feature' }),
      a: node({ id: 'a', name: 'A', parentId: 'r', kind: 'feature' }),
      a1: node({ id: 'a1', name: 'A1', parentId: 'a', selfState: 'done', progress: 1 }),
      a2: node({ id: 'a2', name: 'A2', parentId: 'a' }),
      b: node({ id: 'b', name: 'B', parentId: 'r', kind: 'feature' }),
      b1: node({ id: 'b1', name: 'B1', parentId: 'b' }),
    },
  };
  const derived = deriveGraph(graph);
  // 关注 a 与 b（互不包含）→ 并集 {a1,a2,b1}
  const focused = statsForRoots(derived, ['a', 'b']);
  assert.equal(focused.totalLeaves, 3);
  assert.ok(Math.abs(focused.ratio - 1 / 3) < 1e-9);
  assert.equal(focused.doneLeaves, 1);
  assert.equal(focused.unfinishedLeaves, 2);
});

test('unfinishedLeaves：只列叶节点，关注优先、异常靠前', () => {
  const graph: GraphSnapshot = {
    projectName: '未完成',
    rootIds: ['r'],
    dataFormat: 1,
    nodes: {
      r: node({ id: 'r', name: 'R', kind: 'feature' }),
      p: node({ id: 'p', name: 'P', parentId: 'r', selfState: 'running' }),
      q: node({ id: 'q', name: 'Q', parentId: 'r', selfState: 'error', focus: true }),
      z: node({ id: 'z', name: 'Z', parentId: 'r', selfState: 'done', progress: 1 }),
    },
  };
  const list = unfinishedLeaves(deriveGraph(graph));
  assert.deepEqual(list.map((d) => d.node.id), ['q', 'p'], '关注项在前，异常优先');
});

test('effectiveWeight：缺省为 1，超界收敛到 [1,10]', () => {
  assert.equal(effectiveWeight(node({ id: 'x', name: 'X' })), 1);
  assert.equal(effectiveWeight(node({ id: 'x', name: 'X', weight: 0.1 })), 1);
  assert.equal(effectiveWeight(node({ id: 'x', name: 'X', weight: 99 })), 10);
});

test('权重对标：k = mean(aiW/h)（§9.3a）', () => {
  const scale = calibrateWeightScale([
    { aiW: 8, h: 4 },
    { aiW: 4, h: 2 },
  ]);
  assert.equal(scale.calibrated, true);
  assert.ok(Math.abs(scale.k - 2) < 1e-9);
  assert.equal(scale.samples, 2);
  assert.ok(Math.abs(toHeuristicWeight(3, scale) - 6) < 1e-9);
});

test('权重对标：无样本时不校准并保持原值', () => {
  const scale = calibrateWeightScale([]);
  assert.equal(scale.calibrated, false);
  assert.equal(scale.k, 1);
  assert.equal(toHeuristicWeight(3, scale), 3);
});

test('权重对标：h=0 的样本被剔除，避免除零', () => {
  const scale = calibrateWeightScale([
    { aiW: 5, h: 0 },
    { aiW: 6, h: 3 },
  ]);
  assert.equal(scale.samples, 1);
  assert.ok(Math.abs(scale.k - 2) < 1e-9);
});

test('空图不崩且统计为零', () => {
  const derived = deriveGraph({ projectName: '空', rootIds: [], dataFormat: 1, nodes: {} });
  assert.equal(derived.overall.totalLeaves, 0);
  assert.equal(derived.overall.ratio, 0);
});

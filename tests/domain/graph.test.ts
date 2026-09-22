import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ancestorIds,
  buildIndex,
  findSiblingByName,
  focusInvariantHolds,
  focusedRoots,
  leafIds,
  planFocusNormalization,
  structuralViolations,
  subtreeIds,
  siblingIds,
} from '../../src/domain/graph.ts';
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

/** 树： A → B → (D, E)；A → C */
function sampleGraph(overrides: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    projectName: '示例',
    rootIds: ['a'],
    dataFormat: 1,
    nodes: {
      a: node({ id: 'a', name: 'A', kind: 'feature' }),
      b: node({ id: 'b', name: 'B', parentId: 'a', kind: 'feature' }),
      c: node({ id: 'c', name: 'C', parentId: 'a', kind: 'feature' }),
      d: node({ id: 'd', name: 'D', parentId: 'b' }),
      e: node({ id: 'e', name: 'E', parentId: 'b' }),
    },
    ...overrides,
  };
}

test('buildIndex 建立父子关系与根列表', () => {
  const index = buildIndex(sampleGraph());
  assert.deepEqual(index.roots, ['a']);
  assert.deepEqual(index.childrenOf.get('a'), ['b', 'c']);
  assert.deepEqual(index.childrenOf.get('b'), ['d', 'e']);
  assert.deepEqual(index.childrenOf.get('d'), []);
});

test('subtreeIds 返回含自身的整枝', () => {
  const index = buildIndex(sampleGraph());
  assert.deepEqual(subtreeIds(index, 'b').sort(), ['b', 'd', 'e']);
  assert.deepEqual(subtreeIds(index, 'a').sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('ancestorIds 自父向上', () => {
  const index = buildIndex(sampleGraph());
  assert.deepEqual(ancestorIds(index, 'd'), ['b', 'a']);
  assert.deepEqual(ancestorIds(index, 'a'), []);
});

test('leafIds 只返回无子节点者', () => {
  const index = buildIndex(sampleGraph());
  assert.deepEqual(leafIds(index).sort(), ['c', 'd', 'e']);
});

test('siblingIds 排除自身', () => {
  const index = buildIndex(sampleGraph());
  assert.deepEqual(siblingIds(index, 'd'), ['e']);
  assert.deepEqual(siblingIds(index, 'a'), []);
});

test('findSiblingByName 检出同级同名（C12）', () => {
  const graph = sampleGraph();
  graph.nodes['d'] = node({ id: 'd', name: 'C', parentId: 'b' });
  const index = buildIndex(graph);
  assert.equal(findSiblingByName(index, 'b', 'C')?.id, 'd');
  // 跨父同名不算冲突（§7.2：全树可重名）
  assert.equal(findSiblingByName(index, 'a', 'D'), undefined);
});

test('关注父节点：后代 focus 被清除（C11 归一化）', () => {
  const graph = sampleGraph();
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'a', focus: true, focusShadow: true });
  const index = buildIndex(graph);
  const changes = planFocusNormalization(index, 'a', true);
  assert.equal(changes.get('a'), true);
  assert.equal(changes.get('b'), false);
});

test('取消关注父节点：按 focusShadow 恢复后代', () => {
  const graph = sampleGraph();
  // 先关注 b（shadow=true），再关注 a（b.focus 被清、shadow 保留）
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'a', focus: false, focusShadow: true });
  graph.nodes['a'] = node({ id: 'a', name: 'A', focus: true, focusShadow: true });
  const index = buildIndex(graph);
  const changes = planFocusNormalization(index, 'a', false);
  assert.equal(changes.get('a'), false);
  assert.equal(changes.get('b'), true, 'b 曾显式标记过，应被恢复');
});

test('恢复时被祖先覆盖的后代不再恢复（保持"两两互不包含"）', () => {
  const graph = sampleGraph();
  // b 与 d 都曾显式关注；a 关注中
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'a', focus: false, focusShadow: true });
  graph.nodes['d'] = node({ id: 'd', name: 'D', parentId: 'b', focus: false, focusShadow: true });
  graph.nodes['a'] = node({ id: 'a', name: 'A', focus: true, focusShadow: true });
  const index = buildIndex(graph);
  const changes = planFocusNormalization(index, 'a', false);
  assert.equal(changes.get('b'), true);
  assert.equal(changes.get('d'), undefined, 'd 已被恢复的 b 覆盖，不应再恢复');
  // 应用变更后不变量成立
  const applied: GraphSnapshot = { ...graph, nodes: { ...graph.nodes } };
  for (const [id, value] of changes) {
    const current = applied.nodes[id];
    if (current) applied.nodes[id] = { ...current, focus: value };
  }
  assert.ok(focusInvariantHolds(buildIndex(applied)));
});

test('focusInvariantHolds 检出祖先-后代同时关注', () => {
  const graph = sampleGraph();
  graph.nodes['a'] = node({ id: 'a', name: 'A', focus: true });
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'a', focus: true });
  assert.equal(focusInvariantHolds(buildIndex(graph)), false);
});

test('focusedRoots 列出全部生效关注点', () => {
  const graph = sampleGraph();
  graph.nodes['b'] = node({ id: 'b', name: 'B', parentId: 'a', focus: true });
  graph.nodes['c'] = node({ id: 'c', name: 'C', parentId: 'a', focus: true });
  assert.deepEqual(focusedRoots(buildIndex(graph)).sort(), ['b', 'c']);
});

test('structuralViolations 检出悬空父指针与同名兄弟', () => {
  const graph = sampleGraph();
  graph.nodes['d'] = node({ id: 'd', name: 'E', parentId: 'b' }); // 与 e 同名
  const problems = structuralViolations(buildIndex(graph));
  assert.ok(problems.some((p) => p.includes('同名')));

  const dangling = sampleGraph();
  dangling.nodes['f'] = node({ id: 'f', name: 'F', parentId: 'missing' });
  assert.ok(structuralViolations(buildIndex(dangling)).some((p) => p.includes('不存在')));
});

test('structuralViolations 检出环', () => {
  const graph: GraphSnapshot = {
    projectName: '环',
    rootIds: [],
    dataFormat: 1,
    nodes: {
      x: node({ id: 'x', name: 'X', parentId: 'y' }),
      y: node({ id: 'y', name: 'Y', parentId: 'x' }),
    },
  };
  assert.ok(structuralViolations(buildIndex(graph)).some((p) => p.includes('环')));
});

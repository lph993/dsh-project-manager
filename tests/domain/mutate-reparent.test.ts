/**
 * `mutateReparent` 的单测（此前**一条都没有** —— `grep mutateReparent tests/` 为空，
 * 所以这条路径上的三种拒绝理由与文案改动没人拦得住）。
 *
 * 覆盖三件事，都是真机上真遇到过的：
 * ① **成环**：不能把节点挂到自己或自己的子孙下（否则父链成环，遍历全乱）；
 * ② **同名兄弟**：同一父下名称必须唯一（§7.2），否则界面上两个同名节点分不清；
 * ③ **`refs` 互为子集**（FR-158 ⑥）：那是"同一份代码的两次评估"，合并只会让分母灌水 ——
 *    这条拒绝还得**给出保留建议**（批次 53 新增：子节点多 > 有描述 > 进度高，打平保留原位那棵）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createNodeRecord, mutateReparent } from '../../src/domain/mutate.ts';
import type { GraphSnapshot, NodeRecord, Ref } from '../../src/shared/types.ts';

/** 造一份最小图（用官方的 createNodeRecord，字段默认值不靠手写猜）。 */
function graphOf(records: Array<Partial<NodeRecord> & { id: string; name: string }>): GraphSnapshot {
  const nodes: Record<string, NodeRecord> = {};
  for (const partial of records) {
    const base = createNodeRecord({
      id: partial.id,
      name: partial.name,
      parentId: partial.parentId ?? null,
      kind: partial.kind ?? 'task',
      ts: '2026-09-25T00:00:00.000Z',
      by: 'user',
    });
    nodes[partial.id] = { ...base, ...partial };
  }
  return {
    projectName: '测试项目',
    nodes,
    rootIds: records.filter((record) => (record.parentId ?? null) === null).map((record) => record.id),
    dataFormat: 1,
  };
}

const ctx = {
  clock: { now: () => '2026-09-25T00:00:00.000Z' },
  random: { uuid: () => 'sub-1' },
  policy: 'auto-fix-first' as const,
};

const ref = (target: string): Ref => ({ type: 'code', target });

describe('mutateReparent：三种拒绝都必须说清理由', () => {
  it('① 挂到自己下面 ⇒ E_CYCLE', () => {
    const graph = graphOf([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parentId: 'a' }]);
    const result = mutateReparent(graph, { nodeId: 'a', parentId: 'a', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    assert.equal(result.kind === 'reject' ? result.code : '', 'E_CYCLE');
  });

  it('① 挂到自己的**子孙**下面 ⇒ E_CYCLE（成环的另一种写法）', () => {
    const graph = graphOf([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'b' },
    ]);
    const result = mutateReparent(graph, { nodeId: 'a', parentId: 'c', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    assert.equal(result.kind === 'reject' ? result.code : '', 'E_CYCLE');
  });

  it('② 新同级里已有同名活节点 ⇒ C12（墓碑不算，删除后允许复用名字）', () => {
    const graph = graphOf([
      { id: 'root', name: '根' },
      { id: 'a', name: '同名', parentId: 'root' },
      { id: 'b', name: '同名' },
      { id: 'dead', name: '旧名字', parentId: 'root', selfState: 'removed' },
    ]);
    const result = mutateReparent(graph, { nodeId: 'b', parentId: 'root', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    assert.equal(result.kind === 'reject' ? result.code : '', 'C12');

    // 墓碑不挡路：把 b 改成与墓碑同名的节点名才该被拒，这里反过来验证"墓碑不算同名"
    const ok = mutateReparent(
      { ...graph, nodes: { ...graph.nodes, b: { ...graph.nodes['b']!, name: '旧名字' } } },
      { nodeId: 'b', parentId: 'root', by: 'user' },
      ctx,
    );
    assert.notEqual(ok.kind === 'reject' ? ok.code : '', 'C12', '墓碑不该被当成同名兄弟');
  });

  it('③ refs 互为子集 ⇒ E_DUPLICATE_BRANCH，且**给出保留建议**（子节点多者胜）', () => {
    const graph = graphOf([
      { id: 'root', name: '根' },
      { id: 'far', name: '伞', parentId: 'root', refs: [ref('src/x')] },
      { id: 'kid1', name: '细活一', parentId: 'far', refs: [ref('src/x/a.ts')] },
      { id: 'kid2', name: '细活二', parentId: 'far', refs: [ref('src/x/b.ts')] },
      { id: 'narrow', name: '窄壳', refs: [ref('src/x')] },
    ]);
    const result = mutateReparent(graph, { nodeId: 'narrow', parentId: 'far', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    if (result.kind !== 'reject') return;
    assert.equal(result.code, 'E_DUPLICATE_BRANCH');
    assert.match(result.message, /同一份代码的两次评估/);
    assert.match(result.hint ?? '', /建议保留「伞」/, '要保留子节点更多的那棵（伞有 2 个子节点）');
    assert.match(result.hint ?? '', /2 个子节点/);
  });

  it('③ 三项事实打平 ⇒ 如实说打平，并建议保留**已在原位**的那棵', () => {
    const graph = graphOf([
      { id: 'root', name: '根' },
      { id: 'keep', name: '原父', parentId: 'root', refs: [ref('src/y')] },
      { id: 'mover', name: '要搬的', refs: [ref('src/y')] },
    ]);
    const result = mutateReparent(graph, { nodeId: 'mover', parentId: 'keep', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    if (result.kind !== 'reject') return;
    assert.equal(result.code, 'E_DUPLICATE_BRANCH');
    assert.match(result.hint ?? '', /打平/, '三项事实一样时必须如实说打平，不许编一个理由');
    assert.match(result.hint ?? '', /建议保留「原父」/, '打平时保留已在原位的那棵（少动一次）');
  });

  it('④ 反向也算互为子集：对方 refs 全在自己里时同样拒绝', () => {
    const graph = graphOf([
      { id: 'root', name: '根' },
      { id: 'broad', name: '宽', parentId: 'root', refs: [ref('src/z'), ref('src/z2')] },
      { id: 'narrow', name: '窄', refs: [ref('src/z')] },
    ]);
    const result = mutateReparent(graph, { nodeId: 'narrow', parentId: 'broad', by: 'user' }, ctx);
    assert.equal(result.kind, 'reject');
    assert.equal(result.kind === 'reject' ? result.code : '', 'E_DUPLICATE_BRANCH');
  });

  it('⑤ 正常改父：只动父子关系，其它字段一字不动', () => {
    const graph = graphOf([
      { id: 'root', name: '根' },
      { id: 'p', name: '新父', parentId: 'root' },
      { id: 'target', name: '被搬的', refs: [ref('src/only/file.ts')], progress: 0.42 },
    ]);
    const result = mutateReparent(graph, { nodeId: 'target', parentId: 'p', by: 'user' }, ctx);
    assert.equal(result.kind, 'ok', JSON.stringify(result));
    if (result.kind !== 'ok') return;
    const after = result.graph.nodes['target'];
    assert.equal(after?.parentId, 'p', '父子关系要改');
    assert.equal(after?.name, '被搬的', '名字不许变');
    assert.equal(after?.progress, 0.42, '进度不许变');
    // 原图**不被就地改写**（纯函数：新图返回、旧图保持原样）
    assert.equal(graph.nodes['target']?.parentId, null, '原图不该被就地改写');
  });
});

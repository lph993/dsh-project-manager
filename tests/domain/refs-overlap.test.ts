/**
 * 「部分重叠的兄弟枝」判据测试（FR-158 ⑥ 的补白）。
 *
 * 这块的价值全在"**能看见现有判据看不见的那一类**"：完全相同 / 互为子集早就被两组判据拦住了，
 * 真正漏掉的是"**部分重叠**"（两个兄弟枝顺手引到了同一个文件）—— 它们同时给同一批文件计数，
 * 而所有现有判据都报 0 组。所以测试的重点是：partial 必须被抓出来，且不能把"没重叠"误报。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeRefOverlap, refCovers, siblingRefOverlaps, type RefOverlapNode } from '../../src/domain/refs-overlap.ts';

const node = (
  name: string,
  refs: string[],
  parentId: string | null = 'parent',
): RefOverlapNode => ({ id: name, name, parentId, refs });

describe('部分重叠的兄弟枝判定', () => {
  it('① **部分重叠**必须被抓出来（这正是现有判据的空白）', () => {
    const pairs = siblingRefOverlaps([
      node('产物与源码校验脚本', [
        'scripts/verify-artifacts.mjs',
        'scripts/verify-client-combo.mjs',
        'scripts/verify-live.mjs',
        'scripts/verify-source-syntax.mjs',
      ]),
      node('产物与源码自检', [
        'scripts/verify-artifacts.mjs',
        'scripts/verify-source-syntax.mjs',
        'scripts/inspect-bundle.mjs',
        'scripts/find-registration.mjs',
      ]),
    ]);
    assert.equal(pairs.length, 1, `真机那对兄弟枝必须被判出来：${JSON.stringify(pairs)}`);
    const pair = pairs[0]!;
    assert.equal(pair.kind, 'partial', '既不相同也不互为子集 ⇒ partial');
    assert.deepEqual(pair.shared, ['scripts/verify-artifacts.mjs', 'scripts/verify-source-syntax.mjs']);
    assert.equal(pair.overlapOfSmaller, 0.5, '较小的那侧 4 条引用里有 2 条重叠');
    assert.match(describeRefOverlap(pair), /部分重叠/);
  });

  it('② 引用完全相同 ⇒ exact；互为子集 ⇒ subset（与现有判据口径一致）', () => {
    const exact = siblingRefOverlaps([
      node('甲', ['scripts/a.mjs', 'scripts/b.mjs']),
      node('乙', ['scripts/b.mjs', 'scripts/a.mjs']),
    ]);
    assert.equal(exact[0]?.kind, 'exact');

    const subset = siblingRefOverlaps([
      node('宽', ['scripts/a.mjs', 'scripts/b.mjs']),
      node('窄', ['scripts/a.mjs']),
    ]);
    assert.equal(subset[0]?.kind, 'subset');
    assert.equal(subset[0]?.overlapOfSmaller, 1, '小的一侧被完全覆盖');
  });

  it('③ **目录与目录里的文件**也算重叠（字符串不等但文件被算了两遍）', () => {
    const pairs = siblingRefOverlaps([
      node('按目录管', ['src/ai']),
      node('按文件管', ['src/ai/prompt.ts', 'src/ai/route.ts']),
    ]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.kind, 'partial');
    assert.deepEqual(pairs[0]?.shared, ['src/ai/prompt.ts', 'src/ai/route.ts'], '共享路径取更长的那条');
    assert.equal(pairs[0]?.overlapOfSmaller, 1);
  });

  it('④ 前缀相似但不同文件**不算**重叠（`src/ai` vs `src/aix.ts`）', () => {
    assert.equal(refCovers('src/ai', 'src/aix.ts'), false, '按路径边界比，前缀不算');
    const pairs = siblingRefOverlaps([node('甲', ['src/ai']), node('乙', ['src/aix.ts'])]);
    assert.deepEqual(pairs, [], '不能把"前缀碰巧相同"误报成重叠');
  });

  it('⑤ 只看**兄弟**：父子之间的包含是正常形态，不算重叠', () => {
    const pairs = siblingRefOverlaps([
      { id: 'p', name: '父', parentId: null, refs: ['src/ai'] },
      { id: 'c', name: '子', parentId: 'p', refs: ['src/ai/prompt.ts'] },
    ]);
    assert.deepEqual(pairs, [], '父覆盖子是层级本意，不是"两条并列任务线各算一遍"');
  });

  it('⑥ 没有 refs 的节点不参与；排序按重叠条数降序（可复现）', () => {
    const pairs = siblingRefOverlaps([
      node('无引用', []),
      node('甲', ['a.ts', 'b.ts']),
      node('乙', ['a.ts', 'b.ts']),
      node('丙', ['b.ts', 'c.ts']),
    ]);
    assert.equal(pairs.length, 3, '甲乙、甲丙、乙丙 三对');
    assert.equal(pairs[0]?.shared.length, 2, '重叠最多的排最前');
    assert.ok(pairs.every((pair) => !pair.a.name.includes('无引用') && !pair.b.name.includes('无引用')));
  });

  it('⑦ 反斜杠路径归一化后同样能判出来', () => {
    const pairs = siblingRefOverlaps([
      node('甲', ['scripts\\verify-artifacts.mjs']),
      node('乙', ['scripts/verify-artifacts.mjs']),
    ]);
    assert.equal(pairs[0]?.kind, 'exact', 'Windows 路径必须与正斜杠等价');
  });

  it('⑧ 无 refs 的父枝（辅助任务专区）⇒ 其下兄弟**豁免**，不再报重叠', () => {
    const bucket: RefOverlapNode = { id: 'bucket', name: '跨区辅助任务', parentId: null, refs: [] };
    const pairs = siblingRefOverlaps([
      bucket,
      { ...node('甲', ['src/tools', 'src/subscriptions']), parentId: 'bucket' },
      { ...node('乙', ['src/tools', 'src/subscriptions']), parentId: 'bucket' },
    ]);
    assert.deepEqual(pairs, [], '用户口径：无法归类且必须存在的跨区节点用单一区管理，它们之间重叠是允许的');

    // 父不在输入里（判不了）⇒ 保守**不豁免**，仍然报出来
    const unknownParent = siblingRefOverlaps([
      { ...node('丙', ['a.ts']), parentId: 'not-in-list' },
      { ...node('丁', ['a.ts']), parentId: 'not-in-list' },
    ]);
    assert.equal(unknownParent.length, 1, '父不可见时不许假装"它没有 refs"');
  });
});

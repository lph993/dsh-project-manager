/**
 * 重复枝合并算法（`planConsolidation`）的测试。
 *
 * 这是把我**手工修剪时用的规则**固化成算法的那一层，所以测试要钉的正是那几条吃过亏的判据：
 * ① 只有"完全相同 / 互为子集"才算重复枝（部分重叠只报告）；
 * ② 无 refs 的父（辅助任务专区）下的兄弟**豁免**；
 * ③ 先搬后删（被删者的活子节点搬进保留者）；
 * ④ 进度删前先并（取大）；
 * ⑤ 深度优先：嵌套重复自然收敛，绝不整片误删。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeConsolidation, planConsolidation, type ConsolidateNode } from '../../src/domain/consolidate.ts';

const node = (
  name: string,
  refs: string[],
  extra: Partial<ConsolidateNode> = {},
): ConsolidateNode => ({
  id: name,
  name,
  parentId: 'parent',
  kind: 'task',
  progress: 0.5,
  refs,
  ...extra,
});

describe('重复枝合并算法', () => {
  it('① 引用完全相同 ⇒ 留"子节点多/有描述/进度高"的那个，另一个先搬后删', () => {
    const plan = planConsolidation([
      {
        ...node('宽枝', ['scripts/a.mjs', 'scripts/b.mjs'], { progress: 0.6, description: '有说明' }),
        id: 'keep',
      },
      { ...node('副本', ['scripts/b.mjs', 'scripts/a.mjs'], { progress: 0.9 }), id: 'dup' },
      // 保留者这边有**两个**子节点、对方一个 ⇒ 按"子节点多 > 有描述 > 进度高"必须留 keep
      { ...node('宽枝的孩子一', ['scripts/a.mjs'], { parentId: 'keep' }), id: 'k1' },
      { ...node('宽枝的孩子二', ['scripts/b.mjs'], { parentId: 'keep' }), id: 'k2' },
      { ...node('副本的孩子', ['scripts/a.mjs'], { parentId: 'dup' }), id: 'kid' },
    ]);
    const kinds = plan.actions.map((action) => action.kind);
    assert.deepEqual(kinds.slice(0, 3), ['move', 'fold', 'delete'], '顺序必须是：先搬 → 再并进度 → 最后删');
    const moved = plan.actions.find((action) => action.kind === 'move');
    assert.equal(moved?.kind === 'move' ? moved.nodeId : '', 'kid', '被删者的活子节点必须先搬');
    const del = plan.actions.find((action) => action.kind === 'delete');
    assert.equal(del?.kind === 'delete' ? del.nodeId : '', 'dup');
    assert.equal(del?.kind === 'delete' ? del.keptBy : '', 'keep');
    /**
     * 迭代会把"刚搬进来的孩子"与保留者已有的孩子**再判一次**（kid 与 k1 都是 `scripts/a.mjs`，
     * 确实是同一件事）—— 这是算法该做的，所以只断言"最后不会两份都留着"。
     */
    const aliveAfter = new Set(
      ['keep', 'dup', 'kid', 'k1', 'k2'].filter(
        (id) => !plan.actions.some((action) => action.kind === 'delete' && action.nodeId === id),
      ),
    );
    assert.ok(aliveAfter.has('keep'));
    assert.ok(!aliveAfter.has('dup'));
    assert.ok(!(aliveAfter.has('kid') && aliveAfter.has('k1')), '同一批文件的两个孩子不许都留下');
  });

  it('② 部分重叠**不动作**（教训：按部分重叠算过"121 个可删"，里面全是正常层级）', () => {
    const plan = planConsolidation([
      node('甲', ['scripts/verify-artifacts.mjs', 'scripts/verify-live.mjs']),
      node('乙', ['scripts/verify-artifacts.mjs', 'scripts/inspect-bundle.mjs']),
    ]);
    assert.deepEqual(plan.actions, [], '部分重叠只是"范围有交集"，不是"同一份代码被评估两次"');
  });

  it('③ 无 refs 的父（跨区辅助任务专区）⇒ 其下兄弟豁免', () => {
    const bucket: ConsolidateNode = {
      id: 'bucket',
      name: '跨区辅助任务',
      parentId: null,
      kind: 'feature',
      progress: 0,
      refs: [],
    };
    const plan = planConsolidation([
      bucket,
      { ...node('辅助甲', ['src/tools', 'src/subscriptions']), parentId: 'bucket' },
      { ...node('辅助乙', ['src/tools', 'src/subscriptions']), parentId: 'bucket' },
    ]);
    assert.deepEqual(plan.actions, [], '用户口径：辅助任务之间重叠是允许的');
  });

  it('④ 嵌套重复：无论留哪一层，**真活绝不能被删**（安全底线）', () => {
    const plan = planConsolidation([
      { ...node('外层副本', ['src/ai']), id: 'outer', parentId: 'parent' },
      { ...node('内层副本', ['src/ai']), id: 'inner', parentId: 'outer' },
      { ...node('真活', ['src/ai/prompt.ts'], { progress: 0.7 }), id: 'work', parentId: 'inner' },
      { ...node('保留者', ['src/ai'], { description: '有说明' }), id: 'keeper', parentId: 'parent' },
    ]);
    const deleted = plan.actions.filter((action) => action.kind === 'delete').map((action) => action.nodeId);
    assert.ok(!deleted.includes('work'), `真活绝不能被删：${JSON.stringify(plan.actions)}`);
    // 同父的两个重复枝只留一个
    assert.ok(!(deleted.includes('outer') && deleted.includes('keeper')), '同父重复枝必须留一个');
    // 说明算法**不**处理"父子之间的包含"（那是正常层级）——如实记录这条边界
    assert.ok(
      !deleted.includes('inner') || !deleted.includes('outer'),
      '嵌套在父子之间的重复不在本算法的处置范围内（它是层级本意，不是并列副本）',
    );
  });

  it('⑤ 没有重复枝时什么也不做（空计划）', () => {
    const plan = planConsolidation([
      node('甲', ['src/a/x.ts']),
      node('乙', ['src/b/y.ts']),
      node('无引用', []),
    ]);
    assert.deepEqual(plan.actions, []);
    assert.equal(describeConsolidation(plan), '没有可合并的重复枝');
  });
});

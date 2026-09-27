/**
 * FR-161 判据测试：**跨子项目写入的审核**。
 *
 * 这条判据两种错法都要防：① **该拦不拦**（改到复用/底层代码却放过去 → 别的任务线被静默影响）；
 * ② **不该拦乱拦**（只对本子项目负责的代码也拦 → 用户被无意义的弹窗淹没，最后学会闭眼点"允许"）。
 * 所以每个分支都正反各钉一条。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  crossProjectVerdict,
  describeReviewVerdict,
  isWhitelistedPath,
  refCoversPath,
  type ReviewNode,
} from '../../src/domain/review-gate.ts';

/**
 * 造树：`path` 是**从根到自己的名字路径**，节点 id 就用路径拼出来。
 *
 * 这样 `parentId` 天然指向上一个节点 —— 早先我用手写 id + 路径当父子键，
 * 结果父链全断（判据当然跟着错），白白查一轮：**测试夹具自己也得是自洽的**。
 */
function node(
  path: string[],
  options: { refs?: string[]; focus?: boolean } = {},
): ReviewNode {
  return {
    id: path.join('/'),
    name: path[path.length - 1] ?? '',
    parentId: path.length > 1 ? path.slice(0, -1).join('/') : null,
    focus: options.focus === true,
    refs: options.refs ?? [],
  };
}

/** 组装一棵两子项目的树：mobile 前端 / pc 前端，另有一个共享层（根的直接子节点）。 */
function forest(): ReviewNode[] {
  return [
    node(['项目']),
    node(['项目', 'Mobile'], { focus: true }),
    node(['项目', 'Mobile', 'Mobile 界面'], { refs: ['src/mobile-ui'] }),
    node(['项目', 'Mobile', 'Mobile 后台'], { refs: ['src/shared-api'] }),
    node(['项目', 'PC'], { focus: true }),
    node(['项目', 'PC', 'PC 界面'], { refs: ['src/pc-ui', 'src/shared-api'] }),
    node(['项目', '共享层'], { refs: ['src/shared-api'] }),
  ];
}

describe('FR-161 跨子项目写入判据', () => {
  it('① 同子项目内改代码 ⇒ 直接过', () => {
    const verdict = crossProjectVerdict(['src/mobile-ui/Page.tsx'], forest());
    assert.equal(verdict.required, false);
    assert.equal(verdict.required === false ? verdict.reason : '', 'single-project');
  });

  it('② 只对某个子项目负责的代码（即使被别的**子项目之外**的节点引用）⇒ 直接过', () => {
    // mobile 后台改自己那半边的代码：只有 mobile-api 引用它
    const verdict = crossProjectVerdict(['src/shared-api/own-only.ts'], forest());
    // 注意：这棵树里 shared-api 被 mobile-api / pc-ui / shared 三个节点引用（分属 3 个子项目）
    // ⇒ 属于"复用代码"，必须审；真正"只对自己负责"的例子单列在下一个用例里
    assert.equal(verdict.required, true);
  });

  it('②b 只有同一条任务线上的节点引用 ⇒ 直接过（哪怕跨了节点）', () => {
    const nodes: ReviewNode[] = [
      node(['项目']),
      node(['项目', 'Mobile']),
      node(['项目', 'Mobile', 'A'], { refs: ['src/only-mobile'] }),
      node(['项目', 'Mobile', 'B'], { refs: ['src/only-mobile/part.ts'] }),
      node(['项目', 'PC']),
      node(['项目', 'PC', 'C'], { refs: ['src/pc-only'] }),
    ];
    const verdict = crossProjectVerdict(['src/only-mobile/part.ts'], nodes);
    assert.equal(verdict.required, false, JSON.stringify(verdict));
    assert.equal(verdict.required === false ? verdict.reason : '', 'single-project');
  });

  it('③ 改到被**≥2 个子项目**引用的复用代码 ⇒ 必须审核，并列出子项目与命中节点', () => {
    const verdict = crossProjectVerdict(['src/shared-api/client.ts'], forest());
    assert.equal(verdict.required, true, JSON.stringify(verdict));
    if (verdict.required !== true) return;
    assert.equal(verdict.reason, 'shared-code');
    assert.deepEqual(
      verdict.projects,
      ['Mobile', 'PC', '共享层'],
      '子项目 = 根的直接子节点（按码位排序 ⇒ 顺序可复现，界面不会跳来跳去）',
    );
    assert.ok(
      verdict.affected.some((item) => item.name === 'PC 界面') &&
        verdict.affected.some((item) => item.name === 'Mobile 后台'),
      `要能指名道姓：${JSON.stringify(verdict.affected)}`,
    );
  });

  it('④ 白名单（投影文档 / .pm/ 缓存）⇒ 直接过，不打扰', () => {
    assert.equal(isWhitelistedPath('project-manager.md'), true);
    assert.equal(isWhitelistedPath('.pm/cache/ai.json'), true);
    assert.equal(isWhitelistedPath('.pm'), true);
    assert.equal(isWhitelistedPath('src/pm/x.ts'), false, '前缀相同的源码目录不许被白名单吃掉');
    const verdict = crossProjectVerdict(['project-manager.md', '.pm/cache/x.json'], forest());
    assert.equal(verdict.required, false);
    assert.equal(verdict.required === false ? verdict.reason : '', 'all-whitelisted');
  });

  it('⑤ 混合：有一条真代码路径就按真代码判（白名单不掩盖其它路径）', () => {
    const verdict = crossProjectVerdict(['project-manager.md', 'src/shared-api/client.ts'], forest());
    assert.equal(verdict.required, true);
  });

  it('⑥ 没有任何节点引用 ⇒ 不拦（无人负责的路径不该弹窗）', () => {
    const verdict = crossProjectVerdict(['README.md'], forest());
    assert.equal(verdict.required, false);
    assert.equal(verdict.required === false ? verdict.reason : '', 'no-affected-node');
  });

  it('⑦ 读不出路径 ⇒ 不拦（**不猜**：猜错会把正常改动拦下来）', () => {
    const verdict = crossProjectVerdict([], forest());
    assert.equal(verdict.required, false);
    assert.equal(verdict.required === false ? verdict.reason : '', 'no-paths');
  });

  it('⑧ 跨关注链路（两个子项目各自被关注）⇒ 必须审核', () => {
    // 构造"同一个子项目内，但命中的节点分属两条不同关注枝"
    const nodes: ReviewNode[] = [
      node(['项目']),
      node(['项目', '任务线']),
      node(['项目', '任务线', '左关注枝'], { refs: ['src/shared-inside'], focus: true }),
      node(['项目', '任务线', '右关注枝'], { refs: ['src/shared-inside'], focus: true }),
    ];
    const verdict = crossProjectVerdict(['src/shared-inside/x.ts'], nodes);
    assert.equal(verdict.required, true, JSON.stringify(verdict));
    assert.equal(verdict.required === true ? verdict.reason : '', 'cross-focus');
  });

  it('引用按**路径边界**比：同前缀的不同文件不算命中', () => {
    assert.equal(refCoversPath('src/ai', 'src/ai/scope.ts'), true);
    assert.equal(refCoversPath('src/ai/', 'src/ai/scope.ts'), true);
    assert.equal(refCoversPath('src/ai', 'src/aix.ts'), false, '少了这条判断，"前缀相同"的文件会被误判');
    assert.equal(refCoversPath('src/ai/scope.ts', 'src/ai/scope.ts'), true);
    assert.equal(refCoversPath('src/ai/scope.ts', 'src/ai/scope.tsx'), false);
    assert.equal(refCoversPath('', 'src/ai.ts'), false);
  });

  it('反斜杠路径与 `./` 前缀都归一化（Windows 上会话给的就是反斜杠）', () => {
    const verdict = crossProjectVerdict(['src\\shared-api\\client.ts'], forest());
    assert.equal(verdict.required, true, JSON.stringify(verdict));
    assert.equal(isWhitelistedPath('.\\project-manager.md'), true);
  });

  it('父链断裂 / 成环时不抛、不猜：按当前层收手', () => {
    const broken: ReviewNode[] = [
      { id: 'a', name: '孤儿', parentId: 'missing', focus: false, refs: ['src/x'] },
    ];
    const verdict = crossProjectVerdict(['src/x/y.ts'], broken);
    assert.equal(verdict.required, false);
    assert.equal(verdict.required === false ? verdict.reason : '', 'single-project');

    const cyclic: ReviewNode[] = [
      { id: 'a', name: 'A', parentId: 'b', focus: false, refs: ['src/x'] },
      { id: 'b', name: 'B', parentId: 'a', focus: false, refs: ['src/x'] },
    ];
    assert.doesNotThrow(() => crossProjectVerdict(['src/x/y.ts'], cyclic));
  });

  it('判定能说成一句人话（提问/拒绝文案共用同一处措辞）', () => {
    const required = crossProjectVerdict(['src/shared-api/client.ts'], forest());
    const text = describeReviewVerdict(required);
    assert.match(text, /会影响别的任务线/);
    assert.match(text, /Mobile/);
    assert.match(text, /命中节点/);
    const ok = crossProjectVerdict(['src/mobile-ui/Page.tsx'], forest());
    assert.equal(describeReviewVerdict(ok), '只影响同一条任务线');
  });
});

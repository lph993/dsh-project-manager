/**
 * 分区命中判定单测（用户口径：截图里问"点击分区内部空白处…展示分区属性还是直接清空"）。
 *
 * 三种落点必须给出三种**不同**的结果 —— 这是本文件存在的全部理由：
 * 区内 ⇒ 选中该区、区外留白 ⇒ 不动、真空白 ⇒ 清空。
 * 只测"区内能选中"是不够的：把"区外留白"也判成清空，用户会觉得自己点了个缝、右边就空了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { featureAtPoint, gestureOutcome, type ZoneBox } from '../../src/client/zone-hit.ts';

const zone = (id: string, x: number, y: number, width: number, height: number): ZoneBox => ({
  x,
  y,
  width,
  height,
  feature: { id },
});

/** 两个区：A 在左上（0,0 起 100×50），B 在右侧（200,0 起 100×50）。中间 100..200 是缝。 */
const ZONES: ZoneBox[] = [zone('A', 0, 0, 100, 50), zone('B', 200, 0, 100, 50)];

test('区内 ⇒ 选中该区（用户要的行为：点区里的空白看这个区的属性）', () => {
  assert.deepEqual(featureAtPoint(ZONES, 10, 10), { kind: 'feature', featureId: 'A' });
  assert.deepEqual(featureAtPoint(ZONES, 250, 25), { kind: 'feature', featureId: 'B' });
  // 边界含在内（贴着区框边点，仍算这个区）
  assert.deepEqual(featureAtPoint(ZONES, 0, 0), { kind: 'feature', featureId: 'A' });
  assert.deepEqual(featureAtPoint(ZONES, 100, 50), { kind: 'feature', featureId: 'A' });
});

test('区外的留白（缝里）⇒ 不动选中，**不许清空**', () => {
  // x=150 落在 A 的右边与 B 的左边之间，仍在两区的包围盒里
  assert.deepEqual(featureAtPoint(ZONES, 150, 25), { kind: 'gap' });
});

test('真空白（所有区之外 / 没有分区）⇒ 清空', () => {
  assert.deepEqual(featureAtPoint(ZONES, -10, -10), { kind: 'outside' });
  assert.deepEqual(featureAtPoint(ZONES, 999, 999), { kind: 'outside' });
  assert.deepEqual(featureAtPoint([], 5, 5), { kind: 'outside' }, '没有分区时一切空白都算真空白');
});

test('重叠时取**画在上层**的那个（后画的压在上面）', () => {
  const overlapping: ZoneBox[] = [zone('under', 0, 0, 100, 100), zone('over', 20, 20, 100, 100)];
  assert.deepEqual(featureAtPoint(overlapping, 30, 30), { kind: 'feature', featureId: 'over' });
  // 只有下层覆盖到的位置仍归下层
  assert.deepEqual(featureAtPoint(overlapping, 5, 5), { kind: 'feature', featureId: 'under' });
});

// ── 手势结论（真机 bug：鼠标在分区内无法拖动）──────────────────────

test('拖过 ⇒ 什么都不做（拖动不是点击，平移视图不许改选中）', () => {
  const hit = featureAtPoint(ZONES, 10, 10);
  assert.deepEqual(gestureOutcome({ onNode: false, blank: false, moved: true, hit }), { kind: 'none' });
  assert.deepEqual(
    gestureOutcome({ onNode: false, blank: true, moved: true, hit: { kind: 'outside' } }),
    { kind: 'none' },
    '拖完松手不许清空（曾经的 bug：拖动画布平移，一松手选中就没了）',
  );
});

test('没拖：按在分区里 ⇒ 选中该分区（区框、标题、区内留白都算）', () => {
  for (const hit of [featureAtPoint(ZONES, 10, 10), featureAtPoint(ZONES, 250, 25)] as const) {
    const outcome = gestureOutcome({ onNode: false, blank: false, moved: false, hit });
    assert.equal(outcome.kind, 'select');
    assert.equal(outcome.kind === 'select' ? outcome.featureId : '', hit.kind === 'feature' ? hit.featureId : '');
  }
});

test('没拖：按在节点上 ⇒ 不参与（节点已在 pointerdown 选中自己）', () => {
  assert.deepEqual(
    gestureOutcome({ onNode: true, blank: false, moved: false, hit: featureAtPoint(ZONES, 10, 10) }),
    { kind: 'none' },
    '少了这条，点节点会被几何命中改判成"点到了节点所在的分区"',
  );
});

test('没拖：真·画布空白 ⇒ 清空；区的缝里 ⇒ 不动', () => {
  assert.deepEqual(
    gestureOutcome({ onNode: false, blank: true, moved: false, hit: { kind: 'outside' } }),
    { kind: 'clear' },
  );
  assert.deepEqual(
    gestureOutcome({ onNode: false, blank: true, moved: false, hit: { kind: 'gap' } }),
    { kind: 'none' },
    '区与区之间的缝不该因为点了一下就把右边清空',
  );
  assert.deepEqual(
    gestureOutcome({ onNode: false, blank: false, moved: false, hit: { kind: 'outside' } }),
    { kind: 'none' },
    '按在区外的连线/装饰上（非真空白）不许清空',
  );
});

// ── 源码级守卫：真机 bug 的**成因**不能再回来 ──────────────────────

/**
 * 这一条测的不是纯函数，而是"画布有没有真的用它"以及"分区有没有再去拦指针"。
 *
 * 为什么值得写：真机 bug 的成因**不在纯函数里**，而在"分区 `<g>` 自己 `stopPropagation()`"
 * ——纯函数写得再对，画布那层收不到 `pointerdown` 也白搭（这正是本项目栽过的
 * "函数写好了没人用/接线断了"那一类）。断言写死到源码文本，看着笨，但它会在**改错的那一刻**报红。
 */
test('画布接上了手势判定，且分区不再拦截指针（真机 bug 的成因）', () => {
  const source = readFileSync(new URL('../../src/client/flow-canvas.tsx', import.meta.url), 'utf8');
  assert.match(source, /gestureOutcome\(/, '画布必须真的调用 gestureOutcome（不是写了个纯函数放那儿）');
  assert.match(source, /data-pm-node=\{node\.id\}/, '节点标记是"按在节点上"的判据，必须有');

  // 分区那一段：从 zones.map 到区框 strokeDasharray 之间不许出现 stopPropagation
  const start = source.indexOf('layout.mode ===');
  const end = source.indexOf('strokeDasharray="6 4"');
  assert.ok(start !== -1 && end !== -1 && end > start, '分区渲染代码的位置变了，请同步本断言');
  const zoneBlock = source.slice(start, end);
  // 只找**调用/属性**形态（`.stopPropagation(` / `onPointerDown=`），不找注释里提到的词
  assert.ok(
    !zoneBlock.includes('.stopPropagation('),
    '分区 `<g>` 又拦指针了 —— 区框覆盖的地方会再次拖不动（用户真机截图那个 bug）',
  );
  assert.ok(
    !zoneBlock.includes('onPointerDown='),
    '分区的选中改由松手时的几何命中判定，不该再有 pointerdown 处理器',
  );
});

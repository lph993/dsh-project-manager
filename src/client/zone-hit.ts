/**
 * **分区命中判定**：内容坐标落在哪个分区里（纯函数，可单测）。
 *
 * 背景（用户口径，截图提问）："点击分区内部空白处你看是展示分区属性好呢还是直接清空右侧属性好呢"。
 * 取"**展示分区属性**"：人已经站在这个区里，想看的通常就是这个区。
 * 但区里还有"真空白"（区框内没节点的地方），那不是任何一个区，清空是合理的。
 *
 * 三种落点要有三种结果，所以返回值用联合类型而不是"有/没有"两态：
 * - `feature`：点在某个区框里 ⇒ 选中该区；
 * - `gap`：**所有区之外**的留白 ⇒ 不动选中（保留用户看到的那个）；
 * - `outside`：什么都不是（没有分区、或点真空白）⇒ 清空选中。
 */

/** 区框的最小形状（与 `FlowZone` 同形的子集）。 */
export interface ZoneBox {
  x: number;
  y: number;
  width: number;
  height: number;
  feature: { id: string };
}

export type FeatureAtPoint =
  | { kind: 'feature'; featureId: string }
  | { kind: 'gap' }
  | { kind: 'outside' };

/**
 * 命中判定。
 *
 * @param zones 本次布局的分区框（顺序即绘制顺序）
 * @param x 内容坐标（已做逆视图变换）
 */
export function featureAtPoint(zones: readonly ZoneBox[], x: number, y: number): FeatureAtPoint {
  /**
   * **从后往前找**：区是顺序打包出来的，后面的画在上层，重叠时以视觉上压在上面那个为准。
   */
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i];
    if (zone === undefined) continue;
    if (x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height) {
      return { kind: 'feature', featureId: zone.feature.id };
    }
  }
  /**
   * 不在任何区里：区分"区外的留白"与"什么都没有"。
   *
   * 判据 = 落点是否落在**所有区框的并集包围盒**内：在里面说明是"区与区之间的缝"，
   * 那是布局留白（用户并没有想要什么），不该因为他点了一下就把右边清空；
   * 在包围盒外（或压根没有分区）才是真正的"点了画布空白"。
   */
  if (zones.length === 0) return { kind: 'outside' };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const zone of zones) {
    minX = Math.min(minX, zone.x);
    minY = Math.min(minY, zone.y);
    maxX = Math.max(maxX, zone.x + zone.width);
    maxY = Math.max(maxY, zone.y + zone.height);
  }
  return x >= minX && x <= maxX && y >= minY && y <= maxY ? { kind: 'gap' } : { kind: 'outside' };
}

/**
 * **一次指针手势的结论**：该选中谁 / 该清空 / 什么都不做。
 *
 * 为什么要把这件事抽成纯函数：它同时受三件事影响（按在哪、有没有拖、几何命中谁），
 * 而三者各自都有"看起来像是修好了"的错误版本。真机反馈过的两个坑：
 *
 * 1. **分区框吃掉指针 ⇒ 区内拖不动**（用户原话"鼠标在分区内无法拖动了需要处理"）：
 *    分区 `<g>` 一度在 `pointerdown` 上 `stopPropagation()`（为了"点分区标题条就选中这个区"），
 *    于是画布那层的 `pointerdown` **根本收不到** ⇒ 拖拽状态从不建立 ⇒ 区框覆盖的地方一律平移不了。
 *    正解：**别拦指针**，选中改由本函数在松手时判定。
 * 2. **拖动不是点击**（用户口径：拖动时不算点击）：拖过就必须什么都不做 ——
 *    否则"平移视图"会顺手把选中改掉。
 *
 * @param input.onNode 按压落点是否落在**节点**上（节点在 `pointerdown` 已经自己选中了，
 *   这里必须放行，不能再按几何命中把"点到节点"改判成"点到分区"）
 * @param input.blank 按压时 `target` 是否就是画布本身（真·空白）
 * @param input.moved 中途是否超过拖拽阈值
 * @param input.hit 按压点的分区命中结果
 */
export function gestureOutcome(input: {
  onNode: boolean;
  blank: boolean;
  moved: boolean;
  hit: FeatureAtPoint;
}): GestureOutcome {
  // ① 拖动不是点击：平移视图不得改变选中
  if (input.moved) return { kind: 'none' };
  // ② 点在节点上：节点在 pointerdown 已经选中它了，这里不参与
  if (input.onNode) return { kind: 'none' };
  // ③ 点在某个分区里（区框、标题、区内的留白/连线都算）⇒ 选中这个分区
  if (input.hit.kind === 'feature') return { kind: 'select', featureId: input.hit.featureId };
  // ④ 只有**真·画布空白**才清空；区与区之间的缝（gap）不动选中
  if (input.hit.kind === 'outside' && input.blank) return { kind: 'clear' };
  return { kind: 'none' };
}

/** `gestureOutcome` 的三种结论。 */
export type GestureOutcome =
  | { kind: 'select'; featureId: string }
  | { kind: 'clear' }
  | { kind: 'none' };

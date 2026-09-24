/**
 * 节点"数字口径"的唯一来源（用户纠偏后的约定：**以项目进度为主**，不以"还剩多少"为主）。
 *
 * 原话：「总功能/任务 / 已完成 这样纯数字的在流程图节点上渲染，其他地方看着修改。
 * 并不是以未完成任务为主，别忘了项目宗旨是以项目进度为主」。
 *
 * 所以口径统一成一条：
 * - **枝节点**：给"**总数 / 已完成**"两个纯数字（该枝子树里的任务点数与其中已完成数）；
 * - **叶节点**：给自身百分比 —— 单件任务点没有"总数"可言（写 `1 / 0` 只是噪声），
 *   而百分比本身就是它的进度；
 * - 未完成数、未完成列表、"只看未完成"过滤**都保留**：它们是有用的入口，
 *   只是不再当主口径（主口径 = 已完成 / 总）。
 *
 * 为什么抽成纯函数：同一个数字要在**五处**出现（画布节点、悬停提示、属性栏、右栏实时进度、
 * 看板指标行与规模行）。散着写早晚会漂移 —— 而"同一份数据在两个地方说法不一致"正是本项目
 * 最不能接受的那类问题（口径必须同源，FR-71）。
 */

/** 只依赖计数字段的形状（画布/属性栏/右栏传的都是 NodeView，这里不绑定具体类型）。 */
export interface Countable {
  /** 该节点子树里的任务点（叶节点）总数。 */
  leafCount: number;
  /** 其中还没完成的任务点数。 */
  unfinishedLeafCount: number;
  /** 自身进度 0–1（叶节点用）。 */
  progress?: number;
}

/** 已完成任务点数 = 总数 − 未完成数（下限 0：坏数据也不给出负数）。 */
export function doneCountOf(node: Countable): number {
  const total = Math.max(0, Math.trunc(node.leafCount));
  const unfinished = Math.max(0, Math.trunc(node.unfinishedLeafCount));
  return Math.max(0, total - unfinished);
}

/** 该节点是不是"有子项"的枝（叶节点没有"总数"概念）。 */
export function isBranch(node: Pick<Countable, 'leafCount'> & { childCount?: number }): boolean {
  if (typeof node.childCount === 'number') return node.childCount > 0;
  return node.leafCount > 1;
}

/**
 * 画布节点上的那行数字（**带标签**：用户两轮口径合并后的结论 ——
 * 先说"总功能/任务 / 已完成 这样纯数字的"，看到裸数字 `4 / 0` 又要求"修正下 `总 / 已完成` 这样展示最合适"。
 * 结论：数字要标出来源，否则框里两个数没人知道哪个是哪个）。
 *
 * - 枝：`总 33 / 已完成 21`
 * - 叶：`45%`（自身进度；单个任务点没有"总数"可言）
 */
export function nodeCountLabel(node: Countable & { childCount?: number }): string {
  if (!isBranch(node)) return `${percentOf(node.progress)}%`;
  return `总 ${Math.max(0, Math.trunc(node.leafCount))} / 已完成 ${doneCountOf(node)}`;
}

/**
 * 那行数字的口径说明（悬停提示与属性栏用一句话讲清"哪个数是哪个"）。
 *
 * 纯数字在框里省地方，但必须在别处能问到含义 —— 否则就是"看着像写错了"的那类界面。
 */
export function nodeCountHint(node: Countable & { childCount?: number }): string {
  if (!isBranch(node)) return `自身进度 ${percentOf(node.progress)}%`;
  return `总 ${Math.max(0, Math.trunc(node.leafCount))} 个任务点 / 已完成 ${doneCountOf(node)} 个`;
}

/** 0–1 → 整数百分比（非法值一律按 0，不渲染 NaN%）。 */
export function percentOf(progress: number | undefined): number {
  if (progress === undefined || !Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** 属性栏顶部那块"大号数字牌"的内容。 */
export interface NodeHeadline {
  /** 大号数字：枝给 `总 / 已完成`，叶给自身百分比。 */
  primary: string;
  /** 大号数字的口径说明（必须跟着数字走，否则 `72 / 6` 没人知道哪个是哪个）。 */
  caption: string;
  /** 进度条旁的百分比（两种形态都给，避免"枝只看到件数、叶只看到百分比"的割裂）。 */
  percent: string;
}

/**
 * 属性栏顶部的**大号数字牌**（用户要求：「选中节点的『总 / 已完成』用大号数字放在右侧属性栏顶部」）。
 *
 * 与画布节点用**同一套口径**（`nodeCountLabel`）：枝 = 总 / 已完成，叶 = 自身百分比。
 * 叶节点不写 `1 / 0`：单件没有"总数"可言，那不是信息而是噪声（见本文件顶部说明）。
 */
export function nodeHeadline(node: Countable & { childCount?: number }): NodeHeadline {
  const percent = `${percentOf(node.progress)}%`;
  if (!isBranch(node)) {
    return { primary: percent, caption: '自身进度', percent };
  }
  return {
    // 大号数字牌空间大，用与画布**措辞一致**的标签（`总 n / 已完成 d`），两处对照不会看岔
    primary: `总 ${Math.max(0, Math.trunc(node.leafCount))} / 已完成 ${doneCountOf(node)}`,
    caption: `总 ${Math.max(0, Math.trunc(node.leafCount))} 个任务点 / 已完成 ${doneCountOf(node)}`,
    percent,
  };
}

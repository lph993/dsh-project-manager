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
 * 画布节点上的那行数字。
 *
 * - 枝：`33 / 21`（**总 / 已完成**）
 * - 叶：`45%`（自身进度）
 */
export function nodeCountLabel(node: Countable & { childCount?: number }): string {
  if (!isBranch(node)) return `${percentOf(node.progress)}%`;
  return `${Math.max(0, Math.trunc(node.leafCount))} / ${doneCountOf(node)}`;
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

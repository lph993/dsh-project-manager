/**
 * **未完成列表的排序口径**（右栏那一列）。抽成纯函数是为了能单测：
 * 这个顺序的规则已经被用户纠正过两次（"进度低的在前"把 0% 顶到最前是错的），
 * 每次都在 UI 里现写一遍比较器，就等于每次都重新赌一次方向。
 *
 * ## 顺序（从先到后）
 *
 * 1. `done` 沉底（已完成不该占视野）；
 * 2. `running` 最先 —— 这个列表的用处是"我现在该盯哪几个"，活的任务优先；
 * 3. 同档内先看 **优先级**（1 最高；**未设置排最后**）—— 用户口径：
 *    "工具获取的任务要按关注点 → 优先级 → 进度 这样的排序获取"（FR-162）；
 * 4. 再看**进度高的在前**（已经起了头的比 0% 更接近完成，0% 是一大片并列噪声）；
 * 5. 最后按名称兜底，保证**每次刷新顺序稳定**（顺序跳来跳去比排错更难受）。
 */
export interface UnfinishedRow {
  id: string;
  name: string;
  derivedState: string;
  progress: number;
  priority?: number | undefined;
}

/** 状态档位（越小越靠前）。 */
const STATE_RANK: Record<string, number> = { running: 0, pending: 1, paused: 2, held: 2 };

function rankOf(state: string): number {
  return STATE_RANK[state] ?? 3;
}

/**
 * 优先级比较：**未设置排最后**（不是当 0 —— 0 会被误当"最高优先级"顶到最前）。
 *
 * 注意这里**不能写成 `rankOf(a) - rankOf(b)`**：两个都未设置时是
 * `Infinity - Infinity = NaN`，而比较器返回 `NaN` 的行为是**未定义**的 ——
 * 实测后果就是"两条都没设优先级的待办，进度高的那条没排在前面"，
 * 被既有的渲染自检抓了出来（`RightProgressView（任务点列表…）`）。
 * 所以这里显式判等/判大小，绝不把 Infinity 拿去相减。
 */
function comparePriority(a: number | undefined, b: number | undefined): number {
  const left = a === undefined ? Number.POSITIVE_INFINITY : a;
  const right = b === undefined ? Number.POSITIVE_INFINITY : b;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 返回排好序的**新数组**（不改入参）。 */
export function orderUnfinished<T extends UnfinishedRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const doneDiff = Number(a.derivedState === 'done') - Number(b.derivedState === 'done');
    if (doneDiff !== 0) return doneDiff;
    const rankDiff = rankOf(a.derivedState) - rankOf(b.derivedState);
    if (rankDiff !== 0) return rankDiff;
    const priorityDiff = comparePriority(a.priority, b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    const progressDiff = b.progress - a.progress;
    if (progressDiff !== 0) return progressDiff;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

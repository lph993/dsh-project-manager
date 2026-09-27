/**
 * **取"下一个该做的"**（FR-162）—— 纯函数，可单测。
 *
 * 用户口径（原话）："完成一个阶段后，从项目进度工具里获取下个阶段任务继续跑，
 * 无需用户一直写入继续，或者说需要一个开关" + "工具获取的任务要按
 * **关注点 → 优先级 → 进度** 这样的排序获取"。
 *
 * ## 为什么排序口径要写死在这里
 *
 * "下一条做什么"如果每次靠模型自己权衡，同一份树会给出不同答案 —— 使用者就不知道
 * 下一步到底该干嘛（这正是本项目最不能接受的那类漂移）。把它固定成三级比较，
 * 结果**可复现**：同一棵树、同一份优先级，永远取到同一条。
 *
 * ## 排序（FR-162 + FR-164 的合并口径）
 *
 * 0. **待审查**（`needsReview`）—— 用户口径："**审查优先级大于关注**"：
 *    审过的活才算数，所以先把"等着被审"的捞出来（否则审不完的活会一直堆着）；
 * 1. **关注链路**（`focus` 枝及其祖先链与后代）—— 人已经表态"我现在盯这条"；
 * 2. **优先级**（1 最高）—— AI 建树时初判、人可改；
 *    **没给优先级的排在给了的后面**（"没表态"不该抢在"明确高优先"前面）；
 * 3. **进度**（低者优先）—— 同档里先捡"还没怎么动的"；
 * 4. 最后按**名称**兜底 —— 保证顺序稳定（每次刷新换一条会让人无所适从）。
 */

/** 候选节点（只带排序需要的字段，便于单测直接喂对象）。 */
export interface TaskCandidate {
  id: string;
  name: string;
  /** 派生状态：`done` / `removed` 不参与"下一个该做的"。 */
  derivedState: string;
  /** 自身进度 0–1。 */
  progress: number;
  /** 优先级 1..10（1 最高）；`undefined` = 没表态。 */
  priority?: number | undefined;
  /** **待审查**（FR-164）：右键打过标记、还没审完。权重高于关注。 */
  needsReview?: boolean | undefined;
  /**
   * 是否在**关注链路**内（`focus` 枝本身及其祖先链/后代）。
   *
   * 由调用方算好传进来：这里刻意不碰树结构 —— 保持纯函数，也让"什么叫关注链路"
   * 只有一处定义（`domain/graph.ts` 的 `focusedRoots` + 祖先链）。
   */
  inFocusChain: boolean;
}

/** 该节点是否"还能做"（已完成/已删除不参与排序）。 */
function actionable(node: TaskCandidate): boolean {
  return node.derivedState !== 'done' && node.derivedState !== 'removed';
}

/** 没给优先级时排最后（而不是当 0 或当 5）："没表态"不该插队。 */
function priorityRank(node: TaskCandidate): number {
  return node.priority === undefined ? Number.POSITIVE_INFINITY : node.priority;
}

/**
 * 按 **待审查 → 关注链路 → 优先级 → 进度 → 名称** 排序，返回**下一条**；没有可做的返回 `undefined`。
 *
 * 只读、不改任何状态 —— 调用方（`pm_next` 工具）据此告诉模型"接着做哪条"。
 */
export function nextTaskOf(candidates: readonly TaskCandidate[]): TaskCandidate | undefined {
  const pool = candidates.filter(actionable);
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => {
    // ⓪ 待审查优先（用户口径："审查优先级大于关注"）
    const reviewDiff = Number(b.needsReview === true) - Number(a.needsReview === true);
    if (reviewDiff !== 0) return reviewDiff;
    // ① 关注链路优先
    const focusDiff = Number(b.inFocusChain) - Number(a.inFocusChain);
    if (focusDiff !== 0) return focusDiff;
    // ② 优先级（1 最高；没给的排最后）
    const priorityDiff = priorityRank(a) - priorityRank(b);
    if (priorityDiff !== 0) return priorityDiff;
    // ③ 进度低者优先
    const progressDiff = a.progress - b.progress;
    if (progressDiff !== 0) return progressDiff;
    // ④ 名称兜底：保证同一棵树每次取到同一条
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  })[0];
}

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
  /**
   * 派生状态（可选）：用来判定"到底完成了没有"。
   *
   * 传了它，百分比就**与完成判定同源**（未完成绝不显示 100%，见 {@link nodePercentOf}）。
   */
  derivedState?: string | undefined;
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
 * 画布节点上的那行数字：**枝给纯数字 `总 / 已完成`**（如 `33 / 21`），**叶给自身百分比**。
 *
 * 用户口径合并后的结论：
 * ① 先说"总功能/任务 / 已完成 这样**纯数字**的在流程图节点上渲染"，看到裸数字 `4 / 0` 又要求
 *    "修正下 `总 / 已完成` 这样展示最合适"；
 * ② 后来又指出"**任务点等地方我说了展示为 140/1，不是 1/140**"——**总数在前**这一条被再次钉死。
 * 两条并不冲突：**框里只放数字**（`33 / 21`），**标签放在框外/别处**（悬停提示与属性栏 caption 讲清含义）。
 * 于是画布那一行从 `总 33 / 已完成 21` 收成 `33 / 21`——含义由 `nodeCountHint` 承担。
 *
 * - 枝：`33 / 21`（总任务点 / 已完成）
 * - 叶：`45%`（自身进度；单个任务点没有"总数"可言）
 */
export function nodeCountLabel(node: Countable & { childCount?: number }): string {
  /**
   * 叶节点给自身百分比 —— 走 {@link nodePercentOf}（**与完成判定同源**）：
   * 用户实测提问"这个意思是还没完成吗？"就是 `percentOf(0.996)` 四舍五入成 100% 造成的。
   */
  if (!isBranch(node)) return `${nodePercentOf({ progress: node.progress ?? 0, derivedState: node.derivedState })}%`;
  // 与 `countRatio` 同一方向、同一间距：`总/已完成`（无空格）—— 空格差异也是"方言"
  return countRatio(node.leafCount, doneCountOf(node));
}

/**
 * 那行数字的口径说明（悬停提示与属性栏用一句话讲清"哪个数是哪个"）。
 *
 * 纯数字在框里省地方，但必须在别处能问到含义 —— 否则就是"看着像写错了"的那类界面。
 */
export function nodeCountHint(node: Countable & { childCount?: number }): string {
  if (!isBranch(node)) {
    return `自身进度 ${nodePercentOf({ progress: node.progress ?? 0, derivedState: node.derivedState })}%`;
  }
  return `${Math.max(0, Math.trunc(node.leafCount))} 个任务点，已完成 ${doneCountOf(node)} 个`;
}

/**
 * 全项目唯一的**件数口径数字串**：`总/已完成`（如 `140/1` = 总 140、已完成 1）。
 *
 * 用户口径（原话）：「**任务点等地方我说了展示为 140/1，不是 1/140**」——
 * 所以**总数在前、已完成在后**，全项目一个方向，不做方言：
 *
 * 1. **一个位置只放一个数字串**，主口径固定为 `总/已完成`（`140/1`）；
 * 2. **未完成数是次口径**，只在它本身就是该位置的主角时出现（未完成清单、`未完成 N 项` 标题），
 *    且**不再与件数比并列**（两个数的和就是总数，并列即冗余——用户："描述啰嗦"）；
 * 3. **顺序写死为 `总/已完成`**；`已完成/总`（`1/140`）是错误方向。
 *
 * @param total 任务点总数
 * @param done  其中已完成数（会钳到 [0, total]）
 */
export function countRatio(total: number, done: number): string {
  const t = Math.max(0, Math.trunc(total));
  const d = Math.min(Math.max(0, Math.trunc(done)), t);
  return `${t}/${d}`;
}

/** 0–1 → 整数百分比（非法值一律按 0，不渲染 NaN%）。 */
export function percentOf(progress: number | undefined): number {
  if (progress === undefined || !Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/**
 * **节点自身的百分比** —— 与"完成判定"同源，避免"显示 100% 却不算完成"。
 *
 * 用户实测提问："这个意思是还没完成吗？"（截图里一条 100% 的任务点，状态点却不是绿的）。
 * 根因是**四舍五入**：`percentOf(0.996)` = 100%，而 `derivedState` 仍是 `running`/`pending`
 * —— 于是界面一边说"到 100% 了"、一边说"还没完成"，用户不知道信哪个。
 *
 * 口径（**未完成一律向下取整**）：
 * - `derivedState === 'done'` ⇒ 100（它确实完成了）；
 * - 否则 `progress` 取 `floor`，并**夹到 99** —— 没完成就绝不显示 100%。
 *
 * 为什么不是"把 0.996 直接当完成"：那等于把"进度接近 1"偷偷升级成"已完成"，
 * 是在替用户下结论（A3 不编造）；显示上少报 1% 是诚实的代价。
 */
export function nodePercentOf(node: { progress: number; derivedState?: string | undefined }): number {
  if (node.derivedState === 'done') return 100;
  const raw = node.progress;
  if (!Number.isFinite(raw)) return 0;
  const clamped = Math.min(1, Math.max(0, raw));
  return Math.min(99, Math.floor(clamped * 100));
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
 * 与画布节点用**同一套口径**（`nodeCountLabel`）：枝 = 纯数字 `总 / 已完成`，叶 = 自身百分比。
 * 叶节点不写 `1 / 0`：单件没有"总数"可言，那不是信息而是噪声（见本文件顶部说明）。
 */
export function nodeHeadline(node: Countable & { childCount?: number }): NodeHeadline {
  const percent = `${percentOf(node.progress)}%`;
  if (!isBranch(node)) {
    return { primary: percent, caption: '自身进度', percent };
  }
  const total = Math.max(0, Math.trunc(node.leafCount));
  const done = doneCountOf(node);
  return {
    // 大号数字牌空间大，但仍然只给纯数字（用户：描述啰嗦）；含义由紧跟其下的 caption 承担
    // 与画布节点同一串（`countRatio`：`总/已完成`、无空格）
    primary: countRatio(total, done),
    caption: `${total} 个任务点，已完成 ${done}`,
    percent,
  };
}

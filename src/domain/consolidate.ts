/**
 * **重复枝合并算法**（FR-158 ⑥ 的执行体）。
 *
 * ## 为什么要有它
 *
 * 在此之前，"合并重复枝"是我**手工**做的：读脚本输出 → 一条条 `pm_move` → 再 `pm_remove`。
 * 那是**数据操作，不是产品能力** —— 换个项目、换一次建树，同样的脏东西会再长出来。
 * 真正该做的是把判据与动作**抽成纯函数**，然后接到两个地方：
 *
 * | 落点 | 作用 |
 * |---|---|
 * | 建树合并（预防） | 模型提案与既有**兄弟枝**身份撞车时复用/合并，而不是并排再建一份 |
 * | 维护操作（治疗） | 对已有树跑一次 dry-run → 人看一眼 → 执行（带审计、可回滚） |
 *
 * ## 判据（全部机械，且都吃过亏）
 *
 * 1. **只比兄弟**，且**父枝必须有 refs**：无 refs 的父是「跨区辅助任务」这类专区，
 *    它下面的重叠是**被允许**的（用户口径："无法归类且必须存在的用单一区管理，算辅助任务"）。
 * 2. **只有"引用完全相同 / 互为子集"才算重复枝**（FR-158 ⑥：同一份代码的两次评估）。
 *    **部分重叠不算** —— 这条是血的教训：我一度按"部分重叠"推算出"121 个可删"，
 *    逐条看才发现里面全是"功能点与其下属任务点"的正常层级；**重叠≠重复**。
 * 3. **保留者**按可比较的事实选：子节点多 > 有描述 > 进度高 > 名字（稳定）。
 * 4. **先搬后删**：把被删者的**活子节点**搬进保留者（搬是无损的），**再**删空壳；
 *    嵌套重复（重复枝里面还是重复枝）按**深度优先**处理，于是自然收敛、绝不整片误删。
 * 5. **进度按"取大"并进保留者**（删之前并，否则信息就丢了）。
 */

/** 判据输入（`service.reviewIndexOf()` 的形状就够）。 */
export interface ConsolidateNode {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
  description?: string;
  progress: number;
  refs: string[];
}

/** 一个动作。顺序即执行顺序：先 `move`、再 `fold`、最后 `delete`。 */
export type ConsolidateAction =
  | { kind: 'move'; nodeId: string; name: string; toParentId: string; reason: string }
  | { kind: 'fold'; nodeId: string; name: string; progress: number; reason: string }
  | {
      kind: 'delete';
      nodeId: string;
      name: string;
      /** 被删者的 refs 逐条都被这个保留者覆盖（可核对，不是"看起来像"）。 */
      keptBy: string;
      reason: string;
    };

export interface ConsolidatePlan {
  actions: ConsolidateAction[];
  /** 只报告、不动作的情况（例如部分重叠）—— 交人判断，算法不擅自处置。 */
  notes: string[];
}

const normalize = (ref: string): string => ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const refSet = (node: ConsolidateNode): string[] => [
  ...new Set(node.refs.map(normalize).filter((ref) => ref !== '')),
];

/** refs 是否互为子集（**字符串集合**判定，与宿主 `E_DUPLICATE_BRANCH` 同一口径）。 */
function mutuallyContained(a: readonly string[], b: readonly string[]): boolean {
  const setB = new Set(b);
  const setA = new Set(a);
  return a.every((ref) => setB.has(ref)) || b.every((ref) => setA.has(ref));
}

/** 保留者排序：子节点多 > 有描述 > 进度高 > 名字（全是可比较的事实）。 */
function pickKeeper(
  candidates: readonly ConsolidateNode[],
  childCountOf: (id: string) => number,
): ConsolidateNode {
  return [...candidates].sort((a, b) => {
    const kidsDiff = childCountOf(b.id) - childCountOf(a.id);
    if (kidsDiff !== 0) return kidsDiff;
    const descDiff = Number((b.description ?? '') !== '') - Number((a.description ?? '') !== '');
    if (descDiff !== 0) return descDiff;
    if (b.progress !== a.progress) return b.progress - a.progress;
    return a.name.localeCompare(b.name);
  })[0] as ConsolidateNode;
}

/** 树深（用于深度优先处理嵌套重复）。 */
function depthOf(node: ConsolidateNode, byId: Map<string, ConsolidateNode>): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>([node.id]);
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * 生成合并计划（**纯函数，不改任何数据**）。
 *
 * @param nodes 当前活节点（墓碑不必传；传了也不参与判据）
 * @returns 动作序列（按"深度优先 + 先搬后删"排好）与只报告不动的说明
 */
export function planOnce(nodes: readonly ConsolidateNode[]): ConsolidatePlan {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, ConsolidateNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const bucket = childrenOf.get(node.parentId);
    if (bucket === undefined) childrenOf.set(node.parentId, [node]);
    else bucket.push(node);
  }
  const childCountOf = (id: string): number => (childrenOf.get(id) ?? []).length;

  /** 已被计划删掉的节点集合：它们的子节点还没搬走之前，不允许再被当成"待删"。 */
  const plannedDelete = new Set<string>();
  const actions: ConsolidateAction[] = [];
  const notes: string[] = [];

  // 深度优先：先处理深的重复枝，父层的重复枝等到子层收干净，自然变成空壳再处理
  const ordered = [...nodes].sort((a, b) => depthOf(b, byId) - depthOf(a, byId) || a.name.localeCompare(b.name));

  for (const node of ordered) {
    if (plannedDelete.has(node.id)) continue;
    const refs = refSet(node);
    if (refs.length === 0) continue;
    if (node.parentId === null) continue;

    const parent = byId.get(node.parentId);
    /**
     * 无 refs 的父 = 辅助任务专区 ⇒ **豁免**（用户口径）。父不在输入里（判不了）⇒ 不豁免，
     * 保守地继续判 —— 宁可多报，也不假装"它没有 refs"。
     */
    if (parent !== undefined && refSet(parent).length === 0) continue;

    const siblings = (childrenOf.get(node.parentId) ?? []).filter(
      (candidate) => candidate.id !== node.id && !plannedDelete.has(candidate.id),
    );
    const dupes = siblings.filter((candidate) => {
      const other = refSet(candidate);
      return other.length > 0 && mutuallyContained(refs, other);
    });
    if (dupes.length === 0) {
      /**
       * 没有"完全相同/互为子集"的兄弟，但可能有**部分重叠** —— 只报告，不动作。
       * （教训：曾按部分重叠算出"121 个可删"，里面全是功能点与其下属任务点的正常层级。）
       */
      continue;
    }

    const group = [node, ...dupes];
    const keeper = pickKeeper(group, childCountOf);
    if (keeper.id === node.id) continue; // 自己就是保留者，等别人那轮处理
    for (const loser of group.filter((item) => item.id !== keeper.id)) {
      if (plannedDelete.has(loser.id)) continue;
      plannedDelete.add(loser.id);
      const loserRefs = refSet(loser);
      const keeperRefs = new Set(refSet(keeper));
      const covered = loserRefs.every((ref) => keeperRefs.has(ref));
      // 只搬**活子节点**；它们的 refs 各行其是，搬过去不改变语义
      for (const child of childrenOf.get(loser.id) ?? []) {
        actions.push({
          kind: 'move',
          nodeId: child.id,
          name: child.name,
          toParentId: keeper.id,
          reason: `「${loser.name}」与保留者「${keeper.name}」引用同一批路径（同一份代码的两次评估）⇒ 先把它的活子节点搬到保留者下`,
        });
      }
      if (loser.progress > keeper.progress) {
        actions.push({
          kind: 'fold',
          nodeId: keeper.id,
          name: keeper.name,
          progress: loser.progress,
          reason: `「${loser.name}」进度 ${Math.round(loser.progress * 100)}% 高于保留者的 ${Math.round(
            keeper.progress * 100,
          )}% ⇒ 删之前先并过去`,
        });
      }
      actions.push({
        kind: 'delete',
        nodeId: loser.id,
        name: loser.name,
        keptBy: keeper.id,
        reason: covered
          ? `refs 逐条都被保留者「${keeper.name}」覆盖`
          : `与保留者「${keeper.name}」互为子集（合并会重复统计进度）`,
      });
    }
  }

  return { actions, notes };
}

/** 计划摘要（诊断页/工具输出共用）。 */
export function describeConsolidation(plan: ConsolidatePlan): string {
  const moves = plan.actions.filter((action) => action.kind === 'move').length;
  const folds = plan.actions.filter((action) => action.kind === 'fold').length;
  const deletes = plan.actions.filter((action) => action.kind === 'delete').length;
  if (plan.actions.length === 0) return '没有可合并的重复枝';
  return `可合并：搬 ${moves} 个节点、并 ${folds} 处进度、删 ${deletes} 个空壳（均为重复枝）`;
}

/** 把一批动作"演算"到一份节点副本上（纯数据变换，用于迭代规划）。 */
function simulate(
  nodes: readonly ConsolidateNode[],
  actions: readonly ConsolidateAction[],
): ConsolidateNode[] {
  const byId = new Map(nodes.map((node) => [node.id, { ...node }]));
  for (const action of actions) {
    if (action.kind === 'move') {
      const child = byId.get(action.nodeId);
      if (child !== undefined) child.parentId = action.toParentId;
    } else if (action.kind === 'fold') {
      const node = byId.get(action.nodeId);
      if (node !== undefined) node.progress = Math.max(node.progress, action.progress);
    } else {
      byId.delete(action.nodeId);
    }
  }
  return [...byId.values()];
}

/**
 * 生成**完整**合并计划（纯函数，不改任何数据）。
 *
 * **为什么要迭代**（第一版就是栽在这里）：单趟只比"同父兄弟"，而重复枝常常是**链式**的
 * （重复枝的里面还有一层重复枝）。手工清理时我是"跑一轮 → 看结果 → 再跑一轮"；
 * 算法要一次给出完整计划，就得**自己演算**：应用本趟动作到副本上，再规划下一趟，
 * 直到没有动作可做（最多 8 轮，防御性上限）。每一轮的动作都是"先搬后删"，所以
 * 逐轮收敛的过程中**任何一步都不会丢子节点**。
 */
export function planConsolidation(nodes: readonly ConsolidateNode[]): ConsolidatePlan {
  const actions: ConsolidateAction[] = [];
  const notes: string[] = [];
  let current = [...nodes];
  for (let round = 0; round < 8; round += 1) {
    const plan = planOnce(current);
    if (plan.actions.length === 0) {
      for (const note of plan.notes) if (!notes.includes(note)) notes.push(note);
      break;
    }
    actions.push(...plan.actions);
    current = simulate(current, plan.actions);
  }
  /**
   * **合并重复的 `fold`**：迭代每轮都会重发"并进度"（因为保留者进度还是旧的），
   * 于是同一个保留者会出现 6 条一模一样的动作（**真机实测**：`适配器注册表与调试通道 → 60%` 六遍）。
   * 计划是给人看的 —— 同一个节点只留**最高**那一条，否则读起来像要写 6 次。
   */
  const foldsByNode = new Map<string, Extract<ConsolidateAction, { kind: 'fold' }>>();
  const deduped: ConsolidateAction[] = [];
  for (const action of actions) {
    if (action.kind !== 'fold') {
      deduped.push(action);
      continue;
    }
    const existing = foldsByNode.get(action.nodeId);
    if (existing === undefined) {
      foldsByNode.set(action.nodeId, action);
      deduped.push(action);
    } else if (action.progress > existing.progress) {
      existing.progress = action.progress;
      existing.reason = action.reason;
    }
  }
  return { actions: deduped, notes };
}

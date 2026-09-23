/**
 * 枝桠折叠的**纯逻辑**（不碰 React，可被 `node --test` 直接跑）。
 *
 * 语义（用户口径，逐字对着实现）：
 * - 普通点击：枝里**没有**折叠标记 → 整枝折起（只标记分叉根自己，布局遇到它就整棵子树不画）；
 *   枝里**有**标记 → 展开一层；
 * - Shift 点击：没有标记 → 从**最下游（最深）**一层开始，一次折一层；
 *   有标记 → 整枝全部展开。
 *
 * 关键概念是"一层"：它按**当前可见**的节点算，所以"折一层"= 把当前可见的、还有子节点的
 * 最深一层标记起来（正好藏掉再往下一层）；"展开一层"= 把最浅一层标记**下移一层**。
 *
 * 为什么展开是"下移"而不是"删除"：整枝折起时只标记了根，直接把标记删掉会让整棵子树
 * 一口气全露出来 —— 那就不是"一层层展开"了。
 */

import type { NodeView } from './contract.ts';

export interface FoldTree {
  /** 父 → 直接子（只含本次数据集内的节点；父不在集合里的当根）。 */
  childrenOf: Map<string, string[]>;
  /** 某节点的整棵子树 id（含自身）。 */
  subtree(nodeId: string): string[];
  /** 子树里**当前可见**的节点，按深度分层（第 0 层是它自己；折叠处的子树不再往下走）。 */
  visibleLayers(nodeId: string, folded: ReadonlySet<string>): string[][];
}

/** 按 `parentId` 建一次邻接表（事实源是扁平数组，不引入第二套树结构）。 */
export function buildFoldTree(nodes: readonly NodeView[]): FoldTree {
  const childrenOf = new Map<string, string[]>();
  const known = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId === null || !known.has(parentId)) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(node.id);
    childrenOf.set(parentId, list);
  }
  const subtree = (nodeId: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(childrenOf.get(id) ?? []));
    }
    return out;
  };
  const visibleLayers = (nodeId: string, folded: ReadonlySet<string>): string[][] => {
    const layers: string[][] = [];
    const walk = (id: string, depth: number): void => {
      const layer = layers[depth] ?? (layers[depth] = []);
      layer.push(id);
      if (folded.has(id)) return; // 折起来的节点：子树整段不画，层也到此为止
      for (const child of childrenOf.get(id) ?? []) walk(child, depth + 1);
    };
    walk(nodeId, 0);
    return layers;
  };
  return { childrenOf, subtree, visibleLayers };
}

/** 这个枝里有没有被折起来的东西（含它自己）。折叠/展开的方向完全由它决定，不记"上次点了什么"。 */
export function hasFoldBelow(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
): boolean {
  return tree.subtree(nodeId).some((id) => folded.has(id));
}

/** 折一层：把当前可见、还有子节点的**最深**一层标记起来（已经标记过的排除，否则会原地打转）。 */
function collapseLayer(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
): ReadonlySet<string> {
  const layers = tree.visibleLayers(nodeId, folded);
  for (let depth = layers.length - 1; depth >= 0; depth -= 1) {
    const candidates = (layers[depth] ?? []).filter(
      (id) => !folded.has(id) && (tree.childrenOf.get(id) ?? []).length > 0,
    );
    if (candidates.length === 0) continue;
    const next = new Set(folded);
    for (const id of candidates) next.add(id);
    return next;
  }
  return folded; // 已经折到底了：这次点击没有可折的层
}

/** 展开一层：把最浅一层**折起来的可见节点**的标记挪到它们的子节点上（正好多露一层）。 */
function expandLayer(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
): ReadonlySet<string> {
  const layers = tree.visibleLayers(nodeId, folded);
  const frontier = layers.find((ids) => ids.some((id) => folded.has(id)));
  if (frontier === undefined) return folded;
  const next = new Set(folded);
  for (const id of frontier) {
    if (!folded.has(id)) continue;
    next.delete(id);
    for (const child of tree.childrenOf.get(id) ?? []) {
      if ((tree.childrenOf.get(child) ?? []).length > 0) next.add(child);
    }
  }
  return next;
}

/** 整枝展开：子树里的折叠标记一律清掉（含历史上留下的深层标记）。 */
function expandAll(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
): ReadonlySet<string> {
  const next = new Set(folded);
  let changed = false;
  for (const id of tree.subtree(nodeId)) if (next.delete(id)) changed = true;
  return changed ? next : folded;
}

/**
 * 一次点击（或双击、点枝标签）之后的新折叠集合。返回 `folded` 本身表示"没有变化"。
 *
 * Shift 的规则值得写清楚：**还能再折就再折一层，折到底了才是"全展开"**。
 * 一开始写成"只要枝里有折叠标记就全展开"是错的 —— 那会让"按住 Shift 连点"变成
 * 第一下折一层、第二下反而全展开（实测单测当场抓到）。
 *
 * @param shiftKey - 是否按住 Shift（逐层折 / 全展开）
 */
export function foldToggle(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
  shiftKey: boolean,
): ReadonlySet<string> {
  if (shiftKey) {
    const deeper = collapseLayer(tree, folded, nodeId);
    if (deeper !== folded) return deeper; // 还有层可折
    return expandAll(tree, folded, nodeId); // 已经折到底 → 全部展开
  }
  if (hasFoldBelow(tree, folded, nodeId)) return expandLayer(tree, folded, nodeId);
  // 没有折叠标记 → 整枝折起：只标记分叉根，别的一个都不用加
  return folded.has(nodeId) ? folded : new Set(folded).add(nodeId);
}

/**
 * 这个节点下面藏了多少节点（分叉按钮上的 `+N`）。
 *
 * 说实话的算法：子树总节点数 − 当前可见节点数。只报"直接子节点数"会小得离谱。
 */
export function hiddenBelow(
  tree: FoldTree,
  folded: ReadonlySet<string>,
  nodeId: string,
): number {
  if (!hasFoldBelow(tree, folded, nodeId)) return 0;
  const total = tree.subtree(nodeId).length;
  const visible = tree
    .visibleLayers(nodeId, folded)
    .reduce((sum, layer) => sum + layer.length, 0);
  return Math.max(0, total - visible);
}

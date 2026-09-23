/**
 * 流程图布局（纯函数，可单测）。
 *
 * 为什么自研而不用 elkjs（§5.4 原计划）：见 `src/client/flow-canvas.tsx` 顶部说明 ——
 * 我们这个层级只需要"分层树 + 正交连线"，20 行 DFS 就够了，
 * 拉进来一个几百 KB 的布局引擎对客户端 bundle 是纯负担。
 *
 * 布局规则：
 * - 自上而下分层，`y = depth * (nodeHeight + gapY)`；
 * - 叶节点横向依次排开，父节点居中于其可见子节点的中点（经典 tidy tree 的简化版）；
 * - 折叠（`collapsed`）的子树不参与布局，但记下被隐藏的子节点数，供 UI 显示"已折叠 N 项"。
 */

import type { NodeView } from './contract.ts';

export interface FlowLayoutOptions {
  /** 被折叠的节点 id（其子树不参与布局）。 */
  collapsed?: ReadonlySet<string>;
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
}

export interface PlacedNode {
  node: NodeView;
  /** 节点左上角坐标（画布坐标系）。 */
  x: number;
  y: number;
  depth: number;
  /** 被折叠隐藏的直接子节点数（0 = 没有隐藏）。 */
  hiddenChildren: number;
  /**
   * 被折叠隐藏的**整棵子树**节点数（不含自己）。
   *
   * 与 `hiddenChildren` 分开：徽标要给用户一个"这一折下去藏了多少东西"的量感，
   * 只报直接子节点数会小得离谱（一棵 30 个节点的枝折起来只显示 +3）。
   */
  hiddenDescendants: number;
  /** 该节点是否在关注枝并集内（关注枝 = 实线主路径；旁枝 = 虚线）。 */
  inFocusBranch: boolean;
  /**
   * 该节点是否**通往**某个被关注的节点（自己的祖先链上有焦点，或子孙里有焦点）。
   *
   * 关注的枝根往上是"链路"：图大时用户要能顺着链路找回根，所以这些节点也要**轻微**提示，
   * 但不能和主枝一样抢眼（实测反馈："关注的节点的父级也应该也高亮，只不过不用那么明显"）。
   */
  onFocusPath: boolean;
  /** 顶层枝序号（`depth >= 1` 时指向最近的 depth-1 祖先；根为 -1）。 */
  branchIndex: number;
  /** 顶层枝名（用于画布上的枝标签）。 */
  branchLabel: string;
  /** 该节点是否就是顶层枝本身。 */
  isBranchRoot: boolean;
}

export interface FlowEdge {
  from: PlacedNode;
  to: PlacedNode;
}

export interface FlowLayout {
  placed: PlacedNode[];
  edges: FlowEdge[];
  /** 画布内容尺寸（含节点自身宽高）。 */
  width: number;
  height: number;
  /** 布局用到的节点尺寸（渲染端复用，避免两处各写一遍）。 */
  nodeWidth: number;
  nodeHeight: number;
}

export const FLOW_NODE_WIDTH = 152;
export const FLOW_NODE_HEIGHT = 50;
export const FLOW_GAP_X = 20;
export const FLOW_GAP_Y = 42;

/**
 * 计算流程图布局。
 *
 * 输入是看板的**扁平**节点数组（`parentId` 表达父子关系）——
 * 与事实源的口径一致，布局层不引入第二套树结构。
 */
export function layoutFlow(
  nodes: readonly NodeView[],
  options: FlowLayoutOptions = {},
): FlowLayout {
  const nodeWidth = options.nodeWidth ?? FLOW_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? FLOW_NODE_HEIGHT;
  const gapX = options.gapX ?? FLOW_GAP_X;
  const gapY = options.gapY ?? FLOW_GAP_Y;
  const collapsed = options.collapsed ?? new Set<string>();

  const byId = new Map<string, NodeView>();
  for (const node of nodes) byId.set(node.id, node);

  const childrenOf = new Map<string, NodeView[]>();
  const roots: NodeView[] = [];
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(node);
      continue;
    }
    const list = childrenOf.get(parentId) ?? [];
    list.push(node);
    childrenOf.set(parentId, list);
  }
  // 稳定顺序：按名称排序，保证同一份数据每次布局一致（画布不该自己抖动）
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }
  roots.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const placed: PlacedNode[] = [];
  const placedById = new Map<string, PlacedNode>();
  const edges: FlowEdge[] = [];
  let cursorX = 0;
  let maxDepth = 0;
  const visited = new Set<string>();

  /**
   * 关注枝并集：任一祖先（含自身）被关注，则该节点在关注枝内。
   */
  const focusMemo = new Map<string, boolean>();
  const inFocus = (node: NodeView): boolean => {
    const cached = focusMemo.get(node.id);
    if (cached !== undefined) return cached;
    const path: NodeView[] = [];
    const seen = new Set<string>();
    let current: NodeView | undefined = node;
    let value = false;
    while (current !== undefined) {
      const known = focusMemo.get(current.id);
      if (known !== undefined) {
        value = known;
        break;
      }
      if (seen.has(current.id)) break; // 环：就地收敛，视为未关注
      seen.add(current.id);
      path.push(current);
      if (current.focus) {
        value = true;
        break;
      }
      const parentId: string | null = current.parentId;
      current = parentId === null ? undefined : byId.get(parentId);
    }
    for (const item of path) focusMemo.set(item.id, value);
    return value;
  };

  /**
   * "通往焦点"的链路：自己在焦点的祖先链上，或自己的子孙里有焦点。
   *
   * 用一趟自底向上 + 一趟自顶向下算完，避免每个节点各走一遍祖先链。
   */
  const hasFocusedDescendant = new Map<string, boolean>();
  const computeHasFocusedDescendant = (node: NodeView, guard: Set<string>): boolean => {
    const cached = hasFocusedDescendant.get(node.id);
    if (cached !== undefined) return cached;
    if (guard.has(node.id)) return false;
    guard.add(node.id);
    let value = node.focus;
    for (const child of childrenOf.get(node.id) ?? []) {
      if (computeHasFocusedDescendant(child, guard)) value = true;
    }
    hasFocusedDescendant.set(node.id, value);
    return value;
  };
  for (const root of roots) computeHasFocusedDescendant(root, new Set<string>());
  for (const node of nodes) {
    if (!hasFocusedDescendant.has(node.id)) computeHasFocusedDescendant(node, new Set<string>());
  }

  /** 是否为某条"通往焦点的祖先链"上的节点（自己不必是主枝）。 */
  const onFocusPath = (node: NodeView): boolean => {
    if (inFocus(node)) return true;
    if (hasFocusedDescendant.get(node.id) === true) return true;
    // 祖先里有焦点 → 已经在 inFocus 里覆盖；这里只需再查"子孙里有焦点"
    return false;
  };

  /** 某节点的全部后代数（折叠徽标用；memo 化，避免每个折叠节点各走一遍子树）。 */
  const descendantMemo = new Map<string, number>();
  const countDescendants = (node: NodeView, guard: Set<string>): number => {
    const cached = descendantMemo.get(node.id);
    if (cached !== undefined) return cached;
    if (guard.has(node.id)) return 0; // 数据成环时就地收敛
    guard.add(node.id);
    let total = 0;
    for (const child of childrenOf.get(node.id) ?? []) {
      total += 1 + countDescendants(child, guard);
    }
    descendantMemo.set(node.id, total);
    return total;
  };

  /**
   * 深度优先布局。
   *
   * @returns 该子树占用的**横向中心**（父节点据此居中）
   */
  const walk = (node: NodeView, depth: number, branch: { index: number; label: string }): number => {
    if (visited.has(node.id)) {
      // 数据异常（成环）时按叶子处理，绝不死循环
      const x = cursorX;
      cursorX += nodeWidth + gapX;
      return x + nodeWidth / 2;
    }
    visited.add(node.id);
    const children = childrenOf.get(node.id) ?? [];
    const isCollapsed = collapsed.has(node.id);
    const hidden = isCollapsed ? children.length : 0;
    const hiddenDeep = isCollapsed ? countDescendants(node, new Set<string>()) : 0;
    const visible = isCollapsed ? [] : children;

    maxDepth = Math.max(maxDepth, depth);

    let centerX: number;
    if (visible.length === 0) {
      centerX = cursorX + nodeWidth / 2;
      cursorX += nodeWidth + gapX;
    } else {
      const centers = visible.map((child) => walk(child, depth + 1, branch));
      centerX = (centers[0]! + centers[centers.length - 1]!) / 2;
    }

    const entry: PlacedNode = {
      node,
      x: centerX - nodeWidth / 2,
      y: depth * (nodeHeight + gapY),
      depth,
      hiddenChildren: hidden,
      hiddenDescendants: hiddenDeep,
      inFocusBranch: inFocus(node),
      onFocusPath: onFocusPath(node),
      branchIndex: branch.index,
      branchLabel: branch.label,
      isBranchRoot: depth === 1,
    };
    placed.push(entry);
    placedById.set(node.id, entry);
    return centerX;
  };

  for (const root of roots) walk(root, 0, { index: -1, label: root.name });
  // 数据异常（互相指认的环、或父节点不在本次数据集里）时，剩下的节点不能凭空消失：
  // 把它们当根再走一遍，`visited` 保证不会死循环。
  // 但**被折叠的子树除外** —— 那是用户主动隐藏的，不能再被"救回来"。
  const hiddenByCollapse = (node: NodeView): boolean => {
    const seen = new Set<string>();
    let current = node;
    while (current.parentId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      if (collapsed.has(parent.id)) return true;
      current = parent;
    }
    return false;
  };
  let orphanBranch = -1;
  for (const node of nodes) {
    if (!visited.has(node.id) && !hiddenByCollapse(node)) {
      walk(node, 0, { index: orphanBranch, label: node.name });
      orphanBranch -= 1;
    }
  }

  /*
   * 顶层枝的序号与**名字**：只有 depth-1 的节点开启新枝，其余继承父枝。
   *
   * **实测踩过的错**：一开始只重算了 `branchIndex`，`branchLabel` 还是 `walk()` 里从根传下来的
   * 那个值 —— 于是每一条枝（存储与持久化、构建与产物自检工具链、领域模型与进度计算…）
   * 的标签都写着**根节点的名字**，看起来像"同一个节点被画了好几遍"（用户截图指出）。
   * 枝名必须取**该枝自己（depth-1 节点）的名字**。
   */
  let nextBranch = 0;
  for (const entry of placed) {
    if (entry.depth === 1) {
      entry.branchIndex = nextBranch;
      entry.branchLabel = entry.node.name;
      nextBranch += 1;
    }
  }
  for (const entry of placed) {
    if (entry.depth <= 1) continue;
    const parent = entry.node.parentId === null ? undefined : placedById.get(entry.node.parentId);
    if (parent !== undefined) {
      entry.branchIndex = parent.branchIndex;
      entry.branchLabel = parent.branchLabel;
    }
  }

  // 边在布局完成后统一连接（此时两端都已就位）
  for (const entry of placed) {
    for (const child of childrenOf.get(entry.node.id) ?? []) {
      const target = placedById.get(child.id);
      if (target) edges.push({ from: entry, to: target });
    }
  }

  const leafSpan = Math.max(1, placed.filter((p) => (childrenOf.get(p.node.id) ?? []).length === 0 || p.hiddenChildren > 0).length);
  return {
    placed,
    edges,
    width: Math.max(leafSpan * (nodeWidth + gapX), nodeWidth),
    height: (maxDepth + 1) * (nodeHeight + gapY),
    nodeWidth,
    nodeHeight,
  };
}

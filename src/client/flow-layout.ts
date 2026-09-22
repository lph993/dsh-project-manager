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
  /** 该节点是否在关注枝并集内（关注枝 = 实线主路径；旁枝 = 虚线）。 */
  inFocusBranch: boolean;
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

export const FLOW_NODE_WIDTH = 168;
export const FLOW_NODE_HEIGHT = 56;
export const FLOW_GAP_X = 28;
export const FLOW_GAP_Y = 46;

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
   * 深度优先布局。
   *
   * @returns 该子树占用的**横向中心**（父节点据此居中）
   */
  const walk = (node: NodeView, depth: number): number => {
    if (visited.has(node.id)) {
      // 数据异常（成环）时按叶子处理，绝不死循环
      const x = cursorX;
      cursorX += nodeWidth + gapX;
      return x + nodeWidth / 2;
    }
    visited.add(node.id);
    const children = childrenOf.get(node.id) ?? [];
    const hidden = collapsed.has(node.id) ? children.length : 0;
    const visible = collapsed.has(node.id) ? [] : children;

    maxDepth = Math.max(maxDepth, depth);

    let centerX: number;
    if (visible.length === 0) {
      centerX = cursorX + nodeWidth / 2;
      cursorX += nodeWidth + gapX;
    } else {
      const centers = visible.map((child) => walk(child, depth + 1));
      centerX = (centers[0]! + centers[centers.length - 1]!) / 2;
    }

    const entry: PlacedNode = {
      node,
      x: centerX - nodeWidth / 2,
      y: depth * (nodeHeight + gapY),
      depth,
      hiddenChildren: hidden,
      inFocusBranch: inFocus(node),
    };
    placed.push(entry);
    placedById.set(node.id, entry);
    return centerX;
  };

  for (const root of roots) walk(root, 0);
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
  for (const node of nodes) {
    if (!visited.has(node.id) && !hiddenByCollapse(node)) walk(node, 0);
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

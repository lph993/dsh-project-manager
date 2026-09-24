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

/**
 * 布局方向。
 *
 * - `LR`（默认）：根在左、子孙往右 —— 贴合**窄而高**的侧边栏面板（用户反馈"由左往右展示是不是
 *   面积就不那么大点"）；
 * - `TB`：根在上、子孙往下（老版本；叶节点多时拉成又宽又扁的横带）。
 */
export type FlowOrientation = 'TB' | 'LR';

/**
 * 布局形态。
 *
 * - `tree`（默认）：一整棵连线树（根在左、子孙往右）；
 * - `zones`：**按功能点分区**（用户诉求："按功能点拆顶级节点去展示，一个功能点是个区，
 *   这种是面向功能相关性弱的方式展示"）。根的每个直接子节点 = 一个区，区内自己排一棵小树，
 *   区块再打包成多列 —— 于是**长宽都不会失控**（树模式下 33 个叶节点会拉出一条几千像素的带子）。
 */
export type FlowMode = 'tree' | 'zones';

/** 一个"区"（功能点）在画布上的框与标题。 */
export interface FlowZone {
  /** 功能点节点（区标题就是它：名字 + 总/已完成）。 */
  feature: NodeView;
  /** 区框（含标题条）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 标题文字基线位置。 */
  titleX: number;
  titleY: number;
  /** 该区属于哪条顶层枝（用枝色给框描边，和节点左侧色条同一套颜色）。 */
  branchIndex: number;
}

export interface FlowLayoutOptions {
  /** 被折叠的节点 id（其子树不参与布局）。 */
  collapsed?: ReadonlySet<string>;
  /** 布局方向；默认 `LR`。 */
  orientation?: FlowOrientation;
  /** 布局形态；默认 `tree`。 */
  mode?: FlowMode;
  /** `zones` 模式下每列的目标高度（像素）；实际会按区大小自适应微调。 */
  columnHeight?: number;
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
  /** 本次布局用的方向（渲染端据此决定连线走法、折叠按钮放哪条边、怎么自适应）。 */
  orientation: FlowOrientation;
  /** 本次布局的形态（`tree` = 整棵连线树；`zones` = 按功能点分区）。 */
  mode: FlowMode;
  /** `zones` 模式下的区框与标题（`tree` 模式下为空数组）。 */
  zones: FlowZone[];
  /** 画布内容尺寸（含节点自身宽高）。 */
  width: number;
  height: number;
  /** 布局用到的节点尺寸（渲染端复用，避免两处各写一遍）。 */
  nodeWidth: number;
  nodeHeight: number;
  /**
   * 这棵树里**有没有**任何节点被关注。
   *
   * 为什么要这个开关（用户实测反馈："节点好轻啊，容易看不清"）：
   * 没有关注时，所有节点的 `inFocusBranch` 都是 false，渲染端按"旁枝"处理 ⇒ **整棵树都被调暗**
   * （暗色主题下 opacity 0.42）。而没有关注就没有"主/旁"的对照可言 —— 这时应当**全亮**。
   */
  hasFocus: boolean;
}

export const FLOW_NODE_WIDTH = 152;
export const FLOW_NODE_HEIGHT = 50;
export const FLOW_GAP_X = 20;
export const FLOW_GAP_Y = 42;

/**
 * 计算流程图布局（统一入口）：按 `mode` 分派到"整棵连线树"或"按功能点分区"。
 */
export function layoutFlow(
  nodes: readonly NodeView[],
  options: FlowLayoutOptions = {},
): FlowLayout {
  return (options.mode ?? 'tree') === 'zones' ? layoutZones(nodes, options) : layoutTree(nodes, options);
}

/**
 * **按功能点分区布局**（用户诉求："按功能点拆顶级节点去展示，一个功能点是个区，
 * 这种是面向功能相关性弱的方式展示"）。
 *
 * 做法：根的每个直接子节点（功能点）= 一个区；**区内部**复用整树布局（LR），
 * 再把区按目标列高打包成多列。于是画布的长宽都不受"叶节点总数"单边支配 ——
 * 整树模式下 33 个叶节点会拉出一条 5000px 宽的带子，分区模式下每个区各占一小块。
 *
 * 标题条承担原来那个功能点节点的职责（名字 + 总/已完成 + 状态色），因此**不再重复画它**；
 * 功能点本身没有子节点时（罕见），就把它当区里唯一的节点画出来（保证还能点选）。
 */
export function layoutZones(
  nodes: readonly NodeView[],
  options: FlowLayoutOptions = {},
): FlowLayout {
  const nodeWidth = options.nodeWidth ?? FLOW_NODE_WIDTH;
  const nodeHeight = options.nodeHeight ?? FLOW_NODE_HEIGHT;
  const gapX = options.gapX ?? FLOW_GAP_X;
  const gapY = options.gapY ?? FLOW_GAP_Y;
  const collapsed = options.collapsed ?? new Set<string>();

  const byId = new Map(nodes.map((node) => [node.id, node]));
  /** 父不在数据集里的节点也算根（与整树布局同一套容错）。 */
  const roots = nodes.filter((node) => node.parentId === null || !byId.has(node.parentId));
  const features: NodeView[] = [];
  for (const root of roots) {
    const children = nodes.filter((node) => node.parentId === root.id);
    if (children.length === 0) {
      // 根下面没有子节点：把根自己当一个区，至少能看见它
      features.push(root);
      continue;
    }
    features.push(...children);
  }

  const titleHeight = 26;
  const pad = 10;
  const placed: PlacedNode[] = [];
  const edgeList: FlowEdge[] = [];
  const zones: FlowZone[] = [];

  /** 先把每个区**单独**排好（相对坐标），再统一打包。 */
  const blocks = features.map((feature) => {
    const members = new Set<string>([feature.id]);
    const stack = [feature.id];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const child of nodes) {
        if (child.parentId !== current || members.has(child.id)) continue;
        members.add(child.id);
        stack.push(child.id);
      }
    }
    const subset = nodes.filter((node) => members.has(node.id));
    const sub = layoutTree(subset, {
      collapsed,
      orientation: 'LR',
      nodeWidth,
      nodeHeight,
      gapX,
      gapY,
    });
    const featureEntry = sub.placed.find((entry) => entry.node.id === feature.id);
    const shiftX = featureEntry === undefined ? 0 : -(featureEntry.x + nodeWidth + gapX);
    // 功能点自己有子节点 → 它退化成区标题（不重复画）；没有子节点 → 画出来（保证可点选）
    const keepFeatureNode = (sub.placed.length === 1 && featureEntry !== undefined) || sub.placed.length === 0;
    const bodyEntries = keepFeatureNode ? sub.placed : sub.placed.filter((entry) => entry.node.id !== feature.id);
    const bodyEdges = sub.edges.filter(
      (edge) => edge.from.node.id !== feature.id && edge.to.node.id !== feature.id,
    );
    const bodyWidth =
      bodyEntries.length === 0
        ? nodeWidth
        : Math.max(...bodyEntries.map((entry) => entry.x + shiftX + nodeWidth)) - Math.min(...bodyEntries.map((entry) => entry.x + shiftX));
    const bodyHeight =
      bodyEntries.length === 0
        ? nodeHeight
        : Math.max(...bodyEntries.map((entry) => entry.y + nodeHeight)) - Math.min(...bodyEntries.map((entry) => entry.y));
    const minX = bodyEntries.length === 0 ? 0 : Math.min(...bodyEntries.map((entry) => entry.x + shiftX));
    const minY = bodyEntries.length === 0 ? 0 : Math.min(...bodyEntries.map((entry) => entry.y));
    const width = Math.max(nodeWidth, bodyWidth) + pad * 2;
    const height = titleHeight + Math.max(nodeHeight, bodyHeight) + pad * 2;
    return {
      feature,
      bodyEntries: bodyEntries.map((entry) => ({ ...entry, x: entry.x + shiftX - minX, y: entry.y - minY })),
      bodyEdges: bodyEdges.map((edge) => ({
        fromId: edge.from.node.id,
        toId: edge.to.node.id,
      })),
      width,
      height,
      branchIndex: featureEntry?.branchIndex ?? -1,
    };
  });

  /**
   * 打包：按目标列高把区**贪心**填进各列（顺序稳定 = 同一份数据每次一样）。
   * 目标列高按"总面积开方"估，避免 1 列太高或列数太多 —— 两侧都不失控。
   */
  const totalHeight = blocks.reduce((sum, block) => sum + block.height + gapY, 0);
  const columnHeight = options.columnHeight ?? Math.max(460, Math.round(Math.sqrt(totalHeight) * 26));
  let columnX = 0;
  let columnY = 0;
  let columnWidth = 0;
  let canvasHeight = 0;
  for (const block of blocks) {
    if (columnY > 0 && columnY + block.height > columnHeight) {
      // 换一列
      columnX += columnWidth + gapX * 2;
      canvasHeight = Math.max(canvasHeight, columnY);
      columnY = 0;
      columnWidth = 0;
    }
    const zone: FlowZone = {
      feature: block.feature,
      x: columnX,
      y: columnY,
      width: block.width,
      height: block.height,
      titleX: columnX + pad,
      titleY: columnY + 17,
      branchIndex: block.branchIndex,
    };
    zones.push(zone);
    const offsetX = columnX + pad;
    const offsetY = columnY + titleHeight + pad;
    const index = new Map<string, PlacedNode>();
    for (const entry of block.bodyEntries) {
      const moved: PlacedNode = { ...entry, x: entry.x + offsetX, y: entry.y + offsetY };
      placed.push(moved);
      index.set(moved.node.id, moved);
    }
    for (const edge of block.bodyEdges) {
      const from = index.get(edge.fromId);
      const to = index.get(edge.toId);
      if (from !== undefined && to !== undefined) edgeList.push({ from, to });
    }
    columnY += block.height + gapY;
    columnWidth = Math.max(columnWidth, block.width);
    canvasHeight = Math.max(canvasHeight, columnY);
  }

  return {
    placed,
    edges: edgeList,
    orientation: 'LR',
    mode: 'zones',
    zones,
    width: Math.max(columnX + columnWidth, nodeWidth),
    height: Math.max(canvasHeight, nodeHeight),
    nodeWidth,
    nodeHeight,
    hasFocus: placed.some((entry) => entry.node.focus),
  };
}

/**
 * 计算流程图布局。
 *
 * 输入是看板的**扁平**节点数组（`parentId` 表达父子关系）——
 * 与事实源的口径一致，布局层不引入第二套树结构。
 */
function layoutTree(
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
  /** 兄弟方向上的游标（TB 下是 x、LR 下是 y）与单个节点的占位（含间距）。 */
  let cursor = 0;
  const orientation: FlowOrientation = options.orientation ?? 'LR';
  const span = orientation === 'LR' ? nodeHeight + gapY : nodeWidth + gapX;
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
   * 坐标轴按 `orientation` 决定（用户反馈："流程图由左往右展示是不是面积就不那么大点，现在好大啊"）：
   * - `LR`（默认）：**深度 → x**（根在左、子孙往右），**兄弟 → y**（竖直排开）；
   * - `TB`：深度 → y，兄弟 → x（老版本；节点多时会长成一条又宽又扁的带子）。
   *
   * 为什么默认改成 LR：面板是**窄而高**的侧边栏。TB 下 30 多个叶节点会拉出 5000px 宽的横带，
   * 只能缩到很小才塞得下（用户看到的"好大啊"）；LR 把宽度换成深度（一般 4–6 层），
   * 长边落在**纵向**，正好贴合面板形状。
   *
   * @param cursor 兄弟方向上的游标（TB 下是 x，LR 下是 y）
   * @returns 该子树在兄弟方向上的**中心**
   */
  const walk = (node: NodeView, depth: number, branch: { index: number; label: string }): number => {
    if (visited.has(node.id)) {
      // 数据异常（成环）时按叶子处理，绝不死循环
      const start = cursor;
      cursor += span;
      return start + span / 2;
    }
    visited.add(node.id);
    const children = childrenOf.get(node.id) ?? [];
    const isCollapsed = collapsed.has(node.id);
    const hidden = isCollapsed ? children.length : 0;
    const hiddenDeep = isCollapsed ? countDescendants(node, new Set<string>()) : 0;
    const visible = isCollapsed ? [] : children;

    maxDepth = Math.max(maxDepth, depth);

    let center: number;
    if (visible.length === 0) {
      center = cursor + span / 2;
      cursor += span;
    } else {
      const centers = visible.map((child) => walk(child, depth + 1, branch));
      center = (centers[0]! + centers[centers.length - 1]!) / 2;
    }

    // 深度方向的坐标：TB 看 y，LR 看 x
    const depthPos = depth * (orientation === 'LR' ? nodeWidth + gapX : nodeHeight + gapY);
    const entry: PlacedNode = {
      node,
      x: orientation === 'LR' ? depthPos : center - nodeWidth / 2,
      y: orientation === 'LR' ? center - nodeHeight / 2 : depthPos,
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
    return center;
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

  /**
   * 内容尺寸：**长边跟着"兄弟方向"走**。
   *
   * TB：宽度 = 叶节点数 × 列宽、高度 = 层数 × 行高；
   * LR：宽度 = 层数 × 列宽、高度 = 叶节点数 × 行高。
   * （`leafSpan` 是"可见叶 + 有隐藏子节点的节点"计数；游标 `cursor` 才是精确值，
   *   取两者较大者，免得折叠后尺寸算小、把内容裁掉。）
   */
  const leafSpan = Math.max(1, placed.filter((p) => (childrenOf.get(p.node.id) ?? []).length === 0 || p.hiddenChildren > 0).length);
  const siblingsExtent = Math.max(leafSpan * span, cursor);
  const depthExtent = (maxDepth + 1) * (orientation === 'LR' ? nodeWidth + gapX : nodeHeight + gapY);
  return {
    placed,
    edges,
    orientation,
    mode: 'tree',
    zones: [],
    width: Math.max(orientation === 'LR' ? depthExtent : siblingsExtent, nodeWidth),
    height: Math.max(orientation === 'LR' ? siblingsExtent : depthExtent, nodeHeight),
    nodeWidth,
    nodeHeight,
    // 没有任何关注 ⇒ 渲染端不该把整棵树当"旁枝"调暗（"节点好轻啊，容易看不清"）
    hasFocus: placed.some((entry) => entry.node.focus),
  };
}

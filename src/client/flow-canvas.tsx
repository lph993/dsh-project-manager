/**
 * 流程图渲染（三段式布局的第 ② 段，FR-40/FR-46a）。
 *
 * **为什么自绘 SVG 而不是 React Flow + elkjs**（§5.4 原计划）：
 * 实测这个客户端插件契约里**没有 CSS 管线** —— bundle 是一个 classic script，
 * 平台只把 factory 的 exports 取走，不会加载外部 `.css`；React Flow 的布局与手柄
 * 强依赖它的样式表，硬接就得把 CSS 当字符串内嵌再手动注入 `<head>`。
 * 而本插件需要的图形语义（分层树 + 正交连线 + 状态填充 + 角标 + 折叠 + tooltip）
 * 自绘 SVG 约 300 行即可覆盖，且没有任何第三方运行时负担（combo 会拼进全部 57 个 bundle）。
 * 决策与理由**待登记**进 `立项.md` §5.4a（下一步补；README 的偏差说明已同步）。
 *
 * 视觉编码严格按 §11.2 的**两层编码**：
 * ① 完成态层占**边框线型与边框色**（枝未完成=虚线 + 未完成计数；叶未完成=空心方点；完成=绿实线 + 勾）；
 * ② 状态层只用**填充色 / 角标 / 外发光**，两层互不覆盖。
 */

import React from 'react';

import type { NodeView } from './contract.ts';
import { DERIVED_STATE_COLOR, nodeRowTitle } from './api.ts';
import { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH, layoutFlow, type PlacedNode } from './flow-layout.ts';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

/** 计算状态 → 填充色（浅色调，保证与边框层的语义不冲突）。 */
const STATE_FILL: Record<string, string> = {
  pending: 'transparent',
  // 未映射到的状态由 derivedState 的兜底色处理
};

/** 计算状态 → 状态层角标（第二层，绝不用边框表达）。 */
const STATE_BADGE: Record<string, string> = {
  running: '▶',
  error: '!',
  paused: 'Ⅱ',
  held: '⛔',
  done: '✓',
};

export interface FlowCanvasProps {
  /** 全部节点（扁平，`parentId` 表达父子关系）。 */
  nodes: readonly NodeView[];
  /** 当前选中节点（与未完成列表双向联动）。 */
  selectedId?: string | undefined;
  onSelect: (nodeId: string) => void;
  /** 「只看未完成」过滤（FR-48 的最小实现）。 */
  hideDone?: boolean;
}

/** 把节点名截断到节点框宽度内（不做文本测量，按字符数近似，中文更宽）。 */
function clipLabel(name: string, max = 13): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

export function FlowCanvas(props: FlowCanvasProps): React.ReactElement {
  const { nodes, selectedId, onSelect } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [view, setView] = useState({ tx: 16, ty: 12, k: 1 });
  const [hover, setHover] = useState<{ node: NodeView; x: number; y: number } | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | undefined>(undefined);
  /**
   * 用户是否手动调过视图（缩放/平移）。
   *
   * 只要没手动调过，容器尺寸一变（面板首次布局、窗口缩放）就**重新适应视图**；
   * 手动调过之后不再自动动它 —— 否则每次轮询重渲染都会把用户的视图拽回去。
   */
  const userAdjustedRef = useRef(false);
  const [clipped, setClipped] = useState(false);
  /** 容器实测尺寸（用于"尺寸为 0 → 退化成清单"的诚实提示）。 */
  const [measured, setMeasured] = useState<{ w: number; h: number } | undefined>(undefined);

  const visibleNodes = useMemo(
    () => (props.hideDone === true ? nodes.filter((n) => n.derivedState !== 'done') : nodes),
    [nodes, props.hideDone],
  );

  // `hideDone` 过滤会打断父子链：把父节点补回来（否则子节点会被当成根，布局散架）
  const layered = useMemo(() => {
    if (props.hideDone !== true) return visibleNodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const keep = new Map<string, NodeView>();
    for (const node of visibleNodes) {
      keep.set(node.id, node);
      let parentId = node.parentId;
      const guard = new Set<string>();
      while (parentId !== null && !guard.has(parentId)) {
        guard.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        if (!keep.has(parent.id)) keep.set(parent.id, parent);
        parentId = parent.parentId;
      }
    }
    return [...keep.values()];
  }, [nodes, visibleNodes, props.hideDone]);

  const layout = useMemo(() => layoutFlow(layered, { collapsed }), [layered, collapsed]);

  /**
   * 适应视图。
   *
   * **关键修复（实测"面板空白"）**：原来把缩放下限钳在 0.2，21 个节点的树宽 3528px，
   * 在几百像素宽的面板里根本装不下；再叠加"首次测量拿到 0 尺寸就直接放弃"，
   * 视图就落到了画布外 —— 于是看起来是**一片空白**。现在的规则：
   * ① 尺寸为 0 时**不**标记"已适应"，等 ResizeObserver 报出真实尺寸再来；
   * ② 缩放下限放宽到 0.12（装得下就装）；
   * ③ 若仍装不下，就**以根节点为锚**居中（保证第一屏一定能看到树的顶部），
   *    而不是把整棵树的几何中心对齐面板中心（那会把根推到屏幕外）。
   */
  const fit = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const pad = 24;
    const availW = Math.max(rect.width - pad * 2, 40);
    const availH = Math.max(rect.height - pad * 2, 40);
    /**
     * 缩放下限取 0.5 而不是"能装多小就多小"：21 个节点的树宽 3528px，
     * 硬塞进 976px 会得到 0.26 的缩放 —— 节点只有 44×15px，等于看不清（实测量到过）。
     * 装不下就让图比视口宽，并按根节点锚定 + 提示可拖拽浏览。
     */
    const k = Math.min(
      1.2,
      Math.max(0.5, Math.min(availW / Math.max(layout.width, 1), availH / Math.max(layout.height, 1))),
    );
    const fits = layout.width * k <= availW + 1;
    // 装不下时以**根节点**（没有根就用最靠上的节点）为锚，保证顶部可见
    const anchor =
      layout.placed.find((p) => p.node.parentId === null) ??
      layout.placed.reduce<PlacedNode | undefined>(
        (best, p) => (best === undefined || p.y < best.y ? p : best),
        undefined,
      );
    const anchorX = anchor === undefined ? layout.width / 2 : anchor.x + layout.nodeWidth / 2;
    setView({
      k,
      tx: fits ? (rect.width - layout.width * k) / 2 : rect.width / 2 - anchorX * k,
      ty: pad,
    });
    setClipped(!fits);
    return true;
  }, [layout.width, layout.height, layout.placed, layout.nodeWidth]);

  /**
   * 真实尺寸就位 / 窗口变化时：① 记录容器尺寸（用于"尺寸为 0"的退化提示）
   * ② 自动适应视图（用户手动调过之后就不打扰）。
   *
   * 用 ResizeObserver 而不是"挂载时量一次"：面板可能先被 mount 在 0 尺寸容器里
   * （隐藏/尚未布局），一次性测量会把"暂时量不到"误判成"容器没有高度"，
   * 于是永久退化成清单、画布再也不出现（实测踩过：`canvas: null`）。
   */
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) {
      setMeasured({ w: 0, h: 0 });
      return undefined;
    }
    const apply = (): void => {
      const rect = element.getBoundingClientRect();
      setMeasured({ w: Math.round(rect.width), h: Math.round(rect.height) });
      if (userAdjustedRef.current) return;
      if (rect.width < 4 || rect.height < 4) return;
      fit();
    };
    apply();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => apply());
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [fit, layout.placed.length]);

  // 滚轮缩放必须用**非 passive** 的原生监听：React 的 onWheel 在部分浏览器里是 passive 的，
  // 那样 preventDefault() 无效，页面会跟着滚。
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      userAdjustedRef.current = true;
      const rect = svg.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((prev) => {
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const k = Math.min(2.5, Math.max(0.5, prev.k * factor));
        const ratio = k / prev.k;
        return { k, tx: px - (px - prev.tx) * ratio, ty: py - (py - prev.ty) * ratio };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    userAdjustedRef.current = true;
    setView((prev) => ({
      ...prev,
      tx: drag.tx + (event.clientX - drag.x),
      ty: drag.ty + (event.clientY - drag.y),
    }));
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    dragRef.current = undefined;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放：忽略
    }
  };

  const toggleCollapse = (nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const showHover = (node: NodeView, event: React.MouseEvent<SVGGElement>): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ node, x: event.clientX - rect.left + 12, y: event.clientY - rect.top + 12 });
  };

  /**
   * 退化提示：容器**确实**量不到尺寸（宽/高 < 4px）时才走这里。
   *
   * 为什么留着：真遇到宿主布局把面板塞进 0 高度容器时，与其给用户一片空白，
   * 不如明说原因并给一份任务清单。判断依据是 ResizeObserver 的**实测值**，
   * 而不是"挂载那一刻量到 0"（那可能只是还没布局完）。
   */
  if (measured !== undefined && (measured.w < 4 || measured.h < 4)) {
    return (
      <div style={styles.wrap} ref={wrapRef}>
        <div style={{ padding: '12px 16px', fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>画布容器尺寸为 0，无法绘制流程图</div>
          <div style={{ opacity: 0.75 }}>
            {`这是宿主布局问题（面板被放进了没有高度的容器，实测 ${measured.w}×${measured.h}）。`}
            已退化为任务清单；节点数据本身是好的。
          </div>
          <ul style={{ margin: '8px 0 0 16px', padding: 0, maxHeight: 320, overflow: 'auto' }}>
            {layered.map((node) => (
              <li key={node.id} style={{ opacity: node.derivedState === 'done' ? 0.5 : 1 }}>
                {node.name}
                <span style={{ opacity: 0.6 }}>
                  {' '}
                  · {node.derivedState === 'done' ? '已完成' : '未完成'}
                  {node.childCount > 0 ? ` · 未完成 ${node.unfinishedLeafCount}/${node.leafCount}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (layout.placed.length === 0) {
    return (
      <div style={styles.wrap} ref={wrapRef}>
        <div style={styles.placeholder}>还没有节点：先「扫描工作区」建一棵草稿树。</div>
      </div>
    );
  }

  return (
    <div style={styles.wrap} ref={wrapRef}>
      <svg
        ref={svgRef}
        style={styles.svg}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          {/* 连线先画：虚线在主枝节点**下层**（FR-45），永不遮挡节点 */}
          <g>
            {layout.edges.map((edge) => {
              const x1 = edge.from.x + layout.nodeWidth / 2;
              const y1 = edge.from.y + layout.nodeHeight;
              const x2 = edge.to.x + layout.nodeWidth / 2;
              const y2 = edge.to.y;
              const midY = (y1 + y2) / 2;
              const dashed = !edge.to.inFocusBranch;
              return (
                <path
                  key={`${edge.from.node.id}->${edge.to.node.id}`}
                  d={`M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`}
                  fill="none"
                  stroke="var(--dsw-alias-border-l2, rgba(128,128,128,0.55))"
                  strokeWidth={dashed ? 1 : 1.4}
                  strokeDasharray={dashed ? '4 3' : undefined}
                  opacity={dashed ? 0.7 : 1}
                />
              );
            })}
          </g>

          {layout.placed.map((placed) => (
            <FlowNode
              key={placed.node.id}
              placed={placed}
              nodeWidth={layout.nodeWidth}
              nodeHeight={layout.nodeHeight}
              selected={selectedId === placed.node.id}
              collapsed={collapsed.has(placed.node.id)}
              onSelect={onSelect}
              onToggleCollapse={toggleCollapse}
              onHover={showHover}
              onLeave={() => setHover(undefined)}
            />
          ))}
        </g>
      </svg>

      <div style={styles.toolbar}>
        <button
          type="button"
          style={styles.toolButton}
          onClick={() => {
            userAdjustedRef.current = true;
            setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.15) }));
          }}
        >
          放大
        </button>
        <button
          type="button"
          style={styles.toolButton}
          onClick={() => {
            userAdjustedRef.current = true;
            setView((v) => ({ ...v, k: Math.max(0.5, v.k / 1.15) }));
          }}
        >
          缩小
        </button>
        <button
          type="button"
          style={styles.toolButton}
          onClick={() => {
            userAdjustedRef.current = false;
            fit();
          }}
        >
          适应视图
        </button>
        <span style={styles.toolHint}>
          {layout.placed.length} 个节点 · 滚轮缩放 / 拖拽平移 / 点圆点折叠
          {clipped ? ' · 图较宽：已对准根节点，可拖拽浏览' : ''}
        </span>
      </div>

      {hover ? (
        <div style={{ ...styles.tooltip, left: hover.x, top: hover.y }}>
          <div style={styles.tooltipTitle}>{hover.node.name}</div>
          <div style={styles.tooltipBody}>{nodeRowTitle(hover.node)}</div>
        </div>
      ) : null}
    </div>
  );
}

interface FlowNodeProps {
  placed: PlacedNode;
  nodeWidth: number;
  nodeHeight: number;
  selected: boolean;
  collapsed: boolean;
  onSelect: (nodeId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  onHover: (node: NodeView, event: React.MouseEvent<SVGGElement>) => void;
  onLeave: () => void;
}

/** 单个节点：两层编码的落点（第一层=边框，第二层=填充/角标/外发光）。 */
function FlowNode(props: FlowNodeProps): React.ReactElement {
  const { placed, nodeWidth, nodeHeight } = props;
  const node = placed.node;
  const isLeaf = node.childCount === 0;
  const done = node.derivedState === 'done';
  const stateColor = DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2';
  const fill = done ? 'rgba(34,197,94,0.14)' : (STATE_FILL[node.derivedState] ?? `${hexToRgba(stateColor, 0.14)}`);
  const borderColor = done ? '#22c55e' : stateColor;
  const badge = STATE_BADGE[node.derivedState];

  const innerWidth = nodeWidth - 20;
  const progressWidth = Math.max(0, Math.min(1, node.progress)) * innerWidth;

  return (
    <g
      transform={`translate(${placed.x} ${placed.y})`}
      style={{
        cursor: 'pointer',
        opacity: placed.inFocusBranch ? 1 : 0.58,
        filter: node.focus
          ? 'drop-shadow(0 0 5px rgba(59,130,246,0.9))'
          : props.selected
            ? 'drop-shadow(0 0 4px rgba(148,163,184,0.9))'
            : undefined,
      }}
      onClick={() => props.onSelect(node.id)}
      onMouseMove={(event) => props.onHover(node, event)}
      onMouseLeave={props.onLeave}
    >
      <title>{nodeRowTitle(node)}</title>
      {/* 第一层：边框线型 + 边框色（未完成的枝=虚线；完成=绿实线） */}
      <rect
        width={nodeWidth}
        height={nodeHeight}
        rx={7}
        fill={fill}
        stroke={props.selected ? '#2563eb' : borderColor}
        strokeWidth={props.selected ? 2 : 1.2}
        strokeDasharray={isLeaf ? undefined : done ? undefined : '5 3'}
      />
      {/* 状态层：running 的枝/叶统一高亮（FR-42 枝级传播已由派生状态给出） */}
      {node.derivedState === 'running' ? (
        <rect width={nodeWidth} height={nodeHeight} rx={7} fill={`${hexToRgba('#3b82f6', 0.12)}`} stroke="none" />
      ) : null}

      <text x={10} y={18} fontSize={11.5} fontWeight={600} fill="var(--dsw-alias-text-primary, #111)">
        {clipLabel(node.name, isLeaf ? 14 : 12)}
      </text>

      {/* 第二层：角标（关注/中途新增/自动/回滚/状态） */}
      <text x={nodeWidth - 8} y={14} fontSize={10} textAnchor="end" fill={borderColor}>
        {[
          node.focus ? '◆' : '',
          badge ?? '',
          node.addedMidway ? '+' : '',
          node.autoCreated ? 'A' : '',
          node.flags.includes('rolledBack') ? '↺' : '',
        ]
          .filter((token) => token !== '')
          .join(' ')}
      </text>

      {/* 进度条（两层之外的信息：进度百分比本身） */}
      <rect x={10} y={nodeHeight - 22} width={innerWidth} height={5} rx={2.5} fill="rgba(128,128,128,0.22)" />
      <rect x={10} y={nodeHeight - 22} width={progressWidth} height={5} rx={2.5} fill={done ? '#22c55e' : stateColor} />

      {/* 计数/百分比文案：枝给"未完成 x/y"，叶给百分比（FR-31/FR-46a） */}
      <text x={10} y={nodeHeight - 7} fontSize={9.5} fill="var(--dsw-alias-text-secondary, #555)">
        {isLeaf
          ? `${Math.round(node.progress * 100)}%`
          : `未完成 ${node.unfinishedLeafCount}/${node.leafCount}`}
      </text>

      {/* 叶节点未完成 → 右下角空心方点（第一层的"待办单元"标记） */}
      {isLeaf && !done ? (
        <rect
          x={nodeWidth - 13}
          y={nodeHeight - 11}
          width={6}
          height={6}
          fill="none"
          stroke={stateColor}
          strokeWidth={1.2}
        />
      ) : null}

      {/* 折叠/展开（FR-47）：有子节点才显示 */}
      {node.childCount > 0 ? (
        <g
          transform={`translate(${nodeWidth / 2} ${nodeHeight})`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleCollapse(node.id);
          }}
        >
          <circle r={7} fill="var(--dsw-alias-bg-primary, #fff)" stroke={borderColor} strokeWidth={1} />
          <text y={3.5} fontSize={9} textAnchor="middle" fill={borderColor}>
            {props.collapsed ? '▸' : '▾'}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** `#rrggbb` → `rgba(...)`（状态色来自 `api.ts` 的固定表，一定是 6 位十六进制）。 */
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const styles = {
  wrap: {
    position: 'relative' as const,
    flex: '1 1 auto',
    // 面板容器不一定是定高 flex：给一个兜底高度，避免画布被压成 0 像素（那就是"空白"）
    minHeight: 280,
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    overflow: 'hidden',
    background:
      'radial-gradient(circle at 1px 1px, rgba(128,128,128,0.18) 1px, transparent 0) 0 0 / 22px 22px',
  },
  svg: { width: '100%', height: '100%', display: 'block', touchAction: 'none' as const },
  placeholder: { padding: 24, fontSize: 12, opacity: 0.7, textAlign: 'center' as const },
  toolbar: {
    position: 'absolute' as const,
    right: 8,
    top: 8,
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    background: 'var(--dsw-alias-bg-primary, rgba(255,255,255,0.86))',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))',
    borderRadius: 6,
    padding: '4px 6px',
  },
  toolButton: {
    fontSize: 11,
    padding: '2px 7px',
    borderRadius: 4,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  toolHint: { fontSize: 10, opacity: 0.6, marginLeft: 2 },
  tooltip: {
    position: 'absolute' as const,
    maxWidth: 320,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'var(--dsw-alias-bg-primary, rgba(20,20,20,0.92))',
    color: 'var(--dsw-alias-text-primary, #fff)',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))',
    fontSize: 11,
    lineHeight: 1.5,
    pointerEvents: 'none' as const,
    whiteSpace: 'pre-line' as const,
    zIndex: 5,
  },
  tooltipTitle: { fontWeight: 600, marginBottom: 2 },
  tooltipBody: { opacity: 0.85, fontSize: 10.5 },
};

export { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH };


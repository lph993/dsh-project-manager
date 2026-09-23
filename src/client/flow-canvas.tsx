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
import { DERIVED_STATE_COLOR, nodeRowTitle, type PanelNodeAction } from './api.ts';
import { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH, layoutFlow, type PlacedNode } from './flow-layout.ts';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

/** 计算状态 → 状态层角标（第二层，绝不用边框表达）。 */
const STATE_BADGE: Record<string, string> = {
  running: '▶',
  error: '!',
  paused: 'Ⅱ',
  held: '⛔',
  done: '✓',
};

/**
 * 主题相关的调色板。
 *
 * **为什么要在运行时判断明暗**：面板拿不到"当前主题"这个事实（主题由 shell 用 CSS 变量切换，
 * 而且用户可以把 GUI 主题钉死在 dark，与 `prefers-color-scheme` 不一致）。
 * 可靠的做法是**读实际生效的文本色**：深色主题给浅色文字、浅色主题给深色文字 ——
 * 用它的亮度反推主题，比猜变量名稳。
 *
 * 实测踩过的坑：早先把节点文字写成 `var(--dsw-alias-text-primary, #111)`，
 * 变量拿不到时回落到近黑色 → 暗主题下就是"深灰底上的黑字"，等于看不清。
 */
interface FlowPalette {
  dark: boolean;
  /** 节点主文字（用 `currentColor` 之外单独给，便于控制透明度）。 */
  text: string;
  textMuted: string;
  /** 状态填充的透明度（暗色下要更实一点才看得见）。 */
  fillAlpha: number;
  /** 进度条底槽。 */
  track: string;
  /** 网格点。 */
  grid: string;
  /** 默认边框（未完成态）。 */
  edge: string;
  /** 连线色。 */
  link: string;
  /** 画布底色（tooltip/工具栏底）。 */
  surface: string;
}

const LIGHT_PALETTE: FlowPalette = {
  dark: false,
  text: 'currentColor',
  textMuted: 'rgba(0,0,0,0.55)',
  fillAlpha: 0.16,
  track: 'rgba(0,0,0,0.12)',
  grid: 'rgba(0,0,0,0.10)',
  edge: 'rgba(0,0,0,0.35)',
  link: 'rgba(0,0,0,0.35)',
  surface: 'rgba(255,255,255,0.92)',
};

const DARK_PALETTE: FlowPalette = {
  dark: true,
  text: 'currentColor',
  textMuted: 'rgba(255,255,255,0.65)',
  fillAlpha: 0.34,
  track: 'rgba(255,255,255,0.22)',
  grid: 'rgba(255,255,255,0.14)',
  edge: 'rgba(255,255,255,0.45)',
  link: 'rgba(255,255,255,0.40)',
  surface: 'rgba(28,28,32,0.94)',
};

/** `rgb()/rgba()` 字符串 → 相对亮度（拿不到就返回 undefined）。 */
function relativeLuminance(color: string): number | undefined {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (!match) return undefined;
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map((value) => Number(value) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * 判断当前是深色主题：读**实际生效的文本色**亮度（浅字=深色主题）。
 *
 * 同时监听两件事，主题切换后无需刷新：`documentElement` 的属性/class 变化
 * 与 `prefers-color-scheme` 变化。
 */
function useIsDarkTheme(ref: React.RefObject<HTMLElement | null>): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = (): void => {
      const element = ref.current;
      if (element === null || typeof window === 'undefined') return;
      const color = window.getComputedStyle(element).color;
      const luminance = relativeLuminance(color);
      if (luminance !== undefined) setDark(luminance > 0.55);
    };
    read();
    const media =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : undefined;
    media?.addEventListener?.('change', read);
    const observer =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(read);
    if (typeof document !== 'undefined') {
      observer?.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      });
    }
    return () => {
      media?.removeEventListener?.('change', read);
      observer?.disconnect();
    };
  }, [ref]);
  return dark;
}

export interface FlowCanvasProps {
  /** 全部节点（扁平，`parentId` 表达父子关系）。 */
  nodes: readonly NodeView[];
  /** 当前选中节点（与未完成列表双向联动）。 */
  selectedId?: string | undefined;
  onSelect: (nodeId: string) => void;
  /** 「只看未完成」过滤（FR-48 的最小实现）。 */
  hideDone?: boolean;
  /**
   * 右键菜单动作（FR-6.6）。面板负责确认与调用宿主；画布只负责"在哪儿点了什么"。
   *
   * 不给这个回调时（例如自检里）画布不显示右键菜单 —— 保持组件可独立渲染。
   */
  onAction?: (action: PanelNodeAction | 'remove', nodeId: string) => void;
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
  const palette = useIsDarkTheme(wrapRef) ? DARK_PALETTE : LIGHT_PALETTE;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<
    { x: number; y: number; tx: number; ty: number; moved: boolean } | undefined
  >(undefined);
  /** 拖拽过 → 抑制随后那次 click（否则拖完会顺手选中落点上的节点）。 */
  const dragMovedRef = useRef(false);
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
   * 视图就落到了画布外 —— 于是看起来是**一片空白**。
   *
   * **第二轮修正（实测"节点太小看不清"）**：宽度优先的适配会把一棵"宽而浅"的树压到
   * 0.26 倍（节点只有 44×15px，等于看不清）。所以改成**高度优先**：
   * 缩放取"能装下整棵树高度"的值（上限 1.2、下限 0.6），宽度装不下就让图比视口宽，
   * 按根节点锚定 + 提示"可拖拽浏览" —— 宁可横向拖，也不要把字缩到看不见。
   */
  const fit = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    const pad = 24;
    const availW = Math.max(rect.width - pad * 2, 40);
    const availH = Math.max(rect.height - pad * 2, 40);
    const fitByHeight = availH / Math.max(layout.height, 1);
    const fitByWidth = availW / Math.max(layout.width, 1);
    // 两者都能装下时才按宽度缩小；否则保可读性（高度优先，下限 0.6）
    const k = Math.min(
      1.2,
      Math.max(0.6, fitByWidth >= fitByHeight ? Math.min(fitByWidth, fitByHeight) : fitByHeight),
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
    /**
     * **必须 preventDefault**：否则拖拽会走浏览器的原生"选中文字/拖拽"路径，
     * 鼠标划过节点标签时就把文字选蓝了（实测反馈）。
     */
    event.preventDefault();
    dragRef.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // 超过阈值才算"拖拽"：这样"点一下节点"不会被几像素的手抖吃掉
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      drag.moved = true;
      // 拖拽期间抑制随之而来的 click（否则拖完会顺手选中落点上的节点）
      dragMovedRef.current = true;
      userAdjustedRef.current = true;
    }
    if (!drag.moved) return;
    setView((prev) => ({ ...prev, tx: drag.tx + dx, ty: drag.ty + dy }));
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (drag?.moved !== true) dragMovedRef.current = false;
    // 下一次 pointerdown 会重置；这里再垫一个微任务清理，避免 click 已经派发完
    window.setTimeout(() => {
      dragMovedRef.current = false;
    }, 0);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放：忽略
    }
  };

  /** 选中回调（拖拽结束的那一次 click 忽略掉）。 */
  const selectUnlessDragged = useCallback(
    (nodeId: string) => {
      if (dragMovedRef.current) return;
      onSelect(nodeId);
    },
    [onSelect],
  );

  /** 右键菜单状态：在哪个节点、屏幕坐标。 */
  const [menu, setMenu] = useState<{ node: NodeView; x: number; y: number } | undefined>(undefined);

  const openMenu = useCallback(
    (node: NodeView, event: React.MouseEvent<SVGGElement>) => {
      if (props.onAction === undefined) return;
      event.preventDefault();
      const rect = wrapRef.current?.getBoundingClientRect();
      setMenu({
        node,
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      });
    },
    [props],
  );

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
    <div
      style={{
        ...styles.wrap,
        background: `radial-gradient(circle at 1px 1px, ${palette.grid} 1px, transparent 0) 0 0 / 22px 22px`,
      }}
      ref={wrapRef}
    >
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
                  stroke={palette.link}
                  strokeWidth={dashed ? 1.2 : 1.6}
                  strokeDasharray={dashed ? '4 3' : undefined}
                  opacity={dashed ? 0.75 : 1}
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
              palette={palette}
              onSelect={selectUnlessDragged}
              onOpenMenu={openMenu}
              onToggleCollapse={toggleCollapse}
              onHover={showHover}
              onLeave={() => setHover(undefined)}
            />
          ))}
        </g>
      </svg>

      <div style={{ ...styles.toolbar, background: palette.surface, color: palette.text }}>
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
      </div>

      {/*
        提示行单独放在左下角，且 `pointer-events: none`。
        早先它和按钮同排，把工具栏撑到 538px 宽 —— 于是画布右上那一条被工具栏盖住，
        右键/点击/拖拽都落不到节点上（实测：右键事件目标是工具栏 DIV，不是节点）。
      */}
      <div style={{ ...styles.toolHint, color: palette.textMuted }}>
        {layout.placed.length} 个节点 · 滚轮缩放 / 拖拽平移 / 右键菜单 / 点圆点折叠
        {clipped ? ' · 图较宽：已对准根节点，可拖拽浏览' : ''}
      </div>

      {hover ? (
        <div
          style={{
            ...styles.tooltip,
            left: hover.x,
            top: hover.y,
            background: palette.surface,
            color: palette.text,
            border: `0.5px solid ${palette.edge}`,
          }}
        >
          <div style={styles.tooltipTitle}>{hover.node.name}</div>
          <div style={styles.tooltipBody}>{nodeRowTitle(hover.node)}</div>
        </div>
      ) : null}

      {/* 右键菜单（FR-6.6）：只在给了 onAction 时出现，动作本身由面板执行 */}
      {menu !== undefined && props.onAction !== undefined
        ? React.createElement(
            React.Fragment,
            null,
            // 点任意空白处关掉菜单
            React.createElement('div', {
              style: { position: 'absolute' as const, inset: 0, zIndex: 8 },
              onClick: () => setMenu(undefined),
              onContextMenu: (event: React.MouseEvent) => {
                event.preventDefault();
                setMenu(undefined);
              },
            }),
            React.createElement(
              'div',
              {
                style: {
                  position: 'absolute' as const,
                  left: Math.min(menu.x, Math.max(0, (measured?.w ?? 400) - 170)),
                  top: Math.min(menu.y, Math.max(0, (measured?.h ?? 300) - 240)),
                  zIndex: 9,
                  background: palette.surface,
                  color: palette.text,
                  border: `0.5px solid ${palette.edge}`,
                  borderRadius: 6,
                  padding: '4px 0',
                  minWidth: 160,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.28)',
                  fontSize: 12,
                },
              },
              React.createElement('div', { style: styles.menuTitle }, clipLabel(menu.node.name, 18)),
              ...menuItems(menu.node).map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.action,
                    type: 'button',
                    style: {
                      ...styles.menuItem,
                      opacity: item.disabled === true ? 0.4 : 1,
                      cursor: item.disabled === true ? 'not-allowed' : 'pointer',
                    },
                    disabled: item.disabled === true,
                    onClick: () => {
                      setMenu(undefined);
                      if (item.disabled !== true) props.onAction?.(item.action, menu.node.id);
                    },
                  },
                  item.label,
                ),
              ),
            ),
          )
        : null}
    </div>
  );
}

/** 菜单项（按 §6.6 的清单，作用于父/叶各有取舍）。 */
function menuItems(
  node: NodeView,
): Array<{ action: PanelNodeAction | 'remove'; label: string; disabled?: boolean }> {
  const isLeaf = node.childCount === 0;
  const gated = node.gate !== null;
  return [
    { action: node.focus ? 'unfocus' : 'focus', label: node.focus ? '取消关注' : '关注（整枝）' },
    { action: 'add-child', label: '添加子节点…' },
    { action: 'rename', label: '修改名称…' },
    { action: 'describe', label: '补充描述…' },
    // 暂停/继续只对叶任务有意义（父节点的"暂停"就是拦停）
    { action: 'pause', label: '暂停…（生成交接文档）', disabled: !isLeaf || gated },
    { action: 'resume', label: '继续（消费交接文档）', disabled: !gated },
    { action: 'hold', label: '拦停整枝…（仅父节点）', disabled: isLeaf || gated },
    { action: 'release', label: '放行整枝（仅父节点）', disabled: isLeaf || !gated },
    { action: 'snapshot', label: '打一个回滚点…' },
    // 删除走的是另一条带三方案确认的路径（`/pm/branch/remove`），所以单独列一项
    { action: 'remove', label: '删除整枝…' },
  ];
}

interface FlowNodeProps {
  placed: PlacedNode;
  nodeWidth: number;
  nodeHeight: number;
  selected: boolean;
  collapsed: boolean;
  /// 主题调色板（暗色下填充更实、底槽更亮，否则"看不清"）
  palette: FlowPalette;
  onSelect: (nodeId: string) => void;
  /** 右键 → 面板菜单（未提供时不响应右键）。 */
  onOpenMenu: (node: NodeView, event: React.MouseEvent<SVGGElement>) => void;
  onToggleCollapse: (nodeId: string) => void;
  onHover: (node: NodeView, event: React.MouseEvent<SVGGElement>) => void;
  onLeave: () => void;
}

/** 单个节点：两层编码的落点（第一层=边框，第二层=填充/角标/外发光）。 */
function FlowNode(props: FlowNodeProps): React.ReactElement {
  const { placed, nodeWidth, nodeHeight, palette } = props;
  const node = placed.node;
  const isLeaf = node.childCount === 0;
  const done = node.derivedState === 'done';
  const stateColor = DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2';
  // 填充透明度随主题变化：暗色下 0.16 几乎看不见，用 0.34
  const fill = hexToRgba(done ? '#22c55e' : stateColor, palette.fillAlpha);
  const borderColor = done ? '#22c55e' : stateColor;
  const badge = STATE_BADGE[node.derivedState];

  const innerWidth = nodeWidth - 20;
  const progressWidth = Math.max(0, Math.min(1, node.progress)) * innerWidth;

  return (
    <g
      transform={`translate(${placed.x} ${placed.y})`}
      style={{
        cursor: 'pointer',
        opacity: placed.inFocusBranch ? 1 : palette.dark ? 0.68 : 0.58,
        filter: node.focus
          ? 'drop-shadow(0 0 5px rgba(59,130,246,0.9))'
          : props.selected
            ? 'drop-shadow(0 0 4px rgba(148,163,184,0.9))'
            : undefined,
      }}
      onClick={() => props.onSelect(node.id)}
      onContextMenu={(event) => props.onOpenMenu(node, event)}
      onMouseMove={(event) => props.onHover(node, event)}
      onMouseLeave={props.onLeave}
    >
      <title>{nodeRowTitle(node)}</title>
      {/* 第一层：边框线型 + 边框色（未完成的枝=虚线；完成=绿实线） */}
      <rect
        width={nodeWidth}
        height={nodeHeight}
        rx={7}
        fill={done || node.derivedState !== 'pending' ? fill : palette.dark ? 'rgba(255,255,255,0.06)' : 'transparent'}
        stroke={props.selected ? '#2563eb' : borderColor}
        strokeWidth={props.selected ? 2 : 1.4}
        strokeDasharray={isLeaf ? undefined : done ? undefined : '5 3'}
      />

      <text x={10} y={18} fontSize={11.5} fontWeight={600} fill={palette.text}>
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
      <rect x={10} y={nodeHeight - 22} width={innerWidth} height={5} rx={2.5} fill={palette.track} />
      <rect x={10} y={nodeHeight - 22} width={progressWidth} height={5} rx={2.5} fill={done ? '#22c55e' : stateColor} />

      {/* 计数/百分比文案：枝给"未完成 x/y"，叶给百分比（FR-31/FR-46a） */}
      <text x={10} y={nodeHeight - 7} fontSize={9.5} fill={palette.textMuted}>
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
          <circle r={7} fill={palette.surface} stroke={borderColor} strokeWidth={1} />
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
    // 拖拽时不许选中文字（SVG 的 <text> 默认可选，划过就整片选蓝）
    userSelect: 'none' as const,
    WebkitUserSelect: 'none' as const,
    cursor: 'grab' as const,
    background:
      'radial-gradient(circle at 1px 1px, rgba(128,128,128,0.18) 1px, transparent 0) 0 0 / 22px 22px',
  },
  svg: {
    width: '100%',
    height: '100%',
    display: 'block',
    touchAction: 'none' as const,
    /**
     * 拖拽画布时**不许选中文字**：SVG 里的 `<text>` 默认可选，
     * 鼠标划过就整片选蓝（实测反馈）。这里连同 `onPointerDown` 的 preventDefault 一起兜住。
     */
    userSelect: 'none' as const,
    WebkitUserSelect: 'none' as const,
  },
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
  toolHint: {
    position: 'absolute' as const,
    left: 8,
    bottom: 6,
    fontSize: 10,
    opacity: 0.75,
    // 提示行绝不拦截鼠标：画布上的点击/右键/拖拽都要落到底下的节点上
    pointerEvents: 'none' as const,
  },
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
  menuTitle: {
    padding: '3px 10px 5px',
    fontSize: 11,
    fontWeight: 600,
    borderBottom: '0.5px solid rgba(128,128,128,0.35)',
    marginBottom: 3,
  },
  menuItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '4px 10px',
    fontSize: 12,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
  },
};

export { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH };





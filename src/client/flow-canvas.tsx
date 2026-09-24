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
 * ① 完成态层占**边框线型与边框色**（枝未完成=虚线、叶未完成=空心方点、完成=绿实线 + 勾）；
 *    节点里的数字给「**总 / 已完成**」（枝）或自身百分比（叶）—— 口径见 `client/labels.ts`，
 *    刻意**不以"还剩多少未完成"为主**（用户纠偏：项目宗旨是进度为主）。
 * ② 状态层只用**填充色 / 角标 / 外发光**，两层互不覆盖。
 */

import React from 'react';

import type { NodeView } from './contract.ts';
import { DERIVED_STATE_COLOR, nodeRowLabel, nodeRowTitle, type PanelNodeAction } from './api.ts';
import { nodeCountLabel } from './labels.ts';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  layoutFlow,
  type FlowLayout,
  type PlacedNode,
} from './flow-layout.ts';
import { buildFoldTree, foldToggle, hiddenBelow } from './fold.ts';

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
 * 顶层枝配色（每条枝一个颜色，配枝标签一起用）。
 *
 * 选取原则：中明度、彼此区分度够、在明暗两种主题下都能看清（不依赖主题背景色）。
 * 枝色只画在节点**内部左侧的色条**与枝标签上 —— 节点边框仍然只表达"完成态"（§11.2 两层编码）。
 */
const BRANCH_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#ef4444',
  '#84cc16',
  '#a855f7',
  '#14b8a6',
];

/** 取某条枝的颜色（越界按取模，保证同一条枝永远同色）。 */
function branchColor(index: number): string {
  if (index < 0) return '#94a3b8';
  return BRANCH_COLORS[index % BRANCH_COLORS.length]!;
}

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
   * 折叠状态的持久化作用域（传项目的 `projectId`）。
   *
   * 折叠是**看图的视图状态**，不是项目数据 —— 不该写回事实源（那会污染审计与并发版本），
   * 但换个会话再看同一棵树时用户不想重新折一遍，所以存在浏览器本地，按项目分开。
   * 不传 = 不持久化（自检里的独立渲染走这条）。
   */
  projectId?: string | undefined;
  /**
   * 右键菜单动作（FR-6.6）。面板负责确认与调用宿主；画布只负责"在哪儿点了什么"。
   *
   * 不给这个回调时（例如自检里）画布不显示右键菜单 —— 保持组件可独立渲染。
   */
  onAction?: (action: PanelNodeAction | 'remove' | 'rollback' | 'branch-rollback', nodeId: string) => void;
  /**
   * 某节点有几个可用回滚点（来自看板快照的 `rollbackPoints`）。
   *
   * 菜单要**同步**决定「回滚」显不显示（FR：没有回滚点就不显示，而不是置灰）。
   */
  rollbackPoints?: ((nodeId: string) => number) | undefined;
  /**
   * 节点旁的输入/确认浮层。
   *
   * **为什么放在画布内**：早先把确认框与输入框渲染在面板顶部的标题区，
   * 于是用户右键节点后还要**自己去找**那个框（实测反馈："跳到了标题那里，我还要找它"）。
   * 浮层挂在被操作的节点旁边才符合直觉，也不会把视线拉走。
   */
  overlay?: FlowOverlay | undefined;
  /** 文本浮层的当前输入值。 */
  overlayText?: string | undefined;
  onOverlayTextChange?: (value: string) => void;
  /** 提交（文本浮层带上输入值；确认浮层忽略该参数）。 */
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  /** 回滚浮层的选择变化（回滚点 / 范围 / 是否连带还原共享文件）。 */
  onRollbackChoice?: (choice: RollbackChoice) => void;
}

/** 节点旁浮层的两种形态。 */
export type FlowOverlay =
  | { kind: 'text'; nodeId: string; title: string }
  | { kind: 'confirm'; nodeId: string; title: string; body: string }
  /**
   * 回滚浮层（FR-51b/53b）：要**选回滚点 + 选范围**，所以不能只有"是/否"。
   *
   * `snapshots` 由面板拉好后传进来（画布不碰数据通道）；
   * `scope`/`snapshotId`/`confirmShared` 的当前值由面板持有（受控），画布只回传选择。
   */
  | {
      kind: 'rollback';
      nodeId: string;
      title: string;
      branch: boolean;
      preview: string;
      snapshots: Array<{ snapshotId: string; reason: string; createdAt: string; mode: string }>;
      snapshotId: string;
      scope: 'code' | 'state' | 'both';
      confirmShared: boolean;
      /** 需要二次确认共享文件时给出文件清单（由宿主上一轮返回）。 */
      sharedBlocked?: string[];
    };

/** 回滚浮层的当前选择（画布 → 面板）。 */
export interface RollbackChoice {
  snapshotId: string;
  scope: 'code' | 'state' | 'both';
  confirmShared: boolean;
}

/** 把节点名截断到节点框宽度内（不做文本测量，按字符数近似，中文更宽）。 */
function clipLabel(name: string, max = 13): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** 折叠状态的 localStorage 键（按项目分开；没有 projectId 就不持久化）。 */
function collapseStorageKey(projectId: string | undefined): string | undefined {
  return projectId === undefined || projectId === '' ? undefined : `dsh.pm.collapsed.${projectId}`;
}

/**
 * 读回折叠状态。
 *
 * 全部包在 try/catch 里且 `window` 不存在时直接返回空集：这个模块会被 **SSR 自检**
 * （`scripts/render-check.tsx`）在没有 DOM 的环境里 import 并渲染，抛异常会让自检红掉，
 * 而"读不到折叠状态"本身只是个便利功能，不该影响看板可用性。
 */
function readCollapsed(key: string | undefined): ReadonlySet<string> {
  if (key === undefined || typeof window === 'undefined') return new Set<string>();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set<string>();
  }
}

/** 写回折叠状态（隐私模式/配额满时静默放弃：丢的是视图偏好，不是数据）。 */
function writeCollapsed(key: string | undefined, value: ReadonlySet<string>): void {
  if (key === undefined || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...value]));
  } catch {
    /* 忽略 */
  }
}

export function FlowCanvas(props: FlowCanvasProps): React.ReactElement {
  const { nodes, selectedId, onSelect } = props;
  // 折叠状态按项目持久化：键变了（切换工作区）就换成那一棵树的折叠集合
  const [collapseKey, setCollapseKey] = useState(() => collapseStorageKey(props.projectId));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsed(collapseKey));
  const nextCollapseKey = collapseStorageKey(props.projectId);
  if (nextCollapseKey !== collapseKey) {
    // React 官方推荐的"渲染期间调整 state"：切项目时不要先渲一帧上一棵树的折叠状态
    setCollapseKey(nextCollapseKey);
    setCollapsed(readCollapsed(nextCollapseKey));
  }
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
   * 折叠/展开前被点按钮的屏幕位置（用于"把它钉在原处"，见 `toggleFold`）。
   */
  const foldAnchorRef = useRef<{ id: string; left: number | undefined; top: number | undefined } | undefined>(
    undefined,
  );
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

  /**
   * 树索引 + 折叠逻辑都在 `fold.ts` 里（纯函数、有单测），这里只做一层薄封装。
   */
  const foldTree = useMemo(() => buildFoldTree(layered), [layered]);

  /** 该节点这个枝里藏了多少节点（0 = 下面没藏东西）。分叉按钮的 `+N` 用它。 */
  const hiddenBelowOf = useCallback(
    (nodeId: string): number => hiddenBelow(foldTree, collapsed, nodeId),
    [foldTree, collapsed],
  );

  /**
   * 分叉按钮（以及枝标签、双击）的统一入口。语义见 `fold.ts` 顶部说明：
   * 普通点击 = 整枝折 / 逐层展开；Shift 点击 = 逐层折 / 整枝展开。
   */
  const toggleFold = useCallback(
    (nodeId: string, shiftKey: boolean): void => {
      /**
       * 记下被点按钮**当前的屏幕位置**，折叠后把视图平移补回来。
       *
       * **为什么必须这么做（实测踩过）**：折叠会让整行重新居中 —— 被点的那个分叉根
       * 横向能跳 155px，于是**第二次点击落在了空白处**（`elementFromPoint` 在原位置返回 null），
       * 用户看到的就是"点击折叠，再点展开不行"。
       *
       * 为什么用**屏幕坐标**而不是布局坐标：布局坐标要先换算再乘缩放，一旦算错方向或量级，
       * 结果就是"看着动了、还是没对上"（第一版就是这么错的：视图移了 464px，按钮仍偏 155px）。
       * 直接量同一个 DOM 元素的前后屏幕矩形，差值就是需要补掉的平移量，与缩放无关。
       */
      const button = wrapRef.current?.querySelector(`[data-pm-fork="${nodeId}"]`);
      const rect = button?.getBoundingClientRect();
      foldAnchorRef.current =
        rect !== undefined
          ? { id: nodeId, left: rect.left, top: rect.top }
          : { id: nodeId, left: undefined, top: undefined };
      setCollapsed((prev) => foldToggle(foldTree, prev, nodeId, shiftKey));
    },
    [foldTree],
  );

  /** 折叠后补回屏幕位移，让被点的按钮停在原处（见 `toggleFold` 的说明）。 */
  useEffect(() => {
    const anchor = foldAnchorRef.current;
    if (anchor === undefined) return;
    foldAnchorRef.current = undefined;
    if (anchor.left === undefined || anchor.top === undefined) return;
    const button = wrapRef.current?.querySelector(`[data-pm-fork="${anchor.id}"]`);
    const rect = button?.getBoundingClientRect();
    if (rect === undefined) return;
    const dx = rect.left - anchor.left;
    const dy = rect.top - anchor.top;
    if (dx === 0 && dy === 0) return;
    setView((prev) => ({ ...prev, tx: prev.tx - dx, ty: prev.ty - dy }));
  }, [layout]);

  /** 折叠集合变化就写回本地存储（视图偏好，不进事实源）。 */
  useEffect(() => {
    writeCollapsed(collapseKey, collapsed);
  }, [collapseKey, collapsed]);

  /**
   * 清掉已经不存在的节点 id（枝被删掉后残留在本地存储里，会让"已折叠 N 枝"的提示说谎）。
   *
   * **节点为空时什么也不做**：面板刚挂载时数据还没到（`nodes` 是空的），
   * 这时候"清理"会把上次存的折叠状态一把抹掉 —— 那等于没有持久化。
   */
  useEffect(() => {
    if (nodes.length === 0) return;
    const alive = new Set(nodes.map((node) => node.id));
    setCollapsed((prev) => {
      const kept = [...prev].filter((id) => alive.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [nodes]);

  /**
   * 「全部收起」的范围：所有**非根**的枝。
   *
   * 为什么不连根一起折：整棵树折成一个节点，用户第一反应是"树丢了"（这个面板早先真出过
   * "一片空白"的事故）；留根 + 顶层枝 = 一屏看清有几条枝、各自进度如何，正是图大时想要的。
   */
  const collapsibleIds = useMemo(() => {
    const ids = new Set(layered.map((node) => node.id));
    const hasChild = new Set<string>();
    const isRoot = new Set<string>();
    for (const node of layered) {
      if (node.parentId === null || !ids.has(node.parentId)) isRoot.add(node.id);
      else hasChild.add(node.parentId);
    }
    return [...hasChild].filter((id) => !isRoot.has(id));
  }, [layered]);

  const showHover = (node: NodeView, event: React.MouseEvent<SVGGElement>): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({ node, x: event.clientX - rect.left + 12, y: event.clientY - rect.top + 12 });
  };

  /**
   * 领航图跳转：把点中的**布局坐标**移到画布中心。
   *
   * 只改平移不改缩放 —— 用户当前选好的缩放级别不该被一次点击改掉（那会让人失去位置感）。
   * 跳转算"手动调过视图"，因此之后容器尺寸变化不再自动重新适配。
   */
  const jumpView = useCallback((x: number, y: number): void => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    userAdjustedRef.current = true;
    setView((prev) => ({
      ...prev,
      tx: rect.width / 2 - x * prev.k,
      ty: rect.height / 2 - y * prev.k,
    }));
  }, []);

  /**
   * 选中的节点如果在视野外，就把它带进来（并居中）。
   *
   * **为什么必须有**：选中不只手点画布 —— 点「未完成 N 项」列表里的一行也会选中节点，
   * 而那个节点可能根本不在这块视图里。没有这一步，用户会看到"高亮了，但画布上什么都没有"。
   * 已经在视野内就**一点不动**（别抢用户已经调好的视图）。
   */
  const pannedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selectedId === undefined || pannedRef.current === selectedId) return;
    pannedRef.current = selectedId;
    const entry = layout.placed.find((placed) => placed.node.id === selectedId);
    const rect = wrapRef.current?.getBoundingClientRect();
    if (entry === undefined || !rect || rect.width === 0 || rect.height === 0) return;
    const margin = 12;
    const view0 = {
      x: -view.tx / view.k,
      y: -view.ty / view.k,
      w: rect.width / view.k,
      h: rect.height / view.k,
    };
    const inside =
      entry.x >= view0.x + margin &&
      entry.y >= view0.y + margin &&
      entry.x + layout.nodeWidth <= view0.x + view0.w - margin &&
      entry.y + layout.nodeHeight <= view0.y + view0.h - margin;
    if (inside) return;
    userAdjustedRef.current = true;
    setView((prev) => ({
      ...prev,
      tx: rect.width / 2 - (entry.x + layout.nodeWidth / 2) * prev.k,
      ty: rect.height / 2 - (entry.y + layout.nodeHeight / 2) * prev.k,
    }));
  }, [selectedId, layout, view.tx, view.ty, view.k]);

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
                  {node.childCount > 0 ? ` · ${nodeCountLabel(node)}（总 / 已完成）` : ''}
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
              // 关注枝的连线：蓝色实线且更粗；旁枝：虚线 + 降透明（FR-45）
              const inFocus = edge.to.inFocusBranch;
              const dashed = !inFocus;
              return (
                <path
                  key={`${edge.from.node.id}->${edge.to.node.id}`}
                  d={`M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`}
                  fill="none"
                  stroke={inFocus ? '#3b82f6' : palette.link}
                  strokeWidth={inFocus ? 2 : 1.2}
                  strokeDasharray={dashed ? '4 3' : undefined}
                  opacity={inFocus ? 0.85 : 0.5}
                />
              );
            })}
          </g>

          {/*
            这里**故意不画枝标签**了（原本每个顶层枝头挂一个胶囊，写着枝名）。
            用户实测反馈："这个东西是不是可以删掉，名称和节点一样，没啥意义"——
            确实：枝名就是该枝根节点自己的名字，而它就印在胶囊正下方那个节点上；
            胶囊的另一个作用（点一下折整枝）也已经由**分叉按钮**承担。
            删掉之后画布少一层重复信息，纵向也松快些（枝色仍靠节点左侧色条区分）。
          */}

          {/*
            选中的节点**最后画**（SVG 没有 z-index，顺序就是层级）：它的高亮环、
            悬浮提示不会被相邻节点压住 —— "被点击的节点主要高亮"要体现在层级上。
          */}
          {[...layout.placed]
            .sort((left, right) =>
              left.node.id === selectedId ? 1 : right.node.id === selectedId ? -1 : 0,
            )
            .map((placed) => (
            <FlowNode
              key={placed.node.id}
              placed={placed}
              nodeWidth={layout.nodeWidth}
              nodeHeight={layout.nodeHeight}
              selected={selectedId === placed.node.id}
              hiddenBelow={hiddenBelowOf(placed.node.id)}
              palette={palette}
              branchColor={branchColor(placed.branchIndex)}
              onSelect={selectUnlessDragged}
              onOpenMenu={openMenu}
              onToggleFold={(shiftKey: boolean) => toggleFold(placed.node.id, shiftKey)}
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
        {/* 枝桠折叠（FR-47）：整棵树一键收起/展开，图大时先看骨架 */}
        <button
          type="button"
          style={styles.toolButton}
          disabled={collapsibleIds.length === 0}
          onClick={() => setCollapsed(new Set(collapsibleIds))}
        >
          全部收起
        </button>
        <button
          type="button"
          style={styles.toolButton}
          disabled={collapsed.size === 0}
          onClick={() => setCollapsed(new Set<string>())}
        >
          全部展开
        </button>
      </div>

      {/*
        提示行单独放在左下角，且 `pointer-events: none`。
        早先它和按钮同排，把工具栏撑到 538px 宽 —— 于是画布右上那一条被工具栏盖住，
        右键/点击/拖拽都落不到节点上（实测：右键事件目标是工具栏 DIV，不是节点）。
      */}
      <div style={{ ...styles.toolHint, color: palette.textMuted }}>
        {layout.placed.length} 个节点 · 滚轮缩放 / 拖拽平移 / 右键菜单 / 分叉处按钮折叠
        {collapsed.size > 0
          ? ' · 点一下展开一层；Shift+点：还能折就再折一层，折到底则全展开'
          : ' · 点分叉按钮折整枝；Shift+点从最下游逐层折'}
        {clipped ? ' · 图较宽：已对准根节点，可拖拽浏览' : ''}
      </div>

      {/*
        领航图（右下角）：点/拖地图上的位置，主流程图就跳到对应的那一块。
        放在工具栏与提示行之外（工具提示行在左下），三者互不遮挡（实测踩过工具栏盖住画布）。
      */}
      {measured !== undefined && layout.placed.length > 0 ? (
        <Minimap
          layout={layout}
          view={view}
          container={measured}
          palette={palette}
          onJump={jumpView}
        />
      ) : null}

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
              ...menuItems(menu.node, props.rollbackPoints?.(menu.node.id) ?? 0).map((item) =>
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

      {/* 节点旁的输入 / 确认浮层（贴在**被操作的节点**边上，而不是面板顶部） */}
      {props.overlay !== undefined ? (
        <NodeOverlay
          overlay={props.overlay}
          placed={layout.placed.find((entry) => entry.node.id === props.overlay?.nodeId)}
          view={view}
          nodeWidth={layout.nodeWidth}
          nodeHeight={layout.nodeHeight}
          paneWidth={measured?.w ?? 0}
          paneHeight={measured?.h ?? 0}
          text={props.overlayText ?? ''}
          palette={palette}
          onTextChange={props.onOverlayTextChange}
          onSubmit={props.onSubmit}
          onCancel={props.onCancel}
          onRollbackChoice={props.onRollbackChoice}
        />
      ) : null}
    </div>
  );
}

/**
 * 贴在节点边上的浮层。
 *
 * 位置换算：节点在**画布坐标系**里的位置 → 乘当前缩放、加平移 → 屏幕坐标；
 * 然后夹在画布范围内（右侧/下方不够就翻到节点另一侧），保证不会被裁掉。
 */
function NodeOverlay(props: {
  overlay: FlowOverlay;
  placed: PlacedNode | undefined;
  view: { tx: number; ty: number; k: number };
  nodeWidth: number;
  nodeHeight: number;
  paneWidth: number;
  paneHeight: number;
  text: string;
  palette: FlowPalette;
  onTextChange?: (value: string) => void;
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  /** 回滚浮层的选择变化（受控组件：值在面板那边）。 */
  onRollbackChoice?: (choice: RollbackChoice) => void;
}): React.ReactElement {
  const { overlay, placed, view, palette } = props;
  const width = overlay.kind === 'rollback' ? 306 : 268;
  const estimatedHeight = overlay.kind === 'text' ? 104 : overlay.kind === 'rollback' ? 240 : 150;
  // 节点底部中心（画布坐标 → 屏幕坐标）
  const baseX = placed === undefined ? 24 : (placed.x + props.nodeWidth / 2) * view.k + view.tx;
  const baseY = placed === undefined ? 24 : (placed.y + props.nodeHeight) * view.k + view.ty + 10;

  const maxX = Math.max(8, props.paneWidth - width - 8);
  const left = Math.min(Math.max(8, baseX - width / 2), maxX);
  // 下方放不下就翻到节点上方
  const below = baseY + estimatedHeight <= props.paneHeight - 8 || placed === undefined;
  const top = below
    ? Math.min(baseY, Math.max(8, props.paneHeight - estimatedHeight - 8))
    : Math.max(8, placed!.y * view.k + view.ty - estimatedHeight - 8);

  const node = placed?.node;
  return React.createElement(
    'div',
    {
      style: {
        position: 'absolute' as const,
        left,
        top,
        width,
        zIndex: 10,
        background: palette.surface,
        color: palette.text,
        border: `0.5px solid ${palette.edge}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.32)',
        padding: '8px 10px',
        fontSize: 12,
        lineHeight: 1.6,
      },
      // 浮层内的点击不要穿透到画布（否则会关掉/拖动视图）
      onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
      onClick: (event: React.MouseEvent) => event.stopPropagation(),
    },
    React.createElement(
      'div',
      { style: { fontWeight: 600, marginBottom: 2 } },
      overlay.title,
    ),
    node !== undefined
      ? React.createElement(
          'div',
          { style: { fontSize: 10.5, opacity: 0.7, marginBottom: 6 } },
          nodeRowLabel(node),
        )
      : null,
    overlay.kind === 'text'
      ? React.createElement('input', {
          type: 'text',
          value: props.text,
          autoFocus: true,
          placeholder: '回车确认，Esc 取消',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            props.onTextChange?.(event.target.value),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') props.onSubmit?.(props.text);
            if (event.key === 'Escape') props.onCancel?.();
          },
          style: {
            width: '100%',
            boxSizing: 'border-box' as const,
            fontSize: 12,
            padding: '4px 6px',
            borderRadius: 4,
            border: `0.5px solid ${palette.edge}`,
            background: 'transparent',
            color: 'inherit',
          },
        })
      : overlay.kind === 'rollback'
        ? React.createElement(
            'div',
            { style: { fontSize: 11 } },
            React.createElement(
              'div',
              {
                style: {
                  whiteSpace: 'pre-line' as const,
                  maxHeight: 150,
                  overflow: 'auto',
                  opacity: 0.9,
                  border: `0.5px solid ${palette.edge}`,
                  borderRadius: 4,
                  padding: '5px 7px',
                },
              },
              overlay.preview,
            ),
            React.createElement(
              'div',
              { style: { marginTop: 6, opacity: 0.75 } },
              '回滚点',
            ),
            React.createElement(
              'select',
              {
                value: overlay.snapshotId,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                  props.onRollbackChoice?.({
                    snapshotId: event.target.value,
                    scope: overlay.scope,
                    confirmShared: overlay.confirmShared,
                  }),
                style: {
                  width: '100%',
                  fontSize: 11,
                  padding: '3px 4px',
                  borderRadius: 4,
                  border: `0.5px solid ${palette.edge}`,
                  background: palette.surface,
                  color: 'inherit',
                },
              },
              ...overlay.snapshots.map((row) =>
                React.createElement(
                  'option',
                  { key: row.snapshotId, value: row.snapshotId },
                  `${row.createdAt.slice(0, 16).replace('T', ' ')} · ${row.reason} · ${row.mode}`,
                ),
              ),
            ),
            React.createElement(
              'div',
              { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' } },
              React.createElement('span', { style: { opacity: 0.75 } }, '范围'),
              ...(
                [
                  ['both', '代码+状态'],
                  ['code', '仅代码'],
                  ['state', '仅状态'],
                ] as const
              ).map(([value, label]) =>
                React.createElement(
                  'label',
                  { key: value, style: { display: 'flex', gap: 3, alignItems: 'center', cursor: 'pointer' } },
                  React.createElement('input', {
                    type: 'radio',
                    name: `pm-scope-${overlay.nodeId}`,
                    checked: overlay.scope === value,
                    onChange: () =>
                      props.onRollbackChoice?.({
                        snapshotId: overlay.snapshotId,
                        scope: value,
                        confirmShared: overlay.confirmShared,
                      }),
                  }),
                  label,
                ),
              ),
            ),
            overlay.sharedBlocked && overlay.sharedBlocked.length > 0
              ? React.createElement(
                  'label',
                  {
                    style: {
                      display: 'flex',
                      gap: 5,
                      alignItems: 'flex-start',
                      marginTop: 6,
                      cursor: 'pointer',
                      color: '#f59e0b',
                    },
                  },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: overlay.confirmShared,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      props.onRollbackChoice?.({
                        snapshotId: overlay.snapshotId,
                        scope: overlay.scope,
                        confirmShared: event.target.checked,
                      }),
                  }),
                  `同时还原这些被多个节点写过的文件：${overlay.sharedBlocked.join('、')}`,
                )
              : null,
          )
        : React.createElement(
            'div',
            { style: { fontSize: 11, opacity: 0.85, whiteSpace: 'pre-line' as const, maxHeight: 120, overflow: 'auto' } },
            overlay.body,
          ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' } },
      React.createElement(
        'button',
        {
          type: 'button',
          style: styles.overlayButton,
          onClick: () => props.onCancel?.(),
        },
        '取消',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: styles.overlayButton,
          onClick: () => props.onSubmit?.(props.text),
        },
        overlay.kind === 'text' ? '确定' : '确认',
      ),
    ),
  );
}

/**
 * 菜单项（按 §6.6 的清单，作用于父/叶各有取舍）。
 *
 * @param rollbackPoints 该节点可用回滚点数量。**没有回滚点就不显示「回滚」**（FR：不显示而不是置灰）——
 *   置灰会让人以为功能坏了，而"没有锚点"是正常状态（还没打过点）。
 */
function menuItems(
  node: NodeView,
  rollbackPoints = 0,
): Array<{ action: PanelNodeAction | 'remove' | 'rollback' | 'branch-rollback'; label: string; disabled?: boolean }> {
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
    // 回滚两项：只在**有可用回滚点**时出现（FR-51b/53b）
    ...(rollbackPoints > 0
      ? [
          { action: 'rollback' as const, label: `回滚到回滚点…（${rollbackPoints} 个可用）` },
          ...(node.childCount > 0
            ? [{ action: 'branch-rollback' as const, label: '整枝回滚…（仅父节点）' }]
            : []),
        ]
      : []),
    // 删除走的是另一条带三方案确认的路径（`/pm/branch/remove`），所以单独列一项
    { action: 'remove', label: '删除整枝…' },
  ];
}

interface FlowNodeProps {
  placed: PlacedNode;
  nodeWidth: number;
  nodeHeight: number;
  selected: boolean;
  /** 这个节点的枝里被折起来多少个节点（0 = 下面没藏东西）。分叉按钮的 `+N` 用它。 */
  hiddenBelow: number;
  /// 主题调色板（暗色下填充更实、底槽更亮，否则"看不清"）
  palette: FlowPalette;
  /** 该节点所属顶层枝的颜色（画在节点内部左侧色条上）。 */
  branchColor: string;
  onSelect: (nodeId: string) => void;
  /** 右键 → 面板菜单（未提供时不响应右键）。 */
  onOpenMenu: (node: NodeView, event: React.MouseEvent<SVGGElement>) => void;
  /** 折叠/展开（`shiftKey` = 逐层折 / 全展开）。 */
  onToggleFold: (shiftKey: boolean) => void;
  onHover: (node: NodeView, event: React.MouseEvent<SVGGElement>) => void;
  onLeave: () => void;
}

/** 分叉按钮的尺寸（画在节点框**外**、正对分叉处）。 */
const FORK_BUTTON_HEIGHT = 17;
const FORK_BUTTON_MIN_WIDTH = 22;

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
  /** 分叉按钮挪到框外了（正对分叉处），框内的进度条拿回整条宽度。 */
  const barWidth = innerWidth - 1;
  /** 只有**真分叉**（子节点 ≥ 2）才有折叠按钮：单子链上折不出分支，那个按钮只是噪声。 */
  const isFork = node.childCount >= 2;
  const showForkButton = isFork && !isLeaf;
  const forkLabel = props.hiddenBelow > 0 ? `+${props.hiddenBelow}` : '▾';
  const forkWidth = Math.max(FORK_BUTTON_MIN_WIDTH, 10 + forkLabel.length * 6);

  return (
    <g
      transform={`translate(${placed.x} ${placed.y})`}
      style={{
        cursor: 'pointer',
        /**
         * 三级可见性（实测反馈："关注整枝后子枝和叶子看不出高亮" + "父级也该高亮，但别那么明显"）：
         * ① 主枝（自己或祖先是焦点）：满透明 + 提饱和 + 发光；
         * ② **通往焦点的链路**（祖先是焦点自然属于①；这里指子孙里有焦点）：轻提示，便于大图追链路；
         * ③ 旁枝：明显降透明 + 降饱和。
         * **选中优先**：被点的那一个永远满透明 —— 哪怕它落在旁枝里（"被点击的节点主要高亮"）。
         */
        opacity: props.selected
          ? 1
          : placed.inFocusBranch
            ? 1
            : placed.onFocusPath
              ? 0.82
              : palette.dark
                ? 0.42
                : 0.5,
        filter: [
          props.selected
            ? `saturate(${palette.dark ? 1.2 : 1.08})`
            : placed.inFocusBranch
              ? `saturate(${palette.dark ? 1.15 : 1.05})`
              : placed.onFocusPath
                ? 'saturate(0.85)'
                : 'saturate(0.45)',
          node.focus
            ? 'drop-shadow(0 0 7px rgba(59,130,246,0.95))'
            : placed.inFocusBranch
              ? 'drop-shadow(0 0 4px rgba(59,130,246,0.55))'
              : '',
          // 选中的外发光：用主题前景色（暗底发白、亮底发深），与关注枝的蓝光互不混淆
          props.selected
            ? `drop-shadow(0 0 9px ${palette.dark ? 'rgba(241,245,249,0.75)' : 'rgba(15,23,42,0.55)'})`
            : '',
        ]
          .filter((part) => part !== '')
          .join(' '),
      }}
      onClick={() => props.onSelect(node.id)}
      // 双击整枝折叠/展开（比点那个小圆点好按，实测反馈想更快地收枝）
      onDoubleClick={(event) => {
        event.stopPropagation();
        // 双击是快捷键：有子节点就折/展（按当前枝有没有折叠标记决定方向，与分叉按钮同一套）
        if (node.childCount > 0) props.onToggleFold(event.shiftKey);
      }}
      onContextMenu={(event) => props.onOpenMenu(node, event)}
      onMouseMove={(event) => props.onHover(node, event)}
      onMouseLeave={props.onLeave}
    >
      {/*
        这里**故意不放** `<title>`：浏览器自带的 tooltip 会和我们的悬浮提示同时弹出，
        实测叠成两层（一层原生黄框、一层我们自己的深色框）。只保留我们自己的那份 ——
        它能跟随主题、能显示多行依据，原生那层做不到。
      */}
      {/* 关注枝的发光描边（第二层：外发光，不碰边框语义），整枝每个节点都画 */}
      {placed.inFocusBranch ? (
        <rect
          x={-2.5}
          y={-2.5}
          width={nodeWidth + 5}
          height={nodeHeight + 5}
          rx={9}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={node.focus ? 2.2 : 1.4}
          opacity={node.focus ? 0.95 : 0.6}
        />
      ) : placed.onFocusPath ? (
        // 链路：细一档、淡一档，够看出"它通向某个被关注的节点"即可
        <rect
          x={-2}
          y={-2}
          width={nodeWidth + 4}
          height={nodeHeight + 4}
          rx={9}
          fill="none"
          stroke="#7dd3fc"
          strokeWidth={1}
          opacity={0.35}
        />
      ) : null}
      {/*
        **被点击的节点 = 主高亮**（用户口径："被点击的节点主要高亮并展示节点属性"）。
        与"关注枝"的蓝光分层：关注是**枝**的语义（蓝 #3b82f6），选中是"我正在看这一个"
        —— 用主题前景色画一圈更粗的环 + 一圈更淡的外圈，叠在一起也分得清、且不靠色相区分。
      */}
      {props.selected ? (
        <>
          <rect
            x={-5}
            y={-5}
            width={nodeWidth + 10}
            height={nodeHeight + 10}
            rx={12}
            fill="none"
            stroke={palette.text}
            strokeWidth={2.5}
            opacity={0.92}
          />
          <rect
            x={-8.5}
            y={-8.5}
            width={nodeWidth + 17}
            height={nodeHeight + 17}
            rx={14}
            fill="none"
            stroke={palette.text}
            strokeWidth={1}
            opacity={0.3}
          />
        </>
      ) : null}
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
      {/* 枝色条：在节点**内部左侧**，不与边框语义冲突（一眼看出属于哪条枝） */}
      <rect x={0} y={0} width={3.5} height={nodeHeight} rx={1.75} fill={props.branchColor} opacity={0.9} />

      <text x={11} y={17} fontSize={11} fontWeight={600} fill={palette.text}>
        {clipLabel(node.name, isLeaf ? 13 : 11)}
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

      {/* 进度条（两层之外的信息：进度百分比本身）；有折叠按钮的枝给它让出右侧位置 */}
      <rect x={11} y={nodeHeight - 20} width={barWidth} height={5} rx={2.5} fill={palette.track} />
      <rect
        x={11}
        y={nodeHeight - 20}
        width={Math.max(0, Math.min(1, node.progress)) * barWidth}
        height={5}
        rx={2.5}
        fill={done ? '#22c55e' : stateColor}
      />

      {/*
        计数文案（用户纠偏后的口径：**以项目进度为主**）：
        枝给「**总 / 已完成**」两个纯数字，叶给自身百分比（单件没有"总数"可言）。
        口径的唯一来源是 `client/labels.ts` —— 同一个数字在五处出现，散着写必然漂移。
      */}
      <text x={11} y={nodeHeight - 6} fontSize={9.5} fill={palette.textMuted}>
        {nodeCountLabel(node)}
      </text>

      {/* 叶节点未完成 → 右下角空心方点（第一层的"待办单元"标记） */}
      {isLeaf && !done ? (
        <rect
          x={nodeWidth - 12}
          y={nodeHeight - 11}
          width={6}
          height={6}
          fill="none"
          stroke={stateColor}
          strokeWidth={1.2}
        />
      ) : null}

      {/*
        分叉按钮（FR-47）——**放在节点框外、正对分叉处**（底边中点就是连线的起点）：
        ① 放框内会和"未完成 x/y"文案抢地方（实测挤成一团）；
        ② 语义上它属于"从这里分叉"，不属于这个节点自己。
        只有真分叉（子节点 ≥ 2）才画：单子链上折不出分支，按钮只是噪声。
        收起后按钮变成 `+N`，N = 这枝里被藏起来的节点数（说实话，不报直接子节点数）。
        两处入口同一套语义：这个按钮、双击节点（枝标签已按用户反馈删掉）。
      */}
      {showForkButton ? (
        <g
          transform={`translate(${nodeWidth / 2} ${nodeHeight + 3})`}
          // 供"折叠后把按钮钉回原处"定位用（见 toggleFold 的说明）
          data-pm-fork={node.id}
          style={{ cursor: 'pointer' }}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleFold(event.shiftKey);
          }}
        >
          {/* 这里不放 `<title>`：节点级悬浮提示已经会显示（原生 tooltip 会叠成两层，实测过） */}
          {/* 透明热区：把可点范围放大到视觉按钮之外一点，小缩放下也点得中 */}
          <rect
            x={-forkWidth / 2 - 5}
            y={-4}
            width={forkWidth + 10}
            height={FORK_BUTTON_HEIGHT + 8}
            fill="transparent"
          />
          <rect
            x={-forkWidth / 2}
            y={0}
            width={forkWidth}
            height={FORK_BUTTON_HEIGHT}
            rx={FORK_BUTTON_HEIGHT / 2}
            fill={props.hiddenBelow > 0 ? props.branchColor : palette.surface}
            stroke={props.hiddenBelow > 0 ? props.branchColor : borderColor}
            strokeWidth={1}
          />
          <text
            y={10.5}
            fontSize={9.5}
            textAnchor="middle"
            fill={
              props.hiddenBelow > 0 ? (palette.dark ? '#0b0b0d' : '#ffffff') : borderColor
            }
          >
            {forkLabel}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** 领航图的固定宽度；高度按树的宽高比算，避免又宽又扁或又窄又长。 */
const MINIMAP_WIDTH = 336;
const MINIMAP_MIN_HEIGHT = 120;
const MINIMAP_MAX_HEIGHT = 264;

interface MinimapProps {
  layout: FlowLayout;
  view: { tx: number; ty: number; k: number };
  /** 画布容器的实测尺寸（算"当前看到哪一块"用）。 */
  container: { w: number; h: number };
  palette: FlowPalette;
  /** 点/拖地图 → 把主视图移到这个**布局坐标**处（由画布换算成平移量并居中）。 */
  onJump: (x: number, y: number) => void;
}

/**
 * 领航图（minimap）：整棵树缩略图 + 当前视口框；点/拖地图上的位置，主流程图就跳到那里。
 *
 * 为什么需要：树一大，画布要么缩到看不清、要么只能看到一角（我们的适配策略是"高度优先、
 * 宁可横向拖"，见 `fit`）。有了这张图，用户能随时知道"我在树的哪一块、还有哪几条枝"。
 * 它是**独立的一层 HTML/SVG**，不参与主视图的变换，因此缩放/平移它都不动。
 *
 * 取舍（诚实记录）：它压在画布右下角，那一小块区域内的节点右键/拖拽会被它挡住 ——
 * 所以尺寸克制（168px 宽），并且主视图可以拖开。
 */
function Minimap(props: MinimapProps): React.ReactElement {
  const { layout, view, container, palette } = props;
  const height = Math.max(
    MINIMAP_MIN_HEIGHT,
    Math.min(
      MINIMAP_MAX_HEIGHT,
      Math.round((MINIMAP_WIDTH * layout.height) / Math.max(layout.width, 1)),
    ),
  );
  const scale = Math.min(
    MINIMAP_WIDTH / Math.max(layout.width, 1),
    height / Math.max(layout.height, 1),
  );
  const offsetX = (MINIMAP_WIDTH - layout.width * scale) / 2;
  const offsetY = (height - layout.height * scale) / 2;
  const ref = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);

  const jump = (event: React.PointerEvent<SVGSVGElement>): void => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    props.onJump((event.clientX - box.left - offsetX) / scale, (event.clientY - box.top - offsetY) / scale);
  };

  // 主视图当前看到的布局区域（负的平移 = 内容往左上推，所以可见起点是 -tx/k）
  const visible = {
    x: Math.max(0, -view.tx / view.k),
    y: Math.max(0, -view.ty / view.k),
    w: Math.min(layout.width, container.w / view.k),
    h: Math.min(layout.height, container.h / view.k),
  };

  return (
    <svg
      ref={ref}
      width={MINIMAP_WIDTH}
      height={height}
      // 地图自己吃指针事件：既不启动画布的拖拽，也不让右键菜单在它上面弹出来
      onPointerDown={(event) => {
        event.stopPropagation();
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        jump(event);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        if (dragging.current) jump(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        dragging.current = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerLeave={() => {
        dragging.current = false;
      }}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: 'absolute',
        right: 10,
        bottom: 10,
        zIndex: 6,
        borderRadius: 6,
        border: `0.5px solid ${palette.edge}`,
        background: palette.dark ? 'rgba(24,24,27,0.88)' : 'rgba(255,255,255,0.88)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
        cursor: 'crosshair',
      }}
    >
      <g transform={`translate(${offsetX} ${offsetY}) scale(${scale})`}>
        {layout.edges.map((edge) => (
          <line
            key={`mm:${edge.from.node.id}->${edge.to.node.id}`}
            x1={edge.from.x + layout.nodeWidth / 2}
            y1={edge.from.y + layout.nodeHeight}
            x2={edge.to.x + layout.nodeWidth / 2}
            y2={edge.to.y}
            stroke={palette.link}
            strokeWidth={1 / scale}
            opacity={0.45}
          />
        ))}
        {layout.placed.map((entry) => (
          <rect
            key={`mm:${entry.node.id}`}
            x={entry.x}
            y={entry.y}
            width={layout.nodeWidth}
            height={layout.nodeHeight}
            rx={7}
            // 地图用**枝色**（导航认路），关注枝亮、旁枝暗：状态信息留给主画布，别在这里重复
            fill={branchColor(entry.branchIndex)}
            opacity={entry.node.focus ? 1 : entry.inFocusBranch ? 0.7 : 0.28}
          />
        ))}
      </g>
      <rect
        x={offsetX + visible.x * scale}
        y={offsetY + visible.y * scale}
        width={visible.w * scale}
        height={visible.h * scale}
        rx={2}
        fill="rgba(59,130,246,0.16)"
        stroke="#3b82f6"
        strokeWidth={1}
      />
    </svg>
  );
}

/** `#rrggbb` → `rgba(...)`（状态色来自 `api.ts` 的固定表，一定是 6 位十六进制）。 */function hexToRgba(hex: string, alpha: number): string {
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
  overlayButton: {
    fontSize: 11,
    padding: '2px 10px',
    borderRadius: 4,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
};

export { FLOW_NODE_HEIGHT, FLOW_NODE_WIDTH };






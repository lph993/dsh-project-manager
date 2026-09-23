import * as React$1 from "react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx, jsxs } from "react/jsx-runtime";
async function getJson(path, signal) {
	try {
		const url = new URL(`.//pm${path}`.replace(/\/+/g, "/"), document.baseURI);
		const response = await fetch(url.toString(), {
			method: "GET",
			headers: { accept: "application/json" },
			...signal ? { signal } : {}
		});
		if (!response.ok) return {
			ok: false,
			error: `HTTP ${response.status}`
		};
		return {
			ok: true,
			value: await response.json()
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/** 会话查询串（带上它宿主才能把工作区根精确解析到该会话的工作区）。 */
function sessionQuery(sessionId) {
	return sessionId !== void 0 && sessionId !== "" ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
}
/** 拉取看板快照。 */
function fetchBoard(signal, sessionId) {
	return getJson(`/board${sessionQuery(sessionId)}`, signal);
}
async function postJson(path, body, signal) {
	try {
		const url = new URL(`.//pm${path}`.replace(/\/+/g, "/"), document.baseURI);
		const response = await fetch(url.toString(), {
			method: "POST",
			headers: {
				accept: "application/json",
				...body !== void 0 ? { "content-type": "application/json" } : {}
			},
			...body !== void 0 ? { body: JSON.stringify(body) } : {},
			...signal ? { signal } : {}
		});
		if (!response.ok) return {
			ok: false,
			error: `HTTP ${response.status}`
		};
		return {
			ok: true,
			value: await response.json()
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/** 触发一次零 token 扫描（只建议，不落库）。 */
async function postScan(signal, sessionId) {
	return postJson(`/scan${sessionQuery(sessionId)}`, void 0, signal);
}
/** 应用扫描结果建树（不带参数时服务端自己扫一次）。 */
async function postScanApply(body, signal, sessionId) {
	return postJson(`/scan/apply${sessionQuery(sessionId)}`, body, signal);
}
/**
* 面板路径的整枝删除（FR-57）。
*
* **确认语义**：面板的确认人是当场用户，因此由面板自己的确认框承载（§6.7f 第 2 行）；
* 模型走不了这个接口（模型只有 `pm_*` 工具，那条路必须过 `ctx.approval` 且 fail-closed）。
*/
async function postRemoveBranch(body, signal) {
	return postJson("/branch/remove", body, signal);
}
/**
* 客户端自我上报：让宿主的 `/pm/debug` 能显示"客户端这一侧到底加载成什么样"。
*
* 浏览器全局被严格限制（宿主只注入 `__DSH_BOOT__` / `__ModuleLoader__`，不含插件数据），
* 所以插件自己的可观测点必须**主动上报**，否则宿主无法知道面板是否真的跑起来了。
* 上报失败不影响插件功能（诊断是附加能力）。
*/
function reportClient(input) {
	try {
		const target = (path) => new URL(`.//pm${path}`.replace(/\/+/g, "/"), document.baseURI).toString();
		fetch(target("/debug/client"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...input,
				boardUrl: target("/board"),
				userAgent: typeof navigator === "undefined" ? void 0 : navigator.userAgent
			})
		}).catch(() => {});
	} catch {}
}
/** 格式化百分比（看板口径：按工作量；括号内给件数）。 */
function formatPercent(stats) {
	if (!stats || stats.totalLeaves === 0) return "—";
	return `${Math.round(stats.ratio * 100)}%`;
}
/** 件数比展示。 */
function formatCounts(stats) {
	if (!stats) return "";
	return `${stats.doneLeaves}/${stats.totalLeaves}`;
}
/** 口径标注（FR-34：必须标注权重口径与来源）。 */
function formatBasis(stats) {
	if (!stats) return "";
	if (stats.basis === "weight") return stats.structuralDegenerate === true ? "按件数·无结构数据" : "按工作量";
	return "按件数";
}
/** 计算状态 → 中文标签。 */
const DERIVED_STATE_LABEL = {
	pending: "待开始",
	running: "进行中",
	done: "已完成",
	error: "异常",
	paused: "已暂停",
	held: "已拦停",
	removed: "已删除"
};
/** 计算状态 → 颜色（无障碍：颜色之外还有标签与角标）。 */
const DERIVED_STATE_COLOR = {
	pending: "#9aa4b2",
	running: "#3b82f6",
	done: "#22c55e",
	error: "#ef4444",
	paused: "#f59e0b",
	held: "#b91c1c",
	removed: "#6b7280"
};
/** 一个节点在列表里的单行文案。 */
function nodeRowLabel(node) {
	return `${node.branchPath.length > 0 ? `${node.branchPath.join(" / ")} / ` : ""}${node.name}`;
}
/**
* 节点的悬停说明。
*
* **默认不显示权重**：默认口径是**按件数**（每个任务点等权），
* 编一个"权重 1.00"只会让人以为系统偷偷算过什么（§9.3a 修订）。
* 只有当权重真有来源（AI 估算 / 人工填写）时才把它连同证据摆出来（FR-34）。
*/
function nodeRowTitle(node) {
	const lines = [nodeRowLabel(node)];
	if (node.weightSource === void 0) lines.push("权重口径：按件数（每个任务点等权）");
	else {
		const source = node.weightSource === "ai" ? "AI 估算" : "人工填写";
		lines.push(`权重 ${node.weight.toFixed(2)}（${source}）`);
	}
	if (node.blockedBy.length > 0) lines.push(`被前置阻塞：${node.blockedBy.length} 项`);
	return lines.join("\n");
}
/**
* 计算流程图布局。
*
* 输入是看板的**扁平**节点数组（`parentId` 表达父子关系）——
* 与事实源的口径一致，布局层不引入第二套树结构。
*/
function layoutFlow(nodes, options = {}) {
	const nodeWidth = options.nodeWidth ?? 168;
	const nodeHeight = options.nodeHeight ?? 56;
	const gapX = options.gapX ?? 28;
	const gapY = options.gapY ?? 46;
	const collapsed = options.collapsed ?? /* @__PURE__ */ new Set();
	const byId = /* @__PURE__ */ new Map();
	for (const node of nodes) byId.set(node.id, node);
	const childrenOf = /* @__PURE__ */ new Map();
	const roots = [];
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
	for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	roots.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	const placed = [];
	const placedById = /* @__PURE__ */ new Map();
	const edges = [];
	let cursorX = 0;
	let maxDepth = 0;
	const visited = /* @__PURE__ */ new Set();
	/**
	* 关注枝并集：任一祖先（含自身）被关注，则该节点在关注枝内。
	*/
	const focusMemo = /* @__PURE__ */ new Map();
	const inFocus = (node) => {
		const cached = focusMemo.get(node.id);
		if (cached !== void 0) return cached;
		const path = [];
		const seen = /* @__PURE__ */ new Set();
		let current = node;
		let value = false;
		while (current !== void 0) {
			const known = focusMemo.get(current.id);
			if (known !== void 0) {
				value = known;
				break;
			}
			if (seen.has(current.id)) break;
			seen.add(current.id);
			path.push(current);
			if (current.focus) {
				value = true;
				break;
			}
			const parentId = current.parentId;
			current = parentId === null ? void 0 : byId.get(parentId);
		}
		for (const item of path) focusMemo.set(item.id, value);
		return value;
	};
	/**
	* 深度优先布局。
	*
	* @returns 该子树占用的**横向中心**（父节点据此居中）
	*/
	const walk = (node, depth) => {
		if (visited.has(node.id)) {
			const x = cursorX;
			cursorX += nodeWidth + gapX;
			return x + nodeWidth / 2;
		}
		visited.add(node.id);
		const children = childrenOf.get(node.id) ?? [];
		const hidden = collapsed.has(node.id) ? children.length : 0;
		const visible = collapsed.has(node.id) ? [] : children;
		maxDepth = Math.max(maxDepth, depth);
		let centerX;
		if (visible.length === 0) {
			centerX = cursorX + nodeWidth / 2;
			cursorX += nodeWidth + gapX;
		} else {
			const centers = visible.map((child) => walk(child, depth + 1));
			centerX = (centers[0] + centers[centers.length - 1]) / 2;
		}
		const entry = {
			node,
			x: centerX - nodeWidth / 2,
			y: depth * (nodeHeight + gapY),
			depth,
			hiddenChildren: hidden,
			inFocusBranch: inFocus(node)
		};
		placed.push(entry);
		placedById.set(node.id, entry);
		return centerX;
	};
	for (const root of roots) walk(root, 0);
	const hiddenByCollapse = (node) => {
		const seen = /* @__PURE__ */ new Set();
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
	for (const node of nodes) if (!visited.has(node.id) && !hiddenByCollapse(node)) walk(node, 0);
	for (const entry of placed) for (const child of childrenOf.get(entry.node.id) ?? []) {
		const target = placedById.get(child.id);
		if (target) edges.push({
			from: entry,
			to: target
		});
	}
	const leafSpan = Math.max(1, placed.filter((p) => (childrenOf.get(p.node.id) ?? []).length === 0 || p.hiddenChildren > 0).length);
	return {
		placed,
		edges,
		width: Math.max(leafSpan * (nodeWidth + gapX), nodeWidth),
		height: (maxDepth + 1) * (nodeHeight + gapY),
		nodeWidth,
		nodeHeight
	};
}
//#endregion
//#region ../src/client/flow-canvas.tsx
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
const { useCallback: useCallback$1, useEffect: useEffect$1, useMemo: useMemo$1, useRef: useRef$1, useState: useState$1 } = React;
/** 计算状态 → 填充色（浅色调，保证与边框层的语义不冲突）。 */
const STATE_FILL = { pending: "transparent" };
/** 计算状态 → 状态层角标（第二层，绝不用边框表达）。 */
const STATE_BADGE = {
	running: "▶",
	error: "!",
	paused: "Ⅱ",
	held: "⛔",
	done: "✓"
};
/** 把节点名截断到节点框宽度内（不做文本测量，按字符数近似，中文更宽）。 */
function clipLabel(name, max = 13) {
	return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}
function FlowCanvas(props) {
	const { nodes, selectedId, onSelect } = props;
	const [collapsed, setCollapsed] = useState$1(() => /* @__PURE__ */ new Set());
	const [view, setView] = useState$1({
		tx: 16,
		ty: 12,
		k: 1
	});
	const [hover, setHover] = useState$1(void 0);
	const wrapRef = useRef$1(null);
	const svgRef = useRef$1(null);
	const dragRef = useRef$1(void 0);
	/**
	* 用户是否手动调过视图（缩放/平移）。
	*
	* 只要没手动调过，容器尺寸一变（面板首次布局、窗口缩放）就**重新适应视图**；
	* 手动调过之后不再自动动它 —— 否则每次轮询重渲染都会把用户的视图拽回去。
	*/
	const userAdjustedRef = useRef$1(false);
	const [clipped, setClipped] = useState$1(false);
	/** 容器实测尺寸（用于"尺寸为 0 → 退化成清单"的诚实提示）。 */
	const [measured, setMeasured] = useState$1(void 0);
	const visibleNodes = useMemo$1(() => props.hideDone === true ? nodes.filter((n) => n.derivedState !== "done") : nodes, [nodes, props.hideDone]);
	const layered = useMemo$1(() => {
		if (props.hideDone !== true) return visibleNodes;
		const byId = new Map(nodes.map((n) => [n.id, n]));
		const keep = /* @__PURE__ */ new Map();
		for (const node of visibleNodes) {
			keep.set(node.id, node);
			let parentId = node.parentId;
			const guard = /* @__PURE__ */ new Set();
			while (parentId !== null && !guard.has(parentId)) {
				guard.add(parentId);
				const parent = byId.get(parentId);
				if (!parent) break;
				if (!keep.has(parent.id)) keep.set(parent.id, parent);
				parentId = parent.parentId;
			}
		}
		return [...keep.values()];
	}, [
		nodes,
		visibleNodes,
		props.hideDone
	]);
	const layout = useMemo$1(() => layoutFlow(layered, { collapsed }), [layered, collapsed]);
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
	const fit = useCallback$1(() => {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0 || rect.height === 0) return false;
		const pad = 24;
		const availW = Math.max(rect.width - 48, 40);
		const availH = Math.max(rect.height - 48, 40);
		/**
		* 缩放下限取 0.5 而不是"能装多小就多小"：21 个节点的树宽 3528px，
		* 硬塞进 976px 会得到 0.26 的缩放 —— 节点只有 44×15px，等于看不清（实测量到过）。
		* 装不下就让图比视口宽，并按根节点锚定 + 提示可拖拽浏览。
		*/
		const k = Math.min(1.2, Math.max(.5, Math.min(availW / Math.max(layout.width, 1), availH / Math.max(layout.height, 1))));
		const fits = layout.width * k <= availW + 1;
		const anchor = layout.placed.find((p) => p.node.parentId === null) ?? layout.placed.reduce((best, p) => best === void 0 || p.y < best.y ? p : best, void 0);
		const anchorX = anchor === void 0 ? layout.width / 2 : anchor.x + layout.nodeWidth / 2;
		setView({
			k,
			tx: fits ? (rect.width - layout.width * k) / 2 : rect.width / 2 - anchorX * k,
			ty: pad
		});
		setClipped(!fits);
		return true;
	}, [
		layout.width,
		layout.height,
		layout.placed,
		layout.nodeWidth
	]);
	/**
	* 真实尺寸就位 / 窗口变化时：① 记录容器尺寸（用于"尺寸为 0"的退化提示）
	* ② 自动适应视图（用户手动调过之后就不打扰）。
	*
	* 用 ResizeObserver 而不是"挂载时量一次"：面板可能先被 mount 在 0 尺寸容器里
	* （隐藏/尚未布局），一次性测量会把"暂时量不到"误判成"容器没有高度"，
	* 于是永久退化成清单、画布再也不出现（实测踩过：`canvas: null`）。
	*/
	useEffect$1(() => {
		const element = wrapRef.current;
		if (!element) {
			setMeasured({
				w: 0,
				h: 0
			});
			return;
		}
		const apply = () => {
			const rect = element.getBoundingClientRect();
			setMeasured({
				w: Math.round(rect.width),
				h: Math.round(rect.height)
			});
			if (userAdjustedRef.current) return;
			if (rect.width < 4 || rect.height < 4) return;
			fit();
		};
		apply();
		const observer = typeof ResizeObserver === "undefined" ? void 0 : new ResizeObserver(() => apply());
		observer?.observe(element);
		return () => observer?.disconnect();
	}, [fit, layout.placed.length]);
	useEffect$1(() => {
		const svg = svgRef.current;
		if (!svg) return void 0;
		const onWheel = (event) => {
			event.preventDefault();
			userAdjustedRef.current = true;
			const rect = svg.getBoundingClientRect();
			const px = event.clientX - rect.left;
			const py = event.clientY - rect.top;
			setView((prev) => {
				const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
				const k = Math.min(2.5, Math.max(.5, prev.k * factor));
				const ratio = k / prev.k;
				return {
					k,
					tx: px - (px - prev.tx) * ratio,
					ty: py - (py - prev.ty) * ratio
				};
			});
		};
		svg.addEventListener("wheel", onWheel, { passive: false });
		return () => svg.removeEventListener("wheel", onWheel);
	}, []);
	const onPointerDown = (event) => {
		if (event.button !== 0) return;
		dragRef.current = {
			x: event.clientX,
			y: event.clientY,
			tx: view.tx,
			ty: view.ty
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event) => {
		const drag = dragRef.current;
		if (!drag) return;
		userAdjustedRef.current = true;
		setView((prev) => ({
			...prev,
			tx: drag.tx + (event.clientX - drag.x),
			ty: drag.ty + (event.clientY - drag.y)
		}));
	};
	const onPointerUp = (event) => {
		dragRef.current = void 0;
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {}
	};
	const toggleCollapse = (nodeId) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(nodeId)) next.delete(nodeId);
			else next.add(nodeId);
			return next;
		});
	};
	const showHover = (node, event) => {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect) return;
		setHover({
			node,
			x: event.clientX - rect.left + 12,
			y: event.clientY - rect.top + 12
		});
	};
	/**
	* 退化提示：容器**确实**量不到尺寸（宽/高 < 4px）时才走这里。
	*
	* 为什么留着：真遇到宿主布局把面板塞进 0 高度容器时，与其给用户一片空白，
	* 不如明说原因并给一份任务清单。判断依据是 ResizeObserver 的**实测值**，
	* 而不是"挂载那一刻量到 0"（那可能只是还没布局完）。
	*/
	if (measured !== void 0 && (measured.w < 4 || measured.h < 4)) return /* @__PURE__ */ jsx("div", {
		style: styles$1.wrap,
		ref: wrapRef,
		children: /* @__PURE__ */ jsxs("div", {
			style: {
				padding: "12px 16px",
				fontSize: 12,
				lineHeight: 1.7
			},
			children: [
				/* @__PURE__ */ jsx("div", {
					style: {
						fontWeight: 600,
						marginBottom: 4
					},
					children: "画布容器尺寸为 0，无法绘制流程图"
				}),
				/* @__PURE__ */ jsxs("div", {
					style: { opacity: .75 },
					children: [`这是宿主布局问题（面板被放进了没有高度的容器，实测 ${measured.w}×${measured.h}）。`, "已退化为任务清单；节点数据本身是好的。"]
				}),
				/* @__PURE__ */ jsx("ul", {
					style: {
						margin: "8px 0 0 16px",
						padding: 0,
						maxHeight: 320,
						overflow: "auto"
					},
					children: layered.map((node) => /* @__PURE__ */ jsxs("li", {
						style: { opacity: node.derivedState === "done" ? .5 : 1 },
						children: [node.name, /* @__PURE__ */ jsxs("span", {
							style: { opacity: .6 },
							children: [
								" ",
								"· ",
								node.derivedState === "done" ? "已完成" : "未完成",
								node.childCount > 0 ? ` · 未完成 ${node.unfinishedLeafCount}/${node.leafCount}` : ""
							]
						})]
					}, node.id))
				})
			]
		})
	});
	if (layout.placed.length === 0) return /* @__PURE__ */ jsx("div", {
		style: styles$1.wrap,
		ref: wrapRef,
		children: /* @__PURE__ */ jsx("div", {
			style: styles$1.placeholder,
			children: "还没有节点：先「扫描工作区」建一棵草稿树。"
		})
	});
	return /* @__PURE__ */ jsxs("div", {
		style: styles$1.wrap,
		ref: wrapRef,
		children: [
			/* @__PURE__ */ jsx("svg", {
				ref: svgRef,
				style: styles$1.svg,
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onPointerLeave: onPointerUp,
				children: /* @__PURE__ */ jsxs("g", {
					transform: `translate(${view.tx} ${view.ty}) scale(${view.k})`,
					children: [/* @__PURE__ */ jsx("g", { children: layout.edges.map((edge) => {
						const x1 = edge.from.x + layout.nodeWidth / 2;
						const y1 = edge.from.y + layout.nodeHeight;
						const x2 = edge.to.x + layout.nodeWidth / 2;
						const y2 = edge.to.y;
						const midY = (y1 + y2) / 2;
						const dashed = !edge.to.inFocusBranch;
						return /* @__PURE__ */ jsx("path", {
							d: `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`,
							fill: "none",
							stroke: "var(--dsw-alias-border-l2, rgba(128,128,128,0.55))",
							strokeWidth: dashed ? 1 : 1.4,
							strokeDasharray: dashed ? "4 3" : void 0,
							opacity: dashed ? .7 : 1
						}, `${edge.from.node.id}->${edge.to.node.id}`);
					}) }), layout.placed.map((placed) => /* @__PURE__ */ jsx(FlowNode, {
						placed,
						nodeWidth: layout.nodeWidth,
						nodeHeight: layout.nodeHeight,
						selected: selectedId === placed.node.id,
						collapsed: collapsed.has(placed.node.id),
						onSelect,
						onToggleCollapse: toggleCollapse,
						onHover: showHover,
						onLeave: () => setHover(void 0)
					}, placed.node.id))]
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				style: styles$1.toolbar,
				children: [
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: styles$1.toolButton,
						onClick: () => {
							userAdjustedRef.current = true;
							setView((v) => ({
								...v,
								k: Math.min(2.5, v.k * 1.15)
							}));
						},
						children: "放大"
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: styles$1.toolButton,
						onClick: () => {
							userAdjustedRef.current = true;
							setView((v) => ({
								...v,
								k: Math.max(.5, v.k / 1.15)
							}));
						},
						children: "缩小"
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: styles$1.toolButton,
						onClick: () => {
							userAdjustedRef.current = false;
							fit();
						},
						children: "适应视图"
					}),
					/* @__PURE__ */ jsxs("span", {
						style: styles$1.toolHint,
						children: [
							layout.placed.length,
							" 个节点 · 滚轮缩放 / 拖拽平移 / 点圆点折叠",
							clipped ? " · 图较宽：已对准根节点，可拖拽浏览" : ""
						]
					})
				]
			}),
			hover ? /* @__PURE__ */ jsxs("div", {
				style: {
					...styles$1.tooltip,
					left: hover.x,
					top: hover.y
				},
				children: [/* @__PURE__ */ jsx("div", {
					style: styles$1.tooltipTitle,
					children: hover.node.name
				}), /* @__PURE__ */ jsx("div", {
					style: styles$1.tooltipBody,
					children: nodeRowTitle(hover.node)
				})]
			}) : null
		]
	});
}
/** 单个节点：两层编码的落点（第一层=边框，第二层=填充/角标/外发光）。 */
function FlowNode(props) {
	const { placed, nodeWidth, nodeHeight } = props;
	const node = placed.node;
	const isLeaf = node.childCount === 0;
	const done = node.derivedState === "done";
	const stateColor = DERIVED_STATE_COLOR[node.derivedState] ?? "#9aa4b2";
	const fill = done ? "rgba(34,197,94,0.14)" : STATE_FILL[node.derivedState] ?? `${hexToRgba(stateColor, .14)}`;
	const borderColor = done ? "#22c55e" : stateColor;
	const badge = STATE_BADGE[node.derivedState];
	const innerWidth = nodeWidth - 20;
	const progressWidth = Math.max(0, Math.min(1, node.progress)) * innerWidth;
	return /* @__PURE__ */ jsxs("g", {
		transform: `translate(${placed.x} ${placed.y})`,
		style: {
			cursor: "pointer",
			opacity: placed.inFocusBranch ? 1 : .58,
			filter: node.focus ? "drop-shadow(0 0 5px rgba(59,130,246,0.9))" : props.selected ? "drop-shadow(0 0 4px rgba(148,163,184,0.9))" : void 0
		},
		onClick: () => props.onSelect(node.id),
		onMouseMove: (event) => props.onHover(node, event),
		onMouseLeave: props.onLeave,
		children: [
			/* @__PURE__ */ jsx("title", { children: nodeRowTitle(node) }),
			/* @__PURE__ */ jsx("rect", {
				width: nodeWidth,
				height: nodeHeight,
				rx: 7,
				fill,
				stroke: props.selected ? "#2563eb" : borderColor,
				strokeWidth: props.selected ? 2 : 1.2,
				strokeDasharray: isLeaf ? void 0 : done ? void 0 : "5 3"
			}),
			node.derivedState === "running" ? /* @__PURE__ */ jsx("rect", {
				width: nodeWidth,
				height: nodeHeight,
				rx: 7,
				fill: `${hexToRgba("#3b82f6", .12)}`,
				stroke: "none"
			}) : null,
			/* @__PURE__ */ jsx("text", {
				x: 10,
				y: 18,
				fontSize: 11.5,
				fontWeight: 600,
				fill: "var(--dsw-alias-text-primary, #111)",
				children: clipLabel(node.name, isLeaf ? 14 : 12)
			}),
			/* @__PURE__ */ jsx("text", {
				x: nodeWidth - 8,
				y: 14,
				fontSize: 10,
				textAnchor: "end",
				fill: borderColor,
				children: [
					node.focus ? "◆" : "",
					badge ?? "",
					node.addedMidway ? "+" : "",
					node.autoCreated ? "A" : "",
					node.flags.includes("rolledBack") ? "↺" : ""
				].filter((token) => token !== "").join(" ")
			}),
			/* @__PURE__ */ jsx("rect", {
				x: 10,
				y: nodeHeight - 22,
				width: innerWidth,
				height: 5,
				rx: 2.5,
				fill: "rgba(128,128,128,0.22)"
			}),
			/* @__PURE__ */ jsx("rect", {
				x: 10,
				y: nodeHeight - 22,
				width: progressWidth,
				height: 5,
				rx: 2.5,
				fill: done ? "#22c55e" : stateColor
			}),
			/* @__PURE__ */ jsx("text", {
				x: 10,
				y: nodeHeight - 7,
				fontSize: 9.5,
				fill: "var(--dsw-alias-text-secondary, #555)",
				children: isLeaf ? `${Math.round(node.progress * 100)}%` : `未完成 ${node.unfinishedLeafCount}/${node.leafCount}`
			}),
			isLeaf && !done ? /* @__PURE__ */ jsx("rect", {
				x: nodeWidth - 13,
				y: nodeHeight - 11,
				width: 6,
				height: 6,
				fill: "none",
				stroke: stateColor,
				strokeWidth: 1.2
			}) : null,
			node.childCount > 0 ? /* @__PURE__ */ jsxs("g", {
				transform: `translate(${nodeWidth / 2} ${nodeHeight})`,
				onClick: (event) => {
					event.stopPropagation();
					props.onToggleCollapse(node.id);
				},
				children: [/* @__PURE__ */ jsx("circle", {
					r: 7,
					fill: "var(--dsw-alias-bg-primary, #fff)",
					stroke: borderColor,
					strokeWidth: 1
				}), /* @__PURE__ */ jsx("text", {
					y: 3.5,
					fontSize: 9,
					textAnchor: "middle",
					fill: borderColor,
					children: props.collapsed ? "▸" : "▾"
				})]
			}) : null
		]
	});
}
/** `#rrggbb` → `rgba(...)`（状态色来自 `api.ts` 的固定表，一定是 6 位十六进制）。 */
function hexToRgba(hex, alpha) {
	const value = hex.replace("#", "");
	return `rgba(${Number.parseInt(value.slice(0, 2), 16)},${Number.parseInt(value.slice(2, 4), 16)},${Number.parseInt(value.slice(4, 6), 16)},${alpha})`;
}
const styles$1 = {
	wrap: {
		position: "relative",
		flex: "1 1 auto",
		minHeight: 280,
		borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))",
		borderBottom: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))",
		overflow: "hidden",
		background: "radial-gradient(circle at 1px 1px, rgba(128,128,128,0.18) 1px, transparent 0) 0 0 / 22px 22px"
	},
	svg: {
		width: "100%",
		height: "100%",
		display: "block",
		touchAction: "none"
	},
	placeholder: {
		padding: 24,
		fontSize: 12,
		opacity: .7,
		textAlign: "center"
	},
	toolbar: {
		position: "absolute",
		right: 8,
		top: 8,
		display: "flex",
		gap: 6,
		alignItems: "center",
		background: "var(--dsw-alias-bg-primary, rgba(255,255,255,0.86))",
		border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))",
		borderRadius: 6,
		padding: "4px 6px"
	},
	toolButton: {
		fontSize: 11,
		padding: "2px 7px",
		borderRadius: 4,
		border: "0.5px solid currentColor",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	toolHint: {
		fontSize: 10,
		opacity: .6,
		marginLeft: 2
	},
	tooltip: {
		position: "absolute",
		maxWidth: 320,
		padding: "6px 8px",
		borderRadius: 6,
		background: "var(--dsw-alias-bg-primary, rgba(20,20,20,0.92))",
		color: "var(--dsw-alias-text-primary, #fff)",
		border: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))",
		fontSize: 11,
		lineHeight: 1.5,
		pointerEvents: "none",
		whiteSpace: "pre-line",
		zIndex: 5
	},
	tooltipTitle: {
		fontWeight: 600,
		marginBottom: 2
	},
	tooltipBody: {
		opacity: .85,
		fontSize: 10.5
	}
};
//#endregion
//#region ../src/client/board-panel.tsx
/**
* 主面板：项目进度看板（三段式，§11.1）。
*
* 三段：① 标题看板（只有百分比与计数）② **流程图**（`FlowCanvas`）③ 状态条（可折叠）。
* 未完成列表（FR-35）常驻看板下方但默认折叠 —— 中间那一段必须是图，不是清单。
*
* 数据来自宿主 HTTP 路由（`/pm/board`），按刷新间隔轮询；
* 面板不持有权威状态，只做呈现（§12.4：事实源在宿主）。
*/
const { useCallback, useEffect, useMemo, useRef, useState } = React$1;
/**
* 局部错误边界：**把"空白"变成"看得见的报错"**。
*
* 为什么必须有：槽位错误边界只会在主区域留下一个空 div（`data-slot-error`），
* 用户看到的就是"点开一片空白"，既不知道该刷新还是该反馈。
* 这里兜住画布的渲染异常，退化成一条可读的错误 + 说明，并上报到宿主诊断。
*/
var CanvasBoundary = class extends React$1.Component {
	constructor(props) {
		super(props);
		this.state = { failure: void 0 };
	}
	static getDerivedStateFromError(error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
	componentDidCatch(error) {
		this.props.onError(error);
	}
	render() {
		if (this.state.failure !== void 0) return React$1.createElement("div", { style: {
			padding: 16,
			fontSize: 12,
			lineHeight: 1.7
		} }, React$1.createElement("div", { style: {
			fontWeight: 600,
			marginBottom: 4
		} }, "流程图渲染失败"), React$1.createElement("div", { style: { opacity: .8 } }, this.state.failure), React$1.createElement("div", { style: {
			opacity: .7,
			marginTop: 6
		} }, "看板数据仍然是好的：可展开上方「未完成 N 项」列表继续用；这个错误已上报宿主，可在 /pm/debug 的「客户端 bundle」里查看堆栈。"));
		return this.props.children;
	}
};
/** 选择当前会话 id。 */
function selectCurrentSession(state) {
	return state.current;
}
/**
* 标准源缺失时的替身：不订阅、恒返回 undefined。
*
* 这里仍然调用一个 Hook（`useState`），是为了让 Hook 调用**次数**在
* "标准源出现/消失"时保持一致——渲染器缓存了 standard kit，
* 正常不会变，但保持次数稳定能避免潜在的 Hook 顺序问题。
*/
function useAbsentSessions(_selector) {
	useState(void 0);
}
const styles = {
	root: {
		display: "flex",
		flexDirection: "column",
		minHeight: "100%",
		fontSize: 13,
		color: "var(--dsw-alias-text-primary, inherit)"
	},
	board: {
		padding: "12px 16px",
		borderBottom: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))",
		display: "flex",
		flexDirection: "column",
		gap: 8
	},
	titleRow: {
		display: "flex",
		alignItems: "baseline",
		gap: 12,
		flexWrap: "wrap"
	},
	projectName: {
		fontSize: 15,
		fontWeight: 600
	},
	metrics: {
		display: "flex",
		gap: 20,
		flexWrap: "wrap"
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 2
	},
	metricLabel: {
		fontSize: 11,
		opacity: .65
	},
	metricValue: {
		fontSize: 18,
		fontWeight: 600,
		fontVariantNumeric: "tabular-nums"
	},
	band: {
		display: "flex",
		gap: 1,
		height: 10,
		alignItems: "stretch",
		marginTop: 2
	},
	bandCell: {
		width: 4,
		borderRadius: 1
	},
	body: {
		flex: 1,
		minHeight: 0,
		overflow: "auto",
		padding: "8px 16px 24px"
	},
	/** 空工作区引导（无树时占据流程图那一段）。 */
	emptyWrap: {
		flex: 1,
		minHeight: 0,
		overflow: "auto",
		padding: "12px 16px 24px"
	},
	/** 未完成列表（FR-35）：常驻看板下方，但默认折叠，避免把流程图挤出视野。 */
	listBox: {
		maxHeight: 190,
		overflow: "auto",
		marginTop: 6,
		borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))",
		paddingTop: 4
	},
	rowSelected: {
		background: "rgba(37,99,235,0.14)",
		borderRadius: 4
	},
	selectionBar: {
		display: "flex",
		gap: 8,
		alignItems: "center",
		marginTop: 6,
		paddingTop: 6,
		borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))"
	},
	confirmBox: {
		marginTop: 6,
		padding: "8px 10px",
		borderRadius: 4,
		fontSize: 12,
		background: "rgba(239,68,68,0.10)",
		border: "0.5px solid rgba(239,68,68,0.5)"
	},
	toggleLabel: {
		fontSize: 11,
		display: "flex",
		alignItems: "center",
		gap: 3,
		opacity: .8
	},
	headerButton: {
		fontSize: 11,
		padding: "2px 8px",
		borderRadius: 4,
		border: "0.5px solid currentColor",
		background: "transparent",
		color: "inherit",
		cursor: "pointer"
	},
	statusBar: {
		borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))",
		background: "var(--dsw-alias-bg-secondary, transparent)"
	},
	statusToggle: {
		width: "100%",
		textAlign: "left",
		fontSize: 11,
		padding: "5px 12px",
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		display: "flex",
		gap: 8,
		alignItems: "center"
	},
	statusBadge: {
		fontSize: 10,
		padding: "0 5px",
		borderRadius: 8,
		border: "0.5px solid currentColor",
		opacity: .85
	},
	statusBody: {
		maxHeight: 200,
		overflow: "auto"
	},
	sectionTitle: {
		fontSize: 12,
		fontWeight: 600,
		margin: "16px 0 6px",
		opacity: .8
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "5px 6px",
		borderRadius: 4,
		lineHeight: 1.5
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		flex: "0 0 auto"
	},
	rowName: {
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	badge: {
		fontSize: 10,
		padding: "1px 5px",
		borderRadius: 8,
		border: "0.5px solid currentColor",
		opacity: .85,
		flex: "0 0 auto"
	},
	note: {
		fontSize: 11,
		opacity: .7,
		lineHeight: 1.6
	},
	warn: {
		fontSize: 12,
		padding: "6px 10px",
		borderRadius: 4,
		background: "rgba(245,158,11,0.12)",
		border: "0.5px solid rgba(245,158,11,0.5)"
	},
	error: {
		fontSize: 12,
		padding: "6px 10px",
		borderRadius: 4,
		background: "rgba(239,68,68,0.12)",
		border: "0.5px solid rgba(239,68,68,0.5)"
	},
	empty: {
		padding: 24,
		textAlign: "center",
		opacity: .7,
		lineHeight: 1.8
	}
};
/**
* 轮询看板数据。面板是"只读投影"，因此轮询足够，无需长连接。
*
* @param intervalMs - 轮询间隔（毫秒，下限 500）。
* @param sessionId - 当前会话 id；带上它宿主才能把工作区根精确解析到该会话的工作区。
*/
function useBoardData(intervalMs, sessionId) {
	const [board, setBoard] = useState(void 0);
	const [error, setError] = useState(void 0);
	const inFlight = useRef(false);
	useEffect(() => {
		setBoard(void 0);
	}, [sessionId]);
	const refresh = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		fetchBoard(void 0, sessionId).then((outcome) => {
			if (outcome.ok && outcome.value) {
				setBoard(outcome.value);
				setError(void 0);
			} else setError(outcome.error ?? "未知错误");
		}).finally(() => {
			inFlight.current = false;
		});
	}, [sessionId]);
	useEffect(() => {
		refresh();
		const timer = window.setInterval(refresh, Math.max(500, intervalMs));
		return () => window.clearInterval(timer);
	}, [refresh, intervalMs]);
	return {
		board,
		error,
		refresh
	};
}
/**
* 面板外壳：只负责"取数据"，渲染全部交给 {@link BoardView}。
*
* 拆开的原因（实测踩过）：整块逻辑挤在一起时，`board` 还没到就崩不出来的 bug
* （TDZ）在自检里根本覆盖不到 —— 因为自检没法给组件喂假数据。
* 现在 `BoardView` 只吃 props，自检可以直接把"有数据的看板"喂进去，
* 于是"拿到数据就崩"这类问题在 `pnpm run verify` 就会被挡住。
*/
function BoardPanel(props) {
	const sessionId = (props.useSessions ?? useAbsentSessions)(selectCurrentSession);
	const { board, error, refresh } = useBoardData(props.intervalMs ?? 1e3, sessionId);
	return React$1.createElement(BoardView, {
		board,
		error,
		refresh,
		sessionId
	});
}
/** 纯呈现：三段式布局（FR-40）+ 交互状态。不取数据，因此可被自检直接渲染。 */
function BoardView(props) {
	const { board, error, refresh, sessionId } = props;
	const empty = board !== void 0 && board.nodes.length === 0;
	const [showList, setShowList] = useState(false);
	const [hideDone, setHideDone] = useState(false);
	const [showStatus, setShowStatus] = useState(false);
	const [selectedId, setSelectedId] = useState(void 0);
	const selectedNode = board?.nodes.find((node) => node.id === selectedId);
	/** 删除确认框（FR-57 的面板路径）：先 preview，用户在面板内确认后才落库。 */
	const [removePrompt, setRemovePrompt] = useState(void 0);
	const [removeError, setRemoveError] = useState(void 0);
	const selectNode = useCallback((nodeId) => {
		setSelectedId(nodeId);
		setShowList(true);
		window.requestAnimationFrame(() => {
			document.getElementById(`pm-row-${nodeId}`)?.scrollIntoView({ block: "nearest" });
		});
	}, []);
	/** 第一步：拿删除影响范围（不落库）。 */
	const askRemove = useCallback((nodeId) => {
		setRemoveError(void 0);
		postRemoveBranch({
			nodeId,
			policy: "record",
			confirm: false
		}).then((outcome) => {
			if (!outcome.ok || !outcome.value) {
				setRemoveError(outcome.error ?? "未知错误");
				return;
			}
			if (outcome.value.status === "needs-confirm") {
				setRemovePrompt({
					nodeId,
					preview: outcome.value.preview
				});
				return;
			}
			if (outcome.value.status === "denied") setRemoveError(outcome.value.message ?? outcome.value.reason ?? "被拒绝");
		});
	}, []);
	/** 第二步：用户在面板内确认后执行。 */
	const confirmRemove = useCallback(() => {
		if (!removePrompt) return;
		postRemoveBranch({
			nodeId: removePrompt.nodeId,
			policy: "record",
			confirm: true
		}).then((outcome) => {
			if (!outcome.ok || !outcome.value) {
				setRemoveError(outcome.error ?? "未知错误");
				return;
			}
			if (outcome.value.status === "denied") {
				setRemoveError(outcome.value.message ?? outcome.value.reason ?? "被拒绝");
				return;
			}
			setRemovePrompt(void 0);
			setSelectedId(void 0);
			refresh();
		});
	}, [removePrompt, refresh]);
	/** ③ 状态条内容：冲突 / 降级 / 文档 / 外部改动 + 图例与口径。 */
	const status = useMemo(() => {
		if (!board) return null;
		return React$1.createElement("div", { style: { padding: "8px 16px 16px" } }, board.externalChange ? React$1.createElement("div", { style: {
			...styles.warn,
			marginBottom: 8
		} }, `外部改动：${board.externalChange.path}（${board.externalChange.kind === "document-changed" ? board.externalChange.documentLegal === false ? "文档已不合法" : "文档仍合法" : board.externalChange.kind === "handoff-changed" ? "交接文档变动" : "事实源区域变动"}）`, React$1.createElement("div", { style: styles.note }, "文档只是投影：外部改动不会被读成权威值，节点一律以事实源为准。需要收敛时用 pm_doc_check（write=true）重新投影。")) : null, board.conflicts.length > 0 ? React$1.createElement("div", { style: {
			...styles.error,
			marginBottom: 8
		} }, `⚠ ${board.conflicts.length} 个待仲裁冲突：`, board.conflicts.map((c) => ` ${c.code}@${c.nodeId || "?"}`).join("、")) : null, board.degradation.length > 0 ? React$1.createElement("div", { style: {
			...styles.warn,
			marginBottom: 8
		} }, "降级项：", React$1.createElement("ul", { style: {
			margin: "4px 0 0 16px",
			padding: 0
		} }, board.degradation.map((item, index) => React$1.createElement("li", { key: index }, item)))) : null, !board.document.legal ? React$1.createElement("div", { style: {
			...styles.warn,
			marginBottom: 8
		} }, `文档 ${board.document.path} ${board.document.exists ? "不合法" : "尚未生成"}：`, board.document.violations.length > 0 ? React$1.createElement("ul", { style: {
			margin: "4px 0 0 16px",
			padding: 0
		} }, board.document.violations.slice(0, 6).map((v, index) => React$1.createElement("li", { key: index }, v))) : null) : null, React$1.createElement("div", { style: styles.sectionTitle }, "图例与口径"), React$1.createElement("div", { style: styles.note }, `整体口径：${formatBasis(board.overall)}；快照档位：${board.snapshot.mode}（${board.snapshot.reason}）`, React$1.createElement("br"), board.overall.structuralDegenerate === true ? React$1.createElement("span", null, "⚠ 结构上没有任何区分度（零 token 路径没拿到文件数/行数差异）→ 本页数字等同于按件数，已按「按件数·无结构数据」标注。", React$1.createElement("br")) : null, "流程图编码：**边框**表示完成态（虚线枝=还有未完成叶节点、空心方点=未完成叶节点、绿实线+勾=已完成），", "**填充/角标/外发光**表示具体状态（▶ 进行中、! 异常、Ⅱ 暂停、⛔ 拦停、◆ 关注、+ 中途新增、A 自动建出、↺ 已回滚）；", "旁枝（未关注）降饱和并以虚线连接。悬停任一节点可看权重依据。", React$1.createElement("br"), `确认通道：${board.confirmChannel}`, React$1.createElement("br"), "本看板只给百分比与未完成计数，不提供\"还需多久\"的周期估算。"));
	}, [board]);
	/** 未完成列表（FR-35/36）：常驻看板下方，默认折叠。 */
	const list = useMemo(() => {
		if (!board) return null;
		if (board.unfinished.length === 0) return React$1.createElement("div", { style: {
			...styles.note,
			padding: "0 16px 8px"
		} }, "所有叶节点都已完成。");
		return React$1.createElement("div", { style: styles.listBox }, board.unfinished.map((node) => React$1.createElement("div", {
			key: node.id,
			id: `pm-row-${node.id}`,
			style: {
				...styles.row,
				...selectedId === node.id ? styles.rowSelected : {}
			},
			onClick: () => setSelectedId(node.id)
		}, React$1.createElement("span", { style: {
			...styles.dot,
			background: DERIVED_STATE_COLOR[node.derivedState] ?? "#999"
		} }), React$1.createElement("span", {
			style: styles.rowName,
			title: nodeRowTitle(node)
		}, nodeRowLabel(node)), node.focus ? React$1.createElement("span", { style: styles.badge }, "关注") : null, node.addedMidway ? React$1.createElement("span", { style: styles.badge }, "中途新增") : null, node.autoCreated ? React$1.createElement("span", { style: styles.badge }, "自动") : null, node.subscriptionCount > 0 ? React$1.createElement("span", { style: styles.badge }, `订阅 ${node.subscriptionCount}`) : null, React$1.createElement("span", { style: styles.badge }, DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState), React$1.createElement("span", { style: {
			...styles.note,
			fontVariantNumeric: "tabular-nums"
		} }, `${Math.round(node.progress * 100)}%`))));
	}, [board, selectedId]);
	return React$1.createElement("div", { style: styles.root }, React$1.createElement("div", { style: styles.board }, React$1.createElement("div", { style: styles.titleRow }, React$1.createElement("span", { style: styles.projectName }, board?.projectName ?? "项目进度"), React$1.createElement("label", {
		style: styles.toggleLabel,
		title: "只看未完成：把已完成节点从图中滤掉（FR-48）"
	}, React$1.createElement("input", {
		type: "checkbox",
		checked: hideDone,
		onChange: (event) => setHideDone(event.target.checked)
	}), "只看未完成"), React$1.createElement("button", {
		type: "button",
		onClick: () => setShowList((prev) => !prev),
		style: styles.headerButton
	}, `未完成 ${board?.unfinished.length ?? 0} 项 ${showList ? "▾" : "▸"}`), React$1.createElement("button", {
		type: "button",
		onClick: refresh,
		style: styles.headerButton
	}, "刷新")), React$1.createElement("div", {
		style: {
			...styles.note,
			marginTop: 2
		},
		title: sessionId ? `会话 ${sessionId}` : "未拿到当前会话"
	}, board?.workspaceRoot.value ? `工作区：${board.workspaceRoot.value}（来源：${board.workspaceRoot.source}）` : "工作区：未解析到（面板不会读任何目录）"), React$1.createElement("div", { style: {
		...styles.note,
		opacity: .55
	} }, `面板 v${typeof __PM_VERSION__ === "string" ? __PM_VERSION__ : "dev"} · ${board ? `${board.nodes.length} 个节点 / ${board.overall.unfinishedLeaves} 个未完成` : "正在读取…"} · 口径 ${formatBasis(board?.overall)}`), error ? React$1.createElement("div", { style: styles.error }, `数据通道不可用：${error}（宿主 HTTP 路由 /pm 未注册时会出现这种情况）`) : null, React$1.createElement("div", { style: styles.metrics }, metric("整体完成度", formatPercent(board?.overall), formatCounts(board?.overall)), metric("关注枝", formatPercent(board?.focused), formatCounts(board?.focused)), metric("未完成叶节点", board ? String(board.overall.unfinishedLeaves) : "—", ""), metric("进行中", board ? String(board.overall.runningNodes) : "—", ""), metric("异常", board ? String(board.overall.errorNodes) : "—", "")), board && board.scanBand.length > 0 ? React$1.createElement("div", {
		style: styles.band,
		title: "未完成扫描带：每根竖条 = 一个叶节点，颜色 = 其计算状态；点击定位"
	}, board.scanBand.map((cell) => React$1.createElement("span", {
		key: cell.nodeId,
		style: {
			...styles.bandCell,
			background: DERIVED_STATE_COLOR[cell.derivedState] ?? "#999",
			opacity: cell.derivedState === "done" ? .35 : 1,
			outline: cell.isFocus ? "1px solid currentColor" : "none"
		},
		title: `${cell.name} · ${DERIVED_STATE_LABEL[cell.derivedState] ?? cell.derivedState}`,
		onClick: () => selectNode(cell.nodeId)
	}))) : null, showList ? list : null, selectedNode ? React$1.createElement("div", { style: styles.selectionBar }, React$1.createElement("span", { style: { fontSize: 11 } }, `已选：${selectedNode.name}`), React$1.createElement("button", {
		type: "button",
		style: styles.headerButton,
		onClick: () => askRemove(selectedNode.id),
		title: "删除该节点及其全部子孙（仅删记录，不动代码）"
	}, "删除整枝…"), React$1.createElement("button", {
		type: "button",
		style: styles.headerButton,
		onClick: () => setSelectedId(void 0)
	}, "取消选择")) : null, removePrompt ? React$1.createElement("div", { style: { ...styles.confirmBox } }, React$1.createElement("div", { style: {
		fontWeight: 600,
		marginBottom: 4
	} }, "确认删除整枝？"), React$1.createElement("div", { style: {
		...styles.note,
		whiteSpace: "pre-line"
	} }, removePrompt.preview), React$1.createElement("div", { style: {
		display: "flex",
		gap: 8,
		marginTop: 8
	} }, React$1.createElement("button", {
		type: "button",
		style: styles.headerButton,
		onClick: confirmRemove
	}, "确认删除（仅删记录）"), React$1.createElement("button", {
		type: "button",
		style: styles.headerButton,
		onClick: () => setRemovePrompt(void 0)
	}, "取消"))) : null, removeError ? React$1.createElement("div", { style: {
		...styles.error,
		marginTop: 6
	} }, removeError) : null), error && !board ? React$1.createElement("div", { style: styles.empty }, "无法读取看板数据。", React$1.createElement("br"), React$1.createElement("span", { style: styles.note }, "宿主 HTTP 路由 /pm 未注册时会出现这种情况。")) : !board ? React$1.createElement("div", { style: styles.empty }, "正在读取看板数据…", React$1.createElement("br"), React$1.createElement("span", { style: styles.note }, "首次加载需要宿主完成能力探测与项目初始化。")) : empty ? React$1.createElement("div", { style: styles.emptyWrap }, React$1.createElement(EmptyState, {
		onApplied: refresh,
		...sessionId ? { sessionId } : {}
	}), board.workspaceRoot.value === null ? React$1.createElement("div", { style: {
		...styles.error,
		marginTop: 8
	} }, "没有解析到工作区根：看板读不到也不该读任何工作区数据。", React$1.createElement("div", { style: styles.note }, `来源=${board.workspaceRoot.source}；${board.workspaceRoot.detail}`)) : null) : React$1.createElement(CanvasBoundary, { onError: (error) => reportClient({
		panelId: "project-manager",
		bundleId: "dsh-project-manager",
		registeredSlots: [],
		error: {
			kind: "canvas-render",
			message: error.message,
			...error.stack !== void 0 ? { stack: error.stack } : {}
		}
	}) }, React$1.createElement(FlowCanvas, {
		nodes: board.nodes,
		selectedId,
		onSelect: selectNode,
		hideDone
	})), React$1.createElement("div", { style: styles.statusBar }, React$1.createElement("button", {
		type: "button",
		onClick: () => setShowStatus((prev) => !prev),
		style: styles.statusToggle
	}, `状态与口径 ${showStatus ? "▾" : "▸"}`, board && board.conflicts.length > 0 ? React$1.createElement("span", { style: styles.statusBadge }, `${board.conflicts.length} 冲突`) : null, board && board.degradation.length > 0 ? React$1.createElement("span", { style: styles.statusBadge }, `${board.degradation.length} 降级`) : null, board && !board.document.legal ? React$1.createElement("span", { style: styles.statusBadge }, "文档未生成") : null), showStatus ? React$1.createElement("div", { style: styles.statusBody }, status) : null));
}
function metric(label, value, sub) {
	return React$1.createElement("div", { style: styles.metric }, React$1.createElement("span", { style: styles.metricLabel }, label), React$1.createElement("span", { style: styles.metricValue }, value), sub ? React$1.createElement("span", { style: styles.metricLabel }, sub) : null);
}
/**
* 空工作区引导（FR-38：检测到无项目树时进入引导式扫描，而不是显示空白页）。
*
* 两阶段严格分开（§6.4b）：
* ①「扫描」= 零 token 骨架，立即出建议（FR-39a/39c）；
* ②「建树」= 把建议落库；AI 建树是**后续**阶段 B，本面板不触发（避免误花 token）。
*/
function EmptyState(props) {
	const [phase, setPhase] = useState("idle");
	const [preview, setPreview] = useState(void 0);
	const [message, setMessage] = useState(void 0);
	const [failure, setFailure] = useState(void 0);
	const doScan = useCallback(() => {
		setPhase("scanning");
		setFailure(void 0);
		setMessage(void 0);
		postScan(void 0, props.sessionId).then((outcome) => {
			setPhase("idle");
			if (!outcome.ok || !outcome.value) {
				setFailure(outcome.error ?? "未知错误");
				return;
			}
			if (!outcome.value.available) {
				setFailure(outcome.value.reason ?? "扫描不可用");
				return;
			}
			setPreview(outcome.value);
		});
	}, [props.sessionId]);
	const doApply = useCallback(() => {
		if (!preview) return;
		setPhase("applying");
		setFailure(void 0);
		postScanApply({
			nodes: preview.nodes,
			projectName: preview.projectName
		}, void 0, props.sessionId).then((outcome) => {
			setPhase("idle");
			if (!outcome.ok || !outcome.value) {
				setFailure(outcome.error ?? "未知错误");
				return;
			}
			setMessage(`已建树：新建 ${outcome.value.created} 个节点，跳过 ${outcome.value.skipped} 个（幂等去重）` + (outcome.value.failures.length > 0 ? `，失败 ${outcome.value.failures.length} 个` : ""));
			props.onApplied();
		});
	}, [preview, props]);
	return React$1.createElement("div", { style: {
		...styles.warn,
		marginBottom: 12
	} }, React$1.createElement("div", { style: {
		fontWeight: 600,
		marginBottom: 4
	} }, "这个工作区还没有项目树"), React$1.createElement("div", { style: styles.note }, "第一步先做**零 token 骨架扫描**：只看文件树与 package.json / README 等关键文件，", "不调用任何 AI，因此不花 token。扫描结果是一份\"草稿树\"，确认后再落库。"), React$1.createElement("div", { style: {
		display: "flex",
		gap: 8,
		marginTop: 8,
		flexWrap: "wrap"
	} }, React$1.createElement("button", {
		type: "button",
		onClick: doScan,
		disabled: phase !== "idle",
		style: buttonStyle(phase === "idle")
	}, phase === "scanning" ? "扫描中…" : preview ? "重新扫描" : "扫描工作区"), preview ? React$1.createElement("button", {
		type: "button",
		onClick: doApply,
		disabled: phase !== "idle",
		style: buttonStyle(phase === "idle")
	}, phase === "applying" ? "建树中…" : `建树（${preview.nodes.length} 个节点）`) : null), preview ? React$1.createElement("div", { style: { marginTop: 8 } }, React$1.createElement("div", { style: styles.note }, `扫描到 ${preview.scanned} 个条目，跳过 ${preview.skipped} 个，建议 ${preview.nodes.length} 个节点` + (preview.truncated ? "（已截断）" : "")), React$1.createElement("div", { style: {
		...styles.note,
		marginTop: 4
	} }, "前几个建议：", preview.nodes.slice(0, 8).map((n) => n.name).join("、")), preview.notes.length > 0 ? React$1.createElement("ul", { style: {
		margin: "4px 0 0 16px",
		padding: 0,
		...styles.note
	} }, preview.notes.map((note, index) => React$1.createElement("li", { key: index }, note))) : null) : null, message ? React$1.createElement("div", { style: {
		...styles.note,
		marginTop: 6
	} }, message) : null, failure ? React$1.createElement("div", { style: {
		...styles.error,
		marginTop: 6
	} }, failure) : null, React$1.createElement("div", { style: {
		...styles.note,
		marginTop: 8
	} }, "提醒：扫描是抽样与推断，不保证任务清单完整；自动建出的节点带「自动」角标。", "需要 AI 细化时，请显式在会话里要求（那一步会消耗 token）。"));
}
function buttonStyle(enabled) {
	return {
		fontSize: 12,
		padding: "3px 10px",
		borderRadius: 4,
		border: "0.5px solid currentColor",
		background: "transparent",
		color: "inherit",
		cursor: enabled ? "pointer" : "not-allowed",
		opacity: enabled ? 1 : .5
	};
}
//#endregion
//#region render-check.tsx
/**
* 面板渲染自检（提交进仓库，`pnpm run verify` 会跑）。
*
* **为什么必须有**：`data-slot-error="main"`（点击面板一片空白）这类故障，
* 只有在"组件真的拿到数据渲染"时才暴露。之前的临时 SSR 只渲染了 `board === undefined`
* 的加载态，于是 `board?.nodes.find(...)` 里的 TDZ（`Cannot access 'selectedId'
* before initialization`）完全没被发现 —— 用户点开就是空白（实测踩过）。
*
* 做法：用 SSR（`react-dom/server`）把组件在**两种状态下**都渲染一遍：
* ① 加载态（board 未到）；② 有数据态（画布 + 看板 + 列表全部走一遍）。
* 任何 render 期异常都会让本脚本非零退出。
*
* 说明：这里刻意用 `React.createElement`，避免为自检再引入一套 JSX 构建。
*/
/** 造一个"有数据"的看板快照（含枝/叶混合、关注、进行中、异常等状态）。 */
function fakeBoard() {
	const node = (partial) => ({
		parentId: null,
		kind: "task",
		selfState: "pending",
		derivedState: "pending",
		progress: 0,
		weight: 1,
		focus: false,
		gate: null,
		flags: [],
		autoCreated: true,
		childCount: 0,
		leafCount: 1,
		unfinishedLeafCount: 1,
		blockedBy: [],
		revision: 1,
		updatedAt: "2026-09-23T00:00:00Z",
		updatedBy: "user",
		addedMidway: false,
		subscriptionCount: 0,
		branchPath: [],
		...partial
	});
	const nodes = [
		node({
			id: "root",
			name: "示例项目",
			kind: "feature",
			childCount: 2,
			leafCount: 3,
			unfinishedLeafCount: 2
		}),
		node({
			id: "a",
			name: "前端",
			parentId: "root",
			kind: "feature",
			childCount: 2,
			leafCount: 2,
			unfinishedLeafCount: 1,
			focus: true
		}),
		node({
			id: "a1",
			name: "登录页",
			parentId: "a",
			derivedState: "running",
			progress: .4,
			focus: true
		}),
		node({
			id: "a2",
			name: "好友列表",
			parentId: "a",
			derivedState: "done",
			progress: 1,
			focus: true,
			branchPath: ["前端"]
		}),
		node({
			id: "b",
			name: "服务端",
			parentId: "root",
			kind: "feature",
			childCount: 1,
			leafCount: 1,
			unfinishedLeafCount: 1
		}),
		node({
			id: "b1",
			name: "消息推送",
			parentId: "b",
			derivedState: "error",
			progress: .2,
			flags: ["addedMidway"]
		})
	];
	return {
		projectId: "pm_test",
		projectName: "示例项目",
		nodes,
		overall: {
			ratio: .4,
			basis: "count",
			doneLeaves: 1,
			unfinishedLeaves: 2,
			totalLeaves: 3,
			runningNodes: 1,
			errorNodes: 1
		},
		focused: {
			ratio: .5,
			basis: "count",
			doneLeaves: 1,
			unfinishedLeaves: 1,
			totalLeaves: 2,
			runningNodes: 1,
			errorNodes: 0
		},
		focusedRootIds: ["a"],
		unfinished: [nodes[2], nodes[5]],
		conflicts: [],
		scanBand: nodes.filter((n) => n.childCount === 0).map((n) => ({
			nodeId: n.id,
			name: n.name,
			derivedState: n.derivedState,
			isFocus: n.focus
		})),
		degradation: [],
		snapshot: {
			mode: "patch",
			reason: "测试"
		},
		confirmChannel: "未装配（自检）",
		document: {
			path: "project-manager.md",
			exists: false,
			legal: false,
			violations: []
		},
		dataFormat: 1,
		externalChange: null,
		watchTargets: [],
		workspaceRoot: {
			value: "Z:\\demo",
			source: "tool-call",
			detail: "自检"
		}
	};
}
const failures = [];
function check(label, render, expectText) {
	try {
		const html = render();
		if (html.length < 50) {
			failures.push(`${label}：渲染结果过短（${html.length} 字节）`);
			return;
		}
		if (expectText !== void 0 && !html.includes(expectText)) {
			failures.push(`${label}：渲染结果里没有「${expectText}」`);
			return;
		}
		console.log(`✔ ${label}（${html.length} 字节）`);
	} catch (error) {
		failures.push(`${label} 渲染抛错：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	}
}
const board = fakeBoard();
check("FlowCanvas（有数据）", () => renderToStaticMarkup(React$1.createElement(FlowCanvas, {
	nodes: board.nodes,
	onSelect: () => {}
})), "示例项目");
check("FlowCanvas（真实节点选中）", () => renderToStaticMarkup(React$1.createElement(FlowCanvas, {
	nodes: board.nodes,
	onSelect: () => {},
	selectedId: "a1"
})), "登录页");
check("FlowCanvas（只看未完成）", () => renderToStaticMarkup(React$1.createElement(FlowCanvas, {
	nodes: board.nodes,
	onSelect: () => {},
	hideDone: true
})));
check("FlowCanvas（空树）", () => renderToStaticMarkup(React$1.createElement(FlowCanvas, {
	nodes: [],
	onSelect: () => {}
})));
check("BoardPanel（加载态）", () => renderToStaticMarkup(React$1.createElement(BoardPanel, {})));
check("BoardView（有数据，含未完成列表展开分支）", () => renderToStaticMarkup(React$1.createElement(BoardView, {
	board,
	error: void 0,
	refresh: () => {},
	sessionId: "session-test"
})), "示例项目");
check("BoardView（无数据 / 数据通道报错）", () => renderToStaticMarkup(React$1.createElement(BoardView, {
	board: void 0,
	error: "HTTP 500",
	refresh: () => {},
	sessionId: void 0
})), "数据通道不可用");
check("BoardView（空树引导）", () => renderToStaticMarkup(React$1.createElement(BoardView, {
	board: {
		...board,
		nodes: [],
		unfinished: [],
		scanBand: [],
		focusedRootIds: []
	},
	error: void 0,
	refresh: () => {},
	sessionId: void 0
})), "还没有项目树");
if (failures.length > 0) {
	console.error("面板渲染自检失败：");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log("面板渲染自检通过：加载态与数据态都能渲染。");
//#endregion
export {};

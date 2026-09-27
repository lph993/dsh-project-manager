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
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BoardPanel,
  BoardView,
  CanvasLegendModal,
  UnfinishedListModal,
} from '../src/client/board-panel.tsx';
import { FlowCanvas } from '../src/client/flow-canvas.tsx';
import { RightProgressView } from '../src/client/right-tab.tsx';
import { NodeInspector } from '../src/client/node-inspector.tsx';
import {
  SettingsForm,
  renderAiUsageCard,
  renderBoundaryStatsCard,
  renderNotifyStatsCard,
} from '../src/client/settings-section.tsx';
import type { BoardSnapshot, NodeView } from '../src/client/contract.ts';
import { formatBasis, formatCounts, formatPercent } from '../src/client/api.ts';

/** 造一个"有数据"的看板快照（含枝/叶混合、关注、进行中、异常等状态）。 */
function fakeBoard(): BoardSnapshot {
  const node = (partial: Partial<NodeView> & { id: string; name: string }): NodeView => ({
    parentId: null,
    kind: 'task',
    selfState: 'pending',
    derivedState: 'pending',
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
    updatedAt: '2026-09-23T00:00:00Z',
    updatedBy: 'user',
    addedMidway: false,
    subscriptionCount: 0,
    branchPath: [],
    ...partial,
  });
  const nodes: NodeView[] = [
    node({ id: 'root', name: '示例项目', kind: 'feature', childCount: 2, leafCount: 3, unfinishedLeafCount: 2 }),
    node({ id: 'a', name: '前端', parentId: 'root', kind: 'feature', childCount: 2, leafCount: 2, unfinishedLeafCount: 1, focus: true }),
    node({ id: 'a1', name: '登录页', parentId: 'a', derivedState: 'running', progress: 0.4, focus: true }),
    node({ id: 'a2', name: '好友列表', parentId: 'a', derivedState: 'done', progress: 1, focus: true, branchPath: ['前端'] }),
    node({ id: 'b', name: '服务端', parentId: 'root', kind: 'feature', childCount: 1, leafCount: 1, unfinishedLeafCount: 1 }),
    node({ id: 'b1', name: '消息推送', parentId: 'b', derivedState: 'error', progress: 0.2, flags: ['addedMidway'] }),
  ];
  return {
    projectId: 'pm_test',
    projectName: '示例项目',
    nodes,
    overall: {
      ratio: 0.4,
      basis: 'count',
      doneLeaves: 1,
      unfinishedLeaves: 2,
      totalLeaves: 3,
      runningNodes: 1,
      errorNodes: 1,
    },
    focused: {
      ratio: 0.5,
      basis: 'count',
      doneLeaves: 1,
      unfinishedLeaves: 1,
      totalLeaves: 2,
      runningNodes: 1,
      errorNodes: 0,
    },
    focusedRootIds: ['a'],
    unfinished: [nodes[2]!, nodes[5]!],
    conflicts: [],
    scanBand: nodes
      .filter((n) => n.childCount === 0)
      .map((n) => ({ nodeId: n.id, name: n.name, derivedState: n.derivedState, isFocus: n.focus })),
    degradation: [],
    snapshot: { mode: 'patch', reason: '测试' },
    confirmChannel: '未装配（自检）',
    document: { path: 'project-manager.md', exists: false, legal: false, violations: [] },
    dataFormat: 1,
    externalChange: null,
    watchTargets: [],
    workspaceRoot: { value: 'Z:\\demo', source: 'tool-call', detail: '自检' },
  };
}

const failures: string[] = [];

function check(label: string, render: () => string, expectText?: string): void {
  try {
    const html = render();
    if (html.length < 50) {
      failures.push(`${label}：渲染结果过短（${html.length} 字节）`);
      return;
    }
    if (expectText !== undefined && !html.includes(expectText)) {
      failures.push(`${label}：渲染结果里没有「${expectText}」`);
      return;
    }
    console.log(`✔ ${label}（${html.length} 字节）`);
  } catch (error) {
    failures.push(`${label} 渲染抛错：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const board = fakeBoard();

// ① 画布：真实节点（枝/叶、关注、进行中、异常、中途新增都要走一遍）
//    断言里带上**数字口径**：枝给纯数字「总/已完成」（示例根：总 3、已完成 1 → `3/1`），
//    叶给自身百分比 —— 用户口径（"带标签" → "不啰嗦" → "**140/1 不是 1/140**"）后的终态钉在自检里。
check('FlowCanvas（有数据）', () =>
  renderToStaticMarkup(React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} })),
  '3/1');
check('FlowCanvas（真实节点选中）', () =>
  renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {}, selectedId: 'a1' }),
  ),
  '登录页');
check('FlowCanvas（只看未完成）', () =>
  renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {}, hideDone: true }),
  ));
// 分叉按钮（用户两轮反馈：加折叠图标 + 那个圈要圆）—— 断言它真的画出来了：
// 展开态 = 正圆 + 自绘 chevron；`data-pm-fork` 是"折叠后把按钮钉回原处"定位用的锚点，
// 因此这条断言同时守住"锚点没有被改掉"。
check(
  'FlowCanvas（分叉按钮：正圆 + 折叠图标）',
  () =>
    renderToStaticMarkup(
      React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
    ),
  'data-pm-fork',
);
check('FlowCanvas（空树）', () =>
  renderToStaticMarkup(React.createElement(FlowCanvas, { nodes: [], onSelect: () => {} })));
// 待删除（FR-159，用户口径："由会话引起的节点删除需要审核，并在流程图上红色高亮标记"）：
// 红描边之外还要有「待删除」文字标签 —— 只给一个红框，审核时没人知道它是什么意思。
check('FlowCanvas（AI 待删除 → 红描边 + 「待删除」标签）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, {
      nodes: board.nodes,
      onSelect: () => {},
      pendingRemovals: [{ nodeId: 'a', origin: 'session:test' }],
    }),
  );
  if (!svg.includes('data-pm-pending-removal')) throw new Error('待删除节点没有标记锚点');
  if (!svg.includes('待删除')) throw new Error('红线之外缺「待删除」文字标签');
  if (!svg.includes('#ef4444')) throw new Error('待删除节点没有红描边');
  return svg;
}, '待删除');
// 没有待删除时**不得**出现红描边或标签（避免误标正常节点）
check('FlowCanvas（无待删除 → 不出现红色标记）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (svg.includes('data-pm-pending-removal')) throw new Error('没有待删除却画了红标');
  return svg;
});
/**
 * 「疑似遗留」（FR-158 ③）：本轮建树没再提到的自动节点 —— **只标不删**，仍照常计入统计。
 * 断言两件事：① 有 stale 节点时画出**中性灰**虚线框 + 「疑似遗留」四个字（只给框没人看得懂）；
 * ② 没有任何 stale 节点时**不得**误画（否则整棵树都会花）。
 */
check('FlowCanvas（疑似遗留 → 中性灰虚框 + 「疑似遗留」标签）', () => {
  const nodes = board.nodes.map((node) => (node.id === 'b1' ? { ...node, stale: true } : node));
  const svg = renderToStaticMarkup(React.createElement(FlowCanvas, { nodes, onSelect: () => {} }));
  if (!svg.includes('data-pm-stale-box')) throw new Error('疑似遗留节点没有标记锚点');
  if (!svg.includes('疑似遗留')) throw new Error('虚框之外缺「疑似遗留」文字标签');
  if (!svg.includes('#94a3b8')) throw new Error('疑似遗留节点没有中性灰（**红色专属「待删除」**：功能分支不用红）');
  return svg;
});
check('FlowCanvas（无遗留 → 不出现疑似遗留标记）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (svg.includes('data-pm-stale-box')) throw new Error('没有遗留节点却画了疑似遗留虚框');
  return svg;
});
// 进行中的图标分两种（用户口径："没会话在跑就不用 loading 了，显示播放图标（三角那个）"）：
// ① 最近有活动 → 转圈（SMIL `animateTransform`）；② 早已没人管 → 静态播放三角（`M -1.4 -5 L 4.6 0`）。
// 假数据里 a1 是 running 但 updatedAt 是昨天 ⇒ 必须画播放三角、**不得**再转圈。
check('FlowCanvas（进行中但没在跑 → 播放三角，不转圈）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (svg.includes('animateTransform')) throw new Error('没会话在跑却还在转圈');
  return svg;
}, 'M -1.4 -5 L 4.6 0');
/**
 * **种类过滤必须自绘**（用户两轮实测："select 有毛病" → "**select 还是白底白字**"）。
 *
 * 原生 `<select>` 的弹层由**系统**绘制，`background` / `color` / `color-scheme` 都管不着它，
 * 暗色主题下就是白底白字。这里钉住：① 代码里**没有原生 select**；② 入口还在（按钮显示当前值）。
 * 菜单展开时才列三个选项，SSR 点不到，所以不断言展开态。
 */
check('FlowCanvas（种类过滤：自绘下拉，不再有原生 select）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (svg.includes('<select')) {
    throw new Error('又用回原生 select 了 —— 它的弹层是系统画的，暗色下白底白字（实测两轮）');
  }
  if (!svg.includes('data-pm-kind-filter=')) throw new Error('种类过滤的入口没了');
  if (!svg.includes('全部')) throw new Error('按钮上应显示当前过滤值');
  return svg;
});
/**
 * **待审查角标**（FR-164，用户口径："节点有审查图标状态展示"）。
 *
 * 用文字「审」而不是再造一个符号：项目里符号已经排满（`✓ ! ✕ Ⅱ ⛔ ◌ ▶ ◆`），
 * 近义符号只会让人猜；而且它必须与「待删除」（红）、「疑似遗留」（灰）一眼可辨。
 */
check('FlowCanvas（待审查 → 「审」角标；未标记 → 不出现）', () => {
  const withReview = renderToStaticMarkup(
    React.createElement(FlowCanvas, {
      nodes: board.nodes.map((n) => (n.id === 'a1' ? { ...n, needsReview: true } : n)),
      onSelect: () => {},
    }),
  );
  if (!withReview.includes('data-pm-review-badge')) throw new Error('待审节点没有审查角标');
  if (!withReview.includes('>审<')) throw new Error('角标里应当是「审」字（符号已被别处占用，汉字才无歧义）');
  const without = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (without.includes('data-pm-review-badge')) throw new Error('没标记待审的节点不该有审查角标');
  return withReview;
});

/**
 * **会话在忙、但节点自己还是 `pending` ⇒ 也要转圈**（用户口径：
 * "你现在在跑，项目进度流程图里我没看到一个 loading"）。
 *
 * 真机现场：那 3 个我正处理着的节点状态全是 `pending`（**会话不会先把节点置成 running 再干活**，
 * 工具是在收尾时补记的），而当时的判据是 `running && live` ⇒ 既不转圈、也没有 ▶ ⇒ 图上一个 loading 都没有。
 */
check('FlowCanvas（会话在忙 + 节点还是 pending → 转圈）', () => {
  const busy = 'session-busy';
  const nodes = board.nodes.map((n) =>
    n.id === 'a1' ? { ...n, derivedState: 'pending', lastSessionId: busy } : n,
  );
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes, onSelect: () => {}, busySessionIds: [busy] }),
  );
  if (!svg.includes('animateTransform')) throw new Error('会话在动这个节点，却没画转圈');
  return svg;
});

/** 已完成 + 会话在忙 ⇒ **不画转圈**（完成态优先：给已完成节点转圈是自相矛盾）。 */
check('FlowCanvas（已完成 + 会话在忙 → 不转圈）', () => {
  const busy = 'session-busy';
  const nodes = board.nodes.map((n) =>
    n.id === 'a1' ? { ...n, derivedState: 'done', selfState: 'done', lastSessionId: busy } : n,
  );
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes, onSelect: () => {}, busySessionIds: [busy] }),
  );
  if (svg.includes('animateTransform')) throw new Error('已完成节点不该转圈（与完成态自相矛盾）');
  return svg;
});

/**
 * **该节点所属的会话正在忙 ⇒ 转圈**（这一次的判据是**逐节点**的）。
 *
 * 三次口径的来龙去脉（详见 `client/liveness.ts`）：
 * ① "没会话在跑就别 loading" → ② "正在会话的要切到 loading" → ③ 真机反馈：
 * "**全在转，但是没有会话在跑吧**""线路全部都有了动画" —— 因为当时把"某个会话在忙"当成了"整棵树在跑"。
 * 现在：`node.lastSessionId ∈ board.busySessionIds` 才转圈。
 */
check('FlowCanvas（该节点所属会话正在忙 → 转圈）', () => {
  const busy = 'session-busy';
  const nodes = board.nodes.map((n) => (n.id === 'a1' ? { ...n, derivedState: 'running', lastSessionId: busy } : n));
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes, onSelect: () => {}, busySessionIds: [busy] }),
  );
  if (!svg.includes('animateTransform')) throw new Error('会话在忙却没有转圈（是不是还画着播放三角？）');
  if (svg.includes('M -1.4 -5 L 4.6 0')) throw new Error('会话在忙却仍画了播放三角（两个图标必须互斥）');
  return svg;
});

/**
 * **别的会话在忙 ⇒ 这个节点不转圈**（真机事故的防复发）。
 *
 * 现场证据：那 5 个 `running` 节点 `lastSessionId` 全空、`updatedAt` 是几小时前，
 * 却因为"当前会话在忙"整片转圈。这条断言就是钉住"**不再拿整棵树当代价**"。
 */
check('FlowCanvas（别的会话在忙 → 不转圈，显示播放三角）', () => {
  const nodes = board.nodes.map((n) =>
    n.id === 'a1' ? { ...n, derivedState: 'running', lastSessionId: 'session-other' } : n,
  );
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes, onSelect: () => {}, busySessionIds: ['session-busy'] }),
  );
  if (svg.includes('animateTransform')) throw new Error('别的会话在忙却让这个节点转圈了（整棵树都在转的老毛病）');
  return svg;
}, 'M -1.4 -5 L 4.6 0');

/**
 * **播放三角的连线不该流动**（用户口径："播放三角的连线不应该流动（不是正在运行的）"）。
 *
 * 流动（SMIL `stroke-dashoffset` 动画）与转圈必须**同源判据**：都用 `isLiveNode`。
 * 早先连线只看 `derivedState === 'running'`，于是"已启动但没人跑"的节点画着 ▶、线却在流动。
 * 假数据里 a1 是 running 但 `updatedAt` 是昨天 ⇒ 此时**不该有任何流动**。
 */
check('FlowCanvas（没在跑 → 连线不流动，与播放三角一致）', () => {
  const svg = renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} }),
  );
  if (svg.includes('stroke-dashoffset')) {
    throw new Error('没有节点在跑却让连线流动了（播放三角的线不该动）');
  }
  return svg;
});

/**
 * **完成后仍有遗留 ⇒ 黄底 + `!`**（用户口径："完成后是简报…任务完成情况(需要补充和处理的)
 * 节点黄色警告背景加感叹号图标示警"）。
 *
 * 同时钉住那次**符号让位**：感叹号从 `error` 手里要过来了，所以有遗留时**不得**再画完成态的 `✓`
 * （两个符号同时出现等于没说清"到底收干净没有"）。
 */
check('FlowCanvas（完成但有遗留 → 黄底 + 感叹号）', () => {
  const nodes = board.nodes.map((node) => (node.id === 'a2' ? { ...node, hasFollowUp: true } : node));
  const svg = renderToStaticMarkup(React.createElement(FlowCanvas, { nodes, onSelect: () => {} }));
  if (!svg.includes('#facc15')) throw new Error('有遗留的节点没有黄底（示警色缺失）');
  if (!svg.includes('!')) throw new Error('有遗留的节点没有感叹号角标');
  if (svg.includes('✓')) throw new Error('有遗留时不该再画完成勾（`!` 与 `✓` 不能同时出现）');
  return svg;
});

// ② 面板：加载态（board 未到）
check('BoardPanel（加载态）', () => renderToStaticMarkup(React.createElement(BoardPanel, {})));

// ③ 面板：**有数据态** —— 这一步才是能抓到 "加载态正常、拿到数据就崩" 的那种 bug
//    （实例如 `board?.nodes.find((n) => n.id === selectedId)` 踩 TDZ：
//     加载态短路所以不报错，一拿到数据就抛，用户看到 `data-slot-error` 一片空白）
check(
  'BoardView（有数据，含未完成列表展开分支）',
  () =>
    renderToStaticMarkup(
      React.createElement(BoardView, {
        board,
        error: undefined,
        refresh: () => {},
        sessionId: 'session-test',
      }),
    ),
  '示例项目',
);

/**
 * FR-174：**错误日志警示**（状态条右上角的可点角标）。
 *
 * 三种情形各钉一条，因为它们的失效方式不同：
 * ① 有错误却不画 → "宿主出过错，用户完全不知道"（功能没落地）；
 * ② 没错误却画个"0 错误"绿标 → **无依据地宣称没出错**（A3 不编造）；
 * ③ 画了但不可点/没颜色 → 看得到线索却查不到原文，等于半个功能。
 */
function alertChipSlice(html: string): string {
  const at = html.indexOf('data-pm-alert-chip');
  if (at < 0) return '';
  const start = html.lastIndexOf('<a ', at);
  const end = html.indexOf('</a>', at);
  return start < 0 || end < 0 ? '' : html.slice(start, end + 4);
}

const renderWithAlerts = (alerts: BoardSnapshot['alerts']): string =>
  renderToStaticMarkup(
    React.createElement(BoardView, {
      board: { ...board, ...(alerts === undefined ? {} : { alerts }) },
      error: undefined,
      refresh: () => {},
      sessionId: 'session-test',
    }),
  );

check('BoardView（宿主有错误 → 红标 + 可点诊断页）', () => {
  const html = renderWithAlerts({
    errors: 2,
    warns: 0,
    lastError: { at: '2026-09-23T00:00:00Z', scope: 'host', message: 'hook 抛错' },
  });
  const chip = alertChipSlice(html);
  if (chip === '') throw new Error('有 error 却没画警示角标（宿主出过错用户看不到）');
  if (!chip.includes('data-pm-alert-chip="error"')) throw new Error('有 error 却不是红标');
  if (!chip.includes('#ef4444')) throw new Error('红标没上红色（红色语义 = 异常）');
  if (!chip.includes('/pm/debug')) throw new Error('角标不可点：查不到错误原文等于半个功能');
  if (!chip.includes('2 错误')) throw new Error(`角标没写清条数：${chip}`);
  return chip;
});

check('BoardView（无警示 → 不画角标，更不画"0 错误"）', () => {
  if (alertChipSlice(renderWithAlerts({ errors: 0, warns: 0 })) !== '') {
    throw new Error('没有任何 error/warn 却画了角标（无依据地宣称状态）');
  }
  // 老宿主没有这个字段 ⇒ 同样必须什么都不画
  if (alertChipSlice(renderWithAlerts(undefined)) !== '') {
    throw new Error('宿主没给 alerts 却画了角标（不知道 ≠ 没出错）');
  }
  return renderWithAlerts({ errors: 0, warns: 0 });
});

check('BoardView（只有告警 → 灰标，不借红色）', () => {
  const chip = alertChipSlice(renderWithAlerts({ errors: 0, warns: 3 }));
  if (chip === '') throw new Error('有 warn 却没画角标（降级/兜底路线要能知情）');
  if (!chip.includes('data-pm-alert-chip="warn"')) throw new Error('warn 角标没标成 warn');
  if (chip.includes('#ef4444')) throw new Error('红色只留给异常/删除，不能被告警借用');
  if (!chip.includes('3 告警')) throw new Error(`角标没写清条数：${chip}`);
  return chip;
});

/**
 * 防复发的**重复**断言（用户口径："右键有这个功能，功能性重复。又是重复，你全局审查下吧"）：
 * 「重复」在本项目已经发生多次 —— ① 同一个删除入口同时出现在右键菜单与画布工具条；
 * ② 同一个数字串在同一格/同一屏里说两遍（FR-153 ③/④）。
 *
 * 这里只钉**机械可判的那一半**：同一屏内同一个数字串最多出现一次。
 * 功能性重复（两个入口做同一件事）没法纯靠 DOM 断言，靠"每个功能只留一个入口"的纪律 +
 * 本断言兜住"顺手又加一处显示"这类回归。
 */
function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * 取一段被锚点包住的 HTML：从锚点所在的那个 `<div` 起，按 `<div` / `</div>` **配对计数**
 * 找到它真正的闭合标签（不能取第一个 `</div>` —— 容器内部每个格子自己也是 `div`，
 * 那样只会切到第一格，断言就永远看不到后面的重复）。
 */
function sliceByAnchor(html: string, anchor: string): string {
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error(`找不到锚点 ${anchor}`);
  const start = html.lastIndexOf('<div', at);
  if (start < 0) throw new Error(`锚点 ${anchor} 不在 <div 里`);
  let depth = 0;
  let cursor = start;
  while (cursor < html.length) {
    const open = html.indexOf('<div', cursor);
    const close = html.indexOf('</div>', cursor);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      depth += 1;
      cursor = open + 4;
      continue;
    }
    depth -= 1;
    cursor = close + 6;
    if (depth === 0) return html.slice(start, cursor);
  }
  throw new Error(`锚点 ${anchor} 的闭合标签没找到`);
}

check('BoardView（指标行内同一个数字串不得出现两次）', () => {
  const html = renderToStaticMarkup(
    React.createElement(BoardView, { board, error: undefined, refresh: () => {}, sessionId: 'session-test' }),
  );
  const metrics = sliceByAnchor(html, 'data-pm-metrics');
  const overallCounts = formatCounts(board.overall);
  const count = occurrences(metrics, overallCounts);
  if (count !== 1) {
    throw new Error(
      `指标行里件数串「${overallCounts}」出现 ${count} 次（应为 1）：` +
        '「整体完成度」与「任务点」不能各写一遍同一个数（FR-153 ③/④）',
    );
  }
  // FR-31 要求看板显示**关注枝完成度**：这一格容易被"去重复"顺手删掉（真发生过），所以钉住它。
  if (!metrics.includes('关注枝')) {
    throw new Error('指标行缺「关注枝」格：FR-31 要求显示关注枝完成度，去重复时不许连它一起删');
  }
  // 删除/取消选择在本屏**只该有右键菜单一处**（工具条那一条已按用户口径删掉）
  if (html.includes('取消选择')) throw new Error('画布工具条又长出了「取消选择」按钮（与右键/右栏重复）');
  if (html.includes('已选：')) throw new Error('画布工具条又长出了「已选：x」标签（与画布高亮/右栏标题重复）');
  return html;
});

check('RightProgressView（指标行只给一个数字串）', () => {
  const html = renderToStaticMarkup(
    React.createElement(RightProgressView, { board, error: undefined, refresh: () => {} }),
  );
  const metric = sliceByAnchor(html, 'data-pm-metric="overall"');
  const pct = formatPercent(board.overall);
  if (occurrences(metric, pct) > 0) {
    throw new Error(`右栏指标行同时给了百分比「${pct}」与件数比：主口径只留 \`总/已完成\`（FR-153 ③）`);
  }
  if (occurrences(metric, formatCounts(board.overall)) !== 1) {
    throw new Error('右栏指标行的件数串不是恰好一次');
  }
  return html;
});

/**
 * **全树节点列表：与流程图的树形结构对齐**（用户口径："这里就一个大支点啊，不做细项分支？" +
 * "跟流程图渲染的树形结构对齐咋样"）。
 *
 * 这条断言钉的是**层级**，不是"有没有列表"：早先只按顶层分了一层，
 * 于是 243 个节点被拍成一条长列表（看着像树、其实没分支）。所以这里要求：
 * ① 有根（depth=0）；② **有更深一层**（depth=1）—— 也就是真的递归展开了子节点。
 */
check('RightProgressView（全树列表：树形层级与流程图对齐）', () => {
  const html = renderToStaticMarkup(
    React.createElement(RightProgressView, { board, error: undefined, refresh: () => {} }),
  );
  if (!html.includes('全树（')) throw new Error('右栏没有全树节点列表');
  if (!html.includes('data-pm-depth="0"')) throw new Error('没有根节点行（depth=0）');
  if (!html.includes('data-pm-depth="1"')) {
    throw new Error('没有第二层（depth=1）：列表退化成了平铺，与流程图的父子层次对不上');
  }
  if (!html.includes('登录页')) throw new Error('深层子节点没被渲染出来（递归没走到叶子）');
  if (!html.includes('▾')) throw new Error('折叠指示缺了（不可折展的树不好用）');
  return html;
});

/**
 * **子项目 tabs**（用户口径："子项目做 tabs"；澄清为"顶层根节点（= 子项目）当 tabs，右栏内切换"）。
 *
 * 一个工作区可能并存多个根（截图里就有 `侧边栏实时进度看板` 与 `侧边栏 UI 冒烟脚本`），
 * 右栏一次只展示一个 —— 不再把两棵树糊成一条长列表。
 * 这里断言两件事：① 多根时 tab 栏出现且每个根一个 tab；② **只渲染当前子项目的树**
 * （另一个根的节点不在这棵树里，否则又变回"糊在一起"）。
 */
check('RightProgressView（子项目 tabs：多根时切换、只展示当前子项目）', () => {
  const second = {
    ...board.nodes[0]!,
    id: 'root2',
    name: '第二个子项目',
    parentId: null,
    progress: 0.2,
    /**
     * **归一个正在忙的会话**：用来验证"会话活动标记"。
     * 用户诉求："tabs 上要做会话活动标记，就是当前会话在修复哪块有个标记，
     * 好查看正在操作的节点部分剩余工作"。
     */
    lastSessionId: 'session-live',
    unfinishedLeafCount: 7,
  };
  const multi = { ...board, nodes: [...board.nodes, second], busySessionIds: ['session-live'] };
  const html = renderToStaticMarkup(
    React.createElement(RightProgressView, { board: multi, error: undefined, refresh: () => {} }),
  );
  if (!html.includes('data-pm-tab="root2"')) throw new Error('多根时没有出现子项目 tab');
  if (!html.includes('第二个子项目')) throw new Error('tab 上没显示那个子项目的名字');
  if (!html.includes('示例项目')) throw new Error('第一个子项目丢了');
  // 活动标记：刚动过的那个子项目要有标记
  if (!html.includes('data-pm-tab-live="root2"')) {
    throw new Error('正在被操作的子项目没有活动标记（tabs 上看不出会话在修哪块）');
  }
  // 剩余工作：直接用该子项目的未完成叶节点数
  if (!html.includes('剩 7')) throw new Error('tab 上没有该子项目的剩余工作量');
  // 没在动的那个不该有标记
  if (html.includes('data-pm-tab-live="root"')) {
    throw new Error('没在操作的子项目不该有活动标记（标记必须有依据）');
  }
  // 只有一个根时**不该**有 tab 栏（纯噪声）
  const single = renderToStaticMarkup(
    React.createElement(RightProgressView, { board, error: undefined, refresh: () => {} }),
  );
  if (single.includes('data-pm-tab=')) throw new Error('只有一个子项目时不该显示 tab 栏');
  return html;
});
check(
  'BoardView（无数据 / 数据通道报错）',
  () =>
    renderToStaticMarkup(
      React.createElement(BoardView, {
        board: undefined,
        error: 'HTTP 500',
        refresh: () => {},
        sessionId: undefined,
      }),
    ),
  '数据通道不可用',
);
check(
  'BoardView（空树引导）',
  () =>
    renderToStaticMarkup(
      React.createElement(BoardView, {
        board: { ...board, nodes: [], unfinished: [], scanBand: [], focusedRootIds: [] },
        error: undefined,
        refresh: () => {},
        sessionId: undefined,
      }),
    ),
  '还没有项目树',
);

// ④ 右侧边栏「实时进度」页签：同样是"拿到数据才崩"的高危对象（紧凑视图里有取数组、
//    取 workspaceRoot.value、按状态查颜色表），三种状态都走一遍。
check(
  'RightProgressView（有数据）',
  () =>
    renderToStaticMarkup(
      React.createElement(RightProgressView, { board, error: undefined, refresh: () => {} }),
    ),
  '整体完成度',
);
check(
  'RightProgressView（重复入口已删：关注按钮 / 打开完整看板 / 工作区行 / 口径徽章）',
  () => {
    const html = renderToStaticMarkup(
      React.createElement(RightProgressView, { board, error: undefined, refresh: () => {} }),
    );
    // D：只留左侧栏的面板入口
    if (html.includes('打开完整看板')) throw new Error('右栏又有「打开完整看板」按钮了（用户决定 D：只留左侧入口）');
    // A：关注只留右键菜单与右栏属性面板（用按钮自己的 title 判定，避免撞上指标行的「◆ 关注枝」标签）
    if (html.includes('关注（看板与右栏都会盯这条枝）')) {
      throw new Error('右栏未完成列表又长出「◆ 关注」按钮了（用户决定 A）');
    }
    // B：工作区只在顶部那一处显示
    const workspace = board.workspaceRoot.value ?? '';
    if (workspace !== '' && html.includes(workspace)) {
      throw new Error('右栏又显示工作区路径了（用户决定 B：只保留顶部那一处）');
    }
    // FR-34：口径来源仍须可见（顶部在另一栏，服务不到这里）——它是"标注"，不是重复入口
    if (!html.includes(formatBasis(board.overall))) throw new Error('右栏没有口径来源标注（FR-34 要求）');
    // 但"没绑定工作区"时那条引导**必须**留着 —— 否则用户不知道该去哪里绑（它不是入口，是指路）
    const unbound = renderToStaticMarkup(
      React.createElement(RightProgressView, {
        board: { ...board, workspaceRoot: { value: null, source: 'none', detail: '本会话没有工具调用' } },
        error: undefined,
        refresh: () => {},
      }),
    );
    if (!unbound.includes('左侧栏打开完整看板即可绑定')) {
      throw new Error('未绑定工作区的引导没了：用户将不知道去哪里绑定');
    }
    return html;
  },
);
check('RightProgressView（任务点列表：进行中在前 → 待进行 → 已完成沉底）', () => {
  /**
   * 用户口径："这里应该是**正在进行和将要进行**的任务这样排序"
   * （上一版我按"进度低的在前"排，把 0% 顶到了最前 —— 方向错了）。
   *
   * 同时守住"已完成沉底 + 变绿"（前一版的要求，不能被这次改回去）。
   */
  const running = { ...board.nodes[2]!, id: 'r-1', name: '正在跑的', derivedState: 'running', progress: 0.4 };
  const pendingHigh = { ...board.nodes[2]!, id: 'p-1', name: '待进行已起头', derivedState: 'pending', progress: 0.3 };
  const pendingZero = { ...board.nodes[2]!, id: 'p-2', name: '待进行没动过', derivedState: 'pending', progress: 0 };
  const done = { ...board.nodes[2]!, id: 'd-1', name: '已经做完的', derivedState: 'done', progress: 1 };
  const html = renderToStaticMarkup(
    React.createElement(RightProgressView, {
      board: { ...board, unfinished: [pendingZero, done, pendingHigh, running] },
      error: undefined,
      refresh: () => {},
    }),
  );
  const at = (name: string): number => html.indexOf(name);
  if (at('正在跑的') < 0 || at('待进行已起头') < 0 || at('待进行没动过') < 0 || at('已经做完的') < 0) {
    throw new Error('四条任务点都该列出来');
  }
  if (at('正在跑的') > at('待进行已起头')) throw new Error('进行中的必须排在待进行之前');
  if (at('待进行已起头') > at('待进行没动过')) throw new Error('同为待进行时，已起头的（进度高）在前');
  if (at('待进行没动过') > at('已经做完的')) throw new Error('已完成的必须沉底');
  /**
   * 已完成**还要变绿**（前一版的要求，不许被这次排序改动带回去）。
   * 这里做**邻域检查**而不是全局搜 `#22c55e`：那个颜色在别处（焦点/状态色）也可能出现，
   * 全局搜会让断言"永远为真"，等于没测。
   */
  const doneIdx = at('已经做完的');
  const neighborhood = html.slice(Math.max(0, doneIdx - 400), doneIdx + 200);
  if (!neighborhood.includes('#22c55e') && !neighborhood.includes('rgb(34,197,94)')) {
    throw new Error('已完成的行没有变绿（和未完成的行混在一起分不出来）');
  }
  return html;
});
check(
  'RightProgressView（加载态 / 报错 / 未绑定工作区）',  () => {
    const loading = renderToStaticMarkup(
      React.createElement(RightProgressView, { board: undefined, error: undefined, refresh: () => {} }),
    );
    const failed = renderToStaticMarkup(
      React.createElement(RightProgressView, { board: undefined, error: 'HTTP 500', refresh: () => {} }),
    );
    const unbound = renderToStaticMarkup(
      React.createElement(RightProgressView, {
        board: {
          ...board,
          workspaceRoot: { value: null, source: 'none', detail: '本会话没有工具调用' },
        },
        error: undefined,
        refresh: () => {},
      }),
    );
    for (const [label, html] of [
      ['加载态', loading],
      ['报错', failed],
      ['未绑定', unbound],
    ] as const) {
      if (!html.includes(label === '加载态' ? '读取进度' : label === '报错' ? '数据通道不可用' : '还没绑定工作区')) {
        throw new Error(`${label} 分支渲染结果不对：${html.slice(0, 200)}`);
      }
    }
    return loading + failed + unbound;
  },
);

// ⑤ 节点属性面板：选中枝节点 / 选中叶节点 / 未选中三种状态。
check(
  'NodeInspector（选中枝节点）',
  () =>
    renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: board.nodes.find((n) => n.id === 'a'),
        onAction: () => {},
        onClose: () => {},
      }),
    ),
  // 顶部大号数字牌的口径说明（用户要求：大号数字放属性栏顶部；后又指出"描述啰嗦"→ 大号只留数字）
  '2 个任务点，已完成 1',
);
check(
  'NodeInspector（选中叶节点 + 动作入口）',
  () =>
    renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: board.nodes.find((n) => n.id === 'b1'),
        onAction: () => {},
      }),
    ),
  '关注整枝',
);
check(
  'NodeInspector（优先级：人填过 → 显示值 + 来源 + 就地编辑入口）',
  () =>
    renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: { ...(board.nodes.find((n) => n.id === 'b1') as (typeof board.nodes)[number]), priority: 3, prioritySource: 'user' },
        onAction: () => {},
      }),
    ),
  '3（1 最高，人填）',
);
check(
  'NodeInspector（优先级未设置 → 就地说"未设置"，并给编辑入口）',
  () =>
    renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: { ...(board.nodes.find((n) => n.id === 'b1') as (typeof board.nodes)[number]), priority: undefined },
        onAction: () => {},
      }),
    ),
  '未设置',
);
check(
  'NodeInspector（未选中）',
  () =>
    renderToStaticMarkup(React.createElement(NodeInspector, { node: undefined })),
  '点一个节点',
);

// ⑥ 回滚浮层（FR-51b/53b）：新加的下拉 + 单选 + 共享文件勾选，是最容易渲染崩的一支
check(
  'FlowCanvas（回滚浮层：选回滚点 + 选范围）',
  () =>
    renderToStaticMarkup(
      React.createElement(FlowCanvas, {
        nodes: board.nodes,
        selectedId: 'a',
        onSelect: () => {},
        onAction: () => {},
        overlay: {
          kind: 'rollback',
          nodeId: 'a',
          title: '确认整枝回滚？',
          branch: true,
          preview: '将**整枝回滚**「前端」到 2026-09-23 12:00（manual）\n- 覆盖节点：3 个',
          snapshots: [
            { snapshotId: 'snap_1', reason: 'manual', createdAt: '2026-09-23T12:00:00Z', mode: 'patch' },
            { snapshotId: 'snap_2', reason: 'pause', createdAt: '2026-09-23T13:00:00Z', mode: 'git' },
          ],
          snapshotId: 'snap_2',
          scope: 'both',
          confirmShared: false,
          sharedBlocked: ['src/shared.ts'],
        },
        onSubmit: () => {},
        onCancel: () => {},
        onRollbackChoice: () => {},
      }),
    ),
  '回滚点',
);
check(
  'NodeInspector（有回滚点 → 出现回滚/整枝回滚入口）',
  () =>
    renderToStaticMarkup(
      React.createElement(NodeInspector, {
        node: board.nodes.find((n) => n.id === 'a'),
        onAction: () => {},
        rollbackPoints: 2,
      }),
    ),
  '整枝回滚',
);

// ⑦ 设置页：可编辑表单是最容易在"值缺失/类型不对"时炸的一支
check(
  'SettingsForm（可编辑：数字/开关/下拉/csv 全走一遍）',
  () =>
    renderToStaticMarkup(
      React.createElement(SettingsForm, {
        view: {
          namespace: 'project-manager',
          applies: 'live',
          configurable: true,
          note: '',
          effective: {
            scanMaxDepth: 3,
            scanMaxChildrenPerDir: 12,
            scanMaxNodes: 200,
            scanInclude: [],
            scanExclude: ['docs/**'],
            aiProvider: '',
            aiModel: 'test-model',
            aiMaxOutputTokens: 8192,
            refreshIntervalMs: 1000,
            snapshotMode: 'auto',
            conflictPolicy: 'auto-fix-first',
            heuristicWeight: false,
            aiWeightMeasurement: false,
            sessionBoundaryWriteback: true,
            sessionBoundaryPrompt: false,
          },
        },
        onSaved: () => {},
      }),
    ),
  '保存设置',
);
// ⑦b 版本错位：**旧宿主**不返回 boundary 统计 —— 客户端不得因此崩（只少一张卡）。
check(
  'SettingsForm（旧宿主载荷：没有 boundary 统计）',
  () =>
    renderToStaticMarkup(
      React.createElement(SettingsForm, {
        view: {
          namespace: 'project-manager',
          applies: 'live',
          configurable: true,
          note: '',
          effective: { scanMaxDepth: 3 },
        },
        onSaved: () => {},
      }),
    ),
  '保存设置',
);
check(
  'SettingsForm（宿主没有 settings 服务 → 只给说明，不给假表单）',
  () =>
    renderToStaticMarkup(
      React.createElement(SettingsForm, {
        view: {
          namespace: 'project-manager',
          applies: 'live',
          configurable: false,
          note: '宿主未提供 settings 服务：只能改 cordis.patch.yml 后重启宿主。',
          effective: {},
        },
        onSaved: () => {},
      }),
    ),
  'cordis.patch.yml',
);

// ⑦c 两张统计卡（回写消耗 / 会话边界修正）单独渲染：
//     它们读的全是宿主返回的统计字段，"旧宿主没有这些字段"是最容易崩的一类。
check(
  '统计卡（回写消耗 + 会话边界修正）',
  () =>
    renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderNotifyStatsCard({ sent: 3, suppressed: 11, tracked: 4, enabled: true }),
        renderBoundaryStatsCard({
          runs: 5,
          patches: 2,
          reminders: 4,
          injected: 3,
          lastKind: 'turn-end',
          lastActorId: 'session-abc',
          lastAt: '2026-01-01T00:00:00.000Z',
          enabled: true,
          prompt: true,
        }),
      ),
    ),
  '投出的提醒',
);
check(
  '统计卡（旧宿主：字段全缺 → 不渲染，也不崩）',
  () =>
    renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderNotifyStatsCard(undefined),
        renderBoundaryStatsCard(undefined),
        // "字段都在但值是空的"这种更阴的载荷：不能出现 undefined 字样
        renderBoundaryStatsCard({
          runs: 0,
          patches: 0,
          reminders: 0,
          injected: 0,
          lastKind: '',
          lastActorId: '',
          lastAt: '',
          enabled: false,
          prompt: false,
        }),
      ),
    ),
  '还没触发过',
);

// ③b 未完成清单弹窗（用户反馈"改为modal形式"）：单独渲染，因此不需要测试专用开关
check(
  'UnfinishedListModal（未完成清单弹窗）',
  () =>
    renderToStaticMarkup(
      React.createElement(UnfinishedListModal, {
        nodes: board.unfinished,
        selectedId: 'a1',
        onPick: () => {},
        onClose: () => {},
      }),
    ),
  'aria-modal',
);
check(
  'UnfinishedListModal（全都完成 → 不列行，只说明）',
  () =>
    renderToStaticMarkup(
      React.createElement(UnfinishedListModal, {
        nodes: [],
        onPick: () => {},
        onClose: () => {},
      }),
    ),
  '所有叶节点都已完成',
);

// ⑦d 插件自身 AI 调用消耗卡（FR-147）：真实用量 / 粗估 / 缓存复用三个数分开摆。
//     最容易崩的是"从没调用过"（一堆 0）与"旧宿主没有这个字段"。
check(
  '统计卡（插件自身 AI 消耗：有调用 + 有复用 + 提供方缓存）',
  () =>
    renderToStaticMarkup(
      renderAiUsageCard({
        calls: 4,
        reused: 3,
        failed: 1,
        providerReported: 3,
        estimatedOnly: 1,
        inputTokens: 12000,
        outputTokens: 3400,
        totalTokens: 15400,
        cacheReadTokens: 4000,
        cacheWriteTokens: 800,
        reasoningTokens: 0,
        estimatedTokens: 21000,
        savedTokens: 9000,
        byScenario: [
          { scenario: 'tree', label: 'AI 建树', calls: 3, reused: 2, totalTokens: 14000 },
          { scenario: 'handoff', label: '交接文档补写', calls: 1, reused: 1, totalTokens: 1400 },
        ],
        last: {
          at: '2026-01-01T00:00:00.000Z',
          scenario: 'tree',
          route: 'p / m',
          outcome: 'ok',
          estimatedTokens: 5000,
          usageSource: 'provider',
        },
        window: 7,
      }),
    ),
  '省下约 9,000 token',
);
check(
  '统计卡（插件自身 AI 消耗：从未调用过 → 不编数字）',
  () =>
    renderToStaticMarkup(
      renderAiUsageCard({
        calls: 0,
        reused: 0,
        failed: 0,
        providerReported: 0,
        estimatedOnly: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedTokens: 0,
        savedTokens: 0,
        byScenario: [],
        window: 0,
      }),
    ),
  '还没拿到过提供方用量',
);
check(
  '统计卡（旧宿主：没有 aiUsage 字段 → 不渲染，也不崩）',
  () =>
    renderToStaticMarkup(
      React.createElement(
        'div',
        null,
        // 旧宿主不返回 aiUsage → 卡片整体不渲染（返回 null）；这里包一层容器，
        // 让自检能同时断言"没崩"和"确实没画出卡片"
        renderAiUsageCard(undefined),
        '（旧宿主未返回 aiUsage 字段：这张卡整体不渲染，页面其余部分照常工作）',
      ),
    ),
  '这张卡整体不渲染',
);

// ③c 图例弹窗（用户反馈："不用在 tooltip 上展示每个图标……可以写到专门的地方"）
check(
  'CanvasLegendModal（流程图图例）',
  () => renderToStaticMarkup(React.createElement(CanvasLegendModal, { onClose: () => {} })),
  '自动生成',
);

// ④ 版本错位：**旧宿主**的载荷（没有 rollbackPoints / subscriptionRisk 等新字段）也必须能渲染。
//    插件与宿主的版本不会永远同步，客户端崩在这里是最没必要的故障（这条是被真实场景逼出来的：
//    新客户端 + 旧宿主时，AI 确认框读 `value.cache.state` 会直接抛）。
check(
  'BoardView（旧宿主载荷：缺 rollbackPoints / 订阅风险字段）',
  () => {
    const legacy = {
      ...board,
      rollbackPoints: undefined,
      nodes: board.nodes.map((node) => {
        const copy = { ...node } as Record<string, unknown>;
        delete copy['subscriptionRisk'];
        delete copy['subscriptionWaiting'];
        return copy;
      }),
    } as unknown as BoardSnapshot;
    return renderToStaticMarkup(
      React.createElement(BoardView, {
        board: legacy,
        error: undefined,
        refresh: () => {},
        sessionId: 'session-test',
      }),
    );
  },
  '示例项目',
);

if (failures.length > 0) {
  console.error('面板渲染自检失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('面板渲染自检通过：加载态与数据态都能渲染。');

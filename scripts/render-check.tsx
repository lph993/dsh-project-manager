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

import { BoardPanel, BoardView } from '../src/client/board-panel.tsx';
import { FlowCanvas } from '../src/client/flow-canvas.tsx';
import type { BoardSnapshot, NodeView } from '../src/client/contract.ts';

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
check('FlowCanvas（有数据）', () =>
  renderToStaticMarkup(React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} })),
  '示例项目');
check('FlowCanvas（真实节点选中）', () =>
  renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {}, selectedId: 'a1' }),
  ),
  '登录页');
check('FlowCanvas（只看未完成）', () =>
  renderToStaticMarkup(
    React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {}, hideDone: true }),
  ));
check('FlowCanvas（空树）', () =>
  renderToStaticMarkup(React.createElement(FlowCanvas, { nodes: [], onSelect: () => {} })));

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

if (failures.length > 0) {
  console.error('面板渲染自检失败：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('面板渲染自检通过：加载态与数据态都能渲染。');

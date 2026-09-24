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
//    断言里带上**数字口径**：枝给「总 / 已完成」（示例根：3 个任务点 / 已完成 1），
//    叶给自身百分比 —— 用户纠偏后这条口径必须钉在渲染自检里。
check('FlowCanvas（有数据）', () =>
  renderToStaticMarkup(React.createElement(FlowCanvas, { nodes: board.nodes, onSelect: () => {} })),
  '3 / 1');
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
  'RightProgressView（带「打开完整看板」按钮）',
  () =>
    renderToStaticMarkup(
      React.createElement(RightProgressView, {
        board,
        error: undefined,
        refresh: () => {},
        onOpenBoard: () => {},
      }),
    ),
  '打开完整看板',
);
check(
  'RightProgressView（加载态 / 报错 / 未绑定工作区）',
  () => {
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
  // 顶部大号数字牌的口径说明（用户要求：「总 / 已完成」用大号数字放在属性栏顶部）
  '总 2 个任务点 / 已完成 1',
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

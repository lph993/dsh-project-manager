/**
 * 右侧边栏的「实时进度」页签（紧凑视图）。
 *
 * **为什么有这个东西**：用户的原话是"我其实原本打算把页面放在这里（右侧栏空区），
 * 每个工作区都有自己的可观测进度，而且也利于观察、审查会话和审查、关注进度"。
 * 右侧栏宽度只有几百像素，塞不下流程图，所以这里做的是**只读的进度快照**：
 * 一眼看到整体/关注枝完成度、还有哪些没做完。
 * 完整画布仍然在左侧栏点开的**主面板**里（点侧边栏面板入口即可，本页不再放"打开完整看板"按钮——
 * 用户决定 D：只留左侧入口）。
 *
 * **它是同一份投影的第二个视图**，不引入第二套数据通路：同样打 `/pm/board`
 * （§12.4：事实源在宿主，客户端只做呈现），同样按会话 id 解析工作区根。
 *
 * **这里不该做的事**（用户决定的入口归并，见 FR-160）：
 * ① 不放"关注"按钮（未完成列表行尾的 `◆` 已删）——关注只留**右键菜单**与**右栏属性面板**两处；
 * ② 不放"打开完整看板"按钮——左侧栏的面板入口就是它。
 */

import * as React from 'react';

import {
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  formatBasis,
  formatCounts,
  nodeRowLabel,
} from './api.ts';
import { useBoardData, useAbsentSessions, type SessionsSelectorHook } from './board-panel.tsx';
import { isLiveNode } from './liveness.ts';
import { nodePercentOf } from './labels.ts';
import { orderUnfinished } from './unfinished-order.ts';
import type { BoardSnapshot, NodeView } from './contract.ts';

const { useState } = React;

/** 右栏只列这么多条未完成项：再多就该去主面板看了。 */
const MAX_ROWS = 8;

export interface RightProgressTabProps {
  /** 轮询间隔（毫秒）。右栏是"瞄一眼"的场景，默认比主面板慢一档。 */
  intervalMs?: number;
  /** 全局标准源（缺失时退回"宿主自己解析工作区"，仍然不会瞎猜）。 */
  useSessions?: SessionsSelectorHook;
}

/** 外壳：只取数据，渲染交给 {@link RightProgressView}（自检可以直接喂假数据）。 */
export function RightProgressTab(props: RightProgressTabProps): React.ReactElement {
  const useSessions = props.useSessions ?? useAbsentSessions;
  const sessionId = useSessions((state: { current?: string }) => state.current);
  const { board, error, refresh } = useBoardData(props.intervalMs ?? 2000, sessionId);
  return React.createElement(RightProgressView, { board, error, refresh });
}

export interface RightProgressViewProps {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
}

/** 紧凑进度视图（纯呈现，可独立渲染）。 */
export function RightProgressView(props: RightProgressViewProps): React.ReactElement {
  const { board, error } = props;

  if (error !== undefined && board === undefined) {
    return (
      <div style={styles.root}>
        <div style={styles.error}>数据通道不可用：{error}</div>
        <div style={styles.hint}>看板数据来自宿主 /pm/board；主面板同样受影响。</div>
      </div>
    );
  }

  if (board === undefined) {
    return (
      <div style={styles.root}>
        <div style={styles.hint}>读取进度…</div>
      </div>
    );
  }

  const noWorkspace = board.workspaceRoot.value === null;
  const empty = board.nodes.length === 0;
  const focused = board.focusedRootIds.length > 0;
  /**
   * 任务点列表的排序：**正在进行的在前，然后是待进行的，已完成的沉底**
   * （用户口径："这里应该是正在进行和将要进行的任务这样排序"）。
   *
   * ⚠️ 上一版我按"进度低的在前"排，结果 **0%（一个字没动）排到了最前面** —— 方向错了：
   * 这个列表的用处是"我现在该盯哪几个"，所以**活的任务优先**：
   *
   * 1. `running` 正在进行 —— 最该被看到；
   * 2. `pending` 将要进行 —— 其中**进度高的在前**（已经起了个头的比 0% 更接近完成，
   *    也更能说明"这条在推进中"，0% 是一大片并列的背景噪声）；
   * 3. `paused` / `held` 已停下 —— 排在待进行之后（要人管，但不是"正在跑"）；
   * 4. 其余（含异常）按原顺序；
   * 5. `done` 已完成沉底（上一轮已按用户要求变绿）。
   *
   * 同档内一律用名称兜底，保证**每次刷新顺序稳定**（顺序跳来跳去比排错更难受）。
   */
  /**
   * 排序口径全部搬进 `client/unfinished-order.ts`（纯函数 + 单测）：
   * 这里的规则被用户纠正过两次，写在 UI 里就等于每次刷新都重新赌一次方向。
   * 顺序：done 沉底 → running 最先 → **优先级（1 最高，未设置排最后）** → 进度高的在前 → 名称兜底。
   */
  const rows = orderUnfinished(board.unfinished).slice(0, MAX_ROWS);
  /** 折叠的节点 id（默认全展开）。 */
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set());
  /**
   * 当前选中的**子项目**（= 一个顶层根节点）。
   *
   * 用户口径："子项目做 tabs" + 澄清"顶层根节点（= 子项目）当 tabs，右栏内切换"。
   * 一个工作区里可能并存多个根（截图里 `侧边栏实时进度看板` 与 `侧边栏 UI 冒烟脚本` 就是两个），
   * 它们各自是一棵自洽的树 —— 右栏一次只展示一个，用 tab 切换，**不再糊成一条长列表**。
   */
  const [activeRootId, setActiveRootId] = useState<string | undefined>(undefined);

  /**
   * **全树节点列表：跟流程图的树形结构对齐**（用户口径："这里就一个大支点啊，不做细项分支？" +
   * "跟流程图渲染的树形结构对齐咋样"）。
   *
   * ⚠️ 这里**曾经按"枝"只分了一层**：顶层那个根当了唯一组头，于是 243 个节点被拍成一条长列表
   * —— 看起来就像一棵没有分支的树，与流程图（层层父子）完全不像。
   * 现在的做法是**真递归**：从根往下按 `parentId` 展开，每层缩进，任意节点都能折/展。
   */
  const childrenOf = new Map<string, NodeView[]>();
  for (const node of board.nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenOf.get(node.parentId);
    if (siblings === undefined) childrenOf.set(node.parentId, [node]);
    else siblings.push(node);
  }
  /** 顶层：一个根 = 一个子项目（截图里就有两个：进度看板 / UI 冒烟脚本）。 */
  const roots = board.nodes.filter((node) => node.parentId === null);
  /**
   * **正在被操作的子项目**（用户诉求："tabs 上要做会话活动标记，就是当前会话在修复哪块有个标记，
   * 好查看正在操作的节点部分剩余工作"）。
   *
   * 判据与画布图标**同源**（`isLiveNode`）：子树里有节点"所属会话正在忙"，这个 tab 就亮。
   * 早先这里用"最近 90s 有写入"来判，于是**没有任何会话在跑时 tab 也亮**；
   * 现在改成逐节点的会话信号（`lastSessionId ∈ busySessionIds`），只有真有人在跑才亮。
   */
  const liveRootIds = (() => {
    const busy = board.busySessionIds ?? [];
    const live = new Set<string>();
    const rootIds = new Set(roots.map((root) => root.id));
    for (const node of board.nodes) {
      if (!isLiveNode(node, busy)) continue;
      // 沿 parentId 往上找它属于哪个子项目
      let cursor: NodeView | undefined = node;
      const seen = new Set<string>();
      while (cursor !== undefined && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (rootIds.has(cursor.id)) {
          live.add(cursor.id);
          break;
        }
        cursor =
          cursor.parentId === null
            ? undefined
            : board.nodes.find((candidate) => candidate.id === cursor?.parentId);
      }
    }
    return live;
  })();
  /**
   * 当前展示的子项目：优先用户选的；没选过就用第一个；选中的那个若已消失（被删/换项目）也回落。
   */
  const activeRoot =
    roots.find((node) => node.id === activeRootId) ?? roots[0];

  /** 递归渲染（先序 DFS，与流程图的父子层次一致）。 */
  const renderTree = (node: NodeView, depth: number): React.ReactElement[] => {
    const children = childrenOf.get(node.id) ?? [];
    const collapsed = collapsedNodes.has(node.id);
    const row = (
      <div
        key={node.id}
        /* `data-pm-depth`：把层级暴露出来供渲染自检核对（"树形要对齐流程图的父子层次"是需求，得要断言） */
        data-pm-depth={depth}
        style={{ ...styles.treeNode, paddingLeft: 4 + depth * 12 }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            style={styles.treeToggle}
            title={collapsed ? '展开' : '折叠'}
            onClick={() =>
              setCollapsedNodes((prev) => {
                const next = new Set(prev);
                if (next.has(node.id)) next.delete(node.id);
                else next.add(node.id);
                return next;
              })
            }
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span style={styles.treeToggleSpacer} />
        )}
        <span
          style={{
            ...styles.dot,
            background: DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2',
          }}
          title={DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState}
        />
        <span style={styles.treeNodeName} title={nodeRowLabel(node)}>
          {node.name}
        </span>
        <span style={styles.rowMeta}>{nodePercentOf(node)}%</span>
      </div>
    );
    if (collapsed) return [row];
    return [row, ...children.flatMap((child) => renderTree(child, depth + 1))];
  };

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.name}>{board.projectName}</span>
      </div>

      {/*
        这里曾有：「工作区：…」一行（用户决定 B：**只保留顶部那一处**）与头部的口径徽章
        （用户决定 C：**只保留顶部**的规模行口径）。
        注意：口径徽章不是"装饰性重复"——FR-34 要求百分比旁标注口径来源（按工作量/按件数），
        顶部那份在**另一个栏**里服务不到右栏，故右栏把它下沉到数字旁（见下面的 `styles.metricBasis`）。
      */}

      {noWorkspace ? (
        <div style={styles.warn}>
          当前会话还没绑定工作区：{board.workspaceRoot.detail}（左侧栏打开完整看板即可绑定）
        </div>
      ) : null}

      {/*
        主口径只给 **`总/已完成`** 一个数字串（FR-153 ③/④：同一处不放两个数字串，同一屏不重复）。
        右栏是"瞄一眼还剩多少"的场景，件数比它自己就说完了；百分比留给主面板（那里才有地方）。
        进度条同理不重复——数字已经是进度，再加一根条就是同屏说两遍（用户口径："繁琐不"）。
      */}
      <div style={styles.metricRow} data-pm-metric="overall">
        <span style={styles.metricLabel}>整体完成度</span>
        <span style={styles.metricValue}>{formatCounts(board.overall)}</span>
        {/* 口径来源（FR-34）：顶部也有，但那是**另一栏**，服务不到这里，故数字旁保留这一小句 */}
        <span style={styles.metricBasis}>{formatBasis(board.overall)}</span>
      </div>
      {/**
       * **进度条：必须有**（用户实测反馈："进度条怎么没了"）。
       *
       * 我上一轮以"数字已经是进度、再加一根条就是同屏说两遍"为由删掉了它 —— 那是**误判**：
       * 数字回答"到了多少"，进度条回答"**还剩多长**"，是同一数据的**两种读法**，不是重复。
       * 右栏本来就是"瞄一眼"的场景，一根条的扫视成本远低于读分数。
       */}
      <Bar ratio={board.overall.ratio} />

      {/**
       * 关注枝：**只展示，不说教**（用户实测反馈："这条提示是告诉我必须关注节点吗？！"）。
       *
       * 原先没有关注枝时这里挂一句"还没有关注枝：右键节点 →「关注（整枝）」…"，
       * 那是**把操作说明塞进了状态展示位**：用户只是想看进度，却被教了一句话。
       * 现在没有关注枝就**什么都不说** —— 需要知道怎么关注时，右键菜单与属性面板里本来就有。
       */}
      {focused ? (
        <>
          <div style={styles.metricRow} data-pm-metric="focused">
            <span style={styles.metricLabel}>◆ 关注枝</span>
            <span style={styles.metricValue}>{formatCounts(board.focused)}</span>
          </div>
          <Bar ratio={board.focused.ratio} color="#3b82f6" />
        </>
      ) : null}

      {empty ? (
        <div style={styles.hint}>还没有节点。去完整看板「扫描工作区」或让 AI 从仓库生成任务树。</div>
      ) : rows.length === 0 ? (
        <div style={styles.hint}>全部完成 ✓</div>
      ) : (
        <>
          <div style={styles.sectionTitle}>
            {/* 这是**任务点总表**（含已完成），标题要如实说，否则那些 100% 的行看起来像数据错了 */}
            任务点 {board.unfinished.length} 项
            {board.unfinished.length > rows.length ? `（列前 ${rows.length}·进行中优先）` : ''}
          </div>
          {rows.map((node) => (
            <div key={node.id} style={styles.row}>
              <span
                style={{
                  ...styles.dot,
                  background: DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2',
                }}
                title={DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState}
              />
              {/**
               * 已完成的**整行变绿**（用户口径："已完成的没变绿"）——
               * 与状态点同一份颜色常量（FR-71 数字/颜色同源），不另定一个绿。
               */}
              <span
                style={{
                  ...styles.rowName,
                  ...(node.derivedState === 'done' ? { color: DERIVED_STATE_COLOR.done } : {}),
                }}
                title={nodeRowLabel(node)}
              >
                {node.name}
              </span>
              {/* 这条行**不再放「◆ 关注」按钮**（用户决定 A：关注只留右键菜单与右栏属性面板两处）。
                  列表行的本职是"点一行定位"，改关注是**属性/右键**的事；
                  原先"行尾一个 ◆ + 右键一项 + 属性栏一个按钮"是同一个动作的三个入口。 */}
              <span style={styles.rowMeta}>{nodePercentOf(node)}%</span>
            </div>
          ))}
        </>
      )}

      {board.conflicts.length > 0 ? (
        <div style={styles.warn}>{board.conflicts.length} 处冲突待处理（详情在完整看板的状态条）。</div>
      ) : null}
      {error !== undefined ? <div style={styles.error}>刷新失败：{error}</div> : null}

      {/**
       * **全树节点列表：与流程图的树形结构对齐**（用户口径："跟流程图渲染的树形结构对齐咋样"）。
       *
       * 任意有子节点的行都能折/展，**默认全展开**（`collapsedNodes` 初始为空集）；
       * 每层缩进 12px，先序 DFS 自上而下 —— 与画布里的父子层次同序，对得上号。
       * 列表自身滚动（`flex:1 + overflow:auto`），不挤压上面的进度区。
       */}
      {empty ? null : (
        <div style={styles.treeBox}>
          <div style={styles.sectionTitle}>全树（{board.nodes.length} 个节点）</div>
          {/**
           * **子项目 tabs**（用户口径："子项目做 tabs"，clarified：顶层根节点当 tabs、右栏内切换）。
           *
           * 只有一个根时**不显示**这一排：那时 tab 栏是纯噪声（点了也没有别的可切）。
           */}
          {roots.length > 1 ? (
            <div style={styles.tabs} role="tablist" aria-label="子项目">
              {roots.map((root) => {
                const active = root.id === activeRoot?.id;
                return (
                  <button
                    key={root.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-pm-tab={root.id}
                    title={`${root.name}：${nodePercentOf(root)}%`}
                    style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}
                    onClick={() => setActiveRootId(root.id)}
                  >
                    <span
                      style={{
                        ...styles.dot,
                        background: DERIVED_STATE_COLOR[root.derivedState] ?? '#9aa4b2',
                      }}
                    />
                    <span style={styles.tabName}>{root.name}</span>
                    {/**
                     * **会话活动标记**（用户："tabs 上要做会话活动标记…好查看正在操作的节点部分"）：
                     * 该子项目里有节点最近在动 ⇒ 亮一个小圆点（与画布上"转圈/播放三角"同源判据）。
                     */}
                    {liveRootIds.has(root.id) ? (
                      <span
                        style={styles.tabLive}
                        data-pm-tab-live={root.id}
                        title="这个子项目里有节点正在被操作"
                      />
                    ) : null}
                    <span style={styles.tabMeta}>
                      {nodePercentOf(root)}%
                      {/**
                       * **剩余工作**：直接用它自己的 `unfinishedLeafCount`（未完成叶节点数），
                       * 不另算一套口径（FR-71：数字同源）。为 0 时不显示，避免"0 项"这类噪声。
                       */}
                      {root.unfinishedLeafCount > 0 ? ` · 剩 ${root.unfinishedLeafCount}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <div style={styles.treeList}>
            {activeRoot === undefined ? null : renderTree(activeRoot, 0)}
          </div>
        </div>
      )}

      {/* 这里曾有「打开完整看板」按钮 —— 已删（用户决定 D：**只留左侧栏的面板入口**）。
          判据仍是"不按这个按钮能不能做到"：能，左侧栏点一下就是完整看板，故此处为重复入口。 */}
    </div>
  );
}

/**
 * 进度条（与画布同一套语义：填充 = 完成比例）。
 *
 * 上一轮我把它删了，理由是"数字已经是进度、再加一根条就是同屏说两遍"——**那是误判**：
 * 数字回答"到了多少"，进度条回答"还剩多长"，是同一数据的两种读法。
 * 右栏是"瞄一眼"的场景，一根条的扫视成本远低于读分数（用户实测："进度条怎么没了"）。
 */
function Bar(props: { ratio: number; color?: string }): React.ReactElement {
  const width = Math.max(0, Math.min(1, props.ratio)) * 100;
  return (
    <div style={styles.track}>
      <div
        style={{
          ...styles.fill,
          width: `${width}%`,
          background: props.color ?? '#22c55e',
        }}
      />
    </div>
  );
}

/** 右栏宽度不定，全部用自适应单位；颜色一律 `inherit` 系，避免主题撞色。 */
const styles = {
  root: {
    padding: '10px 12px 16px',
    fontSize: 12,
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    overflow: 'auto',
    height: '100%',
    boxSizing: 'border-box' as const,
  },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  name: { fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  metricRow: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 },
  metricLabel: { fontSize: 11, opacity: 0.75, flex: '0 0 auto' },
  metricValue: { fontSize: 20, fontWeight: 700, lineHeight: 1.1 },
  /** 口径来源（按工作量 / 按件数）：小字贴在数字旁，满足 FR-34 又不与顶部重复成两个大徽章。 */
  metricBasis: { fontSize: 10.5, opacity: 0.6, marginLeft: 'auto', textAlign: 'right' as const },
  /** 进度条轨道与填充（上一轮被我误删，见 `Bar` 的说明）。 */
  track: { height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.28)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, transition: 'width 200ms ease-out' },
  /** 全树列表：占满右栏剩余空间，自己滚动（不挤压上面的进度区）。 */
  treeBox: { flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' as const },
  /**
   * 子项目 tabs：横向排、**可换行**（右栏窄，长了会溢出；换行比横向滚动好按）。
   * 只有一个根时不渲染这一排（见渲染处说明）。
   */
  tabs: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
    marginTop: 4,
    marginBottom: 2,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    padding: '2px 7px',
    fontSize: 11,
    borderRadius: 999,
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.75,
  },
  /** 选中的子项目：实一点、不透明（与未选中一眼可分）。 */
  tabActive: {
    background: 'rgba(148,163,184,0.18)',
    borderColor: 'currentColor',
    opacity: 1,
  },
  tabName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  tabMeta: { fontSize: 10, opacity: 0.6, flex: '0 0 auto' },
  /** 会话活动标记：小圆点 + 呼吸感（只做静态圆点，避免给右栏加动画噪声）。 */
  tabLive: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#3b82f6',
    flex: '0 0 auto',
    boxShadow: '0 0 0 2px rgba(59,130,246,0.25)',
  },
  treeList: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' as const, gap: 1 },
  /** 树的一行：缩进由行内 `paddingLeft` 按深度算（与流程图的层级同序）。 */
  treeNode: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, lineHeight: 1.5 },
  treeToggle: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: 0,
    width: 12,
    flex: '0 0 auto',
    fontSize: 10,
    opacity: 0.7,
  },
  /** 叶子节点占位：让没有折叠箭头的行与有箭头的行**左对齐**。 */
  treeToggleSpacer: { width: 12, flex: '0 0 auto' },
  treeNodeName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  sectionTitle: { fontSize: 11, fontWeight: 600, opacity: 0.8, marginTop: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
  rowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  rowMeta: { fontSize: 10.5, opacity: 0.6, flex: '0 0 auto' },
  hint: { fontSize: 11, opacity: 0.7 },
  warn: {
    fontSize: 11,
    padding: '5px 8px',
    borderRadius: 4,
    background: 'rgba(245,158,11,0.12)',
    border: '0.5px solid rgba(245,158,11,0.5)',
  },
  error: {
    fontSize: 11,
    padding: '5px 8px',
    borderRadius: 4,
    background: 'rgba(239,68,68,0.12)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
};

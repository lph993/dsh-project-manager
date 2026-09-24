/**
 * 右侧边栏的「实时进度」页签（紧凑视图）。
 *
 * **为什么有这个东西**：用户的原话是"我其实原本打算把页面放在这里（右侧栏空区），
 * 每个工作区都有自己的可观测进度，而且也利于观察、审查会话和审查、关注进度"。
 * 右侧栏宽度只有几百像素，塞不下流程图，所以这里做的是**只读的进度快照**：
 * 一眼看到整体/关注枝完成度、还有哪些没做完、顺手就能改关注。
 * 完整画布仍然在左侧栏点开的**主面板**里（`onOpenBoard` 一键跳过去）。
 *
 * **它是同一份投影的第二个视图**，不引入第二套数据通路：同样打 `/pm/board`
 * （§12.4：事实源在宿主，客户端只做呈现），同样按会话 id 解析工作区根。
 */

import * as React from 'react';

import {
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  formatBasis,
  formatCounts,
  formatPercent,
  nodeRowLabel,
  postNodeAction,
} from './api.ts';
import { useBoardData, useAbsentSessions, type SessionsSelectorHook } from './board-panel.tsx';
import type { BoardSnapshot, NodeView } from './contract.ts';

const { useCallback, useState } = React;

/** 右栏只列这么多条未完成项：再多就该去主面板看了。 */
const MAX_ROWS = 8;

export interface RightProgressTabProps {
  /** 轮询间隔（毫秒）。右栏是"瞄一眼"的场景，默认比主面板慢一档。 */
  intervalMs?: number;
  /** 全局标准源（缺失时退回"宿主自己解析工作区"，仍然不会瞎猜）。 */
  useSessions?: SessionsSelectorHook;
  /**
   * 打开完整看板。
   *
   * 由 `index.tsx` 把 `ctx.layout.selectPanel('project-manager')` 包一层注入进来 ——
   * 组件自己拿不到布局服务，也不该拿（槽位组件的 props 才是它的输入面）。
   */
  onOpenBoard?: () => void;
}

/** 外壳：只取数据，渲染交给 {@link RightProgressView}（自检可以直接喂假数据）。 */
export function RightProgressTab(props: RightProgressTabProps): React.ReactElement {
  const useSessions = props.useSessions ?? useAbsentSessions;
  const sessionId = useSessions((state: { current?: string }) => state.current);
  const { board, error, refresh } = useBoardData(props.intervalMs ?? 2000, sessionId);
  return React.createElement(RightProgressView, {
    board,
    error,
    refresh,
    ...(props.onOpenBoard !== undefined ? { onOpenBoard: props.onOpenBoard } : {}),
  });
}

export interface RightProgressViewProps {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
  onOpenBoard?: (() => void) | undefined;
}

/** 紧凑进度视图（纯呈现，可独立渲染）。 */
export function RightProgressView(props: RightProgressViewProps): React.ReactElement {
  const { board, error, refresh } = props;
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  /** 关注/取消关注（FR-50）：右栏最常做的动作，做成一行一个的小开关。 */
  const toggleFocus = useCallback(
    (node: NodeView) => {
      setBusy(node.id);
      setNotice(undefined);
      void postNodeAction({ action: node.focus ? 'unfocus' : 'focus', nodeId: node.id }).then(
        (outcome) => {
          setBusy(undefined);
          if (!outcome.ok) {
            setNotice(outcome.error ?? '操作失败');
            return;
          }
          if (outcome.value?.status !== 'ok') {
            setNotice(outcome.value?.message ?? outcome.value?.preview ?? '未能改动关注');
            return;
          }
          refresh();
        },
      );
    },
    [refresh],
  );

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
  const rows = board.unfinished.slice(0, MAX_ROWS);

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.name}>{board.projectName}</span>
        <span style={styles.badge}>{formatBasis(board.overall)}</span>
      </div>

      {noWorkspace ? (
        <div style={styles.warn}>
          当前会话还没绑定工作区：{board.workspaceRoot.detail}
          {props.onOpenBoard ? '（去完整看板绑定）' : ''}
        </div>
      ) : (
        <div style={styles.workspace} title={board.workspaceRoot.value ?? ''}>
          {board.workspaceRoot.value}
        </div>
      )}

      <div style={styles.metricRow}>
        <span style={styles.metricLabel}>整体完成度</span>
        <span style={styles.metricValue}>{formatPercent(board.overall)}</span>
        <span style={styles.metricSub}>
          {/* 主口径是**进度**（已完成 / 总），未完成数退到后面（用户纠偏） */}
          已完成 {formatCounts(board.overall)} · 未完成 {board.unfinished.length}
        </span>
      </div>
      <Bar ratio={board.overall.ratio} />

      {focused ? (
        <>
          <div style={styles.metricRow}>
            <span style={styles.metricLabel}>◆ 关注枝</span>
            <span style={styles.metricValue}>{formatPercent(board.focused)}</span>
            <span style={styles.metricSub}>{formatCounts(board.focused)}</span>
          </div>
          <Bar ratio={board.focused.ratio} color="#3b82f6" />
        </>
      ) : (
        <div style={styles.hint}>还没有关注枝：点下面的 ◆ 关注一条，右栏与画布都会盯着它。</div>
      )}

      {empty ? (
        <div style={styles.hint}>还没有节点。去完整看板「扫描工作区」或让 AI 从仓库生成任务树。</div>
      ) : rows.length === 0 ? (
        <div style={styles.hint}>全部完成 ✓</div>
      ) : (
        <>
          <div style={styles.sectionTitle}>
            未完成 {board.unfinished.length} 项
            {board.unfinished.length > rows.length ? `（列前 ${rows.length}）` : ''}
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
              <span style={styles.rowName} title={nodeRowLabel(node)}>
                {node.name}
              </span>
              <span style={styles.rowMeta}>{Math.round(node.progress * 100)}%</span>
              <button
                type="button"
                style={{
                  ...styles.focusButton,
                  opacity: node.focus ? 1 : 0.55,
                  color: node.focus ? '#3b82f6' : 'inherit',
                }}
                disabled={busy === node.id}
                title={node.focus ? '取消关注' : '关注（看板与右栏都会盯这条枝）'}
                onClick={() => toggleFocus(node)}
              >
                ◆
              </button>
            </div>
          ))}
        </>
      )}

      {board.conflicts.length > 0 ? (
        <div style={styles.warn}>{board.conflicts.length} 处冲突待处理（详情在完整看板的状态条）。</div>
      ) : null}
      {notice !== undefined ? <div style={styles.error}>{notice}</div> : null}
      {error !== undefined ? <div style={styles.error}>刷新失败：{error}</div> : null}

      {props.onOpenBoard ? (
        <button type="button" style={styles.openButton} onClick={props.onOpenBoard}>
          打开完整看板
        </button>
      ) : null}
    </div>
  );
}

/** 进度条（与画布同一套语义：填充 = 完成比例，颜色只做强调）。 */
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
  badge: {
    fontSize: 10,
    padding: '0 5px',
    borderRadius: 8,
    border: '0.5px solid currentColor',
    opacity: 0.8,
    flex: '0 0 auto',
  },
  workspace: { fontSize: 10.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  metricRow: { display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 },
  metricLabel: { fontSize: 11, opacity: 0.75, flex: '0 0 auto' },
  metricValue: { fontSize: 20, fontWeight: 700, lineHeight: 1.1 },
  metricSub: { fontSize: 10.5, opacity: 0.65, marginLeft: 'auto', textAlign: 'right' as const },
  track: { height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.28)', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, transition: 'width 200ms ease-out' },
  sectionTitle: { fontSize: 11, fontWeight: 600, opacity: 0.8, marginTop: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
  rowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  rowMeta: { fontSize: 10.5, opacity: 0.6, flex: '0 0 auto' },
  focusButton: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: '0 2px',
    fontSize: 12,
    flex: '0 0 auto',
  },
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
  openButton: {
    marginTop: 8,
    padding: '5px 10px',
    fontSize: 11.5,
    borderRadius: 5,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.9,
  },
};

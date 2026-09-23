/**
 * 主面板：项目进度看板（三段式，§11.1）。
 *
 * 三段：① 标题看板（只有百分比与计数）② **流程图**（`FlowCanvas`）③ 状态条（可折叠）。
 * 未完成列表（FR-35）常驻看板下方但默认折叠 —— 中间那一段必须是图，不是清单。
 *
 * 数据来自宿主 HTTP 路由（`/pm/board`），按刷新间隔轮询；
 * 面板不持有权威状态，只做呈现（§12.4：事实源在宿主）。
 */

import * as React from 'react';

import {
  postAiBuild,
  postNodeAction,
  postRemoveBranch,
  postRollback,
  postScan,
  postScanApply,
  fetchSnapshots,
  reportClient,
  type PanelNodeAction,
  type ScanPreview,
  type SnapshotRow,
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  fetchBoard,
  formatBasis,
  formatCounts,
  formatPercent,
  nodeRowLabel,
  nodeRowTitle,
} from './api.ts';
import type { BoardSnapshot } from './contract.ts';
import { FlowCanvas, type FlowOverlay, type RollbackChoice } from './flow-canvas.tsx';
import { NodeInspector } from './node-inspector.tsx';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

/** 构建期注入的版本号（见 tsdown 的 `define`）。 */
declare const __PM_VERSION__: string | undefined;

/**
 * `useSessions` 标准钩子的结构类型（`SnapshotSelectorHook<SessionListState>` 的最小面）。
 *
 * 只声明我们真正用到的字段：`current`（当前会话 id）。
 */
export type SessionsSelectorHook = <T>(selector: (state: { current?: string }) => T) => T;

/**
 * 面板组件 props（`PropsRuntime<'main'>` + 注入面）。
 *
 * `useSessions` **不需要**我们注入：它是 DSH 的**全局标准源**（`GlobalStandardProps`），
 * 由渲染器把 `{...kit}` 摊进每个 slot 条目的 props
 * （`standardHookPropName('sessions') === 'useSessions'`，见 dsh-client-ui-renderer）。
 *
 * 我们用它读**当前会话 id**，再交给宿主的 `/pm/board?sessionId=…`：
 * 宿主据此把工作区根**精确**解析到"你正在看的那个工作区"，
 * 而不是退化成"最近使用过的那个工作区"。
 *
 * 未拿到该钩子时（宿主没有会话层 / 单测直接渲染）保持 undefined，
 * 此时宿主按"最近使用的工作区"解析——仍然不会瞎猜。
 */
export interface BoardPanelProps {
  /** 刷新间隔（毫秒），由宿主设置同步。 */
  intervalMs?: number;
  /** 会话列表选择器钩子（全局标准源；缺失时为 undefined）。 */
  useSessions?: SessionsSelectorHook;
}

/**
 * 局部错误边界：**把"空白"变成"看得见的报错"**。
 *
 * 为什么必须有：槽位错误边界只会在主区域留下一个空 div（`data-slot-error`），
 * 用户看到的就是"点开一片空白"，既不知道该刷新还是该反馈。
 * 这里兜住画布的渲染异常，退化成一条可读的错误 + 说明，并上报到宿主诊断。
 */
class CanvasBoundary extends React.Component<
  { children?: React.ReactNode; onError: (error: Error) => void },
  { failure: string | undefined }
> {
  constructor(props: { children?: React.ReactNode; onError: (error: Error) => void }) {
    super(props);
    this.state = { failure: undefined };
  }

  static getDerivedStateFromError(error: unknown): { failure: string } {
    return { failure: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  override render(): React.ReactNode {
    if (this.state.failure !== undefined) {
      return React.createElement(
        'div',
        { style: { padding: 16, fontSize: 12, lineHeight: 1.7 } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '流程图渲染失败'),
        React.createElement('div', { style: { opacity: 0.8 } }, this.state.failure),
        React.createElement(
          'div',
          { style: { opacity: 0.7, marginTop: 6 } },
          '看板数据仍然是好的：可展开上方「未完成 N 项」列表继续用；' +
            '这个错误已上报宿主，可在 /pm/debug 的「客户端 bundle」里查看堆栈。',
        ),
      );
    }
    return this.props.children;
  }
}

/** 选择当前会话 id。 */
function selectCurrentSession(state: { current?: string }): string | undefined {
  return state.current;
}

/**
 * 标准源缺失时的替身：不订阅、恒返回 undefined。
 *
 * 这里仍然调用一个 Hook（`useState`），是为了让 Hook 调用**次数**在
 * "标准源出现/消失"时保持一致——渲染器缓存了 standard kit，
 * 正常不会变，但保持次数稳定能避免潜在的 Hook 顺序问题。
 */
export function useAbsentSessions<T>(_selector: (state: { current?: string }) => T): T | undefined {
  useState(undefined);
  return undefined;
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    // 用 `minHeight` 而不是定高 `height`：面板容器未必是定高 flex，
    // 定高会在内容撑不开时把中间的画布压成 0 像素（实测表现为"点开一片空白"）
    minHeight: '100%',
    fontSize: 13,
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  board: {
    padding: '12px 16px',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' as const },
  projectName: { fontSize: 15, fontWeight: 600 },
  metrics: { display: 'flex', gap: 20, flexWrap: 'wrap' as const },
  metric: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  metricLabel: { fontSize: 11, opacity: 0.65 },
  metricValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  band: { display: 'flex', gap: 1, height: 10, alignItems: 'stretch', marginTop: 2 },
  bandCell: { width: 4, borderRadius: 1 },
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 16px 24px' },
  /** 空工作区引导（无树时占据流程图那一段）。 */
  emptyWrap: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px 24px' },
  /** 未完成列表（FR-35）：常驻看板下方，但默认折叠，避免把流程图挤出视野。 */
  listBox: {
    maxHeight: 190,
    overflow: 'auto',
    marginTop: 6,
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    paddingTop: 4,
  },
  rowSelected: { background: 'rgba(37,99,235,0.14)', borderRadius: 4 },
  selectionBar: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginTop: 6,
    paddingTop: 6,
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
  },
  confirmBox: {
    marginTop: 6,
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 12,
    background: 'rgba(239,68,68,0.10)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
  /** AI 建树入口行（FR-39；成本提示与按钮同排）。 */
  aiBar: { display: 'flex', alignItems: 'center', marginTop: 6, flexWrap: 'wrap' as const },
  toggleLabel: { fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, opacity: 0.8 },
  headerButton: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  statusBar: {
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    background: 'var(--dsw-alias-bg-secondary, transparent)',
  },
  statusToggle: {
    width: '100%',
    textAlign: 'left' as const,
    fontSize: 11,
    padding: '5px 12px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  statusBadge: {
    fontSize: 10,
    padding: '0 5px',
    borderRadius: 8,
    border: '0.5px solid currentColor',
    opacity: 0.85,
  },
  statusBody: { maxHeight: 200, overflow: 'auto' },
  sectionTitle: { fontSize: 12, fontWeight: 600, margin: '16px 0 6px', opacity: 0.8 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 6px',
    borderRadius: 4,
    lineHeight: 1.5,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
  rowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 8,
    border: '0.5px solid currentColor',
    opacity: 0.85,
    flex: '0 0 auto',
  },
  note: { fontSize: 11, opacity: 0.7, lineHeight: 1.6 },
  warn: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 4,
    background: 'rgba(245,158,11,0.12)',
    border: '0.5px solid rgba(245,158,11,0.5)',
  },
  error: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 4,
    background: 'rgba(239,68,68,0.12)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
  empty: { padding: 24, textAlign: 'center' as const, opacity: 0.7, lineHeight: 1.8 },
  /** 中段：画布 + 属性栏并排（属性栏固定宽度，画布吃掉剩余空间）。 */
  middle: { display: 'flex', flex: '1 1 auto', minHeight: 0, alignItems: 'stretch' },
  canvasSlot: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 },
};

/**
 * 轮询看板数据。面板是"只读投影"，因此轮询足够，无需长连接。
 *
 * @param intervalMs - 轮询间隔（毫秒，下限 500）。
 * @param sessionId - 当前会话 id；带上它宿主才能把工作区根精确解析到该会话的工作区。
 */
export function useBoardData(
  intervalMs: number,
  sessionId?: string,
): {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
} {
  const [board, setBoard] = useState<BoardSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);

  // 会话切换：立刻丢掉上一棵项目树的投影，避免短暂显示"别人的看板"。
  useEffect(() => {
    setBoard(undefined);
  }, [sessionId]);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void fetchBoard(undefined, sessionId)
      .then((outcome) => {
        if (outcome.ok && outcome.value) {
          setBoard(outcome.value);
          setError(undefined);
        } else {
          setError(outcome.error ?? '未知错误');
        }
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, Math.max(500, intervalMs));
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);

  return { board, error, refresh };
}

/**
 * 面板外壳：只负责"取数据"，渲染全部交给 {@link BoardView}。
 *
 * 拆开的原因（实测踩过）：整块逻辑挤在一起时，`board` 还没到就崩不出来的 bug
 * （TDZ）在自检里根本覆盖不到 —— 因为自检没法给组件喂假数据。
 * 现在 `BoardView` 只吃 props，自检可以直接把"有数据的看板"喂进去，
 * 于是"拿到数据就崩"这类问题在 `pnpm run verify` 就会被挡住。
 */
export function BoardPanel(props: BoardPanelProps): React.ReactElement {
  // 全局标准源 `useSessions`（渲染器摊进 kit）→ 当前会话 id。
  // 无条件调用同一组 Hook：标准源缺失时用替身，保证 Hook 次数稳定。
  const useSessions = props.useSessions ?? useAbsentSessions;
  const sessionId = useSessions(selectCurrentSession);
  const { board, error, refresh } = useBoardData(props.intervalMs ?? 1000, sessionId);
  return React.createElement(BoardView, { board, error, refresh, sessionId });
}

export interface BoardViewProps {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
  sessionId: string | undefined;
}

/** 纯呈现：三段式布局（FR-40）+ 交互状态。不取数据，因此可被自检直接渲染。 */
export function BoardView(props: BoardViewProps): React.ReactElement {
  const { board, error, refresh, sessionId } = props;
  const empty = board !== undefined && board.nodes.length === 0;
  // 三段式布局（FR-40）：① 标题看板 ② 流程图 ③ 状态条。
  // 未完成列表按 FR-35 常驻看板下方，但默认折叠 —— 中间那段必须是**流程图**，
  // 否则用户看到的是一份文件/节点清单（实测反馈）。
  const [showList, setShowList] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // 注意：`selectedId` 必须先声明再使用。曾经把这一行写在 useState 之上，
  // 结果是"加载态正常、拿到数据就崩"（`board?.nodes.find` 里踩 TDZ，
  // ReferenceError: Cannot access 'selectedId' before initialization）——
  // SSR 只渲染了 board 为 undefined 的分支，所以完全没暴露（实测踩过）。
  const selectedNode = board?.nodes.find((node) => node.id === selectedId);
  /** 删除确认框（FR-57 的面板路径）：先 preview，用户在面板内确认后才落库。 */
  const [removePrompt, setRemovePrompt] = useState<{ nodeId: string; preview: string } | undefined>(
    undefined,
  );
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  /**
   * AI 建树的确认框（FR-39b：**先给成本，再决定是否花 token**）。
   *
   * 面板按钮 → 先要预估（不调模型）→ 显示"发多少、几次调用、约多少 token" →
   * 用户点确认才真正发起。模型侧走不到这条路径（那里必须过 `ctx.approval`，fail-closed）。
   */
  const [aiPrompt, setAiPrompt] = useState<
    { description: string; route: string } | undefined
  >(undefined);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<string | undefined>(undefined);
  const [aiError, setAiError] = useState<string | undefined>(undefined);
  /** 是否先清掉上次自动建出的草稿（默认是：阶段 B 改写阶段 A 的骨架）。 */
  const [aiReplaceDraft, setAiReplaceDraft] = useState(true);

  /**
   * 右键菜单动作的三种落地方式（FR-6.6）：
   * ① 直接执行（关注/取消关注/继续/放行）；② 先填文本（添加/改名/描述）；
   * ③ 先看影响范围再确认（暂停/拦停/打回滚点）。确认人是面板前的用户（§6.7f 第 2 行）。
   */
  const [menuText, setMenuText] = useState<
    { action: PanelNodeAction; nodeId: string; label: string } | undefined
  >(undefined);
  const [menuInput, setMenuInput] = useState('');
  const [menuConfirm, setMenuConfirm] = useState<
    { action: PanelNodeAction; nodeId: string; label: string; preview: string } | undefined
  >(undefined);
  const [menuNotice, setMenuNotice] = useState<string | undefined>(undefined);
  const [menuError, setMenuError] = useState<string | undefined>(undefined);

  /** 执行一个菜单动作（`needs-confirm` 时转为确认框，不直接落库）。 */
  const runNodeAction = useCallback(
    (action: PanelNodeAction, nodeId: string, extra?: { text?: string; confirm?: boolean }) => {
      setMenuError(undefined);
      void postNodeAction({
        action,
        nodeId,
        ...(extra?.confirm === true ? { confirm: true } : {}),
        ...(extra?.text !== undefined ? { text: extra.text } : {}),
      }).then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          setMenuError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status === 'needs-confirm') {
          const labels: Record<string, string> = { pause: '暂停', hold: '拦停', snapshot: '打回滚点' };
          setMenuConfirm({
            action,
            nodeId,
            label: labels[action] ?? action,
            preview: value.preview ?? '（无影响范围说明）',
          });
          return;
        }
        if (value.status === 'denied') {
          setMenuError(value.message ?? '被拒绝');
          return;
        }
        const detail = value.detail;
        const suffix =
          detail !== undefined && typeof detail['handoff'] === 'string'
            ? `（交接文档 ${detail['handoff']}）`
            : detail !== undefined && typeof detail['snapshot'] === 'string'
              ? `（回滚点 ${detail['snapshot']}）`
              : '';
        setMenuNotice(`${value.message ?? '已完成'}${suffix}`);
        refresh();
      });
    },
    [refresh],
  );

  // 说明：`handleNodeAction` 依赖 `askRemove`（删除走独立路径），
  // 因此它必须定义在 `askRemove` 之后 —— 这一块整体放在文件靠下的位置。


  /** 第一步：要成本预估（不花 token）。 */
  const askAiBuild = useCallback(() => {
    setAiError(undefined);
    setAiResult(undefined);
    setAiBusy(true);
    void postAiBuild({
      confirm: false,
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    })
      .then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          setAiError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status === 'needs-confirm') {
          setAiPrompt({ description: value.description, route: value.route });
          return;
        }
        if (value.status === 'denied') setAiError(`${value.hint}（${value.reason}）`);
        else if (value.status === 'error') setAiError(value.message);
        else setAiError('意外状态：预估没有返回可确认的信息');
      })
      .finally(() => setAiBusy(false));
  }, [sessionId]);

  /** 第二步：用户确认后真的调模型。 */
  const confirmAiBuild = useCallback(() => {
    setAiBusy(true);
    setAiError(undefined);
    void postAiBuild({
      confirm: true,
      replaceAutoDraft: aiReplaceDraft,
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    })
      .then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          setAiError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status === 'ok') {
          setAiPrompt(undefined);
          setAiResult(
            `AI 建树完成：新建 ${value.created} 个、更新 ${value.updated} 个` +
              (value.removed > 0 ? `、清掉草稿 ${value.removed} 枝` : '') +
              `（模型提出 ${value.proposed} 个节点）` +
              (value.failures.length > 0 ? `，失败 ${value.failures.length} 个` : '') +
              (value.notes.length > 0 ? `\n说明：${value.notes.join('；')}` : ''),
          );
          refresh();
          return;
        }
        if (value.status === 'denied') setAiError(`${value.hint}（${value.reason}）`);
        else if (value.status === 'error') {
          // 一并显示模型的原始输出片段：否则"找不到 JSON"这类报错完全看不出原因（实测踩过）
          setAiError(
            value.rawText !== undefined && value.rawText.trim() !== ''
              ? `${value.message}\n模型原始输出片段：${value.rawText.slice(0, 300)}`
              : value.message,
          );
        } else setAiError('仍在待确认状态：请重新点击。');
      })
      .finally(() => setAiBusy(false));
  }, [aiReplaceDraft, refresh, sessionId]);

  const selectNode = useCallback((nodeId: string) => {
    setSelectedId(nodeId);
    setShowList(true);
    // 列表是"图 → 列表"的回链：选中后把它滚进视野（FR-35 双向联动）
    window.requestAnimationFrame(() => {
      document.getElementById(`pm-row-${nodeId}`)?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  /** 第一步：拿删除影响范围（不落库）。 */
  const askRemove = useCallback((nodeId: string) => {
    setRemoveError(undefined);
    void postRemoveBranch({ nodeId, policy: 'record', confirm: false }).then((outcome) => {
      if (!outcome.ok || !outcome.value) {
        setRemoveError(outcome.error ?? '未知错误');
        return;
      }
      if (outcome.value.status === 'needs-confirm') {
        setRemovePrompt({ nodeId, preview: outcome.value.preview });
        return;
      }
      if (outcome.value.status === 'denied') {
        setRemoveError(outcome.value.message ?? outcome.value.reason ?? '被拒绝');
      }
    });
  }, []);

  /** 第二步：用户在面板内确认后执行。 */
  const confirmRemove = useCallback(() => {
    if (!removePrompt) return;
    void postRemoveBranch({ nodeId: removePrompt.nodeId, policy: 'record', confirm: true }).then(
      (outcome) => {
        if (!outcome.ok || !outcome.value) {
          setRemoveError(outcome.error ?? '未知错误');
          return;
        }
        if (outcome.value.status === 'denied') {
          setRemoveError(outcome.value.message ?? outcome.value.reason ?? '被拒绝');
          return;
        }
        setRemovePrompt(undefined);
        setSelectedId(undefined);
        refresh();
      },
    );
  }, [removePrompt, refresh]);

  /**
   * 回滚浮层（FR-51b/53b）：**选回滚点 + 选范围**，所以不能复用"是/否"确认框。
   *
   * 两阶段：先以 `confirm:false` 拿影响范围与快照清单，用户在浮层里选好后
   * 再以 `confirm:true` 执行。确认人是面板前的当场用户（§6.7f 第 2 行）。
   */
  const [rollbackPrompt, setRollbackPrompt] = useState<
    | {
        nodeId: string;
        branch: boolean;
        preview: string;
        snapshots: SnapshotRow[];
        snapshotId: string;
        scope: 'code' | 'state' | 'both';
        confirmShared: boolean;
        sharedBlocked?: string[];
      }
    | undefined
  >(undefined);

  /** 第一步：拿影响范围 + 回滚点清单（不执行任何回滚）。 */
  const askRollback = useCallback(
    (nodeId: string, branch: boolean) => {
      setMenuError(undefined);
      setMenuNotice(undefined);
      void Promise.all([
        postRollback({
          nodeId,
          branch,
          scope: 'both',
          confirm: false,
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
        }),
        fetchSnapshots(nodeId, undefined, sessionId),
      ]).then(([outcome, list]) => {
        if (!outcome.ok || !outcome.value) {
          setMenuError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status !== 'needs-confirm') {
          setMenuError(
            value.status === 'denied'
              ? (value.message ?? value.reason ?? '被拒绝')
              : '仍在待确认状态：请重新点击。',
          );
          return;
        }
        const snapshots = list.ok && list.value ? list.value.snapshots : [];
        const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]!.snapshotId : '';
        setRollbackPrompt({
          nodeId,
          branch,
          preview: value.preview,
          snapshots,
          snapshotId: latest,
          scope: 'both',
          confirmShared: false,
        });
      });
    },
    [sessionId],
  );

  /** 第二步：用户选好回滚点与范围后执行。 */
  const confirmRollback = useCallback(() => {
    const pending = rollbackPrompt;
    if (!pending) return;
    void postRollback({
      nodeId: pending.nodeId,
      branch: pending.branch,
      scope: pending.scope,
      confirm: true,
      confirmShared: pending.confirmShared,
      ...(pending.snapshotId !== '' ? { snapshotId: pending.snapshotId } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    }).then((outcome) => {
      if (!outcome.ok || !outcome.value) {
        setMenuError(outcome.error ?? '未知错误');
        return;
      }
      const value = outcome.value;
      if (value.status === 'denied') {
        // 共享文件被拦：把清单带回浮层，勾选"同时还原"再来一次（而不是让用户猜）
        if (value.code === 'C_SHARED') {
          const blocked = (value.hint ?? '')
            .split('：')
            .slice(1)
            .join('：')
            .split('、')
            .map((item) => item.trim())
            .filter((item) => item !== '');
          setRollbackPrompt({ ...pending, sharedBlocked: blocked });
          setMenuError(value.message ?? '需要二次确认共享文件');
          return;
        }
        setMenuError(value.message ?? value.reason ?? '被拒绝');
        return;
      }
      if (value.status !== 'ok') {
        setMenuError('仍在待确认状态：请重新点击。');
        return;
      }
      setRollbackPrompt(undefined);
      setMenuNotice(
        `回滚完成：还原 ${value.restoredFiles.length} 个文件、删除 ${value.deletedFiles.length} 个、重置 ${value.resetNodes} 个节点` +
          (value.preRollbackSnapshotId !== undefined ? '（已建 pre-rollback，可撤销）' : ''),
      );
      refresh();
    });
  }, [refresh, rollbackPrompt, sessionId]);

  /**
   * 统一的"节点旁浮层"：文本输入（添加/改名/描述）与确认（暂停/拦停/回滚点/删除整枝）。
   *
   * 三者合成一个 `overlay` 交给画布渲染 —— 浮层贴在**被操作的节点旁边**，
   * 而不是渲染在面板顶部让用户去找（实测反馈："跳到了标题那里，我还要找它"）。
   */
  const overlay: FlowOverlay | undefined = menuText
    ? { kind: 'text', nodeId: menuText.nodeId, title: menuText.label }
    : menuConfirm
      ? {
          kind: 'confirm',
          nodeId: menuConfirm.nodeId,
          title: `确认${menuConfirm.label}？`,
          body: menuConfirm.preview,
        }
      : removePrompt
        ? {
            kind: 'confirm',
            nodeId: removePrompt.nodeId,
            title: '确认删除整枝？',
            body: removePrompt.preview,
          }
        : rollbackPrompt
          ? {
              kind: 'rollback',
              nodeId: rollbackPrompt.nodeId,
              title: rollbackPrompt.branch ? '确认整枝回滚？' : '确认回滚？',
              branch: rollbackPrompt.branch,
              preview: rollbackPrompt.preview,
              snapshots: rollbackPrompt.snapshots,
              snapshotId: rollbackPrompt.snapshotId,
              scope: rollbackPrompt.scope,
              confirmShared: rollbackPrompt.confirmShared,
              ...(rollbackPrompt.sharedBlocked !== undefined
                ? { sharedBlocked: rollbackPrompt.sharedBlocked }
                : {}),
            }
          : undefined;

  /** 浮层提交：按当前挂起的是哪一种操作分发。 */
  const submitOverlay = useCallback(
    (text: string) => {
      if (menuText !== undefined) {
        const pending = menuText;
        setMenuText(undefined);
        runNodeAction(pending.action, pending.nodeId, { text });
        return;
      }
      if (menuConfirm !== undefined) {
        const pending = menuConfirm;
        setMenuConfirm(undefined);
        runNodeAction(pending.action, pending.nodeId, { confirm: true });
        return;
      }
      if (removePrompt !== undefined) {
        confirmRemove();
        return;
      }
      if (rollbackPrompt !== undefined) confirmRollback();
    },
    [confirmRemove, confirmRollback, menuConfirm, menuText, removePrompt, rollbackPrompt, runNodeAction],
  );

  const cancelOverlay = useCallback(() => {
    setMenuText(undefined);
    setMenuConfirm(undefined);
    setRemovePrompt(undefined);
    setRollbackPrompt(undefined);
  }, []);

  /** 菜单入口：按动作类型分流。 */
  const handleNodeAction = useCallback(
    (action: PanelNodeAction | 'remove' | 'rollback' | 'branch-rollback', nodeId: string) => {
      // 删除走的是「三方案 + 影响范围确认」那条独立路径
      if (action === 'remove') {
        setMenuNotice(undefined);
        askRemove(nodeId);
        return;
      }
      // 回滚/整枝回滚走「选回滚点 + 选范围」那条独立路径（FR-51b/53b）
      if (action === 'rollback' || action === 'branch-rollback') {
        askRollback(nodeId, action === 'branch-rollback');
        return;
      }
      const textLabels: Partial<Record<PanelNodeAction, string>> = {
        'add-child': '新子节点名称',
        rename: '新名称',
        describe: '节点描述',
      };
      const textLabel = textLabels[action];
      if (textLabel !== undefined) {
        setMenuNotice(undefined);
        setMenuInput('');
        setMenuText({ action, nodeId, label: textLabel });
        return;
      }
      runNodeAction(action, nodeId);
    },
    [askRemove, askRollback, runNodeAction],
  );

  /** ③ 状态条内容：冲突 / 降级 / 文档 / 外部改动 + 图例与口径。 */
  const status = useMemo(() => {
    if (!board) return null;
    return React.createElement(
      'div',
      { style: { padding: '8px 16px 16px' } },
      board.externalChange
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            `外部改动：${board.externalChange.path}（${
              board.externalChange.kind === 'document-changed'
                ? board.externalChange.documentLegal === false
                  ? '文档已不合法'
                  : '文档仍合法'
                : board.externalChange.kind === 'handoff-changed'
                  ? '交接文档变动'
                  : '事实源区域变动'
            }）`,
            React.createElement(
              'div',
              { style: styles.note },
              '文档只是投影：外部改动不会被读成权威值，节点一律以事实源为准。' +
                '需要收敛时用 pm_doc_check（write=true）重新投影。',
            ),
          )
        : null,
      board.conflicts.length > 0
        ? React.createElement(
            'div',
            { style: { ...styles.error, marginBottom: 8 } },
            `⚠ ${board.conflicts.length} 个待仲裁冲突：`,
            board.conflicts.map((c) => ` ${c.code}@${c.nodeId || '?'}`).join('、'),
          )
        : null,
      board.degradation.length > 0
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            '降级项：',
            React.createElement(
              'ul',
              { style: { margin: '4px 0 0 16px', padding: 0 } },
              board.degradation.map((item, index) =>
                React.createElement('li', { key: index }, item),
              ),
            ),
          )
        : null,
      !board.document.legal
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            `文档 ${board.document.path} ${board.document.exists ? '不合法' : '尚未生成'}：`,
            board.document.violations.length > 0
              ? React.createElement(
                  'ul',
                  { style: { margin: '4px 0 0 16px', padding: 0 } },
                  board.document.violations.slice(0, 6).map((v, index) =>
                    React.createElement('li', { key: index }, v),
                  ),
                )
              : null,
          )
        : null,
      React.createElement('div', { style: styles.sectionTitle }, '图例与口径'),
      React.createElement(
        'div',
        { style: styles.note },
        `整体口径：${formatBasis(board.overall)}；快照档位：${board.snapshot.mode}（${board.snapshot.reason}）`,
        React.createElement('br'),
        board.overall.structuralDegenerate === true
          ? React.createElement(
              'span',
              null,
              '⚠ 结构上没有任何区分度（零 token 路径没拿到文件数/行数差异）→ ' +
                '本页数字等同于按件数，已按「按件数·无结构数据」标注。',
              React.createElement('br'),
            )
          : null,
        '流程图编码：**边框**表示完成态（虚线枝=还有未完成叶节点、空心方点=未完成叶节点、绿实线+勾=已完成），',
        '**填充/角标/外发光**表示具体状态（▶ 进行中、! 异常、Ⅱ 暂停、⛔ 拦停、◆ 关注、+ 中途新增、A 自动建出、↺ 已回滚）；',
        '旁枝（未关注）降饱和并以虚线连接。悬停任一节点可看权重依据。',
        React.createElement('br'),
        `确认通道：${board.confirmChannel}`,
        React.createElement('br'),
        '本看板只给百分比与未完成计数，不提供"还需多久"的周期估算。',
      ),
    );
  }, [board]);

  /** 未完成列表（FR-35/36）：常驻看板下方，默认折叠。 */
  const list = useMemo(() => {
    if (!board) return null;
    if (board.unfinished.length === 0) {
      return React.createElement('div', { style: { ...styles.note, padding: '0 16px 8px' } }, '所有叶节点都已完成。');
    }
    return React.createElement(
      'div',
      { style: styles.listBox },
      board.unfinished.map((node) =>
        React.createElement(
          'div',
          {
            key: node.id,
            id: `pm-row-${node.id}`,
            style: {
              ...styles.row,
              ...(selectedId === node.id ? styles.rowSelected : {}),
            },
            onClick: () => setSelectedId(node.id),
          },
          React.createElement('span', {
            style: {
              ...styles.dot,
              background: DERIVED_STATE_COLOR[node.derivedState] ?? '#999',
            },
          }),
          React.createElement(
            'span',
            { style: styles.rowName, title: nodeRowTitle(node) },
            nodeRowLabel(node),
          ),
          node.focus ? React.createElement('span', { style: styles.badge }, '关注') : null,
          node.addedMidway ? React.createElement('span', { style: styles.badge }, '中途新增') : null,
          node.autoCreated ? React.createElement('span', { style: styles.badge }, '自动') : null,
          node.subscriptionCount > 0
            ? React.createElement('span', { style: styles.badge }, `订阅 ${node.subscriptionCount}`)
            : null,
          React.createElement(
            'span',
            { style: styles.badge },
            DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState,
          ),
          React.createElement(
            'span',
            { style: { ...styles.note, fontVariantNumeric: 'tabular-nums' } },
            `${Math.round(node.progress * 100)}%`,
          ),
        ),
      ),
    );
  }, [board, selectedId]);


  return React.createElement(
    'div',
    { style: styles.root },
    // ── ① 标题看板（FR-30–34：只有百分比与计数，绝不出现周期） ──────────
    React.createElement(
      'div',
      { style: styles.board },
      React.createElement(
        'div',
        { style: styles.titleRow },
        React.createElement('span', { style: styles.projectName }, board?.projectName ?? '项目进度'),
        React.createElement(
          'label',
          { style: styles.toggleLabel, title: '只看未完成：把已完成节点从图中滤掉（FR-48）' },
          React.createElement('input', {
            type: 'checkbox',
            checked: hideDone,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setHideDone(event.target.checked),
          }),
          '只看未完成',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setShowList((prev) => !prev),
            style: styles.headerButton,
          },
          `未完成 ${board?.unfinished.length ?? 0} 项 ${showList ? '▾' : '▸'}`,
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: refresh, style: styles.headerButton },
          '刷新',
        ),
      ),
      // "根从哪来"必须可见（FR-71 口径同源）：用户最容易被"面板锁错工作区"迷惑
      React.createElement(
        'div',
        { style: { ...styles.note, marginTop: 2 }, title: sessionId ? `会话 ${sessionId}` : '未拿到当前会话' },
        board?.workspaceRoot.value
          ? `工作区：${board.workspaceRoot.value}（来源：${board.workspaceRoot.source}）`
          : '工作区：未解析到（面板不会读任何目录）',
      ),
      // 版本与规模自检：面板"空白"时，这一行能不能看到就是最快的分诊信息
      // （能看到 → 面板在渲染，问题在中间画布；看不到 → 主槽位压根没渲染我们的组件）
      React.createElement(
        'div',
        { style: { ...styles.note, opacity: 0.55 } },
        `面板 v${typeof __PM_VERSION__ === 'string' ? __PM_VERSION__ : 'dev'} · ` +
          `${board ? `${board.nodes.length} 个节点 / ${board.overall.unfinishedLeaves} 个未完成` : '正在读取…'} · ` +
          `口径 ${formatBasis(board?.overall)}`,
      ),
      error
        ? React.createElement(
            'div',
            { style: styles.error },
            `数据通道不可用：${error}（宿主 HTTP 路由 /pm 未注册时会出现这种情况）`,
          )
        : null,
      React.createElement(
        'div',
        { style: styles.metrics },
        metric('整体完成度', formatPercent(board?.overall), formatCounts(board?.overall)),
        metric('关注枝', formatPercent(board?.focused), formatCounts(board?.focused)),
        metric('未完成叶节点', board ? String(board.overall.unfinishedLeaves) : '—', ''),
        metric('进行中', board ? String(board.overall.runningNodes) : '—', ''),
        metric('异常', board ? String(board.overall.errorNodes) : '—', ''),
      ),
      board && board.scanBand.length > 0
        ? React.createElement(
            'div',
            {
              style: styles.band,
              title: '未完成扫描带：每根竖条 = 一个叶节点，颜色 = 其计算状态；点击定位',
            },
            board.scanBand.map((cell) =>
              React.createElement('span', {
                key: cell.nodeId,
                style: {
                  ...styles.bandCell,
                  background: DERIVED_STATE_COLOR[cell.derivedState] ?? '#999',
                  opacity: cell.derivedState === 'done' ? 0.35 : 1,
                  outline: cell.isFocus ? '1px solid currentColor' : 'none',
                },
                title: `${cell.name} · ${DERIVED_STATE_LABEL[cell.derivedState] ?? cell.derivedState}`,
                onClick: () => selectNode(cell.nodeId),
              }),
            ),
          )
        : null,
      showList ? list : null,
      // 选中节点的操作条（FR-57 的面板路径：删除整枝先给影响范围，再由用户确认）
      // AI 建树入口（FR-39 默认路径）。**先给成本再花 token**：
      // 第一次点击只拿预估（不调模型），确认框里写明发多少内容/几次调用/约多少 token。
      React.createElement(
        'div',
        { style: styles.aiBar },
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.headerButton,
            onClick: askAiBuild,
            disabled: aiBusy,
            title: '让模型读目录骨架与关键文件签名，生成功能点/任务点，并同批给出相对工作量与完成度初判',
          },
          aiBusy && aiPrompt === undefined ? '正在估算成本…' : '用 AI 建树（先看成本）',
        ),
        React.createElement(
          'span',
          { style: { ...styles.note, marginLeft: 8 } },
          '只发送目录骨架与关键文件签名；建树、相对工作量、完成度初判在同一次调用里完成。',
        ),
      ),
      aiPrompt
        ? React.createElement(
            'div',
            { style: styles.confirmBox },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '确认花费 token 建树？'),
            React.createElement('div', { style: styles.note }, aiPrompt.description),
            React.createElement(
              'div',
              { style: { ...styles.note, marginTop: 2 } },
              `模型路由：${aiPrompt.route}`,
            ),
            React.createElement(
              'label',
              {
                style: { ...styles.note, display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 },
              },
              React.createElement('input', {
                type: 'checkbox',
                checked: aiReplaceDraft,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  setAiReplaceDraft(event.target.checked),
              }),
              '先清掉上次自动生成的草稿（只清没人动过的，仅删记录；推荐）',
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 8 } },
              React.createElement(
                'button',
                { type: 'button', style: styles.headerButton, onClick: confirmAiBuild, disabled: aiBusy },
                aiBusy ? '调用中…' : '确认并开始建树',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: styles.headerButton,
                  onClick: () => setAiPrompt(undefined),
                  disabled: aiBusy,
                },
                '取消',
              ),
            ),
          )
        : null,
      aiResult
        ? React.createElement(
            'div',
            { style: { ...styles.note, marginTop: 6, whiteSpace: 'pre-line' as const } },
            aiResult,
          )
        : null,
      aiError
        ? React.createElement('div', { style: { ...styles.error, marginTop: 6 } }, aiError)
        : null,
      selectedNode
        ? React.createElement(
            'div',
            { style: styles.selectionBar },
            React.createElement('span', { style: { fontSize: 11 } }, `已选：${selectedNode.name}`),
            React.createElement(
              'button',
              {
                type: 'button',
                style: styles.headerButton,
                onClick: () => askRemove(selectedNode.id),
                title: '删除该节点及其全部子孙（仅删记录，不动代码）',
              },
              '删除整枝…',
            ),
            React.createElement(
              'button',
              { type: 'button', style: styles.headerButton, onClick: () => setSelectedId(undefined) },
              '取消选择',
            ),
          )
        : null,
      // 注意：删除确认框与文本输入框都**不在**标题区渲染，而是通过 `overlay`
      // 交给画布贴在节点旁边（见下方 FlowCanvas 的 props）。这里只留错误提示。
      removeError
        ? React.createElement('div', { style: { ...styles.error, marginTop: 6 } }, removeError)
        : null,
    ),
    // ── ② 流程图（FR-40/FR-46a；中间这一段必须是图，不是列表） ──────────
    error && !board
      ? React.createElement(
          'div',
          { style: styles.empty },
          '无法读取看板数据。',
          React.createElement('br'),
          React.createElement('span', { style: styles.note }, '宿主 HTTP 路由 /pm 未注册时会出现这种情况。'),
        )
      : !board
        ? React.createElement(
            'div',
            { style: styles.empty },
            '正在读取看板数据…',
            React.createElement('br'),
            React.createElement('span', { style: styles.note }, '首次加载需要宿主完成能力探测与项目初始化。'),
          )
        : empty
          ? React.createElement(
              'div',
              { style: styles.emptyWrap },
              React.createElement(EmptyState, {
                onApplied: refresh,
                ...(sessionId ? { sessionId } : {}),
              }),
              board.workspaceRoot.value === null
                ? React.createElement(
                    'div',
                    { style: { ...styles.error, marginTop: 8 } },
                    '没有解析到工作区根：看板读不到也不该读任何工作区数据。',
                    React.createElement(
                      'div',
                      { style: styles.note },
                      `来源=${board.workspaceRoot.source}；${board.workspaceRoot.detail}`,
                    ),
                  )
                : null,
            )
          : React.createElement(
              // 中段 = 画布 + 右侧属性栏（选中节点时出现）。
              // 属性栏放在**画布外面**（而不是浮在画布上）：画布量到自己的宽度变窄会重新适配视图，
              // 于是"选中节点"不会把树挡在属性栏底下（实测评过：浮层压住节点最难用）。
              'div',
              { style: styles.middle },
              React.createElement(
                'div',
                { style: styles.canvasSlot },
                React.createElement(
                  CanvasBoundary,
                  {
                    onError: (error: Error) =>
                      reportClient({
                        panelId: 'project-manager',
                        bundleId: 'dsh-project-manager',
                        registeredSlots: [],
                        error: { kind: 'canvas-render', message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) },
                      }),
                  },
                  React.createElement(FlowCanvas, {
                    nodes: board.nodes,
                    selectedId,
                    onSelect: selectNode,
                    hideDone,
                    // 折叠状态的本地持久化作用域（换项目就是另一棵树）
                    projectId: board.projectId,
                    onAction: handleNodeAction,
                    // 菜单**同步**决定「回滚」显不显示（FR：没有回滚点就不显示）
                    rollbackPoints: (nodeId: string) => board.rollbackPoints?.[nodeId] ?? 0,
                    // 输入/确认浮层贴在被操作的节点旁边（而不是标题区）
                    overlay,
                    overlayText: menuInput,
                    onOverlayTextChange: setMenuInput,
                    onSubmit: submitOverlay,
                    onCancel: cancelOverlay,
                    onRollbackChoice: (choice: RollbackChoice) =>
                      setRollbackPrompt((prev) =>
                        prev === undefined
                          ? prev
                          : {
                              ...prev,
                              snapshotId: choice.snapshotId,
                              scope: choice.scope,
                              confirmShared: choice.confirmShared,
                            },
                      ),
                  }),
                ),
              ),
              React.createElement(NodeInspector, {
                node: selectedNode,
                onAction: handleNodeAction,
                onClose: () => setSelectedId(undefined),
                rollbackPoints:
                  selectedNode === undefined ? 0 : (board.rollbackPoints?.[selectedNode.id] ?? 0),
              }),
            ),
    // ── ③ 状态条（可折叠）：冲突 / 降级 / 文档 / 外部改动 / 口径图例 ─────
    React.createElement(
      'div',
      { style: styles.statusBar },
      React.createElement(
        'button',
        { type: 'button', onClick: () => setShowStatus((prev) => !prev), style: styles.statusToggle },
        `状态与口径 ${showStatus ? '▾' : '▸'}`,
        board && board.conflicts.length > 0
          ? React.createElement('span', { style: styles.statusBadge }, `${board.conflicts.length} 冲突`)
          : null,
        board && board.degradation.length > 0
          ? React.createElement('span', { style: styles.statusBadge }, `${board.degradation.length} 降级`)
          : null,
        board && !board.document.legal
          ? React.createElement('span', { style: styles.statusBadge }, '文档未生成')
          : null,
      ),
      showStatus
        ? React.createElement('div', { style: styles.statusBody }, status)
        : null,
    ),
  );
}

function metric(label: string, value: string, sub: string): React.ReactElement {
  return React.createElement(
    'div',
    { style: styles.metric },
    React.createElement('span', { style: styles.metricLabel }, label),
    React.createElement('span', { style: styles.metricValue }, value),
    sub ? React.createElement('span', { style: styles.metricLabel }, sub) : null,
  );
}

/**
 * 空工作区引导（FR-38：检测到无项目树时进入引导式扫描，而不是显示空白页）。
 *
 * 两阶段严格分开（§6.4b）：
 * ①「扫描」= 零 token 骨架，立即出建议（FR-39a/39c）；
 * ②「建树」= 把建议落库；AI 建树是**后续**阶段 B，本面板不触发（避免误花 token）。
 */
function EmptyState(props: { onApplied: () => void; sessionId?: string }): React.ReactElement {
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'applying'>('idle');
  const [preview, setPreview] = useState<ScanPreview | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const doScan = useCallback(() => {
    setPhase('scanning');
    setFailure(undefined);
    setMessage(undefined);
    void postScan(undefined, props.sessionId).then((outcome) => {
      setPhase('idle');
      if (!outcome.ok || !outcome.value) {
        setFailure(outcome.error ?? '未知错误');
        return;
      }
      if (!outcome.value.available) {
        setFailure(outcome.value.reason ?? '扫描不可用');
        return;
      }
      setPreview(outcome.value);
    });
  }, [props.sessionId]);

  const doApply = useCallback(() => {
    if (!preview) return;
    setPhase('applying');
    setFailure(undefined);
    void postScanApply(
      { nodes: preview.nodes, projectName: preview.projectName },
      undefined,
      props.sessionId,
    ).then((outcome) => {
      setPhase('idle');
      if (!outcome.ok || !outcome.value) {
        setFailure(outcome.error ?? '未知错误');
        return;
      }
      setMessage(
        `已建树：新建 ${outcome.value.created} 个节点，跳过 ${outcome.value.skipped} 个（幂等去重）` +
          (outcome.value.failures.length > 0 ? `，失败 ${outcome.value.failures.length} 个` : ''),
      );
      props.onApplied();
    });
  }, [preview, props]);

  return React.createElement(
    'div',
    { style: { ...styles.warn, marginBottom: 12 } },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '这个工作区还没有项目树'),
    React.createElement(
      'div',
      { style: styles.note },
      '第一步先做**零 token 骨架扫描**：只看文件树与 package.json / README 等关键文件，',
      '不调用任何 AI，因此不花 token。扫描结果是一份"草稿树"，确认后再落库。',
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: doScan,
          disabled: phase !== 'idle',
          style: buttonStyle(phase === 'idle'),
        },
        phase === 'scanning' ? '扫描中…' : preview ? '重新扫描' : '扫描工作区',
      ),
      preview
        ? React.createElement(
            'button',
            {
              type: 'button',
              onClick: doApply,
              disabled: phase !== 'idle',
              style: buttonStyle(phase === 'idle'),
            },
            phase === 'applying' ? '建树中…' : `建树（${preview.nodes.length} 个节点）`,
          )
        : null,
    ),
    preview
      ? React.createElement(
          'div',
          { style: { marginTop: 8 } },
          React.createElement(
            'div',
            { style: styles.note },
            `扫描到 ${preview.scanned} 个条目，跳过 ${preview.skipped} 个，建议 ${preview.nodes.length} 个节点` +
              (preview.truncated ? '（已截断）' : ''),
          ),
          React.createElement(
            'div',
            { style: { ...styles.note, marginTop: 4 } },
            '前几个建议：',
            preview.nodes
              .slice(0, 8)
              .map((n) => n.name)
              .join('、'),
          ),
          preview.notes.length > 0
            ? React.createElement(
                'ul',
                { style: { margin: '4px 0 0 16px', padding: 0, ...styles.note } },
                preview.notes.map((note, index) =>
                  React.createElement('li', { key: index }, note),
                ),
              )
            : null,
        )
      : null,
    message ? React.createElement('div', { style: { ...styles.note, marginTop: 6 } }, message) : null,
    failure
      ? React.createElement('div', { style: { ...styles.error, marginTop: 6 } }, failure)
      : null,
    React.createElement(
      'div',
      { style: { ...styles.note, marginTop: 8 } },
      '提醒：扫描是抽样与推断，不保证任务清单完整；自动建出的节点带「自动」角标。',
      '需要 AI 细化时，请显式在会话里要求（那一步会消耗 token）。',
    ),
  );
}

function buttonStyle(enabled: boolean): Record<string, unknown> {
  return {
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 4,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  };
}





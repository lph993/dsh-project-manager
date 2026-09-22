/**
 * 主面板：项目进度看板（三段式，§11.1）。
 *
 * 用 `React.createElement` 而非 JSX：无需 jsx runtime 配置，产物更小，
 * 也不依赖 `react/jsx-runtime` 的具体导出形态。
 *
 * 数据来自宿主 HTTP 路由（`/pm/board`），按刷新间隔轮询；
 * 面板不持有权威状态，只做呈现（§12.4：事实源在宿主）。
 */

import * as React from 'react';

import {
  postScan,
  postScanApply,
  type ScanPreview,
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  fetchBoard,
  formatBasis,
  formatCounts,
  formatPercent,
  nodeRowLabel,
} from './api.ts';
import type { BoardSnapshot } from './contract.ts';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

/** 面板组件 props（`PropsRuntime<'main'>` + 注入面）。 */
export interface BoardPanelProps {
  /** 刷新间隔（毫秒），由宿主设置同步。 */
  intervalMs?: number;
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minHeight: 0,
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
};

/** 轮询看板数据。面板是"只读投影"，因此轮询足够，无需长连接。 */
export function useBoardData(intervalMs: number): {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
} {
  const [board, setBoard] = useState<BoardSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void fetchBoard()
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
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, Math.max(500, intervalMs));
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);

  return { board, error, refresh };
}

export function BoardPanel(props: BoardPanelProps): React.ReactElement {
  const { board, error, refresh } = useBoardData(props.intervalMs ?? 1000);
  const empty = board !== undefined && board.nodes.length === 0;

  const body = useMemo(() => {
    if (!board) return null;
    return React.createElement(
      'div',
      { style: styles.body },
      empty ? React.createElement(EmptyState, { onApplied: refresh }) : null,
      board.workspaceRoot.value === null
        ? React.createElement(
            'div',
            { style: { ...styles.error, marginBottom: 8 } },
            '没有解析到工作区根：看板读不到也不该读任何工作区数据。',
            React.createElement(
              'div',
              { style: styles.note },
              `来源=${board.workspaceRoot.source}；${board.workspaceRoot.detail}`,
              React.createElement('br'),
              '在 DSH 侧选中一个工作区（或在本工作区里发起一次工具调用）后刷新即可。',
            ),
          )
        : null,
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
      React.createElement('div', { style: styles.sectionTitle }, `未完成（${board.unfinished.length}）`),
      board.unfinished.length === 0
        ? React.createElement('div', { style: styles.note }, '所有叶节点都已完成。')
        : board.unfinished.map((node) =>
            React.createElement(
              'div',
              { key: node.id, style: styles.row },
              React.createElement('span', {
                style: {
                  ...styles.dot,
                  background: DERIVED_STATE_COLOR[node.derivedState] ?? '#999',
                },
              }),
              React.createElement(
                'span',
                { style: styles.rowName, title: nodeRowLabel(node) },
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
      React.createElement('div', { style: styles.sectionTitle }, '图例与口径'),
      React.createElement(
        'div',
        { style: styles.note },
        `整体口径：${formatBasis(board.overall)}；快照档位：${board.snapshot.mode}（${board.snapshot.reason}）`,
        React.createElement('br'),
        `确认通道：${board.confirmChannel}`,
        React.createElement('br'),
        '本看板只给百分比与未完成计数，不提供"还需多久"的周期估算。',
      ),
    );
  }, [board, empty, refresh]);

  return React.createElement(
    'div',
    { style: styles.root },
    React.createElement(
      'div',
      { style: styles.board },
      React.createElement(
        'div',
        { style: styles.titleRow },
        React.createElement('span', { style: styles.projectName }, board?.projectName ?? '项目进度'),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: refresh,
            style: {
              marginLeft: 'auto',
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 4,
              border: '0.5px solid currentColor',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            },
          },
          '刷新',
        ),
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
              title: '未完成扫描带：每根竖条 = 一个叶节点，颜色 = 其计算状态',
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
              }),
            ),
          )
        : null,
    ),
    body ??
      React.createElement(
        'div',
        { style: styles.empty },
        error ? '无法读取看板数据。' : '正在读取看板数据…',
        React.createElement('br'),
        React.createElement('span', { style: styles.note }, '首次加载需要宿主完成能力探测与项目初始化。'),
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
function EmptyState(props: { onApplied: () => void }): React.ReactElement {
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'applying'>('idle');
  const [preview, setPreview] = useState<ScanPreview | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const doScan = useCallback(() => {
    setPhase('scanning');
    setFailure(undefined);
    setMessage(undefined);
    void postScan().then((outcome) => {
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
  }, []);

  const doApply = useCallback(() => {
    if (!preview) return;
    setPhase('applying');
    setFailure(undefined);
    void postScanApply({ nodes: preview.nodes, projectName: preview.projectName }).then((outcome) => {
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


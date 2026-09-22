/**
 * 设置页分区：确认通道现状 + 快照档位 + 复用的判定能力（FR-89c / FR-89d / §6.7f）。
 *
 * 这一页是 FR-139a 的落点：用户必须能一眼看到
 * 「破坏性操作现在需要在哪里确认」以及「快照当前是哪一档、为什么降级」。
 */

import * as React from 'react';

import { fetchBoard, fetchDebug, fetchProjects, ROUTE_PREFIX } from './api.ts';

const { useEffect, useState } = React;

export interface SettingsSectionProps {
  /** 设置页容器提供的关闭回调（`SettingsSectionOwnerProps`）。 */
  close?: () => void;
}

const styles = {
  root: { display: 'flex', flexDirection: 'column' as const, gap: 12, fontSize: 13, lineHeight: 1.7 },
  card: {
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    borderRadius: 6,
    padding: '10px 12px',
  },
  cardTitle: { fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.85 },
  kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 },
  k: { opacity: 0.65 },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  note: { fontSize: 11, opacity: 0.7 },
  link: { color: 'inherit', textDecoration: 'underline' },
};

/** 诊断数据的轻量形态（`/pm/debug?format=json`）。 */
interface DebugView {
  report: { instanceId?: string; loadedAt?: string; pluginVersion?: string };
  client: { registeredSlots?: string[]; reportedAt?: string } | null;
  capabilities: {
    approval?: boolean;
    userQuestions?: boolean;
    sandboxMode?: string | null;
  };
  storage: { route?: string; projectId?: string };
  logs?: Array<{ seq: number; ts: string; level: string; scope: string; message: string }>;
  logCount?: number;
}

export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'ready';
        board: Awaited<ReturnType<typeof fetchBoard>>['value'];
        projects: number;
        debug: DebugView | undefined;
      }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchBoard(), fetchProjects(), fetchDebug()]).then(
      ([boardOutcome, projectsOutcome, debugOutcome]) => {
        if (cancelled) return;
        if (!boardOutcome.ok || !boardOutcome.value) {
          setState({ status: 'error', message: boardOutcome.error ?? '未知错误' });
          return;
        }
        setState({
          status: 'ready',
          board: boardOutcome.value,
          projects: Array.isArray(
            (projectsOutcome.value as { projects?: unknown[] } | undefined)?.projects,
          )
            ? (projectsOutcome.value as { projects: unknown[] }).projects.length
            : 0,
          debug: debugOutcome.ok ? (debugOutcome.value as unknown as DebugView) : undefined,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return React.createElement('div', { style: styles.root }, '正在读取宿主状态…');
  }
  if (state.status === 'error') {
    return React.createElement(
      'div',
      { style: styles.root },
      React.createElement(
        'div',
        { style: styles.card },
        React.createElement('div', { style: styles.cardTitle }, '数据通道不可用'),
        React.createElement(
          'div',
          { style: styles.note },
          `无法访问宿主路由 ${ROUTE_PREFIX}（${state.message}）。`,
          React.createElement('br'),
          '宿主未注册 webServer 路由时会出现这种情况：面板与设置页都无法读数据，但插件仍应正常加载。',
        ),
      ),
    );
  }

  const board = state.board;
  return React.createElement(
    'div',
    { style: styles.root },
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, '确认通道现状'),
      React.createElement(
        'div',
        { style: styles.note },
        board?.confirmChannel ?? '未知',
      ),
      React.createElement(
        'div',
        { style: { ...styles.note, marginTop: 6 } },
        '说明：破坏性操作在**模型侧**必须取得一次性授权（会话审批策略为 never 时一律拒绝）；',
        '在**面板内**右键操作由用户在场确认。通道不可用时一律拒绝，绝不静默放行。',
      ),
    ),
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, '快照追踪范围'),
      React.createElement(
        'div',
        { style: styles.kv },
        React.createElement('span', { style: styles.k }, '当前档位'),
        React.createElement('span', { style: styles.mono }, board?.snapshot.mode ?? '—'),
        React.createElement('span', { style: styles.k }, '裁决原因'),
        React.createElement('span', null, board?.snapshot.reason ?? '—'),
      ),
    ),
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, '运行时状态'),
      React.createElement(
        'div',
        { style: styles.kv },
        React.createElement('span', { style: styles.k }, '项目数'),
        React.createElement('span', null, String(state.projects)),
        React.createElement('span', { style: styles.k }, '当前项目'),
        React.createElement('span', { style: styles.mono }, board?.projectId ?? '—'),
        React.createElement('span', { style: styles.k }, '数据格式'),
        React.createElement('span', null, `v${board?.dataFormat ?? '?'}`),
        React.createElement('span', { style: styles.k }, '文档'),
        React.createElement(
          'span',
          null,
          `${board?.document.path ?? 'project-manager.md'} · ${
            board?.document.exists ? (board.document.legal ? '合法' : '不合法') : '未生成'
          }`,
        ),
      ),
    ),
    board && board.degradation.length > 0
      ? React.createElement(
          'div',
          { style: styles.card },
          React.createElement('div', { style: styles.cardTitle }, '已降级项'),
          React.createElement(
            'ul',
            { style: { margin: 0, paddingLeft: 18 } },
            board.degradation.map((item, index) => React.createElement('li', { key: index }, item)),
          ),
        )
      : null,
    // ── 诊断（调试入口的 UI 落点）────────────────────────────────
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, '诊断'),
      state.debug
        ? React.createElement(
            'div',
            { style: styles.kv },
            React.createElement('span', { style: styles.k }, '宿主实例'),
            React.createElement('span', { style: styles.mono }, state.debug.report.instanceId ?? '—'),
            React.createElement('span', { style: styles.k }, '加载于'),
            React.createElement('span', { style: styles.mono }, state.debug.report.loadedAt ?? '—'),
            React.createElement('span', { style: styles.k }, '存储路线'),
            React.createElement('span', { style: styles.mono }, state.debug.storage.route ?? '—'),
            React.createElement('span', { style: styles.k }, '客户端已注册槽位'),
            React.createElement(
              'span',
              { style: styles.mono },
              (state.debug.client?.registeredSlots ?? []).join(', ') || '（尚未上报）',
            ),
            React.createElement('span', { style: styles.k }, '诊断记录'),
            React.createElement('span', null, `${state.debug.logCount ?? 0} 条`),
          )
        : React.createElement('div', { style: styles.note }, '诊断数据不可用（/pm/debug 未响应）。'),
      React.createElement(
        'div',
        { style: { ...styles.note, marginTop: 8 } },
        '完整诊断页：',
        React.createElement(
          'a',
          { href: `${ROUTE_PREFIX}/debug`, target: '_blank', rel: 'noreferrer', style: styles.link },
          `${ROUTE_PREFIX}/debug`,
        ),
        ' · JSON：',
        React.createElement(
          'a',
          {
            href: `${ROUTE_PREFIX}/debug?format=json`,
            target: '_blank',
            rel: 'noreferrer',
            style: styles.link,
          },
          '?format=json',
        ),
        ' · 日志：',
        React.createElement(
          'a',
          {
            href: `${ROUTE_PREFIX}/debug/logs`,
            target: '_blank',
            rel: 'noreferrer',
            style: styles.link,
          },
          `${ROUTE_PREFIX}/debug/logs`,
        ),
        React.createElement('br'),
        '面板无数据时依次看：① /pm/health（宿主是否加载）② /pm/debug（能力与降级）③ 浏览器控制台（客户端 bundle 是否运行）。',
      ),
    ),
    React.createElement(
      'div',
      { style: styles.note },
      '本插件是辅助工具，不保证任何结果；百分比为估算值，回滚不保证完整恢复。请自行核实并承担后果。',
    ),
  );
}

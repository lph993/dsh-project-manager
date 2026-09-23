/**
 * 节点属性面板（画布右侧的"属性栏"）。
 *
 * **为什么加**：用户指着画布右侧那块空白说"是不是可以加节点属性，就是节点名称、节点描述、
 * 节点进度等等展示"。流程图擅长表达**结构与位置**，不适合堆文字；选中一个节点后把它的
 * 全部属性放在旁边一栏里，图和细节各司其职，也省得用户去悬停提示里找。
 *
 * 三条口径上的坚持：
 * ① **权重不撒谎**：没有权重来源（AI 估算 / 人工填写）时只说"按件数（每个任务点等权）"，
 *    不把内部凑出来的 1.00 当成信息展示（§9.3a）；
 * ② **进度写出口径**：枝给"未完成 x/y 个任务点"，叶给百分比 + 自身状态；
 * ③ **可追溯**：版本号、最后修改人/时间、旗标（中途新增 / 自动生成 / 回滚过）都摆出来，
 *    因为这块面板的用途之一就是"审查进度"。
 */

import * as React from 'react';

import {
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  nodeRowLabel,
  type PanelNodeAction,
} from './api.ts';
import type { NodeView } from './contract.ts';

const { useState } = React;

/** 属性栏里能直接发起的动作（其余动作走画布右键菜单）。 */
const INSPECTOR_ACTIONS: Array<{ action: PanelNodeAction; label: string; hint: string }> = [
  { action: 'rename', label: '改名', hint: '改这个节点的名称' },
  { action: 'describe', label: '写描述', hint: '补一段这个节点要做什么' },
  { action: 'add-child', label: '加子节点', hint: '在它下面加一个任务点' },
  { action: 'pause', label: '暂停', hint: '暂停它这一枝（可继续）' },
  { action: 'hold', label: '拦停', hint: '拦停这一枝，需要重新评审才放行' },
  { action: 'snapshot', label: '打回滚点', hint: '留一个能回来的时间锚点' },
];

export interface NodeInspectorProps {
  /** 选中的节点；未选中时面板显示引导文案（而不是空白）。 */
  node: NodeView | undefined;
  /** 发起节点动作（与画布右键菜单同一个入口，确认仍由面板的浮层承载）。 */
  onAction?: (action: PanelNodeAction | 'rollback' | 'branch-rollback', nodeId: string) => void;
  /** 收起属性栏。 */
  onClose?: () => void;
  /** 该节点有几个可用回滚点（0 = 不显示「回滚」，与菜单同一条规矩）。 */
  rollbackPoints?: number;
}

/** 属性行：等宽的标签 + 内容（内容作为 createElement 的可变子参数传入，故声明为可选）。 */
function Field(props: { label: string; children?: React.ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { style: styles.field },
    React.createElement('span', { style: styles.fieldLabel }, props.label),
    React.createElement('span', { style: styles.fieldValue }, props.children),
  );
}

/** 节点属性面板。没有选中节点时渲染一句引导（而不是空白，避免用户以为坏了）。 */
export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  const [showRefs, setShowRefs] = useState(true);
  const node = props.node;

  if (node === undefined) {
    return React.createElement(
      'div',
      { style: styles.root },
      React.createElement('div', { style: styles.title }, '节点属性'),
      React.createElement(
        'div',
        { style: styles.hint },
        '在左边的流程图里点一个节点，这里会显示它的名称、描述、进度、权重口径与改动记录。',
      ),
    );
  }

  const isLeaf = node.childCount === 0;
  const stateColor = DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2';
  const flags = [
    node.focus ? '◆ 已关注' : '',
    node.gate === 'paused' ? '已暂停' : '',
    node.gate === 'held' ? '已拦停' : '',
    node.addedMidway ? '中途新增' : '',
    node.autoCreated ? '自动生成' : '',
    // 事实源里的旗标原样展示：认识的翻译过来，不认识的也别吞掉（审查时要看得见）
    ...node.flags.map((flag) => (flag === 'rolledBack' ? '回滚过' : flag)),
  ].filter((flag) => flag !== '');

  return React.createElement(
    'div',
    { style: styles.root },
    React.createElement(
      'div',
      { style: styles.header },
      React.createElement('span', { style: { ...styles.dot, background: stateColor } }),
      React.createElement('span', { style: styles.title, title: nodeRowLabel(node) }, node.name),
      props.onClose
        ? React.createElement(
            'button',
            { type: 'button', style: styles.close, onClick: props.onClose, title: '收起属性栏' },
            '×',
          )
        : null,
    ),
    React.createElement(
      'div',
      { style: styles.subtitle },
      `${node.kind === 'feature' ? '功能点' : '任务点'} · ${DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState} · v${node.revision}`,
    ),

    React.createElement(Field, { label: '路径' }, nodeRowLabel(node)),

    React.createElement(
      Field,
      { label: '进度' },
      isLeaf
        ? `${Math.round(node.progress * 100)}%`
        : `${Math.round(node.progress * 100)}%（未完成 ${node.unfinishedLeafCount}/${node.leafCount} 个任务点）`,
    ),
    React.createElement(
      'div',
      { style: styles.track },
      React.createElement('div', {
        style: { ...styles.fill, width: `${Math.round(node.progress * 100)}%`, background: stateColor },
      }),
    ),

    React.createElement(
      Field,
      { label: '权重' },
      node.weightSource === undefined
        ? '按件数（每个任务点等权）'
        : `${node.weight.toFixed(2)}（${node.weightSource === 'ai' ? 'AI 估算' : '人工填写'}）`,
    ),
    React.createElement(Field, { label: '结构' }, `${node.childCount} 个子节点 · ${node.leafCount} 个任务点`),
    React.createElement(
      Field,
      { label: '最后改动' },
      `${node.updatedBy} · ${node.updatedAt.slice(0, 16).replace('T', ' ')}`,
    ),
    flags.length > 0 ? React.createElement(Field, { label: '标记' }, flags.join(' · ')) : null,
    node.blockedBy.length > 0
      ? React.createElement(Field, { label: '被阻塞' }, `${node.blockedBy.length} 项前置未完成`)
      : null,

    React.createElement('div', { style: styles.sectionTitle }, '描述'),
    React.createElement(
      'div',
      { style: node.description ? styles.description : styles.hint },
      node.description ?? '（还没有描述：用下面的「写描述」补一句，模型和后来的人都会看到）',
    ),

    React.createElement(
      'div',
      { style: styles.sectionTitle },
      React.createElement(
        'button',
        { type: 'button', style: styles.sectionToggle, onClick: () => setShowRefs((prev) => !prev) },
        `引用 ${node.refs?.length ?? 0} 处 ${showRefs ? '▾' : '▸'}`,
      ),
    ),
    showRefs
      ? node.refs && node.refs.length > 0
        ? React.createElement(
            'div',
            { style: styles.refs },
            ...node.refs.map((ref, index) =>
              React.createElement(
                'div',
                { key: `${ref.type}:${ref.target}:${index}`, style: styles.ref },
                React.createElement('span', { style: styles.refType }, ref.type),
                React.createElement(
                  'span',
                  { style: styles.refTarget, title: ref.target },
                  ref.label ?? ref.target,
                ),
              ),
            ),
          )
        : React.createElement('div', { style: styles.hint }, '（没有登记代码/文档引用）')
      : null,

    props.onAction
      ? React.createElement(
          'div',
          { style: styles.actions },
          React.createElement(
            'button',
            {
              type: 'button',
              style: styles.actionPrimary,
              onClick: () => props.onAction?.(node.focus ? 'unfocus' : 'focus', node.id),
            },
            node.focus ? '◆ 取消关注' : '◇ 关注整枝',
          ),
          // 回滚两项：只在**有可用回滚点**时出现（FR-51b/53b：没有锚点就不显示）
          ...((props.rollbackPoints ?? 0) > 0
            ? [
                React.createElement(
                  'button',
                  {
                    key: 'rollback',
                    type: 'button',
                    style: styles.action,
                    title: '回到某个回滚点（可选范围：仅代码 / 仅状态 / 两者）',
                    onClick: () => props.onAction?.('rollback', node.id),
                  },
                  `回滚…（${props.rollbackPoints} 个点）`,
                ),
                ...(node.childCount > 0
                  ? [
                      React.createElement(
                        'button',
                        {
                          key: 'branch-rollback',
                          type: 'button',
                          style: styles.action,
                          title: '一次性回滚整枝内所有节点的副作用',
                          onClick: () => props.onAction?.('branch-rollback', node.id),
                        },
                        '整枝回滚…',
                      ),
                    ]
                  : []),
              ]
            : []),
          ...INSPECTOR_ACTIONS.map((item) =>
            React.createElement(
              'button',
              {
                key: item.action,
                type: 'button',
                style: styles.action,
                title: item.hint,
                onClick: () => props.onAction?.(item.action, node.id),
              },
              item.label,
            ),
          ),
        )
      : null,
  );
}

const styles = {
  root: {
    width: 250,
    flex: '0 0 auto',
    borderLeft: '0.5px solid rgba(148,163,184,0.35)',
    padding: '10px 12px 16px',
    overflow: 'auto',
    fontSize: 12,
    lineHeight: 1.65,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    boxSizing: 'border-box' as const,
    height: '100%',
  },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
  title: {
    fontWeight: 600,
    fontSize: 13,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  close: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 14,
    opacity: 0.6,
    padding: '0 2px',
    flex: '0 0 auto',
  },
  subtitle: { fontSize: 10.5, opacity: 0.7 },
  field: { display: 'flex', gap: 6, alignItems: 'flex-start' },
  fieldLabel: { width: 56, flex: '0 0 auto', opacity: 0.6, fontSize: 11 },
  fieldValue: { flex: 1, minWidth: 0, wordBreak: 'break-word' as const },
  track: { height: 5, borderRadius: 3, background: 'rgba(148,163,184,0.28)', overflow: 'hidden', margin: '2px 0 4px 62px' },
  fill: { height: '100%', borderRadius: 3 },
  sectionTitle: { fontSize: 11, fontWeight: 600, opacity: 0.8, marginTop: 8 },
  sectionToggle: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: 0,
    fontSize: 11,
    fontWeight: 600,
    opacity: 0.8,
  },
  description: { fontSize: 11.5, whiteSpace: 'pre-wrap' as const, opacity: 0.9 },
  hint: { fontSize: 11, opacity: 0.65, lineHeight: 1.7 },
  refs: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  ref: { display: 'flex', gap: 6, alignItems: 'baseline' },
  refType: {
    fontSize: 9.5,
    padding: '0 4px',
    borderRadius: 6,
    border: '0.5px solid currentColor',
    opacity: 0.7,
    flex: '0 0 auto',
  },
  refTarget: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    opacity: 0.85,
  },
  actions: { display: 'flex', flexWrap: 'wrap' as const, gap: 5, marginTop: 10 },
  action: {
    padding: '3px 8px',
    fontSize: 11,
    borderRadius: 5,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.85,
  },
  actionPrimary: {
    padding: '3px 8px',
    fontSize: 11,
    borderRadius: 5,
    border: '0.5px solid #3b82f6',
    background: 'rgba(59,130,246,0.14)',
    color: 'inherit',
    cursor: 'pointer',
  },
};

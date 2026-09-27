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
 * ② **进度写出口径**：枝给"总 x 个任务点 / 已完成 d"与百分比，叶给百分比 + 自身状态；
 *    未完成数**不再是主口径**（用户纠偏：项目宗旨是进度为主）—— 口径唯一来源是 `client/labels.ts`
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
import { hasResourceOpener, openWorkspaceFile } from './navigation.ts';
import { countRatio, doneCountOf, nodeHeadline, percentOf } from './labels.ts';
import { buildNodeSummary } from './summary.ts';
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
  onAction?: (action: PanelNodeAction | 'rollback' | 'branch-rollback', nodeId: string, text?: string) => void;
  /** 收起属性栏。 */
  onClose?: () => void;
  /** 该节点有几个可用回滚点（0 = 不显示「回滚」，与菜单同一条规矩）。 */
  rollbackPoints?: number;
  /** 当前会话 id（点引用要按会话作用域拼文件地址）。 */
  sessionId?: string | undefined;
  /**
   * **跳到某个会话**（用户诉求："点击能跳转到对应会话"）。
   *
   * 由 `index.tsx` 从宿主 `uiWorkspace.openSession` 包一层注入 ——
   * 组件自己拿不到那个服务，也不该拿（槽位组件的 props 才是它的输入面）。
   * 不提供时那一行退化成纯文本（**不做点了没反应的按钮**）。
   */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /**
   * **开一个新会话**（用于"从未完成节点开始处理"）。由 `index.tsx` 注入。
   *
   * 它**只能开空会话** —— 宿主没有"带着任务开新会话"的 API，所以文案里如实写明，
   * 不假装新会话已经知道要干什么。
   */
  onStartSession?: (() => void) | undefined;
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

/** 订阅风险等级的中文标签（FR-110）。 */
const SUBSCRIPTION_RISK_LABEL: Record<string, string> = {
  read: '只读（可无限并行）',
  write: '写入（路径相交需排队）',
  exclusive: '独占（同节点只允许一个）',
};

/** 引用类型里哪些是"能打开的文件"（目录交给 file 预览只会失败，所以不算）。 */
function isOpenableRef(type: string): boolean {
  return type !== 'dir' && type !== 'folder';
}

/**
 * 复制文本到剪贴板（降级路径用）。
 *
 * 两个坑都要防：`navigator.clipboard` 在非安全上下文里不存在；写入也可能被权限拒绝。
 * 返回是否**真的**复制成功 —— 失败时提示里必须说清"请手动复制"，不能假装成功。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 节点属性面板。没有选中节点时渲染一句引导（而不是空白，避免用户以为坏了）。 */
export function NodeInspector(props: NodeInspectorProps): React.ReactElement {
  const [showRefs, setShowRefs] = useState(true);
  const [refNotice, setRefNotice] = useState<string | undefined>(undefined);
  /** 「复制摘要」的临时反馈（2 秒后自动消失）。 */
  const [copyNote, setCopyNote] = useState<string | undefined>(undefined);
  /** 优先级的草稿值（就地编辑用；不随节点变化自动清空是有意的：改完一个常想接着改下一个）。 */
  const [prioDraft, setPrioDraft] = useState('');
  const [prioNote, setPrioNote] = useState<string | undefined>(undefined);
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

  const stateColor = DERIVED_STATE_COLOR[node.derivedState] ?? '#9aa4b2';
  // 顶部大号数字牌的口径（与画布同源：`client/labels.ts`）
  const headline = nodeHeadline(node);
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

    /*
      顶部的**大号数字牌**（用户要求）：选中节点的「总 / 已完成」以大号数字摆在属性栏顶部。
      枝给 `72 / 6`（总任务点 / 已完成），叶给自身百分比 —— 与画布节点同一套口径
      （`client/labels.ts` 是唯一来源），下面配进度条，所以"件数"和"进度"一眼都在。
    */
    React.createElement(
      'div',
      { style: styles.headline },
      React.createElement('div', { style: styles.headlinePrimary }, headline.primary),
      React.createElement('div', { style: styles.headlineCaption }, headline.caption),
      React.createElement(
        'div',
        { style: styles.headlineBarRow },
        React.createElement(
          'div',
          { style: { ...styles.track, ...styles.headlineTrack } },
          React.createElement('div', {
            style: {
              ...styles.fill,
              width: `${percentOf(node.progress)}%`,
              background: stateColor,
            },
          }),
        ),
        React.createElement('span', { style: styles.headlinePercent }, headline.percent),
      ),
    ),

    React.createElement(Field, { label: '路径' }, nodeRowLabel(node)),

    React.createElement(
      Field,
      { label: '权重' },
      node.weightSource === undefined
        ? '按件数（每个任务点等权）'
        : `${node.weight.toFixed(2)}（${node.weightSource === 'ai' ? 'AI 估算' : '人工填写'}）`,
    ),
    /*
      **优先级**（FR-162 ② 的"人可改"）：AI 建树只给初判，改不改由人定。

      两件事必须一起给，少一个就白做：
      ① **看得见**：当前值 + **来源**（AI / 人 / 未设置）——不知道来源就不知道该不该动它；
      ② **改得动**：就地填 1–10（1 最高）或清除。改完落 `prioritySource: 'user'`，
         之后 AI 建树不能覆盖它（服务侧已有该保护），所以这一笔是"钉住"的。
    */
    React.createElement(
      Field,
      { label: '优先级' },
      React.createElement(
        'span',
        { style: { display: 'flex', alignItems: 'center', gap: 6 }, 'data-pm-priority-row': '1' },
        React.createElement(
          'span',
          { 'data-pm-priority-value': node.priority === undefined ? 'none' : String(node.priority) },
          node.priority === undefined
            ? '未设置'
            : `${node.priority}（1 最高，${node.prioritySource === 'user' ? '人填' : 'AI 初判'}）`,
        ),
        React.createElement('input', {
          type: 'number',
          min: 1,
          max: 10,
          value: prioDraft,
          placeholder: '1–10',
          'data-pm-priority-input': '1',
          title: '填 1–10（1 最高）后点「设为」；留空点「设为」＝清除',
          style: styles.prioInput,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPrioDraft(event.target.value),
        }),
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.smallButton,
            'data-pm-priority-set': '1',
            title: '设为这个优先级（来源记作"人"，AI 以后不覆盖）',
            onClick: () => props.onAction?.('set-priority', node.id, prioDraft.trim()),
          },
          '设为',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.smallButton,
            'data-pm-priority-clear': '1',
            title: '清除优先级（回到"未设置"）',
            onClick: () => {
              setPrioDraft('');
              props.onAction?.('set-priority', node.id, '');
            },
          },
          '清除',
        ),
        prioNote !== undefined ? React.createElement('span', { style: styles.hint }, prioNote) : null,
      ),
    ),
    React.createElement(
      Field,
      { label: '结构' },
      // 口径串来自 labels.ts 的 countRatio；前面已有"N 个任务点"，这里只补纯数字（FR-153：不重复说明）
      `${node.childCount} 个子节点 · ${node.leafCount} 个任务点 · ${countRatio(doneCountOf(node), node.leafCount)}`,
    ),
    // FR-110：订阅数量 + 风险等级 + 有几条在等锁（只报数量等于没说）
    node.subscriptionCount > 0
      ? React.createElement(
          Field,
          { label: '订阅' },
          `${node.subscriptionCount} 条${
            node.subscriptionRisk === undefined
              ? ''
              : `（最高风险：${SUBSCRIPTION_RISK_LABEL[node.subscriptionRisk] ?? node.subscriptionRisk}）`
          }${(node.subscriptionWaiting ?? 0) > 0 ? ` · ${node.subscriptionWaiting} 条在等锁` : ''}`,
        )
      : null,
    // FR-111：订阅数超阈值只**提示**，不硬性禁止
    node.subscriptionCount > 3
      ? React.createElement(
          'div',
          { style: styles.hint },
          `这个节点上有 ${node.subscriptionCount} 条订阅（默认阈值 3）：并行度偏高，改前先用 pm_watch_conflicts 看一眼冲突。`,
        )
      : null,
    React.createElement(
      Field,
      { label: '最后改动' },
      `${node.updatedBy} · ${node.updatedAt.slice(0, 16).replace('T', ' ')}`,
    ),
    /**
     * FR-158 ③：疑似遗留（本轮建树没再提到它）。
     *
     * **这里刻意不放"删除"按钮**：删除入口只留右键菜单一处（用户决定 A）。
     * 这一格只负责**说清楚它是什么、以及它还照常计入统计**，然后指路到右键。
     */
    node.stale === true
      ? React.createElement(
          'div',
          { style: styles.staleNotice },
          '疑似遗留：上次建树没再提到它，但它上面有已报过的进度，所以只是标记、还在照常计入统计。' +
            '确认确实不用了，就右键这个节点 → 删除整枝。',
        )
      : null,
    /**
     * **用新会话开始处理**（用户诉求："从未完成节点发起会话进行开始处理的能力"）。
     *
     * 只在**未完成**的节点上给：已完成的活没有"开始处理"可言。
     * ⚠️ 文案必须如实 —— `uiWorkspace.startSession` 只能**开一个空会话**，
     * 插件无法替它预填"要处理哪个节点"（DSH 没这个 API）。
     * 与其假装它自动知道，不如写清"打开后在里面说明要做什么"。
     */
    props.onStartSession !== undefined && node.derivedState !== 'done' && node.derivedState !== 'removed'
      ? React.createElement(
          'div',
          { style: styles.startRow },
          React.createElement(
            'button',
            {
              type: 'button',
              style: styles.startButton,
              title: '新会话是空的（宿主不支持预填任务），打开后请说明要处理这个节点',
              onClick: () => props.onStartSession?.(),
            },
            '用新会话开始处理 ↗',
          ),
          /**
           * **复制摘要**：新会话是空的，所以给它一段"现状"就有用了。
           *
           * 摘要由 `summary.ts` 纯函数拼装（只用**已知字段**，零 token、不替模型下结论）——
           * 点一下拿到文本、粘进新会话即可。复制失败时**如实说失败**，不假装成功。
           */
          React.createElement(
            'button',
            {
              type: 'button',
              style: styles.startButton,
              title: '复制这个节点的现状摘要（路径/状态/规模/描述/引用），粘到新会话里',
              onClick: () => {
                const text = buildNodeSummary(node);
                void navigator.clipboard
                  .writeText(text)
                  .then(() => setCopyNote('已复制 ✓'))
                  .catch(() => setCopyNote('复制失败，请手动复制'));
                window.setTimeout(() => setCopyNote(undefined), 2000);
              },
            },
            '复制摘要',
          ),
          copyNote !== undefined
            ? React.createElement('span', { style: styles.startNote }, copyNote)
            : React.createElement(
                'span',
                { style: styles.startNote },
                '（新会话是空的，进去说明要做什么）',
              ),
        )
      : null,
    flags.length > 0 ? React.createElement(Field, { label: '标记' }, flags.join(' · ')) : null,
    /**
     * **跳到正在处理它的会话**（用户诉求："方便让人看到哪个会话哪个功能上…点击能跳转到对应会话"）。
     *
     * 会话 id 来自**写入记录**（`lastSessionId`：谁改的就记谁），不是靠订阅猜 ——
     * 所以即使从没订阅过、只是报过一次进度，这里也有据可依。
     * 拿不到回调（宿主没提供 `uiWorkspace`）时**只显示不高亮**，绝不画一个点了没反应的按钮。
     */
    node.lastSessionId !== undefined
      ? React.createElement(
          'div',
          { style: styles.sessionRow },
          React.createElement('span', { style: styles.fieldLabel }, '处理它的会话'),
          props.onOpenSession !== undefined
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  style: styles.sessionLink,
                  title: `跳到会话 ${node.lastSessionId}`,
                  onClick: () => props.onOpenSession?.(node.lastSessionId as string),
                },
                `${node.lastSessionId.slice(0, 8)}… ↗`,
              )
            : React.createElement('span', { style: styles.sessionPlain }, `${node.lastSessionId.slice(0, 8)}…`),
        )
      : null,
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
                // 目录引用不给"打开"：右栏文件预览读的是**文件**，点目录只会得到一个失败；
                // 这类引用给"复制路径"，别画一个点了必然失败的按钮。
                isOpenableRef(ref.type)
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        style: styles.refTarget,
                        title: `${ref.target}\n点击在右侧栏打开`,
                        onClick: () => {
                          const result = openWorkspaceFile(props.sessionId, ref.target);
                          if (result === 'opened') {
                            setRefNotice(`已在右侧栏打开：${ref.target}`);
                            return;
                          }
                          if (result === 'bad-path') {
                            setRefNotice(
                              `这是绝对路径或空引用，右栏按会话工作区解析不到：${ref.target}（引用应为工作区相对路径）`,
                            );
                            return;
                          }
                          void copyText(ref.target).then((copied) => {
                            setRefNotice(
                              result === 'failed'
                                ? `右栏打不开它，已复制路径：${ref.target}`
                                : copied
                                  ? `右栏未挂载，已复制路径：${ref.target}`
                                  : `右栏未挂载，也复制不了（请手动复制）：${ref.target}`,
                            );
                          });
                        },
                      },
                      ref.label ?? ref.target,
                    )
                  : React.createElement(
                      'span',
                      { style: styles.refPlain, title: `${ref.target}\n目录引用：右栏预览读的是文件` },
                      ref.label ?? ref.target,
                    ),
              ),
            ),
          )
        : React.createElement('div', { style: styles.hint }, '（没有登记代码/文档引用）')
      : null,
    refNotice !== undefined
      ? React.createElement(
          'div',
          {
            style: {
              ...styles.hint,
              marginTop: 4,
            },
          },
          refNotice,
          hasResourceOpener() ? '' : '（诊断：宿主未提供右栏导航面）',
        )
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
  // ── 顶部大号数字牌（用户要求：「总 / 已完成」用大号数字放在属性栏顶部）──
  headline: {
    margin: '8px 0 10px',
    padding: '8px 10px',
    borderRadius: 8,
    background: 'rgba(148,163,184,0.12)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  headlinePrimary: {
    fontSize: 26,
    fontWeight: 700,
    lineHeight: '30px',
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: 0.5,
  },
  headlineCaption: { fontSize: 10.5, opacity: 0.7 },
  headlineBarRow: { display: 'flex', alignItems: 'center', gap: 8 },
  // 大号数字牌里的进度条不受"给字段标签让位"的左边距影响
  headlineTrack: { flex: 1, margin: 0, height: 6 },
  headlinePercent: { fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
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
  /** 优先级就地编辑：输入框窄一点（只填 1–10），两个小按钮与它同排。 */
  prioInput: {
    width: 52,
    padding: '1px 4px',
    fontSize: 12,
    borderRadius: 4,
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))',
    background: 'transparent',
    color: 'inherit',
  },
  smallButton: {
    padding: '1px 6px',
    fontSize: 11,
    borderRadius: 4,
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  /** 「疑似遗留」提示（FR-158 ③）：琥珀色警示，与红色（异常/待删除）区分开。 */
  /** 「跳到处理它的会话」一行：标签 + 可点链接（拿不到跳转能力时退化成纯文本）。 */
  sessionRow: { display: 'flex', alignItems: 'center', gap: 6 },
  sessionLink: {
    border: 'none',
    background: 'transparent',
    color: '#3b82f6',
    cursor: 'pointer',
    padding: 0,
    fontSize: 11,
    textDecoration: 'underline',
  },
  sessionPlain: { fontSize: 11, opacity: 0.75 },
  /** 「用新会话开始处理」：按钮 + 一句如实说明（新会话是空的）。 */
  startRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const },
  startButton: {
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
  },
  startNote: { fontSize: 10.5, opacity: 0.6 },
  staleNotice: {
    fontSize: 11,
    lineHeight: 1.6,
    padding: '5px 8px',
    borderRadius: 4,
    background: 'rgba(148,163,184,0.14)',
    border: '0.5px solid rgba(148,163,184,0.55)',
  },
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
  refPlain: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    opacity: 0.7,
  },
  refTarget: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    opacity: 0.85,
    // 引用是**可点的**：用按钮而不是 span（键盘可达、语义正确），但外观保持像一行路径
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left' as const,
    padding: 0,
    textDecoration: 'underline dotted',
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

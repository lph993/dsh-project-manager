/**
 * 设置页分区：确认通道现状 + 快照档位 + 复用的判定能力（FR-89c / FR-89d / §6.7f）。
 *
 * 这一页是 FR-139a 的落点：用户必须能一眼看到
 * 「破坏性操作现在需要在哪里确认」以及「快照当前是哪一档、为什么降级」。
 */

import * as React from 'react';

import {
  fetchBoard,
  fetchDebug,
  fetchProjects,
  fetchSettings,
  postSettings,
  ROUTE_PREFIX,
  type SettingsView,
} from './api.ts';

const { useCallback, useEffect, useState } = React;

export interface SettingsSectionProps {
  /** 设置页容器提供的关闭回调（`SettingsSectionOwnerProps`）。 */
  close?: () => void;
}

/**
 * 可编辑字段表（FR-80/81/81a/81b/82/87/88）。
 *
 * 刻意**不是**把所有配置项一股脑铺出来：这里只放"用户在面板上真的会改"的那些，
 * 每项都写清"改了什么时候生效"，避免让人以为改完就重建了项目树。
 */
type FieldKind = 'number' | 'boolean' | 'text' | 'csv' | 'choice';

interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  hint: string;
  choices?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
}

const FIELDS: Field[] = [
  {
    key: 'scanMaxDepth',
    label: '扫描深度上限',
    kind: 'number',
    min: 1,
    max: 12,
    hint: '阶段 A 目录最深下钻几层。改了**下一次扫描**生效（已建好的树不动）。',
  },
  {
    key: 'scanMaxChildrenPerDir',
    label: '单目录子项上限',
    kind: 'number',
    min: 1,
    max: 200,
    hint: '防止根目录巨大时节点爆炸；超出会截断并如实标注。',
  },
  {
    key: 'scanMaxNodes',
    label: '单次扫描节点上限',
    kind: 'number',
    min: 1,
    max: 2000,
    hint: '硬上限，超出即截断。',
  },
  {
    key: 'scanInclude',
    label: '包含 glob',
    kind: 'csv',
    hint: '逗号分隔；留空 = 全部。例：`src/**`。',
  },
  {
    key: 'scanExclude',
    label: '排除 glob',
    kind: 'csv',
    hint: '逗号分隔；会**叠加**在内置排除项（node_modules/dist/.git 等）之上，内置项不可取消。',
  },
  {
    key: 'aiProvider',
    label: 'AI 供应商',
    kind: 'text',
    hint: '留空 = 跟随宿主默认模型（FR-81a）。改完下一次「用 AI 建树」生效。',
  },
  { key: 'aiModel', label: 'AI 模型', kind: 'text', hint: '留空 = 跟随宿主默认模型。' },
  {
    key: 'aiMaxOutputTokens',
    label: '单次 AI 输出上限（token）',
    kind: 'number',
    min: 1,
    hint: '预算闸门（FR-81b）：到顶就截断并如实报「可能是截断」，不静默丢内容。',
  },
  {
    key: 'refreshIntervalMs',
    label: '面板刷新间隔（毫秒）',
    kind: 'number',
    min: 200,
    hint: '面板轮询兜底；事件推送为主。',
  },
  {
    key: 'snapshotMode',
    label: '快照档位',
    kind: 'choice',
    choices: [
      { value: 'auto', label: 'auto（按沙箱可写性自动裁决）' },
      { value: 'git', label: 'git（专属 ref）' },
      { value: 'patch', label: 'patch（补丁）' },
      { value: 'full', label: 'full（全量拷贝）' },
    ],
    hint: '改了立即生效（会重新裁决档位）。full 档尚未实现，选了会如实降级。',
  },
  {
    key: 'conflictPolicy',
    label: '冲突策略',
    kind: 'choice',
    choices: [
      { value: 'auto-fix-first', label: 'auto-fix-first（能修就修并留痕）' },
      { value: 'always-arbitrate', label: 'always-arbitrate（一律人工仲裁）' },
    ],
    hint: 'FR-82；只影响可自动修正的那几类（C3/C4），语义冲突永远要人裁决。',
  },
  {
    key: 'heuristicWeight',
    label: '零 token 启发式权重轨',
    kind: 'boolean',
    hint: '默认关闭。开启后会读文件行数并按结构评分 —— 但"已写代码占比"回答不了"还剩多少要写"，默认口径仍应按件数。',
  },
  {
    key: 'aiWeightMeasurement',
    label: 'AI 权重测量',
    kind: 'boolean',
    hint: '默认关闭；开启会消耗 token（仅测关注枝）。',
  },
  {
    key: 'notifyKeyEvents',
    label: '关键事件回写会话',
    kind: 'boolean',
    hint: '默认开启（FR-112）。只发关键事件：完成 / 异常 / 枝完成 / 门控置位与解除；progress 微增不发。',
  },
  {
    key: 'notifySilent',
    label: '静默模式（关闭回写）',
    kind: 'boolean',
    hint: '彻底关闭回写（FR-116）。只关通知面：写入面与文件锁仍然生效，两面独立。',
  },
  {
    key: 'sessionBoundaryWriteback',
    label: '会话边界进度修正',
    kind: 'boolean',
    hint: '默认开启。回合 / 子任务 / 会话结束时，把本会话订阅过、还没开工的节点标成「进行中」，并给未完成的节点投一条提醒（不花 token：只推 pending→running，绝不覆盖你写过的进度）。',
  },
  {
    key: 'sessionBoundaryPrompt',
    label: '进度纪律进系统提示词',
    kind: 'boolean',
    hint: '默认开启。用官方 system-prompt 的两个机制告诉模型「收尾前用 pm_report 汇报」，并列出它绑定的未完成节点（静态段不会破坏前缀缓存）。关掉只影响「模型被告知」，边界上的状态推进照旧。',
  },
];

/** 把生效值渲染成输入框里的文本。 */
function toText(value: unknown, kind: FieldKind): string {
  if (value === undefined || value === null) return '';
  if (kind === 'csv') return Array.isArray(value) ? value.join(', ') : String(value);
  return String(value);
}

/** 输入框文本 → 提交值（数字转数字，csv 转数组，空字符串按"清空"处理）。 */
function fromText(text: string, kind: FieldKind): unknown {
  if (kind === 'number') {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    return Number(trimmed);
  }
  if (kind === 'csv') {
    return text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return text;
}

/** 值班编辑的一份草稿（只在"有改动"时才提交）。 */
interface Draft {
  values: Record<string, string>;
  dirty: boolean;
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
  // 可编辑设置：一行一项，标签在左（含灰字说明），控件在右
  field: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 260px) 1fr',
    gap: '6px 12px',
    alignItems: 'start',
    padding: '6px 0',
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.18))',
  },
  fieldLabel: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  fieldName: { fontSize: 12, fontWeight: 600 },
  fieldHint: { fontSize: 10.5, opacity: 0.65, lineHeight: 1.5 },
  fieldControl: { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 2 },
  input: {
    width: '100%',
    maxWidth: 320,
    fontSize: 12,
    padding: '4px 6px',
    borderRadius: 4,
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.4))',
    background: 'transparent',
    color: 'inherit',
  },
  button: {
    fontSize: 12,
    padding: '5px 12px',
    borderRadius: 5,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  error: {
    marginTop: 8,
    fontSize: 11.5,
    padding: '5px 8px',
    borderRadius: 4,
    background: 'rgba(239,68,68,0.12)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
  notice: {
    marginTop: 8,
    fontSize: 11.5,
    padding: '5px 8px',
    borderRadius: 4,
    background: 'rgba(34,197,94,0.12)',
    border: '0.5px solid rgba(34,197,94,0.5)',
  },
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

/**
 * 可编辑设置区（FR-80/81/81a/81b/82/87/88）。
 *
 * 保存的语义是**补丁**：只把改过的字段发上去（`settings.update()` 是 merge 语义），
 * 因此"改一项"绝不会把其它项悄悄重置成默认值。
 * 校验与持久化都在宿主（官方 settings 服务）做；这里只负责呈现拒绝原因。
 */
export function SettingsForm(props: {
  view: SettingsView;
  onSaved: (effective: Record<string, unknown>) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(() => ({
    values: Object.fromEntries(
      FIELDS.map((field) => [field.key, toText(props.view.effective[field.key], field.kind)]),
    ),
    dirty: false,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const set = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ values: { ...prev.values, [key]: value }, dirty: true }));
    setNotice(undefined);
    setError(undefined);
  }, []);

  const save = useCallback(() => {
    const patch: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const raw = draft.values[field.key] ?? '';
      const next = field.kind === 'boolean' ? raw === 'true' : fromText(raw, field.kind);
      if (next === undefined) continue;
      patch[field.key] = next;
    }
    setBusy(true);
    setError(undefined);
    void postSettings(patch).then((outcome) => {
      setBusy(false);
      if (!outcome.ok || !outcome.value) {
        setError(outcome.error ?? '未知错误');
        return;
      }
      if (outcome.value.ok !== true) {
        setError(outcome.value.message ?? '宿主拒绝了这次修改');
        return;
      }
      setDraft((prev) => ({ ...prev, dirty: false }));
      setNotice('已保存并生效。扫描类设置在**下一次扫描**时使用，已建好的树不会被动。');
      if (outcome.value.effective) props.onSaved(outcome.value.effective);
    });
  }, [draft.values, props]);

  if (!props.view.configurable) {
    return React.createElement(
      'div',
      { style: styles.note },
      props.view.note,
    );
  }

  return React.createElement(
    'div',
    null,
    React.createElement(
      'div',
      { style: styles.note },
      '改动**立即生效**（扫描 glob / AI 路由 / 刷新间隔都是"下次用到时读"）；已经在跑的那一次调用不会被打断。',
    ),
    ...FIELDS.map((field) => {
      const value = draft.values[field.key] ?? '';
      const control =
        field.kind === 'boolean'
          ? React.createElement('input', {
              type: 'checkbox',
              checked: value === 'true',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                set(field.key, event.target.checked ? 'true' : 'false'),
            })
          : field.kind === 'choice'
            ? React.createElement(
                'select',
                {
                  value,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                    set(field.key, event.target.value),
                  style: styles.input,
                },
                ...(field.choices ?? []).map((choice) =>
                  React.createElement(
                    'option',
                    { key: choice.value, value: choice.value },
                    choice.label,
                  ),
                ),
              )
            : React.createElement('input', {
                type: field.kind === 'number' ? 'number' : 'text',
                value,
                ...(field.min !== undefined ? { min: field.min } : {}),
                ...(field.max !== undefined ? { max: field.max } : {}),
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  set(field.key, event.target.value),
                style: styles.input,
              });
      return React.createElement(
        'div',
        { key: field.key, style: styles.field },
        React.createElement(
          'label',
          { style: styles.fieldLabel },
          React.createElement('span', { style: styles.fieldName }, field.label),
          React.createElement('span', { style: styles.fieldHint }, field.hint),
        ),
        React.createElement('div', { style: styles.fieldControl }, control),
      );
    }),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 } },
      React.createElement(
        'button',
        {
          type: 'button',
          style: { ...styles.button, opacity: draft.dirty && !busy ? 1 : 0.5 },
          disabled: !draft.dirty || busy,
          onClick: save,
        },
        busy ? '保存中…' : '保存设置',
      ),
      React.createElement(
        'span',
        { style: styles.note },
        draft.dirty ? '有未保存的改动' : '已与宿主一致',
      ),
    ),
    error !== undefined
      ? React.createElement('div', { style: styles.error }, `宿主拒绝了这次修改：${error}`)
      : null,
    notice !== undefined ? React.createElement('div', { style: styles.notice }, notice) : null,
  );
}

/**
 * 回写消耗卡（FR-117：让"省了多少"可核对）。
 *
 * 抽成**纯函数**而不是内联在 `SettingsSection` 里，是为了让渲染自检能直接喂载荷：
 * 这两张卡读的全是宿主返回的统计字段，而"旧宿主没有这些字段"正是最容易崩的一类。
 */
export function renderNotifyStatsCard(
  notify: SettingsView['notify'],
): React.ReactElement | null {
  if (notify === undefined) return null;
  return React.createElement(
    'div',
    { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, '进度回写消耗'),
    React.createElement(
      'div',
      { style: styles.kv },
      React.createElement('span', { style: styles.k }, '当前状态'),
      React.createElement('span', null, notify.enabled ? '开启（只发关键事件）' : '静默关闭'),
      React.createElement('span', { style: styles.k }, '已发出'),
      React.createElement('span', { style: styles.mono }, `${notify.sent} 条`),
      React.createElement('span', { style: styles.k }, '已压掉'),
      React.createElement(
        'span',
        { style: styles.mono },
        `${notify.suppressed} 条（非关键事件/已去重）`,
      ),
      React.createElement('span', { style: styles.k }, '跟踪节点'),
      React.createElement('span', { style: styles.mono }, String(notify.tracked)),
    ),
    React.createElement(
      'div',
      { style: { ...styles.note, marginTop: 6 } },
      '说明：回写只发关键事件（完成 / 异常 / 枝完成 / 门控置位与解除），progress 微增不发；',
      '「已压掉」就是省下来的那部分。静默模式只关通知面，写入面与文件锁照常生效。',
    ),
  );
}

/** 会话边界修正卡：这一层"有没有在干活"必须看得见（runs/patches/injected 分开显示）。 */
export function renderBoundaryStatsCard(
  boundary: SettingsView['boundary'],
): React.ReactElement | null {
  if (boundary === undefined) return null;
  return React.createElement(
    'div',
    { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, '会话边界进度修正'),
    React.createElement(
      'div',
      { style: styles.kv },
      React.createElement('span', { style: styles.k }, '当前状态'),
      React.createElement(
        'span',
        null,
        boundary.enabled
          ? boundary.prompt
            ? boundary.promptRegistered === true
              ? '开启（状态推进 + 提示词纪律）'
              : boundary.promptRegistered === false
                ? '开启（仅状态推进：提示词段未注册）'
                : '开启（状态推进 + 提示词纪律，注册状态未知）'
            : '开启（仅状态推进，未接管提示词）'
          : '已关闭',
      ),
      React.createElement('span', { style: styles.k }, '触发次数'),
      React.createElement('span', { style: styles.mono }, `${boundary.runs} 次`),
      React.createElement('span', { style: styles.k }, '推进为进行中'),
      React.createElement('span', { style: styles.mono }, `${boundary.patches} 个节点`),
      React.createElement('span', { style: styles.k }, '投出的提醒'),
      React.createElement('span', { style: styles.mono }, `${boundary.injected} 条`),
      React.createElement('span', { style: styles.k }, '最近一次'),
      React.createElement(
        'span',
        { style: styles.mono },
        boundary.lastKind === ''
          ? '（还没触发过）'
          : `${boundary.lastKind} · ${boundary.lastActorId || '未知会话'}`,
      ),
    ),
    React.createElement(
      'div',
      { style: { ...styles.note, marginTop: 6 } },
      '说明：边界修正**不花 token** —— 只把本会话订阅过、还没开工的节点标成「进行中」（绝不覆盖你写过的进度），',
      '并给未完成的节点投一条**不唤醒** agent 的提醒；真正的数字由模型在下一个回合用 pm_report 补上。',
    ),
  );
}

/**
 * **插件自身 AI 调用消耗**（FR-147，用户诉求："这个插件可以出 token 使用统计，是插件自身的
 * AI 调用 token"）。
 *
 * 三件事必须分开摆，否则数字会骗人：
 * ① **真实用量**（提供方在流末尾回报的 `usage`）与**粗估**分开 —— 预算闸门本来就是粗估；
 * ② **缓存复用**不算调用，但它省下的量单独记（T6/T9 的价值证明）；
 * ③ 明确写出"**不含会话本身的 token**"：那是宿主会话计量的事，插件看不见也不该假装知道。
 */
export function renderAiUsageCard(aiUsage: SettingsView['aiUsage']): React.ReactElement | null {
  if (aiUsage === undefined) return null;
  const n = (value: number): string => value.toLocaleString('en-US');
  const hasProvider = aiUsage.providerReported > 0;
  return React.createElement(
    'div',
    { style: styles.card },
    React.createElement('div', { style: styles.cardTitle }, '插件自身的 AI 调用消耗'),
    React.createElement(
      'div',
      { style: styles.kv },
      React.createElement('span', { style: styles.k }, '真实用量'),
      React.createElement(
        'span',
        { style: styles.mono },
        hasProvider
          ? `${n(aiUsage.totalTokens)} token（入 ${n(aiUsage.inputTokens)} / 出 ${n(aiUsage.outputTokens)}）`
          : '还没拿到过提供方用量',
      ),
      React.createElement('span', { style: styles.k }, '调用次数'),
      React.createElement(
        'span',
        { style: styles.mono },
        `${aiUsage.calls} 次${aiUsage.failed > 0 ? `（含失败 ${aiUsage.failed}）` : ''}`,
      ),
      React.createElement('span', { style: styles.k }, '缓存复用'),
      React.createElement(
        'span',
        { style: styles.mono },
        `${aiUsage.reused} 次${
          aiUsage.savedTokens > 0 ? ` · 省下约 ${n(aiUsage.savedTokens)} token` : ''
        }`,
      ),
      React.createElement('span', { style: styles.k }, '粗估合计'),
      React.createElement(
        'span',
        { style: styles.mono },
        `${n(aiUsage.estimatedTokens)} token${
          aiUsage.estimatedOnly > 0 ? `（其中 ${aiUsage.estimatedOnly} 次只有粗估）` : ''
        }`,
      ),
      aiUsage.cacheReadTokens > 0 || aiUsage.cacheWriteTokens > 0
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement('span', { style: styles.k }, '提供方缓存'),
            React.createElement(
              'span',
              { style: styles.mono },
              `读 ${n(aiUsage.cacheReadTokens)} / 写 ${n(aiUsage.cacheWriteTokens)} token`,
            ),
          )
        : null,
      React.createElement('span', { style: styles.k }, '按场景'),
      React.createElement(
        'span',
        { style: styles.mono },
        aiUsage.byScenario.length === 0
          ? '（还没有调用）'
          : aiUsage.byScenario
              .map(
                (item) =>
                  `${item.label} ${item.calls} 次${
                    item.reused > 0 ? ` + 复用 ${item.reused}` : ''
                  } ${n(item.totalTokens)}`,
              )
              .join(' · '),
      ),
      React.createElement('span', { style: styles.k }, '最近一次'),
      React.createElement(
        'span',
        { style: styles.mono },
        aiUsage.last === undefined
          ? '（还没有调用）'
          : `${aiUsage.last.scenario} · ${aiUsage.last.outcome} · ${aiUsage.last.route}`,
      ),
    ),
    React.createElement(
      'div',
      { style: { ...styles.note, marginTop: 6 } },
      '口径：只统计**插件自己发起**的调用（AI 建树 / 交接文档补写），**不含会话本身的 token**',
      '（那由宿主的会话计量负责）。真实用量来自提供方回报；拿不到时数字标为"粗估"，不混进真实用量里一起报。',
      `统计窗口：最近 ${aiUsage.window} 条明细；账本随工作区走（.pm/ai-usage.json），换工作区就是另一份。`,
    ),
  );
}

export function SettingsSection(props: SettingsSectionProps): React.ReactElement {
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'ready';
        board: Awaited<ReturnType<typeof fetchBoard>>['value'];
        projects: number;
        debug: DebugView | undefined;
        settings: SettingsView | undefined;
      }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchBoard(), fetchProjects(), fetchDebug(), fetchSettings()]).then(
      ([boardOutcome, projectsOutcome, debugOutcome, settingsOutcome]) => {
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
          settings: settingsOutcome.ok ? settingsOutcome.value : undefined,
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
    // ── 可编辑设置（FR-80/81/81a/81b/82/87/88）：改一项存一项，走宿主官方 settings 通道 ──
    React.createElement(
      'div',
      { style: styles.card },
      React.createElement('div', { style: styles.cardTitle }, '设置'),
      state.settings === undefined
        ? React.createElement(
            'div',
            { style: styles.note },
            '读不到设置（/pm/settings 未响应）：只能改 cordis.patch.yml 后重启宿主。',
          )
        : React.createElement(SettingsForm, {
            view: state.settings,
            onSaved: (effective) =>
              setState((prev) =>
                prev.status === 'ready' && prev.settings !== undefined
                  ? { ...prev, settings: { ...prev.settings, effective } }
                  : prev,
              ),
          }),
    ),
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
    // ── 回写消耗（FR-117：让"省了多少"可核对）────────────────────
    renderNotifyStatsCard(state.settings?.notify),
    // ── 会话边界修正（回合 / 子任务 / 会话结束）────────────────────
    renderBoundaryStatsCard(state.settings?.boundary),
    // ── 插件自身 AI 调用消耗（FR-147）────────────────────────────
    renderAiUsageCard(state.settings?.aiUsage),
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

/**
 * 状态机与计算状态收敛（§9.1 / §9.2）。
 *
 * 三条硬规则：
 * 1. `paused` / `held` **从不**出现在 `selfState` 里 —— 它们只由 `gate` 派生；
 * 2. 父节点**不写**自身状态（C5）—— 其状态完全由子孙算出；
 * 3. 删除是**独立入口**，是唯一能写 `removed` 的路径（§9.1）。
 */

import type { DerivedState, Gate, SelfState, WritableSelfState } from '../shared/types.ts';

/** 推进类自身状态（可被工具/菜单写入的那些）。 */
export const WRITABLE_SELF_STATES: readonly WritableSelfState[] = [
  'pending',
  'running',
  'done',
  'error',
];

export const ALL_SELF_STATES: readonly SelfState[] = [...WRITABLE_SELF_STATES, 'removed'];

export const GATES: readonly Gate[] = [null, 'paused', 'held'];

/**
 * 自身状态迁移表（§9.1）。`from → to` 是否合法。
 *
 * `done → running` / `done → error`（重开已完成节点）需要 `force` **且**来源为 `user`（C6）。
 * `running → pending` 等回退需要 `force`（FR-25）。
 */
const TRANSITIONS: Record<WritableSelfState, ReadonlySet<WritableSelfState>> = {
  // 开始 / 直接完成 / 失败
  pending: new Set<WritableSelfState>(['running', 'done', 'error']),
  // 完成 / 失败（回退到 pending 需 force）
  running: new Set<WritableSelfState>(['pending', 'done', 'error']),
  // 重开（需 force + user）
  done: new Set<WritableSelfState>(['running', 'error']),
  // 重试 / 修复后完成
  error: new Set<WritableSelfState>(['pending', 'running', 'done']),
};

/** 需要 `force` 的迁移（回退/重开）。 */
const FORCE_REQUIRED: ReadonlySet<string> = new Set([
  'running→pending',
  'done→running',
  'done→error',
]);

/** 需要来源为 `user`（在 force 之上再加一层）的迁移（C6）。 */
const USER_ONLY: ReadonlySet<string> = new Set(['done→running', 'done→error']);

export interface TransitionCheck {
  ok: boolean;
  /** 需要的额外条件；为空表示无条件通过。 */
  requires: Array<'force' | 'user'>;
  reason?: string;
}

/**
 * 检查一次自身状态迁移是否合法（不修改任何状态）。
 *
 * 注意：`removed` 不走迁移表（§9.1 删除是独立入口），调用方对 `removed` 应直接拒绝。
 */
export function checkTransition(from: SelfState, to: WritableSelfState): TransitionCheck {
  if (from === to) return { ok: true, requires: [] };
  if (from === 'removed') {
    return { ok: false, requires: [], reason: '节点已删除（tombstone），不可再推进状态' };
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) {
    return {
      ok: false,
      requires: [],
      reason: `自身状态不允许 ${from} → ${to}`,
    };
  }
  const key = `${from}→${to}`;
  const requires: Array<'force' | 'user'> = [];
  if (FORCE_REQUIRED.has(key)) requires.push('force');
  if (USER_ONLY.has(key)) requires.push('user');
  return { ok: true, requires };
}

/** 自身状态是否为终态（完成或删除）。 */
export function isTerminal(state: SelfState): boolean {
  return state === 'done' || state === 'removed';
}

/** 门控是否只能写在父节点上（`held` 仅父节点，§9.2）。 */
export function gateAllowedOn(gate: Gate, childCount: number): boolean {
  if (gate === 'held') return childCount > 0;
  return true;
}

/**
 * 计算状态收敛（§9.1 规则 0–6）——按优先级**命中即止**。
 *
 * @param selfState 节点自身状态
 * @param gate 节点自身门控
 * @param ancestorRemoved 自身或任一祖先是否为 tombstone
 * @param ancestorGate 自身或任一祖先的门控（`held` 优先于 `paused`）
 * @param descendantStates 全部子孙的**计算状态**（递归收敛后的结果）
 * @param hasChildren 是否为父节点
 */
export function deriveState(input: {
  selfState: SelfState;
  gate: Gate;
  ancestorRemoved: boolean;
  ancestorGate: Gate;
  descendantStates: readonly DerivedState[];
  hasChildren: boolean;
}): DerivedState {
  const {
    selfState,
    gate,
    ancestorRemoved,
    ancestorGate,
    descendantStates,
    hasChildren,
  } = input;

  // 规则 0：自身或任一祖先为 removed（优先于门控）
  if (ancestorRemoved || selfState === 'removed') return 'removed';

  // 规则 1：自身或任一祖先 held
  if (gate === 'held' || ancestorGate === 'held') return 'held';

  // 规则 2：自身或任一祖先 paused
  if (gate === 'paused' || ancestorGate === 'paused') return 'paused';

  // 规则 3：自身 error，或存在任一子孙 error
  if (selfState === 'error' || descendantStates.includes('error')) return 'error';

  // 规则 4：自身 running，或存在任一子孙 running
  if (selfState === 'running' || descendantStates.includes('running')) return 'running';

  // 规则 5：自身 done 且所有子孙为 done/removed
  // —— 父节点自身的 selfState 因 C5 永远停在 pending，故对"有子节点的节点"
  //    判定改为「全部子孙已了结」即视为 done（否则 FR-46b 与规则 5 自相矛盾：
  //    子孙全完成时枝永远显示未完成）。叶节点仍严格要求自身 done。
  const childrenAllSettled = descendantStates.every(
    (state) => state === 'done' || state === 'removed',
  );
  if (childrenAllSettled && (selfState === 'done' || hasChildren)) return 'done';

  // 规则 6：其余
  return 'pending';
}

/** 门控在某个祖先上的最强值（held 优先于 paused）。 */
export function strongestGate(gates: readonly Gate[]): Gate {
  if (gates.includes('held')) return 'held';
  if (gates.includes('paused')) return 'paused';
  return null;
}

/** `removed` 及其子孙是否应从统计中剔除（§9.1 统计口径）。 */
export function excludedFromStats(state: DerivedState): boolean {
  return state === 'removed';
}

/** 计算状态是否为「未完成」（第一层完成态编码，§11.2）。 */
export function isUnfinished(state: DerivedState): boolean {
  return state !== 'done' && state !== 'removed';
}

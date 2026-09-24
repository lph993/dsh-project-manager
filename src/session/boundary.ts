/**
 * **会话边界上的进度修正**（子代理 / 子任务回合 / 会话结束时）。
 *
 * 背景：进度真正准不准，取决于"干活的那次会话有没有汇报"。光靠模型自觉，
 * 很容易出现"活干完了、树上还挂着 0%" —— 而这正是用户最想避免的"进度与实际脱节"（§0.2 第 3 条）。
 *
 * DSH 给的三个边界信号（实测自 `dsh-agent` 的事件表）：
 * | 事件 | 含义 | 这里做什么 |
 * |---|---|---|
 * | `agent/status` → `idle` | 一次回合结束（子任务做完一段） | 边界修正（**按 agent 去抖**） |
 * | `agent/disposed` | 子代理/会话结束 | 最后一次边界修正 |
 * | `agent/turn-stopping` | 回合正在收尾（可 await） | **不用**：写盘不应该拖慢别人的回合 |
 *
 * 修正分两层，**都不花 token**：
 * 1. **状态推进**：该 actor 订阅过的节点里，还是 `pending` 的 → 置 `running`。
 *    证据就是"它订了并且在做"这件事本身；**不碰**已完成/已删除/被门控的节点，
 *    **绝不覆盖**人写过的进度（§9.3b 进度来源①）。
 * 2. **提醒汇报**：给还在进行中的节点发一条**极简**提醒（复用 `notify` 的会话投影），
 *    让模型在下一个边界前用 `pm_progress` / `pm_finish` 把数字补上 —— 这才是"实时修正"的闭环。
 *
 * 这一层刻意**不发 AI 调用**：回合结束就自动花钱是不可接受的（FR-101/T11）。
 * 需要模型判断时走既有工具（`pm_progress`）或交接文档补写那条明确确认过的路径。
 */

import type { DerivedState, Gate, SelfState } from '../shared/types.ts';

/** 边界来源（进审计，事后能看清是谁触发的修正）。 */
export type BoundaryKind = 'turn-end' | 'agent-disposed';

/**
 * 一个 actor 订阅过的节点事实（同步快照）。
 *
 * 之所以要有这个形状：边界修正（事件回调）与提示词 provider（**同步**函数）
 * 都要读同一份"我订了哪些节点、它们现在什么状态"，两边共用一种数据形状能避免口径漂移。
 */
export interface BoundNode {
  nodeId: string;
  name: string;
  selfState: SelfState;
  derivedState: DerivedState;
  gate: Gate;
  progress: number;
  /**
   * 是不是叶节点。
   *
   * **必须知道这件事**：C5 规定"父节点状态完全由子节点派生，不能写入自身状态"，
   * 对父节点写 `selfState` 会被校验拒绝。少了这个字段，边界修正就会去写一个注定被拒的
   * 父节点，然后拿着 `denied` 结果报告"已推进" —— 那是**假汇报**。
   */
  leaf: boolean;
}

/** 边界修正的输入（都是可测的纯数据）。 */
export interface BoundaryInput {
  kind: BoundaryKind;
  /** 触发边界的 agent / 会话 id（订阅记录里的 `actorId`）。 */
  actorId: string;
  /** 该 actor 订阅过的节点。 */
  bound: ReadonlyArray<BoundNode>;
}

/** 一条待执行的修正。 */
export interface BoundaryPatch {
  nodeId: string;
  name: string;
  from: SelfState;
  to: SelfState;
  reason: string;
}

/** 修正计划（纯函数产出，服务只负责落库与投递）。 */
export interface BoundaryPlan {
  patches: BoundaryPatch[];
  /** 提醒里要列出的"仍在进行"的节点名（最多 8 个，避免把上下文塞满）。 */
  stillRunning: string[];
  /** 仍未完成的进行中节点**总数**（`stillRunning` 被裁过，这个数用于提醒里说"还有多少"）。 */
  runningTotal: number;
  /** 要不要发提醒（没有任何进行中的节点就不打扰）。 */
  remind: boolean;
}

/**
 * 判定要推进的节点。
 *
 * 只做一件事：`pending → running`。理由与边界：
 * - 更激进的推断（比如"文件改了就算 50%"）都是猜，**猜出来的进度会污染事实源**；
 * - `running` 已经是"有人在动它"的忠实表达，而且它让看板/预算/通知都开始按"进行中"对待；
 * - 已经有进度（> 0）或已是 `running` 的节点不动 —— 那说明有人报过，别覆盖；
 * - **父节点一律不动**（C5：父节点状态由子节点派生，写自身状态会被拒）。
 */
export function planBoundaryWriteback(input: BoundaryInput): BoundaryPlan {
  const patches: BoundaryPatch[] = [];
  const stillRunning: string[] = [];
  let runningTotal = 0;
  for (const node of input.bound) {
    if (node.derivedState === 'done' || node.derivedState === 'removed') continue;
    if (node.gate !== null) continue; // 暂停/拦停中的枝不该被"边界"推着走
    if (node.selfState === 'pending' && node.progress === 0) {
      if (!node.leaf) continue; // 父节点不写自身状态（C5）
      patches.push({
        nodeId: node.nodeId,
        name: node.name,
        from: 'pending',
        to: 'running',
        reason: `${input.kind === 'turn-end' ? '回合结束' : '会话结束'}边界：该节点仍被订阅且未开工，标记为进行中`,
      });
      continue;
    }
    if (node.selfState === 'running' && node.progress < 1) {
      runningTotal += 1;
      if (stillRunning.length < 8) stillRunning.push(node.name);
    }
  }
  return {
    patches,
    stillRunning,
    runningTotal,
    remind: runningTotal > 0,
  };
}

/**
 * 边界提醒的单行文本（FR-114 的极简口径：不展开子节点、不带描述）。
 *
 * 说清三件事就够：有谁还在进行（以及一共几个）、数字要谁补、用什么工具补。
 */
export function boundaryReminderText(plan: BoundaryPlan): string | undefined {
  if (!plan.remind) return undefined;
  const names = plan.stillRunning.join('、');
  const more = plan.runningTotal > plan.stillRunning.length ? ` 等 ${plan.runningTotal} 个` : '';
  return `[pm] 本会话订阅的任务点仍在进行：${names}${more}。若这一段已推进，请用 pm_progress 更新进度、做完的用 pm_finish，避免树上数字与实际脱节。`;
}

/** 去抖窗口：同一 actor 的 `idle` 边界在这个窗口内只处理一次（防抖不掉真实修正，也不刷屏）。 */
export const BOUNDARY_DEBOUNCE_MS = 5000;

/** 纯函数版的去抖判定（服务持有 lastSeen，这里只做判断，便于单测）。 */
export function shouldHandleBoundary(input: {
  kind: BoundaryKind;
  actorId: string;
  now: number;
  lastSeen: ReadonlyMap<string, number>;
  debounceMs?: number;
}): boolean {
  if (input.kind === 'agent-disposed') return true; // 结束事件必须处理，它是最后的机会
  const last = input.lastSeen.get(input.actorId);
  if (last === undefined) return true;
  return input.now - last >= (input.debounceMs ?? BOUNDARY_DEBOUNCE_MS);
}

/**
 * 进度回写会话投影（Q6 / FR-112–118）。
 *
 * **为什么做**：只有把进度写回会话，模型才能真正"实时看到"变化；否则"实时"只对人可见。
 * **为什么必须省 token**（§9.6）：每次状态变化都往历史里塞消息，长会话成本会失控。
 *
 * 四条纪律全部落在这个纯模块里（好测、好审）：
 * - **FR-113 只发关键事件**：节点完成、进入异常、枝由未完成变完成、门控置位/解除；
 *   `progress` 微增**不发**任何事件（`0.4 → 0.5` 不该进上下文）。
 * - **FR-114 极简单行**：`[pm] <nodeId> 「名称」 done 100%`，不含描述/引用/子节点展开。
 * - **FR-115 按会话裁剪**：只推"该会话订阅过的节点"或"关注枝上的节点"，绝不推全树。
 * - **FR-116 去重 + 静默模式**：同一节点同一状态只推一次；静默模式彻底关闭回写。
 *
 * FR-118 的另一半是"模型要全树走 `pm_tree` 按需读"——那是既有工具，这里不再重复推送。
 */

import type { DerivedState, Gate } from '../shared/types.ts';

/** 关键事件的种类（FR-113 的封闭清单）。 */
export type NotifyEventKind =
  | 'node-done'
  | 'node-error'
  | 'branch-done'
  | 'gate-on'
  | 'gate-off';

/** 一次回写的内容（够渲染单行即可，别多带字段）。 */
export interface NotifyEvent {
  kind: NotifyEventKind;
  nodeId: string;
  name: string;
  state: DerivedState;
  /** 0–1 的完成度（渲染成百分比）。 */
  progress: number;
  /** 枝才有：未完成任务点数 / 总任务点数。 */
  counts?: { unfinished: number; total: number };
  gate?: Gate;
}

/** 节点在本模块眼里需要的最小信息。 */
export interface NotifyNode {
  id: string;
  name: string;
  derivedState: DerivedState;
  progress: number;
  gate: Gate;
  childCount: number;
  unfinishedLeafCount: number;
  leafCount: number;
}

/** 上一次"已经通知过"的状态（去重与事件判定的依据）。 */
export interface NotifyMemo {
  state: DerivedState;
  gate: Gate;
}

/**
 * 判定一次变化是否属于关键事件（FR-113）。
 *
 * @param before - 上次已通知的状态（没有则视为首次）
 * @param after - 当前状态
 * @returns 事件种类；`undefined` = **不该发**（例如只是进度微增）
 */
export function keyEventOf(
  before: NotifyMemo | undefined,
  after: NotifyNode,
): NotifyEventKind | undefined {
  // 门控置位/解除优先于状态（门控变化本身就是要人知道的事）
  if (before !== undefined && before.gate !== after.gate) {
    if (after.gate !== null) return 'gate-on';
    return 'gate-off';
  }
  if (before === undefined || before.state !== after.derivedState) {
    if (after.derivedState === 'done') {
      // 枝完成 = "该枝的叶子都完成了"，语义上比"某个叶完成"更重要
      return after.childCount > 0 ? 'branch-done' : 'node-done';
    }
    if (after.derivedState === 'error') return 'node-error';
  }
  // 其余（progress 微增、状态没变）一律不发 —— 这是控制 token 的关键一条
  return undefined;
}

/** 渲染成**单行**结构化文本（FR-114）。 */
export function formatNotice(event: NotifyEvent): string {
  const percent = `${Math.round(event.progress * 100)}%`;
  const counts =
    event.counts === undefined
      ? ''
      : ` (${event.counts.total - event.counts.unfinished}/${event.counts.total})`;
  const label =
    event.kind === 'branch-done'
      ? 'branch done'
      : event.kind === 'node-done'
        ? 'done'
        : event.kind === 'node-error'
          ? 'error'
          : event.kind === 'gate-on'
            ? `gate=${event.gate ?? 'on'}`
            : 'gate=off';
  return `[pm] ${event.nodeId} 「${event.name}」 ${label} ${percent}${counts}`;
}

/**
 * 去重账本（FR-116）。
 *
 * 只保留"每个节点最后一次已通知的状态"：同一节点同一状态不会推第二次，
 * 状态再变化时又能继续推。**不用无界集合**：节点数有限，键就是节点 id。
 */
export class NotifyLedger {
  private readonly memo = new Map<string, NotifyMemo>();
  /** 累计发出条数（FR-117：回写消耗要能看）。 */
  private sent = 0;
  /** 因去重/非关键事件被压掉的条数（让"省了多少"可核对）。 */
  private suppressed = 0;

  /** 上次已通知的状态（`undefined` = 还没通知过）。 */
  peek(nodeId: string): NotifyMemo | undefined {
    return this.memo.get(nodeId);
  }

  /** 记录"已通知到这个状态"。 */
  commit(nodeId: string, node: NotifyNode): void {
    this.memo.set(nodeId, { state: node.derivedState, gate: node.gate });
  }

  /** 记一次成功发出。 */
  countSent(): void {
    this.sent += 1;
  }

  /** 记一次被压掉（去重或非关键事件）。 */
  countSuppressed(): void {
    this.suppressed += 1;
  }

  /** FR-117：回写消耗统计（设置页可查看）。 */
  stats(): { sent: number; suppressed: number; tracked: number } {
    return { sent: this.sent, suppressed: this.suppressed, tracked: this.memo.size };
  }
}

/** 会话裁剪所需的上下文（FR-115）。 */
export interface SessionScope {
  /** 该会话订阅过的节点 id（写得最明确的一类）。 */
  subscribedNodeIds: ReadonlySet<string>;
  /** 关注枝的节点 id 并集（关注是项目级的，因此对所有会话都算"相关"）。 */
  focusedNodeIds: ReadonlySet<string>;
}

/**
 * 这个节点该不该推给这条会话（FR-115）。
 *
 * 判定：会话**订阅过**它，或者它落在**关注枝**上。
 * 两条都不满足就不推 —— 否则大项目里每一次叶节点完成都会广播给所有会话。
 */
export function inSessionScope(nodeId: string, scope: SessionScope): boolean {
  return scope.subscribedNodeIds.has(nodeId) || scope.focusedNodeIds.has(nodeId);
}

/**
 * 组装一次回写（去重 + 事件判定都走这里，服务只负责"投递到哪个会话"）。
 *
 * @returns 要发的文本；`undefined` = 这条变化不值得打扰会话（FR-113/116）
 */
export function noticeFor(
  ledger: NotifyLedger,
  node: NotifyNode,
): { text: string; event: NotifyEvent } | undefined {
  const kind = keyEventOf(ledger.peek(node.id), node);
  if (kind === undefined) {
    ledger.countSuppressed();
    return undefined;
  }
  const event: NotifyEvent = {
    kind,
    nodeId: node.id,
    name: node.name,
    state: node.derivedState,
    progress: node.progress,
    ...(node.childCount > 0
      ? { counts: { unfinished: node.unfinishedLeafCount, total: node.leafCount } }
      : {}),
    ...(kind === 'gate-on' ? { gate: node.gate } : {}),
  };
  return { text: formatNotice(event), event };
}

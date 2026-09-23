/**
 * 文件级锁与等待队列（FR-106/107/108/110，§13.4）。
 *
 * **纯逻辑 + 注入时钟**：不碰存储、不碰 React、不等真实时间，所以能被 `node --test`
 * 直接跑——并行治理的逻辑一旦出错就是"两个人同时写同一个文件"，必须可测。
 *
 * 语义（对着 §13.4 的风险分级表实现）：
 * | `intent` | 并行规则 |
 * |---|---|
 * | `read` | 可无限并行，**不占锁** |
 * | `write` | `touchedPaths` 互不相交才并行；相交则排队等锁 |
 * | `exclusive` | 独占该节点及其枝：同一时刻只允许一个，其余按策略**拒绝或排队** |
 *
 * 两条容易写错的规矩，特意在实现里写死并有单测：
 * 1. **不许插队（no barging）**：同一条路径上有人已经排队时，后来的请求即使当下空闲也不能直接拿锁 ——
 *    否则先来者会被无限饿死。
 * 2. **要么全拿到，要么一个都不拿（all-or-nothing）**：一个订阅声明了多个路径时，
 *    不能"先占一半再等另一半"—— 半持锁会让别的订阅误判可以并行。
 */

import type { SubIntent } from '../shared/types.ts';

import { Deque } from '@deepseek-ai/dsh-deque';

/** 一次取锁请求。 */
export interface LockRequest {
  subscriptionId: string;
  nodeId: string;
  intent: SubIntent;
  /** 声明会碰的工作区相对路径（`read` 忽略它）。 */
  touchedPaths: readonly string[];
  /** 请求发生的时间（注入时钟，便于测试与审计）。 */
  at: string;
  /** 订阅过期时间；到期自动释放（FR-108）。 */
  expiresAt?: string;
  /** 冲突策略（FR-111 的"策略由设置项选择"）：拒绝，还是排队等。 */
  onConflict: 'reject' | 'queue';
}

/** 取锁结果。 */
export type LockOutcome =
  | { kind: 'granted'; subscriptionId: string; paths: string[] }
  | { kind: 'queued'; subscriptionId: string; paths: string[]; waitingFor: string[] }
  | { kind: 'rejected'; subscriptionId: string; paths: string[]; blockedBy: string[]; reason: string };

/** 一个持锁记录。 */
interface Hold {
  subscriptionId: string;
  nodeId: string;
  intent: SubIntent;
  paths: string[];
  at: string;
  expiresAt?: string;
}

/** 一个等待记录（FIFO）。 */
interface Waiter {
  request: LockRequest;
  paths: string[];
}

/** 冲突快照（`pm_watch_conflicts` / FR-110 的可视化输入）。 */
export interface LockSnapshot {
  holds: Array<{
    subscriptionId: string;
    nodeId: string;
    intent: SubIntent;
    paths: string[];
    at: string;
    expiresAt?: string;
  }>;
  waiting: Array<{
    subscriptionId: string;
    nodeId: string;
    intent: SubIntent;
    paths: string[];
    blockedBy: string[];
  }>;
  /** 有冲突的路径 → 等待者数量。 */
  conflicts: Array<{ path: string; holders: string[]; waiters: string[] }>;
}

/**
 * 文件锁管理器。
 *
 * 刻意不做"超时自动放弃"——那是调用方（`pm_watch_wait`）的截止时间语义（FR-129），
 * 这里只负责"谁持锁、谁在排队、释放后给谁"。过期释放按 `expiresAt` 被动清理。
 */
export class FileLockManager {
  private readonly holds = new Map<string, Hold>();
  /**
   * 路径 → 等待者队列。
   *
   * 用官方 `dsh-deque`（FR-130：队列不许自造）而不是数组：这里的入队/出队发生在
   * 异步工作之间，环形双端队列既保证 FIFO，也不会像 `Array.shift()` 那样在大队列上退化。
   * `no barging` 就靠"每个订阅在它声明的**每一条**路径的队列里都留一个位置"实现。
   */
  private readonly waitersByPath = new Map<string, Deque<string>>();
  private readonly waiters = new Map<string, Waiter>();

  /**
   * 申请取锁。
   *
   * @param request - 取锁请求（含冲突策略）
   * @returns 立即拿到 / 已排队 / 被拒（三种结果都会如实说明被谁挡住）
   */
  acquire(request: LockRequest): LockOutcome {
    this.sweepExpired(request.at);
    const paths = normalizePaths(request.touchedPaths);

    // 只读：不占锁、不排队（§13.4：read 可无限并行）
    if (request.intent === 'read' || paths.length === 0) {
      return { kind: 'granted', subscriptionId: request.subscriptionId, paths };
    }

    const holders = this.holdersOf(paths, request.subscriptionId);
    const exclusiveHolders = this.exclusiveHoldersOf(request);
    const waitingAhead = this.waitersAheadOf(paths, request.subscriptionId);

    if (holders.length === 0 && exclusiveHolders.length === 0 && waitingAhead.length === 0) {
      this.takeHold(request, paths);
      return { kind: 'granted', subscriptionId: request.subscriptionId, paths };
    }

    const blockedBy = [...new Set([...holders, ...exclusiveHolders, ...waitingAhead])];
    if (request.onConflict === 'reject') {
      return {
        kind: 'rejected',
        subscriptionId: request.subscriptionId,
        paths,
        blockedBy,
        reason:
          exclusiveHolders.length > 0
            ? `节点被独占订阅占用：${exclusiveHolders.join('、')}`
            : `以下路径已被占用或有人排队：${blockedBy.join('、')}`,
      };
    }

    this.enqueue(request, paths);
    return {
      kind: 'queued',
      subscriptionId: request.subscriptionId,
      paths,
      waitingFor: blockedBy,
    };
  }

  /** 释放一个订阅持有的全部锁，并把锁让给队列里下一个**能整批拿到**的等待者。 */
  release(subscriptionId: string, at: string): string[] {
    this.holds.delete(subscriptionId);
    this.removeWaiter(subscriptionId);
    return this.promote(at);
  }

  /** 主动清理过期订阅（FR-108：不留僵尸锁）。返回被释放的订阅 id。 */
  sweepExpired(now: string): string[] {
    const released: string[] = [];
    for (const hold of [...this.holds.values()]) {
      if (hold.expiresAt !== undefined && hold.expiresAt <= now) {
        this.holds.delete(hold.subscriptionId);
        released.push(hold.subscriptionId);
      }
    }
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.request.expiresAt !== undefined && waiter.request.expiresAt <= now) {
        this.removeWaiter(waiter.request.subscriptionId);
        released.push(waiter.request.subscriptionId);
      }
    }
    if (released.length > 0) this.promote(now);
    return released;
  }

  /**
   * 尝试让某个等待者前进（`pm_watch_wait` 的轮询点）。
   *
   * @returns 该订阅当前是否已持锁
   */
  isHeldBy(subscriptionId: string): boolean {
    return this.holds.has(subscriptionId);
  }

  /** 某订阅还被谁挡着（等待中的订阅用它给用户/模型一个明确答复）。 */
  blockedBy(subscriptionId: string): string[] {
    const waiter = this.waiters.get(subscriptionId);
    if (waiter === undefined) return [];
    const holders = this.holdersOf(waiter.paths, subscriptionId);
    const ahead = this.waitersAheadOf(waiter.paths, subscriptionId);
    return [...new Set([...holders, ...ahead])];
  }

  /** 快照（FR-110 / `pm_watch_conflicts`）。 */
  snapshot(): LockSnapshot {
    const pathIndex = new Map<string, { holders: string[]; waiters: string[] }>();
    for (const hold of this.holds.values()) {
      for (const path of hold.paths) {
        const entry = pathIndex.get(path) ?? { holders: [], waiters: [] };
        entry.holders.push(hold.subscriptionId);
        pathIndex.set(path, entry);
      }
    }
    for (const waiter of this.waiters.values()) {
      for (const path of waiter.paths) {
        const entry = pathIndex.get(path) ?? { holders: [], waiters: [] };
        entry.waiters.push(waiter.request.subscriptionId);
        pathIndex.set(path, entry);
      }
    }
    return {
      holds: [...this.holds.values()].map((hold) => ({
        subscriptionId: hold.subscriptionId,
        nodeId: hold.nodeId,
        intent: hold.intent,
        paths: [...hold.paths],
        at: hold.at,
        ...(hold.expiresAt !== undefined ? { expiresAt: hold.expiresAt } : {}),
      })),
      waiting: [...this.waiters.values()].map((waiter) => ({
        subscriptionId: waiter.request.subscriptionId,
        nodeId: waiter.request.nodeId,
        intent: waiter.request.intent,
        paths: [...waiter.paths],
        blockedBy: this.blockedBy(waiter.request.subscriptionId),
      })),
      conflicts: [...pathIndex.entries()]
        .filter(([, entry]) => entry.waiters.length > 0)
        .map(([path, entry]) => ({ path, holders: entry.holders, waiters: entry.waiters })),
    };
  }

  /** 某节点上的持锁订阅（回滚要停掉整枝的全部订阅，FR-109）。 */
  holdersOnNode(nodeId: string): string[] {
    return [...this.holds.values()]
      .filter((hold) => hold.nodeId === nodeId)
      .map((hold) => hold.subscriptionId);
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private takeHold(request: LockRequest, paths: string[]): void {
    this.holds.set(request.subscriptionId, {
      subscriptionId: request.subscriptionId,
      nodeId: request.nodeId,
      intent: request.intent,
      paths,
      at: request.at,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    });
  }

  private enqueue(request: LockRequest, paths: string[]): void {
    if (this.waiters.has(request.subscriptionId)) return;
    this.waiters.set(request.subscriptionId, { request, paths });
    for (const path of paths) this.queueOf(path).pushBack(request.subscriptionId);
  }

  private removeWaiter(subscriptionId: string): void {
    const waiter = this.waiters.get(subscriptionId);
    if (waiter === undefined) return;
    this.waiters.delete(subscriptionId);
    for (const path of waiter.paths) {
      const queue = this.waitersByPath.get(path);
      if (queue === undefined) continue;
      // Deque 只能从两端取，所以"删中间那个"= 全量取出再按序放回（等待队列很短，够用）
      const kept = this.queueList(path).filter((id) => id !== subscriptionId);
      queue.clear();
      for (const id of kept) queue.pushBack(id);
      if (queue.size === 0) this.waitersByPath.delete(path);
    }
  }

  private queueOf(path: string): Deque<string> {
    const existing = this.waitersByPath.get(path);
    if (existing !== undefined) return existing;
    const created = new Deque<string>();
    this.waitersByPath.set(path, created);
    return created;
  }

  /** 读一条队列的内容（原序，读完放回，不改变队列）。 */
  private queueList(path: string): string[] {
    const queue = this.waitersByPath.get(path);
    if (queue === undefined) return [];
    const out: string[] = [];
    const size = queue.size;
    for (let index = 0; index < size; index += 1) {
      const id = queue.popFront();
      if (id === undefined) break;
      out.push(id);
    }
    for (const id of out) queue.pushBack(id);
    return out;
  }

  /**
   * 释放后按 FIFO 让路：从头开始扫等待队列，**能整批拿到**的才给。
   *
   * 拿不到的不跳过（避免插队），但继续往后扫会让"被独占挡住的长等待"卡住整条队列；
   * 折中：按**等待顺序**尝试，第一个能拿到的就授予，然后从它之后继续尝试其余（各自整批判定）。
   */
  private promote(at: string): string[] {
    const granted: string[] = [];
    const order = [...this.waiters.values()];
    for (const waiter of order) {
      const { request, paths } = waiter;
      const holders = this.holdersOf(paths, request.subscriptionId);
      const exclusive = this.exclusiveHoldersOf(request);
      const ahead = this.waitersAheadOf(paths, request.subscriptionId);
      if (holders.length > 0 || exclusive.length > 0 || ahead.length > 0) continue;
      this.removeWaiter(request.subscriptionId);
      this.takeHold({ ...request, at }, paths);
      granted.push(request.subscriptionId);
    }
    return granted;
  }

  /** 这些路径上的持锁者（排除自己）。 */
  private holdersOf(paths: readonly string[], selfId: string): string[] {
    const out = new Set<string>();
    for (const hold of this.holds.values()) {
      if (hold.subscriptionId === selfId) continue;
      if (hold.paths.some((path) => paths.includes(path))) out.add(hold.subscriptionId);
    }
    return [...out];
  }

  /** 与本次请求**节点相同**的独占订阅（独占粒度是节点及其枝，不只是路径）。 */
  private exclusiveHoldersOf(request: LockRequest): string[] {
    const out = new Set<string>();
    for (const hold of this.holds.values()) {
      if (hold.subscriptionId === request.subscriptionId) continue;
      if (hold.intent !== 'exclusive') continue;
      if (hold.nodeId === request.nodeId) out.add(hold.subscriptionId);
    }
    if (request.intent === 'exclusive') {
      // 反过来也要挡：我要独占时，同节点上任何**非只读**订阅都得让路
      for (const hold of this.holds.values()) {
        if (hold.subscriptionId === request.subscriptionId) continue;
        if (hold.nodeId !== request.nodeId) continue;
        if (hold.intent === 'read') continue;
        out.add(hold.subscriptionId);
      }
    }
    return [...out];
  }

  /** 同路径上排在我前面的等待者（`no barging`）。 */
  private waitersAheadOf(paths: readonly string[], selfId: string): string[] {
    const out = new Set<string>();
    for (const path of paths) {
      for (const id of this.queueList(path)) {
        if (id === selfId) break; // 到自己为止：后面的人不算"在我前面"
        out.add(id);
      }
    }
    return [...out];
  }
}

/** 路径归一化：去空白、统一分隔符、去重（`a//b` 与 `a/b` 是同一把锁）。 */
export function normalizePaths(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    const trimmed = raw.trim().replace(/\\+/g, '/').replace(/\/{2,}/g, '/');
    const clean = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
    if (clean === '') continue;
    out.add(clean);
  }
  return [...out];
}

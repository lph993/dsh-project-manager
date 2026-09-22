/**
 * 领域写入操作（§6.2 / §6.6 / §9.1 / §9.2 / §10）。
 *
 * 全部为**纯函数**：接收快照与请求，返回新快照 + 审计记录，绝不修改入参。
 * 所有写入都必须经过 `validateWrite`（§12.4 不变量 2：无旁路）。
 */

import type {
  ActorKind,
  Gate,
  GraphSnapshot,
  NodeFlag,
  NodeKind,
  NodeRecord,
  Ref,
  SelfState,
  Subscription,
  WriteAttempt,
  WriteBlock,
} from '../shared/types.ts';
import {
  buildIndex,
  findSiblingByName,
  planFocusNormalization,
  type GraphIndex,
} from './graph.ts';
import { validateWrite, type ConflictPolicy, type PatchFields, type ValidateContext } from './validate.ts';

/** 时间戳来源（可注入，便于测试确定性）。 */
export interface Clock {
  now(): string;
}

/** 随机源端口（领域层不直接依赖 crypto —— 见 §5.2 的 `dsh-util-crypto` 约束）。 */
export interface RandomSource {
  uuid(): string;
}

/** 写入尝试的公共入口参数。 */
export interface MutateBase {
  by: ActorKind;
  actorId?: string;
  reason?: string;
  /** 仅用户可 force（§10.4）。 */
  force?: boolean;
  ts?: string;
}

export interface MutationContext {
  clock: Clock;
  random: RandomSource;
  policy: ConflictPolicy;
  /** 该子树是否处于回滚锁中（C9）。 */
  rollbackLocked?: (nodeId: string) => boolean;
  /** 同一节点上是否有待仲裁的互斥写入（C2）。 */
  pendingOppositeWrite?: (
    nodeId: string,
  ) => { selfState?: SelfState; by: ActorKind; at: string } | undefined;
}

/** 统一结果形态。 */
export type MutationResult =
  | {
      kind: 'ok';
      graph: GraphSnapshot;
      attempts: WriteAttempt[];
      /** 自动修正的冲突编号（C3/C4），已在审计中留痕。 */
      autoFixes: string[];
    }
  | {
      kind: 'reject';
      code: string;
      message: string;
      hint?: string;
      latestRev?: number;
    }
  | {
      kind: 'arbitrate';
      code: string;
      message: string;
      conflictId: string;
    };

/** 节点字段默认值（§7.2 必填项）。 */
export function createNodeRecord(input: {
  id: string;
  name: string;
  parentId: string | null;
  kind: NodeKind;
  ts: string;
  by: ActorKind;
  actorId?: string;
}): NodeRecord {
  return {
    id: input.id,
    name: input.name,
    parentId: input.parentId,
    kind: input.kind,
    selfState: 'pending',
    progress: 0,
    focus: false,
    gate: null,
    revision: 1,
    updatedAt: input.ts,
    updatedBy: input.actorId ? `${input.by}:${input.actorId}` : input.by,
  };
}

function sourceLabel(base: MutateBase): string {
  return base.actorId ? `${base.by}:${base.actorId}` : base.by;
}

function cloneGraph(graph: GraphSnapshot): GraphSnapshot {
  return { ...graph, nodes: { ...graph.nodes } };
}

function attempt(
  ctx: MutationContext,
  input: {
    nodeId: string | null;
    block: WriteBlock;
    op: Record<string, unknown>;
    base: MutateBase;
    rev: number;
  },
): WriteAttempt {
  return {
    attemptId: ctx.random.uuid(),
    nodeId: input.nodeId,
    block: input.block,
    op: input.op,
    by: {
      by: input.base.by,
      actorId: input.base.actorId,
      label: sourceLabel(input.base),
    },
    rev: input.rev,
    ts: input.base.ts ?? ctx.clock.now(),
  };
}

/** 路径逃逸检测（C7）：拒绝绝对路径与 `..`。 */
export function escapingTargets(refs: readonly Ref[] | undefined): string[] {
  if (!refs) return [];
  const out: string[] = [];
  for (const ref of refs) {
    const target = ref.target;
    if (
      target.startsWith('/') ||
      target.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(target) ||
      target.split(/[\\/]/).includes('..')
    ) {
      out.push(target);
    }
  }
  return out;
}

/** 依据块归属校验声明的 rev 是否指向正确的域（§13.1 版本号选择规则）。 */
export function blockOf(patch: PatchFields): WriteBlock {
  if (patch.selfState !== undefined) return 'state';
  if (patch.progress !== undefined) return 'progress';
  if (patch.gate !== undefined) return 'gate';
  if (patch.focus !== undefined) return 'focus';
  if (patch.name !== undefined) return 'name';
  if (patch.description !== undefined) return 'desc';
  if (patch.refs !== undefined) return 'refs';
  return 'structure';
}

/**
 * 更新一个节点的字段（`pm_update` / `pm_progress` / `pm_finish` 的公共内核）。
 */
export function mutatePatch(
  graph: GraphSnapshot,
  input: MutateBase & {
    nodeId: string;
    patch: PatchFields;
    rev?: number;
    structRev?: number;
  },
  ctx: MutationContext,
): MutationResult {
  const index = buildIndex(graph);
  const node = index.byId.get(input.nodeId);
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }

  const escaping = escapingTargets(input.patch.refs);
  const duplicate = input.patch.name !== undefined
    ? findSiblingByName(index, node.parentId, input.patch.name, node.id)
    : undefined;

  const validateCtx: ValidateContext = {
    node,
    childCount: (index.childrenOf.get(node.id) ?? []).length,
    policy: ctx.policy,
    ...(escaping.length > 0 ? { escapingRefTargets: escaping } : {}),
    ...(duplicate ? { duplicateSiblingId: duplicate.id } : {}),
    ...(ctx.rollbackLocked?.(node.id) ? { rollbackLocked: true } : {}),
    ...(node.flags?.includes('needsConfirm') ? { needsConfirm: true } : {}),
    ...(ctx.pendingOppositeWrite
      ? (() => {
          const pending = ctx.pendingOppositeWrite?.(node.id);
          return pending ? { pendingOppositeWrite: pending } : {};
        })()
      : {}),
  };

  const decision = validateWrite(
    {
      nodeId: input.nodeId,
      by: input.by,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      patch: input.patch,
    },
    validateCtx,
  );

  if (decision.kind === 'reject') {
    return {
      kind: 'reject',
      code: decision.code,
      message: decision.message,
      ...(decision.hint !== undefined ? { hint: decision.hint } : {}),
      ...(decision.latestRev !== undefined ? { latestRev: decision.latestRev } : {}),
    };
  }
  if (decision.kind === 'arbitrate') {
    return {
      kind: 'arbitrate',
      code: decision.code,
      message: decision.message,
      conflictId: ctx.random.uuid(),
    };
  }

  const next = cloneGraph(graph);
  const merged: NodeRecord = {
    ...node,
    ...decision.patch,
    revision: node.revision + 1,
    updatedAt: input.ts ?? ctx.clock.now(),
    updatedBy: sourceLabel(input),
  };
  next.nodes[node.id] = merged;

  const attempts: WriteAttempt[] = [
    attempt(ctx, {
      nodeId: node.id,
      block: blockOf(decision.patch),
      op: decision.patch as Record<string, unknown>,
      base: input,
      rev: merged.revision,
    }),
  ];

  // 自动修正单独留痕（§10.2 C3/C4 必须"记录修正"）
  for (const code of decision.autoFixes) {
    attempts.push(
      attempt(ctx, {
        nodeId: node.id,
        block: 'state',
        op: { autoFix: code, applied: decision.patch as Record<string, unknown> },
        base: { ...input, reason: `自动修正 ${code}` },
        rev: merged.revision,
      }),
    );
  }

  return { kind: 'ok', graph: next, attempts, autoFixes: decision.autoFixes };
}

/**
 * 新增节点（`pm_add` / 菜单「添加」）。同名兄弟被拒（C12）。
 */
export function mutateAdd(
  graph: GraphSnapshot,
  input: MutateBase & {
    parentId: string | null;
    name: string;
    kind?: NodeKind;
    refs?: Ref[];
    description?: string;
    autoCreated?: boolean;
    /** 中途新增的分支必须显式标记（FR-15）。 */
    addedMidway?: boolean;
    /**
     * 零 token 启发式权重（§9.3a）。
     *
     * 允许在建节点时一并写入：阶段 A 建树是"叶节点 + 其结构信号"一起产出的，
     * 若必须再发一次 `patchNode`，既要两次 CAS 也会在两次写入之间留下"没有权重的树"。
     */
    weight?: number;
    weightSource?: 'ai' | 'heuristic';
    weightDetail?: Record<string, unknown>;
  },
  ctx: MutationContext,
): MutationResult {
  const name = input.name.trim();
  if (name === '') {
    return { kind: 'reject', code: 'E_NAME', message: '节点名称不能为空' };
  }
  const index = buildIndex(graph);
  if (input.parentId !== null && !index.byId.has(input.parentId)) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `父节点 ${input.parentId} 不存在` };
  }
  const duplicate = findSiblingByName(index, input.parentId, name);
  if (duplicate) {
    return {
      kind: 'reject',
      code: 'C12',
      message: `同级已存在同名节点「${name}」`,
      hint: `已存在节点 id=${duplicate.id}，请改名后重试`,
    };
  }
  const escaping = escapingTargets(input.refs);
  if (escaping.length > 0) {
    return {
      kind: 'reject',
      code: 'C7',
      message: `引用路径逃逸工作区：${escaping.join('、')}`,
      hint: '引用 target 必须为工作区相对路径',
    };
  }

  const ts = input.ts ?? ctx.clock.now();
  const record = createNodeRecord({
    id: ctx.random.uuid(),
    name,
    parentId: input.parentId,
    kind: input.kind ?? 'task',
    ts,
    by: input.by,
    ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
  });
  if (input.refs) record.refs = input.refs;
  if (input.description !== undefined) record.description = input.description;
  if (input.autoCreated === true) record.autoCreated = true;
  if (input.addedMidway === true) record.flags = ['addedMidway' as NodeFlag];
  if (input.weight !== undefined && Number.isFinite(input.weight) && input.weight > 0) {
    record.weight = input.weight;
    if (input.weightSource !== undefined) record.weightSource = input.weightSource;
    if (input.weightDetail !== undefined) record.weightDetail = input.weightDetail;
  }

  const next = cloneGraph(graph);
  next.nodes[record.id] = record;
  if (input.parentId === null) next.rootIds = [...next.rootIds, record.id];

  return {
    kind: 'ok',
    graph: next,
    autoFixes: [],
    attempts: [
      attempt(ctx, {
        nodeId: record.id,
        block: 'structure',
        op: { add: { name, parentId: input.parentId, kind: record.kind } },
        base: input,
        rev: record.revision,
      }),
    ],
  };
}

/** 删除策略（FR-57 三选一）。 */
export type RemovePolicy = 'record' | 'code' | 'comment';

/**
 * 删除整枝（`pm_remove`，FR-57 / §9.1）。
 *
 * - `record`：软删除（打 tombstone），保留审计
 * - `code` / `comment`：同样先打 tombstone；代码层面的动作由 adapter 层执行（本层只记状态）
 */
export function mutateRemove(
  graph: GraphSnapshot,
  input: MutateBase & { nodeId: string; policy: RemovePolicy; rev?: number; structRev?: number },
  ctx: MutationContext,
): MutationResult {
  const index = buildIndex(graph);
  const node = index.byId.get(input.nodeId);
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }
  if (input.rev !== undefined && input.rev !== node.revision) {
    return {
      kind: 'reject',
      code: 'C1',
      message: `写入携带的 rev=${input.rev} 已陈旧（当前 rev=${node.revision}）`,
      hint: '读取最新状态后携带新 rev 重试',
      latestRev: node.revision,
    };
  }

  const next = cloneGraph(graph);
  const ts = input.ts ?? ctx.clock.now();
  const removed: NodeRecord = {
    ...node,
    selfState: 'removed',
    revision: node.revision + 1,
    updatedAt: ts,
    updatedBy: sourceLabel(input),
  };
  next.nodes[node.id] = removed;

  const attempts: WriteAttempt[] = [
    attempt(ctx, {
      nodeId: node.id,
      block: 'delete',
      op: { policy: input.policy, tombstone: true, branchSize: countBranch(index, node.id) },
      base: input,
      rev: removed.revision,
    }),
  ];

  if (input.policy === 'record') {
    // 软删除：保留记录，仅打 tombstone（子孙状态由派生规则 0 处理，不递归改写）
  }

  return { kind: 'ok', graph: next, attempts, autoFixes: [] };
}

function countBranch(index: GraphIndex, rootId: string): number {
  let count = 0;
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    count += 1;
    for (const childId of index.childrenOf.get(current) ?? []) stack.push(childId);
  }
  return count;
}

/**
 * 设置关注（`pm_focus`，FR-19 / C11）。
 *
 * 归一化在此强制执行：聚焦父节点会清除后代的 `focus`（保留 `focusShadow`）；
 * 取消关注会按 `focusShadow` 恢复后代。
 */
export function mutateFocus(
  graph: GraphSnapshot,
  input: MutateBase & { nodeId: string; focus: boolean; structRev?: number },
  ctx: MutationContext,
): MutationResult {
  const index = buildIndex(graph);
  const node = index.byId.get(input.nodeId);
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }

  const changes = planFocusNormalization(index, input.nodeId, input.focus);
  const next = cloneGraph(graph);
  const ts = input.ts ?? ctx.clock.now();
  const touched: string[] = [];

  // 自身：写入 focus 与 focusShadow
  const selfChanges = changes.get(node.id);
  if (selfChanges !== undefined) {
    next.nodes[node.id] = {
      ...node,
      focus: selfChanges,
      focusShadow: input.focus ? true : node.focusShadow,
      revision: node.revision + 1,
      updatedAt: ts,
      updatedBy: sourceLabel(input),
    };
    touched.push(node.id);
  }

  // 后代归一化（不递增 revision？会破坏 CAS —— 因此递增并留痕）
  for (const [id, value] of changes) {
    if (id === node.id) continue;
    const current = next.nodes[id] ?? index.byId.get(id);
    if (!current) continue;
    next.nodes[id] = {
      ...current,
      focus: value,
      revision: current.revision + 1,
      updatedAt: ts,
      updatedBy: sourceLabel(input),
    };
    touched.push(id);
  }

  const attempts: WriteAttempt[] = [
    attempt(ctx, {
      nodeId: node.id,
      block: 'focus',
      op: { focus: input.focus, normalized: touched.length - 1 },
      base: input,
      rev: next.nodes[node.id]?.revision ?? node.revision,
    }),
  ];
  for (const id of touched) {
    if (id === node.id) continue;
    const current = next.nodes[id];
    if (!current) continue;
    attempts.push(
      attempt(ctx, {
        nodeId: id,
        block: 'focus',
        op: { focus: current.focus, normalizedBy: node.id },
        base: { ...input, reason: `关注归一化（${input.focus ? '被祖先覆盖' : '按 shadow 恢复'}）` },
        rev: current.revision,
      }),
    );
  }

  return { kind: 'ok', graph: next, attempts, autoFixes: [] };
}

/**
 * 设置门控（暂停/拦停/放行/继续，§9.2）。
 *
 * 门控是**标记**，不改自身状态；作用域靠派生规则的"自身或任一祖先"实现继承。
 */
export function mutateGate(
  graph: GraphSnapshot,
  input: MutateBase & { nodeId: string; gate: Gate; structRev?: number },
  ctx: MutationContext,
): MutationResult {
  const index = buildIndex(graph);
  const node = index.byId.get(input.nodeId);
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }
  const childCount = (index.childrenOf.get(node.id) ?? []).length;
  if (input.gate === 'held' && childCount === 0) {
    return {
      kind: 'reject',
      code: 'E_GATE',
      message: '「拦停」只能作用于父节点',
      hint: '对叶节点请使用「暂停」',
    };
  }

  const ts = input.ts ?? ctx.clock.now();
  const next = cloneGraph(graph);
  next.nodes[node.id] = {
    ...node,
    gate: input.gate,
    revision: node.revision + 1,
    updatedAt: ts,
    updatedBy: sourceLabel(input),
  };

  return {
    kind: 'ok',
    graph: next,
    autoFixes: [],
    attempts: [
      attempt(ctx, {
        nodeId: node.id,
        block: 'gate',
        op: { gate: input.gate, inheritsToBranch: true },
        base: input,
        rev: next.nodes[node.id]?.revision ?? node.revision,
      }),
    ],
  };
}

/** 批量设置 flags（如回滚后的 `rolledBack`、C10 的 `needsConfirm`）。 */
export function mutateFlags(
  graph: GraphSnapshot,
  input: MutateBase & {
    nodeId: string;
    add?: NodeFlag[];
    remove?: NodeFlag[];
    lastRollbackAt?: string;
  },
  ctx: MutationContext,
): MutationResult {
  const node = graph.nodes[input.nodeId];
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }
  const current = new Set<NodeFlag>(node.flags ?? []);
  for (const flag of input.add ?? []) current.add(flag);
  for (const flag of input.remove ?? []) current.delete(flag);

  const flags = [...current];
  const ts = input.ts ?? ctx.clock.now();
  const next = cloneGraph(graph);
  const updated: NodeRecord = {
    ...node,
    revision: node.revision + 1,
    updatedAt: ts,
    updatedBy: sourceLabel(input),
  };
  if (flags.length > 0) updated.flags = flags;
  else delete updated.flags;
  if (input.lastRollbackAt !== undefined) updated.lastRollbackAt = input.lastRollbackAt;
  next.nodes[node.id] = updated;

  return {
    kind: 'ok',
    graph: next,
    autoFixes: [],
    attempts: [
      attempt(ctx, {
        nodeId: node.id,
        block: 'state',
        op: { flags, lastRollbackAt: input.lastRollbackAt ?? null },
        base: input,
        rev: updated.revision,
      }),
    ],
  };
}

/** 订阅登记（§13.4）：同一 actor+actorId 重复申请视为续期。 */
export function mutateSubscribe(
  graph: GraphSnapshot,
  input: MutateBase & { nodeId: string; subscription: Omit<Subscription, 'claimedAt'> },
  ctx: MutationContext,
): MutationResult {
  const node = graph.nodes[input.nodeId];
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }
  const ts = input.ts ?? ctx.clock.now();
  const bindings = [...(node.bindings ?? [])];
  const existingIndex = bindings.findIndex(
    (s) => s.actor === input.subscription.actor && s.actorId === input.subscription.actorId,
  );
  const entry: Subscription = { ...input.subscription, claimedAt: ts };
  if (existingIndex >= 0) bindings[existingIndex] = entry;
  else bindings.push(entry);

  const next = cloneGraph(graph);
  next.nodes[node.id] = {
    ...node,
    bindings,
    revision: node.revision + 1,
    updatedAt: ts,
    updatedBy: sourceLabel(input),
  };

  return {
    kind: 'ok',
    graph: next,
    autoFixes: [],
    attempts: [
      attempt(ctx, {
        nodeId: node.id,
        block: 'structure',
        op: { subscribe: entry, renewed: existingIndex >= 0 },
        base: input,
        rev: next.nodes[node.id]?.revision ?? node.revision,
      }),
    ],
  };
}

/** 释放订阅（FR-108：会话结束/失联/超时自动释放）。 */
export function mutateUnsubscribe(
  graph: GraphSnapshot,
  input: MutateBase & { nodeId: string; subscriptionId: string },
  ctx: MutationContext,
): MutationResult {
  const node = graph.nodes[input.nodeId];
  if (!node) {
    return { kind: 'reject', code: 'E_NOT_FOUND', message: `节点 ${input.nodeId} 不存在` };
  }
  const bindings = (node.bindings ?? []).filter((s) => s.subscriptionId !== input.subscriptionId);
  if (bindings.length === (node.bindings ?? []).length) {
    return {
      kind: 'reject',
      code: 'E_NOT_FOUND',
      message: `订阅 ${input.subscriptionId} 不存在于节点 ${input.nodeId}`,
    };
  }
  const ts = input.ts ?? ctx.clock.now();
  const next = cloneGraph(graph);
  next.nodes[node.id] = {
    ...node,
    bindings,
    revision: node.revision + 1,
    updatedAt: ts,
    updatedBy: sourceLabel(input),
  };
  return {
    kind: 'ok',
    graph: next,
    autoFixes: [],
    attempts: [
      attempt(ctx, {
        nodeId: node.id,
        block: 'structure',
        op: { unsubscribe: input.subscriptionId },
        base: input,
        rev: next.nodes[node.id]?.revision ?? node.revision,
      }),
    ],
  };
}

/** 空快照工厂（首次扫描/迁移的起点）。 */
export function emptyGraph(projectName: string, ts: string, baselineDsh?: string): GraphSnapshot {
  return {
    projectName,
    nodes: {},
    rootIds: [],
    dataFormat: 1,
    ...(baselineDsh !== undefined ? { baselineDsh } : {}),
    createdAt: ts,
  };
}

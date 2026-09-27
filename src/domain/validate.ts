/**
 * 语义校验与冲突判定（§10.2）。判定顺序**写死**，命中即止。
 *
 * 核心原则（FR-23/24）：**能自动修正就自动修正并留痕；不能修正就拒绝或仲裁，永不静默覆盖**。
 *
 * 判定顺序：
 * ```
 * C7 安全违规 → C9 回滚锁 → C10 挂起态 → C6 状态倒退 → C5 父节点写状态
 *   → C1 版本陈旧 → C3/C4 自相矛盾修正 → C2 语义互斥 → C8 结构竞争 → C12 同名
 * ```
 */

import type { ActorKind, Gate, NodeRecord, SelfState, WritableSelfState } from '../shared/types.ts';
import { checkTransition } from './state.ts';

/** 冲突编号（C1–C12），用于审计、UI 文案与验收对照。 */
export type ConflictCode =
  | 'C1'
  | 'C2'
  | 'C3'
  | 'C4'
  | 'C5'
  | 'C6'
  | 'C7'
  | 'C8'
  | 'C9'
  | 'C10'
  | 'C11'
  | 'C12';

/** 冲突策略（FR-82）。 */
export type ConflictPolicy = 'auto-fix-first' | 'always-arbitrate';

/** 一次写入尝试（校验器的输入）。 */
export interface PatchRequest {
  nodeId: string;
  /** 调用方携带的 CAS 版本（并发正确性的来源，§10.1）。 */
  rev?: number;
  /** 结构版本（结构域）。 */
  structRev?: number;
  by: ActorKind;
  actorId?: string;
  /** 仅用户可 `force`（§10.4 权限表）。 */
  force?: boolean;
  /**
   * **回滚还原通道**（FR-67）：把节点状态写回快照点记录的状态。
   *
   * 还原**不是**一次"状态迁移"——它要把节点搬回**当时**的任意状态（包括 `done → pending`
   * 这种正常路径上根本不存在的倒退），所以这条通道跳过 C6 的迁移表与"已完成不可改回"判定，
   * 也跳过 C9：它本来就是回滚自己发出的写入，不该被自己的锁挡住
   * （实测踩过：锁没放的时候还原被拒，于是"整枝回滚"只还原了文件、节点状态原地不动）。
   *
   * 仍然要求 `force` + `by: 'user'`：还原是用户可见的破坏性动作，且必须留痕。
   * 只有 service 的回滚路径会传它，**不暴露给工具/模型**（模型走 pm_rollback 的审批闸门）。
   */
  restore?: boolean;
  /** 要写入的字段。 */
  patch: PatchFields;
  /** 写入理由，用于审计与仲裁展示。 */
  reason?: string;
}

export interface PatchFields {
  name?: string;
  selfState?: SelfState;
  progress?: number;
  description?: string;
  refs?: NodeRecord['refs'];
  /** 稳定身份键（FR-158）：建树时补登记，让下次建树能按身份复用而不是按名字。 */
  identity?: string;
  /**
   * 「本轮建树没再提到它」（FR-158 ③）：**只标不删**，等用户确认后再清理。
   *
   * 为什么是标记而不是删除：这个节点可能已经被人报过进度（那是人的劳动），
   * 自动删掉就是"埋掉人的工作"；但一直留着又会让分母越来越大（用户最初的痛点：
   * 节点从 140 涨到 213、进度被灌水）。所以标记出来、交给用户决定。
   */
  stale?: boolean;
  /**
   * **优先级 1..10（1 最高）**。AI 建树时初判，人可在右键菜单里改。
   *
   * 与 `weight` 是两个轴：weight 是"要花多少力气"，priority 是"该不该先干"。
   * **不参与完成度计算。**
   */
  priority?: number;
  /** 优先级来源：`user` 表示人改过（建树刷新时不覆盖）。 */
  prioritySource?: 'ai' | 'user';
  /**
   * **待审查**（FR-164）：右键打过标记、还没审完。
   *
   * 取"下一个该做的"时**压过关注**（用户口径："审查优先级大于关注"）；
   * 审查通过后标记消失；父节点审过 ⇒ 整枝视为已审（清除时级联）。
   */
  needsReview?: boolean;
  /**
   * 描述最后一次被写入的时间（ISO）。**通常不用手动传** ——
   * `mutatePatch` 在 patch 里含 `description` 时会自动打上（见那里的说明）。
   */
  descriptionUpdatedAt?: string;
  /**
   * 完成简报里还留着"需要补充/处理"的事 ⇒ 节点黄底 + 感叹号示警。
   *
   * 由收尾方（会话/人）在写完成简报时一并设置：`pm_finish({ ..., followUp: true })`。
   */
  hasFollowUp?: boolean;
  gate?: Gate;
  focus?: boolean;
  dependsOn?: string[];
  weight?: number;
  estimateMin?: number;
  flags?: NodeRecord['flags'];
}

/** 校验上下文：调用方提供当前状态与外部条件。 */
export interface ValidateContext {
  node: NodeRecord;
  /** 是否有子节点（C5 判定）。 */
  childCount: number;
  /** 该枝内是否存在同名兄弟（C12）。 */
  duplicateSiblingId?: string;
  /** 引用路径是否逃逸工作区（C7）。 */
  escapingRefTargets?: string[];
  /** 该子树是否处于回滚锁中（C9）。 */
  rollbackLocked?: boolean;
  /** 该节点是否带 needsConfirm 挂起态（C10）。 */
  needsConfirm?: boolean;
  /** 同一节点上是否存在"语义互斥"的待仲裁写入（C2）。 */
  pendingOppositeWrite?: { selfState?: SelfState; by: ActorKind; at: string };
  policy: ConflictPolicy;
}

/** 校验结论。 */
export type ValidateDecision =
  | { kind: 'accept'; patch: PatchFields; autoFixes: ConflictCode[] }
  | { kind: 'reject'; code: ConflictCode; message: string; hint?: string; latestRev?: number }
  | { kind: 'arbitrate'; code: ConflictCode; message: string };


/**
 * 校验一次写入。纯函数：不修改入参，不在被拒绝时产生副作用。
 */
export function validateWrite(req: PatchRequest, ctx: ValidateContext): ValidateDecision {
  const { node } = ctx;
  const patch: PatchFields = { ...req.patch };
  const autoFixes: ConflictCode[] = [];

  // ── C7 安全违规：引用路径逃逸工作区 ──────────────────────────────
  const escapes = ctx.escapingRefTargets ?? [];
  if (escapes.length > 0) {
    return {
      kind: 'reject',
      code: 'C7',
      message: `引用路径逃逸工作区：${escapes.join('、')}`,
      hint: '引用 target 必须为工作区相对路径，禁止绝对路径与 `..` 逃逸',
    };
  }

  // ── C9 回滚锁：回滚期间该子树拒绝对外写入 ────────────────────────
  // 例外：**回滚自己的还原写入**（`restore`）不该被自己的锁挡住（见 PatchRequest.restore）。
  if (ctx.rollbackLocked === true && req.restore !== true) {
    return {
      kind: 'reject',
      code: 'C9',
      message: '该节点所在子树正在回滚，期间不接受写入',
      hint: '回滚完成后携带新的 rev 重试',
      latestRev: node.revision,
    };
  }

  // ── C10 挂起态：绑定会话未确认停止 ──────────────────────────────
  // 挂起态不阻止回滚本身，但阻止"重新推进"（否则会边回滚边写入）。
  const isProgression =
    patch.selfState === 'running' || patch.selfState === 'done' || (patch.progress ?? 0) > 0;
  if (ctx.needsConfirm === true && isProgression) {
    return {
      kind: 'reject',
      code: 'C10',
      message: '绑定会话尚未确认停止（待确认停止），此时不接受推进类写入',
      hint: '先等待停止确认或显式清除 needsConfirm 标记；超时后可标记会话失联并继续',
      latestRev: node.revision,
    };
  }

  // ── C6 状态倒退：done 被改回非 done ─────────────────────────────
  // 还原（restore）走自己的通道：它要能搬回快照点的任意状态，不算"倒退写入"。
  // 但通道本身要收紧：必须 force + 来源 user（还原是用户可见的破坏性动作，且必须留痕）。
  if (req.restore === true && patch.selfState !== undefined) {
    if (req.force !== true || req.by !== 'user') {
      return {
        kind: 'reject',
        code: 'C6',
        message: '回滚还原必须由 user 携带 force 执行',
        hint: '还原通道只给 service 的回滚路径用（模型路径需先过 ctx.approval）',
        latestRev: node.revision,
      };
    }
  }
  if (
    req.restore !== true &&
    patch.selfState !== undefined &&
    node.selfState === 'done' &&
    patch.selfState !== 'done'
  ) {
    const isUser = req.by === 'user';
    if (req.force !== true || !isUser) {
      return {
        kind: 'reject',
        code: 'C6',
        message: `已完成节点不可静默改回 ${patch.selfState}`,
        hint: '重开已完成节点需显式 force 且来源为 user（会留痕）',
        latestRev: node.revision,
      };
    }
  }

  // 迁移表校验（除 C6 之外的回退路径，如 running → pending 需 force）
  if (req.restore !== true && patch.selfState !== undefined && patch.selfState !== 'removed') {
    const transition = checkTransition(node.selfState, patch.selfState as WritableSelfState);
    if (!transition.ok) {
      return {
        kind: 'reject',
        code: 'C6',
        message: transition.reason ?? '非法状态迁移',
        hint: '如需回退请携带 force（来源必须为 user）',
        latestRev: node.revision,
      };
    }
    if (transition.requires.includes('force') && req.force !== true) {
      return {
        kind: 'reject',
        code: 'C6',
        message: `${node.selfState} → ${patch.selfState} 属回退操作，需要 force`,
        hint: '回退会留痕；来源为 user 时才允许重开已完成节点',
        latestRev: node.revision,
      };
    }
    if (transition.requires.includes('user') && req.by !== 'user') {
      return {
        kind: 'reject',
        code: 'C6',
        message: '该迁移仅允许来源为 user 的操作',
        latestRev: node.revision,
      };
    }
  }

  // ── C5 对父节点写入自身状态 ─────────────────────────────────────
  if (patch.selfState !== undefined && patch.selfState !== 'removed' && ctx.childCount > 0) {
    return {
      kind: 'reject',
      code: 'C5',
      message: '父节点状态完全由子节点派生，不能写入自身状态',
      hint: '改用门控（暂停/拦停）或修改具体子节点；删除整枝请走删除操作',
    };
  }

  // ── C1 版本陈旧 ────────────────────────────────────────────────
  if (req.rev !== undefined && req.rev !== node.revision) {
    return {
      kind: 'reject',
      code: 'C1',
      message: `写入携带的 rev=${req.rev} 已陈旧（当前 rev=${node.revision}）`,
      hint: '读取最新状态后携带新 rev 重试',
      latestRev: node.revision,
    };
  }

  // ── C3 / C4 自相矛盾（唯一允许自动修正的两条） ──────────────────
  if (patch.selfState === 'done' && patch.progress !== undefined && patch.progress < 1) {
    if (ctx.policy === 'always-arbitrate') {
      return {
        kind: 'arbitrate',
        code: 'C3',
        message: '「标记完成」与「progress < 1」互相矛盾',
      };
    }
    patch.progress = 1;
    autoFixes.push('C3');
  }

  if (patch.progress !== undefined && patch.progress > 0 && patch.selfState === 'pending') {
    if (ctx.policy === 'always-arbitrate') {
      return {
        kind: 'arbitrate',
        code: 'C4',
        message: '「progress > 0」与「selfState = pending」互相矛盾',
      };
    }
    patch.selfState = 'running';
    autoFixes.push('C4');
  }

  // ── C2 语义互斥（一个传完成、一个传待完成）──────────────────────
  const opposite = ctx.pendingOppositeWrite;
  if (opposite?.selfState !== undefined && patch.selfState !== undefined) {
    const a = opposite.selfState;
    const b = patch.selfState;
    const contradictory = a !== b && (a === 'done' || b === 'done');
    if (contradictory) {
      return {
        kind: 'arbitrate',
        code: 'C2',
        message: `与另一条写入（${a}）语义互斥：${a} ↔ ${b}`,
      };
    }
  }

  // ── C12 同名兄弟 ───────────────────────────────────────────────
  if (patch.name !== undefined && patch.name !== node.name && ctx.duplicateSiblingId !== undefined) {
    return {
      kind: 'reject',
      code: 'C12',
      message: `同级已存在同名节点「${patch.name}」`,
      hint: '改名重试；同级名称必须唯一以免投影与反解析产生歧义',
    };
  }

  return { kind: 'accept', patch, autoFixes };
}

/**
 * C8 结构写冲突：同一父节点下并发增删。**串行化**即可化解（按队列顺序应用），
 * 因此不需要拒绝，只需保证调用方走同一 FIFO 队列。此函数用于在审计里如实标注。
 */
export function noteStructuralSerialization(
  _parentId: string | null,
): { code: 'C8'; note: string } {
  return { code: 'C8', note: '结构写入已按队列顺序串行化' };
}

/** C11 关注归一化：由 `graph.planFocusNormalization` 实现，此处仅提供统一的冲突登记。 */
export function isConflictCode(value: string): value is ConflictCode {
  return /^C(?:[1-9]|1[0-2])$/.test(value);
}

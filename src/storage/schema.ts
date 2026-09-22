/**
 * 存储领域定义（§7.1 主路线：`ctx.storageDomain`）。
 *
 * 两个域按"写入块"的域归属拆开（§7.1）：
 * - `pm-structure`：项目名、节点结构/元数据、审计、冲突、checkpoint
 * - `pm-progress`：节点自身状态与进度（高频写，与结构写分离，减少互相排队）
 *
 * 记录 schema 用 **zod**（`defineDomain` 要求），插件 `Config` 用 schemastery —— 两者不可混。
 */

import { z } from 'zod';

import type { NodeFlag, NodeKind, Ref, SelfState, SubIntent, SubNotify, ActorKind } from '../shared/types.ts';

/** 数据格式版本；与领域 `version` 联动（§19.6）。 */
export const DATA_FORMAT = 1;

/** 领域版本：递增即意味着旧数据必须走迁移器链（§7.1）。 */
export const STRUCTURE_DOMAIN_VERSION = 1;
export const PROGRESS_DOMAIN_VERSION = 1;

export const projectIdSchema = z.string().min(1).max(200);
export const nodeIdSchema = z.string().min(1).max(200);

const refSchema: z.ZodType<Ref> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('note'), target: z.string().min(1) }),
  z.object({ type: z.literal('md'), target: z.string().min(1), label: z.string().optional() }),
  z.object({
    type: z.literal('code'),
    target: z.string().min(1),
    symbol: z.string().optional(),
    lines: z.tuple([z.number().int(), z.number().int()]).optional(),
  }),
  z.object({ type: z.literal('artifact'), target: z.string().min(1) }),
  z.object({ type: z.literal('dir'), target: z.string().min(1) }),
]);

const flagSchema: z.ZodType<NodeFlag> = z.enum([
  'addedMidway',
  'risk',
  'blocked',
  'needsConfirm',
  'rolledBack',
]);

const kindSchema: z.ZodType<NodeKind> = z.enum(['feature', 'task']);

const selfStateSchema: z.ZodType<SelfState> = z.enum(['pending', 'running', 'done', 'error', 'removed']);

const intentSchema: z.ZodType<SubIntent> = z.enum(['read', 'write', 'exclusive']);
const notifySchema: z.ZodType<SubNotify> = z.enum(['key', 'full', 'none']);
const actorKindSchema: z.ZodType<ActorKind> = z.enum(['session', 'subagent', 'job', 'user']);

const subscriptionSchema = z.object({
  subscriptionId: z.string().min(1),
  actor: actorKindSchema,
  actorId: z.string().min(1),
  intent: intentSchema,
  notify: notifySchema,
  touchedPaths: z.array(z.string()),
  claimedAt: z.string(),
  expiresAt: z.string().optional(),
});

/**
 * 结构域节点记录（§7.2 中"结构 + 元数据"那一半）。
 *
 * 刻意**不含** `selfState` / `progress`：它们在高频的进度域，
 * 这样一次进度推进不会与结构写入抢同一条域写链。
 */
export const nodeStructureSchema = z.object({
  id: nodeIdSchema,
  projectId: projectIdSchema,
  name: z.string().min(1),
  parentId: nodeIdSchema.nullable(),
  kind: kindSchema,
  estimateMin: z.number().nonnegative().optional(),
  actualMin: z.number().nonnegative().optional(),
  weight: z.number().positive().optional(),
  weightSource: z.enum(['ai', 'heuristic']).optional(),
  weightDetail: z.record(z.string(), z.unknown()).optional(),
  autoCreated: z.boolean().optional(),
  description: z.string().optional(),
  refs: z.array(refSchema).optional(),
  focus: z.boolean(),
  focusShadow: z.boolean().optional(),
  flags: z.array(flagSchema).optional(),
  lastRollbackAt: z.string().optional(),
  gate: z.enum(['paused', 'held']).nullable(),
  dependsOn: z.array(nodeIdSchema).optional(),
  bindings: z.array(subscriptionSchema).optional(),
  /** 结构域自己的 CAS 版本（`structRev`）。 */
  structRev: z.number().int().nonnegative(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

/** 进度域节点记录（§7.2 中"状态 + 进度"那一半）。 */
export const nodeProgressSchema = z.object({
  id: nodeIdSchema,
  projectId: projectIdSchema,
  selfState: selfStateSchema,
  progress: z.number().min(0).max(1),
  /** 进度域自己的 CAS 版本（`rev`）。 */
  rev: z.number().int().nonnegative(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});

/** 项目 meta（`dataFormat` 与基线版本，§19.6）。 */
export const projectMetaSchema = z.object({
  projectId: projectIdSchema,
  projectName: z.string(),
  dataFormat: z.number().int().nonnegative(),
  baselineDsh: z.string().optional(),
  pluginVersion: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 根节点 id 列表（通常一个）。 */
  rootIds: z.array(nodeIdSchema),
  /** 最近一次投影出的文档指纹，用于"结构未变则不重写文件"的短路判断。 */
  projectionFingerprint: z.string().optional(),
});

/** 审计记录（§7.4 / FR-26）。 */
export const auditRecordSchema = z.object({
  attemptId: z.string().min(1),
  projectId: projectIdSchema,
  nodeId: nodeIdSchema.nullable(),
  block: z.string(),
  op: z.record(z.string(), z.unknown()),
  by: z.string(),
  rev: z.number().int(),
  ts: z.string(),
  /** 自动修正/拒绝/仲裁的附加说明。 */
  note: z.string().optional(),
});

/** 冲突记录（§10.3）。 */
export const conflictRecordSchema = z.object({
  conflictId: z.string().min(1),
  projectId: projectIdSchema,
  nodeId: nodeIdSchema,
  code: z.string(),
  message: z.string(),
  /** 参与仲裁的候选写入。 */
  candidates: z.array(z.record(z.string(), z.unknown())),
  status: z.enum(['pending', 'resolved', 'abandoned']),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  resolution: z.record(z.string(), z.unknown()).optional(),
});

/** 快照索引记录（§7.5）。 */
export const snapshotRecordSchema = z.object({
  snapshotId: z.string().min(1),
  projectId: projectIdSchema,
  nodeIds: z.array(nodeIdSchema),
  reason: z.enum(['pause', 'hold', 'manual', 'pre-rollback']),
  mode: z.enum(['git', 'patch', 'full']),
  aux: z.enum(['patch', 'none']),
  auxPaths: z.array(z.string()),
  ref: z.string(),
  touchedPaths: z.array(z.string()),
  sharedPaths: z.array(z.string()),
  nodeState: z.record(
    z.string(),
    z.object({
      selfState: selfStateSchema,
      progress: z.number(),
      gate: z.enum(['paused', 'held']).nullable(),
    }),
  ),
  sizeBytes: z.number().nonnegative(),
  createdAt: z.string(),
  createdBy: z.string(),
});

/** 多记录操作的 checkpoint（FR-125：幂等可重放序列）。 */
export const checkpointRecordSchema = z.object({
  checkpointId: z.string().min(1),
  projectId: projectIdSchema,
  kind: z.enum(['branch-rollback', 'batch-delete', 'batch-reset', 'migration']),
  /** 已完成步骤的幂等标记（可重放，重复应用无副作用）。 */
  doneSteps: z.array(z.string()),
  totalSteps: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.string(),
  updatedAt: z.string(),
});

/** 结构域全局状态（必须非 null，`defineDomain` 会校验）。 */
export const structureGlobalSchema = z.object({
  initialized: z.boolean(),
  projectIds: z.array(projectIdSchema),
});

export const progressGlobalSchema = z.object({
  initialized: z.boolean(),
});

export type NodeStructureRecord = z.infer<typeof nodeStructureSchema>;
export type NodeProgressRecord = z.infer<typeof nodeProgressSchema>;
export type ProjectMetaRecord = z.infer<typeof projectMetaSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type ConflictRecord = z.infer<typeof conflictRecordSchema>;
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;

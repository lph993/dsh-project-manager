/**
 * 存储领域 spec（`defineDomain` 的真实形态）与 KV 端口实现（§7.1 主路线）。
 *
 * 关键契约（已按 DSH 0.1.5-rc.2 实测核对）：
 * - `ctx.storageDomain` 是 `DomainFacility` 服务，用 `open(spec)` 打开领域
 * - 表读取**同步**（来自内存已校验状态），写入**异步且 resolve 即持久**
 * - `table.update(key, fn)` 的 `fn` 在**每领域单条写链**的槽位上执行 → 原子 RMW
 * - 变更事件 `domain/changed` 按写入顺序发出
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
// 纯类型导入：加载 `ctx.storageDomain` 的接口增补。
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

import { serviceOf } from '../adapter/capabilities.ts';

import type { GraphSnapshot, NodeRecord } from '../shared/types.ts';
import type { StorageChange, StoragePort } from './port.ts';
import {
  DATA_FORMAT,
  PROGRESS_DOMAIN_VERSION,
  STRUCTURE_DOMAIN_VERSION,
  auditRecordSchema,
  checkpointRecordSchema,
  conflictRecordSchema,
  nodeProgressSchema,
  nodeStructureSchema,
  progressGlobalSchema,
  projectMetaSchema,
  snapshotRecordSchema,
  structureGlobalSchema,
  type AuditRecord,
  type CheckpointRecord,
  type ConflictRecord,
  type NodeProgressRecord,
  type NodeStructureRecord,
  type ProjectMetaRecord,
  type SnapshotRecord,
} from './schema.ts';

/** 结构域：项目 meta、节点结构、审计、冲突、快照索引、checkpoint。 */
export const structureDomainSpec = defineDomain({
  // 注意：`defineDomain` 要求名匹配 `^[a-z][a-z0-9_]*$`（**不允许连字符**）。
  name: 'project_manager_structure',
  version: STRUCTURE_DOMAIN_VERSION,
  global: { schema: structureGlobalSchema, initial: { initialized: false, projectIds: [] } },
  tables: {
    meta: domainTable(projectMetaSchema),
    nodes: domainTable(nodeStructureSchema),
    audit: domainTable(auditRecordSchema),
    conflicts: domainTable(conflictRecordSchema),
    snapshots: domainTable(snapshotRecordSchema),
    checkpoints: domainTable(checkpointRecordSchema),
  },
});

/** 进度域：节点自身状态与进度（高频写，与结构写分离）。 */
export const progressDomainSpec = defineDomain({
  name: 'project_manager_progress',
  version: PROGRESS_DOMAIN_VERSION,
  global: { schema: progressGlobalSchema, initial: { initialized: false } },
  tables: {
    nodes: domainTable(nodeProgressSchema),
  },
});

/** 领域名常量（事件过滤与迁移都要用同一份）。 */
export const STRUCTURE_DOMAIN_NAME = 'project_manager_structure';
export const PROGRESS_DOMAIN_NAME = 'project_manager_progress';

/** 审计有界保留上限（存储清理须自研，不用 output-retention —— FR-131）。 */
export const AUDIT_RETENTION_MAX = 5000;

/**
 * KV 主路线端口。
 *
 * 组合方式（见 `src/index.ts`）：`await ctx.storageDomain.open(spec)`，
 * 并用 `ctx.effect(() => () => domain.close())` 保证随插件卸载关闭。
 */
export class KvStoragePort implements StoragePort {
  readonly route = 'kv-domain' as const;
  readonly capabilities = {
    atomicSingleRecord: true,
    crossProcessLock: true,
    needsCompaction: false,
    changeEvents: true,
  };

  private readonly listeners = new Set<(change: StorageChange) => void>();
  private disposed = false;
  private readonly ctx: CordisContext;
  /** 注意：这里必须保留 spec 的**具体类型**，否则泛型退化为 `unknown`/`never`。 */
  private readonly structure: Domain<typeof structureDomainSpec>;
  private readonly progress: Domain<typeof progressDomainSpec>;

  // 不用构造函数参数属性：Node 的 TS strip-only 模式不支持该语法，
  // 而领域层与工具我们希望尽量能被 `node --test` 直跑（少一层构建）。
  private constructor(
    ctx: CordisContext,
    structure: Domain<typeof structureDomainSpec>,
    progress: Domain<typeof progressDomainSpec>,
  ) {
    this.ctx = ctx;
    this.structure = structure;
    this.progress = progress;
  }

  /** 打开两个领域并挂上变更事件转发。 */
  static async create(ctx: CordisContext): Promise<KvStoragePort> {
    const facility = serviceOf<DomainFacility>(ctx, 'storageDomain');
    if (!facility) {
      throw new Error('storageDomain 服务不可用（ctx.storageDomain 与 ctx.get 均未解析到）');
    }
    const structure = await facility.open(structureDomainSpec);
    const progress = await facility.open(progressDomainSpec);
    const port = new KvStoragePort(ctx, structure, progress);
    /**
     * 释放必须**可被等待**（2026-09-25 真机 HMR 实验的结论）。
     *
     * 早先是 `void port.close()`（火后不管），而 HMR 重载/二次装配会**紧接着重新 `open`** ——
     * close 还在飞、open 已经来，就是一个纯粹的时序竞态。真机证据：连续两次热重载，
     * **第一次**把插件卸掉后装不回来（`/pm/*` 404 且 15 秒内不恢复），**第二次**却成功了；
     * 而 e2e 的"二次装配"（同步 dispose→apply，没有真实 I/O 时序）一直是绿的 ⇒
     * 差别就在**真实 I/O 的时序**上。所以把 disposer 改成**返回 close 的 promise**，
     * 让宿主能排着队"关干净再开"，而不是靠运气。
     */
    ctx.effect(() => () => port.close(), 'project-manager.storage.close');
    return port;
  }

  private get structureNodes() {
    return this.structure.table('nodes');
  }

  private get structureMeta() {
    return this.structure.table('meta');
  }

  private get structureAudit() {
    return this.structure.table('audit');
  }

  private get structureConflicts() {
    return this.structure.table('conflicts');
  }

  private get structureSnapshots() {
    return this.structure.table('snapshots');
  }

  private get structureCheckpoints() {
    return this.structure.table('checkpoints');
  }

  private get progressNodes() {
    return this.progress.table('nodes');
  }

  /** 挂载 `domain/changed` → 端口级变更事件（§11.4 增量更新的来源）。 */
  attachChangeEvents(): () => void {
    return this.ctx.on('domain/changed', (change) => {
      if (this.disposed) return;
      const domain = (change as { domain?: string }).domain;
      if (domain !== STRUCTURE_DOMAIN_NAME && domain !== PROGRESS_DOMAIN_NAME) return;
      if (change.table !== 'nodes') {
        if (change.table === 'meta') {
          this.emit({ kind: 'meta-updated', projectId: change.key });
        } else if (change.table === 'conflicts') {
          this.emit({ kind: 'conflict-changed', conflictId: change.key });
        }
        return;
      }
      if (change.operation === 'deleted') {
        this.emit({ kind: 'node-deleted', nodeId: change.key });
      } else {
        this.emit({ kind: 'node-upserted', nodeId: change.key });
      }
    });
  }

  private emit(change: StorageChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 观察者异常不影响写入（与 domain/changed 的语义一致）
      }
    }
  }

  onChange(listener: (change: StorageChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── 项目 ───────────────────────────────────────────────────────
  async openProject(meta: ProjectMetaRecord): Promise<void> {
    await this.structureMeta.put(meta.projectId, meta);
    const global = this.structure.global.get();
    if (!global.projectIds.includes(meta.projectId)) {
      await this.structure.global.set({
        initialized: true,
        projectIds: [...global.projectIds, meta.projectId],
      });
    }
  }

  async getMeta(projectId: string): Promise<ProjectMetaRecord | undefined> {
    return this.structureMeta.get(projectId);
  }

  async putMeta(meta: ProjectMetaRecord): Promise<void> {
    await this.structureMeta.put(meta.projectId, meta);
  }

  async listProjects(): Promise<string[]> {
    return [...this.structure.global.get().projectIds];
  }

  async deleteProject(projectId: string): Promise<void> {
    for (const key of [...this.structureNodes.keys()]) {
      const record = this.structureNodes.get(key);
      if (record?.projectId === projectId) await this.structureNodes.delete(key);
    }
    for (const key of [...this.progressNodes.keys()]) {
      const record = this.progressNodes.get(key);
      if (record?.projectId === projectId) await this.progressNodes.delete(key);
    }
    await this.structureMeta.delete(projectId);
    const global = this.structure.global.get();
    await this.structure.global.set({
      initialized: global.initialized,
      projectIds: global.projectIds.filter((id) => id !== projectId),
    });
  }

  // ── 节点 ───────────────────────────────────────────────────────
  async readGraph(projectId: string): Promise<GraphSnapshot | undefined> {
    const meta = this.structureMeta.get(projectId);
    if (!meta) return undefined;
    const nodes: Record<string, NodeRecord> = {};
    for (const [, structure] of this.structureNodes.entries()) {
      if (structure.projectId !== projectId) continue;
      nodes[structure.id] = mergeRecords(structure, this.progressNodes.get(structure.id));
    }
    return {
      projectName: meta.projectName,
      nodes,
      rootIds: meta.rootIds,
      dataFormat: meta.dataFormat,
      ...(meta.baselineDsh !== undefined ? { baselineDsh: meta.baselineDsh } : {}),
      createdAt: meta.createdAt,
    };
  }

  async getNode(projectId: string, nodeId: string): Promise<NodeRecord | undefined> {
    const structure = this.structureNodes.get(nodeId);
    if (!structure || structure.projectId !== projectId) return undefined;
    return mergeRecords(structure, this.progressNodes.get(nodeId));
  }

  async putNode(projectId: string, node: NodeRecord): Promise<void> {
    const structure: NodeStructureRecord = {
      id: node.id,
      projectId,
      name: node.name,
      parentId: node.parentId,
      kind: node.kind,
      estimateMin: node.estimateMin,
      actualMin: node.actualMin,
      weight: node.weight,
      weightSource: node.weightSource,
      weightDetail: node.weightDetail,
      autoCreated: node.autoCreated,
      description: node.description,
      refs: node.refs,
      /**
       * ⚠️ `identity` / `stale` **必须在这里带上**：本方法是**逐字段**构造结构记录（不是整对象展开），
       * 所以 `NodeRecord` 上新增的任何字段只要忘了加进来，就会在**主路线（KV）里被静默丢掉**。
       * 实测踩过两次：`identity`（FR-158 建树幂等的根）与 `stale`（FR-158 ③ 疑似遗留标记）
       * 都曾是"类型里有、落库时没了"，于是功能看起来实现了却永远不生效。
       * 教训：**结构域字段表是白名单，加字段必须两头都改**（`shared/types.ts` + 这里 + `schema.ts`）。
       */
      identity: node.identity,
      stale: node.stale,
      descriptionUpdatedAt: node.descriptionUpdatedAt,
      hasFollowUp: node.hasFollowUp,
      lastSessionId: node.lastSessionId,
      priority: node.priority,
      prioritySource: node.prioritySource,
      /** 待审查（FR-164）：这个字段也踩过"白名单漏了"的坑，所以在三处 + 照妖镜都登记。 */
      needsReview: node.needsReview,
      focus: node.focus,
      focusShadow: node.focusShadow,
      flags: node.flags,
      lastRollbackAt: node.lastRollbackAt,
      gate: node.gate,
      dependsOn: node.dependsOn,
      bindings: node.bindings,
      structRev: node.revision,
      updatedAt: node.updatedAt,
      updatedBy: node.updatedBy,
    };
    const progressRecord: NodeProgressRecord = {
      id: node.id,
      projectId,
      selfState: node.selfState,
      progress: node.progress,
      rev: node.revision,
      updatedAt: node.updatedAt,
      updatedBy: node.updatedBy,
    };
    await this.structureNodes.put(node.id, stripUndefined(structure) as NodeStructureRecord);
    await this.progressNodes.put(node.id, progressRecord);
    assertNoDroppedFields(node, structure);
  }

  async deleteNode(projectId: string, nodeId: string): Promise<void> {
    void projectId;
    await this.structureNodes.delete(nodeId);
    await this.progressNodes.delete(nodeId);
  }

  // ── 审计（有界保留：保留最新、淘汰最旧，自研实现 §FR-131）──────
  async appendAudit(record: AuditRecord): Promise<void> {
    await this.structureAudit.put(record.attemptId, record);
    await this.enforceAuditBound(record.projectId);
  }

  private async enforceAuditBound(projectId: string): Promise<void> {
    const rows: AuditRecord[] = [];
    for (const [, value] of this.structureAudit.entries()) {
      if (value.projectId === projectId) rows.push(value);
    }
    if (rows.length <= AUDIT_RETENTION_MAX) return;
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    const excess = rows.length - AUDIT_RETENTION_MAX;
    for (let i = 0; i < excess; i += 1) {
      const victim = rows[i];
      if (victim) await this.structureAudit.delete(victim.attemptId);
    }
  }

  async listAudit(projectId: string, limit: number): Promise<AuditRecord[]> {
    const rows: AuditRecord[] = [];
    for (const [, value] of this.structureAudit.entries()) {
      if (value.projectId === projectId) rows.push(value);
    }
    rows.sort((a, b) => b.ts.localeCompare(a.ts));
    return rows.slice(0, limit);
  }

  // ── 冲突 ───────────────────────────────────────────────────────
  async putConflict(record: ConflictRecord): Promise<void> {
    await this.structureConflicts.put(record.conflictId, record);
  }

  async getConflict(conflictId: string): Promise<ConflictRecord | undefined> {
    return this.structureConflicts.get(conflictId);
  }

  async listConflicts(
    projectId: string,
    status?: ConflictRecord['status'],
  ): Promise<ConflictRecord[]> {
    const rows: ConflictRecord[] = [];
    for (const [, value] of this.structureConflicts.entries()) {
      if (value.projectId !== projectId) continue;
      if (status && value.status !== status) continue;
      rows.push(value);
    }
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows;
  }

  // ── 快照索引 ───────────────────────────────────────────────────
  async putSnapshot(record: SnapshotRecord): Promise<void> {
    await this.structureSnapshots.put(record.snapshotId, record);
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRecord | undefined> {
    return this.structureSnapshots.get(snapshotId);
  }

  async listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
    const rows: SnapshotRecord[] = [];
    for (const [, value] of this.structureSnapshots.entries()) {
      if (value.projectId === projectId) rows.push(value);
    }
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rows;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.structureSnapshots.delete(snapshotId);
  }

  // ── checkpoint ────────────────────────────────────────────────
  async putCheckpoint(record: CheckpointRecord): Promise<void> {
    await this.structureCheckpoints.put(record.checkpointId, record);
  }

  async getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined> {
    return this.structureCheckpoints.get(checkpointId);
  }

  async listCheckpoints(projectId: string): Promise<CheckpointRecord[]> {
    const rows: CheckpointRecord[] = [];
    for (const [, value] of this.structureCheckpoints.entries()) {
      if (value.projectId === projectId) rows.push(value);
    }
    return rows;
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await this.structureCheckpoints.delete(checkpointId);
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    await this.structure.close();
    await this.progress.close();
  }
}

/** 合并两个域的记录为领域层形态；进度域缺失时回落默认值。 */
function mergeRecords(
  structure: NodeStructureRecord,
  progress: NodeProgressRecord | undefined,
): NodeRecord {
  const node: NodeRecord = {
    id: structure.id,
    name: structure.name,
    parentId: structure.parentId,
    kind: structure.kind,
    selfState: progress?.selfState ?? 'pending',
    progress: progress?.progress ?? 0,
    focus: structure.focus,
    gate: structure.gate,
    revision: Math.max(structure.structRev, progress?.rev ?? 0),
    updatedAt: structure.updatedAt,
    updatedBy: structure.updatedBy,
  };
  if (structure.estimateMin !== undefined) node.estimateMin = structure.estimateMin;
  if (structure.actualMin !== undefined) node.actualMin = structure.actualMin;
  if (structure.weight !== undefined) node.weight = structure.weight;
  if (structure.weightSource !== undefined) node.weightSource = structure.weightSource;
  if (structure.weightDetail !== undefined) node.weightDetail = structure.weightDetail;
  if (structure.autoCreated !== undefined) node.autoCreated = structure.autoCreated;
  if (structure.description !== undefined) node.description = structure.description;
  if (structure.refs !== undefined) node.refs = structure.refs;
  /**
   * ⚠️ 与 `putNode` **成对**：写入带上的字段，还原时必须带回，否则等于"存了但读不出来"。
   * `identity` / `stale` 曾在这里漏掉 —— 那种"功能实现了却不生效"最难查（对象里确实有值，
   * 只是每次读回来就没了）。改任一侧都要同时改另一侧。
   */
  if (structure.identity !== undefined) node.identity = structure.identity;
  if (structure.stale !== undefined) node.stale = structure.stale;
  if (structure.descriptionUpdatedAt !== undefined) node.descriptionUpdatedAt = structure.descriptionUpdatedAt;
  if (structure.hasFollowUp !== undefined) node.hasFollowUp = structure.hasFollowUp;
  if (structure.lastSessionId !== undefined) node.lastSessionId = structure.lastSessionId;
  if (structure.priority !== undefined) node.priority = structure.priority;
  if (structure.prioritySource !== undefined) node.prioritySource = structure.prioritySource;
  if (structure.needsReview !== undefined) node.needsReview = structure.needsReview;
  if (structure.focusShadow !== undefined) node.focusShadow = structure.focusShadow;
  if (structure.flags !== undefined) node.flags = structure.flags;
  if (structure.lastRollbackAt !== undefined) node.lastRollbackAt = structure.lastRollbackAt;
  if (structure.dependsOn !== undefined) node.dependsOn = structure.dependsOn;
  if (structure.bindings !== undefined) node.bindings = structure.bindings;
  return node;
}

/** 进度域自己负责的字段（不属于结构域白名单，比对时要排除）。 */
const PROGRESS_OWNED_FIELDS = new Set(['selfState', 'progress']);

/**
 * 结构域里**改了名**保存的字段（同值不同名，不算丢）。照妖镜必须认识这些别名，否则全是误报。
 */
const STRUCTURE_FIELD_ALIASES: Record<string, string> = { revision: 'structRev' };

/**
 * **结构域字段表是白名单，漏一个字段就会被静默丢掉** —— 这个检查把那种"写了但存不下"变成当场报错。
 *
 * 为什么值得常驻：`identity`（FR-158 建树幂等的根）与 `stale`（FR-158 ③ 疑似遗留标记）
 * 都曾经"类型里有、`putNode` 里没有"，于是功能看起来实现了、却永远不生效；
 * 而症状（建树老是新建、进度推不动）离根因（少写了一行）很远，查起来极贵。
 *
 * **只查"疑点字段"**（身份 / 标记 / 计时 / 计数这类容易被忘的），不查全部字段：
 * 有些字段本来就只在某个域（如 `derivedState` 是派生值、不进存储），一律报错会变成噪音。
 */
const DROPPABLE_FIELD_HINTS = ['identity', 'stale', 'descriptionUpdatedAt', 'hasFollowUp', 'lastSessionId', 'priority', 'prioritySource', 'needsReview', 'actualMin', 'estimateMin', 'lastRollbackAt', 'focusShadow', 'dependsOn', 'bindings', 'weightDetail'];

function assertNoDroppedFields(source: NodeRecord, saved: NodeStructureRecord): void {
  const savedKeys = new Set(Object.keys(saved));
  const dropped: string[] = [];
  for (const key of DROPPABLE_FIELD_HINTS) {
    if (PROGRESS_OWNED_FIELDS.has(key)) continue;
    const sourceValue = (source as unknown as Record<string, unknown>)[key];
    if (sourceValue === undefined) continue;
    const savedName = STRUCTURE_FIELD_ALIASES[key] ?? key;
    if (!savedKeys.has(savedName)) dropped.push(key);
  }
  if (dropped.length === 0) return;
  throw new Error(
    `kv-port.putNode 丢掉字段：${dropped.join('、')} —— ` +
      '结构域白名单（本方法）必须与 shared/types.ts 的 NodeRecord 同步；' +
      '漏字段会让功能"实现了但不生效"（FR-158 的 identity/stale 就踩过两次）',
  );
}

function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}

/** 生成新项目 id（`dsh-util-crypto` 的浏览器安全 UUID，§5.2）。 */
export function newProjectId(): string {
  return `pm_${randomUUID()}`;
}

/** 数据格式常量再导出，避免调用方各自 import schema。 */
export { DATA_FORMAT };

/**
 * 兜底文件存储路线（§7.1b / FR-119/120/123）。
 *
 * **何时用**：能力探测发现 `ctx.storageDomain` 不可用时（FR-124）。它是主路线的降级路径，
 * 但**同样必须耐用**，只是实现方式不同：
 *
 * | 需求 | 主路线（KV） | 本路线 |
 * |---|---|---|
 * | FR-20 块化写入 | 领域写链保证不交错 | **append-only 日志**（只追加，物理上不可能交错覆盖） |
 * | FR-22 队列化写入 | 复用领域单条写链 | **自建 FIFO 队列** |
 * | FR-26 审计 | `audit` 表 | 同一份 append-only 日志（有界保留） |
 * | FR-119–122 压实/归档 | 不需要 | **必须实现**（否则日志无限膨胀） |
 * | §14 持久性 | resolve 即持久 | 追加写；打开时**重放** |
 *
 * 落盘策略（关键设计）：
 * - **所有写操作都追加到 `graph.jsonl`**，因此崩溃后总能重放；
 * - `snapshot.json` **只在压实时写出**，是"减少重放量"的优化，**不是**权威来源；
 * - 压实 = 写 snapshot → 把日志归档到 `archive/` → 截断日志（FR-119/120）。
 *
 * 目录布局（`.pm/` 在工作区内，§7.5 已把它排除在快照之外）：
 * ```
 * .pm/meta.json          项目元信息（含 dataFormat 与投影指纹）
 * .pm/graph.jsonl        append-only 变更日志（块化写入的落点）
 * .pm/snapshot.json      压实产出的全量状态（重放起点）
 * .pm/archive/graph-*.jsonl  压实后归档的旧日志（保留最近 N 份）
 * ```
 *
 * 与主路线的**能力差异**（如实列出，FR-123）：
 * - 无跨进程写锁（`crossProcessLock: false`）
 * - 需要压实（`needsCompaction: true`）
 * - 打开需要重放日志（之后走内存）
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Gate, GraphSnapshot, NodeRecord, SelfState, WriteAttempt } from '../shared/types.ts';
import type { StorageChange, StoragePort, StorageRoute } from './port.ts';
import {
  auditRecordSchema,
  checkpointRecordSchema,
  conflictRecordSchema,
  nodeProgressSchema,
  nodeStructureSchema,
  projectMetaSchema,
  snapshotRecordSchema,
  type AuditRecord,
  type CheckpointRecord,
  type ConflictRecord,
  type NodeProgressRecord,
  type NodeStructureRecord,
  type ProjectMetaRecord,
  type SnapshotRecord,
} from './schema.ts';

/** `.pm/` 下的文件与目录名（与 §7.5 的排除规则一致）。 */
export const PM_DIR = '.pm';
export const GRAPH_LOG = 'graph.jsonl';
export const SNAPSHOT_FILE = 'snapshot.json';
export const META_FILE = 'meta.json';
export const ARCHIVE_DIR = 'archive';

/** 压实阈值：日志行数超过 `max(500, 50 × 节点数)` 即压实（FR-119）。 */
export const COMPACT_MIN_LINES = 500;
export const COMPACT_LINES_PER_NODE = 50;

/** 归档保留份数（FR-120：超限最旧优先清理）。 */
export const ARCHIVE_KEEP = 3;

/** 审计有界保留上限（与 KV 路线一致）。 */
export const AUDIT_KEEP = 5000;

/** 日志记录（append-only 的唯一内容）。 */
type LogRecord =
  | { kind: 'meta'; meta: ProjectMetaRecord }
  | { kind: 'node'; projectId: string; nodeId: string; node: NodeRecord }
  | { kind: 'node-deleted'; projectId: string; nodeId: string }
  | { kind: 'project-deleted'; projectId: string }
  | { kind: 'audit'; audit: AuditRecord }
  | { kind: 'conflict'; conflict: ConflictRecord }
  | { kind: 'snapshot-record'; snapshot: SnapshotRecord }
  | { kind: 'snapshot-deleted'; snapshotId: string }
  | { kind: 'checkpoint'; checkpoint: CheckpointRecord }
  | { kind: 'checkpoint-deleted'; checkpointId: string };

/** 压实产出的全量状态（`snapshot.json` 的形状）。 */
export interface SnapshotPayload {
  meta: ProjectMetaRecord[];
  nodes: NodeStructureRecord[];
  progress: NodeProgressRecord[];
  audit: AuditRecord[];
  conflicts: ConflictRecord[];
  snapshots: SnapshotRecord[];
  checkpoints: CheckpointRecord[];
}

/** 领域节点 → 存储记录（结构与进度分开，与 KV 路线的两个域对齐）。 */
export function toStorageRecords(
  projectId: string,
  node: NodeRecord,
): { structure: NodeStructureRecord; progress: NodeProgressRecord } {
  const structure: NodeStructureRecord = {
    id: node.id,
    projectId,
    name: node.name,
    parentId: node.parentId,
    kind: node.kind,
    focus: node.focus,
    gate: node.gate,
    structRev: node.revision,
    updatedAt: node.updatedAt,
    updatedBy: node.updatedBy,
  };
  if (node.estimateMin !== undefined) structure.estimateMin = node.estimateMin;
  if (node.actualMin !== undefined) structure.actualMin = node.actualMin;
  if (node.weight !== undefined) structure.weight = node.weight;
  if (node.weightSource !== undefined) structure.weightSource = node.weightSource;
  if (node.weightDetail !== undefined) structure.weightDetail = node.weightDetail;
  if (node.autoCreated !== undefined) structure.autoCreated = node.autoCreated;
  if (node.description !== undefined) structure.description = node.description;
  if (node.refs !== undefined) structure.refs = node.refs;
  if (node.focusShadow !== undefined) structure.focusShadow = node.focusShadow;
  if (node.flags !== undefined) structure.flags = node.flags;
  if (node.lastRollbackAt !== undefined) structure.lastRollbackAt = node.lastRollbackAt;
  if (node.dependsOn !== undefined) structure.dependsOn = node.dependsOn;
  if (node.bindings !== undefined) structure.bindings = node.bindings;

  const progress: NodeProgressRecord = {
    id: node.id,
    projectId,
    selfState: node.selfState,
    progress: node.progress,
    rev: node.revision,
    updatedAt: node.updatedAt,
    updatedBy: node.updatedBy,
  };
  return { structure, progress };
}

/**
 * 存储记录 → 领域节点（合并结构与进度两半；两半都要通过 schema 校验）。
 *
 * 返回 undefined 表示结构记录不合法（损坏行 → 跳过，不影响其余数据）。
 */
export function fromStorageRecords(
  structureValue: unknown,
  progressValue: unknown,
): NodeRecord | undefined {
  const structure = nodeStructureSchema.safeParse(structureValue);
  if (!structure.success) return undefined;
  const progress = nodeProgressSchema.safeParse(progressValue);
  const s = structure.data;
  const p = progress.success ? progress.data : undefined;

  const node: NodeRecord = {
    id: s.id,
    name: s.name,
    parentId: s.parentId,
    kind: s.kind,
    selfState: p?.selfState ?? ('pending' as SelfState),
    progress: p?.progress ?? 0,
    focus: s.focus,
    gate: s.gate as Gate,
    revision: Math.max(s.structRev, p?.rev ?? 0),
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  };
  if (s.estimateMin !== undefined) node.estimateMin = s.estimateMin;
  if (s.actualMin !== undefined) node.actualMin = s.actualMin;
  if (s.weight !== undefined) node.weight = s.weight;
  if (s.weightSource !== undefined) node.weightSource = s.weightSource;
  if (s.weightDetail !== undefined) node.weightDetail = s.weightDetail;
  if (s.autoCreated !== undefined) node.autoCreated = s.autoCreated;
  if (s.description !== undefined) node.description = s.description;
  if (s.refs !== undefined) node.refs = s.refs;
  if (s.focusShadow !== undefined) node.focusShadow = s.focusShadow;
  if (s.flags !== undefined) node.flags = s.flags;
  if (s.lastRollbackAt !== undefined) node.lastRollbackAt = s.lastRollbackAt;
  if (s.dependsOn !== undefined) node.dependsOn = s.dependsOn;
  if (s.bindings !== undefined) node.bindings = s.bindings;
  return node;
}

export interface FileStoragePortOptions {
  /** 工作区根；`.pm/` 就建在它下面。 */
  workspaceRoot: string;
}

/**
 * 兜底路线实现。
 *
 * 写入串行化由 FIFO 队列保证（`enqueue`）：与主路线"每领域单条写链"语义等价。
 */
export class FileStoragePort implements StoragePort {
  readonly route: StorageRoute = 'file-fallback';
  readonly capabilities = {
    atomicSingleRecord: false,
    crossProcessLock: false,
    needsCompaction: true,
    changeEvents: true,
  };

  private readonly root: string;
  private readonly listeners = new Set<(change: StorageChange) => void>();
  private readonly meta = new Map<string, ProjectMetaRecord>();
  private readonly nodes = new Map<string, Map<string, NodeRecord>>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly checkpoints = new Map<string, CheckpointRecord>();
  private audit: AuditRecord[] = [];
  /** FIFO 写队列尾。 */
  private tail: Promise<unknown> = Promise.resolve();
  private logLines = 0;
  private opened = false;

  constructor(options: FileStoragePortOptions) {
    this.root = join(options.workspaceRoot, PM_DIR);
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** 串行执行写操作（等价于主路线的单条写链）。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ── 打开与重放 ───────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(this.root, { recursive: true });
    await mkdir(this.path(ARCHIVE_DIR), { recursive: true });
    this.opened = true;

    // ① 读压实产出（重放起点）
    await this.loadSnapshotFile();
    // ② 重放日志（append-only 顺序 = 写入顺序）
    let text = '';
    try {
      text = await readFile(this.path(GRAPH_LOG), 'utf8');
    } catch {
      text = '';
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    this.logLines = lines.length;
    for (const line of lines) {
      try {
        this.applyLogRecord(JSON.parse(line) as LogRecord);
      } catch {
        // 损坏行跳过（不让打开失败）；其余数据照常可用
      }
    }
    // ③ 审计有界（重放后收口）
    if (this.audit.length > AUDIT_KEEP) this.audit = this.audit.slice(-AUDIT_KEEP);
  }

  private async loadSnapshotFile(): Promise<void> {
    let payload: SnapshotPayload;
    try {
      const text = await readFile(this.path(SNAPSHOT_FILE), 'utf8');
      if (text.trim() === '') return;
      payload = JSON.parse(text) as SnapshotPayload;
    } catch {
      return;
    }
    for (const item of payload.meta ?? []) {
      const parsed = projectMetaSchema.safeParse(item);
      if (parsed.success) this.meta.set(parsed.data.projectId, parsed.data);
    }
    const progressById = new Map<string, unknown>();
    for (const item of payload.progress ?? []) {
      const parsed = nodeProgressSchema.safeParse(item);
      if (parsed.success) progressById.set(parsed.data.id, parsed.data);
    }
    for (const item of payload.nodes ?? []) {
      const structure = nodeStructureSchema.safeParse(item);
      if (!structure.success) continue;
      const node = fromStorageRecords(structure.data, progressById.get(structure.data.id));
      if (node) this.nodeMap(structure.data.projectId).set(node.id, node);
    }
    for (const item of payload.audit ?? []) {
      const parsed = auditRecordSchema.safeParse(item);
      if (parsed.success) this.audit.push(parsed.data);
    }
    for (const item of payload.conflicts ?? []) {
      const parsed = conflictRecordSchema.safeParse(item);
      if (parsed.success) this.conflicts.set(parsed.data.conflictId, parsed.data);
    }
    for (const item of payload.snapshots ?? []) {
      const parsed = snapshotRecordSchema.safeParse(item);
      if (parsed.success) this.snapshots.set(parsed.data.snapshotId, parsed.data);
    }
    for (const item of payload.checkpoints ?? []) {
      const parsed = checkpointRecordSchema.safeParse(item);
      if (parsed.success) this.checkpoints.set(parsed.data.checkpointId, parsed.data);
    }
  }

  private nodeMap(projectId: string): Map<string, NodeRecord> {
    let map = this.nodes.get(projectId);
    if (!map) {
      map = new Map();
      this.nodes.set(projectId, map);
    }
    return map;
  }

  private applyLogRecord(record: LogRecord): void {
    switch (record.kind) {
      case 'meta':
        this.meta.set(record.meta.projectId, record.meta);
        return;
      case 'node':
        this.nodeMap(record.projectId).set(record.nodeId, record.node);
        return;
      case 'node-deleted':
        this.nodes.get(record.projectId)?.delete(record.nodeId);
        return;
      case 'project-deleted':
        this.meta.delete(record.projectId);
        this.nodes.delete(record.projectId);
        return;
      case 'audit':
        this.audit.push(record.audit);
        return;
      case 'conflict':
        this.conflicts.set(record.conflict.conflictId, record.conflict);
        return;
      case 'snapshot-record':
        this.snapshots.set(record.snapshot.snapshotId, record.snapshot);
        return;
      case 'snapshot-deleted':
        this.snapshots.delete(record.snapshotId);
        return;
      case 'checkpoint':
        this.checkpoints.set(record.checkpoint.checkpointId, record.checkpoint);
        return;
      case 'checkpoint-deleted':
        this.checkpoints.delete(record.checkpointId);
        return;
    }
  }

  /**
   * 追加日志（唯一的落盘路径）。
   *
   * **刻意不在这里压实**：压实只在"一次写入操作的边界"做（见 `appendAttempt`/`appendAudit`），
   * 否则粒度太细（每次单条追加都可能压实），既浪费又会让"一条写入 = 一批日志"的语义变模糊。
   */
  private async appendLogLines(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;
    const file = this.path(GRAPH_LOG);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    this.logLines += records.length;
  }

  /** 写出压实快照（原子替换）。 */
  private async writeSnapshotFile(): Promise<void> {
    const payload: SnapshotPayload = {
      meta: [...this.meta.values()],
      nodes: [],
      progress: [],
      audit: this.audit.slice(-AUDIT_KEEP),
      conflicts: [...this.conflicts.values()],
      snapshots: [...this.snapshots.values()],
      checkpoints: [...this.checkpoints.values()],
    };
    for (const [projectId, map] of this.nodes) {
      for (const node of map.values()) {
        const { structure, progress } = toStorageRecords(projectId, node);
        payload.nodes.push(structure);
        payload.progress.push(progress);
      }
    }
    const target = this.path(SNAPSHOT_FILE);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(payload), 'utf8');
    await rename(temp, target);
  }

  /**
   * 压实：写 snapshot → 归档旧日志 → **截断日志**（FR-119/120）。
   *
   * 三者必须同时发生：只写 snapshot 不截断日志，下次打开会把同一批记录应用两次。
   */
  async compact(): Promise<{ compacted: boolean; reason: string; archived?: string }> {
    return this.enqueue(async () => {
      if (this.logLines < this.compactThreshold()) {
        return {
          compacted: false,
          reason: `日志 ${this.logLines} 行未达阈值 ${this.compactThreshold()}`,
        };
      }
      return this.compactLocked();
    });
  }

  private compactThreshold(): number {
    const nodeCount = [...this.nodes.values()].reduce((sum, map) => sum + map.size, 0);
    return Math.max(COMPACT_MIN_LINES, COMPACT_LINES_PER_NODE * Math.max(1, nodeCount));
  }

  /** 已在队列内时的压实（不再入队）。 */
  private async compactLocked(): Promise<{
    compacted: boolean;
    reason: string;
    archived?: string;
  }> {
    await this.writeSnapshotFile();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relative = `${ARCHIVE_DIR}/graph-${stamp}.jsonl`;
    try {
      await rename(this.path(GRAPH_LOG), this.path(relative));
    } catch {
      // 日志不存在 → 建空文件继续
      await writeFile(this.path(GRAPH_LOG), '', 'utf8');
    }
    this.logLines = 0;
    await this.pruneArchive();
    return { compacted: true, reason: `已压实并归档到 ${relative}`, archived: relative };
  }

  /** 达到阈值就地压实（在写路径上调用，已在队列内）。 */
  private async maybeCompact(): Promise<void> {
    if (this.logLines < this.compactThreshold()) return;
    await this.compactLocked();
  }

  /** 归档保留份数上限：超限删除最旧（FR-120）。 */
  private async pruneArchive(): Promise<void> {
    try {
      const dir = this.path(ARCHIVE_DIR);
      const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
      for (let i = 0; i < files.length - ARCHIVE_KEEP; i += 1) {
        const victim = files[i];
        if (victim !== undefined) await rm(join(dir, victim), { force: true });
      }
    } catch {
      // 归档目录不可读时忽略
    }
  }

  /** 存储占用统计（FR-122 的计量基础）。 */
  async usage(): Promise<{ bytes: number; files: number; detail: Record<string, number> }> {
    const detail: Record<string, number> = {};
    let bytes = 0;
    let files = 0;
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        try {
          const info = await stat(full);
          bytes += info.size;
          files += 1;
          const key = entry.name.replace(/\d+/g, '#');
          detail[key] = (detail[key] ?? 0) + info.size;
        } catch {
          // 读不到的忽略
        }
      }
    };
    await visit(this.root);
    return { bytes, files, detail };
  }

  // ── StoragePort 实现 ─────────────────────────────────────────

  async openProject(meta: ProjectMetaRecord): Promise<void> {
    await this.enqueue(async () => {
      this.meta.set(meta.projectId, meta);
      await this.appendLogLines([{ kind: 'meta', meta }]);
    });
  }

  async getMeta(projectId: string): Promise<ProjectMetaRecord | undefined> {
    this.assertOpen();
    return this.meta.get(projectId);
  }

  async putMeta(meta: ProjectMetaRecord): Promise<void> {
    await this.enqueue(async () => {
      this.meta.set(meta.projectId, meta);
      await this.appendLogLines([{ kind: 'meta', meta }]);
    });
  }

  async listProjects(): Promise<string[]> {
    this.assertOpen();
    return [...this.meta.keys()];
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.enqueue(async () => {
      this.meta.delete(projectId);
      this.nodes.delete(projectId);
      await this.appendLogLines([{ kind: 'project-deleted', projectId }]);
    });
  }

  async readGraph(projectId: string): Promise<GraphSnapshot | undefined> {
    this.assertOpen();
    const meta = this.meta.get(projectId);
    if (!meta) return undefined;
    const map = this.nodes.get(projectId) ?? new Map<string, NodeRecord>();
    const nodes: Record<string, NodeRecord> = {};
    for (const [id, node] of map) nodes[id] = node;
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
    this.assertOpen();
    return this.nodes.get(projectId)?.get(nodeId);
  }

  async putNode(projectId: string, node: NodeRecord): Promise<void> {
    await this.enqueue(async () => {
      this.nodeMap(projectId).set(node.id, node);
      this.emit({ kind: 'node-upserted', nodeId: node.id });
      await this.appendLogLines([{ kind: 'node', projectId, nodeId: node.id, node }]);
    });
  }

  async deleteNode(projectId: string, nodeId: string): Promise<void> {
    await this.enqueue(async () => {
      this.nodes.get(projectId)?.delete(nodeId);
      this.emit({ kind: 'node-deleted', nodeId });
      await this.appendLogLines([{ kind: 'node-deleted', projectId, nodeId }]);
    });
  }

  /**
   * 追加一条写入尝试：**按 before/after 差异只追加变化的节点**（块化写入）。
   *
   * 这正是本路线"追加而非覆盖"的落点：同一节点的不同块（state/progress/desc）各写一行，
   * 交错写入在物理上不可能互相破坏。
   */
  async appendAttempt(input: {
    projectId: string;
    attempt: WriteAttempt;
    before: GraphSnapshot | undefined;
    after: GraphSnapshot;
  }): Promise<void> {
    await this.enqueue(async () => {
      const map = this.nodeMap(input.projectId);
      const changed: string[] = [];
      for (const [id, node] of Object.entries(input.after.nodes)) {
        const previous = input.before?.nodes[id];
        if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(node)) {
          changed.push(id);
          map.set(id, node);
        }
      }
      for (const id of Object.keys(input.before?.nodes ?? {})) {
        if (input.after.nodes[id] === undefined) {
          changed.push(id);
          map.delete(id);
        }
      }

      const audit: AuditRecord = {
        attemptId: input.attempt.attemptId,
        projectId: input.projectId,
        nodeId: input.attempt.nodeId,
        block: input.attempt.block,
        op: input.attempt.op,
        by: input.attempt.by.label ?? input.attempt.by.by,
        rev: input.attempt.rev,
        ts: input.attempt.ts,
      };
      this.audit.push(audit);
      if (this.audit.length > AUDIT_KEEP) this.audit = this.audit.slice(-AUDIT_KEEP);

      const records: LogRecord[] = [];
      for (const id of changed) {
        const node = input.after.nodes[id];
        if (node) records.push({ kind: 'node', projectId: input.projectId, nodeId: id, node });
      }
      records.push({ kind: 'audit', audit });
      await this.appendLogLines(records);
      await this.maybeCompact();
      for (const id of changed) this.emit({ kind: 'node-upserted', nodeId: id });
    });
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.enqueue(async () => {
      this.audit.push(record);
      if (this.audit.length > AUDIT_KEEP) this.audit = this.audit.slice(-AUDIT_KEEP);
      await this.appendLogLines([{ kind: 'audit', audit: record }]);
      await this.maybeCompact();
    });
  }

  async listAudit(projectId: string, limit: number): Promise<AuditRecord[]> {
    this.assertOpen();
    return this.audit
      .filter((row) => row.projectId === projectId)
      .slice(-limit)
      .reverse();
  }

  async putConflict(record: ConflictRecord): Promise<void> {
    await this.enqueue(async () => {
      this.conflicts.set(record.conflictId, record);
      this.emit({ kind: 'conflict-changed', conflictId: record.conflictId });
      await this.appendLogLines([{ kind: 'conflict', conflict: record }]);
    });
  }

  async getConflict(conflictId: string): Promise<ConflictRecord | undefined> {
    this.assertOpen();
    return this.conflicts.get(conflictId);
  }

  async listConflicts(
    projectId: string,
    status?: ConflictRecord['status'],
  ): Promise<ConflictRecord[]> {
    this.assertOpen();
    return [...this.conflicts.values()]
      .filter((row) => row.projectId === projectId)
      .filter((row) => status === undefined || row.status === status);
  }

  async putSnapshot(record: SnapshotRecord): Promise<void> {
    await this.enqueue(async () => {
      this.snapshots.set(record.snapshotId, record);
      await this.appendLogLines([{ kind: 'snapshot-record', snapshot: record }]);
    });
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRecord | undefined> {
    this.assertOpen();
    return this.snapshots.get(snapshotId);
  }

  async listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
    this.assertOpen();
    return [...this.snapshots.values()]
      .filter((row) => row.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.enqueue(async () => {
      this.snapshots.delete(snapshotId);
      await this.appendLogLines([{ kind: 'snapshot-deleted', snapshotId }]);
    });
  }

  async putCheckpoint(record: CheckpointRecord): Promise<void> {
    await this.enqueue(async () => {
      this.checkpoints.set(record.checkpointId, record);
      await this.appendLogLines([{ kind: 'checkpoint', checkpoint: record }]);
    });
  }

  async getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined> {
    this.assertOpen();
    return this.checkpoints.get(checkpointId);
  }

  async listCheckpoints(projectId: string): Promise<CheckpointRecord[]> {
    this.assertOpen();
    return [...this.checkpoints.values()].filter((row) => row.projectId === projectId);
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await this.enqueue(async () => {
      this.checkpoints.delete(checkpointId);
      await this.appendLogLines([{ kind: 'checkpoint-deleted', checkpointId }]);
    });
  }

  onChange(listener: (change: StorageChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    // 等队列里已排的写完成
    await this.tail.catch(() => undefined);
    // 干净关闭时压实一次（写 snapshot **并截断日志**）。
    //
    // 注意：写 snapshot 必须同时截断日志 —— 否则下次打开会"先读 snapshot 再重放整份日志"，
    // 同一批记录被应用两次（实测：审计条数翻倍、日志行数对不上）。
    // 截断后的旧日志进 archive/，仍然可追。
    try {
      await this.enqueue(async () => {
        if (this.logLines > 0) await this.compactLocked();
      });
    } catch {
      // 写不出来不算失败（日志已经落盘，重放仍然正确）
    }
    this.listeners.clear();
    this.opened = false;
  }

  private emit(change: StorageChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // 观察者异常不影响写入
      }
    }
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error('FileStoragePort 尚未 open()');
  }

  /** 仅供测试与诊断：当前日志行数。 */
  get logLineCount(): number {
    return this.logLines;
  }
}

/** 创建并打开一个兜底路线端口。 */
export async function openFileStorage(
  options: FileStoragePortOptions,
): Promise<FileStoragePort> {
  const port = new FileStoragePort(options);
  await port.open();
  return port;
}


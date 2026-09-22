/**
 * 存储端口（FR-123）：领域层**只依赖本文件**，不依赖任何具体后端。
 *
 * 两条路线实现同一组契约测试：
 * - 主路线 `kv-port.ts` → `ctx.storageDomain`
 * - 兜底路线 `file-port.ts` → `.pm/` 下的 JSONL + 快照 + 压实（经 `ctx.fs`）
 *
 * 领域层禁止 import 具体后端（§12.4 不变量 6）。
 */

import type { GraphSnapshot, NodeRecord } from '../shared/types.ts';
import type {
  AuditRecord,
  CheckpointRecord,
  ConflictRecord,
  ProjectMetaRecord,
  SnapshotRecord,
} from './schema.ts';

/** 存储路线标识（设置页要明示当前路线，FR-124）。 */
export type StorageRoute = 'kv-domain' | 'file-fallback';

/** 能力差异（主/兜底不一致的地方必须显式列出，§7.1b）。 */
export interface StorageCapabilities {
  /** 单记录写入是否原子且 resolve 即持久。 */
  atomicSingleRecord: boolean;
  /** 是否有跨进程写锁。 */
  crossProcessLock: boolean;
  /** 是否需要压实（兜底路线需要）。 */
  needsCompaction: boolean;
  /** 是否支持按写入顺序的变更事件。 */
  changeEvents: boolean;
}

/** 变更事件（驱动客户端增量更新，§11.4）。 */
export type StorageChange =
  | { kind: 'node-upserted'; nodeId: string }
  | { kind: 'node-deleted'; nodeId: string }
  | { kind: 'meta-updated'; projectId: string }
  | { kind: 'conflict-changed'; conflictId: string };

/** 存储端口。所有写入都必须是**耐用**的：resolve 即已落盘。 */
export interface StoragePort {
  readonly route: StorageRoute;
  readonly capabilities: StorageCapabilities;

  /** 打开（或初始化）一个项目。 */
  openProject(meta: ProjectMetaRecord): Promise<void>;
  /** 读取项目 meta；不存在返回 undefined。 */
  getMeta(projectId: string): Promise<ProjectMetaRecord | undefined>;
  /** 写入项目 meta。 */
  putMeta(meta: ProjectMetaRecord): Promise<void>;
  /** 列出全部项目 id。 */
  listProjects(): Promise<string[]>;
  /** 删除项目（导入/导出与清理用）。 */
  deleteProject(projectId: string): Promise<void>;

  /** 读取整个节点图（领域层的输入形态）。 */
  readGraph(projectId: string): Promise<GraphSnapshot | undefined>;
  /** 写入单个节点（新增或整条替换）。 */
  putNode(projectId: string, node: NodeRecord): Promise<void>;
  /** 删除单个节点（**硬删除**，方案①）。 */
  deleteNode(projectId: string, nodeId: string): Promise<void>;
  /** 读取单个节点。 */
  getNode(projectId: string, nodeId: string): Promise<NodeRecord | undefined>;

  /** 追加审计记录。 */
  appendAudit(record: AuditRecord): Promise<void>;
  /** 读取最近 N 条审计（有界保留，FR-131）。 */
  listAudit(projectId: string, limit: number): Promise<AuditRecord[]>;

  /** 冲突记录。 */
  putConflict(record: ConflictRecord): Promise<void>;
  getConflict(conflictId: string): Promise<ConflictRecord | undefined>;
  listConflicts(projectId: string, status?: ConflictRecord['status']): Promise<ConflictRecord[]>;

  /** 快照索引。 */
  putSnapshot(record: SnapshotRecord): Promise<void>;
  getSnapshot(snapshotId: string): Promise<SnapshotRecord | undefined>;
  listSnapshots(projectId: string): Promise<SnapshotRecord[]>;
  deleteSnapshot(snapshotId: string): Promise<void>;

  /** 多记录操作 checkpoint（FR-125）。 */
  putCheckpoint(record: CheckpointRecord): Promise<void>;
  getCheckpoint(checkpointId: string): Promise<CheckpointRecord | undefined>;
  listCheckpoints(projectId: string): Promise<CheckpointRecord[]>;
  deleteCheckpoint(checkpointId: string): Promise<void>;

  /** 订阅变更（返回取消订阅函数）。 */
  onChange(listener: (change: StorageChange) => void): () => void;

  /** 关闭并释放资源。 */
  close(): Promise<void>;
}

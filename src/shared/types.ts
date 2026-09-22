/**
 * 领域层核心类型（§7.2 / §7.3 / §9.1）。
 *
 * 本文件**零宿主依赖**：不 import 任何 DSH 包、不触碰 node:fs / DOM，
 * 因此 Host 与 Client 两侧都能编译同一份定义（§12.4 不变量 6）。
 */

/** 节点自身状态（§9.1）。只有这 5 个能被写入。 */
export type SelfState = 'pending' | 'running' | 'done' | 'error' | 'removed';

/** 能被「推进类」写入写入的自身状态（不含 removed —— 删除是独立入口，§9.1）。 */
export type WritableSelfState = Exclude<SelfState, 'removed'>;

/**
 * 计算状态（对外状态）。`paused` / `held` **不是**自身状态，
 * 而是门控派生（§9.2）；`removed` 由自身或祖先的 tombstone 派生（规则 0）。
 */
export type DerivedState =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'paused'
  | 'held'
  | 'removed';

/** 节点种类：功能点 / 任务点。 */
export type NodeKind = 'feature' | 'task';

/** 门控标记（§9.2）。写在单个节点上，沿枝向下继承。 */
export type Gate = null | 'paused' | 'held';

/** 节点标记位（§7.2 flags）。 */
export type NodeFlag =
  | 'addedMidway'
  | 'risk'
  | 'blocked'
  | 'needsConfirm'
  | 'rolledBack';

/** 引用类型（§7.3）。`target` 一律为工作区相对路径。 */
export type Ref =
  | { type: 'note'; target: string }
  | { type: 'md'; target: string; label?: string }
  | { type: 'code'; target: string; symbol?: string; lines?: [number, number] }
  | { type: 'artifact'; target: string }
  | { type: 'dir'; target: string };

export type RefType = Ref['type'];

/** 订阅意图（§13.4 写入面）。 */
export type SubIntent = 'read' | 'write' | 'exclusive';

/** 订阅通知级别（§13.4 通知面）。 */
export type SubNotify = 'key' | 'full' | 'none';

/** 订阅方类型。 */
export type ActorKind = 'session' | 'subagent' | 'job' | 'user';

/** 一个订阅（§13.4）。一个节点可挂多个订阅。 */
export interface Subscription {
  subscriptionId: string;
  actor: ActorKind;
  actorId: string;
  intent: SubIntent;
  notify: SubNotify;
  touchedPaths: string[];
  claimedAt: string;
  expiresAt?: string;
}

/** 节点记录（§7.2 节点字段表）。 */
export interface NodeRecord {
  id: string;
  /** 节点简称。**同一父节点下必须唯一**（§7.2）。 */
  name: string;
  parentId: string | null;
  kind: NodeKind;
  selfState: SelfState;
  /** 自身完成度 0–1（叶节点有效）。 */
  progress: number;
  /** 预计工作量（分钟）。**内部提示量，不对 UI 展示为周期**（§9.4）。 */
  estimateMin?: number;
  /** 实际已耗时（累计）。仅审计用，不进 UI。 */
  actualMin?: number;
  /** 进度权重（AI 测量值或启发式对标值，同尺度）。 */
  weight?: number;
  weightSource?: 'ai' | 'heuristic';
  weightDetail?: Record<string, unknown>;
  autoCreated?: boolean;
  description?: string;
  refs?: Ref[];
  /** 生效中的关注标记（受归一化约束）。 */
  focus: boolean;
  /** 是否曾被显式标记关注；归一化清除 focus 时不动它（C11 / FR-19）。 */
  focusShadow?: boolean;
  flags?: NodeFlag[];
  lastRollbackAt?: string;
  gate: Gate;
  dependsOn?: string[];
  bindings?: Subscription[];
  /** CAS 版本号，每次写入 +1。 */
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

/** 节点 + 其计算状态（派生，永不持久化，§12.4 不变量 3）。 */
export interface DerivedNode extends NodeRecord {
  derivedState: DerivedState;
  childCount: number;
  /** 该枝（含自身）的叶节点总数，已按 tombstone 过滤。 */
  leafCount: number;
  /** 该枝未完成叶节点数，已按 tombstone 过滤。 */
  unfinishedLeafCount: number;
}

/** 写入来源（§10.4 审计）。 */
export interface WriteSource {
  by: ActorKind;
  /** `by` 为 session/subagent/job 时的具体 id；user 可省略。 */
  actorId?: string;
  /** 人类可读的来源说明，用于审计与 UI。 */
  label?: string;
}

/** 一次写入尝试的审计记录（§7.4 / FR-26）。 */
export interface WriteAttempt {
  attemptId: string;
  nodeId: string | null;
  /** 块隔离：不同块并发互不冲突（§7.4）。 */
  block: WriteBlock;
  op: Record<string, unknown>;
  by: WriteSource;
  rev: number;
  ts: string;
}

/** 写入块（§7.4 块隔离）。 */
export type WriteBlock =
  | 'state'
  | 'progress'
  | 'desc'
  | 'refs'
  | 'name'
  | 'structure'
  | 'gate'
  | 'focus'
  | 'delete'
  | 'rollback';

/** 事实源整体形态（§7.1 主路线拆两个域：结构域 + 进度域，此处为内存合并视图）。 */
export interface GraphSnapshot {
  /** 项目名（`project-manager.md` 的一级标题）。 */
  projectName: string;
  nodes: Record<string, NodeRecord>;
  /** 根节点 id 列表（通常只有一个）。 */
  rootIds: string[];
  /** 数据格式版本（§19.6）。 */
  dataFormat: number;
  /** 生成该快照的 DSH 基线版本。 */
  baselineDsh?: string;
  createdAt?: string;
}

/** 进度与计数统计口径（§9.3 / §4 FR-33）。 */
export interface ProgressStats {
  /** 按权重的完成度 0–1（无权重信息时退化为按件数）。 */
  ratio: number;
  /** 口径来源，用于看板标注（FR-34）。 */
  basis: 'weight' | 'count';
  /** 已完成叶节点数。 */
  doneLeaves: number;
  /** 未完成叶节点数。 */
  unfinishedLeaves: number;
  /** 叶节点总数（已按 tombstone 过滤）。 */
  totalLeaves: number;
  /** 进行中节点数（计算状态为 running 的节点，含枝）。 */
  runningNodes: number;
  /** 异常节点数（计算状态为 error 的节点）。 */
  errorNodes: number;
}

/** 权重归一化对标信息（§9.3a）。 */
export interface WeightScale {
  /** 对标系数：同一尺度下 AI 权重 / 启发式权重的均值比。 */
  k: number;
  /** 参与对标的样本数（关注枝内同时有两轨信息的节点数）。 */
  samples: number;
  /** k 是否可用；样本不足时为 false，此时 AI 权重原样使用并标注。 */
  calibrated: boolean;
}

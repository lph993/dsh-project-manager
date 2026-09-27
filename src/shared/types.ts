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
  /**
   * **稳定身份键**（FR-158）：由 `refs` 路径派生，**不由名称派生**。
   *
   * 为什么必须有：模型对同一个功能点会换说法（实测 `领域模型与进度计算` → `项目扫描与领域模型`），
   * 若按名字认节点，每跑一次建树就长出一批同义节点 ⇒ 节点只增不减、**完成度的分母被灌水**
   * （实测 140 → 213 叶，`3/140` 变成 `3/213`）。身份键让建树变成 upsert：同路径 = 同一节点。
   * 老数据没有这个字段：读取时视为"未登记身份"，不参与按身份复用（只按同父同名兜底）。
   */
  identity?: string;
  /**
   * **本轮建树没有再提到它**（FR-158）。
   *
   * 只是标记，不是删除：`stale` 节点**照常计入统计、照常参与进度**，等用户确认后才清理 ——
   * 绝不因为"模型这次没提"就静默丢掉人工推进过的节点。
   */
  stale?: boolean;
  /**
   * **描述最后一次被写入的时间**（ISO）。用来回答"这个描述还新鲜吗"。
   *
   * 用户口径："未完成的如果某些会话动了节点功能是需要刷新描述的"。
   * **不能拿 `updatedAt` 当判据** —— 那个值会被任何一次进度写入刷新，
   * "报了一次进度"就会被误判成"功能变了、描述过时了"，于是每次建树都重刷描述（白白烧 token）。
   */
  descriptionUpdatedAt?: string;
  /**
   * **完成简报里还留着"需要补充和处理"的事**（用户口径："完成后是简报…任务完成情况
   * (需要补充和处理的) 节点黄色警告背景加感叹号图标示警"）。
   *
   * 与 `flags`（`rolledBack` 那种历史标记）分开：这是一个**当下要不要盯**的信号，
   * 清了就没了，不该混进历史旗标里。
   */
  hasFollowUp?: boolean;
  /**
   * **最后一次改动这个节点的会话 id**（由写入路径自动记录，人手动改不覆盖它）。
   *
   * 用途：节点 →「跳到正在处理它的那个会话」；会话上下文吃紧时新建的会话也能顺着它接上。
   * 为什么不能只靠 `bindings`：那只在**订阅**时写，普通进度写入不留痕迹 ——
   * 而"谁在动这个节点"恰恰是普通写入才反映得出来的。
   */
  lastSessionId?: string;
  /**
   * **优先级**（1..10，**1 最高**；这是"先干哪个"，与 `weight`（工作量）、`focus`（关注）三个轴各管各的）。
   *
   * 由 **AI 建树时初判**（读仓库现状按重要性给级），之后可由人在右键菜单里改。
   * **绝不参与完成度计算** —— 完成度是"干到哪了"，优先级是"该不该先干"，混进去会让进度失真。
   */
  priority?: number;
  /**
   * 优先级的来源（`WeightSource` 的同构做法）：`ai` = 建树时模型估的；`user` = 人改过。
   *
   * 为什么要分：AI 估的可以随建树刷新，**人改过的不许被模型覆盖**（同 §9.3b 的进度优先级口径）。
   */
  prioritySource?: 'ai' | 'user';
  /**
   * **待审查**（FR-164）：右键打过「标记待审查」，还没审完。
   *
   * 语义：**审过的活才算数**。取"下一个该做的"时它**压过关注**（用户口径："审查优先级大于关注"）；
   * 审查通过后标记**自动消失**（不留"已审"装饰）；**可遗传** —— 父节点审查通过 ⇒ 整枝视为已审，
   * 所以清除标记时要**连同子节点一起清**（在 `clearReviewFlag` 里做级联）。
   */
  needsReview?: boolean;
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
  /**
   * 权重**没有结构区分度**（§9.3a 的诚实降级）：
   * 所有叶节点的启发式结构分完全相同 → 加权结果与按件数一致。
   *
   * 出现这个标记时看板必须标注「按件数·无结构数据」，不得继续声称工作量口径。
   */
  structuralDegenerate?: boolean;
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

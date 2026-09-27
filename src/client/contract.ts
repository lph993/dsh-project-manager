/**
 * 面板契约类型（Host ↔ Client 共享形态）。
 *
 * 这里**刻意手写一份**而不从 `src/service.ts` import：
 * - Client bundle 不能把宿主侧代码（zod / storage / node 依赖）拉进浏览器；
 * - 契约很小，重复一份的成本远低于引入跨面依赖的风险。
 * 两侧一致性由 `tests/contract/board-shape.test.ts` 断言。
 */

export type SelfState = 'pending' | 'running' | 'done' | 'error' | 'removed';
export type DerivedState = SelfState | 'paused' | 'held';

export interface ProgressStats {
  ratio: number;
  basis: 'weight' | 'count';
  doneLeaves: number;
  unfinishedLeaves: number;
  totalLeaves: number;
  runningNodes: number;
  errorNodes: number;
  /** 权重没有结构区分度（§9.3a）：看板必须标注「按件数·无结构数据」。 */
  structuralDegenerate?: boolean;
}

export interface NodeView {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'feature' | 'task';
  selfState: SelfState;
  derivedState: DerivedState;
  progress: number;
  weight: number;
  /** 权重来源（`heuristic` = 零 token 结构评分；`ai` = 模型测量）。 */
  weightSource?: 'ai' | 'heuristic';
  /** 权重依据（信号构成），供 UI 说明"为什么是这个权重"。 */
  weightDetail?: Record<string, unknown>;
  focus: boolean;
  gate: null | 'paused' | 'held';
  flags: string[];
  description?: string;
  refs?: Array<{ type: string; target: string; label?: string }>;
  autoCreated: boolean;
  childCount: number;
  leafCount: number;
  unfinishedLeafCount: number;
  blockedBy: string[];
  revision: number;
  updatedAt: string;
  updatedBy: string;
  addedMidway: boolean;
  /**
   * 「本轮建树没再提到它」（FR-158 ③）：看起来像自动生成的遗留节点，等用户确认后清理。
   *
   * **照常计入统计、照常参与进度**——它只是"疑似该走了"的标记，不是"不算数"。
   */
  stale?: boolean;
  /**
   * 优先级 1..10（**1 最高**）：只用来回答"**未完成的这些里先做哪个**"。
   *
   * 由 AI 建树时初判，人可在右键菜单里改；**不参与完成度计算**，已完成节点也不需要它。
   */
  priority?: number;
  /** 优先级来源：`ai` = 建树时模型估的；`user` = 人改过（模型不覆盖）。 */
  prioritySource?: 'ai' | 'user';
  /**
   * **待审查**（FR-164）：右键打过标记、还没审完。画布显示审查角标；
   * 取"下一个该做的"时它**压过关注**（用户口径："审查优先级大于关注"）；审完标记消失、父审通整枝。
   */
  needsReview?: boolean;
  /**
   * 完成简报里还留着"需要补充/处理"的事 ⇒ 节点**黄底 + 感叹号**示警
   * （用户口径："完成后是简报…任务完成情况(需要补充和处理的) 节点黄色警告背景加感叹号图标示警"）。
   */
  hasFollowUp?: boolean;
  /**
   * 最后一次改动这个节点的会话 id（人手动改不覆盖）。
   *
   * 用途：属性栏给出「跳转到该会话」——"这个节点是谁在动"从**记录**里读，
   * 不是靠 `bindings` 猜（后者只在订阅时写）。
   */
  lastSessionId?: string;
  subscriptionCount: number;
  /**
   * 该节点上订阅的**最高风险等级**（FR-110）：read < write < exclusive。
   *
   * 看板/属性栏据此提示"这里有人在并行写"——只给数量不给风险等级，用户没法判断要不要担心。
   */
  subscriptionRisk?: 'read' | 'write' | 'exclusive';
  /** 该节点上有几条订阅还在**等锁**（FR-110：冲突中的订阅要能看出来）。 */
  subscriptionWaiting?: number;
  branchPath: string[];
}

export interface ScanBandCell {
  nodeId: string;
  name: string;
  derivedState: DerivedState;
  isFocus: boolean;
}

export interface BoardSnapshot {
  projectId: string;
  projectName: string;
  nodes: NodeView[];
  overall: ProgressStats;
  focused: ProgressStats;
  focusedRootIds: string[];
  unfinished: NodeView[];
  conflicts: Array<{ conflictId: string; nodeId: string; code: string; message: string }>;
  scanBand: ScanBandCell[];
  degradation: string[];
  /**
   * FR-174：宿主侧的 error/warn 警示（状态条的警示角标读它）。
   *
   * 可选：老宿主 / 兜底数据源没有这个字段时，客户端**当没有告警**处理 —— 而不是画一个
   * "0 条错误"的绿标（那是**断言**宿主没出错，我们并没有这个依据）。
   */
  alerts?: {
    errors: number;
    warns: number;
    lastError?: { at: string; scope: string; message: string };
  };
  snapshot: { mode: 'git' | 'patch' | 'full'; reason: string };
  /**
   * 每个节点有几个可用回滚点（`nodeId → 数量`）。
   *
   * **为什么要放进看板**：FR 明确要求"无可用回滚点时不显示「回滚」"（而不是置灰）——
   * 菜单必须**同步**知道有没有点，不能先画出来再异步补救。
   */
  rollbackPoints?: Record<string, number>;
  confirmChannel: string;
  /**
   * 正在真干活的会话 id（宿主 `agent/status: running` 记账，见 `service.noteSessionActivity`）。
   *
   * 客户端拿它跟自己的会话 id 对一下，就知道"这个面板对应的会话是不是正在跑"——
   * 进行中的图标据此在**会话真的在跑**时转圈，而不是只靠节点 `updatedAt` 的 90s 窗口去猜。
   */
  busySessionIds?: string[];
  document: { path: string; exists: boolean; legal: boolean; violations: string[] };
  dataFormat: number;
  /** 最近一次外部改动（R4/R6）；无则为 null。 */
  externalChange: {
    kind: string;
    path: string;
    at: string;
    documentLegal?: boolean;
  } | null;
  /** 当前监听目标（诊断用）。 */
  watchTargets: string[];
  /**
   * **AI 发起、等待人工确认的整枝删除**（用户口径："由会话引起的节点删除需要审核，
   * 并在流程图上红色高亮标记，知道要删哪个"）。
   *
   * 允许缺席：旧宿主不返回该字段时按"没有待删除"处理（客户端必须能降级渲染）。
   */
  pendingRemovals?: Array<{
    nodeId: string;
    name: string;
    policy: 'record' | 'code' | 'comment';
    preview: string;
    origin: string;
    at: string;
  }>;
  /** 工作区根解析结果（诊断用）：面板空着的头号原因。 */
  workspaceRoot: { value: string | null; source: string; detail: string };
  /**
   * **正在跑的 AI 建树进度**（FR-167）：`null` = 没有在跑。
   *
   * 两个数必须分清口径：`outputChars` 是**事实**（数出来的字符），
   * `outputTokensEstimate` 是**粗估**（chars/3，界面要标"约"），`outputLimit` 是**确定值**。
   * 允许缺席：旧宿主不返回该字段时按"没有在跑"渲染。
   */
  aiRun?: {
    startedAt: string;
    scenario: 'tree';
    mode: 'single' | 'shard';
    shardIndex: number;
    shardTotal: number;
    outputChars: number;
    outputTokensEstimate: number;
    outputLimit: number;
    truncated: boolean;
    /** 阶段；**完成/失败后不清空**（进度条保留、可看这一轮的实际消耗）。旧宿主不带此字段。 */
    phase?: 'running' | 'done' | 'error';
    /** 本轮**实际消耗**（提供方回报；分批时逐片累加）。拿不到就是缺席。 */
    actual?: { inputTokens?: number; outputTokens?: number };
  } | null;
}


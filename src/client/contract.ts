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
  subscriptionCount: number;
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
  snapshot: { mode: 'git' | 'patch' | 'full'; reason: string };
  /**
   * 每个节点有几个可用回滚点（`nodeId → 数量`）。
   *
   * **为什么要放进看板**：FR 明确要求"无可用回滚点时不显示「回滚」"（而不是置灰）——
   * 菜单必须**同步**知道有没有点，不能先画出来再异步补救。
   */
  rollbackPoints?: Record<string, number>;
  confirmChannel: string;
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
  /** 工作区根解析结果（诊断用）：面板空着的头号原因。 */
  workspaceRoot: { value: string | null; source: string; detail: string };
}


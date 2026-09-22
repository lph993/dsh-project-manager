/**
 * 进度计算与权重（§9.3 / §9.3a）。
 *
 * 权重定义（先定死，否则公式不闭合）：
 * - 叶节点：`weight = aiWeight | heurWeight ∈ (0,10]`，`progress = clamp(0,1,p)`
 * - 父节点：`weight = Σ weight(子)`，`progress = Σ(子 progress × 子 weight) / Σ(子 weight)`
 * - 整体/关注枝：**扁平式**（只对叶节点求和），与递归式等价
 *
 * 本模块同时产出**每个节点**的 `derivedState` 与 `ProgressStats`，
 * 因为看板的顶部指标、每个枝内的计数、以及未完成任务列表都要用同一份口径。
 */

import type {
  DerivedState,
  Gate,
  GraphSnapshot,
  NodeRecord,
  ProgressStats,
  WeightScale,
} from '../shared/types.ts';
import { buildIndex, isLeaf, type GraphIndex } from './graph.ts';
import { deriveState, isUnfinished } from './state.ts';

/** 一个节点在无任何测量信息时的默认权重（等权）。 */
export const DEFAULT_WEIGHT = 1;

/** 权重取值区间下界（§9.3a：`clamp(k × h, 1, 10)`）。 */
export const WEIGHT_MIN = 1;

/** 权重取值区间上界。 */
export const WEIGHT_MAX = 10;

/** 单节点的派生结果。 */
export interface NodeDerived {
  node: NodeRecord;
  derivedState: DerivedState;
  /** 递归权重：叶节点为自身权重，父节点为 Σ 子权重。 */
  weight: number;
  /** 递归进度：加权平均后的完成度 0–1。 */
  progress: number;
  childCount: number;
  /** 该枝（含自身）剔除 tombstone 后的叶节点数。 */
  leafCount: number;
  /** 该枝未完成叶节点数。 */
  unfinishedLeafCount: number;
  /** 该枝已完成叶节点数。 */
  doneLeafCount: number;
}

/** 全树派生结果。 */
export interface DerivedGraph {
  index: GraphIndex;
  nodes: Map<string, NodeDerived>;
  roots: string[];
  /** 全树统计（口径见 §9.3）。 */
  overall: ProgressStats;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 取节点生效权重：显式 weight 优先，否则默认等权；并做区间收敛。 */
export function effectiveWeight(node: NodeRecord): number {
  const raw = typeof node.weight === 'number' && Number.isFinite(node.weight) ? node.weight : DEFAULT_WEIGHT;
  return clamp(raw, WEIGHT_MIN, WEIGHT_MAX);
}

/**
 * 计算权重对标系数 `k = mean{ aiW_i / h_i }`（§9.3a）。
 *
 * 逐节点等权取算术平均；样本不足（无任一 AI 测点）时 `calibrated = false`，
 * 此时**不做换算**，并应在看板标注权重口径（FR-34）。
 *
 * @param samples 关注枝内**同时**具备 AI 权重与启发式原始分的叶节点
 */
export function calibrateWeightScale(
  samples: ReadonlyArray<{ aiW: number; h: number }>,
): WeightScale {
  const usable = samples.filter(
    (s) => Number.isFinite(s.aiW) && Number.isFinite(s.h) && s.h > 0 && s.aiW > 0,
  );
  if (usable.length === 0) return { k: 1, samples: 0, calibrated: false };
  const k = usable.reduce((sum, s) => sum + s.aiW / s.h, 0) / usable.length;
  if (!Number.isFinite(k) || k <= 0) return { k: 1, samples: usable.length, calibrated: false };
  return { k, samples: usable.length, calibrated: true };
}

/** 把启发式结构分对标到 AI 尺度（§9.3a）。 */
export function toHeuristicWeight(h: number, scale: WeightScale): number {
  return clamp(scale.k * h, WEIGHT_MIN, WEIGHT_MAX);
}

/**
 * 遍历全树，产出每个节点的计算状态、递归权重/进度与计数。
 *
 * 采用显式栈的**后序遍历**：先算子孙，再算自身，因此规则 3–5 需要的
 * "子孙计算状态"总是已就绪。门控继承沿下行路径累积。
 */
export function deriveGraph(graph: GraphSnapshot): DerivedGraph {
  const index = buildIndex(graph);
  const out = new Map<string, NodeDerived>();

  interface Frame {
    id: string;
    /** 自身或任一祖先是否为 tombstone。 */
    ancestorRemoved: boolean;
    /** 自身或任一祖先的门控（累积，held 优先）。 */
    ancestorGate: Gate;
    childIndex: number;
  }

  const roots = index.roots.length > 0 ? index.roots : [];

  for (const rootId of roots) {
    const stack: Frame[] = [
      { id: rootId, ancestorRemoved: false, ancestorGate: null, childIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const node = index.byId.get(frame.id);
      if (!node) {
        stack.pop();
        continue;
      }
      const children = index.childrenOf.get(frame.id) ?? [];

      if (frame.childIndex < children.length) {
        const childId = children[frame.childIndex];
        frame.childIndex += 1;
        if (childId === undefined) continue;
        const child = index.byId.get(childId);
        if (!child) continue;
        const ancestorRemoved = frame.ancestorRemoved || node.selfState === 'removed';
        const ancestorGate: Gate = frame.ancestorGate === 'held'
          ? 'held'
          : node.gate === 'held'
            ? 'held'
            : frame.ancestorGate === 'paused' || node.gate === 'paused'
              ? 'paused'
              : null;
        stack.push({ id: childId, ancestorRemoved, ancestorGate, childIndex: 0 });
        continue;
      }

      // 子节点全部就绪 → 结算自身
      stack.pop();
      const childDerived: NodeDerived[] = [];
      for (const childId of children) {
        const d = out.get(childId);
        if (d) childDerived.push(d);
      }

      const ownRemoved = frame.ancestorRemoved || node.selfState === 'removed';
      const descendantStates = childDerived.map((d) => d.derivedState);
      // 注意：`ancestorRemoved` / `ancestorGate` 只含**严格祖先**，
      // 自身是否命中由 deriveState 用 selfState / gate 自行判定（§9.1 规则 0–2 的"自身或任一祖先"）。
      const derivedState = deriveState({
        selfState: node.selfState,
        gate: node.gate,
        ancestorRemoved: frame.ancestorRemoved,
        ancestorGate: frame.ancestorGate,
        descendantStates,
        hasChildren: children.length > 0,
      });

      let weight: number;
      let progress: number;
      let leafCount: number;
      let unfinishedLeafCount: number;
      let doneLeafCount: number;

      if (children.length === 0) {
        // 叶节点：自身即权重与进度
        weight = effectiveWeight(node);
        progress = ownRemoved ? 0 : clamp(node.progress, 0, 1);
        leafCount = ownRemoved ? 0 : 1;
        unfinishedLeafCount = ownRemoved ? 0 : derivedState === 'done' ? 0 : 1;
        doneLeafCount = ownRemoved ? 0 : derivedState === 'done' ? 1 : 0;
      } else {
        // 父节点：权重为子和；进度为加权平均；计数为子和
        weight = 0;
        let weightedProgress = 0;
        leafCount = 0;
        unfinishedLeafCount = 0;
        doneLeafCount = 0;
        for (const child of childDerived) {
          weight += child.weight;
          weightedProgress += child.progress * child.weight;
          leafCount += child.leafCount;
          unfinishedLeafCount += child.unfinishedLeafCount;
          doneLeafCount += child.doneLeafCount;
        }
        progress = weight > 0 ? weightedProgress / weight : 0;
        if (ownRemoved) {
          // 整枝被删除：不计入任何统计
          leafCount = 0;
          unfinishedLeafCount = 0;
          doneLeafCount = 0;
          progress = 0;
        } else if (derivedState === 'done') {
          // 规则 5 命中：枝内不存在未完成叶节点
          progress = 1;
          unfinishedLeafCount = 0;
          doneLeafCount = leafCount;
        }
      }

      out.set(frame.id, {
        node,
        derivedState,
        weight,
        progress,
        childCount: children.length,
        leafCount,
        unfinishedLeafCount,
        doneLeafCount,
      });
    }
  }

  const derived: DerivedGraph = {
    index,
    nodes: out,
    roots,
    overall: emptyStats(),
  };
  derived.overall = statsForRoots(derived, roots);
  return derived;
}

function emptyStats(): ProgressStats {
  return {
    ratio: 0,
    basis: 'count',
    doneLeaves: 0,
    unfinishedLeaves: 0,
    totalLeaves: 0,
    runningNodes: 0,
    errorNodes: 0,
  };
}

/**
 * 统计一组"作用根"的完成度（§9.3 扁平式）。
 *
 * 只对并集内的**叶节点**求和；调用方需保证作用根两两互不包含（关注集合的归一化不变量），
 * 否则会被 `dedupe` 去重（这里用 Set 兜底，不依赖调用方）。
 */
export function statsForRoots(
  derived: DerivedGraph,
  scopeRoots: readonly string[],
): ProgressStats {
  const seenLeaves = new Set<string>();
  let weightedSum = 0;
  let weightTotal = 0;
  let doneLeaves = 0;
  let unfinishedLeaves = 0;
  let sawWeight = false;

  for (const rootId of scopeRoots) {
    const rootDerived = derived.nodes.get(rootId);
    if (!rootDerived) continue;
    for (const leafId of collectLeaves(derived.index, rootId)) {
      if (seenLeaves.has(leafId)) continue;
      seenLeaves.add(leafId);
      const leaf = derived.nodes.get(leafId);
      if (!leaf) continue;
      if (leaf.derivedState === 'removed') continue;
      const weight = leaf.weight;
      if (weight !== DEFAULT_WEIGHT || leaf.node.weight !== undefined) sawWeight = true;
      weightedSum += leaf.progress * weight;
      weightTotal += weight;
      if (leaf.derivedState === 'done') doneLeaves += 1;
      else unfinishedLeaves += 1;
    }
  }

  let runningNodes = 0;
  let errorNodes = 0;
  for (const d of derived.nodes.values()) {
    if (d.derivedState === 'running') runningNodes += 1;
    else if (d.derivedState === 'error') errorNodes += 1;
  }

  const basis: ProgressStats['basis'] = sawWeight ? 'weight' : 'count';
  const ratio = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    ratio,
    basis,
    doneLeaves,
    unfinishedLeaves,
    totalLeaves: doneLeaves + unfinishedLeaves,
    runningNodes,
    errorNodes,
  };
}

/** 收集某枝内的叶节点 id（含自身，若自身即叶）。 */
export function collectLeaves(index: GraphIndex, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (isLeaf(index, current)) {
      out.push(current);
      continue;
    }
    for (const childId of index.childrenOf.get(current) ?? []) stack.push(childId);
  }
  return out;
}

/** 未完成叶节点列表（FR-35），按「是否关注 → 状态 → 名称」排序。 */
export function unfinishedLeaves(
  derived: DerivedGraph,
  scopeRoots?: readonly string[],
): NodeDerived[] {
  const scope = scopeRoots && scopeRoots.length > 0
    ? new Set(scopeRoots.flatMap((rootId) => collectLeaves(derived.index, rootId)))
    : null;
  const stateOrder: Record<DerivedState, number> = {
    error: 0,
    held: 1,
    paused: 2,
    running: 3,
    pending: 4,
    done: 5,
    removed: 6,
  };
  const out: NodeDerived[] = [];
  for (const d of derived.nodes.values()) {
    if (isLeaf(derived.index, d.node.id) === false) continue;
    if (d.derivedState === 'removed' || d.derivedState === 'done') continue;
    if (scope && !scope.has(d.node.id)) continue;
    out.push(d);
  }
  out.sort((a, b) => {
    const focusA = a.node.focus ? 0 : 1;
    const focusB = b.node.focus ? 0 : 1;
    if (focusA !== focusB) return focusA - focusB;
    const orderDiff = stateOrder[a.derivedState] - stateOrder[b.derivedState];
    if (orderDiff !== 0) return orderDiff;
    return a.node.name.localeCompare(b.node.name, 'zh-Hans-CN');
  });
  return out;
}

/** 计算状态是否为未完成（供 UI 直接调用，避免各处重复 import state 模块）。 */
export { isUnfinished };

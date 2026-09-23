/**
 * 节点树结构与关注归一化（§3.2 / §7.2 / FR-19 / C11）。
 *
 * 全部为纯函数：输入快照，输出新快照或派生结构，不修改入参（结构共享）。
 */

import type { GraphSnapshot, NodeRecord, Subscription } from '../shared/types.ts';

/** 索引结构：一次构建，多次查询（避免 O(n²) 的父/子查找）。 */
export interface GraphIndex {
  byId: Map<string, NodeRecord>;
  /** parentId → 子节点 id 列表（保持插入顺序）。 */
  childrenOf: Map<string, string[]>;
  roots: string[];
}

export function buildIndex(graph: GraphSnapshot): GraphIndex {
  const byId = new Map<string, NodeRecord>();
  const childrenOf = new Map<string, string[]>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    byId.set(id, node);
    if (!childrenOf.has(id)) childrenOf.set(id, []);
  }
  const roots: string[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = childrenOf.get(node.parentId);
      if (list) list.push(node.id);
      else childrenOf.set(node.parentId, [node.id]);
    } else {
      roots.push(node.id);
    }
  }
  return { byId, childrenOf, roots };
}

/** 自身或任一祖先是否命中谓词（自叶向上的继承判定，§9.1 规则 1/2）。 */
export function ancestorOrSelf(
  index: GraphIndex,
  nodeId: string,
  predicate: (node: NodeRecord) => boolean,
): boolean {
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return false; // 环保护：损坏数据不应导致死循环
    seen.add(current);
    const node = index.byId.get(current);
    if (!node) return false;
    if (predicate(node)) return true;
    current = node.parentId;
  }
  return false;
}

/** 以 nodeId 为根的枝（含自身）的全部节点 id，深度优先。 */
export function subtreeIds(index: GraphIndex, nodeId: string): string[] {
  const out: string[] = [];
  const stack = [nodeId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    const children = index.childrenOf.get(current) ?? [];
    for (const child of children) stack.push(child);
  }
  return out;
}

/** 叶节点判定：无子节点。 */
export function isLeaf(index: GraphIndex, nodeId: string): boolean {
  return (index.childrenOf.get(nodeId) ?? []).length === 0;
}

/** 全部叶节点 id（深度优先顺序）。 */
export function leafIds(index: GraphIndex): string[] {
  const out: string[] = [];
  for (const id of index.byId.keys()) {
    if (isLeaf(index, id)) out.push(id);
  }
  return out;
}

/** 节点的祖先 id 链（自父向上，不含自身）。 */
export function ancestorIds(index: GraphIndex, nodeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = index.byId.get(nodeId)?.parentId ?? null;
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    out.push(current);
    current = index.byId.get(current)?.parentId ?? null;
  }
  return out;
}

/** 同一父节点下的兄弟（不含自身）。 */
export function siblingIds(index: GraphIndex, nodeId: string): string[] {
  const parentId = index.byId.get(nodeId)?.parentId ?? null;
  const list = parentId ? (index.childrenOf.get(parentId) ?? []) : index.roots;
  return list.filter((id) => id !== nodeId);
}

/**
 * 同名兄弟检测（C12：同一父节点下名称必须唯一）。
 *
 * **墓碑不算"同名兄弟"**（§9.1 规则 0）：删除是 tombstone，记录留着是为了回滚/审计，
 * 但在语义上这个节点已经不存在了 —— 若把它算进唯一性，用户"删了再建同名节点"会被
 * 自己的删除记录挡住（实测踩过：整枝删除后重新扫描，21 个节点全部被 C12 判重跳过）。
 */
export function findSiblingByName(
  index: GraphIndex,
  parentId: string | null,
  name: string,
  exceptId?: string,
): NodeRecord | undefined {
  const list = parentId ? (index.childrenOf.get(parentId) ?? []) : index.roots;
  for (const id of list) {
    if (id === exceptId) continue;
    const node = index.byId.get(id);
    if (node && node.name === name && node.selfState !== 'removed') return node;
  }
  return undefined;
}

/** 祖先-后代关系判定（严格包含，自身不算）。 */
export function isAncestorOf(index: GraphIndex, ancestorId: string, nodeId: string): boolean {
  return ancestorIds(index, nodeId).includes(ancestorId);
}

/** 只把关注的叶节点取出来（用于统计）。 */
export function scopedLeafIds(index: GraphIndex, scopeRoots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const rootId of scopeRoots) {
    if (!index.byId.has(rootId)) continue;
    for (const id of subtreeIds(index, rootId)) {
      if (isLeaf(index, id)) out.add(id);
    }
  }
  return [...out];
}

/**
 * 关注归一化的目标状态（§3.2 / FR-19）。
 *
 * 规则：聚焦集合中**不存在**祖先-后代关系。聚焦 A 时自动清除其后代的 focus
 * 标记（但保留它们的 focusShadow，以便取消 A 时恢复）；取消 A 时，
 * 把"没有其他聚焦祖先"的 shadow 后代恢复为聚焦。
 *
 * @returns 需要被改写的节点（id → 新的 focus 值）；无需改写时为空。
 */
export function planFocusNormalization(
  index: GraphIndex,
  targetId: string,
  focus: boolean,
): Map<string, boolean> {
  const changes = new Map<string, boolean>();
  const target = index.byId.get(targetId);
  if (!target) return changes;

  if (focus) {
    // 聚焦：自身 focus=true；后代中原本聚焦的改为 false（shadow 保留）。
    if (!target.focus) changes.set(targetId, true);
    for (const id of subtreeIds(index, targetId)) {
      if (id === targetId) continue;
      const node = index.byId.get(id);
      if (node?.focus) changes.set(id, false);
    }
    return changes;
  }

  // 取消关注：自身 focus=false；随后按 shadow 恢复后代。
  if (target.focus) changes.set(targetId, false);
  const descendants = subtreeIds(index, targetId).filter((id) => id !== targetId);
  const restored = new Set<string>();
  // 自浅入深遍历：一旦某个祖先被恢复聚焦，其 shadow 后代保持不聚焦（已被祖先覆盖）。
  for (const id of descendants) {
    const node = index.byId.get(id);
    if (!node?.focusShadow) continue;
    const coveredByRestored = ancestorIds(index, id).some(
      (ancestor) => restored.has(ancestor) || (ancestor !== targetId && changes.get(ancestor) === true),
    );
    const coveredByOtherFocus = ancestorIds(index, id).some((ancestor) => {
      if (ancestor === targetId) return false; // 正在取消的祖先不再覆盖
      const ancestorNode = index.byId.get(ancestor);
      const nextValue = changes.get(ancestor);
      return nextValue === undefined ? Boolean(ancestorNode?.focus) : nextValue;
    });
    if (coveredByRestored || coveredByOtherFocus) continue;
    if (!node.focus) {
      changes.set(id, true);
      restored.add(id);
    }
  }
  return changes;
}

/** 当前生效的关注节点集合（保证两两互不包含）。 */
export function focusedRoots(index: GraphIndex): string[] {
  const out: string[] = [];
  for (const node of index.byId.values()) {
    if (node.focus) out.push(node.id);
  }
  return out;
}

/**
 * §12.4 不变量：关注集合中不存在祖先-后代关系。
 * 用于把归一化结果注册为可校验断言（`dsh-invariants`）。
 */
export function focusInvariantHolds(index: GraphIndex): boolean {
  const focused = focusedRoots(index);
  for (const a of focused) {
    for (const b of focused) {
      if (a !== b && isAncestorOf(index, a, b)) return false;
    }
  }
  return true;
}

/** 结构与字段级不变量：父指针有效、无环、同名兄弟不存在（供写入前后校验）。 */
export function structuralViolations(index: GraphIndex): string[] {
  const problems: string[] = [];
  for (const node of index.byId.values()) {
    if (node.parentId !== null && !index.byId.has(node.parentId)) {
      problems.push(`节点 ${node.id} 的 parentId=${node.parentId} 不存在`);
      continue;
    }
    if (node.parentId === node.id) problems.push(`节点 ${node.id} 以自身为父`);
    if (ancestorIds(index, node.id).includes(node.id)) {
      problems.push(`节点 ${node.id} 处于环上`);
    }
    if (findSiblingByName(index, node.parentId, node.name, node.id)) {
      problems.push(`同一父节点下存在同名节点「${node.name}」`);
    }
  }
  return problems;
}

/** 订阅计数（用于看板 FR-110 的订阅数展示）。 */
export function subscriptionCount(node: NodeRecord): number {
  return (node.bindings ?? []).length;
}

/** 取某节点上某 actor 的订阅。 */
export function findSubscription(
  node: NodeRecord,
  actor: string,
  actorId: string,
): Subscription | undefined {
  return (node.bindings ?? []).find((s) => s.actor === actor && s.actorId === actorId);
}

/**
 * 某节点所属的枝路径（自根到父，**不含自身**）。
 *
 * 放在 graph 层而不是投影层：交接文档（纯领域模块）也要用它，
 * 不该为了一个路径函数去依赖文档投影。
 */
export function branchPath(index: GraphIndex, nodeId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current = index.byId.get(nodeId)?.parentId ?? null;
  while (current) {
    if (seen.has(current)) break; // 环保护
    seen.add(current);
    const node = index.byId.get(current);
    if (!node) break;
    out.unshift(node.name);
    current = node.parentId;
  }
  return out;
}

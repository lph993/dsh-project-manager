/**
 * `project-manager.md` 单向投影与反解析（§7.1b / §8 / 不变量 1）。
 *
 * 方向只有一条：**事实源 → 文档**。文档永不被当作权威值回写。
 *
 * 投影规则：
 * - 父子关系 → **实线** `A --> B`（同一父下多个子各占一行）
 * - 跨枝依赖（`dependsOn`）→ **虚线** `A -.-> B`
 * - 节点名含 `::` 的并列组按整组名投影，不拆分（拆分信息只存在于事实源）
 */

import type { GraphSnapshot, NodeRecord } from '../shared/types.ts';
import { buildIndex, isAncestorOf, subtreeIds } from './graph.ts';
import { escapeNodeName } from './docFormat.ts';

/** 默认最大输出行数；超出时**拒绝**而不是静默截断（FR-126 的诚实报告原则）。 */
export const DEFAULT_MAX_LINES = 3000;

export interface ProjectOptions {
  /** 根节点 id 顺序覆盖（默认用快照 rootIds）。 */
  rootIds?: readonly string[];
  /** 是否投影无父的孤立节点（默认投影）。 */
  maxLines?: number;
}

export interface ProjectionResult {
  markdown: string;
  /** 是否因超过 `maxLines` 被拒绝。 */
  overflow: boolean;
  /** 实际输出行数。 */
  lines: number;
  /** 被跳过的依赖线数量（仅当出现重复边时）。 */
  skippedEdges: number;
}

/**
 * 把事实源投影为合法文档（§8.1 唯一形态）。
 *
 * 纯函数：相同快照恒产出相同文本（便于哈希比对与测试）。
 */
export function projectDocument(
  graph: GraphSnapshot,
  options: ProjectOptions = {},
): ProjectionResult {
  const index = buildIndex(graph);
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const roots = options.rootIds && options.rootIds.length > 0 ? options.rootIds : index.roots;

  const lines: string[] = [`# ${escapeNodeName(graph.projectName)}`, '', '```mermaid', 'flowchart TD'];

  // 1) 父子实线：父 → 子（保持子节点的插入顺序）
  for (const parentId of orderedNodeIds(index, roots)) {
    const children = index.childrenOf.get(parentId) ?? [];
    for (const childId of children) {
      const parent = index.byId.get(parentId);
      const child = index.byId.get(childId);
      if (!parent || !child) continue;
      if (parent.selfState === 'removed' || child.selfState === 'removed') continue;
      lines.push(indent(1) + `${escapeNodeName(parent.name)} --> ${escapeNodeName(child.name)}`);
    }
  }

  // 2) 跨枝依赖虚线：去重且跳过与父子边重复的
  const parentEdges = new Set<string>();
  for (const parentId of index.byId.keys()) {
    for (const childId of index.childrenOf.get(parentId) ?? []) {
      parentEdges.add(`${parentId}->${childId}`);
    }
  }
  const emittedDeps = new Set<string>();
  let skippedEdges = 0;
  for (const nodeId of orderedNodeIds(index, roots)) {
    const node = index.byId.get(nodeId);
    if (!node || node.selfState === 'removed') continue;
    for (const depId of node.dependsOn ?? []) {
      const dep = index.byId.get(depId);
      if (!dep || dep.selfState === 'removed') continue;
      const key = `${nodeId}->${depId}`;
      const reverseKey = `${depId}->${nodeId}`;
      if (parentEdges.has(key) || parentEdges.has(reverseKey)) {
        skippedEdges += 1;
        continue;
      }
      if (emittedDeps.has(key) || emittedDeps.has(reverseKey)) {
        skippedEdges += 1;
        continue;
      }
      emittedDeps.add(key);
      lines.push(indent(1) + `${escapeNodeName(node.name)} -.-> ${escapeNodeName(dep.name)}`);
    }
  }

  // 3) 孤立节点（无父无子，未出现在任何连线里）：显式声明，避免反解析时丢失
  const connected = new Set<string>();
  for (const key of parentEdges) {
    const [a, b] = key.split('->');
    if (a) connected.add(a);
    if (b) connected.add(b);
  }
  for (const nodeId of orderedNodeIds(index, roots)) {
    const node = index.byId.get(nodeId);
    if (!node || node.selfState === 'removed') continue;
    if (!connected.has(nodeId)) lines.push(indent(1) + escapeNodeName(node.name));
  }

  lines.push('```');
  lines.push('');

  const overflow = lines.length > maxLines;
  return {
    markdown: lines.join('\n'),
    overflow,
    lines: lines.length,
    skippedEdges,
  };
}

/** 深度优先的节点 id 顺序（父在子之前，保证输出稳定）。 */
function orderedNodeIds(
  index: ReturnType<typeof buildIndex>,
  roots: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rootId of roots) {
    const stack = [rootId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      const children = index.childrenOf.get(current) ?? [];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  // 未被 root 覆盖到的（数据异常）也一并输出，避免投影丢节点
  for (const id of index.byId.keys()) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

function indent(level: number): string {
  return '  '.repeat(level);
}

/**
 * 文档形态的事实源结构指纹：用于「结构未变则不重写文件」的短路判断。
 * 只包含影响投影结果的字段，避免状态变化触发文档重写。
 */
export function projectionFingerprint(graph: GraphSnapshot): string {
  const index = buildIndex(graph);
  const parts: string[] = [graph.projectName];
  for (const node of index.byId.values()) {
    const deps = [...(node.dependsOn ?? [])].sort().join(',');
    parts.push(`${node.id}|${node.name}|${node.parentId ?? ''}|${node.selfState}|${deps}`);
  }
  parts.sort();
  return parts.join('\n');
}

/**
 * 反解析：把文档里的**父子关系**还原为一组 `parentName → childName`。
 *
 * 仅用于「外部手改后的规范化」（FR-05）与排歧，**不**作为权威值来源。
 * 虚线边视为依赖而非父子（与投影对偶）。
 */
export function parseParentChildPairs(
  edges: ReadonlyArray<{ from: string; to: string; dashed: boolean }>,
): Array<{ parent: string; child: string }> {
  const pairs: Array<{ parent: string; child: string }> = [];
  for (const edge of edges) {
    if (edge.dashed) continue;
    pairs.push({ parent: edge.from, child: edge.to });
  }
  return pairs;
}

/**
 * 反解析出的父子关系中，若某节点有多于一个父，则标注为歧义（供规范化提示）。
 */
export function findMultiParentNames(
  pairs: ReadonlyArray<{ parent: string; child: string }>,
): string[] {
  const parentsOf = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const set = parentsOf.get(pair.child) ?? new Set<string>();
    set.add(pair.parent);
    parentsOf.set(pair.child, set);
  }
  const ambiguous: string[] = [];
  for (const [child, parents] of parentsOf) {
    if (parents.size > 1) ambiguous.push(child);
  }
  return ambiguous;
}

/** 判断某节点是否落在任一关注枝内（§3.2 主枝并集判定）。 */
export function isInFocusScope(
  index: ReturnType<typeof buildIndex>,
  focusedIds: readonly string[],
  nodeId: string,
): boolean {
  for (const focusId of focusedIds) {
    if (focusId === nodeId) return true;
    if (isAncestorOf(index, focusId, nodeId)) return true;
  }
  return false;
}

/**
 * 某节点所属的枝路径。
 *
 * 实现已归位到 `graph.ts`（交接文档等纯领域模块也要用，不该依赖投影层）；
 * 这里保留 re-export 以免调用方到处改 import。
 */
export { branchPath } from './graph.ts';

/** 收集一个枝内的全部节点记录（用于整枝回滚与门控）。 */
export function branchNodes(
  index: ReturnType<typeof buildIndex>,
  rootId: string,
): NodeRecord[] {
  return subtreeIds(index, rootId)
    .map((id) => index.byId.get(id))
    .filter((node): node is NodeRecord => node !== undefined);
}

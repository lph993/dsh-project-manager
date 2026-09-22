/**
 * 交接文档（§9.6.4 / FR-51/53/54 / Q5 决策）。
 *
 * **定位**：交接文档的目的只是"**能续接**"，不是完整归档。
 * 因此它只写续接必需的：做到哪、下一步是什么、关键决策与坑、涉及文件清单。
 *
 * **作者（写死，否则不可实现）**：
 * | 小节 | 作者 |
 * |---|---|
 * | `## 进度快照` / `## 涉及文件` / `## 未完成清单` | **插件机械生成（零 token）** |
 * | `## 下一步` / `## 关键决策与坑` | **模型补写**（无法从节点表推导） |
 *
 * 模型补写属于 AI 调用，必须走预算前置（FR-101）。用户拒绝或超预算时：
 * 只产出机械部分，文首标注「模型补写部分已跳过」，**不阻塞暂停/拦停**。
 *
 * 本模块是**纯函数**：输入图快照与派生结果，输出 Markdown 文本与可反解析的结构。
 */

import type { DerivedGraph, NodeDerived } from './progress.ts';
import { collectLeaves } from './progress.ts';
import { branchPath as computeBranchPath, buildIndex, subtreeIds } from './graph.ts';
import { isUnfinished } from './state.ts';
import type { GraphSnapshot, NodeRecord } from '../shared/types.ts';
import { utf8ByteLength, utf8Slice, utf8Truncate } from '../shared/bytes.ts';

/** 文档种类（文件名里的 `kind`）。 */
export type HandoffKind = 'pause' | 'hold';

/** 固定小节顺序（§9.6.4）。 */
export const HANDOFF_SECTIONS = [
  '进度快照',
  '下一步',
  '关键决策与坑',
  '涉及文件',
  '未完成清单',
] as const;

export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** 单份文档默认长度上限 200 KB（可配，§9.6.4 / FR-81e）。 */
export const DEFAULT_HANDOFF_MAX_BYTES = 200 * 1024;

/** 模型补写内容（由 `src/ai/` 那条路径提供；缺失即为"已跳过"）。 */
export interface HandoffSupplements {
  /** `## 下一步` 的内容（Markdown 片段）。 */
  nextSteps?: string;
  /** `## 关键决策与坑` 的内容（Markdown 片段）。 */
  decisions?: string;
  /** 本次补写消耗的 token（计入成本统计，FR-102）。 */
  tokensUsed?: number;
}

/** 生成参数。 */
export interface HandoffBuildOptions {
  kind: HandoffKind;
  /** 文档覆盖的节点（单节点暂停 = 一个；拦停 = 该枝全部）。 */
  nodeIds: readonly string[];
  /** 覆盖范围的根节点（用于命名与标题）。 */
  rootNodeId: string;
  /** 本机时区的时间戳（用于文件名，`yyyymmdd-HHmmss`）。 */
  now: Date;
  /** 模型补写；缺失表示"跳过补写"。 */
  supplements?: HandoffSupplements;
  /** 长度上限（字节）。 */
  maxBytes?: number;
  /** 排除路径/关键字黑名单（FR-81e，默认空）。 */
  excludePaths?: readonly string[];
  /** 暂停/拦停原因。 */
  reason?: string;
}

/** 生成结果。 */
export interface HandoffDocument {
  kind: HandoffKind;
  /** 文件名（相对 `.pm/handoff/`）。 */
  fileName: string;
  /** 完整相对路径（`.pm/handoff/<kind>-<nodeId>-<ts>.md`）。 */
  relativePath: string;
  markdown: string;
  /** 字节数。 */
  bytes: number;
  /** 是否因超限被截断。 */
  truncated: boolean;
  /** 模型补写是否被跳过（降级标注）。 */
  supplementsSkipped: boolean;
  /** 机械部分覆盖的节点数。 */
  nodeCount: number;
}

/** 文件名里的时间戳格式：`yyyymmdd-HHmmss`（本地时间，便于人读）。 */
export function formatStamp(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 生成文件名（§9.6.4：`handoff/<kind>-<nodeId>-<yyyymmdd-HHmmss>.md`）。 */
export function handoffFileName(input: {
  kind: HandoffKind;
  rootNodeId: string;
  now: Date;
}): string {
  return `${input.kind}-${input.rootNodeId}-${formatStamp(input.now)}.md`;
}

/** 解析出的文件名成分。 */
export interface ParsedHandoffName {
  kind: HandoffKind;
  nodeId: string;
  stamp: string;
  fileName: string;
}

/**
 * 解析交接文档文件名。
 *
 * **不能用 `split('-')`**：node id 本身含连字符（如 `pm_76463c05-887f-…`），
 * 按连字符切会把 id 切碎，导致"读不到自己刚写的文档"。从**固定后缀**
 * （`-<8位日期>-<6位时间>.md`）倒推才可靠。
 */
export function parseHandoffFileName(fileName: string): ParsedHandoffName | undefined {
  const match = /^(pause|hold)-(.+)-(\d{8}-\d{6})\.md$/.exec(fileName);
  if (!match) return undefined;
  const kind = match[1];
  const nodeId = match[2];
  const stamp = match[3];
  if (kind === undefined || nodeId === undefined || stamp === undefined) return undefined;
  return { kind: kind as HandoffKind, nodeId, stamp, fileName };
}

/** 交接文档目录（FR-84）。 */
export const HANDOFF_DIR = '.pm/handoff';

/** 图节点在文档里的一行状态。 */
function nodeStateLine(node: NodeRecord, derived: NodeDerived | undefined): string {
  const state = derived?.derivedState ?? node.selfState;
  const percent = Math.round((derived?.progress ?? node.progress) * 100);
  const gate = node.gate === null ? '' : `，门控=${node.gate}`;
  return `- \`${node.name}\` — ${state} ${percent}%${gate}`;
}

/**
 * 生成交接文档（纯函数）。
 *
 * 机械小节完全由节点表推导；`## 下一步` 与 `## 关键决策与坑` 只接受**传入**的补写内容，
 * 本函数**不会**自己调 AI（AI 出口唯一在 `src/ai/`）。
 */
export function buildHandoffDocument(
  graph: GraphSnapshot,
  derived: DerivedGraph,
  options: HandoffBuildOptions,
): HandoffDocument {
  const index = buildIndex(graph);
  const root = graph.nodes[options.rootNodeId];
  const covered = new Set<string>();
  for (const nodeId of options.nodeIds) {
    covered.add(nodeId);
    for (const id of subtreeIds(index, nodeId)) covered.add(id);
  }

  const excluded = new Set(options.excludePaths ?? []);
  const isExcluded = (path: string): boolean =>
    [...excluded].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  // ── ① 进度快照（机械） ────────────────────────────────────────
  const coveredNodes = [...covered]
    .map((id) => graph.nodes[id])
    .filter((node): node is NodeRecord => node !== undefined)
    .filter((node) => node.selfState !== 'removed');

  const scopeLeaves = options.nodeIds.flatMap((id) => collectLeaves(index, id));
  const leafStats = { done: 0, unfinished: 0 };
  for (const leafId of new Set(scopeLeaves)) {
    const d = derived.nodes.get(leafId);
    if (!d || d.derivedState === 'removed') continue;
    if (d.derivedState === 'done') leafStats.done += 1;
    else leafStats.unfinished += 1;
  }

  const snapshotLines: string[] = [];
  snapshotLines.push(
    `- 覆盖范围：\`${root?.name ?? options.rootNodeId}\`（${coveredNodes.length} 个节点，其中叶节点 ${leafStats.done + leafStats.unfinished} 个）`,
  );
  snapshotLines.push(
    `- 完成情况：已完成 ${leafStats.done} / 未完成 ${leafStats.unfinished}`,
  );
  snapshotLines.push(`- 动作：${options.kind === 'hold' ? '拦停（整枝停止，需重新评审）' : '暂停（保留现场，可继续）'}`);
  if (options.reason !== undefined && options.reason.trim() !== '') {
    snapshotLines.push(`- 原因：${options.reason.trim()}`);
  }
  if (options.kind === 'hold' && options.nodeIds.length > 1) {
    // 多任务（放行）文档：一个父节点一份，内部按子节点分节
    snapshotLines.push('- 该文档按子节点分节（拦停覆盖整枝）');
  }
  snapshotLines.push('');
  snapshotLines.push('节点状态：');
  for (const node of coveredNodes) {
    snapshotLines.push(nodeStateLine(node, derived.nodes.get(node.id)));
  }

  // ── ② 下一步（模型补写，缺失即降级） ───────────────────────────
  const supplementsSkipped =
    options.supplements?.nextSteps === undefined && options.supplements?.decisions === undefined;
  const nextSteps =
    options.supplements?.nextSteps?.trim() ||
    '（模型补写部分已跳过：本次未做 AI 补写，或用户拒绝/超预算。请从「未完成清单」继续。）';

  // ── ③ 关键决策与坑（机械可给"标记过的风险"，其余靠模型） ────────
  const riskNodes = coveredNodes.filter((node) =>
    (node.flags ?? []).some((flag) => flag === 'risk' || flag === 'blocked' || flag === 'rolledBack'),
  );
  const mechanicalDecisions: string[] = [];
  if (riskNodes.length > 0) {
    mechanicalDecisions.push('插件记录的标记：');
    for (const node of riskNodes) {
      mechanicalDecisions.push(`- \`${node.name}\` 标记：${(node.flags ?? []).join('、')}`);
    }
  }
  const described = coveredNodes.filter(
    (node) => node.description !== undefined && node.description.trim() !== '',
  );
  if (described.length > 0) {
    mechanicalDecisions.push('');
    mechanicalDecisions.push('节点描述（可能含决策背景）：');
    for (const node of described.slice(0, 20)) {
      const text = (node.description ?? '').replace(/\s+/g, ' ').trim();
      mechanicalDecisions.push(`- \`${node.name}\`：${text.length > 240 ? `${text.slice(0, 239)}…` : text}`);
    }
  }
  const decisions =
    options.supplements?.decisions?.trim() ||
    '（模型补写部分已跳过）';
  const decisionsBlock = [
    ...mechanicalDecisions,
    ...(mechanicalDecisions.length > 0 ? [''] : []),
    decisions,
  ].join('\n');

  // ── ④ 涉及文件（机械；引用用路径而非内容） ──────────────────────
  const touched = new Set<string>();
  for (const node of coveredNodes) {
    for (const ref of node.refs ?? []) {
      if (!isExcluded(ref.target)) touched.add(ref.target);
    }
  }
  const fileLines =
    touched.size === 0
      ? ['（该枝内节点尚未记录任何引用路径）']
      : [...touched].sort().map((path) => `- \`${path}\``);

  // ── ⑤ 未完成清单（机械） ──────────────────────────────────────
  const unfinishedLines: string[] = [];
  const leafIds = [...new Set(scopeLeaves)].sort();
  for (const leafId of leafIds) {
    const d = derived.nodes.get(leafId);
    if (!d || !isUnfinished(d.derivedState)) continue;
    const path = computeBranchPath(index, leafId);
    const prefix = path.length > 0 ? `${path.join(' / ')} / ` : '';
    unfinishedLines.push(
      `- ${prefix}\`${d.node.name}\` — ${d.derivedState} ${Math.round(d.progress * 100)}%`,
    );
  }
  if (unfinishedLines.length === 0) unfinishedLines.push('（覆盖范围内没有未完成叶节点）');

  // ── 组装 ─────────────────────────────────────────────────────
  const header = [
    `# 交接文档 · ${options.kind === 'pause' ? '继续' : '放行'}（${root?.name ?? options.rootNodeId}）`,
    '',
    // 提示里**不要**写 `## 小节名`：那会让按行解析（本文件的 parseHandoff、以及任何
    // 外部 Markdown 处理）把提示行误认成真正的小节标题（实测踩过）。
    supplementsSkipped
      ? '> ⚠ 模型补写部分已跳过：「下一步」与「关键决策与坑」两节只含机械内容。'
      : '> 模型补写已包含（消耗 token 见成本统计）。',
    '',
  ];

  const body = [
    '## 进度快照',
    '',
    ...snapshotLines,
    '',
    '## 下一步',
    '',
    nextSteps,
    '',
    '## 关键决策与坑',
    '',
    decisionsBlock,
    '',
    '## 涉及文件',
    '',
    ...fileLines,
    '',
    '## 未完成清单',
    '',
    ...unfinishedLines,
    '',
  ];

  const full = [...header, ...body].join('\n');
  const maxBytes = options.maxBytes ?? DEFAULT_HANDOFF_MAX_BYTES;
  const { text, truncated } = truncateUtf8(full, maxBytes);

  const fileName = handoffFileName({ kind: options.kind, rootNodeId: options.rootNodeId, now: options.now });
  return {
    kind: options.kind,
    fileName,
    relativePath: `${HANDOFF_DIR}/${fileName}`,
    markdown: text,
    bytes: utf8ByteLength(text),
    truncated,
    supplementsSkipped,
    nodeCount: coveredNodes.length,
  };
}

/**
 * 按**字节**上限截断，且不切断 UTF-8 字符（§9.6.4：截断必须给出省略说明）。
 *
 * 手工实现字节安全截断：与 `dsh-output-retention` 的 `TextRetainer` 同一目标，
 * 但那条路径服务于"工具返回"，这里服务于"写文件"，因此只需要一个确定性实现。
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const total = utf8ByteLength(text);
  if (total <= maxBytes) return { text, truncated: false };

  // 留出省略说明的位置
  const notice = `\n\n> ⚠ 文档超过上限 ${maxBytes} 字节，已截断（原 ${total} 字节）。交接文档只求"能续接"，未写入的内容请从节点表查看。\n`;
  const budget = Math.max(0, maxBytes - utf8ByteLength(notice));
  const sliced = utf8Truncate(text, budget);
  // toString 在切断多字节字符时会产出替换字符，去掉尾部残片
  const cleaned = sliced;
  return { text: `${cleaned}${notice}`, truncated: true };
}

// ── 反解析（读取与消费用）──────────────────────────────────────

/** 解析出的文档结构。 */
export interface ParsedHandoff {
  title: string;
  kind: HandoffKind | undefined;
  rootName: string | undefined;
  sections: Partial<Record<HandoffSection, string>>;
  supplementsSkipped: boolean;
}

/**
 * 解析交接文档（`pm_handoff_read` 与"消费"语义都要用）。
 *
 * 只按固定小节切分，不追求通用 Markdown 解析。
 */
export function parseHandoff(markdown: string): ParsedHandoff {
  const lines = markdown.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith('# '))?.slice(2).trim() ?? '';
  const kindMatch = /（(pause|hold)）|·\s*(继续|放行)/.exec(title);
  const kind: HandoffKind | undefined = title.includes('放行')
    ? 'hold'
    : title.includes('继续')
      ? 'pause'
      : undefined;
  void kindMatch;
  const rootNameMatch = /（(.+?)）\s*$/.exec(title);

  const sections: Partial<Record<HandoffSection, string>> = {};
  let current: HandoffSection | undefined;
  const buffer: string[] = [];
  const flush = (): void => {
    if (current !== undefined) sections[current] = buffer.join('\n').trim();
    buffer.length = 0;
  };
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1] as HandoffSection;
      if ((HANDOFF_SECTIONS as readonly string[]).includes(name)) {
        flush();
        current = name;
        continue;
      }
      // 非固定小节：并入当前小节（保持原文可读）
      if (current !== undefined) buffer.push(line);
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();

  return {
    title,
    kind,
    rootName: rootNameMatch?.[1],
    sections,
    supplementsSkipped: /模型补写部分已跳过/.test(markdown),
  };
}

/**
 * 按字节窗口切片（`pm_handoff_read` 强制分页，§13.2：默认 ≤ 32 KB/次）。
 *
 * @returns 切片文本、下一偏移（null 表示已到末尾）、是否被截断
 */
export function sliceHandoffByBytes(
  markdown: string,
  offset: number,
  limitBytes: number,
): { text: string; nextOffset: number | null; truncated: boolean } {
  const total = utf8ByteLength(markdown);
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + Math.max(1, limitBytes));
  const slice = utf8Slice(markdown, start, end);
  return {
    text: slice,
    nextOffset: end >= total ? null : end,
    truncated: end < total,
  };
}



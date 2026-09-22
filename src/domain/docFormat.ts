/**
 * 文档形态定义（§8.1 / §8.2 / §8.3）。
 *
 * 合法形态**唯一**：一个一级标题 + 一个 ```mermaid 代码块，块外零非空文本行。
 */

/** 一级标题行的正则（允许前后空白，不允许前导 `#` 数量不为 1）。 */
export const H1_PATTERN = /^#\s+(.+?)\s*$/;

/** mermaid 代码块起始围栏。 */
export const MERMAID_FENCE = '```mermaid';

/** `flowchart` / `graph` 声明行。 */
export const MERMAID_DECL_PATTERN = /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\s*$/;

/** 实线连线：`A --> B`（允许带节点文本）。 */
export const EDGE_SOLID_PATTERN = /^(.+?)\s*-->\s*(.+)$/;

/** 虚线连线：`A -.-> B`（旁枝），也接受 `A -. label .-> B`。 */
export const EDGE_DASHED_PATTERN = /^(.+?)\s*-\.(?:\s*([^.]*?)\s*\.)?->\s*(.+)$/;

/** 并列同级分隔符（FR-13）：`我的朋友 :: 群组`。 */
export const SIBLING_SEPARATOR = '::';

/** 被禁止的 mermaid 指令（§8.3）：状态由事实源驱动，不允许手写样式与点击。 */
export const FORBIDDEN_DIRECTIVES: readonly string[] = [
  'classDef',
  'class ',
  'style ',
  'linkStyle',
  'click ',
  'subgraph',
  'end',
  '%%',
];

/** 文档解析出的节点：一条连线的一个端点。 */
export interface DocNodeRef {
  /** 展示名（去空白、已展开 `::` 并列）。 */
  name: string;
  /** 是否为虚线（旁枝）端点。 */
  sideBranch: boolean;
}

/** 一条连线。 */
export interface DocEdge {
  from: string;
  to: string;
  dashed: boolean;
}

/** 文档解析结果。 */
export interface ParsedDoc {
  projectName: string;
  /** 图中出现的节点名（去重后，保持首次出现顺序）。 */
  nodeNames: string[];
  edges: DocEdge[];
  /** 方向声明（TD/LR/...），仅作展示元信息。 */
  direction: string | null;
}

/** 校验结论。 */
export interface DocViolation {
  rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';
  message: string;
  /** 可执行的修正提示（FR-04）。 */
  hint: string;
  line?: number;
}

/** 文档解析/校验的统一结果。 */
export interface DocCheckResult {
  ok: boolean;
  violations: DocViolation[];
  parsed?: ParsedDoc;
}

/**
 * 解析并校验 `project-manager.md` 的原始文本（§8.2 规则 R1–R6）。
 *
 * 纯函数：不抛异常，把所有问题收集为 `violations`，便于一次性给出全部修正提示。
 *
 * @param text 文件原文
 * @param knownNames 事实源中已存在的节点名集合；给定时执行 R5
 */
export function checkDocument(text: string, knownNames?: ReadonlySet<string>): DocCheckResult {
  const violations: DocViolation[] = [];
  const lines = text.split(/\r?\n/);

  let projectName: string | null = null;
  let h1Count = 0;
  let fenceOpen = -1;
  let fenceClose = -1;
  const outsideLines: Array<{ line: number; text: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    if (line.trimStart().startsWith('```')) {
      if (fenceOpen === -1) {
        if (line.trim() === MERMAID_FENCE.trim()) {
          fenceOpen = i;
        } else {
          violations.push({
            rule: 'R4',
            line: lineNo,
            message: `代码块必须以 ${MERMAID_FENCE} 开始（实际为 ${line.trim()}）`,
            hint: `把围栏改为 ${MERMAID_FENCE}`,
          });
        }
      } else if (fenceClose === -1) {
        fenceClose = i;
      } else {
        violations.push({
          rule: 'R2',
          line: lineNo,
          message: '只允许一个 mermaid 代码块',
          hint: '删除多余的代码块；节点变更请走工具/菜单',
        });
      }
      continue;
    }

    if (fenceOpen === -1 || (fenceClose !== -1 && i > fenceClose)) {
      // 代码块之外
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const h1 = H1_PATTERN.exec(trimmed);
      if (h1 && !trimmed.startsWith('##')) {
        h1Count += 1;
        if (h1Count === 1) projectName = (h1[1] ?? '').trim();
      } else {
        outsideLines.push({ line: lineNo, text: trimmed });
      }
    }
  }

  if (h1Count === 0) {
    violations.push({
      rule: 'R1',
      message: '缺少一级标题（项目名称）',
      hint: '首行写 `# <项目名称>`',
    });
  } else if (h1Count > 1) {
    violations.push({
      rule: 'R1',
      message: `只允许一个一级标题，实际有 ${h1Count} 个`,
      hint: '把多余标题降级或删除；说明文字不允许出现在本文件内',
    });
  }

  if (fenceOpen === -1) {
    violations.push({
      rule: 'R2',
      message: '缺少 mermaid 代码块',
      hint: `追加一个 ${MERMAID_FENCE} 代码块，用连线描述节点`,
    });
    return { ok: violations.length === 0, violations };
  }
  if (fenceClose === -1) {
    violations.push({
      rule: 'R2',
      message: 'mermaid 代码块未闭合',
      hint: '补上结尾的 ``` 围栏',
    });
  }

  for (const extra of outsideLines) {
    violations.push({
      rule: 'R3',
      line: extra.line,
      message: `代码块外不允许非空文本行：${truncate(extra.text, 40)}`,
      hint: '把说明移到节点的 description 字段或会话里；本文件只保留标题与流程图',
    });
  }

  // ── 解析代码块内容 ─────────────────────────────────────────────
  const bodyStart = fenceOpen + 1;
  const bodyEnd = fenceClose === -1 ? lines.length : fenceClose;
  const parsed = parseMermaidBody(lines.slice(bodyStart, bodyEnd), bodyStart + 1);

  if (parsed.doc.direction === null && parsed.doc.edges.length === 0) {
    violations.push({
      rule: 'R4',
      message: '代码块内没有可解析的流程图声明或连线',
      hint: '第一行写 `flowchart TD`，随后用 `A --> B` 描述节点',
    });
  }

  for (const forbidden of parsed.forbiddenHits) {
    violations.push({
      rule: 'R6',
      line: forbidden.line,
      message: `禁止的 mermaid 指令：${forbidden.token}`,
      hint: '状态与样式由事实源驱动；请通过节点状态而非 classDef/style 表达',
    });
  }

  if (knownNames && knownNames.size > 0) {
    for (const name of parsed.doc.nodeNames) {
      if (!knownNames.has(name)) {
        violations.push({
          rule: 'R5',
          message: `节点「${name}」不在事实源的节点表中`,
          hint: '通过 pm_add 创建该节点，或在规范化时选择把它纳入事实源',
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    parsed: { projectName: projectName ?? '', ...parsed.doc },
  };
}

interface BodyParseResult {
  doc: Omit<ParsedDoc, 'projectName'>;
  forbiddenHits: Array<{ token: string; line: number }>;
}

export function parseMermaidBody(lines: readonly string[], firstLineNo = 1): BodyParseResult {
  const nodeNames: string[] = [];
  const seen = new Set<string>();
  const edges: DocEdge[] = [];
  const forbiddenHits: Array<{ token: string; line: number }> = [];
  let direction: string | null = null;

  const registerName = (raw: string): void => {
    for (const part of expandSiblings(raw)) {
      if (!seen.has(part)) {
        seen.add(part);
        nodeNames.push(part);
      }
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    const lineNo = firstLineNo + i;
    if (line === '') continue;

    const declaration = MERMAID_DECL_PATTERN.exec(line);
    if (declaration) {
      direction = declaration[2] ?? 'TD';
      continue;
    }

    for (const directive of FORBIDDEN_DIRECTIVES) {
      if (line === directive.trim() || line.startsWith(directive)) {
        forbiddenHits.push({ token: directive.trim(), line: lineNo });
      }
    }

    const dashed = EDGE_DASHED_PATTERN.exec(line);
    if (dashed) {
      const from = cleanNodeToken(dashed[1] ?? '');
      const to = cleanNodeToken(dashed[3] ?? '');
      if (from && to) {
        registerName(from);
        registerName(to);
        edges.push({ from: firstSibling(from), to: firstSibling(to), dashed: true });
      }
      continue;
    }

    const solid = EDGE_SOLID_PATTERN.exec(line);
    if (solid) {
      const from = cleanNodeToken(solid[1] ?? '');
      const to = cleanNodeToken(solid[2] ?? '');
      if (from && to) {
        registerName(from);
        registerName(to);
        edges.push({ from: firstSibling(from), to: firstSibling(to), dashed: false });
      }
      continue;
    }

    // 单独的节点定义行（无连线）：`NodeName`
    const solo = cleanNodeToken(line);
    if (solo) registerName(solo);
  }

  return { doc: { nodeNames, edges, direction }, forbiddenHits };
}

/** 去掉节点 token 两端空白与 mermaid 的引号/括号包装。 */
export function cleanNodeToken(token: string): string {
  let value = token.trim();
  // 形如 A["文本"] / A(文本) / A{文本} → 取 A
  const withBracket = /^([^[({]+)[\[({]/.exec(value);
  if (withBracket) return (withBracket[1] ?? '').trim();
  value = value.replace(/^["'`]|["'`]$/g, '').trim();
  return value;
}

/** 展开 `::` 并列同级语法（FR-13）。 */
export function expandSiblings(raw: string): string[] {
  return raw
    .split(SIBLING_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 取并列组里的第一个名字（连线端点用第一个代表整组）。 */
export function firstSibling(raw: string): string {
  return expandSiblings(raw)[0] ?? raw.trim();
}

/** 转义节点名以便安全写回 mermaid（避免 `::`、连字符等被误解析）。 */
export function escapeNodeName(name: string): string {
  return name.replace(/\r?\n/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

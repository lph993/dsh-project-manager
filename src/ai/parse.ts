/**
 * AI 建树：输出解析与归一化（**纯函数**，可单测，不碰网络）。
 *
 * 设计原则（实测修正过一次，很重要）：
 * **对形状宽容，对事实严格。**
 * 早先的版本用严格 zod 枚举直接校验模型输出，结果模型把引用类型写成 `"file"`
 * （我的枚举只有 `dir`/`md`/`code`）→ **整棵树被拒**，用户只看到一句"结构不合法"。
 * 而这类偏差是可以安全归一的：`file` → `code`、`75%` → `0.75`、`"3"` → `3`。
 *
 * 现在的规则：
 * - **能安全归一的一律归一**，并逐条记进 `notes`（面板会显示，绝不静默改数据）；
 * - **不能确信的只丢那一小段**（一个坏引用不该拖垮整棵树）；
 * - **只有整体不可用才失败**（找不到 JSON、JSON 坏掉、归一后一个节点都不剩）。
 *
 * 仍然**绝不编造**：拿不准的字段宁可省略，也不猜一个值出来。
 */

import type { NodeKind } from '../shared/types.ts';

/** 归一后的引用类型（与 `Ref` 的类型子集一致）。 */
export type AiRefType = 'dir' | 'md' | 'code';

export interface AiTreeNode {
  name: string;
  kind: NodeKind;
  /** 父节点在这个数组里的下标（`null` = 根）。 */
  parent: number | null;
  refs: Array<{ type: AiRefType; target: string }>;
  weight?: number;
  progress?: number;
  note?: string;
}

export interface AiTree {
  projectName?: string;
  nodes: AiTreeNode[];
}

export type ParseOutcome =
  | { ok: true; value: AiTree; notes: string[] }
  | { ok: false; error: string; excerpt?: string };

/** 取出文本里的第一个完整 JSON 对象（模型常把 JSON 包在 ```json 围栏里）。 */
export function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/** 括号是否配平（用于区分"被截断"与"本来就不是 JSON"）。 */
export function isBalanced(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
  }
  return depth === 0;
}

/** 引用类型别名归一（`file`/`folder`/`doc` 这些模型常用的写法都收进来）。 */
function normalizeRefType(value: unknown): AiRefType | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if (key === 'dir' || key === 'directory' || key === 'folder' || key === 'path') return 'dir';
  if (key === 'md' || key === 'markdown' || key === 'doc' || key === 'docs' || key === 'document') {
    return 'md';
  }
  if (key === 'code' || key === 'file' || key === 'source' || key === 'src' || key === 'ts') {
    return 'code';
  }
  return undefined;
}

/** 由路径后缀猜引用类型（模型只给了字符串路径时）。 */
function inferRefTypeFromTarget(target: string): AiRefType {
  if (/\.(md|markdown)$/i.test(target)) return 'md';
  if (/\.[a-z0-9]+$/i.test(target)) return 'code';
  return 'dir';
}

/** 工作区相对路径校验（禁止绝对路径与向上逃逸）。 */
function isWorkspaceRelative(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').trim();
  if (normalized === '') return false;
  if (normalized === '.') return true;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
  return !normalized.split('/').includes('..');
}

/** 引用归一：字符串路径、`{type,target}`、别名类型都接受；坏的只丢这一条。 */
function normalizeRef(
  value: unknown,
  nodeName: string,
  notes: string[],
): { type: AiRefType; target: string } | undefined {
  let rawType: unknown;
  let target: unknown;
  if (typeof value === 'string') {
    target = value;
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    rawType = record['type'] ?? record['kind'];
    target = record['target'] ?? record['path'] ?? record['value'];
  } else {
    notes.push(`「${nodeName}」有一条引用格式无法识别，已丢弃`);
    return undefined;
  }
  if (typeof target !== 'string' || !isWorkspaceRelative(target)) {
    notes.push(`「${nodeName}」的引用 ${String(target)} 不是工作区相对路径，已丢弃`);
    return undefined;
  }
  const normalizedTarget = target.replace(/\\/g, '/');
  const mapped = normalizeRefType(rawType);
  const canonical =
    typeof rawType === 'string' && ['dir', 'md', 'code'].includes(rawType.trim().toLowerCase());
  if (rawType !== undefined && !canonical) {
    // 等价类型也**留痕**：用户能在面板上看到"我改了什么"，而不是被悄悄改掉
    notes.push(
      mapped !== undefined
        ? `「${nodeName}」的引用类型 ${String(rawType)} 已按等价类型 ${mapped} 归一`
        : `「${nodeName}」的引用类型 ${String(rawType)} 不认识，已按路径推断为 ` +
          `${inferRefTypeFromTarget(normalizedTarget)}`,
    );
  }
  return { type: mapped ?? inferRefTypeFromTarget(normalizedTarget), target: normalizedTarget };
}

/** 节点类型归一（中英文与 `feature-point` 这类写法都收）。 */
function normalizeKind(value: unknown, fallback: NodeKind): { kind: NodeKind; note?: string } {
  if (typeof value !== 'string') return { kind: fallback };
  const key = value.trim().toLowerCase();
  if (key === 'feature' || key === 'feature-point' || key === '功能' || key === '功能点') {
    return { kind: 'feature' };
  }
  if (key === 'task' || key === 'task-point' || key === '任务' || key === '任务点') {
    return { kind: 'task' };
  }
  return { kind: fallback, note: `kind="${value}" 不认识，已按层级推断为 ${fallback}` };
}

/** 权重归一：数字或数字字符串；`%` 去掉；越界**夹紧**（不因此丢掉整棵树）。 */
function normalizeWeight(value: unknown): { weight?: number; note?: string } {
  if (value === undefined || value === null || value === '') return {};
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[%\s]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return {};
  if (numeric > 10) return { weight: 10, note: `weight=${String(value)} 超出 (0,10]，已夹紧到 10` };
  return { weight: numeric };
}

/** 完成度归一：`0.75` / `75` / `"75%"` / `"0.75"` 都接受（>1 视为百分数）。 */
function normalizeProgress(value: unknown): { progress?: number; note?: string } {
  if (value === undefined || value === null || value === '') return {};
  const text = String(value).trim();
  const percent = text.endsWith('%');
  const numeric = typeof value === 'number' ? value : Number(text.replace(/[%\s]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return {};
  const normalized = percent || numeric > 1 ? numeric / 100 : numeric;
  if (!Number.isFinite(normalized)) return {};
  if (normalized > 1) return { progress: 1, note: `progress=${text} 超出 1，已夹紧到 1` };
  return {
    progress: normalized,
    ...(percent || numeric > 1 ? { note: `progress=${text} 已按百分数换算` } : {}),
  };
}

/** 从可能的包装层里取出 `nodes` 数组（模型有时会套一层 `tree` / `data`）。 */
function pickNodes(parsed: unknown): { nodes: unknown[]; projectName?: unknown } | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record['nodes'])) {
    return { nodes: record['nodes'], projectName: record['projectName'] };
  }
  for (const key of ['tree', 'data', 'result', 'project']) {
    const nested = record[key];
    if (typeof nested === 'object' && nested !== null) {
      const found = pickNodes(nested);
      if (found !== undefined) {
        return { nodes: found.nodes, projectName: found.projectName ?? record['projectName'] };
      }
    }
  }
  return undefined;
}

/**
 * 解析并归一化模型输出。
 *
 * @returns 成功时给出归一后的树与**逐条说明**；失败时给出原因与原始片段
 */
export function parseTreeResponse(text: string): ParseOutcome {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return { ok: false, error: '模型输出里找不到 JSON 对象', excerpt: text.slice(0, 400) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      excerpt: json.slice(0, 400),
    };
  }

  const picked = pickNodes(parsed);
  if (picked === undefined || picked.nodes.length === 0) {
    return { ok: false, error: 'JSON 里没有 nodes 数组', excerpt: json.slice(0, 400) };
  }

  const notes: string[] = [];
  const nodes: AiTreeNode[] = [];
  /** 保留节点下标 → 原始数组下标（父下标在这张映射里查）。 */
  const originalIndex: number[] = [];
  const seenSibling = new Set<string>();

  picked.nodes.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      notes.push(`第 ${index + 1} 个节点不是对象，已丢弃`);
      return;
    }
    const record = raw as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    if (name === '') {
      notes.push(`第 ${index + 1} 个节点没有名称，已丢弃`);
      return;
    }

    // 父下标：数字、数字字符串都认；只有指向前面的节点才有效（防环、防前向引用）
    let parent: number | null = null;
    const rawParent = record['parent'];
    if (typeof rawParent === 'number' && Number.isInteger(rawParent)) parent = rawParent;
    else if (typeof rawParent === 'string' && /^\d+$/.test(rawParent.trim())) {
      parent = Number(rawParent.trim());
    } else if (rawParent !== null && rawParent !== undefined) {
      notes.push(`「${name}」的 parent=${String(rawParent)} 不是下标，已当作根`);
    }
    if (parent !== null) {
      if (parent >= index) {
        notes.push(`「${name}」的父下标 ${parent} 指向自身或后面的节点，已改为根`);
        parent = null;
      } else {
        const mapped = originalIndex.indexOf(parent);
        if (mapped < 0) {
          notes.push(`「${name}」的父下标 ${parent} 已被丢弃，已改为根`);
          parent = null;
        } else {
          parent = mapped;
        }
      }
    }

    const siblingKey = `${parent ?? 'root'}\u0000${name}`;
    if (seenSibling.has(siblingKey)) {
      notes.push(`同级重复名称「${name}」已丢弃`);
      return;
    }
    seenSibling.add(siblingKey);

    const refs = (Array.isArray(record['refs']) ? record['refs'] : [])
      .map((ref) => normalizeRef(ref, name, notes))
      .filter((ref): ref is { type: AiRefType; target: string } => ref !== undefined)
      .slice(0, 12);

    const kindDecision = normalizeKind(record['kind'], 'task');
    if (kindDecision.note !== undefined) notes.push(`「${name}」${kindDecision.note}`);
    const weight = normalizeWeight(record['weight']);
    if (weight.note !== undefined) notes.push(`「${name}」${weight.note}`);
    const progress = normalizeProgress(record['progress']);
    if (progress.note !== undefined) notes.push(`「${name}」${progress.note}`);

    const node: AiTreeNode = { name, kind: kindDecision.kind, parent, refs };
    if (weight.weight !== undefined) node.weight = weight.weight;
    if (progress.progress !== undefined) node.progress = progress.progress;
    const note = typeof record['note'] === 'string' ? record['note'].trim() : '';
    if (note !== '') node.note = note.slice(0, 300);
    nodes.push(node);
    originalIndex.push(index);
  });

  if (nodes.length === 0) {
    return { ok: false, error: '没有任何可用节点', excerpt: json.slice(0, 400) };
  }

  if (!nodes.some((node) => node.parent === null)) {
    nodes[0]!.parent = null;
    notes.push('模型没给根节点，已把第一个节点作为根');
  }

  // 有子节点的必然是"枝"：模型把枝标成 task 时按**事实**纠正
  const hasChild = new Set<number>();
  for (const node of nodes) {
    if (node.parent !== null) hasChild.add(node.parent);
  }
  for (const [index, node] of nodes.entries()) {
    if (hasChild.has(index) && node.kind !== 'feature') {
      node.kind = 'feature';
      notes.push(`「${node.name}」有子节点，kind 已按事实改为 feature`);
    }
  }

  const projectNameRaw = picked.projectName;
  const projectName =
    typeof projectNameRaw === 'string' && projectNameRaw.trim() !== ''
      ? projectNameRaw.trim()
      : undefined;

  return {
    ok: true,
    value: { ...(projectName !== undefined ? { projectName } : {}), nodes },
    notes,
  };
}

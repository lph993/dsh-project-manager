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
  /** 优先级 1..10（1 最高）：AI 建树时按重要性初判。 */
  priority?: number;
  /**
   * **给节点补的描述**（用户诉求："AI 建树/修剪树/同步树时直接补充描述信息"）：
   * 回答"这块要做什么"，写进节点的 `description`。
   *
   * 与 {@link note} 是两个字段、两种用途：`note` 是"我凭什么这么判断"（只用于追溯），
   * 早先两者被混为一谈 —— `note` 被直接当成 `description` 写进节点，
   * 于是节点描述里全是判断依据，而不是"要做什么"。现在分开。
   */
  description?: string;
  note?: string;
}

export interface AiTree {
  projectName?: string;
  nodes: AiTreeNode[];
}

export type ParseOutcome =
  | { ok: true; value: AiTree; notes: string[] }
  | { ok: false; error: string; excerpt?: string };

/**
 * 把缓存里那份**已解析的树**还原成"与 `parseTreeResponse` 同形"的结果（结构自检）。
 *
 * 缓存是 JSON 落盘的，读回来是 `unknown`：手工改坏或曾经写进一个空树的条目都不该被当成有效结论。
 * 判定"缓存能不能复用"必须走这里 —— 它是纯函数，预览与执行两条路径共用，也就能被单测钉住。
 */
export function treeFromCached(tree: unknown): ParseOutcome | undefined {
  if (tree === null || typeof tree !== 'object') return undefined;
  const candidate = tree as { nodes?: unknown; notes?: unknown };
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) return undefined;
  const notes = Array.isArray(candidate.notes)
    ? candidate.notes.filter((note): note is string => typeof note === 'string')
    : [];
  return { ok: true, value: tree as AiTree, notes };
}

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

/**
 * 终止原因里"撞到上限"的**各种写法**。
 *
 * 为什么不能直接 `=== 'length'`：那是某一家供应商的措辞。实测本机这条报错拿到的是
 * **`max-tokens`**（真机截图里的"终止原因：max-tokens"），而代码只认 `length` ——
 * 于是**同一个事实**：给用户看的提示说"被截断"，机器可读的原因码却说 `invalid-output`。
 * 供应商还可能写 `max_tokens` / `MAX_TOKENS` / `token-limit` / `max-output-tokens`，
 * 所以这里做**大小写与分隔符归一**后再比，而不是碰运气。
 */
const OUTPUT_LIMIT_REASONS: readonly RegExp[] = [
  /^length$/i,
  /^max[-_ ]?tokens?$/i,
  /^max[-_ ]?output[-_ ]?tokens?$/i,
  /^token[-_ ]?limit$/i,
  /^output[-_ ]?limit$/i,
];

/** 终止原因是不是"撞到输出上限"。 */
export function isOutputLimitReason(finishReason: string | undefined): boolean {
  if (finishReason === undefined) return false;
  const normalized = finishReason.trim();
  return OUTPUT_LIMIT_REASONS.some((pattern) => pattern.test(normalized));
}

/**
 * **输出被截断了**——唯一判据，供提示文案与原因码**共用**。
 *
 * 两个信号，任一成立即算：
 * ① **文本本身不配平**（`{`/`[` 没闭合）：这是**与供应商措辞无关的客观证据** ——
 *    一份完整的 JSON 不可能不配平，所以它比任何 label 都可靠；
 * ② 终止原因命中"撞上限"的各种写法（见 {@link isOutputLimitReason}）。
 *
 * 为什么必须共用一个函数：这里踩过真坑 —— 提示文案用了"①或②"，原因码却只用了
 * `=== 'length'`，于是 `max-tokens` 时两者**互相矛盾**（用户看到的正是这种自相矛盾：
 * 一句说"被截断"，另一句说"不符合要求"）。**一个事实只能有一处判据。**
 */
export function isTruncatedCompletion(input: {
  finishReason: string | undefined;
  text: string;
}): boolean {
  return isOutputLimitReason(input.finishReason) || !isBalanced(input.text);
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

/**
 * 优先级归一：**1..10 整数，1 最高**；越界夹紧、小数取整（不因此丢掉整棵树）。
 *
 * 与 `weight` 的关键差别：`weight` 只有下界（(0,10]），优先级是**闭区间 1..10** ——
 * 模型给 `0` 或 `11` 都要夹回边界，而不是当作"没给"（那会让节点悄悄失去优先级）。
 */
function normalizePriority(value: unknown): { priority?: number; note?: string } {
  if (value === undefined || value === null || value === '') return {};
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[%\s]/g, ''));
  if (!Number.isFinite(numeric)) return {};
  const rounded = Math.round(numeric);
  if (rounded < 1) return { priority: 1, note: `priority=${String(value)} 低于 1，已夹紧到 1（1 最高）` };
  if (rounded > 10) return { priority: 10, note: `priority=${String(value)} 高于 10，已夹紧到 10` };
  return {
    priority: rounded,
    ...(rounded !== numeric ? { note: `priority=${String(value)} 已取整为 ${rounded}` } : {}),
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
    const priority = normalizePriority(record['priority']);
    if (priority.note !== undefined) notes.push(`「${name}」${priority.note}`);

    const node: AiTreeNode = { name, kind: kindDecision.kind, parent, refs };
    if (weight.weight !== undefined) node.weight = weight.weight;
    if (progress.progress !== undefined) node.progress = progress.progress;
    if (priority.priority !== undefined) node.priority = priority.priority;
    /**
     * 描述与判断依据**分开落字段**（用户诉求："AI 建树…时直接补充描述信息"）。
     * 描述允许长一点（200 字），依据短一点（300 字）——它只是追溯用的备注。
     */
    const description = typeof record['description'] === 'string' ? record['description'].trim() : '';
    if (description !== '') node.description = description.slice(0, 200);
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

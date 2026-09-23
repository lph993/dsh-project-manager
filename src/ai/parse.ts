/**
 * AI 建树：输出解析与校验（**纯函数**，可单测，不碰网络）。
 *
 * 模型返回的是**文本**，必须当成不可信输入：先剥代码围栏、再定位 JSON、
 * 然后逐条校验（名称/类型/父下标/权重/进度/引用路径），最后做归一化
 * （同父同名去重、父下标必须指向前面的节点、断环）。
 *
 * 任何一处不合法都**不猜**：返回失败 + 原因，由上层如实告诉用户，
 * 绝不"尽力改一改就落库"（§9.3b：AI 初判只能是初判，不能把坏数据写进事实源）。
 */

import { z } from 'zod';

const refSchema = z.object({
  type: z.enum(['dir', 'md', 'code']),
  target: z.string().min(1).max(300),
});

const rawNodeSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['feature', 'task']).optional(),
  /** 父节点在 `nodes` 数组里的下标；`null` = 根。 */
  parent: z.number().int().min(0).nullable().optional(),
  refs: z.array(refSchema).max(20).optional(),
  /** 相对工作量：`(0, 10]`（§9.3a；**不是**代码量）。 */
  weight: z.number().positive().max(10).optional(),
  /** 完成度初判：`0..1`（§9.3b，AI 初判来源）。 */
  progress: z.number().min(0).max(1).optional(),
  note: z.string().max(300).optional(),
});

const rawResponseSchema = z.object({
  projectName: z.string().min(1).max(80).optional(),
  nodes: z.array(rawNodeSchema).min(1).max(400),
});

export interface AiTreeNode {
  name: string;
  kind: 'feature' | 'task';
  /** 父节点在这个数组里的下标（`null` = 根）。 */
  parent: number | null;
  refs: Array<{ type: 'dir' | 'md' | 'code'; target: string }>;
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
  // 从第一个 `{` 开始做括号配对（忽略字符串内的括号）
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

/** 工作区相对路径校验（禁止绝对路径与向上逃逸；FR-39j 的 refs 约束）。 */
function isWorkspaceRelative(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').trim();
  if (normalized === '' || normalized === '.') return true;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
  return !normalized.split('/').includes('..');
}

/**
 * 解析并校验模型输出。
 *
 * 归一化规则（都会记进 `notes`，不静默处理）：
 * - 同父同名 → 丢弃后来的（C12：同级名称唯一）；
 * - `parent` 必须指向**前面**出现的节点（防环、防前向引用）；
 * - `refs` 只保留工作区相对路径；
 * - 名称去首尾空白，空名直接判失败。
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
  const validated = rawResponseSchema.safeParse(parsed);
  if (!validated.success) {
    const first = validated.error.issues[0];
    return {
      ok: false,
      error: `结构不合法：${first ? `${first.path.join('.')} ${first.message}` : '未知字段问题'}`,
      excerpt: json.slice(0, 400),
    };
  }

  const notes: string[] = [];
  const nodes: AiTreeNode[] = [];
  /** 保留节点下标 → 原始数组下标（父下标要在这个映射里查）。 */
  const originalIndex: number[] = [];
  const seenSibling = new Set<string>();

  validated.data.nodes.forEach((raw, index) => {
    const name = raw.name.trim();
    if (name === '') {
      notes.push(`第 ${index + 1} 个节点名称为空，已丢弃`);
      return;
    }
    // 父下标：必须指向前面的节点（根用 null）
    let parent: number | null = raw.parent ?? null;
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

    const refs = (raw.refs ?? []).filter((ref) => {
      if (isWorkspaceRelative(ref.target)) return true;
      notes.push(`「${name}」的引用 ${ref.target} 不是工作区相对路径，已丢弃`);
      return false;
    });

    const node: AiTreeNode = {
      name,
      kind: raw.kind ?? 'task',
      parent,
      refs: refs.map((ref) => ({ type: ref.type, target: ref.target.replace(/\\/g, '/') })),
    };
    if (raw.weight !== undefined) node.weight = raw.weight;
    if (raw.progress !== undefined) node.progress = raw.progress;
    if (raw.note !== undefined && raw.note.trim() !== '') node.note = raw.note.trim();
    nodes.push(node);
    originalIndex.push(index);
  });

  const cleaned = nodes;

  if (cleaned.length === 0) return { ok: false, error: '没有任何可用节点', excerpt: json.slice(0, 400) };
  if (!cleaned.some((node) => node.parent === null)) {
    // 没有根：把第一个提为根（否则整棵树挂不上去）
    cleaned[0]!.parent = null;
    notes.push('模型没给根节点，已把第一个节点作为根');
  }

  return {
    ok: true,
    value: {
      ...(validated.data.projectName !== undefined
        ? { projectName: validated.data.projectName.trim() }
        : {}),
      nodes: cleaned,
    },
    notes,
  };
}

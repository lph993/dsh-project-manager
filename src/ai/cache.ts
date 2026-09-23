/**
 * AI 轨的内容哈希缓存与增量复用（T6/T9、FR-104/39f/39g）。
 *
 * **为什么必须有**：AI 建树是全插件最贵的一次调用。同样的仓库重跑一次就再花一次钱，
 * 而用户的实际动作往往只是"再看看"或"改了一个文件"。
 *
 * 三条口径写死在这里（纯函数，可单测）：
 * 1. **键 = 输入指纹**：渲染后的提示词 + 模型路由 + 输出上限 + 提示词版本。
 *    键相同 ⇒ 送进模型的东西**逐字节相同** ⇒ 上次的结论可以原样复用（零 token）。
 * 2. **增量**：额外记录"路径 → 签名哈希"，于是能算清"这次到底改了什么"
 *    （新增/删除/内容变化），而不是含糊地说"仓库变了"。
 * 3. **可续跑**：被取消/截断的那次也把**已得文本**落盘（`partial`），
 *    下次可以复用而不是从头再来——但复用前要如实告诉用户这是"上次那份"。
 */

import { hashContent } from '../adapter/workspace.ts';

/** 关键文件的签名指纹（增量比对的单位）。 */
export interface SignatureMap {
  [path: string]: string;
}

/** 缓存条目状态：`complete` 可整份复用；`partial` 是被打断的那次（可续跑）。 */
export type CacheStatus = 'complete' | 'partial';

export interface CacheEntry {
  /** 输入指纹（见 `cacheKey`）。 */
  key: string;
  status: CacheStatus;
  createdAt: string;
  /** 送进模型的骨架指纹（用于"这次比上次改了什么"）。 */
  signatures: SignatureMap;
  /** `complete`：模型输出解析后的树（原样复用）。 */
  tree?: unknown;
  /** `partial`：已得到的原始文本（可人工/自动续跑）。 */
  rawText?: string;
  /** 上次花费（用于统计"省了多少"）。 */
  tokens?: number;
  /** 上次的模型路由与输出上限（换了模型就不算同一个键，但仍可展示差异）。 */
  route?: string;
  maxTokens?: number;
}

/** 输入指纹的组成部分。 */
export interface CacheKeyInput {
  /** 渲染后的提示词（**逐字节**参与哈希：提示词一改，缓存自然失效）。 */
  prompt: string;
  provider: string;
  model: string;
  maxTokens: number;
  /** 提示词/解析器的版本号：改了解析口径就应该让旧缓存失效。 */
  promptVersion: string;
}

/**
 * 输入指纹。
 *
 * 注意：这里**不含时间**，否则永远命不中；也不含"仓库路径"，因为同样的内容
 * 在不同路径下结论应当一致（键里已经有全部提示词内容）。
 */
export function cacheKey(input: CacheKeyInput): string {
  return hashContent(
    [
      `v=${input.promptVersion}`,
      `p=${input.provider}`,
      `m=${input.model}`,
      `t=${input.maxTokens}`,
      input.prompt,
    ].join('\n'),
  );
}

/** 从骨架条目提取"路径 → 签名哈希"（非关键文件用大小+修改时间兜底，够判"文件变了没"）。 */
export function signaturesOf(
  entries: ReadonlyArray<{ path: string; signature?: string; sizeBytes?: number; mtimeMs?: number }>,
): SignatureMap {
  const out: SignatureMap = {};
  for (const entry of entries) {
    /**
     * 关键文件：用**签名内容**判（最准）。
     * 其它文件：用**大小 + 修改时间**兜底 —— 只比大小会漏掉同尺寸改动
     * （`1` → `2` 这种，实测被 e2e 抓到：缓存命中导致旧结论被复用）。
     * 代价是"复制文件但保留 mtime"这类操作可能漏检，这一点如实写在 README 里。
     */
    const basis =
      entry.signature !== undefined && entry.signature !== ''
        ? `sig:${entry.signature}`
        : `meta:${entry.sizeBytes ?? 'unknown'}:${entry.mtimeMs ?? 'unknown'}`;
    out[entry.path] = hashContent(basis);
  }
  return out;
}

/** 相对上次的增量（FR-39f：只处理变更文件）。 */
export interface SignatureDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  /** 是否有任何变化（`false` ⇒ 可以整份复用缓存）。 */
  dirty: boolean;
}

/** 比对两次骨架指纹。 */
export function diffSignatures(prev: SignatureMap, next: SignatureMap): SignatureDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const [path, hash] of Object.entries(next)) {
    const before = prev[path];
    if (before === undefined) added.push(path);
    else if (before !== hash) changed.push(path);
    else unchanged += 1;
  }
  for (const path of Object.keys(prev)) {
    if (next[path] === undefined) removed.push(path);
  }
  const dirty = added.length + removed.length + changed.length > 0;
  return { added, removed, changed, unchanged, dirty };
}

/** 缓存命中/未命中/只有半份的判定结果。 */
export type CacheVerdict =
  | { kind: 'hit'; entry: CacheEntry }
  | { kind: 'resume'; entry: CacheEntry }
  | { kind: 'miss'; previous?: CacheEntry };

/**
 * 判定这次该怎么用缓存。
 *
 * @param entries - 已落盘的条目（新→旧按需，函数内部自己按 key 找）
 * @param key - 本次输入指纹
 * @param signatures - 本次骨架指纹（用来判断"半份"是否还有效）
 */
export function decideCache(
  entries: readonly CacheEntry[],
  key: string,
  signatures: SignatureMap,
): CacheVerdict {
  const sameKey = entries.filter((entry) => entry.key === key);
  const complete = sameKey.find((entry) => entry.status === 'complete');
  if (complete !== undefined) {
    // 键相同就代表送进去的东西逐字节一样 —— 但骨架指纹还要再核一遍：
    // 万一有人手工改了缓存文件，"整份复用"就会给出与当前仓库无关的树
    const diff = diffSignatures(complete.signatures, signatures);
    if (!diff.dirty) return { kind: 'hit', entry: complete };
  }
  const partial = sameKey.find((entry) => entry.status === 'partial');
  if (partial !== undefined) {
    const diff = diffSignatures(partial.signatures, signatures);
    if (!diff.dirty) return { kind: 'resume', entry: partial };
  }
  // 没命中也把最近一次同路由的记录带出去，UI 才能说清"上次是什么时候、改了多少"
  const previous = entries.find((entry) => entry.status === 'complete');
  return { kind: 'miss', ...(previous !== undefined ? { previous } : {}) };
}

/** 缓存条目的容量治理（FR-122 精神：有界 + 说清淘汰了什么）。 */
export interface PruneResult {
  kept: CacheEntry[];
  dropped: CacheEntry[];
}

/**
 * 有界保留：**保留最新**若干条、且总字节不超上限。
 *
 * 不变量：`complete` 优先于 `partial`（半份的复用价值更低），同状态内按时间新旧。
 */
export function pruneEntries(
  entries: readonly CacheEntry[],
  options: { maxEntries: number; maxBytes: number },
): PruneResult {
  const ordered = [...entries].sort((left, right) => {
    if (left.status !== right.status) return left.status === 'complete' ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const kept: CacheEntry[] = [];
  const dropped: CacheEntry[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    const size = JSON.stringify(entry).length;
    if (kept.length >= options.maxEntries || bytes + size > options.maxBytes) {
      dropped.push(entry);
      continue;
    }
    kept.push(entry);
    bytes += size;
  }
  return { kept, dropped };
}

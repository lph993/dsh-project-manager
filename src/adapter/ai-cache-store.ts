/**
 * AI 缓存落盘（`.pm/ai-cache.json`）。
 *
 * 为什么放 `.pm/` 而不是 KV 主路线：缓存是**可丢弃的加速件**，不是事实源。
 * 放进 workspace 下自己的一亩三分地，既不用为它改存储 schema（两条路线都要动），
 * 也天然跟着工作区走（换个工作区就是另一份缓存），坏了删掉重跑即可。
 *
 * 读写在 adapter 层（用 `ctx.fs`），**纯判定逻辑在 `src/ai/cache.ts`**：
 * 这样"什么时候能复用"这件事可以单测，而 IO 只是搬运。
 */

import type { Context } from '@deepseek-ai/cordis';

import type { CacheEntry } from '../ai/cache.ts';
import { pruneEntries } from '../ai/cache.ts';
import { debugBus } from './debug.ts';

/** 缓存文件（工作区根下）。 */
export const AI_CACHE_PATH = '.pm/ai-cache.json';

/** 保留上限：条数与总字节双限（FR-122 的有界精神，宁可丢缓存也不拖慢宿主）。 */
const MAX_ENTRIES = 6;
const MAX_BYTES = 512 * 1024;

/** 缓存文件的结构（带版本号，将来改形状时能识别旧文件而不是崩）。 */
interface CacheFile {
  version: 1;
  entries: CacheEntry[];
}

/**
 * 宿主 `ctx.fs` 的最小面。
 *
 * **必须先 `resolve(path)` 拿 target 再读写**（真实 `ctx.fs` 是"版本守卫的原子写"，
 * 目标是一个带版本的对象；直接传路径字符串会被拒）。早先这里图省事直接传路径，
 * e2e 立即暴露（假 fs 的 `readText` 收的是 target）。
 */
interface FsLike {
  resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
  readText(target: unknown): Promise<string>;
  writeText(target: unknown, content: string): Promise<unknown>;
}

function fsOf(ctx: Context): FsLike | undefined {
  try {
    const holder = ctx as unknown as {
      fs?: Partial<FsLike>;
      get?: (name: string) => unknown;
    };
    const fs = (holder.fs ?? holder.get?.('fs')) as Partial<FsLike> | undefined;
    if (
      fs === undefined ||
      typeof fs.resolve !== 'function' ||
      typeof fs.readText !== 'function' ||
      typeof fs.writeText !== 'function'
    ) {
      return undefined;
    }
    return fs as FsLike;
  } catch {
    return undefined;
  }
}

/**
 * 读取缓存条目。
 *
 * 任何异常都当"没有缓存"处理并留诊断记录：缓存坏了不该让建树失败。
 */
export async function readAiCache(ctx: Context): Promise<CacheEntry[]> {
  const fs = fsOf(ctx);
  if (fs === undefined) return [];
  try {
    const target = await fs.resolve(AI_CACHE_PATH);
    const text = await fs.readText(target);
    if (text === undefined || text === '') return [];
    const parsed = JSON.parse(text) as Partial<CacheFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (entry): entry is CacheEntry =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as CacheEntry).key === 'string' &&
        ((entry as CacheEntry).status === 'complete' || (entry as CacheEntry).status === 'partial'),
    );
  } catch (error) {
    debugBus.debug(
      'ai',
      `AI 缓存读取未命中（首次运行或文件不存在）：${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * 写入一条缓存条目（合并同键旧条目 + 有界保留）。
 *
 * @returns 写盘结果与"淘汰了什么"（淘汰要能看见，不是静默丢）
 */
export async function writeAiCacheEntry(
  ctx: Context,
  entry: CacheEntry,
): Promise<{ written: boolean; dropped: string[]; reason?: string }> {
  const fs = fsOf(ctx);
  if (fs === undefined) {
    return { written: false, dropped: [], reason: '宿主未提供 ctx.fs，缓存无法落盘（功能不受影响）' };
  }
  try {
    const existing = await readAiCache(ctx);
    // 同键旧条目直接替换：同一个键只会有一条"最新结论"
    const merged = [entry, ...existing.filter((item) => item.key !== entry.key)];
    const { kept, dropped } = pruneEntries(merged, { maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES });
    const payload: CacheFile = { version: 1, entries: kept };
    const target = await fs.resolve(AI_CACHE_PATH);
    await fs.writeText(target, JSON.stringify(payload, null, 2));
    if (dropped.length > 0) {
      debugBus.info('ai', `AI 缓存淘汰 ${dropped.length} 条（有界保留：${MAX_ENTRIES} 条 / ${MAX_BYTES} 字节）`);
    }
    return { written: true, dropped: dropped.map((item) => item.key.slice(0, 12)) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debugBus.warn('ai', `AI 缓存写入失败（不影响本次结果）：${reason}`);
    return { written: false, dropped: [], reason };
  }
}

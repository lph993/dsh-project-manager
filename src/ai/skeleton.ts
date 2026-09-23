/**
 * 采集"给模型看的仓库骨架"（阶段 A 的合法产物，§9.5 T4/T8）。
 *
 * 三条纪律：
 * 1. **不读整文件**：只有关键文件读一小段（`MAX_SIGNATURE_BYTES`）做签名；
 * 2. **不为了估成本读盘**：条目数与字节数都来自已有的遍历结果；
 * 3. **如实标注截断**：深度/数量上限命中时把 `truncated` 与 `skipped` 带出去。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isKeyFileName } from '../domain/scanner.ts';
import type { SkeletonEntry } from './prompt.ts';

/** 单个关键文件最多读多少字节做签名（"只读入口文件"这一级的硬上限）。 */
export const MAX_SIGNATURE_BYTES = 4 * 1024;

/** 最多给几个关键文件做签名（再多收益递减、成本线性上升）。 */
export const MAX_SIGNATURE_FILES = 12;

export interface SkeletonInput {
  root: string;
  entries: ReadonlyArray<{
    path: string;
    kind: 'file' | 'dir';
    sizeBytes?: number;
    /** 修改时间（遍历时同一次 stat 拿到的；增量判定用）。 */
    mtimeMs?: number;
  }>;
  maxEntries?: number;
}

export interface SkeletonResult {
  skeleton: SkeletonEntry[];
  signatureBytes: number;
  truncated: boolean;
  /** 关键文件签名读取失败的路径（如实记录，不假装读过）。 */
  unreadable: string[];
}

/** 采集骨架：目录 + 关键文件（含签名）。 */
export async function collectSkeleton(input: SkeletonInput): Promise<SkeletonResult> {
  const maxEntries = input.maxEntries ?? 400;
  const dirs = input.entries.filter((entry) => entry.kind === 'dir');
  const files = input.entries.filter((entry) => entry.kind === 'file');

  // 目录的直接子文件数（只数元数据，不读内容）
  const fileCountByDir = new Map<string, number>();
  for (const file of files) {
    const parent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    fileCountByDir.set(parent, (fileCountByDir.get(parent) ?? 0) + 1);
  }

  const skeleton: SkeletonEntry[] = [];
  for (const dir of dirs.slice(0, maxEntries)) {
    skeleton.push({
      path: dir.path,
      kind: 'dir',
      fileCount: fileCountByDir.get(dir.path) ?? 0,
    });
  }
  for (const file of files.slice(0, maxEntries)) {
    skeleton.push({
      path: file.path,
      kind: 'file',
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      // 带上修改时间：AI 缓存判增量用（只有 size 会漏掉同尺寸改动，见 `ai/cache.ts`）
      ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    });
  }

  // 关键文件签名：只读前 MAX_SIGNATURE_BYTES 字节
  const keyFiles = files
    .filter((file) => isKeyFileName(file.path.split('/').pop() ?? file.path))
    .slice(0, MAX_SIGNATURE_FILES);
  let signatureBytes = 0;
  const unreadable: string[] = [];
  for (const file of keyFiles) {
    try {
      const text = await readFile(join(input.root, file.path), 'utf8');
      const signature = text.slice(0, MAX_SIGNATURE_BYTES);
      signatureBytes += Buffer.byteLength(signature, 'utf8');
      const entry = skeleton.find(
        (item) => item.kind === 'file' && item.path === file.path,
      );
      if (entry) {
        entry.keyFile = true;
        entry.signature = signature;
      }
    } catch {
      unreadable.push(file.path);
    }
  }

  const truncated = dirs.length + files.length > maxEntries * 2;
  return { skeleton, signatureBytes, truncated, unreadable };
}

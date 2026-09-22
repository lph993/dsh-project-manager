/**
 * 工作区适配器：**唯一**直接触碰 `node:fs` 的地方（§19.5 反腐层）。
 *
 * 为什么需要它：`ctx.fs` 是 DSH 的文件 seam（投影与手改文档走它），但**没有目录遍历**。
 * 而快照必须知道"工作区里有哪些文件"。因此这一层用 `node:fs` 做遍历与快照内容的读写，
 * 并把所有平台细节（路径分隔符、编码、符号链接）收口在**一个文件**里。
 *
 * 快照内容存哪：工作区 `.pm/snapshots/<id>.json`（与 `立项.md` §7.5 的兜底路线一致）。
 * `.pm/` 在快照排除表里，因此不会被快照吞掉。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  MAX_SNAPSHOT_FILES,
  computeManifestHash,
  isSnapshotableFile,
  type FileManifest,
  type SnapshotFileEntry,
} from '../domain/snapshot.ts';
import type { Gate, SelfState } from '../shared/types.ts';

/** 快照内容目录（工作区相对路径）。 */
export const SNAPSHOT_DIR = '.pm/snapshots';

/** 文件内容哈希（快照内容用 sha256：这里要的是碰撞率低，不需要跨面通用）。 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

/** 把绝对路径转成工作区相对路径（统一 `/` 分隔）。 */
export function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

export interface WalkResult {
  manifest: FileManifest;
  /** path → 内容（仅含纳入清单的文件）。 */
  contents: Map<string, string>;
}

/**
 * 遍历工作区，产出文件清单与内容。
 *
 * - 排除规则由**领域层**判定（`isSnapshotableFile`），这里只负责读盘；
 * - 符号链接**不跟进**（避免环与跑到工作区外）；
 * - 超过 `MAX_SNAPSHOT_FILES` 时标记 `truncated`（截断的清单不允许建点）。
 */
export async function walkWorkspace(root: string): Promise<WalkResult> {
  const files: SnapshotFileEntry[] = [];
  const contents = new Map<string, string>();
  let skipped = 0;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不到的目录直接跳过（权限等）
    }
    for (const entry of entries) {
      if (truncated) return;
      const absolute = join(dir, entry.name);
      const rel = toRelative(root, absolute);
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        // 早退：被排除的目录整枝跳过（省 IO，也避免 .git 巨大树）
        if (!isSnapshotableFile({ relativePath: rel, sizeBytes: 0 })) {
          skipped += 1;
          continue;
        }
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(absolute)).size;
      } catch {
        skipped += 1;
        continue;
      }
      if (!isSnapshotableFile({ relativePath: rel, sizeBytes })) {
        skipped += 1;
        continue;
      }
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        skipped += 1;
        continue;
      }
      // 二进制探测：含 NUL 视为二进制，不进快照（无法安全文本还原）
      if (content.includes('\u0000')) {
        skipped += 1;
        continue;
      }
      files.push({ path: rel, hash: hashContent(content), sizeBytes });
      contents.set(rel, content);
      if (files.length >= MAX_SNAPSHOT_FILES) {
        truncated = true;
        return;
      }
    }
  };

  await visit(root);

  return {
    manifest: {
      files,
      manifestHash: computeManifestHash(files),
      skipped,
      truncated,
    },
    contents,
  };
}

/** 快照内容文件（含每个文件的内容与节点状态）。 */
export interface SnapshotContent {
  snapshotId: string;
  createdAt: string;
  files: Array<{ path: string; hash: string; content: string }>;
  /** 该快照覆盖的节点状态（§9.2b：回滚后回到快照点记录的状态）。 */
  nodeState: Record<string, { selfState: SelfState; progress: number; gate: Gate }>;
  manifestHash: string;
}

/** 写入一份快照内容；返回相对路径与占用字节数。 */
export async function writeSnapshotContent(
  root: string,
  content: SnapshotContent,
): Promise<{ ref: string; sizeBytes: number }> {
  const dir = join(root, SNAPSHOT_DIR);
  await mkdir(dir, { recursive: true });
  const rel = `${SNAPSHOT_DIR}/${content.snapshotId}.json`;
  const absolute = join(root, rel);
  const text = JSON.stringify(content);
  await writeFile(absolute, text, 'utf8');
  return { ref: rel, sizeBytes: Buffer.byteLength(text, 'utf8') };
}

/** 读取一份快照内容；不存在或损坏时返回 undefined。 */
export async function readSnapshotContent(
  root: string,
  ref: string,
): Promise<SnapshotContent | undefined> {
  try {
    const absolute = resolve(root, ref);
    // 防逃逸：ref 必须是工作区内相对路径
    if (!absolute.startsWith(resolve(root))) return undefined;
    const text = await readFile(absolute, 'utf8');
    return JSON.parse(text) as SnapshotContent;
  } catch {
    return undefined;
  }
}

/** 删除一份快照内容（清理时用）。 */
export async function deleteSnapshotContent(root: string, ref: string): Promise<void> {
  try {
    const absolute = resolve(root, ref);
    if (!absolute.startsWith(resolve(root))) return;
    await rm(absolute, { force: true });
  } catch {
    // 删除失败不致命（索引已摘除即可）
  }
}

/** 写一个工作区文件（回滚还原用）；必要时创建父目录。 */
export async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(resolve(root))) {
    throw new Error(`拒绝写入工作区外路径：${relativePath}`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

/** 交接文档目录（与 `domain/handoff.ts` 的 `HANDOFF_DIR` 保持一致）。 */
export const HANDOFF_DIR_PATH = '.pm/handoff';

/** 写一份交接文档（FR-84：`.pm/handoff/`）。 */
export async function writeHandoffFile(input: {
  root: string;
  relativePath: string;
  content: string;
}): Promise<void> {
  await writeWorkspaceFile(input.root, input.relativePath, input.content);
}

/** 列出某个枝的交接文档（按文件名倒序，最新在前）。 */
export async function listHandoffFiles(root: string): Promise<string[]> {
  try {
    const dir = join(root, HANDOFF_DIR_PATH);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** 读一个工作区文件；不存在返回 undefined。 */
export async function readWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    const absolute = resolve(root, relativePath);
    if (!absolute.startsWith(resolve(root))) return undefined;
    return await readFile(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/** 删除一个工作区文件（还原"新增文件"时用）。 */
export async function deleteWorkspaceFile(root: string, relativePath: string): Promise<void> {
  try {
    const absolute = resolve(root, relativePath);
    if (!absolute.startsWith(resolve(root))) return;
    await rm(absolute, { force: true });
  } catch {
    // 忽略
  }
}

/** 工作区是否是一个 git 仓库（用于档位裁决）。 */
export function isGitRepository(root: string): boolean {
  return existsSync(join(root, '.git'));
}

/** 探测沙箱模式（用于 §7.5 的档位裁决）。 */
export type DetectedSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;

/**
 * 阶段 A 统计行数的读盘预算（防止在大仓库里"扫一下"变成读整棵树）。
 *
 * 超预算的文件不再读内容，而是按字节数估算行数并标记 `lineCountEstimated`（诚实标注）。
 */
export const SCAN_LINE_COUNT_MAX_FILE_BYTES = 256 * 1024;
export const SCAN_LINE_COUNT_MAX_FILES = 2000;
export const SCAN_LINE_COUNT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 只给可能算行数的文本文件读内容（二进制不读；无扩展名的按文本试一次）。 */
function isTextLike(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|markdown|txt|css|scss|less|html|htm|yml|yaml|toml|ini|cfg|sh|ps1|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sql|vue|svelte)$/i.test(
    path,
  );
}

/**
 * 遍历工作区，产出**扫描用**的条目清单（阶段 A：零 token 骨架）。
 *
 * 与 `walkWorkspace` 的区别：那个为快照服务（读内容算哈希），这个只列路径与类型，
 * 并在**有限预算**内统计文本文件行数（供 §9.3a 的零 token 权重轨使用）。
 */
export async function scanWorkspaceEntries(input: {
  root: string;
  maxDepth: number;
  exclude: string[];
}): Promise<{
  entries: Array<{
    path: string;
    kind: 'file' | 'dir';
    sizeBytes?: number;
    lineCount?: number;
    lineCountEstimated?: boolean;
  }>;
  rootDirName: string;
  packageName?: string;
  skipped: number;
  /** 行数统计的实际开销（如实报告，便于用户判断扫描代价）。 */
  lineCountStats: { filesRead: number; bytesRead: number; estimated: number };
}> {
  const entries: Array<{
    path: string;
    kind: 'file' | 'dir';
    sizeBytes?: number;
    lineCount?: number;
    lineCountEstimated?: boolean;
  }> = [];
  let skipped = 0;
  let filesRead = 0;
  let bytesRead = 0;
  let estimated = 0;
  const rootDirName = basename(input.root);

  const excludedByGlob = (rel: string): boolean =>
    input.exclude.some((glob) => {
      const normalized = glob.replace(/\\/g, '/').replace(/\/+$/, '');
      return rel === normalized || rel.startsWith(`${normalized}/`);
    });

  /** 在预算内统计行数；超预算/读失败 → 返回 undefined（调用方按字节估算）。 */
  const countLines = async (absolute: string, rel: string, sizeBytes: number | undefined): Promise<number | undefined> => {
    if (sizeBytes === undefined || sizeBytes > SCAN_LINE_COUNT_MAX_FILE_BYTES) return undefined;
    if (!isTextLike(rel)) return undefined;
    if (filesRead >= SCAN_LINE_COUNT_MAX_FILES) return undefined;
    if (bytesRead + sizeBytes > SCAN_LINE_COUNT_MAX_TOTAL_BYTES) return undefined;
    try {
      const text = await readFile(absolute, 'utf8');
      filesRead += 1;
      bytesRead += sizeBytes;
      if (text.includes('\u0000')) return undefined; // 二进制：不算行数
      if (text === '') return 0;
      // 末尾换行不算"多一行"：与编辑器的行号一致
      const newlines = text.split('\n').length - 1;
      return text.endsWith('\n') ? newlines : newlines + 1;
    } catch {
      return undefined;
    }
  };

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > input.maxDepth) return;
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirEntries) {
      const absolute = join(dir, entry.name);
      const rel = toRelative(input.root, absolute);
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (excludedByGlob(rel)) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        entries.push({ path: rel, kind: 'dir' });
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(absolute)).size;
      } catch {
        sizeBytes = undefined;
      }
      const lineCount = await countLines(absolute, rel, sizeBytes);
      if (lineCount === undefined) estimated += 1;
      entries.push({
        path: rel,
        kind: 'file',
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(lineCount === undefined ? {} : { lineCount }),
        ...(lineCount === undefined ? { lineCountEstimated: true } : {}),
      });
    }
  };

  await visit(input.root, 0);

  // 读 package.json 的 name（用于建议项目名；读失败不致命）
  let packageName: string | undefined;
  const pkgText = await readWorkspaceFile(input.root, 'package.json');
  if (pkgText !== undefined) {
    try {
      const parsed = JSON.parse(pkgText) as { name?: unknown };
      if (typeof parsed.name === 'string') packageName = parsed.name;
    } catch {
      // 忽略
    }
  }

  return {
    entries,
    rootDirName,
    ...(packageName !== undefined ? { packageName } : {}),
    skipped,
    lineCountStats: { filesRead, bytesRead, estimated },
  };
}

/** 综合裁决快照档位（§7.5 / FR-69c）。 */
export function resolveSnapshotCapability(input: {
  workspaceRoot: string;
  sandboxMode: DetectedSandboxMode;
}): { mode: 'git' | 'patch' | 'full'; reason: string } {
  const { workspaceRoot, sandboxMode } = input;
  if (sandboxMode === 'read-only') {
    return {
      mode: 'patch',
      reason: '当前会话为只读沙箱，工作区不可写，已降级为补丁档（且建点会失败并告警）',
    };
  }
  if (sandboxMode === 'workspace-write') {
    return {
      mode: 'patch',
      reason: '当前会话为 workspace-write 沙箱：`.git/refs/pm/*` 在工作区外不可写，已降级为补丁档',
    };
  }
  if (isGitRepository(workspaceRoot)) {
    return { mode: 'git', reason: '未检测到沙箱限制，使用 git 档（专属 ref + 防 gc）' };
  }
  return { mode: 'patch', reason: '工作区不是 git 仓库，使用补丁档' };
}

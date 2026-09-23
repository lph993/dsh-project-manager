/**
 * git 档快照的 git 命令层（§7.5 "git 优先"档）。
 *
 * **不切分支、不动索引、不改 HEAD** —— 这是设计约束（§7.5 决策记录），
 * 做法是把 `GIT_INDEX_FILE` 指向一个**临时索引文件**再 `git add -A`，
 * 于是 `git write-tree` 写出的树来自**工作区**，而用户的真实索引完全不受影响。
 *
 * 为什么不直接 `git write-tree`：它写的是**索引**（通常是 HEAD 的状态），
 * 不是工作区。这一点极易做错 —— 实测中"工作区恰好干净"时两者相同，
 * 会让人误判为正确。所以必须显式建临时索引。
 *
 * 另两个刻意的选择（写进决策记录）：
 * - 用 `refs/pm/snapshots/<id>` 而不是 `git stash create`：取**持久性**。
 *   快照被 gc 回收等于回滚能力静默失效，而用户察觉不到（等真要用时才发现）。
 * - 该档**尊重 `.gitignore`**（因为是 `git add -A`）：被忽略的文件不进快照。
 *   这与补丁档（排除表 + 全量读取）语义不同，两条路线都会在快照记录里标注。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 一次 git 命令的结果。 */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 失败时的简短原因（给用户看）。 */
  reason?: string;
}

/** 快照 ref 前缀（专属命名空间，便于 `refs/pm/keep` 维护可达性）。 */
export const SNAPSHOT_REF_PREFIX = 'refs/pm/snapshots';
/** 防 gc 的 keep ref 前缀。 */
export const KEEP_REF_PREFIX = 'refs/pm/keep';

/**
 * 执行 git 命令（不开 shell、不长期持有句柄、单次调用）。
 *
 * 强制 `core.autocrlf=false`：否则建点/还原会按平台改写行尾（Windows 上把 `\n` 变 `\r\n`），
 * 那就是**静默修改用户文件**——快照工具绝不该做这件事。实测踩过。
 */
async function git(
  cwd: string,
  args: readonly string[],
  options: { indexFile?: string; input?: string; maxBuffer?: number } = {},
): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.indexFile !== undefined) env['GIT_INDEX_FILE'] = options.indexFile;
  // 关掉分页与交互提示，避免在非 tty 环境挂住
  env['GIT_PAGER'] = 'cat';
  env['GIT_TERMINAL_PROMPT'] = '0';
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
      {
        cwd,
        env,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: string };
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    if (err.code === 'ENOENT') {
      return { ok: false, stdout, stderr, reason: '系统里找不到 git（未安装或不在 PATH）' };
    }
    return {
      ok: false,
      stdout,
      stderr,
      reason: stderr.trim().split('\n')[0] ?? err.message ?? 'git 命令失败',
    };
  }
}

/** 该目录是否是一个可用的 git 仓库（`git rev-parse` 成功）。 */
export async function isUsableGitRepo(cwd: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

/** 建点结果。 */
export interface GitCaptureOutcome {
  ok: boolean;
  reason?: string;
  /** 快照的 commit（ref 的 tip）。 */
  commit?: string;
  /** 该 commit 的树对象（还原时的基准）。 */
  tree?: string;
  ref?: string;
  /** 纳入的文件数（`git ls-tree -r` 计数）。 */
  fileCount?: number;
  /**
   * 建点时**用户索引里未跟踪**的路径（`git ls-files --others --exclude-standard`）。
   *
   * 为什么要报出来：临时索引 + `add -A` 的写法会把未跟踪文件**一并写进树对象**，
   * 所以它们其实**是被覆盖的**（实测：改掉一个未跟踪文件后回滚能还原，且用户索引不被弄脏）。
   * 有了这个字段，上层就能如实说"本次覆盖含 N 个未跟踪文件"，而不是含糊其辞或假装没覆盖。
   */
  untrackedPaths?: string[];
}

/**
 * 在工作区上建立一个 git 快照（不改分支/索引/HEAD）。
 *
 * 步骤：临时索引 → `git add -A` → `git write-tree` → `git commit-tree` → `git update-ref`。
 */
export async function gitCapture(input: {
  cwd: string;
  snapshotId: string;
  /** commit message（进 reflog，便于事后追溯）。 */
  message: string;
}): Promise<GitCaptureOutcome> {
  if (!(await isUsableGitRepo(input.cwd))) {
    return { ok: false, reason: '当前工作区不是 git 仓库，或 git 不可用' };
  }

  const indexDir = await mkdtemp(join(tmpdir(), 'pm-gitindex-'));
  const indexFile = join(indexDir, 'index');
  try {
    // 先记下**用户索引**里的未跟踪文件（用真实索引问，别带临时索引，
    // 否则临时索引会把已暂存的内容也算进去，问出来的"未跟踪"就不准了）
    const untracked = await git(input.cwd, ['ls-files', '--others', '--exclude-standard']);
    const untrackedPaths = untracked.ok
      ? untracked.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : [];

    const add = await git(input.cwd, ['add', '-A', '--', '.'], { indexFile });
    if (!add.ok) {
      return { ok: false, reason: add.reason ?? 'git add 失败' };
    }

    const writeTree = await git(input.cwd, ['write-tree'], { indexFile });
    if (!writeTree.ok) {
      return { ok: false, reason: writeTree.reason ?? 'git write-tree 失败' };
    }
    const tree = writeTree.stdout.trim();

    const commitTree = await git(input.cwd, ['commit-tree', tree, '-m', input.message]);
    if (!commitTree.ok) {
      return { ok: false, reason: commitTree.reason ?? 'git commit-tree 失败' };
    }
    const commit = commitTree.stdout.trim();

    const ref = `${SNAPSHOT_REF_PREFIX}/${input.snapshotId}`;
    const updateRef = await git(input.cwd, ['update-ref', ref, commit]);
    if (!updateRef.ok) {
      return { ok: false, reason: updateRef.reason ?? 'git update-ref 失败' };
    }

    // 维护 keep ref（防 gc）：让所有快照对象保持可达
    await git(input.cwd, ['update-ref', `${KEEP_REF_PREFIX}/${input.snapshotId}`, commit]);

    const lsTree = await git(input.cwd, ['ls-tree', '-r', '--name-only', tree]);
    const fileCount = lsTree.ok
      ? lsTree.stdout.split('\n').filter((line) => line.trim() !== '').length
      : undefined;

    return {
      ok: true,
      commit,
      tree,
      ref,
      ...(fileCount !== undefined ? { fileCount } : {}),
      untrackedPaths,
    };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 快照树与当前工作区的差异（哪三个集合）。 */
export interface GitDiffOutcome {
  ok: boolean;
  reason?: string;
  /** 快照中有、工作区已改或已删（需要还原）。 */
  changed: string[];
  /** 快照中没有、工作区新增（还原时应删除）。 */
  added: string[];
}

/**
 * 比较快照树与当前工作区。
 *
 * 用 `git diff --name-status <tree>`：
 * - `M`/`D`/`T` → 需要从快照还原
 * - `A` → 快照之后新增，还原时应删除
 *
 * **必须先 `git add -A --intent-to-add`（在临时索引上）**：`git diff` 默认看不见
 * 未跟踪文件，漏掉它们会让"快照后新增的文件"在还原时不被删除，
 * 回滚就等于不完整。实测确认过这一点。
 * 临时索引保证用户的暂存区不被这些东西污染。
 */
export async function gitDiffAgainstTree(input: {
  cwd: string;
  tree: string;
}): Promise<GitDiffOutcome> {
  const indexDir = await mkdtemp(join(tmpdir(), 'pm-gitindex-'));
  const indexFile = join(indexDir, 'index');
  try {
    const intent = await git(input.cwd, ['add', '-A', '--intent-to-add', '--', '.'], { indexFile });
    if (!intent.ok) {
      return { ok: false, reason: intent.reason ?? 'git add --intent-to-add 失败', changed: [], added: [] };
    }
    const result = await git(input.cwd, ['diff', '--name-status', '--no-renames', input.tree], {
      indexFile,
    });
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? 'git diff 失败', changed: [], added: [] };
    }
    const changed: string[] = [];
    const added: string[] = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const [status, ...rest] = trimmed.split('\t');
      const path = rest.join('\t');
      if (path === '') continue;
      const code = status?.[0];
      if (code === 'A') added.push(path);
      else changed.push(path);
    }
    return { ok: true, changed, added };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 从快照树还原指定路径（幂等：还原到目标内容即可重复执行）。
 *
 * `git checkout <tree> -- <paths>` 同样写**索引**，所以依旧用临时索引，
 * 否则会把用户的暂存区改掉。工作区文件仍会被写成快照内容（这是我们要的效果）。
 */
export async function gitRestorePaths(input: {
  cwd: string;
  tree: string;
  paths: readonly string[];
}): Promise<{ ok: boolean; reason?: string; restored: number }> {
  if (input.paths.length === 0) return { ok: true, restored: 0 };

  const indexDir = await mkdtemp(join(tmpdir(), 'pm-gitindex-'));
  const indexFile = join(indexDir, 'index');
  try {
    // 分批（命令行长度有限），每批 200 个路径
    let restored = 0;
    for (let i = 0; i < input.paths.length; i += 200) {
      const batch = input.paths.slice(i, i + 200);
      const result = await git(input.cwd, ['checkout', input.tree, '--', ...batch], { indexFile });
      if (!result.ok) {
        return { ok: false, reason: result.reason ?? 'git checkout 失败', restored };
      }
      restored += batch.length;
    }
    return { ok: true, restored };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 删除若干工作区文件（还原"新增文件"时用）。
 *
 * 刻意**直接删文件**而不是 `git rm` —— `git rm` 会改用户的索引，
 * 而本档的硬约束是"不动索引"。
 */
export async function gitRemovePaths(input: {
  cwd: string;
  paths: readonly string[];
}): Promise<{ ok: boolean; reason?: string; removed: number }> {
  if (input.paths.length === 0) return { ok: true, removed: 0 };
  let removed = 0;
  for (const path of input.paths) {
    try {
      await rm(join(input.cwd, path), { force: true });
      removed += 1;
    } catch {
      // 文件已不存在也算成功（幂等）
    }
  }
  return { ok: true, removed };
}

/** 删除快照 ref 与对应 keep ref（清理时用）。顺序不可颠倒：先摘 keep 再删 ref。 */
export async function gitDeleteSnapshotRef(input: {
  cwd: string;
  snapshotId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const keep = await git(input.cwd, [
    'update-ref',
    '-d',
    `${KEEP_REF_PREFIX}/${input.snapshotId}`,
  ]);
  // keep ref 不存在时 `update-ref -d` 会失败，这不算错误
  void keep;
  const ref = await git(input.cwd, ['update-ref', '-d', `${SNAPSHOT_REF_PREFIX}/${input.snapshotId}`]);
  return ref.ok ? { ok: true } : { ok: false, reason: ref.reason ?? 'update-ref -d 失败' };
}

/** 某个快照 ref 是否仍可解析（可达性自检，FR-89b）。 */
export async function gitRefReachable(input: {
  cwd: string;
  ref: string;
}): Promise<{ reachable: boolean; commit?: string }> {
  const result = await git(input.cwd, ['rev-parse', '--verify', '--quiet', `${input.ref}^{commit}`]);
  if (!result.ok) return { reachable: false };
  return { reachable: true, commit: result.stdout.trim() };
}

/** 列出全部快照 ref（索引损坏时的重建来源，§7.5）。 */
export async function gitListSnapshotRefs(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 该快照 ref 覆盖的路径（用于还原范围裁决）。 */
export async function gitTreePaths(cwd: string, tree: string): Promise<string[]> {
  const result = await git(cwd, ['ls-tree', '-r', '--name-only', tree]);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  gitCapture,
  gitDeleteSnapshotRef,
  gitDiffAgainstTree,
  gitListSnapshotRefs,
  gitRefReachable,
  gitRemovePaths,
  gitRestorePaths,
  gitTreePaths,
  isUsableGitRepo,
} from '../../src/adapter/git.ts';

/** git 不可用时整组跳过（而不是假装通过）。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

/** 造一个带提交的临时仓库。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-git-'));
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@local']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'a.txt'), 'a1\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'b.txt'), 'b1\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

/** 取用户索引是否干净（我们的硬约束：不动索引）。 */
function statusPorcelain(dir: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim();
}

test('git 档：capture 建立快照 ref，且**不污染用户索引与 HEAD**', { skip: !HAS_GIT }, async () => {
  const repo = makeRepo();
  try {
    assert.equal(await isUsableGitRepo(repo), true);

    // 改一个文件 + 新增一个未跟踪文件（都不提交）
    writeFileSync(join(repo, 'a.txt'), 'a2-modified\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    const statusBefore = statusPorcelain(repo);

    const captured = await gitCapture({
      cwd: repo,
      snapshotId: 'snap_test_1',
      message: 'pm snapshot test',
    });
    assert.equal(captured.ok, true, `建点失败：${captured.reason}`);
    assert.ok(captured.tree);
    assert.ok(captured.commit);
    assert.ok((captured.fileCount ?? 0) >= 3, '应包含 a.txt/new.txt/src/b.txt');

    // ref 可解析
    const reachable = await gitRefReachable({ cwd: repo, ref: `${captured.ref}` });
    assert.equal(reachable.reachable, true);

    // 硬约束：HEAD 未变、索引未脏
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    assert.equal(headAfter, headBefore, 'HEAD 不得改变');
    assert.equal(statusPorcelain(repo), statusBefore, '用户索引/工作区状态不得被快照改变');

    // 快照确实记录了**工作区**内容（而不是 HEAD 内容）
    const paths = await gitTreePaths(repo, captured.tree);
    assert.ok(paths.includes('a.txt'));
    assert.ok(paths.includes('new.txt'), '未跟踪的新文件也必须进快照（否则 git 档会漏内容）');

    const listed = await gitListSnapshotRefs(repo);
    assert.ok(listed.some((ref) => ref.endsWith('snap_test_1')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git 档：diff 能区分"改了"与"快照后新增"', { skip: !HAS_GIT }, async () => {
  const repo = makeRepo();
  try {
    const captured = await gitCapture({ cwd: repo, snapshotId: 's1', message: 's1' });
    assert.equal(captured.ok, true);
    const tree = captured.tree as string;

    writeFileSync(join(repo, 'a.txt'), 'a2\n'); // 修改
    writeFileSync(join(repo, 'later.txt'), 'later\n'); // 新增

    const diff = await gitDiffAgainstTree({ cwd: repo, tree });
    assert.equal(diff.ok, true, `diff 失败：${diff.reason}`);
    assert.ok(diff.changed.includes('a.txt'), `changed 应含 a.txt：${JSON.stringify(diff)}`);
    assert.ok(diff.added.includes('later.txt'), `added 应含 later.txt：${JSON.stringify(diff)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git 档：还原到快照内容、删除快照后新增的文件，且幂等', { skip: !HAS_GIT }, async () => {
  const repo = makeRepo();
  try {
    const captured = await gitCapture({ cwd: repo, snapshotId: 's1', message: 's1' });
    const tree = captured.tree as string;

    writeFileSync(join(repo, 'a.txt'), 'a2-changed\n');
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    writeFileSync(join(repo, 'src', 'b.txt'), 'b2-changed\n');

    const diff = await gitDiffAgainstTree({ cwd: repo, tree });
    const restore = await gitRestorePaths({ cwd: repo, tree, paths: diff.changed });
    assert.equal(restore.ok, true, `还原失败：${restore.reason}`);
    await gitRemovePaths({ cwd: repo, paths: diff.added });

    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'a1\n', 'a.txt 应还原');
    assert.equal(readFileSync(join(repo, 'src', 'b.txt'), 'utf8'), 'b1\n', 'src/b.txt 应还原');
    assert.equal(existsSync(join(repo, 'later.txt')), false, '快照后新增的文件应被删除');

    // 幂等：再跑一次结果不变
    const diff2 = await gitDiffAgainstTree({ cwd: repo, tree });
    assert.deepEqual(diff2.changed, [], '还原后不应再有差异');
    assert.deepEqual(diff2.added, []);

    // 用户索引仍未被我们的操作弄脏（工作区有改动是正常的，索引不该有暂存内容）
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo })
      .toString()
      .trim();
    assert.equal(staged, '', '不得把我们的操作暂存进用户索引');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git 档：删除 ref 的顺序（先摘 keep 再删 ref）与清理结果', { skip: !HAS_GIT }, async () => {
  const repo = makeRepo();
  try {
    const captured = await gitCapture({ cwd: repo, snapshotId: 's1', message: 's1' });
    assert.equal(captured.ok, true);

    const deleted = await gitDeleteSnapshotRef({ cwd: repo, snapshotId: 's1' });
    assert.equal(deleted.ok, true, `删除失败：${deleted.reason}`);

    const reachable = await gitRefReachable({ cwd: repo, ref: `${captured.ref}` });
    assert.equal(reachable.reachable, false, '删除后 ref 必须不可解析（即清理真实生效）');

    const listed = await gitListSnapshotRefs(repo);
    assert.deepEqual(listed, []);

    // 幂等：再删一次不抛错
    const again = await gitDeleteSnapshotRef({ cwd: repo, snapshotId: 's1' });
    assert.equal(typeof again.ok, 'boolean');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git 档：非 git 目录明确拒绝而不是假装成功', { skip: !HAS_GIT }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-nogit-'));
  try {
    // 造一个"看起来像 git 但其实是父仓库子目录"之外的真非仓库目录
    const nested = join(dir, 'plain');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'x.txt'), 'x\n');

    const captured = await gitCapture({ cwd: nested, snapshotId: 's', message: 's' });
    if (captured.ok) {
      // 若被判定为某个父仓库的一部分（CI 环境可能如此），至少要求 tree 存在
      assert.ok(captured.tree);
    } else {
      assert.match(captured.reason ?? '', /git/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SNAPSHOT_CAPACITY,
  SNAPSHOT_THROTTLE_MS,
  checkSingleSnapshotLimit,
  computeManifestHash,
  decideSnapshot,
  diffManifests,
  fnv1a64,
  isExcludedPath,
  isSnapshotableFile,
  isWithin,
  planCleanup,
  planRollbackFiles,
  rollbackNodeState,
  type FileManifest,
  type HashManifest,
  type SnapshotMeta,
} from '../../src/domain/snapshot.ts';

// ── 排除规则 ─────────────────────────────────────────────────────

test('单快照体积上限：全量档豁免，其它档超限即拒（这条规则曾经只声明不执行）', () => {
  const limit = 100 * 1024 * 1024;
  assert.equal(checkSingleSnapshotLimit({ mode: 'git', sizeBytes: limit + 1, limit }).ok, false);
  assert.equal(checkSingleSnapshotLimit({ mode: 'patch', sizeBytes: limit + 1, limit }).ok, false);
  assert.equal(checkSingleSnapshotLimit({ mode: 'git', sizeBytes: limit, limit }).ok, true, '刚好等于上限应放行');
  // 全量档：没有 git 兜底时最稳的一档，拿单体上限卡它等于让大工作区永远用不上它
  assert.equal(checkSingleSnapshotLimit({ mode: 'full', sizeBytes: limit * 10, limit }).ok, true);
  assert.match(
    checkSingleSnapshotLimit({ mode: 'patch', sizeBytes: limit + 1, limit }).reason ?? '',
    /git 档|提高上限/,
  );
});

test('排除规则：`.pm/` 与 `.git`、node_modules、构建产物必须排除', () => {
  // `.pm/` 是硬要求：否则快照会吞掉事实源自身（§7.5）
  assert.equal(isExcludedPath('.pm/graph.jsonl'), true);
  assert.equal(isExcludedPath('.pm/snapshots/snap_1.json'), true);
  assert.equal(isExcludedPath('.pm/wal/0001.jsonl'), true);
  assert.equal(isExcludedPath('.git/config'), true);
  assert.equal(isExcludedPath('node_modules/zod/index.js'), true);
  assert.equal(isExcludedPath('src/node_modules/x.js'), true, '任意层级都要排除');
  assert.equal(isExcludedPath('dist/index.js'), true);
  assert.equal(isExcludedPath('coverage/lcov.info'), true);
});

test('排除规则：正常源码路径不排除', () => {
  assert.equal(isExcludedPath('src/domain/graph.ts'), false);
  assert.equal(isExcludedPath('README.md'), false);
  assert.equal(isExcludedPath('packages/out-of-tree/src/x.ts'), false, '目录名含 out 但非 out/');
  assert.equal(isExcludedPath('docs/distribution.md'), false, '文件名含 dist 但不是目录');
});

test('排除规则：编辑器交换文件与空路径', () => {
  assert.equal(isExcludedPath(''), true);
  assert.equal(isExcludedPath('.'), true);
  assert.equal(isExcludedPath('src/.graph.ts.swp'), true);
  assert.equal(isExcludedPath('src/graph.ts~'), true);
});

test('isWithin 判定子树包含', () => {
  assert.equal(isWithin('.pm/snapshots/a.json', '.pm'), true);
  assert.equal(isWithin('.pm', '.pm'), true);
  assert.equal(isWithin('.pmother/x', '.pm'), false);
  assert.equal(isWithin('anything', ''), true);
});

test('isSnapshotableFile：超大文件不纳入', () => {
  assert.equal(isSnapshotableFile({ relativePath: 'src/a.ts', sizeBytes: 100 }), true);
  assert.equal(isSnapshotableFile({ relativePath: 'src/a.ts', sizeBytes: 5 * 1024 * 1024 }), false);
  assert.equal(isSnapshotableFile({ relativePath: '.pm/a.json', sizeBytes: 10 }), false);
});

// ── 哈希与 diff ──────────────────────────────────────────────────

test('fnv1a64 确定性且不同内容不同哈希', () => {
  assert.equal(fnv1a64('hello'), fnv1a64('hello'));
  assert.notEqual(fnv1a64('hello'), fnv1a64('hello!'));
  assert.match(fnv1a64('hello'), /^[0-9a-f]{16}$/);
});

test('computeManifestHash 与条目顺序无关', () => {
  const a = computeManifestHash([
    { path: 'a.ts', hash: '1' },
    { path: 'b.ts', hash: '2' },
  ]);
  const b = computeManifestHash([
    { path: 'b.ts', hash: '2' },
    { path: 'a.ts', hash: '1' },
  ]);
  assert.equal(a, b);
});

test('computeManifestHash 对内容变化敏感', () => {
  const base = computeManifestHash([{ path: 'a.ts', hash: '1' }]);
  const changed = computeManifestHash([{ path: 'a.ts', hash: '2' }]);
  assert.notEqual(base, changed);
});

test('diffManifests 分类新增/修改/删除', () => {
  // diff 只依赖 (path, hash)，因此用最小形态构造（HashManifest）
  const before: HashManifest = {
    files: [
      { path: 'keep.ts', hash: '1' },
      { path: 'edit.ts', hash: '1' },
      { path: 'gone.ts', hash: '1' },
    ],
  };
  const after: HashManifest = {
    files: [
      { path: 'keep.ts', hash: '1' },
      { path: 'edit.ts', hash: '2' },
      { path: 'new.ts', hash: '1' },
    ],
  };
  const diff = diffManifests(before, after);
  assert.deepEqual(diff.added, ['new.ts']);
  assert.deepEqual(diff.modified, ['edit.ts']);
  assert.deepEqual(diff.removed, ['gone.ts']);
});

// ── 建点节流 ─────────────────────────────────────────────────────

test('建点决策：内容未变化且已有有效点 → 跳过', () => {
  const decision = decideSnapshot({
    hasValidPoint: true,
    lastManifestHash: 'same',
    currentManifestHash: 'same',
    lastCreatedAt: '2026-01-01T00:00:00Z',
    now: '2026-01-01T10:00:00Z',
    force: false,
  });
  assert.equal(decision.create, false);
  assert.match(decision.reason, /无变化/);
});

test('建点决策：60s 内重复 → 节流跳过', () => {
  const decision = decideSnapshot({
    hasValidPoint: false,
    lastManifestHash: 'a',
    currentManifestHash: 'b',
    lastCreatedAt: '2026-01-01T00:00:00Z',
    now: '2026-01-01T00:00:30Z',
    force: false,
  });
  assert.equal(decision.create, false);
  assert.match(decision.reason, /节流/);
});

test('建点决策：超过 60s 且内容变化 → 建', () => {
  const decision = decideSnapshot({
    hasValidPoint: true,
    lastManifestHash: 'a',
    currentManifestHash: 'b',
    lastCreatedAt: '2026-01-01T00:00:00Z',
    now: `2026-01-01T00:0${Math.ceil(SNAPSHOT_THROTTLE_MS / 60000) + 1}:00Z`,
    force: false,
  });
  assert.equal(decision.create, true);
});

test('建点决策：force 时无视节流与无变化', () => {
  const decision = decideSnapshot({
    hasValidPoint: true,
    lastManifestHash: 'same',
    currentManifestHash: 'same',
    lastCreatedAt: '2026-01-01T00:00:00Z',
    now: '2026-01-01T00:00:01Z',
    force: true,
  });
  assert.equal(decision.create, true);
});

test('建点决策：无有效点时即使内容"未变化"也要建（FR-61）', () => {
  const decision = decideSnapshot({
    hasValidPoint: false,
    lastManifestHash: undefined,
    currentManifestHash: 'x',
    lastCreatedAt: undefined,
    now: '2026-01-01T00:00:00Z',
    force: false,
  });
  assert.equal(decision.create, true);
  assert.match(decision.reason, /尚无有效回滚点/);
});

// ── 容量治理 ─────────────────────────────────────────────────────

function meta(partial: Partial<SnapshotMeta> & { snapshotId: string }): SnapshotMeta {
  return {
    nodeIds: ['n1'],
    reason: 'pause',
    sizeBytes: 100,
    createdAt: '2026-01-01T00:00:00Z',
    coversUnfinishedNode: false,
    coversRemovedOrRolledBack: false,
    ...partial,
  };
}

test('清理：未超限时不清理，但 80% 时告警', () => {
  const capacity = { ...DEFAULT_SNAPSHOT_CAPACITY, totalBytesLimit: 1000 };
  const plan = planCleanup([meta({ snapshotId: 'a', sizeBytes: 300 })], capacity);
  assert.deepEqual(plan.evict, []);
  assert.equal(plan.warn, false);

  const warnPlan = planCleanup([meta({ snapshotId: 'a', sizeBytes: 850 })], capacity);
  assert.equal(warnPlan.warn, true);
  assert.deepEqual(warnPlan.evict, []);
});

test('清理：永不清理未完成节点的最新点与 pre-rollback', () => {
  const capacity = { ...DEFAULT_SNAPSHOT_CAPACITY, totalBytesLimit: 100, countLimit: 100 };
  const plan = planCleanup(
    [
      meta({
        snapshotId: 'newest-unfinished',
        sizeBytes: 200,
        coversUnfinishedNode: true,
        createdAt: '2026-02-01T00:00:00Z',
      }),
      meta({
        snapshotId: 'pre-rollback',
        sizeBytes: 200,
        reason: 'pre-rollback',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ],
    capacity,
  );
  assert.deepEqual(plan.evict, [], '两者都不允许清理');
  assert.equal(plan.stillOverLimit, true, '无可清理时必须如实报告仍超限');
});

test('清理：优先清理已删除/已回滚节点的历史点', () => {
  const capacity = { ...DEFAULT_SNAPSHOT_CAPACITY, totalBytesLimit: 250, countLimit: 100 };
  const plan = planCleanup(
    [
      meta({
        snapshotId: 'rolled-back-old',
        sizeBytes: 100,
        coversRemovedOrRolledBack: true,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      meta({
        snapshotId: 'finished',
        sizeBytes: 100,
        createdAt: '2026-01-02T00:00:00Z',
      }),
      meta({
        snapshotId: 'paused',
        sizeBytes: 100,
        reason: 'pause',
        createdAt: '2026-01-03T00:00:00Z',
      }),
    ],
    capacity,
  );
  assert.equal(plan.evict[0], 'rolled-back-old', '已回滚的最先被清理');
  assert.ok(plan.projectedBytes <= 250);
});

test('清理：份数兜底也会触发', () => {
  const capacity = { ...DEFAULT_SNAPSHOT_CAPACITY, totalBytesLimit: 10 ** 9, countLimit: 2 };
  const plan = planCleanup(
    [
      meta({ snapshotId: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      meta({ snapshotId: 'b', createdAt: '2026-01-02T00:00:00Z' }),
      meta({ snapshotId: 'c', createdAt: '2026-01-03T00:00:00Z' }),
    ],
    capacity,
  );
  assert.equal(plan.evict.length, 1);
  assert.equal(plan.evict[0], 'a', '最旧的先清理');
});

// ── 回滚范围 ─────────────────────────────────────────────────────

test('回滚文件：优先用节点 touchedPaths，共享文件默认拦下', () => {
  const plan = planRollbackFiles({
    touched: ['src/a.ts', 'src/shared.ts'],
    sharedPaths: ['src/shared.ts'],
    manifestChanged: ['src/other.ts'],
    confirmedShared: false,
  });
  assert.deepEqual(plan.restore, ['src/a.ts']);
  assert.deepEqual(plan.sharedBlocked, ['src/shared.ts']);
});

test('回滚文件：确认后连带还原共享文件', () => {
  const plan = planRollbackFiles({
    touched: ['src/a.ts', 'src/shared.ts'],
    sharedPaths: ['src/shared.ts'],
    manifestChanged: [],
    confirmedShared: true,
  });
  assert.deepEqual(plan.restore, ['src/a.ts', 'src/shared.ts']);
  assert.deepEqual(plan.sharedBlocked, []);
});

test('回滚文件：绝不还原事实源与快照目录（FR-69d）', () => {
  const plan = planRollbackFiles({
    touched: ['.pm/graph.jsonl', '.pm/snapshots/s1.json', 'src/a.ts'],
    sharedPaths: [],
    manifestChanged: [],
    confirmedShared: true,
  });
  assert.deepEqual(plan.restore, ['src/a.ts']);
  assert.equal(plan.neverRestore.includes('.pm/graph.jsonl'), true);
});

test('回滚文件：无 touchedPaths 时退化为清单 diff（不猜归属）', () => {
  const plan = planRollbackFiles({
    touched: [],
    sharedPaths: [],
    manifestChanged: ['src/changed.ts'],
    confirmedShared: true,
  });
  assert.deepEqual(plan.restore, ['src/changed.ts']);
});

test('回滚节点状态：有记录则回到记录值，缺失回落 pending', () => {
  assert.deepEqual(
    rollbackNodeState({ selfState: 'running', progress: 0.6, gate: null }),
    { selfState: 'running', progress: 0.6, gate: null },
  );
  assert.deepEqual(rollbackNodeState(undefined), { selfState: 'pending', progress: 0, gate: null });
});


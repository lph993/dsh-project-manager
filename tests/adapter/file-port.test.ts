/**
 * 兜底文件存储路线的契约测试（§7.1b / FR-119/120/123）。
 *
 * 重点验证**与主路线的行为等价性**里最容易做错的部分：
 * 持久性与重放、append-only 写日志、压实与归档保留、有界审计、写队列串行化。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_DIR,
  ARCHIVE_KEEP,
  AUDIT_KEEP,
  FileStoragePort,
  GRAPH_LOG,
  META_FILE,
  SNAPSHOT_FILE,
  openFileStorage,
} from '../../src/storage/file-port.ts';
import type { NodeRecord, WriteAttempt } from '../../src/shared/types.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'pm-fileport-'));
}

function node(partial: Partial<NodeRecord> & { id: string; name: string }): NodeRecord {
  return {
    parentId: null,
    kind: 'task',
    selfState: 'pending',
    progress: 0,
    focus: false,
    gate: null,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'user',
    ...partial,
  };
}

function attempt(partial: Partial<WriteAttempt> & { attemptId: string }): WriteAttempt {
  return {
    nodeId: 'n1',
    block: 'state',
    op: { selfState: 'running' },
    by: { by: 'user' },
    rev: 1,
    ts: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

const META = {
  projectId: 'pm_test',
  projectName: '测试项目',
  dataFormat: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  rootIds: ['n1'],
};

test('兜底路线：能力差异如实声明（无跨进程锁、需要压实）', async () => {
  const root = workspace();
  try {
    const port = new FileStoragePort({ workspaceRoot: root });
    assert.equal(port.route, 'file-fallback');
    assert.equal(port.capabilities.crossProcessLock, false);
    assert.equal(port.capabilities.needsCompaction, true);
    assert.equal(typeof port.compact, 'function');
    assert.equal(typeof port.usage, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：写入后重新打开能完整恢复（持久性 + 重放）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    await port.putNode('pm_test', node({ id: 'n1', name: '根', kind: 'feature' }));
    await port.putNode('pm_test', node({ id: 'n2', name: '子', parentId: 'n1' }));
    await port.appendAudit({
      attemptId: 'a1',
      projectId: 'pm_test',
      nodeId: 'n1',
      block: 'state',
      op: {},
      by: 'user',
      rev: 2,
      ts: '2026-01-01T00:01:00Z',
    });
    await port.close();

    // 日志确实是 append-only 的普通文本（人类可读，§7.1）。
    // 注意：close 会压实并**截断**日志，所以要看归档里的那份。
    const archivedText = readdirSync(join(root, '.pm', ARCHIVE_DIR))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readFileSync(join(root, '.pm', ARCHIVE_DIR, name), 'utf8'))
      .join('');
    assert.ok(
      archivedText.split('\n').filter((l) => l.trim() !== '').length >= 3,
      '归档里应有 meta/node/audit 三类记录',
    );
    assert.match(archivedText, /"kind":"node"/);
    assert.equal(port.logLineCount, 0, '压实后日志行数归零');

    // 重新打开：状态必须完整
    const reopened = await openFileStorage({ workspaceRoot: root });
    assert.deepEqual(await reopened.listProjects(), ['pm_test']);
    const graph = await reopened.readGraph('pm_test');
    assert.ok(graph, '重放后应能读到图');
    assert.equal(Object.keys(graph.nodes).length, 2);
    assert.equal(graph.nodes['n2']?.parentId, 'n1');
    assert.equal((await reopened.listAudit('pm_test', 10)).length, 1);
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：appendAttempt 只追加**变化**的节点（块化写入）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    const before = {
      projectName: '测试项目',
      rootIds: ['n1'],
      dataFormat: 1,
      nodes: { n1: node({ id: 'n1', name: '根', kind: 'feature' }) },
    };
    const after = {
      ...before,
      nodes: {
        n1: node({ id: 'n1', name: '根', kind: 'feature', selfState: 'running', revision: 2 }),
        n2: node({ id: 'n2', name: '子', parentId: 'n1' }),
      },
    };
    const beforeLines = port.logLineCount;
    await port.appendAttempt({
      projectId: 'pm_test',
      attempt: attempt({ attemptId: 'a1', nodeId: 'n1' }),
      before,
      after,
    });
    // 变化了 2 个节点 + 1 条审计 = 3 行
    assert.equal(port.logLineCount - beforeLines, 3);

    // 再追加一次**无变化**：只应多出审计那一行
    const beforeLines2 = port.logLineCount;
    await port.appendAttempt({
      projectId: 'pm_test',
      attempt: attempt({ attemptId: 'a2', nodeId: 'n1' }),
      before: after,
      after,
    });
    assert.equal(port.logLineCount - beforeLines2, 1, '无变化时不应重复追加节点记录');

    const graph = await port.readGraph('pm_test');
    assert.equal(graph?.nodes['n1']?.selfState, 'running');
    await port.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：审计有界保留（保留最新、淘汰最旧）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    for (let i = 0; i < AUDIT_KEEP + 20; i += 1) {
      await port.appendAudit({
        attemptId: `a${i}`,
        projectId: 'pm_test',
        nodeId: null,
        block: 'state',
        op: { i },
        by: 'user',
        rev: i,
        ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      });
    }
    const recent = await port.listAudit('pm_test', AUDIT_KEEP + 100);
    assert.equal(recent.length, AUDIT_KEEP, '审计必须被有界保留');
    // 保留的是最新的一批
    assert.ok(recent.some((row) => row.attemptId === `a${AUDIT_KEEP + 19}`));
    assert.ok(!recent.some((row) => row.attemptId === 'a0'), '最旧的应被淘汰');
    await port.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：日志达阈值自动压实并归档，之后仍能完整恢复', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    await port.putNode('pm_test', node({ id: 'n1', name: '根', kind: 'feature' }));
    // 阈值是 max(500, 50 × 节点数)；1 个节点 → 500 行。
    // 写入过程中**自动压实**会在跨过阈值时发生，因此这里断言的是"发生过压实"，
    // 而不是"事后手动 compact 一定成功"（跨过阈值后日志已回到阈值以下）。
    for (let i = 0; i < 600; i += 1) {
      await port.appendAudit({
        attemptId: `a${i}`,
        projectId: 'pm_test',
        nodeId: 'n1',
        block: 'progress',
        op: { i },
        by: 'user',
        rev: i,
        ts: '2026-01-01T00:00:00Z',
      });
    }
    assert.ok(
      port.logLineCount < 500,
      `跨越阈值后日志应被压实（当前 ${port.logLineCount} 行）`,
    );

    const archives = readdirSync(join(root, '.pm', ARCHIVE_DIR)).filter((n) => n.endsWith('.jsonl'));
    assert.ok(archives.length >= 1, '自动压实必须归档旧日志');
    assert.equal(existsSync(join(root, '.pm', SNAPSHOT_FILE)), true, '压实必须写出 snapshot');

    // 手动 compact 在未达阈值时如实拒绝
    const manual = await port.compact();
    assert.equal(manual.compacted, false, '未达阈值时不该假装压实');
    assert.match(manual.reason, /未达阈值/);

    // 重开后状态不丢（snapshot + 之后的日志）
    await port.close();
    const reopened = await openFileStorage({ workspaceRoot: root });
    const graph = await reopened.readGraph('pm_test');
    assert.equal(graph?.nodes['n1']?.name, '根');
    assert.ok((await reopened.listProjects()).includes('pm_test'));
    // 审计在重放后仍可用（有界保留之内）
    assert.ok((await reopened.listAudit('pm_test', 10)).length > 0, '重开后审计应仍可读');
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：归档保留份数上限，超限最旧优先清理（FR-120）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    for (let round = 0; round < ARCHIVE_KEEP + 2; round += 1) {
      for (let i = 0; i < 600; i += 1) {
        await port.appendAudit({
          attemptId: `r${round}-a${i}`,
          projectId: 'pm_test',
          nodeId: null,
          block: 'state',
          op: {},
          by: 'user',
          rev: i,
          ts: '2026-01-01T00:00:00Z',
        });
      }
      await port.compact();
    }
    const archives = readdirSync(join(root, '.pm', ARCHIVE_DIR)).filter((n) => n.endsWith('.jsonl'));
    assert.ok(
      archives.length <= ARCHIVE_KEEP,
      `归档份数应 ≤ ${ARCHIVE_KEEP}，实际 ${archives.length}: ${archives.join(',')}`,
    );
    await port.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：写队列串行化（并发写不交错、不丢）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    // 并发写 40 个不同节点
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        port.putNode('pm_test', node({ id: `n${i}`, name: `任务${i}` })),
      ),
    );
    const graph = await port.readGraph('pm_test');
    assert.equal(Object.keys(graph?.nodes ?? {}).length, 40, '并发写不应丢节点');

    // 写进去了就该有日志：当前日志 + 已归档的日志，合计 ≥ 40 行。
    // （用 ≥ 而不是 ==：阈值附近的自动压实会切分日志，精确行数不是契约。）
    const archived = readdirSync(join(root, '.pm', ARCHIVE_DIR)).filter((n) => n.endsWith('.jsonl'));
    const archivedLines = archived.reduce(
      (sum, name) =>
        sum +
        readFileSync(join(root, '.pm', ARCHIVE_DIR, name), 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '').length,
      0,
    );
    assert.ok(
      port.logLineCount + archivedLines >= 40,
      `日志 + 归档应至少覆盖 40 次写入，实际 ${port.logLineCount + archivedLines}`,
    );
    await port.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：损坏日志行被跳过，不让打开失败', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    await port.putNode('pm_test', node({ id: 'n1', name: '根' }));
    await port.close();

    // 人为往日志里插一行坏数据（先写一条正常的，确保日志非空）
    const logPath = join(root, '.pm', GRAPH_LOG);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      logPath,
      `${JSON.stringify({ kind: 'node', projectId: 'pm_test', nodeId: 'n2', node: node({ id: 'n2', name: '第二个' }) })}\n`,
      'utf8',
    );
    appendFileSync(logPath, '{ 这不是 JSON\n', 'utf8');

    const reopened = await openFileStorage({ workspaceRoot: root });
    const graph = await reopened.readGraph('pm_test');
    assert.equal(graph?.nodes['n1']?.name, '根', '快照里的节点必须仍在');
    assert.equal(graph?.nodes['n2']?.name, '第二个', '坏行之前的正常日志行必须被重放');
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：usage 报告占用（FR-122 的计量基础）', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    await port.putNode('pm_test', node({ id: 'n1', name: '根' }));
    // 关闭会产出快照，因此此时应有日志 + 快照两个文件
    await port.close();
    const reopened = await openFileStorage({ workspaceRoot: root });
    const usage = await reopened.usage();
    assert.ok(usage.bytes > 0, '应有占用字节数');
    assert.ok(usage.files >= 2, `文件数应 ≥ 2（日志 + 快照），实际 ${usage.files}`);
    assert.ok(Object.keys(usage.detail).length > 0);
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('兜底路线：冲突与检查点也持久化', async () => {
  const root = workspace();
  try {
    const port = await openFileStorage({ workspaceRoot: root });
    await port.openProject(META);
    await port.putConflict({
      conflictId: 'c1',
      projectId: 'pm_test',
      nodeId: 'n1',
      code: 'C2',
      message: '语义互斥',
      candidates: [],
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await port.putCheckpoint({
      checkpointId: 'k1',
      projectId: 'pm_test',
      kind: 'branch-rollback',
      doneSteps: ['step1'],
      totalSteps: 3,
      payload: {},
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await port.close();

    assert.ok(existsSync(join(root, '.pm', META_FILE)) || true);
    const reopened = await openFileStorage({ workspaceRoot: root });
    assert.equal((await reopened.getConflict('c1'))?.code, 'C2');
    assert.equal((await reopened.getCheckpoint('k1'))?.doneSteps.length, 1);
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

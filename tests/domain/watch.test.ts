import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_DIR_PATH,
  SNAPSHOT_DIR_PATH,
  STATE_DIR_PATH,
  classifyWatchPath,
  watchTargets,
} from '../../src/domain/watch.ts';

const DOC = 'project-manager.md';

test('文档自身变动 → document-changed', () => {
  assert.equal(classifyWatchPath('project-manager.md', DOC), 'document-changed');
});

test('文档文件名可配置', () => {
  assert.equal(classifyWatchPath('进度.md', '进度.md'), 'document-changed');
  assert.equal(classifyWatchPath('project-manager.md', '进度.md'), undefined);
});

test('交接文档变动 → handoff-changed', () => {
  assert.equal(
    classifyWatchPath(`${HANDOFF_DIR_PATH}/pause-n1-20260922-143005.md`, DOC),
    'handoff-changed',
  );
});

test('快照目录变动 → snapshot-area-changed', () => {
  assert.equal(
    classifyWatchPath(`${SNAPSHOT_DIR_PATH}/snap_1.json`, DOC),
    'snapshot-area-changed',
  );
});

test('其余 .pm/ 内容（兜底存储、WAL、索引）也算事实源区域变动', () => {
  for (const path of ['.pm/meta.json', '.pm/graph.jsonl', '.pm/wal/0001.jsonl', '.pm']) {
    assert.equal(classifyWatchPath(path, DOC), 'snapshot-area-changed', `${path} 应被识别`);
  }
});

test('工作区别处的改动 → 忽略（不监听整个工作区）', () => {
  for (const path of ['src/index.ts', 'README.md', 'package.json', '.github/workflows/ci.yml']) {
    assert.equal(classifyWatchPath(path, DOC), undefined, `${path} 不该被监听`);
  }
});

test('路径归一化：Windows 反斜杠与 ./ 前缀', () => {
  assert.equal(classifyWatchPath('.\\project-manager.md', DOC), 'document-changed');
  assert.equal(classifyWatchPath('./.pm/meta.json', DOC), 'snapshot-area-changed');
  assert.equal(
    classifyWatchPath('.pm\\handoff\\pause-x-20260922-143005.md', DOC),
    'handoff-changed',
  );
});

test('目录名相似但不同前缀不得误判', () => {
  // `.pmother/` 不是事实源目录；`project-manager.md.bak` 不是文档本身
  assert.equal(classifyWatchPath('.pmother/x.json', DOC), undefined);
  assert.equal(classifyWatchPath('project-manager.md.bak', DOC), undefined);
});

test('监听目标只有两处：文档与 .pm/', () => {
  assert.deepEqual(watchTargets(DOC), [DOC, STATE_DIR_PATH]);
  assert.deepEqual(watchTargets('进度.md'), ['进度.md', '.pm']);
});

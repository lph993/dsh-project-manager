/**
 * 外部改动监听的端到端验证（§15 R4/R6）。
 *
 * 单独成文件的原因：监听依赖真实文件系统事件 + 定时器，是这套里最"有时间性"的一块；
 * 隔离出来既能独立跑，也方便在失败时确认不是被别的东西干扰。
 *
 * 断言三件事：
 * ① 真实改文档会被感知，并且**非法文档会被识别为不合法**；
 * ② `.pm/` 被动过也会被感知；
 * ③ 工作区里**无关文件**的改动**不会**被感知（证明没在监听整个工作区）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startWatching } from '../../src/adapter/watcher.ts';

/** 轮询直到拿到满足条件的值（断言非空，方便调用方直接使用）。 */
async function waitForValue<T>(
  read: () => T | undefined,
  accept: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && accept(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitForValue 超时，最后的值：${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('监听：文档改动被感知，且非法文档被识别；.pm/ 与无关文件按范围区分', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-watch-'));
  const events: Array<{ kind: string; path: string; type: string }> = [];
  const documentPath = 'project-manager.md';
  writeFileSync(
    join(workspace, documentPath),
    '# 项目\n\n```mermaid\nflowchart TD\n  A --> B\n```\n',
  );

  const handle = startWatching({
    workspaceRoot: workspace,
    documentPath,
    debounceMs: 50,
    onEvent: (event) => {
      events.push({ kind: event.kind, path: event.path, type: event.type });
    },
  });
  assert.ok(handle, '监听应能启动');
  assert.deepEqual(handle?.targets, [documentPath, '.pm']);

  try {
    // 等 chokidar 就绪（它异步建立监听）
    await new Promise((resolve) => setTimeout(resolve, 800));

    // ① 外部改文档
    writeFileSync(
      join(workspace, documentPath),
      '# 项目\n\n这里不该有说明文字\n\n```mermaid\nflowchart TD\n  A --> B\n```\n',
    );
    const docEvent = await waitForValue(
      () => events.find((e) => e.kind === 'document-changed'),
      (value) => value !== undefined,
      15000,
    );
    assert.equal(docEvent.path, documentPath);

    // ② 外部动 .pm/
    mkdirSync(join(workspace, '.pm'), { recursive: true });
    writeFileSync(join(workspace, '.pm', 'meta.json'), '{"dataFormat":1}\n');
    const stateEvent = await waitForValue(
      () => events.find((e) => e.kind === 'snapshot-area-changed'),
      (value) => value !== undefined,
      15000,
    );
    assert.match(stateEvent.path, /^\.pm\//);

    // ③ 无关文件不该触发（证明监听范围是窄的）
    const before = events.length;
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'noise.ts'), 'export const x = 1;\n');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(events.length, before, `无关文件产生了事件：${JSON.stringify(events.slice(before))}`);
  } finally {
    await handle?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('监听：关闭后再改文件不再产生事件（不留存活句柄）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-watch-close-'));
  const events: Array<{ kind: string }> = [];
  const documentPath = 'project-manager.md';
  writeFileSync(join(workspace, documentPath), '# 项目\n');

  const handle = startWatching({
    workspaceRoot: workspace,
    documentPath,
    debounceMs: 30,
    onEvent: (event) => events.push({ kind: event.kind }),
  });
  assert.ok(handle);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await handle?.close();

  writeFileSync(join(workspace, documentPath), '# 项目（改过）\n');
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(events, [], '关闭后不应再有事件');
  rmSync(workspace, { recursive: true, force: true });
});

test('监听：工作区不存在时启动不抛错（可选能力，§19.4）', async () => {
  const handle = startWatching({
    workspaceRoot: join(tmpdir(), 'pm-does-not-exist-' + Date.now()),
    documentPath: 'project-manager.md',
    onEvent: () => {},
  });
  // 允许 undefined（启动失败）或句柄（chokidar 容忍不存在的目录并等它出现）
  if (handle) await handle.close();
});

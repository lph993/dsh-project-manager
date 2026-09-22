/**
 * 工作区根解析（`src/adapter/workspace-root.ts`）的契约测试。
 *
 * 这段逻辑是"面板空着"那次事故的根因所在，因此必须把**优先级**与
 * **不猜**（无来源时返回 undefined）钉死：
 * 1. 工具调用报告 > 2. 会话 agent 的 cwd > 3. 会话反查注册表 > 4. 注册表最近使用 > 5. 环境变量。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  pickWorkspaceFromRegistry,
  resolveWorkspaceRoot,
} from '../../src/adapter/workspace-root.ts';

/** 造一个真实存在的临时目录（解析时会 existsSync 校验）。 */
function makeDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `pm-root-${name}-`));
}

/** 假 ctx：只需要 get()。 */
function ctxWith(services: Record<string, unknown>): never {
  return {
    get: (key: string) => services[key],
  } as never;
}

describe('工作区根解析', () => {
  const dirs: string[] = [];
  const dir = (name: string): string => {
    const created = makeDir(name);
    dirs.push(created);
    return created;
  };

  const envKeys = ['DSH_WORKSPACE', 'PWD', 'INIT_CWD'] as const;
  const savedEnv = new Map<string, string | undefined>();

  before(() => {
    for (const key of envKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const created of dirs) rmSync(created, { recursive: true, force: true });
  });

  it('工具调用报告最优先（就是那次调用的 cwd）', () => {
    const reported = dir('reported');
    const other = dir('other');
    const resolution = resolveWorkspaceRoot({
      ctx: ctxWith({ workspaceRegistry: { list: () => [{ path: other, updatedAt: '2030-01-01' }] } }),
      reported,
      sessionId: 'session-x',
    });
    assert.equal(resolution.root, reported);
    assert.equal(resolution.source, 'tool-call');
  });

  it('带 sessionId 时按该会话的 session.header.cwd 精确解析', () => {
    const cwd = dir('agent');
    const ctx = ctxWith({
      agents: { get: (id: string) => (id === 's1' ? { session: { header: { cwd } } } : undefined) },
    });
    const resolution = resolveWorkspaceRoot({ ctx, sessionId: 's1' });
    assert.equal(resolution.root, cwd);
    assert.equal(resolution.source, 'session-agent');
    assert.match(resolution.detail, /s1/);
  });

  it('会话 agent 不可用时，按注册表里的 sessionIds 反查', () => {
    const mine = dir('mine');
    const newest = dir('newest');
    const ctx = ctxWith({
      workspaceRegistry: {
        list: () => [
          { path: newest, sessionIds: ['someone-else'], updatedAt: '2030-01-01T00:00:00Z' },
          { path: mine, sessionIds: ['s1'], updatedAt: '2020-01-01T00:00:00Z' },
        ],
      },
    });
    const resolution = resolveWorkspaceRoot({ ctx, sessionId: 's1' });
    // 关键：反查命中的是"我这个会话的工作区"，而不是"最近使用的那个"
    assert.equal(resolution.root, mine);
    assert.equal(resolution.source, 'session-workspace');
  });

  it('没有 sessionId 时取注册表里最近使用的那个', () => {
    const older = dir('older');
    const newer = dir('newer');
    const ctx = ctxWith({
      workspaceRegistry: {
        list: () => [
          { path: older, updatedAt: '2020-01-01T00:00:00Z' },
          { path: newer, updatedAt: '2030-01-01T00:00:00Z' },
        ],
      },
    });
    const resolution = resolveWorkspaceRoot({ ctx });
    assert.equal(resolution.root, newer);
    assert.equal(resolution.source, 'workspace-registry');
  });

  it('注册表不可读但环境变量可用时兜底到 env', () => {
    const env = dir('env');
    process.env['DSH_WORKSPACE'] = env;
    try {
      const resolution = resolveWorkspaceRoot({ ctx: ctxWith({}) });
      assert.equal(resolution.root, env);
      assert.equal(resolution.source, 'env');
    } finally {
      delete process.env['DSH_WORKSPACE'];
    }
  });

  it('什么来源都没有时返回 none，**不猜目录**', () => {
    const resolution = resolveWorkspaceRoot({ ctx: ctxWith({}) });
    assert.equal(resolution.root, undefined);
    assert.equal(resolution.source, 'none');
  });

  it('注册表里的路径不存在时如实降级（不返回根）', () => {
    const resolution = resolveWorkspaceRoot({
      ctx: ctxWith({
        workspaceRegistry: {
          list: () => [{ path: join(tmpdir(), 'pm-definitely-missing-' + Date.now()) }],
        },
      }),
    });
    assert.equal(resolution.root, undefined);
    assert.equal(resolution.source, 'none');
    assert.match(resolution.detail, /不存在/);
  });

  it('会话 agent 的 cwd 不存在时继续往下找，而不是返回坏路径', () => {
    const real = dir('real');
    const ctx = ctxWith({
      agents: {
        get: () => ({ session: { header: { cwd: join(tmpdir(), 'pm-missing-' + Date.now()) } } }),
      },
      workspaceRegistry: { list: () => [{ path: real, updatedAt: '2020-01-01T00:00:00Z' }] },
    });
    const resolution = resolveWorkspaceRoot({ ctx, sessionId: 's1' });
    assert.equal(resolution.root, real);
    assert.equal(resolution.source, 'workspace-registry');
  });

  it('pickWorkspaceFromRegistry：updatedAt 缺失时回落 createdAt，全缺时取首个可用', () => {
    assert.equal(
      pickWorkspaceFromRegistry([
        { path: 'a', createdAt: '2021-01-01T00:00:00Z' },
        { path: 'b', createdAt: '2022-01-01T00:00:00Z' },
      ]),
      'b',
    );
    assert.equal(pickWorkspaceFromRegistry([{ path: 'a' }, { path: 'b' }]), 'a');
    assert.equal(pickWorkspaceFromRegistry([{}]), undefined);
    assert.equal(pickWorkspaceFromRegistry([]), undefined);
  });
});

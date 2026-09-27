/**
 * AI 缓存与增量的契约测试（T6/T9、FR-104/39f/39g）。
 *
 * 这套逻辑的价值直接等于**钱**：该命中不命中就白发一次调用，不该复用却复用了就给出与
 * 当前仓库不符的树。所以这里把"什么时候能复用、什么时候必须重算"逐条钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheKey,
  decideCache,
  diffSignatures,
  pruneEntries,
  signaturesOf,
  type CacheEntry,
} from '../../src/ai/cache.ts';

const keyOf = (prompt: string, model = 'm1', maxTokens = 8192): string =>
  cacheKey({ prompt, provider: 'p', model, maxTokens, promptVersion: 'tree-v3' });

test('输入指纹：内容相同 → 键相同；提示词/模型/上限/版本任一变化 → 键不同', () => {
  assert.equal(keyOf('hello'), keyOf('hello'));
  assert.notEqual(keyOf('hello'), keyOf('hello2'), '提示词变了必须失效');
  assert.notEqual(keyOf('hello', 'm1'), keyOf('hello', 'm2'), '换模型不能复用');
  assert.notEqual(keyOf('hello', 'm1', 8192), keyOf('hello', 'm1', 4096), '输出上限也是输入');
  assert.notEqual(
    cacheKey({ prompt: 'x', provider: 'p', model: 'm', maxTokens: 1, promptVersion: 'a' }),
    cacheKey({ prompt: 'x', provider: 'p', model: 'm', maxTokens: 1, promptVersion: 'b' }),
    '解析口径版本变了必须失效',
  );
});

test('骨架指纹优先：提示词里的"随树变化的清单"不许打穿缓存', () => {
  /**
   * 提示词里现在夹着"本轮只需给哪些节点补描述"这类**随当前树状态变化**的清单
   * （用户口径："修剪树时已有简述和简报的不必再次要求 AI 生成…省 token"）。
   *
   * 只要给了 `skeletonFingerprint`，指纹就该只看骨架 —— 否则"某条描述被补上"
   * 会让同骨架的第二次建树从 `hit` 掉成 `miss`，白烧一次模型调用（实测踩过）。
   */
  const base = { provider: 'p', model: 'm', maxTokens: 8192, promptVersion: 'tree-v3', skeletonFingerprint: 'same' };
  assert.equal(
    cacheKey({ ...base, prompt: '骨架 + 清单：A、B 需要描述' }),
    cacheKey({ ...base, prompt: '骨架 + 清单：（一个都不缺）' }),
    '骨架没变时，清单变了也必须命中缓存',
  );
  assert.notEqual(
    cacheKey({ ...base, prompt: 'x' }),
    cacheKey({ ...base, prompt: 'x', skeletonFingerprint: 'changed' }),
    '骨架变了必须失效',
  );
  // 没给骨架指纹时保持老行为（整份提示词参与哈希）
  assert.notEqual(keyOf('hello'), keyOf('hello2'));
});

test('骨架指纹与增量：新增/删除/内容变化分得清', () => {  const before = signaturesOf([
    { path: 'src/a.ts', signature: 'aaa', sizeBytes: 10 },
    { path: 'src/b.ts', signature: 'bbb', sizeBytes: 20 },
    { path: 'README.md', sizeBytes: 30 },
  ]);
  const after = signaturesOf([
    { path: 'src/a.ts', signature: 'aaa', sizeBytes: 10 },
    { path: 'src/b.ts', signature: 'BBB', sizeBytes: 20 },
    { path: 'src/c.ts', signature: 'ccc', sizeBytes: 5 },
  ]);
  const diff = diffSignatures(before, after);
  assert.deepEqual(diff.added, ['src/c.ts']);
  assert.deepEqual(diff.removed, ['README.md']);
  assert.deepEqual(diff.changed, ['src/b.ts']);
  assert.equal(diff.unchanged, 1);
  assert.equal(diff.dirty, true);

  assert.equal(diffSignatures(before, before).dirty, false, '一模一样就是干净');
});

test('非关键文件用大小兜底：大小变了也算变化（不能因为没签名就当作没变）', () => {
  const before = signaturesOf([{ path: 'src/a.ts', sizeBytes: 10 }]);
  const after = signaturesOf([{ path: 'src/a.ts', sizeBytes: 11 }]);
  assert.deepEqual(diffSignatures(before, after).changed, ['src/a.ts']);
});

test('命中：同键 + 骨架完全一致 → 整份复用（零调用）', () => {
  const signatures = signaturesOf([{ path: 'src/a.ts', signature: 'aaa' }]);
  const entry: CacheEntry = {
    key: keyOf('prompt'),
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    signatures,
    tree: { nodes: [{ name: 'A' }] },
    tokens: 1234,
  };
  const verdict = decideCache([entry], keyOf('prompt'), signatures);
  assert.equal(verdict.kind, 'hit');
});

test('同键但骨架对不上 → 不复用（缓存文件被手工改过也不该给出无关的树）', () => {
  const entry: CacheEntry = {
    key: keyOf('prompt'),
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    signatures: signaturesOf([{ path: 'src/a.ts', signature: 'OLD' }]),
    tree: { nodes: [{ name: 'A' }] },
  };
  const verdict = decideCache(
    [entry],
    keyOf('prompt'),
    signaturesOf([{ path: 'src/a.ts', signature: 'NEW' }]),
  );
  assert.equal(verdict.kind, 'miss', '内容变了必须重算');
});

test('续跑：只有半份（上次被中断）也能复用，前提是骨架没变', () => {
  const signatures = signaturesOf([{ path: 'src/a.ts', signature: 'aaa' }]);
  const partial: CacheEntry = {
    key: keyOf('prompt'),
    status: 'partial',
    createdAt: '2026-01-01T00:00:00Z',
    signatures,
    rawText: '{"nodes":[]}',
  };
  assert.equal(decideCache([partial], keyOf('prompt'), signatures).kind, 'resume');
  assert.equal(
    decideCache(
      [partial],
      keyOf('prompt'),
      signaturesOf([{ path: 'src/a.ts', signature: 'bbb' }]),
    ).kind,
    'miss',
    '骨架变了，半份结论也不再适用',
  );
});

test('完整优先于半份：两者同键时用完整的那份', () => {
  const signatures = signaturesOf([{ path: 'src/a.ts', signature: 'aaa' }]);
  const partial: CacheEntry = {
    key: keyOf('prompt'),
    status: 'partial',
    createdAt: '2026-01-02T00:00:00Z',
    signatures,
    rawText: '{}',
  };
  const complete: CacheEntry = {
    key: keyOf('prompt'),
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    signatures,
    tree: { nodes: [{ name: 'A' }] },
  };
  assert.equal(decideCache([partial, complete], keyOf('prompt'), signatures).kind, 'hit');
});

test('未命中时带出上一条完整记录（UI 才能说清"上次是什么时候、改了多少"）', () => {
  const entry: CacheEntry = {
    key: keyOf('old prompt'),
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    signatures: signaturesOf([{ path: 'src/a.ts', signature: 'aaa' }]),
    tree: { nodes: [{ name: 'A' }] },
  };
  const verdict = decideCache(
    [entry],
    keyOf('new prompt'),
    signaturesOf([{ path: 'src/a.ts', signature: 'bbb' }]),
  );
  assert.equal(verdict.kind, 'miss');
  assert.equal(verdict.kind === 'miss' ? verdict.previous?.key : '', keyOf('old prompt'));
});

test('有界保留：条数与字节双限，淘汰时完整优先于半份', () => {
  const make = (id: number, status: 'complete' | 'partial'): CacheEntry => ({
    key: `k${id}`,
    status,
    createdAt: `2026-01-0${id}T00:00:00Z`,
    signatures: {},
    ...(status === 'complete' ? { tree: { nodes: [] } } : { rawText: 'x'.repeat(50) }),
  });
  const entries = [make(1, 'partial'), make(2, 'complete'), make(3, 'complete'), make(4, 'partial')];
  const byCount = pruneEntries(entries, { maxEntries: 2, maxBytes: 10_000 });
  assert.deepEqual(byCount.kept.map((entry) => entry.key), ['k3', 'k2'], '最新的完整条目优先');
  assert.deepEqual(byCount.dropped.map((entry) => entry.key).sort(), ['k1', 'k4']);

  const byBytes = pruneEntries(entries, { maxEntries: 10, maxBytes: 120 });
  assert.ok(byBytes.kept.length < entries.length, '字节上限也要生效');
  assert.ok(byBytes.dropped.length > 0, '淘汰的东西要能看见');
});

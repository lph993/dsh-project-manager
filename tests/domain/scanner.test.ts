import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCAN_OPTIONS,
  buildSuggestedTree,
  isSelected,
  matchesGlob,
  readPackageName,
  suggestProjectName,
  type ScanOptions,
  type ScannedEntry,
} from '../../src/domain/scanner.ts';

function options(overrides: Partial<ScanOptions> = {}): ScanOptions {
  return { ...DEFAULT_SCAN_OPTIONS, ...overrides };
}

/** 一个典型前端仓库的骨架。 */
const FRONTEND: ScannedEntry[] = [
  { path: 'package.json', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'tsconfig.json', kind: 'file' },
  { path: 'src', kind: 'dir' },
  { path: 'src/index.ts', kind: 'file' },
  { path: 'src/app.ts', kind: 'file' },
  { path: 'src/components', kind: 'dir' },
  { path: 'src/components/Button.tsx', kind: 'file' },
  { path: 'src/components/Modal.tsx', kind: 'file' },
  { path: 'tests', kind: 'dir' },
  { path: 'tests/app.test.ts', kind: 'file' },
  { path: 'docs', kind: 'dir' },
  { path: 'docs/usage.md', kind: 'file' },
];

test('glob 匹配：精确、前缀、单星与双星', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/a.ts'), true);
  assert.equal(matchesGlob('src/a/b.ts', 'src'), true, '目录前缀应命中其下所有文件');
  assert.equal(matchesGlob('srcx/a.ts', 'src'), false, '前缀不能跨目录名');
  assert.equal(matchesGlob('src/a/b.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', '**.ts'), true);
});

test('include/exclude：exclude 优先，include 为空即全选', () => {
  const all = options();
  assert.equal(isSelected('anything/x.ts', all), true);

  const excluded = options({ exclude: ['dist', 'node_modules'] });
  assert.equal(isSelected('dist/a.js', excluded), false);
  assert.equal(isSelected('node_modules/z/index.js', excluded), false);
  assert.equal(isSelected('src/a.ts', excluded), true);

  const only = options({ include: ['src'] });
  assert.equal(isSelected('src/a.ts', only), true);
  assert.equal(isSelected('docs/a.md', only), false);
});

test('建议树：目录 → feature，关键文件 → task，根为 feature', () => {
  const result = buildSuggestedTree(FRONTEND, options({ packageName: 'my-app' }));
  const byName = new Map(result.nodes.map((n) => [n.name, n]));

  const root = result.nodes[0];
  assert.ok(root);
  assert.equal(root.kind, 'feature');
  assert.equal(root.parentKey, null);

  // 目录用中文标签，并在 description 里保留原路径（可追溯）
  const src = byName.get('源码');
  assert.ok(src, `未生成"源码"节点：${result.nodes.map((n) => n.name).join(',')}`);
  assert.equal(src.kind, 'feature');
  assert.equal(src.parentKey, 'root');
  assert.match(src.description ?? '', /src\//);
  assert.deepEqual(src.refs, [{ type: 'dir', target: 'src' }]);

  const pkg = byName.get('package.json（依赖与脚本清单）');
  assert.ok(pkg, 'package.json 应被识别为关键文件');
  assert.equal(pkg.kind, 'task');
  assert.equal(pkg.parentKey, 'root');
});

test('建议树：所有节点都标 autoCreated 的来源，且 refs 指向真实路径', () => {
  const result = buildSuggestedTree(FRONTEND, options());
  for (const node of result.nodes) {
    assert.ok(
      ['root', 'directory', 'entry-file', 'doc', 'module-dir'].includes(node.origin),
      `未知 origin: ${node.origin}`,
    );
    for (const ref of node.refs) {
      assert.equal(ref.target.startsWith('/'), false, 'refs 必须是工作区相对路径');
    }
  }
});

test('建议树：key 稳定（同输入同输出，可增量去重）', () => {
  const a = buildSuggestedTree(FRONTEND, options());
  const b = buildSuggestedTree(FRONTEND, options());
  assert.deepEqual(
    a.nodes.map((n) => n.key),
    b.nodes.map((n) => n.key),
  );
  // 条目顺序打乱也不应影响 key 集合
  const shuffled = [...FRONTEND].reverse();
  const c = buildSuggestedTree(shuffled, options());
  assert.deepEqual(
    a.nodes.map((n) => n.key).sort(),
    c.nodes.map((n) => n.key).sort(),
  );
});

test('建议树：maxNodes 上限触发截断并如实标注', () => {
  const many: ScannedEntry[] = [];
  for (let i = 0; i < 50; i += 1) {
    many.push({ path: `dir${i}`, kind: 'dir' });
    many.push({ path: `dir${i}/file${i}.ts`, kind: 'file' });
  }
  const result = buildSuggestedTree(many, options({ maxNodes: 10 }));
  assert.equal(result.nodes.length, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((n) => n.includes('上限')));
});

test('建议树：深度上限触发说明而非静默丢弃', () => {
  const deep: ScannedEntry[] = [
    { path: 'a', kind: 'dir' },
    { path: 'a/b', kind: 'dir' },
    { path: 'a/b/c', kind: 'dir' },
    { path: 'a/b/c/d.ts', kind: 'file' },
  ];
  const result = buildSuggestedTree(deep, options({ maxDepth: 1 }));
  assert.ok(result.notes.some((n) => n.includes('深度上限')));
});

test('建议树：文件过多的目录聚合为"其余 N 个文件"（避免节点爆炸）', () => {
  const many: ScannedEntry[] = [{ path: 'src', kind: 'dir' }];
  for (let i = 0; i < 30; i += 1) many.push({ path: `src/file${i}.ts`, kind: 'file' });
  const result = buildSuggestedTree(many, options({ maxChildrenPerDir: 5, maxDepth: 2 }));
  const rest = result.nodes.find((n) => /其余 \d+ 个文件/.test(n.name));
  assert.ok(rest, `未生成聚合节点：${result.nodes.map((n) => n.name).join(',')}`);
  assert.equal(rest.kind, 'task');
});

test('建议树：被排除的条目计入 skipped 且不建节点', () => {
  const entries: ScannedEntry[] = [
    ...FRONTEND,
    { path: 'node_modules', kind: 'dir' },
    { path: 'node_modules/zod/index.js', kind: 'file' },
  ];
  const result = buildSuggestedTree(entries, options({ exclude: ['node_modules'] }));
  assert.equal(
    result.nodes.some((n) => n.key.includes('node_modules')),
    false,
  );
  assert.ok(result.skipped > 0);
});

test('项目名建议：目录名优先于 package.json name', () => {
  assert.equal(suggestProjectName({ rootDirName: 'my-repo', packageName: 'pkg' }), 'my-repo');
  assert.equal(suggestProjectName({ packageName: '@scope/pkg' }), '@scope/pkg');
  assert.equal(suggestProjectName({}), '未命名项目');
  assert.equal(suggestProjectName({ rootDirName: '   ' }), '未命名项目');
});

test('readPackageName：解析失败不抛错', () => {
  assert.equal(readPackageName('{"name":"x"}'), 'x');
  assert.equal(readPackageName('{ not json'), undefined);
  assert.equal(readPackageName('{}'), undefined);
  assert.equal(readPackageName(undefined), undefined);
});

test('空工作区：只产出根节点，不崩', () => {
  const result = buildSuggestedTree([], options());
  assert.equal(result.nodes.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.scanned, 0);
});

test('权重轨：只有叶节点带启发式权重，父节点不带（§9.3）', () => {
  const entries: ScannedEntry[] = [
    { path: 'package.json', kind: 'file', lineCount: 20 },
    { path: 'src', kind: 'dir' },
    { path: 'src/index.ts', kind: 'file', lineCount: 200 },
    { path: 'src/components', kind: 'dir' },
    { path: 'src/components/Button.tsx', kind: 'file', lineCount: 30 },
    { path: 'src/components/Modal.tsx', kind: 'file', lineCount: 900 },
  ];
  const result = buildSuggestedTree(entries, options({ maxDepth: 3 }));
  const byKey = new Map(result.nodes.map((n) => [n.key, n]));
  const parentKeys = new Set(
    result.nodes.map((n) => n.parentKey).filter((k): k is string => k !== null),
  );

  for (const node of result.nodes) {
    if (parentKeys.has(node.key)) {
      assert.equal(node.weight, undefined, `父节点 ${node.name} 不应有独立权重`);
      continue;
    }
    assert.equal(node.weightSource, 'heuristic', `叶节点 ${node.name} 应带启发式权重`);
    assert.ok(typeof node.weight === 'number' && node.weight > 0);
    assert.equal(node.weightDetail?.source, 'heuristic');
    assert.ok(node.weightDetail !== undefined && node.weightDetail.score > 0);
  }

  // 行数差 30 倍（30 vs 900）的两个兄弟叶节点，权重必须不同 —— 否则"工作量口径"是假的
  const button = byKey.get('file:src/components/Button.tsx');
  const modal = byKey.get('file:src/components/Modal.tsx');
  assert.ok(button && modal);
  assert.ok(
    (modal.weight ?? 0) > (button.weight ?? 0),
    `大文件权重应更高：${button.weight} vs ${modal.weight}`,
  );
});

test('权重轨：零 token 路径拿不到任何结构差异时 → 如实标注退化', () => {
  // 两个只由空文件组成的目录：fileCount/lineCount 相同 → 无区分度
  const entries: ScannedEntry[] = [
    { path: 'a', kind: 'dir' },
    { path: 'a/x', kind: 'file', lineCount: 0 },
    { path: 'b', kind: 'dir' },
    { path: 'b/y', kind: 'file', lineCount: 0 },
  ];
  const result = buildSuggestedTree(entries, options({ maxDepth: 2 }));
  const leaves = result.nodes.filter((n) => n.key.startsWith('file:'));
  assert.equal(leaves.length, 2);
  const scores = leaves.map((n) => n.weightDetail?.score);
  assert.equal(scores[0], scores[1], '两个叶节点结构分应相同（这正是"无结构数据"的情形）');
  assert.equal(leaves[0]?.weightDetail?.degenerate, true);
  assert.ok(
    result.notes.some((note) => note.includes('按件数口径')),
    `退化时必须给出说明：${result.notes.join(' | ')}`,
  );
});

test('权重轨：真实行数优先，缺失时按字节估算并标记 estimated', () => {
  const entries: ScannedEntry[] = [
    { path: 'real.ts', kind: 'file', lineCount: 10 },
    { path: 'guessed.ts', kind: 'file', sizeBytes: 4000 },
  ];
  const result = buildSuggestedTree(entries, options());
  const real = result.nodes.find((n) => n.key === 'file:real.ts');
  const guessed = result.nodes.find((n) => n.key === 'file:guessed.ts');
  assert.equal(real?.weightDetail?.signals.lineCount, 10);
  assert.equal(real?.weightDetail?.signals.lineCountEstimated, false);
  assert.equal(guessed?.weightDetail?.signals.lineCount, 100, '4000 字节 / 40 ≈ 100 行');
  assert.equal(guessed?.weightDetail?.signals.lineCountEstimated, true);
});


/**
 * 建树范围（FR-170）纯函数契约。
 *
 * 用户口径两轮，第二轮是关键澄清：
 * ① "仅主要代码就行，示例，测试，生成物，配置等都可以排除"；
 * ② **"生成物的生成代码和生成配置和读取代码不能排除，只针对生成物本身和配置文件本身"**。
 *
 * 所以这个文件里**一半断言在测"该排的排掉了"，另一半在测"不该排的没被排掉"** ——
 * 后者才是容易一刀切错的地方（第一版就把 `scripts` 与 `**.config.*` 一起排了，
 * 等于把构建管线从树上抹掉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AI_BUILD_EXCLUDE, isOutsideMainCode } from '../../src/ai/scope.ts';

test('排除：测试 / 示例 / 端到端脚本', () => {
  for (const path of [
    'tests/client/labels.test.ts',
    'src/domain/state.test.tsx',
    'test/helper.ts',
    '__tests__/a.ts',
    '__mocks__/fs.ts',
    'fixtures/sample.json',
    'examples/demo.ts',
    'demo/play.ts',
    'playground/index.tsx',
    'e2e/smoke.spec.ts',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

test('排除：**产物本身**（目录/缓存），而不是生成它的代码', () => {
  for (const path of [
    '.render-check/render-check.mjs',
    '.render-check/render-check.d.ts',
    '.turbo/cache.json',
    '.next/server/page.js',
    'vendor/lib.js',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

test('排除：**配置文件本身**', () => {
  for (const path of [
    'tsconfig.json',
    'tsconfig.host.json',
    'package.json',
    'pnpm-lock.yaml',
    'cordis.patch.yml',
    'Dockerfile',
    'Makefile',
    '.eslintrc.json',
    '.prettierrc',
    '.editorconfig',
    '.github/workflows/ci.yml',
    '.vscode/settings.json',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

/**
 * **这一组是本次澄清的核心**：代码与"关于产物的代码"一律保留 ——
 * 包括生成产物的脚本、生成用的配置、以及读取/加载产物的代码。
 */
test('保留：生成产物的代码、生成配置、读取代码（用户澄清的界线）', () => {
  for (const path of [
    'scripts/wrap-client-bundle.mjs',
    'scripts/render-check.tsx',
    'scripts/verify-artifacts.mjs',
    'tsdown.config.ts',
    'scripts/render-check.tsdown.config.ts',
    'vite.config.ts',
    'src/adapter/ai-cache-store.ts', // 读取缓存产物（生成物）的代码
    'src/storage/file-port.ts', // 读回落到磁盘产物的代码
    'src/domain/scanner.ts',
    'README.md',
    'docs/立项审查-痛点与宗旨.md', // 文档既不是示例也不是产物/配置，未列入排除（需要时可自行加）
    'src/data/user.schema.json', // 一刀切 `**.json` 会把真实数据也挡掉 —— 所以只点名具体配置文件
    'tools/build.ts',
  ]) {
    assert.equal(isOutsideMainCode(path), false, `${path} **不该**被排除`);
  }
});

test('排除表里不允许出现"代码类"模式（防止下次又顺手加回 scripts / **.config.*）', () => {
  assert.ok(!AI_BUILD_EXCLUDE.includes('scripts'), 'scripts 是构建代码，不能整目录排除');
  assert.ok(
    !AI_BUILD_EXCLUDE.some((glob) => glob.includes('.config.')),
    '`**.config.*` 属于"生成配置"，里面有逻辑，不能排除',
  );
  assert.ok(!AI_BUILD_EXCLUDE.includes('docs'), '文档未被列为排除项（它既非示例也非产物/配置）');
});

/**
 * `domain/scanner.ts` 的**存活能力**测试。
 *
 * ## 这个文件被裁过（如实记账）
 *
 * 原先 275 行，绝大部分是 `buildSuggestedTree` / `isSelected` / `suggestProjectName` /
 * `readPackageName` 的测试。那四个符号随「扫描工作区 → 直接建树」整条产品路径一起删除
 * （用户口径："0 token 代码全删除，既然做不好，就不要了"）——
 * 它们的测试随之删掉：**给已删代码留测试等于让测试骗人**。
 *
 * 留存的两块测的是**仍在服役**的能力：
 * - `matchesGlob`：`src/adapter/workspace.ts` 的目录遍历用它做 include/exclude 过滤；
 * - `isKeyFileName`：`src/ai/skeleton.ts` 用它挑"关键文件"做签名（AI 建树的提示词原料）。
 *
 * 原文可在 git 里取回：`git show dd843c2:tests/domain/scanner.test.ts`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isKeyFileName, matchesGlob } from '../../src/domain/scanner.ts';

test('glob 匹配：精确、前缀、单星与双星', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/a.ts'), true);
  assert.equal(matchesGlob('src/a/b.ts', 'src'), true, '目录前缀应命中其下所有文件');
  assert.equal(matchesGlob('srcx/a.ts', 'src'), false, '前缀不能跨目录名');
  assert.equal(matchesGlob('src/a/b.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', 'src/**'), true);
  assert.equal(matchesGlob('src/a.ts', '**.ts'), true);
});

/**
 * 关键文件识别：`ai/skeleton.ts` 靠它决定"给哪几个文件读签名"。
 *
 * 注意这张表**同时含目录条目**（`src` / `docs` / `packages` …），而本函数只对**文件名**
 * 匹配 —— 所以那些条目只会命中同名文件。这是原有行为，这里把**实际行为**钉住
 * （而不是钉一个"应该"），免得以后有人按名字误以为它在识别目录。
 */
test('isKeyFileName：识别入口/文档类文件名，且不把普通源码当关键文件', () => {
  assert.equal(isKeyFileName('package.json'), true);
  assert.equal(isKeyFileName('pnpm-workspace.yaml'), true);
  assert.equal(isKeyFileName('tsconfig.json'), true);
  assert.equal(isKeyFileName('README.md'), true, '大小写不敏感');
  assert.equal(isKeyFileName('changelog.md'), true);

  assert.equal(isKeyFileName('index.ts'), false, '普通源码不是关键文件');
  assert.equal(isKeyFileName('a/b/package.json'), false, '只按文件名匹配，不含路径');
  assert.equal(isKeyFileName(''), false);
});

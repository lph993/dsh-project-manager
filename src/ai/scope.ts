/**
 * **AI 建树的范围**：默认只给"主要代码"，把示例 / 测试 / 生成物 / 配置挡在外面。
 *
 * 用户口径（原话两轮，第二轮是关键澄清）：
 * ① "仅主要代码就行，示例，测试，生成物，配置等都可以排除"；
 * ② **"生成物的生成代码和生成配置和读取代码不能排除，只针对生成物本身和配置文件本身"**。
 *
 * ## 那条澄清划出的界线（本文件的核心）
 *
 * | 类别 | 例子 | 排除？ | 为什么 |
 * |---|---|---|---|
 * | **产物本身** | `lib/`、`dist/`、`.render-check/`（目录）、`**.map` | ✅ 排除 | 它们是**结果**，不是功能；建出来的都是重复节点（历史上真发生过） |
 * | **配置文件本身** | `tsconfig.json`、`package.json`、`cordis.patch.yml`、`.eslintrc*` | ✅ 排除 | 声明式数据，不是功能点 |
 * | **生成产物的代码** | `scripts/wrap-client-bundle.mjs`、`scripts/render-check.tsx` | ❌ **保留** | 它们**是项目代码**（构建管线也是功能） |
 * | **生成用的配置** | `tsdown.config.ts`、`*.config.ts` | ❌ **保留** | 里面有逻辑，是"怎么产出"的一部分 |
 * | **读取/加载产物的代码** | 运行期加载 `lib/` 的入口、解析配置的代码 | ❌ **保留** | 同属主要代码 |
 *
 * 换句话说：**排的是"东西"，不是"关于东西的代码"**。
 * 这条界线很容易一刀切错（我第一版就把 `scripts` 和 `**.config.*` 一起排了 ——
 * 那等于把"构建管线"从树上抹掉）。
 *
 * ## 为什么不做成 `DEFAULT_SCAN_EXCLUDE` 的一部分
 *
 * `DEFAULT_SCAN_EXCLUDE` 服务扫描 / 建树 / 行数统计多条路径，改它会波及所有路径；
 * "只看主要代码"是**建树这一个场景**的口径，所以做成叠加层：
 * `DEFAULT_SCAN_EXCLUDE + AI_BUILD_EXCLUDE + 用户自己的 scanExclude`。
 */

import { matchesGlob } from '../domain/scanner.ts';

/**
 * 建树时额外排除的 glob（在 `DEFAULT_SCAN_EXCLUDE` 之上叠加）。
 *
 * **注意**：这里只放"产物本身"与"配置文件本身"。
 * 像 `scripts`、`**.config.*` 这种**代码**一律不放进来（见文件头的界线表）。
 */
export const AI_BUILD_EXCLUDE: readonly string[] = [
  // ── 测试（含测试资产）────────────────────────────────────
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  'mocks',
  'fixtures',
  '**.test.ts',
  '**.test.tsx',
  '**.test.js',
  '**.test.mjs',
  '**.spec.ts',
  '**.spec.tsx',
  '**.spec.js',
  // ── 示例 / 演示 / 端到端脚本 ────────────────────────────
  'examples',
  'example',
  'demo',
  'demos',
  'samples',
  'sample',
  'playground',
  'e2e',
  // ── 生成物**本身**（目录、缓存、第三方产物）──────────────
  '.render-check',
  '.turbo',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.output',
  'vendor',
  // ── 仓库级配置与 IDE/CI 配置（**文件本身**，不含生成它们的代码）──
  '.github',
  '.vscode',
  '.idea',
  '.husky',
  // ── 配置文件本身：点名常见的那些，而不是一刀切 `**.json`
  //（一刀切会把 `src/**/*.schema.json` 这类真实数据也挡掉）
  'tsconfig**.json',
  'jsconfig**.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '**.lock',
  'cordis**.yml',
  'cordis**.yaml',
  'Dockerfile',
  'Makefile',
  '.env**',
  '.editorconfig',
  '.gitignore',
  '.npmrc',
  '.eslintrc**',
  '.prettierrc**',
];

/** 一条工作区相对路径是否被"仅主要代码"这条口径排除（纯函数，可单测）。 */
export function isOutsideMainCode(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return AI_BUILD_EXCLUDE.some((glob) => matchesGlob(path, glob));
}

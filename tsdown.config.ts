/**
 * tsdown 构建配置（Host 面 ESM + Client 面 classic-script 工厂）。
 *
 * 两条硬约束（实测自 DSH 0.1.5-rc.2 的 client-modules）：
 *
 * 1. **Client bundle 不是 ESM**：宿主用 `<script src>` 加载，产物必须是
 *    `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`。
 *    因此用 CJS 格式产出，再用 banner/outro 包成工厂（module/exports 在 banner 里预置）。
 * 2. **平台基座只有 9 个 specifier** 可直接 `require`，其余必须写进
 *    package.json 的 `dsh.client.external`，否则运行时报
 *    "missed the module table"。
 *
 * 平台基座（实测自 shell 的 `staticModules`）：
 *   react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis ·
 *   @deepseek-ai/dsh-client-store · @deepseek-ai/dsh-client-ui-slots ·
 *   @deepseek-ai/dsh-client-ui-primitives · @deepseek-ai/dsh-client-ui-dockkit
 */

import { defineConfig } from 'tsdown';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PACKAGE_ID = 'dsh-plugin-project-manager';

/**
 * rolldown 默认不解析 `.ts` 后缀的相对导入，而本项目遵循"显式 `.ts` 后缀"
 * （唯一能同时让 `node --test` 的 TS 直跑、`tsc`、tsdown 三方都工作的写法）。
 * 故补一个最小解析插件：把 `./x.ts` 指到真实文件。
 */
const tsExtensionResolver = {
  name: 'ts-extension-resolver',
  resolveId(source: string, importer: string | undefined): string | null {
    if (!importer) return null;
    if (!source.startsWith('./') && !source.startsWith('../')) return null;
    if (!source.endsWith('.ts') && !source.endsWith('.tsx')) return null;
    const absolute = resolve(dirname(importer), source);
    if (process.env.PM_DEBUG_RESOLVE === '1') {
      console.error(`[ts-resolver] ${source} <- ${importer} => ${absolute} exists=${existsSync(absolute)}`);
    }
    return existsSync(absolute) ? absolute : null;
  },
};

/** 平台基座：可直接 require，**不必**也不能声明为 external。 */
const PLATFORM_SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** Host 面外部依赖：全部走 Node 解析，不打包进产物。 */
const HOST_EXTERNAL = [
  /^@deepseek-ai\//,
  /^node:/,
  'chokidar',
  'zod',
];

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: false,
    clean: false,
    sourcemap: true,
    // 产物必须是 `.js`：package.json 的 exports 指向 lib/index.js 与 lib/client.js。
    // 注意 `fixedExtension` 的语义是「禁用 esm 的 .js 后缀」而非「固定为 .js」，
    // 因此这里用 outExtensions 直接钉死后缀。
    outExtensions: () => ({ js: '.js' }),
    external: HOST_EXTERNAL,
    plugins: [tsExtensionResolver],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    minify: false,
    treeshake: false,
    outExtensions: () => ({ js: '.js' }),
    // 只把平台基座外部化：插件自己的代码全部内联进 bundle。
    external: PLATFORM_SEED,
    plugins: [tsExtensionResolver],
    banner: [
      '/* Project Manager client bundle — classic script + lazy-CJS factory (DSH client-modules). */',
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(PACKAGE_ID)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
    outro: ['    return module.exports;', '  },', '});', ''].join('\n'),
  },
]);

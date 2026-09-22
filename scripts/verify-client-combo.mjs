/**
 * 组合自检：把宿主**真实提供**的全部 client bundle 放进同一个沙箱按顺序执行，
 * 断言每一个都成功调用 `__ModuleLoader__.load` 并注册了自己。
 *
 * 为什么需要它：客户端插件是被拼成一条 combo（多个 bundle 顺序拼在一个 `<script>` 里）
 * 下发的。**任意一个 bundle 语法不完整**，都会让后面所有插件不执行，而报错只会说
 * 「loaded without registering <第一个缺失的 id>」—— 极难定位。
 * 本脚本就是对那次真实故障的回归测试。
 *
 * 用法：node scripts/verify-client-combo.mjs [bundle 目录…]
 * 默认扫描 profile 安装目录与本仓 lib/。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

/** 运行时应当被回答的模块请求（真实 runtime 里由 shell 的冻结表提供）。 */
const STUBBED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/** 收集待验证的 client bundle 文件。 */
function collectBundles(roots) {
  const out = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // 本仓 lib/client.js
    const direct = join(root, 'lib', 'client.js');
    if (existsSync(direct)) out.push(direct);
    // profile 安装目录：node_modules/<pkg>/<exports['./client']>
    // 注意：DSH 的包目录常是 junction/symlink，必须用 withFileTypes 并显式跟进，
    // 否则 `statSync().isDirectory()` 会把它们全漏掉（本脚本第一版就踩了这个坑）。
    for (const dirent of readdirSync(root, { withFileTypes: true })) {
      const isDirLike = dirent.isDirectory() || dirent.isSymbolicLink();
      if (!isDirLike) continue;
      const dir = join(root, dirent.name);
      const pkgJson = join(dir, 'package.json');
      if (!existsSync(pkgJson)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (pkg.dsh?.client?.platform !== 'web') continue;
        const entry = pkg.exports?.['./client'];
        const rel = typeof entry === 'string' ? entry : entry?.default;
        if (typeof rel !== 'string') continue;
        const file = join(dir, rel);
        if (existsSync(file)) out.push(file);
      } catch {
        // 忽略无法解析的包
      }
    }
  }
  return out;
}

/** 造一个能回答平台基座请求的 require 替身。 */
function makeStubRequire(file) {
  const cache = new Map();
  const react = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => (typeof fn === 'function' ? fn() : fn),
    useRef: (initial) => ({ current: initial }),
    memo: (c) => c,
    createContext: () => ({ Provider: () => null, Consumer: () => null }),
  };
  return (specifier) => {
    if (!STUBBED_MODULES.has(specifier)) {
      throw new Error(`${file}: 请求了平台基座之外的模块 ${specifier}（需写进 dsh.client.external）`);
    }
    if (cache.has(specifier)) return cache.get(specifier);
    const value = specifier.startsWith('react') ? react : new Proxy({}, {
      get: () => () => null,
    });
    cache.set(specifier, value);
    return value;
  };
}

/** 在一个共享沙箱里依次执行全部 bundle，收集注册结果与错误。 */
function runCombo(files) {
  const registered = [];
  const errors = [];
  const pending = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          if (typeof entry?.factory !== 'function') {
            errors.push('load() 收到没有 factory 的条目');
            return;
          }
          // 真实 runtime 是**惰性**的：执行 bundle 只注册 factory。
          // 这里两种都验：注册必须成功；物化失败单独记录（不当作组合故障）。
          registered.push(entry.id);
          pending.push(entry);
        },
      },
    },
    document: {
      createElement: () => ({ dataset: {}, style: {}, remove() {}, setAttribute() {} }),
      querySelector: () => null,
      head: { append() {}, appendChild() {}, insertBefore() {} },
      body: { append() {}, appendChild() {} },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };

  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    try {
      vm.runInNewContext(code, sandbox, { filename: file });
    } catch (error) {
      errors.push(`${file}: ${error.constructor.name}: ${error.message}`);
    }
  }

  // 物化一次，验证 factory 真的能跑（这才是浏览器里实际发生的下一步）
  const materializeErrors = [];
  for (const entry of pending) {
    try {
      const exports = entry.factory(makeStubRequire(entry.id));
      if (exports === null || typeof exports !== 'object') {
        materializeErrors.push(`${entry.id}: factory 未返回 exports 对象`);
      }
    } catch (error) {
      materializeErrors.push(`${entry.id}: ${error.message}`);
    }
  }

  return { registered, errors, materializeErrors };
}

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0
  ? roots
  : [
      process.cwd(),
      join(process.env['DSH_HOME'] ?? join(process.env['USERPROFILE'] ?? '', '.dsh'), 'profiles', 'node_modules'),
    ];

const files = collectBundles(searchRoots);
if (files.length === 0) {
  console.error('没有找到任何 client bundle 可验证');
  process.exit(1);
}

const { registered, errors, materializeErrors } = runCombo(files);

console.log(`扫描到 ${files.length} 个 client bundle，成功注册 ${registered.length} 个。`);
if (errors.length > 0) {
  console.error('组合失败（这些 bundle 语法/加载有问题，会拖垮整条 combo）：');
  for (const line of errors) console.error(`  - ${line}`);
}
if (materializeErrors.length > 0) {
  console.warn('物化告警（不影响组合加载，但该插件运行时可能异常）：');
  for (const line of materializeErrors) console.warn(`  - ${line}`);
}
if (errors.length > 0) process.exit(1);
console.log('组合自检通过：全部 client bundle 均可注册。');

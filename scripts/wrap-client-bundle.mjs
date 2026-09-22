/**
 * 把 tsdown 产出的 CJS 客户端代码包装成 DSH 要求的 **classic script + lazy-CJS 工厂**。
 *
 * 为什么不靠打包器的 banner/outro：实测 tsdown 0.23 不输出 `outro`
 * （产物尾部缺少工厂收尾，浏览器里整条 combo 都会报
 * 「loaded without registering ... via __ModuleLoader__.load」，且错误挂到别的插件名下）。
 * 自己包装反而简单可控，并且可以在包装前**剥掉**作者自带的 `sourceMappingURL`
 * （宿主要求并会自己重新盖章；留着会顶掉收尾）。
 *
 * 输入：`lib/client.cjs.js`（tsdown 的 CJS 产物，已把平台基座外部化为 `require(...)`）
 * 输出：`lib/client.js`
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const packageId = packageJson.name;

/** tsdown 的客户端中间产物名（由 tsdown.config.ts 的 outExtensions 决定）。 */
const INPUT = 'lib/client.bundle.js';
const OUTPUT = 'lib/client.js';

if (!existsSync(INPUT)) {
  console.error(`包装失败：找不到 tsdown 产物 ${INPUT}（先跑 tsdown）`);
  process.exit(1);
}

let body = readFileSync(INPUT, 'utf8');

// 1) 剥掉 sourcemap 尾巴（放在最后会顶掉我们的收尾）
body = body.replace(/\n?\/\/# sourceMappingURL=.*\s*$/u, '\n');
// 2) 防御性剥掉可能自带的 sourceURL
body = body.replace(/\n?\/\/# sourceURL=.*\s*$/u, '\n');

// 3) 包成 DSH 的 lazy-CJS 工厂
const banner = [
  '/* Project Manager client bundle — 由 scripts/wrap-client-bundle.mjs 包装。',
  ' * 形态：classic script + lazy-CJS factory（DSH @deepseek-ai/dsh-client-modules 要求）。',
  ' * 执行只注册 factory；模块体副作用（含样式注入）在物化时运行。',
  ' */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(packageId)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n');

const outro = [
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n');

writeFileSync(OUTPUT, `${banner}\n${body}\n${outro}`, 'utf8');
console.log(`已包装 ${INPUT} → ${OUTPUT}（id=${packageId}）`);

// 中间产物不再需要：保持 lib/ 里只有最终会被宿主扫描的两个文件。
try {
  unlinkSync(INPUT);
} catch {
  // 删除失败不致命
}

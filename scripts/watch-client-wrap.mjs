/**
 * 把「客户端 bundle 的包装」接进 watch 链（开发期热重载用）。
 *
 * ## 为什么需要它（实测）
 *
 * DSH 的客户端热重载链是：
 * 宿主 `dsh-client-hmr` 每 500ms 比对**每个客户端 bundle 的 mtime/size** →
 * 变了就 `clientModules.rebuilt(id)` → 推 `/plugins/events`（SSE）→ 浏览器侧换组件。
 *
 * 而它只 stat **`lib/client.js`**（宿主实际加载的那个文件）。本项目的构建是**两段**：
 *
 * ```
 * tsdown --watch  →  lib/client.bundle.js   （中间产物）
 * wrap-client-bundle.mjs  →  lib/client.js  （宿主要的最终形态）
 * ```
 *
 * `pnpm run watch` 只跑第一段 ⇒ **客户端改动永远到不了宿主**（实测：
 * `client.bundle.js` 更新到 13:12:38，而 `client.js` 停在 13:07:42），
 * 于是"官方有热重载"这件事在本项目里是断的 —— 必须手动 `pnpm run build`。
 *
 * 本脚本补上第二段：监听 `lib/client.bundle.js`，出现/变化就调一次包装脚本
 * （包装脚本幂等：写 `client.js` 后删掉中间产物）。
 *
 * ## 用法
 *
 * ```
 * pnpm run watch          # 终端 A：tsdown --watch（产出中间产物）
 * pnpm run watch:wrap     # 终端 B：本脚本（把它包装成宿主认的 client.js）
 * ```
 *
 * 两个都跑起来后，改 `src/client/**` 会**无需刷新页面**自动重载。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { resolve } from 'node:path';

const INPUT = resolve('lib/client.bundle.js');
const LIB = resolve('lib');
const WRAPPER = resolve('scripts/wrap-client-bundle.mjs');

/** 去抖：tsdown 一次重建会触发多次 fs 事件。 */
const DEBOUNCE_MS = 120;
let timer;

function wrap(reason) {
  if (!existsSync(INPUT)) return; // 已被包装脚本删除（正常）→ 等下一次重建
  const result = spawnSync(process.execPath, [WRAPPER], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[watch-wrap] 包装失败（${reason}），exit=${result.status}`);
    return;
  }
  console.log(`[watch-wrap] 已更新 lib/client.js（${reason}）→ 宿主热重载链会自己接手`);
}

const schedule = (reason) => {
  clearTimeout(timer);
  timer = setTimeout(() => wrap(reason), DEBOUNCE_MS);
};

// lib/ 可能还不存在（首次构建前）→ 先建目录，watch 才有东西可挂
mkdirSync(LIB, { recursive: true });

// 监听**目录**而不是文件：中间产物会被删掉重建，监听文件句柄会失效
watch(LIB, (_event, filename) => {
  if (filename !== 'client.bundle.js') return;
  schedule('client.bundle.js 变化');
});

// 启动时先包装一次（万一上次构建留下了未包装的中间产物）
schedule('启动自检');

console.log('[watch-wrap] 正在监听 lib/client.bundle.js（改客户端代码后无需刷新页面）');

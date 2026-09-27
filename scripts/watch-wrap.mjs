/**
 * `wrap-client-bundle` 的**免 spawn** 监听器。
 *
 * ## 为什么不用 `node --watch`
 *
 * 实测：本机沙箱（`workspace-write`）下 `node --watch` 一启动就 `spawn EPERM` ——
 * 它的实现就是 spawn 子进程，被围栏挡住了（`node --test` 同理）。
 * 所以这里改成**轮询 mtime**（纯 fs stat，不起子进程），变化时按路径动态 import 包装脚本。
 *
 * ## 为什么要处理"输入被删"
 *
 * `wrap-client-bundle.mjs` 包装完会**删掉中间产物** `lib/client.bundle.js`
 * （刻意让 `lib/` 里只留宿主会扫描的那两个文件）。所以监听器不能假设输入一直在：
 * 每次 tsdown 重建它（mtime 变大）才触发一次包装，包装后它又被删掉 → 读回 0 → 不触发。
 *
 * 用法：`node scripts/watch-wrap.mjs`（与 `pnpm run watch` 配套，两个一起跑）
 */

import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const INPUT = 'lib/client.bundle.js';
/** 包装脚本的**绝对**路径：`pathToFileURL` 相对 cwd 解析，用脚本自身目录拼才不会找错。 */
const WRAP = join(import.meta.dirname, 'wrap-client-bundle.mjs');
const INTERVAL_MS = 200;

let lastSeen = 0;
let running = false;

async function runWrap() {
  if (running) return;
  running = true;
  try {
    // 带时间戳查询参数 → 绕开 ESM 模块缓存，真正重新执行包装
    await import(`${pathToFileURL(WRAP).href}?t=${Date.now()}`);
    console.log(`[watch-wrap] 已重新包装（${new Date().toLocaleTimeString()}）`);
  } catch (error) {
    console.error('[watch-wrap] 包装失败：', error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0; // 不存在（通常是已被包装并删除）
  }
}

// 启动时若有未包装的中间产物，先包一次（否则它可能要等到 tsdown 下次重建才被处理）
const initial = mtimeOf(INPUT);
if (initial > 0) {
  lastSeen = initial;
  await runWrap();
}

setInterval(() => {
  const current = mtimeOf(INPUT);
  // 只有"输入重新出现且比上次见到的新"才触发；被删除后读回 0 不会误触发
  if (current > lastSeen) {
    lastSeen = current;
    void runWrap();
  }
}, INTERVAL_MS);

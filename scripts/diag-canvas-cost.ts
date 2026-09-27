/**
 * 诊断脚本：**面板每秒重算一次的客户端代价**（卡顿定位的第二段受控实验）。
 *
 * 起因：离线测出"写文件"那条路只要 **0.43 ms**（见 `diag-write-cost.ts`），
 * 于是宿主侧的写入路径被排除。仍留在嫌疑名单上的、**每秒都在跑**的东西只剩一件：
 * 面板 1 Hz 轮询 `/pm/board` → 新数据 → `layoutFlow()` 重算 → 整块 SVG 重新调和。
 *
 * 本脚本用**真机那棵树**（161 个活节点）计时纯函数 `layoutFlow`（整树 / 分区两种形态），
 * 回答"每秒重排要花多少毫秒" —— 浏览器里还要再叠上 React 调和与 SVG 重绘，但下界在这里。
 *
 * 用法：`node scripts/diag-canvas-cost.ts [迭代次数]`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { layoutFlow } from '../src/client/flow-layout.ts';

const STORAGE_DIR = path.join(os.homedir(), '.dsh', 'storages');

type Raw = { global: Record<string, unknown>; tables: Record<string, Record<string, Record<string, unknown>>> };

const structure = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, 'project_manager_structure.json'), 'utf8')) as Raw;
const progress = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, 'project_manager_progress.json'), 'utf8')) as Raw;

const projectId = (structure.global['projectIds'] as string[])[0] ?? '';
const structures = Object.values(structure.tables['nodes'] ?? {}).filter((n) => n['projectId'] === projectId);
const progresses = progress.tables['nodes'] ?? {};

/** 只取布局真正读得到的字段（口径与 `service.toView` 一致：不推断）。 */
const nodes = structures.map((record) => {
  const p = progresses[record['id'] as string] ?? {};
  return {
    id: record['id'] as string,
    name: record['name'] as string,
    parentId: (record['parentId'] ?? null) as string | null,
    kind: record['kind'] as 'feature' | 'task',
    selfState: (p['selfState'] ?? 'pending') as 'pending' | 'running' | 'done' | 'error' | 'removed',
    derivedState: (p['selfState'] ?? 'pending') as 'pending' | 'running' | 'done' | 'error' | 'removed',
    progress: (p['progress'] ?? 0) as number,
    weight: 1,
    focus: record['focus'] === true,
    gate: (record['gate'] ?? null) as null | 'paused' | 'held',
    flags: [] as string[],
    autoCreated: record['autoCreated'] === true,
    childCount: 0,
    leafCount: 0,
    unfinishedLeafCount: 0,
    blockedBy: [] as string[],
    revision: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'user',
    addedMidway: false,
    ...(record['stale'] === true ? { stale: true } : {}),
  };
});

const live = nodes.filter((node) => node.selfState !== 'removed');
const roots = live.filter((node) => node.parentId === null);
console.log(`项目 ${projectId}：结构记录 ${structures.length}，活节点 ${live.length}，根 ${roots.length}`);

const iterations = Number(process.argv[2] ?? 200);
const stat = (label: string, samples: number[]): void => {
  const sorted = samples.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  console.log(
    `${label.padEnd(30)} 平均 ${avg.toFixed(3)} ms  中位 ${(sorted[Math.floor(sorted.length * 0.5)] ?? 0).toFixed(3)} ms  p95 ${(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(3)} ms  最大 ${(sorted[sorted.length - 1] ?? 0).toFixed(3)} ms`,
  );
};

function time(label: string, run: () => void): void {
  for (let i = 0; i < Math.min(20, iterations); i++) run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  stat(label, samples);
}

console.log(`\n=== 面板每秒重算的代价（迭代 ${iterations} 次） ===`);
time('layoutFlow 整树 LR', () => {
  layoutFlow(live, { orientation: 'LR', mode: 'tree' });
});
time('layoutFlow 整树 TB', () => {
  layoutFlow(live, { orientation: 'TB', mode: 'tree' });
});
time('layoutFlow 分区 LR', () => {
  layoutFlow(live, { orientation: 'LR', mode: 'zones' });
});

const collapsed = new Set(live.filter((node) => node.parentId !== null).slice(0, 8).map((node) => node.id));
time('layoutFlow 整树（折叠 8 枝）', () => {
  layoutFlow(live, { orientation: 'LR', mode: 'tree', collapsed });
});

const first = layoutFlow(live, { orientation: 'LR', mode: 'tree' });
console.log(`\n产物规模：placed ${first.placed.length}、edges ${first.edges.length}、画布 ${Math.round(first.width)}×${Math.round(first.height)}`);

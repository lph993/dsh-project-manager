/**
 * 诊断脚本：**"写一个文件"这条路到底要付多少代价**（卡顿定位的受控实验，离线可复现）。
 *
 * 起因（上一轮真机症状）：用户报告"一直深度求索中…"，而插件是唯一变量（卸载即恢复）。
 * 上一轮列了四条嫌疑，第 1 条是「`tools/pre-execute` 里新加的跨子项目审核门（FR-161）
 * **每次 `write`/`edit` 都跑一遍 `service.reviewIndexOf()`**（全树 derive）」。
 *
 * 本脚本**不去猜**：它用**真机的那份存储**（`~/.dsh/storages/project_manager_*.json`）
 * 把真实代码路径（真 `KvStoragePort.readGraph` + 真 `deriveGraph` + 真
 * `crossProjectVerdict`）跑一遍并计时 —— 也就是把"一次写入要付的成本"逐段拆开。
 *
 * 用法：`node scripts/diag-write-cost.ts [迭代次数]`
 *
 * 纪律：本脚本**不改生产代码、不写任何存储**（域是只读替身）。它只回答"贵不贵、贵在哪一段"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { deriveGraph } from '../src/domain/progress.ts';
import { crossProjectVerdict } from '../src/domain/review-gate.ts';
import { KvStoragePort } from '../src/storage/kv-port.ts';

const STORAGE_DIR = path.join(os.homedir(), '.dsh', 'storages');
const STRUCTURE = path.join(STORAGE_DIR, 'project_manager_structure.json');
const PROGRESS = path.join(STORAGE_DIR, 'project_manager_progress.json');

const iterations = Number(process.argv[2] ?? 200);

type RawDomain = {
  unit?: unknown;
  global: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>>;
};

function load(file: string): RawDomain {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RawDomain;
}

const rawStructure = load(STRUCTURE);
const rawProgress = load(PROGRESS);

/**
 * 只读的域替身：形状与 `ctx.storageDomain.open()` 的返回值一致（`table` / `global` / `close`），
 * 数据直接来自真机的存储 JSON —— 这样 `KvStoragePort` 的合并逻辑就是**真代码**。
 */
function makeDomain(raw: RawDomain, name: string): unknown {
  const tables = new Map<string, Map<string, unknown>>();
  const tableOf = (table: string): Map<string, unknown> => {
    let existing = tables.get(table);
    if (existing === undefined) {
      existing = new Map(Object.entries(raw.tables[table] ?? {}));
      tables.set(table, existing);
    }
    return existing;
  };
  return {
    name,
    table(table: string) {
      return {
        get: (key: string) => tableOf(table).get(key),
        put: async (key: string, value: unknown) => void tableOf(table).set(key, value),
        delete: async (key: string) => void tableOf(table).delete(key),
        keys: () => tableOf(table).keys(),
        entries: () => tableOf(table).entries(),
      };
    },
    global: { get: () => raw.global, set: async () => {} },
    close: async () => {},
  };
}

const ctx = {
  storageDomain: { open: async (spec: { name: string }) => makeDomain(spec.name === 'project_manager_structure' ? rawStructure : rawProgress, spec.name) },
  get: () => undefined,
  effect: (fn: () => unknown) => {
    fn();
  },
} as unknown as Parameters<typeof KvStoragePort.create>[0];

const port = await KvStoragePort.create(ctx);

const projectIds = await port.listProjects();
const sizes = await Promise.all(
  projectIds.map(async (id) => ({
    id,
    name: (await port.getMeta(id))?.projectName,
    nodes: (await port.readGraph(id))?.nodes,
  })),
);
const main = sizes.slice().sort((a, b) => Object.keys(b.nodes ?? {}).length - Object.keys(a.nodes ?? {}).length)[0];
if (main === undefined || main.nodes === undefined) {
  console.error('调试：listProjects =', JSON.stringify(projectIds).slice(0, 500));
  console.error('调试：getMeta =', JSON.stringify(await port.getMeta(projectIds[0] ?? '')).slice(0, 300));
  throw new Error('存储里没有可用的项目');
}
const projectId = main.id;

const stat = (label: string, samples: number[]): void => {
  const sorted = samples.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  console.log(
    `${label.padEnd(34)} 平均 ${avg.toFixed(3)} ms  中位 ${p50.toFixed(3)} ms  p95 ${p95.toFixed(3)} ms`,
  );
};

async function time(label: string, times: number, run: () => Promise<void> | void): Promise<void> {
  for (let i = 0; i < Math.min(20, times); i++) await run(); // 预热
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  stat(label, samples);
}

console.log('=== 存储现状（真机数据） ===');
for (const item of sizes) {
  console.log(`项目 ${item.name ?? '?'}（${item.id}）：节点 ${Object.keys(item.nodes ?? {}).length}`);
}
console.log(`结构域记录：nodes ${Object.keys(rawStructure.tables['nodes'] ?? {}).length} / audit ${Object.keys(rawStructure.tables['audit'] ?? {}).length}`);
console.log(`迭代 ${iterations} 次；当前项目 = ${main.name}（${projectId}）\n`);

console.log('=== 一次 "write/edit" 要付的成本（逐段） ===');

let graph: Awaited<ReturnType<typeof port.readGraph>>;
await time('① port.readGraph（合并 596 条记录）', iterations, async () => {
  graph = await port.readGraph(projectId);
});

const snapshot = (await port.readGraph(projectId))!;
let derived: ReturnType<typeof deriveGraph>;
await time('② deriveGraph（全树派生）', iterations, () => {
  derived = deriveGraph(snapshot);
});

const derivedOnce = deriveGraph(snapshot);
await time('③ reviewIndexOf 投影（建结构面）', iterations, () => {
  const nodes = [...derivedOnce.nodes.values()]
    .filter((entry) => entry.derivedState !== 'removed')
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      parentId: entry.node.parentId ?? null,
      focus: entry.node.focus === true,
      kind: entry.node.kind,
      progress: entry.node.progress ?? 0,
      refs: (entry.node.refs ?? []).map((ref) => ref.target),
    }));
  void nodes;
});

const reviewNodes = [...derivedOnce.nodes.values()]
  .filter((entry) => entry.derivedState !== 'removed')
  .map((entry) => ({
    id: entry.node.id,
    name: entry.node.name,
    parentId: entry.node.parentId ?? null,
    focus: entry.node.focus === true,
    kind: entry.node.kind,
    progress: entry.node.progress ?? 0,
    refs: (entry.node.refs ?? []).map((ref) => ref.target),
  }));

console.log(`（结构面节点数 ${reviewNodes.length}，带 refs 的 ${reviewNodes.filter((n) => n.refs.length > 0).length}）`);

await time("④ crossProjectVerdict（1 个路径）", iterations, () => {
  crossProjectVerdict(['src/client/board-panel.tsx'], reviewNodes);
});

await time('⑤ 一次写入合计 ①+②+③+④', iterations, async () => {
  const g = await port.readGraph(projectId);
  if (!g) return;
  const d = deriveGraph(g);
  const nodes = [...d.nodes.values()]
    .filter((entry) => entry.derivedState !== 'removed')
    .map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      parentId: entry.node.parentId ?? null,
      focus: entry.node.focus === true,
      kind: entry.node.kind,
      progress: entry.node.progress ?? 0,
      refs: (entry.node.refs ?? []).map((ref) => ref.target),
    }));
  crossProjectVerdict(['src/client/board-panel.tsx'], nodes);
});

console.log('\n=== 参照：审判决议（与成本无关，只为确认判据真的在跑） ===');
console.log(JSON.stringify(crossProjectVerdict(['src/client/board-panel.tsx'], reviewNodes).reason));
void graph;
void derived;

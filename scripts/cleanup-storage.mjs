/**
 * 存储清理：删掉**不在活树里的旧节点记录**（幽灵骨架）与**墓碑**，并对齐 `meta.rootIds`。
 *
 * ## 为什么需要（真机现场）
 *
 * 用户把图清空过、又重建了树，但 KV 存储是**按 key 的追加式**：旧骨架的 node 记录一直留着
 * （既不在图上、`meta.rootIds` 里却还挂着它），于是"本项目还有什么要做"只能靠人翻存储回答
 * —— 那是**假残留**，不是真待办。真机读数：存储 650 条 node 记录，图上只有 49 个。
 *
 * ## 判据（v2 —— v1 判错过，如实记下）
 *
 * v1 从 `meta.rootIds` 出发算"可达闭包"，结论"650 条全可达、删 0" —— **错的**：
 * `meta.rootIds` 里那 8 个旧根**本身就还在存储里**，从它们当然能走到整片旧骨架。
 * 而图上真正的顶级节点只有 1 个（用户重建的那棵），旧骨架在图上**一个都不显示**。
 *
 * 所以 v2 用**显式活根** `--root <nodeId>`：从它沿 `parentId` 走闭包 = 保留集合，
 * 其余本项目记录（含墓碑与不可达的 pending）一律删。
 *
 * ## 安全设计
 *
 * - **默认 dry-run**：只打印方案（各表将删多少、前几个例子），不碰文件；
 * - `--apply` 才写盘，且**写前先备份**到同目录 `cleanup-<时间戳>/`；
 * - 只动**指定项目**的记录，不碰别的项目；
 * - 顺带清理：指向被删节点的 `audit` 记录、目标全被删的 `snapshots` 记录；
 * - `meta.rootIds` 重写为只含活根。
 *
 * 用法：
 *   node scripts/cleanup-storage.mjs --project <id> --root <nodeId>            # 只出方案
 *   node scripts/cleanup-storage.mjs --project <id> --root <nodeId> --apply    # 落盘
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectId = argOf('--project');
const rootId = argOf('--root');
const apply = args.includes('--apply');

if (projectId === undefined || projectId === '' || rootId === undefined || rootId === '') {
  console.error('用法：node scripts/cleanup-storage.mjs --project <id> --root <nodeId> [--apply]');
  process.exit(2);
}

const DIR = join(homedir(), '.dsh', 'storages');
const STRUCTURE = join(DIR, 'project_manager_structure.json');
const PROGRESS = join(DIR, 'project_manager_progress.json');

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const structure = read(STRUCTURE);
const progress = read(PROGRESS);

/** 某表里属于本项目的 [key, value] 记录。 */
const recordsOf = (table) =>
  Object.entries(table ?? {}).filter(([, value]) => value?.projectId === projectId);

const nodes = recordsOf(structure.tables.nodes);
const progressNodes = recordsOf(progress.tables.nodes);
const liveIds = new Set(nodes.map(([key]) => key));

if (!liveIds.has(rootId)) {
  console.error(`--root ${rootId} 不在本项目的 node 记录里（项目 ${projectId}）`);
  process.exit(2);
}

/** 从活根沿 parentId 走闭包 = 要保留的节点。 */
const childIndex = new Map();
for (const [key, value] of nodes) {
  const parent = value.parentId ?? '\u0000root';
  if (!childIndex.has(parent)) childIndex.set(parent, []);
  childIndex.get(parent).push(key);
}
const keep = new Set();
const queue = [rootId];
while (queue.length > 0) {
  const id = queue.shift();
  if (keep.has(id)) continue;
  keep.add(id);
  for (const child of childIndex.get(id) ?? []) queue.push(child);
}

const staleNodes = nodes.filter(([key]) => !keep.has(key));
const staleProgress = progressNodes.filter(([key]) => !keep.has(key));

const auditRecords = recordsOf(structure.tables.audit);
const staleAudit = auditRecords.filter(([, value]) => {
  const nodeId = value?.nodeId;
  if (nodeId === null || nodeId === undefined) return false; // 项目级记录保留
  return liveIds.has(nodeId) && !keep.has(nodeId);
});

const snapshots = recordsOf(structure.tables.snapshots);
const staleSnapshots = snapshots.filter(([, value]) => {
  const ids = Array.isArray(value?.nodeIds) ? value.nodeIds : [];
  return ids.length > 0 && ids.every((id) => !keep.has(id));
});

const say = (label, list, nameOf = (v) => v?.name ?? v?.attemptId ?? v?.snapshotId ?? '') => {
  console.log(`${label}: ${list.length} 条`);
  for (const [key, value] of list.slice(0, 5)) {
    const name = nameOf(value);
    console.log(`    - ${key}${name !== '' ? `  ${name}` : ''}`);
  }
  if (list.length > 5) console.log(`    … 另有 ${list.length - 5} 条`);
};

console.log(`项目 ${projectId}   活根 ${rootId}`);
console.log(`  本项目 node 记录：${nodes.length} 条；保留（活树闭包）：${keep.size} 条`);
console.log('将删除：');
say('  structure.nodes（不在活树里，含墓碑）', staleNodes);
say('  progress.nodes', staleProgress);
say('  audit（指向被删节点）', staleAudit);
say('  snapshots（目标全没了）', staleSnapshots);
const currentRootIds = structure.tables.meta?.[projectId]?.rootIds ?? [];
console.log(`  meta.rootIds：${currentRootIds.length} → 1（只留活根 ${rootId}）`);

if (!apply) {
  console.log('\n（dry-run：没有改任何文件。要落盘请加 --apply）');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(DIR, `cleanup-${stamp}`);
mkdirSync(backupDir, { recursive: true });
copyFileSync(STRUCTURE, join(backupDir, 'project_manager_structure.json'));
copyFileSync(PROGRESS, join(backupDir, 'project_manager_progress.json'));
console.log(`\n已备份到：${backupDir}`);

const drop = (table, list) => {
  for (const [key] of list) delete table[key];
};
drop(structure.tables.nodes, staleNodes);
drop(progress.tables.nodes, staleProgress);
drop(structure.tables.audit, staleAudit);
drop(structure.tables.snapshots, staleSnapshots);
structure.tables.meta[projectId].rootIds = [rootId];

writeFileSync(STRUCTURE, JSON.stringify(structure), 'utf8');
writeFileSync(PROGRESS, JSON.stringify(progress), 'utf8');
console.log('已写回。剩余：');
console.log(`  structure.nodes ${Object.keys(structure.tables.nodes).length} 条`);
console.log(`  progress.nodes  ${Object.keys(progress.tables.nodes).length} 条`);
console.log(`  meta.rootIds    ${structure.tables.meta[projectId].rootIds.length} 个`);

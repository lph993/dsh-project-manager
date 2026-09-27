/**
 * 诊断脚本：看这个工作区**到底会不会触发分批**、以及**建树会看到哪些文件**。
 *
 * 起因：用户真机建树报「输出被截断（max-tokens）」，而 FR-165 应在这种失败后自动分批 ——
 * 先查清是"阈值没到"还是"分批没触发"，再决定改哪儿。绝不靠猜。
 *
 * 现在它同时是 FR-170（"仅主要代码"）的核对工具：**必须与 `service.collectAiSkeleton`
 * 用同一份排除项**，否则工具给出的是另一个项目的数字，比没有更糟。
 */
import { scanWorkspaceEntries } from '../src/adapter/workspace.ts';
import { collectSkeleton } from '../src/ai/skeleton.ts';
import { AI_BUILD_EXCLUDE, isOutsideMainCode } from '../src/ai/scope.ts';
import { SHARD_MAX_FILES, SHARD_THRESHOLD_FILES, shouldShard, shardSkeleton } from '../src/ai/shard.ts';
import { DEFAULT_SCAN_EXCLUDE } from '../src/service.ts';

const root = process.cwd();
const exclude = [...DEFAULT_SCAN_EXCLUDE, ...AI_BUILD_EXCLUDE];
const walked = await scanWorkspaceEntries({
  root,
  maxDepth: 6,
  exclude,
  countLines: false,
});
const collected = await collectSkeleton({ root, entries: walked.entries });
const files = collected.skeleton.filter((entry) => entry.kind === 'file');
const dirs = collected.skeleton.filter((entry) => entry.kind === 'dir');
const shards = shardSkeleton(collected.skeleton);

console.log(`通用排除：${DEFAULT_SCAN_EXCLUDE.join(', ')}`);
console.log(`建树专用排除（仅主要代码）：${AI_BUILD_EXCLUDE.join(', ')}`);
console.log(`遍历条目 ${walked.entries.length}（skipped ${walked.skipped}）`);
console.log(`骨架条目 ${collected.skeleton.length}（目录 ${dirs.length} / 文件 ${files.length}）`);
/** 反向自检：骨架里**不该**出现被排除的路径（口径与实现不一致时这里会报出来）。 */
const leaked = collected.skeleton.map((entry) => entry.path).filter((path) => isOutsideMainCode(path));
console.log(leaked.length === 0 ? '范围自检 ✅ 没有非主要代码混进骨架' : `范围自检 ❌ 混进 ${leaked.length} 条：${leaked.slice(0, 8).join(', ')}`);
console.log(`阈值：文件数 > ${SHARD_THRESHOLD_FILES} 才分批；单片上限 ${SHARD_MAX_FILES}`);
console.log(`shouldShard = ${shouldShard(collected.skeleton)}`);
console.log(
  `分片 = ${shards.length} 片 → ${shards
    .map((shard) => `${shard.rootDir === '' ? '(根)' : shard.rootDir}:${shard.entries.filter((e) => e.kind === 'file').length}`)
    .join(' | ')}`,
);

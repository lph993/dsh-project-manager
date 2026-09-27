/**
 * 一次性诊断：找出"**同引用**的重复节点"（真机上建树留下的重复分支/叶子）。
 *
 * 为什么用 `refs` 当判据：节点身份本来就由 `refs` 路径派生（FR-158）——
 * 同一个目录/文件集合出现两次，就是同一个功能点被建成了两个节点。
 * 这是**机械可判**的，不靠名字相似度。
 *
 * 用法：`node scripts/analyze-tree-dups.mjs`（跑在宿主已启动的前提下，直接读 /pm/board）。
 */

const BOARD_URL = process.env.PM_BOARD_URL ?? 'http://127.0.0.1:3080/pm/board';

/** 只看这几棵枝里面（真机上"AI 建树"被建了 5 次）。`PM_DUP_ROOTS=''` = 全树。 */
const rawRoots = process.env.PM_DUP_ROOTS ?? 'AI 建树与推理|AI 驱动建树|AI 辅助建树|AI 建树能力|AI 解析与建树';
const ROOT_NAMES = rawRoots.trim() === '' ? [] : rawRoots.split('|');

const board = await (await fetch(BOARD_URL)).json();
/**
 * **墓碑（已删除）不进判据**：它们本来就已经删掉了，再"去重"一次没有意义；
 * 更要紧的是它们会**虚增子节点数** —— 而"子节点多"正是选保留者的第一判据，
 * 拿墓碑当子节点会让我们把该留的删掉、把该删的留下。
 */
const live = board.nodes.filter((node) => node.derivedState !== 'removed');
const byId = new Map(live.map((node) => [node.id, node]));
const kids = new Map();
for (const node of live) {
  if (node.parentId === null) continue;
  const bucket = kids.get(node.parentId);
  if (bucket === undefined) kids.set(node.parentId, [node]);
  else bucket.push(node);
}

/**
 * 范围：默认只扫指定枝；**留空 = 全树**（注释早就这么写了，实现却把空串当成了一个叫 `''` 的枝名 ⇒
 * 扫描范围恒为空、结论永远是"没有重复" —— 一个"永远说没事"的诊断工具比没有还糟）。
 */
const wholeTree = ROOT_NAMES.length === 0;
const roots = wholeTree
  ? live.filter((node) => node.parentId === null)
  : live.filter((node) => ROOT_NAMES.includes(node.name));
const scope = [];
const stack = roots.map((root) => root.id);
if (wholeTree) {
  // 全树：所有活着的节点都在范围内（根自己也算）
  for (const node of live) scope.push(node);
}
while (stack.length > 0) {
  const current = stack.pop();
  for (const child of kids.get(current) ?? []) {
    scope.push(child);
    stack.push(child.id);
  }
}
/** 去重：全树模式下根与遍历结果会重叠。 */
const seen = new Set();
const scoped = scope.filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));

console.log(`范围：${roots.map((r) => r.name).join('、') || '(全树)'}`);
console.log(`范围内节点数 = ${scoped.length}`);
console.log('');

const groups = new Map();
for (const node of scoped) {
  const key = (node.refs ?? []).map((ref) => ref.target).sort().join('|');
  if (key === '') continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(node);
}

const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1).sort((a, b) => b[1].length - a[1].length);
console.log(`同引用重复组 = ${dupGroups.length}`);
for (const [key, list] of dupGroups) {
  console.log(`── refs = ${key}`);
  const ranked = [...list].sort((a, b) => b.progress - a.progress);
  for (const node of ranked) {
    console.log(
      `     ${node.name} | p=${Math.round(node.progress * 100)}% | 父=${byId.get(node.parentId)?.name ?? '(根)'} | ` +
        `子=${kids.get(node.id)?.length ?? 0} | 描述=${node.description ? '有' : '无'} | id=${node.id}`,
    );
  }
}

/** 建议保留哪一个：有子节点 > 有描述 > 进度高（都是可机械比较的事实）。 */
console.log('');
console.log('每组建议保留（子节点多 > 有描述 > 进度高）：');
for (const [key, list] of dupGroups) {
  const best = [...list].sort((a, b) => {
    const kidsDiff = (kids.get(b.id)?.length ?? 0) - (kids.get(a.id)?.length ?? 0);
    if (kidsDiff !== 0) return kidsDiff;
    const descDiff = Number(b.description !== undefined) - Number(a.description !== undefined);
    if (descDiff !== 0) return descDiff;
    return b.progress - a.progress;
  })[0];
  const drops = list.filter((node) => node.id !== best.id);
  console.log(`  refs=${key}`);
  console.log(`    保留 ${best.name}（${best.id}）`);
  for (const drop of drops) console.log(`    重复 ${drop.name}（${drop.id}）p=${Math.round(drop.progress * 100)}%`);
}

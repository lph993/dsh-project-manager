/**
 * 一次性诊断：把"同引用重复"整理成**可执行计划**（保留谁 / 删谁 / 进度怎么并）。
 *
 * 判据全部是机械事实：`refs` 相同 = 同一个功能点（FR-158 的身份键口径）；
 * 保留者按"子节点多 > 有描述 > 进度高"排序（**只比事实，不比名字好不好听**）。
 *
 * **本脚本只打印计划，不动数据**：真正执行走 `pm_report`（并进度）与 `pm_remove`（删重复）。
 * 之所以要分开：删除是破坏性操作，计划必须先被人（或模型）看一眼。
 *
 * 用法：`node scripts/plan-tree-dedupe.mjs`
 */

const BOARD_URL = process.env.PM_BOARD_URL ?? 'http://127.0.0.1:3080/pm/board';
/** `PM_DUP_ROOTS=''` = 全树（与 `analyze-tree-dups.mjs` 同一约定，两个脚本必须能互相复核）。 */
const rawRoots = process.env.PM_DUP_ROOTS ?? 'AI 建树与推理|AI 驱动建树|AI 辅助建树|AI 建树能力|AI 解析与建树';
const ROOT_NAMES = rawRoots.trim() === '' ? [] : rawRoots.split('|');

const board = await (await fetch(BOARD_URL)).json();
/** 墓碑不进判据（它们会让"子节点多"这个第一判据失真，见 analyze-tree-dups.mjs 的说明）。 */
const live = board.nodes.filter((node) => node.derivedState !== 'removed');
const byId = new Map(live.map((node) => [node.id, node]));
const kids = new Map();
for (const node of live) {
  if (node.parentId === null) continue;
  const bucket = kids.get(node.parentId);
  if (bucket === undefined) kids.set(node.parentId, [node]);
  else bucket.push(node);
}
const wholeTree = ROOT_NAMES.length === 0;
const roots = wholeTree
  ? live.filter((node) => node.parentId === null)
  : live.filter((node) => ROOT_NAMES.includes(node.name));
const scope = [];
const stack = roots.map((root) => root.id);
if (wholeTree) {
  for (const node of board.nodes) {
    if (node.derivedState !== 'removed') scope.push(node);
  }
}
while (stack.length > 0) {
  const current = stack.pop();
  for (const child of kids.get(current) ?? []) {
    scope.push(child);
    stack.push(child.id);
  }
}
const seen = new Set();
const scoped = scope.filter((node) => (seen.has(node.id) ? false : (seen.add(node.id), true)));

const groups = new Map();
for (const node of scoped) {
  const key = (node.refs ?? []).map((ref) => ref.target).sort().join('|');
  if (key === '') continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(node);
}

/** 保留者：子节点多 > 有描述 > 进度高（同一个排序用于全部组，避免"这次这样、下次那样"）。 */
function pickKeeper(list) {
  return [...list].sort((a, b) => {
    const kidsDiff = (kids.get(b.id)?.length ?? 0) - (kids.get(a.id)?.length ?? 0);
    if (kidsDiff !== 0) return kidsDiff;
    const descDiff = Number(b.description !== undefined) - Number(a.description !== undefined);
    if (descDiff !== 0) return descDiff;
    return b.progress - a.progress;
  })[0];
}

const ready = [];
const blocked = [];
for (const [key, list] of groups) {
  if (list.length < 2) continue;
  const keeper = pickKeeper(list);
  const others = list.filter((node) => node.id !== keeper.id);
  const withKids = others.filter((node) => (kids.get(node.id)?.length ?? 0) > 0);
  const deletable = others.filter((node) => (kids.get(node.id)?.length ?? 0) === 0);
  const maxProgress = Math.max(keeper.progress, ...deletable.map((node) => node.progress));
  const entry = {
    refs: key,
    keeper: { id: keeper.id, name: keeper.name, progress: keeper.progress },
    foldTo: maxProgress > keeper.progress ? maxProgress : undefined,
    delete: deletable.map((node) => ({ id: node.id, name: node.name, progress: node.progress })),
  };
  if (withKids.length > 0) {
    // 还有带子节点的重复者 ⇒ 必须先把活子节点搬进保留者，本批不能删（不是宿主能力问题）
    blocked.push({ ...entry, needsMove: withKids.map((node) => ({ id: node.id, name: node.name, kids: kids.get(node.id)?.length ?? 0 })) });
    continue;
  }
  ready.push(entry);
}

console.log('=== 可立即执行（重复者都是叶子，删掉不丢任何子树）===');
for (const item of ready) {
  console.log(`refs=${item.refs}`);
  console.log(`  保留 ${item.keeper.name}（${item.keeper.id}）p=${Math.round(item.keeper.progress * 100)}%`);
  for (const drop of item.delete) {
    console.log(`  删除 ${drop.name}（${drop.id}）p=${Math.round(drop.progress * 100)}%`);
  }
  const active = item.delete.filter((drop) => drop.progress > item.keeper.progress);
  if (active.length > 0) console.log(`  并进度 → ${active[0].progress}`);
}
console.log('');
console.log('=== 需要先搬子节点（把活子节点 move 进保留者后才能删）===');
for (const item of blocked) {
  console.log(`refs=${item.refs}  保留 ${item.keeper.name}；待搬：${item.needsMove.map((n) => `${n.name}(${n.kids} 子)`).join('、')}`);
}

/**
 * **第二轮：把"整枝副本"展开成可执行动作**（`PM_DUP_DEEP=1`）。
 *
 * 为什么需要它：第一轮只处理"重复者都是叶子"的组；剩下的 7 组是**整枝副本**（子节点里还有子节点）。
 * 逐个手动搬子节点既费事又容易漏。这里把每组的动作机械算出来，只有两种：
 *
 * - **DELETE**：这个子节点的 `refs` 在保留者子树里**已经有一个同引用的活节点** ⇒ 它本身也是重复 ⇒ 删掉，不搬；
 * - **MOVE**：保留者子树里没有同引用的 ⇒ 搬过去（保住这条工作项）。
 *
 * 顺序很关键：**先删同引用子节点、再搬剩下的、最后删空掉的重复枝** ——
 * 先搬的话会把重复者塞进保留者，反而制造新的二阶重复。
 */
if (process.env.PM_DUP_DEEP === '1') {
  /**
   * 子树里所有活节点的 refs 键集合（含自己）。
   *
   * **必须排除"待合并的重复枝自己的子树"**：保留者枝里往往**就含着**这些重复枝（例如
   * `工作区与 Git 适配` 挂在 `宿主适配层` 下面），若不排除，`keeperKeys` 会天然包含重复枝
   * 子节点的键 ⇒ 每个子节点都被判成"保留者里已有同引用" ⇒ **把唯一代表某个引用路径的节点删掉**。
   * 这正是机械判据最容易伤人的地方：它看起来很有道理，删的却是唯一的那一份。
   */
  const excluded = new Set();
  for (const item of blocked) {
    for (const dup of item.needsMove) {
      const stack2 = [dup.id];
      while (stack2.length > 0) {
        const current = stack2.pop();
        excluded.add(current);
        for (const child of kids.get(current) ?? []) stack2.push(child.id);
      }
    }
  }
  const refKeysInSubtree = (rootId) => {
    const set = new Set();
    const walk = (id) => {
      const node = byId.get(id);
      if (node === undefined) return;
      if (!excluded.has(id)) {
        const key = (node.refs ?? []).map((ref) => ref.target).sort().join('|');
        if (key !== '') set.add(key);
      }
      for (const child of kids.get(id) ?? []) walk(child.id);
    };
    walk(rootId);
    return set;
  };

  console.log('');
  console.log('=== 第二轮动作（DEEP：DELETE 同引用子节点 → MOVE 其余 → 删空枝）===');
  for (const item of blocked) {
    const keeperId = item.keeper.id;
    const keeperKeys = refKeysInSubtree(keeperId);
    console.log(`组 refs=${item.refs}  保留者 ${item.keeper.name}（${keeperId}）`);
    const branchDeletes = [];
    for (const dup of item.needsMove) {
      const children = (kids.get(dup.id) ?? []).filter((node) => node.derivedState !== 'removed');
      for (const child of children) {
        const key = (child.refs ?? []).map((ref) => ref.target).sort().join('|');
        /**
         * **只删叶子，而且只删"保留者里真的有同引用"的叶子**：
         * 带子节点的重复者一律**搬**（搬是无损的，搬完下一轮它会变成空枝再删）——
         * 于是递归自然收敛，绝不出现"删掉一整片还没搬的子树"。
         */
        const childHasKids = (kids.get(child.id) ?? []).length > 0;
        if (!childHasKids && key !== '' && keeperKeys.has(key)) {
          console.log(`  DELETE ${child.name}（${child.id}）—— 叶子，且保留者子树里已有同引用节点`);
        } else {
          console.log(`  MOVE   ${child.name}（${child.id}）→ ${keeperId}${key === '' ? '（无 refs，按结构保留）' : childHasKids ? '（它自己还有子节点 ⇒ 只搬不删）' : ''}`);
        }
      }
      branchDeletes.push({ id: dup.id, name: dup.name });
    }
    console.log(`  然后删除空枝：${branchDeletes.map((n) => `${n.name}（${n.id}）`).join('、')}`);
  }
}

console.log('');
console.log(`小结：可删 ${ready.reduce((sum, item) => sum + item.delete.length, 0)} 个叶子重复；` +
  `另有 ${blocked.length} 组需要先搬 ${blocked.reduce((sum, item) => sum + item.needsMove.length, 0)} 棵重复枝的子节点。`);

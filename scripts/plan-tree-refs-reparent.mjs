/**
 * 诊断 + 计划：把**挂错枝**的节点按 `refs` 归位。
 *
 * ## 为什么要单独一轮（与"合并重复"是两件事）
 *
 * 合并重复解决的是"同一件事被建成两个节点"（同引用组）。
 * 归位解决的是"这个节点挂在了与它 `refs` 不相干的枝下"——
 * 真机实例：保留枝「模型选择路由」（refs=`src/ai/route.ts`）下挂着几十个
 * refs 全是 `src/adapter/*` 的节点（工作区/快照/http/watcher/git/confirm）。
 * 它在界面上表现为"点开 AI 路由，看到的全是适配层的活"。
 *
 * ## 判据（全部机械）
 *
 * 对每个有 `refs` 的活节点 N，在活节点里找"**能覆盖它全部 refs 的候选父**"：
 * 候选 P 的每条 ref 按**路径边界**覆盖 N 的 refs（`src/ai` 覆盖 `src/ai/x.ts`，
 * 不覆盖 `src/aix.ts`）。在候选里取**最能说明问题**的那个：先比**覆盖用到的 ref 路径有多具体**
 * （越长越具体：`src/domain` 比 `src` 具体），再比树深（越深越具体），再比名字保证可复现。
 * 若 N 已经在最优候选下 ⇒ 不动。
 *
 * ⚠ **为什么不能只比树深**（第一版就错在这里）：根的直接子节点**树深都是 1**，
 * 于是 `领域与数据层`（refs=`src/domain`）与 `插件入口与生命周期`（refs=`src`）打平，
 * 判据就把"已经挂对的"节点建议往上搬 —— 机械判据看着有道理，办的却是错事。
 * 具体度必须来自**引用路径本身**。
 *
 * ⚠ **必须与宿主侧的执行判据一致**（`domain/mutate.ts` 的 `E_DUPLICATE_BRANCH`）：宿主用的是
 * **ref 字符串集合**的互为子集判定（不是路径前缀覆盖）—— 两者互为子集时它认为"同一份代码的
 * 两次评估"，**拒绝合并**。第一版计划器只按前缀覆盖挑目标，于是 12 个动作被宿主当场拒了
 * （`E_DUPLICATE_BRANCH`）；这里把同一条判据抄进来：候选里**排除**与节点 refs 互为子集的目标。
 * 剩下的那类（父的 ref 是笼统目录、子的 ref 是具体文件，例如 `src/ai` ⊃ `src/ai/prompt.ts`）
 * 才是合法嵌套 —— 判据不同，结论就不同，计划器不能自己发明一套。
 *
 * 三条安全约束：① 不把节点挂到自己的子孙下（成环）；② 无 `refs` 的节点不参与（判不了就不动）；
 * ③ 找不到候选就不动（**不猜**）——宁可留着，也不塞到一个"看起来差不多"的枝下。
 *
 * `PM_REFS_APPLY=1` 只影响输出措辞；本脚本**从不写数据**，执行走 `pm_move`。
 * 用法：`node scripts/plan-tree-refs-reparent.mjs`
 */

const BOARD_URL = process.env.PM_BOARD_URL ?? 'http://127.0.0.1:3080/pm/board';

const board = await (await fetch(BOARD_URL)).json();
const live = board.nodes.filter((node) => node.derivedState !== 'removed');
const kids = new Map();
for (const node of live) {
  if (node.parentId === null) continue;
  const bucket = kids.get(node.parentId);
  if (bucket === undefined) kids.set(node.parentId, [node]);
  else bucket.push(node);
}

/** 路径归一化：反斜杠转正斜杠、去 `./` 与尾部 `/`。 */
const norm = (path) => String(path).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** 引用是否覆盖这条路径（按路径边界）。 */
const covers = (ref, path) => {
  const target = norm(ref);
  const file = norm(path);
  if (target === '') return false;
  return file === target || file.startsWith(`${target}/`);
};

const refsOf = (node) => [...new Set((node.refs ?? []).map((ref) => norm(ref.target)).filter((t) => t !== ''))];

const depthOf = (node) => {
  let depth = 0;
  let current = node;
  const seen = new Set([node.id]);
  while (current.parentId !== null) {
    const parent = live.find((item) => item.id === current.parentId);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
};

const subtreeOf = (rootId) => {
  const out = new Set([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of kids.get(current) ?? []) {
      out.add(child.id);
      stack.push(child.id);
    }
  }
  return out;
};

/**
 * 候选 P 对节点 N 的**具体度**：N 的每条 ref 都找 P 里覆盖它的最长 ref，取这些长度里的**最小值**。
 * 越小 = 覆盖得越笼统（`src` 只给 3），越大 = 覆盖得越贴题（`src/domain` 给 10）。
 * 用"最坏情况"而不是平均值：只要有一条 ref 只能被笼统覆盖，这个候选就不够具体。
 */
const specificity = (candidate, refs) => {
  const cRefs = refsOf(candidate);
  return Math.min(
    ...refs.map((path) => {
      const covering = cRefs.filter((ref) => covers(ref, path)).map((ref) => norm(ref).length);
      return covering.length === 0 ? 0 : Math.max(...covering);
    }),
  );
};

const moves = [];
const unplaceable = [];
const already = [];
const crossArea = [];
/** 与某个候选互为子集（= 宿主会以 E_DUPLICATE_BRANCH 拒绝）的节点：属重复枝，另案处理。 */
const duplicateTargets = [];
const duplicateNodes = new Set();

/** 两批 refs 是否互为子集（**字符串集合**判定，与 `domain/mutate.ts` 同一口径）。 */
const mutuallyContained = (a, b) => {
  const setA = new Set(a);
  const setB = new Set(b);
  const aInB = a.every((target) => setB.has(target));
  const bInA = b.every((target) => setA.has(target));
  return aInB || bInA;
};

/** 一个引用属于哪个"区"：`src/domain/x.ts` → `src/domain`；其它取首段。 */
const areaOf = (ref) => {
  const parts = norm(ref).split('/');
  return parts[0] === 'src' && parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? '');
};

/** 当前父是否已经覆盖这个节点的**全部** refs。 */
const parentCoversAll = (node, refs) => {
  const parent = live.find((item) => item.id === node.parentId);
  if (parent === undefined) return false;
  const pRefs = refsOf(parent);
  return pRefs.length > 0 && refs.every((path) => pRefs.some((ref) => covers(ref, path)));
};

for (const node of live) {
  const refs = refsOf(node);
  if (refs.length === 0) continue; // 判不了就不动
  /**
   * **无 refs 的父枝是"合法的家"**（用户口径：无法归类且必须存在的跨区节点，用单一区管理，
   * 算辅助任务）—— 例如「跨区辅助任务」专区自身没有 refs，它下面的节点本来就不该被"归位"。
   * 少了这条，判据会把刚收进专区的 14 个节点**又建议搬回各区**（乒乓）。
   */
  const parent = live.find((item) => item.id === node.parentId);
  if (parent !== undefined && refsOf(parent).length === 0) {
    already.push(node);
    continue;
  }
  /**
   * **跨区的节点不动**：它的 refs 分属 `src/domain` 与 `src/weight` 这类两个区时，
   * "能覆盖全部 refs 的节点"只剩很笼统的 `src` —— 那不是"归位"，是**往上搬**，
   * 只会让它更说不清。这类节点如实报出来，交给人判断。
   */
  if (new Set(refs.map(areaOf)).size >= 2) {
    crossArea.push(node);
    continue;
  }
  /**
   * **只修真正的挂错**：当前父已经覆盖全部 refs ⇒ 它没挂错，不动。
   * （否则"更具体的枝"会把整棵树无休止地重排，而那不是 `refs` 能定的事。）
   */
  if (parentCoversAll(node, refs)) {
    already.push(node);
    continue;
  }
  const ownSubtree = subtreeOf(node.id);
  const candidates = live.filter((candidate) => {
    if (candidate.id === node.id) return false;
    if (ownSubtree.has(candidate.id)) return false; // 成环保护
    const cRefs = refsOf(candidate);
    if (cRefs.length === 0) return false;
    /**
     * **宿主会拒的目标，计划里也不许出现**（`E_DUPLICATE_BRANCH`）：refs 互为子集 ⇒ 那是
     * "同一份代码的两次评估"，合并只会把分母灌水。这类关系不是"挂错枝"，而是**重复枝**，
     * 得走删除或"把独有的任务点挪出来"（宿主 hint 的两条出路），另案处理。
     */
    if (mutuallyContained(refs, cRefs)) {
      duplicateTargets.push({ node, target: candidate });
      return false;
    }
    // 候选必须覆盖**这个节点的每一条**引用（路径边界）
    return refs.every((path) => cRefs.some((ref) => covers(ref, path)));
  });
  if (candidates.length === 0) {
    unplaceable.push(node);
    continue;
  }
  if (duplicateTargets.some((item) => item.node.id === node.id)) duplicateNodes.add(node.id);
  const best = candidates.sort((a, b) => {
    // ① 具体度：覆盖这个节点每条 refs 所用到的**最长 ref 路径**里取最短的那条（最坏情况）
    const specDiff = specificity(b, refs) - specificity(a, refs);
    if (specDiff !== 0) return specDiff;
    // ② 树深：同样具体时，挂得越深越贴题
    const depthDiff = depthOf(b) - depthOf(a);
    if (depthDiff !== 0) return depthDiff;
    // ③ 名字：保证每次跑出来的计划一模一样（可复核）
    return a.name.localeCompare(b.name);
  })[0];
  if (best === undefined) continue;
  if (node.parentId === best.id) {
    already.push(node);
    continue;
  }
  moves.push({ node, from: live.find((item) => item.id === node.parentId) ?? null, to: best });
}

console.log(`活节点 = ${live.length}；有 refs 的 = ${live.filter((n) => refsOf(n).length > 0).length}`);
console.log(
  `当前父已覆盖全部 refs（不算挂错）= ${already.length}；跨区（不动，交人判）= ${crossArea.length}；` +
    `需要归位 = ${moves.length}；找不到覆盖枝（不动）= ${unplaceable.length}`,
);
console.log('');
console.log('=== 建议动作（MOVE 挂错的节点 → 覆盖它全部 refs 的**最具体**枝）===');
/** `PM_REFS_COMPACT=1`：只打 `MOVE <childId> <parentId>` —— 便于直接照着执行，不占上下文。 */
if (process.env.PM_REFS_COMPACT === '1') {
  for (const item of moves) console.log(`MOVE ${item.node.id} ${item.to.id}`);
  process.exit(0);
}
for (const item of moves) {
  console.log(
    `MOVE ${item.node.name}（${item.node.id}）\n` +
      `     现在挂：${item.from?.name ?? '(根)'}｜refs=${refsOf(item.node).join('、')}\n` +
      `     移到：  ${item.to.name}（${item.to.id}）refs=${refsOf(item.to).join('、')}`,
  );
}
console.log('');
console.log('=== 与某个候选互为子集（宿主会以 E_DUPLICATE_BRANCH 拒绝 ⇒ 属**重复枝**，另案处理）===');
const dupPairs = [];
for (const item of duplicateTargets) {
  if (!dupPairs.some((p) => p.node.id === item.node.id)) dupPairs.push(item);
}
for (const item of dupPairs.slice(0, 30)) {
  console.log(`  ${item.node.name}（${item.node.id}）refs=${refsOf(item.node).join('、')} ⇄ ${item.target.name}（${item.target.id}）`);
}
if (dupPairs.length > 30) console.log(`  …另有 ${dupPairs.length - 30} 个`);
console.log('');
console.log('=== 引用跨区（**不动**：没有任何枝能同时具体地覆盖它们）===');
for (const node of crossArea.slice(0, 30)) {
  console.log(`  ${node.name}（${node.id}）refs=${refsOf(node).join('、')}`);
}
if (crossArea.length > 30) console.log(`  …另有 ${crossArea.length - 30} 个`);
console.log('');
console.log('=== 找不到覆盖枝（**不动**，宁可留着也不乱塞）===');
for (const node of unplaceable.slice(0, 40)) {
  console.log(`  ${node.name}（${node.id}）refs=${refsOf(node).join('、')}`);
}
if (unplaceable.length > 40) console.log(`  …另有 ${unplaceable.length - 40} 个`);

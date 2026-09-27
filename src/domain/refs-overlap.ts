/**
 * **部分重叠**的兄弟枝判定（FR-158 ⑥ 的补白）。
 *
 * ## 为什么需要它（判据真空白）
 *
 * 现有去重判据只认两种关系：`refs` 集合**完全相同**，或**互为子集**
 * （`analyze-tree-dups.mjs` 的"同引用重复组"与宿主 `E_DUPLICATE_BRANCH` 都是）。
 * 于是**"引用部分重叠、但既不相同也不互为子集"的兄弟枝**可以并存 —— 真机实例：
 *
 * | 兄弟枝 | refs |
 * |---|---|
 * | `产物与源码校验脚本` | verify-artifacts / verify-client-combo / verify-live / verify-source-syntax |
 * | `产物与源码自检` | verify-artifacts / verify-source-syntax / inspect-bundle / find-registration |
 *
 * 两者**同时给 `verify-artifacts.mjs`、`verify-source-syntax.mjs` 计数** ⇒ 权重与分母重复计，
 * 而两个判据都报"0 组"（看不见它）。用户口径"进度推不动/分母灌水"的一部分就来自这类并存。
 *
 * ## 这一层只做判定，不做处置
 *
 * 重叠不等于"该删"：两个兄弟枝可能一个管校验脚本、一个管产物结构，**只是顺手都引到了同一个文件**。
 * 所以这里只把**事实**（重叠了哪些、重叠度多少、是哪一类）列出来交给人/上层判，
 * 不替调用方决定合并或删除 —— 那是产品决策，不是机械判据能拍的事。
 */

/** 判据输入：只要结构面（`service.reviewIndexOf()` 给的就是它）。 */
export interface RefOverlapNode {
  id: string;
  name: string;
  parentId: string | null;
  refs: string[];
}

/** 重叠的类别。`exact`/`subset` 现有判据已经能看见；**`partial` 是这一层新增的能力**。 */
export type RefOverlapKind = 'exact' | 'subset' | 'partial';

/** 一对重叠的兄弟枝。 */
export interface RefOverlapPair {
  a: { id: string; name: string };
  b: { id: string; name: string };
  kind: RefOverlapKind;
  /** 被两边同时引用的路径（**归一到最长的那条**，便于人读）。 */
  shared: string[];
  /** 重叠占"较小的那一侧"的比例（1 = 小的一侧被完全覆盖）。 */
  overlapOfSmaller: number;
}

/** 路径归一化：反斜杠转正斜杠、去 `./` 与尾部 `/`。 */
function normalizeRef(ref: string): string {
  return ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** 一条引用是否覆盖另一条（按路径边界：`src/ai` 覆盖 `src/ai/x.ts`，不覆盖 `src/aix.ts`）。 */
export function refCovers(cover: string, target: string): boolean {
  const a = normalizeRef(cover);
  const b = normalizeRef(target);
  if (a === '' || b === '') return false;
  return a === b || b.startsWith(`${a}/`);
}

/**
 * 两条引用是否"指同一批文件"。
 *
 * 判定用**互相覆盖**而不是字符串相等：兄弟枝一个引目录、一个引目录里的文件时，
 * 字符串不等但文件确实被两边都算了一遍 —— 只看字符串相等会漏掉这类（正是要补的空白）。
 */
function refsIntersect(a: string, b: string): boolean {
  return refCovers(a, b) || refCovers(b, a);
}

/**
 * 找出同一父下**引用重叠**的兄弟枝对。
 *
 * 只比兄弟（同 `parentId`）：父子之间的重叠是"包含"的正常形态（父覆盖子），
 * 而**兄弟之间**的重叠才是"同一批文件被两条并列的任务线各算一遍"。
 *
 * @returns 按重叠路径数降序（并列时按名字，保证可复现）
 */
export function siblingRefOverlaps(nodes: readonly RefOverlapNode[]): RefOverlapPair[] {
  const refsById = new Map(
    nodes.map((node) => [node.id, node.refs.map(normalizeRef).filter((ref) => ref !== '')]),
  );
  const byParent = new Map<string, RefOverlapNode[]>();
  for (const node of nodes) {
    const refs = [...new Set(node.refs.map(normalizeRef).filter((ref) => ref !== ''))];
    if (refs.length === 0) continue;
    const key = node.parentId ?? '(root)';
    /**
     * **无 refs 的父枝 = 辅助任务专区 ⇒ 它下面的兄弟豁免**（用户口径：无法归类且必须存在的跨区节点
     * 用单一区管理、算辅助任务 ⇒ 它们之间引用重叠是**允许**的，不该再报成"待处理重叠"）。
     * 父不在输入里（例如只传了子树）时判不了 ⇒ **不豁免**（保守：宁可多报也不漏报）。
     */
    const parentRefs = refsById.get(key);
    if (parentRefs !== undefined && parentRefs.length === 0) continue;
    const bucket = byParent.get(key);
    const entry: RefOverlapNode = { ...node, refs };
    if (bucket === undefined) byParent.set(key, [entry]);
    else bucket.push(entry);
  }

  const pairs: RefOverlapPair[] = [];
  for (const siblings of byParent.values()) {
    for (let i = 0; i < siblings.length; i += 1) {
      for (let j = i + 1; j < siblings.length; j += 1) {
        const a = siblings[i];
        const b = siblings[j];
        if (a === undefined || b === undefined) continue;
        // 两边都命中的引用：取**更长**的那条作为"共享路径"（更有信息量）
        const shared: string[] = [];
        for (const left of a.refs) {
          for (const right of b.refs) {
            if (!refsIntersect(left, right)) continue;
            const longer = left.length >= right.length ? left : right;
            if (!shared.includes(longer)) shared.push(longer);
          }
        }
        if (shared.length === 0) continue;

        const aSet = new Set(a.refs);
        const bSet = new Set(b.refs);
        const same = a.refs.length === bSet.size && a.refs.every((ref) => bSet.has(ref));
        const aInsideB = a.refs.every((ref) => bSet.has(ref));
        const bInsideA = b.refs.every((ref) => aSet.has(ref));
        const kind: RefOverlapKind = same ? 'exact' : aInsideB || bInsideA ? 'subset' : 'partial';
        /**
         * 重叠度按**较小那一侧有多少条引用参与了重叠**算，而不是 `shared` 的条数：
         * 一条目录引用（`src/ai`）可以同时命中对方多条文件引用，于是"共享条数"会大于
         * 小的一侧的引用条数（比例算出 2.0 这种没意义的数）。按"参与重叠的引用条数 / 该侧条数"
         * 才是有界且可解释的（1 = 小的一侧被完全覆盖）。
         */
        const hitsOf = (side: readonly string[], other: readonly string[]): number =>
          side.filter((left) => other.some((right) => refsIntersect(left, right))).length;
        const smallerSide = a.refs.length <= b.refs.length ? a.refs : b.refs;
        const smallerHits =
          a.refs.length <= b.refs.length ? hitsOf(a.refs, b.refs) : hitsOf(b.refs, a.refs);
        pairs.push({
          a: { id: a.id, name: a.name },
          b: { id: b.id, name: b.name },
          kind,
          shared: shared.sort(),
          overlapOfSmaller: smallerSide.length === 0 ? 0 : smallerHits / smallerSide.length,
        });
      }
    }
  }

  return pairs.sort((left, right) => {
    if (right.shared.length !== left.shared.length) return right.shared.length - left.shared.length;
    return `${left.a.name}|${left.b.name}`.localeCompare(`${right.a.name}|${right.b.name}`);
  });
}

/** 一句话说清重叠（诊断页/工具输出共用，不另写措辞）。 */
export function describeRefOverlap(pair: RefOverlapPair): string {
  const label =
    pair.kind === 'exact' ? '引用完全相同' : pair.kind === 'subset' ? '引用互为子集' : '引用部分重叠';
  return `${pair.a.name} ⇄ ${pair.b.name}：${label}（共 ${pair.shared.length} 条：${pair.shared.join('、')}）`;
}

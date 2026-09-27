/**
 * 节点身份与建树幂等（FR-158）——**纯逻辑，可单测**。
 *
 * ## 为什么必须有这一层
 *
 * 实测教训：同一个工作区被建了两棵 AI 树，随后被 `reparent` 叠加，叶节点从 140 涨到 213，
 * 完成度从 `3/140` 变成 `3/213` —— **分母被灌水，进度再也推不动**。
 * 根因不是"模型建多了"，而是**认节点的方式不对**：
 *
 * | 旧做法 | 后果 |
 * |---|---|
 * | 按**节点名**查重 | 模型换说法（`领域模型与进度计算` → `项目扫描与领域模型`）就绕过去了 |
 * | 只清理"没人动过"的节点 | 报过一次进度的节点永久保留 ⇒ 旧的留着、新的又建 ⇒ **只增不减** |
 * | 合并 = 整枝叠加 | 两棵描述同一份代码的树变成一棵，统计被重复计入 |
 *
 * ## 现在的口径
 *
 * 1. **身份键由 `refs` 路径派生，不由名称派生**：同一个目录/文件 = 同一个节点；
 * 2. **匹配即补录**：复用一个没有 `identity` 的老节点时顺手补登记 —— 下次建树它就能按身份被认出
 *    （否则"按身份匹配"对存量数据永远不生效）；
 * 3. **认不出来才新建**；本轮未再提到的自动节点记 `stale`，**不静默删除**。
 */

import type { NodeKind, Ref } from '../shared/types.ts';

/** 参与匹配的既有节点（只取需要的字段，便于单测直接喂对象）。 */
export interface IdentityNode {
  id: string;
  name: string;
  parentId: string | null;
  refs?: Ref[] | undefined;
  /** 已登记的稳定身份键（老数据可能没有）。 */
  identity?: string | undefined;
}

/** 路径归一：统一分隔符、去掉 `./` 与重复斜杠（`src\domain/` → `src/domain`）。 */
export function normalizeRefPath(target: string): string {
  return target
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * 一个节点的**身份键**（FR-158）——由 `refs` 路径派生。
 *
 * 优先级：① 目录引用（功能点最自然的身份）→ ② 文件引用 → ③ 名称兜底。
 * 路径取**排序后的全集**：同一个功能点换一组 refs、多一个少一个文件，不应该变成两个节点。
 */
export function identityKeyOf(node: { name: string; refs?: Ref[] | undefined }): string {
  const paths = (node.refs ?? [])
    .map((ref) => normalizeRefPath(ref.target))
    .filter((path) => path !== '');
  const dirs = [...new Set(paths.filter((path) => !path.includes('.')))].sort();
  const files = [...new Set(paths.filter((path) => path.includes('.')))].sort();
  if (dirs.length > 0) return `dir:${dirs.join('|')}`;
  if (files.length > 0) return `file:${files.join('|')}`;
  // 没有 refs 的纯抽象功能点：只能用名字兜底（天然不如路径稳，故排最后）
  return `name:${node.name.trim()}`;
}

/** 复用的三种来由（写进 notes，让"为什么没新建"可追溯）。 */
export type ReuseReason = 'identity' | 'sibling-name' | 'ref-overlap' | 'global-name';

export interface ReuseMatch {
  id: string;
  reason: ReuseReason;
  /** 记进 notes 的说明（没有可说的就为 undefined）。 */
  note?: string | undefined;
  /** 复用的同时要不要补登记身份键（该节点原本没有 identity 时）。 */
  relabel?: string | undefined;
}

/**
 * 一个节点的**引用路径集合**（归一化后的目标路径，去重排序）。
 *
 * 用途见 {@link findReusableNode} 的第 ② 层：身份键要求"路径集合完全一致"，
 * 而**目录改名/移动**会让同一个功能点的身份键整体变掉（`dir:src/domain` → `dir:src/core`），
 * 那时只有"引用还有重叠"能把它们认回同一个节点。
 */
export function refTokensOf(node: { refs?: Ref[] | undefined }): string[] {
  const raw = (node.refs ?? []).map((ref) => normalizeRefPath(ref.target)).filter((path) => path !== '');
  return [...new Set(raw)].sort();
}

/**
 * 为一棵树节点挑一个**可复用的既有节点**（不修改任何数据，纯函数，可单测）。
 *
 * 判据顺序**固定**（命中即止）：
 * 1. **身份键**相同 ⇒ 复用 —— 这一条让"模型换说法"不再长出新节点（FR-158 的核心）；
 * 1.5 **引用路径有重叠** ⇒ 复用 —— 兜住"同一批文件/目录被改名或移动"：
 *    身份键是"整个路径集合"的指纹，改名后它整体变掉；如果只看身份键，
 *    同一个功能点会被当成新节点、老节点留着变成 stale（**节点照样涨**，正是要防的事）；
 * 2. **同名** ⇒ 复用（没有 refs 的抽象节点只能靠它；也是老数据的主要路径）；
 * 3. 都不中 ⇒ `undefined`（调用方新建）。
 *
 * @param existingById 既有活节点（**不含已删的墓碑**）
 * @param claimedIds   本轮已经认领过的节点（一个节点不该被两处同时认领）
 * @param hasLiveRoot  是否已有活根（全树同名复用不认根：根由单根规则决定）
 * @param refsOf       读某个既有节点的引用集合（缺省时第 1.5 层不生效）
 */
export function findReusableNode(input: {
  name: string;
  refs?: Ref[] | undefined;
  identityOf: (id: string) => string;
  existingById: ReadonlyMap<string, IdentityNode>;
  claimedIds: ReadonlySet<string>;
  hasLiveRoot: boolean;
  refsOf?: ((id: string) => string[]) | undefined;
}): ReuseMatch | undefined {
  const key = identityKeyOf({ name: input.name, refs: input.refs });
  const relabelOf = (candidate: IdentityNode): string | undefined =>
    candidate.identity === undefined || candidate.identity === '' ? key : undefined;

  // ① 身份键命中
  for (const candidate of input.existingById.values()) {
    if (input.claimedIds.has(candidate.id)) continue;
    if (input.identityOf(candidate.id) !== key) continue;
    const renamed = candidate.name !== input.name;
    return {
      id: candidate.id,
      reason: 'identity',
      ...(renamed ? { note: `「${candidate.name}」按目录身份复用（模型这次叫「${input.name}」）` } : {}),
      ...(relabelOf(candidate) !== undefined ? { relabel: key } : {}),
    };
  }

  // ② 同名（同父同名视为同一个功能点）
  for (const candidate of input.existingById.values()) {
    if (input.claimedIds.has(candidate.id)) continue;
    if (candidate.name !== input.name) continue;
    // 根节点只在"确实就是那个根"时命中（调用方另行处理根，这里跳过根避免误认）
    if (candidate.parentId === null && input.hasLiveRoot) continue;
    return {
      id: candidate.id,
      reason: 'sibling-name',
      ...(relabelOf(candidate) !== undefined ? { relabel: key } : {}),
    };
  }

  /**
   * ③ **引用路径有重叠** ⇒ 复用（兜住目录改名/移动）。
   *
   * **刻意排在同名之后**：同名是更强的语义信号（模型说"这个功能点还叫登录与鉴权"），
   * 而"引用重叠"只说明两者碰过同一批路径 —— 若把它排在前面，
   * "新功能点恰好用了旧功能点所在目录"就会被误配成同一个节点（那是更贵的错误）。
   *
   * 只取**交集非空**这一个条件（不做相似度阈值）：同一批路径出现两次，
   * 大概率就是同一个功能点；命中时带上 `relabel`，让它的身份键跟上新路径
   * —— 否则下次还得再靠一次重叠才认得回来。
   */
  if (input.refsOf !== undefined) {
    const wanted = new Set(refTokensOf({ refs: input.refs }));
    if (wanted.size > 0) {
      for (const candidate of input.existingById.values()) {
        if (input.claimedIds.has(candidate.id)) continue;
        const shared = input.refsOf(candidate.id).filter((token) => wanted.has(token));
        if (shared.length === 0) continue;
        return {
          id: candidate.id,
          reason: 'ref-overlap',
          note: `「${candidate.name}」按引用路径重叠复用（共同路径：${shared.slice(0, 3).join('、')}${
            shared.length > 3 ? ' 等' : ''
          }）`,
          ...(relabelOf(candidate) !== undefined ? { relabel: key } : {}),
        };
      }
    }
  }

  return undefined;
}

/** 既有节点在**本轮未被认领**时的身份键（用于把旧节点与新一轮树对齐）。 */
export function keyOfExisting(node: IdentityNode): string {
  return node.identity !== undefined && node.identity !== ''
    ? node.identity
    : identityKeyOf(node);
}

/** 树的落库节点形状（骨架扫描与 AI 建树共用）。 */
export interface TreeEntry {
  name: string;
  kind: NodeKind;
  refs: Ref[];
  parentIndex: number | null;
}

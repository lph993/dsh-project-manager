/**
 * FR-161：**跨子项目写入的审核判据**（纯函数，可单测）。
 *
 * ## 判据（用户口径）
 *
 * "通过审核后允许跨节点写代码…重点是**跨子项目**时，比如 mobile 前端改完了需要改后台，
 * 但是 mobile 后台又分两种，一种是**只对 mobile 负责**的代码，这种可以直接过，不经审核；
 * 另一种是调用到了**复用接口或者底层、通用代码**等对其他子项目（例如 pc 端和 pc 后台）
 * 有影响的部分需要审核（**对别的任务线产生了影响**），另外关注链路同样如此。"
 *
 * 落成机械判据就是：把本次要改的路径经 `refs` **反转**（文件 → 引用它的节点），
 * 命中的节点若分属 **≥2 个子项目**（子项目 = **根的直接子节点**，与画布分区同一口径）
 * ⇒ 必须过审核。反之：同子项目内、只对本子项目负责的代码、基础/记忆文档与缓存 ⇒ 直接过。
 *
 * ## 这一层刻意只做"判断"
 *
 * 本模块**不读文件、不问人、不写状态**：输入是"要改哪些路径 + 树的结构"，输出是判定与理由。
 * 这样它既能被单测钉住（判错的代价是"正常改动被拦"或"该拦的没拦"），
 * 也不会因为在钩子里读半个仓库而变慢 —— 写入类工具每次调用都要过这一关。
 */

/** 判据输入：节点的**最小结构面**（`service.reviewIndexOf()` 给的就是它）。 */
export interface ReviewNode {
  id: string;
  name: string;
  parentId: string | null;
  /** 是否在关注链路上（FR-161 ⑤：跨关注链路也要审核）。 */
  focus: boolean;
  /** 该节点声称负责的路径（`refs` 的 target）。 */
  refs: string[];
}

/** 判定结果。`required === false` 时 `reason` 说明**为什么不必审**（便于排查"该拦没拦"）。 */
export type ReviewVerdict =
  | {
      required: false;
      reason: 'no-paths' | 'all-whitelisted' | 'no-affected-node' | 'single-project';
    }
  | {
      required: true;
      reason: 'shared-code' | 'cross-focus';
      /** 受影响的任务线（子项目名，去重、稳定排序）。 */
      projects: string[];
      /** 具体命中的节点（界面/提问要能指名道姓）。 */
      affected: Array<{ nodeId: string; name: string; project: string }>;
    };

/**
 * 白名单：这些路径的改动**不触发**审核。
 *
 * 用户口径是"基础文档 / 记忆文档 / 缓存这类**对项目不重要**的节点 ⇒ 直接过"。
 * 这里的三个来源与本插件的数据面一一对应：投影文档、`.pm/` 下的存储与缓存。
 */
export const REVIEW_PATH_WHITELIST: readonly string[] = ['project-manager.md', '.pm/'];

/** 规范化路径：反斜杠转正斜杠、去掉 `./` 前缀与首尾空白。 */
export function normalizeReviewPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 路径是否在白名单里（目录项按前缀匹配，文件项按全等匹配）。 */
export function isWhitelistedPath(path: string): boolean {
  const normalized = normalizeReviewPath(path);
  return REVIEW_PATH_WHITELIST.some((entry) =>
    entry.endsWith('/') ? normalized === entry.slice(0, -1) || normalized.startsWith(entry) : normalized === entry,
  );
}

/**
 * 引用是否覆盖这条路径。
 *
 * 引用可以是**目录**（`src/ai`）也可以是**文件**（`src/ai/scope.ts`），
 * 所以必须按**路径边界**比：`src/ai` 覆盖 `src/ai/scope.ts`，但**不**覆盖 `src/aix.ts`
 * （少了这条边界判断，"同一个前缀"的文件会被误判成受影响的别的任务线 ⇒ 正常改动被拦）。
 */
export function refCoversPath(ref: string, path: string): boolean {
  const target = normalizeReviewPath(ref).replace(/\/+$/, '');
  const file = normalizeReviewPath(path);
  if (target === '') return false;
  return file === target || file.startsWith(`${target}/`);
}

/**
 * 判定一次写入是否需要过审核。
 *
 * @param touchedPaths 本次要改的路径（来自工具参数；读不出来就传空数组 ⇒ 不拦）
 * @param nodes 树的结构面（`service.reviewIndexOf()`）
 */
export function crossProjectVerdict(touchedPaths: readonly string[], nodes: readonly ReviewNode[]): ReviewVerdict {
  const paths = touchedPaths.map(normalizeReviewPath).filter((path) => path !== '');
  if (paths.length === 0) return { required: false, reason: 'no-paths' };
  const judged = paths.filter((path) => !isWhitelistedPath(path));
  if (judged.length === 0) return { required: false, reason: 'all-whitelisted' };

  // ① 路径 → 引用它的节点（**反转** refs）
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const hits = nodes.filter((node) => node.refs.some((ref) => judged.some((path) => refCoversPath(ref, path))));
  if (hits.length === 0) return { required: false, reason: 'no-affected-node' };

  /**
   * ② 每个命中节点归属哪个子项目。
   *
   * 子项目 = **根的直接子节点**（与画布分区同一口径）：沿父链上溯，**父是根时当前这一层就是子项目**；
   * 自己是根（或父链断了 / 成环）就按自己算 —— 成环/断链属于数据异常，这里**不猜**，收手即可。
   */
  const projectOf = (node: ReviewNode): { id: string; name: string } => {
    let current = node;
    const seen = new Set<string>([node.id]);
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      if (parent === undefined) break;
      if (parent.parentId === null) return { id: current.id, name: current.name };
      if (seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return { id: node.id, name: node.name };
  };

  const affected = hits.map((node) => ({ nodeId: node.id, name: node.name, project: projectOf(node).name }));
  const projects = [...new Set(affected.map((item) => item.project))].sort();

  // ③ ≥2 个子项目 ⇒ 改到了"别的任务线也在用"的代码 ⇒ 必须审核
  if (projects.length >= 2) {
    return { required: true, reason: 'shared-code', projects, affected };
  }

  // ④ 跨**关注链路**：命中节点分属 ≥2 条不同的关注枝 ⇒ 同样必须审核
  const focusChains = new Set<string>();
  for (const node of hits) {
    let current: ReviewNode | undefined = node;
    const seen = new Set<string>();
    let chain: string | undefined;
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.focus && chain === undefined) chain = current.id;
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    if (chain !== undefined) focusChains.add(chain);
  }
  if (focusChains.size >= 2) {
    return { required: true, reason: 'cross-focus', projects, affected };
  }

  return { required: false, reason: 'single-project' };
}

/** 把判定结果说成一句人话（提问/拒绝文案共用，**不另写一套措辞**）。 */
export function describeReviewVerdict(verdict: ReviewVerdict): string {
  if (!verdict.required) {
    switch (verdict.reason) {
      case 'no-paths':
        return '没有可判的改动路径';
      case 'all-whitelisted':
        return '只改到投影文档 / 存储缓存这类不重要的路径';
      case 'no-affected-node':
        return '没有节点引用这些路径（无人负责 ⇒ 不影响别的任务线）';
      case 'single-project':
        return '只影响同一条任务线';
    }
  }
  const lines = verdict.affected.map((item) => `${item.name}（${item.project}）`).join('、');
  const why =
    verdict.reason === 'cross-focus' ? '改到了跨关注链路的代码' : '改到了被多个子项目引用的复用代码';
  return `这条改动会影响别的任务线：${why}。涉及子项目：${verdict.projects.join('、')}；命中节点：${lines}`;
}

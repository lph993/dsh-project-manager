/**
 * 破坏性操作守卫（用户口径："动功能点（删除／性质上的修改）属于**危险操作**，任务点没问题"）。
 *
 * ## 为什么需要它
 *
 * 宿主的审批策略（`dsh-user-approval`）**只有会话级 `ask | never` 一个旋钮** ——
 * 要么什么都不弹，要么一视同仁。而"只让**该弹的**弹"必须由**工具自己**声明：
 * 在 `tools/pre-execute` 钩子里返回 `{ kind: 'ask' }`，宿主才会为这次调用请求授权。
 *
 * 因此这里的判据只覆盖**真正危险**的几个工具：
 *
 * | 工具 | 是否要审批 | 为什么 |
 * |---|---|---|
 * | `pm_remove` | ✅ | 删整枝；删**功能点**尤其危险（任务点的把关在服务层判 `kind`） |
 * | `pm_rollback` / `pm_rollback_undo` | ✅ | 回滚会改代码与状态，且可能涉及功能点的枝 |
 * | 其余全部 `pm_*` | ❌ | 推进进度、改描述、关注、门控、订阅、读取 —— 动了也不伤规划结构 |
 *
 * 面板路径不在模型手里（用户当场点的，由面板确认框承载），因此本判据只影响模型侧。
 */

/** 判定的结果：要不要为这次工具调用请求人工授权。 */
export type GuardAsk = { kind: 'ask'; reason: string } | undefined;

/** 这几个工具无论参数如何都要审批（删功能点/回滚都动到了规划结构）。 */
const ALWAYS_ASK: Readonly<Record<string, string>> = {
  pm_remove: '删除整枝（会移除功能点或任务点，仅删记录可恢复）',
  pm_rollback: '回滚会改代码与节点状态',
  pm_rollback_undo: '撤销回滚会再次改动代码与节点状态',
};

/**
 * 这次工具调用要不要请求人工授权（**纯函数**，可单测）。
 *
 * **完全权限 ⇒ 不再重复弹窗**（用户口径："完全权限不需要审核可以直接进行节点危险操作"）。
 * 理由：`danger-full-access` 是用户在会话级**显式选择**的"我信任你直接做"；
 * 这时再为每个删除/回滚弹一次窗，等于把已经表达过的意图再问一遍 ——
 * 审批的意义是"用户没表态时替他拦一下"，**不是"表态了也不信"**。
 *
 * 只认工具名 —— 参数解析刻意不做：`pre-execute` 阶段的参数形状随版本变化，
 * 而"删的是功能点还是任务点"这一层由服务层按 `node.kind` 再判一次（§6.8）。
 */
export function guardAskFor(toolName: string, sandboxMode?: string | undefined): GuardAsk {
  if (sandboxMode === 'danger-full-access') return undefined;
  const reason = ALWAYS_ASK[toolName];
  if (reason === undefined) return undefined;
  return { kind: 'ask', reason };
}

/** 供 UI/诊断用：哪些工具会被拦去审批。 */
export function guardedToolNames(): string[] {
  return Object.keys(ALWAYS_ASK);
}

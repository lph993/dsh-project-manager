/**
 * **模型可见的进度纪律**（提示词段 + 动态上下文），全都零 token 触发。
 *
 * 为什么要有这一层（用户的原始诉求）：
 * "deepseek harness 会话时的工具呢，就是每次子代理或者子任务或者会话结束时进行进度实时修正"
 * —— 光靠宿主在边界上做的事是**不够**的：宿主只能把 `pending` 推成 `running`（那是唯一
 * 有证据的推断），真正的数字只有干活的模型知道。所以必须让模型**自己在收尾前**用工具汇报。
 *
 * 按官方文档（`docs/subsystems/system-prompt.zh.md`）给出的两个机制分开落地：
 *
 * | 机制 | 内容 | 为什么用它 |
 * |---|---|---|
 * | `ctx.systemPrompt.section()` | **静态**纪律文本（本文件 `progressDisciplineText`） | 段文本参与系统提示词，**渲染不变则缓存前缀不动**；所以这里必须是静态的 |
 * | `ctx.systemPrompt.context()` | **动态**事实（本文件 `boundFactsText`） | 官方口径：动态上下文是"缓存安全的持久快照"，只在快照变化时重新记录 |
 *
 * 纪律（都是被踩过才写下来的）：
 * - 段文本里**不许**出现节点名/进度 —— 那会让系统提示词每次都变，直接毁掉前缀缓存；
 * - 动态事实里**只**列订阅过的节点，且**同步**可得（provider 是同步函数，不能 await）；
 * - 排序与裁剪必须**确定**：同样的状态渲染出同样的文本，否则缓存与 diff 全是噪声。
 */

import type { BoundNode } from './boundary.ts';

/**
 * 纪律段的注册名（全局唯一；重复注册会抛）。
 *
 * 前缀用 `project-manager:` 而不是 `pm:` —— 撞名会直接让插件加载失败，
 * 而 `pm:` 太容易被别的东西占用。
 */
export const PM_SECTION_NAME = 'project-manager:progress-discipline';

/** 动态事实的注册名。 */
export const PM_CONTEXT_NAME = 'project-manager:bound-progress';

/**
 * 段顺序。
 *
 * 官方口径：仓库自带贡献方走 `getSectionOrder()` 集中分配的位置，**外部贡献可以用任意有限
 * order**。这里取 9000/9010：排在工具指导之后、harness 源码说明（10000）之前 ——
 * 属于"项目惯例"层级，而不是"身份/人格"层级。
 */
export const PM_SECTION_ORDER = 9000;
export const PM_CONTEXT_ORDER = 9010;

/** 动态事实里最多列几个节点（再多就淹没重点，也白烧 token）。 */
export const MAX_FACT_LINES = 8;

/**
 * **静态**纪律文本。
 *
 * 只讲三件事：什么时候写、写完什么算数、收尾前必须做什么。
 * 「宁少不猜」这句是刻意的：让模型给出没有依据的数字，比不写更糟（污染事实源）。
 *
 * `autoContinue`（FR-162 ②，**默认关**）为真时追加一条"做完就自己取下一条"的自述。
 * 它仍然**只改"模型被告知什么"**：插件不因此唤醒任何会话、不发任何注入
 * （T11：唤醒 = 自动花钱），所以这句话只在用户下次自然输入时才有机会生效。
 */
export function progressDisciplineText(autoContinue = false): string {
  const lines = [
    '本工作区由 project-manager 跟踪进度（工具前缀 pm_，树在侧边栏看板里）。纪律：',
    '- 动手做一个节点时先 pm_progress 置 running；做完一段就更新 progress（0–1，按件数口径）。',
    '- 收尾之前（回合结束 / 子任务结束 / 会话结束）用 pm_report 一次性汇报本次动过的节点：',
    '  做完的 finish=true，没做完的写实际 progress。',
    '- 数字只写你确有依据的值；没有依据就不要写，绝不为了让树好看而猜。',
  ];
  if (autoContinue) {
    lines.push(
      '- 自动接续已开：做完一个节点就先用 pm_report 汇报掉，再用 pm_next 取下一条接着做——不必等用户说继续。',
      '  取不到（pm_next 说没有可做的）就如实停下并说明，不要自己造任务。',
    );
  }
  return lines.join('\n');
}

/** 单个节点的一行事实（确定性文本，便于断言与缓存）。 */
export function factLine(node: BoundNode): string {
  const percent = Math.round(clamp01(node.progress) * 100);
  const gate = node.gate === null ? '' : ` gate=${node.gate}`;
  const state = node.derivedState === node.selfState ? node.selfState : `${node.selfState}/${node.derivedState}`;
  return `- ${node.nodeId} 「${node.name}」 ${state} ${percent}%${gate}`;
}

/**
 * **动态**事实文本：该 agent 当前绑定、且还没做完的节点。
 *
 * 返回 `undefined` 表示"没什么可说的" —— 官方语义里空文本不贡献任何内容，
 * 于是没有任何绑定的会话完全不受影响（不打扰、不烧 token）。
 */
export function boundFactsText(
  bound: readonly BoundNode[],
  options: { limit?: number } = {},
): string | undefined {
  const limit = options.limit ?? MAX_FACT_LINES;
  const live = bound
    .filter((node) => node.derivedState !== 'done' && node.derivedState !== 'removed')
    // 确定性排序：先按自身状态分组（进行中 > 待办 > 异常），同组按 nodeId。
    // **不能**沿用 Map/对象的插入序 —— 那会随写入历史变化，让"同样的状态渲染出不同文本"。
    .sort((a, b) => rank(a.selfState) - rank(b.selfState) || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  if (live.length === 0) return undefined;
  const shown = live.slice(0, limit);
  const lines = shown.map(factLine);
  const rest = live.length - shown.length;
  const header =
    '你（本会话）在 project-manager 上绑定了这些还没做完的节点（收尾前请用 pm_report 更新）：';
  return rest > 0 ? `${header}\n${lines.join('\n')}\n… 另有 ${rest} 个未列出` : `${header}\n${lines.join('\n')}`;
}

/** 自身状态的确定性排序权重（进行中优先，异常也值得看见）。 */
function rank(state: BoundNode['selfState']): number {
  switch (state) {
    case 'running':
      return 0;
    case 'error':
      return 1;
    case 'pending':
      return 2;
    default:
      return 3;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

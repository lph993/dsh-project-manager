/**
 * **节点进度摘要**（纯函数，可单测）—— 用于"开一个新会话处理它"时把现状带过去。
 *
 * 用户诉求："从未完成节点发起会话进行开始处理的能力"。
 *
 * 为什么需要它：`uiWorkspace.startSession()` 只能开**一个空会话**，
 * 插件没法替它预填任务（宿主没有这个 API）。于是"能开始处理"和"真的能开始"之间差一段上下文 ——
 * 这段上下文不用 AI 生成、也不用猜：**节点自己的字段就是现成的**（路径/状态/描述/引用/未完成数），
 * 拼起来粘进新会话即可。
 *
 * 诚实边界：这里只说**已知的字段**，不替模型总结、不编"建议先做 X"。
 * 摘要里没写的东西，新会话就不该以为它知道。
 */

/** 摘要需要的最小节点形状（不绑定 `NodeView`，便于单测直接喂对象）。 */
export interface SummarizableNode {
  name: string;
  kind: string;
  derivedState: string;
  progress: number;
  /** 从根到它的路径（不含自己）。 */
  branchPath: string[];
  description?: string | undefined;
  refs?: ReadonlyArray<{ type: string; target: string }> | undefined;
  /** 子树里的任务点数 / 其中未完成数 / 直接子节点数。 */
  leafCount?: number | undefined;
  unfinishedLeafCount?: number | undefined;
  childCount?: number | undefined;
  /** 前置未完成数（`blockedBy`）。 */
  blockedBy?: readonly string[] | undefined;
  /** 优先级 1..10（1 最高）；没给就不写这一行。 */
  priority?: number | undefined;
}

/** 计算状态 → 中文（与界面同一套说法，避免摘要里冒出 `pending` 这种黑话）。 */
const STATE_ZH: Record<string, string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  error: '异常',
  paused: '已暂停',
  held: '已拦停',
  removed: '已删除',
};

/**
 * 生成一段可直接粘贴的摘要。
 *
 * 只写**有依据**的字段：没有描述的节点不会出现"描述"行（而不是写"（无）"占地方）。
 */
export function buildNodeSummary(node: SummarizableNode): string {
  const lines: string[] = [];
  const path = [...node.branchPath, node.name].join(' / ');
  lines.push(`请处理这个${node.kind === 'feature' ? '功能点' : '任务点'}：${path}`);
  const state = STATE_ZH[node.derivedState] ?? node.derivedState;
  const percent = node.derivedState === 'done' ? 100 : Math.min(99, Math.floor(node.progress * 100));
  lines.push(`状态：${state}（${percent}%）`);
  if (node.priority !== undefined) lines.push(`优先级：${node.priority}（1 最高）`);
  if (typeof node.leafCount === 'number') {
    const unfinished = Math.max(0, Math.trunc(node.unfinishedLeafCount ?? 0));
    const total = Math.max(0, Math.trunc(node.leafCount));
    lines.push(`规模：${total} 个任务点，其中未完成 ${unfinished} 个`);
  }
  if (node.description !== undefined && node.description.trim() !== '') {
    lines.push(`描述：${node.description.trim()}`);
  }
  const refs = (node.refs ?? []).map((ref) => ref.target).filter((target) => target !== '');
  if (refs.length > 0) lines.push(`引用：${refs.join('、')}`);
  if ((node.blockedBy ?? []).length > 0) {
    lines.push(`前置：有 ${node.blockedBy?.length ?? 0} 项未完成，先确认它们的状态`);
  }
  return lines.join('\n');
}

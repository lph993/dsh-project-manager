/**
 * AI 建树的提示词与成本估算（**纯函数**，可单测）。
 *
 * 两条硬要求贯穿全文：
 * 1. **节点必须是功能点或任务点**（FR-39j）——文件只能作为 `refs`，绝不建文件节点；
 * 2. 输出必须是**严格 JSON**，且 `weight` / `progress` 的语义写死：
 *    - `weight` = 相对工作量（1..10，来自**对任务的判断**，不是代码量）；
 *    - `progress` = 完成度初判（0..1，**看代码现状**得出的初值，允许不给）。
 */

import type { NodeKind } from '../shared/types.ts';

/** 仓库骨架里的一行（只含元数据，**不含文件内容**）。 */
export interface SkeletonEntry {
  /** 工作区相对路径（目录不带尾斜杠）。 */
  path: string;
  kind: 'dir' | 'file';
  sizeBytes?: number;
  /** 直接子文件数（目录才有）。 */
  fileCount?: number;
  /** 是否关键文件（package.json / README / tsconfig / 文档…）。 */
  keyFile?: boolean;
  /** 关键文件的签名（截断后的前若干行，来自"只读入口文件"这一级）。 */
  signature?: string;
}

export interface PromptInput {
  /** 项目名建议（来自 package.json 或目录名）。 */
  projectName: string;
  skeleton: readonly SkeletonEntry[];
  /** 最多产出多少节点（与面板/工具的节点上限一致）。 */
  maxNodes: number;
  /** 骨架是否因深度/数量上限被截断（必须如实告知模型）。 */
  truncated?: boolean;
  skipped?: number;
}

/** 系统提示词：把"不许做什么"写清楚，比"要做什么"更能省 token。 */
export const AI_TREE_SYSTEM_PROMPT = [
  '你是项目进度看板的建树助手。',
  '',
  '**输出格式（最优先；违反即视为失败）**：',
  '- 你的回复里**只有**一个 JSON 对象：第一个字符必须是 `{`，最后一个字符必须是 `}`。',
  '- 不要任何解释、前言、后记；不要 Markdown 代码围栏（不要 ```json）；不要写"好的"。',
  '- 键与字符串用双引号；不要注释；不要尾逗号。',
  '',
  '硬规则：',
  '1. 节点必须是「功能点」或「任务点」（kind: "feature" | "task"），**不是文件**。',
  '   文件的唯一用途是节点的 refs（工作区相对路径），禁止为单个文件建节点，',
  '   也禁止出现「其余 N 个文件」这类文件名语气的节点。',
  '2. 名称用中文、动宾或名词短语（如「登录与鉴权」「消息推送服务」「好友列表」），不要照抄目录名。',
  '3. 层级：根 1 个（parent: null），下面按功能分 2–6 个枝，叶节点是可独立完成的任务。',
  '   节点总数不超过 maxNodes；宁可粗一点，也不要堆无意义的小节点。',
  '4. weight 是**相对工作量**（数字 1–10，越大越重），依据是"这件事本身有多大"，',
  '   **不是**已有代码的行数或文件数；没把握就省略该字段。',
  '5. progress 是**完成度初判**（0–1）。只有当你从代码里能看出"这部分已经实现到什么程度"时才给，',
  '   例如：核心逻辑写完且有测试 → 0.8；只有接口骨架 → 0.2；完全没看到 → 省略（不要猜 0）。',
  '6. 不要输出任何"还需多久/预计工时"信息。',
  '',
  '输出 JSON 结构：',
  '{"projectName":"可选，项目名","nodes":[',
  '  {"name":"根功能名","kind":"feature","parent":null,"refs":[{"type":"dir","target":"src"}]},',
  '  {"name":"子功能","kind":"feature","parent":0,"weight":6,"progress":0.4,',
  '   "refs":[{"type":"dir","target":"src/auth"}],"note":"可选：判断依据"}]}',
  '说明：parent 是**该数组里父节点的下标**（根为 null；父必须出现在子之前）。',
].join('\n');

/** 渲染骨架文本（只有路径/大小/关键文件签名，不含整文件内容）。 */
export function renderSkeleton(input: PromptInput): string {
  const lines: string[] = [];
  const dirs = input.skeleton.filter((entry) => entry.kind === 'dir');
  const files = input.skeleton.filter((entry) => entry.kind === 'file');
  lines.push(`项目名建议：${input.projectName}`);
  lines.push(`目录（${dirs.length} 个）：`);
  for (const dir of dirs.slice(0, 120)) {
    const count = dir.fileCount === undefined ? '' : `（${dir.fileCount} 个直接文件）`;
    lines.push(`- ${dir.path}/${count}`);
  }
  lines.push('');
  lines.push(`文件（${files.length} 个，只列关键文件的内容签名）：`);
  for (const file of files.slice(0, 60)) {
    const size = file.sizeBytes === undefined ? '' : ` ${Math.round(file.sizeBytes / 1024)}KB`;
    lines.push(`- ${file.path}${size}`);
    if (file.signature !== undefined && file.signature.trim() !== '') {
      lines.push(`  签名：${file.signature.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
  }
  if (input.truncated === true) {
    lines.push('');
    lines.push('注意：目录遍历因上限被截断，上面不是全部内容，请按可见部分给出骨架。');
  }
  if (input.skipped !== undefined && input.skipped > 0) {
    lines.push(`（另有 ${input.skipped} 个条目被排除/跳过，未列出）`);
  }
  return lines.join('\n');
}

/** 完整的用户消息（骨架 + 任务要求 + 上限）。 */
export function buildTreePrompt(input: PromptInput): string {
  return [
    `请为下面这个仓库生成项目进度树（最多 ${input.maxNodes} 个节点）。`,
    '',
    renderSkeleton(input),
    '',
    '请只输出 JSON。',
  ].join('\n');
}

/** AI 建树的成本估算结果（如实标注"粗估"）。 */
export interface AiEstimate {
  /** 发送给模型的骨架条目数（目录 + 关键文件）。 */
  entries: number;
  /** 关键文件签名的字节数（只有这一小部分会进提示词）。 */
  signatureBytes: number;
  /** 提示词字节数。 */
  promptBytes: number;
  /** 预计调用次数（建树 + 工作量 + 完成度初判合并在同一次调用里）。 */
  calls: number;
  /** 预计输入 token（按字节粗估）。 */
  inputTokens: number;
  /** 输出上限 token。 */
  outputTokens: number;
  /** 预计总 token（粗估，用于成本提示）。 */
  totalTokens: number;
  /** 规模档位，用于 UI 给一句话判断。 */
  level: 'small' | 'medium' | 'large';
}

/**
 * 估算一次 AI 建树的规模。
 *
 * **只用手上已有的元数据**（条目数、签名字节、输出上限），
 * 不为了估成本去读文件（§9.5 T3）。token 换算按"混合中英、约 3 字节/token"粗估，
 * 结果一律标注为粗估 —— 估不准就说估不准。
 */
export function estimateAiBuild(input: {
  entries: number;
  signatureBytes: number;
  promptBytes: number;
  maxOutputTokens: number;
}): AiEstimate {
  // 配置缺失/非法时用保守默认值，绝不把 NaN 传出去（曾经因此算出 totalTokens=null、
  // 档位被误判成 large —— 面板上就是一句吓人的假数字）
  const maxOutputTokens =
    Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
      ? Math.round(input.maxOutputTokens)
      : 4096;
  const promptBytes = Number.isFinite(input.promptBytes) && input.promptBytes > 0 ? input.promptBytes : 0;
  const entries = Number.isFinite(input.entries) && input.entries > 0 ? Math.round(input.entries) : 0;
  const signatureBytes =
    Number.isFinite(input.signatureBytes) && input.signatureBytes > 0 ? Math.round(input.signatureBytes) : 0;
  const inputTokens = Math.ceil(promptBytes / 3);
  const totalTokens = inputTokens + maxOutputTokens;
  const level: AiEstimate['level'] =
    totalTokens < 8000 ? 'small' : totalTokens < 30000 ? 'medium' : 'large';
  return {
    entries,
    signatureBytes,
    promptBytes,
    calls: 1,
    inputTokens,
    outputTokens: maxOutputTokens,
    totalTokens,
    level,
  };
}

/** 档位的中文说明（面板成本提示用）。 */
export function describeEstimate(estimate: AiEstimate): string {
  const levelText =
    estimate.level === 'small'
      ? '规模小，成本很低'
      : estimate.level === 'medium'
        ? '规模中等'
        : '规模较大，建议先缩小扫描范围';
  return (
    `${levelText}：将发送 ${estimate.entries} 个骨架条目` +
    `（关键文件签名 ${Math.round(estimate.signatureBytes / 1024)} KB），` +
    `预计 ${estimate.calls} 次调用、约 ${estimate.totalTokens} token（粗估）。` +
    '不发送整文件内容；建树、相对工作量与完成度初判在同一次调用里完成。'
  );
}

/** 节点类型推断（模型没给 kind 时的兜底：有子节点=功能点，叶子=任务点）。 */
export function inferKind(hasChildren: boolean): NodeKind {
  return hasChildren ? 'feature' : 'task';
}

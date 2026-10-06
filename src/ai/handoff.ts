/**
 * 交接文档的**模型补写**（FR-104a 场景⑤、§9.6.4）。
 *
 * 五个小节里，「进度快照 / 涉及文件 / 未完成清单」是**机械生成（零 token）**；
 * 「下一步」与「关键决策与坑」推导不出来，只能靠模型 —— 这就是本模块唯一负责的东西。
 *
 * 四条纪律（对着 spec 逐条落）：
 * - **FR-101 预算前置**：先给估算、要用户确认，确认了才发调用（调用方负责这一步）；
 * - **FR-100 唯一出口**：模型调用只在这里发生，走 `ctx.llm`，与建树共用同一条路由；
 * - **FR-51 不阻塞**：失败/不可用/拒绝 → 交接文档照常产出，只是文首标注「模型补写部分已跳过」；
 * - **T6 缓存**：同一份提示词命中内容哈希缓存就直接复用，一次调用都不发。
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

import { extractJsonObject } from './parse.ts';
import type { AiRoute } from './route.ts';
import { readUsage, type LlmStreamLike } from './tree-builder.ts';
import type { TokenUsageLike } from './usage.ts';

/** 补写产出的两节内容。 */
export interface HandoffSupplementText {
  /** `## 下一步` 的 Markdown 片段。 */
  nextSteps: string;
  /** `## 关键决策与坑` 的 Markdown 片段。 */
  decisions: string;
}

/** 补写提示词的输入（全部来自**已有**的图数据，不额外读盘）。 */
export interface HandoffPromptInput {
  /** 暂停 / 拦停。 */
  kind: 'pause' | 'hold';
  nodeName: string;
  /** 所属枝路径（面包屑），用于让模型知道自己在树里的位置。 */
  branchPath: readonly string[];
  reason?: string;
  description?: string;
  /** 未完成的任务点（截断后），让"下一步"有事实依据。 */
  unfinished: readonly string[];
  doneLeaves: number;
  totalLeaves: number;
  /** 已登记的引用路径（让模型知道动过哪些文件）。 */
  refs: readonly string[];
  /** 旗标（中途新增 / 自动生成 / 回滚过…）。 */
  flags: readonly string[];
}

export const HANDOFF_SYSTEM_PROMPT = [
  '你在为一个"功能点/任务点"项目树写交接文档的两个小节，读者是**下一个接手的人（或模型）**。',
  '只输出一个 JSON 对象，不要任何解释、不要 markdown 围栏，格式严格为：',
  '{"nextSteps": "...", "decisions": "..."}',
  '要求：',
  '- nextSteps：接下来该做什么，3–6 条 Markdown 列表项，动词开头，具体到"改哪个文件/验什么"。',
  '- decisions：已知的关键决策与坑，0–5 条列表项；没有就写"（暂无：本枝尚无值得记录的决策或坑）"。',
  '- **不要复述节点名与进度数字**（那部分由插件机械生成，重复只会浪费读者的注意力）。',
  '- 不确定的事**不要编**：宁可少写，也不要虚构文件、接口或结论。',
].join('\n');

/** 渲染补写提示词（纯函数，便于测试与缓存键计算）。 */
export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const lines: string[] = [
    `# 交接对象`,
    `- 名称：${input.nodeName}`,
    ...(input.branchPath.length > 0 ? [`- 路径：${input.branchPath.join(' / ')}`] : []),
    `- 动作：${input.kind === 'pause' ? '暂停（稍后继续）' : '拦停整枝（需重新评审才放行）'}`,
    ...(input.reason !== undefined && input.reason !== '' ? [`- 原因：${input.reason}`] : []),
    ...(input.description !== undefined && input.description !== ''
      ? [`- 说明：${input.description}`]
      : []),
    '',
    `# 事实（插件已经查过，不要重复复述）`,
    `- 任务点：已完成 ${input.doneLeaves} / 共 ${input.totalLeaves}`,
    ...(input.flags.length > 0 ? [`- 标记：${input.flags.join('、')}`] : []),
    ...(input.refs.length > 0 ? [`- 已登记引用：${input.refs.slice(0, 20).join('、')}`] : []),
  ];
  if (input.unfinished.length > 0) {
    lines.push('', '# 未完成的任务点（最多列 20 个）');
    for (const item of input.unfinished.slice(0, 20)) lines.push(`- ${item}`);
  }
  lines.push('', '现在输出那个 JSON 对象。');
  return lines.join('\n');
}

/** 补写成本的粗估（与建树同口径：只用手上元数据，不读文件）。 */
export interface HandoffEstimate {
  calls: number;
  promptBytes: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  level: 'small' | 'medium' | 'large';
}

/** 粗估 token（§9.5 T3：**不为了估成本去读文件**，只用已渲染的提示词字节数）。 */
export function estimateHandoffSupplement(input: {
  promptBytes: number;
  maxOutputTokens: number;
}): HandoffEstimate {
  const inputTokens = Math.ceil(input.promptBytes / 3);
  const outputTokens = Math.min(input.maxOutputTokens, 800);
  const totalTokens = inputTokens + outputTokens;
  const level: HandoffEstimate['level'] =
    totalTokens < 2000 ? 'small' : totalTokens < 8000 ? 'medium' : 'large';
  return {
    calls: 1,
    promptBytes: input.promptBytes,
    inputTokens,
    outputTokens,
    totalTokens,
    level,
  };
}

/** 调用结果（`usage` = 提供方回报的真实用量，失败/取消时也可能有）。 */
export type HandoffCallResult =
  | { ok: true; supplements: HandoffSupplementText; rawText: string; usage?: TokenUsageLike }
  | {
      ok: false;
      reason: 'llm-unavailable' | 'call-failed' | 'empty-output' | 'invalid-output';
      message: string;
      usage?: TokenUsageLike;
    };

/** 提示词/解析口径版本：改了就让旧缓存失效（与建树同一套纪律）。 */
export const HANDOFF_PROMPT_VERSION = 'handoff-v1';

/**
 * 从模型输出里取出两节内容。
 *
 * 容错口径与建树一致：允许 ```json 围栏、允许字段是字符串或字符串数组、
 * 允许把"暂无"写成空字符串。**只有"压根没有 JSON"才算失败** —— 那时如实说失败，不猜。
 */
export function parseHandoffSupplements(text: string): HandoffSupplementText | string {
  const json = extractJsonObject(text);
  if (json === undefined) return '输出里找不到 JSON 对象';
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
  }
  if (parsed === null || typeof parsed !== 'object') return 'JSON 不是对象';
  const record = parsed as Record<string, unknown>;
  const read = (key: string): string => {
    const value = record[key];
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item !== '')
        .join('\n');
    }
    return '';
  };
  const nextSteps = read('nextSteps');
  const decisions = read('decisions');
  if (nextSteps === '' && decisions === '') return '两节内容都是空的';
  return {
    nextSteps: nextSteps === '' ? '（模型未给出「下一步」）' : nextSteps,
    decisions: decisions === '' ? '（暂无：本枝尚无值得记录的决策或坑）' : decisions,
  };
}

/** 调用入口（测试可注入 `stream`；生产走 `ctx.llm`）。 */
export interface HandoffCallInput {
  route: AiRoute;
  system: string;
  user: string;
  maxTokens: number;
  stream?: LlmStreamLike | undefined;
}

/**
 * 发一次补写调用并解析。
 *
 * 与建树共用**同一套** chunk 契约（`assembler.push(chunk)` 再读 `assembler.blocks()`），
 * 不自己另发明一套累加逻辑 —— 早先那版手写累加就是错的（猜 API，永远取不到文本）。
 * 失败一律结构化返回，不抛给上层（上层要"失败也不阻塞暂停"）。
 */
export async function callHandoffSupplement(
  input: HandoffCallInput,
): Promise<HandoffCallResult> {
  let text = '';
  // 组装器提到 try 外：失败/取消时也可能已经拿到提供方回的 usage（花过的钱要记得住）
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of input.stream!.stream({
      provider: input.route.provider,
      model: input.route.model,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: input.user }],
          source: { kind: 'plugin', plugin: 'dsh-project-progress' },
        }),
      ],
      system: input.system,
      maxTokens: input.maxTokens,
    })) {
      assembler.push(chunk as never);
    }
    const blocks = assembler.blocks() as Array<{ type: string; text?: string }>;
    text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  } catch (error) {
    const usage = readUsage(assembler);
    return {
      ok: false,
      reason: 'call-failed',
      message: `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  const usage = readUsage(assembler);
  if (text.trim() === '') {
    return {
      ok: false,
      reason: 'empty-output',
      message: '模型没有返回任何文本内容。',
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  const parsed = parseHandoffSupplements(text);
  if (typeof parsed === 'string') {
    return {
      ok: false,
      reason: 'invalid-output',
      message: `模型输出不符合要求：${parsed}`,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return { ok: true, supplements: parsed, rawText: text, ...(usage !== undefined ? { usage } : {}) };
}

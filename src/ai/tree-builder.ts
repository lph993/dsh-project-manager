/**
 * AI 建树的模型调用（宿主侧唯一出口）。
 *
 * 形态照抄 DSH 自己的 `dsh-session-title-llm`（那是"插件里怎么正确调一次模型"的
 * 官方样板）：`ctx.llm.stream(options)` + `BlockAssembler`，用 `deadline` 限时，
 * 只发文本消息（`createUserMessage` + `source.plugin` 标注来源）。
 *
 * 这里**不做确认与预算**：那两件事由上层（service / 面板确认框）负责，
 * 免得"能不能花钱"的判断散落在调用点（§9.5 T1–T3 的收口纪律）。
 */

import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

import { parseTreeResponse, type ParseOutcome } from './parse.ts';
import type { AiRoute } from './route.ts';

/** 允许注入的流式实现（单测用假模型；生产走 `ctx.llm.stream`）。 */
export interface LlmStreamLike {
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    system?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

export interface BuildTreeCallInput {
  ctx: Context;
  route: AiRoute;
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** 测试注入点：给了就用它，不再查 `ctx.llm`。 */
  stream?: LlmStreamLike;
}

export interface BuildTreeCallOk {
  ok: true;
  parsed: Extract<ParseOutcome, { ok: true }>;
  /** 模型原始输出（诊断用；只在失败/审计时展示截断片段）。 */
  rawText: string;
}

export interface BuildTreeCallFail {
  ok: false;
  /** 结构化原因，便于上层区分"没模型/超时/输出不合法"。 */
  reason: 'llm-unavailable' | 'call-failed' | 'empty-output' | 'invalid-output' | 'aborted';
  message: string;
  rawText?: string;
}

export type BuildTreeCallResult = BuildTreeCallOk | BuildTreeCallFail;

/** 从 `ctx` 取 llm 服务（缺失返回 undefined，不抛）。 */
export function llmStreamOf(ctx: Context): LlmStreamLike | undefined {
  try {
    const service = (ctx as unknown as { get?: (key: string) => unknown }).get?.('llm') as
      | LlmStreamLike
      | undefined;
    return typeof service?.stream === 'function' ? service : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 调一次模型并解析成树。
 *
 * @returns 成功时返回解析结果；失败时返回**结构化原因**（绝不抛给路由层）
 */
export async function callTreeBuilder(input: BuildTreeCallInput): Promise<BuildTreeCallResult> {
  const llm = input.stream ?? llmStreamOf(input.ctx);
  if (llm === undefined) {
    return {
      ok: false,
      reason: 'llm-unavailable',
      message: '宿主没有可用的 llm 服务（ctx.llm 缺失），无法发起 AI 建树。',
    };
  }

  const message = createUserMessage({
    content: [{ type: 'text', text: input.user }],
    source: { kind: 'plugin', plugin: 'dsh-project-manager' },
  });

  let text = '';
  try {
    const assembler = new BlockAssembler();
    for await (const chunk of llm.stream({
      provider: input.route.provider,
      model: input.route.model,
      messages: [message],
      system: input.system,
      maxTokens: input.maxTokens,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })) {
      assembler.push(chunk as never);
    }
    const blocks = assembler.blocks() as Array<{ type: string; text?: string }>;
    text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  } catch (error) {
    const aborted = input.signal?.aborted === true;
    return {
      ok: false,
      reason: aborted ? 'aborted' : 'call-failed',
      message: aborted
        ? 'AI 建树已取消。'
        : `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (text.trim() === '') {
    return { ok: false, reason: 'empty-output', message: '模型没有返回任何文本内容。' };
  }

  const parsed = parseTreeResponse(text);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: 'invalid-output',
      message: `模型输出不符合要求：${parsed.error}`,
      rawText: text.slice(0, 600),
    };
  }
  return { ok: true, parsed, rawText: text };
}

/**
 * AI 建树的模型路由解析（宿主侧，能力探测式）。
 *
 * 优先级：
 * 1. 插件设置里的 `aiProvider` / `aiModel`（FR-81a：允许给扫描指定更便宜的模型）；
 * 2. 宿主当前默认模型 `ctx.agentDefaultModel.currentSelection()`（跟随主会话）；
 * 3. 都没有 → **不调用**，返回可执行的原因（让用户去设置里填，而不是静默失败）。
 *
 * 刻意**不**把 `llm` 写进 `inject`：AI 是可选能力，写进去会让"没配模型"的机器
 * 整个插件加载失败（§19.4 的不变量：可选能力缺失不得阻断加载）。
 */

import type { Context } from '@deepseek-ai/cordis';

export interface AiRoute {
  provider: string;
  model: string;
  source: 'config' | 'default-selection';
}

export type RouteOutcome = { ok: true; route: AiRoute } | { ok: false; reason: string; hint: string };

interface DefaultModelLike {
  currentSelection?: () => { provider?: unknown; model?: unknown } | undefined;
}

/** 读宿主默认模型选择（不可读时返回 undefined，不抛错）。 */
function readDefaultSelection(ctx: Context): { provider: string; model: string } | undefined {
  try {
    const service = (ctx as unknown as { get?: (key: string) => unknown }).get?.(
      'agentDefaultModel',
    ) as DefaultModelLike | undefined;
    const selection = service?.currentSelection?.();
    const provider = selection?.provider;
    const model = selection?.model;
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      return { provider, model };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 解析模型路由；缺配置或缺服务时给出**可执行**的提示。 */
export function resolveAiRoute(input: {
  ctx: Context;
  configProvider?: string | undefined;
  configModel?: string | undefined;
}): RouteOutcome {
  const provider = input.configProvider?.trim();
  const model = input.configModel?.trim();
  if (provider !== undefined && provider !== '' && model !== undefined && model !== '') {
    return { ok: true, route: { provider, model, source: 'config' } };
  }
  if ((provider !== undefined && provider !== '') || (model !== undefined && model !== '')) {
    return {
      ok: false,
      reason: 'ai-route-incomplete',
      hint: '设置里的「AI 模型」必须同时填 provider 与 model（现在只填了一个）。',
    };
  }

  const selection = readDefaultSelection(input.ctx);
  if (selection !== undefined) {
    return { ok: true, route: { ...selection, source: 'default-selection' } };
  }

  return {
    ok: false,
    reason: 'ai-route-unavailable',
    hint:
      '没有可用的模型路由。请在插件设置里填 AI 建树用的 provider / model，' +
      '或在 DSH 的模型设置里选一个默认模型；配好之前不会发起任何 AI 调用。',
  };
}

/** `llm` 服务是否可用（不可用时如实说明，而不是抛异常）。 */
export function llmAvailable(ctx: Context): boolean {
  try {
    const service = (ctx as unknown as { get?: (key: string) => unknown }).get?.('llm') as
      | { stream?: unknown }
      | undefined;
    return typeof service?.stream === 'function';
  } catch {
    return false;
  }
}

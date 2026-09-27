/**
 * 确认路由（§6.7f / FR-135–139）——**审批与提问两条 seam 的唯一出口**。
 *
 * 设计要点（回应用户把审批策略从 `ask` 改成 `never` 这件事）：
 * - 准入（这个动作该不该执行）走 `ctx.approval` 的**一次性授权**；只有 `allowed-once` 才放行。
 * - preview / 影响范围走 `ctx.userQuestions`，因为**审批请求只带 toolName 与 reason、不带参数**。
 * - 任何一步不可用（策略 `never`、无应答者、非未结束轮次、子代理）→ **拒绝执行**（fail-closed），
 *   并给出可执行的替代路径；**绝不**降级为"默认同意"（FR-136）。
 * - 五类拒绝原因必须可区分（FR-137），避免用户误判为插件损坏。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';

import type { Clock, RandomSource } from '../domain/mutate.ts';
import type { CapabilityReport } from './capabilities.ts';

/** 拒绝原因分类（FR-137）。 */
export type DenyReason =
  | 'policy-never'
  | 'no-channel'
  | 'cancelled'
  | 'unavailable'
  | 'validation'
  | 'needs-human';

/** 统一的确认结果。 */
export type ConfirmResult =
  | { ok: true; outcome: 'allowed-once'; authorizeId: string }
  | { ok: false; reason: DenyReason; message: string; hint: string };

/** 需要确认的动作（封闭清单里的每一项都由这些标识指认）。 */
export type ConfirmAction =
  | 'remove-branch'
  | 'rollback'
  | 'branch-rollback'
  | 'rollback-undo'
  | 'ai-scan'
  | 'ai-weight'
  /**
   * **AI 建树要覆盖"人手动改过的优先级"**（用户口径："人改过的节点可以被AI覆盖，
   * 需要项目进度审核权限(ask弹窗)"）。
   *
   * 单独一个 action 而不是复用 `ai-weight`：授权范围要**窄**——人在弹窗里批准的是
   * "覆盖这几个节点的优先级"，不是"以后 AI 都能随便改建树结果"。
   */
  | 'ai-build-priority-overwrite';

/** 提问项（对应 `AskUserQuestionItem` 的结构子集）。 */
export interface QuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type QuestionAnswer =
  | { ok: true; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { ok: false; reason: DenyReason; message: string; hint: string };

/** 审批服务的结构形状（只依赖我们真正用到的成员，便于测试替身）。 */
interface ApprovalLike {
  request(req: {
    agent: Agent;
    toolName: string;
    callId?: ToolCallId;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome>;
}

/** 提问服务的结构形状。 */
interface UserQuestionsLike {
  ask(req: {
    agent?: Agent;
    questions: QuestionItem[];
    signal?: AbortSignal;
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>;
}

export interface ConfirmRouter {
  readonly capabilities: CapabilityReport;
  /** 准入：拿到一次性授权才返回 ok。 */
  authorize(input: {
    action: ConfirmAction;
    toolName: string;
    reason: string;
    agent?: Agent | undefined;
    callId?: ToolCallId | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ConfirmResult>;
  /** 展示 preview / 澄清提问。 */
  ask(input: {
    questions: QuestionItem[];
    agent?: Agent | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<QuestionAnswer>;
  /** 供 UI 与设置页读取的一句话说明：破坏性操作当前需在哪里确认。 */
  describeChannel(): string;
}

export interface ConfirmRouterDeps {
  capabilities: CapabilityReport;
  clock: Clock;
  random: RandomSource;
}

/** 面板替代路径的统一提示（FR-136 的"可执行替代路径"）。 */
const PANEL_HINT = '请在 Harness 侧边栏打开「项目进度」面板，在流程图节点上右键 → 选择对应操作确认';

export function createConfirmRouter(ctx: Context, deps: ConfirmRouterDeps): ConfirmRouter {
  const { capabilities } = deps;

  function approvalService(): ApprovalLike | undefined {
    try {
      const value = (ctx as unknown as { get?: (key: string) => unknown }).get?.('approval');
      if (value && typeof (value as ApprovalLike).request === 'function') {
        return value as ApprovalLike;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function questionsService(): UserQuestionsLike | undefined {
    try {
      const value = (ctx as unknown as { get?: (key: string) => unknown }).get?.('userQuestions');
      if (value && typeof (value as UserQuestionsLike).ask === 'function') {
        return value as UserQuestionsLike;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  return {
    capabilities,

    async authorize(input): Promise<ConfirmResult> {
      // ① 子代理/作业边界（FR-138a）：归属其他 agent 的存活子代理不能向人提问，
      //    因此也不该尝试准入 —— 直接回落为"待人工确认"，由父会话或面板完成。
      if (input.agent === undefined) {
        return {
          ok: false,
          reason: 'needs-human',
          message: `「${input.action}」需要人工确认，但本次调用没有可归属的会话（可能是子代理或后台作业）`,
          hint: `${PANEL_HINT}；子代理请把 preview 放进最终结果，由父会话确认`,
        };
      }

      // ② seam 缺失 → 无通道，拒绝（不是"同意"）
      const approval = approvalService();
      if (!approval) {
        return {
          ok: false,
          reason: 'no-channel',
          message: `「${input.action}」需要一次性授权，但当前组合没有审批通道（ctx.approval 未装配）`,
          hint: PANEL_HINT,
        };
      }

      let outcome: ApprovalOutcome;
      try {
        outcome = await approval.request({
          agent: input.agent,
          toolName: input.toolName,
          reason: input.reason,
          ...(input.callId !== undefined ? { callId: input.callId } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      } catch (error) {
        // 请求必须处于未结束的轮次内；空闲或轮次之间调用会在审计前抛错。
        return {
          ok: false,
          reason: 'unavailable',
          message: `审批请求无法送达：${error instanceof Error ? error.message : String(error)}`,
          hint: `${PANEL_HINT}；若在会话空闲时发起，请改为在面板内确认`,
        };
      }

      switch (outcome) {
        case 'allowed-once':
          return { ok: true, outcome: 'allowed-once', authorizeId: deps.random.uuid() };
        case 'rejected':
          return {
            ok: false,
            reason: 'policy-never',
            message: `「${input.action}」被确定性拒绝（会话审批策略为 never，或无应答者时以拒绝方式关闭）`,
            hint: `${PANEL_HINT}；本插件不会在策略拒绝后静默放行`,
          };
        case 'cancelled':
          return {
            ok: false,
            reason: 'cancelled',
            message: `「${input.action}」的授权请求已被取消`,
            hint: '重新发起操作即可再次请求确认',
          };
        default:
          return {
            ok: false,
            reason: 'no-channel',
            message: `「${input.action}」无法取得授权（无应答者可用）`,
            hint: PANEL_HINT,
          };
      }
    },

    async ask(input): Promise<QuestionAnswer> {
      const questions = questionsService();
      if (!questions) {
        return {
          ok: false,
          reason: 'no-channel',
          message: '无法向用户提问：当前组合没有提问通道（ctx.userQuestions 未装配）',
          hint: PANEL_HINT,
        };
      }
      try {
        const result = await questions.ask({
          questions: input.questions,
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        return { ok: true, answers: result.answers ?? [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 子代理被 DELEGATED_CALLER 拒绝时，语义是"待人工"，不是"通道坏了"
        if (/DELEGATED_CALLER/i.test(message)) {
          return {
            ok: false,
            reason: 'needs-human',
            message: '子代理不能直接向用户提问，需由父会话确认',
            hint: '把未决问题与 preview 放进最终结果上报',
          };
        }
        return {
          ok: false,
          reason: 'unavailable',
          message: `提问失败：${message}`,
          hint: PANEL_HINT,
        };
      }
    },

    describeChannel(): string {
      const parts: string[] = [];
      parts.push(
        capabilities.approval
          ? '模型侧破坏性操作经审批通道授权（策略为 never 时一律拒绝）'
          : '模型侧破坏性操作无审批通道，全部拒绝',
      );
      parts.push(
        capabilities.userQuestions
          ? '影响范围与澄清经提问通道展示'
          : '提问通道不可用，需在面板内查看影响范围',
      );
      parts.push('面板内右键操作始终可用（用户在场，走面板确认弹窗）');
      return parts.join('；');
    },
  };
}

/** 供 UI 复用的原因标签（FR-137：文案必须可区分）。 */
export const DENY_REASON_LABEL: Record<DenyReason, string> = {
  'policy-never': '策略拒绝',
  'no-channel': '无确认通道',
  cancelled: '授权已取消',
  unavailable: '通道暂不可用',
  validation: '校验失败',
  'needs-human': '待人工确认',
};

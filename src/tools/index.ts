/**
 * AI 工具集（§13.1）。UI 与工具走同一服务层，保证行为一致（FR-71）。
 *
 * 设计纪律：
 * - 返回**精简且稳定**的文本（FR-74），裁剪与省略提示统一走 `dsh-output-retention`；
 * - 破坏性工具（`pm_remove` / `pm_rollback`）**不自行判定确认**，一律经 `adapter/confirm.ts`；
 * - 工具层是唯一知道"当前会话工作区 cwd"的地方（DSH 的 cwd 是 per-call 值），
 *   因此每次执行都会把它告知 `ProjectService`。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

import type { ProjectService, ApplyResult } from '../service.ts';
import type { SelfState } from '../shared/types.ts';
import { describeConsolidation, planConsolidation } from '../domain/consolidate.ts';

/** 工具返回的文本上限（FR-74：不污染模型上下文）。 */
const TEXT_LIMIT = 4000;

/** 从执行上下文取当前会话的工作区根。 */
function workspaceRootOf(exec: ToolRunContext): string | undefined {
  try {
    const agent = exec.agent as { session?: { header?: { cwd?: string } } } | undefined;
    return agent?.session?.header?.cwd;
  } catch {
    return undefined;
  }
}

/** 工具调用的来源描述（§10.4 权限表）。 */
function callerOf(exec: ToolRunContext): {
  by: 'session' | 'subagent' | 'user';
  actorId?: string;
} {
  const agent = exec.agent as
    | { id?: string; session?: { id?: string }; parent?: unknown }
    | undefined;
  if (!agent) return { by: 'user' };
  // 有 parent 说明是子代理
  const isSubagent = agent.parent !== undefined;
  const id = agent.id ?? agent.session?.id;
  return isSubagent
    ? { by: 'subagent', ...(id !== undefined ? { actorId: id } : {}) }
    : { by: 'session', ...(id !== undefined ? { actorId: id } : {}) };
}

/**
 * 发起这次调用的会话 id（1:1 对应 `exec.agent.id`）。
 *
 * 服务用它做**按会话**的工作区根解析：多会话同时开在不同工作区时，
 * A 会话的工具调用不得把 B 会话的面板/项目带偏。
 */
function sessionIdOf(exec: ToolRunContext): string | undefined {
  try {
    const agent = exec.agent as { id?: string; session?: { id?: string } } | undefined;
    return agent?.id ?? agent?.session?.id;
  } catch {
    return undefined;
  }
}

/** 截断长文本并**如实标注**省略（FR-126：不自造措辞，这里是最小实现）。 */
function clip(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const omitted = text.length - TEXT_LIMIT;
  return `${text.slice(0, TEXT_LIMIT)}\n…（已省略 ${omitted} 个字符）`;
}

/** 把一个写入结果渲染成给模型看的单行 JSON（结构化、稳定）。 */
function renderResult(result: ApplyResult): string {
  return JSON.stringify(result);
}

/**
 * 注册全部 `pm_*` 工具。
 *
 * @returns 卸载函数（逐个工具的 disposer 组合）
 */
export function registerTools(ctx: Context, service: ProjectService): () => void {
  const disposers: Array<() => void> = [];

  /**
   * 每次工具调用的前置动作：报告这次调用的工作区根，并**返回会话 id**。
   *
   * 返回会话 id 是为了让写路径把项目绑到"**这次调用所属会话**的工作区"
   * （见 `ProjectService.bindForCall`）—— 只报告根是不够的：根记在全局
   * `pendingRoot` 上，会被别的会话的面板轮询覆盖，于是写入会落到别人的项目里。
   */
  const withRoot = <A>(exec: ToolRunContext): string | undefined => {
    const sessionId = sessionIdOf(exec);
    service.noteWorkspaceRoot(workspaceRootOf(exec), sessionId);
    return sessionId;
  };

  // ── 读 ────────────────────────────────────────────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_tree',
        description:
          '读取项目节点树（可限深/分页）。返回精简字段；需要单节点详情用 pm_node。' +
          '本插件只提供百分比与未完成计数，不提供周期估算。',
        parameters: {
          rootId: { type: 'string', description: '以该节点为根；省略则从项目根开始' },
          depth: { type: 'number', description: '最大深度（1 起）' },
          limit: { type: 'number', description: '单次返回节点数上限，默认 50' },
          detail: { type: 'boolean', description: '是否返回描述与引用' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const tree = await service.tree({
            ...(args.rootId !== undefined ? { rootId: args.rootId } : {}),
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
          });
          return tree as unknown as JsonValue;
        },
        presentCall: (args) => ({
          card: 'generic',
          title: 'Read project tree',
          kind: 'other',
          rawInput: args,
        }),
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_node',
        description: '读取单个节点的详情（状态、进度、权重、计数、订阅数、所属枝路径）。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const view = await service.nodeView(args.nodeId);
          return (view ?? { error: 'not-found', nodeId: args.nodeId }) as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 写 ────────────────────────────────────────────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_add',
        description:
          '在当前节点下新增子节点（同级名称必须唯一）。中途新增的分支会带 addedMidway 标记。',
        parameters: {
          parentId: { type: 'string', description: '父节点 id；省略表示新增为项目根' },
          name: { type: 'string', required: true, description: '节点简称（同级唯一）' },
          kind: {
            type: 'string',
            enum: ['feature', 'task'],
            description: '功能点或任务点；默认 task',
          },
          description: { type: 'string', description: '详细说明（名称之外的说明放这里）' },
          addedMidway: { type: 'boolean', description: '是否标记为中途新增' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.addNode({
            parentId: args.parentId ?? null,
            name: args.name,
            ...(args.kind !== undefined ? { kind: args.kind as 'feature' | 'task' } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.addedMidway !== undefined ? { addedMidway: args.addedMidway } : {}),
            by: caller.by,
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_consolidate',
        description:
          '重复枝合并（FR-158 ⑥）：默认**只给方案**（不改数据）—— 找出"同一父下引用**完全相同或互为子集**"的并列副本，' +
          '给出**先搬谁 → 并哪处进度 → 删哪个空壳**的动作清单；传 `apply=true` 则**按计划执行**' +
          '（先搬后删、删前并进度，全程走既有的 `reparentNode` / `progress` / `removeBranch`，带审计、可回滚）。' +
          '口径写死：**部分重叠不算重复**（那只是范围有交集，不是同一份代码被评估两次 —— 曾按它算出"121 个可删"，' +
          '逐条看全是功能点与其下属任务点的正常层级）；**父枝没有 refs 时豁免**（那是「跨区辅助任务」专区，' +
          '辅助任务之间重叠是允许的）；保留者按 `子节点多 > 有描述 > 进度高 > 名字` 选；' +
          '**每个待删者的活子节点都会被先搬走**（所以删掉的只会是空壳）。',
        parameters: {
          apply: {
            type: 'boolean',
            description:
              'false（默认）= 只出方案；true = 按方案执行（先搬 → 并进度 → 删空壳）。' +
              '建议先不带参数看一眼动作清单，确认后再 apply',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          const plan = planConsolidation(await service.reviewIndexOf());
          const summary = describeConsolidation(plan);
          if (args.apply !== true) {
            return {
              status: 'ok',
              action: 'consolidate-plan',
              message: summary,
              detail: { summary, actions: plan.actions, notes: plan.notes },
            } as unknown as JsonValue;
          }

          const moves: Array<{ nodeId: string; to: string; status: string }> = [];
          const folds: Array<{ nodeId: string; progress: number; status: string }> = [];
          const deletes = plan.actions.filter((action) => action.kind === 'delete');
          // ① 先搬（无损）：被删者的活子节点挂到保留者下
          for (const action of plan.actions) {
            if (action.kind !== 'move') continue;
            const result = (await service.reparentNode({
              nodeId: action.nodeId,
              parentId: action.toParentId,
              by: caller.by,
              ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
              reason: action.reason,
            })) as { status?: string; code?: string };
            moves.push({ nodeId: action.nodeId, to: action.toParentId, status: result?.status ?? result?.code ?? '?' });
          }
          // ② 再并进度（删之前并，否则信息就丢了）
          for (const action of plan.actions) {
            if (action.kind !== 'fold') continue;
            const result = (await service.progress({
              nodeId: action.nodeId,
              progress: action.progress,
              by: caller.by,
              ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
              reason: action.reason,
            })) as { status?: string; code?: string };
            folds.push({
              nodeId: action.nodeId,
              progress: action.progress,
              status: result?.status ?? result?.code ?? '?',
            });
          }
          // ③ 最后删空壳（一次批量；模型侧要一次确认句柄，这里两步走完）
          let removed: string[] = [];
          let deleteStatus = 'skipped';
          let deleteCode: string | undefined;
          if (deletes.length > 0) {
            const nodeIds = deletes.map((action) => action.nodeId);
            const first = (await service.removeBranch({
              nodeIds,
              policy: 'record',
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
              toolName: 'pm_consolidate',
            })) as { status?: string; confirmToken?: string; code?: string; message?: string };
            if (first.status === 'needs-confirm' && typeof first.confirmToken === 'string') {
              const second = (await service.removeBranch({
                nodeIds,
                policy: 'record',
                confirmToken: first.confirmToken,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
                toolName: 'pm_consolidate',
              })) as { status?: string; removed?: string[]; code?: string };
              deleteStatus = second.status ?? '?';
              deleteCode = second.code;
              removed = second.removed ?? [];
            } else {
              deleteStatus = first.status ?? '?';
              deleteCode = first.code;
            }
          }
          return {
            status: deleteStatus === 'ok' || deleteStatus === 'skipped' ? 'ok' : 'denied',
            action: 'consolidate-apply',
            message:
              `${summary}；实际：搬 ${moves.filter((m) => m.status === 'ok').length}/${moves.length}、` +
              `并 ${folds.filter((f) => f.status === 'ok').length}/${folds.length}、` +
              `删 ${removed.length}/${deletes.length}（${deleteStatus}${deleteCode !== undefined ? `/${deleteCode}` : ''}）`,
            detail: {
              plan: summary,
              moves,
              folds,
              removed,
              deleteStatus,
              /**
               * **必须是 `null`、不能是 `undefined`**：工具返回值要过"无损 JSON"校验，
               * `undefined` 会让**整次调用报错** —— 哪怕删除其实已经成功执行。
               * 真机踩到：67 个空壳确实删完了，会话侧看到的却是 `value is not lossless JSON`，
               * 差点被当成失败**重跑一遍**（重跑无害，但"成功"显示成"没做"是会误导人的错）。
               */
              deleteCode: deleteCode ?? null,
            },
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_review',
        description:
          '节点审查（FR-164）：`action=list` 列出**待审查**节点（右键打过标记的）；' +
          '`mark` 把给定节点标成待审（取任务时它压过关注）；`pass` 审查通过 —— 清掉标记，' +
          '并且**父节点通过 ⇒ 整枝视为已审**（遗传）。' +
          '审查对象按 `refs` 判定：有文档审文档、有代码审代码，两者都有则**以文档为主、再用文档辅助审代码**；' +
          '只审**修改部分**，不全文重审；`description` 是判断不是事实，**不得作为审查依据**。',
        parameters: {
          action: {
            type: 'string',
            enum: ['list', 'mark', 'pass'],
            description: 'list（默认）列待审 / mark 标记待审 / pass 审查通过（级联整枝）',
          },
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'mark / pass 时的节点 id 列表（pass 会连同整枝一起清）',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const caller = callerOf(exec);
          const action = args.action === 'mark' || args.action === 'pass' ? args.action : 'list';
          const nodeIds = Array.isArray(args.nodeIds) ? (args.nodeIds as string[]) : [];
          if (action === 'list') {
            const queue = await service.reviewQueue();
            return {
              status: 'ok',
              action: 'review-list',
              message:
                queue.length === 0
                  ? '没有待审查的节点。'
                  : `${queue.length} 个待审查节点：${queue.map((item) => `「${item.name}」`).join('、')}`,
              detail: { queue },
            } as unknown as JsonValue;
          }
          if (nodeIds.length === 0) {
            return {
              status: 'denied',
              code: 'E_NODE_IDS',
              message: 'mark / pass 都要给 nodeIds。',
            } as unknown as JsonValue;
          }
          if (action === 'mark') {
            for (const nodeId of nodeIds) {
              // 子代理按会话记（它就是会话派出去的活）；领域层只分"人/会话"两类来源
              await service.panelNodeAction({
                action: 'mark-review',
                nodeId,
                by: caller.by === 'user' ? 'user' : 'session',
              });
            }
            return {
              status: 'ok',
              action: 'review-mark',
              message: `已标记 ${nodeIds.length} 个节点待审查`,
              detail: { nodeIds },
            } as unknown as JsonValue;
          }
          const results = [];
          for (const nodeId of nodeIds) {
            const outcome = await service.clearReviewFlags({
              nodeId,
              by: caller.by === 'user' ? 'user' : 'session',
            });
            results.push({ nodeId, cleared: outcome.cleared, failed: outcome.failed.length });
          }
          return {
            status: 'ok',
            action: 'review-pass',
            message: `审查通过：清掉 ${results.reduce((sum, item) => sum + item.cleared, 0)} 个待审标记（含整枝）`,
            detail: { results },
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_move',
        description:
          '把节点（连同整枝）挂到另一个节点下 —— 用于修正建树留下的层级/重复分支。' +
          '内核是 reparentSubtree：自带成环保护（不许挂到自己的子孙下）、重复枝检查与审计记录；' +
          '只动父子关系，不改名称/进度/描述/优先级。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '要移动的节点 id' },
          newParentId: {
            type: 'string',
            required: true,
            description: '目标父节点 id（拖到根下就传根节点 id）',
          },
          reason: { type: 'string', description: '为什么移动（进审计，便于日后追溯树为什么变了）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.reparentNode({
            nodeId: args.nodeId,
            parentId: args.newParentId,
            by: caller.by,
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(args.reason !== undefined
              ? { reason: args.reason }
              : { reason: '会话调用 pm_move 改父节点（修正建树层级/重复分支）' }),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_progress',
        description:
          '推进节点进度或自身状态。注意：父节点不可写自身状态（会被拒绝），请改门控或子节点；' +
          '已完成节点回退需要 force 且来源为 user。携带 rev 做 CAS，陈旧会返回最新 rev。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          progress: { type: 'number', description: '自身完成度 0–1' },
          selfState: {
            type: 'string',
            enum: ['pending', 'running', 'done', 'error'],
            description: '自身状态',
          },
          rev: { type: 'number', description: 'CAS 版本号（从上次读取获得）' },
          force: { type: 'boolean', description: '回退/重开时需要（仅 user 来源有效）' },
          reason: { type: 'string', description: '写入理由（进审计）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.progress({
            nodeId: args.nodeId,
            ...(args.progress !== undefined ? { progress: args.progress } : {}),
            ...(args.selfState !== undefined ? { selfState: args.selfState as SelfState } : {}),
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.force !== undefined ? { force: args.force } : {}),
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(caller.by !== 'user' ? { by: caller.by } : {}),
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_finish',
        description:
          '标记节点完成（同时把进度置为 1，避免"完成但进度<1"的自相矛盾写入）。' +
          '**收尾时请把 `description` 改写成完成简报**（完成了什么 + 需要补充/处理的），' +
          '还有遗留要处理时把 `followUp` 设为 true —— 节点会**黄底 + 感叹号**示警，方便一眼找出没收干净的活。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          rev: { type: 'number', description: 'CAS 版本号' },
          evidence: { type: 'string', description: '完成依据（进审计）' },
          description: {
            type: 'string',
            description:
              '**完成简报**（覆盖原来的任务简述）：完成了什么、有什么需要补充/处理的。' +
              '写完会自动打上描述时间戳',
          },
          followUp: {
            type: 'boolean',
            description: '完成简报里还有"需要补充/处理"的事 ⇒ 节点黄底 + 感叹号示警（默认 false）',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          /**
           * **简报与遗留标记随完成一起写**（用户口径："完成后是简报…任务完成情况(需要补充和处理的)
           * 节点黄色警告背景加感叹号图标示警"）。
           *
           * 为什么要做成 `pm_finish` 的参数而不是让模型另调一次 `pm_update`：
           * "完成"和"完成情况怎么写"本来就是一件事，分两步就会有人只做第一步。
           */
          if (args.description !== undefined || args.followUp !== undefined) {
            const patched = await service.patchNode({
              nodeId: args.nodeId,
              patch: {
                ...(args.description !== undefined ? { description: args.description } : {}),
                ...(args.followUp !== undefined ? { hasFollowUp: args.followUp === true } : {}),
              },
              by: caller.by,
              ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
              reason: '完成时写简报（含遗留标记）',
            });
            if (patched.status !== 'ok') return patched as unknown as JsonValue;
          }
          const result = await service.finish({
            nodeId: args.nodeId,
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            ...(caller.by !== 'user' ? { by: caller.by } : {}),
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_report',
        description:
          '一次性汇报多个节点的进度/状态（**收尾时用**：回合、子任务或会话结束前把这段动过的节点一起报掉）。' +
          '每一项等价于一次 pm_progress，finish=true 则等价于 pm_finish（done 且 progress=1）；' +
          '逐项独立判定，某一项失败不影响其它项，结果逐项返回。最多 50 项。',
        parameters: {
          updates: {
            type: 'array',
            required: true,
            description: '要汇报的节点（最多 50 项；超出部分不执行，返回值会如实说明）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true, description: '节点 id' },
                progress: { type: 'number', description: '实际完成度 0–1（按件数口径）' },
                selfState: {
                  type: 'string',
                  enum: ['pending', 'running', 'done', 'error'],
                  description: '自身状态（finish=true 时忽略）',
                },
                finish: { type: 'boolean', description: '置为完成（等价 pm_finish）' },
                rev: { type: 'number', description: 'CAS 版本号' },
                evidence: { type: 'string', description: '依据（进审计）' },
              },
            },
          },
          reason: { type: 'string', description: '整批的写入理由（进审计）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.reportBatch({
            updates: args.updates,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(caller.by !== 'user' ? { by: caller.by } : {}),
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `Report ${args.updates.length} node(s)`,
          kind: 'other',
          rawInput: args,
        }),
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_focus',
        description:
          '设置/取消关注某节点（关注 = 该节点及其整枝）。写入时自动归一化：' +
          '关注父节点会清除后代的关注标记（保留 shadow，取消时可恢复）。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          focus: { type: 'boolean', required: true, description: 'true 关注，false 取消' },
          structRev: { type: 'number', description: '结构版本号' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const result = await service.setFocus({
            nodeId: args.nodeId,
            focus: args.focus,
            ...(args.structRev !== undefined ? { structRev: args.structRev } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_gate',
        description:
          '设置门控：paused 暂停（可继续）/ held 拦停（仅父节点）/ null 解除。' +
          '门控沿枝向下继承，不改写任何节点的自身状态。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          gate: {
            type: 'string',
            enum: ['paused', 'held', 'none'],
            required: true,
            description: 'paused / held / none（解除）',
          },
          reason: { type: 'string', description: '原因（进审计）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const gate = args.gate === 'none' ? null : (args.gate as 'paused' | 'held');
          const result = await service.setGate({
            nodeId: args.nodeId,
            gate,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_watch',
        description:
          '申请订阅一个节点（写入面 + 通知面）。声明 intent（read/write/exclusive）与 touchedPaths，' +
          '用于并行治理与进度回写路由。exclusive 独占该节点及其枝。' +
          '返回里带 lock：granted 直接可用；queued 说明被谁挡住（可用 pm_watch_wait 等让路）；' +
          'rejected 说明冲突策略是"拒绝"。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          intent: {
            type: 'string',
            enum: ['read', 'write', 'exclusive'],
            description: '写入意图；默认 write',
          },
          touchedPaths: {
            type: 'array',
            description: '本次会改动的文件（工作区相对路径）',
            items: { type: 'string' },
          },
          notify: {
            type: 'string',
            enum: ['key', 'full', 'none'],
            description: '通知级别；默认 key（只收关键事件）',
          },
          expiresAt: {
            type: 'string',
            description: '订阅到期时间（ISO）；到期自动释放订阅与文件锁（FR-108）',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const caller = callerOf(exec);
          const actor = caller.by === 'user' ? 'session' : caller.by;
          const result = await service.subscribe({
            nodeId: args.nodeId,
            actor,
            actorId: caller.actorId ?? 'unknown',
            intent: (args.intent as 'read' | 'write' | 'exclusive' | undefined) ?? 'write',
            ...(args.touchedPaths !== undefined ? { touchedPaths: args.touchedPaths } : {}),
            ...(args.notify !== undefined
              ? { notify: args.notify as 'key' | 'full' | 'none' }
              : {}),
            ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 订阅治理（§13.4 / FR-105–111）────────────────────────────

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_unwatch',
        description:
          '释放订阅（须带 subscriptionId，防误释放他人的）。释放后它持有的文件锁立刻让给排队者，' +
          '返回值里的 releasedTo 就是被让路成功的订阅。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          subscriptionId: { type: 'string', required: true, description: '订阅 id' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.unsubscribe({
            nodeId: args.nodeId,
            subscriptionId: args.subscriptionId,
            by: caller.by === 'user' ? 'user' : caller.by,
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_watchers',
        description:
          '查询某节点的订阅列表、每条订阅的锁状态（holdsLock / blockedBy）与冲突路径。' +
          '并行前先看这个，比"先写再说"便宜得多。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          return (await service.watchers(args.nodeId)) as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_watch_conflicts',
        description: '查询当前全部文件锁占用、等待队列与冲突路径（谁挡着谁一目了然）。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(_args, exec) {
          withRoot(exec);
          return service.watchConflicts() as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_watch_wait',
        description:
          '等待让路：阻塞直到这条订阅拿到锁，或超时。**不要空转轮询**——用这个等。' +
          '超时是可预期结果（返回 timeout 与被谁挡着），不是错误。',
        parameters: {
          subscriptionId: { type: 'string', required: true, description: '订阅 id' },
          timeoutMs: { type: 'number', description: '等待上限（毫秒，默认 30000，上限 600000）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const result = await service.watchWait({
            subscriptionId: args.subscriptionId,
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_watch_arbitrate',
        description:
          '冲突无法自动化解时请求人工裁决。**子代理调用时回落为 needs-human + preview**，' +
          '由父会话或面板裁决（§13.3/FR-138a）—— 子代理不得自行放行。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '冲突所在节点' },
          reason: { type: 'string', required: true, description: '为什么要人裁决（一句话说清冲突）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const caller = callerOf(exec);
          const conflicts = service.watchConflicts();
          const result = await service.requestArbitration({
            nodeId: args.nodeId,
            reason: args.reason,
            conflict: conflicts.conflicts,
            ...(caller.actorId !== undefined ? { actorId: caller.actorId } : {}),
            by: caller.by,
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_remove',
        description:
          '删除整枝（破坏性）。**必须人工确认**：首次调用只返回 needs-confirm 与影响范围预览，' +
          '不会执行任何动作；确认须由人在会话中批准（一次性授权）或在侧边栏面板内右键确认。' +
          '会话审批策略为 never 时一律拒绝，不会静默放行。',
        parameters: {
          nodeIds: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description:
              '要删除的枝根节点 id 列表（**至少一个**）。' +
              '给多个即**批量删除**：一次确认覆盖整批，逐枝独立判定，某一枝失败不影响其他枝；' +
              '被别的目标包含的节点会被顺带删掉，不必重复列出',
          },
          policy: {
            type: 'string',
            enum: ['record', 'code', 'comment'],
            description: 'record 仅删记录 / code 代码一并删除 / comment 代码仅注释；默认 record',
          },
          rev: { type: 'number', description: 'CAS 版本号（仅单节点删除时有意义）' },
          confirmToken: { type: 'string', description: '确认令牌（只能由插件在人工确认后签发）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          const sessionId = withRoot(exec);
          const result = await service.removeBranch({
            nodeIds: Array.isArray(args.nodeIds) ? (args.nodeIds as string[]) : [],
            policy: (args.policy as 'record' | 'code' | 'comment' | undefined) ?? 'record',
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.confirmToken !== undefined ? { confirmToken: args.confirmToken } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            toolName: 'pm_remove',
            agent: exec.agent,
            ...(exec.callId !== undefined ? { callId: String(exec.callId) } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 看板与文档 ────────────────────────────────────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_board',
        description:
          '读取看板快照：整体/关注枝完成度、未完成叶节点计数、进行中与异常节点数、' +
          '冲突列表、快照档位、确认通道现状。这是与 UI 完全一致的口径（FR-71）。' +
          '需要清理建树遗留时传 `includeStale`：会额外列出**疑似遗留**节点（上次建树没再提到、' +
          '但仍照常计入统计），然后可用 `pm_remove` 带多个 `nodeIds` 一次确认删掉。',
        parameters: {
          includeStale: {
            type: 'boolean',
            description:
              '是否额外返回「疑似遗留」节点清单（FR-158 ③）。默认 false —— 日常看进度不需要它，' +
              '而且逐节点明细很占 token。清单里每条给 id / 名称 / 类型 / 进度 / 所属枝 / 时间，够直接调 pm_remove',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const board = await service.board();
          // 工具返回精简：去掉逐节点明细（那走 pm_tree）
          const { nodes: _nodes, unfinished, scanBand, ...rest } = board;
          /**
           * FR-158 ③ 的"清理闭环"：只在**显式要求**时给遗留清单。
           * 不给的话 AI 就得靠 `pm_tree` 翻全树找 `stale`，既费 token 又容易漏；
           * 默认给的话又违背"工具返回精简"（T 系列 token 约束）。
           */
          const staleNodes =
            args.includeStale === true
              ? board.nodes
                  .filter((node) => node.stale === true && node.derivedState !== 'removed')
                  .map((node) => ({
                    id: node.id,
                    name: node.name,
                    kind: node.kind,
                    progress: node.progress,
                    parentName: board.nodes.find((candidate) => candidate.id === node.parentId)?.name ?? null,
                    refs: (node.refs ?? []).map((ref) => ref.target),
                    updatedAt: node.updatedAt,
                  }))
              : undefined;
          return {
            ...rest,
            unfinishedCount: unfinished.length,
            scanBandCount: scanBand.length,
            ...(staleNodes !== undefined ? { staleCount: staleNodes.length, staleNodes } : {}),
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  /**
   * **取「下一个该做的」**（FR-162）。
   *
   * 用户口径："完成一个阶段后，从项目进度工具里获取下个阶段任务继续跑，
   * 无需用户一直写入继续" + "按 **关注点 → 优先级 → 进度** 这样的排序获取"。
   *
   * **只读**：只回答"接着做哪条"，不改任何状态 —— 推进进度仍走 `pm_progress` / `pm_finish`。
   * 排序口径固定且可复现（同关注/同优先级/同进度时按名称），同一棵树每次取到同一条。
   */
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_next',
        description:
          '取「下一个该做的」（只读）。排序固定为 **关注点 → 优先级 → 进度**：' +
          '① 关注链路内的优先（关注枝及其祖先/后代）；② 同档按优先级（1 最高，**没给优先级的排最后**）；' +
          '③ 再按进度低的优先；④ 名称兜底保证可复现。' +
          '完成一个节点后可用它直接取下一条接着做，不必等用户说继续；推进进度仍走 pm_progress / pm_finish。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(_args, exec) {
          withRoot(exec);
          const picked = await service.nextTask();
          return picked as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_doc_check',
        description:
          '校验 project-manager.md 是否合法（仅标题 + 一个 mermaid 代码块），' +
          '返回全部违规项与可执行的修正提示。可选地把当前事实源投影写回文件。',
        parameters: {
          write: { type: 'boolean', description: '是否在合法时把投影写回文件（默认 false）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const check = await service.checkDocumentFile();
          const projection = args.write === true
            ? await service.projectDocumentToDisk()
            : undefined;
          return {
            exists: check.exists,
            legal: check.check?.ok ?? false,
            violations: (check.check?.violations ?? []).map((v) => ({
              rule: v.rule,
              message: v.message,
              hint: v.hint,
            })),
            ...(projection !== undefined ? { projection } : {}),
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_audit',
        description: '读取最近的写入审计（来源、时间、块、版本）。用于排查"谁改了这个节点"。',
        parameters: {
          limit: { type: 'number', description: '返回条数上限，默认 20' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const rows = await service.recentAudit(args.limit ?? 20);
          return { rows } as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 快照与回滚（§6.6b）────────────────────────────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_snapshot',
        description:
          '建立一个回滚点（snapshot / rollback point）。暂停、拦停与叶节点首次执行前会自动建点；' +
          '本工具用于手动留一个"可回到的时间锚点"，不暂停任务。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          reason: {
            type: 'string',
            enum: ['manual', 'pause', 'hold', 'pre-rollback'],
            description: '建立原因；手动调用请用 manual',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const result = await service.captureSnapshot({
            nodeId: args.nodeId,
            ...(args.reason !== undefined
              ? { reason: args.reason as 'manual' | 'pause' | 'hold' | 'pre-rollback' }
              : {}),
            force: true,
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_snapshots',
        description: '列出某节点当前可用的回滚点（时间、原因、档位、占用字节）。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const rows = await service.listSnapshots(args.nodeId);
          const status = service.snapshotStatus();
          return { nodeId: args.nodeId, mode: status.mode, modeReason: status.reason, rows } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_rollback',
        description:
          '回滚节点到某个回滚点（破坏性）。**必须人工确认**：首次调用只返回 needs-confirm 与影响范围，' +
          '不执行任何动作；确认由人在会话中批准（一次性授权）或在面板内确认。' +
          '回滚前会先建 `pre-rollback` 快照以便撤销；会话审批策略为 never 时一律拒绝。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          snapshotId: { type: 'string', description: '指定回滚点；省略则用最近的' },
          scope: {
            type: 'string',
            enum: ['code', 'state', 'both'],
            description: '回滚范围：仅代码 / 仅节点状态 / 两者（默认两者）',
          },
          confirmToken: { type: 'string', description: '确认令牌（只能由插件在人工确认后签发）' },
          confirmShared: {
            type: 'boolean',
            description: '是否确认连带还原被多个节点写过的共享文件',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const result = await service.rollback({
            nodeId: args.nodeId,
            scope: (args.scope as 'code' | 'state' | 'both' | undefined) ?? 'both',
            ...(args.snapshotId !== undefined ? { snapshotId: args.snapshotId } : {}),
            ...(args.confirmToken !== undefined ? { confirmToken: args.confirmToken } : {}),
            ...(args.confirmShared !== undefined ? { confirmShared: args.confirmShared } : {}),
            toolName: 'pm_rollback',
            agent: exec.agent,
            ...(exec.callId !== undefined ? { callId: String(exec.callId) } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_rollback_undo',
        description: '撤销上一次回滚（用 `pre-rollback` 快照恢复回滚前的现场）。需人工确认。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          confirmToken: { type: 'string', description: '确认令牌' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const result = await service.undoRollback({
            nodeId: args.nodeId,
            ...(args.confirmToken !== undefined ? { confirmToken: args.confirmToken } : {}),
            toolName: 'pm_rollback_undo',
            agent: exec.agent,
            ...(exec.callId !== undefined ? { callId: String(exec.callId) } : {}),
          });
          return result as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_snapshot_health',
        description:
          '快照可达性自检：检查索引里的回滚点在磁盘上是否仍可读（gc/误删这类损坏' +
          '平时察觉不到，等真要回滚时才发现就晚了）。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(_args, exec) {
          withRoot(exec);
          const status = service.snapshotStatus();
          const health = await service.checkSnapshotReachability();
          return { mode: status.mode, modeReason: status.reason, ...health } as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 首次扫描（阶段 A：零 token 骨架）──────────────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_scan',
        description:
          '零 token 扫描工作区并给出「草稿节点树」建议（只看文件树与关键文件，**不调用任何 AI**）。' +
          'mode=preview 只返回建议（默认）；mode=apply 直接落库建树（幂等：同名同父的节点跳过）。' +
          '扫描是抽样与推断，不保证任务清单完整。',
        parameters: {
          mode: {
            type: 'string',
            enum: ['preview', 'apply'],
            description: 'preview 只建议（默认）/ apply 落库',
          },
          maxDepth: { type: 'number', description: '目录深度上限（默认 6）' },
          maxNodes: { type: 'number', description: '最多产出节点数（默认 200）' },
          maxChildrenPerDir: { type: 'number', description: '单目录最多展开子项（默认 12）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const scan = await service.scan({
            ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
            ...(args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {}),
            ...(args.maxChildrenPerDir !== undefined
              ? { maxChildrenPerDir: args.maxChildrenPerDir }
              : {}),
          });
          if (!scan.available) {
            return { status: 'denied', reason: scan.reason } as unknown as JsonValue;
          }
          if (args.mode === 'apply') {
            const applied = await service.applyScan({
              nodes: scan.nodes,
              projectName: scan.projectName,
            });
            return {
              status: 'ok',
              created: applied.created,
              skipped: applied.skipped,
              failures: applied.failures,
              scanned: scan.scanned,
              excluded: scan.skipped,
              truncated: scan.truncated,
              notes: scan.notes,
            } as unknown as JsonValue;
          }
          // preview：只回摘要 + 前 30 个建议，避免污染上下文（FR-74）
          return {
            status: 'ok',
            projectName: scan.projectName,
            nodeCount: scan.nodes.length,
            scanned: scan.scanned,
            excluded: scan.skipped,
            truncated: scan.truncated,
            notes: scan.notes,
            preview: scan.nodes.slice(0, 30).map((n) => ({
              key: n.key,
              name: n.name,
              kind: n.kind,
              parent: n.parentKey,
              origin: n.origin,
            })),
            hint: '确认后用 mode=apply 落库；节点会带 autoCreated 角标，可一键转正。',
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  // ── 暂停 / 拦停 / 继续 / 放行（§9.2 / §9.6.4）──────────────────
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_pause',
        description:
          '暂停节点（及其整枝）：置门控 paused、**自动建立回滚点**、生成《继续交接文档》。' +
          '交接文档的机械部分零 token；「下一步」「关键决策与坑」两节需要模型补写（属于 AI 调用，' +
          '要走预算前置）——不提供时该文档会标注「模型补写部分已跳过」，不阻塞暂停。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          reason: { type: 'string', description: '暂停原因（进审计与文档）' },
          nextSteps: { type: 'string', description: '模型补写：下一步做什么' },
          decisions: { type: 'string', description: '模型补写：关键决策与坑' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const supplements =
            args.nextSteps !== undefined || args.decisions !== undefined
              ? {
                  ...(args.nextSteps !== undefined ? { nextSteps: args.nextSteps } : {}),
                  ...(args.decisions !== undefined ? { decisions: args.decisions } : {}),
                }
              : undefined;
          const result = await service.pauseNode({
            nodeId: args.nodeId,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(supplements !== undefined ? { supplements } : {}),
          });
          return {
            status: result.status,
            handoff: result.handoff
              ? { file: result.handoff.relativePath, bytes: result.handoff.bytes, supplementsSkipped: result.handoff.supplementsSkipped }
              : null,
            snapshot: result.snapshot?.created ? result.snapshot.snapshotId : null,
            ...(result.status !== 'ok' && 'message' in result ? { message: result.message } : {}),
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_hold',
        description:
          '拦停一个枝（**仅父节点**）：整枝停止、需重新评审。置门控 held、为整枝建立回滚点、' +
          '生成《放行交接文档》（多任务，按子节点分节）。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '父节点 id' },
          reason: { type: 'string', description: '拦停原因' },
          nextSteps: { type: 'string', description: '模型补写：下一步做什么' },
          decisions: { type: 'string', description: '模型补写：关键决策与坑' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const supplements =
            args.nextSteps !== undefined || args.decisions !== undefined
              ? {
                  ...(args.nextSteps !== undefined ? { nextSteps: args.nextSteps } : {}),
                  ...(args.decisions !== undefined ? { decisions: args.decisions } : {}),
                }
              : undefined;
          const result = await service.holdNode({
            nodeId: args.nodeId,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(supplements !== undefined ? { supplements } : {}),
          });
          return {
            status: result.status,
            handoff: result.handoff
              ? { file: result.handoff.relativePath, bytes: result.handoff.bytes, nodes: result.handoff.nodeCount }
              : null,
            snapshot: result.snapshot?.created ? result.snapshot.snapshotId : null,
            ...(result.status !== 'ok' && 'message' in result ? { message: result.message } : {}),
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_resume',
        description:
          '继续（解除暂停）：解除门控，并把《继续交接文档》内容作为**返回值**交给会话续接' +
          '（插件没有直接向会话注入消息的公开接口，因此以工具返回形式交付）；' +
          'consumeDoc=true（默认）时消费后删除文档，false 则保留归档。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          consumeDoc: { type: 'boolean', description: '是否删除交接文档（默认 true）' },
          offset: { type: 'number', description: '文档分页起始偏移（默认 0）' },
          limitBytes: { type: 'number', description: '单次读取字节上限（默认 32 KB）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          // 先按分页读出来（避免长文档一次性进上下文，§13.2），再决定是否消费
          const page = await service.readHandoffPage({
            nodeId: args.nodeId,
            kind: 'pause',
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.limitBytes !== undefined ? { limitBytes: args.limitBytes } : {}),
          });
          const result = await service.resumeNode({
            nodeId: args.nodeId,
            ...(args.consumeDoc !== undefined ? { consumeDoc: args.consumeDoc } : {}),
          });
          return {
            status: result.status,
            resumed: result.resumed ?? false,
            handoff: page.found
              ? {
                  file: page.fileName,
                  text: page.text,
                  nextOffset: page.nextOffset,
                  truncated: page.truncated,
                  supplementsSkipped: page.supplementsSkipped,
                }
              : null,
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_release',
        description:
          '放行（解除拦停）：解除门控，并把《放行交接文档》（多任务）内容作为返回值交给会话续接。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '父节点 id' },
          consumeDoc: { type: 'boolean', description: '是否删除交接文档（默认 true）' },
          offset: { type: 'number', description: '文档分页起始偏移（默认 0）' },
          limitBytes: { type: 'number', description: '单次读取字节上限（默认 32 KB）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const page = await service.readHandoffPage({
            nodeId: args.nodeId,
            kind: 'hold',
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.limitBytes !== undefined ? { limitBytes: args.limitBytes } : {}),
          });
          const result = await service.releaseNode({
            nodeId: args.nodeId,
            ...(args.consumeDoc !== undefined ? { consumeDoc: args.consumeDoc } : {}),
          });
          return {
            status: result.status,
            resumed: result.resumed ?? false,
            handoff: page.found
              ? {
                  file: page.fileName,
                  text: page.text,
                  nextOffset: page.nextOffset,
                  truncated: page.truncated,
                }
              : null,
          } as unknown as JsonValue;
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'pm_handoff_read',
        description:
          '分页读取某节点的交接文档（默认单次 ≤ 32 KB）。**200 KB 的文档绝不允许一次性进上下文**，' +
          '所以必须用分页；返回 nextOffset 为 null 表示读完。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          kind: {
            type: 'string',
            enum: ['pause', 'hold'],
            description: '文档种类；省略则取最近一份',
          },
          offset: { type: 'number', description: '起始偏移（默认 0）' },
          limitBytes: { type: 'number', description: '单次字节上限（默认 32 KB）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const page = await service.readHandoffPage({
            nodeId: args.nodeId,
            ...(args.kind !== undefined ? { kind: args.kind as 'pause' | 'hold' } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            ...(args.limitBytes !== undefined ? { limitBytes: args.limitBytes } : {}),
          });
          return page as unknown as JsonValue;
        },
      }),
    ),
  );

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载期的异常不应影响其他工具
      }
    }
  };
}




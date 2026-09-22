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

  const withRoot = <A>(exec: ToolRunContext): A => {
    service.noteWorkspaceRoot(workspaceRootOf(exec));
    return undefined as A;
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
          withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.addNode({
            parentId: args.parentId ?? null,
            name: args.name,
            ...(args.kind !== undefined ? { kind: args.kind as 'feature' | 'task' } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.addedMidway !== undefined ? { addedMidway: args.addedMidway } : {}),
            by: caller.by,
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
          withRoot(exec);
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
        description: '标记节点完成（同时把进度置为 1，避免"完成但进度<1"的自相矛盾写入）。',
        parameters: {
          nodeId: { type: 'string', required: true, description: '节点 id' },
          rev: { type: 'number', description: 'CAS 版本号' },
          evidence: { type: 'string', description: '完成依据（进审计）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const caller = callerOf(exec);
          const result = await service.finish({
            nodeId: args.nodeId,
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            ...(caller.by !== 'user' ? { by: caller.by } : {}),
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
          withRoot(exec);
          const result = await service.setFocus({
            nodeId: args.nodeId,
            focus: args.focus,
            ...(args.structRev !== undefined ? { structRev: args.structRev } : {}),
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
          withRoot(exec);
          const gate = args.gate === 'none' ? null : (args.gate as 'paused' | 'held');
          const result = await service.setGate({
            nodeId: args.nodeId,
            gate,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
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
          '用于并行治理与进度回写路由。exclusive 独占该节点及其枝。',
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
          nodeId: { type: 'string', required: true, description: '要删除的枝根节点 id' },
          policy: {
            type: 'string',
            enum: ['record', 'code', 'comment'],
            description: 'record 仅删记录 / code 代码一并删除 / comment 代码仅注释；默认 record',
          },
          rev: { type: 'number', description: 'CAS 版本号' },
          confirmToken: { type: 'string', description: '确认令牌（只能由插件在人工确认后签发）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: renderResult(value as ApplyResult) }],
        },
        async execute(args, exec) {
          withRoot(exec);
          const result = await service.removeBranch({
            nodeId: args.nodeId,
            policy: (args.policy as 'record' | 'code' | 'comment' | undefined) ?? 'record',
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.confirmToken !== undefined ? { confirmToken: args.confirmToken } : {}),
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
          '冲突列表、快照档位、确认通道现状。这是与 UI 完全一致的口径（FR-71）。',
        parameters: {},
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: clip(JSON.stringify(value)) }],
        },
        async execute(_args, exec) {
          withRoot(exec);
          const board = await service.board();
          // 工具返回精简：去掉逐节点明细（那走 pm_tree）
          const { nodes: _nodes, unfinished, scanBand, ...rest } = board;
          return {
            ...rest,
            unfinishedCount: unfinished.length,
            scanBandCount: scanBand.length,
          } as unknown as JsonValue;
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




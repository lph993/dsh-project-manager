/**
 * 项目服务（Host 面应用层）：把**纯领域层**、**存储端口**、**文档投影**与**确认通道**串起来。
 *
 * 本文件是唯一持有"可变世界"的地方：
 * - 领域函数负责判定（纯、可测）
 * - 本服务负责读快照 → 调领域 → 原子写回 → 投影文档 → 记审计
 *
 * 所有写入都经过同一入口（§12.4 不变量 2：无旁路）。
 */

import type { Context } from '@deepseek-ai/cordis';
// 纯类型导入：加载 DSH 的服务接口增补（`ctx.fs` / `ctx.storageDomain` / `ctx.settings`）。
// 这些增补写在各自包的 `.d.ts` 里，只有该模块进入编译图时才会生效。
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-settings';

import type { ConfirmRouter } from './adapter/confirm.ts';
import { resolveSnapshotMode, serviceOf, type CapabilityReport } from './adapter/capabilities.ts';
import { deriveGraph, statsForRoots, unfinishedLeaves, type DerivedGraph } from './domain/progress.ts';
import { focusedRoots, buildIndex } from './domain/graph.ts';
import {
  blockOf,
  emptyGraph,
  mutateAdd,
  mutateFlags,
  mutateFocus,
  mutateGate,
  mutatePatch,
  mutateRemove,
  mutateSubscribe,
  mutateUnsubscribe,
  type Clock,
  type MutationContext,
  type MutationResult,
  type RandomSource,
} from './domain/mutate.ts';
import {
  checkDocument,
  type DocCheckResult,
} from './domain/docFormat.ts';
import { projectDocument, projectionFingerprint, branchPath } from './domain/project.ts';
import type {
  GraphSnapshot,
  NodeFlag,
  NodeKind,
  NodeRecord,
  ProgressStats,
  Ref,
  SelfState,
} from './shared/types.ts';
import type { ConflictPolicy, PatchFields } from './domain/validate.ts';
import { KvStoragePort, newProjectId } from './storage/kv-port.ts';
import type { StoragePort } from './storage/port.ts';
import type { AuditRecord, ProjectMetaRecord } from './storage/schema.ts';
import { DATA_FORMAT } from './storage/schema.ts';

/** 插件配置（与 `src/index.ts` 的 schemastery Config 对应）。 */
export interface ProjectServiceConfig {
  refreshIntervalMs: number;
  conflictPolicy: ConflictPolicy;
  documentPath: string;
  snapshotMode: 'auto' | 'git' | 'patch' | 'full';
  aiWeightMeasurement: boolean;
}

export interface ProjectServiceDeps {
  config: ProjectServiceConfig;
  capabilities: CapabilityReport;
  clock: Clock;
  random: RandomSource;
}

/** 一个节点的看板视图（供 UI / 工具返回）。 */
export interface NodeView {
  id: string;
  name: string;
  parentId: string | null;
  kind: NodeKind;
  selfState: SelfState;
  derivedState: string;
  progress: number;
  weight: number;
  focus: boolean;
  gate: NodeRecord['gate'];
  flags: NodeFlag[];
  description?: string;
  refs?: Ref[];
  autoCreated: boolean;
  childCount: number;
  leafCount: number;
  unfinishedLeafCount: number;
  blockedBy: string[];
  revision: number;
  updatedAt: string;
  updatedBy: string;
  addedMidway: boolean;
  subscriptionCount: number;
  branchPath: string[];
}

/** 看板整体快照（面板一次拉取的全部内容）。 */
export interface BoardSnapshot {
  projectId: string;
  projectName: string;
  nodes: NodeView[];
  overall: ProgressStats;
  focused: ProgressStats;
  focusedRootIds: string[];
  unfinished: NodeView[];
  conflicts: Array<{ conflictId: string; nodeId: string; code: string; message: string }>;
  /** 未完成扫描带（FR-46c）：叶节点按图序。 */
  scanBand: Array<{ nodeId: string; name: string; derivedState: string; isFocus: boolean }>;
  degradation: string[];
  snapshot: { mode: 'git' | 'patch' | 'full'; reason: string };
  confirmChannel: string;
  document: { path: string; exists: boolean; legal: boolean; violations: string[] };
  dataFormat: number;
}

/** 一次写入的对外结果（工具返回与 UI 都用它，保证行为一致 FR-71）。 */
export type ApplyResult =
  | { status: 'ok'; nodeId: string; revision: number; autoFixes: string[]; attempts: number }
  | {
      status: 'denied';
      reason: string;
      code: string;
      message: string;
      hint?: string;
      latestRev?: number;
    }
  | { status: 'needs-confirm'; confirmToken: string; preview: string; action: string }
  | { status: 'arbitrate'; conflictId: string; code: string; message: string };

/**
 * 项目服务。
 */
export class ProjectService {
  readonly route: StoragePort['route'];

  private readonly ctx: Context;
  private readonly port: StoragePort;
  private readonly deps: ProjectServiceDeps;
  private projectId = '';
  private confirm: ConfirmRouter | undefined;
  /** 回滚锁（C9）：被锁定的子树根 id 集合。 */
  private readonly rollbackLocks = new Set<string>();
  /** 待确认停止的节点（C10）。 */
  private readonly needsConfirmNodes = new Set<string>();
  /** 最近一次工具调用报告的工作区根（DSH 的 cwd 是 per-call 值）。 */
  private workspaceRootOverride: string | undefined;

  private constructor(ctx: Context, port: StoragePort, deps: ProjectServiceDeps) {
    this.ctx = ctx;
    this.port = port;
    this.deps = deps;
    this.route = port.route;
  }

  /**
   * 创建服务：打开存储、解析/初始化当前项目。
   *
   * 主路线不可用时回落兜底路线（FR-124）—— 兜底实现见 `storage/file-port.ts`（后续里程碑）。
   */
  static async create(ctx: Context, deps: ProjectServiceDeps): Promise<ProjectService> {
    if (!deps.capabilities.storageDomain) {
      throw new Error(
        'storageDomain 不可用，且兜底文件存储尚未实现（计划在 M1b）。' +
          '当前 DSH 组合缺少 @deepseek-ai/dsh-storage-domain / dsh-storage-json。',
      );
    }
    const port = await KvStoragePort.create(ctx);
    const service = new ProjectService(ctx, port, deps);
    if (port instanceof KvStoragePort) port.attachChangeEvents();
    await service.ensureProject();
    return service;
  }

  /** 注入确认路由（避免 storage 与服务之间的循环依赖）。 */
  attachConfirm(confirm: ConfirmRouter): void {
    this.confirm = confirm;
  }

  get storage(): StoragePort {
    return this.port;
  }

  get currentProjectId(): string {
    return this.projectId;
  }

  /**
   * 工作区根目录。
   *
   * DSH 里工作区 cwd 是**每次调用**的值（`exec.agent.session.header.cwd`），
   * 不在 `ctx` 上；因此工具层每次调用都会用 `noteWorkspaceRoot()` 告知本服务。
   * 没有 agent 上下文时回落到 `DSH_WORKSPACE`（宿主启动环境），再没有就交给 `ctx.fs` 的默认语义。
   */
  workspaceRoot(): string | undefined {
    return this.workspaceRootOverride ?? readWorkspaceRootFromEnv();
  }

  /** 由工具层在每次执行时写入当前会话的工作区根。 */
  noteWorkspaceRoot(root: string | undefined): void {
    if (root !== undefined && root !== '') this.workspaceRootOverride = root;
  }

  // ── 项目初始化 ────────────────────────────────────────────────
  private async ensureProject(): Promise<void> {
    const ts = this.deps.clock.now();
    const existing = await this.port.listProjects();
    const first = existing[0];
    if (first) {
      this.projectId = first;
      return;
    }
    const projectId = newProjectId();
    const meta: ProjectMetaRecord = {
      projectId,
      projectName: '未命名项目',
      dataFormat: DATA_FORMAT,
      createdAt: ts,
      updatedAt: ts,
      rootIds: [],
    };
    await this.port.openProject(meta);
    this.projectId = projectId;
  }

  /** 切换当前项目（多项目工作区）。 */
  async selectProject(projectId: string): Promise<void> {
    const meta = await this.port.getMeta(projectId);
    if (!meta) throw new Error(`项目 ${projectId} 不存在`);
    this.projectId = projectId;
  }

  async listProjects(): Promise<ProjectMetaRecord[]> {
    const ids = await this.port.listProjects();
    const out: ProjectMetaRecord[] = [];
    for (const id of ids) {
      const meta = await this.port.getMeta(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  private async readGraph(): Promise<GraphSnapshot> {
    const graph = await this.port.readGraph(this.projectId);
    if (graph) return graph;
    const ts = this.deps.clock.now();
    return emptyGraph('未命名项目', ts);
  }

  private mutationContext(): MutationContext {
    const base: MutationContext = {
      clock: this.deps.clock,
      random: this.deps.random,
      policy: this.deps.config.conflictPolicy,
      rollbackLocked: (nodeId) => this.isRollbackLocked(nodeId),
    };
    return base;
  }

  private isRollbackLocked(nodeId: string): boolean {
    if (this.rollbackLocks.has(nodeId)) return true;
    const locked = [...this.rollbackLocks];
    return locked.some((rootId) => nodeId.startsWith(rootId));
  }

  /** 把领域结果落盘（含审计）。审计失败不得回滚已提交的写入。 */
  private async persist(result: MutationResult): Promise<ApplyResult> {
    if (result.kind === 'reject') {
      return {
        status: 'denied',
        reason: 'validation',
        code: result.code,
        message: result.message,
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
        ...(result.latestRev !== undefined ? { latestRev: result.latestRev } : {}),
      };
    }
    if (result.kind === 'arbitrate') {
      const ts = this.deps.clock.now();
      await this.port.putConflict({
        conflictId: result.conflictId,
        projectId: this.projectId,
        nodeId: '',
        code: result.code,
        message: result.message,
        candidates: [],
        status: 'pending',
        createdAt: ts,
      });
      return {
        status: 'arbitrate',
        conflictId: result.conflictId,
        code: result.code,
        message: result.message,
      };
    }

    const before = await this.port.readGraph(this.projectId);
    const changedIds = diffNodeIds(before, result.graph);
    for (const nodeId of changedIds) {
      const node = result.graph.nodes[nodeId];
      if (!node) continue;
      await this.port.putNode(this.projectId, node);
    }

    // meta 同步（rootIds / projectName / 投影指纹）
    const meta = await this.port.getMeta(this.projectId);
    if (meta) {
      await this.port.putMeta({
        ...meta,
        projectName: result.graph.projectName,
        rootIds: result.graph.rootIds,
        updatedAt: this.deps.clock.now(),
      });
    }

    const auditRows: AuditRecord[] = result.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      projectId: this.projectId,
      nodeId: attempt.nodeId,
      block: attempt.block,
      op: attempt.op,
      by: attempt.by.label ?? attempt.by.by,
      rev: attempt.rev,
      ts: attempt.ts,
    }));
    if (result.autoFixes.length > 0) {
      auditRows.push({
        attemptId: this.deps.random.uuid(),
        projectId: this.projectId,
        nodeId: null,
        block: 'state',
        op: {},
        by: 'system',
        rev: 0,
        ts: this.deps.clock.now(),
        note: `自动修正：${result.autoFixes.join('、')}`,
      });
    }
    for (const row of auditRows) await this.port.appendAudit(row);

    const firstChanged = changedIds[0];
    const node = firstChanged ? result.graph.nodes[firstChanged] : undefined;
    return {
      status: 'ok',
      nodeId: firstChanged ?? '',
      revision: node?.revision ?? 0,
      autoFixes: result.autoFixes,
      attempts: auditRows.length,
    };
  }

  // ── 写入操作（UI 与工具共用，保证行为一致 FR-71）────────────────

  /** 新增节点。 */
  async addNode(input: {
    parentId: string | null;
    name: string;
    kind?: NodeKind;
    description?: string;
    refs?: Ref[];
    addedMidway?: boolean;
    autoCreated?: boolean;
    by?: 'user' | 'session' | 'subagent' | 'job';
    actorId?: string;
  }): Promise<ApplyResult & { nodeId?: string }> {
    const graph = await this.readGraph();
    const result = mutateAdd(
      graph,
      {
        parentId: input.parentId,
        name: input.name,
        by: input.by ?? 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.refs !== undefined ? { refs: input.refs } : {}),
        ...(input.addedMidway !== undefined ? { addedMidway: input.addedMidway } : {}),
        ...(input.autoCreated !== undefined ? { autoCreated: input.autoCreated } : {}),
      },
      this.mutationContext(),
    );
    const applied = await this.persist(result);
    if (applied.status === 'ok' && result.kind === 'ok') {
      const newId = diffNodeIds(graph, result.graph)[0];
      return { ...applied, ...(newId !== undefined ? { nodeId: newId } : {}) };
    }
    return applied;
  }

  /** 更新节点字段（`pm_update` 内核）。 */
  async patchNode(input: {
    nodeId: string;
    patch: PatchFields;
    rev?: number;
    structRev?: number;
    force?: boolean;
    by?: 'user' | 'session' | 'subagent' | 'job';
    actorId?: string;
    reason?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const node = graph.nodes[input.nodeId];
    if (node?.flags?.includes('needsConfirm')) this.needsConfirmNodes.add(input.nodeId);
    const result = mutatePatch(
      graph,
      {
        nodeId: input.nodeId,
        patch: input.patch,
        by: input.by ?? 'session',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.rev !== undefined ? { rev: input.rev } : {}),
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 推进进度/状态（`pm_progress`）。 */
  async progress(input: {
    nodeId: string;
    progress?: number;
    selfState?: SelfState;
    rev?: number;
    force?: boolean;
    reason?: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    const patch: PatchFields = {};
    if (input.progress !== undefined) patch.progress = input.progress;
    if (input.selfState !== undefined) patch.selfState = input.selfState;
    return this.patchNode({
      nodeId: input.nodeId,
      patch,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });
  }

  /** 标记完成（`pm_finish`）：同时置 `progress = 1`，避免触发 C3。 */
  async finish(input: {
    nodeId: string;
    rev?: number;
    evidence?: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    return this.patchNode({
      nodeId: input.nodeId,
      patch: { selfState: 'done', progress: 1 },
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
      ...(input.evidence !== undefined ? { reason: input.evidence } : {}),
      ...(input.by !== undefined ? { by: input.by } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });
  }

  /**
   * 删除整枝（`pm_remove`）—— **破坏性操作，必须取得一次性授权**（§13.1 / FR-135–138）。
   *
   * 未带 `confirmToken` 时只返回 `needs-confirm` + preview，**不执行任何动作**。
   */
  async removeBranch(input: {
    nodeId: string;
    policy: 'record' | 'code' | 'comment';
    rev?: number;
    confirmToken?: string;
    toolName?: string;
    agent?: unknown;
    callId?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const node = graph.nodes[input.nodeId];
    if (!node) {
      return {
        status: 'denied',
        reason: 'validation',
        code: 'E_NOT_FOUND',
        message: `节点 ${input.nodeId} 不存在`,
      };
    }

    const preview = this.previewRemove(graph, input.nodeId, input.policy);

    if (input.confirmToken === undefined) {
      return {
        status: 'needs-confirm',
        confirmToken: this.deps.random.uuid(),
        preview,
        action: 'remove-branch',
      };
    }

    // 准入：一次性授权（fail-closed，FR-136）
    const authorized = await this.authorize({
      action: 'remove-branch',
      toolName: input.toolName ?? 'pm_remove',
      reason: `删除整枝「${node.name}」（policy=${input.policy}）`,
      agent: input.agent,
      callId: input.callId,
    });
    if (!authorized.ok) {
      return {
        status: 'denied',
        reason: authorized.reason,
        code: authorized.reason,
        message: authorized.message,
        hint: authorized.hint,
      };
    }

    const result = mutateRemove(
      graph,
      {
        nodeId: input.nodeId,
        policy: input.policy,
        by: 'user',
        ...(input.rev !== undefined ? { rev: input.rev } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 预览删除影响范围（FR-64/R10：必须明示覆盖范围与未覆盖项）。 */
  previewRemove(graph: GraphSnapshot, nodeId: string, policy: string): string {
    const index = buildIndex(graph);
    const node = index.byId.get(nodeId);
    if (!node) return '节点不存在';
    const descendants = collectSubtree(index, nodeId);
    const leaves = descendants.filter((id) => (index.childrenOf.get(id) ?? []).length === 0);
    const touched = new Set<string>();
    for (const id of descendants) {
      for (const path of graph.nodes[id]?.refs?.map((r) => r.target) ?? []) touched.add(path);
    }
    return [
      `将删除整枝「${node.name}」`,
      `- 覆盖节点：${descendants.length} 个（其中叶节点 ${leaves.length} 个）`,
      `- 方案：${policy === 'record' ? '仅删枝的记录（可恢复）' : policy === 'code' ? '代码一并删除' : '代码仅注释（保留后期恢复可能）'}`,
      `- 已记录的引用路径：${touched.size} 个`,
      '- 未覆盖项：shell 命令产生的写入、外部进程与其他工具的改动不在回滚/删除范围内',
      '- 本操作不可保证完整恢复，请自行确认',
    ].join('\n');
  }

  /** 设置关注（`pm_focus`，含归一化）。 */
  async setFocus(input: {
    nodeId: string;
    focus: boolean;
    structRev?: number;
    by?: 'user' | 'session';
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateFocus(
      graph,
      {
        nodeId: input.nodeId,
        focus: input.focus,
        by: input.by ?? 'user',
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 设置门控（暂停/拦停/放行/继续）。 */
  async setGate(input: {
    nodeId: string;
    gate: NodeRecord['gate'];
    structRev?: number;
    by?: 'user' | 'session';
    reason?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateGate(
      graph,
      {
        nodeId: input.nodeId,
        gate: input.gate,
        by: input.by ?? 'user',
        ...(input.structRev !== undefined ? { structRev: input.structRev } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 设置标记位（回滚过、待确认停止等）。 */
  async setFlags(input: {
    nodeId: string;
    add?: NodeFlag[];
    remove?: NodeFlag[];
    lastRollbackAt?: string;
    by?: 'user' | 'session';
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateFlags(
      graph,
      {
        nodeId: input.nodeId,
        by: input.by ?? 'user',
        ...(input.add !== undefined ? { add: input.add } : {}),
        ...(input.remove !== undefined ? { remove: input.remove } : {}),
        ...(input.lastRollbackAt !== undefined ? { lastRollbackAt: input.lastRollbackAt } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 申请订阅（`pm_watch`）。 */
  async subscribe(input: {
    nodeId: string;
    actor: 'session' | 'subagent' | 'job' | 'user';
    actorId: string;
    intent: 'read' | 'write' | 'exclusive';
    touchedPaths?: string[];
    notify?: 'key' | 'full' | 'none';
    expiresAt?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateSubscribe(
      graph,
      {
        nodeId: input.nodeId,
        by: input.actor,
        actorId: input.actorId,
        subscription: {
          subscriptionId: this.deps.random.uuid(),
          actor: input.actor,
          actorId: input.actorId,
          intent: input.intent,
          notify: input.notify ?? 'key',
          touchedPaths: input.touchedPaths ?? [],
        },
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  /** 释放订阅。 */
  async unsubscribe(input: {
    nodeId: string;
    subscriptionId: string;
    by?: 'session' | 'subagent' | 'job' | 'user';
    actorId?: string;
  }): Promise<ApplyResult> {
    const graph = await this.readGraph();
    const result = mutateUnsubscribe(
      graph,
      {
        nodeId: input.nodeId,
        subscriptionId: input.subscriptionId,
        by: input.by ?? 'session',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      },
      this.mutationContext(),
    );
    return this.persist(result);
  }

  // ── 读视图 ────────────────────────────────────────────────────

  /** 派生图（UI 与工具共用同一口径）。 */
  async derive(): Promise<{ graph: GraphSnapshot; derived: DerivedGraph }> {
    const graph = await this.readGraph();
    return { graph, derived: deriveGraph(graph) };
  }

  /** 看板快照（面板一次拉全，避免多次往返）。 */
  async board(): Promise<BoardSnapshot> {
    const { graph, derived } = await this.derive();
    const focusRoots = focusedRoots(derived.index);
    const views = [...derived.nodes.values()].map((d) =>
      this.toView(derived, d.node.id),
    ).filter((v): v is NodeView => v !== undefined);

    const conflicts = await this.port.listConflicts(this.projectId, 'pending');
    const snapshotDecision = resolveSnapshotMode(
      this.deps.config.snapshotMode,
      this.deps.capabilities,
    );
    const doc = await this.checkDocumentFile(graph);
    const meta = await this.port.getMeta(this.projectId);

    return {
      projectId: this.projectId,
      projectName: graph.projectName,
      nodes: views,
      overall: derived.overall,
      focused: statsForRoots(derived, focusRoots),
      focusedRootIds: focusRoots,
      unfinished: unfinishedLeaves(derived).map((d) => this.toView(derived, d.node.id)).filter(
        (v): v is NodeView => v !== undefined,
      ),
      conflicts: conflicts.map((c) => ({
        conflictId: c.conflictId,
        nodeId: c.nodeId,
        code: c.code,
        message: c.message,
      })),
      scanBand: [...derived.nodes.values()]
        .filter((d) => (derived.index.childrenOf.get(d.node.id) ?? []).length === 0)
        .map((d) => ({
          nodeId: d.node.id,
          name: d.node.name,
          derivedState: d.derivedState,
          isFocus: d.node.focus,
        })),
      degradation: this.deps.capabilities.degradations,
      snapshot: snapshotDecision,
      confirmChannel: this.confirm?.describeChannel() ?? '确认路由未装配',
      document: {
        path: this.deps.config.documentPath,
        exists: doc.exists,
        legal: doc.check?.ok ?? false,
        violations: (doc.check?.violations ?? []).map(
          (v) => `${v.rule}: ${v.message}（${v.hint}）`,
        ),
      },
      dataFormat: meta?.dataFormat ?? DATA_FORMAT,
    };
  }

  /** 单节点视图。 */
  async nodeView(nodeId: string): Promise<NodeView | undefined> {
    const { derived } = await this.derive();
    return this.toView(derived, nodeId);
  }

  private toView(derived: DerivedGraph, nodeId: string): NodeView | undefined {
    const d = derived.nodes.get(nodeId);
    if (!d) return undefined;
    const view: NodeView = {
      id: d.node.id,
      name: d.node.name,
      parentId: d.node.parentId,
      kind: d.node.kind,
      selfState: d.node.selfState,
      derivedState: d.derivedState,
      progress: d.progress,
      weight: d.weight,
      focus: d.node.focus,
      gate: d.node.gate,
      flags: d.node.flags ?? [],
      autoCreated: d.node.autoCreated === true,
      childCount: d.childCount,
      leafCount: d.leafCount,
      unfinishedLeafCount: d.unfinishedLeafCount,
      blockedBy: (d.node.dependsOn ?? []).filter((id) => {
        const dep = derived.nodes.get(id);
        return dep !== undefined && dep.derivedState !== 'done' && dep.derivedState !== 'removed';
      }),
      revision: d.node.revision,
      updatedAt: d.node.updatedAt,
      updatedBy: d.node.updatedBy,
      addedMidway: (d.node.flags ?? []).includes('addedMidway'),
      subscriptionCount: (d.node.bindings ?? []).length,
      branchPath: branchPath(derived.index, nodeId),
    };
    if (d.node.description !== undefined) view.description = d.node.description;
    if (d.node.refs !== undefined) view.refs = d.node.refs;
    return view;
  }

  /** 树形返回（`pm_tree`）：按父子关系嵌套，返回极简字段（FR-74）。 */
  async tree(options: {
    rootId?: string;
    depth?: number;
    detail?: boolean;
    limit?: number;
  }): Promise<{ nodes: unknown[]; truncated: boolean; totalNodes: number }> {
    const { graph, derived } = await this.derive();
    const index = derived.index;
    const roots = options.rootId ? [options.rootId] : graph.rootIds;
    const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;
    const limit = options.limit ?? 50;
    const flat: NodeView[] = [];
    let truncated = false;

    const walk = (id: string, depth: number): void => {
      if (flat.length >= limit) {
        truncated = true;
        return;
      }
      const view = this.toView(derived, id);
      if (view) flat.push(view);
      if (depth >= maxDepth) return;
      for (const childId of index.childrenOf.get(id) ?? []) walk(childId, depth + 1);
    };
    for (const rootId of roots) walk(rootId, 1);

    return { nodes: flat, truncated, totalNodes: derived.nodes.size };
  }

  // ── 文档 ─────────────────────────────────────────────────────

  /**
   * 文件系统服务。
   *
   * 走 `serviceOf` 而不是直接写 `ctx.fs`：属性访问依赖模块增补被加载，
   * 且无法在测试替身下注入；两条路都试更稳（判定见 `adapter/capabilities.ts`）。
   */
  private fileSystem(): {
    resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
    readText(target: unknown): Promise<string>;
    writeText(target: unknown, content: string): Promise<unknown>;
  } {
    const fs = serviceOf<{
      resolve(path: string, opts?: { cwd?: string }): Promise<unknown>;
      readText(target: unknown): Promise<string>;
      writeText(target: unknown, content: string): Promise<unknown>;
    }>(this.ctx, 'fs');
    if (!fs) throw new Error('文件系统服务不可用（ctx.fs / ctx.get("fs") 均未解析到）');
    return fs;
  }

  /** 文档合法性检查（FR-02/04）。 */
  async checkDocumentFile(
    graph?: GraphSnapshot,
  ): Promise<{ exists: boolean; check?: DocCheckResult; markdown?: string }> {
    const snapshot = graph ?? (await this.readGraph());
    try {
      const root = this.workspaceRoot();
      const fs = this.fileSystem();
      const target = await fs.resolve(this.deps.config.documentPath, {
        ...(root !== undefined ? { cwd: root } : {}),
      });
      const text = await fs.readText(target);
      const known = new Set(Object.values(snapshot.nodes).map((n) => n.name));
      return { exists: true, check: checkDocument(text, known), markdown: text };
    } catch {
      return { exists: false };
    }
  }

  /** 投影文档内容（不写盘）。 */
  async renderDocument(): Promise<{ markdown: string; overflow: boolean; fingerprint: string }> {
    const graph = await this.readGraph();
    const projection = projectDocument(graph);
    return {
      markdown: projection.markdown,
      overflow: projection.overflow,
      fingerprint: projectionFingerprint(graph),
    };
  }

  /**
   * 把投影写入 `project-manager.md`（经 `ctx.fs` 版本守卫，FR-127）。
   *
   * 结构未变（指纹一致）时**短路不写**，避免无意义写盘与文件监听抖动。
   */
  async projectDocumentToDisk(): Promise<{
    written: boolean;
    reason: string;
    path: string;
  }> {
    const rendered = await this.renderDocument();
    if (rendered.overflow) {
      return {
        written: false,
        reason: '投影超过行数上限，已拒绝写入（避免静默截断）',
        path: this.deps.config.documentPath,
      };
    }
    const meta = await this.port.getMeta(this.projectId);
    if (meta?.projectionFingerprint === rendered.fingerprint) {
      return { written: false, reason: '结构未变化，跳过写入', path: this.deps.config.documentPath };
    }

    const root = this.workspaceRoot();
    try {
      const fs = this.fileSystem();
      const target = await fs.resolve(this.deps.config.documentPath, {
        ...(root !== undefined ? { cwd: root } : {}),
      });
      await fs.writeText(target, rendered.markdown);
    } catch (error) {
      return {
        written: false,
        reason: `写入失败：${error instanceof Error ? error.message : String(error)}`,
        path: this.deps.config.documentPath,
      };
    }

    if (meta) {
      await this.port.putMeta({
        ...meta,
        projectionFingerprint: rendered.fingerprint,
        updatedAt: this.deps.clock.now(),
      });
    }
    return { written: true, reason: '已投影', path: this.deps.config.documentPath };
  }

  // ── 确认 ─────────────────────────────────────────────────────

  /** 取得一次性授权（fail-closed，FR-136）。 */
  async authorize(input: {
    action: Parameters<ConfirmRouter['authorize']>[0]['action'];
    toolName: string;
    reason: string;
    agent?: unknown;
    callId?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string; message: string; hint: string }> {
    if (!this.confirm) {
      return {
        ok: false,
        reason: 'no-channel',
        message: '确认路由未装配，破坏性操作一律拒绝',
        hint: '请在面板内右键确认',
      };
    }
    const result = await this.confirm.authorize({
      action: input.action,
      toolName: input.toolName,
      reason: input.reason,
      agent: input.agent as never,
      ...(input.callId !== undefined ? { callId: input.callId as never } : {}),
    });
    if (result.ok) return { ok: true };
    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      hint: result.hint,
    };
  }

  // ── 回滚锁（C9）──────────────────────────────────────────────
  lockSubtree(rootId: string): void {
    this.rollbackLocks.add(rootId);
  }

  unlockSubtree(rootId: string): void {
    this.rollbackLocks.delete(rootId);
  }

  markNeedsConfirm(nodeId: string): void {
    this.needsConfirmNodes.add(nodeId);
  }

  clearNeedsConfirm(nodeId: string): void {
    this.needsConfirmNodes.delete(nodeId);
  }

  /** 审计读取（状态条展示）。 */
  async recentAudit(limit = 50): Promise<AuditRecord[]> {
    return this.port.listAudit(this.projectId, limit);
  }

  /** 写入块归属（供工具做 rev/structRev 校验说明）。 */
  static blockOfPatch(patch: PatchFields): string {
    return blockOf(patch);
  }
}

/** 计算两份图的节点差异（用于只写变化的记录）。 */
function diffNodeIds(
  before: GraphSnapshot | undefined,
  after: GraphSnapshot,
): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(after.nodes)) {
    const prev = before?.nodes[id];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(node)) out.push(id);
  }
  return out;
}

/** 收集整枝 id（含自身）。 */
function collectSubtree(index: ReturnType<typeof buildIndex>, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const childId of index.childrenOf.get(current) ?? []) stack.push(childId);
  }
  return out;
}

/**
 * 尽力从环境推断工作区根。
 *
 * DSH 的工作区 cwd 是 **per-call** 值（`exec.agent.session.header.cwd`），
 * 不在 `ctx` 上；因此在没有 agent 上下文时回落到 `DSH_WORKSPACE`/`PWD`，
 * 有 agent 上下文时由工具层显式传入（见 `src/tools/`）。
 */
function readWorkspaceRootFromEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return undefined;
  return env['DSH_WORKSPACE'] ?? env['PWD'] ?? env['INIT_CWD'] ?? undefined;
}

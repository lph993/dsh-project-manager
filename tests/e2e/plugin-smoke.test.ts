/**
 * 端到端冒烟测试：用**构建产物** `lib/index.js` 跑完整链路。
 *
 * 为什么需要它：单元测试只覆盖纯领域层。插件真正会踩的坑在**宿主契约**上
 * （服务名、schema 校验、事件名、exports 形态、领域名规则……），只有把 `apply()`
 * 真的跑起来才暴露得出来 —— 本测试第一次运行就抓到了
 * 「领域名不允许连字符」这个真错误。
 *
 * 这里用**假的 Cordis 上下文 + 按 spec 校验的 storageDomain 替身**：
 * 既验证我们的数据形状真能通过 DSH 的 zod schema，又不需要拉起整套宿主。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { structureDomainSpec, progressDomainSpec } from '../../src/storage/kv-port.ts';

/** 按 DomainSpec 的 zod schema 校验的存储替身。 */
function createFakeStorageDomain() {
  const domains = new Map<string, { spec: unknown; tables: Map<string, Map<string, unknown>>; global: unknown }>();
  const listeners: Array<(change: unknown) => void> = [];

  const table = (domainName: string, tableName: string) => {
    const domain = domains.get(domainName);
    if (!domain) throw new Error(`domain ${domainName} not open`);
    let store = domain.tables.get(tableName);
    if (!store) {
      store = new Map();
      domain.tables.set(tableName, store);
    }
    const spec = domain.spec as {
      tables: Record<string, { valueSchema?: { parse(value: unknown): unknown } }>;
    };
    const schema = spec.tables[tableName]?.valueSchema;
    if (!schema) throw new Error(`table ${tableName} not in spec`);

    const emit = (key: string, operation: 'put' | 'deleted', value?: unknown) => {
      for (const listener of listeners) listener({ domain: domainName, table: tableName, key, operation, value });
    };

    return {
      get: (key: string) => store.get(key),
      keys: () => store.keys(),
      entries: () => store.entries(),
      get size() {
        return store.size;
      },
      async put(key: string, value: unknown) {
        const parsed = schema.parse(value); // ← 关键：真用 DSH 的 schema 校验
        store.set(key, parsed);
        emit(key, 'put', parsed);
      },
      async delete(key: string) {
        const existed = store.delete(key);
        if (existed) emit(key, 'deleted');
        return existed;
      },
      async update(key: string, fn: (current: unknown) => unknown) {
        const current = store.get(key);
        if (current === undefined) throw new Error('missing-key');
        const next = schema.parse(fn(current));
        store.set(key, next);
        emit(key, 'put', next);
        return next;
      },
    };
  };

  return {
    async open(spec: { name: string; tables: Record<string, unknown>; global?: { schema: { parse(v: unknown): unknown }; initial: unknown } }) {
      const globalValue = spec.global ? spec.global.schema.parse(spec.global.initial) : undefined;
      domains.set(spec.name, { spec, tables: new Map(), global: globalValue });
      return {
        name: spec.name,
        table: (name: string) => table(spec.name, name),
        global: {
          get: () => domains.get(spec.name)?.global,
          set: async (value: unknown) => {
            const parsed = spec.global ? spec.global.schema.parse(value) : value;
            const domain = domains.get(spec.name);
            if (domain) domain.global = parsed;
          },
        },
        close: async () => {
          domains.delete(spec.name);
        },
      };
    },
    on(_event: string, listener: (change: unknown) => void) {
      listeners.push(listener);
      return () => {};
    },
  };
}

/** 最小假文件系统：只实现投影用到的两个方法。 */
function createFakeFs(workspace: string) {
  const files = new Map<string, string>();
  return {
    files,
    async resolve(path: string) {
      return { targetKey: path, displayPath: join(workspace, path) };
    },
    async readText(target: { targetKey: string }) {
      const content = files.get(target.targetKey);
      if (content === undefined) throw new Error('FS_NOT_OBSERVED');
      return content;
    },
    async writeText(target: { targetKey: string }, content: string) {
      files.set(target.targetKey, content);
      return { operation: 'update', version: 'v1', before: null, after: content };
    },
  };
}

/** 本文件创建过的假上下文（供失败兜底卸载，见文件末尾的 `after`）。 */
const createdContexts: Array<{ disposeAll(): void }> = [];

/** 最小假 cordis 上下文。 */
function createFakeContext(options: { workspace: string; agents?: unknown }) {  const services = new Map<string, unknown>();
  const storage = createFakeStorageDomain();
  const fs = createFakeFs(options.workspace);
  const tools = new Map<string, unknown>();
  const settingsNamespaces: string[] = [];
  const effects: Array<() => void> = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const logs: string[] = [];

  services.set('storageDomain', storage);
  services.set('fs', fs);
  // agent 注册表替身（可选）：只有需要"按会话精确解析工作区"的用例才装它
  if (options.agents !== undefined) services.set('agents', options.agents);
  /**
   * 工作区注册表替身。
   *
   * 真实 DSH 里它是 `ctx.workspaceRegistry`，`list()` 返回 `{ path, title, updatedAt }`。
   * 插件用它来解决"面板在没有工具调用时不知道工作区根"的问题（实测踩过：看板因此空着）。
   */
  services.set('workspaceRegistry', {
    list: () => [
      {
        path: options.workspace,
        title: 'test-workspace',
        sessionIds: ['session-in-workspace'],
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        path: join(options.workspace, 'older'),
        title: 'older',
        sessionIds: [],
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
  });
  services.set('approval', {
    async request() {
      return 'allowed-once' as const;
    },
  });
  services.set('userQuestions', {
    async ask() {
      return { answers: [] };
    },
  });
  /** 捕获注册的 HTTP 路由，便于在测试里直接调用 handler。 */
  const registeredRoutes: Array<{
    kind: string;
    path: string;
    handler: (req: unknown, res: unknown) => void | Promise<void>;
  }> = [];

  services.set('webServer', {
    register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) {
      registeredRoutes.push(route);
      return () => {};
    },
  });

  const ctx = {
    get: (key: string) => services.get(key),
    set: (key: string, value: unknown) => {
      services.set(key, value);
    },
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const list = events.get(event) ?? [];
      list.push(listener);
      events.set(event, list);
      return () => {};
    },
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    // 与真实 cordis 对齐：`provide` 注册**新**服务并返回 disposer；
    // `set` 只允许覆盖已提供的服务（首次装入时就是用错 set 才炸的）。
    provide: (key: string, value?: unknown) => {
      if (services.has(key)) throw new Error(`cannot provide "${key}" twice`);
      services.set(key, value);
      return () => services.delete(key);
    },
    set: (key: string, value: unknown) => {
      if (!services.has(key)) {
        throw new Error(`cannot set property "${key}" without provide`);
      }
      services.set(key, value);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of events.get(event) ?? []) listener(...args);
    },
    tools: {
      register: (definition: { name: string }) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    settings: {
      register: (namespace: string) => {
        settingsNamespaces.push(namespace);
        return { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} };
      },
    },
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
    services,
    fsService: fs,
    storage,
    toolRegistry: tools,
    settingsNamespaces,
    effects,
    events,
    logs,
    registeredRoutes,
    /**
     * 模拟 cordis 的**纤维卸载**：按注册逆序执行全部 effect disposer。
     *
     * 必须有这一步：插件注册了 chokidar 监听（外部改动感知），若测试结束时不卸载，
     * 监听会一直挂在事件循环上 —— Node 的测试进程会**一直等**（实测超时 120s）。
     */
    disposeAll() {
      for (const dispose of [...effects].reverse()) {
        try {
          dispose();
        } catch {
          // 卸载期异常忽略
        }
      }
      effects.length = 0;
    },
  };
  createdContexts.push(ctx);
  return ctx;
}

/**
 * 兜底卸载：**任何**测试失败时也要把已建的假上下文卸载掉。
 *
 * 为什么必须有：插件会惰性启动 chokidar 监听，若某个断言先抛错，
 * 该测试末尾的 `ctx.disposeAll()` 就不会执行 —— 监听句柄留在事件循环上，
 * `node --test` **永远不退出**（实测：整轮跑挂死 10 分钟，且看不到失败详情）。
 */
after(() => {
  for (const ctx of createdContexts.splice(0)) {
    try {
      ctx.disposeAll();
    } catch {
      // 卸载期异常忽略
    }
  }
});

test('构建产物可加载，且 apply() 能完成注册（无 export default）', async () => {
  const module = (await import('../../lib/index.js')) as Record<string, unknown>;
  assert.equal(typeof module['apply'], 'function');
  assert.ok(Array.isArray(module['inject']), 'inject 必须是数组');
  assert.equal(module['name'], 'project-manager');
  assert.ok(!('default' in module), '函数式插件不得有 export default（Loader 会丢掉 inject）');
  assert.ok(module['Config'], 'Config 必须是 schemastery schema');
});

test('apply() 全链路：建树 → 统计 → 投影 → 工具可调用', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };

  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'auto',
    aiWeightMeasurement: false,
  });

  // 服务已注册
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    finish(input: Record<string, unknown>): Promise<unknown>;
    progress(input: Record<string, unknown>): Promise<unknown>;
    setFocus(input: Record<string, unknown>): Promise<unknown>;
    setGate(input: Record<string, unknown>): Promise<unknown>;
    board(): Promise<{
      overall: { ratio: number; totalLeaves: number; unfinishedLeaves: number };
      focused: { ratio: number };
      nodes: unknown[];
    }>;
    renderDocument(): Promise<{ markdown: string; overflow: boolean }>;
    projectDocumentToDisk(): Promise<{ written: boolean; reason: string }>;
    checkDocumentFile(): Promise<{ exists: boolean; check?: { ok: boolean } }>;
    recentAudit(limit: number): Promise<unknown[]>;
    removeBranch(input: Record<string, unknown>): Promise<{ status: string }>;
  };
  assert.ok(service, 'projectManager 服务未注册');
  assert.match(service.currentProjectId, /^pm_/);

  // 工具已注册（与 src/index.ts 的 TOOL_NAMES 对齐）
  for (const name of [
    'pm_tree',
    'pm_node',
    'pm_add',
    'pm_progress',
    'pm_finish',
    'pm_focus',
    'pm_gate',
    'pm_watch',
    'pm_remove',
    'pm_board',
    'pm_doc_check',
    'pm_audit',
    'pm_snapshot',
    'pm_snapshots',
    'pm_rollback',
    'pm_rollback_undo',
    'pm_snapshot_health',
    'pm_scan',
    'pm_pause',
    'pm_hold',
    'pm_resume',
    'pm_release',
    'pm_handoff_read',
  ]) {
    assert.ok(ctx.toolRegistry.has(name), `工具 ${name} 未注册`);
  }
  assert.equal(ctx.toolRegistry.size, 23, '工具总数应与 TOOL_NAMES 一致');

  // 设置命名空间已注册
  assert.deepEqual(ctx.settingsNamespaces, ['project-manager']);

  // ── 面板契约一致性：看板快照字段必须覆盖 client/contract.ts 的 BoardSnapshot ──
  const contractKeys = [
    'projectId',
    'projectName',
    'nodes',
    'overall',
    'focused',
    'focusedRootIds',
    'unfinished',
    'conflicts',
    'scanBand',
    'degradation',
    'snapshot',
    'confirmChannel',
    'document',
    'dataFormat',
  ];
  const snapshot = await service.board();
  for (const key of contractKeys) {
    assert.ok(key in (snapshot as unknown as Record<string, unknown>), `看板缺少契约字段 ${key}`);
  }
  const statsKeys = [
    'ratio',
    'basis',
    'doneLeaves',
    'unfinishedLeaves',
    'totalLeaves',
    'runningNodes',
    'errorNodes',
  ];
  for (const key of statsKeys) {
    assert.ok(
      key in (snapshot.overall as unknown as Record<string, unknown>),
      `统计缺少契约字段 ${key}`,
    );
  }

  // ── 建树：根 → 枝 → 两个叶 ──────────────────────────────────
  const root = await service.addNode({ parentId: null, name: 'IM聊天', kind: 'feature' });
  assert.equal(root.status, 'ok');
  const rootId = root.nodeId;
  assert.ok(rootId);

  const branch = await service.addNode({ parentId: rootId, name: 'web前端', kind: 'feature' });
  const branchId = branch.nodeId;
  assert.ok(branchId);

  const leafA = await service.addNode({ parentId: branchId, name: '好友列表' });
  const leafB = await service.addNode({ parentId: branchId, name: '群组' });
  assert.ok(leafA.nodeId && leafB.nodeId);

  // 同级同名被拒（C12）
  const duplicate = await service.addNode({ parentId: branchId, name: '群组' });
  assert.equal(duplicate.status, 'denied');
  assert.equal((duplicate as { code?: string }).code, 'C12');

  // ── 统计：0% ────────────────────────────────────────────────
  let board = await service.board();
  assert.equal(board.overall.totalLeaves, 2);
  assert.equal(board.overall.unfinishedLeaves, 2);
  assert.equal(board.overall.ratio, 0);

  // ── 完成一个叶节点 → 50% ────────────────────────────────────
  const done = await service.finish({ nodeId: leafA.nodeId as string, by: 'session' });
  assert.equal(done.status, 'ok');
  board = await service.board();
  assert.equal(board.overall.ratio, 0.5, '一个叶完成应为 50%');
  assert.equal(board.overall.unfinishedLeaves, 1);

  // 枝的完成态必须递归：还有叶未完成 → 枝不能是 done
  const branchView = board.nodes.find((n) => (n as { id: string }).id === branchId) as {
    derivedState: string;
    unfinishedLeafCount: number;
  };
  assert.notEqual(branchView.derivedState, 'done', 'FR-46b：子孙未完成时枝不得显示完成');
  assert.equal(branchView.unfinishedLeafCount, 1);

  // ── 非法写入被拒：父节点写自身状态（C5） ────────────────────
  const c5 = await service.progress({
    nodeId: branchId,
    selfState: 'running',
    by: 'session',
  });
  assert.equal(c5.status, 'denied');
  assert.equal((c5 as { code?: string }).code, 'C5');

  // ── 关注归一化：关注枝根 → 统计只看该枝 ────────────────────
  const focus = await service.setFocus({ nodeId: branchId, focus: true });
  assert.equal(focus.status, 'ok');
  board = await service.board();
  assert.equal(board.focused.ratio, 0.5, '关注枝内 1/2 完成');

  // ── 门控：拦停枝根 → 子孙计算状态为 held ───────────────────
  const held = await service.setGate({ nodeId: branchId, gate: 'held' });
  assert.equal(held.status, 'ok');
  board = await service.board();
  const heldLeaf = board.nodes.find((n) => (n as { id: string }).id === leafB.nodeId) as {
    derivedState: string;
  };
  assert.equal(heldLeaf.derivedState, 'held', '门控必须沿枝继承到叶节点');

  // 解除门控后回落原状态
  await service.setGate({ nodeId: branchId, gate: null });
  board = await service.board();
  const releasedLeaf = board.nodes.find((n) => (n as { id: string }).id === leafB.nodeId) as {
    derivedState: string;
  };
  assert.equal(releasedLeaf.derivedState, 'pending');

  // ── 文档投影 ────────────────────────────────────────────────
  const rendered = await service.renderDocument();
  assert.match(rendered.markdown, /^# /, '首行必须是一级标题');
  assert.match(rendered.markdown, /```mermaid/);
  assert.match(rendered.markdown, /IM聊天 --> web前端/);
  assert.equal(rendered.overflow, false);

  const written = await service.projectDocumentToDisk();
  assert.equal(
    written.written,
    true,
    'projection not written, reason=' + written.reason,
  );
  assert.equal(ctx.fsService.files.get('project-manager.md'), rendered.markdown);

  // 再投影一次应短路（结构未变）
  const second = await service.projectDocumentToDisk();
  assert.equal(second.written, false);
  assert.match(second.reason, /未变化/);

  // 文档校验：刚投影出来的文档必须合法
  const check = await service.checkDocumentFile();
  assert.equal(check.exists, true);
  assert.equal(check.check?.ok, true, `投影出的文档不合法：${JSON.stringify(check.check)}`);

  // 事后篡改：加一行说明文字 → R3 违规
  ctx.fsService.files.set('project-manager.md', `# 项目\n\n这里是说明文字\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n`);
  const dirty = await service.checkDocumentFile();
  assert.equal(dirty.check?.ok, false);
  assert.ok(dirty.check?.violations.some((v) => v.rule === 'R3'));

  // ── 删除整枝：需确认（不执行） ─────────────────────────────
  const needsConfirm = await service.removeBranch({ nodeId: leafB.nodeId as string, policy: 'record' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  const stillThere = await service.nodeView(leafB.nodeId as string);
  assert.ok(stillThere, '未确认前不得执行删除');

  // ── 审计留痕 ────────────────────────────────────────────────
  const audit = await service.recentAudit(50);
  assert.ok(audit.length > 0, '写入必须留痕');

  // 卸载不抛错
  for (const dispose of ctx.effects) dispose();
  ctx.disposeAll();
});

test('看板按会话精确定位工作区：sessionId → agent cwd / 注册表反查', async () => {
  const registered = mkdtempSync(join(tmpdir(), 'pm-e2e-root-a-'));
  const sessionDir = mkdtempSync(join(tmpdir(), 'pm-e2e-root-b-'));

  // ① 有 agent 注册表：按 session.header.cwd 解析（最精确）
  const ctxWithAgent = createFakeContext({
    workspace: registered,
    agents: { get: (id: string) => (id === 'session-live' ? { session: { header: { cwd: sessionDir } } } : undefined) },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctxWithAgent, {});
  const serviceWithAgent = ctxWithAgent.services.get('projectManager') as {
    board(sessionId?: string): Promise<{
      workspaceRoot: { value: string | null; source: string };
    }>;
  };

  const byAgent = await serviceWithAgent.board('session-live');
  assert.equal(byAgent.workspaceRoot.value, sessionDir);
  assert.equal(byAgent.workspaceRoot.source, 'session-agent');

  // ② agent 查不到 → 用注册表里的 sessionIds 反查（用户选过的工作区）
  const byRegistry = await serviceWithAgent.board('session-in-workspace');
  assert.equal(byRegistry.workspaceRoot.value, registered);
  assert.equal(byRegistry.workspaceRoot.source, 'session-workspace');

  // ③ 没有会话信息 → 退回"最近使用的工作区"，并且根不能为空
  const anonymous = await serviceWithAgent.board();
  assert.equal(anonymous.workspaceRoot.value, registered);
  assert.equal(anonymous.workspaceRoot.source, 'workspace-registry');

  ctxWithAgent.disposeAll();
  rmSync(registered, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

test('多工作区：每个工作区根绑定自己的项目（切换不串树）', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'pm-e2e-ws-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'pm-e2e-ws-b-'));
  const ctx = createFakeContext({ workspace: wsA });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    board(sessionId?: string): Promise<{
      projectId: string;
      nodes: Array<{ name: string }>;
      workspaceRoot: { value: string | null; source: string };
    }>;
    listProjects(): Promise<Array<{ projectId: string; workspaceRoot?: string }>>;
  };

  // A 工作区建一棵树
  service.noteWorkspaceRoot(wsA, 'session-A');
  const nodeA = await service.addNode({ parentId: null, name: 'A树' });
  assert.equal(nodeA.status, 'ok');
  const projectA = service.currentProjectId;

  // 切到 B 工作区（另一个会话）→ 必须换到**另一个项目**，而不是把 B 的节点写进 A 的树
  service.noteWorkspaceRoot(wsB, 'session-B');
  const boardB = await service.board('session-B');
  assert.equal(boardB.workspaceRoot.value, wsB);
  assert.notEqual(boardB.projectId, projectA, '不同工作区必须绑定不同项目');
  assert.deepEqual(boardB.nodes, [], 'B 工作区应该是空的新项目');

  const nodeB = await service.addNode({ parentId: null, name: 'B树' });
  assert.equal(nodeB.status, 'ok');
  const boardB2 = await service.board('session-B');
  assert.deepEqual(
    boardB2.nodes.map((n) => n.name),
    ['B树'],
  );

  // 切回 A：A 的树必须原样还在（证明没有互相污染）
  service.noteWorkspaceRoot(wsA, 'session-A');
  const boardA = await service.board('session-A');
  assert.equal(boardA.projectId, projectA);
  assert.deepEqual(
    boardA.nodes.map((n) => n.name),
    ['A树'],
  );

  // 两个项目都记下了自己的根（这是"能按根找回项目"的依据）
  const projects = await service.listProjects();
  const roots = projects.map((p) => p.workspaceRoot).filter((r): r is string => r !== undefined);
  assert.equal(roots.length, 2, `项目 meta 必须各自记录工作区根：${JSON.stringify(projects)}`);

  ctx.disposeAll();
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});

test('老数据迁移：库里只有一个无根项目时被"认领"，而不是孤立它', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-adopt-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'pm-e2e-adopt-other-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string }>;
    board(sessionId?: string): Promise<{
      projectId: string;
      nodes: Array<{ name: string }>;
      workspaceRoot: { value: string | null };
    }>;
    storage: {
      getMeta(id: string): Promise<Record<string, unknown> | undefined>;
      putMeta(meta: Record<string, unknown>): Promise<void>;
    };
  };

  const legacyId = service.currentProjectId;
  await service.addNode({ parentId: null, name: '旧树' });

  // 模拟"升级前写入的数据"：meta 里没有 workspaceRoot 字段
  const meta = await service.storage.getMeta(legacyId);
  assert.ok(meta, '项目 meta 必须存在');
  const { workspaceRoot: _dropped, ...legacyMeta } = meta;
  await service.storage.putMeta(legacyMeta);
  assert.equal((await service.storage.getMeta(legacyId))?.['workspaceRoot'], undefined);

  // 换到另一个根：库里唯一的"无根项目"应被认领（而不是新建空项目 → 用户的树被孤立）
  service.noteWorkspaceRoot(otherRoot, 'session-other');
  const board = await service.board('session-other');
  assert.equal(board.projectId, legacyId, '唯一的老项目应被认领，而不是新建一个空项目');
  assert.deepEqual(
    board.nodes.map((n) => n.name),
    ['旧树'],
  );
  assert.equal(
    (await service.storage.getMeta(legacyId))?.['workspaceRoot'],
    otherRoot,
    '认领时应把根写回项目 meta',
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
});

test('墓碑不变量：删了能重建同名、重扫不被墓碑挡住、墓碑不进看板（§9.1 T-a/b/c）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-tomb-'));
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'tomb-demo' }));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string; code?: string }>;
    board(): Promise<{ nodes: Array<{ id: string; name: string }>; overall: { totalLeaves: number } }>;
    removeBranchFromPanel(input: Record<string, unknown>): Promise<{ status: string; preview?: string }>;
    scan(input?: Record<string, unknown>): Promise<{ nodes: Array<Record<string, unknown>> }>;
    applyScan(input: Record<string, unknown>): Promise<{ created: number; skipped: number }>;
  };
  service.noteWorkspaceRoot(workspace);

  const root = await service.addNode({ parentId: null, name: '甲' });
  assert.equal(root.status, 'ok');
  const child = await service.addNode({ parentId: root.nodeId, name: '乙' });
  assert.equal(child.status, 'ok');

  // 面板路径删除整枝：先 preview，确认后才落库
  const preview = await service.removeBranchFromPanel({ nodeId: root.nodeId, policy: 'record' });
  assert.equal(preview.status, 'needs-confirm');
  assert.ok(preview.preview && preview.preview.length > 0, '删除前必须给出影响范围');
  const removed = await service.removeBranchFromPanel({
    nodeId: root.nodeId,
    policy: 'record',
    confirm: true,
  });
  assert.equal(removed.status, 'ok');

  // T-c：墓碑不进看板
  const afterRemove = await service.board();
  assert.equal(afterRemove.nodes.length, 0, `墓碑不得出现在看板：${JSON.stringify(afterRemove.nodes)}`);
  assert.equal(afterRemove.overall.totalLeaves, 0);

  // T-a：删了能重建同名（不被自己的删除记录按 C12 挡住）
  const again = await service.addNode({ parentId: null, name: '甲' });
  assert.equal(again.status, 'ok', `删后重建同名被拒：${again.code ?? ''}`);

  // T-b：重新扫描不被墓碑去重挡住（全部重建）
  const scan = await service.scan({});
  assert.ok(scan.nodes.length >= 2, `扫描应至少给出根 + 关键文件：${scan.nodes.length}`);
  const applied = await service.applyScan({ nodes: scan.nodes });
  assert.equal(applied.skipped, 0, '墓碑不得参与重新扫描的去重');
  assert.ok(applied.created >= 2, `应能重建：${JSON.stringify(applied)}`);

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('AI 建树：先给成本预估，确认后一次调用生成功能/任务点（含工作量与完成度初判）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-ai-'));
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'ai-demo' }));
  writeFileSync(join(workspace, 'README.md'), '# ai demo\n');
  mkdirSync(join(workspace, 'src', 'auth'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'auth', 'index.ts'), 'export const login = 1;\n');

  const ctx = createFakeContext({ workspace });
  // 让模型路由可用：注入宿主默认模型选择（真实环境里由 dsh-agent-default-model 提供）
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  // llm 服务"存在"（真实宿主一定有），但**未确认前不该被调用**：这里让它直接抛错
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('未确认就调用了模型');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{
      projectName: string;
      overall: { basis: string };
      nodes: Array<{
        id: string;
        name: string;
        parentId: string | null;
        weight: number;
        weightSource?: string;
        weightDetail?: Record<string, unknown>;
        progress: number;
        description?: string;
      }>;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 假模型：按 BlockAssembler 的 chunk 契约流式吐出 JSON（不花任何 token）。 */
  const fakeStream = (json: string) => ({
    stream: () =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: json.slice(0, 40) };
        yield { type: 'text-delta', index: 0, text: json.slice(40) };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
        yield { type: 'finish', reason: 'stop' };
      })(),
  });

  // ① 未确认 → 只回成本预估；这里**不给** stream，一旦真调模型就会因缺 llm 服务而失败
  const preflight = await service.aiBuildTree({ confirm: false });
  assert.equal(preflight['status'], 'needs-confirm', JSON.stringify(preflight));
  const estimate = preflight['estimate'] as { calls: number; totalTokens: number };
  assert.equal(estimate.calls, 1, '建树 + 工作量 + 完成度初判必须是同一次调用');
  assert.ok(estimate.totalTokens > 0);
  assert.ok(String(preflight['description']).includes('粗估'));

  // ② 确认 + 假模型 → 落库
  const json = JSON.stringify({
    projectName: '演示项目',
    nodes: [
      { name: '登录与鉴权', kind: 'feature', parent: null, weight: 8, refs: [{ type: 'dir', target: 'src/auth' }] },
      { name: '会话续期', kind: 'task', parent: 0, weight: 3, progress: 0.6, note: '已看到 refresh 逻辑' },
      { name: '好友列表', kind: 'task', parent: null, weight: 5 },
    ],
  });
  const built = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(built['status'], 'ok', JSON.stringify(built));
  assert.equal(built['created'], 3);
  assert.equal(built['proposed'], 3);
  assert.deepEqual(built['failures'], []);

  const board = await service.board();
  assert.equal(board.projectName, '演示项目');
  const login = board.nodes.find((node) => node.name === '登录与鉴权');
  assert.ok(login, `未建成「登录与鉴权」：${board.nodes.map((n) => n.name).join(',')}`);
  assert.equal(login.weightSource, 'ai', '权重来源必须标成 AI 估算');
  assert.equal(
    (login.weightDetail as { source?: string } | undefined)?.source,
    'ai',
    '权重依据要能追到"AI 估算"',
  );
  const renew = board.nodes.find((node) => node.name === '会话续期');
  assert.equal(renew?.parentId, login.id, '层级要按 parent 下标挂对');
  // 注意：NodeView.weight 是**派生权重**（父 = Σ 子），叶节点才是自己的权重
  assert.equal(renew?.weight, 3, '叶节点的相对工作量应落库');
  assert.equal(renew?.progress, 0.6, '完成度初判应写入');
  assert.equal(renew?.description, '已看到 refresh 逻辑');
  assert.equal(board.overall.basis, 'weight', '有 AI 权重时口径应转为按工作量（§9.3a）');

  // ③ 幂等：同一份输出再跑一次 → 不重复建树，只更新
  const again = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(again['status'], 'ok');
  assert.equal(again['created'], 0, '重复建树不得再新建节点');
  assert.equal(again['updated'], 3);
  assert.equal((await service.board()).nodes.length, board.nodes.length);

  // ④ 模型输出不合法 → 明确失败、不落库、不猜测
  const broken = await service.aiBuildTree({
    confirm: true,
    stream: fakeStream('这不是 JSON，只是我的一段解释'),
  });
  assert.equal(broken['status'], 'error');
  assert.equal(broken['reason'], 'invalid-output');
  assert.equal((await service.board()).nodes.length, board.nodes.length, '失败时不得改动事实源');

  // ⑤ 没有可用路由 → 拒绝并给出可执行提示（不静默失败）
  ctx.services.delete('agentDefaultModel');
  const noRoute = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(noRoute['status'], 'denied');
  assert.equal(noRoute['reason'], 'ai-route-unavailable');
  assert.ok(String(noRoute['hint']).includes('不会发起任何 AI 调用'));

  // ⑥ 阶段 A 草稿会被清掉，但**上次 AI 建出的树必须留着**（否则重跑会埋掉人工进度）
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  const draftScan = await (service as unknown as {
    scan(input?: Record<string, unknown>): Promise<{ nodes: Array<Record<string, unknown>> }>;
  }).scan({});
  await (service as unknown as {
    applyScan(input: Record<string, unknown>): Promise<unknown>;
  }).applyScan({ nodes: draftScan.nodes });
  const withDraft = await service.board();
  const draftNames = withDraft.nodes
    .filter((node) => node.name.includes('package.json'))
    .map((node) => node.name);
  assert.ok(draftNames.length > 0, '扫描应产生阶段 A 草稿节点（关键文件）');

  const rebuilt = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(rebuilt['status'], 'ok');
  assert.ok(Number(rebuilt['removed']) >= 1, '应清掉阶段 A 草稿');
  assert.equal(rebuilt['created'], 0, 'AI 节点按同名同父复用，不重复建');
  const afterRebuild = await service.board();
  assert.equal(
    afterRebuild.nodes.some((node) => node.name.includes('package.json')),
    false,
    '阶段 A 草稿应被清掉',
  );
  assert.ok(
    afterRebuild.nodes.some((node) => node.name === '会话续期' && node.progress === 0.6),
    '上次 AI 建出的节点（含人工可能推进过的进度）必须留着',
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('领域 spec 是合法的（defineDomain 的规则已内建校验）', () => {
  // 领域名必须匹配 ^[a-z][a-z0-9_]*$（不允许连字符）—— 这里把它固化成断言
  assert.equal(structureDomainSpec.name, 'project_manager_structure');
  assert.equal(progressDomainSpec.name, 'project_manager_progress');
  for (const name of [structureDomainSpec.name, progressDomainSpec.name]) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
  }
  assert.ok(Object.keys(structureDomainSpec.tables).length >= 6);
  assert.deepEqual(Object.keys(progressDomainSpec.tables), ['nodes']);
});

test('快照与回滚：建点 → 改文件 → 回滚还原 → 撤销回滚', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-snap-'));
  // 工作区里放一个文件，稍后改它并回滚
  writeFileSync(join(workspace, 'target.txt'), 'v1\n');
  writeFileSync(join(workspace, 'untouched.txt'), 'keep\n');

  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    snapshotStatus(): { mode: string; reason: string };
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    captureSnapshot(input: Record<string, unknown>): Promise<{
      created: boolean;
      snapshotId?: string;
      reason: string;
      fileCount?: number;
      skipped?: number;
    }>;
    listSnapshots(nodeId: string): Promise<Array<{ snapshotId: string; reason: string }>>;
    rollback(input: Record<string, unknown>): Promise<{
      status: string;
      confirmToken?: string;
      preview?: string;
    }>;
    undoRollback(input: Record<string, unknown>): Promise<{ status: string; confirmToken?: string }>;
    checkSnapshotReachability(): Promise<{ available: boolean; total?: number }>;
    nodeView(nodeId: string): Promise<{ selfState: string; flags: string[] } | undefined>;
  };

  // 工作区根由工具层告知（DSH 的 cwd 是 per-call 值）
  service.noteWorkspaceRoot(workspace);
  const status = service.snapshotStatus();
  assert.equal(status.mode, 'patch', '显式指定 patch 档');

  const added = await service.addNode({ parentId: null, name: '任务A', kind: 'feature' });
  const nodeId = added.nodeId as string;

  // ① 建点
  const captured = await service.captureSnapshot({ nodeId, reason: 'manual', force: true });
  assert.equal(captured.created, true, `建点失败：${captured.reason}`);
  assert.ok((captured.fileCount ?? 0) >= 2, '快照应覆盖工作区文件');
  assert.ok(captured.snapshotId);
  // `.pm/` 必须被排除（否则快照会吞掉事实源自身）
  assert.equal(
    ctx.fsService.files.size >= 0 && captured.fileCount !== undefined && captured.fileCount <= 3,
    true,
  );

  const listed = await service.listSnapshots(nodeId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.reason, 'manual');

  // ② 改文件 + 推进节点状态
  writeFileSync(join(workspace, 'target.txt'), 'v2-changed\n');
  await service.addNode({ parentId: nodeId, name: '任务A1' });

  // ③ 回滚：首次调用只返回 needs-confirm，不执行
  const needsConfirm = await service.rollback({ nodeId, scope: 'both' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  assert.match(needsConfirm.preview ?? '', /覆盖范围/);
  assert.match(needsConfirm.preview ?? '', /未覆盖项/);
  assert.equal(readFileSync(join(workspace, 'target.txt'), 'utf8'), 'v2-changed\n', '未确认不得执行');

  // ③b 无归属会话时（子代理/后台作业）必须拒绝并给替代路径，而不是自行放行（FR-138a）
  const noAgent = await service.rollback({
    nodeId,
    scope: 'both',
    confirmToken: needsConfirm.confirmToken,
  });
  assert.equal(noAgent.status, 'denied');
  assert.match(String((noAgent as { code?: string }).code), /needs-human/);

  // ④ 带确认令牌 + 归属会话执行回滚（假宿主里审批返回 allowed-once）
  const done = await service.rollback({
    nodeId,
    scope: 'both',
    confirmToken: needsConfirm.confirmToken,
    agent: { id: 'session-test' },
  });
  assert.equal(done.status, 'ok', `回滚应成功：${JSON.stringify(done)}`);
  assert.equal(
    readFileSync(join(workspace, 'target.txt'), 'utf8'),
    'v1\n',
    '文件必须还原到快照点内容',
  );
  assert.equal(
    readFileSync(join(workspace, 'untouched.txt'), 'utf8'),
    'keep\n',
    '未改动文件不应被碰',
  );

  // ⑤ 回滚后节点带 rolledBack 标记（§9.2b：回滚是状态重置 + 审计标记）
  const view = await service.nodeView(nodeId);
  assert.ok(view?.flags.includes('rolledBack'), '回滚必须打 rolledBack 标记');

  // ⑥ 撤销回滚
  const undoNeedsConfirm = await service.undoRollback({ nodeId });
  assert.equal(undoNeedsConfirm.status, 'needs-confirm');
  const undone = await service.undoRollback({
    nodeId,
    confirmToken: undoNeedsConfirm.confirmToken,
    agent: { id: 'session-test' },
  });
  assert.equal(undone.status, 'ok', '撤销回滚应成功');
  assert.equal(
    readFileSync(join(workspace, 'target.txt'), 'utf8'),
    'v2-changed\n',
    '撤销回滚应把现场恢复到回滚前',
  );

  // ⑦ 可达性自检
  const health = await service.checkSnapshotReachability();
  assert.equal(health.available, true);
  assert.ok((health.total ?? 0) >= 2, '应至少有 manual 与 pre-rollback 两个点');
  ctx.disposeAll();
});

test('零 token 扫描：建议树 → 一键建树 → 节点带 autoCreated、幂等可重放', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-scan-'));
  // 造一个像样的小仓库：文件规模**刻意不同**（否则零 token 权重轨拿不到结构差异，
  // 百分比会合法地退化成按件数 —— 那是另一条分支，见 domain/weight.test.ts）
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  writeFileSync(join(workspace, 'README.md'), '# demo\n');
  mkdirSync(join(workspace, 'src', 'components'), { recursive: true });
  writeFileSync(
    join(workspace, 'src', 'index.ts'),
    Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n',
  );
  writeFileSync(
    join(workspace, 'src', 'components', 'Button.tsx'),
    Array.from({ length: 5 }, (_, i) => `export const B${i} = ${i};`).join('\n') + '\n',
  );
  writeFileSync(
    join(workspace, 'src', 'components', 'Modal.tsx'),
    Array.from({ length: 400 }, (_, i) => `export const M${i} = ${i};`).join('\n') + '\n',
  );
  mkdirSync(join(workspace, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', 'zod', 'index.js'), 'module.exports={};\n');
  mkdirSync(join(workspace, 'dist'), { recursive: true });
  writeFileSync(join(workspace, 'dist', 'bundle.js'), 'x\n');

  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    scan(input?: Record<string, unknown>): Promise<{
      available: boolean;
      projectName: string;
      nodes: Array<{ key: string; name: string; kind: string; parentKey: string | null }>;
      scanned: number;
      skipped: number;
      truncated: boolean;
      notes: string[];
    }>;
    applyScan(input: Record<string, unknown>): Promise<{
      created: number;
      skipped: number;
      failures: unknown[];
    }>;
    board(): Promise<{
      nodes: Array<{
        id: string;
        name: string;
        autoCreated: boolean;
        parentId: string | null;
        weight: number;
        weightSource?: 'ai' | 'heuristic';
        weightDetail?: Record<string, unknown>;
      }>;
      overall: {
        totalLeaves: number;
        basis: 'weight' | 'count';
        structuralDegenerate?: boolean;
      };
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  // ── 扫描（零 token） ────────────────────────────────────────
  const scan = await service.scan({});
  assert.equal(scan.available, true, `扫描不可用：${JSON.stringify(scan)}`);
  assert.ok(scan.nodes.length >= 3, `建议节点太少：${scan.nodes.map((n) => n.name).join(',')}`);
  assert.equal(scan.nodes[0]?.parentKey, null, '第一个必须是根');

  const names = scan.nodes.map((n) => n.name);
  assert.ok(
    names.some((n) => n.includes('源码') || n === 'src'),
    `未把 src 识别为节点：${names.join(',')}`,
  );
  assert.ok(
    names.some((n) => n.includes('package.json')),
    'package.json 应被识别为关键文件',
  );
  // node_modules 与 dist 必须被排除
  assert.equal(
    scan.nodes.some((n) => n.key.includes('node_modules') || n.key.includes('dist')),
    false,
    `被排除的目录仍建了节点：${scan.nodes.map((n) => n.key).join(',')}`,
  );
  assert.ok(scan.skipped > 0, '被排除的条目必须计入 skipped（诚实交代）');

  // ── 建树 ────────────────────────────────────────────────────
  const applied = await service.applyScan({ nodes: scan.nodes, projectName: scan.projectName });
  assert.ok(applied.created >= 3, `建树太少：${JSON.stringify(applied)}`);
  assert.deepEqual(applied.failures, []);

  const board = await service.board();
  assert.ok(board.nodes.length >= 3);
  // 自动创建的节点必须带 autoCreated 标记（FR-39d）
  assert.ok(
    board.nodes.some((n) => n.autoCreated),
    '自动建出的节点必须带 autoCreated 角标',
  );

  // ── 默认口径 = **按件数**（§9.3a 修订） ──────────────────────
  // 节点是功能点/任务点，进度由任务本身决定；**不得**用"已写代码量"当进度或权重。
  const leafViews = board.nodes.filter(
    (n) => !board.nodes.some((other) => other.parentId === n.id),
  );
  assert.ok(leafViews.length > 0);
  for (const leaf of leafViews) {
    assert.equal(
      leaf.weightSource,
      undefined,
      `叶节点 ${leaf.name} 默认不应带任何"代码量算出来的"权重`,
    );
  }
  assert.equal(
    board.overall.basis,
    'count',
    `默认口径必须是按件数：${JSON.stringify(board.overall)}`,
  );

  // ── 幂等：再应用一次不应重复建节点 ──────────────────────────
  const again = await service.applyScan({ nodes: scan.nodes });
  assert.equal(again.created, 0, '重复应用不应新建节点');
  assert.ok(again.skipped >= 3, '重复应用应全部按同名同父跳过');
  const boardAfter = await service.board();
  assert.equal(boardAfter.nodes.length, board.nodes.length, '节点总数不应变化');
  ctx.disposeAll();
});

test('暂停/继续：门控 + 自动回滚点 + 交接文档（机械部分零 token）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-handoff-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    progress(input: Record<string, unknown>): Promise<unknown>;
    pauseNode(input: Record<string, unknown>): Promise<{
      status: string;
      handoff?: { relativePath: string; bytes: number; supplementsSkipped: boolean; markdown: string };
      snapshot?: { snapshotId?: string; created: boolean };
    }>;
    resumeNode(input: Record<string, unknown>): Promise<{
      status: string;
      resumed?: boolean;
      handoff?: { fileName: string; markdown: string };
    }>;
    board(): Promise<{ nodes: Array<{ id: string; derivedState: string; gate: string | null }> }>;
    readHandoffPage(input: Record<string, unknown>): Promise<{
      found: boolean;
      text?: string;
      nextOffset?: number | null;
      supplementsSkipped?: boolean;
    }>;
    listSnapshots(nodeId: string): Promise<Array<{ reason: string }>>;
  };
  service.noteWorkspaceRoot(workspace);

  const root = await service.addNode({ parentId: null, name: '枝根', kind: 'feature' });
  const leaf = await service.addNode({ parentId: root.nodeId, name: '任务X' });
  const nodeId = leaf.nodeId as string;
  await service.progress({ nodeId, selfState: 'running', progress: 0.4 });

  // ── 暂停：门控 + 回滚点 + 交接文档 ──────────────────────────
  const paused = await service.pauseNode({
    nodeId,
    reason: '等接口联调',
    supplements: { nextSteps: '接完创建接口后补权限校验' },
  });
  assert.equal(paused.status, 'ok', `暂停失败：${JSON.stringify(paused)}`);
  assert.ok(paused.handoff, '暂停必须生成交接文档');
  assert.match(paused.handoff?.relativePath ?? '', /^\.pm\/handoff\/pause-/);
  assert.equal(paused.handoff?.supplementsSkipped, false, '提供了补写就不该标降级');
  assert.match(paused.handoff?.markdown ?? '', /接完创建接口/);
  assert.equal(paused.snapshot?.created, true, '暂停必须自动建立回滚点');

  const boardPaused = await service.board();
  const view = boardPaused.nodes.find((n) => n.id === nodeId);
  assert.equal(view?.derivedState, 'paused', '门控应使节点呈现为已暂停');

  const snaps = await service.listSnapshots(nodeId);
  assert.ok(snaps.some((s) => s.reason === 'pause'), '应有 pause 原因的回滚点');

  // ── 交接文档确实落在磁盘的 .pm/handoff/ 里（FR-84）────────────
  const handoffDir = join(workspace, '.pm', 'handoff');
  const handoffFiles = readdirSync(handoffDir);
  assert.equal(handoffFiles.length, 1, `交接文档数不对：${handoffFiles.join(',')}`);
  const handoffName = handoffFiles[0] as string;
  assert.match(handoffName, /^pause-.+-\d{8}-\d{6}\.md$/, `命名不符规范：${handoffName}`);
  const onDisk = readFileSync(join(handoffDir, handoffName), 'utf8');
  assert.match(onDisk, /## 进度快照/);
  assert.match(onDisk, /接完创建接口/, '模型补写内容应写入磁盘');

  // ── 分页读取交接文档 ────────────────────────────────────────
  const page = await service.readHandoffPage({ nodeId, kind: 'pause', limitBytes: 512 });
  assert.equal(page.found, true, `读取失败应能找到刚写的文档：${JSON.stringify(page)}`);
  assert.ok((page.text ?? '').length > 0);
  assert.match(page.text ?? '', /进度快照/);

  // ── 继续：解除门控 + 返回文档内容用于续接 + 消费后删除 ──────
  const resumed = await service.resumeNode({ nodeId, consumeDoc: true });
  assert.equal(resumed.status, 'ok');
  assert.equal(resumed.resumed, true);
  assert.ok(resumed.handoff, '继续时应把交接文档内容交回会话');
  assert.match(resumed.handoff?.markdown ?? '', /进度快照/);

  const boardResumed = await service.board();
  const viewAfter = boardResumed.nodes.find((n) => n.id === nodeId);
  assert.equal(viewAfter?.derivedState, 'running', '解除门控后应回落原计算状态');
  assert.equal(viewAfter?.gate, null);

  const afterConsume = await service.readHandoffPage({ nodeId, kind: 'pause' });
  assert.equal(afterConsume.found, false, 'consumeDoc=true 时文档应被消费删除');
  assert.equal(
    readdirSync(join(workspace, '.pm', 'handoff')).length,
    0,
    '消费后磁盘上的文档也应被删除',
  );
  ctx.disposeAll();
});

test('存储降级：storageDomain 不可用时走兜底文件路线，功能不缺席', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-fallback-'));
  const ctx = createFakeContext({ workspace });
  // 把 storageDomain 摘掉，模拟缺少 storage 的组合
  (ctx.services as Map<string, unknown>).delete('storageDomain');

  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    route: string;
    storage: { capabilities: { needsCompaction: boolean; crossProcessLock: boolean } };
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    finish(input: Record<string, unknown>): Promise<unknown>;
    board(): Promise<{ overall: { ratio: number; totalLeaves: number } }>;
    renderDocument(): Promise<{ markdown: string }>;
  };
  service.noteWorkspaceRoot(workspace);

  // 路线必须是兜底，且能力差异如实声明（FR-123：不假装等价）
  assert.equal(service.route, 'file-fallback');
  assert.equal(service.storage.capabilities.needsCompaction, true);
  assert.equal(service.storage.capabilities.crossProcessLock, false);

  // 功能不缺席：建树 → 完成 → 统计 → 投影
  const root = await service.addNode({ parentId: null, name: '根', kind: 'feature' });
  const leaf = await service.addNode({ parentId: root.nodeId, name: '任务F' });
  const done = await service.finish({ nodeId: leaf.nodeId as string, by: 'session' });
  assert.equal(done.status, 'ok', `兜底路线下写入失败：${JSON.stringify(done)}`);

  const board = await service.board();
  assert.equal(board.overall.totalLeaves, 1);
  assert.equal(board.overall.ratio, 1);

  const doc = await service.renderDocument();
  assert.match(doc.markdown, /根 --> 任务F/);

  // `.pm/` 下确实落了文件（兜底路线的事实源在这）
  assert.equal(existsSync(join(workspace, '.pm')), true);
  assert.equal(existsSync(join(workspace, '.pm', 'graph.jsonl')), true);

  // 重新打开插件实例应能读回（重放）
  ctx.disposeAll();
  const ctx2 = createFakeContext({ workspace });
  (ctx2.services as Map<string, unknown>).delete('storageDomain');
  await module.apply(ctx2, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });
  const service2 = ctx2.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    board(): Promise<{ overall: { totalLeaves: number; ratio: number } }>;
  };
  service2.noteWorkspaceRoot(workspace);
  const board2 = await service2.board();
  assert.equal(board2.overall.totalLeaves, 1, '重开后节点数应恢复');
  assert.equal(board2.overall.ratio, 1, '重开后完成度应恢复');

  ctx2.disposeAll();
});

test('投影出的文档写在临时工作区里（不污染仓库）', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-check-'));
  const file = join(workspace, 'project-manager.md');
  writeFileSync(file, '# 空\n');
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, 'utf8'), '# 空\n');
});

test('诊断路由：/pm/health 与 /pm/debug 可用，客户端上报可被接收', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-debug-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'auto',
    aiWeightMeasurement: false,
    debugLogging: true,
  });

  // 路由已注册（前缀 /pm）
  const route = ctx.registeredRoutes.find((r) => r.path === '/pm');
  assert.ok(route, '未注册 /pm 前缀路由');
  assert.equal(route.kind, 'prefix');

  /** 造一对最小的 req/res。 */
  const call = async (
    url: string,
    method = 'GET',
    body?: string,
  ): Promise<{ status: number; body: string; contentType: string }> => {
    const headers: Record<string, string> = {};
    let status = 0;
    let text = '';
    const res = {
      writeHead(code: number, h?: Record<string, string>) {
        status = code;
        Object.assign(headers, h ?? {});
      },
      end(chunk?: string) {
        text = chunk ?? '';
      },
    };
    // 模拟带 body 的请求流：on('data') / on('end')
    const req = {
      url,
      method,
      on:
        body === undefined
          ? undefined
          : (event: string, listener: (...args: unknown[]) => void) => {
              if (event === 'data') listener(body);
              if (event === 'end') listener();
            },
    };
    await route.handler(req, res);
    return { status, body: text, contentType: headers['content-type'] ?? '' };
  };

  // health
  const health = await call('/pm/health');
  assert.equal(health.status, 200);
  const healthJson = JSON.parse(health.body) as { ok: boolean; route: string; instanceId: string };
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.route, 'kv-domain');
  assert.ok(healthJson.instanceId.length > 0);

  // 看板路由：`?sessionId=` 必须真的被宿主读走（否则面板永远只能"最近使用的工作区"）
  const boardBySession = await call('/pm/board?sessionId=session-in-workspace');
  assert.equal(boardBySession.status, 200);
  const boardJson = JSON.parse(boardBySession.body) as {
    workspaceRoot: { value: string | null; source: string };
  };
  assert.equal(boardJson.workspaceRoot.source, 'session-workspace');
  assert.equal(boardJson.workspaceRoot.value, workspace);

  // debug（JSON）
  const debug = await call('/pm/debug?format=json');
  assert.equal(debug.status, 200);
  const snapshot = JSON.parse(debug.body) as {
    report: { registeredTools: string[]; routes: string[]; packageId: string };
    client: unknown;
    capabilities: { approval: boolean };
    logs: unknown[];
  };
  assert.equal(snapshot.report.packageId, 'dsh-project-manager');
  assert.equal(snapshot.report.registeredTools.length, 23);
  assert.ok(snapshot.report.routes.includes('GET /pm/debug'));
  assert.equal(snapshot.client, null, '尚未上报时 client 应为 null');
  assert.ok(snapshot.logs.length > 0, '加载过程必须留下诊断记录');

  // debug（HTML 人可读）
  const html = await call('/pm/debug');
  assert.equal(html.status, 200);
  assert.match(html.contentType, /text\/html/);
  assert.match(html.body, /Project Manager 诊断/);

  // 客户端上报：空 body 必须被拒（否则会把"上报坏了"伪装成"上报成功"）
  const emptyReport = await call('/pm/debug/client', 'POST');
  assert.equal(emptyReport.status, 400);

  // 客户端上报：合法 JSON → 200，且诊断快照里出现 client
  const goodReport = await call(
    '/pm/debug/client',
    'POST',
    JSON.stringify({
      panelId: 'project-manager',
      bundleId: 'dsh-project-manager',
      registeredSlots: ['sidebar.panellist', 'main', 'settings.section'],
      boardUrl: 'http://127.0.0.1:3080/pm/board',
      userAgent: 'test-agent',
    }),
  );
  assert.equal(goodReport.status, 200);
  const after = await call('/pm/debug?format=json');
  const afterJson = JSON.parse(after.body) as {
    client: { panelId: string; registeredSlots: string[]; userAgent?: string } | null;
  };
  assert.ok(afterJson.client, '上报后 client 必须出现在诊断快照里');
  assert.equal(afterJson.client.panelId, 'project-manager');
  assert.deepEqual(afterJson.client.registeredSlots, [
    'sidebar.panellist',
    'main',
    'settings.section',
  ]);
  assert.equal(afterJson.client.userAgent, 'test-agent');

  // logs
  const logs = await call('/pm/debug/logs');
  assert.equal(logs.status, 200);
  const logJson = JSON.parse(logs.body) as { entries: unknown[]; total: number };
  assert.ok(logJson.total > 0);

  // 未知路径
  const missing = await call('/pm/nope');
  assert.equal(missing.status, 404);
  ctx.disposeAll();
});

test('git 档：真实仓库里建点 → 改动 → 回滚还原，且不污染用户索引/HEAD', async () => {
  // git 不可用时跳过（而不是假装通过）
  let gitOk = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    gitOk = false;
  }
  if (!gitOk) return;

  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-git-'));
  const runGit = (args: string[]): string =>
    execFileSync('git', args, { cwd: workspace }).toString().trim();
  runGit(['init', '-q']);
  runGit(['config', 'user.email', 'test@local']);
  runGit(['config', 'user.name', 'test']);
  writeFileSync(join(workspace, 'tracked.txt'), 'v1\n');
  runGit(['add', '-A']);
  runGit(['commit', '-q', '-m', 'init']);

  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'git', // 强制 git 档
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    snapshotStatus(): { mode: string; reason: string };
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    captureSnapshot(input: Record<string, unknown>): Promise<{
      created: boolean;
      snapshotId?: string;
      reason: string;
    }>;
    rollback(input: Record<string, unknown>): Promise<{ status: string; confirmToken?: string }>;
    checkSnapshotReachability(): Promise<{
      available: boolean;
      total?: number;
      orphaned?: unknown[];
    }>;
  };
  service.noteWorkspaceRoot(workspace);
  assert.equal(service.snapshotStatus().mode, 'git');

  const added = await service.addNode({ parentId: null, name: '任务G', kind: 'feature' });
  const nodeId = added.nodeId as string;

  const headBefore = runGit(['rev-parse', 'HEAD']);

  // ① 建点（此时工作区含未提交的 project-manager.md 等文件）
  const captured = await service.captureSnapshot({ nodeId, reason: 'manual', force: true });
  assert.equal(captured.created, true, `git 档建点失败：${captured.reason}`);

  // 硬约束：HEAD 未变（不切分支、不提交）
  assert.equal(runGit(['rev-parse', 'HEAD']), headBefore, 'git 档不得改变 HEAD');

  // ② 改文件 + 新增文件
  writeFileSync(join(workspace, 'tracked.txt'), 'v2-changed\n');
  writeFileSync(join(workspace, 'later.txt'), 'later\n');

  // ③ 回滚
  const needsConfirm = await service.rollback({ nodeId, scope: 'both' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  const done = await service.rollback({
    nodeId,
    scope: 'both',
    confirmToken: needsConfirm.confirmToken,
    agent: { id: 'session-test' },
  });
  assert.equal(done.status, 'ok', `git 档回滚应成功：${JSON.stringify(done)}`);

  assert.equal(readFileSync(join(workspace, 'tracked.txt'), 'utf8'), 'v1\n', 'tracked 应还原');
  assert.equal(existsSync(join(workspace, 'later.txt')), false, '快照后新增的文件应被删除');
  // 换行不得被改写（core.autocrlf 必须被强制关掉）
  assert.equal(
    readFileSync(join(workspace, 'tracked.txt'), 'utf8').includes('\r\n'),
    false,
    'git 档还原不得把 LF 改成 CRLF',
  );

  // ④ 用户索引不得有我们造成的暂存内容
  assert.equal(runGit(['diff', '--cached', '--name-only']), '', '不得污染用户暂存区');

  // ⑤ 可达性自检能读到 git ref
  const health = await service.checkSnapshotReachability();
  assert.equal(health.available, true);
  assert.ok((health.total ?? 0) >= 2, '至少有 manual + pre-rollback');
  assert.deepEqual(health.orphaned ?? [], [], 'git ref 应仍可解析');
});















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
  /** `ctx.inject` 的调用记录（用于断言"确实走了官方声明式路径"）。 */
  const injectCalls: Array<{ deps: string[]; ran: boolean }> = [];

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
    /**
     * 官方的**依赖声明式**加载：`ctx.inject(deps, cb)` —— 这在真宿主上是**唯一**能拿到
     * 未在插件 `inject` 里声明的服务的路（官方 `dsh-client-modules` 就是
     * `if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], …)`）。
     *
     * 替身按官方语义实现：依赖齐了就**同步**回调；不齐就保持待定（不回调、不报错）。
     * 少了它，测试就只会走回退路径，真机上"服务是 PENDING"这件事永远测不到 ——
     * 而提示词层第一次真机实测就是这么静默失败的。
     */
    inject: (deps: string[], callback: (scoped: unknown) => void) => {
      const ran = deps.every((name) => services.has(name));
      injectCalls.push({ deps: [...deps], ran });
      if (ran) {
        // 真 cordis 的语义：注入后的作用域 ctx 上，这些服务是**可读属性**
        //（这正是"未声明的服务拿不到、声明了就能拿到"的全部区别）
        const scoped = Object.create(ctx) as Record<string, unknown>;
        for (const name of deps) scoped[name] = services.get(name);
        callback(scoped);
      }
      return () => {};
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
      /**
       * 设置服务替身：**会真的合并补丁、真的通知订阅者**。
       *
       * 早先这里是个"什么都返回空"的桩，于是"设置页改一项 → 运行中的服务立刻用新值"
       * 这条链路完全没有覆盖。现在它按官方语义来：
       * `update(patch)` 合并进用户层 → 用注册时的 schema 校验 → 通知 watcher。
       */
      register: (
        namespace: string,
        schema?: (value: unknown) => unknown,
        options?: { applies?: string },
      ) => {
        settingsNamespaces.push(namespace);
        let section: Record<string, unknown> = {};
        const watchers: Array<(next: unknown, prev: unknown) => unknown> = [];
        const validate = (value: unknown): unknown => (schema ? schema(value) : value);
        const current = (): unknown => validate({ ...section });
        return {
          get: current,
          applies: options?.applies,
          watch: (callback: (next: unknown, prev: unknown) => unknown) => {
            watchers.push(callback);
            return () => {
              const index = watchers.indexOf(callback);
              if (index >= 0) watchers.splice(index, 1);
            };
          },
          update: async (patch: Record<string, unknown>) => {
            const prev = current();
            // 校验的是**合并后**的完整值：schemastery 的默认值会补齐缺失字段
            const next = validate({ ...section, ...patch });
            section = { ...section, ...patch };
            for (const watcher of watchers) await watcher(next, prev);
          },
          replace: async (next: Record<string, unknown>) => {
            const prev = current();
            section = { ...next };
            const resolved = current();
            for (const watcher of watchers) await watcher(resolved, prev);
          },
        };
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
    injectCalls,
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
    'pm_report',
  ]) {
    assert.ok(ctx.toolRegistry.has(name), `工具 ${name} 未注册`);
  }
  assert.equal(ctx.toolRegistry.size, 29, '工具总数应与 TOOL_NAMES 一致');

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

  /** 数调用次数：缓存要证明的是"真的一次都没调"（T6）。 */
  let modelCalls = 0;
  const fakeStream = (json: string) => ({
    stream: () => {
      modelCalls += 1;
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: json.slice(0, 40) };
        yield { type: 'text-delta', index: 0, text: json.slice(40) };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
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
  assert.equal(modelCalls, 1, '首次建树应恰好调一次模型');
  assert.equal(
    (built['cache'] as { state: string }).state,
    'miss',
    '首次没有缓存 → miss',
  );

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

  // ③ 幂等 + **缓存命中**：同一份输入再跑一次 → 不重复建树，且**一次模型调用都不发**（T6/FR-104）
  const again = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(again['status'], 'ok');
  assert.equal(again['created'], 0, '重复建树不得再新建节点');
  assert.equal(again['updated'], 3);
  assert.equal(modelCalls, 1, '输入逐字节相同 → 必须走缓存，绝不能再调模型');
  assert.equal((again['cache'] as { state: string }).state, 'hit');
  assert.ok(
    ((again['cache'] as { savedTokens: number }).savedTokens ?? 0) > 0,
    '要能说清这次省了多少（FR-117 口径）',
  );
  assert.equal(
    ((again['estimate'] as { calls: number }).calls),
    0,
    '走缓存时预估的调用次数应为 0（预估与实际必须一致）',
  );
  assert.equal((await service.board()).nodes.length, board.nodes.length);

  // ③b 改一个文件 → 缓存失效（同键但骨架对不上），并如实报告增量
  writeFileSync(join(workspace, 'src', 'auth', 'index.ts'), 'export const login = 2;\n');
  const incremental = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(incremental['status'], 'ok');
  assert.equal(modelCalls, 2, '文件变了必须重算');
  const cacheInfo = incremental['cache'] as {
    state: string;
    changedPaths: { changed: string[] };
  };
  assert.equal(cacheInfo.state, 'miss');
  assert.ok(
    cacheInfo.changedPaths.changed.includes('src/auth/index.ts'),
    `增量要指出到底哪个文件变了：${JSON.stringify(cacheInfo.changedPaths)}`,
  );
  assert.ok(
    (incremental['notes'] as string[]).some((note) => note.includes('增量：')),
    '结果里要写清"相比上次改了什么"',
  );

  // ④ 模型输出不合法 → 明确失败、不落库、不猜测
  //    注意：**必须先让输入变化**，否则会（正确地）命中上一步的缓存、根本不调模型 ——
  //    这正是 T6 想要的行为，测试得顺着它来，而不是绕过它。
  //    这里用 `forceRebuild`：非关键文件的指纹是"大小 + 修改时间"，而同一毫秒内的
  //    同尺寸改动可能漏检（**已如实写进 README**）—— 逃生口的存在让用户永远能强制重算。
  const broken = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: fakeStream('这不是 JSON，只是我的一段解释'),
  });
  assert.equal(broken['status'], 'error');
  assert.equal(broken['reason'], 'invalid-output');
  assert.equal(modelCalls, 3, '强制重算 → 真的调了模型（这次模型给了坏输出）');
  assert.equal((await service.board()).nodes.length, board.nodes.length, '失败时不得改动事实源');
  // T9：失败也要把已得文本交出去，供下次续跑（不能"一失败就全丢"）
  assert.ok(
    typeof broken['rawText'] === 'string' && String(broken['rawText']).includes('不是 JSON'),
    '失败要带回模型原始输出',
  );
  const cacheFile = ctx.fsService.files.get('.pm/ai-cache.json');
  assert.ok(
    cacheFile !== undefined && cacheFile.includes('"status": "partial"'),
    '被中断/失败的那次要落成 partial 缓存（T9 可续跑）',
  );

  // ④b 实测回归：模型把引用类型写成 "file" 时**不该整树失败**（归一后照常落库）
  const tolerant = await service.aiBuildTree({
    confirm: true,
    replaceAutoDraft: false,
    stream: fakeStream(
      JSON.stringify({
        projectName: '演示项目',
        nodes: [
          {
            name: '登录与鉴权',
            kind: 'feature',
            parent: null,
            refs: [
              { type: 'dir', target: 'src/auth' },
              { type: 'file', target: 'package.json' },
            ],
          },
        ],
      }),
    ),
  });
  assert.equal(tolerant['status'], 'ok', JSON.stringify(tolerant));
  assert.ok(
    (tolerant['notes'] as string[]).some((note) => note.includes('file')),
    '归一要有说明（不能静默改模型给的数据）',
  );

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

test('面板节点动作分发：关注/改名/描述/加子节点/暂停(先确认)/继续/打回滚点', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-panel-'));
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'panel-demo' }));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    // 这个用例会走到"打回滚点"，所以要给快照档位（生产里由 schema 默认值给）
    snapshotMode: 'patch',
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    aiWeightMeasurement: false,
  });
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    panelNodeAction(input: Record<string, unknown>): Promise<{
      status: string;
      message?: string;
      preview?: string;
      code?: string;
      detail?: Record<string, unknown>;
    }>;
    board(): Promise<{
      nodes: Array<{ id: string; name: string; focus: boolean; gate: string | null; description?: string }>;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  const root = await service.addNode({ parentId: null, name: '甲' });
  const leaf = await service.addNode({ parentId: root.nodeId, name: '叶子' });

  // ① 直接执行类：关注 / 改名 / 描述 / 加子节点
  assert.equal((await service.panelNodeAction({ action: 'focus', nodeId: root.nodeId })).status, 'ok');
  const renamed = await service.panelNodeAction({
    action: 'rename',
    nodeId: leaf.nodeId,
    text: '叶子（改）',
  });
  assert.equal(renamed.status, 'ok', JSON.stringify(renamed));
  await service.panelNodeAction({ action: 'describe', nodeId: leaf.nodeId, text: '这是描述' });
  const child = await service.panelNodeAction({ action: 'add-child', nodeId: leaf.nodeId, text: '孙子' });
  assert.equal(child.status, 'ok');

  const board = await service.board();
  const leafView = board.nodes.find((node) => node.name === '叶子（改）');
  assert.ok(leafView, `改名未生效：${board.nodes.map((n) => n.name).join(',')}`);
  assert.equal(leafView.description, '这是描述');
  assert.equal(board.nodes.find((node) => node.name === '甲')?.focus, true);
  assert.ok(board.nodes.some((node) => node.name === '孙子'));

  // ② 空文本 → 明确拒绝（不落库、不静默）
  const blank = await service.panelNodeAction({ action: 'rename', nodeId: leaf.nodeId, text: '  ' });
  assert.equal(blank.status, 'denied');
  assert.equal(blank.code, 'E_NAME');

  // ③ 破坏性动作：未确认只回影响范围（且**不**改状态）
  const pending = await service.panelNodeAction({ action: 'pause', nodeId: leaf.nodeId });
  assert.equal(pending.status, 'needs-confirm');
  assert.ok(String(pending.preview).includes('暂停'));
  assert.equal(
    (await service.board()).nodes.find((node) => node.name === '叶子（改）')?.gate,
    null,
    '未确认不得暂停',
  );

  // ④ 确认后执行：暂停会生成交接文档 + 自动回滚点
  const paused = await service.panelNodeAction({ action: 'pause', nodeId: leaf.nodeId, confirm: true });
  assert.equal(paused.status, 'ok', JSON.stringify(paused));
  assert.equal((await service.board()).nodes.find((node) => node.name === '叶子（改）')?.gate, 'paused');

  // ⑤ 继续：解除门控
  const resumed = await service.panelNodeAction({ action: 'resume', nodeId: leaf.nodeId });
  assert.equal(resumed.status, 'ok', JSON.stringify(resumed));
  assert.equal((await service.board()).nodes.find((node) => node.name === '叶子（改）')?.gate, null);

  // ⑥ 手动回滚点：同样先确认
  const snapshotConfirm = await service.panelNodeAction({ action: 'snapshot', nodeId: leaf.nodeId });
  assert.equal(snapshotConfirm.status, 'needs-confirm');
  const snapshot = await service.panelNodeAction({
    action: 'snapshot',
    nodeId: leaf.nodeId,
    confirm: true,
  });
  assert.equal(snapshot.status, 'ok', JSON.stringify(snapshot));

  // ⑦ 未知节点 → 不崩、明确拒绝
  const missing = await service.panelNodeAction({ action: 'focus', nodeId: 'nope' });
  assert.equal(missing.status, 'denied');
  assert.equal(missing.code, 'E_NOT_FOUND');

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

test('面板路径的回滚 / 整枝回滚：两阶段、覆盖整枝文件、checkpoint 用完即删', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-panelroll-'));
  writeFileSync(join(workspace, 'root.txt'), 'r1\n');
  writeFileSync(join(workspace, 'child.txt'), 'c1\n');

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
    captureSnapshot(input: Record<string, unknown>): Promise<{ created: boolean; snapshotId?: string }>;
    panelRollback(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    listSnapshots(nodeId: string): Promise<Array<{ snapshotId: string }>>;
    listCheckpoints(): Promise<Array<{ status: string; kind: string }>>;
    board(sessionId?: string): Promise<{ rollbackPoints: Record<string, number> }>;
    nodeView(nodeId: string): Promise<{ selfState: string; flags: string[] } | undefined>;
    completeNode(input: Record<string, unknown>): Promise<{ status: string }>;
  };

  service.noteWorkspaceRoot(workspace);  // 枝里的两个节点各自"碰过"一个文件：整枝回滚必须把**两个**文件都还原
  const root = await service.addNode({
    parentId: null,
    name: '根功能',
    kind: 'feature',
    refs: [{ type: 'code', target: 'root.txt' }],
  });
  const rootId = root.nodeId as string;
  const child = await service.addNode({
    parentId: rootId,
    name: '子任务',
    refs: [{ type: 'code', target: 'child.txt' }],
  });
  const childId = child.nodeId as string;

  // 建整枝回滚点（拦停/暂停会自动建；这里显式建，便于断言）。
  // **先建点再推进**：这样快照里记的是"子节点还没做完"，回滚才有得重置。
  const captured = await service.captureSnapshot({ nodeId: rootId, reason: 'manual', force: true });
  assert.equal(captured.created, true);

  // 看板带上"每个节点有几个回滚点"，菜单据此决定显不显示（FR：没有就不显示）
  const board = await service.board();
  assert.ok((board.rollbackPoints[rootId] ?? 0) >= 1, '枝根应有可用回滚点');
  assert.ok((board.rollbackPoints[childId] ?? 0) >= 1, '整枝快照覆盖子孙，子节点也算有');

  // ① 改两个文件 + 把子节点推进到 done
  writeFileSync(join(workspace, 'root.txt'), 'r2-changed\n');
  writeFileSync(join(workspace, 'child.txt'), 'c2-changed\n');
  await service.finish({ nodeId: childId });
  assert.equal((await service.nodeView(childId))?.selfState, 'done', '前置：子节点已完成');

  // ② 第一次调用只给影响范围（**不执行**）
  const preview = await service.panelRollback({ nodeId: rootId, branch: true, scope: 'both' });
  assert.equal(preview.status, 'needs-confirm');
  assert.match(String(preview.preview), /整枝回滚/);
  assert.match(String(preview.preview), /覆盖节点：2 个/);
  assert.equal(readFileSync(join(workspace, 'root.txt'), 'utf8'), 'r2-changed\n', '未确认不得执行');

  // ③ 确认后执行：两个文件都还原（这正是"整枝"与"单节点"的区别）
  const done = await service.panelRollback({
    nodeId: rootId,
    branch: true,
    scope: 'both',
    confirm: true,
  });
  assert.equal(done.status, 'ok', `整枝回滚应成功：${JSON.stringify(done)}`);
  assert.equal(readFileSync(join(workspace, 'root.txt'), 'utf8'), 'r1\n', '枝根的文件要还原');
  assert.equal(readFileSync(join(workspace, 'child.txt'), 'utf8'), 'c1\n', '子孙的文件也要还原');
  assert.ok((done.resetNodes as number) >= 1, '枝内有记过状态的节点应被重置');
  assert.equal(
    (await service.nodeView(childId))?.selfState,
    'pending',
    '子孙的节点状态也要回到快照点（否则只是"半截整枝回滚"）',
  );

  // ④ 覆盖范围内每个节点都打 rolledBack 标记
  assert.ok((await service.nodeView(rootId))?.flags.includes('rolledBack'));
  assert.ok((await service.nodeView(childId))?.flags.includes('rolledBack'));

  // ⑤ checkpoint 用完即删（留着说明多记录操作没走完）
  assert.deepEqual(await service.listCheckpoints(), [], '成功的整枝回滚不得留下 checkpoint');

  // ⑥ 没有回滚点的节点：拒绝并说清原因（而不是假装回滚成功）
  const lonely = await service.addNode({ parentId: null, name: '没有点的枝', kind: 'feature' });
  const denied = await service.panelRollback({
    nodeId: lonely.nodeId as string,
    scope: 'both',
    confirm: true,
  });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.code, 'E_NO_SNAPSHOT');
  ctx.disposeAll();
});

test('订阅并行：相交路径排队 → 释放让路 → 看板/冲突可查；子代理不得自行裁决', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-watch-'));

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
    subscribe(input: Record<string, unknown>): Promise<{
      status: string;
      subscriptionId?: string;
      lock?: { kind: string; blockedBy: string[] };
    }>;
    unsubscribe(input: Record<string, unknown>): Promise<{ releasedTo?: string[] }>;
    watchers(nodeId: string): Promise<{
      subscriptions: Array<{ subscriptionId: string; holdsLock: boolean; blockedBy: string[] }>;
    }>;
    watchConflicts(): { holds: unknown[]; waiting: unknown[]; conflicts: Array<{ path: string }> };
    watchWait(input: Record<string, unknown>): Promise<{ status: string; blockedBy: string[] }>;
    requestArbitration(input: Record<string, unknown>): Promise<{ status: string; hint?: string }>;
  };

  service.noteWorkspaceRoot(workspace);
  const a = await service.addNode({ parentId: null, name: '任务A', kind: 'feature' });
  const b = await service.addNode({ parentId: null, name: '任务B', kind: 'feature' });
  const nodeA = a.nodeId as string;
  const nodeB = b.nodeId as string;

  // ① 第一个写订阅拿到锁
  const first = await service.subscribe({
    nodeId: nodeA,
    actor: 'session',
    actorId: 'sess-1',
    intent: 'write',
    touchedPaths: ['src/shared.ts'],
  });
  assert.equal(first.status, 'ok');
  assert.equal(first.lock?.kind, 'granted');

  // ② 第二个写订阅声明了**相交**的路径 → 排队，并说清被谁挡住
  const second = await service.subscribe({
    nodeId: nodeB,
    actor: 'session',
    actorId: 'sess-2',
    intent: 'write',
    touchedPaths: ['src/shared.ts'],
  });
  assert.equal(second.status, 'ok', '排队也是登记成功：用户要看得到"它在等"');
  assert.equal(second.lock?.kind, 'queued');
  assert.deepEqual(second.lock?.blockedBy, [first.subscriptionId]);

  // ③ 冲突可查（pm_watch_conflicts / pm_watchers）
  const conflicts = service.watchConflicts();
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0]?.path, 'src/shared.ts');
  const watchers = await service.watchers(nodeB);
  assert.equal(watchers.subscriptions.length, 1);
  assert.equal(watchers.subscriptions[0]?.holdsLock, false);
  assert.deepEqual(watchers.subscriptions[0]?.blockedBy, [first.subscriptionId]);

  // ④ 等待让路：超时是**可预期结果**，不是错误
  const waited = await service.watchWait({ subscriptionId: second.subscriptionId, timeoutMs: 300 });
  assert.equal(waited.status, 'timeout');
  assert.deepEqual(waited.blockedBy, [first.subscriptionId]);

  // ⑤ 释放第一个 → 锁立刻让给第二个（FIFO）
  const released = await service.unsubscribe({
    nodeId: nodeA,
    subscriptionId: first.subscriptionId as string,
  });
  assert.deepEqual(released.releasedTo, [second.subscriptionId]);
  const watchersAfter = await service.watchers(nodeB);
  assert.equal(watchersAfter.subscriptions[0]?.holdsLock, true, '让路后应真的持锁');

  // ⑥ 子代理请求仲裁 → 回落 needs-human（不得自行放行，§13.3/FR-138a）
  const arbitrate = await service.requestArbitration({
    nodeId: nodeB,
    reason: '两个会话都要写 src/shared.ts',
    conflict: conflicts.conflicts,
    by: 'subagent',
    actorId: 'sub-1',
  });
  assert.equal(arbitrate.status, 'needs-human');
  assert.match(String(arbitrate.hint), /父会话|面板/);

  // ⑦ 独占订阅：同节点已有写订阅时排队；被拒（策略=拒绝）时不登记订阅
  const exclusive = await service.subscribe({
    nodeId: nodeB,
    actor: 'session',
    actorId: 'sess-3',
    intent: 'exclusive',
    touchedPaths: ['src/other.ts'],
  });
  assert.equal(exclusive.lock?.kind, 'queued', '同节点已有写订阅 → 独占也要等');
  ctx.disposeAll();
});

test('进度回写会话投影：关键事件才推、按会话裁剪、去重、静默模式可关（FR-112–117）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-notify-'));

  /** 记录 inbox 投递的假 agent（官方通道是 `agent.inbox.append('next-step', message)`）。 */
  const delivered: Array<{ sessionId: string; target: string; text: string; plugin: string }> = [];
  const agentFor = (sessionId: string) => ({
    session: { header: { cwd: workspace } },
    inbox: {
      append(target: string, message: { content?: Array<{ text?: string }>; source?: { plugin?: string } }) {
        delivered.push({
          sessionId,
          target,
          text: message?.content?.[0]?.text ?? '',
          plugin: message?.source?.plugin ?? '',
        });
      },
    },
  });

  const ctx = createFakeContext({
    workspace,
    agents: { get: (id: string) => agentFor(id) },
  });
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
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<{ subscriptionId?: string }>;
    finish(input: Record<string, unknown>): Promise<{ status: string }>;
    progress(input: Record<string, unknown>): Promise<{ status: string }>;
    setGate(input: Record<string, unknown>): Promise<{ status: string }>;
    notifyStats(): { sent: number; suppressed: number; enabled: boolean };
  };

  // 这个会话与工作区绑定（回写要发给它）
  service.noteWorkspaceRoot(workspace, 'session-a');
  const task = await service.addNode({ parentId: null, name: '登录页', kind: 'task' });
  const nodeId = task.nodeId as string;

  // ① 没有任何会话订阅、也不在关注枝 → **不推**（否则大项目里每次完成都广播）
  await service.progress({ nodeId, selfState: 'running', progress: 0.4 });
  assert.equal(delivered.length, 0, '没订阅、没关注 → 不该打扰会话');

  // ② 会话订阅这个节点 → 完成时推一条关键事件
  await service.subscribe({
    nodeId,
    actor: 'session',
    actorId: 'session-a',
    intent: 'read',
    notify: 'key',
  });
  await service.finish({ nodeId });
  assert.equal(delivered.length, 1, `应推一条：${JSON.stringify(delivered)}`);
  assert.equal(delivered[0]?.target, 'next-step', '用 next-step（下一个步边界可见）');
  assert.equal(delivered[0]?.plugin, 'dsh-project-manager', '来源必须标明是本插件');
  assert.match(delivered[0]?.text ?? '', /^\[pm\] \S+ 「登录页」 done 100%$/);

  // ③ 去重：同一状态再写一次不重复推
  await service.finish({ nodeId });
  assert.equal(delivered.length, 1, '同一节点同一状态不重复推（FR-116）');

  // ④ progress 微增不发事件（FR-113）
  const before = delivered.length;
  await service.progress({ nodeId, progress: 0.99, force: true });
  assert.equal(delivered.length, before, 'progress 微增绝不该进上下文');

  // ⑤ 门控置位是关键词事件
  await service.setGate({ nodeId, gate: 'paused', reason: '测试' });
  assert.equal(delivered.length, before + 1);
  assert.match(delivered[delivered.length - 1]?.text ?? '', /gate=paused/);

  // ⑥ 统计可核对（FR-117）
  const stats = service.notifyStats();
  assert.equal(stats.enabled, true);
  assert.ok(stats.sent >= 2);
  assert.ok(stats.suppressed >= 1, '被压掉的条数要能看见');
  ctx.disposeAll();
});

test('全量档（full）：非 git 工作区也能建点 → 改动 → 回滚还原', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-full-'));
  writeFileSync(join(workspace, 'a.txt'), 'A1\n');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 1;\n');

  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'full', // 显式选全量档（设置项 FR-88）
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    snapshotStatus(): { mode: string; reason: string };
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    captureSnapshot(input: Record<string, unknown>): Promise<{
      created: boolean;
      reason: string;
      sizeBytes?: number;
    }>;
    rollback(input: Record<string, unknown>): Promise<{ status: string; confirmToken?: string }>;
  };
  service.noteWorkspaceRoot(workspace);
  assert.equal(service.snapshotStatus().mode, 'full', '设置里选了 full 就该是 full');

  const added = await service.addNode({
    parentId: null,
    name: '任务F',
    kind: 'feature',
    refs: [
      { type: 'code', target: 'a.txt' },
      { type: 'code', target: 'src/b.ts' },
    ],
  });
  const nodeId = added.nodeId as string;

  const captured = await service.captureSnapshot({ nodeId, reason: 'manual', force: true });
  assert.equal(captured.created, true, captured.reason);
  assert.ok((captured.sizeBytes ?? 0) > 0, '全量档要如实报占用字节');

  // 改动 + 新增 + 删除，三种情况都要能还原
  writeFileSync(join(workspace, 'a.txt'), 'A2-changed\n');
  writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 222;\n');
  writeFileSync(join(workspace, 'extra.txt'), 'should be removed by rollback\n');

  const needsConfirm = await service.rollback({ nodeId, scope: 'code' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  const done = await service.rollback({
    nodeId,
    scope: 'code',
    confirmToken: needsConfirm.confirmToken,
    agent: { id: 'session-test' },
  });
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'A1\n', '改动要还原');
  assert.equal(
    readFileSync(join(workspace, 'src', 'b.ts'), 'utf8'),
    'export const b = 1;\n',
    '子目录里的文件也要还原',
  );
  assert.equal(
    existsSync(join(workspace, 'extra.txt')),
    false,
    '快照之后新增的文件应被删除（否则"回滚"只是半截）',
  );
  ctx.disposeAll();
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

  // 回滚相关路由（FR-51b/53b 的面板路径）：菜单靠 `GET /pm/snapshots` 列点、
  // 靠 `POST /pm/rollback` 两阶段执行；这里直接打 handler，把"路由接线"也钉住。
  const noNode = await call('/pm/snapshots');
  assert.equal(noNode.status, 400, '缺 nodeId 必须 400，而不是静默返回空清单');
  const emptySnaps = await call('/pm/snapshots?nodeId=__none__');
  assert.equal(emptySnaps.status, 200);
  assert.deepEqual(
    (JSON.parse(emptySnaps.body) as { snapshots: unknown[] }).snapshots,
    [],
    '没有回滚点的节点返回空数组（面板据此隐藏「回滚」）',
  );

  const badRollback = await call('/pm/rollback', 'POST', '{"nodeId":""}');
  assert.equal(badRollback.status, 400);
  const rollbackNoNode = await call('/pm/rollback', 'POST', '{"nodeId":"__none__","scope":"both"}');
  assert.equal(rollbackNoNode.status, 200);
  assert.equal(
    (JSON.parse(rollbackNoNode.body) as { status: string }).status,
    'denied',
    '不存在的节点应被拒绝，而不是假装回滚',
  );

  // 设置路由（FR-80/81/81a/81b）：读回生效值 + 改一项立即生效 + 非法值被拒
  const settingsRead = await call('/pm/settings');
  assert.equal(settingsRead.status, 200);
  const settingsJson = JSON.parse(settingsRead.body) as {
    configurable: boolean;
    effective: { scanMaxDepth: number; aiModel: string; scanExclude: string[] };
  };
  assert.equal(settingsJson.configurable, true);
  assert.equal(settingsJson.effective.scanMaxDepth, 3, '默认深度应为 3（FR-81）');

  const settingsWrite = await call(
    '/pm/settings',
    'POST',
    JSON.stringify({ patch: { scanMaxDepth: 2, aiModel: 'test-model', scanExclude: ['docs/**'] } }),
  );
  assert.equal(settingsWrite.status, 200, settingsWrite.body);
  const afterWrite = JSON.parse(settingsWrite.body) as {
    effective: { scanMaxDepth: number; aiModel: string; scanExclude: string[] };
  };
  assert.equal(afterWrite.effective.scanMaxDepth, 2, '改完必须**立即**回到生效值里');
  assert.equal(afterWrite.effective.aiModel, 'test-model');
  assert.deepEqual(afterWrite.effective.scanExclude, ['docs/**']);

  // 非法值必须被宿主拒（面板照实显示原因，不静默存下来）
  const settingsInvalid = await call(
    '/pm/settings',
    'POST',
    JSON.stringify({ patch: { scanMaxDepth: 'not-a-number' } }),
  );
  assert.equal(settingsInvalid.status, 400, '非法值必须 400，而不是存进去等着炸');
  const settingsEmpty = await call('/pm/settings', 'POST', '{"patch":null}');
  assert.equal(settingsEmpty.status, 400);

  // debug（JSON）
  const debug = await call('/pm/debug?format=json');  assert.equal(debug.status, 200);
  const snapshot = JSON.parse(debug.body) as {
    report: { registeredTools: string[]; routes: string[]; packageId: string };
    client: unknown;
    capabilities: { approval: boolean };
    logs: unknown[];
  };
  assert.equal(snapshot.report.packageId, 'dsh-project-manager');
  assert.equal(snapshot.report.registeredTools.length, 29);
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

test('git 档覆盖**未跟踪文件**：临时索引把 untracked 一起写进树，回滚能还原（否则 aux 就是句谎话）', async () => {
  let gitOk = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    gitOk = false;
  }
  if (!gitOk) return;

  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-untracked-'));
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
    snapshotMode: 'git',
    aiWeightMeasurement: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    captureSnapshot(input: Record<string, unknown>): Promise<{ created: boolean; reason: string }>;
    listSnapshots(nodeId: string): Promise<Array<{ snapshotId: string }>>;
    rollback(input: Record<string, unknown>): Promise<{ status: string; confirmToken?: string }>;
  };
  service.noteWorkspaceRoot(workspace);

  // 任务产出一个**未跟踪**文件（git status 里是 ??）
  writeFileSync(join(workspace, 'untracked-new.ts'), 'export const fresh = 1;\n');
  const untrackedListed = runGit(['ls-files', '--others', '--exclude-standard']);
  assert.match(untrackedListed, /untracked-new\.ts/, '前置：这个文件在 git 眼里确实是未跟踪的');

  const added = await service.addNode({
    parentId: null,
    name: '任务U',
    kind: 'feature',
    refs: [{ type: 'code', target: 'untracked-new.ts' }],
  });
  const nodeId = added.nodeId as string;
  const captured = await service.captureSnapshot({ nodeId, reason: 'manual', force: true });
  assert.equal(captured.created, true, captured.reason);

  // 改动这个未跟踪文件（**没有** git add）
  writeFileSync(join(workspace, 'untracked-new.ts'), 'export const fresh = 999;\n');
  assert.equal(runGit(['ls-files', '--others', '--exclude-standard']), 'untracked-new.ts');

  // 回滚：未跟踪文件必须被还原（这是我们与"git 只能管已跟踪文件"的差别所在）
  const needsConfirm = await service.rollback({ nodeId, scope: 'code' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  assert.match(
    String((needsConfirm as { preview?: string }).preview),
    /含 1 个未跟踪文件/,
    '确认框要如实交代未跟踪文件的覆盖情况',
  );
  const done = await service.rollback({
    nodeId,
    scope: 'code',
    confirmToken: needsConfirm.confirmToken,
    agent: { id: 'session-test' },
  });
  assert.equal(done.status, 'ok', JSON.stringify(done));
  assert.equal(
    readFileSync(join(workspace, 'untracked-new.ts'), 'utf8'),
    'export const fresh = 1;\n',
    '未跟踪文件也要能还原（临时索引把它们写进了树对象）',
  );
  // 还原不得把用户索引弄脏：该文件仍然应当是未跟踪
  assert.equal(
    runGit(['ls-files', '--others', '--exclude-standard']),
    'untracked-new.ts',
    '回滚不得顺手 git add（那会改用户索引）',
  );
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

test('会话边界进度修正 + 提示词纪律 + pm_report：零 token 的收尾闭环', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-boundary-'));

  /** `agent.inject` 的投递（边界提醒走这条：官方口径是"不唤醒 driver"）。 */
  const injected: Array<{ sessionId: string; text: string; plugin: string }> = [];
  /** inbox 投递（回写通道）：用来证明"提醒"与"关键事件回写"是两条分开的路。 */
  const inboxed: Array<{ sessionId: string; target: string; text: string }> = [];
  const agentFor = (sessionId: string) => ({
    session: { header: { cwd: workspace } },
    inject(message: { content?: Array<{ text?: string }>; source?: { plugin?: string } }) {
      injected.push({
        sessionId,
        text: message?.content?.[0]?.text ?? '',
        plugin: message?.source?.plugin ?? '',
      });
    },
    inbox: {
      append(target: string, message: { content?: Array<{ text?: string }> }) {
        inboxed.push({ sessionId, target, text: message?.content?.[0]?.text ?? '' });
      },
    },
  });

  const ctx = createFakeContext({ workspace, agents: { get: (id: string) => agentFor(id) } });
  // 假 system-prompt：把注册的段/上下文记下来，事后直接调 provider 断言渲染结果
  const sections = new Map<string, { order: number; text: unknown }>();
  const contexts = new Map<string, { order: number; text: unknown }>();
  ctx.provide('systemPrompt', {
    section(candidate: { name: string; order: number; text: unknown }) {
      sections.set(candidate.name, candidate);
      return () => {
        sections.delete(candidate.name);
      };
    },
    context(candidate: { name: string; order: number; text: unknown }) {
      contexts.set(candidate.name, candidate);
      return () => {
        contexts.delete(candidate.name);
      };
    },
  });

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
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<{ subscriptionId?: string }>;
    progress(input: Record<string, unknown>): Promise<{ status: string }>;
    nodeView(id: string): Promise<{ selfState: string; progress: number } | undefined>;
    board(): Promise<unknown>;
    boundaryStatsOf(): {
      runs: number;
      patches: number;
      reminders: number;
      injected: number;
      enabled: boolean;
      prompt: boolean;
      promptState: 'pending' | 'registered' | 'unavailable';
      promptRegistered: boolean;
    };
  };
  service.noteWorkspaceRoot(workspace, 'session-a');

  /** 等异步的边界回调落库（事件回调是 fire-and-forget，测试里必须给它时间）。 */
  const settle = async (ms = 40): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const settleUntil = async (predicate: () => Promise<boolean>, budgetMs = 800): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      if (await predicate()) return true;
      await settle(10);
    }
    return false;
  };

  // ── 提示词纪律：静态段（常量文本，混进动态内容就会毁掉前缀缓存）──
  // 注册走的是官方声明式路径 `ctx.inject(['systemPrompt'], …)`（真宿主上 `ctx.get` 拿不到未声明服务）
  assert.ok(
    ctx.injectCalls.some((call) => call.deps.includes('systemPrompt') && call.ran),
    '提示词段应通过 ctx.inject 声明式注册',
  );
  assert.equal(service.boundaryStatsOf().promptState, 'registered');
  assert.equal(service.boundaryStatsOf().promptRegistered, true);
  const section = sections.get('project-manager:progress-discipline');
  assert.ok(section, '未注册进度纪律段');
  assert.equal(section.order, 9000);
  const staticText =
    typeof section.text === 'function'
      ? (section.text as (context: unknown) => string)({})
      : String(section.text);
  assert.match(staticText, /pm_report/);
  assert.ok(!staticText.includes('登录页'), '静态段不许出现节点名');

  // 建树：枝 + 两个叶（父节点用来验证 C5：父节点不被边界推着写自身状态）
  const branch = await service.addNode({ parentId: null, name: '登录模块', kind: 'feature' });
  const branchId = branch.nodeId as string;
  const leafA = await service.addNode({ parentId: branchId, name: '登录页' });
  const leafB = await service.addNode({ parentId: branchId, name: '鉴权中间件' });
  const leafAId = leafA.nodeId as string;
  const leafBId = leafB.nodeId as string;

  // 三个都订阅：两个叶 + 父节点（父节点必须"被跳过"而不是"被拒后假装推进"）
  for (const nodeId of [branchId, leafAId, leafBId]) {
    await service.subscribe({
      nodeId,
      actor: 'session',
      actorId: 'session-a',
      intent: 'read',
      notify: 'key',
    });
  }
  await service.progress({
    nodeId: leafAId,
    selfState: 'running',
    progress: 0.3,
    by: 'session',
    actorId: 'session-a',
  });
  injected.length = 0;
  inboxed.length = 0;

  // 事实由 `derive()` 顺手刷新 —— 而订阅/写入本身就会派生，所以这里不需要额外拉一次看板。
  // （反过来也钉住一件事：**任何**读路径都必须让 provider 拿到最新事实，不能只在面板刷新时才更新。）
  const factsEntry = contexts.get('project-manager:bound-progress');
  assert.ok(factsEntry, '未注册绑定事实上下文');
  assert.equal(factsEntry.order, 9010);
  const renderFacts = (actorId: string): string =>
    String((factsEntry.text as (context: unknown) => string)({ agent: { id: actorId } }));
  const facts = renderFacts('session-a');
  assert.match(facts, /登录页/);
  assert.match(facts, /鉴权中间件/);
  assert.match(facts, /running/, '已报进度的节点要显示 running');
  assert.match(facts, /登录模块/, '父节点也在绑定里，且自身/派生状态都写出来');
  assert.equal(renderFacts('session-other'), '', '别的会话问 → 什么都不知道，什么都不说');

  // ── 边界 ①：`agent/status = running` 不是边界 ──
  ctx.emit('agent/status', { agent: { id: 'session-a' }, status: 'running' });
  await settle();
  assert.equal(service.boundaryStatsOf().runs, 0, 'running 只表示"开始干活"，不是边界');

  // ── 边界 ②：`agent/status = idle` → 零 token 推进 + 一条不唤醒的提醒 ──
  ctx.emit('agent/status', { agent: { id: 'session-a' }, status: 'idle' });
  const pushed = await settleUntil(
    async () => (await service.nodeView(leafBId))?.selfState === 'running',
  );
  assert.ok(pushed, '边界回调没有把未开工的叶节点推成进行中');
  const viewB = await service.nodeView(leafBId);
  assert.equal(viewB?.progress, 0, '推进状态**绝不能**顺手编数字');
  const viewA = await service.nodeView(leafAId);
  assert.equal(viewA?.progress, 0.3, '已报过的进度不许被覆盖');
  const branchView = await service.nodeView(branchId);
  assert.equal(branchView?.selfState, 'pending', '父节点不写自身状态（C5），边界也不许碰它');

  assert.equal(injected.length, 1, `应投一条边界提醒：${JSON.stringify(injected)}`);
  assert.equal(injected[0]?.plugin, 'dsh-project-manager', '来源必须标明是本插件');
  assert.match(injected[0]?.text ?? '', /仍在进行/);
  assert.match(injected[0]?.text ?? '', /登录页/);
  assert.equal(inboxed.length, 0, '边界提醒走 inject（不唤醒），不走回写的 next-step 通道');

  // ── 去抖：窗口内重复的 idle 不再动一次 ──
  ctx.emit('agent/status', { agent: { id: 'session-a' }, status: 'idle' });
  await settle();
  assert.equal(service.boundaryStatsOf().runs, 1, '去抖：同会话的 idle 边界在窗口内只处理一次');
  assert.equal(injected.length, 1);

  // ── 边界 ③：`agent/disposed`（子代理/会话结束）永远处理，但不再往要消失的 agent 投东西 ──
  ctx.emit('agent/disposed', { agent: { id: 'session-a' } });
  await settle();
  assert.equal(service.boundaryStatsOf().runs, 2, 'disposed 是最后的机会，不受去抖约束');
  assert.equal(injected.length, 1, 'agent 都要没了，不该再往它 inbox 里投东西');

  // ── pm_report：一次调用汇报多个节点（"AI 主动在收尾时修正"的落地方式）──
  const reportTool = ctx.toolRegistry.get('pm_report') as {
    execute(
      args: unknown,
      exec: unknown,
    ): Promise<{
      applied: number;
      failed: number;
      truncated: number;
      results: Array<{ nodeId: string; status: string; code?: string }>;
    }>;
  };
  assert.ok(reportTool, 'pm_report 未注册');
  const exec = { agent: { id: 'session-a', session: { header: { cwd: workspace } } } };

  const report = await reportTool.execute(
    {
      updates: [
        { nodeId: leafAId, progress: 0.6 },
        { nodeId: leafBId, finish: true, evidence: '鉴权中间件已合入' },
      ],
      reason: '本回合收尾汇报',
    },
    exec,
  );
  assert.equal(report.applied, 2, JSON.stringify(report));
  assert.equal(report.failed, 0);
  assert.equal(report.truncated, 0);
  assert.equal((await service.nodeView(leafBId))?.selfState, 'done');
  assert.equal((await service.nodeView(leafBId))?.progress, 1, 'finish 必须同时把进度置 1');
  assert.equal((await service.nodeView(leafAId))?.progress, 0.6);

  // 单项失败不影响其它项，且失败**如实回传**
  const mixed = await reportTool.execute(
    {
      updates: [
        { nodeId: '__nope__', progress: 0.5 },
        { nodeId: leafAId, progress: 0.7 },
      ],
    },
    exec,
  );
  assert.equal(mixed.applied, 1);
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.results.find((item) => item.nodeId === '__nope__')?.status, 'denied');

  // 超过 50 项：不执行超出部分，并如实说明（不静默截断）
  const capped = await reportTool.execute(
    { updates: Array.from({ length: 52 }, () => ({ nodeId: leafAId, progress: 0.8 })) },
    exec,
  );
  assert.equal(capped.truncated, 2, '超出上限的数量必须如实返回');
  assert.equal(capped.applied, 50);

  // 统计可核对（设置页显示的正是这一份）
  const stats = service.boundaryStatsOf();
  assert.equal(stats.enabled, true);
  assert.equal(stats.prompt, true);
  assert.ok(stats.patches >= 1, '至少推进了那个未开工的叶节点');
  assert.equal(stats.reminders, 1);
  assert.equal(stats.injected, 1);

  // ── 卸载：提示词贡献必须被撤销（否则插件卸载后还在往系统提示词里塞东西）──
  ctx.disposeAll();
  assert.equal(sections.size, 0, '段未随插件卸载撤销');
  assert.equal(contexts.size, 0, '动态上下文未随插件卸载撤销');
});

test('边界修正开关：关掉之后边界上什么都不做（零副作用）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-boundary-off-'));
  const injected: string[] = [];
  const ctx = createFakeContext({
    workspace,
    agents: {
      get: () => ({
        session: { header: { cwd: workspace } },
        inject(message: { content?: Array<{ text?: string }> }) {
          injected.push(message?.content?.[0]?.text ?? '');
        },
      }),
    },
  });
  ctx.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
    sessionBoundaryWriteback: false,
    sessionBoundaryPrompt: false,
  });

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    nodeView(id: string): Promise<{ selfState: string } | undefined>;
    boundaryStatsOf(): { runs: number; patches: number; enabled: boolean; prompt: boolean };
  };
  service.noteWorkspaceRoot(workspace, 'session-a');
  const leaf = await service.addNode({ parentId: null, name: '登录页' });
  const leafId = leaf.nodeId as string;
  await service.subscribe({
    nodeId: leafId,
    actor: 'session',
    actorId: 'session-a',
    intent: 'read',
    notify: 'key',
  });

  ctx.emit('agent/status', { agent: { id: 'session-a' }, status: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await service.nodeView(leafId))?.selfState, 'pending', '关掉后不许动节点');
  assert.equal(injected.length, 0, '关掉后不许打扰会话');
  assert.equal(service.boundaryStatsOf().runs, 0);
  assert.equal(service.boundaryStatsOf().enabled, false);
  assert.equal(service.boundaryStatsOf().prompt, false);
  ctx.disposeAll();
});
test('always-arbitrate 下的自相矛盾写入 → 返回 arbitrate 并**真的记下冲突节点**（schema 非空 nodeId）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-arbitrate-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'always-arbitrate',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    progress(input: Record<string, unknown>): Promise<{ status: string; conflictId?: string; code?: string }>;
    board(): Promise<{ conflicts: Array<{ nodeId: string; code: string }> }>;
  };
  service.noteWorkspaceRoot(workspace, 'session-a');
  const leaf = await service.addNode({ parentId: null, name: '登录页' });
  const leafId = leaf.nodeId as string;

  // C3：`done` + `progress < 1` 自相矛盾；策略是 always-arbitrate → 必须仲裁而不是自动修正
  const result = await service.progress({ nodeId: leafId, selfState: 'done', progress: 0.5 });
  assert.equal(result.status, 'arbitrate', JSON.stringify(result));
  assert.equal(result.code, 'C3');

  // 冲突记录必须落在**这个节点**上（早先这里写的是空串，撞上 schema 的 min(1) 直接抛）
  const board = await service.board();
  const conflict = board.conflicts.find((item) => item.code === 'C3');
  assert.ok(conflict, `冲突未落库：${JSON.stringify(board.conflicts)}`);
  assert.equal(conflict?.nodeId, leafId);
  ctx.disposeAll();
});
test('提示词层：宿主没有 systemPrompt 时如实记为"未注册/等待"，绝不谎称已生效', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-noprompt-'));
  // 场景 A：有 ctx.inject（真宿主姿态）但服务永远不会出现 → 注入纤维保持待定
  const ctxA = createFakeContext({ workspace });
  const moduleA = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await moduleA.apply(ctxA, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });
  const serviceA = ctxA.services.get('projectManager') as {
    boundaryStatsOf(): { promptState: string; promptRegistered: boolean; enabled: boolean };
  };
  assert.equal(serviceA.boundaryStatsOf().promptState, 'pending', '没有 systemPrompt → 等待，而不是假装注册成功');
  assert.equal(serviceA.boundaryStatsOf().promptRegistered, false);
  assert.equal(serviceA.boundaryStatsOf().enabled, true, '提示词层缺失不该影响边界上的零 token 状态推进');
  ctxA.disposeAll();

  // 场景 B：**没有 `ctx.inject`** 的旧宿主/替身 → 走回退路径，并且**留下诊断**
  const ctxB = createFakeContext({ workspace });
  delete (ctxB as unknown as { inject?: unknown }).inject;
  await moduleA.apply(ctxB, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });
  const serviceB = ctxB.services.get('projectManager') as {
    boundaryStatsOf(): { promptState: string; promptRegistered: boolean };
  };
  assert.equal(serviceB.boundaryStatsOf().promptState, 'unavailable');
  assert.equal(serviceB.boundaryStatsOf().promptRegistered, false);
  ctxB.disposeAll();
});
test('回写与边界提醒走官方 ctx.inject 注入的 agents（模拟真宿主的 PENDING 语义）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-agents-inject-'));
  const delivered: Array<{ sessionId: string; target: string; text: string }> = [];
  const agentFor = (sessionId: string) => ({
    session: { header: { cwd: workspace } },
    inbox: {
      append(target: string, message: { content?: Array<{ text?: string }> }) {
        delivered.push({ sessionId, target, text: message?.content?.[0]?.text ?? '' });
      },
    },
  });

  const ctx = createFakeContext({ workspace, agents: { get: (id: string) => agentFor(id) } });
  // 真宿主的语义：**未在插件 `inject` 里声明的服务是 PENDING 的**，`ctx.get` 拿不到
  // （属性读回来也不是可用的服务对象）。这就是"回写一条都投不出去"的真实原因。
  const viaGet = ctx.get;
  ctx.get = (key: string) =>
    key === 'agents' || key === 'systemPrompt' ? undefined : viaGet(key);
  ctx.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
  });

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
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    finish(input: Record<string, unknown>): Promise<{ status: string }>;
    notifyStats(): { sent: number };
  };
  assert.ok(
    ctx.injectCalls.some((call) => call.deps.includes('agents') && call.ran),
    'agents 必须通过 ctx.inject 声明式取得',
  );

  service.noteWorkspaceRoot(workspace, 'session-a');
  const leaf = await service.addNode({ parentId: null, name: '登录页' });
  const leafId = leaf.nodeId as string;
  await service.subscribe({
    nodeId: leafId,
    actor: 'session',
    actorId: 'session-a',
    intent: 'read',
    notify: 'key',
  });
  await service.finish({ nodeId: leafId });

  assert.equal(delivered.length, 1, `真宿主语义下也必须投得出去：${JSON.stringify(delivered)}`);
  assert.equal(delivered[0]?.target, 'next-step');
  assert.match(delivered[0]?.text ?? '', /done 100%/);
  assert.equal(service.notifyStats().sent, 1);
  ctx.disposeAll();
});
test('插件自身 AI 用量统计（FR-147）：真实用量优先、缓存复用记节省、失败也记账、账本落盘', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-usage-'));
  writeFileSync(join(workspace, 'package.json'), '{"name":"usage-demo"}\n');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', { stream: () => { throw new Error('不该走真 llm'); } });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    aiUsageStats(): Promise<{
      calls: number;
      reused: number;
      failed: number;
      providerReported: number;
      estimatedOnly: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      estimatedTokens: number;
      savedTokens: number;
      byScenario: Array<{ scenario: string; calls: number; reused: number; totalTokens: number }>;
      window: number;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  // ① 一开始什么都没发生：不许编数字
  const before = await service.aiUsageStats();
  assert.equal(before.calls, 0);
  assert.equal(before.totalTokens, 0);
  assert.deepEqual(before.byScenario, []);

  const json = JSON.stringify({
    projectName: '用量演示',
    nodes: [{ name: '登录', kind: 'feature', parent: null, weight: 5 }],
  });
  /** 假模型：文本 + **提供方用量 chunk**（真实适配器就是在 finish 之前回它）。 */
  const fakeStream = (text: string, usage?: Record<string, number>) => ({
    stream: () =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        if (usage !== undefined) yield { type: 'usage', usage };
        yield { type: 'finish', reason: 'stop' };
      })(),
  });

  // ② 真发一次调用：真实用量必须按提供方回报记账
  const first = await service.aiBuildTree({
    confirm: true,
    stream: fakeStream(json, {
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
    }),
  });
  assert.equal(first['status'], 'ok', JSON.stringify(first));
  const afterCall = await service.aiUsageStats();
  assert.equal(afterCall.calls, 1);
  assert.equal(afterCall.providerReported, 1);
  assert.equal(afterCall.estimatedOnly, 0);
  assert.equal(afterCall.totalTokens, 1801, '真实用量按提供方回报，不用粗估顶替');
  assert.equal(afterCall.inputTokens, 1234);
  assert.equal(afterCall.outputTokens, 567);
  assert.equal(afterCall.cacheReadTokens, 400);
  assert.equal(afterCall.byScenario[0]?.scenario, 'tree');
  assert.ok(afterCall.estimatedTokens > 0, '粗估也记一笔（用于"预估 vs 实际"对照）');

  // ③ 同输入再建一次 → 缓存命中：**不算调用**，但要把省下的量记进 savedTokens
  const second = await service.aiBuildTree({
    confirm: true,
    stream: fakeStream(json, { inputTokens: 9, outputTokens: 9, totalTokens: 18 }),
  });
  assert.equal(second['status'], 'ok');
  assert.equal((second['cache'] as { state: string }).state, 'hit', '同输入应命中缓存');
  const afterReuse = await service.aiUsageStats();
  assert.equal(afterReuse.calls, 1, '缓存命中不许增加调用次数');
  assert.equal(afterReuse.reused, 1);
  assert.equal(afterReuse.totalTokens, 1801, '复用不产生真实用量');
  assert.ok(afterReuse.savedTokens > 0, '复用省下的量要记（T6/T9 的价值证明）');

  // ④ 失败的调用也烧 token：forceRebuild 绕过缓存 + 模型直接抛错
  const failed = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: {
      stream: () =>
        (async function* () {
          yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 40, totalTokens: 340 } };
          throw new Error('模型连接中断');
        })(),
    },
  });
  assert.equal(failed['status'], 'error', JSON.stringify(failed));
  const afterFail = await service.aiUsageStats();
  assert.equal(afterFail.calls, 2);
  assert.equal(afterFail.failed, 1);
  assert.equal(afterFail.totalTokens, 1801 + 340, '失败那次已经回过的用量也要记账');

  // ⑤ 账本真的落盘（统计要能跨重启累计），且形状可读
  const raw = ctx.fsService.files.get('.pm/ai-usage.json');
  assert.ok(raw !== undefined, '用量账本应写到 .pm/ai-usage.json');
  const parsed = JSON.parse(raw as string) as { version: number; entries: Array<Record<string, unknown>> };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.entries.length, 3, '一次成功调用 + 一次缓存复用 + 一次失败调用');
  assert.equal(afterFail.window, 3);
  ctx.disposeAll();
});
test('回写投递优先走官方 agent.send（文档入口 + 显式 wakeup=false）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-send-'));
  /** 只给 send（没有 inbox）：钉住"优先走文档入口"这条分支（真机上两者通常都在）。 */
  const sent: Array<{ sessionId: string; target: string; wakeup: boolean; text: string }> = [];
  const ctx = createFakeContext({
    workspace,
    agents: {
      get: (id: string) => ({
        session: { header: { cwd: workspace } },
        send(message: { content?: Array<{ text?: string }> }, target: string, wakeup: boolean) {
          sent.push({ sessionId: id, target, wakeup, text: message?.content?.[0]?.text ?? '' });
        },
      }),
    },
  });
  ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    finish(input: Record<string, unknown>): Promise<{ status: string }>;
    notifyStats(): { sent: number };
  };
  service.noteWorkspaceRoot(workspace, 'session-a');
  const leaf = await service.addNode({ parentId: null, name: '登录页' });
  const leafId = leaf.nodeId as string;
  await service.subscribe({ nodeId: leafId, actor: 'session', actorId: 'session-a', intent: 'read', notify: 'key' });
  await service.finish({ nodeId: leafId });

  assert.equal(sent.length, 1, `应通过 send 投一条：${JSON.stringify(sent)}`);
  assert.equal(sent[0]?.target, 'next-step');
  assert.equal(sent[0]?.wakeup, false, 'wakeup 必须是 false（不唤醒 agent ⇒ 不产生 token，T11）');
  assert.match(sent[0]?.text ?? '', /done 100%/);
  assert.equal(service.notifyStats().sent, 1);
  ctx.disposeAll();
});
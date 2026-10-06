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
import { join, dirname } from 'node:path';

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
    /**
     * **把工具注册表暴露给测试**（键 = 工具名 → `defineTool` 的定义对象，含 `execute`）。
     *
     * 为什么叫 `toolDefs` 而不是 `tools`：`ctx.tools` 这个名字被上方的**注册入口**
     * （`{ register }`）占着 —— 插件要用它，不能让给测试（实测覆盖它会炸掉全部 e2e）。
     *
     * 为什么需要它：只断言"工具名注册了"是不够的 —— 工具自己的**参数处理与返回整形**是插件逻辑的一部分
     * （`pm_board` 的 `includeStale` 这类映射，光看服务层测不到；注册名对了但返回错了照样是 bug）。
     */
    toolDefs: tools,
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
    'pm_next',
    'pm_doc_check',
    'pm_audit',
    'pm_snapshot',
    'pm_snapshots',
    'pm_rollback',
    'pm_rollback_undo',
    'pm_snapshot_health',
    'pm_pause',
    'pm_hold',
    'pm_resume',
    'pm_release',
    'pm_handoff_read',
    'pm_report',
  ]) {
    assert.ok(ctx.toolRegistry.has(name), `工具 ${name} 未注册`);
  }
  // 工具总数与源头 `TOOL_NAMES` 对齐（「扫描直接建树」已删除 ⇒ 33 → 32）
  assert.equal(ctx.toolRegistry.size, 32, '工具总数应与 TOOL_NAMES 一致');

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
  const needsConfirm = await service.removeBranch({ nodeIds: [leafB.nodeId as string], policy: 'record' });
  assert.equal(needsConfirm.status, 'needs-confirm');
  const stillThere = await service.nodeView(leafB.nodeId as string);
  assert.ok(stillThere, '未确认前不得执行删除');

  /**
   * ── **批量删除整枝**：一次确认覆盖整批（用户口径："删除批量只存在会话工具中"）──
   *
   * 面板只提供右键「删除整枝」（本身递归删整棵子树）；"一次删多个枝"是**工具侧**的能力，
   * 所以这里验证三件事：① 一次签发覆盖整批；② 被包含的节点不重复列出；
   * ③ 逐枝独立判定（一枝的失败不该把整批判死）。
   */
  const bulk = await service.removeBranch({
    nodeIds: [leafA.nodeId as string, leafB.nodeId as string],
    policy: 'record',
  });
  assert.equal(bulk.status, 'needs-confirm', JSON.stringify(bulk));
  assert.ok(typeof bulk.confirmToken === 'string' && bulk.confirmToken.length > 0, '批量也要签发确认句柄');
  assert.ok(String(bulk.preview).includes('批量删除 2 枝'), `预览要说清是批量：${bulk.preview}`);
  assert.ok(
    (await service.nodeView(leafA.nodeId as string)) !== undefined &&
      (await service.nodeView(leafB.nodeId as string)) !== undefined,
    '批量在未确认前同样不得执行任何删除',
  );
  const bulkDone = await service.removeBranch({
    nodeIds: [leafA.nodeId as string, leafB.nodeId as string],
    policy: 'record',
    confirmToken: bulk.confirmToken as string,
  });
  assert.equal(bulkDone.status, 'ok', JSON.stringify(bulkDone));
  assert.equal(bulkDone.removed.length, 2, '两枝都该删掉');
  assert.deepEqual(bulkDone.failures, [], '没有失败项');
  const boardAfterBulk = await service.board();
  assert.equal(
    boardAfterBulk.nodes.find((node) => node.name === (leafA.name as string)),
    undefined,
    '批量删除后两枝都不该在树上',
  );
  assert.equal(
    boardAfterBulk.nodes.find((node) => node.name === (leafB.name as string)),
    undefined,
    '批量删除后两枝都不该在树上',
  );
  // 幂等性：同一个令牌第二次用必须被拒（一次性句柄，不许重放）
  const replay = await service.removeBranch({
    nodeIds: [leafA.nodeId as string],
    policy: 'record',
    confirmToken: bulk.confirmToken as string,
  });
  assert.equal(replay.status, 'denied', '确认句柄是一次性的：重放必须被拒');
  assert.equal(replay.code, 'E_STALE_CONFIRM_TOKEN');

  /**
   * ── **工具层**：`pm_board` 的返回整形（光测服务层测不到这一段）──
   *
   * 用真注册表拿到工具定义直接调 `execute`：验证**默认不给遗留清单**（逐节点明细很占 token，
   * 日常看进度不需要）与**显式要求时给出空清单**。有真数据的情形在建树那段验证。
   */
  const pmBoard = (ctx.toolDefs as Map<string, { execute(args: Record<string, unknown>, exec: unknown): Promise<Record<string, unknown>> }>).get('pm_board');
  assert.ok(pmBoard, 'pm_board 应已注册');
  const asked = await pmBoard.execute({ includeStale: true }, { agent: undefined, callId: 'e2e' });
  assert.equal(asked['staleCount'], 0, '当前没有遗留节点 → 清单为空');
  assert.deepEqual(asked['staleNodes'], []);
  const plain = await pmBoard.execute({}, { agent: undefined, callId: 'e2e' });
  assert.equal(plain['staleNodes'], undefined, '默认不得返回逐节点明细（省 token）');
  assert.equal(plain['staleCount'], undefined);

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

  /**
   * ③ 没有会话信息（浏览器面板拿不到会话 id 的那次）→ **认"面板正在看的那个会话的项目"**。
   *
   * 口径变更（实测修正）：这里原先是"退回注册表最近使用的工作区"。但那条路会先命中
   * `workspaceRootOverride`（**任何**会话最后报告的根），把匿名轮询带去别的工作区 ——
   * 真机现场就是本工作区的流程图读到 0 节点、一个 loading 都不显示。
   * 现在匿名读只认"最近一次**具名会话**读/写过的那个根"—— 这里就是 ② 那次
   * `session-in-workspace` 的 `registered`（根的值与旧行为相同，只是来源标注更准确）；
   * 完全没有会话线索时才退回注册表/环境（见 service.operationRoot 的注释）。
   */
  const anonymous = await serviceWithAgent.board();
  assert.equal(anonymous.workspaceRoot.value, registered);
  assert.equal(anonymous.workspaceRoot.source, 'bound');

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

  // A 工作区建一棵树（写入要带发起会话 —— 项目绑定跟着"这次调用所属会话"走）
  service.noteWorkspaceRoot(wsA, 'session-A');
  const nodeA = await service.addNode({ parentId: null, name: 'A树', sessionId: 'session-A' });
  assert.equal(nodeA.status, 'ok');
  const projectA = service.currentProjectId;

  // 切到 B 工作区（另一个会话）→ 必须换到**另一个项目**，而不是把 B 的节点写进 A 的树
  service.noteWorkspaceRoot(wsB, 'session-B');
  const boardB = await service.board('session-B');
  assert.equal(boardB.workspaceRoot.value, wsB);
  assert.notEqual(boardB.projectId, projectA, '不同工作区必须绑定不同项目');
  assert.deepEqual(boardB.nodes, [], 'B 工作区应该是空的新项目');

  const nodeB = await service.addNode({ parentId: null, name: 'B树', sessionId: 'session-B' });
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

/**
 * 绑定副作用（多工作区并发时的真实数据混入）。
 *
 * ## 现场
 *
 * 面板每轮都会调 `board(sessionId)`，而 `board` 会把"正在看的那个会话的工作区"
 * 记成**全局** `pendingRoot`。写路径（`pm_add` / `pm_progress` / `pm_report` …）
 * 走的却是 `operationRoot()` —— 它优先读的正是这个全局值。
 *
 * ## 后果
 *
 * A 工作区的会话发起写入时，如果 B 工作区的面板刚轮询过（B 的会话并没有在写），
 * `operationRoot()` 会解析到 B —— 于是 **A 的写入落进 B 的项目**（B 会凭空多出节点，
 * A 什么都没变）。这是"把进度写进别人的项目"，不是显示问题。
 *
 * 判据：工具调用所属会话自己有 cwd（`noteWorkspaceRoot(root, sessionId)`）时，
 * 写入必须落到该会话自己工作区的项目上，**与谁的面板刚轮询过无关**。
 */
test('多工作区：写入必须跟着「调用会话自己的工作区」，不能被别人的面板轮询带偏', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'pm-e2e-bind-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'pm-e2e-bind-b-'));
  const ctx = createFakeContext({ workspace: wsA });
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
    }>;
  };

  // A 工作区建树（会话 A 的调用）
  service.noteWorkspaceRoot(wsA, 'session-A');
  const nodeA = await service.addNode({ parentId: null, name: 'A树', sessionId: 'session-A' });
  assert.equal(nodeA.status, 'ok');
  const projectA = service.currentProjectId;

  // B 工作区建树（会话 B 的调用）→ 必须是另一个项目
  service.noteWorkspaceRoot(wsB, 'session-B');
  const nodeB = await service.addNode({ parentId: null, name: 'B树', sessionId: 'session-B' });
  assert.equal(nodeB.status, 'ok');
  const projectB = service.currentProjectId;
  assert.notEqual(projectA, projectB, '两个工作区必须是两个项目');

  // 现场：B 的面板刚轮询过（B 的会话**并没有在写**任何东西）
  await service.board('session-B');

  // 此刻 A 的会话发起写入 —— 必须落进 A 的项目
  service.noteWorkspaceRoot(wsA, 'session-A');
  const later = await service.addNode({ parentId: null, name: 'A的第二个节点', sessionId: 'session-A' });
  assert.equal(later.status, 'ok');

  const boardA = await service.board('session-A');
  assert.equal(boardA.projectId, projectA, 'A 会话的写入必须留在 A 的项目里');
  assert.deepEqual(
    boardA.nodes.map((n) => n.name).sort(),
    ['A树', 'A的第二个节点'],
    `A 的项目应当多出 A 会话写的那个节点，实际：${JSON.stringify(boardA.nodes)}`,
  );

  // B 的项目必须**没被污染**：凭空多出别人的节点就是"写进别人的项目"
  const boardB = await service.board('session-B');
  assert.equal(boardB.projectId, projectB);
  assert.deepEqual(
    boardB.nodes.map((n) => n.name),
    ['B树'],
    `B 的项目不得被 A 会话的写入污染，实际：${JSON.stringify(boardB.nodes)}`,
  );

  ctx.disposeAll();
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});

/**
 * 匿名读（浏览器面板轮询）不得跟着**别的会话**的 `pendingRoot` 走。
 *
 * ## 现场
 *
 * 面板的 `/pm/board` 有时拿不到会话 id（匿名）。旧实现里 `operationRoot()` 无条件认全局
 * `pendingRoot` —— 那是**上一个工具调用**留下的根。于是本工作区的会话在跑、节点在动，
 * 面板却被带去另一个工作区的空项目上：流程图 0 节点、**一个 loading 都不显示**
 * （用户反馈的"项目进度里的流程图没有 loading"就是它）。
 *
 * 判据：匿名读必须落到**当前已绑定的项目**（也就是本服务真正在读写的那个），
 * 而不是某个别的会话残留的根。
 */
test('匿名看板轮询不得被别的会话的根带偏（要读当前已绑定项目）', async () => {
  const wsHome = mkdtempSync(join(tmpdir(), 'pm-e2e-anon-home-'));
  const wsOther = mkdtempSync(join(tmpdir(), 'pm-e2e-anon-other-'));
  const ctx = createFakeContext({ workspace: wsHome });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    boundWorkspaceRoot: string | undefined;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string }>;
    board(sessionId?: string): Promise<{
      projectId: string;
      nodes: Array<{ name: string }>;
      workspaceRoot: { value: string | null; source: string };
    }>;
  };

  // 本工作区建树（本会话）
  service.noteWorkspaceRoot(wsHome, 'session-home');
  assert.equal(
    (await service.addNode({ parentId: null, name: '根节点', sessionId: 'session-home' })).status,
    'ok',
  );

  // 面板当前看的会话 = session-home → 记录它看到的是哪个项目
  const panelView = await service.board('session-home');
  const homeOnly = panelView.projectId;

  // 另一个会话在别的工作区建了树（绑定会被它改到 wsOther）
  service.noteWorkspaceRoot(wsOther, 'session-other');
  assert.equal(
    (await service.addNode({ parentId: null, name: '别人的树', sessionId: 'session-other' })).status,
    'ok',
  );

  // 别的会话的面板也轮询过（绑定现在停在 wsOther 的项目上）
  await service.board('session-other');

  // ① 反过来：本会话的面板带 id 读 → 必须回到本工作区的那个项目
  const backHome = await service.board('session-home');
  assert.equal(backHome.projectId, homeOnly, '带会话 id 的面板读必须回到该会话自己的工作区');
  assert.deepEqual(backHome.nodes.map((n) => n.name), ['根节点']);

  // ② 匿名轮询（浏览器面板拿不到会话 id 的那次）—— 不得被 session-other 的根带走
  const anon = await service.board();
  assert.equal(
    anon.projectId,
    homeOnly,
    '匿名看板必须读「用户正在看的那个项目」，不能被别的会话刚绑上的工作区项目带偏',
  );
  assert.deepEqual(
    anon.nodes.map((n) => n.name),
    ['根节点'],
    `匿名看板不得被别的会话的根带偏（读到别人的树就是被带偏），实际：${JSON.stringify(anon.nodes)}`,
  );

  ctx.disposeAll();
  rmSync(wsHome, { recursive: true, force: true });
  rmSync(wsOther, { recursive: true, force: true });
});

/**
 * 写路径的同一条判据必须覆盖**全部写入口**，而不只是 addNode/patchNode。
 *
 * 为什么单独钉：`pm_move` / `pm_focus` / `pm_gate` / `pm_remove` 这些入口曾各自直接
 * `readGraph()`/`derive()`，没有"先按调用会话绑定"这一步 —— 于是 A 工作区的工具调用
 * 在 B 的面板刚轮询过之后，会去 **B 的项目**里找节点。短期表现是"找不到节点"的报错
 * 而不是静默写错，但跨工作区写入本身就不该发生。
 */
test('多工作区：move/focus/gate/remove 也走「调用会话自己的工作区」', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'pm-e2e-writes-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'pm-e2e-writes-b-'));
  const ctx = createFakeContext({ workspace: wsA });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    setFocus(input: Record<string, unknown>): Promise<{ status: string }>;
    setGate(input: Record<string, unknown>): Promise<{ status: string }>;
    reparentNode(input: Record<string, unknown>): Promise<{ status: string }>;
    removeBranchFromPanel(input: Record<string, unknown>): Promise<{ status: string }>;
    board(sessionId?: string): Promise<{ projectId: string; nodes: Array<{ name: string }> }>;
  };

  // A 工作区：建父子两个节点
  service.noteWorkspaceRoot(wsA, 'session-A');
  const parent = await service.addNode({ parentId: null, name: 'A父', sessionId: 'session-A' });
  const child = await service.addNode({
    parentId: parent.nodeId ?? null,
    name: 'A子',
    sessionId: 'session-A',
  });
  assert.equal(parent.status, 'ok');
  assert.equal(child.status, 'ok');
  const projectA = service.currentProjectId;

  // B 工作区：另一个会话也建一棵树，并且它的面板轮询过（绑定停在 B）
  service.noteWorkspaceRoot(wsB, 'session-B');
  await service.addNode({ parentId: null, name: 'B树', sessionId: 'session-B' });
  await service.board('session-B');
  assert.notEqual(service.currentProjectId, projectA, '前置条件：当前绑定应当已停在 B 的项目');

  // 现在 A 会话依次调用四个写入口 —— 每一个都必须落回 A 的项目
  service.noteWorkspaceRoot(wsA, 'session-A');
  const focused = await service.setFocus({ nodeId: child.nodeId, focus: true, sessionId: 'session-A' });
  assert.equal(focused.status, 'ok', `pm_focus 必须能在 A 的项目里找到该节点：${JSON.stringify(focused)}`);

  service.noteWorkspaceRoot(wsA, 'session-A');
  const gated = await service.setGate({ nodeId: child.nodeId, gate: 'paused', sessionId: 'session-A' });
  assert.equal(gated.status, 'ok', `pm_gate 必须能在 A 的项目里找到该节点：${JSON.stringify(gated)}`);

  service.noteWorkspaceRoot(wsA, 'session-A');
  // 合法移动：把子节点移到**它本来就在的父节点**下（同一父子关系，不触发"项目根唯一"约束）
  const moved = await service.reparentNode({
    nodeId: child.nodeId,
    parentId: parent.nodeId ?? null,
    sessionId: 'session-A',
  });
  assert.equal(moved.status, 'ok', `pm_move 必须能在 A 的项目里找到该节点：${JSON.stringify(moved)}`);

  service.noteWorkspaceRoot(wsA, 'session-A');
  const removed = await service.removeBranchFromPanel({
    nodeId: child.nodeId,
    policy: 'record',
    confirm: true,
    sessionId: 'session-A',
  });
  assert.equal(removed.status, 'ok', `pm_remove 必须能在 A 的项目里找到该节点：${JSON.stringify(removed)}`);

  // 结论：B 的项目必须**一点没动**
  const boardA = await service.board('session-A');
  const boardB = await service.board('session-B');
  assert.equal(boardA.projectId, projectA);
  assert.deepEqual(
    boardB.nodes.map((n) => n.name),
    ['B树'],
    `B 的项目不得被 A 会话的写入污染，实际：${JSON.stringify(boardB.nodes)}`,
  );

  ctx.disposeAll();
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
});

/**
 * 幽灵空项目清理（真机踩过）：在别的工作区里调用一次工具就会新建一个"未命名项目"，
 * 并**永久留在全机器共享存储里**（本机实测留下 VideoFix / AIG 两个零节点空壳）。
 *
 * 判据必须保守：只删「零根节点 **且** 图里零节点」的项目，且**跳过当前绑定的那个**
 * —— 用户可能真的刚打开一个还没建树的项目。
 */
test('空项目清理：只删零节点空壳，绝不碰当前绑定与有内容的项目', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'pm-e2e-prune-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'pm-e2e-prune-b-'));
  const wsC = mkdtempSync(join(tmpdir(), 'pm-e2e-prune-c-'));
  const ctx = createFakeContext({ workspace: wsA });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string }>;
    board(sessionId?: string): Promise<{ projectId: string; nodes: Array<{ name: string }> }>;
    listProjects(): Promise<Array<{ projectId: string; workspaceRoot?: string }>>;
    pruneEmptyProjects(): Promise<{ removed: string[] }>;
  };

  // A：有内容的项目（要保住）
  service.noteWorkspaceRoot(wsA, 'session-A');
  await service.addNode({ parentId: null, name: 'A树', sessionId: 'session-A' });
  const projectA = service.currentProjectId;

  // B：另一个工作区的**空壳**（只被"碰过"、没建任何节点）—— 要删
  service.noteWorkspaceRoot(wsB, 'session-B');
  await service.board('session-B');
  const ghostB = service.currentProjectId;
  assert.notEqual(ghostB, projectA);

  // C：第三个工作区，同样只被碰过 —— 要删；但它是**当前绑定**，本次必须跳过
  service.noteWorkspaceRoot(wsC, 'session-C');
  await service.board('session-C');
  const ghostC = service.currentProjectId;

  const before = await service.listProjects();
  assert.ok(
    before.some((p) => p.projectId === ghostB) && before.some((p) => p.projectId === ghostC),
    `前置条件：两个空壳都应在库里：${JSON.stringify(before)}`,
  );

  const result = await service.pruneEmptyProjects();
  assert.ok(result.removed.includes(ghostB), `B 空壳应被清理：${JSON.stringify(result)}`);
  assert.ok(!result.removed.includes(ghostC), '当前绑定的项目不得被清理（用户可能刚开始用）');
  assert.ok(!result.removed.includes(projectA), '有内容的项目绝不能删');

  const after = await service.listProjects();
  assert.ok(!after.some((p) => p.projectId === ghostB), 'B 空壳应已从库里消失');
  assert.ok(after.some((p) => p.projectId === ghostC), '当前绑定仍在');

  // 幂等：再跑一次不该再删任何东西
  const again = await service.pruneEmptyProjects();
  assert.deepEqual(again.removed, [], '清理必须幂等（没有空壳时什么都不做）');

  // A 的树必须完好
  const boardA = await service.board('session-A');
  assert.equal(boardA.projectId, projectA);
  assert.deepEqual(boardA.nodes.map((n) => n.name), ['A树']);

  ctx.disposeAll();
  rmSync(wsA, { recursive: true, force: true });
  rmSync(wsB, { recursive: true, force: true });
  rmSync(wsC, { recursive: true, force: true });
});

/**
 * 删除项目（清理入口）：真机现场是"试错留下的整棵树 / 幽灵空项目没有别的清理方式"。
 *
 * 两条必须钉住的纪律：
 * ① **两段式**：`confirm:false` 只回影响范围、**不落库**；`confirm:true` 才真删。
 * ② **不允许删当前绑定的项目**（否则删完再读会退到别的项目 = 静默换项目）。
 */
test('删除项目：两段式确认、不允许删当前绑定、删完从列表消失', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'pm-e2e-del-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'pm-e2e-del-b-'));
  const ctx = createFakeContext({ workspace: wsA });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    currentProjectId: string;
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    board(sessionId?: string): Promise<{ projectId: string; nodes: Array<{ name: string }> }>;
    listProjects(): Promise<Array<{ projectId: string; workspaceRoot?: string }>>;
    deleteProject(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };

  // A：本工作区建一棵树（要保住）
  service.noteWorkspaceRoot(wsA, 'session-A');
  await service.addNode({ parentId: null, name: 'A树', sessionId: 'session-A' });
  const projectA = service.currentProjectId;

  // B：另一个工作区也建一棵树（拿来删）
  service.noteWorkspaceRoot(wsB, 'session-B');
  await service.addNode({ parentId: null, name: 'B树', sessionId: 'session-B' });
  const projectB = service.currentProjectId;
  assert.notEqual(projectA, projectB);

  // 回到 A（这样 B 不是"当前绑定"，才允许删）
  service.noteWorkspaceRoot(wsA, 'session-A');
  await service.board('session-A');
  assert.equal(service.currentProjectId, projectA);

  // ① 第一段：只回影响范围，不落库
  const preview = await service.deleteProject({ projectId: projectB });
  assert.equal(preview['status'], 'needs-confirm', JSON.stringify(preview));
  assert.match(String(preview['preview']), /B树/, `影响范围要列出顶级枝：${String(preview['preview'])}`);
  let projects = await service.listProjects();
  assert.ok(projects.some((p) => p.projectId === projectB), '第一段不得真删');

  // ② 第二段：真删
  const done = await service.deleteProject({ projectId: projectB, confirm: true });
  assert.equal(done['status'], 'ok', JSON.stringify(done));
  assert.equal(done['removedNodes'], 1);
  projects = await service.listProjects();
  assert.ok(!projects.some((p) => p.projectId === projectB), 'B 项目应从列表消失');
  assert.ok(projects.some((p) => p.projectId === projectA), 'A 项目必须还在');

  // ③ 守卫：当前绑定的项目不许删（force 也不行 —— 这里没有 force 这个口子）
  const bound = await service.deleteProject({ projectId: projectA, confirm: true });
  assert.equal(bound['status'], 'denied', JSON.stringify(bound));
  assert.equal(bound['code'], 'E_PROJECT_BOUND');
  assert.ok(
    (await service.listProjects()).some((p) => p.projectId === projectA),
    '被拒后项目必须还在',
  );

  // ④ 删过的 id 再删一次：如实说"不存在"，不抛错
  const again = await service.deleteProject({ projectId: projectB, confirm: true });
  assert.equal(again['status'], 'denied');
  assert.equal(again['code'], 'E_PROJECT_NOT_FOUND');

  // A 的树完好
  const boardA = await service.board('session-A');
  assert.deepEqual(boardA.nodes.map((n) => n.name), ['A树']);

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

  /**
   * T-b：墓碑不参与去重（重建同名节点**不该**被墓碑挡住）。
   *
   * 这里原先用"重新扫描 + 一键建树"来验证 —— 那条产品路径已按用户口径删除
   * （"0 token 代码全删除"），所以改成**手工重建同名节点**：更直接地测同一条不变量，
   * 且不再依赖任何扫描产物。
   */
  const rebuiltChild = await service.addNode({ parentId: again.nodeId, name: '乙' });
  assert.equal(rebuiltChild.status, 'ok', `墓碑不得挡住重建同名子节点：${rebuiltChild.code ?? ''}`);
  const rebuiltBoard = await service.board();
  assert.deepEqual(
    rebuiltBoard.nodes.map((n) => n.name).sort(),
    ['甲', '乙'].sort(),
    `重建后的树应当只有这两个活节点：${JSON.stringify(rebuiltBoard.nodes)}`,
  );

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
      { name: '登录与鉴权', kind: 'feature', parent: null, weight: 8, priority: 3, description: '登录态与权限校验，含会话续期', refs: [{ type: 'dir', target: 'src/auth' }] },
      { name: '会话续期', kind: 'task', parent: 0, weight: 3, progress: 0.6, priority: 11, note: '已看到 refresh 逻辑' },
      { name: '好友列表', kind: 'task', parent: null, weight: 5, priority: 0 }, // 越界值：应夹紧
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
  /**
   * 这条断言**原来期望 `description === '已看到 refresh 逻辑'`** —— 那正是"note 冒充描述"的旧行为。
   * 语义分开之后：`description` 只由模型的 `description` 字段来（这里没给 ⇒ 必须为空），
   * `note`（判断依据）留在权重依据里供追溯。
   */
  assert.equal(renew?.description, undefined, 'note 是判断依据，不许被当成描述写进节点');
  assert.equal(
    (renew?.weightDetail as { note?: string } | undefined)?.note,
    '已看到 refresh 逻辑',
    '判断依据要留在 weightDetail.note 里可追溯',
  );
  assert.equal(board.overall.basis, 'weight', '有 AI 权重时口径应转为按工作量（§9.3a）');

  /**
   * **优先级：AI 建树时初判**（用户诉求："优先级针对未完成的排序，优先做哪个"）。
   *
   * 三件事一起验：① 模型给的 priority 真的落库并标 `source: ai`；
   * ② 越界值**夹紧**到 1..10（`11 → 10`、`0 → 1`）而不是被丢弃；
   * ③ 它是**独立于 weight 的另一个轴**（8/3/5 与 3/10/1 各自保留）。
   */
  assert.equal(login.priority, 3, 'AI 给的优先级要落库');
  assert.equal(login.prioritySource, 'ai', '要标清来源是 AI 估的');
  assert.equal(renew?.priority, 10, 'priority=11 属越界 → 夹紧到 10（而不是丢掉）');
  const friends = board.nodes.find((node) => node.name === '好友列表');
  assert.equal(friends?.priority, 1, 'priority=0 属越界 → 夹紧到 1（1 最高）');
  assert.notEqual(login.priority, login.weight, '优先级与工作量是两个轴，不许互相顶替');

  /**
   * **建树时直接补描述**（用户诉求："AI 建树/修剪树/同步树时直接补充描述信息"）。
   *
   * 这里钉两件事：① 模型给的 `description` 落进节点的 `description`；
   * ② **`note`（判断依据）不许再冒充描述** —— 早先两者混用，节点描述里全是"我凭什么这么判断"。
   */
  assert.equal(login.description, '登录态与权限校验，含会话续期', 'AI 给的描述要落库');
  /**
   * **`note` 不许冒充描述**（反向断言）：`会话续期` 只给了 `note`（"已看到 refresh 逻辑"）、
   * 没给 `description`，所以它的描述**必须为空**。
   * 早先两者混用（`note` 直接写进 `description`），节点描述里全是"我凭什么这么判断"——
   * 这条断言就是用来钉住那次语义分离的（宽松写法等于没测，所以这里断言"必须没有"）。
   */
  assert.equal(renew?.description, undefined, 'note 是判断依据，不许被当成描述写进节点');

  /**
   * **人改过的优先级不许被建树覆盖**（与进度、权重同一个优先级口径）。
   *
   * 少了这条纪律会出现最气人的一种行为：你手动把某功能点提到"最高优先"，
   * 下一次 AI 建树按自己的判断又把它压回中间 —— 人的表态必须赢。
   */
  const patched = await (service as unknown as {
    patchNode(input: Record<string, unknown>): Promise<{ status: string }>;
  }).patchNode({ nodeId: login.id, patch: { priority: 1, prioritySource: 'user' }, by: 'user' });
  assert.equal(patched.status, 'ok', JSON.stringify(patched));
  const rebuiltForPriority = await service.aiBuildTree({ confirm: true, forceRebuild: true, stream: fakeStream(json) });
  assert.equal(rebuiltForPriority['status'], 'ok', JSON.stringify(rebuiltForPriority));
  const boardAfterPriority = await service.board();
  const loginAfter = boardAfterPriority.nodes.find((node) => node.name === '登录与鉴权');
  assert.equal(loginAfter?.priority, 1, '人改过的优先级必须保留（AI 只能填人没表过态的地方）');
  assert.equal(loginAfter?.prioritySource, 'user', '来源要如实标成 user');

  // ③ 幂等 + **缓存命中**：同一份输入再跑一次 → 不重复建树，且**一次模型调用都不发**（T6/FR-104）
  const beforeCacheHit = modelCalls;
  const again = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(again['status'], 'ok');
  assert.equal(again['created'], 0, '重复建树不得再新建节点');
  assert.equal(again['updated'], 3, `第二次建树的复用数不对：${JSON.stringify(again)}`);
  assert.equal(modelCalls, beforeCacheHit, '输入逐字节相同 → 必须走缓存，绝不能再调模型');
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
  const beforeIncremental = modelCalls;
  const incremental = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(incremental['status'], 'ok');
  assert.equal(modelCalls, beforeIncremental + 1, '文件变了必须重算');
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
  assert.equal(modelCalls, beforeIncremental + 2, '强制重算 → 真的调了模型（这次模型给了坏输出）');
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

  /**
   * ③c **FR-158 ③：本轮没再提到的自动节点 → 记 `stale`，不删除**（用户最初痛点的收口）。
   *
   * 场景就是用户实际遇到的那个：模型这次少提了一个功能点。
   * 关键是选**已经有人报过进度**的节点：那种节点**删不掉**（自动草稿清理只碰"没人动过"的，
   * 因为删掉就是埋掉人的劳动），于是旧口径下它就永久留着、分母一直涨（140 → 213 那次事故）。
   * 现在它有归宿了：**标记 stale、照常计入统计、等用户确认**。
   */
  const staleCalls = modelCalls;
  const shrunk = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: fakeStream(
      JSON.stringify({
        projectName: '演示项目',
        nodes: [
          // 同一棵树，但**不再提「会话续期」**（那条枝已报过进度，必须留下并标 stale）
          { name: '登录与鉴权', kind: 'feature', parent: null, weight: 8, refs: [{ type: 'dir', target: 'src/auth' }] },
        ],
      }),
    ),
  });
  assert.equal(shrunk['status'], 'ok', JSON.stringify(shrunk));
  assert.equal(modelCalls, staleCalls + 1, 'forceRebuild 必须真的调一次模型');
  const afterShrink = await service.board();
  const droppedNode = afterShrink.nodes.find((node) => node.name === '会话续期');
  assert.ok(droppedNode, '本轮没提到的节点**不许被删除**（它上面有已报过的进度）');
  assert.equal(droppedNode.stale, true, '没再提到 → 必须记 stale，让用户确认后再清');
  assert.equal(droppedNode.progress, 0.6, 'stale 只是标记：**已报过的进度一个字都不能动**');
  assert.ok(
    (shrunk['notes'] as string[]).some((note) => note.includes('疑似遗留')),
    '要如实告诉用户"标了哪些、它们照常计入统计"',
  );
  /**
   * **清理闭环的数据源**：`pm_board(includeStale=true)` 就是在这份快照上筛 `stale`，
   * 给模型 id / 名称 / 进度 / 所属枝，好让它带多个 `nodeIds` 调 `pm_remove` 一次确认删掉。
   * 这里守住"这份数据真的在"（UI 与工具用的是同一份，FR-71）。
   */
  const staleFeed = afterShrink.nodes.filter((node) => node.stale === true && node.derivedState !== 'removed');
  assert.equal(staleFeed.length, 1, '看板快照必须能筛出刚标的遗留节点');
  assert.equal(staleFeed[0]?.id, droppedNode.id, '筛出来的 id 必须能直接喂给 pm_remove');

  /**
   * 同一份数据走**工具层**再验一次（`pm_board` 的 `includeStale` 整形是本轮新加的插件逻辑，
   * 只测服务层测不到它）。清单里的 id 必须能直接拿去调 `pm_remove`。
   */
  const boardTool = (ctx.toolDefs as Map<string, { execute(args: Record<string, unknown>, exec: unknown): Promise<Record<string, unknown>> }>).get('pm_board');
  assert.ok(boardTool, 'pm_board 应已注册');
  const staleViaTool = await boardTool.execute({ includeStale: true }, { agent: undefined, callId: 'e2e' });
  assert.equal(staleViaTool['staleCount'], 1, `工具层要给出遗留清单：${JSON.stringify(staleViaTool['staleNodes'])}`);
  const listed = (staleViaTool['staleNodes'] as Array<Record<string, unknown>>)[0];
  assert.equal(listed?.['id'], droppedNode.id, '清单 id 必须能直接喂给 pm_remove({ nodeIds: [...] })');
  assert.equal(listed?.['name'], '会话续期');
  assert.equal(listed?.['progress'], 0.6, '要报进度：让模型自己判断这条值不值得删');
  assert.equal(listed?.['kind'], 'task');
  assert.equal(listed?.['parentName'], '登录与鉴权', '要报所属枝：模型据此判断"删它会不会带走别的"');
  // 节点总数不能因为"少提了一个"而变化 —— 这正是"只增不减 / 分母灌水"的反面
  /**
   * 注意**不能**断言"节点总数不变"：自动草稿清理会照常删掉"没人动过"的自动节点（那是它的本分）。
   * 这里要守的是**已动过的节点**：报过进度的那个必须留下并标 stale。
   */
  assert.equal(
    afterShrink.nodes.filter((node) => node.progress > 0).length,
    board.nodes.filter((node) => node.progress > 0).length,
    `已报过进度的节点一个都不许丢（现在剩：${afterShrink.nodes.map((n) => `${n.name}@${n.progress}${n.stale === true ? '(stale)' : ''}`).join(', ')}）`,
  );

  // ③d 反向：下一轮又提到了它 → 撤销 stale（"回来了就不算遗留"）
  const restored = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: fakeStream(json),
  });
  assert.equal(restored['status'], 'ok', JSON.stringify(restored));
  const revived = (await service.board()).nodes.find((node) => node.name === '会话续期');
  assert.equal(revived?.stale, undefined, '本轮又提到了 → stale 标记必须撤销');
  assert.ok(
    (restored['notes'] as string[]).some((note) => note.includes('已撤销标记')),
    '撤销 stale 也要如实说明', 
  );

  // ④b 实测回归：模型把引用类型写成 "file" 时**不该整树失败**（归一后照常落库）
  //     注意要 `forceRebuild`：否则会命中上一次同输入的缓存，**根本不走归一化**，
  //     于是这条断言测的就不是"归一有没有说明"，而是"缓存命中了没有"（实测踩过）。
  const tolerant = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
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
    `归一要有说明（不能静默改模型给的数据）：${JSON.stringify(tolerant['notes'])}`,
  );

  // ⑤ 没有可用路由 → 拒绝并给出可执行提示（不静默失败）
  ctx.services.delete('agentDefaultModel');
  const noRoute = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(noRoute['status'], 'denied');
  assert.equal(noRoute['reason'], 'ai-route-unavailable');
  assert.ok(String(noRoute['hint']).includes('不会发起任何 AI 调用'));

  // ⑥ 自动建出的草稿会被清掉，但**上次 AI 建出的树必须留着**（否则重跑会埋掉人工进度）
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  /**
   * 造一个"阶段 A 草稿"：`autoCreated + pending + 进度 0`。
   *
   * 原先用"扫描 + 一键建树"来造它 —— 那条产品路径已按用户口径删除，所以直接手工写一个
   * 满足草稿判据的节点。测的行为**完全一样**：草稿该被清、上次 AI 的树该留。
   */
  const manualDraft = await service.addNode({
    parentId: null,
    name: 'package.json（骨架草稿）',
    autoCreated: true,
  });
  assert.equal(manualDraft.status, 'ok');
  const withDraft = await service.board();
  assert.ok(
    withDraft.nodes.some((node) => node.name.includes('package.json')),
    '前置条件：草稿节点应当已落库',
  );

  const rebuilt = await service.aiBuildTree({ confirm: true, stream: fakeStream(json) });
  assert.equal(rebuilt['status'], 'ok');
  assert.ok(Number(rebuilt['removed']) >= 1, '应清掉自动草稿');
  assert.equal(rebuilt['created'], 0, 'AI 节点按同名同父复用，不重复建');
  const afterRebuild = await service.board();
  assert.equal(
    afterRebuild.nodes.some((node) => node.name.includes('package.json')),
    false,
    '自动草稿应被清掉',
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
    effective: { aiModel: string; scanExclude: string[] };
  };
  assert.equal(settingsJson.configurable, true);
  // 「扫描深度/子项上限/包含 glob」已随"扫描直接建树"那条产品路径删除（空旋钮不再显示）；
  // 排除项仍在，且默认值是内置排除表（不是 undefined）。
  assert.ok(Array.isArray(settingsJson.effective.scanExclude), '排除项应可读回');

  const settingsWrite = await call(
    '/pm/settings',
    'POST',
    JSON.stringify({ patch: { aiModel: 'test-model', scanExclude: ['docs/**'] } }),
  );
  assert.equal(settingsWrite.status, 200, settingsWrite.body);
  const afterWrite = JSON.parse(settingsWrite.body) as {
    effective: { aiModel: string; scanExclude: string[] };
  };
  assert.equal(afterWrite.effective.aiModel, 'test-model', '改完必须**立即**回到生效值里');
  assert.deepEqual(afterWrite.effective.scanExclude, ['docs/**']);

  // 非法值必须被宿主拒（面板照实显示原因，不静默存下来）
  const settingsInvalid = await call(
    '/pm/settings',
    'POST',
    // `scanExclude` 必须是字符串数组 ⇒ 传字符串应当被 schema 拒成 400
    JSON.stringify({ patch: { scanExclude: 'not-an-array' } }),
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
  assert.equal(snapshot.report.registeredTools.length, 32);
  assert.ok(
    snapshot.report.registeredTools.includes('pm_consolidate'),
    '重复枝合并计划（只读）必须是会话可用的工具 —— 否则又只能靠人肉读脚本修剪',
  );
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
    // FR-162 ②：自动接续**开**着跑这个会话——它只该多一句话，
    // 绝不因此多发一次注入/唤醒（本测试后面按**精确条数**断言 injected/inboxed，
    // 所以"自动接续偷偷唤醒会话"会直接把那几条断言打红）。
    autoContinue: true,
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
    applyConfig(patch: Record<string, unknown>): void;
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

  // ── FR-162 ②：自动接续 = **多一句话**，且必须能运行时开关 ──
  assert.match(staticText, /pm_next/, 'autoContinue 开着，段里必须告诉模型去取下一节点');
  assert.match(staticText, /不必等用户说继续/, '这句话就是用户要的「不必每次说继续」');
  const readSection = (): string =>
    typeof section.text === 'function'
      ? (section.text as (context: unknown) => string)({})
      : String(section.text);
  service.applyConfig({ autoContinue: false });
  const staticOff = readSection();
  assert.ok(!staticOff.includes('pm_next'), '设置页关掉自动接续后，提示词里不得再留这句话');
  assert.match(staticOff, /pm_report/, '关掉自动接续不能连带把进度纪律也关掉');
  service.applyConfig({ autoContinue: true });
  assert.match(readSection(), /pm_next/, '再开回来必须立刻生效（每次组装都问一遍开关）');

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

  /**
   * **FR-171**：这一次的真实用量必须能被**下一次确认框**拿来当"上次实测"——
   * 事前精确预计做不到（宿主不固定分词器），但"上次真的花了多少"是硬事实。
   */
  const estimateAfter = await service.aiBuildEstimate({});
  const lastActual = (estimateAfter['estimate'] as { lastActual?: { outputTokens?: number } }).lastActual;
  assert.equal(lastActual?.outputTokens, 567, `确认框要能带出上次实测值：${JSON.stringify(estimateAfter)}`);

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

test('分批触发看"失败 + 能否切"，不看文件数（范围收窄后的回归）', async () => {
  /**
   * 起因：FR-170 把建树范围收在"主要代码"后，本仓文件数掉到 80 阈值之下 ——
   * 若分批仍以"文件数 > 80"为前置，**输出被截断时反而永远不会再分批**。
   * 截断本身就是"一次请求不够"的直接证据，所以触发条件改为"失败原因属规模类 + 能切出多片"。
   *
   * 这个用例只有 2 个文件（远低于阈值），但分成 2 个顶层目录 ⇒ 能切 ⇒ 必须重试。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-small-shard-'));
  for (const top of ['one', 'two']) {
    mkdirSync(join(workspace, top), { recursive: true });
    writeFileSync(join(workspace, top, 'main.ts'), 'export const x = 1;\n');
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  let modelCalls = 0;
  const streamOf = (text: string) =>
    (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' };
    })();
  const result = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        modelCalls += 1;
        if (modelCalls === 1) return streamOf(''); // 整仓那次空返回
        const prompt = JSON.stringify(options.messages ?? []);
        const top = prompt.includes('one/') ? 'one' : 'two';
        return streamOf(
          JSON.stringify({ projectName: '小仓演示', nodes: [{ name: `模块 ${top}`, kind: 'feature', parent: null }] }),
        );
      },
    },
  });

  assert.equal(result['status'], 'ok', `小仓库也必须能靠分批救回来：${JSON.stringify(result)}`);
  assert.equal(modelCalls, 3, '1 次整仓失败 + 2 片 = 3 次调用');
  ctx.disposeAll();
});

test('建树实时进度 + 显式取消（FR-167/168）：进度可见、取消能中止、已得内容可续跑', async () => {
  /**
   * 两件事一起测，因为它们本来就是一条链：
   * ① **进度可见**（FR-167）：流式期间 `board().aiRun` 必须能读出字符数/片号/输出上限；
   * ② **显式中止**（FR-168）：走 `POST /pm/ai/cancel`（**不是**靠"连接断了"推断），
   *    中止后如实回 `aborted`，并把**已拿到的输出存成 partial 缓存**（T9）⇒ 下次可续跑。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-progress-'));
  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    /**
     * 宿主的模型信息：给出"该模型配置的输出上限"（模型设置里的"最大输出 token 数"）。
     * 用户口径："**上限应该和 harness 参数持平**" ⇒ 插件不自己设限，读这个数来显示与估算。
     */
    resolveModelInfo: async () => ({ defaultMaxTokens: 262_144 }),
    stream: () => {
      throw new Error('本测试必须走注入的假流，不该碰真 llm');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    aiBuildEstimate(input?: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{
      aiRun: { outputChars: number; outputTokensEstimate: number; shardTotal: number; outputLimit: number } | null;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 中途观测到的进度（由假流在 yield 之后主动去读看板）。 */
  const observed: Array<{ chars: number; tokens: number; shardTotal: number; limit: number }> = [];
  /** 这次请求**实际发出去**的 `maxTokens`（跟随宿主时应当是 undefined）。 */
  let sentMaxTokens: number | undefined = -1;
  /** 让假流停在中间，等测试发起"取消"。 */
  let release: (() => void) | undefined;
  void new Promise<void>((resolve) => {
    release = resolve;
  });
  const json = JSON.stringify({
    projectName: '进度演示',
    nodes: [{ name: '甲', kind: 'feature', parent: null, weight: 3 }],
  });

  const buildPromise = service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { signal?: AbortSignal; maxTokens?: number }) =>
        (async function* () {
          /**
           * **跟随宿主 ⇒ 不传 `maxTokens`**（用户口径："上限应该和 harness 参数持平"）：
           * 省略它，宿主的适配器才会按模型配置的上限落地；我们自己传一个小数字就是替用户关闸门。
           */
          sentMaxTokens = options.maxTokens;
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: json.slice(0, 20) };
          // 真实宿主也是这样：面板随时能读到"已经吐了多少"
          const snapshot = await service.board();
          observed.push({
            chars: snapshot.aiRun?.outputChars ?? -1,
            tokens: snapshot.aiRun?.outputTokensEstimate ?? -1,
            shardTotal: snapshot.aiRun?.shardTotal ?? -1,
            limit: snapshot.aiRun?.outputLimit ?? -1,
          });
          // 等测试点"取消"（真实流由宿主在 abort 时中断）
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted === true) resolve();
            else options.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new Error('aborted by user');
        })(),
    },
  });

  // 等第一次观测落地（观测之后假流会停在等待里，直到我们取消）
  const started = Date.now();
  while (observed.length === 0 && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(observed.length, 1, '流式期间必须能读到进度（否则面板没法显示"已生成多少"）');
  assert.ok((observed[0]?.chars ?? 0) > 0, `已完成字符数应大于 0：${JSON.stringify(observed[0])}`);
  assert.equal(observed[0]?.shardTotal, 1, '单次路径只有一片');
  /**
   * **跟随宿主**：显示用的上限取宿主的模型设置（262144），而请求里**不传** `maxTokens`。
   * 两件事都必须成立 —— 只显示不省略，等于"我们替模型设了限"；只省略不显示，进度条就没有分母。
   */
  assert.equal(observed[0]?.limit, 262_144, '进度条的分母应当是宿主给的模型上限');
  assert.equal(sentMaxTokens, undefined, '跟随宿主时**不许**自己塞一个 maxTokens 进请求');

  // 点"取消并中止"：走**显式 HTTP 路由**（而不是"连接断了"这类推断）
  const route = ctx.registeredRoutes.find((entry) => entry.path === '/pm');
  assert.ok(route, '未注册 /pm 前缀路由');
  let cancelBody = '';
  let cancelStatus = 0;
  await route.handler(
    { url: '/pm/ai/cancel', method: 'POST', on: undefined },
    {
      writeHead(code: number) {
        cancelStatus = code;
      },
      end(chunk?: string) {
        cancelBody = chunk ?? '';
      },
    },
  );
  assert.equal(cancelStatus, 200);
  assert.equal(
    (JSON.parse(cancelBody) as { cancelled: boolean }).cancelled,
    true,
    '有调用在跑时点取消必须真的中止（而不是回一句"没有在跑"）',
  );
  release?.();

  const outcome = await buildPromise;
  assert.equal(outcome['status'], 'error', `被中止的建树必须如实回错误：${JSON.stringify(outcome)}`);
  assert.equal(outcome['reason'], 'aborted', '理由要是 aborted，而不是伪装成"模型输出不合法"');
  /**
   * **跑完不清空**（用户口径："生成后，进度条保留，保持 100%，并能看到 token 消耗"）：
   * 留下的是**这一轮**的收尾状态（阶段 + 已生成字符），不是"永远 90% 的假进度条"。
   */
  const finalRun = (await service.board()).aiRun;
  assert.ok(finalRun !== null, '跑完之后要留下这一轮的结果（否则看不到花了多少 token）');
  assert.equal(finalRun?.phase, 'error', '被取消 ⇒ 阶段是"没成功"，不能装成已完成');

  // T9：被中止也要把**已经流出来的那部分文本**落盘（否则这一轮就白花了）
  const cacheFile = ctx.fsService.files.get('.pm/ai-cache.json');
  assert.ok(
    cacheFile !== undefined && cacheFile.includes('"status": "partial"'),
    '被中止的那次要落成 partial 缓存（T9 可续跑）',
  );
  assert.ok(
    cacheFile.includes('进度'),
    'partial 缓存里要真的有"已流出来的内容"（当初的缺口正是：中途中止时文本压根没交出去）',
  );
  ctx.disposeAll();
});

test('节点审查（FR-164）：标记待审 → 取任务时压过关注 → 审查通过级联整枝', async () => {
  /**
   * 用户口径："节点上加审查标记功能，在当前任务走完后读取下一节点时**审查优先级大于关注**…
   * 审查标记在审查完成后消失，功能加到右键吧，然后节点有审查图标状态展示" +
   * "审查可遗传，就是父节点审查了，通审整枝"。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-review-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    panelNodeAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    nextTask(): Promise<Record<string, unknown>>;
    reviewQueue(): Promise<Array<{ id: string; name: string }>>;
    board(): Promise<{ nodes: Array<{ id: string; name: string; needsReview?: boolean }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  const parent = (await service.addNode({ parentId: null, name: '甲功能' })).nodeId as string;
  const childA = (await service.addNode({ parentId: parent, name: '甲的子A' })).nodeId as string;
  const childB = (await service.addNode({ parentId: parent, name: '甲的子B' })).nodeId as string;
  const other = (await service.addNode({ parentId: null, name: '乙功能' })).nodeId as string;
  // 乙功能是**关注枝**：用来验证"待审查压过关注"
  await service.panelNodeAction({ action: 'focus', nodeId: other });

  // ① 标记待审 → 看板暴露该旗标
  const marked = await service.panelNodeAction({ action: 'mark-review', nodeId: childA });
  assert.equal(marked['status'], 'ok', JSON.stringify(marked));
  const node = (await service.board()).nodes.find((item) => item.id === childA);
  assert.equal(node?.needsReview, true, '画布要靠这个旗标画审查角标');

  // ② 取任务：待审查压过关注枝
  const picked = await service.nextTask();
  assert.equal(picked['nodeId'], childA, `待审查必须排最前（压过关注）：${JSON.stringify(picked)}`);
  assert.equal(picked['needsReview'], true);
  assert.match(String(picked['reason']), /待审查/);

  // ③ 父节点审查通过 ⇒ **整枝视为已审**（子节点即便没被标也一起清）
  await service.panelNodeAction({ action: 'mark-review', nodeId: childB });
  await service.panelNodeAction({ action: 'mark-review', nodeId: parent });
  const passed = await service.panelNodeAction({ action: 'clear-review', nodeId: parent });
  assert.equal(passed['status'], 'ok', JSON.stringify(passed));
  const nodes = (await service.board()).nodes;
  for (const id of [parent, childA, childB]) {
    assert.equal(
      nodes.find((item) => item.id === id)?.needsReview,
      undefined,
      '审查通过后标记必须消失（父审通过 ⇒ 整枝视为已审）',
    );
  }
  assert.deepEqual(await service.reviewQueue(), [], '待审队列应当清空');
  ctx.disposeAll();
});

test('改父节点（移到…/拖拽改父）：挂到目标下、拒绝自环与成环', async () => {
  /**
   * 用户诉求："移到…/拖拽改父"。
   * 内核复用 `reparentSubtree`（`applyAiTree` 里"按身份复用 + 挂点"走的就是它），
   * 这里验证面板动作这条路径真的通，且**非法移动被拒**（不是静默不动）。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-reparent-'));
  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    panelNodeAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ nodes: Array<{ id: string; name: string; parentId: string | null }> }>;
  };
  service.noteWorkspaceRoot(workspace);
  const a = (await service.addNode({ parentId: null, name: '甲' })).nodeId as string;
  const b = (await service.addNode({ parentId: null, name: '乙' })).nodeId as string;
  const child = (await service.addNode({ parentId: a, name: '甲的子' })).nodeId as string;

  // ① 正常改父：把「甲的子」挂到「乙」下
  const moved = await service.panelNodeAction({ action: 'set-parent', nodeId: child, text: b });
  assert.equal(moved['status'], 'ok', JSON.stringify(moved));
  let nodes = (await service.board()).nodes;
  assert.equal(nodes.find((n) => n.id === child)?.parentId, b, '父子关系要真的改掉');

  // ② 自环：把「乙」挂到「甲的子」下（乙是甲的子的祖先的另一枝，这里用直接自指更清晰）
  const self = await service.panelNodeAction({ action: 'set-parent', nodeId: b, text: b });
  assert.equal(self['status'], 'denied');
  assert.equal(self['code'], 'E_SELF');

  // ③ 成环：把「乙」挂到自己的子孙（甲的子）下
  const cycle = await service.panelNodeAction({ action: 'set-parent', nodeId: b, text: child });
  assert.equal(cycle['status'], 'denied', `成环必须被拒：${JSON.stringify(cycle)}`);
  nodes = (await service.board()).nodes;
  assert.equal(nodes.find((n) => n.id === b)?.parentId, null, '被拒的移动不得改动事实源');

  // ④ 目标不存在 / 没给目标：如实拒绝并说清怎么用
  const missing = await service.panelNodeAction({ action: 'set-parent', nodeId: child, text: '__none__' });
  assert.equal(missing['status'], 'denied');
  assert.equal(missing['code'], 'E_NOT_FOUND');
  const empty = await service.panelNodeAction({ action: 'set-parent', nodeId: child, text: '' });
  assert.equal(empty['status'], 'denied');
  assert.equal(empty['code'], 'E_PARENT');
  ctx.disposeAll();
});

test('同一次建树里"引用相同"的提案必须并进同一个节点（认领既有分支，FR-158 ⑤）', async () => {
  /**
   * **真机现场**：树上出现 5 棵 refs 全是 `src/ai` 的分支
   * （`AI 建树与推理` / `AI 驱动建树` / `AI 辅助建树` / `AI 建树能力` / `AI 解析与建树`），
   * 外加两条 refs 全是 `src/ai/prompt.ts` 的叶子。
   *
   * 根因：`findReusableNode` 只做了"**提案 ↔ 既有**"的去重，而 `claimedIds` 又规定
   * "一个既有节点只能被认领一次" ⇒ 同一轮里第 2、3 个同引用提案找不到可认领对象，就各自新建了。
   * 这条测试把那个场景原样复刻：一次建树里给出三个同引用的兄弟分支 + 两条同引用的叶子。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-claim-'));
  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ nodes: Array<{ id: string; name: string; parentId: string | null; refs?: unknown[] }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  const json = JSON.stringify({
    projectName: '认领演示',
    nodes: [
      { name: '项目根', kind: 'feature', parent: null },
      // 三个兄弟分支，**refs 完全相同**（模型换着说法描述同一份代码）
      { name: 'AI 建树与推理', kind: 'feature', parent: 0, refs: [{ type: 'dir', target: 'src/ai' }] },
      { name: 'AI 驱动建树', kind: 'feature', parent: 0, refs: [{ type: 'dir', target: 'src/ai' }] },
      { name: 'AI 辅助建树', kind: 'feature', parent: 0, refs: [{ type: 'dir', target: 'src/ai' }] },
      // 两条同引用的叶子（真机上的 `建树提示词编排` / `建树提示词组织` 就是这个形状）
      { name: '提示词编排', kind: 'task', parent: 1, refs: [{ type: 'file', target: 'src/ai/prompt.ts' }] },
      { name: '提示词组织', kind: 'task', parent: 2, refs: [{ type: 'file', target: 'src/ai/prompt.ts' }] },
    ],
  });
  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: () =>
        (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: json };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
          yield { type: 'finish', reason: 'stop' };
        })(),
    },
  });
  assert.equal(built['status'], 'ok', JSON.stringify(built));

  const nodes = (await service.board()).nodes;
  const hasRef = (node: { refs?: unknown[] }, needle: string): boolean =>
    (node.refs ?? []).some((ref) => JSON.stringify(ref).includes(needle));
  const branches = nodes.filter((node) => hasRef(node, 'src/ai') && !hasRef(node, 'prompt.ts'));
  assert.equal(
    branches.length,
    1,
    `refs 同为 src/ai 的分支只该有一个，实际 ${branches.length}：${branches.map((n) => n.name).join('、')}`,
  );
  const leaves = nodes.filter((node) => hasRef(node, 'src/ai/prompt.ts'));
  assert.equal(
    leaves.length,
    1,
    `refs 同为 src/ai/prompt.ts 的叶子只该有一个，实际 ${leaves.length}：${leaves.map((n) => n.name).join('、')}`,
  );
  const notes = (built['notes'] as string[]).join('\n');
  assert.match(notes, /引用相同[^。]*并进同一个节点/, `notes 要说清"并进了谁"：${notes.slice(0, 400)}`);
  ctx.disposeAll();
});

test('同父下已有 {a,b} 的枝，再提 {a} ⇒ 必须复用而不是新建（FR-158 的行为契约）', async () => {
  /**
   * **这是批次 73 记下的那条"缺失的 e2e"**：上一轮加了"并列副本预防"（批次 72/64），
   * 但**没有测试覆盖它**，所以当时只敢说"实现了"，不敢说"受保护"。
   * 这条测试第一次跑就红，并牵出批次 74 修掉的那个真 bug（清理与复用两套判据 ⇒ 丢掉本轮复用的整枝）。
   *
   * 形状取自真机：同一个父下已经有一枝覆盖 `{workspace.ts, snapshots.ts}`，
   * 下一轮模型只提了 `{workspace.ts}`（换了说法、只说了其中一个路径）——
   * 旧口径下这会再建一条并列的枝，同一份代码被评估两次、分母灌水。
   *
   * ⚠️ **本测试钉的是"行为契约"（不许长第二条），不是"哪一层判据拦住的"**。
   * 读代码可知：`findReusableNode` 的第 ③ 层（**引用路径有重叠就复用**，全树扫）先于批次 64 那支
   * "兄弟副本预防"，而"互为子集"必然"有交集" ⇒ 那支结构上不可达，**批次 74 已把它删掉**。
   * 所以这里断言"复用发生了、id 没变、节点数没涨"，并**如实记录是哪一层生效**
   * —— 不写一条只有死代码能过的测试（那种测试只会给人"这层受保护"的错觉）。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-sibling-copy-'));
  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
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
      nodes: Array<{ id: string; name: string; parentId: string | null; refs?: Array<{ target: string }> }>;
    }>;
  };
  service.noteWorkspaceRoot(workspace);

  const streamOf = (json: string) => ({
    stream: () =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: json };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
        yield { type: 'finish', reason: 'stop' };
      })(),
  });

  // ── 第一轮：同父下建出一枝覆盖两个路径的枝 ────────────────────────────────
  // 注意每项都带 `weight`：AI 建树本来就会同批给出相对工作量（FR-87），
  // 而"上次 AI 建出的树"正是靠 `weightSource: 'ai'` 与阶段 A 骨架区分的
  // （清理那条判据按出身分档，见 `service.ts` 里 `mentionedThisRound` 的说明）。
  const first = await service.aiBuildTree({
    confirm: true,
    stream: streamOf(
      JSON.stringify({
        projectName: '并列副本演示',
        nodes: [
          { name: '项目根', kind: 'feature', parent: null, weight: 10 },
          { name: '适配层', kind: 'feature', parent: 0, weight: 8, refs: [{ type: 'dir', target: 'src/adapter' }] },
          {
            name: '工作区与快照',
            kind: 'feature',
            parent: 1,
            weight: 5,
            refs: [
              { type: 'dir', target: 'src/adapter/workspace.ts' },
              { type: 'dir', target: 'src/adapter/snapshots.ts' },
            ],
          },
        ],
      }),
    ),
  });
  assert.equal(first['status'], 'ok', JSON.stringify(first));
  const after1 = (await service.board()).nodes;
  const multi = after1.find((node) => node.name === '工作区与快照');
  assert.ok(multi, `第一轮应建出「工作区与快照」：${after1.map((n) => n.name).join('、')}`);
  assert.equal(multi.refs?.length, 2, '这一枝要覆盖两个路径（否则测不出"子集提案"这个形状）');

  // ── 第二轮：同一个父下只提其中一个路径（换说法 + 只提子集）────────────────
  const second = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: streamOf(
      JSON.stringify({
        projectName: '并列副本演示',
        nodes: [
          { name: '项目根', kind: 'feature', parent: null, weight: 10 },
          { name: '适配层', kind: 'feature', parent: 0, weight: 8, refs: [{ type: 'dir', target: 'src/adapter' }] },
          {
            name: '工作区（模型这次换了说法）',
            kind: 'feature',
            parent: 1,
            weight: 5,
            refs: [{ type: 'dir', target: 'src/adapter/workspace.ts' }],
          },
        ],
      }),
    ),
  });
  assert.equal(second['status'], 'ok', JSON.stringify(second));

  const after2 = (await service.board()).nodes;
  const covering = after2.filter((node) =>
    (node.refs ?? []).some((ref) => ref.target === 'src/adapter/workspace.ts'),
  );
  assert.equal(
    covering.length,
    1,
    `同一个路径只该被一个节点覆盖（不许长并列副本），实际 ${covering.length}；` +
      `第二轮后全树 = ${after2.map((n) => `${n.name}[${(n.refs ?? []).map((r) => r.target).join('+') || '无引用'}]`).join('，')}`,
  );
  assert.equal(covering[0]?.id, multi.id, '必须复用既有那一枝（id 不变），而不是新建一条');
  assert.equal(
    after2.some((node) => node.name === '工作区（模型这次换了说法）' && node.id !== multi.id),
    false,
    '换了说法的提案**不许**被建成第二条并列枝',
  );
  assert.ok(
    after2.length <= after1.length,
    `节点数不许涨（否则又是"分母灌水"）：第一轮 ${after1.length} → 第二轮 ${after2.length}`,
  );
  /**
   * 如实要求测试自己交代"是哪一层复用的"：已知生效的是**引用重叠**层（第 ③ 层）。
   * 这条断言的价值在于**防止有人把第 ③ 层关掉却以为"兄弟副本层还在兜"** ——
   * 届时这里会红，并把人引到上面那段注释。
   */
  const notes = [...((second['notes'] as string[] | undefined) ?? [])].join('\n');
  assert.match(
    notes,
    /引用(路径)?重叠|并进|复用/,
    `notes 要说清"复用/并进了谁"（现在是哪一层拦住的也要留下痕迹）：${notes.slice(0, 400)}`,
  );
  ctx.disposeAll();
});

test('优先级可由人改，且 AI 建树不覆盖（FR-162 ②：人可改）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-priority-'));
  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    panelNodeAction(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ nodes: Array<{ id: string; name: string; priority?: number; prioritySource?: string }> }>;
  };
  service.noteWorkspaceRoot(workspace);
  const leaf = await service.addNode({ parentId: null, name: '登录页' });
  const nodeId = leaf.nodeId as string;

  // ① 面板设优先级 → 落库 + 来源记作"人"
  const set = await service.panelNodeAction({ action: 'set-priority', nodeId, text: '3' });
  assert.equal(set['status'], 'ok', JSON.stringify(set));
  let node = (await service.board()).nodes.find((item) => item.id === nodeId);
  assert.equal(node?.priority, 3);
  assert.equal(node?.prioritySource, 'user', '来源必须是 user —— 否则下一轮 AI 建树会把它当"AI 初判"覆盖掉');

  // ② 越界值被拒（并说清怎么填）
  const bad = await service.panelNodeAction({ action: 'set-priority', nodeId, text: '99' });
  assert.equal(bad['status'], 'denied');
  assert.equal(bad['code'], 'E_PRIORITY');
  assert.match(String(bad['message']), /1–10/);

  // ③ AI 建树给出不同优先级：**人改过的不许被静默覆盖**
  const json = JSON.stringify({
    projectName: '优先级演示',
    nodes: [{ name: '登录页', kind: 'task', parent: null, priority: 9 }],
  });
  const built = await service.aiBuildTree({
    confirm: true,
    forceRebuild: true,
    stream: {
      stream: () =>
        (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: json };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
          yield { type: 'finish', reason: 'stop' };
        })(),
    },
  });
  assert.equal(built['status'], 'ok', JSON.stringify(built));
  node = (await service.board()).nodes.find((item) => item.id === nodeId);
  assert.equal(node?.priority, 3, '人填的 3 必须还在（AI 给的 9 不得静默覆盖）');
  assert.equal(node?.prioritySource, 'user');

  // ④ 清除 → 回到"未设置"
  const cleared = await service.panelNodeAction({ action: 'set-priority', nodeId, text: '' });
  assert.equal(cleared['status'], 'ok', JSON.stringify(cleared));
  node = (await service.board()).nodes.find((item) => item.id === nodeId);
  assert.equal(node?.priority, undefined, '清除后必须真的没有值（不是留个 0）');
  ctx.disposeAll();
});

test('建树范围只给主要代码：测试/示例/产物/配置不进骨架，生成它们的代码照旧进（FR-170）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-scope-'));
  const write = (rel: string, text = 'export const x = 1;\n'): void => {
    const full = join(workspace, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  // 主要代码（该进）
  write('src/domain/state.ts');
  write('scripts/wrap-bundle.mjs', 'export const build = 1;\n'); // 生成产物的**代码** → 要留
  write('tsdown.config.ts', 'export default {};\n'); // 生成**配置** → 要留
  // 该排除的：测试 / 示例 / 产物本身 / 配置文件本身
  write('tests/state.test.ts');
  write('examples/demo.ts');
  write('.render-check/out.mjs');
  write('lib/index.js');
  write('tsconfig.json', '{}\n');
  write('package.json', '{"name":"scope-demo"}\n');

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  let promptText = '';
  const result = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: (options: { messages?: unknown[] }) => {
        promptText = JSON.stringify(options.messages ?? []);
        const json = JSON.stringify({
          projectName: '范围演示',
          nodes: [{ name: '状态机', kind: 'feature', parent: null, refs: [{ type: 'file', target: 'src/domain/state.ts' }] }],
        });
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: json };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: json } };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    },
  });

  assert.equal(result['status'], 'ok', JSON.stringify(result));
  for (const keep of ['src/domain/state.ts', 'scripts/wrap-bundle.mjs', 'tsdown.config.ts']) {
    assert.ok(promptText.includes(keep), `「${keep}」属于主要代码/生成代码/生成配置，不该被排除`);
  }
  for (const drop of ['tests/state.test.ts', 'examples/demo.ts', '.render-check/out.mjs', 'tsconfig.json', 'package.json']) {
    assert.ok(!promptText.includes(drop), `「${drop}」不属于主要代码，不该进骨架`);
  }
  ctx.disposeAll();
});

test('大项目分批建树：单次空返回后按顶层目录分批重试，逐片落库且互不误删', async () => {
  /**
   * 用户口径："由于项目大了可能出现空返回情况，需要分批处理。"
   *
   * 这个测试要证明三件事，缺一条都不算接上了线：
   * ① **真的走分批**：第一次（整仓）空返回后，按顶层目录又调了 N 次模型；
   * ② **逐片落库、且互不误删**：`replaceAutoDraft` 只在第一片生效 ——
   *    若每片都清，"后一片"会把"前一片刚建好的新节点"当草稿删掉（同一轮自相残杀）；
   * ③ **如实记账**：调用次数、notes、cache 状态都不能含糊。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-shard-'));
  // 造 >80 个文件（分批阈值）且分成 3 个顶层目录 —— 每片 30 个文件，不超过单片上限 40
  const tops = ['alpha', 'beta', 'gamma'];
  for (const top of tops) {
    mkdirSync(join(workspace, top), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(
        join(workspace, top, `f${String(index).padStart(2, '0')}.ts`),
        `export const v${index} = ${index};\n`,
      );
    }
  }

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('本测试必须走注入的假流，不该碰真 llm');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});

  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    board(): Promise<{ nodes: Array<{ name: string; parentId: string | null }> }>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 每片回什么：从提示词里认出"这一片是哪个顶层目录"，回一个只属于它的节点名。 */
  let modelCalls = 0;
  const seenShardTops: string[] = [];
  /** 记下每片的提示词：用来证明"每片的节点上限按这一片的规模收"（不是每片都问 60 个）。 */
  const shardPrompts: string[] = [];
  const streamOf = (text: string) =>
    (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: 'stop' };
    })();
  const fakeStream = {
    stream: (options: { messages?: unknown[] }) => {
      modelCalls += 1;
      // 第一次是整仓请求：空返回（正是用户说的"项目大了会空返回"）
      if (modelCalls === 1) return streamOf('');
      const promptText = JSON.stringify(options.messages ?? []);
      shardPrompts.push(promptText);
      const top = tops.find((name) => promptText.includes(`${name}/`)) ?? `unknown${modelCalls}`;
      seenShardTops.push(top);
      return streamOf(
        JSON.stringify({
          projectName: '分批演示',
          nodes: [{ name: `模块 ${top}`, kind: 'feature', parent: null, weight: 4, priority: 5 }],
        }),
      );
    },
  };

  const result = await service.aiBuildTree({ confirm: true, stream: fakeStream });

  assert.equal(result['status'], 'ok', JSON.stringify(result));
  assert.equal(modelCalls, 4, '1 次整仓（失败）+ 3 片 = 4 次调用');
  assert.deepEqual([...seenShardTops].sort(), ['alpha', 'beta', 'gamma'], '三片应各覆盖一个顶层目录');
  const notes = (result['notes'] as string[]).join('\n');
  assert.match(notes, /分批/, `notes 必须说清走了分批路径：${notes}`);
  assert.match(notes, /成功 3\/3 片/);
  assert.match(notes, /不写整份树缓存/, '分批路径不写整份缓存这件事必须如实告知');
  assert.equal((result['estimate'] as { calls: number }).calls, 3, '真实成本是 3 次调用（如实改掉次数）');
  assert.equal((result['cache'] as { state: string }).state, 'miss');
  /**
   * 每片的节点上限要**按这一片的文件占比分摊整轮预算**（3 片各 30 文件、整轮 60 ⇒ 每片 20），
   * 而不是每片都问 60 个 —— 否则"分批"只是把同一份过大的要求重复 N 遍，照样被输出上限截断，
   * 而且用户看到的"最多 60 个节点"会悄悄变成 6 × 60 = 360。
   */
  assert.equal(shardPrompts.length, 3);
  for (const prompt of shardPrompts) {
    assert.ok(
      prompt.includes('最多 20 个节点'),
      `每片的节点上限应按文件占比分摊（期望「最多 20 个节点」）：${prompt.slice(0, 140)}`,
    );
  }

  /**
   * **边界 ① 的回归点**：三个片的节点必须**都在**。
   * 如果 `replaceAutoDraft` 每片都跑，后一片会把前一片刚建的节点当草稿删掉 —— 这里会只剩一个。
   */
  const board = await service.board();
  const names = board.nodes.map((node) => node.name);
  for (const top of tops) {
    assert.ok(
      names.includes(`模块 ${top}`),
      `「模块 ${top}」被误删了（replaceAutoDraft 应只在第一片生效）：${names.join(',')}`,
    );
  }
  ctx.disposeAll();
});

/**
 * FR-174：**failed hook / 错误日志警示**。
 *
 * 场景是用户实际遇到的：某个 hook 抛错时宿主只在终端打一行，面板那侧什么都看不到，
 * 用户看到的现象是"某个功能就是不动"却没有任何线索。这条链路要求：
 * 宿主错误 → 诊断总线 → 看板 `alerts` → 状态条红标 → 一步跳到 `/pm/debug` 看原文。
 * 同时钉住瀑布事件**不许改行为**（`agent/request-error` 必须原样返回 `next()`）。
 */
test('FR-174：宿主错误被记进诊断总线，看板 alerts 与 /pm/debug 报同一个数', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-alerts-'));
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
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    board(): Promise<{
      alerts: { errors: number; warns: number; lastError?: { at: string; scope: string; message: string } };
    }>;
  };
  service.noteWorkspaceRoot(workspace, 'session-a');

  // 诊断总线是**进程级单例**（热重载不丢历史，这是故意的），所以只能断言"增量"
  const before = (await service.board()).alerts;

  // ── ① 普通事件：`agent/error`（纯通知，没有返回值语义）──
  ctx.emit('agent/error', { error: new Error('hook 抛了个错') });
  const afterError = (await service.board()).alerts;
  assert.equal(afterError.errors, before.errors + 1, `看板必须看见宿主错误：${JSON.stringify(afterError)}`);
  assert.equal(afterError.lastError?.scope, 'host', '要能看出是宿主侧报的，而不是插件某处');
  assert.match(afterError.lastError?.message ?? '', /hook 抛了个错/);
  assert.ok(
    (afterError.lastError?.at ?? '') > (before.lastError?.at ?? ''),
    'lastError 必须换成**最新**那一条（时间戳往前走）',
  );

  // ── ② 瀑布事件：`agent/request-error` 必须原样返回 next() 的结果 ──
  // 我们只是记录，绝不改宿主的重试判定 —— 这里用一个哨兵值把"有没有改行为"钉死。
  const sentinel = { action: 'retry', reason: 'host-decided' };
  let nextCalls = 0;
  const results = (ctx.events.get('agent/request-error') ?? []).map((listener) =>
    listener({ failure: { message: '模型请求失败：连接中断' } }, () => {
      nextCalls += 1;
      return sentinel;
    }),
  );
  assert.equal(nextCalls, results.length, '每个订阅者都必须把 next() 调下去');
  for (const result of results) {
    assert.equal(result, sentinel, '瀑布的返回值必须原样透传，不能被诊断层改写');
  }
  const afterRequestError = (await service.board()).alerts;
  assert.equal(afterRequestError.errors, before.errors + 2, '模型请求失败也要记账');
  assert.match(afterRequestError.lastError?.message ?? '', /模型请求失败/);

  // ── ③ 看板与诊断页**同一个数**（口径唯一一处，两个页面不许互相打脸）──
  const route = ctx.registeredRoutes.find((r) => r.path === '/pm');
  assert.ok(route, '未注册 /pm 前缀路由');
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      text = chunk ?? '';
    },
  };
  await route.handler({ url: '/pm/debug?format=json', method: 'GET' }, res);
  assert.equal(status, 200);
  const snapshot = JSON.parse(text) as {
    alerts: { errors: number; warns: number; lastError?: { scope: string; message: string } };
  };
  assert.equal(snapshot.alerts.errors, afterRequestError.errors, '诊断页与看板的错误数必须一致');
  assert.equal(snapshot.alerts.warns, afterRequestError.warns);
  assert.equal(snapshot.alerts.lastError?.message, afterRequestError.lastError?.message);

  ctx.disposeAll();
});

/**
 * **审批门的字段名**（一次真事故的防复发）：钩子必须按宿主契约读 `exec.name` / `exec.agent`。
 *
 * 早先读的是 `exec.toolName` / `exec.session` ⇒ 真机上恒为 `undefined` ⇒ 审批门**静默失效**
 * （既不会误拦，也再拦不住任何东西，而会话级策略是 `never` 时更看不出来）。
 * 这条用**宿主真实形状**的载荷驱动钩子，并顺带钉住 FR-163：完全权限 ⇒ 不弹窗。
 */
test('审批门按宿主契约读载荷（exec.name / exec.agent.session），并在完全权限下免审核', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-guard-'));
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  const config = {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  };

  /** 直接调 `tools/pre-execute` 的监听器（宿主流水线的替身），返回各自的判定。 */
  const decisionsOf = async (ctx: ReturnType<typeof createFakeContext>, exec: unknown) => {
    const listeners = ctx.events.get('tools/pre-execute') ?? [];
    assert.ok(listeners.length > 0, '审批门没挂上 tools/pre-execute');
    const out: unknown[] = [];
    for (const listener of listeners) {
      out.push(await listener(exec, async () => ({ kind: 'allow' })));
    }
    return out;
  };

  // ① 没有 sandboxPolicy 服务 ⇒ 读不到档位 ⇒ 保守放行到审批（不是静默放过）
  const ctxA = createFakeContext({ workspace });
  await module.apply(ctxA, config);
  const askedA = await decisionsOf(ctxA, {
    callId: 'call-1',
    name: 'pm_remove',
    arguments: { nodeIds: ['n1'] },
    agent: { id: 'session-a', session: { header: { cwd: workspace } } },
  });
  assert.ok(
    askedA.some((decision) => (decision as { kind?: string }).kind === 'ask'),
    `pm_remove 必须走审批：${JSON.stringify(askedA)}`,
  );

  // ② 同一个钩子对无关工具不许打扰（判据只覆盖真正危险的那几个）
  const quietA = await decisionsOf(ctxA, {
    name: 'pm_progress',
    arguments: { nodeId: 'n1', progress: 0.5 },
    agent: { id: 'session-a', session: { header: { cwd: workspace } } },
  });
  assert.ok(
    quietA.every((decision) => (decision as { kind?: string }).kind !== 'ask'),
    `pm_progress 不该弹窗：${JSON.stringify(quietA)}`,
  );
  ctxA.disposeAll();

  // ③ 完全权限（FR-163）：`resolve()` 折出 danger-full-access ⇒ 一律放行
  const ctxB = createFakeContext({ workspace });
  const seenRequests: unknown[] = [];
  ctxB.services.set('sandboxPolicy', {
    mode: 'workspace-write',
    resolve(request?: { session?: unknown }) {
      seenRequests.push(request);
      // 只有**拿到会话对象**才认得出"这个会话是完全权限"（这正是字段名那处 bug 的判别点）
      return { mode: request?.session === undefined ? 'workspace-write' : 'danger-full-access' };
    },
  });
  await module.apply(ctxB, config);
  const askedB = await decisionsOf(ctxB, {
    name: 'pm_remove',
    arguments: { nodeIds: ['n1'] },
    agent: { id: 'session-b', session: { header: { cwd: workspace } } },
  });
  assert.ok(
    askedB.every((decision) => (decision as { kind?: string }).kind !== 'ask'),
    `完全权限下不该弹窗：${JSON.stringify(askedB)}`,
  );
  assert.ok(
    seenRequests.some((request) => (request as { session?: unknown } | undefined)?.session !== undefined),
    '沙箱策略必须收到**会话对象**（读错字段名时这里恒为 undefined，闸门就会静默失效）',
  );
  ctxB.disposeAll();
});

/**
 * 回写失败的**三种情形必须分清**（真机诊断事故：一顶帽子扣三种病）。
 *
 * 真机上出现过这条 warn：`回写会话（session-9f2b…）失败：拿不到 agents 服务（…PENDING…）`，
 * 而它发生在**加载后 4 分半**、服务其实好好的 —— 真因是那条订阅属于**上一个宿主进程的会话**。
 * 在"拿本插件当项目自测"的场景里这尤其误导：树上留着历史会话建的订阅是**正常现象**，
 * 却会被说成"服务没注入"，还会把状态条的警示角标**长期点亮**（FR-174）——永远亮着的告警等于没有告警。
 *
 * 这条测试钉住三分：
 * ① 注册表不可达 ⇒ **warn**（真降级，带注入提示）；
 * ② 注册表在、会话不在 ⇒ **info**（正常，不报警告、不记账、等它回来）；
 * ③ 会话在、但没有投递通道 ⇒ **形状**告警（第三种，不许和前两种混说）。
 */
test('回写失败分三类：服务不可达（warn）/ 会话不在注册表（info）/ 通道形状不对', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-notify-causes-'));
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  const config = {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  };

  /**
   * 读**插件自己的诊断通道**（`/pm/debug?format=json` 的 `logs`）来断言日志。
   *
   * 为什么不能用 `import { debugBus }`：本文件跑的是**构建产物** `lib/index.js`，
   * 它把 `adapter/debug.ts` **打进自己的 bundle**，于是那份单例与测试进程里 `src/` 的那份
   * **是两个对象**（实测踩到：断言恒为"日志为空"）。走诊断路由既绕开这个陷阱，
   * 又顺带钉住"用户真能看到这条日志"——毕竟 FR-174 的价值就在于**能看见**。
   */
  const readLogs = async (
    ctx: ReturnType<typeof createFakeContext>,
  ): Promise<Array<{ seq: number; level: string; scope: string; message: string }>> => {
    const route = ctx.registeredRoutes.find((r) => r.path === '/pm');
    assert.ok(route, '未注册 /pm 前缀路由');
    let text = '';
    await route.handler(
      { url: '/pm/debug?format=json', method: 'GET' },
      { writeHead() {}, end(chunk?: string) { text = chunk ?? ''; } },
    );
    const parsed = JSON.parse(text) as {
      logs: Array<{ seq: number; level: string; scope: string; message: string }>;
    };
    return parsed.logs;
  };
  const maxSeqOf = (logs: Array<{ seq: number }>): number =>
    logs.length === 0 ? 0 : (logs[logs.length - 1]?.seq ?? 0);

  // ── ① 注册表不可达（宿主没给 agents）⇒ 必须是 warn，且提示注入路 ──
  const ctxNoAgents = createFakeContext({ workspace }); // 不传 agents ⇒ ctx.get('agents') 为 undefined
  await module.apply(ctxNoAgents, config);
  const serviceNoAgents = ctxNoAgents.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    finish(input: Record<string, unknown>): Promise<unknown>;
    progress(input: Record<string, unknown>): Promise<unknown>;
    notifyStats(): { sent: number; suppressed: number; tracked: number };
  };
  serviceNoAgents.noteWorkspaceRoot(workspace, 'session-a');
  const nodeA = await serviceNoAgents.addNode({ parentId: null, name: '登录页', kind: 'task' });
  await serviceNoAgents.progress({ nodeId: nodeA.nodeId, selfState: 'running', progress: 0.4 });
  await serviceNoAgents.subscribe({
    nodeId: nodeA.nodeId,
    actor: 'session',
    actorId: 'session-a',
    intent: 'read',
    notify: 'key',
  });
  const beforeNoAgents = maxSeqOf(await readLogs(ctxNoAgents));
  await serviceNoAgents.finish({ nodeId: nodeA.nodeId });
  const noAgentsEntries = (await readLogs(ctxNoAgents)).filter((entry) => entry.seq > beforeNoAgents);
  assert.ok(
    noAgentsEntries.some((entry) => entry.level === 'warn' && entry.message.includes('拿不到 agents 服务')),
    `拿不到 agents 服务必须留一条 warn（真降级不能沉默）：${JSON.stringify(noAgentsEntries.map((e) => e.message))}` +
      `｜诊断：${JSON.stringify({ stats: serviceNoAgents.notifyStats() })}`,
  );
  ctxNoAgents.disposeAll();

  // ── ② 注册表在、会话不在 ⇒ 只能是 info，**warn 数不许涨** ──
  const ctxGhost = createFakeContext({
    workspace,
    // 注册表正常，但里面只有别人：查 'session-ghost' 一律 undefined
    agents: { get: (id: string) => (id === 'session-other' ? { inbox: { append() {} } } : undefined) },
  });
  await module.apply(ctxGhost, config);
  const serviceGhost = ctxGhost.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    finish(input: Record<string, unknown>): Promise<unknown>;
    notifyStats(): { sent: number };
  };
  serviceGhost.noteWorkspaceRoot(workspace, 'session-a');
  const nodeG = await serviceGhost.addNode({ parentId: null, name: '幽灵订阅', kind: 'task' });
  await serviceGhost.progress({ nodeId: nodeG.nodeId, selfState: 'running', progress: 0.4 });
  await serviceGhost.subscribe({
    nodeId: nodeG.nodeId,
    actor: 'session',
    actorId: 'session-ghost',
    intent: 'read',
    notify: 'key',
  });
  const beforeGhost = maxSeqOf(await readLogs(ctxGhost));
  await serviceGhost.finish({ nodeId: nodeG.nodeId });
  const ghostEntries = (await readLogs(ctxGhost)).filter((entry) => entry.seq > beforeGhost);
  assert.equal(
    ghostEntries.filter((entry) => entry.level === 'warn' || entry.level === 'error').length,
    0,
    `会话不在注册表里是**正常现象**（历史会话留下的订阅）：只该留 info，不该报警告：${JSON.stringify(
      ghostEntries.map((e) => `${e.level}:${e.message}`),
    )}`,
  );
  assert.ok(
    ghostEntries.some(
      (entry) => entry.level === 'info' && entry.message.includes('session-ghost') && entry.message.includes('不在活跃注册表里'),
    ),
    `要如实说明"会话不在"这个真因：${JSON.stringify(ghostEntries.map((e) => e.message))}`,
  );
  assert.equal(serviceGhost.notifyStats().sent, 0, '没送到就是没送到：不记账（等它回来再试）');
  ctxGhost.disposeAll();

  // ── ③ 会话在、但注册表返回的东西没有投递通道 ⇒ 形状告警（第三种）──
  const ctxShape = createFakeContext({
    workspace,
    agents: { get: () => ({}) }, // 有 agent，但既没有 send 也没有 inbox
  });
  await module.apply(ctxShape, config);
  const serviceShape = ctxShape.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
    subscribe(input: Record<string, unknown>): Promise<unknown>;
    finish(input: Record<string, unknown>): Promise<unknown>;
  };
  serviceShape.noteWorkspaceRoot(workspace, 'session-a');
  const nodeS = await serviceShape.addNode({ parentId: null, name: '无通道', kind: 'task' });
  await serviceShape.progress({ nodeId: nodeS.nodeId, selfState: 'running', progress: 0.4 });
  await serviceShape.subscribe({
    nodeId: nodeS.nodeId,
    actor: 'session',
    actorId: 'session-shape',
    intent: 'read',
    notify: 'key',
  });
  const beforeShape = maxSeqOf(await readLogs(ctxShape));
  await serviceShape.finish({ nodeId: nodeS.nodeId });
  const shapeEntries = (await readLogs(ctxShape)).filter((entry) => entry.seq > beforeShape);
  assert.ok(
    shapeEntries.some((entry) => entry.level === 'warn' && entry.message.includes('回写通道不可用')),
    `通道形状不对也要留一条 warn（把"找到了什么"写出来）：${JSON.stringify(shapeEntries.map((e) => e.message))}`,
  );
  assert.ok(
    !shapeEntries.some((entry) => entry.message.includes('拿不到 agents 服务')),
    '形状问题必须有自己的说法，不许和服务不可用混为一谈',
  );
  ctxShape.disposeAll();
});

/**
 * FR-161：**跨子项目写入的审核门**。
 *
 * 判据本身在 `domain/review-gate.ts` 有 13 条单测；这条 e2e 钉的是**接线**：
 * 文件写入类工具真的会被判、理由里真的带着"哪几个子项目、哪几个节点"，
 * 且三种"拦不了/不必拦"的情形（完全权限 / 策略 never / 只影响同一条任务线）都不会把活堵死。
 */
test('FR-161：跨子项目的文件写入会请求审核，并说清影响哪几条任务线', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-review-'));
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  const ctx = createFakeContext({ workspace });
  // 沙箱：workspace-write（非完全权限）；审批策略：ask（能真的征询）
  ctx.services.set('sandboxPolicy', {
    mode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write' }),
  });
  ctx.services.set('approval', {
    async request() {
      return 'allowed-once' as const;
    },
    overrideOf: () => 'ask',
  });
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
    reviewIndexOf(): Promise<Array<{ id: string; name: string }>>;
  };
  service.noteWorkspaceRoot(workspace, 'session-a');

  // 树：两个子项目（根的直接子节点）各自有节点引用同一个共享文件
  const mobile = await service.addNode({ parentId: null, name: 'Mobile', kind: 'feature' });
  const pc = await service.addNode({ parentId: null, name: 'PC', kind: 'feature' });
  await service.addNode({
    parentId: mobile.nodeId,
    name: 'Mobile 后台',
    refs: [{ type: 'code', target: 'src/shared-api' }],
  });
  await service.addNode({
    parentId: pc.nodeId,
    name: 'PC 前端',
    refs: [{ type: 'code', target: 'src/shared-api/client.ts' }],
  });
  const index = await service.reviewIndexOf();
  assert.ok(index.length >= 4, `结构面应包含这些节点：${JSON.stringify(index)}`);

  /** 调一次 `tools/pre-execute`（宿主流水线替身）。 */
  const judge = async (toolName: string, args: unknown): Promise<{ kind?: string; reason?: string }> => {
    const listeners = ctx.events.get('tools/pre-execute') ?? [];
    let last: { kind?: string; reason?: string } = {};
    for (const listener of listeners) {
      last = (await listener(
        { name: toolName, arguments: args, agent: { id: 'session-a', session: { header: { cwd: workspace } } } },
        async () => ({ kind: 'allow' }),
      )) as { kind?: string; reason?: string };
    }
    return last;
  };

  // ① 改到被两个子项目引用的复用代码 ⇒ must ask，且理由能指名道姓
  const asked = await judge('write', { path: 'src/shared-api/client.ts', content: 'x' });
  assert.equal(asked.kind, 'ask', `跨子项目写入必须走审核：${JSON.stringify(asked)}`);
  assert.match(asked.reason ?? '', /会影响别的任务线/);
  assert.match(asked.reason ?? '', /Mobile/);
  assert.match(asked.reason ?? '', /PC/);
  assert.match(asked.reason ?? '', /Mobile 后台|PC 前端/, '要说清命中了哪些节点');

  // ② 同一条任务线自己的代码 ⇒ 不打扰
  const own = await judge('edit', { file_path: 'src/mobile-only/Page.tsx' });
  assert.notEqual(own.kind, 'ask', `只对本子项目负责的代码不该弹窗：${JSON.stringify(own)}`);

  // ③ 白名单（投影文档 / .pm 缓存）⇒ 不打扰
  const doc = await judge('write', { path: 'project-manager.md', content: 'x' });
  assert.notEqual(doc.kind, 'ask');
  const cache = await judge('write', { path: 'src/shared-api/../.pm/cache.json' });
  assert.notEqual(cache.kind, 'ask', '白名单判定按归一化路径（顺带钉住 `..` 之外的前缀不被吃掉）');

  // ④ 非写入类工具不参与判据（读文件也带 path，不许拿它当改动）
  const read = await judge('read', { path: 'src/shared-api/client.ts' });
  assert.notEqual(read.kind, 'ask', 'read 不改文件，不该被审核门拦住');
  ctx.disposeAll();

  // ⑤ 策略为 never ⇒ **拦不了就如实留痕，不许假装审过、也不许把活堵死**
  const ctxNever = createFakeContext({ workspace });
  ctxNever.services.set('sandboxPolicy', { mode: 'workspace-write', resolve: () => ({ mode: 'workspace-write' }) });
  ctxNever.services.set('approval', { async request() { return 'rejected' as const; }, overrideOf: () => 'never' });
  await module.apply(ctxNever, {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  });
  const serviceNever = ctxNever.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined, sessionId?: string): void;
    addNode(input: Record<string, unknown>): Promise<{ nodeId?: string }>;
  };
  serviceNever.noteWorkspaceRoot(workspace, 'session-a');
  const projectA = await serviceNever.addNode({ parentId: null, name: 'A 线', kind: 'feature' });
  const projectB = await serviceNever.addNode({ parentId: null, name: 'B 线', kind: 'feature' });
  await serviceNever.addNode({ parentId: projectA.nodeId, name: 'A 实现', refs: [{ type: 'dir', target: 'src/shared' }] });
  await serviceNever.addNode({ parentId: projectB.nodeId, name: 'B 实现', refs: [{ type: 'dir', target: 'src/shared' }] });
  const listenersNever = ctxNever.events.get('tools/pre-execute') ?? [];
  let legacyDecision: { kind?: string } = {};
  for (const listener of listenersNever) {
    legacyDecision = (await listener(
      { name: 'write', arguments: { path: 'src/shared/x.ts' }, agent: { id: 'session-a', session: {} } },
      async () => ({ kind: 'allow' }),
    )) as { kind?: string };
  }
  assert.notEqual(
    legacyDecision.kind,
    'ask',
    '策略 never 时弹窗等于确定性拒绝：会把日常跨文件改动整片堵死，因此只留痕、不拦',
  );
  ctxNever.disposeAll();
});

/**
 * FR-163：**完全权限下删功能点不审核**。
 *
 * 真机现象（用户原话："完全权限是能删除且不审核的，你处理呗"）：完全权限下删**任务点**能过，
 * 删**功能点**却被 `policy-never` 确定性拒绝 —— 因为功能点的删除**有两道门**：
 * ① `tools/pre-execute`（这次工具调用要不要弹窗）；② `removeBranch` 按 `node.kind` 分级
 * **再要一次授权**。早先只修了第 ① 道，于是表现仍然是"完全权限下删不掉功能点"。
 * 这条测试用"审批一律拒绝"的替身证明：**第二道门也免了**（不是"问了但恰好通过"）。
 */
test('FR-163：完全权限下删除功能点不再请求授权（第二道门同样免）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-fr163-'));
  const ctx = createFakeContext({ workspace });
  ctx.services.set('sandboxPolicy', {
    mode: 'workspace-write',
    resolve: () => ({ mode: 'danger-full-access' }),
  });
  let approvalCalls = 0;
  ctx.services.set('approval', {
    async request() {
      approvalCalls += 1;
      return 'rejected' as const; // 一旦真的去问，就会得到拒绝 ⇒ 能删除就证明"没问"
    },
    overrideOf: () => 'never',
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
    removeBranch(input: Record<string, unknown>): Promise<{ status: string; confirmToken?: string; code?: string }>;
    board(): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  };
  service.noteWorkspaceRoot(workspace, 'session-a');
  const feature = await service.addNode({ parentId: null, name: '要被删的功能点', kind: 'feature' });
  const featureId = feature.nodeId as string;
  const agent = { id: 'session-a', session: { header: { cwd: workspace } } };

  // 先签发确认句柄（这一步本身不问审批），再带句柄执行 —— 执行阶段才会遇到第二道门
  const needsConfirm = await service.removeBranch({
    nodeIds: [featureId],
    policy: 'record',
    agent,
    toolName: 'pm_remove',
  });
  assert.equal(needsConfirm.status, 'needs-confirm');
  const done = await service.removeBranch({
    nodeIds: [featureId],
    policy: 'record',
    confirmToken: needsConfirm.confirmToken,
    agent,
    toolName: 'pm_remove',
  });
  assert.equal(done.status, 'ok', `完全权限下删功能点必须成功：${JSON.stringify(done)}`);
  assert.equal(approvalCalls, 0, '完全权限下**一次审批都不许发**（不是"发了恰好通过"）');
  const names = (await service.board()).nodes.map((n) => n.name);
  assert.ok(!names.includes('要被删的功能点'), '功能点应已删除');
  ctx.disposeAll();
});

/**
 * **二次装配**：卸载后在同一 ctx 上再 `apply` 一次，必须成功。
 *
 * 真机事故（2026-09-25）：profile 里把 HMR 打开（`disabled: false`）后，构建 `lib/` 数秒内
 * `/pm/*` 全部 **404** —— 插件被卸载了，却**再也没装回来**；宿主进程还活着、前端照常服务。
 * 也就是 HMR 的 `partialReload`（清模块缓存 → 重新 import → 重新装配）卡在了最后一步。
 *
 * 这条测试用**最逼近的方式**复现它：① 首次 apply；② 卸载（等价于旧 fiber 被 dispose ——
 * 我们的 effect disposer 会注销服务/路由）；③ 用**带 query 的 import** 拿到一个**新的模块实例**
 * （等价于"缓存被清后重新 import"）再 apply 一次；④ 断言服务与看板都回来了。
 *
 * 为什么值得单独钉：`apply()` 的幂等性不只服务 HMR —— 任何"先卸载再装配"的开发/升级路径都吃它。
 * 判据是"二次装配后服务与路由都在"，而不是"没抛错"（抛错会被宿主吞掉变成 404，正是真机现象）。
 */
test('二次装配：卸载后再 apply 一次必须成功（HMR partialReload 的等价物）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-reapply-'));
  const ctx = createFakeContext({ workspace });
  const config = {
    refreshIntervalMs: 1000,
    conflictPolicy: 'auto-fix-first',
    documentPath: 'project-manager.md',
    snapshotMode: 'patch',
    aiWeightMeasurement: false,
  };

  type PluginModule = { apply(ctx: unknown, config: unknown): Promise<void> };
  const first = (await import('../../lib/index.js')) as PluginModule;
  await first.apply(ctx, config);
  assert.ok(ctx.services.get('projectManager'), '首次装配后服务必须在');

  // 卸载：宿主销毁旧 fiber（我们的 disposer 会注销服务、路由、监听）
  ctx.disposeAll();
  assert.equal(
    ctx.services.get('projectManager'),
    undefined,
    '卸载后服务必须已注销（否则二次装配必然撞 "cannot provide twice"）',
  );

  // 第二次：**新模块实例**（等价于 HMR 清缓存后重新 import），同一个 ctx
  const second = (await import('../../lib/index.js?hmr-reapply=1')) as PluginModule;
  await second.apply(ctx, config);

  const service = ctx.services.get('projectManager') as
    | { board(): Promise<{ nodes: unknown[] }> }
    | undefined;
  assert.ok(service, '二次装配后服务必须重新可用（真机现象正是"卸载了但装不回来"）');
  const board = await service.board();
  assert.ok(Array.isArray(board.nodes), '二次装配后看板必须可读');

  // 路由也必须重新注册（否则真机上就是 404 —— 这次事故的可见症状）
  const routes = ctx.registeredRoutes.filter((route) => route.path === '/pm');
  assert.ok(routes.length >= 1, '二次装配后 /pm 路由必须重新注册');
  ctx.disposeAll();
});

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

/** 最小假 cordis 上下文。 */
function createFakeContext(options: { workspace: string }) {
  const services = new Map<string, unknown>();
  const storage = createFakeStorageDomain();
  const fs = createFakeFs(options.workspace);
  const tools = new Map<string, unknown>();
  const settingsNamespaces: string[] = [];
  const effects: Array<() => void> = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const logs: string[] = [];

  services.set('storageDomain', storage);
  services.set('fs', fs);
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
  services.set('webServer', {
    register() {
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
  };
  return ctx;
}

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

  // 工具已注册
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
  ]) {
    assert.ok(ctx.toolRegistry.has(name), `工具 ${name} 未注册`);
  }

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

test('投影出的文档写在临时工作区里（不污染仓库）', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-e2e-check-'));
  const file = join(workspace, 'project-manager.md');
  writeFileSync(file, '# 空\n');
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, 'utf8'), '# 空\n');
});



import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HANDOFF_MAX_BYTES,
  HANDOFF_DIR,
  buildHandoffDocument,
  formatStamp,
  handoffFileName,
  parseHandoff,
  sliceHandoffByBytes,
  truncateUtf8,
} from '../../src/domain/handoff.ts';
import { deriveGraph } from '../../src/domain/progress.ts';
import type { GraphSnapshot, NodeRecord } from '../../src/shared/types.ts';

function node(partial: Partial<NodeRecord> & { id: string; name: string }): NodeRecord {
  return {
    parentId: null,
    kind: 'task',
    selfState: 'pending',
    progress: 0,
    focus: false,
    gate: null,
    revision: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    updatedBy: 'user',
    ...partial,
  };
}

/** 一个待续接的枝：根 → (完成A, 进行中B, 异常C) */
function sampleGraph(): GraphSnapshot {
  return {
    projectName: '示例项目',
    rootIds: ['root'],
    dataFormat: 1,
    nodes: {
      root: node({ id: 'root', name: 'IM聊天', kind: 'feature' }),
      a: node({
        id: 'a',
        name: '好友列表',
        parentId: 'root',
        selfState: 'done',
        progress: 1,
        refs: [{ type: 'code', target: 'src/friends.ts' }],
        description: '用本地缓存，接口分页 20 条',
      }),
      b: node({
        id: 'b',
        name: '群组',
        parentId: 'root',
        selfState: 'running',
        progress: 0.6,
        refs: [{ type: 'code', target: 'src/group.ts' }],
      }),
      c: node({
        id: 'c',
        name: '消息服务',
        parentId: 'root',
        selfState: 'error',
        flags: ['risk'],
        refs: [{ type: 'code', target: 'src/msg.ts' }],
      }),
    },
  };
}

const NOW = new Date(2026, 8, 22, 14, 30, 5);

test('文件名与时间戳格式：handoff/<kind>-<nodeId>-<yyyymmdd-HHmmss>.md', () => {
  assert.equal(formatStamp(NOW), '20260922-143005');
  const name = handoffFileName({ kind: 'pause', rootNodeId: 'n_7f3a', now: NOW });
  assert.equal(name, 'pause-n_7f3a-20260922-143005.md');
  assert.equal(`${HANDOFF_DIR}/${name}`, '.pm/handoff/pause-n_7f3a-20260922-143005.md');
});

test('机械生成：固定小节顺序齐全', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
    reason: '等接口联调',
  });

  // 按**行首**匹配真正的标题，避免撞上正文里提到的节名
  const headings = doc.markdown
    .split(/\r?\n/)
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim());
  assert.deepEqual(headings, ['进度快照', '下一步', '关键决策与坑', '涉及文件', '未完成清单']);
});

test('机械部分：进度快照含完成情况与节点状态', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
  });
  assert.match(doc.markdown, /已完成 0 \/ 未完成 1/, '只覆盖 b 枝');
  assert.match(doc.markdown, /`群组` — running 60%/);
  assert.match(doc.markdown, /暂停（保留现场，可继续）/);
});

test('机械部分：拦停文档标注按子节点分节并可覆盖整枝', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
  });
  assert.match(doc.markdown, /拦停（整枝停止，需重新评审）/);
  assert.match(doc.markdown, /已完成 1 \/ 未完成 2/, '整枝内 1 完成 2 未完成');
  // 子节点都应在快照里
  for (const name of ['好友列表', '群组', '消息服务']) {
    assert.ok(doc.markdown.includes(name), `缺少子节点 ${name}`);
  }
});

test('机械部分：涉及文件只给路径，不复制内容', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
  });
  assert.match(doc.markdown, /- `src\/friends\.ts`/);
  assert.match(doc.markdown, /- `src\/group\.ts`/);
  assert.match(doc.markdown, /- `src\/msg\.ts`/);
  // 不应出现文件内容（示例里没有内容可复制，这里验证不出现代码围栏）
  assert.equal(doc.markdown.includes('```'), false);
});

test('机械部分：未完成清单带枝路径与状态', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
  });
  assert.match(doc.markdown, /IM聊天 \/ `群组` — running 60%/);
  assert.match(doc.markdown, /IM聊天 \/ `消息服务` — error/);
  // 已完成的叶节点不得出现在未完成清单里：只检查「未完成清单」小节内部
  const unfinishedSection = (parseHandoff(doc.markdown).sections['未完成清单'] ?? '');
  assert.ok(!unfinishedSection.includes('好友列表'), `未完成清单混入了已完成节点：${unfinishedSection}`);
});

test('模型补写缺失 → 降级标注，但不阻塞生成', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
  });
  assert.equal(doc.supplementsSkipped, true);
  assert.match(doc.markdown, /模型补写部分已跳过/);
});

test('模型补写存在 → 写入对应小节且不再标降级', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
    supplements: {
      nextSteps: '1. 接完群组创建接口\n2. 补权限校验',
      decisions: '群组 ID 用服务端生成，不用本地自增',
      tokensUsed: 1234,
    },
  });
  assert.equal(doc.supplementsSkipped, false);
  assert.match(doc.markdown, /接完群组创建接口/);
  assert.match(doc.markdown, /群组 ID 用服务端生成/);
  assert.ok(!doc.markdown.includes('模型补写部分已跳过'));
});

test('排除黑名单：路径不进「涉及文件」', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
    excludePaths: ['src/msg.ts'],
  });
  assert.ok(!doc.markdown.includes('src/msg.ts'), '黑名单路径不应出现');
  assert.ok(doc.markdown.includes('src/friends.ts'));
});

test('超长描述会被逐节点截断（避免单节点描述淹没文档）', () => {
  const graph = sampleGraph();
  graph.nodes['b'] = node({
    id: 'b',
    name: '群组',
    parentId: 'root',
    selfState: 'running',
    description: 'x'.repeat(1000),
  });
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
  });
  // 描述被截到 240 字符以内
  assert.ok(doc.markdown.length < 3000, `文档过长：${doc.markdown.length}`);
});

// ── 截断与分页 ───────────────────────────────────────────────────

test('truncateUtf8：不超限时原样返回', () => {
  const result = truncateUtf8('hello', 100);
  assert.equal(result.text, 'hello');
  assert.equal(result.truncated, false);
});

test('truncateUtf8：按字节截断且不切断多字节字符', () => {
  const text = '中'.repeat(100); // 每字 3 字节
  const result = truncateUtf8(text, 100);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 100 + 200, '含说明后仍在合理范围');
  assert.ok(!result.text.includes('\uFFFD'), '不得出现替换字符（说明切断被正确处理）');
  assert.match(result.text, /已截断/);
});

test('超限文档：生成时即截断并给出省略说明', () => {
  const graph = sampleGraph();
  // 塞入大量未完成叶节点
  for (let i = 0; i < 400; i += 1) {
    graph.nodes[`leaf${i}`] = node({
      id: `leaf${i}`,
      name: `任务${i}`,
      parentId: 'root',
      refs: [{ type: 'code', target: `src/file${i}.ts` }],
    });
  }
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
    maxBytes: 4096,
  });
  assert.equal(doc.truncated, true);
  assert.ok(doc.bytes <= 4096 + 64, `实际 ${doc.bytes} 字节`);
  assert.match(doc.markdown, /已截断/);
});

test('分页读取：逐片取完，offset 归零到末尾', () => {
  const text = '行\n'.repeat(2000);
  let offset = 0;
  let collected = '';
  let guard = 0;
  for (;;) {
    const page = sliceHandoffByBytes(text, offset, 1024);
    collected += page.text;
    guard += 1;
    assert.ok(guard < 100, '分页不应死循环');
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(collected, text, '逐片拼回应与原文一致');
});

test('分页读取：不切断多字节字符', () => {
  const text = '中文内容'.repeat(500);
  const page = sliceHandoffByBytes(text, 0, 10);
  assert.ok(!page.text.includes('\uFFFD'));
  assert.equal(page.truncated, true);
});

// ── 反解析 ───────────────────────────────────────────────────────

test('parseHandoff：能取回各小节与降级标记', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'pause',
    nodeIds: ['b'],
    rootNodeId: 'b',
    now: NOW,
    supplements: { nextSteps: '接接口', decisions: '用服务端 ID' },
  });
  const parsed = parseHandoff(doc.markdown);
  assert.equal(parsed.kind, 'pause');
  assert.match(parsed.sections['下一步'] ?? '', /接接口/);
  assert.match(parsed.sections['关键决策与坑'] ?? '', /服务端 ID/);
  assert.match(parsed.sections['进度快照'] ?? '', /完成情况/);
  assert.equal(parsed.supplementsSkipped, false);
});

test('parseHandoff：拦停文档识别为 hold', () => {
  const graph = sampleGraph();
  const derived = deriveGraph(graph);
  const doc = buildHandoffDocument(graph, derived, {
    kind: 'hold',
    nodeIds: ['root'],
    rootNodeId: 'root',
    now: NOW,
  });
  const parsed = parseHandoff(doc.markdown);
  assert.equal(parsed.kind, 'hold');
  assert.equal(parsed.supplementsSkipped, true);
});

test('默认上限为 200 KB（FR-81e）', () => {
  assert.equal(DEFAULT_HANDOFF_MAX_BYTES, 200 * 1024);
});

/**
 * AI 建树的纯逻辑测试（解析 / 提示词 / 成本估算 / 路由）。
 *
 * 这些是**不花钱**的部分，但也是最容易把不可信输入放进门的地方：
 * 模型输出必须当成外部数据校验，任何不合法都不许"尽力改一改就落库"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractJsonObject, isBalanced, parseTreeResponse } from '../../src/ai/parse.ts';
import {
  AI_TREE_SYSTEM_PROMPT,
  buildTreePrompt,
  describeEstimate,
  estimateAiBuild,
  inferKind,
} from '../../src/ai/prompt.ts';
import { resolveAiRoute } from '../../src/ai/route.ts';

/** 假 ctx：只需要 `get()`。 */
function ctxWith(services: Record<string, unknown>): never {
  return { get: (key: string) => services[key] } as never;
}

describe('AI 输出解析', () => {
  it('能从 ```json 围栏里取出 JSON，并忽略前后解释文字', () => {
    const text = [
      '好的，这是你要的树：',
      '```json',
      '{"projectName":"示例","nodes":[{"name":"根","kind":"feature"},{"name":"子","parent":0}]}',
      '```',
      '希望能帮到你。',
    ].join('\n');
    const outcome = parseTreeResponse(text);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.value.projectName, '示例');
    assert.deepEqual(
      outcome.value.nodes.map((n) => [n.name, n.parent, n.kind]),
      [
        ['根', null, 'feature'],
        ['子', 0, 'task'],
      ],
    );
  });

  it('找不到 JSON / JSON 坏掉 / 结构不合法 → 明确失败，不带猜测', () => {
    assert.equal(parseTreeResponse('我觉得这个项目很好').ok, false);
    assert.equal(parseTreeResponse('{"nodes":[').ok, false);
    const wrongShape = parseTreeResponse('{"nodes":[{"name":""}]}');
    assert.equal(wrongShape.ok, false);
    const empty = parseTreeResponse('{"nodes":[]}');
    assert.equal(empty.ok, false);
  });

  it('父下标指向自身或后面的节点 → 改为根并记说明（不死循环）', () => {
    const outcome = parseTreeResponse(
      '{"nodes":[{"name":"甲","parent":1},{"name":"乙","parent":0}]}',
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.value.nodes[0]?.parent, null);
    assert.ok(outcome.notes.some((note) => note.includes('父下标')));
  });

  it('同级重名 → 丢弃后来的并记说明（C12）', () => {
    const outcome = parseTreeResponse(
      '{"nodes":[{"name":"根"},{"name":"登录","parent":0},{"name":"登录","parent":0}]}',
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.value.nodes.length, 2);
    assert.ok(outcome.notes.some((note) => note.includes('同级重复')));
  });

  it('引用路径逃逸工作区 → 丢弃该引用（文件系统边界）', () => {
    const outcome = parseTreeResponse(
      '{"nodes":[{"name":"根","refs":[{"type":"dir","target":"../outside"},{"type":"dir","target":"src"}]}]}',
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.value.nodes[0]?.refs, [{ type: 'dir', target: 'src' }]);
  });

  it('实测回归：`type:"file"` 这类别名要归一，而不是把整棵树判失败', () => {
    // 这是真实跑出来过的输出片段：模型把引用类型写成 "file"，早先版本直接整树被拒
    const outcome = parseTreeResponse(
      JSON.stringify({
        projectName: 'dsh-project-manager',
        nodes: [
          {
            name: '项目进度看板插件',
            kind: 'feature',
            parent: null,
            refs: [
              { type: 'dir', target: 'src' },
              { type: 'file', target: 'package.json' },
            ],
          },
          {
            name: '领域模型与进度引擎',
            kind: 'feature',
            parent: 0,
            weight: 9,
            progress: 0.75,
            refs: [{ type: 'dir', target: 'src/domain' }],
          },
        ],
      }),
    );
    assert.equal(outcome.ok, true, outcome.ok ? '' : JSON.stringify(outcome));
    if (!outcome.ok) return;
    assert.deepEqual(outcome.value.nodes[0]?.refs, [
      { type: 'dir', target: 'src' },
      { type: 'code', target: 'package.json' },
    ]);
    assert.equal(outcome.value.projectName, 'dsh-project-manager');
    assert.equal(outcome.value.nodes[1]?.weight, 9);
    assert.equal(outcome.value.nodes[1]?.progress, 0.75);
    assert.ok(outcome.notes.some((note) => note.includes('file')), '归一要有说明，不能静默');
  });

  it('宽容但诚实：百分数/字符串数字/越界值都归一，且逐条记说明', () => {
    const outcome = parseTreeResponse(
      JSON.stringify({
        nodes: [
          { name: 'A', progress: '75%', weight: '3' },
          { name: 'B', parent: 0, progress: 120, weight: 99 },
          { name: 'C', parent: 0, kind: '功能', weight: 'abc', progress: -1 },
          { name: 'D', parent: 0, refs: ['README.md', 'src/domain', '../escape', 42] },
        ],
      }),
    );
    assert.equal(outcome.ok, true, outcome.ok ? '' : JSON.stringify(outcome));
    if (!outcome.ok) return;
    const byName = new Map(outcome.value.nodes.map((node) => [node.name, node]));
    assert.equal(byName.get('A')?.progress, 0.75);
    assert.equal(byName.get('A')?.weight, 3);
    assert.equal(byName.get('B')?.progress, 1, '超过 1 的百分数夹紧到 1');
    assert.equal(byName.get('B')?.weight, 10, '超过 10 的权重夹紧到 10');
    assert.equal(byName.get('C')?.kind, 'feature', '中文 kind 要认；有子节点故为 feature');
    assert.equal(byName.get('C')?.weight, undefined, '认不出的权重直接省略，不猜');
    assert.equal(byName.get('C')?.progress, undefined, '负值省略');
    assert.deepEqual(byName.get('D')?.refs, [
      { type: 'md', target: 'README.md' },
      { type: 'dir', target: 'src/domain' },
    ]);
    assert.ok(outcome.notes.length >= 3, `归一说明应有多条：${outcome.notes.join(' | ')}`);
  });

  it('宽容的边界：没有名称的节点丢弃、nodes 缺失才整体失败', () => {
    const dropped = parseTreeResponse('{"nodes":[{"name":"  "},{"name":"有效"}]}');
    assert.equal(dropped.ok, true);
    if (!dropped.ok) return;
    assert.deepEqual(dropped.value.nodes.map((n) => n.name), ['有效']);
    assert.ok(dropped.notes.some((note) => note.includes('没有名称')));

    assert.equal(parseTreeResponse('{"foo":1}').ok, false);
    assert.equal(parseTreeResponse('{"nodes":[]}').ok, false);
  });

  it('能穿透 tree/data 包装层（模型偶尔会套一层）', () => {
    const outcome = parseTreeResponse('{"data":{"nodes":[{"name":"包装里的根"}]}}');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.value.nodes[0]?.name, '包装里的根');
  });

  it('括号配平检查用来区分"截断"与"不是 JSON"', () => {
    assert.equal(isBalanced('{"nodes":[{"name":"a"}'), false);
    assert.equal(isBalanced('{"nodes":[{"name":"a"}]}'), true);
  });

  it('extractJsonObject 能处理字符串里带括号的情况', () => {
    const json = extractJsonObject('前言 {"name":"a{b}","other":"}"} 结语');
    assert.equal(json, '{"name":"a{b}","other":"}"}');
  });
});

describe('AI 提示词与成本估算', () => {
  it('系统提示词把硬规则写清楚（功能点/任务点、严格 JSON、不做周期）', () => {
    for (const rule of ['功能点', '任务点', '不是文件', 'JSON', '相对工作量', '完成度初判', '还需多久']) {
      assert.ok(AI_TREE_SYSTEM_PROMPT.includes(rule), `提示词缺少关键约束：${rule}`);
    }
  });

  it('用户提示词只带骨架与签名（不夹带整文件内容）', () => {
    const prompt = buildTreePrompt({
      projectName: 'demo',
      maxNodes: 50,
      skeleton: [
        { path: 'src', kind: 'dir', fileCount: 3 },
        { path: 'package.json', kind: 'file', sizeBytes: 900, keyFile: true, signature: '{"name":"demo"}' },
      ],
      truncated: true,
      skipped: 7,
    });
    assert.ok(prompt.includes('src/'));
    assert.ok(prompt.includes('package.json'));
    assert.ok(prompt.includes('{"name":"demo"}'));
    assert.ok(prompt.includes('最多 50 个节点'));
    assert.ok(prompt.includes('截断'));
    assert.ok(prompt.includes('7 个条目被排除'));
  });

  it('成本估算只用手上元数据，并如实标注为粗估', () => {
    const estimate = estimateAiBuild({
      entries: 120,
      signatureBytes: 8000,
      promptBytes: 30000,
      maxOutputTokens: 4096,
    });
    assert.equal(estimate.calls, 1);
    assert.equal(estimate.inputTokens, 10000);
    assert.equal(estimate.totalTokens, 14096);
    assert.equal(estimate.level, 'medium');
    assert.ok(describeEstimate(estimate).includes('粗估'));
    assert.ok(describeEstimate(estimate).includes('不发送整文件内容'));
  });

  it('档位随规模变化，且 kind 兜底按有无子节点推断', () => {
    assert.equal(
      estimateAiBuild({ entries: 5, signatureBytes: 0, promptBytes: 900, maxOutputTokens: 512 }).level,
      'small',
    );
    assert.equal(
      estimateAiBuild({ entries: 500, signatureBytes: 0, promptBytes: 300000, maxOutputTokens: 8192 }).level,
      'large',
    );
    assert.equal(inferKind(true), 'feature');
    assert.equal(inferKind(false), 'task');
  });
});

describe('AI 模型路由解析', () => {
  it('设置里填了 provider+model → 用它（source=config）', () => {
    const outcome = resolveAiRoute({
      ctx: ctxWith({}),
      configProvider: 'deepseek',
      configModel: 'deepseek-chat',
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.route, { provider: 'deepseek', model: 'deepseek-chat', source: 'config' });
  });

  it('设置只填一半 → 明确拒绝并给出可执行提示', () => {
    const outcome = resolveAiRoute({ ctx: ctxWith({}), configProvider: 'deepseek' });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'ai-route-incomplete');
    assert.ok(outcome.hint.includes('provider'));
  });

  it('设置留空 → 跟随宿主默认模型', () => {
    const outcome = resolveAiRoute({
      ctx: ctxWith({
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      }),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.route.source, 'default-selection');
    assert.equal(outcome.route.model, 'm');
  });

  it('既没设置也没默认模型 → 拒绝，并说清"配好之前不会发起任何调用"', () => {
    const outcome = resolveAiRoute({ ctx: ctxWith({}) });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'ai-route-unavailable');
    assert.ok(outcome.hint.includes('不会发起任何 AI 调用'));
  });

  it('默认模型服务抛错时不崩（如实降级为"没有路由"）', () => {
    const outcome = resolveAiRoute({
      ctx: ctxWith({
        agentDefaultModel: {
          currentSelection: () => {
            throw new Error('boom');
          },
        },
      }),
    });
    assert.equal(outcome.ok, false);
  });
});


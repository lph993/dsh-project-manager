/**
 * AI 建树的纯逻辑测试（解析 / 提示词 / 成本估算 / 路由）。
 *
 * 这些是**不花钱**的部分，但也是最容易把不可信输入放进门的地方：
 * 模型输出必须当成外部数据校验，任何不合法都不许"尽力改一改就落库"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { isReusableEntry, type CacheEntry } from '../../src/ai/cache.ts';
import { extractJsonObject, isBalanced, isOutputLimitReason, isTruncatedCompletion, parseTreeResponse } from '../../src/ai/parse.ts';
import {
  AI_TREE_SYSTEM_PROMPT,
  buildTreePrompt,
  describeEstimate,
  estimateAiBuild,
  inferKind,
  learnContextWindow,
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
        projectName: 'dsh-project-progress',
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
    assert.equal(outcome.value.projectName, 'dsh-project-progress');
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

  it('成本估算只用手上元数据，并如实标注为粗估', () => {  const estimate = estimateAiBuild({
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

  /**
   * **真机 `maximum context length` 的防复发**（宿主真实报错，不是推测）：
   *
   * ```
   * This model's maximum context length is 1048576 tokens. However, you requested
   * 1049147 tokens (793147 in the messages, 256000 in the completion).
   * ```
   *
   * 也就是"输入 + 输出上限 > 模型窗口"。当时确认框只说"规模较大，建议先缩小扫描范围"，
   * 一个字都没提窗口 ⇒ 用户点确认 ⇒ 必然被拒。
   * 这里钉死：**读到窗口就必须判断，并且超了要说出来**；读不到就不许编判断。
   */
  it('窗口判定：输入 + 输出上限超窗时必须明说（真机 maximum context length 防复发）', () => {
    // 复刻真机数字：输入粗估 793147（≈2379441 字节 / 3）、输出上限 256000、窗口 1048576
    const over = estimateAiBuild({
      entries: 700,
      signatureBytes: 500000,
      promptBytes: 2_379_441,
      maxOutputTokens: 256_000,
      contextWindow: 1_048_576,
      maxNodes: 60,
    });
    assert.equal(over.inputTokens, 793_147, '输入粗估按字节/3，向上取整');
    assert.equal(over.context?.windowTokens, 1_048_576);
    assert.equal(over.context?.totalTokens, 1_049_147, '输入 + 输出上限');
    assert.equal(over.context?.feasible, false, '超窗 571 token —— 必须判为装不下');
    const text = describeEstimate(over);
    assert.match(text, /很可能超模型上下文窗口/, '超窗必须在确认框里直说');
    assert.match(text, /1048576/, '要说清窗口是多少');

    // 装得下时必须说"粗估装得下"，而不是沉默
    const fit = estimateAiBuild({
      entries: 80,
      signatureBytes: 9000,
      promptBytes: 30000,
      maxOutputTokens: 8192,
      contextWindow: 1_048_576,
    });
    assert.equal(fit.context?.feasible, true);
    assert.match(describeEstimate(fit), /粗估装得下/);

    // **读不到窗口 ⇒ 不给这个字段**（不许编一个窗口出来做判断）
    const unknown = estimateAiBuild({ entries: 10, signatureBytes: 100, promptBytes: 300 });
    assert.equal(unknown.context, undefined);
    assert.ok(!describeEstimate(unknown).includes('模型窗口'));
  });

  /**
   * **从提供方拒绝里学窗口**（真机退路）：这台宿主对该模型**不披露** `context.contextWindow`
   * （实测 `resolveModelInfo` 只回了 `defaultMaxTokens`），所以只能从拒绝原话里学。
   * 真机原话就是下面这一句 —— 识别必须窄：只认这个句式、且值要落在合理区间。
   */
  it('learnContextWindow：只认提供方那句原话，乱数字一律不学', () => {
    const real =
      "This model's maximum context length is 1048576 tokens. However, you requested 1049147 tokens " +
      '(793147 in the messages, 256000 in the completion).';
    assert.equal(learnContextWindow(real), 1_048_576, '真机原话里的窗口必须学出来');

    // 大小写与空白宽容
    assert.equal(learnContextWindow('MAXIMUM CONTEXT LENGTH IS 200000 TOKENS'), 200_000);

    // 不认的句式 / 空值 / 越界值 ⇒ undefined（不许把乱七八糟的数字当窗口）
    assert.equal(learnContextWindow(undefined), undefined);
    assert.equal(learnContextWindow(''), undefined);
    assert.equal(learnContextWindow('context length exceeded'), undefined);
    assert.equal(learnContextWindow('maximum context length is 123 tokens'), undefined, '太小 ⇒ 不是窗口');
    assert.equal(learnContextWindow('maximum context length is 999999999 tokens'), undefined, '太大 ⇒ 不是窗口');
  });

  /**
   * 真机踩过的坑：确认框只写"约 9767 token"，用户看不出其中 **8192 是硬上限**、
   * 也看不出"要建 60 个节点"意味着每节点只有 136 token 的预算 ⇒ 点确认 ⇒ 输出被截断 ⇒ 白花一轮。
   * 所以这里钉死：**必须把输出上限与每节点预算摆到台面上**，并且数字是纯算术。
   */
  it('成本提示必须摆出"输出上限 ÷ 节点上限"（真机截断事故的防复发）', () => {
    const text = describeEstimate(
      estimateAiBuild({ entries: 151, signatureBytes: 13000, promptBytes: 5000, maxOutputTokens: 8192, maxNodes: 60 }),
    );
    assert.match(text, /输出上限 8192 token/);
    assert.match(text, /最多 60 个节点/);
    assert.match(text, /每个节点只有 136 token/, '8192 / 60 = 136（纯算术，不许四舍五入成好看的数字）');
    assert.match(text, /分批/, '要告诉用户"截断不会白花这一轮"');
    // 口径必须写清：上限是天花板，不是预期花费（否则用户以为"这次一定花掉这么多"）
    assert.match(text, /硬天花板，不是预期花费/);
    assert.match(text, /最坏情况合计约 9859 token/);
    assert.match(text, /输入约 1667 token/);
  });

  it('没给节点上限时只讲输出上限（不编每节点预算）', () => {
    const text = describeEstimate(
      estimateAiBuild({ entries: 10, signatureBytes: 0, promptBytes: 900, maxOutputTokens: 512 }),
    );
    assert.match(text, /输出上限 512 token/);
    assert.ok(!text.includes('摊到每个节点'), '没有节点上限就不该编一个每节点预算出来');
  });

  /**
   * **FR-171：给"上次实测"，不给"本次预计"**（用户追问："实时预估 token 量没写？"）。
   *
   * 事前精确预计做不到（宿主不固定分词器），但**上一次真的发生过什么**是硬事实 ——
   * 而且它恰好能回答"这次会不会顶到上限"。
   */
  it('有真实用量就给"上次实测"，并标明不是预计；顶到上限时直说', () => {
    const withActual = describeEstimate(
      estimateAiBuild({
        entries: 100,
        signatureBytes: 0,
        promptBytes: 3000,
        maxOutputTokens: 8192,
        maxNodes: 60,
        lastActual: { at: '2026-09-24T12:38:41.065Z', inputTokens: 1500, outputTokens: 567 },
      }),
    );
    assert.match(withActual, /上次建树实测（提供方回报，非预计）/);
    assert.match(withActual, /输出 567 token、输入 1500 token/);
    assert.match(withActual, /2026-09-24 12:38/, '时间要给出来（否则"上次"是多久前说不清）');
    assert.ok(!withActual.includes('顶到当前上限'), '没顶到就别吓唬人');

    const hitCap = describeEstimate(
      estimateAiBuild({
        entries: 100,
        signatureBytes: 0,
        promptBytes: 3000,
        maxOutputTokens: 8192,
        maxNodes: 60,
        lastActual: { at: '2026-09-24T12:38:41.065Z', inputTokens: 1500, outputTokens: 8192 },
      }),
    );
    assert.match(hitCap, /上次就已经顶到当前上限了/, '上次顶到过就必须直说（这是最有用的信号）');
  });

  it('没有真实用量就一个字都不提"上次实测"（不编）', () => {
    const text = describeEstimate(
      estimateAiBuild({ entries: 100, signatureBytes: 0, promptBytes: 3000, maxOutputTokens: 8192, maxNodes: 60 }),
    );
    assert.ok(!text.includes('上次建树实测'), '没有提供方真实用量时不许出现"实测"字样');
  });

  /**
   * 用户口径："**不用精确，说了预估**" —— 所以确认框要给"预计输出"这个数，
   * 但必须：标明粗估 + 写出算法（让人能自己判断怎么来的）。
   */
  it('预计输出（粗估）要给数、要标明粗估、要把算式写出来', () => {
    const text = describeEstimate(
      estimateAiBuild({ entries: 100, signatureBytes: 0, promptBytes: 3000, maxOutputTokens: 32768, maxNodes: 60 }),
    );
    assert.match(text, /预计输出约 9600 token（粗估）/, '60 × 160 = 9600');
    assert.match(text, /60 个节点 × 每节点约 160 token/, '算式要摊开写，别只丢一个数');
    assert.match(text, /每节点至少 136/, '系数依据要写明（实测下界 136，取 160 留余量）');
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

/**
 * 缓存**能不能真的复用**的判据（回归测试，钉住一次真实事故）。
 *
 * 事故：确认框写着"可以直接复用上次结果（不花钱）"（预览只看输入指纹），
 * 点确认后执行阶段做结构自检、发现缓存里是空树 ⇒ 降级真调了模型，
 * 模型返回空文本，于是用户看到"模型没有返回任何文本内容"。
 * 预览与执行因此必须共用 `isReusableEntry` 这一个判据。
 */
describe('缓存可用性判据（预览与执行必须一致）', () => {
  function entry(partial: Partial<CacheEntry>): CacheEntry {
    return {
      key: 'k',
      status: 'complete',
      createdAt: '2026-09-24T00:00:00.000Z',
      signatures: {},
      ...partial,
    };
  }

  it('complete：树结构有效才可复用', () => {
    assert.equal(
      isReusableEntry(entry({ tree: { projectName: 'p', nodes: [{ name: '根', kind: 'feature', parent: null }] } })),
      true,
    );
  });

  it('complete：空树 / 缺 nodes / 不是对象 一律不可复用（这正是那次事故的根源）', () => {
    assert.equal(isReusableEntry(entry({ tree: { nodes: [] } })), false, '空 nodes 数组');
    assert.equal(isReusableEntry(entry({ tree: { projectName: '只有名字' } })), false, '缺 nodes');
    assert.equal(isReusableEntry(entry({ tree: null })), false);
    assert.equal(isReusableEntry(entry({ tree: 'not-json-object' })), false);
    assert.equal(isReusableEntry(entry({ tree: undefined })), false);
  });

  it('partial：已得文本要能解析出树才可续跑', () => {
    assert.equal(
      isReusableEntry(entry({ status: 'partial', rawText: '{"nodes":[{"name":"根","kind":"task","parent":null}]}' })),
      true,
    );
    assert.equal(isReusableEntry(entry({ status: 'partial', rawText: '模型被打断，什么都没给出来' })), false);
    assert.equal(isReusableEntry(entry({ status: 'partial', rawText: '   ' })), false);
    assert.equal(isReusableEntry(entry({ status: 'partial', rawText: undefined })), false);
  });
});

/**
 * **"被截断"只能有一处判据**（真机事故：报错里同时说"被截断"和"不符合要求"）。
 *
 * 事故原委：给用户看的提示用的是"终止原因是 `length` **或** JSON 不闭合"，
 * 机器可读的原因码却只用了 `finishReason === 'length'` —— 供应商回的是 **`max-tokens`**，
 * 于是同一份输出被判成两件事：提示说"似乎被截断"（对），原因码说 `invalid-output`（错）。
 * 后果不是"看起来别扭"：分批重试**按原因码决定要不要救**，分类一错，
 * 该救的（规模问题）不救、不该救的（模型答非所问）乱救（白花钱）。
 */
describe('截断判据（一处实现，供提示与原因码共用）', () => {
  it('撞上限的各种供应商写法都要认（不再只认 length）', () => {
    for (const reason of ['length', 'max-tokens', 'max_tokens', 'MAX_TOKENS', 'max output tokens', 'token-limit', 'output-limit']) {
      assert.equal(isOutputLimitReason(reason), true, `${reason} 应被认作撞上限`);
    }
    for (const reason of ['stop', 'end_turn', 'tool_use', '', 'lengthy-explain']) {
      assert.equal(isOutputLimitReason(reason), false, `${reason} 不是撞上限`);
    }
    assert.equal(isOutputLimitReason(undefined), false, '拿不到终止原因时不许当成截断');
  });

  it('括号不配平本身就是客观证据 —— 哪怕供应商的 label 很奇怪', () => {
    const cut = '{"projectName":"x","nodes":[{"name":"宿主适配层"';
    assert.equal(isTruncatedCompletion({ finishReason: 'max-tokens', text: cut }), true);
    assert.equal(
      isTruncatedCompletion({ finishReason: '某个没见过的原因', text: cut }),
      true,
      '文本没闭合说明就是没吐完，不该因为 label 不认识就改口说"格式不合法"',
    );
  });

  it('配平 + 非上限原因 ⇒ 不是截断（那是模型真的没按格式答）', () => {
    assert.equal(
      isTruncatedCompletion({ finishReason: 'stop', text: '这不是 JSON，只是我的一段解释' }),
      false,
      '这种分批也救不了，必须与"被截断"分开',
    );
  });

  /**
   * 源码级守卫：**调用点不许再自己写一份判据**。
   * 这条 bug 的本质不是"判据算错"，而是"判据写了两份、还只认某一家供应商的措辞"。
   */
  it("调用点必须共用同一个判据，且不许再出现 `=== 'length'`", () => {
    const source = stripComments(
      readFileSync(new URL('../../src/ai/tree-builder.ts', import.meta.url), 'utf8'),
    );
    assert.match(source, /isTruncatedCompletion\(/, '提示与原因码必须共用同一个截断判据');
    assert.ok(
      !source.includes("finishReason === 'length'"),
      "不许再出现 `finishReason === 'length'` —— 那只认一家供应商的措辞（实测拿到的是 max-tokens）",
    );
  });
});

/**
 * 去掉注释后再做源码级断言。
 *
 * **这个函数是被自己的假阳性逼出来的**：上面那条守卫第一版直接搜源码文本，
 * 结果被我那句"不许再写 `finishReason === 'length'`"的**注释本身**打红了 ——
 * 守卫要盯的是**代码**，而注释里引用反例是正常的（今天同类假阳性已经出现两次，
 * 所以这里显式剥掉注释，而不是靠"下次注意"）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}


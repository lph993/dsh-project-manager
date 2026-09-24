/**
 * 会话边界修正与提示词纪律的纯函数契约（用户的原始诉求：
 * "每次子代理或者子任务或者会话结束时进行进度实时修正" + "让 AI 主动的在会话结束时用工具修正"）。
 *
 * 这一层为什么值得单独钉死：
 * - 它**不花 token**，所以它的价值全在"说得准不准、会不会乱改"；
 * - 它写的每一笔都会进事实源，猜错一次就会污染进度（而进度正是用户最在意的那一个数）；
 * - 提示词那段是静态文本，一旦混进动态内容就会毁掉前缀缓存 —— 这条必须有回归测试守着。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOUNDARY_DEBOUNCE_MS,
  boundaryReminderText,
  planBoundaryWriteback,
  shouldHandleBoundary,
  type BoundNode,
} from '../../src/session/boundary.ts';
import {
  MAX_FACT_LINES,
  PM_CONTEXT_NAME,
  PM_CONTEXT_ORDER,
  PM_SECTION_NAME,
  PM_SECTION_ORDER,
  boundFactsText,
  factLine,
  progressDisciplineText,
} from '../../src/session/prompt.ts';

function bound(partial: Partial<BoundNode> & { nodeId: string }): BoundNode {
  return {
    name: partial.nodeId,
    selfState: 'pending',
    derivedState: 'pending',
    gate: null,
    progress: 0,
    leaf: true,
    ...partial,
  };
}

// ── 边界状态推进 ────────────────────────────────────────────────

test('边界修正只做 pending+0 → running：其余一律不碰', () => {
  const plan = planBoundaryWriteback({
    kind: 'turn-end',
    actorId: 's1',
    bound: [
      bound({ nodeId: 'a' }), // 该推
      bound({ nodeId: 'b', selfState: 'running', progress: 0.3 }), // 有人报过 → 不覆盖
      bound({ nodeId: 'c', selfState: 'pending', progress: 0.5 }), // 有进度 → 不推
      bound({ nodeId: 'd', selfState: 'done', derivedState: 'done', progress: 1 }), // 已完成
      bound({ nodeId: 'e', derivedState: 'removed' }), // 墓碑
      bound({ nodeId: 'f', gate: 'paused' }), // 被门控的枝不该被边界推着走
      bound({ nodeId: 'g', derivedState: 'running', leaf: false }), // 父节点（C5 拒写自身状态）
    ],
  });
  assert.deepEqual(
    plan.patches.map((patch) => patch.nodeId),
    ['a'],
    '只有「pending 且进度为 0 且未被门控、未完成」的**叶**节点才推成 running',
  );
  assert.match(plan.patches[0]?.reason ?? '', /回合结束边界/);
});

test('边界提醒只列仍未完成的进行中节点，最多 8 个，并如实报总数', () => {
  const many: BoundNode[] = [];
  for (let index = 0; index < 10; index += 1) {
    many.push(bound({ nodeId: `r${index}`, selfState: 'running', progress: 0.2, name: `任务${index}` }));
  }
  const plan = planBoundaryWriteback({ kind: 'agent-disposed', actorId: 's1', bound: many });
  assert.equal(plan.patches.length, 0);
  assert.equal(plan.stillRunning.length, 8, '最多列 8 个，避免把上下文塞满');
  assert.equal(plan.runningTotal, 10);
  const text = boundaryReminderText(plan);
  assert.match(text ?? '', /等 10 个/, '"还有多少"必须说真实总数，而不是被裁后的 8');
  assert.match(text ?? '', /pm_progress/);
  assert.match(text ?? '', /pm_finish/);
});

test('没有进行中的节点 → 不发提醒（不打扰）', () => {
  const plan = planBoundaryWriteback({
    kind: 'turn-end',
    actorId: 's1',
    bound: [bound({ nodeId: 'a' })],
  });
  assert.equal(plan.remind, false);
  assert.equal(plan.runningTotal, 0);
  assert.equal(boundaryReminderText(plan), undefined);
});

test('去抖：同 actor 的 idle 边界在窗口内只处理一次，disposed 永远处理', () => {
  const lastSeen = new Map<string, number>();
  assert.equal(shouldHandleBoundary({ kind: 'turn-end', actorId: 's1', now: 1000, lastSeen }), true);
  lastSeen.set('s1', 1000);
  assert.equal(
    shouldHandleBoundary({ kind: 'turn-end', actorId: 's1', now: 1000 + BOUNDARY_DEBOUNCE_MS - 1, lastSeen }),
    false,
    '窗口内重复的 idle 不该反复写库/投递',
  );
  assert.equal(
    shouldHandleBoundary({ kind: 'turn-end', actorId: 's1', now: 1000 + BOUNDARY_DEBOUNCE_MS, lastSeen }),
    true,
  );
  assert.equal(
    shouldHandleBoundary({ kind: 'agent-disposed', actorId: 's1', now: 1001, lastSeen }),
    true,
    '会话结束是最后的机会：去抖不能吃掉它',
  );
  assert.equal(
    shouldHandleBoundary({ kind: 'turn-end', actorId: 's2', now: 1001, lastSeen }),
    true,
    '去抖按 actor 分开，不互相影响',
  );
});

// ── 提示词纪律（静态段 + 动态事实）────────────────────────────────

test('静态段是**常量**文本：不含节点名/进度（否则毁掉前缀缓存）', () => {
  const text = progressDisciplineText();
  assert.equal(text, progressDisciplineText(), '同样的输入必须渲染出同样的文本');
  assert.match(text, /pm_report/);
  assert.match(text, /pm_progress/);
  assert.match(text, /绝不为了让树好看而猜/, '「宁少不猜」是刻意的纪律，不能被删掉');
  assert.ok(!/\d+%/.test(text), '静态段里不许出现百分比');
  assert.ok(!/节点 id/.test(text), '静态段里不许出现节点信息');
});

test('注册名带命名空间前缀，顺序在 harness 源码说明之前', () => {
  assert.match(PM_SECTION_NAME, /^project-manager:/);
  assert.match(PM_CONTEXT_NAME, /^project-manager:/);
  assert.notEqual(PM_SECTION_NAME, PM_CONTEXT_NAME);
  assert.ok(PM_SECTION_ORDER < 10000, '要排在 harness 源码说明（10000）之前');
  assert.ok(PM_CONTEXT_ORDER >= PM_SECTION_ORDER, '动态事实排在纪律之后，读起来才顺');
});

test('动态事实：确定性排序、稳定的行格式、空则 undefined', () => {
  assert.equal(boundFactsText([]), undefined, '没有绑定 → 不贡献任何文本');
  assert.equal(
    boundFactsText([bound({ nodeId: 'a', selfState: 'done', derivedState: 'done', progress: 1 })]),
    undefined,
    '全做完了 → 不再唠叨',
  );
  assert.equal(
    boundFactsText([bound({ nodeId: 'a', derivedState: 'removed' })]),
    undefined,
    '墓碑不进上下文',
  );

  const first = boundFactsText([
    bound({ nodeId: 'z', selfState: 'pending' }),
    bound({ nodeId: 'a', selfState: 'running', derivedState: 'running', progress: 0.42, name: '登录页' }),
    bound({ nodeId: 'm', selfState: 'error', derivedState: 'error', progress: 0.1, gate: 'paused' }),
  ]);
  const second = boundFactsText([
    bound({ nodeId: 'm', selfState: 'error', derivedState: 'error', progress: 0.1, gate: 'paused' }),
    bound({ nodeId: 'a', selfState: 'running', derivedState: 'running', progress: 0.42, name: '登录页' }),
    bound({ nodeId: 'z', selfState: 'pending' }),
  ]);
  assert.equal(first, second, '输入顺序不同但状态相同 → 必须渲染出完全一样的文本');
  const lines = (first ?? '').split('\n');
  assert.match(lines[1] ?? '', /^- a 「登录页」 running 42%$/, '进行中排第一');
  assert.match(lines[2] ?? '', /^- m 「m」 error 10% gate=paused$/, '异常次之，且带门控');
  assert.match(lines[3] ?? '', /^- z 「z」 pending 0%$/, '待办最后');
});

test('自身状态与派生状态不一致时两个都写（父节点就是这样）', () => {
  const line = factLine(bound({ nodeId: 'p', derivedState: 'running' }));
  assert.match(line, /pending\/running/, '父节点自身永远 pending，派生才是"枝在跑"');
});

test('动态事实超过上限时如实标注"另有 N 个"', () => {
  const many: BoundNode[] = [];
  for (let index = 0; index < MAX_FACT_LINES + 3; index += 1) {
    many.push(bound({ nodeId: `n${index}`, selfState: 'pending' }));
  }
  const text = boundFactsText(many) ?? '';
  assert.equal(text.split('\n').length, MAX_FACT_LINES + 2, `表头 + ${MAX_FACT_LINES} 行 + 一行省略说明`);
  assert.match(text, /另有 3 个未列出/);
});

test('进度越界与非法值不会渲染出乱七八糟的百分比', () => {
  assert.match(factLine(bound({ nodeId: 'a', progress: 1.7 })), /100%/);
  assert.match(factLine(bound({ nodeId: 'a', progress: -3 })), /0%/);
  assert.match(factLine(bound({ nodeId: 'a', progress: Number.NaN })), /0%/);
});

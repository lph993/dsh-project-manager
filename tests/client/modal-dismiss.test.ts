/**
 * AI 建树弹窗与"非显式关闭"闸门（FR-168）。
 *
 * 用户口径："执行中不可点击空白取消，只能明确点取消或关闭" —— 这条必须被钉住，
 * 因为它的失败方式很隐蔽：**弹窗关掉了，但模型调用还在跑**（token 照烧，用户却看不到任何东西）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dismissibleByBackdrop } from '../../src/client/modal-dismiss.ts';

test('执行中不许被"点空白 / Esc"关掉，非执行态才允许', () => {
  assert.equal(dismissibleByBackdrop(true), false, '执行中：只有明确的按钮能关');
  assert.equal(dismissibleByBackdrop(false), true, '没在跑：关掉没有副作用，允许');
});

/** 读客户端源码做**源码级**守卫（与 zone-hit 的那条同款思路：钉住"接线"而不是只测纯函数）。 */
function panelSource(): string {
  return readFileSync(new URL('../../src/client/board-panel.tsx', import.meta.url), 'utf8');
}

test('确认框与结果必须是模态框，且遮罩的关闭判断必须走那条闸门', () => {
  const source = panelSource();
  assert.match(source, /styles\.modalBackdrop/, '红框/白框要用模态框呈现（不再是标题区的内联块）');
  assert.match(source, /'data-pm-ai-modal': '1'/, '模态框要有自检锚点');
  assert.match(
    source,
    /if \(dismissibleByBackdrop\(aiBusy\)\)/,
    '点遮罩必须问一遍"执行中吗" —— 少这一步就等于"点空白也能关掉正在跑的调用"',
  );
  assert.ok(!source.includes('styles.confirmBox'), '内联确认框（红框）应已被模态框取代');
});

/**
 * 真机事故（用户原话："我现在点 model 内会直接 modal 消失，无法勾选呢"）：
 * 遮罩是卡片的**父元素**，`onMouseDown` 会从卡片冒泡上来 —— 不判"按的是不是遮罩本身"，
 * 点卡片里随便哪里（勾选框、按钮旁空白）都被当成"点了空白"，弹窗当场消失。
 */
test('点卡片内部不许被当成"点空白"（遮罩必须判真实按压目标）', () => {
  const source = panelSource();
  assert.match(
    source,
    /if \(event\.target !== event\.currentTarget\) return;/,
    '遮罩的处置必须先排除"事件来自卡片内部"，否则勾选框根本点不了',
  );
});

test('执行中必须给出**显式**中止入口，并且真的调用取消通道', () => {
  const source = panelSource();
  assert.match(source, /'data-pm-ai-cancel': '1'/, '执行中要有一个明确的中止按钮');
  assert.match(source, /postAiCancel\(\)/, '中止必须走宿主显式通道，而不是只把弹窗藏起来');
  assert.match(source, /aiBusy \? '调用中…' : '确认并开始建树'/, '执行中确认按钮要禁用并改口');
});

test('实时进度：粗估措辞 + 完成后保留（保持 100%）+ 有真实用量时说"实际消耗"', () => {
  const source = panelSource();
  assert.match(source, /'data-pm-ai-run': '1'/);
  assert.match(source, /已生成约 .* token（粗估/, 'token 是粗估，措辞里必须写出来');
  assert.match(source, /本次实际消耗：输出 .*（提供方回报）/, '有提供方用量时改口说实测');
  /**
   * **完成后必须保留**（用户口径："生成后，1图的那个进度条保留，保持 100%，并能看到 token 消耗"）。
   * 早先的门槛是 `aiBusy && board?.aiRun != null` —— 一跑完进度条就消失，用户看不到刚才花了多少。
   */
  assert.match(source, /board\?\.aiRun != null/, '只要宿主给了快照就显示（不再要求"正在跑"）');
  assert.ok(
    !source.includes('aiBusy && board?.aiRun'),
    '不许再加回"只在执行中显示进度条"——那会让完成后的 token 消耗看不见',
  );
  assert.match(source, /phase === 'done' \? 100/, '完成时进度条按 100% 画');
});

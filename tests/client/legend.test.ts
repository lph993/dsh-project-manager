/**
 * 图例的契约测试（用户反馈："不用在 tooltip 上展示每个图标或者 `自` 介绍，
 * 可以写到专门的地方"）。
 *
 * 图例最容易出的问题是**与实际画法脱节**：改了符号忘了改说明，用户就会看到
 * "图例里没有这个符号"。所以这里钉住三件事：
 * ① 每个计算状态都有条目（画布能画出多少种状态，图例就得解释多少种）；
 * ② 画布用的符号常量确实出现在图例里（符号与说明同源）；
 * ③ 条目不成空话（符号或说明至少有一个有内容）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DERIVED_STATE_LABEL } from '../../src/client/api.ts';
import {
  AUTO_BADGE,
  FOCUS_BADGE,
  MIDWAY_BADGE,
  PENDING_LEAF_MARK,
  ROLLBACK_BADGE,
  RUNNING_SPINNER,
  legendSections,
  stateLegend,
} from '../../src/client/legend.ts';

test('每个计算状态都在图例里有条目（除墓碑：它不进画布）', () => {
  const entries = stateLegend();
  const meanings = entries.map((entry) => entry.meaning).join('\n');
  for (const state of Object.keys(DERIVED_STATE_LABEL)) {
    if (state === 'removed') continue; // 墓碑不画在画布上，图例也就不需要它
    assert.match(
      meanings,
      new RegExp(DERIVED_STATE_LABEL[state] ?? state),
      `状态 ${state}（${DERIVED_STATE_LABEL[state]}）在图例里没有条目`,
    );
  }
});

test('画布用的符号常量都出现在图例里（同源，不会"图例里没这个符号"）', () => {
  const all = legendSections()
    .flatMap((section) => section.entries)
    .map((entry) => `${entry.glyph} ${entry.meaning}`)
    .join('\n');
  for (const glyph of [RUNNING_SPINNER, FOCUS_BADGE, MIDWAY_BADGE, AUTO_BADGE, ROLLBACK_BADGE, PENDING_LEAF_MARK]) {
    assert.ok(all.includes(glyph), `符号 ${glyph} 没有在图例里出现`);
  }
  // 自动生成用的是图标而不是中文字（用户反馈"自换成图标吧，合适点"）
  assert.equal(AUTO_BADGE, '⚙');
  assert.ok(!all.includes('自 自动生成'), '不该再有"自 = 自动生成"这种文字角标说明');
});

test('图例分节：完成态 / 状态 / 数字 / 连线 / 操作入口都在，且每节都有内容', () => {
  const sections = legendSections();
  assert.ok(sections.length >= 5);
  const titles = sections.map((section) => section.title).join('|');
  for (const keyword of ['完成态', '状态', '标记', '数字', '连线', '操作入口']) {
    assert.ok(titles.includes(keyword), `图例缺少「${keyword}」这一节`);
  }
  for (const section of sections) {
    assert.ok(section.entries.length > 0, `${section.title} 是空节`);
    for (const entry of section.entries) {
      assert.ok(
        entry.glyph !== '' || entry.meaning !== '',
        `${section.title} 里有一条既没有符号也没有说明`,
      );
    }
  }
});

test('连线一节把各级强弱都写清楚（选中 / 运行链路 / 悬停 / 关注枝 / 链路 / 旁枝）', () => {
  const line = legendSections()
    .find((section) => section.title.includes('连线'))
    ?.entries.map((entry) => entry.meaning)
    .join('\n');
  assert.ok(line !== undefined);
  for (const keyword of ['选中', '运行链路', '悬停', '关注枝', '链路', '旁枝', '枝色']) {
    assert.ok(line.includes(keyword), `连线图例缺少「${keyword}」`);
  }
});

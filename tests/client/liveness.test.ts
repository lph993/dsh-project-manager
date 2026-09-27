/**
 * "节点有没有人在跑"的判据测试（用户三次口径的最终结论）。
 *
 * 这条判据决定界面撒谎不撒谎：转圈 = "正在干活"，播放三角 = "这会儿没人在跑它"。
 * 判错的两种代价不一样 —— 该静的时候还转圈是**无依据地宣称在跑**（A3 不编造），
 * 该转的时候不转只是保守。所以边界一律往"静止"倒。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLiveNode } from '../../src/client/liveness.ts';

describe('节点活跃判据（转圈 vs 播放三角）', () => {
  it('节点所属会话正在忙 ⇒ 转圈', () => {
    assert.equal(isLiveNode({ lastSessionId: 's1' }, ['s1']), true);
    assert.equal(isLiveNode({ lastSessionId: 's1' }, ['s2', 's1']), true, '列表里有它就够');
  });

  it('**别的**会话在忙 ⇒ 这个节点不转圈（真机事故的防复发）', () => {
    /**
     * 用户截图原话："全在转，但是没有会话在跑吧" ——
     * 那 5 个 `running` 节点的 `lastSessionId` 是空的、`updatedAt` 是几小时前，
     * 却因为"某个会话在忙"整片转圈（当时判据是 `if (sessionBusy) return true`）。
     */
    assert.equal(isLiveNode({ lastSessionId: 'stale-session' }, ['current-session']), false);
    assert.equal(isLiveNode({ lastSessionId: undefined }, ['current-session']), false, '不知道归谁 ⇒ 不转');
    assert.equal(isLiveNode({ lastSessionId: '' }, ['current-session']), false);
    assert.equal(isLiveNode({}, ['current-session']), false);
  });

  it('没有任何会话在忙 ⇒ 一律不转圈（不靠"最近写过"来推测）', () => {
    assert.equal(isLiveNode({ lastSessionId: 's1' }, []), false);
    assert.equal(isLiveNode({}, []), false);
  });

  it('边界的对称性：同一个节点，忙的会话列表一变结论就跟着变', () => {
    const node = { lastSessionId: 's1' };
    assert.equal(isLiveNode(node, []), false);
    assert.equal(isLiveNode(node, ['s1']), true);
    assert.equal(isLiveNode(node, []), false, '会话停下 ⇒ 立刻回到 ▶（不许残留转圈）');
  });
});

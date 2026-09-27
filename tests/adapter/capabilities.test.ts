/**
 * `effectiveSandboxMode` 的契约（FR-163 的判据来源）。
 *
 * 真机事故（用户当场指出："完全权限是能删除且不审核的，你处理呗"）：
 * 用户在**完全权限**下删节点，插件却仍然去要审批，而会话策略是 `never` ⇒ **被确定性拒绝**。
 * 根因：我们读的是 `ctx.sandboxPolicy.mode` —— 宿主自己的类型注释写着它是
 * *"File-sandbox mode a session **starts from**"*（**部署默认档位**）；
 * 运行时切的档位记录成**该会话的 `sandbox/mode` 事件**，实际生效值由
 * `resolve({session})` 折出来（显式授权 > 会话 override > 部署默认）。
 * 于是"完全权限免审核"在**运行时切档**的情形下从来没生效过。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from '@deepseek-ai/cordis';

import { effectiveSandboxMode } from '../../src/adapter/capabilities.ts';
import { guardAskFor } from '../../src/tools/guard.ts';

/** 造一个最小 ctx：只有 `get('sandboxPolicy')` 这一条路径（其余字段与本次判据无关）。 */
const ctxWith = (policy: unknown): Context =>
  ({
    get: (key: string) => (key === 'sandboxPolicy' ? policy : undefined),
  }) as unknown as Context;

describe('本次调用实际生效的沙箱档位', () => {
  it('**会话 override 压过部署默认**（这就是那次事故的修法）', () => {
    const ctx = ctxWith({
      defaultMode: 'workspace-write',
      mode: 'workspace-write',
      resolve: () => ({ mode: 'danger-full-access' }),
    });
    assert.equal(
      effectiveSandboxMode(ctx, { id: 'session-a' }),
      'danger-full-access',
      '用户运行时切到完全权限 ⇒ 判据必须是它，不能再看部署默认',
    );
  });

  it('没有 resolve 时退到会话 override，再退到部署默认（逐级降级，不猜）', () => {
    assert.equal(
      effectiveSandboxMode(ctxWith({ overrideOf: () => 'read-only' }), { id: 's' }),
      'read-only',
      'overrideOf 可用时用它',
    );
    assert.equal(
      effectiveSandboxMode(ctxWith({ defaultMode: 'workspace-write' }), { id: 's' }),
      'workspace-write',
      '两者都没有 ⇒ 部署默认（保守且如实）',
    );
  });

  it('拿不到任何信息 / 值非法 ⇒ undefined（调用方按保守处理）', () => {
    assert.equal(effectiveSandboxMode(ctxWith(undefined), undefined), undefined);
    assert.equal(effectiveSandboxMode(ctxWith({ resolve: () => ({ mode: 'nonsense' }) })), undefined);
    assert.equal(effectiveSandboxMode(ctxWith({ resolve: () => { throw new Error('boom'); } })), undefined);
  });

  it('折出来的档位直接决定"要不要审批"：完全权限 ⇒ 免审核（FR-163）', () => {
    const live = effectiveSandboxMode(
      ctxWith({ defaultMode: 'workspace-write', resolve: () => ({ mode: 'danger-full-access' }) }),
      { id: 's' },
    );
    assert.equal(guardAskFor('pm_remove', live), undefined, '完全权限下删除不该再弹审批');
    assert.notEqual(
      guardAskFor('pm_remove', 'workspace-write'),
      undefined,
      '工作区可写档位仍然要审批（行为不变）',
    );
  });
});

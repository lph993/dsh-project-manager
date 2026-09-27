/**
 * `tools/pre-execute` 载荷读法的测试（**这条测试的存在本身就是一次事故的产物**）。
 *
 * 事故：审批门读 `exec.toolName` / `exec.session`，而宿主给的是 `{ name, arguments, agent }`
 * ⇒ 真机上工具名恒为 `undefined` ⇒ 审批门**静默失效**（FR-163 的"完全权限免审核"看起来
 * 生效了，其实是它从来没问过）。所以这里用**宿主真实形状**的载荷把字段名钉死，
 * 并保留旧字段名的回退（rc 之间漂移时闸门不许再次默默失灵）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { execViewOf, touchedPathsOf } from '../../src/adapter/exec-view.ts';

describe('pre-execute 载荷读法（宿主契约 name / arguments / agent）', () => {
  it('宿主真实形状：name + arguments + agent.{id,session}', () => {
    const session = { header: { cwd: 'Z:\\demo' } };
    const view = execViewOf({
      callId: 'call-1',
      name: 'pm_remove',
      arguments: { nodeIds: ['a'] },
      agent: { id: 'session-1', session },
    });
    assert.equal(view.toolName, 'pm_remove', '工具名取 exec.name（不是 toolName）');
    assert.deepEqual(view.args, { nodeIds: ['a'] });
    assert.equal(view.session, session, '会话**对象**取 agent.session');
    assert.equal(view.sessionId, 'session-1', '会话 id 取 agent.id');
  });

  it('旧字段名仍能读（回退，不许因为一次改名就让闸门失灵）', () => {
    const view = execViewOf({ toolName: 'pm_rollback', args: { nodeId: 'n' }, session: 'session-9' });
    assert.equal(view.toolName, 'pm_rollback');
    assert.deepEqual(view.args, { nodeId: 'n' });
    assert.equal(view.sessionId, 'session-9');
    assert.equal(view.session, undefined, '字符串 id 不是会话对象：不许冒充 Session 交给沙箱策略');
  });

  it('任何垃圾输入都不抛，且读不到就说读不到（不猜）', () => {
    for (const input of [undefined, null, 42, 'pm_remove', [], { agent: null }, { name: '' }]) {
      const view = execViewOf(input);
      assert.equal(view.toolName, undefined, `${JSON.stringify(input)} 不该读出一个工具名`);
      assert.equal(view.session, undefined);
      assert.equal(view.sessionId, undefined);
    }
  });

  it('agent 存在但没有 session 字段 ⇒ 会话对象为空，但 id 还在（调用方可去注册表换）', () => {
    const view = execViewOf({ name: 'pm_remove', agent: { id: 'session-2' } });
    assert.equal(view.session, undefined);
    assert.equal(view.sessionId, 'session-2');
  });
});

describe('FR-161 判据输入：从写入类参数里取改动路径', () => {
  it('认宿主文件工具的 path / file_path，并去重', () => {
    assert.deepEqual(touchedPathsOf({ path: 'src/a.ts' }), ['src/a.ts']);
    assert.deepEqual(touchedPathsOf({ file_path: 'src/b.ts' }), ['src/b.ts']);
    assert.deepEqual(touchedPathsOf({ paths: ['src/a.ts', 'src/a.ts', 'src/c.ts'] }), [
      'src/a.ts',
      'src/c.ts',
    ]);
  });

  it('读不出来就是空数组（**不猜**：猜错会把正常改动拦下来，和该拦不拦一样错）', () => {
    for (const input of [undefined, null, {}, { path: 42 }, { path: '' }, { paths: 'x' }, []]) {
      assert.deepEqual(touchedPathsOf(input), [], `${JSON.stringify(input)} 不该编出路径`);
    }
  });
});

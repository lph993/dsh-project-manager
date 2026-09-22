import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkTransition,
  deriveState,
  gateAllowedOn,
  isTerminal,
  isUnfinished,
  strongestGate,
} from '../../src/domain/state.ts';

test('迁移表：pending 可开始/直接完成/失败', () => {
  assert.equal(checkTransition('pending', 'running').ok, true);
  assert.equal(checkTransition('pending', 'done').ok, true);
  assert.equal(checkTransition('pending', 'error').ok, true);
});

test('迁移表：done 不可静默回退（C6 需要 force + user）', () => {
  const toRunning = checkTransition('done', 'running');
  assert.equal(toRunning.ok, true);
  assert.deepEqual(toRunning.requires, ['force', 'user']);
  const toError = checkTransition('done', 'error');
  assert.deepEqual(toError.requires, ['force', 'user']);
});

test('迁移表：running → pending 回退需要 force', () => {
  const check = checkTransition('running', 'pending');
  assert.equal(check.ok, true);
  assert.deepEqual(check.requires, ['force']);
});

test('迁移表：removed 不可再推进', () => {
  const check = checkTransition('removed', 'running');
  assert.equal(check.ok, false);
  assert.match(check.reason ?? '', /已删除/);
});

test('计算状态规则 0：自身或祖先 removed 优先于门控', () => {
  const state = deriveState({
    selfState: 'running',
    gate: 'held',
    ancestorRemoved: true,
    ancestorGate: 'held',
    descendantStates: ['running'],
    hasChildren: true,
  });
  assert.equal(state, 'removed');
});

test('计算状态规则 1/2：held 优先于 paused（含祖先继承）', () => {
  assert.equal(
    deriveState({
      selfState: 'running',
      gate: 'paused',
      ancestorRemoved: false,
      ancestorGate: 'held',
      descendantStates: [],
      hasChildren: false,
    }),
    'held',
  );
  assert.equal(
    deriveState({
      selfState: 'pending',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: 'paused',
      descendantStates: [],
      hasChildren: false,
    }),
    'paused',
  );
});

test('计算状态规则 3：子孙 error 使父节点 error', () => {
  assert.equal(
    deriveState({
      selfState: 'pending',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: null,
      descendantStates: ['done', 'error'],
      hasChildren: true,
    }),
    'error',
  );
});

test('计算状态规则 4：子孙 running 使整枝 running（FR-42）', () => {
  assert.equal(
    deriveState({
      selfState: 'pending',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: null,
      descendantStates: ['done', 'running'],
      hasChildren: true,
    }),
    'running',
  );
});

test('计算状态规则 5：自身 done 且子孙全为 done/removed', () => {
  assert.equal(
    deriveState({
      selfState: 'done',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: null,
      descendantStates: ['done', 'removed'],
      hasChildren: true,
    }),
    'done',
  );
  // 有未完成子孙时不得显示完成（FR-46b）
  assert.equal(
    deriveState({
      selfState: 'done',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: null,
      descendantStates: ['done', 'pending'],
      hasChildren: true,
    }),
    'pending',
  );
});

test('计算状态规则 6：其余为 pending', () => {
  assert.equal(
    deriveState({
      selfState: 'pending',
      gate: null,
      ancestorRemoved: false,
      ancestorGate: null,
      descendantStates: [],
      hasChildren: false,
    }),
    'pending',
  );
});

test('strongestGate：held 优先', () => {
  assert.equal(strongestGate(['paused', 'held']), 'held');
  assert.equal(strongestGate(['paused', null]), 'paused');
  assert.equal(strongestGate([null, null]), null);
});

test('gateAllowedOn：拦停仅父节点', () => {
  assert.equal(gateAllowedOn('held', 0), false);
  assert.equal(gateAllowedOn('held', 2), true);
  assert.equal(gateAllowedOn('paused', 0), true);
});

test('isTerminal / isUnfinished', () => {
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('removed'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isUnfinished('done'), false);
  assert.equal(isUnfinished('removed'), false);
  assert.equal(isUnfinished('held'), true);
  assert.equal(isUnfinished('paused'), true);
  assert.equal(isUnfinished('pending'), true);
});

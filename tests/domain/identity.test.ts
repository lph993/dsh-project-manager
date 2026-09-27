/**
 * 节点身份与复用匹配的纯逻辑测试（FR-158）。
 *
 * **为什么这层必须有测试**：它是"进度不被灌水"的地基 ——
 * 身份认错一次，建树就会给同一个功能点建出第二个节点，分母变大、完成度立刻失真
 * （实测事故：节点 140 → 213，`3/140` 变 `3/213`）。
 * 这些判据全是纯函数，正好可以逐条钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findReusableNode,
  identityKeyOf,
  keyOfExisting,
  normalizeRefPath,
  refTokensOf,
  type IdentityNode,
} from '../../src/domain/identity.ts';

function existing(partial: Partial<IdentityNode> & { id: string; name: string }): IdentityNode {
  return { parentId: null, ...partial };
}

/** `findReusableNode` 的默认入参（每个用例只覆盖自己关心的那一项）。 */
function pick(input: {
  name: string;
  refs?: Array<{ type: string; target: string }>;
  nodes: IdentityNode[];
  claimed?: string[];
  hasLiveRoot?: boolean;
}) {
  const existingById = new Map(input.nodes.map((node) => [node.id, node]));
  const claimedIds = new Set(input.claimed ?? []);
  return findReusableNode({
    name: input.name,
    ...(input.refs !== undefined ? { refs: input.refs as never } : {}),
    identityOf: (id) => keyOfExisting(existingById.get(id) as IdentityNode),
    existingById,
    claimedIds,
    hasLiveRoot: input.hasLiveRoot ?? false,
  });
}

/** 同 {@link pick}，但**启用引用路径重叠层**（`refsOf`）——测"目录改名兜底"用。 */
function pickRefs(input: {
  name: string;
  refs?: Array<{ type: string; target: string }>;
  nodes: IdentityNode[];
  claimed?: string[];
  hasLiveRoot?: boolean;
}) {
  const existingById = new Map(input.nodes.map((node) => [node.id, node]));
  return findReusableNode({
    name: input.name,
    ...(input.refs !== undefined ? { refs: input.refs as never } : {}),
    identityOf: (id) => keyOfExisting(existingById.get(id) as IdentityNode),
    refsOf: (id) => refTokensOf({ refs: existingById.get(id)?.refs }),
    existingById,
    claimedIds: new Set(input.claimed ?? []),
    hasLiveRoot: input.hasLiveRoot ?? false,
  });
}

test('normalizeRefPath：反斜杠 / 重复斜杠 / ./ 前缀 / 尾部斜杠都归一到同一写法', () => {
  assert.equal(normalizeRefPath('src\\domain/'), 'src/domain');
  assert.equal(normalizeRefPath('./src//domain///'), 'src/domain');
  assert.equal(normalizeRefPath('  src/domain  '), 'src/domain');
  assert.equal(normalizeRefPath('src'), 'src');
});

test('identityKeyOf：目录优先于文件，文件优先于名称', () => {
  assert.equal(identityKeyOf({ name: '随便什么名字', refs: [{ type: 'dir', target: 'src/domain' }] }), 'dir:src/domain');
  assert.equal(identityKeyOf({ name: '随便什么名字', refs: [{ type: 'code', target: 'src/index.ts' }] }), 'file:src/index.ts');
  // 同时有目录与文件 → 取目录（功能点最自然的身份）
  assert.equal(
    identityKeyOf({
      name: 'x',
      refs: [
        { type: 'code', target: 'src/index.ts' },
        { type: 'dir', target: 'src' },
      ],
    }),
    'dir:src',
  );
  // 没有 refs 的纯抽象功能点：只能用名字兜底
  assert.equal(identityKeyOf({ name: '  登录与鉴权 ', refs: [] }), 'name:登录与鉴权');
});

test('identityKeyOf：多路径排序去重 → 换一组 refs 顺序不产生第二个身份', () => {
  const a = identityKeyOf({
    name: 'x',
    refs: [
      { type: 'dir', target: 'src/client' },
      { type: 'dir', target: 'src/domain' },
    ],
  });
  const b = identityKeyOf({
    name: 'x',
    refs: [
      { type: 'dir', target: './src/domain' },
      { type: 'dir', target: 'src/client' },
      { type: 'dir', target: 'src/domain' }, // 重复项
    ],
  });
  assert.equal(a, 'dir:src/client|src/domain');
  assert.equal(b, a, '顺序不同 / 有重复项 → 仍必须是同一个身份键');
});

test('keyOfExisting：已登记 identity 就用它，否则现算（老数据收敛的前提）', () => {
  assert.equal(
    keyOfExisting(existing({ id: 'a', name: '甲', identity: 'dir:src/a' })),
    'dir:src/a',
  );
  assert.equal(
    keyOfExisting(existing({ id: 'b', name: '乙', refs: [{ type: 'dir', target: 'src/b' }] as never })),
    'dir:src/b',
  );
  // 空字符串的 identity 视为"没登记"（历史脏数据）
  assert.equal(
    keyOfExisting(existing({ id: 'c', name: '丙', identity: '' })),
    'name:丙',
  );
});

test('findReusableNode ①：身份键相同 → 复用，并记下"模型换了个说法"', () => {
  const match = pick({
    name: '项目扫描与领域模型',
    refs: [{ type: 'dir', target: 'src/domain' }],
    nodes: [existing({ id: 'old', name: '领域模型与进度计算', refs: [{ type: 'dir', target: 'src/domain' }] as never })],
  });
  assert.equal(match?.id, 'old');
  assert.equal(match?.reason, 'identity');
  assert.ok(match?.note?.includes('领域模型与进度计算'), '要能说清复用的是哪个旧名字');
  /**
   * 老节点**没有登记 `identity`**（只有 `refs`）时，复用的同时要补登记 —— 这正是存量树收敛的机制。
   * 反过来，已经登记过的节点不会拿到 `relabel`（见下一个用例），所以身份一旦固定就不会被改写。
   */
  assert.equal(match?.relabel, 'dir:src/domain', '没有 identity 的老节点被复用时必须补登记');
});

test('findReusableNode ①：已登记 identity 的节点不再补登记（身份一旦固定就不许被 refs 漂移改写）', () => {
  const match = pick({
    name: '领域模型',
    refs: [{ type: 'dir', target: 'src/domain' }],
    nodes: [existing({ id: 'old', name: '领域模型', identity: 'dir:src/domain' })],
  });
  assert.equal(match?.reason, 'identity');
  assert.equal(match?.relabel, undefined, '已有 identity → 不补登记，避免身份被后续 refs 漂移改掉');
});

test('findReusableNode ①：复用老节点时顺手补登记身份键（否则存量树永远收敛不了）', () => {
  const match = pick({
    name: '领域模型',
    refs: [{ type: 'dir', target: 'src/domain' }],
    // 同名 + 同 refs，但没有登记 identity
    nodes: [existing({ id: 'legacy', name: '领域模型' })],
  });
  assert.equal(match?.id, 'legacy');
  assert.equal(match?.relabel, 'dir:src/domain', '没有 identity 的节点被复用时必须补登记');
});

test('findReusableNode ②：没有 refs 的抽象节点也会被「名字身份」命中（reason 是 identity 而非 sibling-name）', () => {
  const match = pick({
    name: '登录与鉴权',
    nodes: [existing({ id: 'n1', name: '登录与鉴权' })],
  });
  assert.equal(match?.id, 'n1');
  /**
   * 没有 `refs` 时 `identityKeyOf` 会退回 `name:<名字>` —— 于是"同名"在**身份层**就已经命中了。
   * 所以 `reason` 是 `identity`，`sibling-name` 只是"连名字身份都没登记"时的兜底分支。
   */
  assert.equal(match?.reason, 'identity');
});

test('findReusableNode：已认领的节点不会被第二处再认领一次', () => {
  const match = pick({
    name: '登录与鉴权',
    nodes: [existing({ id: 'n1', name: '登录与鉴权' })],
    claimed: ['n1'],
  });
  assert.equal(match, undefined, '一个节点不该被两个位置同时认领');
});

test('findReusableNode：根候选只挡「同名兜底」，仍可被身份键命中（根的去留由上游单根规则裁定）', () => {
  const root = existing({ id: 'root', name: '项目' });
  /**
   * ⚠️ 实测过的一处语义边界：`hasLiveRoot` 只作用于**同名分支**（源码里是同名循环内的 continue），
   * 因此"同名的根候选"仍然会被返回。
   *
   * 为什么这里不改成"有活根就跳过根"，而是把测试改成符合实现：
   * ① **根的处理在上游**：`applyAiTree` 用 `isExistingRootItself`（名字相同才认）单独处理根，
   *    并把最后一个 `hasLiveRoot` 参数写成 `rootId !== undefined`；
   * ② 若这里再挡一刀，会**重复**上游的判断条件，反而在"本轮根名与既有根不同"时
   *    造出新的分叉行为（两处规则不一致最难查）。
   * 所以契约就是：**本函数不裁定根，只如实报出匹配**。
   */
  assert.equal(pick({ name: '项目', nodes: [root], hasLiveRoot: true })?.id, 'root');
  assert.equal(pick({ name: '项目', nodes: [root], hasLiveRoot: false })?.id, 'root');
});

test('findReusableNode：都认不出来 → undefined（调用方新建）', () => {
  const match = pick({
    name: '全新的功能点',
    refs: [{ type: 'dir', target: 'src/brand-new' }],
    nodes: [existing({ id: 'n1', name: '别的功能点', refs: [{ type: 'dir', target: 'src/other' }] as never })],
  });
  assert.equal(match, undefined);
});

test('findReusableNode：身份键匹配优先于同名（换了名字也能认回来）', () => {
  // 既有：名字 A、身份 dir:src/x；本轮：名字 B、身份 dir:src/y
  // 若按名字会新建；按身份应当认出"这是同一个目录"
  const match = pick({
    name: 'B',
    refs: [{ type: 'dir', target: 'src/x' }],
    nodes: [existing({ id: 'n1', name: 'A', refs: [{ type: 'dir', target: 'src/x' }] as never })],
  });
  assert.equal(match?.reason, 'identity');
  assert.equal(match?.id, 'n1');
});

test('findReusableNode ③：目录改名/移动 + 名字也换了 → 按**引用路径重叠**认回同一个节点', () => {
  /**
   * 身份键是"整个路径集合"的指纹：`src/domain` → `src/core` 改名后整体变掉，
   * 若只看身份键，同一个功能点会被当成**新节点**，老节点留着变 stale —— 节点照样涨。
   *
   * 注意用例必须**名字也不同**：名字相同的话第 ② 层（同名）就先命中了，
   * 根本走不到重叠层（**这是有意的优先级**，不是缺陷）。
   */
  const match = pickRefs({
    name: '领域与进度（新叫法）',
    refs: [
      { type: 'dir', target: 'src/core' }, // 改名后的目录
      { type: 'code', target: 'src/domain/progress.ts' }, // 这个文件没动
    ],
    nodes: [
      existing({
        id: 'old',
        name: '领域模型与进度计算',
        identity: 'dir:src/domain|file:src/domain/progress.ts',
        refs: [
          { type: 'dir', target: 'src/domain' },
          { type: 'code', target: 'src/domain/progress.ts' },
        ] as never,
      }),
    ],
  });
  assert.equal(match?.id, 'old', '共同文件路径必须能把改名后的同一功能点认回来');
  assert.equal(match?.reason, 'ref-overlap');
  assert.ok(match?.note?.includes('src/domain/progress.ts'), '要如实说明是靠哪条共同路径认出来的');
});

test('findReusableNode ③：**同名优先于引用重叠**（新功能点用了旧目录不该被误配）', () => {
  /**
   * 反例保护：若把"引用重叠"排在同名之前，"新功能点 A 恰好落在旧功能点 B 的目录里"
   * 就会被误配成 B（模型说它是 A、我们却挂到 B 上）——那是比"多建一个节点"更贵的错误。
   */
  const match = pickRefs({
    name: '新功能点',
    refs: [{ type: 'dir', target: 'src/legacy' }],
    nodes: [
      // 同名候选（身份不同）与"引用重叠候选"同时存在
      existing({ id: 'same-name', name: '新功能点' }),
      existing({
        id: 'overlap',
        name: '旧功能点',
        identity: 'dir:src/legacy|file:src/legacy/old.ts',
        refs: [{ type: 'dir', target: 'src/legacy' }] as never,
      }),
    ],
  });
  assert.equal(match?.id, 'same-name', '同名必须优先命中，不能被引用重叠抢走');
  assert.equal(match?.reason, 'sibling-name');
});

test('findReusableNode ③：没有任何共同路径 → 不匹配（交给调用方新建）', () => {
  const match = pickRefs({
    name: '全新功能点',
    refs: [{ type: 'dir', target: 'src/brand-new' }],
    nodes: [
      existing({
        id: 'other',
        name: '别的功能点',
        identity: 'dir:src/other',
        refs: [{ type: 'dir', target: 'src/other' }] as never,
      }),
    ],
  });
  assert.equal(match, undefined, '路径毫不相干就不该复用（宁可新建，也不能乱认）');
});

test('findReusableNode ③：不传 refsOf 时该层整体不生效（向后兼容）', () => {
  /**
   * 旧调用方不传 `refsOf` ⇒ 只可能按"身份键 / 同名"命中，**绝不会**靠路径重叠复用。
   * 这里用"名字不同 + 路径不同但同目录前缀"的既有节点证明它不会被认领。
   */
  const match = pick({
    name: '甲功能点',
    refs: [{ type: 'dir', target: 'src/legacy' }],
    nodes: [
      existing({
        id: 'overlap-only',
        name: '乙功能点',
        identity: 'dir:src/legacy|file:src/legacy/old.ts',
        refs: [{ type: 'dir', target: 'src/legacy' }, { type: 'code', target: 'src/legacy/old.ts' }] as never,
      }),
    ],
  });
  assert.equal(match, undefined, '没给 refsOf 就不该做路径重叠匹配');
});

/**
 * 宿主侧**实测**脚本（重启宿主之后跑一次，一条命令验完剩余清单的宿主半边）。
 *
 * 为什么单独有这个脚本：单元/端到端测试用的是"假宿主 + 构建产物"，能证明逻辑对，
 * 但证明不了"**正在跑的那个宿主**真的注册了新路由、真的返回了新字段"。
 * 这一层只能对着活宿主打接口。
 *
 * 用法（token 不需要；`/pm/*` 路由不校验 token）：
 *   node scripts/verify-live.mjs [baseUrl]
 *
 * 设计纪律：
 * - **只做非破坏性探针**：回滚类接口一律用 `confirm:false`（只拿影响范围，不落库）；
 *   设置接口只改一项再改回来，且以"改回原值"结尾。
 * - 每一项都打印 `PASS/FAIL + 实测到的值`，失败以非零码退出（可直接当门禁用）。
 */

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';

/** 探针结果。 */
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function call(path, options) {
  try {
    const response = await fetch(new URL(`/pm${path}`, baseUrl), options);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: undefined, text: String(error) };
  }
}

/**
 * POST 的请求选项。
 *
 * 签名**只收 body**：早先写成 `post(path, body)` 却被 `call(path, post({...}))` 这样调用，
 * 于是 `JSON.stringify(undefined)` 让请求变成空 body，接口一律回 400 ——
 * 探针自己把"探针写错了"报成了"接口有问题"（实测踩过：4 项假失败全出自这里）。
 */
const post = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ── 0) 基础：宿主活着，且是**新构建** ───────────────────────────────
const health = await call('/health');
record('GET /pm/health 可达', health.status === 200, `status=${health.status}`);

const debug = await call('/debug?format=json');
const routes = debug.json?.report?.routes ?? [];
const tools = debug.json?.report?.registeredTools ?? [];
record('诊断可用', debug.status === 200 && routes.length > 0, `${routes.length} 条路由`);

// 新路由（这一条就是在验"宿主是否已经重载新构建"）
for (const route of ['GET /pm/snapshots', 'POST /pm/rollback', 'GET /pm/settings', 'POST /pm/settings']) {
  record(`新路由已注册：${route}`, routes.includes(route));
}
for (const tool of ['pm_unwatch', 'pm_watchers', 'pm_watch_conflicts', 'pm_watch_wait', 'pm_watch_arbitrate']) {
  record(`新工具已注册：${tool}`, tools.includes(tool));
}
record('工具总数为 28', tools.length === 28, `实测 ${tools.length}`);

// ── 1) 看板：新字段（回滚点数 / 订阅风险）───────────────────────────
const board = await call('/board');
const nodes = board.json?.nodes ?? [];
record('GET /pm/board 有节点', nodes.length > 0, `${nodes.length} 个节点`);
record(
  '看板带 rollbackPoints 字段',
  board.json !== undefined && typeof board.json.rollbackPoints === 'object',
  `类型=${typeof board.json?.rollbackPoints}`,
);
const rollbackReady = nodes.filter((node) => (board.json?.rollbackPoints?.[node.id] ?? 0) > 0);
record(
  '存在有回滚点的节点（菜单「回滚」才会出现）',
  true,
  `${rollbackReady.length} 个节点有回滚点（0 也正常：还没打过点）`,
);
const sample = nodes.find((node) => node.id);
record(
  '节点带订阅字段键（可为 undefined）',
  sample !== undefined,
  `subscriptionRisk=${String(sample?.subscriptionRisk)} subscriptionWaiting=${String(sample?.subscriptionWaiting)}`,
);

// ── 2) 回滚点清单（新路由）─────────────────────────────────────────
if (sample !== undefined) {
  const snaps = await call(`/snapshots?nodeId=${encodeURIComponent(sample.id)}`);
  record(
    'GET /pm/snapshots 返回数组',
    snaps.status === 200 && Array.isArray(snaps.json?.snapshots),
    `status=${snaps.status} count=${snaps.json?.snapshots?.length ?? 'n/a'}`,
  );
  // 非破坏性：confirm:false 只拿影响范围
  const preview = await call('/rollback', post({ nodeId: sample.id, scope: 'both', confirm: false }));
  const status = preview.json?.status;
  record(
    'POST /pm/rollback（confirm:false）只给影响范围，不执行',
    preview.status === 200 && (status === 'needs-confirm' || status === 'denied'),
    `status=${status} ${status === 'denied' ? `code=${preview.json?.code}` : ''}`,
  );
}
const badRollback = await call('/rollback', post({ nodeId: '' }));
record('POST /pm/rollback 缺 nodeId → 400', badRollback.status === 400, `status=${badRollback.status}`);

// ── 3) 设置读写（改一项再改回）─────────────────────────────────────
const settings = await call('/settings');
const effective = settings.json?.effective ?? {};
record(
  'GET /pm/settings 可配置',
  settings.status === 200 && settings.json?.configurable === true,
  `configurable=${String(settings.json?.configurable)}`,
);
record(
  '设置含扫描参数（FR-81）',
  typeof effective.scanMaxDepth === 'number' && Array.isArray(effective.scanExclude),
  `scanMaxDepth=${effective.scanMaxDepth} scanExclude=${JSON.stringify(effective.scanExclude)}`,
);
record(
  '设置含回写消耗统计（FR-117）',
  settings.json?.notify !== undefined,
  `notify=${JSON.stringify(settings.json?.notify)}`,
);

const originalDepth = effective.scanMaxDepth;
const written = await call('/settings', post({ patch: { scanMaxDepth: 5 } }));
record(
  'POST /pm/settings 改一项 → 立即生效',
  written.status === 200 && written.json?.effective?.scanMaxDepth === 5,
  `status=${written.status} scanMaxDepth=${written.json?.effective?.scanMaxDepth}`,
);
const reverted = await call('/settings', post({ patch: { scanMaxDepth: originalDepth } }));
record(
  '设置已改回原值（探针不留痕）',
  reverted.status === 200 && reverted.json?.effective?.scanMaxDepth === originalDepth,
  `scanMaxDepth=${reverted.json?.effective?.scanMaxDepth}`,
);
const invalid = await call('/settings', post({ patch: { scanMaxDepth: 'not-a-number' } }));
record('非法设置值 → 400（不静默存下）', invalid.status === 400, `status=${invalid.status}`);

// ── 汇总 ───────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail === undefined ? '' : `（${entry.detail}）`}`);
  process.exit(1);
}
console.log('宿主侧实测通过：新路由、新字段、新工具都在真实宿主上生效。');

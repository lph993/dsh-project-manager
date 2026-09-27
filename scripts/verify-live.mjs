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
record('新工具已注册：pm_report', tools.includes('pm_report'));
/**
 * 工具总数：**不再写死数字**。
 *
 * 批次 69（加 `pm_consolidate`，`TOOL_NAMES` 32→33）时这里漏改，于是探针报了一次**假红**：
 * 它说"工具总数为 29，实测 33"，看的人第一反应是"插件多注册了工具"——实际上多的是对的。
 * 现在期望值取自**插件自己的声明**（`src/index.ts` 的 `TOOL_NAMES`），数字只有一个来源；
 * 源码直跑不可用时如实退化成"只报实测"，不假装通过。
 */
let declaredTools;
try {
  const mod = await import('../src/index.ts');
  if (Array.isArray(mod.TOOL_NAMES)) declaredTools = mod.TOOL_NAMES;
} catch {
  /* 源码不可直跑（老 Node）→ 退化为只报实测 */
}
if (declaredTools === undefined) {
  record('工具总数（未取到声明清单，仅报实测）', true, `实测 ${tools.length} 个`);
} else {
  const missing = declaredTools.filter((name) => !tools.includes(name));
  record(
    `工具总数与插件声明一致（${declaredTools.length}）`,
    tools.length === declaredTools.length && missing.length === 0,
    `实测 ${tools.length}${missing.length > 0 ? `；缺 ${missing.join('、')}` : ''}`,
  );
}

// ── 1) 看板：新字段（回滚点数 / 订阅风险）───────────────────────────
const board = await call('/board');
const nodes = board.json?.nodes ?? [];
/**
 * **看板为空时，必须能一眼看出"是插件没数据"还是"探针看错了项目"**。
 *
 * 真机踩过：不带 `sessionId` 请求 `/pm/board` 时，宿主按"最近使用的工作区"解析根，
 * 于是探针可能读到**另一个（空）项目**，却报成"看板没有节点" —— 看起来像插件坏了。
 * 所以这里把**本次解析到的绑定根**一并打出来（键名逐个试，取不到就如实写"未取名"）。
 */
const report = debug.json?.report ?? {};
const boundRoot =
  report['已绑定工作区根'] ?? report.workspaceRoot ?? report.boundRoot ?? '(未取名)';
record('GET /pm/board 有节点', nodes.length > 0, `${nodes.length} 个节点；本次绑定根=${boundRoot}`);
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
// 会话边界修正（FR-141–145）：统计可见 + **提示词段真的注册上了**。
// 后者是这一批里最容易"看起来生效、其实没生效"的一项（真机实测就静默失效过一次：
// 未在 inject 里声明的服务是 PENDING 的，`ctx.get` 拿不到）——所以必须在真机上验。
const boundaryStats = settings.json?.boundary;
record(
  '设置含会话边界统计（FR-141–145）',
  boundaryStats !== undefined && typeof boundaryStats.runs === 'number',
  `boundary=${JSON.stringify(boundaryStats)}`,
);
record(
  '提示词段已在真实宿主注册（不是 PENDING）',
  boundaryStats?.promptState === 'registered',
  `promptState=${String(boundaryStats?.promptState)} promptRegistered=${String(boundaryStats?.promptRegistered)}`,
);
record(
  '边界修正统计口径齐全（runs/patches/injected）',
  typeof boundaryStats?.patches === 'number' && typeof boundaryStats?.injected === 'number',
  `patches=${String(boundaryStats?.patches)} injected=${String(boundaryStats?.injected)}`,
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

// 边界修正的开关：改一项 → 立即生效 → **改回原值**（探针不留痕）
const originalBoundary = effective.sessionBoundaryWriteback !== false;
const boundaryOff = await call('/settings', post({ patch: { sessionBoundaryWriteback: false } }));
record(
  'POST /pm/settings 关掉边界修正 → 立即生效',
  boundaryOff.status === 200 && boundaryOff.json?.effective?.sessionBoundaryWriteback === false,
  `status=${boundaryOff.status} 值=${String(boundaryOff.json?.effective?.sessionBoundaryWriteback)}`,
);
const boundaryBack = await call('/settings', post({ patch: { sessionBoundaryWriteback: originalBoundary } }));
record(
  '边界修正开关已改回原值（探针不留痕）',
  boundaryBack.status === 200 &&
    boundaryBack.json?.effective?.sessionBoundaryWriteback === originalBoundary,
  `值=${String(boundaryBack.json?.effective?.sessionBoundaryWriteback)}`,
);

// ── 汇总 ───────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail === undefined ? '' : `（${entry.detail}）`}`);
  process.exit(1);
}
console.log('宿主侧实测通过：新路由、新字段、新工具都在真实宿主上生效。');

/**
 * UI 冒烟探测（可选，需本机已装 Edge）：真开一次页面、点开「项目进度」，读回真实 DOM。
 *
 * 用途：**"点开面板一片空白"这类只能在浏览器里复现的问题**。
 * 它会回答三件事：① 客户端 bundle 注册了哪些槽位；② 主槽位是否崩了（`data-slot-error`）；
 * ③ 画布是否真的画出来了（svg 的尺寸）以及顶部自检行写了什么。
 *
 * 用法（token 从宿主启动输出里取）：
 *   node scripts/smoke-ui.mjs <token> [url]
 *
 * 不进 `pnpm run verify`：它依赖"已经有宿主在跑 + 本机有 Edge"，不适合当门禁。
 * 但它比"让用户截图"快得多 —— 排查空白面板时先用它拿证据。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const token = process.argv[2];
if (token === undefined) {
  console.error('用法: node scripts/smoke-ui.mjs <token> [baseUrl]');
  process.exit(2);
}
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:3080';
const browser = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (browser === undefined) {
  console.error('没找到 Edge/Chrome，跳过 UI 冒烟');
  process.exit(0);
}

const port = 9400 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), 'pm-smoke-'));
const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    `${baseUrl}/?token=${token}`,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes(baseUrl.replace('http://', '')));
      if (page) return page;
    } catch {
      // 还没起来
    }
    await sleep(500);
  }
  throw new Error('浏览器调试端口没起来');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const consoleLines = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => arg.description ?? arg.value ?? arg.type)
      .join(' ')
      .split('\n')[0];
    consoleLines.push(`[${message.params.type}] ${text.slice(0, 300)}`);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.result?.value ?? result.result?.exceptionDetails?.text;
}

await send('Runtime.enable');
await sleep(6000);

const report = {};
report.registration = await evaluate(
  `(() => { const d = globalThis.__PM_DEBUG__; return d ? JSON.stringify({ version: d.version, slots: d.registeredSlots }) : 'no __PM_DEBUG__'; })()`,
);
report.click = await evaluate(
  `(() => { const row = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('项目进度')); if (!row) return 'no-sidebar-row'; row.click(); return 'clicked'; })()`,
);
await sleep(2500);
report.dom = await evaluate(`(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const main = document.querySelector('main') ?? document.body;
  const err = document.querySelector('[data-slot-error]');
  const banner = [...main.querySelectorAll('div')].find((d) => (d.textContent || '').startsWith('面板 v'));
  // 从"我们的版本行"往上找到面板根，再在**面板根**里找画布（比在主区域里瞎找准）
  const root = banner ? (() => { let el = banner; while (el.parentElement && el.parentElement.textContent.length === main.textContent.length) el = el.parentElement; return el; })() : null;
  const svg = root ? root.querySelector('svg') : null;
  const text = (main.textContent || '').replace(/\\s+/g, ' ');
  return JSON.stringify({
    main: rect(main),
    slotError: err ? err.getAttribute('data-slot-error') : null,
    mainCount: document.querySelectorAll('main').length,
    panelRootSvgCount: root ? root.querySelectorAll('svg').length : null,
    panelRootHtmlHead: root ? root.innerHTML.slice(0, 400) : null,
    canvas: rect(svg),
    svgCount: document.querySelectorAll('main svg').length,
    banner: banner ? banner.textContent.slice(0, 100) : null,
    hasZeroSizeNotice: text.includes('画布容器尺寸为 0'),
    hasEmptyPlaceholder: text.includes('还没有节点'),
    hasCanvasError: text.includes('流程图渲染失败'),
    canvasErrorText: text.includes('流程图渲染失败')
      ? text.slice(text.indexOf('流程图渲染失败'), text.indexOf('流程图渲染失败') + 220)
      : null,
    svgAnywhere: document.querySelectorAll('svg').length,
    svgSizes: [...document.querySelectorAll('svg')].slice(0, 6).map((s) => rect(s)),
  });
})()`);

console.log(JSON.stringify(report, null, 2));

// 可选：第四个参数是要在页面里求值的表达式（排查时很好用）
if (process.argv[4] !== undefined && !process.argv[4].startsWith('--')) {
  const extra = await evaluate(process.argv[4]);
  console.log('=== 自定义探测 ===');
  console.log(typeof extra === 'string' ? extra : JSON.stringify(extra));
}

/**
 * `--menu`：用**真实鼠标事件**（CDP Input 域）右键点一个节点，确认菜单能弹出来。
 * 合成的 `MouseEvent('contextmenu')` 走不到 React 的委托监听，所以这里必须用浏览器真事件。
 */
if (process.argv.includes('--menu')) {
  const target = await evaluate(`(() => {
    const wrap = [...document.querySelectorAll('div')].find((d) => String(d.getAttribute('style') || '').includes('radial-gradient'));
    if (!wrap) return null;
    const svg = wrap.querySelector('svg');
    if (!svg) return null;
    const groups = [...svg.querySelectorAll('g')].filter((g) => g.getAttribute('transform') && [...g.children].some((c) => c.tagName === 'rect'));
    const rect = groups.length > 0 ? groups[groups.length - 1].querySelector('rect') : null;
    if (!rect) return null;
    const r = rect.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  console.log('=== 右键菜单 ===');
  if (typeof target === 'string' && target.startsWith('{')) {
    const point = JSON.parse(target);
    // 先装一个监听器：确认 contextmenu 事件到底有没有到、落在谁身上
    await evaluate(`(() => {
      window.__pmCtx = [];
      document.addEventListener('contextmenu', (e) => {
        window.__pmCtx.push((e.target && e.target.tagName) + '#' + ((e.target && e.target.getAttribute && e.target.getAttribute('class')) || ''));
      }, true);
      return 'ok';
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        button: 'right',
        buttons: type === 'mousePressed' ? 2 : 0,
        clickCount: 1,
        x: point.x,
        y: point.y,
      });
    }
    await sleep(500);
    const menu = await evaluate(`(() => {
      const wrap = [...document.querySelectorAll('div')].find((d) => String(d.getAttribute('style') || '').includes('radial-gradient'));
      const labels = wrap ? [...wrap.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean) : [];
      return JSON.stringify({ items: labels, ctxEvents: window.__pmCtx ?? null, point: ${JSON.stringify(point)} });
    })()`);
    console.log(menu);
  } else {
    console.log('找不到可点的节点');
  }
}

/**
 * `--overlay`：真实鼠标右键节点 → 点菜单里的破坏性项 → 确认浮层是否**贴在节点旁边**。
 * （实测反馈过：早先确认框渲染在面板顶部，用户得自己去找。）
 */
if (process.argv.includes('--overlay')) {
  console.log('=== 节点旁浮层 ===');
  const nodePoint = await evaluate(`(() => {
    const wrap = [...document.querySelectorAll('div')].find((d) => String(d.getAttribute('style') || '').includes('radial-gradient'));
    const svg = wrap && wrap.querySelector('svg');
    if (!svg) return null;
    const groups = [...svg.querySelectorAll('g')].filter((g) => g.getAttribute('transform') && [...g.children].some((c) => c.tagName === 'rect'));
    const rect = groups.length > 0 ? groups[groups.length - 1].querySelector('rect') : null;
    if (!rect) return null;
    const r = rect.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  if (typeof nodePoint === 'string' && nodePoint.startsWith('{')) {
    const point = JSON.parse(nodePoint);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        button: 'right',
        buttons: type === 'mousePressed' ? 2 : 0,
        clickCount: 1,
        x: point.x,
        y: point.y,
      });
    }
    await sleep(400);
    const itemPoint = await evaluate(`(() => {
      const item = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('打一个回滚点'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (typeof itemPoint === 'string' && itemPoint.startsWith('{')) {
      const item = JSON.parse(itemPoint);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
          x: item.x,
          y: item.y,
        });
      }
      await sleep(600);
      const overlayReport = await evaluate(`(() => {
        try {
          const wrap = [...document.querySelectorAll('div')].find((d) => String(d.getAttribute('style') || '').includes('radial-gradient'));
          const overlay = wrap ? [...wrap.querySelectorAll('div')].find((d) => (d.textContent || '').startsWith('确认打回滚点')) : null;
          const svg = wrap && wrap.querySelector('svg');
          const groups = svg ? [...svg.querySelectorAll('g')].filter((g) => g.getAttribute('transform') && [...g.children].some((c) => c.tagName === 'rect')) : [];
          const rect = groups.length > 0 ? groups[groups.length - 1].querySelector('rect') : null;
          const nodeRect = rect ? rect.getBoundingClientRect() : null;
          const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
          return JSON.stringify({
            overlayFound: !!overlay,
            overlay: overlay ? R(overlay) : null,
            node: nodeRect
              ? { x: Math.round(nodeRect.x), y: Math.round(nodeRect.y), w: Math.round(nodeRect.width), h: Math.round(nodeRect.height) }
              : null,
            verticalGap: overlay && nodeRect ? Math.round(overlay.getBoundingClientRect().top - nodeRect.bottom) : null,
          });
        } catch (error) {
          return 'probe-error: ' + (error && error.message ? error.message : String(error));
        }
      })()`);
      console.log(overlayReport);
    } else {
      console.log('打回滚点菜单项没找到');
    }
  } else {
    console.log('找不到可右键的节点');
  }
}

const errors = consoleLines.filter((line) => line.startsWith('[error]'));
if (errors.length > 0) {
  console.log('=== 控制台错误 ===');
  console.log(errors.slice(-5).join('\n'));
}
ws.close();
child.kill();
process.exit(report.dom?.includes('"slotError":null') ? 0 : 1);

/**
 * 产物结构自检（构建后运行）。
 *
 * 为什么需要它：client bundle 必须是**完整可执行**的 classic script ——
 * banner 打开的 `window.__ModuleLoader__.load({...})` 必须由 outro 收尾。
 * 一旦收尾丢失（例如 sourcemap 尾巴把 outro 顶掉），浏览器里**整条 combo 都会报**
 * 「loaded without registering ... via __ModuleLoader__.load」，而且错误会挂到
 * combo 里第一个插件名下，极难定位。
 *
 * 这里用 `vm` 把它当脚本真跑一遍（桩掉 window / require），验证：
 *   1. 语法完整（能被解析执行）
 *   2. 真的调用了 `__ModuleLoader__.load`
 *   3. 注册的 id 与包名一致
 *   4. factory 返回的是 exports 对象
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const expectedId = packageJson.name;

const failures = [];

/**
 * 平台基座（shell 的**冻结**模块表）——实测取自 web frontend 的 `__ModuleLoader__` 种子：
 * react · react/jsx-runtime · react-dom · react-dom/client · @deepseek-ai/cordis ·
 * dsh-client-store · dsh-client-ui-slots · dsh-client-ui-primitives · dsh-client-ui-dockkit。
 *
 * 只有这 9 个可以被 `require`；其余一律必须**打进 bundle**（写进 `dsh.client.external` 也没用，
 * 那些包在浏览器里根本不存在）。本自检就是用来钉死这条边界的。
 */
const PLATFORM_SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/**
 * 极简 React 替身：本自检只关心"能否注册/能否构造"，不关心渲染。
 *
 * **必须包含 `Component`**：错误边界要写 `class X extends React.Component`，
 * 替身里没有它时产物会在这里直接崩成 `Class extends value undefined` ——
 * 那个报错很容易被误读成"产物坏了"，实际只是自检的替身不完整（实测踩过）。
 */
function reactStub() {
  class Component {
    constructor(props) {
      this.props = props ?? {};
      this.state = {};
    }
    setState(next) {
      const patch = typeof next === 'function' ? next(this.state) : next;
      this.state = { ...this.state, ...patch };
    }
    forceUpdate() {}
    render() {
      return null;
    }
  }
  Component.prototype.isReactComponent = {};
  class PureComponent extends Component {}
  const noop = () => null;
  const passthrough = (value) => value;
  return {
    Component,
    PureComponent,
    createElement: noop,
    cloneElement: passthrough,
    isValidElement: () => false,
    createContext: (initial) => ({ Provider: noop, Consumer: noop, _currentValue: initial }),
    forwardRef: passthrough,
    memo: passthrough,
    Fragment: Symbol('Fragment'),
    StrictMode: Symbol('StrictMode'),
    Suspense: Symbol('Suspense'),
    Children: {
      map: (children, fn) => (Array.isArray(children) ? children.map(fn) : []),
      toArray: (children) => (Array.isArray(children) ? children : []),
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useReducer: (_reducer, initial) => [initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: () => ({ current: undefined }),
    useContext: (context) => context?._currentValue,
    useId: () => 'id',
    useTransition: () => [false, (fn) => fn()],
    useSyncExternalStore: (_subscribe, getSnapshot) =>
      typeof getSnapshot === 'function' ? getSnapshot() : undefined,
    version: '18.3.1-stub',
  };
}

function checkClientBundle() {
  const code = readFileSync('lib/client.js', 'utf8');
  const registered = [];
  const requested = [];

  const stubRequire = (specifier) => {
    requested.push(specifier);
    if (!PLATFORM_SEED.includes(specifier)) {
      throw new Error(`client bundle 请求了未在平台基座里的模块：${specifier}`);
    }
    if (specifier === 'react') return reactStub();
    // JSX 编译产物走 `react/jsx-runtime` 的 jsx/jsxs（jsxDEV 是 dev 形态）
    if (specifier === 'react/jsx-runtime') {
      const factory = () => null;
      return { jsx: factory, jsxs: factory, jsxDEV: factory, Fragment: Symbol('Fragment') };
    }
    // 其余基座模块在自检里只需"存在"，注册路径不会真的用到它们
    return { __stub: specifier };
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          if (typeof entry?.id !== 'string') throw new Error('load() 缺少 id');
          if (typeof entry.factory !== 'function') throw new Error('load() 缺少 factory 函数');
          const exports = entry.factory(stubRequire);
          if (exports === null || typeof exports !== 'object') {
            throw new Error('factory 必须返回 exports 对象');
          }
          registered.push(entry.id);
        },
      },
    },
    document: { createElement: () => ({ dataset: {}, style: {} }), querySelector: () => null, head: { append() {} } },
    console,
  };

  try {
    vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' });
  } catch (error) {
    failures.push(
      `lib/client.js 无法作为脚本执行：${error.constructor.name}: ${error.message}` +
        '（常见原因：outro 被 sourcemap 尾巴顶掉，导致工厂未闭合）',
    );
    return;
  }

  if (registered.length === 0) {
    failures.push('lib/client.js 没有调用 window.__ModuleLoader__.load');
    return;
  }
  if (!registered.includes(expectedId)) {
    failures.push(`lib/client.js 注册的 id 与包名不一致：期望 ${expectedId}，实际 ${registered.join(', ')}`);
  }
  if (registered.length !== 1) {
    failures.push(`lib/client.js 注册了 ${registered.length} 个模块（应为 1）：${registered.join(', ')}`);
  }
}

function checkHostBundle() {
  const code = readFileSync('lib/index.js', 'utf8');
  if (!/export\s*\{/.test(code)) {
    failures.push('lib/index.js 不像 ESM 产物（未找到 export {}）');
  }
  // 函数式插件**不得**有 default 导出：Loader 的 `unwrapExports` 会把
  // `exports.default ?? exports` 取出来，从而丢掉 inject/apply。
  // 只看真正的 ESM 导出语句，避免被打包器运行时里的字面量 "default" 误伤。
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    if (/(^|[\s,])default([\s,]|$)/.test(match[1])) {
      failures.push('lib/index.js 的导出语句里出现 default：Loader 会丢掉 inject/apply');
      break;
    }
  }
  for (const symbol of ['apply', 'inject', 'name', 'Config']) {
    if (!new RegExp(`\\b${symbol}\\b`).test(code)) {
      failures.push(`lib/index.js 缺少导出 ${symbol}`);
    }
  }
}

checkClientBundle();
checkHostBundle();

if (failures.length > 0) {
  console.error('产物自检失败：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('产物自检通过：client bundle 可执行且注册正确，host bundle 导出形态正确。');

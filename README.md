# dsh-project-manager

把「会话跑到哪了、还剩多少」从一堆说明文档，变成侧边栏里一张实时进度看板。
DSH 双面插件（Host 面 + Web Client 面），基准 `@deepseek-ai/dsh` **0.1.5-rc.2**。

- 设计文档（唯一权威）：[`立项.md`](./立项.md)
- 当前已装进 `web` profile：`C:\Users\LDS\.dsh\profiles\web`（`link:` 形式，便于热更）

---

## 1. 快速开始

```powershell
pnpm install
pnpm run build          # tsdown + 包装 client bundle + 产物自检 + 两侧类型检查
pnpm run test           # 43 个测试（39 领域 + 4 端到端）
pnpm run watch          # client bundle 热更（配合 dsh-client-hmr，浏览器自动替换）
```

装入 profile 并重启：

```powershell
dsh plugin --profile web add 'Z:\Projects\project-manager'
# 宿主面改动必须重启 dsh web；client 面改动由 HMR 自动替换
dsh web
```

---

## 2. 调试方式（重点）

### 2.0 先说结论：DSH 没有给插件留调试入口

实测（`dsh --help`、`lib/bin.js`）：CLI **只有 `web` 与 `plugin` 两个命令**，
没有 `dsh debug`、没有 `--log/--verbose`，`profiles` 目录下也不写日志文件。
宿主 logger 只写启动那个终端窗口。

因此插件的可观测性**必须自带**。本插件为此提供四级入口，从"最省事"到"最底层"：

| # | 入口 | 看什么 | 什么时候用 |
|---|---|---|---|
| 1 | **`http://127.0.0.1:3080/pm/debug`** | 人可读诊断页：能力探测、降级项、存储路线、已注册工具、HTTP 计数、**客户端上报**、最近诊断记录 | 首选。插件"看起来没反应"时第一站 |
| 2 | `…/pm/debug?format=json` | 同上，机器可读（脚本/我给排查时用） | 写回归脚本、贴给别人 |
| 3 | `…/pm/debug/logs` | 仅诊断记录（环形缓冲，最新 200 条） | 只想看时间线 |
| 4 | **设置页 →「项目进度」→ 诊断卡片** | 同一份数据的 UI 摘要 + 三个链接 | 面板里直接跳 |

### 2.1 三条路由各自的用途（按故障层次）

| 现象 | 先看 | 判定 |
|---|---|---|
| 侧边栏完全没有图标 | `/pm/health` 是否 200 | 404 → **宿主面没加载**（重启 `dsh web`，或看启动终端里的 `plugin tree failed to load`） |
| 有图标、点开是空白/报错 | `/pm/debug` 的 `client` 字段 | `null` → **客户端 bundle 没运行**（查浏览器控制台；`loaded without registering` 说明 bundle 语法/注册有问题） |
| 面板有壳但没数据 | `/pm/board`、`/pm/debug` 的 `http.lastPaths` | 路由 401/404 → 数据通道没通；`degradations` 非空 → 能力被降级 |
| 行为不对（该拒绝没拒绝等） | `/pm/debug` 的 `capabilities` + `logs` | `approval: false` 或策略 `never` → 破坏性操作一律拒绝（这是设计，见 §6.7f） |

### 2.2 客户端侧（浏览器）

- **控制台把手**：`window.__PM_DEBUG__` —— 已注册槽位、bundle id、版本、各路由地址。
- **自我上报**：client bundle 每次注册槽位后 `POST /pm/debug/client`，
  于是"浏览器里到底注册上了没有"能在宿主侧看到（`client.registeredSlots`）。
  这是刻意设计：宿主**不**给插件注入数据全局，只注入 `__DSH_BOOT__` / `__ModuleLoader__`，
  所以插件自己的状态必须主动回传。
- **HMR**：`dsh-client-hmr` 每 500ms 轮询每个 bundle 文件，重建后经 SSE 推给浏览器、
  自动替换插件 fiber（不刷新页面）。跑 `pnpm run watch` 即可。
  注意：client 面的 React 状态会丢；宿主面改动**不会**热更。

### 2.3 构建产物自检（会挡住两类"很难查"的故障）

```powershell
pnpm run verify
```

| 脚本 | 挡什么 |
|---|---|
| `scripts/verify-artifacts.mjs` | 用 `vm` 把 `lib/client.js` 当脚本真跑一遍：语法必须完整、必须调用 `__ModuleLoader__.load`、id 必须等于包名、factory 必须返回 exports；同时校验 host 产物无 `default` 导出 |
| `scripts/verify-client-combo.mjs` | 把**真实安装的全部** client bundle（本机 57 个）放进同一沙箱按序执行，断言全部注册成功 |

> 为什么需要第二个：客户端插件是被拼成**一条 combo**（多个 bundle 顺序拼进一个 `<script>`）下发的。
> 任意一个 bundle 语法不完整，**后面所有插件都不执行**，而报错只会说
> 「loaded without registering <第一个缺失的 id>」，指向的是**别的插件**。
> 这个脚本就是那次真实故障的回归测试。

### 2.4 诊断记录（宿主侧日志）

宿主侧没有日志文件，所以插件自己维护一个**有界环形缓冲**（最新 200 条，自研有界保留）：

- 加载全过程都有记录：能力探测 → 存储初始化 → 确认通道 → 工具注册 → 设置命名空间 → 路由 → `provide` 服务。
- **加载期抛错前必先记一条 error**（否则只会看到 `plugin tree failed to load` 这一句）。
- 加 `debugLogging: true`（组合配置或设置页）会额外记录 debug 级细节。

### 2.5 用组合检查确认"插件到底有没有被激活"

```powershell
dsh --profile web --dump-config | Select-String 'project-manager' -Context 0,2
```

会看到该插件作为一层 bundle 被插入（`- id: project-manager`）。
若这里没有，说明 `package.json` 缺 `dsh.bundle.patch`，或 profile 的
`dsh.profile.bundles` 里没有它。

---

## 3. 架构

```
src/
├── index.ts              Host 入口：能力探测 → 存储 → 确认路由 → 工具 → 设置 → 路由 → provide 服务
├── service.ts            应用层：读快照 → 调领域 → 原子写回 → 投影文档 → 记审计
├── domain/               纯领域层（零宿主依赖，Host/Client 两侧共用）
│   ├── graph.ts          树结构、关注归一化（C11）、结构不变量
│   ├── state.ts          状态机 + 计算状态收敛（§9.1 规则 0–6）
│   ├── progress.ts       加权进度（§9.3）、权重对标（§9.3a）
│   ├── validate.ts       C1–C12 判定（顺序写死）、C3/C4 自动修正
│   ├── mutate.ts         写入操作（增/删/改/关注/门控/订阅），纯函数
│   ├── docFormat.ts      doc-guard（§8.2 R1–R6）+ mermaid 子集解析
│   └── project.ts        文档投影与反解析
├── storage/              端口 + KV 主路线（ctx.storageDomain 双领域）
├── adapter/              唯一接触 DSH API 的地方
│   ├── capabilities.ts   能力探测 + 服务解析（属性与 ctx.get 两条路）
│   ├── confirm.ts        审批/提问两条 seam 的唯一出口，fail-closed
│   ├── http.ts           面板数据路由 + 诊断路由
│   ├── debug.ts          诊断总线（环形缓冲）
│   └── runtime.ts        时钟与 UUID 端口实现
├── tools/index.ts        12 个 pm_* 模型工具
└── client/               Web Client 面
    ├── index.tsx         侧边栏图标 + main 面板 + 设置分区注册
    ├── board-panel.tsx   看板（三段式）
    ├── settings-section.tsx 设置分区 + 诊断摘要
    ├── api.ts            同源 HTTP 数据层
    └── contract.ts       面板契约类型（与宿主侧一致性由测试断言）
```

### 关键实测约束（都踩过坑，别再踩）

1. **函数式插件不得有 `export default`** —— Loader 的 `unwrapExports` 会因此丢掉 `inject`。
2. **新服务必须 `ctx.provide()`** —— `ctx.set()` 只允许覆盖已提供的服务，否则抛
   `cannot set property "x" without provide`（首次装入时整个 web profile 都起不来）。
3. **client bundle 不是 ESM** —— 必须是 classic script + `__ModuleLoader__.load({id, factory})`。
   tsdown 0.23 **不输出 `outro`**，所以包装由 `scripts/wrap-client-bundle.mjs` 构建后做。
4. **平台基座只有 9 个 specifier 可直接 `require`**；其余必须写进 `dsh.client.external`。
5. **`defineDomain` 的领域名不允许连字符**（`^[a-z][a-z0-9_]*$`），且记录 schema 用 **zod v4**。
6. **客户端插件拿不到自定义 `ctx.remote.<ns>`**（命名空间集合是构建期硬编码清单，
   生成器未随发行版安装）→ 数据通路走宿主 HTTP 路由（同 `dshmarket` 做法）。
7. **`sidebar.panellist` 的组件只渲染图标**；外层按钮/tooltip/文案由侧边栏渲染。
   `main` 槽是 keyed，其 `key` **必须等于**侧边栏项的 `id`。
8. **入口 id 必须与包名一致**（`package.json.name`）——combo 自检依赖这个一致性。

---

## 4. 当前进度

已完成（可运行、有测试、已在真实 profile 中加载）：

- 领域层全部纯逻辑 + 74 个单测（树/状态机/进度/校验/变更/文档/快照/扫描）
- KV 主路线存储（`ctx.storageDomain` 双领域，schema 校验通过）
- 文档投影 + doc-guard + 反解析（投影出的文档自校验合法）
- 确认路由（审批/提问双 seam、fail-closed、五类拒绝原因）
- 18 个 `pm_*` 工具
- **首次扫描阶段 A（零 token 骨架）**：目录→功能点、关键文件→任务点、深度/节点数上限
  如实标注、排除项计入 skipped；一键建树**幂等**（同名同父跳过）、节点带 `autoCreated`
- **快照与回滚**：建点（内容哈希跳过 + 60s 节流 + 强制）、回滚（范围可选、共享文件二次确认、
  `pre-rollback` 可撤销）、容量治理（容量为主/份数为兜底、清理优先级、永不清理未完成节点最新点）、
  可达性自检、`.pm/` 与工作区外路径永不还原
- 侧边栏面板 + 看板 + 空工作区引导（扫描 → 建树两步分离）+ 设置页分区
- 能力探测与诊断体系（`/pm/debug`，含官方口径的插件注册表 PENDING 视图）
- 端到端冒烟测试（用构建产物 + 假宿主 + 按 spec 校验的存储替身；含真实文件回滚与真实扫描建树）

尚未实现（按 `立项.md` 的里程碑）：

- 文件监听（外部改动热感知）、兜底文件存储路线
- **git 档快照**（当前只实现补丁档；受限沙箱下本来就走补丁档，git 档在写到 `.git/` 时才会用到）
- **扫描阶段 B（AI 建树）与 AI 权重测量**（`src/ai/`、`src/weight/`）；当前只做阶段 A，
  且**不**在面板里触发任何 AI 调用（避免误花 token）
- 订阅并行的文件级锁与等待队列（`src/subscriptions/`）
- 进度回写会话投影（`src/notify/`）
- React Flow 画布 + 节点右键菜单 12 项（当前面板是列表/扫描带形态）

---

## 5. 免责

本插件是辅助工具，**不保证任何结果**；百分比为估算值，回滚不保证完整恢复。
请自行核实并承担后果。完整声明见 `立项.md` §0.1 与设置页「诊断」上方。

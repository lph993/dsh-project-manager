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
| 面板显示 0 个节点 /「未命名项目」 | 看板头部的「工作区：…（来源：…）」或 `/pm/debug` 的 `已绑定工作区根` | 根解析不出来 → 在 DSH 侧选中一个工作区（或在本工作区里发起一次工具调用）后刷新；根解析出来了但树是空的 → 面板里「扫描工作区 → 建树」 |
| 看板显示的树"不是这个工作区的" | `/pm/debug` 的 `当前项目` + `已绑定工作区根` | 每个工作区根绑**自己的项目**（§6.7g / FR-140）；面板会把当前会话 id 交给宿主来精确解析根，若宿主拿不到会话会退化成"最近使用的工作区" |
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

- 领域层全部纯逻辑 + 单测（树/状态机/进度/校验/变更/文档/快照/扫描/交接/监听）
- KV 主路线存储（`ctx.storageDomain` 双领域，schema 校验通过）
- **兜底文件存储路线**（`ctx.storageDomain` 缺失时降级到工作区 `.pm/` 下的 append-only
  文件存储；与主路线跑同一组契约测试，能力差异如实标注）
- 文档投影 + doc-guard + 反解析（投影出的文档自校验合法）
- 确认路由（审批/提问双 seam、fail-closed、五类拒绝原因）
- 23 个 `pm_*` 工具
- **多工作区绑定**：KV 路线是全机器共享一份存储，因此按**工作区根**分项目
  （`projectMetaSchema.workspaceRoot`）；面板把**当前会话 id** 交给宿主，
  宿主按 `session.header.cwd` → 注册表 `sessionIds` 反查 → 注册表最近使用 的顺序
  精确解析根（解析不出就**如实说明并不读任何目录**，绝不猜）；
  老数据（只有一个"无根项目"）会被**认领**而不是被孤立
- **首次扫描阶段 A（零 token 骨架）**：目录→功能点、关键文件→任务点、深度/节点数上限
  如实标注、排除项计入 skipped；一键建树**幂等**（同名同父跳过）、节点带 `autoCreated`。
  默认**不读文件内容**（不数行数），普通文件不建节点（节点必须是功能点/任务点）
- **AI 建树（阶段 B，默认建树路径）**：面板「用 AI 建树（先看成本）」→ 先算成本（**不调模型**）
  → 确认框写明"发送什么 / 几次调用 / 约多少 token（**粗估**）" → **一次调用**同时产出
  功能点·任务点 + 每个任务的**相对工作量** + **完成度初判**（模型读代码判断；
  只在人没写过进度时生效，绝不覆盖人工值）。
  模型输出按**不可信输入**校验：非法 JSON / 越界权重与进度 / 逃逸路径 / 同父重名 →
  明确失败或丢弃并记录说明，绝不"改一改就落库"。
  默认先清掉**阶段 A 的目录草稿**（只清没人动过的、仅删记录），但**不碰上次 AI 建出的树**
  （避免重跑把人工已推进的进度埋掉）。没配模型时该入口明确拒绝并给出配置指引，
  **配好之前不会发起任何调用**
- **零 token 启发式权重轨**（§9.3a，`src/weight/heuristic.ts`，**默认关闭的实验轨**）：
  显式开启后才统计文本文件行数（有读盘预算，超预算按字节估算并**如实标注**），
  按 `α·log(1+行数) + β·文件数 + γ·子树叶数 + δ·类型` 给**叶节点**评分；
  默认口径是**按件数**（每个任务点等权），只有 AI 给了相对工作量时才转工作量口径
- **快照与回滚**（补丁档 + **git 档**）：建点（内容哈希跳过 + 60s 节流 + 强制）、
  回滚（范围可选、共享文件二次确认、`pre-rollback` 可撤销）、容量治理（容量为主/份数为兜底、
  清理优先级、永不清理未完成节点最新点）、可达性自检、`.pm/` 与工作区外路径永不还原
  - **git 档**：`GIT_INDEX_FILE` 临时索引 + `git add -A` + `write-tree` + `commit-tree` +
    `update-ref refs/pm/snapshots/*`（并写 `refs/pm/keep` 防 gc）——
    **不切分支、不动用户索引、不改 HEAD**；强制 `core.autocrlf=false` 以免还原时静默改换行；
    差异计算带 `--intent-to-add`（否则漏掉未跟踪文件）
- 侧边栏面板 + 看板 + 空工作区引导（扫描 → 建树两步分离）+ 设置页分区
- **交接文档**（§9.6.4 / FR-51–54）：暂停 → 《继续交接文档》+ 自动回滚点；拦停 → 《放行交接文档》（整枝）；
  继续/放行 → 解除门控并把文档内容交回会话（`consumeDoc` 决定是否删除）。
  五个固定小节，其中「进度快照 / 涉及文件 / 未完成清单」**零 token 机械生成**，
  「下一步 / 关键决策与坑」由模型补写，缺失即标注降级且**不阻塞**暂停；
  读取**强制分页**（默认 ≤32 KB，200 KB 文档绝不一次进上下文）
- 侧边栏面板 + **三段式布局**（① 标题看板 ② **自绘 SVG 流程图** ③ 状态条/口径）
  - 流程图：两层视觉编码（边框=完成态、填充/角标/外发光=状态）、缩放/平移/适应视图/折叠子树、
    「只看未完成」、点选与未完成列表双向联动、悬停看权重依据；**按主题自动切换明暗配色**
    （读实际生效的文本色亮度来判明暗，不猜 CSS 变量名——变量拿不到时曾回落成"深底黑字"）；
    拖拽平移时**不选中文字**（`user-select: none` + `pointerdown` 阻止默认），
    拖动超过阈值后那次 click 不会顺手选中落点节点
- 能力探测与诊断体系（`/pm/debug`，含官方口径的插件注册表 PENDING 视图）
- **外部改动监听**（§15 R4/R6）：只监听**文档**与 `.pm/`（不监听整个工作区——全树递归监听
  在真实仓库里代价不可接受）；文档被外部改后重新校验合法性并在看板提示（文档只是投影，
  永不反向污染事实源）；**惰性启动**（读看板/诊断时才起，不在启动路径上白挂一个 watcher）
- 端到端冒烟测试（用构建产物 + 假宿主 + 按 spec 校验的存储替身；含真实文件回滚、
  真实 git 仓库的 git 档往返、真实扫描建树、真实交接文档落盘与消费、真实文件事件的监听验证）

尚未实现（按 `立项.md` 的里程碑）：

- 快照 **full 档**（全量拷贝）；git 档的**辅助补丁层**（`aux: 'patch'`，记录 git 忽略的未跟踪文件）
- AI 轨的**缓存与增量**（T6/T9：内容哈希复用、中断续跑）；AI 细化只测关注枝（当前一次调用给全树枝）
- 交接文档的**模型补写**（现在只接受**传入**的补写内容，不主动调模型）
- 订阅并行的文件级锁与等待队列（`src/subscriptions/`）
- 进度回写会话投影（`src/notify/`）
- 节点右键菜单（§6.6）：已实现 **10 项**——关注/取消关注、添加子节点、修改名称、补充描述、
  暂停（生成交接文档+回滚点）、继续、拦停整枝、放行整枝、打回滚点、删除整枝；
  破坏性动作一律**先给影响范围再确认**（面板内确认，§6.7f 第 2 行）。
  待做：**回滚 / 整枝回滚**（需要在菜单里选回滚点，属于下一批）
- 设置页的可编辑项（扫描 include/exclude glob、AI 模型路由目前只能改 `cordis.patch.yml`）

---

## 5. 免责

本插件是辅助工具，**不保证任何结果**；百分比为估算值，回滚不保证完整恢复。
请自行核实并承担后果。完整声明见 `立项.md` §0.1 与设置页「诊断」上方。



# 变更记录

本文件记录**对外发布**的版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **`0.1.0` 从未公开发布。** 它只是本仓库早期在 `dsh-project-manager` 这个名字下的内部版本号，
> npm 上没有它的任何发布记录。因此本文件从 **`0.2.0`（首个公开版本）** 起记录。

## [0.2.0] — 首个公开版本

### 变更

- **包名改为 `dsh-project-progress`**（原 `dsh-project-manager`）。
  原因：`dsh-project-manager` 在 npm 上已被他人占用（`hoyyang/dsh-project-manager` 0.4.0，与本项目无关）。
  GitHub 仓库名保持不变，仍是 `lph993/dsh-project-manager`。
- 版本号 `0.1.0` → `0.2.0`。

> ⚠ **包名同时是本插件的运行时身份。** 若你此前装过旧名字的版本，必须先把 profile 里的挂载改掉
> （`dependencies` 与 `dsh.profile.bundles` 中的名字、以及 `node_modules` 下的目录名），
> 否则浏览器会抛 `bundle … loaded without registering "…" via __ModuleLoader__.load`。
> 宿主认领客户端 bundle 的规则是三者严格相等：**loader 行名 === 包目录名 === `package.json.name`**。

### 破坏性变更

- **工具数 33 → 32**：删除 `pm_scan`。
- **删除「扫描工作区 → 直接建树」整条产品路径**。目录不再是节点；建树改由 **AI 建树**承担
  （读目录骨架与关键文件签名，一次调用产出功能点 / 任务点 + 相对工作量 + 完成度初判，
  **先给成本再花 token**）。起因是真机上那棵树按**目录**建了出来，根因是替换草稿的判据
  `proposedNames.has(node.name)` 让"被模型提到过的目录名"免于清理，而骨架与真功能点
  共用名字与进度字段，只能靠名字猜。既然做不好，直接不要了。
- **删除两条路由**：`POST /pm/scan`、`POST /pm/scan/apply`。
- **删除四个设置项**：`scanMaxDepth`、`scanMaxChildrenPerDir`、`scanMaxNodes`、`scanInclude`。

### 修复

- **匿名读不再被别的会话带偏**（真 bug）：面板轮询此前会读到**别的**会话绑定的项目
  （写路径跟着全局 `pendingRoot`，且匿名读认可全局 `workspaceRootOverride`）。
  现在写路径一律跟随调用会话，匿名读只认 `lastSessionBound` / `lastAnonymousBound`。
- **门控写路径补上会话绑定**：`pm_pause` / `pm_hold` / `pm_resume` / `pm_release` 此前会去
  **别人的项目**里找节点，现在全部按调用会话解析工作区。
- **`maximum context length` 事前判断**：真正跑出过
  `maximum context length is 1048576 tokens … you requested 1049147 tokens`。
  现在 AI 调用前先估输入 + 输出上限是否装得进模型窗口，装不下就如实拒绝（`input-over-context`）
  或把输出压到窗口余量（`windowOverflow`）；宿主不披露窗口时，从提供方拒绝里**学会**窗口
  （`.pm/ai-usage.json` 的 `learnedContextWindow`，有上下界校验）。
- **疑似遗留的节点不再与"正常待办"长得一样**：未完成清单里的残留节点改为灰色虚线方块并带说明。
- **清理幽灵空项目**：零根节点 + 零节点的项目会被清掉（跳过当前绑定）。

### 新增

- **`pm_review` 节点审查**（FR-164）：待审标记 / 审查通过，父节点通过则整枝视为已审。
- **「删除此项目」清理入口**（`DELETE /pm/projects`）：两段式确认，且不允许删除当前绑定的项目；
  配套 `scripts/cleanup-storage.mjs` 可清理 KV 里**不可达**的历史记录（默认 dry-run，
  `--apply` 需显式给出项目与根节点，且先自动备份）。
- **`pm_consolidate` 重复枝合并**：只给方案（不改数据），确认后才执行先搬后删。
- **宿主批次自报**（`HOST_BATCH`）：诊断页显示"宿主批次 第 N 批"，用来区分"改了没用"与"跑的还是旧代码"。
  旧宿主没有这个字段时如实写"未知（宿主为旧版）"，**不猜**。

### 说明

- 基准宿主 `@deepseek-ai/dsh` **0.1.5-rc.2**（本版本只在该版本上实测过）。
- 安装：`dsh plugin --profile web add dsh-project-progress`，随后重启 `dsh web`。
- 代码仓库：<https://github.com/lph993/dsh-project-manager>

[0.2.0]: https://github.com/lph993/dsh-project-manager/releases/tag/v0.2.0

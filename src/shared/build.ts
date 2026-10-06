/**
 * **宿主侧代码的批次号**（FR-169）。
 *
 * ## 为什么需要它
 *
 * 本插件是双面的：**客户端**（`lib/client.js`）刷新页面就换新，**宿主**（`lib/index.js`）
 * 必须**重载插件/重启宿主**才换新。这条区别不看代码是看不出来的，而它的代价很实在 ——
 * 已经白花过两轮模型调用：分批重试写好了、`lib` 也构建了，可宿主里跑的还是旧版，
 * 于是"输出被截断"的报错里当然没有"分批重试"字样，看起来像"改了没用"。
 *
 * 所以给宿主侧一个**自报的批次号**：设置页的诊断卡片直接显示"宿主批次 第 N 批"；
 * 旧宿主没有这个字段，界面就如实写"未知（宿主为旧版）"——**不猜**。
 *
 * ## 纪律
 *
 * - **每次动到宿主侧行为就把这个数 +1**（客户端专用的改动不必加：刷新即生效）。
 * - 它**只**用于诊断，不参与任何业务判断、不写进事实源。
 *
 * ## 批次 52 的用途（如实记录，免得后人以为这里有行为变更）
 *
 * 这一批**没有行为变更**：它是**热重载探针**。发现 profile 里的 hmr 条目被 base 层的
 * `disabled: true` 压着（配置在、插件根本没加载）之后，加上 `disabled: false` 并把这个数 +1，
 * 用"宿主批次是否自己从 51 跳到 52"来判定 HMR 到底有没有真的重载宿主 ——
 * 一个只用于诊断的数字，正好用来诊断"诊断页说的到底是哪一份代码"。
 */
/**
 * ## 批次 66 的用途
 *
 * 删掉「扫描工作区 → 直接建树」整条产品路径（用户口径："0 token 代码全删除，既然做不好，
 * 就不要了"；起因是真机上那棵树按**目录**建了出来 —— 根因是替换草稿的判据
 * `proposedNames.has(node.name)` 让"被模型提到过的目录名"免于清理，而骨架与真功能点
 * 共用名字/进度字段，只能靠名字猜）。
 *
 * 影响宿主侧行为的部分：`service.scan()`/`applyScan()` 删除、工具 **33 → 32**、
 * 路由 `POST /pm/scan` 与 `/pm/scan/apply` 删除、四个已成空旋钮的设置项删除
 * （`scanMaxDepth`/`scanMaxChildrenPerDir`/`scanMaxNodes`/`scanInclude`）。
 * 保留 `scanWorkspaceEntries`/`collectAiSkeleton`（AI 建树的**不可见输入**）。
 *
 * ## 批次 66 里一并做的（同批，不另开号）
 *
 * - **门控写路径补上会话**：`pauseNode` / `holdNode` / `resumeNode` / `releaseNode` 及其
 *   内部 `gateWithHandoff` / `releaseGate` / `captureSnapshot` 现在都带 `sessionId`
 *   （此前它们各自 `derive()` 不带会话 —— 跨工作区时会去**别人的项目**里找节点）；
 *   四个对应工具（`pm_pause` / `pm_hold` / `pm_resume` / `pm_release`）同步传下去。
 * - **删死代码**：`buildSuggestedTree` / `isSelected` / `suggestProjectName` / `readPackageName`
 *   与 `SuggestedNode` / `ScanResult`（骨架生成链，随产品路径一起消失），
 *   `domain/scanner.ts` 543 → 188 行；其测试同步裁掉（给已删代码留测试等于让测试骗人）。
 */
/**
 * ## 批次 67 的用途
 *
 * **发布改名**：包名 `dsh-project-manager` 在 npm 上已被他人占用
 * （`hoyyang/dsh-project-manager` 0.4.0，与本品无关），且 `npm view lph993` 为 404 ——
 * 没有该账号名，`@lph993/*` 这种 scope 也发不出去。故改名为无冲突、无 scope 的
 * **`dsh-project-progress`**，版本 0.1.0 → **0.2.0**。
 *
 * 为什么碰了宿主侧：包名在代码里同时充当**运行时身份**，宿主认领客户端 bundle 的规则是
 * `dsh-client-modules` 里的 `nearestPackage()`（第 717 行）——**loader 行名 === 包目录名
 * 上溯到的 `package.json.name`**，三者必须严格相等，否则浏览器抛
 * `bundle … loaded without registering "…" via __ModuleLoader__.load`。
 * 所以 `PACKAGE_ID`（宿主/客户端各一处）、事件 `source.plugin`、以及 profile 的
 * `dependencies` / `dsh.profile.bundles` / symlink 目录名必须**同名一起改**。
 *
 * 另：0.2.0 是**破坏性**版本（工具 33 → 32、路由与设置项删除，见批次 66），
 * 首个公开版本，无历史用户，故不提供兼容垫片。
 */
export const HOST_BATCH = 67;

/** 批次的中文说法（界面直接用，免得每处各写一遍）。 */
export function describeHostBatch(batch: number | undefined): string {
  return batch === undefined ? '未知（宿主为旧版）' : `第 ${batch} 批`;
}

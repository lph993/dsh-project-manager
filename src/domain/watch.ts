/**
 * 监听路径分类（纯逻辑）。
 *
 * 单独放在领域层的原因：这样它可以被**单测**而不必加载 chokidar，
 * 也能被 Client 侧编译（chokidar 是 Node 专有）。
 */

/** 监听事件的种类。 */
export type WatchEventKind = 'document-changed' | 'snapshot-area-changed' | 'handoff-changed';

/** 快照目录（与 `adapter/workspace.ts` 的 `SNAPSHOT_DIR` 一致）。 */
export const SNAPSHOT_DIR_PATH = '.pm/snapshots';

/** 交接文档目录（与 `domain/handoff.ts` 的 `HANDOFF_DIR` 一致）。 */
export const HANDOFF_DIR_PATH = '.pm/handoff';

/** 事实源目录（`.pm/` 整体：快照 + 交接文档 + 兜底存储 + WAL）。 */
export const STATE_DIR_PATH = '.pm';

/**
 * 判定一个工作区相对路径属于哪一类监听事件。
 *
 * @returns 未命中任何监听范围时返回 `undefined`（调用方应忽略）
 */
export function classifyWatchPath(
  relativePath: string,
  documentPath: string,
): WatchEventKind | undefined {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === documentPath) return 'document-changed';
  if (normalized.startsWith(`${HANDOFF_DIR_PATH}/`)) return 'handoff-changed';
  if (normalized.startsWith(`${SNAPSHOT_DIR_PATH}/`)) return 'snapshot-area-changed';
  // `.pm/` 其余内容（兜底存储、WAL、索引）也算事实源区域变动
  if (normalized.startsWith(`${STATE_DIR_PATH}/`) || normalized === STATE_DIR_PATH) {
    return 'snapshot-area-changed';
  }
  return undefined;
}

/**
 * 需要监听的目标（工作区相对路径）。
 *
 * **只监听两处**：文档与 `.pm/`。不监听整个工作区 —— 全树递归监听在真实仓库里
 * 代价不可接受，而插件真正需要感知的外部改动只有这两处。
 */
export function watchTargets(documentPath: string): string[] {
  return [documentPath, STATE_DIR_PATH];
}

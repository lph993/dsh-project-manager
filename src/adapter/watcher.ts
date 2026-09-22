/**
 * 文件监听：外部改动热感知（§15 R4/R6）。
 *
 * **监听范围刻意的窄**：只监听「项目文档」与 `.pm/`（快照 / 交接文档 / 兜底存储）。
 * 不监听整个工作区 —— 全树递归监听在真实仓库里代价不可接受（几万文件 + 事件风暴），
 * 而插件真正需要感知的只有这两处：
 * - 文档被**外部工具**改了 → 需要重新校验合法性并提示（R4：事实源不被文档反向污染）
 * - `.pm/` 被外部改动（快照被清理、兜底存储被手改）→ 需要刷新可达性并提示
 *
 * 用 chokidar（已在 DSH 依赖树内）。分类逻辑在 `domain/watch.ts`（纯函数、可单测）。
 */

import chokidar, { type FSWatcher } from 'chokidar';

import { classifyWatchPath, watchTargets, type WatchEventKind } from '../domain/watch.ts';

/** 一次变更通知。 */
export interface WatchEvent {
  kind: WatchEventKind;
  /** 工作区相对路径（`/` 分隔，已归一化）。 */
  path: string;
  /** 事件类型。 */
  type: 'add' | 'change' | 'unlink';
  at: string;
}

export interface WatcherOptions {
  workspaceRoot: string;
  /** 文档文件名（默认 `project-manager.md`）。 */
  documentPath: string;
  /** 事件回调（已做去抖）。 */
  onEvent: (event: WatchEvent) => void;
  /** 去抖间隔（毫秒），默认 200。 */
  debounceMs?: number;
}

/** 监听句柄。 */
export interface WatcherHandle {
  close: () => Promise<void>;
  /** 当前监听的目标（诊断用）。 */
  targets: string[];
}

/** 去抖：把同一路径的连续事件合并成一次（编辑器保存常触发多条事件）。 */
class Debouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delayMs: number;
  private readonly fire: (event: WatchEvent) => void;

  // 不用构造函数参数属性：Node 的 TS strip-only 模式不支持该语法，
  // 而测试要能直接 `node --test` 跑源码（不额外加一层构建）。
  constructor(delayMs: number, fire: (event: WatchEvent) => void) {
    this.delayMs = delayMs;
    this.fire = fire;
  }

  push(event: WatchEvent): void {
    const key = `${event.kind}\u0000${event.path}`;
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.fire(event);
      }, this.delayMs),
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * 启动监听。
 *
 * @returns 句柄；启动失败时返回 `undefined`（不阻断插件加载，§19.4 不变量）
 */
export function startWatching(options: WatcherOptions): WatcherHandle | undefined {
  const targets = watchTargets(options.documentPath);
  const debouncer = new Debouncer(options.debounceMs ?? 200, options.onEvent);
  let watcher: FSWatcher;

  try {
    watcher = chokidar.watch(targets, {
      cwd: options.workspaceRoot,
      // 只向下两层：`.pm/<sub>/<file>` 足够覆盖快照与交接文档
      depth: 2,
      ignoreInitial: true,
      // 不跟进符号链接；异步等待稳定写入，避免读到写一半的文件
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const forward =
      (type: WatchEvent['type']) =>
      (path: string): void => {
        const kind = classifyWatchPath(path, options.documentPath);
        if (kind === undefined) return;
        debouncer.push({
          kind,
          path: path.replace(/\\/g, '/'),
          type,
          at: new Date().toISOString(),
        });
      };

    watcher.on('add', forward('add'));
    watcher.on('change', forward('change'));
    watcher.on('unlink', forward('unlink'));
    watcher.on('error', () => {
      // 监听错误不冒泡到插件（可选能力失败不得阻断加载）
    });
  } catch {
    debouncer.dispose();
    return undefined;
  }

  const instance = watcher;
  return {
    targets,
    close: async () => {
      debouncer.dispose();
      try {
        await instance.close();
      } catch {
        // 关闭失败忽略
      }
    },
  };
}

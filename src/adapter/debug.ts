/**
 * 诊断总线：插件自带的可观测性（因为 DSH 没有 `dsh logs`，宿主 logger 只写启动终端）。
 *
 * 目标：让"插件到底加载成什么样、最近发生了什么、哪一步降级了"能在**一个 HTTP 页面**里
 * 看完，而不必去翻 `dsh web` 那个终端窗口的滚动历史。
 *
 * 用法：
 * - 宿主路由 `GET /pm/debug` → 人可读的 HTML 诊断页
 * - 宿主路由 `GET /pm/debug?format=json` → 同样的数据，机器可读（给我自己/脚本用）
 * - 所有记录进**有界环形缓冲**（保留最新 N 条，自研有界保留，FR-131）
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto';

/** 一条诊断记录。 */
export interface DebugEntry {
  seq: number;
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  scope: string;
  message: string;
  detail?: unknown;
}

/** 环形缓冲上限：保留最新 200 条，避免无界增长。 */
export const DEBUG_BUFFER_MAX = 200;

/**
 * 进程级诊断总线。
 *
 * 用模块级单例而不是实例字段：热重载/重新加载插件时，诊断历史不该跟着丢
 * （排查"加载失败"时最需要的就是上一次的记录）。
 */
class DebugBus {
  private readonly entries: DebugEntry[] = [];
  private seq = 0;

  record(level: DebugEntry['level'], scope: string, message: string, detail?: unknown): void {
    this.seq += 1;
    const entry: DebugEntry = {
      seq: this.seq,
      ts: new Date().toISOString(),
      level,
      scope,
      message,
    };
    if (detail !== undefined) entry.detail = safeDetail(detail);
    this.entries.push(entry);
    // 有界保留：保留最新，淘汰最旧
    if (this.entries.length > DEBUG_BUFFER_MAX) {
      this.entries.splice(0, this.entries.length - DEBUG_BUFFER_MAX);
    }
  }

  info(scope: string, message: string, detail?: unknown): void {
    this.record('info', scope, message, detail);
  }

  warn(scope: string, message: string, detail?: unknown): void {
    this.record('warn', scope, message, detail);
  }

  error(scope: string, message: string, detail?: unknown): void {
    this.record('error', scope, message, detail);
  }

  debug(scope: string, message: string, detail?: unknown): void {
    this.record('debug', scope, message, detail);
  }

  /** 最新 N 条（默认全部，最新在最后）。 */
  tail(limit = DEBUG_BUFFER_MAX): DebugEntry[] {
    return limit >= this.entries.length ? [...this.entries] : this.entries.slice(-limit);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}

/** 把任意 detail 收敛成可 JSON 序列化、且不会爆炸的形态。 */
function safeDetail(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function') return `[function ${(value as { name?: string }).name ?? 'anonymous'}]`;
  if (type === 'symbol') return String(value);
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => safeDetail(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6) };
  }
  if (type === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 50) {
        out['…'] = '[truncated]';
        break;
      }
      out[key] = safeDetail(item, depth + 1);
      count += 1;
    }
    return out;
  }
  return String(value);
}

/** 单例。 */
export const debugBus = new DebugBus();

/** 一次插件加载的自我描述（诊断页要显示"你到底加载成什么样"）。 */
export interface PluginSelfReport {
  pluginName: string;
  pluginVersion: string;
  packageId: string;
  loadedAt: string;
  /** 本次加载的实例 id：重载后变化，便于分辨"跑的是哪一份代码"。 */
  instanceId: string;
  storageRoute: string;
  capabilities: {
    approval: boolean;
    userQuestions: boolean;
    sandbox: boolean;
    sandboxMode: string | undefined;
    storageDomain: boolean;
    webServer: boolean;
  };
  degradations: string[];
  registeredTools: string[];
  settingsNamespaces: string[];
  routes: string[];
  /** 客户端 bundle 的自我描述（由 client 侧上报，见 `POST /pm/debug/client`）。 */
  client: ClientSelfReport | undefined;
}

/** 客户端 bundle 上报的自我描述。 */
export interface ClientSelfReport {
  panelId: string;
  bundleId: string;
  registeredSlots: string[];
  boardUrl: string;
  reportedAt: string;
  userAgent?: string;
  /**
   * 客户端抛错（最近一次）。
   *
   * 面板渲染抛错时，槽位错误边界会把主区域换成一个空 div，用户看到"点开一片空白"，
   * 宿主侧**什么都收不到**。有了这个字段，"空白"就有了可查的原因。
   */
  error?: { kind: string; message: string; stack?: string; at: string };
}

/** 生成一次性实例 id（浏览器安全 UUID，§5.2）。 */
export function newInstanceId(): string {
  return randomUUID();
}

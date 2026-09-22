/**
 * 工作区根解析（§19.4 能力降级的一组）。
 *
 * **为什么需要多种来源**：DSH 把"会话工作区 cwd"作为**每次调用**的值
 * （`exec.agent.session.header.cwd`）传给工具，宿主 `ctx` 上并没有它。
 * 但面板/看板是在**没有工具调用**的情况下读数据的 —— 那时 per-call cwd 还不存在，
 * 于是插件不知道"该管哪个工作区"，看板只能空着。
 *
 * 实测出的解析优先级（从最可信到兜底）：
 * 1. **工具层报告**（`noteWorkspaceRoot`）：就是 per-call cwd，最准确；
 * 2. **工作区注册表**（`ctx.workspaceRegistry.list()`）：DSH 自己维护的
 *    `{ path, title, sessionIds, updatedAt }` 列表 —— 用户选过的工作区就在里面。
 *    取 `updatedAt` 最新的那个（最近使用的用户意图最强）；本地开发常见是单工作区，
 *    这种情况完全等价。**这是面板能在无工具调用时拿到根的关键来源**；
 * 3. **环境变量**（`DSH_WORKSPACE`/`PWD`/`INIT_CWD`）：宿主启动环境，最不可信
 *    （可能指向别的仓库），只做最后兜底。
 *
 * 刻意**不猜**：注册表不可用且没有环境变量时返回 undefined，由调用方如实降级
 * （而不是挑一个目录当作工作区）。
 */

import { existsSync } from 'node:fs';

import type { Context } from '@deepseek-ai/cordis';

/** 工作区注册表里的一条记录（只声明我们读到的字段）。 */
export interface WorkspaceRegistryEntry {
  path?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  sessionIds?: unknown;
}

/** DSH 工作区注册表的最小接口形态。 */
interface WorkspaceRegistryLike {
  list(): WorkspaceRegistryEntry[];
}

/** DSH agent 注册表的最小接口形态（`ctx.agents.get(sessionId)`）。 */
interface AgentRegistryLike {
  get(id: string): { session?: { header?: { cwd?: string } } } | undefined;
}

/** 单个来源的解析结果（诊断页展示"根从哪来"）。 */
export interface WorkspaceRootResolution {
  root: string | undefined;
  source:
    | 'tool-call'
    | 'session-agent'
    | 'session-workspace'
    | 'workspace-registry'
    | 'bound'
    | 'env'
    | 'none';
  /** 诊断说明（人可读）。 */
  detail: string;
}

/** 读取环境变量兜底。 */
function fromEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return undefined;
  return env['DSH_WORKSPACE'] ?? env['PWD'] ?? env['INIT_CWD'] ?? undefined;
}

/**
 * 从工作区注册表取一个候选根。
 *
 * 排序规则：`updatedAt` 最新优先（最近使用的用户意图最强），其次 `createdAt`。
 */
export function pickWorkspaceFromRegistry(
  workspaces: ReadonlyArray<{ path?: unknown; updatedAt?: unknown; createdAt?: unknown }>,
): string | undefined {
  const usable = workspaces
    .map((item) => ({
      path: typeof item.path === 'string' ? item.path : undefined,
      stamp:
        (typeof item.updatedAt === 'string' ? item.updatedAt : undefined) ??
        (typeof item.createdAt === 'string' ? item.createdAt : undefined) ??
        '',
    }))
    .filter((item): item is { path: string; stamp: string } => item.path !== undefined);
  if (usable.length === 0) return undefined;
  usable.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return usable[0]?.path;
}

/**
 * 归一化工作区根，用于**比较**（不是用于落盘/展示）。
 *
 * 为什么需要：同一条路径在手写配置、DSH 注册表、`process.cwd()` 里可能出现
 * `Z:\a\b` / `Z:/a/b` / `z:\a\b\` / `\\?\Z:\a\b` 等写法，直接字符串比较会
 * 把"同一个工作区"认成两个，于是每个写法都新建一个项目。
 */
export function normalizeRootPath(input: string): string {
  let path = input.trim();
  // Windows 的长路径前缀（`\\?\C:\x` / `\\?\UNC\srv\share`）
  if (path.startsWith('\\\\?\\UNC\\')) path = `\\\\${path.slice(8)}`;
  else if (path.startsWith('\\\\?\\')) path = path.slice(4);
  path = path.replace(/\\/g, '/');
  // 去掉结尾斜杠（但要保留根 `/` 与 `C:/`）
  path = path.replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(path)) path = `${path}/`;
  // Windows 盘符大小写不敏感；POSIX 敏感，所以只在小写盘符形态上统一
  if (/^[a-zA-Z]:\//.test(path)) path = path[0]!.toLowerCase() + path.slice(1);
  return path;
}

/** 解析工作区根（不外抛）。 */
export function resolveWorkspaceRoot(input: {
  ctx: Context;
  /** 工具层报告的 per-call cwd（最可信）。 */
  reported?: string | undefined;
  /**
   * 面板报告的当前会话 id。
   *
   * 有它就能**精确**定位"你正在看的那个工作区"，而不是"最近用过的那个"：
   * ① `ctx.agents.get(sessionId).session.header.cwd` —— 最准（就是那次会话的 cwd）；
   * ② 工作区注册表里 `sessionIds` 含该会话的那条 —— 次准（用户选过的工作区）。
   */
  sessionId?: string | undefined;
}): WorkspaceRootResolution {
  if (input.reported !== undefined && input.reported !== '') {
    return { root: input.reported, source: 'tool-call', detail: '由工具调用报告的会话 cwd' };
  }

  const sessionId = input.sessionId;

  // ① 会话 → 活的 agent → session.header.cwd（最精确）
  if (sessionId !== undefined && sessionId !== '') {
    try {
      const agents = (input.ctx as unknown as { get?: (key: string) => unknown }).get?.(
        'agents',
      ) as AgentRegistryLike | undefined;
      const cwd = agents?.get?.(sessionId)?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '' && existsSync(cwd)) {
        return {
          root: cwd,
          source: 'session-agent',
          detail: `按当前会话 ${sessionId} 的 session.header.cwd 解析`,
        };
      }
    } catch {
      // agent 注册表不可用 → 继续
    }
  }

  // ② 工作区注册表：按 sessionIds 反查（用户选过的那个工作区）
  const registry = readWorkspaceRegistry(input.ctx);
  if (registry !== undefined && sessionId !== undefined && sessionId !== '') {
    const owner = registry.find(
      (item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId),
    );
    const path = typeof owner?.path === 'string' ? owner.path : undefined;
    if (path !== undefined && existsSync(path)) {
      return {
        root: path,
        source: 'session-workspace',
        detail: `按当前会话 ${sessionId} 在会话列表中反查到的工作区`,
      };
    }
  }

  // ③ 工作区注册表：最近使用（面板没有会话信息时的兜底）
  if (registry !== undefined) {
    const picked = pickWorkspaceFromRegistry(registry);
    if (picked !== undefined && existsSync(picked)) {
      return {
        root: picked,
        source: 'workspace-registry',
        detail: '取自 DSH 工作区注册表中最近使用的工作区（未拿到当前会话，故按最近使用取）',
      };
    }
    if (picked !== undefined) {
      return {
        root: undefined,
        source: 'none',
        detail: `工作区注册表里的路径不存在：${picked}`,
      };
    }
  }

  const envRoot = fromEnv();
  if (envRoot !== undefined && envRoot !== '' && existsSync(envRoot)) {
    return {
      root: envRoot,
      source: 'env',
      detail: '取自宿主启动环境（DSH_WORKSPACE / PWD / INIT_CWD），可信度最低',
    };
  }

  return {
    root: undefined,
    source: 'none',
    detail: '既没有工具调用报告、也没有会话/工作区注册表与环境变量可用',
  };
}

/** 读取工作区注册表列表（不可读时返回 undefined）。 */
function readWorkspaceRegistry(ctx: Context): WorkspaceRegistryEntry[] | undefined {
  try {
    const registry = (ctx as unknown as { get?: (key: string) => unknown }).get?.(
      'workspaceRegistry',
    ) as WorkspaceRegistryLike | undefined;
    if (registry && typeof registry.list === 'function') return registry.list();
    return undefined;
  } catch {
    return undefined;
  }
}

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

/** DSH 工作区注册表的最小接口形态。 */
interface WorkspaceRegistryLike {
  list(): Array<{ path?: unknown; title?: unknown; updatedAt?: unknown; createdAt?: unknown }>;
}

/** 单个来源的解析结果（诊断页展示"根从哪来"）。 */
export interface WorkspaceRootResolution {
  root: string | undefined;
  source:
    | 'tool-call'
    | 'workspace-registry'
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

/** 解析工作区根（不外抛）。 */
export function resolveWorkspaceRoot(input: {
  ctx: Context;
  /** 工具层报告的 per-call cwd（最可信）。 */
  reported?: string | undefined;
}): WorkspaceRootResolution {
  if (input.reported !== undefined && input.reported !== '') {
    return { root: input.reported, source: 'tool-call', detail: '由工具调用报告的会话 cwd' };
  }

  // 工作区注册表：面板无工具调用时唯一可靠的来源
  try {
    const registry = (input.ctx as unknown as { get?: (key: string) => unknown }).get?.(
      'workspaceRegistry',
    ) as WorkspaceRegistryLike | undefined;
    if (registry && typeof registry.list === 'function') {
      const picked = pickWorkspaceFromRegistry(registry.list());
      if (picked !== undefined && existsSync(picked)) {
        return {
          root: picked,
          source: 'workspace-registry',
          detail: '取自 DSH 工作区注册表中最近使用的工作区',
        };
      }
      if (picked !== undefined) {
        // 注册表里有，但路径不存在（工作区被删/移动）→ 如实说明，不硬用
        return {
          root: undefined,
          source: 'none',
          detail: `工作区注册表里的路径不存在：${picked}`,
        };
      }
    }
  } catch {
    // 注册表不可读 → 继续兜底
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
    detail: '既没有工具调用报告，也没有工作区注册表与环境变量可用',
  };
}

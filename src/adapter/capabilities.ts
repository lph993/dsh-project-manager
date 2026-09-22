/**
 * 启动能力探测（§19.4 / FR-91 / FR-139）。
 *
 * **不变量**：任何"可选能力"缺失都不得导致插件加载失败 —— 否则一个 DSH 更新
 * 就让整个侧边栏消失。因此本模块只**观察**，从不抛错；缺失项进入降级台账，
 * 由 UI 明示（FR-89c）。
 */

import type { Context } from '@deepseek-ai/cordis';

/** 沙箱模式（`dsh-sandbox` 的 `SandboxMode` 词表）。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** 审批策略（`dsh-user-approval` 的 `ApprovalPolicy`）。 */
export type ApprovalPolicy = 'ask' | 'never';

/** 能力台账（设置页「确认通道现状」直接渲染它，FR-89c）。 */
export interface CapabilityReport {
  /** `ctx.approval` 是否存在。 */
  approval: boolean;
  /** `ctx.userQuestions` 是否存在。 */
  userQuestions: boolean;
  /** `ctx.sandboxPolicy` 是否存在；缺失视为不限制。 */
  sandbox: boolean;
  /** 当前会话沙箱模式；未知为 undefined。 */
  sandboxMode: SandboxMode | undefined;
  /** `ctx.settingsScope`（客户端）—— Host 面恒 false，仅用于台账统一。 */
  settingsScope: boolean;
  /** `ctx.storageDomain` 是否可用（决定存储路线）。 */
  storageDomain: boolean;
  /** 已降级项的人类可读说明（看板状态条 + 设置页）。 */
  degradations: string[];
}

/** 安全读取 `ctx.get(id)`：任何异常都视为"不可用"，绝不冒泡。 */
function has(ctx: Context, id: string): boolean {
  try {
    const value = (ctx as unknown as { get?: (key: string) => unknown }).get?.(id);
    return value !== undefined && value !== null;
  } catch {
    return false;
  }
}

/**
 * 解析一个宿主服务，**属性与 `ctx.get()` 两条路都走**。
 *
 * DSH 的服务既可以通过模块增补直接写成 `ctx.storageDomain` 属性访问，
 * 也可以通过 `ctx.get('storageDomain')` 解析（`dsh-tools` 自己就是这么写 `ctx.get('approval')`）。
 * 走两条路的好处：既能容忍增补未加载，也让插件在测试替身下可用（属性无法注入）。
 */
export function serviceOf<T>(ctx: Context, id: string): T | undefined {
  try {
    const viaProperty = (ctx as unknown as Record<string, unknown>)[id];
    if (viaProperty !== undefined && viaProperty !== null) return viaProperty as T;
  } catch {
    // 落到 ctx.get
  }
  try {
    const viaGet = (ctx as unknown as { get?: (key: string) => unknown }).get?.(id);
    return viaGet === undefined || viaGet === null ? undefined : (viaGet as T);
  } catch {
    return undefined;
  }
}

/**
 * 探测当前 Host 上下文的能力。
 *
 * 注意 `approval` 的**策略**不在这里判定：策略是 per-session 的，且会随用户切换
 * 而变（`ask` ↔ `never`）。因此这里只回答"seam 在不在"，
 * "这次能不能授权"由 `adapter/confirm.ts` 在每次请求时按结果判定（FR-136/137）。
 */
export function capabilityProbe(ctx: Context): CapabilityReport {
  const approval = has(ctx, 'approval');
  const userQuestions = has(ctx, 'userQuestions');
  const sandbox = has(ctx, 'sandboxPolicy');
  const storageDomain = has(ctx, 'storageDomain');

  const degradations: string[] = [];
  if (!approval) {
    degradations.push('审批通道不可用：模型侧破坏性操作无法取得授权，将拒绝执行并提示改用面板');
  }
  if (!userQuestions) {
    degradations.push('提问通道不可用：无法展示影响范围与澄清问题，相关操作将被拒绝');
  }
  if (!sandbox) {
    degradations.push('沙箱策略不可用：按不限制处理，快照档位仍会在写入失败时自动降级');
  }
  if (!storageDomain) {
    degradations.push('storageDomain 不可用：已切换到兜底文件存储（能力有差异）');
  }

  // 客户端能力无法在这里探测（Host 与 Client 是两个上下文），
  // 因此 `settingsScope` 一律记 false，由 Client 面自行覆盖台账。
  return {
    approval,
    userQuestions,
    sandbox,
    sandboxMode: readSandboxMode(ctx),
    settingsScope: false,
    storageDomain,
    degradations,
  };
}

/** 尽力读取当前沙箱模式；读不到就返回 undefined（不猜）。 */
function readSandboxMode(ctx: Context): SandboxMode | undefined {
  try {
    const policy = (ctx as unknown as { get?: (key: string) => unknown }).get?.('sandboxPolicy');
    if (!policy || typeof policy !== 'object') return undefined;
    const candidate = policy as { mode?: unknown; current?: unknown; defaultMode?: unknown };
    const raw = candidate.mode ?? candidate.current ?? candidate.defaultMode;
    if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') {
      return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 快照档位裁决（§7.5 / FR-69c）。
 *
 * git 档需要写 `.git/` 下的 `refs/pm/*`。受限沙箱（`workspace-write` / `read-only`）
 * 下这属于工作区外写入 → 会失败，而 FR-61「每个未完成节点恒有可退回点」会**静默失效**。
 * 因此这里按沙箱模式**主动降级**，并给出原因供 UI 明示（FR-89d）。
 */
export function resolveSnapshotMode(
  preferred: 'auto' | 'git' | 'patch' | 'full',
  report: CapabilityReport,
): { mode: 'git' | 'patch' | 'full'; reason: string } {
  if (preferred !== 'auto') {
    return { mode: preferred, reason: '由设置项显式指定' };
  }
  if (report.sandboxMode === 'read-only') {
    return {
      mode: 'patch',
      reason: '当前会话为只读沙箱，git 元数据与工作区均不可写，已降级为补丁档',
    };
  }
  if (report.sandboxMode === 'workspace-write') {
    return {
      mode: 'patch',
      reason: '当前会话为 workspace-write 沙箱，`.git/refs/pm/*` 在工作区外不可写，已降级为补丁档',
    };
  }
  if (report.sandbox && report.sandboxMode === undefined) {
    return {
      mode: 'patch',
      reason: '沙箱模式未知，为避免回滚点静默失效，保守选择补丁档（可重新探测）',
    };
  }
  return { mode: 'git', reason: '未检测到沙箱限制，使用 git 档（专属 ref + 防 gc）' };
}

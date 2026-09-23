/**
 * 打开工作区文件（跳到右侧栏的文件预览）。
 *
 * **为什么要单独一个模块**：槽位组件的 props 由框架组装，而"多塞一个自有回调"这条路
 * 在本机**没有实测过**（官方 `documentpreview` 是这么写的，但我们的右栏页签在无头环境里
 * 打不开，`inject` 面拿不到证据）。与其赌一个未验证的契约，这里用一条**明确的注入缝**：
 * `index.tsx` 在 `apply()` 时把 `ctx.sidebarRight.openResource` 交进来，组件按需调用，
 * 拿不到 opener 就**如实降级**（复制路径），而不是画一个点了没反应的按钮。
 *
 * 地址口径来自官方（`dsh-api-workspace-files` 的 `provider`）：
 * `dsh-resource://file/session/<sessionId>/<工作区相对路径>`，路径段要逐段百分号编码。
 */

/** 打开一个资源地址（由 `index.tsx` 注入）。 */
export type ResourceOpener = (address: string) => void;

let opener: ResourceOpener | undefined;

/** 注入/清除 opener（`undefined` = 右栏不可用，调用方据此降级）。 */
export function setResourceOpener(next: ResourceOpener | undefined): void {
  opener = next;
}

/** 当前有没有可用的 opener（UI 用它决定按钮文案与提示）。 */
export function hasResourceOpener(): boolean {
  return opener !== undefined;
}

/**
 * 由「会话 id + 工作区相对路径」拼出官方文件地址。
 *
 * @returns 地址；路径为空、或**不是工作区相对路径**（绝对路径 / Windows 盘符 / UNC）时返回 `undefined`
 *   —— 会话地址只在会话工作区内解析，硬拼绝对路径只会得到"打不开"，不如让调用方说清楚。
 */
export function fileAddress(sessionId: string | undefined, path: string): string | undefined {
  const id = sessionId ?? '';
  const raw = path.trim();
  if (id === '' || raw === '') return undefined;
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) return undefined;
  const segments = raw
    .split(/[/\\]+/)
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment));
  if (segments.length === 0) return undefined;
  return `dsh-resource://file/session/${encodeURIComponent(id)}/${segments.join('/')}`;
}

/** 一次打开尝试的结果（UI 据此给不同提示，**绝不**假装成功）。 */
export type OpenFileResult = 'opened' | 'no-opener' | 'bad-path' | 'failed';

/**
 * 尝试在右栏打开这个文件。
 *
 * @param sessionId - 当前会话 id（地址的会话作用域要它）
 * @param path - 工作区相对路径（节点引用就是这种）
 */
export function openWorkspaceFile(sessionId: string | undefined, path: string): OpenFileResult {
  const address = fileAddress(sessionId, path);
  if (address === undefined) return 'bad-path';
  if (opener === undefined) return 'no-opener';
  try {
    opener(address);
    return 'opened';
  } catch {
    // 官方 `openResource` 对"没有类型认领这个地址"会抛：这是打不开，不是崩溃
    return 'failed';
  }
}

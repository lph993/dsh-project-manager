/**
 * `tools/pre-execute` 载荷的**读法**（把宿主契约收在一处）。
 *
 * ## 为什么必须有这个模块（这不是洁癖，是一次真事故）
 *
 * 破坏性操作审批门（`tools/guard.ts`，FR-135/136/163）读的是 `exec.toolName` 与 `exec.session`，
 * 而宿主 `dsh-tools` 的真实形状是 **`{ name, arguments, agent }`** ——
 * `agent.id` 是会话 id、`agent.session` 才是 `Session` 对象（`dsh-agent/lib/types/runtime-types.d.ts`）。
 * 于是真机上 `toolName` 恒为 `undefined` ⇒ 钩子第一句就 `return` ⇒
 * **审批门从来没生效过**（而会话级审批策略又是 `never`，更看不出来）：
 * 一个安全闸门静默失效，比它报错还糟。
 *
 * 教训写在这里：**钩子里的字段名必须对着宿主类型声明抄**，并且要有 e2e 用**真实形状**的载荷钉住
 * —— 早先没有这条测试，所以"门是死的"一直没被发现。
 *
 * 这里同时保留旧字段名（`toolName` / `args` / `session`）作为**回退**：
 * 宿主 rc 之间形状有漂移，读到哪个用哪个，绝不因为一个字段改名就让闸门再次静默失效。
 */

/** 一次工具调用在 `pre-execute` 阶段能被读到的信息。 */
export interface ExecView {
  /** 工具名（宿主：`exec.name`）。读不到就是 undefined ⇒ 调用方按"不管"处理。 */
  toolName: string | undefined;
  /** 已解析的参数（宿主：`exec.arguments`）。 */
  args: unknown;
  /**
   * 调用所属的**会话对象**（宿主：`exec.agent.session`）。
   *
   * 必须是对象才返回：沙箱策略的 `resolve({ session })` 要的是 `Session`，
   * 塞个 id 字符串进去只会让它按"没有会话"处理（甚至读出不存在的 cwd）——
   * 那属于**假装算过**，不如如实 `undefined` 让它退到部署默认。
   */
  session: unknown;
  /** 会话 id（宿主：`exec.agent.id`）—— 会话对象拿不到时用它去注册表里换。 */
  sessionId: string | undefined;
}

/** 取第一个非空字符串。 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** 安全地把 unknown 当记录读。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 从"代理样"的输入里取出**会话对象**（沙箱策略要的就是它）。
 *
 * 优先直接用 `agent.session`（宿主 `ToolExecution.agent` 的形状）；
 * 只有 id 时去 `agents` 注册表换一个 —— 换不到就如实 `undefined`
 * （调用方据此退到部署默认档位：保守但诚实；**绝不**拿 id 字符串冒充 `Session`）。
 *
 * 放在这里是为了让**钩子**（`index.ts`）与**服务层的第二道门**（`service.authorize`，FR-163）
 * 用同一份读法：两处各写一遍，迟早各漂各的。
 */
export function sessionOfAgent(ctx: unknown, agent: unknown): unknown {
  const record = asRecord(agent);
  const direct = record['session'];
  if (typeof direct === 'object' && direct !== null) return direct;
  const id = firstString(
    record['id'],
    record['sessionId'],
    typeof agent === 'string' ? agent : undefined,
  );
  if (id === undefined) return undefined;
  try {
    const registry = (ctx as { get?: (key: string) => unknown } | undefined)?.get?.('agents') as
      | { get?: (id: string) => { session?: unknown } | undefined }
      | undefined;
    const found = registry?.get?.(id)?.session;
    return typeof found === 'object' && found !== null ? found : undefined;
  } catch {
    return undefined;
  }
}

/** 把 `pre-execute` 的载荷收敛成 {@link ExecView}（**纯函数**，任何输入都不抛）。 */
export function execViewOf(exec: unknown): ExecView {
  const record = asRecord(exec);
  const agent = asRecord(record['agent']);
  const legacySession = record['session'];
  const legacySessionRecord = asRecord(legacySession);
  const session = agent['session'] ?? (typeof legacySession === 'object' ? legacySession : undefined);
  return {
    toolName: firstString(record['name'], record['toolName']),
    args: record['arguments'] ?? record['args'],
    session: typeof session === 'object' && session !== null ? session : undefined,
    sessionId: firstString(agent['id'], legacySessionRecord['id'], legacySessionRecord['sessionId'], legacySession),
  };
}

/**
 * 从一次文件写入类调用的参数里读出**会被改动的路径**（FR-161 的判据输入）。
 *
 * 只认宿主自带文件工具的字段名（`path` / `file_path`），并且**只认字符串**：
 * 读不出来就返回空数组 —— FR-161 的判据是"改到被别的子项目引用的路径才要审核"，
 * 空数组的含义是"没有可判的证据" ⇒ 不拦（**不猜**：猜错了会把正常改动拦下来，
 * 那和"该拦不拦"一样是错的）。
 */
export function touchedPathsOf(args: unknown): string[] {
  const record = asRecord(args);
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  // 批量形状（`paths: [...]`）也认：同样是"只认字符串"
  const list = record['paths'];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string' && item !== '') out.push(item);
    }
  }
  return [...new Set(out)];
}

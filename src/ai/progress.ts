/**
 * **运行中的 AI 建树进度**（FR-167）：让面板能实时看到"已经吐了多少 / 上限多少"。
 *
 * ## 为什么只能"粗估"，而且要写明粗估
 *
 * 用户问过"有办法实时预算吗"。分三层，答案不一样（这也是本模块存在的边界）：
 *
 * | 时机 | 能不能 | 依据 |
 * |---|---|---|
 * | 事前精确 | **做不到** | 宿主**故意不固定分词器**：`dsh-llm` 的类型注释原话是 "The caller prices `text` with its own text estimator so provider pricing never fixes a text tokenization."，`TokenUsage` 只在**调用之后**通过 usage 事件回来 |
 * | 事后真实 | 能 | 提供方 `usage`（插件账本已在记，且分批时逐片记） |
 * | **运行中** | 能，但只能是**粗估** | 流式期间只有"已生成的字符数"这一个事实，token 只能按同一套粗估口径折算（沿用提示词侧那套 **3 字节/token** 的换算） |
 *
 * 所以这里**只上报两个数**：`outputChars`（**事实**，数出来的字符）与
 * `outputTokensEstimate`（**粗估**，`chars/3` 向上取整）+ 输出上限（**确定值**）。
 * 界面必须把后者标成"约"。**绝不**把粗估说成实测。
 */

/** 一次建树运行中对外可见的进度（只读快照，进看板载荷）。 */
export interface AiRunProgress {
  /** 开始时间（ISO）。 */
  startedAt: string;
  /** 场景（目前只有建树）。 */
  scenario: 'tree';
  /**
   * 单次请求还是分批里的某一片。
   *
   * 分批时面板要能说清"第几片 / 共几片"—— 否则用户看到进度条重置会以为出错了。
   */
  mode: 'single' | 'shard';
  /** 当前第几片（从 1 开始；单次模式恒为 1）。 */
  shardIndex: number;
  /** 共几片（单次模式恒为 1）。 */
  shardTotal: number;
  /** **事实**：已生成的字符数。 */
  outputChars: number;
  /** **粗估**：已生成 token 的估算（`chars/3` 向上取整），界面必须标"约"。 */
  outputTokensEstimate: number;
  /** **确定值**：本次调用的输出上限（用户设的闸门，或宿主的模型上限）；`0` = 读不到。 */
  outputLimit: number;
  /**
   * 是否已经知道"这次被上限截断了"。
   *
   * 只有**真发生**才置真 —— 不预测、不预警成"已截断"（那是两回事：接近上限 ≠ 被截断）。
   */
  truncated: boolean;
  /**
   * 阶段。**完成/失败后不清空**（用户口径："生成后，1图的那个进度条保留，保持 100%"）——
   * 这条进度条同时承担"这一轮跑到哪了"和"上一轮结果如何"，清掉等于把刚发生的事抹掉。
   */
  phase: 'running' | 'done' | 'error';
  /**
   * **本次实际消耗**（提供方回报的真实 `usage`；分批时逐片累加）。
   *
   * 只有拿到真实值才有 —— 拿不到就是 `undefined`（界面退回显示粗估，并标明"粗估"）。
   */
  actual?: { inputTokens?: number; outputTokens?: number } | undefined;
}

/** 字符数 → 粗估 token（与提示词侧同一套口径：3 字节/token）。 */
export function outputTokensEstimateOf(outputChars: number): number {
  if (!Number.isFinite(outputChars) || outputChars <= 0) return 0;
  return Math.ceil(outputChars / 3);
}

/**
 * 用量比例（0..1，用来画进度条）。
 *
 * 上限非法（0/NaN）时返回 0：**宁可不画，也不画出一个除零出来的假进度**。
 */
export function usedRatio(progress: Pick<AiRunProgress, 'outputChars' | 'outputLimit'>): number {
  if (!Number.isFinite(progress.outputLimit) || progress.outputLimit <= 0) return 0;
  const estimated = outputTokensEstimateOf(progress.outputChars) / progress.outputLimit;
  return Math.max(0, Math.min(1, estimated));
}

/**
 * 构造一份进度快照。
 *
 * 刻意做成纯函数：面板要显示什么、按什么口径标"约"，全在这里能单测，
 * 而不是散在流式回调与 UI 里各写一遍（两处口径必然会漂）。
 */
export function aiRunProgressOf(input: {
  startedAt: string;
  mode: 'single' | 'shard';
  shardIndex: number;
  shardTotal: number;
  outputChars: number;
  outputLimit: number;
  truncated?: boolean;
  phase?: 'running' | 'done' | 'error';
  actual?: { inputTokens?: number; outputTokens?: number } | undefined;
}): AiRunProgress {
  return {
    startedAt: input.startedAt,
    scenario: 'tree',
    mode: input.mode,
    shardIndex: Math.max(1, Math.round(input.shardIndex)),
    shardTotal: Math.max(1, Math.round(input.shardTotal)),
    outputChars: Math.max(0, Math.round(input.outputChars)),
    outputTokensEstimate: outputTokensEstimateOf(input.outputChars),
    outputLimit: Math.max(0, Math.round(input.outputLimit)),
    truncated: input.truncated === true,
    phase: input.phase ?? 'running',
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
  };
}

/** 面板/提示一句人话（措辞与"粗估"纪律一致）。 */
export function describeAiRun(progress: AiRunProgress): string {
  const shard =
    progress.shardTotal > 1 ? `第 ${progress.shardIndex}/${progress.shardTotal} 片，` : '';
  /**
   * 上限未知（跟随宿主且读不到值）时**不显示"／上限 0"**——那是除零式的假数字。
   */
  const tail =
    progress.outputLimit > 0
      ? progress.truncated
        ? `已到输出上限 ${progress.outputLimit}，这一次被截断了。`
        : `上限 ${progress.outputLimit}。`
      : '上限：跟随宿主的模型设置（未读到具体数值）。';
  /**
   * **实际消耗**：只有提供方真实回报才写"实测"，否则只说粗估 —— 两个来源不许混。
   */
  const actualText =
    progress.actual === undefined
      ? `已生成约 ${progress.outputTokensEstimate} token（粗估 ${progress.outputChars} 字符）／`
      : progress.phase === 'done'
        ? `本次实际消耗：输出 ${progress.actual.outputTokens ?? '—'} token、输入 ${progress.actual.inputTokens ?? '—'} token（提供方回报）／`
        : `已生成约 ${progress.outputTokensEstimate} token（粗估 ${progress.outputChars} 字符）／`;
  const phaseText = progress.phase === 'done' ? '已完成。' : progress.phase === 'error' ? '这一轮没成功。' : '';
  return `${shard}${actualText}${tail}${phaseText}`;
}

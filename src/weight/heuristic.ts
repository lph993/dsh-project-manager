/**
 * 零 token 启发式权重轨（§9.3a）。
 *
 * **为什么需要它**：看板百分比是**工作量口径**（§9.3）。若用户不开 AI 测量（默认关闭，FR-87），
 * 又没有任何结构信号，百分比就会退化成"按件数"—— 与"关闭测量仍是工作量口径"的承诺矛盾。
 * 因此必须有**零 token** 就能算出的结构评分。
 *
 * **本模块是纯函数**：只做评分、对标换算与退化判定，不读盘、不调 AI、不碰存储。
 * 输入信号由阶段 A（文件树扫描）提供；AI 侧样本由 `src/ai/`（尚未实现）提供。
 *
 * 口径（写死，避免"看起来像工作量"的模糊实现）：
 * ```
 * h_i       = α·log(1 + lineCount) + β·fileCount + γ·subtreeCount + δ·kindFactor(kind)
 * h_i       = max(h_i, hMin)                     // 硬下限，防 0/负
 * k         = mean{ aiW_i / max(h_i, hMin) }     // 对**所有已被 AI 测过的叶节点**逐节点等权
 * heurW_i   = clamp(k × h_i, 1, 10)              // 与 AI 轨同尺度（(0,10]）
 * ```
 *
 * **诚实边界**：若所有 `h_i` 都等于硬下限（零 token 路径确实拿不到任何结构差异），
 * 说明这一轮**没有结构数据**，此时不得再声称是工作量口径 —— 由调用方（`progress.ts` / 看板）
 * 标注「按件数·无结构数据」。`isStructurallyDegenerate()` 就是给这件事用的判据。
 */

import type { NodeKind } from '../shared/types.ts';
import { calibrateWeightScale, toHeuristicWeight } from '../domain/progress.ts';

/** 启发式系数（§9.3a 默认值；可在设置页调整）。 */
export interface HeuristicCoefficients {
  /** 行数项系数（对数压缩后加权）。 */
  alpha: number;
  /** 文件数项系数。 */
  beta: number;
  /** 子树叶节点数项系数。 */
  gamma: number;
  /** 类型项系数（feature / task）。 */
  delta: number;
}

/** 默认系数（§9.3a）。 */
export const DEFAULT_HEURISTIC_COEFFICIENTS: HeuristicCoefficients = {
  alpha: 1.0,
  beta: 0.5,
  gamma: 0.3,
  delta: 1.0,
};

/** 评分硬下限：即使空目录也不会出现 0（§9.3a）。 */
export const HEURISTIC_MIN_SCORE = 0.1;

/** 权重区间：与 AI 轨同为 `(0, 10]`（§9.3a）。 */
export const HEURISTIC_WEIGHT_MIN = 1;
export const HEURISTIC_WEIGHT_MAX = 10;

/** 一个叶节点的结构信号（全部零 token 可得）。 */
export interface HeuristicSignals {
  /** 该节点**对应目录**的直接子文件数。 */
  fileCount: number;
  /** 该目录下文件的行数之和。 */
  lineCount: number;
  /**
   * 该节点子树里的叶节点数（**含自身**，故对叶节点恒为 1）。
   *
   * 保留它是因为规范把它列为信号；对"只评叶节点"的本实现它只提供常量偏移，
   * 真正的区分度来自 `fileCount` 与 `lineCount`（见模块头注）。
   */
  subtreeCount: number;
  /** 节点类型（自动建树时顶层为 feature、更深处为 task）。 */
  kind: NodeKind;
  /** 行数是否为**估算值**（读盘受限时的兜底），会如实写进 `weightDetail`。 */
  lineCountEstimated?: boolean;
}

/**
 * 权重依据（落到 `NodeRecord.weightDetail`，供用户核对，FR-16）。
 *
 * 用 `type` 而非 `interface`：`NodeRecord.weightDetail` 是 `Record<string, unknown>`，
 * 只有对象字面量类型才带隐式索引签名，`interface` 会被 TS 拒绝赋值。
 */
export type HeuristicWeightDetail = {
  /** 依据来源：零 token 启发式。 */
  source: 'heuristic';
  signals: {
    fileCount: number;
    lineCount: number;
    subtreeCount: number;
    kindFactor: number;
    lineCountEstimated: boolean;
  };
  coefficients: HeuristicCoefficients;
  /** 未对标前的结构分（已过硬下限）。 */
  score: number;
  /** 对标系数（无 AI 样本时为 1）。 */
  k: number;
  /** 是否因"所有结构分都触到硬下限"而无区分度。 */
  degenerate: boolean;
};

/** 类型项：`feature` 视为比同规模 `task` 更重（顶层功能点的粒度更大）。 */
export function kindFactor(kind: NodeKind): number {
  return kind === 'feature' ? 1 : 0;
}

/**
 * 校验系数：不允许全部为 0（§9.3a 明写）。
 *
 * @returns 违规说明；合法时返回 undefined
 */
export function validateCoefficients(coefficients: HeuristicCoefficients): string | undefined {
  const values = [coefficients.alpha, coefficients.beta, coefficients.gamma, coefficients.delta];
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return '系数必须是非负有限数';
  }
  if (values.every((v) => v === 0)) {
    return '系数不允许全部为 0（否则所有节点权重相同，百分比会退化成按件数）';
  }
  return undefined;
}

/** 结构化评分 `h_i`（已过硬下限）。 */
export function computeHeuristicScore(
  signals: HeuristicSignals,
  coefficients: HeuristicCoefficients = DEFAULT_HEURISTIC_COEFFICIENTS,
): number {
  const fileCount = Math.max(0, signals.fileCount);
  const lineCount = Math.max(0, signals.lineCount);
  const subtreeCount = Math.max(0, signals.subtreeCount);
  const raw =
    coefficients.alpha * Math.log(1 + lineCount) +
    coefficients.beta * fileCount +
    coefficients.gamma * subtreeCount +
    coefficients.delta * kindFactor(signals.kind);
  if (!Number.isFinite(raw)) return HEURISTIC_MIN_SCORE;
  return Math.max(raw, HEURISTIC_MIN_SCORE);
}

/**
 * 对标系数 `k`：把启发式尺度换算到 AI 尺度（§9.3a）。
 *
 * 复用 `domain/progress.ts#calibrateWeightScale`（**同一套公式只有一份实现**，FR-134）：
 * 逐节点等权取算术平均，`k = mean{ aiW_i / max(h_i, hMin) }`。
 *
 * @param samples - 已被 AI 测过的叶节点样本（`aiWeight` 与对应结构分 `score`）
 * @returns `k`；无有效样本时返回 undefined（调用方按"无 AI 轨"处理，即 k=1）
 */
export function calibrateK(
  samples: ReadonlyArray<{ aiWeight: number; score: number }>,
): number | undefined {
  const scale = calibrateWeightScale(
    samples.map((s) => ({ aiW: s.aiWeight, h: Math.max(s.score, HEURISTIC_MIN_SCORE) })),
  );
  return scale.calibrated ? scale.k : undefined;
}

/** 启发式权重（`(0,10]` 收敛后的值）；复用领域层的收敛实现。 */
export function heuristicWeight(score: number, k = 1): number {
  const safeK = Number.isFinite(k) && k > 0 ? k : 1;
  return toHeuristicWeight(Math.max(score, HEURISTIC_MIN_SCORE), {
    k: safeK,
    samples: 0,
    calibrated: safeK !== 1,
  });
}

/**
 * 是否"结构上没有区分度"：所有结构分**完全相同**。
 *
 * 为什么不是"都等于硬下限才判退化"：默认系数里 `γ·subtreeCount` 是常量项（叶节点 =
 * 1），因此分数通常不会真的落到 `hMin`（0.1）。但"完全相同"才是我们真正关心的可观测条件 ——
 * 它等价于"零 token 路径拿不到任何结构差异"，此时加权百分比与按件数**数值一致**。
 * 出现这种情况时必须改口径标注（§9.3a），否则就是在用工作量口径的名义报件数。
 *
 * @param scores - 全部叶节点的结构分
 */
export function isStructurallyDegenerate(scores: readonly number[]): boolean {
  if (scores.length === 0) return false;
  const first = scores[0]!;
  return scores.every((score) => Math.abs(score - first) < 1e-9);
}

/**
 * 为一个叶节点算出权重与依据（阶段 A 落库用）。
 *
 * @param signals - 结构信号
 * @param options - 系数、对标系数、是否退化
 */
export function scoreLeaf(input: {
  signals: HeuristicSignals;
  coefficients?: HeuristicCoefficients;
  k?: number;
  degenerate?: boolean;
}): { weight: number; detail: HeuristicWeightDetail } {
  const coefficients = input.coefficients ?? DEFAULT_HEURISTIC_COEFFICIENTS;
  const score = computeHeuristicScore(input.signals, coefficients);
  const k = input.k === undefined || !Number.isFinite(input.k) || input.k <= 0 ? 1 : input.k;
  return {
    weight: heuristicWeight(score, k),
    detail: {
      source: 'heuristic',
      signals: {
        fileCount: Math.max(0, input.signals.fileCount),
        lineCount: Math.max(0, input.signals.lineCount),
        subtreeCount: Math.max(0, input.signals.subtreeCount),
        kindFactor: kindFactor(input.signals.kind),
        lineCountEstimated: input.signals.lineCountEstimated === true,
      },
      coefficients,
      score,
      k,
      degenerate: input.degenerate === true,
    },
  };
}

/** 人可读的一句话依据（看板/工具里展示，便于用户核对）。 */
export function describeWeightDetail(detail: HeuristicWeightDetail): string {
  const s = detail.signals;
  const lines = `行数 ${s.lineCount}${s.lineCountEstimated ? '（估算）' : ''}`;
  const base = `启发式：文件 ${s.fileCount}、${lines}、子树叶 ${s.subtreeCount} → 分 ${round2(detail.score)}`;
  const scaled = detail.k === 1 ? '（无 AI 样本，k=1）' : `（对标 k=${round2(detail.k)}）`;
  return detail.degenerate ? `${base}${scaled}；⚠ 无结构差异，百分比按件数口径` : `${base}${scaled}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

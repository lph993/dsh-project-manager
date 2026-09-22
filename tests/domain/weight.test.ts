/**
 * 零 token 启发式权重轨（§9.3a）的契约测试。
 *
 * 这一轨是"关闭 AI 测量也仍是工作量口径"这条承诺的**唯一依据**，
 * 所以必须把四件事钉死：
 * ① 公式与硬下限；② 系数校验（不许全 0）；③ `k` 对标；④ 无区分度时如实标退化。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_HEURISTIC_COEFFICIENTS,
  HEURISTIC_MIN_SCORE,
  HEURISTIC_WEIGHT_MAX,
  HEURISTIC_WEIGHT_MIN,
  calibrateK,
  computeHeuristicScore,
  describeWeightDetail,
  heuristicWeight,
  isStructurallyDegenerate,
  kindFactor,
  scoreLeaf,
  validateCoefficients,
} from '../../src/weight/heuristic.ts';

const baseSignals = {
  fileCount: 0,
  lineCount: 0,
  subtreeCount: 1,
  kind: 'task' as const,
};

describe('启发式评分（§9.3a）', () => {
  it('公式：α·log(1+行数) + β·文件数 + γ·子树叶数 + δ·类型', () => {
    const score = computeHeuristicScore(
      { fileCount: 4, lineCount: Math.E - 1, subtreeCount: 2, kind: 'feature' },
      DEFAULT_HEURISTIC_COEFFICIENTS,
    );
    // α·log(1+行数)=1·1=1；β·4=2；γ·2=0.6；δ·1=1（feature）
    assert.ok(Math.abs(score - (1 + 2 + 0.6 + 1)) < 1e-9, `实际 ${score}`);
  });

  it('硬下限：空目录/空文件也不会算出 0', () => {
    const score = computeHeuristicScore(baseSignals, {
      alpha: 0,
      beta: 0,
      gamma: 0,
      delta: 0.0001,
    });
    assert.equal(score, HEURISTIC_MIN_SCORE);
  });

  it('kindFactor：feature 比同规模 task 重', () => {
    assert.equal(kindFactor('feature'), 1);
    assert.equal(kindFactor('task'), 0);
    const feature = computeHeuristicScore({ ...baseSignals, kind: 'feature' });
    const task = computeHeuristicScore({ ...baseSignals, kind: 'task' });
    assert.ok(feature > task);
  });

  it('系数校验：不允许全 0，也不允许负数', () => {
    assert.equal(validateCoefficients(DEFAULT_HEURISTIC_COEFFICIENTS), undefined);
    assert.match(
      String(validateCoefficients({ alpha: 0, beta: 0, gamma: 0, delta: 0 })),
      /全部为 0/,
    );
    assert.match(String(validateCoefficients({ alpha: -1, beta: 0, gamma: 0, delta: 1 })), /非负/);
  });
});

describe('对标换算 k（§9.3a）', () => {
  it('k = 逐节点等权的 mean(aiW / h)（不是按枝加权）', () => {
    const k = calibrateK([
      { aiWeight: 4, score: 2 },
      { aiWeight: 9, score: 3 },
    ]);
    assert.ok(k !== undefined);
    assert.ok(Math.abs(k - (4 / 2 + 9 / 3) / 2) < 1e-9, `实际 k=${k}`);
  });

  it('无样本 → undefined（调用方按"没有 AI 轨"处理，不做换算）', () => {
    assert.equal(calibrateK([]), undefined);
    assert.equal(calibrateK([{ aiWeight: 0, score: 2 }]), undefined);
  });

  it('分母保护：score 触底也不会除零/得出 Infinity', () => {
    const k = calibrateK([{ aiWeight: 5, score: 0 }]);
    assert.ok(k !== undefined && Number.isFinite(k) && k > 0);
  });

  it('权重收敛到 (0,10]：下限 1、上限 10', () => {
    assert.equal(heuristicWeight(0.01, 1), HEURISTIC_WEIGHT_MIN);
    assert.equal(heuristicWeight(1000, 1), HEURISTIC_WEIGHT_MAX);
    assert.ok(Math.abs(heuristicWeight(2, 1.5) - 3) < 1e-9);
    // 坏 k 不产生 NaN
    assert.ok(Number.isFinite(heuristicWeight(3, Number.NaN)));
  });
});

describe('无区分度时的诚实降级（§9.3a）', () => {
  it('所有结构分相同 → 判为退化（此时加权结果与按件数一致）', () => {
    assert.equal(isStructurallyDegenerate([0.3, 0.3, 0.3]), true);
    assert.equal(isStructurallyDegenerate([0.3, 0.4]), false);
    assert.equal(isStructurallyDegenerate([]), false, '没有叶节点不算退化');
  });

  it('scoreLeaf 把依据（信号 + 系数 + 分 + k + 退化）一并带回', () => {
    const scored = scoreLeaf({
      signals: { fileCount: 3, lineCount: 100, subtreeCount: 1, kind: 'task' },
      degenerate: true,
    });
    assert.equal(scored.detail.source, 'heuristic');
    assert.equal(scored.detail.signals.fileCount, 3);
    assert.equal(scored.detail.signals.lineCountEstimated, false);
    assert.equal(scored.detail.degenerate, true);
    assert.ok(scored.weight >= HEURISTIC_WEIGHT_MIN && scored.weight <= HEURISTIC_WEIGHT_MAX);
    assert.match(describeWeightDetail(scored.detail), /按件数口径/);
  });

  it('估算行数会被如实标注（不允许把估算当实测）', () => {
    const scored = scoreLeaf({
      signals: { fileCount: 1, lineCount: 400, subtreeCount: 1, kind: 'task', lineCountEstimated: true },
    });
    assert.equal(scored.detail.signals.lineCountEstimated, true);
    assert.match(describeWeightDetail(scored.detail), /（估算）/);
  });
});

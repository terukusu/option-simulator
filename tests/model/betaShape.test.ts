/**
 * β の形 g(ΔX%)（#306。設計 5.4・5.13）: Δσ_β = β × g(ΔX%)。g は実測の中央値の形（BETA_SHAPE の定数）。
 * 値は実測の係数で文献値は無い。区切りの点の値は定数から手で計算した値を固定する（定数を変えたらここも直す）。
 */

import { describe, expect, it } from 'vitest';
import {
  BETA_SHAPE,
  betaAddPt,
  betaShapePt,
  type Scenario,
  SIGMA_MIN,
  sigmaAt,
  underlyingAt,
  ZERO_SCENARIO,
} from '../../model/scenario';
import { makeStrikes, makeSvi, sviTotalVariance } from '../support/synthChain';

/** −99%〜+900% の格子（0.01% 刻みの近く + 粗い外側） */
function grid(): number[] {
  const out: number[] = [];
  for (let x = -99; x <= 10; x += 0.01) out.push(Math.round(x * 100) / 100);
  for (let x = 10; x <= 900; x += 1) out.push(x);
  return out;
}

describe('BETA_SHAPE の定数', () => {
  it('傾きは 0 ≤ s1 ≤ s2 ≤ s3（凸・単調）、区切りは 0 < 3 < 6、上げの傾きは 0 以上、上限は正', () => {
    const [s1, s2, s3] = BETA_SHAPE.slopes;
    expect(BETA_SHAPE.knots).toEqual([3, 6]);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeGreaterThanOrEqual(s1);
    expect(s3).toBeGreaterThanOrEqual(s2);
    expect(BETA_SHAPE.upSlope).toBeGreaterThanOrEqual(0);
    expect(BETA_SHAPE.capPt).toBeGreaterThan(0);
  });

  it('いつのデータから求めた形か（期間・測った日・基準）が空でない', () => {
    expect(BETA_SHAPE.period).toMatch(/^\d{4}-\d{2}〜\d{4}-\d{2}$/);
    expect(BETA_SHAPE.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(BETA_SHAPE.basis.length).toBeGreaterThan(0);
  });
});

describe('g(ΔX%)（betaShapePt）', () => {
  it('区切りの点の値（定数 0.25 / 0.9 / 4・上限 60 から手で計算）', () => {
    expect(betaShapePt(0)).toBe(0);
    expect(betaShapePt(-1)).toBeCloseTo(0.25, 12);
    expect(betaShapePt(-3)).toBeCloseTo(0.75, 12);
    expect(betaShapePt(-4.5)).toBeCloseTo(0.75 + 1.35, 12);
    expect(betaShapePt(-6)).toBeCloseTo(3.45, 12);
    expect(betaShapePt(-10)).toBeCloseTo(19.45, 12);
    expect(betaShapePt(-15)).toBeCloseTo(39.45, 12);
    // 上限 60pt に当たる下げ幅 = 6 + (60 − 3.45) / 4 = 20.1375%
    expect(betaShapePt(-20.1375)).toBeCloseTo(60, 12);
    expect(betaShapePt(-25)).toBe(60);
    expect(betaShapePt(-99)).toBe(60);
  });

  it('上げでは upSlope × ΔX% だけ下げる（今の定数は 0 = 上げでは IV を動かさない。−0 を返さない）', () => {
    for (const x of [0.01, 1, 5, 30, 900]) {
      expect(betaShapePt(x)).toBeCloseTo(-BETA_SHAPE.upSlope * x, 12);
      if (BETA_SHAPE.upSlope === 0) expect(Object.is(betaShapePt(x), 0)).toBe(true);
    }
  });

  it('下げ幅に単調非減少・上限を超えない・有限（−99%〜+900%）', () => {
    const xs = grid();
    let prev = Number.POSITIVE_INFINITY;
    for (const x of xs) {
      const v = betaShapePt(x);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(BETA_SHAPE.capPt);
      // ΔX が上がる向きに走査するので、g は増えない
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      if (x < 0) expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });

  it('連続（区切り 0・−3%・−6%・上限の点で左右の極限が一致）', () => {
    const eps = 1e-9;
    for (const x of [0, -3, -6, -20.1375]) {
      expect(Math.abs(betaShapePt(x - eps) - betaShapePt(x + eps))).toBeLessThan(1e-7);
    }
  });

  it('凸（区間の傾きが深いほど大きいか等しい）: 上限より浅い所で差分の傾きが非減少', () => {
    const h = 0.05;
    let prevSlope = -1;
    for (let d = 0; d + h <= 20; d += h) {
      const slope = (betaShapePt(-(d + h)) - betaShapePt(-d)) / h;
      expect(slope).toBeGreaterThanOrEqual(prevSlope - 1e-9);
      prevSlope = slope;
    }
  });

  it('ΔX% が非有限（±∞・NaN）でも NaN を返さない（x0 = 0 の端。sigmaAt は σ_min の下限で有限）', () => {
    for (const x of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const v = betaShapePt(x);
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeLessThanOrEqual(BETA_SHAPE.capPt);
      expect(Number.isNaN(betaAddPt(x, 2))).toBe(false);
    }
    expect(betaShapePt(Number.NEGATIVE_INFINITY)).toBe(BETA_SHAPE.capPt);
    // x0 = 0 の評価（ΔX% = +∞）でも σ' は有限
    const s = sigmaAt(() => 0.25, 100, 100, 100, 0, 100, { ...ZERO_SCENARIO, beta: 1 }, SIGMA_MIN);
    expect(Number.isFinite(s)).toBe(true);
  });
});

describe('Δσ_β = β × g（betaAddPt）', () => {
  it('β = 0 は 0（連動なし）、β は倍率として線形（β = 2 は β = 1 の 2 倍）', () => {
    for (const x of [-99, -12, -6, -2, 0, 3, 900]) {
      expect(betaAddPt(x, 0)).toBe(0);
      expect(betaAddPt(x, 2)).toBeCloseTo(2 * betaAddPt(x, 1), 12);
      expect(betaAddPt(x, 0.5)).toBeCloseTo(0.5 * betaShapePt(x), 12);
    }
  });
});

/**
 * 合成の板: 前の板（SVI）の同じ行使価格に g(ΔX%) を足した後の板を作り、sticky strike・β = 1 のシナリオの σ' が
 * 行使価格ごとに後の板の IV を再現すること（架空の値）。
 */
describe('合成の板: 前の板 + g(ΔX%) を同じ行使価格に足した後の板をシナリオが再現する', () => {
  const F0 = 67810;
  const T = 30.5 / 365;
  const svi = makeSvi(T);
  const ivBefore = (k: number) => Math.sqrt(sviTotalVariance(svi, Math.log(k / F0)) / T);
  const sigmaBase = (x: number) => Math.sqrt(sviTotalVariance(svi, x) / T);
  const strikes = makeStrikes(F0);

  for (const pct of [-25, -10, -6, -4, -2, 0, 3, 8]) {
    it(`ΔX = ${pct}%`, () => {
      const xPrime = F0 * (1 + pct / 100);
      const sc: Scenario = { ...ZERO_SCENARIO, dX: xPrime - F0, beta: 1 };
      const add = betaShapePt(pct);
      for (const k of strikes) {
        const after = Math.max(SIGMA_MIN, ivBefore(k) + add / 100);
        const FiPrime = underlyingAt(F0, F0, xPrime, 'yen');
        const s = sigmaAt(sigmaBase, k, F0, FiPrime, F0, xPrime, sc, SIGMA_MIN);
        expect(Math.abs(s - after)).toBeLessThan(1e-9);
      }
    });
  }
});

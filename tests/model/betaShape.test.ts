/**
 * β の形 g(ΔX%)（#306・#354。設計 5.4・5.13・5.15）: Δσ_β = β × g(ΔX%)。g は実測の中央値の形（BETA_SHAPE の定数）の角を丸めたもの。
 *
 * 値は実測の係数で文献値は無い。傾き 0.25 / 0.9 / 4 は #306（2018-10〜2026-10 の日中の引け・1 限月・2 営業日・
 * 0.90F₀ の put の同じ行使価格の IV の変化の中央値。5.13）、上限 40pt と丸めの始まり −10% は #354（−15% より深い
 * 2〜20 営業日の窓 24 件で同じ行使価格の put の IV の上がりの最大 38pt（0.85〜1.00F）・45pt（0.80F）、前の形を
 * 超えた窓 0 件。1 限月の 2 日の窓の最深 約 −9.8%）。代表の点は定数から手で計算した値（定数を変えたらここも直す）。
 */

import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
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

const [K1, K2] = BETA_SHAPE.knots;
const [S1, S2, S3] = BETA_SHAPE.slopes;
const CAP = BETA_SHAPE.capPt;
const W0 = BETA_SHAPE.roundZeroPct;
const W = BETA_SHAPE.roundKnotPct;
const C0 = BETA_SHAPE.capRoundFromPct;
/** 折れ線が上限に届く下げ幅 = 6 + (40 − 0.75 − 2.7) / 4 = 15.1375% */
const D_CAP = K2 + (CAP - S1 * K1 - S2 * (K2 - K1)) / S3;
/** 上限の丸めの半幅 = 15.1375 − 10 = 5.1375。上限に届くのは 20.275% */
const W_C = D_CAP - C0;
const C_END = D_CAP + W_C;

/** 角を丸める前の折れ線（上限 40 で止める）。比べる基準 */
function kinked(d: number): number {
  const g =
    S1 * Math.min(d, K1) + S2 * Math.min(Math.max(d - K1, 0), K2 - K1) + S3 * Math.max(d - K2, 0);
  return Math.min(g, CAP);
}

/** g の下げ幅 d（> 0）での解析の傾き（pt / 1%）。区間の式（設計 5.13）を微分したもの */
function slopeAt(d: number, side: 'left' | 'right'): number {
  // 境の点は side の側の区間の式で評価する
  const inside = (a: number, b: number) => (side === 'right' ? d >= a && d < b : d > a && d <= b);
  if (inside(0, W0)) {
    const t = d / W0;
    return S1 * (4 * t - 3 * t * t);
  }
  if (inside(W0, K1 - W)) return S1;
  if (inside(K1 - W, K1 + W)) return S1 + ((S2 - S1) * (d - (K1 - W))) / (2 * W);
  if (inside(K1 + W, K2 - W)) return S2;
  if (inside(K2 - W, K2 + W)) return S2 + ((S3 - S2) * (d - (K2 - W))) / (2 * W);
  if (inside(K2 + W, C0)) return S3;
  if (inside(C0, C_END)) return S3 - (S3 * (d - C0)) / (2 * W_C);
  return 0;
}

describe('BETA_SHAPE の定数', () => {
  it('傾きは 0 ≤ s1 ≤ s2 ≤ s3（単調・凸）、区切りは 0 < 3 < 6、上げの傾きは 0 以上、上限は 40pt', () => {
    expect(BETA_SHAPE.knots).toEqual([3, 6]);
    expect(S1).toBeGreaterThanOrEqual(0);
    expect(S2).toBeGreaterThanOrEqual(S1);
    expect(S3).toBeGreaterThanOrEqual(S2);
    expect(BETA_SHAPE.upSlope).toBeGreaterThanOrEqual(0);
    expect(CAP).toBe(40);
  });

  it('丸めの幅が重ならない: 0 < w₀ ≤ k1 − w、2w ≤ k2 − k1、k2 + w ≤ 丸めの始まり < 上限に届く点', () => {
    expect(W0).toBeGreaterThan(0);
    expect(W0).toBeLessThanOrEqual(K1 - W);
    expect(2 * W).toBeLessThanOrEqual(K2 - K1);
    expect(K2 + W).toBeLessThanOrEqual(C0);
    expect(C0).toBeLessThan(D_CAP);
    expect(D_CAP).toBeCloseTo(15.1375, 12);
    expect(C_END).toBeCloseTo(20.275, 12);
  });

  it('いつのデータから求めた形か（期間・測った日・基準）が空でない', () => {
    expect(BETA_SHAPE.period).toMatch(/^\d{4}-\d{2}〜\d{4}-\d{2}$/);
    expect(BETA_SHAPE.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(BETA_SHAPE.basis.length).toBeGreaterThan(0);
  });
});

describe('g(ΔX%)（betaShapePt）', () => {
  it('代表の点の値（定数 0.25 / 0.9 / 4・丸めの幅 1 / 1.5・上限 40 を −10% から丸める、から手で計算）', () => {
    expect(betaShapePt(0)).toBe(0);
    // [0, w₀] の 3 次の端 = s1·w₀
    expect(betaShapePt(-1)).toBeCloseTo(0.25, 9);
    // −3% の角: g(1.5) + s1·1.5 + (s2 − s1)·1.5² / (4·1.5)
    expect(betaShapePt(-3)).toBeCloseTo(0.375 + 0.375 + (0.65 * 2.25) / 6, 9);
    expect(betaShapePt(-3)).toBeCloseTo(0.99375, 9);
    // 3 と 6 の丸めの境（直線の区間の上）
    expect(betaShapePt(-4.5)).toBeCloseTo(0.75 + 0.9 * 1.5, 9);
    // −5% は −6% の丸めの中: 2.55 + (s3 − s2)·0.5² / 6
    expect(betaShapePt(-5)).toBeCloseTo(2.55 + 3.1 / 24, 9);
    // −6% の角: 3.45 + (s3 − s2)·1.5² / 6
    expect(betaShapePt(-6)).toBeCloseTo(3.45 + (3.1 * 2.25) / 6, 9);
    expect(betaShapePt(-6)).toBeCloseTo(4.6125, 9);
    expect(betaShapePt(-7.5)).toBeCloseTo(3.45 + 4 * 1.5, 9);
    // −10% は丸める前と同じ（AC23・[急落]）
    expect(betaShapePt(-10)).toBeCloseTo(19.45, 9);
    // 上限の丸め: 19.45 + 4u − 4u² / (4·5.1375)
    expect(betaShapePt(-15)).toBeCloseTo(39.45 - 25 / 5.1375, 9);
    expect(betaShapePt(-15.1375)).toBeCloseTo(40 - 5.1375, 9);
    expect(betaShapePt(-20)).toBeCloseTo(40 - (4 * 0.275 * 0.275) / (4 * 5.1375), 9);
    expect(betaShapePt(-20.275)).toBeCloseTo(40, 9);
    expect(betaShapePt(-25)).toBe(CAP);
    expect(betaShapePt(-99)).toBe(CAP);
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
      expect(v).toBeLessThanOrEqual(CAP);
      // ΔX が上がる向きに走査するので、g は増えない
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      if (x < 0) expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });

  it('連続（区間の境と −3%・−6% で左右の極限が一致）', () => {
    const eps = 1e-9;
    for (const x of [
      0,
      -W0,
      -(K1 - W),
      -K1,
      -(K1 + W),
      -(K2 - W),
      -K2,
      -(K2 + W),
      -C0,
      -D_CAP,
      -C_END,
    ]) {
      expect(Math.abs(betaShapePt(x - eps) - betaShapePt(x + eps))).toBeLessThan(1e-7);
    }
  });

  it('1 階の微分が連続: 区間の境で左右の解析の傾きが一致（1e−9）し、g′(0) = 0・上限の先で 0', () => {
    const edges = [W0, K1 - W, K1 + W, K2 - W, K2 + W, C0, C_END];
    for (const d of edges) {
      expect(Math.abs(slopeAt(d, 'left') - slopeAt(d, 'right'))).toBeLessThan(1e-9);
    }
    expect(slopeAt(0, 'right')).toBe(0);
    expect(slopeAt(C_END, 'left')).toBeCloseTo(0, 12);
  });

  it('1 階の微分が連続: 実装の片側差分（h = 1e−6）が境の左右で 1e−5 以内・区間の中で解析の傾きと一致', () => {
    const h = 1e-6;
    const g = (d: number) => betaShapePt(-d);
    for (const d of [W0, K1 - W, K1, K1 + W, K2 - W, K2, K2 + W, C0, D_CAP, C_END]) {
      const left = (g(d) - g(d - h)) / h;
      const right = (g(d + h) - g(d)) / h;
      expect(Math.abs(right - left)).toBeLessThan(1e-5);
    }
    // g′(0) = 0
    expect(Math.abs(g(h) - g(0)) / h).toBeLessThan(1e-5);
    // 区間の中: 中心差分 ≈ 解析の傾き
    for (let d = 0.05; d < 30; d += 0.1) {
      const num = (g(d + h) - g(d - h)) / (2 * h);
      expect(Math.abs(num - slopeAt(d, 'right'))).toBeLessThan(1e-4);
    }
  });

  it('折れ目が無い: 0.01% 刻みの差分の傾きの隣どうしの差が 0.05 pt/1% 以下（d = 0〜30%）', () => {
    const h = 0.01;
    let prev = Number.NaN;
    let maxJump = 0;
    for (let i = 0; i * h < 30; i++) {
      const d = i * h;
      const slope = (betaShapePt(-(d + h)) - betaShapePt(-d)) / h;
      if (!Number.isNaN(prev)) maxJump = Math.max(maxJump, Math.abs(slope - prev));
      prev = slope;
    }
    expect(maxJump).toBeLessThanOrEqual(0.05);
  });

  it('凸: d = w₀〜丸めの始まり（1〜10%）で差分の傾きが非減少', () => {
    const h = 0.05;
    let prevSlope = -1;
    for (let i = 0; W0 + (i + 1) * h <= C0 + 1e-12; i++) {
      const d = W0 + i * h;
      const slope = (betaShapePt(-(d + h)) - betaShapePt(-d)) / h;
      expect(slope).toBeGreaterThanOrEqual(prevSlope - 1e-9);
      prevSlope = slope;
    }
  });

  it('凹: 上限の丸め（10%〜20.275%）で差分の傾きが非増加', () => {
    const h = 0.05;
    let prevSlope = Number.POSITIVE_INFINITY;
    for (let i = 0; C0 + (i + 1) * h <= C_END + 1e-12; i++) {
      const d = C0 + i * h;
      const slope = (betaShapePt(-(d + h)) - betaShapePt(-d)) / h;
      expect(slope).toBeLessThanOrEqual(prevSlope + 1e-9);
      prevSlope = slope;
    }
  });

  it('角を丸める前の折れ線（上限 40）からのずれは最大 5.1375pt、−3%・−6% の角では折れ線より上（損を大きく見る側）', () => {
    const bound = Math.max((S2 - S1) * W, (S3 - S2) * W, S3 * W_C, (S1 * W0 * 16) / 27) / 4 + 1e-12;
    // 上限の角の下側 s3·w_c / 4 = 5.1375 が最大（−3%・−6% の角は 0.24375・1.1625、0 の 3 次は 0.037）
    expect(bound).toBeCloseTo(5.1375, 9);
    for (let i = 0; i <= 9900; i++) {
      const d = i / 100;
      expect(Math.abs(betaShapePt(-d) - kinked(d))).toBeLessThanOrEqual(bound);
    }
    for (const d of [K1, K2]) expect(betaShapePt(-d)).toBeGreaterThanOrEqual(kinked(d));
    expect(betaShapePt(-K1) - kinked(K1)).toBeCloseTo(0.24375, 9);
    expect(betaShapePt(-K2) - kinked(K2)).toBeCloseTo(1.1625, 9);
    expect(betaShapePt(-D_CAP) - kinked(D_CAP)).toBeCloseTo(-5.1375, 9);
  });

  it('ΔX% が非有限（±∞・NaN）でも NaN を返さない（x0 = 0 の端。sigmaAt は σ_min の下限で有限）', () => {
    for (const x of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const v = betaShapePt(x);
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeLessThanOrEqual(CAP);
      expect(Number.isNaN(betaAddPt(x, 2))).toBe(false);
    }
    expect(betaShapePt(Number.NEGATIVE_INFINITY)).toBe(CAP);
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

/**
 * 合成の板の 1×2（+1 P 38,000 / −2 P 36,000。架空の値。X₀ = F = 40,000、T = 30 日）: β の形に角が無いので、
 * 今日の線（β 1・sticky strike）の傾きが区切りの点・上限の境で跳ばない（#354 AC2）。
 */
describe('合成の板の 1×2: 今日の線の傾きが β の形の区切りで跳ばない', () => {
  const X0 = 40000;
  const T = 30 / 365;
  const svi = makeSvi(T);
  const sigmaBase = (x: number) => Math.sqrt(sviTotalVariance(svi, x) / T);
  const sc: Scenario = { ...ZERO_SCENARIO, beta: 1 };
  /** 足（建値 = 今の板の σ_base の Black-76 = ΔX 0 の価格） */
  const legs = [
    { k: 38000, q: 1 },
    { k: 36000, q: -2 },
  ].map((l) => ({
    ...l,
    entry: black76Price('put', X0, l.k, T, sigmaBase(Math.log(l.k / X0)), 0),
  }));
  /** 損益（円）。σ は sigmaAt（β の形を通す） */
  const pnl = (x: number): number => {
    let total = 0;
    for (const { k, q, entry } of legs) {
      const s = sigmaAt(sigmaBase, k, X0, X0, X0, x, { ...sc, dX: x - X0 }, SIGMA_MIN);
      total += q * (black76Price('put', x, k, T, s, 0) - entry) * 1000;
    }
    return total;
  };

  for (const pct of [0, -1, -1.5, -3, -4.5, -6, -7.5, -10, -D_CAP, -C_END]) {
    it(`ΔX = ${pct}% の左右の傾き（ラージ換算の枚）の差が 0.01 以下`, () => {
      const x = X0 * (1 + pct / 100);
      // 幅 4 円の片側差分（左: X − 12〜X − 8、右: X + 8〜X + 12）
      const left = (pnl(x - 8) - pnl(x - 12)) / 4 / 1000;
      const right = (pnl(x + 12) - pnl(x + 8)) / 4 / 1000;
      expect(Math.abs(right - left)).toBeLessThanOrEqual(0.01);
    });
  }

  it('ΔX = 0 で損益 0、−10% の損益は g(−10%) = 19.45pt を同じ行使価格に足したときと一致', () => {
    expect(Math.abs(pnl(X0))).toBeLessThan(1e-6);
    const x = X0 * 0.9;
    expect(betaShapePt(-10)).toBeCloseTo(19.45, 9);
    let direct = 0;
    for (const { k, q, entry } of legs) {
      const s = sigmaBase(Math.log(k / X0)) + 19.45 / 100;
      direct += q * (black76Price('put', x, k, T, s, 0) - entry) * 1000;
    }
    expect(pnl(x)).toBeCloseTo(direct, 4);
  });
});

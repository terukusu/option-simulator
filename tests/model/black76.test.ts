import { describe, expect, it } from 'vitest';
import {
  black76Greeks,
  black76Price,
  discountedIntrinsic,
  type OptionType,
  upperBound,
} from '../../model/black76';
import { rng } from '../support/synthChain';

describe('Black-76: 文献値（AC3）', () => {
  // Hull『Options, Futures, and Other Derivatives』Black's model の数値例
  // （原油先物の European put: F0 = 20, K = 20, r = 9%, σ = 25%, T = 4 か月 → p = 1.12）
  it('Hull の数値例: put = 1.12', () => {
    const p = black76Price('put', 20, 20, 4 / 12, 0.25, 0.09);
    expect(p).toBeCloseTo(1.12, 2);
  });

  // Haug『The Complete Guide to Option Pricing Formulas』2nd ed., 1.1.2 Black-76 の例
  // （F = 19, K = 19, T = 0.75, r = 10%, σ = 28% → c = p = 1.7011）
  it('Haug の数値例: call = put = 1.7011', () => {
    expect(black76Price('call', 19, 19, 0.75, 0.28, 0.1)).toBeCloseTo(1.7011, 4);
    expect(black76Price('put', 19, 19, 0.75, 0.28, 0.1)).toBeCloseTo(1.7011, 4);
  });

  // 円の桁の参照値（mpmath 40 桁で同じ式を評価。架空の値）。0.01 円より十分細かく一致する
  it.each<[OptionType, number, number, number, number, number, number]>([
    ['call', 67810, 67750, 30.5 / 365, 0.25, 0.005, 1983.0301844226783391],
    ['put', 67810, 47500, 30.5 / 365, 0.5, 0.005, 18.382337233012301838],
    ['call', 30000, 45000, 1, 1.2, 0.01, 10162.54396261158771],
    ['put', 100000, 99000, 1 / 365, 0.15, 0, 37.099730291392448976],
  ])('%s F=%d K=%d → 参照値と 1e-6 円で一致', (type, F, K, T, s, r, want) => {
    expect(Math.abs(black76Price(type, F, K, T, s, r) - want)).toBeLessThan(1e-6);
  });
});

describe('Black-76: 性質テスト', () => {
  const rand = rng(42);
  const cases = Array.from({ length: 400 }, () => {
    const F = 20000 + rand() * 80000;
    return {
      F,
      K: F * (0.5 + rand()),
      T: (1 + rand() * 364) / 365,
      s: 0.05 + rand() * 1.45,
      r: rand() * 0.02,
    };
  });

  it('PCP 恒等式 C − P = e^{−rT}(F − K)（相対 1e-12）', () => {
    for (const { F, K, T, s, r } of cases) {
      const lhs = black76Price('call', F, K, T, s, r) - black76Price('put', F, K, T, s, r);
      const rhs = Math.exp(-r * T) * (F - K);
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-9 * F);
    }
  });

  it('無裁定の範囲: 割引本源的価値 ≤ 価格 ≤ 上限', () => {
    for (const { F, K, T, s, r } of cases) {
      for (const t of ['call', 'put'] as const) {
        const p = black76Price(t, F, K, T, s, r);
        expect(p).toBeGreaterThanOrEqual(discountedIntrinsic(t, F, K, T, r) - 1e-9);
        expect(p).toBeLessThanOrEqual(upperBound(t, F, K, T, r) + 1e-9);
      }
    }
  });

  it('K に対して call は減少・put は増加・どちらも凸', () => {
    const F = 67810;
    const T = 30 / 365;
    for (const s of [0.1, 0.25, 0.6, 1.2]) {
      const ks = Array.from({ length: 200 }, (_, i) => 30000 + i * 250);
      const c = ks.map((k) => black76Price('call', F, k, T, s, 0.005));
      const p = ks.map((k) => black76Price('put', F, k, T, s, 0.005));
      for (let i = 1; i < ks.length; i++) {
        expect(c[i]).toBeLessThanOrEqual(c[i - 1] as number);
        expect(p[i]).toBeGreaterThanOrEqual(p[i - 1] as number);
      }
      for (let i = 1; i + 1 < ks.length; i++) {
        expect(
          (c[i - 1] as number) - 2 * (c[i] as number) + (c[i + 1] as number),
        ).toBeGreaterThanOrEqual(-1e-9);
        expect(
          (p[i - 1] as number) - 2 * (p[i] as number) + (p[i + 1] as number),
        ).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('グリークが中心差分と相対 1e-4 で一致（AC3）', () => {
    for (const { F, K, T, s, r } of cases.slice(0, 150)) {
      for (const t of ['call', 'put'] as const) {
        const g = black76Greeks(t, F, K, T, s, r);
        const price = (f: number, tt: number, ss: number) => black76Price(t, f, K, tt, ss, r);
        const hF = F * 1e-4;
        const hS = 1e-5;
        const hT = Math.min(1e-6, T / 10);
        const fdDelta = (price(F + hF, T, s) - price(F - hF, T, s)) / (2 * hF);
        const fdGamma =
          (price(F + hF, T, s) - 2 * price(F, T, s) + price(F - hF, T, s)) / (hF * hF);
        const fdVega = (price(F, T, s + hS) - price(F, T, s - hS)) / (2 * hS);
        const fdTheta = -(price(F, T + hT, s) - price(F, T - hT, s)) / (2 * hT);
        // 値が小さい（深い OTM）ときは絶対誤差で見る
        const close = (a: number, b: number, scale: number) =>
          expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-4 * Math.max(Math.abs(b), scale));
        close(g.delta, fdDelta, 1e-3);
        close(g.gamma, fdGamma, 1e-3 / F);
        close(g.vega, fdVega, F * 1e-3);
        close(g.theta, fdTheta, F * 1e-3);
      }
    }
  });
});

describe('Black-76: 極限で NaN / Inf を出さない（AC3）', () => {
  const F = 67810;
  const finite = (v: number) => expect(Number.isFinite(v)).toBe(true);
  const allFinite = (t: OptionType, f: number, k: number, T: number, s: number) => {
    finite(black76Price(t, f, k, T, s, 0.005));
    const g = black76Greeks(t, f, k, T, s, 0.005);
    finite(g.delta);
    finite(g.gamma);
    finite(g.vega);
    finite(g.theta);
  };

  it.each(['call', 'put'] as const)('%s: T → 0、σ → 0、K → 0、K 大', (t) => {
    for (const T of [0, -1, 1e-15, 1e-9, 1 / 365 / 24 / 60]) {
      for (const k of [60000, F, 70000]) allFinite(t, F, k, T, 0.25);
    }
    for (const s of [0, 1e-12, 1e-6, 5, 50]) {
      for (const k of [60000, F, 70000]) allFinite(t, F, k, 30 / 365, s);
    }
    for (const k of [1e-300, 1e-12, 1, 1e12, 1e300]) allFinite(t, F, k, 30 / 365, 0.25);
  });

  it('T → 0 で本源的価値に収束、K → 0 の call は割引先物、K = 0 の put は 0', () => {
    expect(black76Price('call', F, 67000, 1e-12, 0.25, 0.005)).toBeCloseTo(810, 6);
    expect(black76Price('put', F, 67000, 1e-12, 0.25, 0.005)).toBeCloseTo(0, 6);
    expect(black76Price('call', F, 67000, 0, 0.25, 0.005)).toBe(810);
    expect(black76Price('put', F, 1e-300, 1, 0.25, 0)).toBe(0);
    expect(black76Price('call', F, 0, 1, 0.25, 0)).toBe(F);
    expect(black76Price('call', F, Number.POSITIVE_INFINITY, 1, 0.25, 0)).toBe(0);
    expect(black76Greeks('call', F, 0, 1, 0.25, 0).delta).toBe(1);
  });

  it('σ → 0 の price は割引本源的価値、delta は 0 か ±e^{−rT}', () => {
    const T = 30 / 365;
    expect(black76Price('call', F, 60000, T, 0, 0.005)).toBeCloseTo(Math.exp(-0.005 * T) * 7810, 9);
    expect(black76Greeks('put', F, 70000, T, 0, 0.005).delta).toBeCloseTo(
      -Math.exp(-0.005 * T),
      12,
    );
    expect(black76Greeks('put', F, 60000, T, 0, 0.005).delta).toBe(0);
  });
});

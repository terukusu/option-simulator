import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  betaAddPt,
  boardSigmaBase,
  CRASH_PRESETS,
  legSigmaBase,
  type Scenario,
  scenarioIvShift,
  scenarioSigma,
  underlyingAt,
  ZERO_SCENARIO,
} from '../../model/scenario';
import { PiecewiseLinearSmile } from '../../model/smile';

const X0 = 67810;
const T = 30.5 / 365;
// 架空のスマイル: ATM 25%、10% OTM put 31%、10% OTM call 22%
const smile = new PiecewiseLinearSmile(
  [
    { x: Math.log(0.9), w: 0.31 ** 2 * T },
    { x: 0, w: 0.25 ** 2 * T },
    { x: Math.log(1.1), w: 0.22 ** 2 * T },
  ],
  T,
);

const at = (k: number, sc: Scenario, sigmaBase = boardSigmaBase(smile), Fi = X0) => {
  const xPrime = X0 + sc.dX;
  const FiPrime = underlyingAt(Fi, X0, xPrime, 'yen');
  return { k, Fi, FiPrime, x0: X0, xPrime, scenario: sc, sigmaBase };
};

describe('急落プリセット / β（AC23）', () => {
  const preset = CRASH_PRESETS[0] as (typeof CRASH_PRESETS)[number];
  const sc = applyPreset({ ...ZERO_SCENARIO, beta: 1 }, preset, X0);

  it('プリセット「−10% / +20pt / +3」を β = 1 で: ATM は +39.45pt（+20 と β の g(−10%) = +19.45 は独立に加算）', () => {
    expect(sc.dX).toBeCloseTo(-6781, 9);
    const s = scenarioIvShift(at(X0, sc));
    // g(−10%) = 0.25 × 3 + 0.9 × 3 + 4 × 4 = 19.45（BETA_SHAPE。設計 5.13）
    expect(s.betaPt).toBeCloseTo(19.45, 9);
    expect(s.xEff).toBe(0);
    expect(Math.abs(s.shiftPt - 39.45)).toBeLessThan(1e-6);
    expect(scenarioSigma(at(X0, sc)) - smile.sigma(0)).toBeCloseTo(0.3945, 9);
  });

  it('10% OTM の put は +42.61pt（Δs × x_eff / 0.1 の +3.16pt が加わる。x_eff = ln 0.9 ≒ −0.105）', () => {
    const k = X0 * 0.9;
    const s = scenarioIvShift(at(k, sc));
    expect(Math.abs(s.shiftPt - (39.45 - (3 * Math.log(0.9)) / 0.1))).toBeLessThan(1e-6);
    expect(Math.abs(s.shiftPt - 42.6108)).toBeLessThan(1e-4);
  });

  it("β = 0 なら連動なし、sticky moneyness では x_eff が F_i' 基準になる", () => {
    const s0 = scenarioIvShift(at(X0, { ...sc, beta: 0 }));
    expect(s0.shiftPt).toBeCloseTo(20, 12);
    const sm = scenarioIvShift(at(X0, { ...sc, ivDynamics: 'sticky_moneyness' }));
    // F が 10% 下がると固定 K の moneyness は ln(1/0.9) > 0（call 側）→ スキューは IV を下げる向き
    expect(sm.xEff).toBeCloseTo(-Math.log(0.9), 12);
    expect(sm.shiftPt).toBeCloseTo(39.45 + (3 * Math.log(0.9)) / 0.1, 9);
  });

  it('sigmaAt と scenarioIvShift は同じ Δσ_β（式は betaAddPt の 1 か所）', () => {
    for (const pct of [-40, -12, -6, -4.5, -3, -1, 0, 2, 8]) {
      const s: Scenario = { ...sc, dX: (X0 * pct) / 100, dSigma: 0, skew: 0, beta: 1.7 };
      const shift = scenarioIvShift(at(X0, s));
      expect(shift.betaPt).toBeCloseTo(betaAddPt(pct, 1.7), 9);
      expect(scenarioSigma(at(X0, s)) - smile.sigma(0)).toBeCloseTo(shift.betaPt / 100, 12);
    }
  });

  it('β = 0 は連動なしの今までの価格と同じ（回帰）。上げでも下げでも σ_base + Δσ − Δs × x_eff / 0.1', () => {
    for (const pct of [-50, -10, -2, 0, 3, 30]) {
      for (const k of [X0 * 0.85, X0, X0 * 1.1]) {
        const s: Scenario = { ...sc, dX: (X0 * pct) / 100, beta: 0 };
        const xEff = Math.log(k / X0);
        expect(scenarioSigma(at(k, s))).toBeCloseTo(
          smile.sigma(xEff) + (20 - (3 * xEff) / 0.1) / 100,
          14,
        );
      }
    }
  });
});

describe("σ' = max(σ_min, σ_base(x_eff) + Δσ_total)", () => {
  it('足は σ_anchor + σ_smile(x) − σ_smile(x₀)（シナリオ 0 で σ_anchor）', () => {
    const k = 64000;
    const x0 = Math.log(k / X0);
    const anchor = 0.305; // 建値（bid）から逆算した IV。スマイル（mid）とは違う
    const base = legSigmaBase(anchor, x0, smile);
    expect(scenarioSigma(at(k, ZERO_SCENARIO, base))).toBeCloseTo(anchor, 15);
    // sticky moneyness で F が 5% 上がると x_eff = ln(K / 1.05F)。スマイルの差分だけ動く
    const sc: Scenario = {
      ...ZERO_SCENARIO,
      dX: X0 * 0.05,
      beta: 0,
      ivDynamics: 'sticky_moneyness',
    };
    const xEff = Math.log(k / (X0 * 1.05));
    expect(scenarioSigma(at(k, sc, base))).toBeCloseTo(
      anchor + smile.sigma(xEff) - smile.sigma(x0),
      14,
    );
  });

  it('σ_min = 1% で下限を切る', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, dSigma: -40 };
    expect(scenarioSigma(at(X0, sc))).toBe(0.01);
  });

  it('IV 平行移動の相対モード: σ_base × (1 + Δσ%)', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, dSigma: 20, ivShift: 'relative' };
    expect(scenarioSigma(at(X0, sc))).toBeCloseTo(0.25 * 1.2, 12);
  });
});

describe('基準原資産 X と basis（AC24 の式）', () => {
  it("円モード F_i' = X' + basis_i、% モード F_i' = X' × F_i / X₀、X' = X₀ で F_i に戻る", () => {
    const F2 = 67885;
    expect(underlyingAt(F2, X0, X0, 'yen')).toBe(F2);
    expect(underlyingAt(F2, X0, X0, 'pct')).toBeCloseTo(F2, 9);
    expect(underlyingAt(F2, X0, 60000, 'yen')).toBe(60000 + 75);
    expect(underlyingAt(F2, X0, 60000, 'pct')).toBeCloseTo((60000 * F2) / X0, 9);
  });
});

/**
 * #144: sticky moneyness で F_i' ≤ 0（円モードで basis_i < 0 の足を X' ≈ 0 に置いたとき）は x_eff = ln(K / F') が
 * 定義できない。σ' は σ_min（F ≤ 0 の Black-76 は本源的価値で σ に依らない）、x_eff は F_i から。
 */
describe("F_i' ≤ 0 の sticky moneyness（#144）", () => {
  const basis = -1_500;
  const Fi = X0 + basis;
  const sc: Scenario = { ...ZERO_SCENARIO, dX: -0.99 * X0, ivDynamics: 'sticky_moneyness' };

  it("σ' は σ_min（NaN にしない）、x_eff・Δσ_total は有限", () => {
    const input = at(64_000, sc, boardSigmaBase(smile), Fi);
    expect(input.FiPrime).toBeLessThanOrEqual(0);
    expect(scenarioSigma(input)).toBe(0.01);
    expect(scenarioSigma({ ...input, sigmaMin: 0.02 })).toBe(0.02);
    const shift = scenarioIvShift(input);
    expect(Number.isFinite(shift.xEff)).toBe(true);
    expect(shift.xEff).toBeCloseTo(Math.log(64_000 / Fi), 12);
    expect(Number.isFinite(shift.shiftPt)).toBe(true);
    // F' = 0 ちょうども同じ
    const zero = { ...input, FiPrime: 0 };
    expect(scenarioSigma(zero)).toBe(0.01);
    expect(Number.isFinite(scenarioIvShift(zero).xEff)).toBe(true);
  });

  it("F_i' > 0 と sticky strike は今と同じ", () => {
    const ok = at(64_000, { ...sc, dX: -0.5 * X0 }, boardSigmaBase(smile), Fi);
    expect(ok.FiPrime).toBeGreaterThan(0);
    expect(scenarioIvShift(ok).xEff).toBeCloseTo(Math.log(64_000 / ok.FiPrime), 12);
    const strike = at(64_000, { ...sc, ivDynamics: 'sticky_strike' }, boardSigmaBase(smile), Fi);
    expect(Number.isFinite(scenarioSigma(strike))).toBe(true);
    expect(scenarioIvShift(strike).xEff).toBeCloseTo(Math.log(64_000 / Fi), 12);
  });
});

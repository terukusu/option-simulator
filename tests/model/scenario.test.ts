import { describe, expect, it } from 'vitest';
import {
  applyPreset,
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

  it('プリセット「−10% / +20pt / +3」を β = 1 で: ATM は +30pt（+20 と β の +10 は独立に加算）', () => {
    expect(sc.dX).toBeCloseTo(-6781, 9);
    const s = scenarioIvShift(at(X0, sc));
    expect(s.betaPt).toBeCloseTo(10, 12);
    expect(s.xEff).toBe(0);
    expect(Math.abs(s.shiftPt - 30)).toBeLessThan(1e-6);
    expect(scenarioSigma(at(X0, sc)) - smile.sigma(0)).toBeCloseTo(0.3, 12);
  });

  it('10% OTM の put は +33.16pt（Δs × x_eff / 0.1 の +3.16pt が加わる。x_eff = ln 0.9 ≒ −0.105）', () => {
    const k = X0 * 0.9;
    const s = scenarioIvShift(at(k, sc));
    expect(Math.abs(s.shiftPt - (30 - (3 * Math.log(0.9)) / 0.1))).toBeLessThan(1e-6);
    expect(Math.abs(s.shiftPt - 33.1608)).toBeLessThan(1e-4);
  });

  it("β = 0 なら連動なし、sticky moneyness では x_eff が F_i' 基準になる", () => {
    const s0 = scenarioIvShift(at(X0, { ...sc, beta: 0 }));
    expect(s0.shiftPt).toBeCloseTo(20, 12);
    const sm = scenarioIvShift(at(X0, { ...sc, ivDynamics: 'sticky_moneyness' }));
    // F が 10% 下がると固定 K の moneyness は ln(1/0.9) > 0（call 側）→ スキューは IV を下げる向き
    expect(sm.xEff).toBeCloseTo(-Math.log(0.9), 12);
    expect(sm.shiftPt).toBeCloseTo(30 + (3 * Math.log(0.9)) / 0.1, 12);
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

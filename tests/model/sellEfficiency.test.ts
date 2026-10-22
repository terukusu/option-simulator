/**
 * 売りの効率（#163。設計 docs/design.md 11 章）。板は合成（tests/support/market.ts・synthChain。架空の値）。
 * 効率は新しい式を持たない（position の評価と margin の marginAt を呼ぶだけ）ので、文献値の代わりに
 * 「同じ足で各関数を直接呼んだ値と一致」を固定する。Black-76 自体の文献値は tests/model/black76.test.ts。
 */

import { describe, expect, it } from 'vitest';
import { black76Price, type OptionType } from '../../model/black76';
import { DEFAULT_MARGIN_PARAMS, type MarginParams, marginAt } from '../../model/margin';
import { DEFAULT_SETTINGS, evaluateLeg, prepareLeg } from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import {
  SELL_EFF_MIN_MARGIN,
  SELL_EFF_MIN_PREMIUM,
  sellEfficiency,
  sellLeg,
} from '../../model/sellEfficiency';
import { businessDaysAhead, DAY_MS, yearFraction } from '../../model/time';
import { M1, M2, makeMarket, R } from '../support/market';
import { rng, synthChain } from '../support/synthChain';

const { ctx } = makeMarket();
const smileOf = (id: string) => {
  const s = ctx.options[id]?.smile;
  if (!s) throw new Error('スマイルが無い');
  return s;
};
const H = businessDaysAhead(ctx.evalTime, 2, []);
const P: MarginParams = DEFAULT_MARGIN_PARAMS;

/** 行使価格 k の OTM 側の 1 枚の売り（σ = スマイルの IV）の入力 */
function input(month: typeof M1 | typeof M2, k: number, scenario: Scenario = ZERO_SCENARIO) {
  const type: OptionType = k < month.F ? 'put' : 'call';
  const sigma = smileOf(month.id).sigma(Math.log(k / month.F));
  return {
    expiry: month.id,
    strike: k,
    type,
    sigma,
    x: ctx.x0 + scenario.dX,
    scenario,
    horizonDays: H,
  };
}

describe('売りの効率（#163）', () => {
  it('必要証拠金は同じ 1 枚の売りの足で marginAt を直接呼んだ値と一致し、効率 = P × 1,000 / M', () => {
    const scenarios: Scenario[] = [
      ZERO_SCENARIO,
      { ...ZERO_SCENARIO, dSigma: 8 },
      { ...ZERO_SCENARIO, days: 5, dX: -2000, dSigma: 5, skew: 1 },
      { ...ZERO_SCENARIO, dSigma: 20, ivShift: 'relative' },
    ];
    for (const sc of scenarios) {
      for (const k of [50000, 60000, 66000, 67750, 70000, 74000]) {
        const inp = input(M1, k, sc);
        const r = sellEfficiency(inp, ctx, DEFAULT_SETTINGS, P);
        if (!r) throw new Error(`効率が決まらない: ${k}`);
        const p = prepareLeg(sellLeg(inp), ctx, DEFAULT_SETTINGS);
        const m = marginAt(
          [p],
          { x: inp.x, scenario: sc, horizonDays: H },
          ctx,
          DEFAULT_SETTINGS,
          P,
        );
        expect(r.margin).toBe(m.margin);
        expect(r.efficiency).toBe((r.premium * 1000) / m.margin);
        const e = evaluateLeg(p, inp.x, sc, ctx, DEFAULT_SETTINGS);
        expect(r.premium).toBe(e.value);
      }
    }
  });

  it('プレミアムは black76Price（σ = σ_smile(K) + Δσ）と相対 1e-9 で一致（β = 0・ΔX = 0・d = 0）', () => {
    const T = yearFraction(ctx.evalTime, ctx.evalTime + M1.days * DAY_MS);
    for (const dSigma of [0, 5, -3, 15]) {
      const sc: Scenario = { ...ZERO_SCENARIO, beta: 0, dSigma };
      for (const k of [55000, 62000, 67500, 69000, 72000]) {
        const inp = input(M1, k, sc);
        const r = sellEfficiency(inp, ctx, DEFAULT_SETTINGS, P);
        if (!r) throw new Error('効率が決まらない');
        const ref = black76Price(inp.type, M1.F, k, T, inp.sigma + dSigma / 100, ctx.r);
        expect(Math.abs(r.premium - ref) / ref).toBeLessThan(1e-9);
        expect(r.sigma).toBeCloseTo(inp.sigma + dSigma / 100, 12);
      }
    }
  });

  it('売りの Δ は displayGreeks の単位（put の売りは +、call の売りは −、ミニ = ラージ × 10）', () => {
    const put = sellEfficiency(input(M1, 64000), ctx, DEFAULT_SETTINGS, P);
    const call = sellEfficiency(input(M1, 71000), ctx, DEFAULT_SETTINGS, P);
    if (!put || !call) throw new Error('効率が決まらない');
    expect(put.deltaLarge).toBeGreaterThan(0);
    expect(put.deltaLarge).toBeLessThan(0.5);
    expect(call.deltaLarge).toBeLessThan(0);
    expect(put.deltaMini).toBeCloseTo(put.deltaLarge * 10, 12);
  });

  it('性質: Δσ を上げるとプレミアムは単調に増える（種 7 の 200 ケース）', () => {
    const rand = rng(7);
    let both = 0;
    for (let i = 0; i < 200; i++) {
      const month = rand() < 0.5 ? M1 : M2;
      const k = Math.round((month.F * (0.6 + rand() * 0.55)) / 125) * 125;
      const base: Scenario = {
        ...ZERO_SCENARIO,
        days: rand() * 10,
        dX: (rand() - 0.5) * 6000,
        skew: (rand() - 0.5) * 4,
      };
      const d1 = (rand() - 0.5) * 30;
      const d2 = d1 + 0.5 + rand() * 10;
      const a = sellEfficiency(input(month, k, { ...base, dSigma: d1 }), ctx, DEFAULT_SETTINGS, P);
      const b = sellEfficiency(input(month, k, { ...base, dSigma: d2 }), ctx, DEFAULT_SETTINGS, P);
      // 呼値未満で null になるのは IV の低い方から（高い方が null なら低い方も null）
      if (!b) {
        expect(a).toBeNull();
        continue;
      }
      if (!a) continue;
      both++;
      expect(b.premium).toBeGreaterThanOrEqual(a.premium);
      for (const r of [a, b]) {
        expect(Number.isFinite(r.efficiency)).toBe(true);
        expect(r.efficiency).toBeGreaterThanOrEqual(0);
      }
    }
    expect(both).toBeGreaterThan(150);
  });

  it('極限: ケースごとに値（有限・効率 ≥ 0・P ≥ 呼値・M ≥ 1 円）か null かを固定する（NaN を返さない）', () => {
    // 満期までの暦日（T0 × 365。yearFraction から作る = 足の T0 と同じ）
    const dExp = yearFraction(ctx.evalTime, ctx.options[M1.id]?.sqTime as number) * 365;
    const cases: Array<[string, number, Scenario, 'value' | 'null']> = [
      ['ファー OTM の put（呼値未満）', 20000, ZERO_SCENARIO, 'null'],
      ['ファー OTM の call（呼値未満）', 140000, ZERO_SCENARIO, 'null'],
      ['遠めの OTM の put', 50000, ZERO_SCENARIO, 'value'],
      [
        'T → 0 の OTM（時間価値が呼値未満）',
        60000,
        { ...ZERO_SCENARIO, days: dExp - 1e-4 },
        'null',
      ],
      [
        'T → 0 の ATM 付近（SQ の 0.01 日前）',
        67750,
        { ...ZERO_SCENARIO, days: dExp - 0.01 },
        'value',
      ],
      ['σ → 0（Δσ −500 で σ_min）', 60000, { ...ZERO_SCENARIO, dSigma: -500 }, 'null'],
      ['σ → 0 の ATM 付近', 67750, { ...ZERO_SCENARIO, dSigma: -500 }, 'value'],
      ['IV を大きく上げる', 30000, { ...ZERO_SCENARIO, dSigma: 200 }, 'value'],
    ];
    for (const [name, k, sc, want] of cases) {
      const r = sellEfficiency(input(M1, k, sc), ctx, DEFAULT_SETTINGS, P);
      if (want === 'null') {
        expect(r, name).toBeNull();
        continue;
      }
      if (!r) throw new Error(`値が無い: ${name}`);
      for (const v of Object.values(r)) expect(Number.isFinite(v), name).toBe(true);
      expect(r.efficiency, name).toBeGreaterThanOrEqual(0);
      expect(r.premium, name).toBeGreaterThanOrEqual(SELL_EFF_MIN_PREMIUM);
      expect(r.margin, name).toBeGreaterThanOrEqual(SELL_EFF_MIN_MARGIN);
    }
    expect(
      sellEfficiency({ ...input(M1, 60000), sigma: Number.NaN }, ctx, DEFAULT_SETTINGS, P),
    ).toBeNull();
    expect(sellEfficiency({ ...input(M1, 60000), sigma: 0 }, ctx, DEFAULT_SETTINGS, P)).toBeNull();
  });

  it('呼値未満のプレミアムは null（下限ちょうどの 1 円は値）、証拠金の下限は 1 円', () => {
    expect(SELL_EFF_MIN_PREMIUM).toBe(1);
    expect(SELL_EFF_MIN_MARGIN).toBe(1);
    // 遠い put を内側へ寄せていき、最初に P ≥ 1 円になる行使価格の 1 本外側は null
    let k = 20000;
    let r = sellEfficiency(input(M1, k), ctx, DEFAULT_SETTINGS, P);
    while (r === null && k < 60000) {
      k += 125;
      r = sellEfficiency(input(M1, k), ctx, DEFAULT_SETTINGS, P);
    }
    if (!r) throw new Error('値が無い');
    expect(r.premium).toBeGreaterThanOrEqual(1);
    const outside = input(M1, k - 125);
    const p = prepareLeg(sellLeg(outside), ctx, DEFAULT_SETTINGS);
    expect(evaluateLeg(p, outside.x, ZERO_SCENARIO, ctx, DEFAULT_SETTINGS).value).toBeLessThan(1);
    expect(sellEfficiency(outside, ctx, DEFAULT_SETTINGS, P)).toBeNull();
  });

  it('シナリオの d が満期を過ぎると null、限月が無い・F が決まらないと null', () => {
    const past: Scenario = { ...ZERO_SCENARIO, days: M1.days + 1 };
    expect(sellEfficiency(input(M1, 60000, past), ctx, DEFAULT_SETTINGS, P)).toBeNull();
    expect(
      sellEfficiency({ ...input(M1, 60000), expiry: 'none' }, ctx, DEFAULT_SETTINGS, P),
    ).toBeNull();
    const noF = {
      ...ctx,
      options: {
        ...ctx.options,
        [M1.id]: {
          ...(ctx.options[M1.id] as NonNullable<(typeof ctx.options)[string]>),
          forward: Number.NaN,
        },
      },
    };
    expect(sellEfficiency(input(M1, 60000), noF, DEFAULT_SETTINGS, P)).toBeNull();
  });

  it('合成の板: スマイルの IV での理論プレミアムが、板を作った真の IV の価格を回復する（±10% の行使価格で IV ±1pt の価格の幅）', () => {
    const T = M1.days / 365;
    // makeMarket と同じ引数（種 3）で真の IV（SVI）を取り直す
    const { trueVol } = synthChain({ F: M1.F, T, r: R, seed: 3 });
    let n = 0;
    for (const [k, vol] of trueVol) {
      if (Math.abs(k / M1.F - 1) > 0.1) continue;
      const type: OptionType = k < M1.F ? 'put' : 'call';
      const r = sellEfficiency(input(M1, k), ctx, DEFAULT_SETTINGS, P);
      if (!r) throw new Error('効率が決まらない');
      const t = yearFraction(ctx.evalTime, ctx.evalTime + M1.days * DAY_MS);
      const lo = black76Price(type, M1.F, k, t, vol - 0.01, ctx.r);
      const hi = black76Price(type, M1.F, k, t, vol + 0.01, ctx.r);
      expect(r.premium).toBeGreaterThanOrEqual(lo);
      expect(r.premium).toBeLessThanOrEqual(hi);
      expect(r.margin).toBeGreaterThan(0);
      n++;
    }
    expect(n).toBeGreaterThan(10);
  });
});

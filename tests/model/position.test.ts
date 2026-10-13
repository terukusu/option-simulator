import { describe, expect, it } from 'vitest';
import { black76Price, discountedIntrinsic } from '../../model/black76';
import { expiryProfile } from '../../model/pnl';
import {
  DEFAULT_SETTINGS,
  deltaUnits,
  displayGreeks,
  evaluateLeg,
  evaluatePosition,
  type Leg,
  type LegEvaluation,
  premiumSummary,
  prepareLeg,
  preparePosition,
} from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { DAY_MS, sqInstant, T_MIN_YEARS } from '../../model/time';
import { FUT, M1, M2, makeMarket, quoteOf } from '../support/market';

const { ctx, rows } = makeMarket();
const rows1 = rows[M1.id] as NonNullable<(typeof rows)[string]>;
const rows2 = rows[M2.id] as NonNullable<(typeof rows)[string]>;

function opLeg(
  month: typeof M1 | typeof M2,
  type: 'call' | 'put',
  k: number,
  side: 'buy' | 'sell',
  qty = 1,
): Leg & { kind: 'option' } {
  const q = quoteOf(month === M1 ? rows1 : rows2, k, type);
  return {
    kind: 'option',
    product: 'op_large',
    type,
    expiry: month.id,
    strike: k,
    side,
    qty,
    entry: side === 'buy' ? q.ask : q.bid,
    mid: q.mid,
  };
}

describe('デルタの単位（AC18）', () => {
  const fake = (delta: number): LegEvaluation => ({
    value: 0,
    pnl: 0,
    sigma: null,
    underlying: 0,
    greeks: { delta, gamma: 0, vega: 0, theta: 0 },
    state: 'live',
  });

  it('ラージ OP 1 枚 δ 0.5 買い = +0.5（ラージ）/ +5.0（ミニ）', () => {
    const p = prepareLeg(opLeg(M1, 'call', 67750, 'buy'), ctx);
    const d = displayGreeks(p, fake(0.5), ctx);
    expect(d.deltaLarge).toBeCloseTo(0.5, 15);
    expect(d.deltaMini).toBeCloseTo(5, 15);
  });

  it.each([
    ['fut_mini', 0.1, 1],
    ['fut_micro', 0.01, 0.1],
    ['fut_large', 1, 10],
  ] as const)('%s 1 枚買い = +%d / +%d', (product, large, mini) => {
    const leg: Leg = {
      kind: 'future',
      product,
      contract: FUT.id,
      side: 'buy',
      qty: 1,
      entry: FUT.price,
    };
    const p = prepareLeg(leg, ctx);
    const e = evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx);
    const d = displayGreeks(p, e, ctx);
    expect(d.deltaLarge).toBeCloseTo(large, 15);
    expect(d.deltaMini).toBeCloseTo(mini, 15);
  });

  it('売りは符号が逆、deltaUnits はラージ / ミニ / マイクロ', () => {
    const leg: Leg = {
      kind: 'future',
      product: 'fut_mini',
      contract: FUT.id,
      side: 'sell',
      qty: 3,
      entry: FUT.price,
    };
    const p = prepareLeg(leg, ctx);
    const d = displayGreeks(p, evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx), ctx);
    expect(d.deltaLarge).toBeCloseTo(-0.3, 15);
    expect(deltaUnits(-0.03)).toEqual({ large: -0.03, mini: -0.3, micro: -3 });
  });
});

describe('グリークの表示単位（設計 5.6）', () => {
  const legs = preparePosition([opLeg(M1, 'put', 64000, 'buy', 2)], ctx);
  const sc0: Scenario = { ...ZERO_SCENARIO, beta: 0 };
  const ev = evaluatePosition(legs, sc0, ctx);

  it('Θ は円 / 暦日で買いが負、1 日進めた損益の変化と近い', () => {
    expect(ev.total.thetaPerDay).toBeLessThan(0);
    const next = evaluatePosition(legs, { ...sc0, days: 1 / 24 }, ctx).pnl;
    expect(Math.abs((next - ev.pnl) * 24 - ev.total.thetaPerDay)).toBeLessThan(
      1e-3 * Math.abs(ev.total.thetaPerDay),
    );
  });

  it('V は円 / IV 1pt、IV +0.01pt の損益変化 × 100 と一致', () => {
    const up = evaluatePosition(legs, { ...sc0, dSigma: 0.01 }, ctx).pnl;
    expect(Math.abs((up - ev.pnl) * 100 - ev.total.vegaPerPt)).toBeLessThan(
      1e-3 * Math.abs(ev.total.vegaPerPt),
    );
  });

  it('Γ は X 100 円あたりの Δ（ラージ換算）の変化', () => {
    const h = 1;
    const dUp = evaluatePosition(legs, sc0, ctx, DEFAULT_SETTINGS, ctx.x0 + h).total.deltaLarge;
    const dDn = evaluatePosition(legs, sc0, ctx, DEFAULT_SETTINGS, ctx.x0 - h).total.deltaLarge;
    expect(((dUp - dDn) / (2 * h)) * 100).toBeCloseTo(ev.total.gammaPer100, 6);
  });
});

describe('板から入れた直後の損益 = 0（AC21）', () => {
  const legs: Leg[] = [
    opLeg(M1, 'put', 64000, 'sell'),
    opLeg(M1, 'call', 70500, 'sell'),
    opLeg(M1, 'call', 67750, 'buy', 3),
    opLeg(M1, 'call', 66000, 'buy'), // ITM（建値 > 割引本源的価値）
    opLeg(M2, 'put', 60000, 'buy', 2),
    opLeg(M2, 'call', 72000, 'sell'),
    {
      kind: 'future',
      product: 'fut_mini',
      contract: FUT.id,
      side: 'buy',
      qty: 4,
      entry: FUT.price,
    },
  ];
  const prepared = preparePosition(legs, ctx);

  it('両側気配があり建値 > 割引本源的価値の足は、シナリオ 0・d = 0 の理論損益が全足で 0 円', () => {
    // β は既定 1 のまま（ΔX = 0 なので効かない）
    const ev = evaluatePosition(prepared, ZERO_SCENARIO, ctx);
    for (const [i, e] of ev.legs.entries()) {
      expect(prepared[i]?.option?.anchorSource ?? 'future').not.toBe('smile');
      expect(Math.abs(e.pnl)).toBeLessThan(0.01);
    }
    expect(Math.abs(ev.pnl)).toBeLessThan(0.01);
  });

  it('スプレッドコスト（mid − 建値）と建値ずれは別に出る', () => {
    const s = premiumSummary(prepared);
    const want = legs.reduce((acc, l) => {
      if (l.kind !== 'option' || l.mid === undefined || l.mid === null) return acc;
      return acc + (l.side === 'buy' ? l.entry - l.mid : l.mid - l.entry) * l.qty * 1000;
    }, 0);
    expect(s.spreadCost).toBeCloseTo(want, 6);
    expect(s.spreadCost).toBeGreaterThan(0);
    expect(s.entryMismatch).toBe(0);
  });

  it('建値 ≤ 割引本源的価値の足（ITM の bid）は σ_anchor = σ_smile(x₀) で、差は建値ずれ', () => {
    const k = 62000;
    const T = M1.days / 365;
    const intrinsic = discountedIntrinsic('call', M1.F, k, T, ctx.r);
    const leg: Leg = {
      kind: 'option',
      product: 'op_large',
      type: 'call',
      expiry: M1.id,
      strike: k,
      side: 'sell',
      qty: 1,
      entry: Math.floor(intrinsic) - 10,
    };
    const p = prepareLeg(leg, ctx);
    expect(p.option?.anchorSource).toBe('smile');
    const smile = ctx.options[M1.id]?.smile;
    expect(p.option?.anchor).toBeCloseTo(smile?.sigma(Math.log(k / M1.F)) ?? 0, 15);
    const theo = black76Price('call', M1.F, k, T, p.option?.anchor ?? 0, ctx.r);
    expect(p.option?.mismatch).toBeCloseTo(leg.entry - theo, 9);
    // 売りで理論より安く売った → 不利（正）。損益はその分だけ負
    const s = premiumSummary([p]);
    expect(s.entryMismatch).toBeCloseTo((theo - leg.entry) * 1000, 6);
    const e = evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx);
    expect(e.pnl).toBeCloseTo(-s.entryMismatch, 6);
  });

  it('IV を編集した足はその IV で評価する', () => {
    const leg = { ...opLeg(M1, 'put', 64000, 'sell'), iv: 0.35 };
    const p = prepareLeg(leg, ctx);
    expect(p.option?.anchorSource).toBe('manual');
    const e = evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx);
    expect(e.sigma).toBeCloseTo(0.35, 15);
  });
});

describe('満期と T_min', () => {
  const leg = opLeg(M1, 'put', 66000, 'buy');
  const p = prepareLeg(leg, ctx);
  const daysToSq = M1.days;

  it("T' ≤ T_min は本源的価値、グリークは T_min の値で固定、SQ を過ぎた足は満期損益", () => {
    const near = evaluateLeg(
      p,
      65000,
      { ...ZERO_SCENARIO, days: daysToSq - T_MIN_YEARS * 365 * 0.5 },
      ctx,
    );
    expect(near.state).toBe('near_expiry');
    expect(near.value).toBeCloseTo(1000, 3);
    expect(Number.isFinite(near.greeks.delta)).toBe(true);
    const after = evaluateLeg(p, 65000, { ...ZERO_SCENARIO, days: daysToSq + 1, dSigma: 30 }, ctx);
    expect(after.state).toBe('expired');
    expect(after.value).toBe(1000);
    expect(after.pnl).toBeCloseTo((1000 - leg.entry) * 1000, 9);
  });

  it("「SQ 日 9:00」ボタン相当: 評価時刻を SQ に置くと T' = 0", () => {
    const sqTime = ctx.options[M1.id]?.sqTime ?? 0;
    const d = (sqTime - ctx.evalTime) / DAY_MS;
    expect(evaluateLeg(p, 65000, { ...ZERO_SCENARIO, days: d }, ctx).state).toBe('expired');
    expect(sqInstant('2026-11-13') % 1000).toBe(0);
  });

  it("先物の足: basis 固定 / 減衰、先物の SQ を過ぎたら F = X'", () => {
    const fl: Leg = {
      kind: 'future',
      product: 'fut_mini',
      contract: FUT.id,
      side: 'buy',
      qty: 1,
      entry: FUT.price,
    };
    const fp = prepareLeg(fl, ctx);
    const half = { ...ZERO_SCENARIO, days: FUT.days / 2 };
    expect(evaluateLeg(fp, 60000, half, ctx).value).toBeCloseTo(60000 + 70, 9);
    const decay = { ...DEFAULT_SETTINGS, futureBasis: 'decay' as const };
    expect(evaluateLeg(fp, 60000, half, ctx, decay).value).toBeCloseTo(60000 + 35, 9);
    const after = evaluateLeg(fp, 60000, { ...ZERO_SCENARIO, days: FUT.days + 1 }, ctx);
    expect(after.state).toBe('settled_flat');
    expect(after.value).toBe(60000);
  });
});

describe('アンカー IV が決まらない足（設計 5.3 (i)）', () => {
  it('建値が割引本源的価値 + 0.01 円未満ならスマイルにフォールバックし、差は建値ずれ', () => {
    const k = 64000;
    const T = M1.days / 365;
    const intrinsic = discountedIntrinsic('call', M1.F, k, T, ctx.r);
    const leg: Leg = {
      kind: 'option',
      product: 'op_large',
      type: 'call',
      expiry: M1.id,
      strike: k,
      side: 'sell',
      qty: 1,
      entry: intrinsic + 0.005,
    };
    const p = prepareLeg(leg, ctx);
    expect(p.option?.anchorSource).toBe('smile');
    expect(Number.isFinite(p.option?.mismatch ?? Number.NaN)).toBe(true);
    expect(p.option?.mismatch).toBeLessThan(0);
  });
});

describe('F が決まらない限月（NaN を広げない）', () => {
  const noF = {
    ...ctx,
    options: {
      ...ctx.options,
      BAD: { sqTime: ctx.evalTime + 30 * DAY_MS, forward: Number.NaN, smile: null },
    },
  };
  const leg: Leg = {
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: 'BAD',
    strike: 64000,
    side: 'sell',
    qty: 1,
    entry: 800,
  };

  it("prepareLeg は anchorSource 'none'、評価は建値のまま（損益 0、グリーク 0）", () => {
    const p = prepareLeg(leg, noF);
    expect(p.option?.anchorSource).toBe('none');
    expect(Number.isFinite(p.option?.anchor ?? Number.NaN)).toBe(true);
    expect(p.option?.mismatch).toBe(0);
    const e = evaluateLeg(p, 60000, { ...ZERO_SCENARIO, dSigma: 10 }, noF);
    expect(e.state).toBe('no_forward');
    expect(e.pnl).toBe(0);
    expect(e.greeks).toEqual({ delta: 0, gamma: 0, vega: 0, theta: 0 });
  });

  it('ポジション全体の損益・グリーク・満期プロファイルが有限', () => {
    const legs = preparePosition([leg, opLeg(M1, 'put', 64000, 'sell')], noF);
    const ev = evaluatePosition(legs, ZERO_SCENARIO, noF, DEFAULT_SETTINGS, 62000);
    expect(Number.isFinite(ev.pnl)).toBe(true);
    for (const v of Object.values(ev.total)) expect(Number.isFinite(v)).toBe(true);
    const prof = expiryProfile(legs, noF);
    expect(prof.points.every((pt) => Number.isFinite(pt.pnl))).toBe(true);
    expect(prof.kinks).toEqual([64000]);
  });
});

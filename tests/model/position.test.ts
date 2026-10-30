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
  legValue,
  type MarketContext,
  type ModelSettings,
  type PreparedLeg,
  premiumSummary,
  prepareLeg,
  preparePosition,
  theoreticalPnl,
} from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { DAY_MS, sqInstant, T_MIN_YEARS } from '../../model/time';
import { FUT, M1, M2, makeMarket, quoteOf } from '../support/market';
import { rng } from '../support/synthChain';

const { ctx, rows } = makeMarket();
const EVAL = ctx.evalTime;
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
    // 売りで理論より安く売った → 不利（損益への影響は負。#260 で足の詳細と同じ向きに）。損益はその分だけ負
    const s = premiumSummary([p]);
    expect(s.entryMismatch).toBeCloseTo((leg.entry - theo) * 1000, 6);
    expect(s.entryMismatch).toBeLessThan(0);
    const e = evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx);
    expect(e.pnl).toBeCloseTo(s.entryMismatch, 6);
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

describe('% モード（basisMode = pct）の Δ・Γ の定義（#260。設計 5.6）', () => {
  // Δ は各足の原資産 F_i あたり（dF/dX を掛けない。5.8 のヘッジと同じ定義）、Γ は「X が 100 円動いたときの
  // その Δ の変化」= Σ 枚数 × γ_i × dF_i/dX × 乗数 / 1,000 × 100（dF_i/dX = F_i / X₀ を 1 回）
  const pct = { ...DEFAULT_SETTINGS, basisMode: 'pct' as const };
  // β = 0: X を動かしても IV が変わらない（Γ の中心差分を IV の変化と混ぜない）
  const sc: Scenario = { ...ZERO_SCENARIO, beta: 0 };
  const legs = preparePosition(
    [
      opLeg(M2, 'put', 66000, 'sell', 2),
      opLeg(M2, 'call', 69000, 'buy'),
      opLeg(M1, 'put', 66500, 'sell'),
    ],
    ctx,
    pct,
  );
  const deltaAt = (x: number) =>
    evaluatePosition(legs, { ...sc, dX: x - ctx.x0 }, ctx, pct, x).total.deltaLarge;

  it('Δ = Σ 枚数 × δ(F_i) × 乗数 / 1,000（dF/dX を掛けない）', () => {
    const e = evaluatePosition(legs, sc, ctx, pct);
    let want = 0;
    for (const p of legs) {
      const g = evaluateLeg(p, ctx.x0, sc, ctx, pct).greeks;
      want += (p.sign * p.leg.qty * p.multiplier * g.delta) / 1000;
    }
    expect(e.total.deltaLarge).toBeCloseTo(want, 12);
  });

  it('Γ / 100 円 = その Δ の X についての中心差分 × 100（dF/dX を 1 回）', () => {
    const e = evaluatePosition(legs, sc, ctx, pct);
    const h = 1;
    const fd = ((deltaAt(ctx.x0 + h) - deltaAt(ctx.x0 - h)) / (2 * h)) * 100;
    expect(e.total.gammaPer100).toBeCloseTo(fd, 6);
    // dF/dX を掛けない Γ とは違う（M2 の F / X₀ ≠ 1 の分）
    let noSlope = 0;
    for (const p of legs) {
      const g = evaluateLeg(p, ctx.x0, sc, ctx, pct).greeks;
      noSlope += ((p.sign * p.leg.qty * p.multiplier * g.gamma) / 1000) * 100;
    }
    expect(Math.abs(e.total.gammaPer100 - noSlope)).toBeGreaterThan(1e-6);
  });
});

// ---------------------------------------------------------------- 前の板で建てた足の時価評価（#299）

describe('今の値段を渡した足（前の板で建てた足の時価評価。#299）', () => {
  const T1 = M1.days / 365;
  const putSell = (entry: number): Leg & { kind: 'option' } => ({
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: M1.id,
    strike: 64000,
    side: 'sell',
    qty: 1,
    entry,
  });
  const fees = { ...DEFAULT_SETTINGS, feePerLot: 50 };

  it('AC1: シナリオ 0 の評価価格 = 今の値段（1e-6）、損益 = 符号 × 枚数 × 乗数 × (今の値段 − 建値) − 手数料', () => {
    // 架空の例: 740 で売った P が今の板で 500
    const p = prepareLeg(putSell(740), ctx, fees, 500);
    expect(p.mark).toBe(500);
    expect(p.option?.anchorSource).toBe('mark');
    expect(p.option?.mismatch).toBe(0);
    expect(Math.abs(legValue(p, ctx.x0, ZERO_SCENARIO, ctx, fees) - 500)).toBeLessThan(1e-6);
    const e = evaluateLeg(p, ctx.x0, ZERO_SCENARIO, ctx, fees);
    expect(Math.abs(e.value - 500)).toBeLessThan(1e-6);
    const want = -1 * 1 * 1000 * (500 - 740) - 50;
    expect(e.pnl).toBeCloseTo(want, 6);
    expect(theoreticalPnl([p], ctx.x0, ZERO_SCENARIO, ctx, fees)).toBeCloseTo(want, 6);
    const s = premiumSummary([p], fees);
    expect(s.unrealized).toBeCloseTo(240_000, 9);
    expect(s.markedLegs).toBe(1);
  });

  /** 足の格子の評価（シナリオの格子の全点） */
  const GRID: Array<{ s: Scenario; settings: ModelSettings }> = [];
  for (const days of [0, 1, 5.5, 20, 400])
    for (const dX of [-3000, 0, 2500])
      for (const dSigma of [-5, 0, 8])
        for (const skew of [0, 0.6])
          for (const beta of [0, 1])
            for (const ivDynamics of ['sticky_strike', 'sticky_moneyness'] as const)
              for (const basisMode of ['yen', 'pct'] as const)
                GRID.push({
                  s: { days, dX, dSigma, skew, beta, ivDynamics, ivShift: 'absolute' },
                  settings: { ...DEFAULT_SETTINGS, basisMode, feePerLot: 30 },
                });

  it('AC2 性質: 今の値段 m の足 = 建値 m の今の板の足 + 符号 × 枚数 × 乗数 × (m − 建値)（rng(299) 400 通り × 格子）', () => {
    const rand = rng(299);
    const smile = ctx.options[M1.id]?.smile ?? null;
    let checked = 0;
    const bad: unknown[] = [];
    const sources = new Set<string>();
    for (let n = 0; n < 400; n++) {
      const F = 55000 + rand() * 25000;
      // T: ほとんどは 0.5〜200 日、1 割は T_min 付近（(0, 2 T_min]）
      const T = rand() < 0.1 ? T_MIN_YEARS * (0.05 + rand() * 1.95) : (0.5 + rand() * 199.5) / 365;
      const type = rand() < 0.5 ? 'put' : 'call';
      const strike = Math.round((F * (0.7 + rand() * 0.6)) / 125) * 125;
      const sigma = 0.08 + rand() * 0.6;
      const r = 0.005;
      // 今の値段: 8 割は Black-76 の値（逆算できる）、1 割は 0（深い OTM の気配なし相当）、1 割は割引本源的価値未満
      const u = rand();
      const intrinsic = discountedIntrinsic(type, F, strike, T, r);
      const m =
        u < 0.8
          ? black76Price(type, F, strike, T, sigma, r)
          : u < 0.9
            ? 0
            : Math.max(intrinsic - 1 - rand() * 50, 0);
      const entry = Math.max(m * (0.3 + rand() * 1.4) + (rand() - 0.5) * 100, 0);
      const side = rand() < 0.5 ? 'buy' : 'sell';
      const qty = 1 + Math.floor(rand() * 20);
      const withSmile = rand() < 0.8;
      const c: MarketContext = {
        evalTime: EVAL,
        r,
        x0: F * (0.99 + rand() * 0.02),
        options: {
          X: { sqTime: EVAL + T * 365 * DAY_MS, forward: F, smile: withSmile ? smile : null },
        },
        futures: {},
      };
      const leg: Leg = {
        kind: 'option',
        product: 'op_large',
        type,
        expiry: 'X',
        strike,
        side,
        qty,
        entry,
      };
      const held = prepareLeg(leg, c, DEFAULT_SETTINGS, m);
      const fresh = prepareLeg({ ...leg, entry: m }, c, DEFAULT_SETTINGS);
      expect(held.mark).toBe(m);
      sources.add(held.option?.anchorSource ?? 'none');
      const sgn = side === 'buy' ? 1 : -1;
      const shift = sgn * qty * 1000 * (m - entry);
      for (const { s, settings } of GRID) {
        const a = theoreticalPnl([held], c.x0 + s.dX, s, c, settings);
        const b = theoreticalPnl([fresh], c.x0 + s.dX, s, c, settings) + shift;
        // 格子の全点を見てから 1 回だけ expect する（expect を 28 万回呼ばない）
        const ok = Number.isFinite(a) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
        if (!ok) bad.push({ n, a, b, s, settings });
        checked++;
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
    expect(checked).toBe(400 * GRID.length);
    // 逆算できる・スマイルに落ちる・σ_min の 3 通りを含む
    expect([...sources].sort()).toEqual(['mark', 'none', 'smile']);
  }, 30_000);

  it('AC3 恒等式: シナリオ 0 の損益 = 含み損益 + 建値ずれ − 手数料（スマイル落ち・IV 編集・T₀ ≤ T_min・前の板の先物を含む）', () => {
    const tiny = {
      ...ctx,
      options: {
        ...ctx.options,
        NEAR: {
          sqTime: ctx.evalTime + T_MIN_YEARS * 0.5 * 365 * DAY_MS,
          forward: M1.F,
          smile: ctx.options[M1.id]?.smile ?? null,
        },
      },
    };
    const itmCall = 62000;
    const intrinsic = discountedIntrinsic('call', M1.F, itmCall, T1, ctx.r);
    const cases: Array<[Leg, number | undefined]> = [
      // 逆算できる今の値段
      [putSell(740), 500],
      // 今の値段 ≤ 割引本源的価値 → スマイル（差は建値ずれ）
      [
        {
          kind: 'option',
          product: 'op_large',
          type: 'call',
          expiry: M1.id,
          strike: itmCall,
          side: 'buy',
          qty: 2,
          entry: 5000,
        },
        Math.floor(intrinsic) - 10,
      ],
      // IV を編集した足（今の値段があっても編集した IV）
      [{ ...putSell(700), iv: 0.4, qty: 3 }, 520],
      // T₀ ≤ T_min
      [{ ...putSell(10), expiry: 'NEAR', strike: 68000, side: 'buy' }, 250],
      // 前の板で建てた先物の足（今の値段 = 評価に使う先物価格）
      [
        {
          kind: 'future',
          product: 'fut_mini',
          contract: FUT.id,
          side: 'sell',
          qty: 4,
          entry: 68500,
        },
        FUT.price,
      ],
      // 今の板で入れた足（今の値段なし）
      [opLeg(M2, 'call', 72000, 'sell'), undefined],
    ];
    const settings = { ...DEFAULT_SETTINGS, feePerLot: 30 };
    const prepared = cases.map(([l, m]) => prepareLeg(l, tiny, settings, m));
    expect(prepared[1]?.option?.anchorSource).toBe('smile');
    expect(prepared[2]?.option?.anchorSource).toBe('manual');
    expect(prepared[3]?.mark).toBe(250);
    const pnl0 = theoreticalPnl(prepared, tiny.x0, ZERO_SCENARIO, tiny, settings);
    const s = premiumSummary(prepared, settings);
    expect(s.markedLegs).toBe(5);
    expect(pnl0).toBeCloseTo(s.unrealized + s.entryMismatch - s.fees, 6);
    // 足ごとにも（evaluatePosition と合計が一致）
    const ev = evaluatePosition(prepared, ZERO_SCENARIO, tiny, settings);
    expect(ev.pnl).toBeCloseTo(pnl0, 6);
  });

  it('AC4: 今の値段を渡さない・使えない値（NaN・負・Infinity）は今と同じ', () => {
    const leg = opLeg(M1, 'put', 64000, 'sell');
    const base = prepareLeg(leg, ctx);
    expect(base.mark).toBeNull();
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, undefined]) {
      const p = prepareLeg(leg, ctx, DEFAULT_SETTINGS, bad);
      expect(p.mark).toBeNull();
      expect(p.option?.anchorSource).toBe(base.option?.anchorSource);
      expect(p.option?.anchor).toBe(base.option?.anchor);
      expect(p.option?.mismatch).toBe(base.option?.mismatch);
      for (const { s, settings } of GRID.slice(0, 40)) {
        expect(theoreticalPnl([p], ctx.x0 + s.dX, s, ctx, settings)).toBe(
          theoreticalPnl([base], ctx.x0 + s.dX, s, ctx, settings),
        );
      }
    }
    const s = premiumSummary([base]);
    expect(s.unrealized).toBe(0);
    expect(s.markedLegs).toBe(0);
  });

  it('AC5: IV を編集した足は今の値段があっても編集した IV がアンカー。先物の足の評価は今の値段の有無で同じ', () => {
    const p = prepareLeg({ ...putSell(740), iv: 0.33 }, ctx, DEFAULT_SETTINGS, 500);
    expect(p.option?.anchorSource).toBe('manual');
    expect(p.option?.anchor).toBe(0.33);
    expect(p.mark).toBe(500);
    const theo = black76Price('put', M1.F, 64000, T1, 0.33, ctx.r);
    expect(p.option?.mismatch).toBeCloseTo(500 - theo, 9);
    const fl: Leg = {
      kind: 'future',
      product: 'fut_large',
      contract: FUT.id,
      side: 'buy',
      qty: 2,
      entry: 69000,
    };
    const a = prepareLeg(fl, ctx);
    const b = prepareLeg(fl, ctx, DEFAULT_SETTINGS, FUT.price);
    expect(b.mark).toBe(FUT.price);
    for (const { s, settings } of GRID) {
      expect(evaluateLeg(b, ctx.x0 + s.dX, s, ctx, settings)).toEqual(
        evaluateLeg(a, ctx.x0 + s.dX, s, ctx, settings),
      );
    }
  });

  it('AC6: SQ を過ぎた足（T₀ ≤ 0）は今の値段を使わず、満期損益は今と同じ', () => {
    const past = {
      ...ctx,
      options: {
        ...ctx.options,
        PAST: { sqTime: ctx.evalTime - DAY_MS, forward: M1.F, smile: null },
      },
      futures: { ...ctx.futures, PASTF: { sqTime: ctx.evalTime - DAY_MS, price: M1.F } },
    };
    const leg = { ...putSell(740), expiry: 'PAST', strike: 68000 };
    const a = prepareLeg(leg, past);
    const b = prepareLeg(leg, past, DEFAULT_SETTINGS, 500);
    expect(b.mark).toBeNull();
    const fl: Leg = {
      kind: 'future',
      product: 'fut_mini',
      contract: 'PASTF',
      side: 'buy',
      qty: 1,
      entry: 67000,
    };
    expect(prepareLeg(fl, past, DEFAULT_SETTINGS, M1.F).mark).toBeNull();
    for (const x of [60000, 67000, 68000, 75000]) {
      const ea = evaluateLeg(a, x, ZERO_SCENARIO, past);
      const eb = evaluateLeg(b, x, ZERO_SCENARIO, past);
      expect(eb).toEqual(ea);
      expect(eb.state).toBe('expired');
    }
  });

  it('極限: 深い OTM の今の値段 0・スマイルなし・F が決まらない・T → 0 で NaN を出さない', () => {
    const noSmile = makeMarket({ withSmile: false }).ctx;
    const noF = {
      ...ctx,
      options: {
        ...ctx.options,
        BAD: { sqTime: ctx.evalTime + 30 * DAY_MS, forward: Number.NaN, smile: null },
      },
    };
    const legs: Array<[Leg, MarketContext]> = [
      [{ ...putSell(5), strike: 40000 }, ctx],
      [{ ...putSell(5), strike: 40000 }, noSmile],
      [{ ...putSell(800), expiry: 'BAD' }, noF],
    ];
    for (const [leg, c] of legs) {
      const p: PreparedLeg = prepareLeg(leg, c, DEFAULT_SETTINGS, 0);
      for (const { s, settings } of GRID) {
        const v = theoreticalPnl([p], c.x0 + s.dX, s, c, settings);
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Number.isFinite(premiumSummary([p]).unrealized)).toBe(true);
    }
    // F が決まらない足は今の値段を使わない（含み損益に入れない）
    expect(
      prepareLeg({ ...putSell(800), expiry: 'BAD' }, noF, DEFAULT_SETTINGS, 500).mark,
    ).toBeNull();
    // スマイルなしで逆算できない → σ_min
    const p0 = prepareLeg({ ...putSell(5), strike: 40000 }, noSmile, DEFAULT_SETTINGS, 0);
    expect(p0.option?.anchorSource).toBe('none');
  });
});

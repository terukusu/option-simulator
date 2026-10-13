import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import {
  expiryPnl,
  expiryProfile,
  findBreakevens,
  tailTable,
  theoreticalBreakevens,
} from '../../model/pnl';
import {
  DEFAULT_SETTINGS,
  evaluatePosition,
  type Leg,
  type MarketContext,
  type ModelSettings,
  preparePosition,
  theoreticalPnl,
} from '../../model/position';
import { applyPreset, CRASH_PRESETS, type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { DAY_MS } from '../../model/time';
import { EVAL_TIME, FUT, M1, M2, makeMarket, R } from '../support/market';

const { ctx } = makeMarket();

const op = (
  expiry: string,
  type: 'call' | 'put',
  strike: number,
  side: 'buy' | 'sell',
  entry: number,
  qty = 1,
): Leg => ({ kind: 'option', product: 'op_large', type, expiry, strike, side, qty, entry });

/** 1 円刻みの総当たりで満期損益の最大・最小・符号変化を求める（解析解の検算用）。 */
function bruteForce(
  legs: Leg[],
  c: MarketContext,
  lo: number,
  hi: number,
  settings: ModelSettings = DEFAULT_SETTINGS,
) {
  const prepared = preparePosition(legs, c, settings);
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  const bes: number[] = [];
  let prev = expiryPnl(prepared, lo, c, settings);
  for (let x = lo; x <= hi; x++) {
    const v = expiryPnl(prepared, x, c, settings);
    max = Math.max(max, v);
    min = Math.min(min, v);
    if (x > lo && prev * v < 0) bes.push(x);
    if (v === 0) bes.push(x);
    prev = v;
  }
  return { max, min, bes };
}

describe('満期損益の解析解（AC6）', () => {
  // 設計 6.1 の架空の例: 11 月限 F = 67,810、売り P 64,000 @ 810 と売り C 70,500 @ 995、手数料 0
  it('ストラングル売り: 最大利益 +1,805,000、put 側の最大損失 −62,195,000（SQ = 0）、call 側 ∞、BEP 62,195 / 72,305', () => {
    const legs = [op(M1.id, 'put', 64000, 'sell', 810), op(M1.id, 'call', 70500, 'sell', 995)];
    const prof = expiryProfile(preparePosition(legs, ctx), ctx);
    expect(prof.maxProfit).toEqual({ value: 1_805_000, x: 64000 });
    expect(prof.maxLoss.value).toBe(Number.NEGATIVE_INFINITY);
    expect(prof.worstAtKinks).toEqual({ value: -62_195_000, x: 0 });
    expect(prof.breakevens).toEqual([62195, 72305]);
    expect(prof.kinks).toEqual([64000, 70500]);
    expect(prof.rightSlope).toBe(-1000);
  });

  it('put 売りの最大損失は (K − 受取) × 乗数で有限、∞ は右端の傾きが負のときだけ', () => {
    const prof = expiryProfile(preparePosition([op(M1.id, 'put', 47500, 'sell', 30)], ctx), ctx);
    expect(prof.maxLoss).toEqual({ value: -(47500 - 30) * 1000, x: 0 });
    expect(prof.maxProfit.value).toBe(30_000);
    expect(prof.breakevens).toEqual([47470]);
    const call = expiryProfile(preparePosition([op(M1.id, 'call', 70500, 'buy', 995)], ctx), ctx);
    expect(call.maxProfit.value).toBe(Number.POSITIVE_INFINITY);
    expect(call.maxLoss).toEqual({ value: -995_000, x: 0 });
  });

  // 各テンプレート（1 限月 basis 0 と 2 限月 basis +75 円の混在を含む）で、解析解と 1 円刻みの総当たりを照合
  const templates: Record<string, Leg[]> = {
    ストラングル売り: [op(M1.id, 'put', 64000, 'sell', 810), op(M1.id, 'call', 70500, 'sell', 995)],
    ストラドル買い: [op(M2.id, 'put', 67875, 'buy', 2400), op(M2.id, 'call', 67875, 'buy', 2410)],
    プットバーティカル: [
      op(M1.id, 'put', 67750, 'buy', 1900),
      op(M1.id, 'put', 67250, 'sell', 1650),
    ],
    アイアンコンドル: [
      op(M2.id, 'put', 60000, 'buy', 320),
      op(M2.id, 'put', 62500, 'sell', 640),
      op(M2.id, 'call', 72500, 'sell', 560),
      op(M2.id, 'call', 75000, 'buy', 215),
    ],
    バタフライ: [
      op(M1.id, 'call', 66750, 'buy', 2450),
      op(M1.id, 'call', 67750, 'sell', 1900, 2),
      op(M1.id, 'call', 68750, 'buy', 1440),
    ],
    'カレンダー（満期は各 SQ）': [
      op(M1.id, 'call', 67750, 'sell', 1900),
      op(M2.id, 'call', 67750, 'buy', 2700),
    ],
    レシオ: [op(M1.id, 'put', 66000, 'buy', 1220), op(M1.id, 'put', 63000, 'sell', 470, 3)],
    'ミニ先物つきの put 売り': [
      op(M1.id, 'put', 47500, 'sell', 30),
      {
        kind: 'future',
        product: 'fut_mini',
        contract: FUT.id,
        side: 'buy',
        qty: 1,
        entry: FUT.price,
      },
    ],
  };

  it.each(Object.entries(templates))('%s: 折れ点・最大損益・BEP が総当たりと一致', (_, legs) => {
    const prepared = preparePosition(legs, ctx);
    const prof = expiryProfile(prepared, ctx);
    // 折れ点は横軸上で K − basis_i
    const want = [
      ...new Set(
        legs
          .filter((l) => l.kind === 'option')
          .map((l) =>
            l.kind === 'option' ? l.strike - ((ctx.options[l.expiry]?.forward ?? 0) - ctx.x0) : 0,
          ),
      ),
    ].sort((a, b) => a - b);
    expect(prof.kinks).toEqual(want);
    const hi = Math.max(...want, ctx.x0) + 30000;
    const bf = bruteForce(legs, ctx, prof.points[0]?.x ?? 0, hi);
    if (Number.isFinite(prof.maxProfit.value)) expect(prof.maxProfit.value).toBeCloseTo(bf.max, 6);
    else expect(prof.rightSlope).toBeGreaterThan(0);
    if (Number.isFinite(prof.maxLoss.value)) expect(prof.maxLoss.value).toBeCloseTo(bf.min, 6);
    else expect(prof.rightSlope).toBeLessThan(0);
    expect(prof.breakevens.length).toBe(bf.bes.length);
    prof.breakevens.forEach((b, i) => {
      expect(Math.abs(b - (bf.bes[i] ?? Number.NaN))).toBeLessThanOrEqual(1);
    });
  });

  it('basis ≠ 0 の限月の折れ点は K − basis_i（2 限月 basis = +75 → 67,875 の折れ点は 67,800）', () => {
    const prof = expiryProfile(preparePosition([op(M2.id, 'call', 67875, 'buy', 2410)], ctx), ctx);
    expect(prof.kinks).toEqual([67875 - (M2.F - M1.F)]);
    // % モードでは K × X₀ / F_i
    const pct = { ...DEFAULT_SETTINGS, basisMode: 'pct' as const };
    const p2 = expiryProfile(
      preparePosition([op(M2.id, 'call', 67875, 'buy', 2410)], ctx, pct),
      ctx,
      pct,
    );
    expect(p2.kinks[0]).toBeCloseTo((67875 * M1.F) / M2.F, 9);
  });

  it('手数料は 1 枚あたりで差し引く', () => {
    const fee = { ...DEFAULT_SETTINGS, feePerLot: 300 };
    const legs = [op(M1.id, 'put', 64000, 'sell', 810), op(M1.id, 'call', 70500, 'sell', 995)];
    const prof = expiryProfile(preparePosition(legs, ctx, fee), ctx, fee);
    expect(prof.maxProfit.value).toBe(1_805_000 - 600);
  });
});

describe('理論損益の BEP（符号変化を囲って二分法）', () => {
  it('findBreakevens は 1 円単位', () => {
    expect(findBreakevens((x) => x - 62195.3, 50000, 70000)).toEqual([62195]);
    expect(findBreakevens((x) => (x - 60000.7) * (x - 70000.2), 50000, 80000)).toEqual([
      60001, 70000,
    ]);
  });

  it('指定日の BEP で理論損益が 0 をまたぐ', () => {
    const legs = [op(M1.id, 'put', 64000, 'sell', 810), op(M1.id, 'call', 70500, 'sell', 995)];
    const prepared = preparePosition(legs, ctx);
    const sc = { ...ZERO_SCENARIO, days: 10 };
    const bes = theoreticalBreakevens(prepared, sc, ctx, { lo: 40000, hi: 90000 });
    expect(bes.length).toBe(2);
    for (const b of bes) {
      const a = theoreticalPnl(prepared, b - 1, sc, ctx);
      const c = theoreticalPnl(prepared, b + 1, sc, ctx);
      expect(a * c).toBeLessThan(0);
    }
  });
});

describe('テール表（AC22）', () => {
  const legs = [op(M1.id, 'put', 64000, 'sell', 810), op(M1.id, 'call', 70500, 'sell', 995)];
  const prepared = preparePosition(legs, ctx);
  const sc: Scenario = { ...ZERO_SCENARIO, beta: 1, dSigma: 2, skew: 1, days: 3 };
  const table = tailTable(prepared, sc, ctx);

  it('−5〜−40% の 5 列、基準は受取プレミアム 1,805,000', () => {
    expect(table.rows.map((r) => r.shock)).toEqual([-0.05, -0.1, -0.2, -0.3, -0.4]);
    expect(table.premiumBase).toEqual({ kind: 'received', amount: 1_805_000 });
  });

  it('SQ 列は満期損益の式（設計 6.1 の例と一致）と倍率', () => {
    const want = [1_805_000, -1_166_000, -7_947_000, -14_728_000, -21_509_000];
    table.rows.forEach((r, i) => {
      expect(r.sq.pnl).toBeCloseTo(want[i] as number, 6);
      expect(r.sq.pnl).toBeCloseTo(expiryPnl(prepared, r.x, ctx), 9);
      expect(r.sq.ratio).toBeCloseTo((want[i] as number) / 1_805_000, 12);
    });
  });

  it('指定日列はシナリオ IV（β 込み）の Black-76 を足ごとに手で計算した値と一致', () => {
    const smile = ctx.options[M1.id]?.smile;
    if (!smile) throw new Error('スマイルが無い');
    for (const r of table.rows) {
      let want = 0;
      for (const p of prepared) {
        if (p.leg.kind !== 'option' || !p.option) continue;
        const K = p.leg.strike;
        const x = Math.log(K / M1.F); // sticky strike → x_eff = x₀
        const shiftPt = sc.dSigma + -sc.beta * r.shock * 100 - (sc.skew * x) / 0.1;
        const sigma = Math.max(0.01, p.option.anchor + shiftPt / 100);
        const T = (M1.days - sc.days) / 365;
        const value = black76Price(p.leg.type, r.x, K, T, sigma, R);
        want += p.sign * 1000 * (value - p.leg.entry);
      }
      expect(r.scenario.pnl).toBeCloseTo(want, 6);
      expect(r.scenario.ratio).toBeCloseTo(want / 1_805_000, 12);
    }
  });

  it('買い（支払超）の倍率は掛け金基準', () => {
    const t = tailTable(
      preparePosition([op(M1.id, 'put', 47500, 'buy', 5)], ctx),
      ZERO_SCENARIO,
      ctx,
    );
    expect(t.premiumBase).toEqual({ kind: 'paid', amount: 5000 });
  });
});

describe('複数限月の横軸（AC24）', () => {
  const legs: Leg[] = [
    op(M1.id, 'put', 64000, 'sell', 810),
    op(M2.id, 'call', 72000, 'buy', 720),
    {
      kind: 'future',
      product: 'fut_mini',
      contract: FUT.id,
      side: 'buy',
      qty: 2,
      entry: FUT.price,
    },
  ];

  it.each(['yen', 'pct'] as const)(
    "%s モード: X' = X₀ で各限月の F が板の F に戻り、X' を動かすと basis どおり",
    (mode) => {
      const settings = { ...DEFAULT_SETTINGS, basisMode: mode };
      const prepared = preparePosition(legs, ctx, settings);
      const at = (x: number) =>
        evaluatePosition(prepared, ZERO_SCENARIO, ctx, settings, x).legs.map((l) => l.underlying);
      const [f1, f2, ff] = at(ctx.x0);
      expect(f1).toBeCloseTo(M1.F, 9);
      expect(f2).toBeCloseTo(M2.F, 9);
      expect(ff).toBeCloseTo(FUT.price, 9);
      const x = 60000;
      const [g1, g2, gf] = at(x);
      if (mode === 'yen') {
        expect(g1).toBeCloseTo(x, 9);
        expect(g2).toBeCloseTo(x + (M2.F - M1.F), 9);
        expect(gf).toBeCloseTo(x + (FUT.price - M1.F), 9);
      } else {
        expect(g2).toBeCloseTo((x * M2.F) / M1.F, 9);
        expect(gf).toBeCloseTo((x * FUT.price) / M1.F, 9);
      }
    },
  );

  it('満期の折れ点は K − basis_i、先物の足は傾き 1 で basis 込み', () => {
    const prepared = preparePosition(legs, ctx);
    const prof = expiryProfile(prepared, ctx);
    expect(prof.kinks).toEqual([64000, 72000 - (M2.F - M1.F)]);
    // 右端の傾き: call 買い 1,000 + ミニ 2 枚 200
    expect(prof.rightSlope).toBe(1200);
  });

  it('先の SQ（1 限月）で評価すると 1 限月は満期損益、2 限月は残存 T の Black-76', () => {
    const prepared = preparePosition(legs, ctx);
    const d = ((ctx.options[M1.id]?.sqTime ?? 0) - EVAL_TIME) / DAY_MS;
    const ev = evaluatePosition(
      prepared,
      { ...ZERO_SCENARIO, days: d },
      ctx,
      DEFAULT_SETTINGS,
      63000,
    );
    expect(ev.legs[0]?.state).toBe('expired');
    expect(ev.legs[1]?.state).toBe('live');
  });
});

describe('急落プリセットをポジションに（AC23 の通し）', () => {
  it('ATM の足の IV は +30pt', () => {
    const legs = [op(M1.id, 'call', 67750, 'buy', 1990)];
    const prepared = preparePosition(legs, ctx);
    const preset = CRASH_PRESETS[0] as (typeof CRASH_PRESETS)[number];
    const sc = applyPreset({ ...ZERO_SCENARIO, beta: 1 }, preset, ctx.x0);
    const ev = evaluatePosition(prepared, sc, ctx);
    const x = Math.log(67750 / M1.F);
    const anchor = prepared[0]?.option?.anchor ?? 0;
    expect((ev.legs[0]?.sigma ?? 0) - anchor).toBeCloseTo(0.3 - (3 * x) / 0.1 / 100, 12);
  });
});

describe('設計 6.1 のワイヤーの数値（架空の例）と一致', () => {
  // 11 月限 T = 30.5 日、F = 67,810、売り P 64,000 @ 810 / 売り C 70,500 @ 995、β = 1、スマイルなし
  const c: MarketContext = {
    evalTime: 0,
    r: 0.005,
    x0: 67810,
    options: { M1: { sqTime: 30.5 * DAY_MS, forward: 67810, smile: null } },
    futures: {},
  };
  const legs = [op('M1', 'put', 64000, 'sell', 810), op('M1', 'call', 70500, 'sell', 995)];
  const prepared = preparePosition(legs, c);

  it('アンカー IV 29.1% / 26.0%、Δ −0.08 枚（ミニ −0.8）、Γ −0.012、Θ +58,250 / 日、V −129,500 / pt', () => {
    expect(prepared[0]?.option?.anchor).toBeCloseTo(0.291, 3);
    expect(prepared[1]?.option?.anchor).toBeCloseTo(0.26, 2);
    const t = evaluatePosition(prepared, ZERO_SCENARIO, c).total;
    expect(t.deltaLarge).toBeCloseTo(-0.08, 2);
    expect(t.deltaMini).toBeCloseTo(-0.8, 1);
    expect(t.gammaPer100).toBeCloseTo(-0.012, 3);
    expect(Math.abs(t.thetaPerDay / 58250 - 1)).toBeLessThan(0.002);
    expect(Math.abs(t.vegaPerPt / -129500 - 1)).toBeLessThan(0.002);
  });

  it('テール表の指定日（d = 0、sticky strike、β = 1）: −1,010,000 / −2,999,000 / −8,522,000 / −14,895,000 / −21,546,000', () => {
    const t = tailTable(prepared, ZERO_SCENARIO, c);
    const want = [-1_010_000, -2_999_000, -8_522_000, -14_895_000, -21_546_000];
    t.rows.forEach((r, i) => {
      // 設計の表は千円単位の丸め（−30% は −14,895,678 を −14,895,000 と表記）なので ±1,000 円で照合
      expect(Math.abs(r.scenario.pnl - (want[i] as number))).toBeLessThanOrEqual(1000);
    });
    expect(t.rows.map((r) => Math.round(Math.abs(r.scenario.ratio ?? 0) * 10) / 10)).toEqual([
      0.6, 1.7, 4.7, 8.3, 11.9,
    ]);
  });
});

describe('先物だけのポジションの満期（SQ の違う先物 2 本）', () => {
  // 架空の値: 近い限月（SQ まで 30 日、67,700）と先の限月（SQ まで 120 日、67,950）
  const c: MarketContext = {
    evalTime: 0,
    r: 0.005,
    x0: 67810,
    options: {},
    futures: {
      NEAR: { sqTime: 30 * DAY_MS, price: 67700 },
      FAR: { sqTime: 120 * DAY_MS, price: 67950 },
    },
  };
  const legs: Leg[] = [
    { kind: 'future', product: 'fut_mini', contract: 'NEAR', side: 'buy', qty: 2, entry: 67700 },
    { kind: 'future', product: 'fut_large', contract: 'FAR', side: 'sell', qty: 1, entry: 67950 },
  ];

  it.each(['fixed', 'decay'] as const)(
    'basis %s: expiryProfile / expiryPnl が最後の SQ での evaluateLeg と一致',
    (futureBasis) => {
      const settings = { ...DEFAULT_SETTINGS, futureBasis };
      const prepared = preparePosition(legs, c, settings);
      const prof = expiryProfile(prepared, c, settings);
      const sc = { ...ZERO_SCENARIO, days: 120 };
      for (const x of [40000, 60000, 67810, 80000]) {
        const want = evaluatePosition(prepared, sc, c, settings, x).pnl;
        expect(expiryPnl(prepared, x, c, settings)).toBeCloseTo(want, 6);
      }
      // 両方とも SQ に達しているので F = X'。傾き = ミニ 2 枚 200 − ラージ 1 枚 1,000
      expect(prof.rightSlope).toBe(-800);
    },
  );
});

describe('basis ≠ 0 の限月の put 売り（設計 5.5 の注記）', () => {
  it('basis > 0 の限月は SQ の下限が basis になり、最大損失は (K − basis − 受取) × 乗数', () => {
    const basis = M2.F - M1.F; // +75
    const prof = expiryProfile(preparePosition([op(M2.id, 'put', 60000, 'sell', 320)], ctx), ctx);
    expect(prof.points[0]?.x).toBe(0);
    expect(prof.maxLoss).toEqual({ value: -(60000 - basis - 320) * 1000, x: 0 });
    expect(prof.breakevens).toEqual([60000 - basis - 320]);
  });

  it("basis < 0 の限月は X' の下端が −basis（SQ = 0）で、最大損失は (K − 受取) × 乗数", () => {
    const c: MarketContext = {
      ...ctx,
      options: {
        ...ctx.options,
        LOW: { sqTime: ctx.evalTime + 30 * DAY_MS, forward: M1.F - 200, smile: null },
      },
    };
    const prof = expiryProfile(preparePosition([op('LOW', 'put', 60000, 'sell', 320)], c), c);
    expect(prof.points[0]?.x).toBe(200);
    expect(prof.maxLoss).toEqual({ value: -(60000 - 320) * 1000, x: 200 });
  });
});

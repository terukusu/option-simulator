/**
 * 過去の急落の再生の当て方（#307。設計 docs/design.md 5.14）。板は合成（tests/support/market.ts。架空の値）。
 * 期間構造・iv30 の値もすべて架空。
 */

import { describe, expect, it } from 'vitest';
import {
  type HoldMapAxes,
  type HoldMapCalc,
  holdMapColumn,
  holdMapLegs,
  holdMapLegsBy,
  holdMapPnlColumn,
  holdMapScenario,
} from '../../model/holdMap';
import { DEFAULT_MARGIN_PARAMS, type MarginParams } from '../../model/margin';
import { expiryPnl } from '../../model/pnl';
import {
  DEFAULT_SETTINGS,
  type Leg,
  legSigma,
  type MarketContext,
  type ModelSettings,
  type OptionLeg,
  type PreparedLeg,
  premiumSummary,
  preparePosition,
  theoreticalPnl,
} from '../../model/position';
import {
  type AtmTerm,
  type ReplayCalc,
  replayDay,
  replayIvRatio,
  replaySummary,
  termIv,
} from '../../model/replay';
import { type IvDynamics, ZERO_SCENARIO } from '../../model/scenario';
import type { Smile } from '../../model/smile';
import { businessDaysAhead, DAY_MS } from '../../model/time';
import { FUT, M1, M2, makeMarket, quoteOf } from '../support/market';

const { ctx, rows } = makeMarket();
const SETTINGS: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: 50 };
const PARAMS: MarginParams = { ...DEFAULT_MARGIN_PARAMS, factor: 1 };
const CAPITAL = 3_000_000;
const HOLIDAYS: string[] = [];

function op(
  month: string,
  type: 'call' | 'put',
  k: number,
  side: 'buy' | 'sell',
  qty = 1,
): OptionLeg {
  const q = quoteOf(rows[month] ?? [], k, type);
  return {
    kind: 'option',
    product: 'op_large',
    type,
    expiry: month,
    strike: k,
    side,
    qty,
    entry: side === 'buy' ? q.ask : q.bid,
    mid: q.mid,
  };
}

const fut = (side: 'buy' | 'sell', qty = 1): Leg => ({
  kind: 'future',
  product: 'fut_mini',
  contract: FUT.id,
  side,
  qty,
  entry: FUT.price,
});

function calcOf(
  prepared: readonly PreparedLeg[],
  dynamics: IvDynamics,
  settings: ModelSettings = SETTINGS,
  market: MarketContext = ctx,
): ReplayCalc {
  return {
    legs: prepared,
    ctx: market,
    settings,
    params: PARAMS,
    dynamics,
    capital: CAPITAL,
    premium: premiumSummary(prepared, settings),
    holidays: HOLIDAYS,
    maxDays: Math.max(...prepared.map((p) => p.T0 * 365)),
  };
}

const flat = (v: number): AtmTerm => ({ t1: 20, v1: v, t2: 50, v2: v });

describe('termIv（足の残存の ATM IV）', () => {
  const term: AtmTerm = { t1: 10, v1: 30, t2: 40, v2: 20 };
  it('1 限月より手前は 1 限月、2 限月より先は 2 限月', () => {
    expect(termIv(term, 0)).toBe(30);
    expect(termIv(term, 5)).toBe(30);
    expect(termIv(term, 10)).toBe(30);
    expect(termIv(term, 40)).toBe(20);
    expect(termIv(term, 90)).toBe(20);
  });
  it('間は総分散 σ²t の線形補間の √', () => {
    const tau = 25;
    const w = (tau - 10) / 30;
    const want = Math.sqrt((30 * 30 * 10 + w * (20 * 20 * 40 - 30 * 30 * 10)) / tau);
    expect(Math.abs(termIv(term, tau) - want)).toBeLessThan(1e-12);
    // 端でつながる
    expect(Math.abs(termIv(term, 10 + 1e-9) - 30)).toBeLessThan(1e-6);
    expect(Math.abs(termIv(term, 40 - 1e-9) - 20)).toBeLessThan(1e-6);
  });
  it('2 限月が無ければ 1 限月', () => {
    expect(termIv({ t1: 10, v1: 30, t2: null, v2: null }, 60)).toBe(30);
  });
  it('SQ まで 3 日未満の 1 限月は使わない（2 限月だけ。2 限月も無ければ NaN）', () => {
    expect(termIv({ t1: 2.5, v1: 80, t2: 30, v2: 22 }, 1)).toBe(22);
    expect(termIv({ t1: 2.5, v1: 80, t2: 30, v2: 22 }, 60)).toBe(22);
    expect(termIv({ t1: 2.5, v1: 80, t2: null, v2: null }, 10)).toBeNaN();
  });
  it('使えない値は NaN', () => {
    expect(termIv({ t1: 10, v1: 0, t2: null, v2: null }, 10)).toBeNaN();
    expect(termIv({ t1: 10, v1: Number.NaN, t2: 30, v2: 20 }, 10)).toBeNaN();
  });
});

describe('replayIvRatio', () => {
  it('平らな期間構造（1・2 限月の IV が同じ = iv30）なら iv30 の比と一致', () => {
    for (const tau of [0, 5, 20, 33, 50, 120]) {
      const r = replayIvRatio(flat(18), flat(27), 18, 27, tau);
      expect(Math.abs(r - 27 / 18)).toBeLessThan(1e-12);
    }
  });
  it('分子と分母で同じ残存の値の比', () => {
    const t0: AtmTerm = { t1: 12, v1: 18, t2: 40, v2: 19 };
    const tk: AtmTerm = { t1: 8, v1: 40, t2: 36, v2: 30 };
    for (const tau of [3, 10, 20, 38]) {
      expect(replayIvRatio(t0, tk, 18, 33, tau)).toBeCloseTo(termIv(tk, tau) / termIv(t0, tau), 12);
    }
    // 近い限月の上がりが大きい = 残存が短い足ほど倍率が大きい
    expect(replayIvRatio(t0, tk, 18, 33, 8)).toBeGreaterThan(replayIvRatio(t0, tk, 18, 33, 38));
  });
  it('期間構造が無い日・値が使えない日は iv30 の比に戻す', () => {
    expect(replayIvRatio(null, flat(30), 20, 30, 10)).toBe(1.5);
    expect(replayIvRatio(flat(20), null, 20, 30, 10)).toBe(1.5);
    expect(replayIvRatio({ t1: 2, v1: 50, t2: null, v2: null }, flat(30), 20, 25, 10)).toBe(1.25);
    expect(replayIvRatio(null, null, 0, 25, 10)).toBeNaN();
  });
});

describe('replayDay（k 日目の余力・損益）', () => {
  const LEGS: Array<[string, Leg[]]> = [
    ['put の売り', [op(M1.id, 'put', 62000, 'sell', 2)]],
    [
      'ストラングルの売り（2 限月）',
      [op(M1.id, 'put', 63000, 'sell'), op(M2.id, 'call', 72000, 'sell')],
    ],
    ['先物 + put の売り', [fut('buy', 3), op(M1.id, 'put', 64000, 'sell')]],
  ];

  it('全足同じ倍率（平らな期間構造）なら、同じ (u, c, d)・Δs = 0 の追証マップのマスと 1e−6 円', () => {
    for (const [name, legs] of LEGS) {
      const prepared = preparePosition(legs, ctx, SETTINGS);
      for (const dynamics of ['sticky_strike', 'sticky_moneyness'] as IvDynamics[]) {
        const calc = calcOf(prepared, dynamics);
        for (const [k, u, iv] of [
          [0, 0, 20],
          [3, -0.06, 26],
          [8, -0.15, 34],
          [15, -0.22, 40],
          [12, 0.04, 16],
        ] as const) {
          const day0 = { term: flat(20), iv: 20 };
          const got = replayDay(calc, { k, u, term: flat(iv), iv }, day0);
          expect(got.ended).toBe(false);
          const days = k > 0 ? businessDaysAhead(ctx.evalTime, k, HOLIDAYS) : 0;
          expect(got.days).toBe(days);
          const c = iv / 20;
          expect(Math.abs(got.c - c)).toBeLessThan(1e-12);
          const hm: HoldMapCalc = {
            legs: prepared,
            ctx,
            settings: SETTINGS,
            params: PARAMS,
            base: { ...ZERO_SCENARIO, days, ivDynamics: dynamics, beta: 0 },
            horizonDays: businessDaysAhead(ctx.evalTime + days * DAY_MS, 2, HOLIDAYS),
            capital: CAPITAL,
            premium: premiumSummary(prepared, SETTINGS),
          };
          const axes: HoldMapAxes = { us: [u], cs: [c] };
          const room = holdMapColumn(hm, axes, 0)[0] as number;
          const pnl = holdMapPnlColumn(hm, axes, 0)[0] as number;
          expect(Number.isFinite(room)).toBe(true);
          expect(Math.abs(got.room - room), `${name} k=${k}`).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(got.pnl - pnl), `${name} k=${k}`).toBeLessThanOrEqual(1e-6);
        }
      }
    }
  });

  it('始まりの日（k = 0・u = 0・同じ ATM）は倍率 1・今の損益', () => {
    const prepared = preparePosition(LEGS[1]?.[1] ?? [], ctx, SETTINGS);
    const t0: AtmTerm = { t1: 12, v1: 18, t2: 40, v2: 19 };
    const got = replayDay(
      calcOf(prepared, 'sticky_strike'),
      { k: 0, u: 0, term: t0, iv: 18 },
      {
        term: t0,
        iv: 18,
      },
    );
    expect(got.c).toBe(1);
    expect(got.days).toBe(0);
    const want = theoreticalPnl(prepared, ctx.x0, { ...ZERO_SCENARIO, beta: 0 }, ctx, SETTINGS);
    expect(Math.abs(got.pnl - want)).toBeLessThan(1e-6);
  });

  const flatSmile = (T: number, s: number): Smile => ({
    T,
    sigma: () => s,
    totalVariance: () => s * s * T,
    mark: () => 'interpolated',
  });
  const flatCtx: MarketContext = {
    ...ctx,
    options: {
      [M1.id]: {
        ...(ctx.options[M1.id] as MarketContext['options'][string]),
        smile: flatSmile(M1.days / 365, 0.2),
      },
      [M2.id]: {
        ...(ctx.options[M2.id] as MarketContext['options'][string]),
        smile: flatSmile(M2.days / 365, 0.2),
      },
    },
  };

  it('平らなスマイル: 足の IV = 今の IV × 足ごとの倍率（σ_min の外。足ごとに違う倍率でも各足が自分の倍率）', () => {
    const legs: Leg[] = [
      { ...op(M1.id, 'put', 62000, 'sell'), iv: 0.2 },
      { ...op(M2.id, 'put', 60000, 'sell'), iv: 0.2 },
    ];
    const prepared = preparePosition(legs, flatCtx, SETTINGS);
    const t0: AtmTerm = { t1: 10, v1: 20, t2: 40, v2: 20 };
    const tk: AtmTerm = { t1: 10, v1: 44, t2: 40, v2: 28 };
    const u = -0.12;
    const days = 6;
    const cOf = (p: PreparedLeg) => replayIvRatio(t0, tk, 20, 30, Math.max(0, p.T0 * 365 - days));
    const shifted = holdMapLegsBy(prepared, u, cOf, flatCtx, SETTINGS, 'sticky_strike');
    const x = flatCtx.x0 * (1 + u);
    const sc = holdMapScenario({ ...ZERO_SCENARIO, days }, u, flatCtx.x0);
    const cs = prepared.map(cOf);
    expect(cs[0]).not.toBeCloseTo(cs[1] as number, 3);
    shifted.forEach((p, i) => {
      const got = legSigma(p, x, sc, flatCtx, SETTINGS) as number;
      expect(Math.abs(got - 0.2 * (cs[i] as number))).toBeLessThan(1e-9);
    });
  });

  it('holdMapLegsBy(…, () => c, …) は holdMapLegs(…, c, …) と同じ足', () => {
    const prepared = preparePosition(LEGS[1]?.[1] ?? [], ctx, SETTINGS);
    for (const c of [0.6, 1, 1.7]) {
      const a = holdMapLegsBy(prepared, -0.08, () => c, ctx, SETTINGS, 'sticky_strike');
      const b = holdMapLegs(prepared, -0.08, c, ctx, SETTINGS, 'sticky_strike');
      a.forEach((p, i) => {
        const q = b[i] as PreparedLeg;
        if (!p.option || !q.option) {
          expect(p).toBe(q);
          return;
        }
        for (const xx of [-0.2, 0, 0.1]) {
          expect(p.option.sigmaBase(xx)).toBeCloseTo(q.option.sigmaBase(xx), 12);
        }
      });
    }
  });

  it('途中で SQ を過ぎた足は本源的価値（満期損益）、最も遠い SQ の後は ended', () => {
    const settings: ModelSettings = { ...SETTINGS, feePerLot: 0 };
    const m1 = op(M1.id, 'put', 64000, 'sell');
    const m2 = op(M2.id, 'put', 62000, 'sell');
    const both = preparePosition([m1, m2], ctx, settings);
    const only2 = preparePosition([m2], ctx, settings);
    const only1 = preparePosition([m1], ctx, settings);
    const maxDays = M2.days;
    const calcBoth = { ...calcOf(both, 'sticky_strike', settings), maxDays };
    const calc2 = { ...calcOf(only2, 'sticky_strike', settings), maxDays };
    const day0 = { term: flat(20), iv: 20 };
    let sawPast = false;
    for (const k of [22, 23, 25, 30, 38, 41]) {
      const u = -0.1;
      const day = { k, u, term: flat(40), iv: 40 };
      const a = replayDay(calcBoth, day, day0);
      const b = replayDay(calc2, day, day0);
      if (a.days > maxDays + 1e-9) {
        expect(a.ended).toBe(true);
        expect(a.room).toBeNaN();
        continue;
      }
      if (a.days <= M1.days) continue;
      sawPast = true;
      expect(Number.isFinite(a.pnl) && Number.isFinite(a.room)).toBe(true);
      const intrinsic = expiryPnl(only1, ctx.x0 * (1 + u), ctx, settings);
      expect(Math.abs(a.pnl - b.pnl - intrinsic)).toBeLessThan(1e-6);
    }
    expect(sawPast).toBe(true);
    // 最も遠い SQ の後の日は ended
    expect(replayDay(calcBoth, { k: 60, u: -0.1, term: flat(40), iv: 40 }, day0).ended).toBe(true);
  });

  it('原資産 −99% 付近・円モードで F′ ≤ 0・倍率 ×5 超でも有限か NaN、IV ≥ σ_min', () => {
    const low: MarketContext = {
      ...ctx,
      options: {
        ...ctx.options,
        [M2.id]: { ...(ctx.options[M2.id] as MarketContext['options'][string]), forward: 58_000 },
      },
    };
    const legs: Leg[] = [
      { ...op(M1.id, 'put', 62000, 'sell'), iv: 0.25 },
      { ...op(M2.id, 'put', 60000, 'sell'), iv: 0.3 },
      { ...op(M2.id, 'call', 64000, 'buy'), iv: 0.18 },
      fut('sell', 1),
    ];
    for (const basisMode of ['yen', 'pct'] as const) {
      const settings: ModelSettings = { ...SETTINGS, basisMode };
      const prepared = preparePosition(legs, low, settings);
      for (const dynamics of ['sticky_strike', 'sticky_moneyness'] as IvDynamics[]) {
        const calc = calcOf(prepared, dynamics, settings, low);
        for (const u of [-0.99, -0.9, -0.5]) {
          for (const iv of [110, 160]) {
            const day0 = { term: flat(20), iv: 20 };
            const day = { k: 5, u, term: flat(iv), iv };
            const r = replayDay(calc, day, day0);
            expect(r.c).toBeGreaterThan(5);
            for (const v of [r.room, r.pnl])
              expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
            const cOf = (p: PreparedLeg) =>
              replayIvRatio(day0.term, day.term, 20, iv, Math.max(0, p.T0 * 365 - r.days));
            const sc = holdMapScenario(
              { ...ZERO_SCENARIO, days: r.days, ivDynamics: dynamics },
              u,
              low.x0,
            );
            for (const p of holdMapLegsBy(prepared, u, cOf, low, settings, dynamics)) {
              const sg = legSigma(p, low.x0 * (1 + u), sc, low, settings);
              if (sg !== null) expect(sg).toBeGreaterThanOrEqual(settings.sigmaMin);
            }
          }
        }
      }
    }
  });
});

describe('replaySummary', () => {
  const rows = [
    { room: 500, pnl: 0 },
    { room: 120, pnl: -300 },
    { room: -50, pnl: -800 },
    { room: Number.NaN, pnl: Number.NaN },
    { room: -400, pnl: -700 },
    { room: 30, pnl: -900 },
    { room: 200, pnl: -100 },
  ];
  it('最初の追証・最も足りない額・最悪の損益・許容損失超え・終わり', () => {
    const s = replaySummary(rows, 600);
    expect(s.firstCall).toBe(2);
    expect(s.minRoom).toEqual({ value: -400, index: 4 });
    expect(s.worstPnl).toEqual({ value: -900, index: 5 });
    expect(s.firstLoss).toBe(2);
    expect(s.endPnl).toBe(-100);
  });
  it('全日余力ありなら追証なし、許容損失が無ければ超えた日もなし', () => {
    const ok = rows.map((r) => ({ ...r, room: Number.isNaN(r.room) ? r.room : Math.abs(r.room) }));
    const s = replaySummary(ok, null);
    expect(s.firstCall).toBeNull();
    expect(s.firstLoss).toBeNull();
    expect(s.minRoom).toEqual({ value: 30, index: 5 });
  });
  it('行が無ければ全部なし・終わりは NaN', () => {
    const s = replaySummary([], 100);
    expect(s).toEqual({
      firstCall: null,
      minRoom: null,
      worstPnl: null,
      firstLoss: null,
      endPnl: Number.NaN,
    });
  });
});

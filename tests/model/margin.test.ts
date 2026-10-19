/**
 * 証拠金の概算（格子の最悪値・掛け目）。設計 docs/design.md 5.10、Issue #131 の AC1〜AC13・#149・#150。
 * 板は合成（tests/support/market.ts。架空の値）。JSCC の額は再現しない（参照値は手計算）。
 * #131 の AC は「買いの OP で減らさない」をオフ（全足で相殺する JSCC の形）にして固定する。
 * 掛け目に依る性質（所要額の大小など）は掛け目 100% を明示して固定する（既定が後で変わっても意味を保つ）。
 */

import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import {
  DEFAULT_MARGIN_PARAMS,
  MARGIN_PRICE_STEPS,
  type MarginParams,
  type MarginState,
  marginAt,
  marginCallLevels,
  marginRoom,
  maxMultiple,
} from '../../model/margin';
import {
  DEFAULT_SETTINGS,
  type Leg,
  legSigma,
  legValue,
  legValueAtSigma,
  type MarketContext,
  type ModelSettings,
  type PreparedLeg,
  premiumSummary,
  preparePosition,
} from '../../model/position';
import { type Scenario, sigmaAt, ZERO_SCENARIO } from '../../model/scenario';
import { businessDaysAhead } from '../../model/time';
import { FUT, M1, M2, makeMarket, quoteOf } from '../support/market';
import { rng } from '../support/synthChain';

const { ctx, rows } = makeMarket();
const rows1 = rows[M1.id] as NonNullable<(typeof rows)[string]>;
const rows2 = rows[M2.id] as NonNullable<(typeof rows)[string]>;

/** 手数料 > 0（架空の 1 枚 50 円）。AC1 で手数料を含めて照合する */
const SETTINGS: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: 50 };
/** #131 の AC の前提: JSCC の形 = 買いの OP でも相殺する（#149 の設定をオフ）。掛け目は 100% を明示 */
const P: MarginParams = { ...DEFAULT_MARGIN_PARAMS, factor: 1, ignoreLongOptions: false };
/** #149 の既定: 買いの OP で減らさない（掛け目 100% を明示） */
const ON: MarginParams = { ...DEFAULT_MARGIN_PARAMS, factor: 1, ignoreLongOptions: true };
/** 板の時刻（架空の 2026-10-13 火曜の夜）から 2 営業日後 = 木曜 */
const H = businessDaysAhead(ctx.evalTime, 2, []);

function op(
  month: typeof M1 | typeof M2,
  type: 'call' | 'put',
  k: number,
  side: 'buy' | 'sell',
  qty = 1,
): Leg {
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

function fut(
  side: 'buy' | 'sell',
  qty = 1,
  product: 'fut_large' | 'fut_mini' | 'fut_micro' = 'fut_large',
): Leg {
  return { kind: 'future', product, contract: FUT.id, side, qty, entry: FUT.price };
}

const prep = (legs: readonly Leg[], s: ModelSettings = SETTINGS) => preparePosition(legs, ctx, s);
const NOW: MarginState = { x: ctx.x0, scenario: ZERO_SCENARIO, horizonDays: H };

function m(
  legs: readonly Leg[],
  opts: { state?: MarginState; params?: MarginParams; settings?: ModelSettings } = {},
) {
  const s = opts.settings ?? SETTINGS;
  return marginAt(prep(legs, s), opts.state ?? NOW, ctx, s, opts.params ?? P);
}

function room(
  legs: readonly Leg[],
  capital: number,
  state: MarginState = NOW,
  settings: ModelSettings = SETTINGS,
  params: MarginParams = P,
) {
  const p = prep(legs, settings);
  return marginRoom(
    capital,
    premiumSummary(p, settings),
    marginAt(p, state, ctx, settings, params),
  );
}

const scale = (legs: readonly Leg[], n: number): Leg[] =>
  legs.map((l) => ({ ...l, qty: l.qty * n }));

const ATM = 67750;

describe('既定値と格子', () => {
  it('既定: R 5%・IV ×1.5 / ×0.75・掛け目 100%、原資産は 5 点（#150）', () => {
    expect(DEFAULT_MARGIN_PARAMS).toEqual({
      range: 0.05,
      ivUp: 0.5,
      ivDown: 0.25,
      factor: 1,
      ignoreLongOptions: true,
    });
    expect([...MARGIN_PRICE_STEPS]).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(H).toBe(2);
  });
});

describe('AC1 買いだけ', () => {
  const cases: Array<[string, Leg[]]> = [
    ['call 買い 1 本', [op(M1, 'call', 68500, 'buy')]],
    ['put 買い 1 本', [op(M1, 'put', 66000, 'buy', 2)]],
    [
      '限月混在の買い 3 本',
      [op(M1, 'call', 69000, 'buy'), op(M2, 'put', 66000, 'buy'), op(M2, 'call', ATM, 'buy', 3)],
    ],
  ];
  for (const [name, legs] of cases) {
    it(`${name}: 所要額 0（掛け目 100%）、必要証拠金 = k × PFE、余力 = 資金 − 支払 − 手数料（1 円以内）`, () => {
      const r = m(legs);
      expect(r.requirement).toBe(0);
      expect(r.margin).toBeCloseTo(P.factor * r.pfe, 6);
      expect(r.pfe).toBeGreaterThanOrEqual(0);
      expect(r.pfe).toBeLessThanOrEqual(r.nov);
      const prem = premiumSummary(prep(legs), SETTINGS);
      expect(prem.fees).toBeGreaterThan(0);
      const capital = 10_000_000;
      expect(Math.abs(room(legs, capital) - (capital - prem.paid - prem.fees))).toBeLessThanOrEqual(
        1,
      );
    });
  }
});

describe('AC2 売りだけ', () => {
  it('put 売り 1 枚: 必要証拠金 = k × PFE、所要額 = k × PFE − NOV ≥ 売りの評価額、PFE > 0', () => {
    const legs = [op(M1, 'put', 66000, 'sell')];
    const r = m(legs);
    const p = prep(legs)[0] as PreparedLeg;
    const value = legValue(p, ctx.x0, ZERO_SCENARIO, ctx, SETTINGS) * 1000;
    expect(r.pfe).toBeGreaterThan(0);
    expect(r.nov).toBeCloseTo(-value, 6);
    expect(r.margin).toBeCloseTo(P.factor * r.pfe, 6);
    expect(r.requirement).toBeCloseTo(P.factor * r.pfe - r.nov, 6);
    expect(r.requirement).toBeGreaterThanOrEqual(Math.abs(r.nov));
    expect(r.worst).not.toBeNull();
    // put 売りの最悪点は下落・IV 上げ
    expect(r.worst?.priceStep).toBe(-1);
    expect(r.worst?.ivScale).toBe(1 + P.ivUp);
  });
});

describe('AC3 大小関係', () => {
  it('同じ限月の ATM: 所要額は ストラドル売り > put 売り > put 買い（= 0）', () => {
    const straddle = m([op(M1, 'call', ATM, 'sell'), op(M1, 'put', ATM, 'sell')]).requirement;
    const putSell = m([op(M1, 'put', ATM, 'sell')]).requirement;
    const putBuy = m([op(M1, 'put', ATM, 'buy')]).requirement;
    expect(straddle).toBeGreaterThan(putSell);
    expect(putSell).toBeGreaterThan(putBuy);
    expect(putBuy).toBe(0);
  });
});

describe('AC4 比例', () => {
  const legs = [
    op(M1, 'put', 66000, 'sell', 2),
    op(M1, 'call', 69500, 'sell'),
    op(M2, 'put', 64000, 'buy'),
    fut('buy'),
  ];
  const base = m(legs);
  it.each([2, 5])('全足の枚数 × %i で必要証拠金・所要額も同じ倍率（相対 1e-9）', (n) => {
    const r = m(scale(legs, n));
    expect(base.margin).toBeGreaterThan(0);
    expect(base.requirement).toBeGreaterThan(0);
    expect(Math.abs(r.margin / (n * base.margin) - 1)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(r.requirement / (n * base.requirement) - 1)).toBeLessThanOrEqual(1e-9);
  });
  it('掛け目 × 2 で必要証拠金は 2 倍、NOV は変わらず、所要額 = 2k × PFE − NOV', () => {
    const r = m(legs, { params: { ...P, factor: P.factor * 2 } });
    expect(Math.abs(r.margin / (2 * base.margin) - 1)).toBeLessThanOrEqual(1e-9);
    expect(r.nov).toBe(base.nov);
    expect(Math.abs(r.requirement - (2 * P.factor * base.pfe - base.nov))).toBeLessThanOrEqual(
      1e-6,
    );
  });
});

describe('AC5 相殺', () => {
  it('同じ銘柄の売り買い同数で所要額 0。建値（アンカー IV）が同じなら必要証拠金も 0', () => {
    // 板の建値（売り = bid、買い = ask）: アンカー IV が足ごとに違うので IV の倍率で差が出て PFE > 0
    // になりうる（#150。必要証拠金 = k × PFE は NOV を含まない）。その PFE は NOV（買いの評価額の差）以下
    const bidAsk = m([op(M1, 'put', 66000, 'sell', 2), op(M1, 'put', 66000, 'buy', 2)]);
    expect(bidAsk.requirement).toBe(0);
    expect(bidAsk.margin).toBeCloseTo(P.factor * bidAsk.pfe, 6);
    expect(bidAsk.pfe).toBeLessThanOrEqual(bidAsk.nov);
    const same = op(M1, 'put', 66000, 'sell', 2);
    for (const legs of [
      [same, { ...same, side: 'buy' as const }],
      [fut('buy', 3), fut('sell', 3)],
    ]) {
      const r = m(legs);
      expect(r.margin).toBe(0);
      expect(r.requirement).toBe(0);
    }
  });

  it('バーティカル（put 売り K1 + put 買い K2 < K1）の所要額 ≤ max(k, 1) × 幅 × 1,000 かつ ≤ put 売り単体（k = 100%）', () => {
    for (const [k1, k2] of [
      [ATM, 67250],
      [66000, 64000],
      [68500, 66500],
    ] as const) {
      const vertical = m([op(M1, 'put', k1, 'sell'), op(M1, 'put', k2, 'buy')]).requirement;
      const single = m([op(M1, 'put', k1, 'sell')]).requirement;
      expect(vertical).toBeGreaterThan(0);
      expect(vertical).toBeLessThanOrEqual(Math.max(P.factor, 1) * (k1 - k2) * 1000);
      expect(vertical).toBeLessThanOrEqual(single);
    }
  });
});

describe('AC6 劣加法', () => {
  const cases: Array<[string, Leg[], Leg[]]> = [
    ['put 売り + 先物買い', [op(M1, 'put', 65000, 'sell')], [fut('buy')]],
    [
      'レシオ（put 売り 2 + put 買い 1）',
      [op(M1, 'put', ATM, 'sell', 2)],
      [op(M1, 'put', 66000, 'buy')],
    ],
    ['限月混在の売り', [op(M1, 'call', 70000, 'sell')], [op(M2, 'put', 65000, 'sell')]],
    ['ストラドル売り', [op(M1, 'call', ATM, 'sell')], [op(M1, 'put', ATM, 'sell')]],
    ['ダイアゴナル', [op(M1, 'put', 66000, 'sell')], [op(M2, 'put', 64000, 'buy')]],
    ['ミニ先物売り + call 買い', [fut('sell', 3, 'fut_mini')], [op(M2, 'call', 69000, 'buy')]],
    [
      'call のレシオ + 先物',
      [op(M1, 'call', 69000, 'sell', 3)],
      [op(M1, 'call', 70000, 'buy', 2), fut('buy')],
    ],
    [
      'アイアンコンドル（限月違い）',
      [op(M2, 'put', 66000, 'sell'), op(M2, 'call', 69500, 'sell')],
      [op(M1, 'put', 63000, 'buy', 2), op(M1, 'call', 72000, 'buy', 2)],
    ],
    ['先物の買いと売り', [fut('buy')], [fut('sell')]],
    [
      '限月混在の put 売り + マイクロ先物・call 売り',
      [op(M1, 'put', 67000, 'sell'), op(M2, 'put', 67000, 'sell')],
      [fut('buy', 5, 'fut_micro'), op(M2, 'call', 71000, 'sell')],
    ],
  ];
  it('10 通り: M(全体) ≤ M(部分 1) + M(部分 2)（必要証拠金・所要額とも）', () => {
    expect(cases).toHaveLength(10);
    for (const [name, a, b] of cases) {
      const whole = m([...a, ...b]);
      const ra = m(a);
      const rb = m(b);
      expect(whole.margin, name).toBeLessThanOrEqual(ra.margin + rb.margin + 1e-6);
      expect(whole.requirement, name).toBeLessThanOrEqual(ra.requirement + rb.requirement + 1e-6);
    }
  });
});

describe('AC7 先物', () => {
  const pct: ModelSettings = { ...SETTINGS, basisMode: 'pct' };
  it('ラージ 1 枚（basis 固定・円モード）= k × R × X_S × 1,000（1 円）', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const x of [ctx.x0, ctx.x0 - 3000, ctx.x0 + 1234]) {
        const state = { ...NOW, x, scenario: { ...ZERO_SCENARIO, dX: x - ctx.x0 } };
        const r = m([fut(side)], { state });
        expect(Math.abs(r.margin - P.factor * P.range * x * 1000)).toBeLessThanOrEqual(1);
        expect(Math.abs(r.requirement - P.factor * P.range * x * 1000)).toBeLessThanOrEqual(1);
        expect(r.nov).toBe(0);
      }
    }
    // 手計算の参照値（架空の X = 40,000）: 1 × 0.05 × 40,000 × 1,000 = 2,000,000 円
    const state = { ...NOW, x: 40000, scenario: { ...ZERO_SCENARIO, dX: 40000 - ctx.x0 } };
    expect(Math.abs(m([fut('buy')], { state }).margin - 2_000_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(m([fut('buy')], { state }).requirement - 2_000_000)).toBeLessThanOrEqual(1);
  });

  it('% モード = k × R × F × 1,000（1 円）', () => {
    for (const side of ['buy', 'sell'] as const) {
      const r = m([fut(side)], { settings: pct });
      expect(Math.abs(r.margin - P.factor * P.range * FUT.price * 1000)).toBeLessThanOrEqual(1);
    }
  });

  it('ミニ・マイクロは乗数の比（1/10・1/100）', () => {
    const large = m([fut('buy')]).margin;
    expect(m([fut('buy', 1, 'fut_mini')]).margin).toBeCloseTo(large / 10, 6);
    expect(m([fut('sell', 1, 'fut_micro')]).margin).toBeCloseTo(large / 100, 6);
  });
});

describe('AC8 単調（売り一方向の 3 形）', () => {
  const shapes: Array<[string, Leg[]]> = [
    ['put 売り', [op(M1, 'put', 66000, 'sell')]],
    ['ストラングル売り', [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 69500, 'sell')]],
    ['ストラドル売り', [op(M1, 'put', ATM, 'sell'), op(M1, 'call', ATM, 'sell')]],
  ];
  const ranges = [0.04, 0.06, 0.08, 0.1, 0.12];
  const ivUps = [0, 0.25, 0.5, 1, 2];
  for (const [name, legs] of shapes) {
    it(`${name}: R・IV の上げ（倍率）を 5 段で上げて必要証拠金・所要額が減らない`, () => {
      const byR = ranges.map((range) => m(legs, { params: { ...P, range } }));
      const byIv = ivUps.map((ivUp) => m(legs, { params: { ...P, ivUp } }));
      for (const seq of [
        byR.map((r) => r.margin),
        byR.map((r) => r.requirement),
        byIv.map((r) => r.margin),
        byIv.map((r) => r.requirement),
      ]) {
        for (let i = 1; i < seq.length; i++) {
          expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] as number);
        }
      }
    });
  }
});

describe('AC9 シナリオの点', () => {
  it('put 売りで ΔX = −10%・Δσ = +20pt の点: 必要証拠金 > 今、余力 < 今', () => {
    const legs = [op(M1, 'put', 66000, 'sell')];
    const dX = -0.1 * ctx.x0;
    const point: MarginState = {
      x: ctx.x0 + dX,
      scenario: { ...ZERO_SCENARIO, dX, dSigma: 20 },
      horizonDays: H,
    };
    const capital = 30_000_000;
    expect(m(legs, { state: point }).margin).toBeGreaterThan(m(legs).margin);
    expect(room(legs, capital, point)).toBeLessThan(room(legs, capital));
  });
});

describe('AC10 T → 0 と決済済み', () => {
  const sellM1 = op(M1, 'put', ATM, 'sell');
  const sellM2 = op(M2, 'put', 66000, 'sell', 2);

  it('1 限月の SQ の先: その限月の足は格子・NOV に入らず、清算額だけが余力に入る', () => {
    const x = ctx.x0 * 0.95;
    const state: MarginState = {
      x,
      scenario: { ...ZERO_SCENARIO, days: 40, dX: x - ctx.x0 },
      horizonDays: H,
    };
    const both = m([sellM1, sellM2], { state });
    const only2 = m([sellM2], { state });
    expect(both.pfe).toBe(only2.pfe);
    expect(both.nov).toBe(only2.nov);
    expect(both.margin).toBe(only2.margin);
    expect(both.requirement).toBe(only2.requirement);
    // put 売りの清算: −1 × 1,000 × (K − F')（円モード F' = X' + basis）
    const intrinsic = ATM - (x + (M1.F - ctx.x0));
    expect(intrinsic).toBeGreaterThan(0);
    expect(both.settledCash).toBeCloseTo(-1000 * intrinsic, 6);
    expect(only2.settledCash).toBe(0);
    // 余力: 決済済みの足の受取は建値で既に入っている
    const capital = 50_000_000;
    const legs = [sellM1, sellM2];
    const prem = premiumSummary(prep(legs), SETTINGS);
    expect(room(legs, capital, state)).toBeCloseTo(
      capital - prem.paid + prem.received - prem.fees + both.settledCash - both.requirement,
      6,
    );
  });

  it("先物の SQ の先: 先物は清算額（F = X'）だけ、評価損益に入らない", () => {
    const x = ctx.x0 + 500;
    const state: MarginState = {
      x,
      scenario: { ...ZERO_SCENARIO, days: 60, dX: 500 },
      horizonDays: H,
    };
    const r = m([fut('buy', 2)], { state });
    expect(r.margin).toBe(0);
    expect(r.requirement).toBe(0);
    expect(r.pfe).toBe(0);
    expect(r.futuresPnl).toBe(0);
    expect(r.settledCash).toBeCloseTo(2 * 1000 * (x - FUT.price), 6);
    expect(r.worst).toBeNull();
    const live = m([fut('buy', 2)]);
    expect(live.futuresPnl).toBeCloseTo(2 * 1000 * (ctx.x0 + (FUT.price - ctx.x0) - FUT.price), 6);
  });

  it('SQ の直前（T ≤ tMin）・T = 0 ちょうど・SQ の直後で NaN・∞ が無い', () => {
    const legs = [sellM1, sellM2, fut('sell'), op(M1, 'call', 69000, 'buy')];
    const p = prep(legs);
    const t0 = (p[0] as PreparedLeg).T0 * 365;
    for (const days of [t0 - 3, t0 - 1, t0 - 1e-4, t0 - 30 / 86400, t0, t0 + 1e-9, 30.5, 31]) {
      for (const x of [ctx.x0, ctx.x0 * 0.8]) {
        const r = marginAt(
          p,
          { x, scenario: { ...ZERO_SCENARIO, days, dX: x - ctx.x0 }, horizonDays: H },
          ctx,
          SETTINGS,
          P,
        );
        for (const v of [r.pfe, r.nov, r.margin, r.requirement, r.futuresPnl, r.settledCash]) {
          expect(Number.isFinite(v), `days=${days} x=${x}`).toBe(true);
        }
        expect(r.margin).toBeGreaterThanOrEqual(0);
        expect(r.requirement).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('生きている足が無ければ 0', () => {
    const r = marginAt([], NOW, ctx, SETTINGS, P);
    expect(r).toMatchObject({
      pfe: 0,
      nov: 0,
      margin: 0,
      requirement: 0,
      futuresPnl: 0,
      settledCash: 0,
    });
    expect(r.worst).toBeNull();
  });
});

describe('AC11 建てられる倍数', () => {
  const legs = [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 70000, 'sell')];
  it('m 倍で余力 ≥ 0、m + 1 倍で < 0（枚数を掛けて作り直して確かめる）', () => {
    const p = prep(legs);
    const prem = premiumSummary(p, SETTINGS);
    const r = marginAt(p, NOW, ctx, SETTINGS, P);
    for (const capital of [3_000_000, 10_000_000, 47_000_000]) {
      const mult = maxMultiple(capital, prem, r);
      expect(mult).not.toBeNull();
      expect(Number.isFinite(mult)).toBe(true);
      const n = mult as number;
      if (n > 0) expect(room(scale(legs, n), capital)).toBeGreaterThanOrEqual(0);
      expect(room(scale(legs, n + 1), capital)).toBeLessThan(0);
    }
    expect(maxMultiple(47_000_000, prem, r)).toBeGreaterThanOrEqual(1);
  });

  it('資金が 0 / 未設定（NaN）なら出さない（null）、足が無ければ上限なし', () => {
    const p = prep(legs);
    const prem = premiumSummary(p, SETTINGS);
    const r = marginAt(p, NOW, ctx, SETTINGS, P);
    expect(maxMultiple(0, prem, r)).toBeNull();
    expect(maxMultiple(Number.NaN, prem, r)).toBeNull();
    const empty = marginAt([], NOW, ctx, SETTINGS, P);
    expect(maxMultiple(1_000_000, premiumSummary([], SETTINGS), empty)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('AC12 追証の線', () => {
  const legs = [op(M1, 'put', ATM, 'sell')];
  const p = prep(legs);
  const prem = premiumSummary(p, SETTINGS);
  const sc: Scenario = { ...ZERO_SCENARIO, days: 3 };
  const range = { lo: ctx.x0 * 0.5, hi: ctx.x0 * 1.5 };
  const roomAt = (capital: number, x: number) =>
    marginRoom(
      capital,
      prem,
      marginAt(p, { x, scenario: { ...sc, dX: x - ctx.x0 }, horizonDays: H }, ctx, SETTINGS, P),
    );

  it('put 売り: X* < X₀、A(X* − 1) と A(X* + 1) の符号が違う。資金を減らすと X* が上がる', () => {
    const levels: number[] = [];
    for (const capital of [20_000_000, 16_000_000, 12_000_000]) {
      const xs = marginCallLevels(p, sc, ctx, SETTINGS, P, H, capital, prem, range);
      expect(xs, `capital=${capital}`).toHaveLength(1);
      const x = xs[0] as number;
      expect(Number.isInteger(x)).toBe(true);
      expect(x).toBeLessThan(ctx.x0);
      expect(Math.sign(roomAt(capital, x - 1))).not.toBe(Math.sign(roomAt(capital, x + 1)));
      levels.push(x);
    }
    expect(levels[1]).toBeGreaterThan(levels[0] as number);
    expect(levels[2]).toBeGreaterThan(levels[1] as number);
  });

  it('余力がどこでも正なら []、資金が 0 / NaN でも []', () => {
    const buy = prep([op(M1, 'call', 68500, 'buy')]);
    const buyPrem = premiumSummary(buy, SETTINGS);
    expect(marginCallLevels(buy, sc, ctx, SETTINGS, P, H, 1e9, buyPrem, range)).toEqual([]);
    expect(marginCallLevels(p, sc, ctx, SETTINGS, P, H, 0, prem, range)).toEqual([]);
    expect(marginCallLevels(p, sc, ctx, SETTINGS, P, H, Number.NaN, prem, range)).toEqual([]);
  });
});

describe('#149 買いの OP で減らさない', () => {
  const capital = 50_000_000;
  /** M の比較に使うフィールド（必要証拠金・所要額・PFE・NOV は 1e-6 円、最悪の点は同じ） */
  const expectSameMargin = (a: ReturnType<typeof m>, b: ReturnType<typeof m>, name = '') => {
    expect(Math.abs(a.margin - b.margin), name).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(a.requirement - b.requirement), name).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(a.pfe - b.pfe), name).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(a.nov - b.nov), name).toBeLessThanOrEqual(1e-6);
    expect(a.worst, name).toEqual(b.worst);
  };

  it('#149 既定は買いの OP で減らさない', () => {
    expect(DEFAULT_MARGIN_PARAMS.ignoreLongOptions).toBe(true);
  });

  it('#149 オン: 買いだけは必要証拠金 0、余力 = 資金 − 支払 − 手数料', () => {
    const cases: Array<[string, Leg[]]> = [
      ['call 買い', [op(M1, 'call', 68500, 'buy')]],
      ['put 買い', [op(M1, 'put', 66000, 'buy', 2)]],
      [
        '限月混在の買い',
        [op(M1, 'call', 69000, 'buy'), op(M2, 'put', 66000, 'buy'), op(M2, 'call', ATM, 'buy', 3)],
      ],
    ];
    for (const [name, legs] of cases) {
      const r = m(legs, { params: ON });
      expect(r, name).toMatchObject({
        pfe: 0,
        nov: 0,
        margin: 0,
        requirement: 0,
        futuresPnl: 0,
        settledCash: 0,
      });
      expect(r.worst, name).toBeNull();
      const prem = premiumSummary(prep(legs), SETTINGS);
      expect(prem.fees).toBeGreaterThan(0);
      const a = room(legs, capital, NOW, SETTINGS, ON);
      expect(Math.abs(a - (capital - prem.paid - prem.fees)), name).toBeLessThanOrEqual(1);
    }
  });

  it('#149 オン: 売り 2 + 買い 1 のレシオは売り 2 枚だけと M・PFE・NOV・最悪の点が一致', () => {
    const sells = [op(M1, 'put', 65000, 'sell', 2)];
    const ratio = [...sells, op(M1, 'put', 65125, 'buy')];
    const on = m(ratio, { params: ON });
    const sellsOnly = m(sells, { params: P });
    expect(sellsOnly.margin).toBeGreaterThan(0);
    expectSameMargin(on, sellsOnly);
    // オフ（相殺あり）は小さい
    expect(m(ratio, { params: P }).margin).toBeLessThan(on.margin);
    expect(m(ratio, { params: P }).requirement).toBeLessThan(on.requirement);
    // 余力: 買いの支払は引かれる
    const prem = premiumSummary(prep(ratio), SETTINGS);
    expect(prem.paid).toBeGreaterThan(0);
    const a = room(ratio, capital, NOW, SETTINGS, ON);
    expect(
      Math.abs(a - (capital - prem.paid + prem.received - prem.fees - sellsOnly.requirement)),
    ).toBeLessThanOrEqual(1);
  });

  it('#149 オン: バーティカルは put 売り単体と一致し、所要額はオフ以上（k = 100%）', () => {
    for (const [k1, k2] of [
      [ATM, 67250],
      [66000, 64000],
      [68500, 66500],
    ] as const) {
      const vertical = [op(M1, 'put', k1, 'sell'), op(M1, 'put', k2, 'buy')];
      const on = m(vertical, { params: ON });
      expectSameMargin(on, m([op(M1, 'put', k1, 'sell')], { params: P }), `${k1}/${k2}`);
      expect(on.requirement).toBeGreaterThanOrEqual(m(vertical, { params: P }).requirement);
    }
  });

  it('#149 オン: 先物 + 買いの put は先物だけと一致（k × R × X_S × 1,000）', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const x of [ctx.x0, ctx.x0 - 3000]) {
        const state = { ...NOW, x, scenario: { ...ZERO_SCENARIO, dX: x - ctx.x0 } };
        const legs = [fut(side), op(M1, 'put', 66000, 'buy', 2)];
        const on = m(legs, { state, params: ON });
        const only = m([fut(side)], { state, params: P });
        expectSameMargin(on, only, `${side} ${x}`);
        expect(Math.abs(on.futuresPnl - only.futuresPnl)).toBeLessThanOrEqual(1);
        expect(Math.abs(on.margin - ON.factor * ON.range * x * 1000)).toBeLessThanOrEqual(1);
        expect(Math.abs(on.requirement - ON.factor * ON.range * x * 1000)).toBeLessThanOrEqual(1);
        expect(on.nov).toBe(0);
      }
    }
  });

  it('#149 オン: 限月混在（期近の売り + 期先の買い）は売りだけと一致', () => {
    const sells = [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 69500, 'sell')];
    const legs = [...sells, op(M2, 'put', 64000, 'buy'), op(M2, 'call', 71000, 'buy', 2)];
    expectSameMargin(m(legs, { params: ON }), m(sells, { params: P }));
  });

  it('#149 決済済みの足の清算額はオン / オフで同じ', () => {
    // M1 の SQ の先（days 40）・下落: M1 の買いの put は本源的価値で清算、M2 の足は生きている
    const x = ctx.x0 * 0.95;
    const state: MarginState = {
      x,
      scenario: { ...ZERO_SCENARIO, days: 40, dX: x - ctx.x0 },
      horizonDays: H,
    };
    const legs = [
      op(M1, 'put', ATM, 'buy'),
      op(M1, 'put', 66000, 'sell'),
      op(M2, 'put', 66000, 'sell', 2),
      op(M2, 'put', 64000, 'buy'),
      fut('buy'),
    ];
    const on = m(legs, { state, params: ON });
    const off = m(legs, { state, params: P });
    expect(on.settledCash).toBe(off.settledCash);
    expect(on.futuresPnl).toBe(off.futuresPnl);
    // 清算額: +1,000 × (ATM − F') − 1,000 × (66,000 − F')（円モード F' = X' + basis）
    const f = x + (M1.F - ctx.x0);
    expect(on.settledCash).toBeCloseTo(1000 * (ATM - f) - 1000 * Math.max(0, 66000 - f), 6);
    // 所要額はオンのほうが大きい（M2 の買いの put を除く）
    expect(on.requirement).toBeGreaterThan(off.requirement);
    expectSameMargin(
      on,
      m(
        [
          op(M1, 'put', ATM, 'buy'),
          op(M1, 'put', 66000, 'sell'),
          op(M2, 'put', 66000, 'sell', 2),
          fut('buy'),
        ],
        {
          state,
          params: P,
        },
      ),
    );
  });

  it('#149 性質: 所要額(オン) ≥ 所要額(オフ)（k ≤ 100%。ここは 100%）、買いの OP が無ければ一致', () => {
    // 根拠: OP の価値 ≥ 0 なので、買いの OP の足を除くと格子の損失は高々その評価額 L だけ減り、
    // NOV はちょうど L だけ減る → k × PFE − NOV は (1 − k)L 以上減らない（k ≤ 100% で減らない。#150）
    expect(P.factor).toBe(1);
    const next = rng(149);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const strikes = [64000, 65000, 66000, 67000, ATM, 68500, 69000, 70000];
    const randomLeg = (): Leg => {
      for (;;) {
        if (next() < 0.2) {
          return fut(pick(['buy', 'sell'] as const), 1 + Math.floor(next() * 3));
        }
        try {
          return op(
            pick([M1, M2] as const),
            pick(['call', 'put'] as const),
            pick(strikes),
            pick(['buy', 'sell'] as const),
            1 + Math.floor(next() * 3),
          );
        } catch {
          // 板に両側気配が無い行使価格は引き直す
        }
      }
    };
    let withLong = 0;
    let withoutLong = 0;
    for (let n = 0; n < 240; n++) {
      const legs = Array.from({ length: 1 + Math.floor(next() * 4) }, randomLeg);
      const x = ctx.x0 * (0.9 + 0.2 * next());
      const state: MarginState = {
        x,
        scenario: { ...ZERO_SCENARIO, dX: x - ctx.x0, days: Math.floor(next() * 3) * 20 },
        horizonDays: H,
      };
      const on = m(legs, { state, params: ON });
      const off = m(legs, { state, params: P });
      const name = `#${n}`;
      expect(on.requirement, name).toBeGreaterThanOrEqual(off.requirement - 1e-9);
      expect(on.settledCash, name).toBe(off.settledCash);
      expect(on.futuresPnl, name).toBe(off.futuresPnl);
      const hasLong = legs.some((l) => l.kind === 'option' && l.side === 'buy');
      if (hasLong) {
        withLong++;
        // オン = 買いの OP を取り除いたポジションのオフ
        const rest = legs.filter((l) => !(l.kind === 'option' && l.side === 'buy'));
        const r = m(rest, { state, params: P });
        expect(Math.abs(on.margin - r.margin), name).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(on.requirement - r.requirement), name).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(on.pfe - r.pfe), name).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(on.nov - r.nov), name).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(on.futuresPnl - r.futuresPnl), name).toBeLessThanOrEqual(1e-6);
      } else {
        withoutLong++;
        expect(on, name).toEqual(off);
      }
    }
    expect(withLong).toBeGreaterThan(20);
    expect(withoutLong).toBeGreaterThan(20);
  });

  it('#149 オン: SQ の直前・T = 0 ちょうど・SQ の直後で NaN・∞ が無い', () => {
    const legs = [
      op(M1, 'put', ATM, 'sell'),
      op(M2, 'put', 66000, 'sell', 2),
      fut('sell'),
      op(M1, 'call', 69000, 'buy'),
    ];
    const p = prep(legs);
    const t0 = (p[0] as PreparedLeg).T0 * 365;
    for (const days of [t0 - 1e-4, t0 - 30 / 86400, t0, t0 + 1e-9]) {
      const r = marginAt(p, { ...NOW, scenario: { ...ZERO_SCENARIO, days } }, ctx, SETTINGS, ON);
      for (const v of [r.pfe, r.nov, r.margin, r.requirement, r.futuresPnl, r.settledCash]) {
        expect(Number.isFinite(v), `days=${days}`).toBe(true);
      }
      expect(r.margin).toBeGreaterThanOrEqual(0);
      expect(r.requirement).toBeGreaterThanOrEqual(0);
    }
  });

  it('#149 オン: 追証の線は売りと先物だけで余力 0', () => {
    const sells = [op(M1, 'put', ATM, 'sell', 2)];
    const ratio = [...sells, op(M1, 'put', 67875, 'buy')];
    const p = prep(ratio);
    const prem = premiumSummary(p, SETTINGS);
    const sellsP = prep(sells);
    const sc: Scenario = { ...ZERO_SCENARIO, days: 3 };
    const range = { lo: ctx.x0 * 0.5, hi: ctx.x0 * 1.5 };
    const at = (x: number) => ({ x, scenario: { ...sc, dX: x - ctx.x0 }, horizonDays: H });
    // 余力 = 全足の支払・受取・手数料 − 売りだけの M
    const roomSells = (cap: number, x: number) =>
      marginRoom(cap, prem, marginAt(sellsP, at(x), ctx, SETTINGS, P));
    const cap = 30_000_000;
    const on = marginCallLevels(p, sc, ctx, SETTINGS, ON, H, cap, prem, range);
    const off = marginCallLevels(p, sc, ctx, SETTINGS, P, H, cap, prem, range);
    expect(on.length).toBeGreaterThanOrEqual(1);
    for (const x of on) {
      expect(Math.sign(roomSells(cap, x - 1))).not.toBe(Math.sign(roomSells(cap, x + 1)));
    }
    expect(on).not.toEqual(off);
    // 下側の線はオン（所要額が大きい）のほうが X₀ に近い
    expect(on[0] as number).toBeGreaterThan((off[0] ?? Number.NEGATIVE_INFINITY) as number);
  });
});

describe('#150 3 つの形の参照値', () => {
  // 平らな IV の板（スマイルなし。足の σ = 建値から逆算したアンカー IV で一定）。1 限月 F = 67,810（架空）
  const flat = makeMarket({ withSmile: false });
  const fctx = flat.ctx;
  const frows = flat.rows[M1.id] as NonNullable<(typeof flat.rows)[string]>;
  const putSell = (k: number): Leg => {
    const q = quoteOf(frows, k, 'put');
    return {
      kind: 'option',
      product: 'op_large',
      type: 'put',
      expiry: M1.id,
      strike: k,
      side: 'sell',
      qty: 1,
      entry: q.bid,
      mid: q.mid,
    };
  };
  const h = businessDaysAhead(fctx.evalTime, 2, []);
  const state: MarginState = { x: fctx.x0, scenario: ZERO_SCENARIO, horizonDays: h };

  // 約 26% OTM・約 9% OTM・ATM の put の売り 1 枚
  it.each([50000, 61750, ATM])('K = %i: 必要証拠金・NOV・所要額が手計算の格子と 1 円以内', (k) => {
    const legs = preparePosition([putSell(k)], fctx, DEFAULT_SETTINGS);
    const p = legs[0] as PreparedLeg;
    const r = marginAt(legs, state, fctx, DEFAULT_SETTINGS, DEFAULT_MARGIN_PARAMS);
    // 参照値（Black-76 を直接呼ぶ）:
    //   σ = アンカー IV（平らな板なので S の評価 IV もこれ）、basis = F − X₀、
    //   P_S = Black76(put, X₀ + basis, K, T0, σ, r)
    //   格子 30 点: x = X₀(1 + s·0.05)（s ∈ {−1, −½, 0, ½, 1}）× c ∈ {1.5, 1, 0.75} × t ∈ {0, h}
    //   P_g = Black76(put, x + basis, K, T0 − t/365, max(σ_min, σ·c), r)
    //   PFE = max(0, max 1,000 × (P_g − P_S))（売り 1 枚の損失）、必要証拠金 = 1 × PFE、
    //   NOV = −1,000 × P_S、所要額 = 必要証拠金 − NOV
    const sigma = (p.option as NonNullable<PreparedLeg['option']>).anchor;
    const basis = p.F - fctx.x0;
    const pS = black76Price('put', fctx.x0 + basis, k, p.T0, sigma, fctx.r);
    let maxLoss = Number.NEGATIVE_INFINITY;
    let arg = { priceStep: 0, ivScale: 0, days: 0 };
    for (const c of [1.5, 1, 0.75]) {
      for (const t of [0, h]) {
        for (const st of [-1, -0.5, 0, 0.5, 1]) {
          const x = fctx.x0 * (1 + st * 0.05);
          const sg = Math.max(DEFAULT_SETTINGS.sigmaMin, sigma * c);
          const pg = black76Price('put', x + basis, k, p.T0 - t / 365, sg, fctx.r);
          const loss = 1000 * (pg - pS);
          if (loss > maxLoss) {
            maxLoss = loss;
            arg = { priceStep: st, ivScale: c, days: t };
          }
        }
      }
    }
    const marginRef = 1 * Math.max(0, maxLoss);
    const novRef = -1000 * pS;
    const requirementRef = marginRef - novRef;
    expect(marginRef).toBeGreaterThan(0);
    expect(Math.abs(r.margin - marginRef)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.nov - novRef)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.requirement - requirementRef)).toBeLessThanOrEqual(1);
    // put の売りの最悪は下落・IV 上げ
    expect(r.worst).toEqual(arg);
    expect(r.worst?.priceStep).toBe(-1);
    expect(r.worst?.ivScale).toBe(1.5);
  });
});

describe('#150 格子の IV は状態 S の IV の倍率で、β に依らない', () => {
  const D = DEFAULT_MARGIN_PARAMS;

  /** 足ごとに S の σ_S を sigmaAt で求め、格子は σ_S × c 一定で回した参照値（円モード・basis 固定） */
  function gridRef(
    legs: readonly PreparedLeg[],
    st: MarginState,
    c0: MarketContext,
    params: MarginParams,
    withBetaOnGrid = false,
  ) {
    const sc = st.scenario;
    const fp = (p: PreparedLeg, x: number) => x + p.basis;
    const sig = (p: PreparedLeg, x: number) => {
      const o = p.option as NonNullable<PreparedLeg['option']>;
      const leg = p.leg as Extract<Leg, { kind: 'option' }>;
      return sigmaAt(
        o.sigmaBase,
        leg.strike,
        p.F,
        fp(p, x),
        c0.x0,
        x,
        sc,
        DEFAULT_SETTINGS.sigmaMin,
      );
    };
    const value = (p: PreparedLeg, x: number, T: number, sigma: number) => {
      const leg = p.leg as Extract<Leg, { kind: 'option' }>;
      return black76Price(leg.type, fp(p, x), leg.strike, T, sigma, c0.r);
    };
    const w = (p: PreparedLeg) => p.sign * p.leg.qty * p.multiplier;
    let v0 = 0;
    for (const p of legs) v0 += w(p) * value(p, st.x, p.T0 - sc.days / 365, sig(p, st.x));
    let maxLoss = Number.NEGATIVE_INFINITY;
    for (const c of [1 + params.ivUp, 1, 1 - params.ivDown]) {
      for (const t of [0, st.horizonDays]) {
        for (const s of MARGIN_PRICE_STEPS) {
          const x = st.x * (1 + s * params.range);
          let v = 0;
          for (const p of legs) {
            const base = withBetaOnGrid ? sig(p, x) : sig(p, st.x);
            const sg = Math.max(DEFAULT_SETTINGS.sigmaMin, base * c);
            v += w(p) * value(p, x, p.T0 - (sc.days + t) / 365, sg);
          }
          maxLoss = Math.max(maxLoss, v0 - v);
        }
      }
    }
    return params.factor * Math.max(0, maxLoss);
  }

  it('今（ΔX = 0）: β = 0 と β = 1 で必要証拠金・所要額・最悪の点が一致（1e-6 円）', () => {
    for (const legs of [
      [op(M1, 'put', 66000, 'sell')],
      [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 69500, 'sell')],
    ]) {
      const p = prep(legs, DEFAULT_SETTINGS);
      const at = (beta: number) =>
        marginAt(p, { ...NOW, scenario: { ...ZERO_SCENARIO, beta } }, ctx, DEFAULT_SETTINGS, D);
      const a = at(0);
      const b = at(1);
      expect(a.margin).toBeGreaterThan(0);
      expect(Math.abs(a.margin - b.margin)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(a.requirement - b.requirement)).toBeLessThanOrEqual(1e-6);
      expect(a.worst).toEqual(b.worst);
    }
  });

  it('シナリオ点（ΔX = −8%・β = 1・Δσ = +5pt・sticky_moneyness）: S の IV × 倍率の参照値と 1 円以内', () => {
    const dX = -0.08 * ctx.x0;
    const st: MarginState = {
      x: ctx.x0 + dX,
      scenario: { ...ZERO_SCENARIO, dX, dSigma: 5, beta: 1, ivDynamics: 'sticky_moneyness' },
      horizonDays: H,
    };
    for (const legs of [
      [op(M1, 'put', 66000, 'sell')],
      [op(M1, 'put', 66000, 'sell'), op(M2, 'call', 69500, 'sell')],
    ]) {
      const p = prep(legs, DEFAULT_SETTINGS);
      const r = marginAt(p, st, ctx, DEFAULT_SETTINGS, D);
      const ref = gridRef(p, st, ctx, D);
      expect(Math.abs(r.margin - ref)).toBeLessThanOrEqual(1);
      // 格子の点ごとに β を足す作り（旧）とは 1 円より大きく違う = 格子で β を足していない
      expect(Math.abs(r.margin - gridRef(p, st, ctx, D, true))).toBeGreaterThan(1);
    }
  });

  it('下げの倍率で σ_min を割る足は σ_min で評価される（1 円）', () => {
    // 買いの put（オフ）は IV の下げで損をするので、最悪の点は下げの層
    const leg = op(M1, 'put', ATM, 'buy');
    const p = prep([leg], DEFAULT_SETTINGS);
    const anchor = ((p[0] as PreparedLeg).option as NonNullable<PreparedLeg['option']>).anchor;
    // S の IV を約 5% にする（× 0.1 = 0.5% < σ_min 1%）
    const st: MarginState = {
      ...NOW,
      scenario: { ...ZERO_SCENARIO, dSigma: (0.05 - anchor) * 100 },
    };
    const sS = legSigma(p[0] as PreparedLeg, st.x, st.scenario, ctx, DEFAULT_SETTINGS) as number;
    expect(sS).toBeGreaterThan(DEFAULT_SETTINGS.sigmaMin);
    expect(sS * 0.1).toBeLessThan(DEFAULT_SETTINGS.sigmaMin);
    const params: MarginParams = { ...D, ivDown: 0.9, ignoreLongOptions: false };
    const r = marginAt(p, st, ctx, DEFAULT_SETTINGS, params);
    expect(r.worst?.ivScale).toBeCloseTo(0.1, 12);
    expect(Math.abs(r.margin - gridRef(p, st, ctx, params))).toBeLessThanOrEqual(1);
  });

  it('倍率の単調: 売りだけの 3 形で ivUp ∈ {0, 0.25, 0.5, 1, 2} に対し必要証拠金が減らない', () => {
    for (const legs of [
      [op(M1, 'put', 66000, 'sell')],
      [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 69500, 'sell')],
      [op(M1, 'put', ATM, 'sell'), op(M1, 'call', ATM, 'sell')],
    ]) {
      const seq = [0, 0.25, 0.5, 1, 2].map((ivUp) => m(legs, { params: { ...D, ivUp } }).margin);
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1] as number);
      }
    }
  });

  it('ivUp = ivDown = 0 で IV の層は 1 種（最悪の点の倍率は 1）', () => {
    const r = m([op(M1, 'put', 66000, 'sell')], { params: { ...D, ivUp: 0, ivDown: 0 } });
    expect(r.worst?.ivScale).toBe(1);
    expect(Number.isFinite(r.margin)).toBe(true);
  });
});

describe('#150 必要証拠金と NOV を分ける', () => {
  const D = DEFAULT_MARGIN_PARAMS;
  const capital = 20_000_000;

  it('売りだけ: 所要額 = 必要証拠金 + |NOV|、余力 = 資金 − 支払 + 受取 − 手数料 + 先物 + 清算 − 所要額（1 円）', () => {
    for (const legs of [
      [op(M1, 'put', 66000, 'sell')],
      [op(M1, 'put', 66000, 'sell'), op(M1, 'call', 69500, 'sell')],
    ]) {
      const p = prep(legs);
      const r = marginAt(p, NOW, ctx, SETTINGS, D);
      expect(r.nov).toBeLessThan(0);
      expect(Math.abs(r.margin - D.factor * r.pfe)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(r.requirement - (r.margin + Math.abs(r.nov)))).toBeLessThanOrEqual(1e-6);
      const prem = premiumSummary(p, SETTINGS);
      const hand =
        capital -
        prem.paid +
        prem.received -
        prem.fees +
        r.futuresPnl +
        r.settledCash -
        r.requirement;
      expect(Math.abs(marginRoom(capital, prem, r) - hand)).toBeLessThanOrEqual(1);
      // 掛け目 × 2: 必要証拠金は 2 倍、NOV は変わらない
      const r2 = marginAt(p, NOW, ctx, SETTINGS, { ...D, factor: 2 * D.factor });
      expect(Math.abs(r2.margin - 2 * r.margin)).toBeLessThanOrEqual(1e-6);
      expect(r2.nov).toBe(r.nov);
      expect(Math.abs(r2.requirement - (2 * D.factor * r.pfe - r.nov))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('オフの買いだけ: 所要額 = max(0, k × PFE − NOV)。k = 100% なら 0 で余力 = 資金 − 支払 − 手数料', () => {
    const legs = [op(M1, 'call', 68500, 'buy'), op(M2, 'put', 66000, 'buy')];
    const off = { ...D, ignoreLongOptions: false };
    const r3 = m(legs, { params: { ...off, factor: 3 } });
    expect(r3.pfe).toBeGreaterThan(0);
    expect(r3.requirement).toBeGreaterThanOrEqual(0);
    expect(Math.abs(r3.requirement - Math.max(0, 3 * r3.pfe - r3.nov))).toBeLessThanOrEqual(1e-6);
    const r1 = m(legs, { params: { ...off, factor: 1 } });
    expect(r1.requirement).toBe(0);
    expect(r1.margin).toBeGreaterThan(0);
    const prem = premiumSummary(prep(legs), SETTINGS);
    const a = room(legs, capital, NOW, SETTINGS, { ...off, factor: 1 });
    expect(Math.abs(a - (capital - prem.paid - prem.fees))).toBeLessThanOrEqual(1);
  });

  it('オン（既定）の買いだけ: 必要証拠金 = 所要額 = 0', () => {
    const r = m([op(M1, 'call', 68500, 'buy')], { params: D });
    expect(r.margin).toBe(0);
    expect(r.requirement).toBe(0);
  });
});

describe('#150 legValueAtSigma は legValue と一致', () => {
  it('種を固定した 240 ケース: OP（3 区間・call / put・円 / %）・先物で 0.01 円以内', () => {
    const next = rng(150);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const strikes = [60000, 64000, 66000, ATM, 69500, 72000];
    const t1 = M1.days;
    const tMinDays = (DEFAULT_SETTINGS.tMin * 365) / 2;
    let near = 0;
    let expired = 0;
    let live = 0;
    for (let n = 0; n < 240; n++) {
      const settings: ModelSettings = {
        ...DEFAULT_SETTINGS,
        basisMode: pick(['yen', 'pct'] as const),
        futureBasis: pick(['fixed', 'decay'] as const),
      };
      const isFut = next() < 0.15;
      const leg = isFut
        ? fut(pick(['buy', 'sell'] as const), 1 + Math.floor(next() * 3))
        : op(
            M1,
            pick(['call', 'put'] as const),
            pick(strikes),
            pick(['buy', 'sell'] as const),
            1 + Math.floor(next() * 3),
          );
      const p = preparePosition([leg], ctx, settings)[0] as PreparedLeg;
      // 経過: SQ の前（生きている）・T ≤ tMin・SQ の後
      const region = Math.floor(next() * 3);
      const days =
        region === 0 ? next() * (t1 - 1) : region === 1 ? t1 - tMinDays : t1 + next() * 5;
      const x = ctx.x0 * (0.85 + 0.3 * next());
      const sc: Scenario = {
        days,
        dX: x - ctx.x0,
        dSigma: (next() - 0.5) * 20,
        skew: (next() - 0.5) * 4,
        beta: next() * 2,
        ivDynamics: pick(['sticky_strike', 'sticky_moneyness'] as const),
        ivShift: pick(['absolute', 'relative'] as const),
      };
      const sigma = legSigma(p, x, sc, ctx, settings);
      const ref = legValue(p, x, sc, ctx, settings);
      const name = `#${n}`;
      if (isFut) {
        expect(sigma, name).toBeNull();
        expect(
          Math.abs(legValueAtSigma(p, x, sc, ctx, settings, 0.3) - ref),
          name,
        ).toBeLessThanOrEqual(0.01);
        continue;
      }
      const T = p.T0 - days / 365;
      if (T <= 0) {
        expired++;
        expect(sigma, name).toBeNull();
      } else {
        const leg2 = p.leg as Extract<Leg, { kind: 'option' }>;
        const o = p.option as NonNullable<PreparedLeg['option']>;
        const fp = settings.basisMode === 'yen' ? x + p.basis : (x * p.F) / ctx.x0;
        expect(sigma, name).toBe(
          sigmaAt(o.sigmaBase, leg2.strike, p.F, fp, ctx.x0, x, sc, settings.sigmaMin),
        );
        expect(
          Math.abs(legValueAtSigma(p, x, sc, ctx, settings, sigma as number) - ref),
          name,
        ).toBeLessThanOrEqual(0.01);
        if (T <= settings.tMin) near++;
        else live++;
      }
      if (T <= settings.tMin) {
        // 本源的価値の区間は σ に依らない
        for (const sg of [0.01, 0.3, 2]) {
          expect(
            Math.abs(legValueAtSigma(p, x, sc, ctx, settings, sg) - ref),
            name,
          ).toBeLessThanOrEqual(0.01);
        }
      }
    }
    expect(live).toBeGreaterThan(20);
    expect(near).toBeGreaterThan(20);
    expect(expired).toBeGreaterThan(20);
  });
});

describe('AC13 純関数', () => {
  // Node の型を入れていないので、fs は motion.test.ts と同じく process.getBuiltinModule で読む
  const fs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
    }
  ).process.getBuiltinModule('node:fs');
  it('model/margin.ts は DOM・fetch・Date.now を参照しない', () => {
    const src = fs.readFileSync(new URL('../../model/margin.ts', import.meta.url), 'utf8');
    expect(src).toContain('export function marginAt');
    expect(src.match(/document|window|fetch\(|Date\.now/g)).toBeNull();
  });
});

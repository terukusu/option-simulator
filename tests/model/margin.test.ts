/**
 * 証拠金の概算（格子の最悪値・掛け目）。設計 docs/design.md 5.10、Issue #131 の AC1〜AC13・#149。
 * 板は合成（tests/support/market.ts。架空の値）。JSCC の額は再現しない（参照値は手計算）。
 * #131 の AC は「買いの OP で減らさない」をオフ（全足で相殺する JSCC の形）にして固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARGIN_PARAMS,
  MARGIN_PRICE_STEPS,
  type MarginParams,
  type MarginState,
  marginAt,
  marginCallLevels,
  marginIvOffset,
  marginRoom,
  maxMultiple,
} from '../../model/margin';
import {
  DEFAULT_SETTINGS,
  type Leg,
  legValue,
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
/** #131 の AC の前提: JSCC の形 = 買いの OP でも相殺する（#149 の設定をオフ） */
const P: MarginParams = { ...DEFAULT_MARGIN_PARAMS, ignoreLongOptions: false };
/** #149 の既定: 買いの OP で減らさない */
const ON: MarginParams = { ...DEFAULT_MARGIN_PARAMS, ignoreLongOptions: true };
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
  it('既定: R 8%・IV +8 / −4pt・掛け目 120%、原資産は 5 点', () => {
    expect(DEFAULT_MARGIN_PARAMS).toEqual({
      range: 0.08,
      ivUpPt: 8,
      ivDownPt: 4,
      factor: 1.2,
      ignoreLongOptions: true,
    });
    expect([...MARGIN_PRICE_STEPS]).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(H).toBe(2);
  });

  it('IV の平行移動は absolute でも relative でもシナリオの式を通した後でちょうど pt', () => {
    const base = (x: number) => 0.2 + 0.1 * x;
    for (const sc of [
      ZERO_SCENARIO,
      { ...ZERO_SCENARIO, dSigma: 5 },
      { ...ZERO_SCENARIO, ivShift: 'relative', dSigma: 50 } as Scenario,
      { ...ZERO_SCENARIO, ivShift: 'relative', dSigma: -30, skew: 2 } as Scenario,
    ]) {
      for (const pt of [8, -4]) {
        const d = marginIvOffset(pt, sc);
        const shifted = (x: number) => base(x) + d;
        const a = sigmaAt(base, 66000, 67810, 65000, 67810, 64990, sc, 0.0001);
        const b = sigmaAt(shifted, 66000, 67810, 65000, 67810, 64990, sc, 0.0001);
        expect(b - a).toBeCloseTo(pt / 100, 12);
      }
    }
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
    it(`${name}: 必要証拠金 0、余力 = 資金 − 支払 − 手数料（1 円以内）`, () => {
      const r = m(legs);
      expect(r.margin).toBe(0);
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
  it('put 売り 1 枚: 必要証拠金 ≥ k × 売りの評価額、PFE > 0', () => {
    const legs = [op(M1, 'put', 66000, 'sell')];
    const r = m(legs);
    const p = prep(legs)[0] as PreparedLeg;
    const value = legValue(p, ctx.x0, ZERO_SCENARIO, ctx, SETTINGS) * 1000;
    expect(r.pfe).toBeGreaterThan(0);
    expect(r.nov).toBeCloseTo(-value, 6);
    expect(r.margin).toBeGreaterThanOrEqual(P.factor * value);
    expect(r.margin).toBeCloseTo(P.factor * (r.pfe - r.nov), 6);
    expect(r.worst).not.toBeNull();
    // put 売りの最悪点は下落・IV 上げ
    expect(r.worst?.priceStep).toBe(-1);
    expect(r.worst?.ivPt).toBe(P.ivUpPt);
  });
});

describe('AC3 大小関係', () => {
  it('同じ限月の ATM: ストラドル売り > put 売り > put 買い（= 0）', () => {
    const straddle = m([op(M1, 'call', ATM, 'sell'), op(M1, 'put', ATM, 'sell')]).margin;
    const putSell = m([op(M1, 'put', ATM, 'sell')]).margin;
    const putBuy = m([op(M1, 'put', ATM, 'buy')]).margin;
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
  it.each([2, 5])('全足の枚数 × %i で必要証拠金も同じ倍率（相対 1e-9）', (n) => {
    const r = m(scale(legs, n));
    expect(base.margin).toBeGreaterThan(0);
    expect(Math.abs(r.margin / (n * base.margin) - 1)).toBeLessThanOrEqual(1e-9);
  });
  it('掛け目 × 2 で 2 倍', () => {
    const r = m(legs, { params: { ...P, factor: P.factor * 2 } });
    expect(Math.abs(r.margin / (2 * base.margin) - 1)).toBeLessThanOrEqual(1e-9);
  });
});

describe('AC5 相殺', () => {
  it('同じ銘柄の売り買い同数で 0', () => {
    expect(m([op(M1, 'put', 66000, 'sell', 2), op(M1, 'put', 66000, 'buy', 2)]).margin).toBe(0);
    expect(m([fut('buy', 3), fut('sell', 3)]).margin).toBe(0);
  });

  it('バーティカル（put 売り K1 + put 買い K2 < K1）≤ k × 幅 × 1,000 かつ ≤ put 売り単体', () => {
    for (const [k1, k2] of [
      [ATM, 67250],
      [66000, 64000],
      [68500, 66500],
    ] as const) {
      const vertical = m([op(M1, 'put', k1, 'sell'), op(M1, 'put', k2, 'buy')]).margin;
      const single = m([op(M1, 'put', k1, 'sell')]).margin;
      expect(vertical).toBeGreaterThan(0);
      expect(vertical).toBeLessThanOrEqual(P.factor * (k1 - k2) * 1000);
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
  it('10 通り: M(全体) ≤ M(部分 1) + M(部分 2)', () => {
    expect(cases).toHaveLength(10);
    for (const [name, a, b] of cases) {
      const whole = m([...a, ...b]).margin;
      const parts = m(a).margin + m(b).margin;
      expect(whole, name).toBeLessThanOrEqual(parts + 1e-6);
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
        expect(r.nov).toBe(0);
      }
    }
    // 手計算の参照値（架空の X = 40,000）: 1.2 × 0.08 × 40,000 × 1,000 = 3,840,000 円
    const state = { ...NOW, x: 40000, scenario: { ...ZERO_SCENARIO, dX: 40000 - ctx.x0 } };
    expect(Math.abs(m([fut('buy')], { state }).margin - 3_840_000)).toBeLessThanOrEqual(1);
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
  const ivUps = [0, 4, 8, 12, 16];
  for (const [name, legs] of shapes) {
    it(`${name}: R・IV の上げ幅を 5 段で上げて必要証拠金が減らない`, () => {
      const byR = ranges.map((range) => m(legs, { params: { ...P, range } }).margin);
      const byIv = ivUps.map((ivUpPt) => m(legs, { params: { ...P, ivUpPt } }).margin);
      for (const seq of [byR, byIv]) {
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
      capital - prem.paid + prem.received - prem.fees + both.settledCash - both.margin,
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
        for (const v of [r.pfe, r.nov, r.margin, r.futuresPnl, r.settledCash]) {
          expect(Number.isFinite(v), `days=${days} x=${x}`).toBe(true);
        }
        expect(r.margin).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('生きている足が無ければ 0', () => {
    const r = marginAt([], NOW, ctx, SETTINGS, P);
    expect(r).toMatchObject({ pfe: 0, nov: 0, margin: 0, futuresPnl: 0, settledCash: 0 });
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
  /** M の比較に使うフィールド（M・PFE・NOV は 1e-6 円、最悪の点は同じ） */
  const expectSameMargin = (a: ReturnType<typeof m>, b: ReturnType<typeof m>, name = '') => {
    expect(Math.abs(a.margin - b.margin), name).toBeLessThanOrEqual(1e-6);
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
      expect(r, name).toMatchObject({ pfe: 0, nov: 0, margin: 0, futuresPnl: 0, settledCash: 0 });
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
    // 余力: 買いの支払は引かれる
    const prem = premiumSummary(prep(ratio), SETTINGS);
    expect(prem.paid).toBeGreaterThan(0);
    const a = room(ratio, capital, NOW, SETTINGS, ON);
    expect(
      Math.abs(a - (capital - prem.paid + prem.received - prem.fees - sellsOnly.margin)),
    ).toBeLessThanOrEqual(1);
  });

  it('#149 オン: バーティカルは put 売り単体と一致し、オフ以上', () => {
    for (const [k1, k2] of [
      [ATM, 67250],
      [66000, 64000],
      [68500, 66500],
    ] as const) {
      const vertical = [op(M1, 'put', k1, 'sell'), op(M1, 'put', k2, 'buy')];
      const on = m(vertical, { params: ON });
      expectSameMargin(on, m([op(M1, 'put', k1, 'sell')], { params: P }), `${k1}/${k2}`);
      expect(on.margin).toBeGreaterThanOrEqual(m(vertical, { params: P }).margin);
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
    // M はオンのほうが大きい（M2 の買いの put を除く）
    expect(on.margin).toBeGreaterThan(off.margin);
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

  it('#149 性質: M(オン) ≥ M(オフ)、買いの OP が無ければ一致', () => {
    // 根拠: OP の価値 ≥ 0 なので、買いの OP の足を除くと格子の損失は高々その評価額 L だけ減り、
    // NOV はちょうど L だけ減る → PFE − NOV は減らない
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
      expect(on.margin, name).toBeGreaterThanOrEqual(off.margin - 1e-9);
      expect(on.settledCash, name).toBe(off.settledCash);
      expect(on.futuresPnl, name).toBe(off.futuresPnl);
      const hasLong = legs.some((l) => l.kind === 'option' && l.side === 'buy');
      if (hasLong) {
        withLong++;
        // オン = 買いの OP を取り除いたポジションのオフ
        const rest = legs.filter((l) => !(l.kind === 'option' && l.side === 'buy'));
        const r = m(rest, { state, params: P });
        expect(Math.abs(on.margin - r.margin), name).toBeLessThanOrEqual(1e-6);
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
      for (const v of [r.pfe, r.nov, r.margin, r.futuresPnl, r.settledCash]) {
        expect(Number.isFinite(v), `days=${days}`).toBe(true);
      }
      expect(r.margin).toBeGreaterThanOrEqual(0);
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
    // 下側の線はオン（M が大きい）のほうが X₀ に近い
    expect(on[0] as number).toBeGreaterThan((off[0] ?? Number.NEGATIVE_INFINITY) as number);
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

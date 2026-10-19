/**
 * 追証マップ（#152 段 B。設計 docs/design.md 5.11）の B1〜B5。
 * 板は合成（tests/support/market.ts。架空の値）。参照値はテストの中で marginAt + marginRoom を直接呼ぶ。
 */

import { describe, expect, it } from 'vitest';
import {
  HOLD_MAP_C,
  HOLD_MAP_U,
  type HoldMapAxes,
  holdMapAxes,
  holdMapColumn,
  holdMapContour,
  holdMapCount,
  holdMapRoomAt,
  holdMapScenario,
} from '../../model/holdMap';
import { DEFAULT_MARGIN_PARAMS, type MarginParams, marginAt, marginRoom } from '../../model/margin';
import {
  DEFAULT_SETTINGS,
  type Leg,
  type ModelSettings,
  premiumSummary,
  preparePosition,
} from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { businessDaysAhead, DAY_MS } from '../../model/time';
import { holdMapCalcOf, holdMapInput, holdMapRooms } from '../../ui/view/holdMap';
import { marginNow } from '../../ui/view/margin';
import { pnlDomains } from '../../ui/view/pnlChart';
import { FUT, M1, M2, makeMarket, quoteOf } from '../support/market';
import { rng } from '../support/synthChain';

const { ctx, rows } = makeMarket();
const rows1 = rows[M1.id] as NonNullable<(typeof rows)[string]>;
const SETTINGS: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: 50 };
const PARAMS: MarginParams = { ...DEFAULT_MARGIN_PARAMS, factor: 1 };
const CAPITAL = 3_000_000;

function op(type: 'call' | 'put', k: number, side: 'buy' | 'sell', qty = 1): Leg {
  const q = quoteOf(rows1, k, type);
  return {
    kind: 'option',
    product: 'op_large',
    type,
    expiry: M1.id,
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

const FORMS: Array<[string, Leg[]]> = [
  ['put の売り', [op('put', 62000, 'sell', 2)]],
  ['ストラングルの売り', [op('put', 63000, 'sell'), op('call', 72000, 'sell')]],
  ['先物 + put の売り', [fut('buy', 3), op('put', 64000, 'sell')]],
];

const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};

function baseOf(legs: readonly Leg[], settings: ModelSettings = SETTINGS) {
  const b = pnlDomains(board, preparePosition(legs, ctx, settings), ctx, settings);
  if (!b) throw new Error('基礎が作れない');
  return b;
}

/** テストの参照値: マス (u, c) の余力を marginAt + marginRoom で直接 */
function reference(
  legs: readonly Leg[],
  base: Scenario,
  u: number,
  c: number,
  params: MarginParams = PARAMS,
  capital = CAPITAL,
  settings: ModelSettings = SETTINGS,
): number {
  const p = preparePosition(legs, ctx, settings);
  const h = businessDaysAhead(ctx.evalTime + base.days * DAY_MS, 2, []);
  const scenario: Scenario = {
    days: base.days,
    skew: base.skew,
    ivDynamics: base.ivDynamics,
    dX: u * ctx.x0,
    ivShift: 'relative',
    dSigma: (c - 1) * 100,
    beta: 0,
  };
  const r = marginAt(p, { x: ctx.x0 * (1 + u), scenario, horizonDays: h }, ctx, settings, params);
  return marginRoom(capital, premiumSummary(p, settings), r);
}

const AXES = holdMapAxes([]);
const iOf = (u: number) => AXES.us.findIndex((x) => Math.abs(x - u) < 1e-9);
const jOf = (c: number) => AXES.cs.findIndex((x) => Math.abs(x - c) < 1e-9);

describe('B1 マスの余力は marginAt の参照値と一致', () => {
  // 今のシナリオ（d・Δs・動き方。ΔX・Δσ・β・ivShift はマップに効かない）
  const current: Scenario = {
    ...ZERO_SCENARIO,
    days: 3,
    skew: 1,
    ivDynamics: 'sticky_moneyness',
    dX: -2000,
    dSigma: 7,
    beta: 2,
    ivShift: 'absolute',
  };
  const cells: Array<[number, number]> = [
    [0, 1],
    [-0.1, 1.6],
    [-0.3, 2.5],
    [0.2, 0.5],
    [-0.04, 0.8],
  ];
  for (const [name, legs] of FORMS) {
    it(`${name}: 5 マスが 1 円以内`, () => {
      const input = holdMapInput(baseOf(legs), current, PARAMS, CAPITAL, []);
      if (!input) throw new Error('入力が作れない');
      const calc = holdMapCalcOf(input);
      for (const [u, c] of cells) {
        const col = holdMapColumn(calc, AXES, iOf(u));
        const got = col[jOf(c)] as number;
        const want = reference(legs, current, u, c);
        expect(Number.isFinite(want)).toBe(true);
        expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
      }
    });
  }

  it('holdMapScenario は ΔX = uX₀・relative・Δσ = (c − 1) × 100・β = 0、d・Δs・動き方はそのまま', () => {
    const s = holdMapScenario(current, -0.1, 1.6, 50_000);
    expect(s.dX).toBeCloseTo(-5000, 9);
    expect(s.dSigma).toBeCloseTo(60, 9);
    expect(s.ivShift).toBe('relative');
    expect(s.beta).toBe(0);
    expect([s.days, s.skew, s.ivDynamics]).toEqual([3, 1, 'sticky_moneyness']);
  });
});

describe('B2 今のマスは今の余力', () => {
  const variants: Array<[string, Scenario]> = [
    ['β 0・sticky strike', { ...ZERO_SCENARIO, beta: 0 }],
    ['β 1・sticky moneyness', { ...ZERO_SCENARIO, beta: 1, ivDynamics: 'sticky_moneyness' }],
    [
      'β 2・sticky strike・relative',
      { ...ZERO_SCENARIO, beta: 2, ivShift: 'relative', dX: 3000, dSigma: -4 },
    ],
  ];
  for (const [name, sc] of variants) {
    it(`${name}: (0%, ×1)・d = 0 の余力が marginNow と 1 円以内`, () => {
      for (const [, legs] of FORMS) {
        const base = baseOf(legs);
        const now = marginNow(base, sc, PARAMS, CAPITAL, []);
        const input = holdMapInput(base, sc, PARAMS, CAPITAL, []);
        if (!input || !now || now.room === null) throw new Error('入力が作れない');
        const col = holdMapColumn(holdMapCalcOf(input), AXES, iOf(0));
        expect(Math.abs((col[jOf(1)] as number) - now.room)).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe('B3 性質（put の売り単体・sticky strike・掛け目 100%・d = 0）', () => {
  const puts = rows1
    .filter((r) => r.k >= 52_000 && r.k <= 67_000 && r.put.bid !== null && r.put.ask !== null)
    .map((r) => r.k);
  const sc: Scenario = { ...ZERO_SCENARIO, ivDynamics: 'sticky_strike' };

  it('u を固定すると c が大きいほど余力が増えない（50 ケース）', () => {
    const rand = rng(152);
    for (let n = 0; n < 50; n++) {
      const k = puts[Math.floor(rand() * puts.length)] as number;
      const qty = 1 + Math.floor(rand() * 3);
      const capital = 500_000 + rand() * 5_000_000;
      const u = -0.3 + Math.round(rand() * 25) * 0.02;
      const legs = [op('put', k, 'sell', qty)];
      let prev = Number.POSITIVE_INFINITY;
      for (const c of [0.5, 0.8, 1, 1.3, 1.7, 2.1, 2.5]) {
        const v = reference(legs, sc, u, c, PARAMS, capital);
        expect(v).toBeLessThanOrEqual(prev + 1e-6);
        prev = v;
      }
    }
  });

  it('u ≤ 0 で c を固定すると u が小さいほど余力が増えない（50 ケース）', () => {
    const rand = rng(1520);
    for (let n = 0; n < 50; n++) {
      const k = puts[Math.floor(rand() * puts.length)] as number;
      const qty = 1 + Math.floor(rand() * 3);
      const capital = 500_000 + rand() * 5_000_000;
      const c = 0.5 + Math.round(rand() * 20) * 0.1;
      const legs = [op('put', k, 'sell', qty)];
      let prev = Number.POSITIVE_INFINITY;
      for (let u = 0; u >= -0.3 - 1e-9; u -= 0.04) {
        const v = reference(legs, sc, u, c, PARAMS, capital);
        // u が小さくなる方向に並べたので、余力は前の値より大きくならない
        expect(v).toBeLessThanOrEqual(prev + 1e-6);
        prev = v;
      }
    }
  });
});

describe('B4 境目の線と数え方', () => {
  const axes = holdMapAxes([]);
  // 線形の場（架空）: room = a·u + b·c + e。境目は a·u + b·c + e = 0 の直線
  const a = 4_000_000;
  const b = -1_000_000;
  const e = 900_000;
  const f = (u: number, c: number) => a * u + b * c + e;
  const field = (g: (u: number, c: number) => number) =>
    axes.us.map((u) => Float64Array.from(axes.cs, (c) => g(u, c)));

  it('線分の端点は真の直線の上（1e-9）', () => {
    const segs = holdMapContour(axes, field(f));
    expect(segs.length).toBeGreaterThan(10);
    for (const seg of segs) {
      for (const [u, c] of seg) {
        // 余力の単位（円）を a で割った距離で 1e-9
        expect(Math.abs(f(u, c)) / a).toBeLessThan(1e-9);
      }
    }
  });

  it('点の判定（双線形補間 < 0）は真の符号と一致（境目の上の点を除く）', () => {
    const rooms = field(f);
    const rand = rng(7);
    const pts = Array.from({ length: 500 }, () => ({
      dx: -0.3 + rand() * 0.5,
      ivRatio: 0.5 + rand() * 2,
    })).filter((p) => Math.abs(f(p.dx, p.ivRatio)) > 1e-3);
    const r = holdMapCount(axes, rooms, pts);
    expect(r.n).toBe(pts.length);
    pts.forEach((p, k) => {
      expect(r.calls[k]).toBe(f(p.dx, p.ivRatio) < 0);
      expect(holdMapRoomAt(axes, rooms, p.dx, p.ivRatio)).toBeCloseTo(f(p.dx, p.ivRatio), 3);
    });
    expect(r.m).toBe(pts.filter((p) => f(p.dx, p.ivRatio) < 0).length);
    expect(r.m).toBeGreaterThan(0);
    expect(r.m).toBeLessThan(r.n);
  });

  it('余力が有限でないマスを含む区画は線にも数にも入れない', () => {
    const rooms = field(f);
    // 境目の上の格子点（u = −0.04 付近）を NaN に
    const i = axes.us.findIndex((u) => Math.abs(u + 0.04) < 1e-9);
    const j = axes.cs.findIndex((c) => Math.abs(c - 0.8) < 1e-9);
    (rooms[i] as Float64Array)[j] = Number.NaN;
    const u0 = axes.us[i] as number;
    const c0 = axes.cs[j] as number;
    const segs = holdMapContour(axes, rooms);
    // NaN の点を角に持つ 4 区画の内側（端は除く）に線分が無い
    for (const seg of segs) {
      const mid = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2] as const;
      const inside = Math.abs(mid[0] - u0) < 0.02 - 1e-9 && Math.abs(mid[1] - c0) < 0.1 - 1e-9;
      expect(inside).toBe(false);
    }
    // 隣の区画の点は NaN で数えない、遠くの点は数える
    const pts = [
      { dx: u0 + 0.005, ivRatio: c0 + 0.03 },
      { dx: u0 - 0.01, ivRatio: c0 - 0.05 },
      { dx: -0.25, ivRatio: 2 },
    ];
    const r = holdMapCount(axes, rooms, pts);
    expect(r.counted).toEqual([false, false, true]);
    expect(r.n).toBe(1);
    expect(Number.isNaN(holdMapRoomAt(axes, rooms, pts[0]?.dx ?? 0, pts[0]?.ivRatio ?? 0))).toBe(
      true,
    );
  });

  it('範囲の外の点は数えない', () => {
    const r = holdMapCount(axes, field(f), [{ dx: -0.5, ivRatio: 1 }]);
    expect(r.n).toBe(0);
  });

  it('鞍点は 4 隅の平均の符号で切る（2 本の線分）', () => {
    const ax: HoldMapAxes = { us: [0, 0.02], cs: [1, 1.1] };
    // 00 と 11 が負、10 と 01 が正。平均が正なら 00 と 11 の角を切る
    const rooms = [Float64Array.from([-1, 3]), Float64Array.from([3, -1])];
    const segs = holdMapContour(ax, rooms);
    expect(segs).toHaveLength(2);
    // 00 の角を切る線分（左と下の辺）と 11 の角（右と上）
    const touches = (s: (typeof segs)[number], u: number, c: number) =>
      s.some(([x, y]) => Math.abs(x - u) < 1e-12 || Math.abs(y - c) < 1e-12);
    expect(segs.some((s) => touches(s, 0, 1))).toBe(true);
  });
});

describe('B5 軸', () => {
  it('既定は u = −30%〜+20%（2% 刻み、26 列）、c = ×0.5〜×2.5（0.1 刻み、21 行）', () => {
    const ax = holdMapAxes([]);
    expect(ax.us).toHaveLength(26);
    expect(ax.cs).toHaveLength(21);
    expect(ax.us[0]).toBe(HOLD_MAP_U.min);
    expect(ax.us[25]).toBe(HOLD_MAP_U.max);
    expect(ax.cs[0]).toBe(HOLD_MAP_C.min);
    expect(ax.cs[20]).toBe(HOLD_MAP_C.max);
    expect(ax.us).toContain(0);
    expect(ax.cs).toContain(1);
    for (let i = 1; i < ax.us.length; i++) {
      expect((ax.us[i] as number) - (ax.us[i - 1] as number)).toBeCloseTo(0.02, 12);
    }
    for (let j = 1; j < ax.cs.length; j++) {
      expect((ax.cs[j] as number) - (ax.cs[j - 1] as number)).toBeCloseTo(0.1, 12);
    }
  });

  it('点がはみ出すときは刻みのまま点を含むまで広げる', () => {
    const ax = holdMapAxes([
      { dx: -0.37, ivRatio: 1 },
      { dx: 0.05, ivRatio: 2.73 },
      { dx: 0.211, ivRatio: 0.42 },
    ]);
    expect(ax.us[0]).toBe(-0.38);
    expect(ax.us[ax.us.length - 1]).toBe(0.22);
    expect(ax.cs[0]).toBe(0.4);
    expect(ax.cs[ax.cs.length - 1]).toBe(2.8);
    expect(ax.us).toHaveLength(31);
    expect(ax.cs).toHaveLength(25);
    for (let i = 1; i < ax.us.length; i++) {
      expect((ax.us[i] as number) - (ax.us[i - 1] as number)).toBeCloseTo(0.02, 12);
    }
  });

  it('端ちょうどの点・中の点では広げない', () => {
    const ax = holdMapAxes([
      { dx: -0.3, ivRatio: 2.5 },
      { dx: 0.2, ivRatio: 0.5 },
      { dx: 0, ivRatio: 1 },
    ]);
    expect(ax.us).toHaveLength(26);
    expect(ax.cs).toHaveLength(21);
  });
});

describe('マップ全体', () => {
  it('put の売りで、追証のマスと余力ありのマスの両方があり、有限', () => {
    const legs = FORMS[0]?.[1] ?? [];
    const input = holdMapInput(baseOf(legs), ZERO_SCENARIO, PARAMS, 1_500_000, []);
    if (!input) throw new Error('入力が作れない');
    const rooms = holdMapRooms(input, AXES);
    const all = rooms.flatMap((c) => [...c]);
    expect(all.every(Number.isFinite)).toBe(true);
    expect(all.some((v) => v < 0)).toBe(true);
    expect(all.some((v) => v >= 0)).toBe(true);
  });
});

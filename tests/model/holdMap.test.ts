/**
 * 追証マップ（#152 段 B・#305。設計 docs/design.md 5.11）の B1〜B5 と #305 の縦軸（ATM の IV の倍率）。
 * 板は合成（tests/support/market.ts。架空の値）。参照値はテストの中で足の σ_base を自前でずらし、marginAt +
 * marginRoom・theoreticalPnl を直接呼ぶ（model/holdMap の足の関数を使わない）。
 */

import { describe, expect, it } from 'vitest';
import {
  HOLD_MAP_C,
  HOLD_MAP_U,
  type HoldMapAxes,
  type HoldMapCalc,
  holdMapAxes,
  holdMapColumn,
  holdMapContour,
  holdMapCount,
  holdMapIvAdd,
  holdMapLegs,
  holdMapLossRooms,
  holdMapPnlColumn,
  holdMapScenario,
  holdMapValueAt,
} from '../../model/holdMap';
import { DEFAULT_MARGIN_PARAMS, type MarginParams, marginAt, marginRoom } from '../../model/margin';
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
import { type IvDynamics, type Scenario, underlyingAt, ZERO_SCENARIO } from '../../model/scenario';
import type { Smile } from '../../model/smile';
import { businessDaysAhead, DAY_MS } from '../../model/time';
import { holdMapCalcOf, holdMapInput, holdMapResultOf } from '../../ui/view/holdMap';
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

/**
 * テストの参照: マス (u, c) の足（#305）。OP の足の σ_base（アンカー + 板のスマイルの差）を自前で作り、
 * Δ_p = c·σ_base(0) − σ_base(x′)（x′ = ln(F′/F)（sticky strike）/ 0（sticky moneyness））だけ平行にずらす
 */
function refLegs(
  prepared: readonly PreparedLeg[],
  u: number,
  c: number,
  dyn: IvDynamics,
  settings: ModelSettings = SETTINGS,
  market: MarketContext = ctx,
): PreparedLeg[] {
  return prepared.map((p) => {
    if (p.leg.kind !== 'option' || !p.option || !Number.isFinite(p.F)) return p;
    const smile = market.options[p.leg.expiry]?.smile ?? null;
    const anchor = p.option.anchor;
    const xk = Math.log(p.leg.strike / p.F);
    const sb = (x: number) => (smile ? anchor + smile.sigma(x) - smile.sigma(xk) : anchor);
    const Fp = underlyingAt(p.F, market.x0, market.x0 * (1 + u), settings.basisMode);
    const xp = dyn === 'sticky_moneyness' || !(Fp > 0) ? 0 : Math.log(Fp / p.F);
    const add = c * sb(0) - sb(xp);
    return { ...p, option: { ...p.option, sigmaBase: (x: number) => sb(x) + add } };
  });
}

/** マスのシナリオ（d・Δs・動き方は base。ΔX = uX₀・absolute・Δσ = 0・β = 0） */
const cellScenario = (base: Scenario, u: number, market: MarketContext = ctx): Scenario => ({
  days: base.days,
  skew: base.skew,
  ivDynamics: base.ivDynamics,
  dX: u * market.x0,
  ivShift: 'absolute',
  dSigma: 0,
  beta: 0,
});

/** 今まで（#305 の前）のマスのシナリオ: 足の IV を一律に c 倍（relative・Δσ = (c − 1) × 100・β = 0） */
const timesCScenario = (base: Scenario, u: number, c: number, market: MarketContext = ctx) => ({
  ...cellScenario(base, u, market),
  ivShift: 'relative' as const,
  dSigma: (c - 1) * 100,
});

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
  const r = marginAt(
    refLegs(p, u, c, base.ivDynamics, settings),
    { x: ctx.x0 * (1 + u), scenario: cellScenario(base, u), horizonDays: h },
    ctx,
    settings,
    params,
  );
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

  it('holdMapScenario は ΔX = uX₀・absolute・Δσ = 0・β = 0、d・Δs・動き方はそのまま', () => {
    const s = holdMapScenario(current, -0.1, 50_000);
    expect(s.dX).toBeCloseTo(-5000, 9);
    expect(s.dSigma).toBe(0);
    expect(s.ivShift).toBe('absolute');
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
      expect(holdMapValueAt(axes, rooms, p.dx, p.ivRatio)).toBeCloseTo(f(p.dx, p.ivRatio), 3);
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
    expect(Number.isNaN(holdMapValueAt(axes, rooms, pts[0]?.dx ?? 0, pts[0]?.ivRatio ?? 0))).toBe(
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
    const { rooms } = holdMapResultOf(input, AXES);
    const all = rooms.flatMap((c) => [...c]);
    expect(all.every(Number.isFinite)).toBe(true);
    expect(all.some((v) => v < 0)).toBe(true);
    expect(all.some((v) => v >= 0)).toBe(true);
  });
});

/** #180: マスの損益と許容損失の境目（損益 = −許容損失） */
describe('#180 マスの損益と許容損失の境目', () => {
  const current: Scenario = { ...ZERO_SCENARIO, days: 3, skew: 1, ivDynamics: 'sticky_moneyness' };
  /** 参照値: (u, c) の d の時点の損益を theoreticalPnl で直接 */
  const pnlRef = (legs: readonly Leg[], u: number, c: number) =>
    theoreticalPnl(
      refLegs(preparePosition(legs, ctx, SETTINGS), u, c, current.ivDynamics),
      ctx.x0 * (1 + u),
      cellScenario(current, u),
      ctx,
      SETTINGS,
    );

  for (const [name, legs] of FORMS) {
    it(`${name}: マスの損益は theoreticalPnl と 1 円以内（全マス）`, () => {
      const input = holdMapInput(baseOf(legs), current, PARAMS, CAPITAL, []);
      if (!input) throw new Error('入力が作れない');
      const calc = holdMapCalcOf(input);
      AXES.us.forEach((u, i) => {
        const col = holdMapPnlColumn(calc, AXES, i);
        AXES.cs.forEach((c, j) => {
          const want = pnlRef(legs, u, c);
          expect(Number.isFinite(want)).toBe(true);
          expect(Math.abs((col[j] as number) - want)).toBeLessThanOrEqual(1);
        });
      });
    });
  }

  it('holdMapLossRooms = 損益 + 許容損失（NaN はそのまま）', () => {
    const r = holdMapLossRooms([Float64Array.from([-500, 100, Number.NaN])], 300);
    expect([...(r[0] as Float64Array)].slice(0, 2)).toEqual([-200, 400]);
    expect(Number.isNaN(r[0]?.[2] as number)).toBe(true);
  });

  it('ショートストラングル: 境目（損益 = −許容損失）の c は、列ごとに theoreticalPnl を二分法で解いた c と ±1 マス以内', () => {
    const legs = FORMS[1]?.[1] ?? [];
    const input = holdMapInput(baseOf(legs), current, PARAMS, CAPITAL, []);
    if (!input) throw new Error('入力が作れない');
    const calc = holdMapCalcOf(input);
    const pnls = AXES.us.map((_, i) => holdMapPnlColumn(calc, AXES, i));
    // 許容損失（架空）: 今の原資産で IV ×1.6 のときの損失 = 境目が軸の中を通る
    const loss = -pnlRef(legs, 0, 1.6);
    expect(loss).toBeGreaterThan(0);
    const segs = holdMapContour(AXES, holdMapLossRooms(pnls, loss));
    expect(segs.length).toBeGreaterThan(5);
    const step = HOLD_MAP_C.step;
    let checked = 0;
    AXES.us.forEach((u) => {
      const f = (c: number) => pnlRef(legs, u, c) + loss;
      const lo0 = AXES.cs[0] as number;
      const hi0 = AXES.cs[AXES.cs.length - 1] as number;
      // 売りだけの足は IV が上がるほど損益が下がる = 列の中で符号が 1 回だけ変わるときに比べる
      if (!(f(lo0) > 0 && f(hi0) < 0)) return;
      let lo = lo0;
      let hi = hi0;
      for (let n = 0; n < 60; n++) {
        const mid = (lo + hi) / 2;
        if (f(mid) > 0) lo = mid;
        else hi = mid;
      }
      const truth = (lo + hi) / 2;
      // この列の上の境目の点（線分の端で u がこの列のもの）
      const onCol = segs.flat().filter(([su]) => Math.abs(su - u) < 1e-12);
      expect(onCol.length, `u=${u}`).toBeGreaterThan(0);
      for (const [, sc] of onCol) expect(Math.abs(sc - truth), `u=${u}`).toBeLessThanOrEqual(step);
      checked++;
    });
    expect(checked).toBeGreaterThan(5);
  });
});

/** #305: 縦軸 = 各限月の ATM の IV の倍率（足の IV = 今のスマイルの上で坂を下る分を除いた平行の上乗せ） */
describe('#305 縦軸は ATM の IV の倍率', () => {
  const DYNS: IvDynamics[] = ['sticky_strike', 'sticky_moneyness'];
  const GRID_U = [-0.3, -0.12, -0.04, 0, 0.06, 0.2];
  const GRID_C = [0.5, 0.8, 1, 1.4, 2.5];

  const opOn = (
    rs: Record<string, NonNullable<(typeof rows)[string]>>,
    month: string,
    type: 'call' | 'put',
    k: number,
    side: 'buy' | 'sell',
  ): Leg => {
    const q = quoteOf(rs[month] ?? [], k, type);
    return {
      kind: 'option',
      product: 'op_large',
      type,
      expiry: month,
      strike: k,
      side,
      qty: 1,
      entry: side === 'buy' ? q.ask : q.bid,
      mid: q.mid,
    };
  };

  function calcFor(
    prepared: readonly PreparedLeg[],
    market: MarketContext,
    base: Scenario,
    settings: ModelSettings = SETTINGS,
  ): HoldMapCalc {
    return {
      legs: prepared,
      ctx: market,
      settings,
      params: PARAMS,
      base,
      horizonDays: businessDaysAhead(market.evalTime + base.days * DAY_MS, 2, []),
      capital: CAPITAL,
      premium: premiumSummary(prepared, settings),
    };
  }

  /** 今まで（足の IV を一律に c 倍）の余力・損益 */
  function timesC(calc: HoldMapCalc, u: number, c: number) {
    const { legs, ctx: m, settings, base, horizonDays, params, capital, premium } = calc;
    const sc = timesCScenario(base, u, c, m);
    const x = m.x0 * (1 + u);
    const r = marginAt(legs, { x, scenario: sc, horizonDays }, m, settings, params);
    return { room: marginRoom(capital, premium, r), pnl: theoreticalPnl(legs, x, sc, m, settings) };
  }

  /** 全マスで今まで（× c）と 1e−6 円以内 */
  function expectSameAsTimesC(calc: HoldMapCalc) {
    const axes: HoldMapAxes = { us: GRID_U, cs: GRID_C };
    GRID_U.forEach((u, i) => {
      const rooms = holdMapColumn(calc, axes, i);
      const pnls = holdMapPnlColumn(calc, axes, i);
      GRID_C.forEach((c, j) => {
        const want = timesC(calc, u, c);
        expect(Number.isFinite(want.room)).toBe(true);
        expect(Math.abs((rooms[j] as number) - want.room), `u=${u} c=${c}`).toBeLessThanOrEqual(
          1e-6,
        );
        expect(Math.abs((pnls[j] as number) - want.pnl), `u=${u} c=${c}`).toBeLessThanOrEqual(1e-6);
      });
    });
  }

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
        smile: flatSmile(M2.days / 365, 0.23),
      },
    },
  };

  it('AC1 平らなスマイル: 建値が ask / bid の足（アンカーがスマイルから外れる）でも余力・損益が今まで（× c）と 1e−6 円', () => {
    const legs = [
      opOn(rows, M1.id, 'put', 62000, 'sell'),
      opOn(rows, M1.id, 'call', 72000, 'buy'),
      opOn(rows, M2.id, 'put', 60000, 'sell'),
      fut('buy', 2),
    ];
    const prepared = preparePosition(legs, flatCtx, SETTINGS);
    // アンカーがスマイル（0.2 / 0.23）の上に無い足がある
    expect(prepared.some((p) => p.option && Math.abs(p.option.anchor - 0.2) > 1e-3)).toBe(true);
    for (const ivDynamics of DYNS) {
      for (const skew of [0, 1.5]) {
        const base: Scenario = { ...ZERO_SCENARIO, days: 2, skew, ivDynamics };
        expectSameAsTimesC(calcFor(prepared, flatCtx, base));
      }
    }
  });

  it('AC5 スマイルの無い足: 今まで（× c）と 1e−6 円', () => {
    const m = makeMarket({ withSmile: false });
    const legs = [
      opOn(m.rows, M1.id, 'put', 63000, 'sell'),
      opOn(m.rows, M1.id, 'call', 72000, 'sell'),
      opOn(m.rows, M2.id, 'put', 61000, 'buy'),
    ];
    const prepared = preparePosition(legs, m.ctx, SETTINGS);
    for (const ivDynamics of DYNS) {
      const base: Scenario = { ...ZERO_SCENARIO, days: 1, skew: -1, ivDynamics };
      expectSameAsTimesC(calcFor(prepared, m.ctx, base));
    }
  });

  /** アンカーがスマイルの上の足（IV を編集した足 = σ_smile(x₀)。a′ = 0） */
  function onSmileLeg(month: string, k: number, type: 'call' | 'put' = 'put'): OptionLeg {
    const m = ctx.options[month];
    if (!m?.smile || !Number.isFinite(m.forward)) throw new Error('スマイルが無い');
    return {
      kind: 'option',
      product: 'op_large',
      type,
      expiry: month,
      strike: k,
      side: 'sell',
      qty: 1,
      entry: 100,
      iv: m.smile.sigma(Math.log(k / m.forward)),
    };
  }

  it('AC2 動いた後の ATM（K = F′）の IV = c × 今の ATM の IV（1e−9。両方の動き方・2 限月）', () => {
    for (const ivDynamics of DYNS) {
      for (const month of [M1.id, M2.id]) {
        const m = ctx.options[month] as MarketContext['options'][string];
        const smile = m.smile as Smile;
        for (const u of [-0.12, -0.05, 0.04]) {
          const Fp = underlyingAt(m.forward, ctx.x0, ctx.x0 * (1 + u), SETTINGS.basisMode);
          const prepared = preparePosition([onSmileLeg(month, Fp)], ctx, SETTINGS);
          for (const c of [0.7, 1, 1.6, 2.4]) {
            const base: Scenario = { ...ZERO_SCENARIO, ivDynamics };
            const legs = holdMapLegs(prepared, u, c, ctx, SETTINGS, ivDynamics);
            const sc = holdMapScenario(base, u, ctx.x0);
            const got = legSigma(legs[0] as PreparedLeg, ctx.x0 * (1 + u), sc, ctx, SETTINGS);
            expect(got).not.toBeNull();
            expect(Math.abs((got as number) - c * smile.sigma(0))).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it('AC3 sticky strike で c = σ(ln(F′/F)) / σ(0) なら、各行使価格の足の IV は今の同じ K の IV（上乗せ 0）', () => {
    const m = ctx.options[M1.id] as MarketContext['options'][string];
    const smile = m.smile as Smile;
    const base: Scenario = { ...ZERO_SCENARIO, ivDynamics: 'sticky_strike' };
    for (const u of [-0.1, -0.04, 0.03]) {
      const Fp = underlyingAt(m.forward, ctx.x0, ctx.x0 * (1 + u), SETTINGS.basisMode);
      const c = smile.sigma(Math.log(Fp / m.forward)) / smile.sigma(0);
      const x = ctx.x0 * (1 + u);
      const sc = holdMapScenario(base, u, ctx.x0);
      for (const k of [56000, 60000, 64000, 67000, 70000]) {
        const prepared = preparePosition([onSmileLeg(M1.id, k)], ctx, SETTINGS);
        const p = prepared[0] as PreparedLeg;
        expect(Math.abs(holdMapIvAdd(p, u, c, ctx, SETTINGS, 'sticky_strike'))).toBeLessThan(1e-12);
        const shifted = holdMapLegs(
          prepared,
          u,
          c,
          ctx,
          SETTINGS,
          'sticky_strike',
        )[0] as PreparedLeg;
        const want = smile.sigma(Math.log(k / m.forward));
        expect(Math.abs((legSigma(shifted, x, sc, ctx, SETTINGS) as number) - want)).toBeLessThan(
          1e-9,
        );
      }
    }
  });

  it('AC7 合成の板からの回復: 実際の IV = 今のスマイル + δ のとき、c を ATM の倍率にすれば各 K の足の IV = 実際（1e−6）', () => {
    const m = ctx.options[M1.id] as MarketContext['options'][string];
    const smile = m.smile as Smile;
    const base: Scenario = { ...ZERO_SCENARIO, ivDynamics: 'sticky_strike' };
    for (const u of [-0.15, -0.06]) {
      const Fp = underlyingAt(m.forward, ctx.x0, ctx.x0 * (1 + u), SETTINGS.basisMode);
      const x = ctx.x0 * (1 + u);
      const sc = holdMapScenario(base, u, ctx.x0);
      for (const delta of [-0.02, 0.03, 0.08]) {
        // 実際（架空）: 動いた後の同じ K の IV = σ_smile(ln(K/F)) + δ。動いた後の ATM の IV = σ(ln(F′/F)) + δ
        const actual = (k: number) => smile.sigma(Math.log(k / m.forward)) + delta;
        const c = actual(Fp) / smile.sigma(0);
        for (const k of [55000, 59000, 62000, 65000, 68000]) {
          const prepared = preparePosition([onSmileLeg(M1.id, k)], ctx, SETTINGS);
          const shifted = holdMapLegs(
            prepared,
            u,
            c,
            ctx,
            SETTINGS,
            'sticky_strike',
          )[0] as PreparedLeg;
          const got = legSigma(shifted, x, sc, ctx, SETTINGS) as number;
          expect(Math.abs(got - actual(k)), `u=${u} δ=${delta} K=${k}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('AC6 軸の端（u = −30%・+20%・−90%、c = ×0.1・×5）で余力・損益は有限か NaN、IV ≥ σ_min（円 / % モード・F′ ≤ 0 の足も）', () => {
    // 2 限月の F を X₀ より大きく下げた市場（円モードで X′ = 0.1X₀ のとき F′ ≤ 0 になる。#144）
    const low: MarketContext = {
      ...ctx,
      options: {
        ...ctx.options,
        [M2.id]: { ...(ctx.options[M2.id] as MarketContext['options'][string]), forward: 58_000 },
      },
    };
    const legs: Leg[] = [
      { ...onSmileLeg(M1.id, 62000), iv: 0.25 },
      { ...onSmileLeg(M2.id, 52000), iv: 0.3 },
      { ...onSmileLeg(M2.id, 64000, 'call'), iv: 0.18, side: 'buy' },
      fut('sell', 1),
    ];
    for (const basisMode of ['yen', 'pct'] as const) {
      const settings: ModelSettings = { ...SETTINGS, basisMode };
      const prepared = preparePosition(legs, low, settings);
      for (const ivDynamics of DYNS) {
        const base: Scenario = { ...ZERO_SCENARIO, days: 1, skew: 1, ivDynamics };
        const calc = calcFor(prepared, low, base, settings);
        const axes: HoldMapAxes = { us: [-0.9, -0.3, 0.2], cs: [0.1, 1, 5] };
        axes.us.forEach((u, i) => {
          for (const col of [holdMapColumn(calc, axes, i), holdMapPnlColumn(calc, axes, i)]) {
            for (const v of col) expect(Number.isFinite(v) || Number.isNaN(v)).toBe(true);
          }
          const sc = holdMapScenario(base, u, low.x0);
          for (const c of axes.cs) {
            for (const p of prepared) {
              expect(Number.isFinite(holdMapIvAdd(p, u, c, low, settings, ivDynamics))).toBe(true);
            }
            for (const p of holdMapLegs(prepared, u, c, low, settings, ivDynamics)) {
              const sg = legSigma(p, low.x0 * (1 + u), sc, low, settings);
              if (sg !== null) expect(sg).toBeGreaterThanOrEqual(settings.sigmaMin);
            }
          }
        });
      }
    }
    // 円モード・u = −90% で 2 限月の F′ ≤ 0 になっている（守りの枝を通った）
    expect(underlyingAt(58_000, ctx.x0, ctx.x0 * 0.1, 'yen')).toBeLessThan(0);
  });

  it('先物・F が決まらない足はずらさない（同じ参照・上乗せ 0）', () => {
    const prepared = preparePosition([fut('buy', 1), op('put', 62000, 'sell')], ctx, SETTINGS);
    const legs = holdMapLegs(prepared, -0.1, 1.5, ctx, SETTINGS, 'sticky_strike');
    expect(legs[0]).toBe(prepared[0]);
    expect(legs[1]).not.toBe(prepared[1]);
    expect(
      holdMapIvAdd(prepared[0] as PreparedLeg, -0.1, 1.5, ctx, SETTINGS, 'sticky_strike'),
    ).toBe(0);
    const noF: MarketContext = {
      ...ctx,
      options: {
        ...ctx.options,
        [M1.id]: {
          ...(ctx.options[M1.id] as MarketContext['options'][string]),
          forward: Number.NaN,
        },
      },
    };
    const p = preparePosition([op('put', 62000, 'sell')], noF, SETTINGS)[0] as PreparedLeg;
    expect(holdMapIvAdd(p, -0.1, 1.5, noF, SETTINGS, 'sticky_strike')).toBe(0);
    expect(holdMapLegs([p], -0.1, 1.5, noF, SETTINGS, 'sticky_strike')[0]).toBe(p);
  });
});

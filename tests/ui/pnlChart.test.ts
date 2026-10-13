import { describe, expect, it } from 'vitest';
import { boardOptionLeg, type Chain, type ChainJson, normalizeChain } from '../../data';
import {
  DAY_MS,
  expiryProfile,
  type Leg,
  type OptionType,
  preparePosition,
  type Scenario,
  type Side,
  sqInstant,
  theoreticalPnl,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Domain, extent, linear, zoomAt } from '../../ui/chart/scale';
import { type Action, initialState, reduce, type UiLeg } from '../../ui/state';
import { boardRows, jumpToOtm, referencePrice } from '../../ui/view/board';
import {
  clippedPath,
  DEFAULT_PNL_Y,
  fmtPnlTick,
  hasDateLine,
  maxScenarioDays,
  type PnlBase,
  type PnlChartModel,
  type PnlYSettings,
  pnlChartModel,
  pnlDomains,
  pnlViewDomain,
  todayLine,
  todayScenario,
  zoomViewport,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';
import { M1, M2, makeMarket } from '../support/market';

/** #11 AC-4〜AC-9: 損益グラフの表示モデル。合成の板（架空の値）。 */
const latest = normalizeChain(fixture('latest'));
const [m1, m2] = latest.months;
if (!m1 || !m2) throw new Error('限月が無い');

const PLOT_W = 1000;
const PLOT_H = 200;

interface LegSpec {
  expiry: string;
  k: number;
  type: OptionType;
  side: Side;
  entry?: number;
}

function uiLegs(chain: Chain, specs: LegSpec[]): UiLeg[] {
  return specs.map((s, i) => {
    const built = boardOptionLeg(chain, s);
    return { id: i + 1, leg: built.leg, marks: built.marks };
  });
}

function baseOf(chain: Chain, legs: UiLeg[]): PnlBase {
  const pm = positionModel(chain, legs, 'B', CALENDAR);
  const base = pnlDomains(chain, pm.prepared, pm.ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  return base;
}

function chartOf(
  base: PnlBase | null,
  opts: {
    days?: number;
    viewport?: Domain | null;
    pnlY?: PnlYSettings;
    plotWidth?: number;
    scenario?: Scenario;
  } = {},
): PnlChartModel {
  return pnlChartModel({
    base,
    scenario: { ...(opts.scenario ?? ZERO_SCENARIO), days: opts.days ?? 0 },
    viewport: opts.viewport ?? null,
    pnlY: opts.pnlY ?? DEFAULT_PNL_Y,
    plotWidth: opts.plotWidth ?? PLOT_W,
    plotHeight: PLOT_H,
  });
}

/** 座標・値がすべて有限か */
function allFinite(m: PnlChartModel): boolean {
  const nums = [
    ...m.domain,
    ...m.yDomain,
    ...m.lines.flatMap((l) => [...l.xs, ...l.ys]),
    ...m.kinks.flatMap((k) => [k.x, k.y, k.px, k.py]),
    ...m.breakevens.flatMap((b) => [b.x, b.px, b.py]),
    ...m.xTicks.map((t) => t.px),
    ...m.yTicks.map((t) => t.px),
    m.x0Px ?? 0,
    m.zeroPy ?? 0,
    m.days,
    m.maxDays,
  ];
  return nums.every(Number.isFinite) && m.lines.every((l) => !/NaN|Infinity/.test(l.d));
}

/** 板の横軸上の行使価格の位置 K − basis_i（F が決まる限月） */
function boardXs(chain: Chain, x0: number): number[] {
  return chain.months
    .filter((m) => Number.isFinite(m.F))
    .flatMap((m) => m.rows.map((r) => r.k - (m.F - x0)));
}

const x0 = referencePrice(m1, 'B') as number;
const k30 = jumpToOtm(boardRows(latest, m1), 'put', x0, 0.3) as number;

describe('横軸の範囲（AC-4）', () => {
  const legs = uiLegs(latest, [
    { expiry: m1.id, k: k30, type: 'put', side: 'sell', entry: 30 },
    { expiry: m1.id, k: 72_000, type: 'call', side: 'sell' },
    { expiry: m2.id, k: 60_000, type: 'put', side: 'buy' },
  ]);
  const base = baseOf(latest, legs);

  it('初期範囲は X₀ と全足の折れ点 K − basis_i と満期の BEP（#6）を含み、両端に余白（全域の端を除く）', () => {
    const { initial, full, profile } = base;
    const core = extent([base.ctx.x0, ...profile.kinks, ...profile.breakevens]) as Domain;
    expect(initial[0]).toBeLessThanOrEqual(core[0]);
    expect(initial[1]).toBeGreaterThanOrEqual(core[1]);
    const pad = Math.max((core[1] - core[0]) * 0.15, base.ctx.x0 * 0.02);
    expect(initial[0]).toBeCloseTo(Math.max(core[0] - pad, full[0]), 6);
    expect(initial[1]).toBeCloseTo(Math.min(core[1] + pad, full[1]), 6);
    expect(initial[0]).toBeLessThan(core[0]);
    expect(initial[1]).toBeGreaterThan(core[1]);
    // 2 限月の折れ点は K − basis_2
    const basis2 = m2.F - base.ctx.x0;
    expect(profile.kinks).toContainEqual(60_000 - basis2);
  });

  it('全域 = 板の全限月の K − basis_i と初期範囲の和、下端は X_lo 以上', () => {
    const xs = boardXs(latest, base.ctx.x0);
    const raw = extent([...xs, ...base.initial]) as Domain;
    expect(base.full[0]).toBeCloseTo(Math.max(raw[0], base.xLo), 9);
    expect(base.full[1]).toBeCloseTo(raw[1], 9);
    expect(base.full[0]).toBeGreaterThanOrEqual(base.xLo);
    expect(base.full[0]).toBeLessThanOrEqual(base.initial[0]);
    expect(base.full[1]).toBeGreaterThanOrEqual(base.initial[1]);
    // 最小幅 = 行使価格の最小刻み（合成の板は 125 円）× 2
    expect(base.minWidth).toBe(250);
  });

  it('縮小を繰り返すと全域でちょうど止まり、拡大を繰り返すと最小幅で止まる（表示モデル経由）', () => {
    let vp: Domain = base.initial;
    for (let i = 0; i < 80; i++) vp = zoomAt(vp, 1.1, x0, base.full, base.minWidth);
    expect(chartOf(base, { viewport: vp }).domain).toEqual(base.full);
    for (let i = 0; i < 300; i++) vp = zoomAt(vp, 1 / 1.1, x0, base.full, base.minWidth);
    const m = chartOf(base, { viewport: vp });
    expect(m.domain[1] - m.domain[0]).toBeCloseTo(250, 6);
    expect(allFinite(m)).toBe(true);
  });

  it('全域の外の表示範囲は収める', () => {
    const m = chartOf(base, { viewport: [-1e6, -1e6 + 5_000] });
    expect(m.domain[0]).toBe(base.full[0]);
    expect(m.domain[1]).toBeCloseTo(base.full[0] + 5_000, 6);
  });
});

describe('縦軸の 3 モード（AC-5）', () => {
  const legs = uiLegs(latest, [
    { expiry: m1.id, k: 64_000, type: 'put', side: 'sell' },
    { expiry: m1.id, k: 71_000, type: 'call', side: 'sell' },
  ]);
  const base = baseOf(latest, legs);

  it('自動: 表示範囲内の全線のサンプル値と 0 を含む。左端へパンすると左端の満期損益を含む', () => {
    for (const days of [0, 10]) {
      const m = chartOf(base, { days });
      const ys = m.lines.flatMap((l) => l.ys);
      for (const y of [0, ...ys]) {
        expect(y).toBeGreaterThanOrEqual(m.yDomain[0]);
        expect(y).toBeLessThanOrEqual(m.yDomain[1]);
      }
    }
    const left: Domain = [base.full[0], base.full[0] + 4_000];
    const m = chartOf(base, { viewport: left, days: 5 });
    const atLeft = base.expiry(base.full[0]);
    expect(atLeft).toBeLessThan(chartOf(base).yDomain[0]); // 初期範囲の縦軸には入っていない
    expect(m.yDomain[0]).toBeLessThanOrEqual(atLeft);
  });

  it('手動: 下端 < 上端の範囲そのもの', () => {
    const m = chartOf(base, { pnlY: { mode: 'manual', manual: [-50_000, 80_000], n: 5 } });
    expect(m.yDomain).toEqual([-50_000, 80_000]);
  });

  it('プレミアム基準: N = 5 で ±5 × |受取 − 支払|', () => {
    const net = base.net;
    expect(net).toBeGreaterThan(0);
    const m = chartOf(base, { pnlY: { mode: 'premium', manual: null, n: 5 } });
    expect(m.yDomain).toEqual([-5 * net, 5 * net]);
    expect(m.premiumFallback).toBe(false);
    const m3 = chartOf(base, { pnlY: { mode: 'premium', manual: null, n: 3 } });
    expect(m3.yDomain).toEqual([-3 * net, 3 * net]);
  });

  it('プレミアム 0（同じ建値の買いと売り）: 自動の範囲と「プレミアム 0 のため自動」の印', () => {
    const zero = baseOf(
      latest,
      uiLegs(latest, [
        { expiry: m1.id, k: 64_000, type: 'put', side: 'sell', entry: 500 },
        { expiry: m1.id, k: 64_000, type: 'put', side: 'buy', entry: 500 },
      ]),
    );
    expect(zero.net).toBe(0);
    const p = chartOf(zero, { pnlY: { mode: 'premium', manual: null, n: 5 } });
    const a = chartOf(zero);
    expect(p.premiumFallback).toBe(true);
    expect(p.yDomain).toEqual(a.yDomain);
  });

  it('縦軸の目盛り: 10 万円以上は千円、未満は円', () => {
    const big = chartOf(base, { pnlY: { mode: 'manual', manual: [-300_000, 300_000], n: 5 } });
    expect(big.yUnit).toBe('thousand');
    expect(big.yTicks.map((t) => t.label)).toContain('−200');
    const small = chartOf(base, { pnlY: { mode: 'manual', manual: [-50_000, 50_000], n: 5 } });
    expect(small.yUnit).toBe('yen');
    expect(small.yTicks.map((t) => t.label)).toContain('−40,000');
    expect(fmtPnlTick(150_000, 'thousand', 50_000)).toBe('150');
    expect(fmtPnlTick(100_500, 'thousand', 500)).toBe('100.5');
  });
});

describe('小さい損益（AC-6。U4 のファー OTM）', () => {
  it('(a) OTM 30% の put を 30 円で 1 枚売り: ±5 倍で折れ点の山が描画高さの 10%、自動では 2% 未満', () => {
    expect(k30).toBe(47_000);
    const base = baseOf(
      latest,
      uiLegs(latest, [{ expiry: m1.id, k: k30, type: 'put', side: 'sell', entry: 30 }]),
    );
    expect(base.net).toBe(30_000);
    const kink = k30 - (m1.F - base.ctx.x0);
    expect(base.profile.breakevens).toEqual([Math.round(kink - 30)]);
    const prem = chartOf(base, { pnlY: { mode: 'premium', manual: null, n: 5 } });
    expect(prem.yDomain).toEqual([-150_000, 150_000]);
    // 初期範囲に折れ点と BEP
    expect(prem.kinks.map((k) => k.x)).toContain(kink);
    expect(prem.breakevens.map((b) => b.x)).toContain(Math.round(kink - 30));
    const k = prem.kinks.find((p) => p.x === kink);
    expect(k?.y).toBeCloseTo(30_000, 6);
    const diff = Math.abs((prem.zeroPy as number) - (k?.py as number));
    expect(Math.abs(diff - PLOT_H * 0.1)).toBeLessThanOrEqual(1);
    // 自動では潰れる
    const auto = chartOf(base);
    const ka = auto.kinks.find((p) => p.x === kink);
    expect(Math.abs((auto.zeroPy as number) - (ka?.py as number))).toBeLessThan(PLOT_H * 0.02);
    // 横軸を折れ点 ±500 円に拡大すると、描画幅 1,000px で折れ点と BEP が 20px 以上離れる
    const zoomed = chartOf(base, {
      viewport: [kink - 500, kink + 500],
      pnlY: { mode: 'premium', manual: null, n: 5 },
    });
    const kz = zoomed.kinks.find((p) => p.x === kink);
    const bz = zoomed.breakevens[0];
    expect(Math.abs((kz?.px as number) - (bz?.px as number))).toBeGreaterThanOrEqual(20);
  });

  it('(b) 5 円の put を 1 枚買い: ±5 倍で [−25,000, +25,000]', () => {
    const base = baseOf(
      latest,
      uiLegs(latest, [{ expiry: m1.id, k: 39_000, type: 'put', side: 'buy', entry: 5 }]),
    );
    expect(base.net).toBe(-5_000);
    const m = chartOf(base, { pnlY: { mode: 'premium', manual: null, n: 5 } });
    expect(m.yDomain).toEqual([-25_000, 25_000]);
  });
});

describe('線（AC-7）', () => {
  const legs = uiLegs(latest, [
    { expiry: m1.id, k: 64_000, type: 'put', side: 'sell' },
    { expiry: m1.id, k: 71_000, type: 'call', side: 'sell' },
    { expiry: m1.id, k: 60_000, type: 'put', side: 'buy' },
  ]);
  const base = baseOf(latest, legs);

  it('満期の頂点に表示範囲内の折れ点がすべて入り、値は expiryProfile と 1 円で一致', () => {
    const m = chartOf(base, { viewport: [62_000, 75_000] });
    const ex = m.lines.find((l) => l.kind === 'expiry');
    if (!ex) throw new Error('満期の線が無い');
    const inside = base.profile.kinks.filter((k) => k >= 62_000 && k <= 75_000);
    expect(inside.length).toBeGreaterThanOrEqual(2);
    for (const k of inside) expect(ex.xs).toContain(k);
    expect([...ex.xs].sort((a, b) => a - b)).toEqual(ex.xs);
    const prof = expiryProfile(base.legs, base.ctx);
    for (const p of prof.points) {
      const i = ex.xs.indexOf(p.x);
      if (i >= 0) expect(Math.abs((ex.ys[i] as number) - p.pnl)).toBeLessThanOrEqual(1);
    }
    for (let i = 0; i < ex.xs.length; i++) {
      expect(Math.abs((ex.ys[i] as number) - base.expiry(ex.xs[i] as number))).toBeLessThan(1);
    }
  });

  it('指定日・今日の点数 = 描画幅の px（2〜2,000）、各点は theoreticalPnl と一致', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, days: 7.5 };
    for (const [w, n] of [
      [PLOT_W, 1000],
      [333.4, 333],
      [3000, 2000],
      [1, 2],
    ] as const) {
      const m = chartOf(base, { days: 7.5, plotWidth: w });
      const date = m.lines.find((l) => l.kind === 'date');
      const today = m.lines.find((l) => l.kind === 'today');
      expect(date?.xs.length).toBe(n);
      expect(today?.xs.length).toBe(n);
      for (let i = 0; i < n; i += 37) {
        const x = date?.xs[i] as number;
        expect(date?.ys[i]).toBe(theoreticalPnl(base.legs, x, sc, base.ctx));
        expect(today?.ys[i]).toBe(theoreticalPnl(base.legs, x, ZERO_SCENARIO, base.ctx));
      }
      expect(date?.xs[0]).toBe(m.domain[0]);
      expect(date?.xs[n - 1]).toBe(m.domain[1]);
    }
  });

  it('d = 0 で線 2 本（満期・今日）、d > 0 で 3 本', () => {
    expect(chartOf(base, { days: 0 }).lines.map((l) => l.kind)).toEqual(['expiry', 'today']);
    expect(chartOf(base, { days: 3 }).lines.map((l) => l.kind)).toEqual([
      'expiry',
      'date',
      'today',
    ]);
  });

  it('カレンダー（1 限月売り + 2 限月買い）: 満期の頂点に K − basis_1 と K − basis_2。d = 2 限月の SQ で指定日 = 満期', () => {
    const cal = baseOf(
      latest,
      uiLegs(latest, [
        { expiry: m1.id, k: 66_000, type: 'put', side: 'sell' },
        { expiry: m2.id, k: 66_000, type: 'put', side: 'buy' },
      ]),
    );
    const k1 = 66_000 - (m1.F - cal.ctx.x0);
    const k2 = 66_000 - (m2.F - cal.ctx.x0);
    expect(k1).not.toBe(k2);
    const days = (m2.sqTime - latest.evalTime) / DAY_MS;
    expect(cal.maxDays).toBeCloseTo(days, 9);
    const m = chartOf(cal, { days });
    const ex = m.lines.find((l) => l.kind === 'expiry');
    expect(ex?.xs).toContain(k1);
    expect(ex?.xs).toContain(k2);
    const date = m.lines.find((l) => l.kind === 'date');
    if (!date) throw new Error('指定日の線が無い');
    for (let i = 0; i < date.xs.length; i++) {
      expect(
        Math.abs((date.ys[i] as number) - cal.expiry(date.xs[i] as number)),
      ).toBeLessThanOrEqual(1);
    }
  });

  it('d は最遠の足の SQ までに収め、その旨を出す', () => {
    const m = chartOf(base, { days: 1_000 });
    expect(m.daysClamped).toBe(true);
    expect(m.days).toBeCloseTo(base.maxDays, 9);
    expect(chartOf(base, { days: 3 }).daysClamped).toBe(false);
  });
});

describe('指定日 d の上限（AC-8）', () => {
  it('maxScenarioDays = 最遠の足の SQ までの暦日、足 0 本は 0', () => {
    const pm = positionModel(
      latest,
      uiLegs(latest, [
        { expiry: m1.id, k: 64_000, type: 'put', side: 'sell' },
        { expiry: m2.id, k: 64_000, type: 'put', side: 'sell' },
      ]),
      'B',
      CALENDAR,
    );
    expect(maxScenarioDays(pm.prepared)).toBeCloseTo((m2.sqTime - latest.evalTime) / DAY_MS, 9);
    expect(maxScenarioDays([])).toBe(0);
    expect(pnlDomains(latest, [], pm.ctx)).toBeNull();
  });
});

describe('壊れた板・少ない板・満期直前（AC-9）', () => {
  function stateWithLegs(chain: Chain) {
    const actions: Action[] = [];
    for (const m of chain.months) {
      const k = m.atm.B.pick?.k ?? m.rows[Math.floor(m.rows.length / 2)]?.k ?? 0;
      actions.push(
        { type: 'addBoardLeg', expiry: m.id, k, optionType: 'put', side: 'sell' },
        { type: 'addBoardLeg', expiry: m.id, k: k + 1000, optionType: 'call', side: 'buy' },
      );
    }
    actions.push({ type: 'addFutureLeg', input: { side: 'buy', qty: 1 } });
    return actions.reduce(reduce, reduce(initialState, { type: 'loaded', chain, label: 't' }));
  }

  function check(chain: Chain, legs: UiLeg[], daysList: number[]) {
    const pm = positionModel(chain, legs, 'B', CALENDAR);
    const base = pnlDomains(chain, pm.prepared, pm.ctx);
    if (!base) throw new Error('基礎が作れない');
    for (const days of daysList) {
      for (const pnlY of [
        DEFAULT_PNL_Y,
        { mode: 'premium', manual: null, n: 5 } as const,
        { mode: 'manual', manual: [-1e5, 1e5], n: 5 } as const,
      ]) {
        const m = chartOf(base, { days, pnlY });
        expect(m.empty).toBe(false);
        expect(allFinite(m)).toBe(true);
      }
      const zoomed = chartOf(base, { days, viewport: [base.full[0], base.full[0] + 100] });
      expect(allFinite(zoomed)).toBe(true);
    }
    return base;
  }

  it('足 0 本: empty で例外なし', () => {
    const m = chartOf(null, { days: 3 });
    expect(m.empty).toBe(true);
    expect(m.lines).toEqual([]);
    expect(allFinite(m)).toBe(true);
  });

  it('night_early（行使価格が少ない）', () => {
    const chain = normalizeChain(fixture('night_early'));
    const s = stateWithLegs(chain);
    check(chain, s.legs, [0, 1, 1e9]);
  });

  it('気配を消して F が NaN の限月の足は除いて描く', () => {
    const s = stateWithLegs(latest);
    const json: ChainJson = fixture('latest');
    json.future.price = null;
    json.future.price_time = null;
    const last = json.months[1];
    if (!last) throw new Error('限月が無い');
    for (const r of last.rows) {
      for (const q of [r.call, r.put]) {
        q.bid = null;
        q.ask = null;
        q.price = null;
      }
    }
    const broken = normalizeChain(json);
    expect(Number.isNaN(broken.months[1]?.F)).toBe(true);
    const s2 = reduce(s, { type: 'loaded', chain: broken, label: 'broken' });
    const base = check(broken, s2.legs, [0, 5, 100]);
    // 2 限月の足（F なし）だけ除く。先物の足は足に持たせた市場で評価できる
    expect(base.legs.map((p) => (p.leg.kind === 'option' ? p.leg.expiry : 'future'))).toEqual([
      m1.id,
      m1.id,
      'future',
    ]);
    expect(s2.legs).toHaveLength(5);
  });

  it('評価時刻 = 1 限月の SQ 日 9:00 の 1 分前、および d = 1 限月の SQ ちょうど', () => {
    const json = fixture('latest');
    const sq1 = sqInstant(json.months[0]?.sq_date as string);
    const chain = normalizeChain(json, { evalTime: sq1 - 60_000 });
    const s = stateWithLegs(chain);
    check(chain, s.legs, [0, 1 / 1440, 1 / 2880, 10]);
    const s0 = stateWithLegs(latest);
    check(latest, s0.legs, [(m1.sqTime - latest.evalTime) / DAY_MS]);
  });
});

describe('画素', () => {
  it('X₀ の縦線と 0 の横線は描画域の中の画素', () => {
    const base = baseOf(
      latest,
      uiLegs(latest, [{ expiry: m1.id, k: 64_000, type: 'put', side: 'sell' }]),
    );
    const m = chartOf(base);
    const sx = linear(m.domain, [m.plot.left, m.plot.left + m.plot.width]);
    expect(m.x0Px).toBeCloseTo(sx(base.ctx.x0), 9);
    expect(m.zeroPy).toBeGreaterThanOrEqual(m.plot.top);
    expect(m.zeroPy).toBeLessThanOrEqual(m.plot.top + m.plot.height);
  });
});

/** path の頂点（M / L の座標）を読む */
function pathPoints(d: string): Array<[number, number]> {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** 点から折れ線までの距離（画素）。急な線では縦の差より意味がある（x の丸め 0.05px が縦に増幅されない） */
function distToPath(points: Array<[number, number]>, px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1] as [number, number];
    const [x2, y2] = points[i] as [number, number];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(Math.max(((px - x1) * dx + (py - y1) * dy) / len2, 0), 1) : 0;
    best = Math.min(best, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
  }
  return best;
}

describe('描く座標（path）が解析解と一致する（Phase 4 #1）', () => {
  function check(m: PnlChartModel, base: PnlBase, kinds: Array<'expiry' | 'date' | 'today'>) {
    const { left, top, width, height } = m.plot;
    const sx = linear(m.domain, [left, left + width]);
    const sy = linear(m.yDomain, [top + height, top]);
    let checked = 0;
    for (const kind of kinds) {
      const line = m.lines.find((l) => l.kind === kind);
      if (!line) throw new Error(`線が無い: ${kind}`);
      const pts = pathPoints(line.d);
      // 描画域の中に見える部分: 横 2,000 点で、解析解（満期）/ サンプル値の線形補間（指定日・今日）と 1px 以内
      for (let i = 0; i <= 2000; i++) {
        const x = m.domain[0] + ((m.domain[1] - m.domain[0]) * i) / 2000;
        let v: number;
        if (kind === 'expiry') v = base.expiry(x);
        else {
          const j = Math.min(
            Math.max(
              line.xs.findIndex((u) => u >= x),
              1,
            ),
            line.xs.length - 1,
          );
          const x1 = line.xs[j - 1] as number;
          const x2 = line.xs[j] as number;
          const y1 = line.ys[j - 1] as number;
          const y2 = line.ys[j] as number;
          v = y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
        }
        const want = sy(v);
        if (want < top || want > top + height) continue;
        expect(distToPath(pts, sx(x), want)).toBeLessThanOrEqual(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }

  const put = () =>
    baseOf(
      latest,
      uiLegs(latest, [{ expiry: m1.id, k: 47_000, type: 'put', side: 'sell', entry: 30 }]),
    );

  it('K 47,000 の put を 30 円で売り・±5 倍・横軸全域: 下端を横切る位置と BEP の印が線上（1px）', () => {
    const base = put();
    const m = chartOf(base, {
      viewport: base.full,
      pnlY: { mode: 'premium', manual: null, n: 5 },
      days: 10,
    });
    expect(m.domain).toEqual(base.full);
    const { left, top, width, height } = m.plot;
    const sx = linear(m.domain, [left, left + width]);
    const ex = pathPoints(m.lines.find((l) => l.kind === 'expiry')?.d ?? '');
    // 満期損益 = −150,000 円になる X = BEP − 150（傾き 1,000 円 / 円）
    const bep = base.profile.breakevens[0] as number;
    const truePx = sx(bep - 150);
    const bottom = top + height;
    let crossPx: number | null = null;
    for (let i = 1; i < ex.length; i++) {
      const [x1, y1] = ex[i - 1] as [number, number];
      const [x2, y2] = ex[i] as [number, number];
      if ((y1 - bottom) * (y2 - bottom) <= 0 && y1 !== y2) {
        crossPx = x1 + ((x2 - x1) * (bottom - y1)) / (y2 - y1);
        break;
      }
    }
    expect(crossPx).not.toBeNull();
    expect(Math.abs((crossPx as number) - truePx)).toBeLessThanOrEqual(1);
    // BEP の印の位置で満期の線の y が 0 の画素
    const b = m.breakevens[0];
    expect(distToPath(ex, b?.px as number, m.zeroPy as number)).toBeLessThanOrEqual(1);
    expect(Math.abs((b?.py as number) - (m.zeroPy as number))).toBeLessThanOrEqual(1e-9);
    check(m, base, ['expiry', 'date', 'today']);
  });

  it('自動・手動の狭い範囲・初期範囲でも、描画域の中の線は解析解と 1px 以内', () => {
    const base = put();
    for (const pnlY of [
      DEFAULT_PNL_Y,
      { mode: 'manual', manual: [-5_000, 40_000], n: 5 } as const,
      { mode: 'premium', manual: null, n: 1 } as const,
    ]) {
      for (const viewport of [null, base.full]) {
        check(chartOf(base, { viewport, pnlY, days: 5 }), base, ['expiry', 'date', 'today']);
      }
    }
    // カレンダー（折れ点 2 つ）も
    const cal = baseOf(
      latest,
      uiLegs(latest, [
        { expiry: m1.id, k: 66_000, type: 'put', side: 'sell' },
        { expiry: m2.id, k: 66_000, type: 'put', side: 'buy' },
      ]),
    );
    check(
      chartOf(cal, {
        viewport: cal.full,
        pnlY: { mode: 'manual', manual: [-300_000, 300_000], n: 5 },
      }),
      cal,
      ['expiry', 'today'],
    );
  });

  it('clippedPath: 境を横切る点を足し、内側の形を保つ。非有限は境に置く', () => {
    // (0, 50) → (100, 250) を [0, 100] に収める: 境 y = 100 を x = 25 で横切る
    expect(pathPoints(clippedPath([0, 100], [50, 250], 0, 100))).toEqual([
      [0, 50],
      [25, 100],
      [100, 100],
    ]);
    // 両方の境を横切る（上から下へ）
    expect(pathPoints(clippedPath([0, 100], [-100, 200], 0, 100))).toEqual([
      [0, 0],
      [33.3, 0],
      [66.7, 100],
      [100, 100],
    ]);
    expect(clippedPath([0, 1], [Number.NEGATIVE_INFINITY, Number.NaN], 0, 100)).toBe(
      'M0.0 0.0L1.0 100.0',
    );
  });
});

describe('シナリオと線（#6）', () => {
  const legs = uiLegs(latest, [
    { expiry: m1.id, k: 64_000, type: 'put', side: 'sell' },
    { expiry: m1.id, k: 71_000, type: 'call', side: 'sell' },
    { expiry: m2.id, k: 60_000, type: 'put', side: 'buy' },
  ]);
  const base = baseOf(latest, legs);
  const lineOf = (m: PnlChartModel, kind: 'date' | 'today') => m.lines.find((l) => l.kind === kind);

  it('今日の線はシナリオ IV を掛けない（d = ΔX = Δσ = Δs = 0）。β と動き方は横軸の各点に効く', () => {
    const sc: Scenario = {
      ...ZERO_SCENARIO,
      days: 3,
      dX: -2_000,
      dSigma: 5,
      skew: 2,
      beta: 0,
      ivDynamics: 'sticky_moneyness',
    };
    expect(todayScenario(sc)).toEqual({ ...sc, days: 0, dX: 0, dSigma: 0, skew: 0 });
    const m = chartOf(base, { scenario: sc, days: 3 });
    const today = lineOf(m, 'today');
    const want = todayScenario(sc);
    today?.xs.forEach((x, i) => {
      expect(today.ys[i]).toBe(theoreticalPnl(base.legs, x, want, base.ctx));
    });
    // β = 0 と β = 1 で今日の線は変わる（X₀ から離れた点）
    const b1 = lineOf(chartOf(base, { scenario: { ...sc, beta: 1 }, days: 3 }), 'today');
    expect(b1?.ys[0]).not.toBeCloseTo(today?.ys[0] as number, 0);
    // d・ΔX・Δσ・Δs を動かしても今日の線は同じ
    const moved = lineOf(
      chartOf(base, { scenario: { ...sc, dX: 1_000, dSigma: -3, skew: -1 }, days: 9 }),
      'today',
    );
    expect(moved?.ys).toEqual(today?.ys);
  });

  it('指定日の線（シナリオ全体）は d > 0 または Δσ・Δs ≠ 0 のときだけ。ΔX だけでは描かない', () => {
    const kinds = (sc: Partial<Scenario>) =>
      chartOf(base, { scenario: { ...ZERO_SCENARIO, ...sc }, days: sc.days ?? 0 }).lines.map(
        (l) => l.kind,
      );
    expect(kinds({})).toEqual(['expiry', 'today']);
    expect(kinds({ dX: -3_000 })).toEqual(['expiry', 'today']);
    expect(kinds({ dSigma: -3 })).toEqual(['expiry', 'date', 'today']);
    expect(kinds({ skew: 0.5 })).toEqual(['expiry', 'date', 'today']);
    expect(kinds({ days: 1 })).toEqual(['expiry', 'date', 'today']);
    expect(hasDateLine(ZERO_SCENARIO, 0)).toBe(false);
    // d = 0・Δσ −3pt（U2 の手順 2）: 指定日の線は今日と異なり、各点は theoreticalPnl
    const sc: Scenario = { ...ZERO_SCENARIO, dSigma: -3 };
    const m = chartOf(base, { scenario: sc, days: 0 });
    const date = lineOf(m, 'date');
    const today = lineOf(m, 'today');
    date?.xs.forEach((x, i) => {
      expect(date.ys[i]).toBe(theoreticalPnl(base.legs, x, sc, base.ctx));
    });
    expect(date?.ys.some((y, i) => Math.abs(y - (today?.ys[i] as number)) > 1)).toBe(true);
  });

  it('前計算した今日の線（todayLine）を渡すと同じモデル。点数が合わなければ自分で作る', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, days: 4, dSigma: 2, beta: 1.5 };
    const viewport: Domain = [60_000, 75_000];
    const pre = todayLine(base, viewport, PLOT_W, sc);
    const plain = chartOf(base, { scenario: sc, days: 4, viewport });
    const withPre = pnlChartModel({
      base,
      scenario: sc,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
      todayYs: pre,
    });
    expect(withPre).toEqual(plain);
    const wrong = pnlChartModel({
      base,
      scenario: sc,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
      todayYs: [1, 2, 3],
    });
    expect(wrong).toEqual(plain);
    expect(todayLine(null, null, PLOT_W, sc)).toBeNull();
  });

  it('シナリオ点 X₀ + ΔX の縦線（ΔX ≠ 0 で範囲内のとき）', () => {
    const m = chartOf(base, { scenario: { ...ZERO_SCENARIO, dX: -2_000 } });
    expect(m.scenarioX).toBeCloseTo(base.ctx.x0 - 2_000, 9);
    const want =
      m.plot.left + ((m.scenarioX - m.domain[0]) / (m.domain[1] - m.domain[0])) * m.plot.width;
    expect(m.scenarioPx).toBeCloseTo(want, 6);
    expect(chartOf(base).scenarioPx).toBeNull();
    const out = chartOf(base, {
      scenario: { ...ZERO_SCENARIO, dX: -2_000 },
      viewport: [base.ctx.x0, base.ctx.x0 + 5_000],
    });
    expect(out.scenarioPx).toBeNull();
  });

  it('パネルの + / − は中心固定で ×0.8 / ×1.25（全域・最小幅で止まる）', () => {
    const v = pnlViewDomain(base, null);
    const zin = zoomViewport(base, null, 0.8);
    expect(zin[1] - zin[0]).toBeCloseTo((v[1] - v[0]) * 0.8, 6);
    expect((zin[0] + zin[1]) / 2).toBeCloseTo((v[0] + v[1]) / 2, 6);
    let w: Domain = v;
    for (let i = 0; i < 60; i++) w = zoomViewport(base, w, 1.25);
    expect(w).toEqual(base.full);
    for (let i = 0; i < 80; i++) w = zoomViewport(base, w, 0.8);
    expect(w[1] - w[0]).toBeCloseTo(base.minWidth, 6);
  });
});

describe('横軸の初期範囲に満期の BEP（AC-12）', () => {
  it('ストラングル売り（P 64,000 @ 810・C 70,500 @ 995、F = 67,810）の満期 BEP 62,195・72,305 が初期範囲の内側、初期範囲は全域の中', () => {
    const { ctx, rows } = makeMarket();
    const legs: Leg[] = [
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: M1.id,
        strike: 64000,
        side: 'sell',
        qty: 1,
        entry: 810,
      },
      {
        kind: 'option',
        product: 'op_large',
        type: 'call',
        expiry: M1.id,
        strike: 70500,
        side: 'sell',
        qty: 1,
        entry: 995,
      },
    ];
    const board = {
      months: [
        { F: M1.F, rows: rows[M1.id] ?? [] },
        { F: M2.F, rows: rows[M2.id] ?? [] },
      ],
    };
    const base = pnlDomains(board, preparePosition(legs, ctx), ctx);
    if (!base) throw new Error('基礎が作れない');
    expect(base.profile.breakevens).toEqual([62_195, 72_305]);
    const [lo, hi] = base.initial;
    // 芯 62,195〜72,305（幅 10,110）+ 余白 max(1,516.5, 1,356.2) = 1,516.5
    expect(lo).toBeLessThan(62_195);
    expect(hi).toBeGreaterThan(72_305);
    expect(lo).toBeCloseTo(62_195 - 10_110 * 0.15, 6);
    expect(hi).toBeCloseTo(72_305 + 10_110 * 0.15, 6);
    expect(lo).toBeGreaterThanOrEqual(base.full[0]);
    expect(hi).toBeLessThanOrEqual(base.full[1]);
    // 初期表示のグラフに満期の BEP の印が 2 つ
    expect(chartOf(base).breakevens.map((b) => b.x)).toEqual([62_195, 72_305]);
  });
});

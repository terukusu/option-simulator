import { describe, expect, it } from 'vitest';
import { type Scenario, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import { type Leg, preparePosition } from '../../model/position';
import { fmtAmount, metricsModel } from '../../ui/view/metrics';
import {
  DEFAULT_PNL_Y,
  type PnlBase,
  pnlChartModel,
  pnlDomains,
  pnlViewDomain,
} from '../../ui/view/pnlChart';
import {
  parseCssColor,
  planSurface,
  SURFACE_A_MAX,
  SURFACE_COARSE,
  SURFACE_FINE,
  SURFACE_GAMMA,
  SURFACE_SETTLE_MS,
  SURFACE_TICK_TOP_GAP,
  SURFACE_Y_UNIT,
  type SurfaceGrid,
  sameSurfaceDeps,
  surfaceActive,
  surfaceAlpha,
  surfaceDayAt,
  surfaceDayPy,
  surfaceDayTicks,
  surfaceDeps,
  surfaceDragPatch,
  surfaceGrid,
  surfaceImage,
  surfaceLegend,
  surfacePoint,
  surfaceValueAt,
} from '../../ui/view/pnlSurface';
import { readoutModel } from '../../ui/view/readout';
import { dXRange } from '../../ui/view/scenario';
import { scenarioMarks } from '../../ui/view/scenarioMarks';
import { ivRailObstacle, type MarkObstacle, stageHandle } from '../../ui/view/stage';
import { M1, M2, makeMarket, quoteOf } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/** #88 段 A: 損益の面の表示モデル。合成の市場（架空の値）。 */

const { ctx, rows } = makeMarket();
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const M1_ROWS = rows[M1.id] ?? [];

/** 売りストラングル（1 限月・足 2 本。建値は板の bid） */
const STRANGLE: Leg[] = [
  {
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: M1.id,
    strike: 64000,
    side: 'sell',
    qty: 1,
    entry: quoteOf(M1_ROWS, 64000, 'put').bid,
  },
  {
    kind: 'option',
    product: 'op_large',
    type: 'call',
    expiry: M1.id,
    strike: 71000,
    side: 'sell',
    qty: 1,
    entry: quoteOf(M1_ROWS, 71000, 'call').bid,
  },
];

function baseOf(legs: Leg[]): PnlBase {
  const b = pnlDomains(board, preparePosition(legs, ctx), ctx);
  if (!b) throw new Error('基礎が作れない');
  return b;
}

const strangle = baseOf(STRANGLE);
const perf = baseOf(PERF_LEGS);
const W = 1000;
const H = 260;

const chartOf = (base: PnlBase | null, scenario: Scenario) =>
  pnlChartModel({
    base,
    scenario,
    viewport: null,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: W,
    plotHeight: H,
  });

const SC: Scenario = { ...ZERO_SCENARIO, days: 5, dSigma: 2, dX: -400 };

function cellCenter(g: SurfaceGrid, i: number, j: number) {
  return {
    x: g.lo + ((g.hi - g.lo) * (i + 0.5)) / g.nx,
    d: (g.maxDays * (j + 0.5)) / g.ny,
  };
}

describe('surfaceGrid（AC-2）', () => {
  for (const [name, base] of [
    ['売りストラングル', strangle],
    ['PERF_LEGS', perf],
  ] as const) {
    for (const res of ['fine', 'coarse'] as const) {
      it(`(a) ${name} ${res}: 各セルがセルの中心の theoreticalPnl と完全に一致`, () => {
        const g = surfaceGrid(base, SC, null, res);
        if (!g) throw new Error('格子が無い');
        for (let j = 0; j < g.ny; j++) {
          for (let i = 0; i < g.nx; i++) {
            const { x, d } = cellCenter(g, i, j);
            const want = theoreticalPnl(base.legs, x, { ...SC, days: d }, base.ctx, base.settings);
            expect(g.values[j * g.nx + i]).toBe(want);
          }
        }
      });
    }
  }

  it('(b) 大きさ 72×36 / 48×24、横の中心は表示範囲の内側、縦の中心は (0, maxDays) の内側', () => {
    expect(SURFACE_FINE).toEqual({ nx: 72, ny: 36 });
    expect(SURFACE_COARSE).toEqual({ nx: 48, ny: 24 });
    const viewport = [64_000, 72_000] as const;
    for (const res of ['fine', 'coarse'] as const) {
      const g = surfaceGrid(perf, SC, viewport, res);
      if (!g) throw new Error('格子が無い');
      const want = res === 'fine' ? SURFACE_FINE : SURFACE_COARSE;
      expect([g.nx, g.ny]).toEqual([want.nx, want.ny]);
      expect(g.values.length).toBe(want.nx * want.ny);
      const [lo, hi] = pnlViewDomain(perf, viewport);
      expect([g.lo, g.hi]).toEqual([lo, hi]);
      expect(g.maxDays).toBe(perf.maxDays);
      const first = cellCenter(g, 0, 0);
      const last = cellCenter(g, g.nx - 1, g.ny - 1);
      expect(first.x).toBeGreaterThan(lo);
      expect(last.x).toBeLessThan(hi);
      expect(first.d).toBeGreaterThan(0);
      expect(last.d).toBeLessThan(perf.maxDays);
      expect(g.res).toBe(res);
    }
  });

  it('(c) 1 限月: 点の値の関数の d = maxDays が満期の損益と ±1e-6 円（上 = 満期）', () => {
    const [lo, hi] = pnlViewDomain(strangle, null);
    for (let k = 0; k < 5; k++) {
      const x = lo + ((hi - lo) * (k + 0.5)) / 5;
      expect(
        Math.abs(surfaceValueAt(strangle, SC, x, strangle.maxDays) - strangle.expiry(x)),
      ).toBeLessThanOrEqual(1e-6);
    }
  });

  it('(d) dX・days だけを変えた 3 通りで出力が深く等しい、dSigma +5 で値が変わる', () => {
    const a = surfaceGrid(perf, SC, null, 'coarse');
    const b = surfaceGrid(perf, { ...SC, dX: 1_500 }, null, 'coarse');
    const c = surfaceGrid(perf, { ...SC, days: 20, dX: -3_000 }, null, 'coarse');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const s = surfaceGrid(perf, { ...SC, dSigma: SC.dSigma + 5 }, null, 'coarse');
    expect(s?.values).not.toEqual(a?.values);
  });

  it('(e) 足 0 本（base null）は null。vmax は有限の |v| の最大', () => {
    expect(surfaceGrid(null, SC, null, 'fine')).toBeNull();
    const g = surfaceGrid(strangle, SC, null, 'fine');
    if (!g) throw new Error('格子が無い');
    let m = 0;
    for (const v of g.values) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
    expect(g.vmax).toBe(m);
    expect(g.vmax).toBeGreaterThan(1);
  });
});

describe('surfaceImage / parseCssColor（AC-3）', () => {
  const GAIN = [10, 200, 100] as const;
  const LOSS = [230, 50, 40] as const;
  const gridOf = (values: number[], nx: number, ny: number, vmax: number): SurfaceGrid => ({
    res: 'fine',
    nx,
    ny,
    lo: 0,
    hi: 1,
    maxDays: 10,
    values: Float64Array.from(values),
    vmax,
  });

  it('(a) 不透明度: 0 で 0、vmax で A_MAX、vmax / 2 で A_MAX × 0.5^0.6 ±1、単調増加', () => {
    expect(SURFACE_A_MAX).toBe(210);
    expect(SURFACE_GAMMA).toBe(0.6);
    const vmax = 10_000;
    expect(surfaceAlpha(0, vmax)).toBe(0);
    expect(surfaceAlpha(vmax, vmax)).toBe(SURFACE_A_MAX);
    expect(surfaceAlpha(-vmax, vmax)).toBe(SURFACE_A_MAX);
    expect(Math.abs(surfaceAlpha(vmax / 2, vmax) - SURFACE_A_MAX * 0.5 ** 0.6)).toBeLessThanOrEqual(
      1,
    );
    let prev = -1;
    for (let k = 0; k <= 100; k++) {
      const a = surfaceAlpha((vmax * k) / 100, vmax);
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(prev);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(255);
      prev = a;
    }
    expect(surfaceAlpha(vmax / 100, vmax)).toBeLessThan(surfaceAlpha(vmax / 2, vmax));
  });

  it('(b) 正 = gain の RGB、負 = loss の RGB', () => {
    const img = surfaceImage(gridOf([500, -500], 2, 1, 500), { gain: GAIN, loss: LOSS });
    expect([...img.data]).toEqual([...GAIN, SURFACE_A_MAX, ...LOSS, SURFACE_A_MAX]);
  });

  it('(c) NaN のセル・vmax < 1 円の格子は全部 0', () => {
    const a = surfaceImage(gridOf([Number.NaN, 0], 2, 1, 500), { gain: GAIN, loss: LOSS });
    expect([...a.data].every((v) => v === 0)).toBe(true);
    const b = surfaceImage(gridOf([0.5, -0.3, 0.9, -0.1], 2, 2, 0.9), { gain: GAIN, loss: LOSS });
    expect([...b.data].every((v) => v === 0)).toBe(true);
  });

  it('(d) バッファの最終行（下端）が d の最小の行、先頭行が最大の行', () => {
    // 2 × 3: j = 0（d 最小）は gain、j = 2（d 最大）は loss
    const g = gridOf([100, 100, 0, 0, -100, -100], 2, 3, 100);
    const img = surfaceImage(g, { gain: GAIN, loss: LOSS });
    expect(img.data.length).toBe(2 * 3 * 4);
    const px = (r: number, i: number) => [...img.data.slice((r * 2 + i) * 4, (r * 2 + i) * 4 + 4)];
    expect(px(0, 0)).toEqual([...LOSS, SURFACE_A_MAX]);
    expect(px(2, 1)).toEqual([...GAIN, SURFACE_A_MAX]);
    expect(px(1, 0)).toEqual([0, 0, 0, 0]);
    // 実の格子でも: 画素の行 r は格子の j = ny − 1 − r
    const real = surfaceGrid(strangle, SC, null, 'coarse');
    if (!real) throw new Error('格子が無い');
    const ri = surfaceImage(real, { gain: GAIN, loss: LOSS });
    const { nx, ny } = real;
    for (const i of [0, nx >> 1, nx - 1]) {
      const vBottom = real.values[0 * nx + i] as number;
      const oBottom = ((ny - 1) * nx + i) * 4;
      expect(ri.data[oBottom + 3]).toBe(surfaceAlpha(vBottom, real.vmax));
      const vTop = real.values[(ny - 1) * nx + i] as number;
      expect(ri.data[i * 4 + 3]).toBe(surfaceAlpha(vTop, real.vmax));
    }
  });

  it('(e) 色の文字列 → RGB', () => {
    expect(parseCssColor('#2fb483')).toEqual([47, 180, 131]);
    expect(parseCssColor('  #2FB483 ')).toEqual([47, 180, 131]);
    expect(parseCssColor('#fff')).toEqual([255, 255, 255]);
    expect(parseCssColor('rgb(16, 138, 92)')).toEqual([16, 138, 92]);
    expect(parseCssColor('rgb(16 138 92)')).toEqual([16, 138, 92]);
    expect(parseCssColor('rgba(16, 138, 92, 0.5)')).toEqual([16, 138, 92]);
    expect(parseCssColor('var(--x)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('#12')).toBeNull();
    expect(parseCssColor('rgb(1, 2)')).toBeNull();
  });
});

describe('縦軸・点・凡例（AC-4）', () => {
  const plot = { left: 56, top: 10, width: W, height: H };
  const maxDays = strangle.maxDays;

  it('(a) d → 画素 → d の往復、下端 = 0・上端 = maxDays、上端とその外は maxDays そのもの', () => {
    expect(maxDays % 1).not.toBe(0);
    for (let d = 0; d <= Math.floor(maxDays); d++) {
      expect(surfaceDayAt(surfaceDayPy(d, plot, maxDays), plot, maxDays)).toBe(d);
    }
    expect(surfaceDayPy(0, plot, maxDays)).toBe(plot.top + plot.height);
    expect(surfaceDayPy(maxDays, plot, maxDays)).toBe(plot.top);
    expect(surfaceDayPy(maxDays + 5, plot, maxDays)).toBe(plot.top);
    expect(surfaceDayPy(-3, plot, maxDays)).toBe(plot.top + plot.height);
    expect(surfaceDayAt(plot.top, plot, maxDays)).toBe(maxDays);
    expect(surfaceDayAt(plot.top - 30, plot, maxDays)).toBe(maxDays);
    expect(surfaceDayAt(plot.top + plot.height + 30, plot, maxDays)).toBe(0);
    // 1 日の格子
    const mid = surfaceDayAt(plot.top + plot.height / 2, plot, maxDays);
    expect(Number.isInteger(mid)).toBe(true);
    expect(surfaceDayAt(Number.NaN, plot, maxDays)).toBe(0);
    expect(surfaceDayAt(plot.top, plot, 0)).toBe(0);
  });

  it('(b) 縦の目盛りは 0 〜 maxDays の整数（0 を含む・昇順・重複なし）、単位「日」', () => {
    expect(SURFACE_Y_UNIT).toBe('日');
    for (const md of [maxDays, perf.maxDays, 3.4, 0.6]) {
      const t = surfaceDayTicks(plot, md);
      expect(t[0]?.v).toBe(0);
      expect(t.length).toBeGreaterThanOrEqual(1);
      for (let k = 0; k < t.length; k++) {
        const v = t[k]?.v as number;
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(md);
        expect(t[k]?.label).toBe(String(v));
        expect(t[k]?.py).toBe(surfaceDayPy(v, plot, md));
        // 0 以外は左上の単位「日」と重ならない
        if (v !== 0) expect(t[k]?.py).toBeGreaterThanOrEqual(plot.top + SURFACE_TICK_TOP_GAP);
        if (k > 0) expect(v).toBeGreaterThan(t[k - 1]?.v as number);
      }
    }
    expect(surfaceDayTicks(plot, maxDays).length).toBeGreaterThanOrEqual(3);
    expect(surfaceDayTicks(plot, 0)).toEqual([]);
  });

  it('(c) 点の値が読み取りの pnl.date と同じ数、横の画素が stageHandle の px（d > maxDays は収めた d）', () => {
    for (const base of [strangle, perf]) {
      for (const sc of [
        { ...ZERO_SCENARIO },
        { ...SC },
        { ...ZERO_SCENARIO, dX: 800, days: base.maxDays + 20, dSigma: -1.5 },
      ]) {
        const chart = chartOf(base, sc);
        const mm = metricsModel({ base, scenario: sc, unit: 'auto' });
        const marks = scenarioMarks({ base, scenario: sc, chart, unit: mm.unit });
        const handle = stageHandle(chart, marks);
        const p = surfacePoint({ base, scenario: sc, chart, handle, unit: mm.unit });
        if (!p || !handle) throw new Error('点が無い');
        const r = readoutModel({ base, metrics: mm, scenario: sc });
        expect(p.value).toBe(r.pnl.date);
        expect(p.px).toBe(handle.px);
        expect(p.days).toBe(Math.min(Math.max(sc.days, 0), base.maxDays));
        expect(p.py).toBe(surfaceDayPy(p.days, chart.plot, base.maxDays));
      }
    }
    // handle・base が無ければ null
    const chart = chartOf(strangle, SC);
    expect(surfacePoint({ base: strangle, scenario: SC, chart, handle: null, unit: 'yen' })).toBe(
      null,
    );
    expect(
      surfacePoint({
        base: null,
        scenario: SC,
        chart: chartOf(null, SC),
        handle: null,
        unit: 'yen',
      }),
    ).toBeNull();
  });

  it('(d) ラベルの箱は描画域の 4 隅の近くと IV レールの吹き出しに重なる点で、描画域の中・吹き出しと交わらない', () => {
    const chart = chartOf(perf, SC);
    const { plot: pl } = chart;
    const right = pl.left + pl.width;
    const bottom = pl.top + pl.height;
    const inside = (b: MarkObstacle) =>
      b.x0 >= pl.left && b.x1 <= right && b.y0 >= pl.top && b.y1 <= bottom;
    const hits = (a: MarkObstacle, b: MarkObstacle) =>
      a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const at = (px: number, days: number, obstacles: MarkObstacle[] = []) => {
      const sc = { ...SC, days };
      const handle = { px, dotPy: null, top: pl.top, bottom };
      const p = surfacePoint({
        base: perf,
        scenario: sc,
        chart,
        handle,
        unit: 'thousand',
        obstacles,
      });
      if (!p) throw new Error('点が無い');
      return p;
    };
    const pyToDays = (py: number) => ((bottom - py) / pl.height) * perf.maxDays;
    const corners: Array<[number, number]> = [
      [pl.left + 5, pyToDays(pl.top + 5)],
      [right - 5, pyToDays(pl.top + 5)],
      [pl.left + 5, pyToDays(bottom - 5)],
      [right - 5, pyToDays(bottom - 5)],
    ];
    const anchors = new Set<string>();
    for (const [px, d] of corners) {
      const p = at(px, d);
      expect(inside(p.box)).toBe(true);
      anchors.add(`${p.anchor}${p.labelY < p.py ? 'up' : 'down'}`);
      // 文字の位置は箱の端・縦の中心
      expect(p.labelX).toBe(p.anchor === 'start' ? p.box.x0 : p.box.x1);
      expect(p.labelY).toBe((p.box.y0 + p.box.y1) / 2);
    }
    expect(anchors.size).toBe(4);
    // IV レールの吹き出し（描画域の右端に重なる）
    const width = pl.left + pl.width + 12;
    const ob = ivRailObstacle(SC.dSigma, pl.top + pl.height + 26, width);
    const py = (ob.y0 + ob.y1) / 2 + 12;
    // 右上の箱の右端が描画域の右端の 2px 内側 = 吹き出しに掛かる位置
    const probe = at(pl.left + 200, pyToDays(py));
    const w = probe.box.x1 - probe.box.x0;
    const px = right - 10 - w - 2;
    expect(px + 10 + w).toBeGreaterThan(ob.x0);
    const p = at(px, pyToDays(py), [ob]);
    expect(inside(p.box)).toBe(true);
    expect(hits(p.box, ob)).toBe(false);
    // 吹き出しが無ければ右上（吹き出しと交わる位置）
    const free = at(px, pyToDays(py));
    expect(free.anchor).toBe('start');
    expect(free.labelY).toBeLessThan(free.py);
    expect(hits(free.box, ob)).toBe(true);
  });

  it('(d) 文言は「金額 + 単位 · d 日」（— / ∞ は単位なし）', () => {
    const chart = chartOf(strangle, SC);
    const mm = metricsModel({ base: strangle, scenario: SC, unit: 'yen' });
    const marks = scenarioMarks({ base: strangle, scenario: SC, chart, unit: 'yen' });
    const p = surfacePoint({
      base: strangle,
      scenario: SC,
      chart,
      handle: stageHandle(chart, marks),
      unit: mm.unit,
    });
    expect(p?.text).toMatch(/^[+−]?[\d,]+円 · d 5$/);
  });

  it('(e) 凡例の vmax は格子の |v| の最大を指標の単位で書いたもの', () => {
    const g = surfaceGrid(strangle, SC, null, 'fine');
    if (!g) throw new Error('格子が無い');
    const yen = surfaceLegend(g.vmax, 'yen');
    expect(yen.vmax).toBe(`±${fmtAmount(g.vmax, 'yen')}円`);
    expect(Number(yen.vmax?.slice(1, -1).replace(/,/g, ''))).toBe(Math.round(g.vmax));
    const th = surfaceLegend(g.vmax, 'thousand');
    expect(th.vmax).toBe(`±${fmtAmount(g.vmax, 'thousand')}千円`);
    expect(th.long).toBe('損益の面（横 原資産 · 縦 経過日数）');
    expect(th.short).toBe('損益の面');
    expect(surfaceLegend(null, 'yen').vmax).toBeNull();
    expect(surfaceLegend(0.5, 'yen').vmax).toBeNull();
  });
});

describe('粗い / 細かい（AC-6）', () => {
  it('前が無い → fine、入力が変わる → coarse、settle が進む → fine、さらに → 同じ参照', () => {
    expect(SURFACE_SETTLE_MS).toBe(120);
    const d0 = surfaceDeps(perf, SC, null);
    const p0 = planSurface(null, d0, 0);
    expect(p0?.res).toBe('fine');
    const d1 = surfaceDeps(perf, { ...SC, dSigma: SC.dSigma + 0.5 }, null);
    const p1 = planSurface(p0, d1, 0);
    expect(p1?.res).toBe('coarse');
    expect(p1?.deps).toBe(d1);
    // 同じ入力・settle がそのまま → 同じ参照（粗いまま）
    expect(planSurface(p1, surfaceDeps(perf, { ...SC, dSigma: SC.dSigma + 0.5 }, null), 0)).toBe(
      p1,
    );
    const p2 = planSurface(p1, surfaceDeps(perf, { ...SC, dSigma: SC.dSigma + 0.5 }, null), 1);
    expect(p2?.res).toBe('fine');
    expect(p2?.deps).toBe(p1?.deps);
    expect(planSurface(p2, d1, 2)).toBe(p2);
    // 表示範囲が変わる → coarse
    expect(planSurface(p2, surfaceDeps(perf, SC, [64_000, 70_000]), 2)?.res).toBe('coarse');
    // 基礎（参照）が変わる → coarse
    expect(planSurface(p2, surfaceDeps(baseOf(PERF_LEGS), SC, null), 2)?.res).toBe('coarse');
  });

  it('ΔX・d だけの変化は同じ参照（作り直さない）', () => {
    const p0 = planSurface(null, surfaceDeps(perf, SC, null), 0);
    for (const sc of [
      { ...SC, dX: 2_000 },
      { ...SC, days: 17 },
      { ...SC, dX: -50, days: 0 },
    ]) {
      const deps = surfaceDeps(perf, sc, null);
      if (!deps || !p0) throw new Error('入力が無い');
      expect(sameSurfaceDeps(p0.deps, deps)).toBe(true);
      expect(planSurface(p0, deps, 0)).toBe(p0);
    }
  });

  it('ZERO_SCENARIO の dX・days 以外のキーを 1 つ変えると同じでない（キーの網羅）', () => {
    const d0 = surfaceDeps(perf, ZERO_SCENARIO, null);
    if (!d0) throw new Error('入力が無い');
    const keys = Object.keys(ZERO_SCENARIO).filter((k) => k !== 'dX' && k !== 'days');
    expect(keys.length).toBeGreaterThanOrEqual(5);
    const changed: Record<string, unknown> = {
      dSigma: 1,
      skew: 1,
      beta: 2,
      ivDynamics: 'sticky_moneyness',
      ivShift: 'relative',
    };
    for (const k of keys) {
      expect(k in changed).toBe(true);
      const sc = { ...ZERO_SCENARIO, [k]: changed[k] } as Scenario;
      const d = surfaceDeps(perf, sc, null);
      if (!d) throw new Error('入力が無い');
      expect(sameSurfaceDeps(d0, d)).toBe(false);
    }
  });

  it('入力が無い（足 0 本・maxDays ≤ 0）→ null（線モードでは作らないのはフック側）', () => {
    expect(surfaceDeps(null, SC, null)).toBeNull();
    expect(planSurface(null, null, 0)).toBeNull();
    const p0 = planSurface(null, surfaceDeps(perf, SC, null), 0);
    expect(planSurface(p0, null, 1)).toBeNull();
    expect(surfaceDeps({ ...perf, maxDays: 0 }, SC, null)).toBeNull();
    expect(surfaceGrid({ ...perf, maxDays: 0 }, SC, null, 'fine')).toBeNull();
  });

  it('計画の解像度で作った格子の大きさ', () => {
    const p = planSurface(null, surfaceDeps(perf, SC, null), 0);
    if (!p) throw new Error('計画が無い');
    expect(surfaceGrid(p.deps.base, SC, [p.deps.lo, p.deps.hi], p.res)?.nx).toBe(SURFACE_FINE.nx);
  });
});

describe('面モードの判定（AC-6: 線モードでは作らない）', () => {
  it('surfaceActive: 面 かつ ミニでない かつ 空でない ときだけ true', () => {
    expect(surfaceActive('surface', false, false)).toBe(true);
    expect(surfaceActive('line', false, false)).toBe(false);
    expect(surfaceActive('surface', true, false)).toBe(false);
    expect(surfaceActive('surface', false, true)).toBe(false);
    expect(surfaceActive('line', true, true)).toBe(false);
  });

  it('面でない（deps = null）なら前の計画があっても null = 格子を作らない', () => {
    const p0 = planSurface(null, surfaceDeps(perf, SC, null), 0);
    if (!p0) throw new Error('計画が無い');
    const coarse = planSurface(p0, surfaceDeps(perf, { ...SC, dSigma: 9 }, null), 0);
    for (const prev of [null, p0, coarse]) {
      for (const settle of [0, 1, 5]) expect(planSurface(prev, null, settle)).toBeNull();
    }
  });
});

describe('surfaceDragPatch（AC-7・AC-13 の根拠。段 B）', () => {
  /** 要素の座標と SVG の座標のずれ（舞台の frame.offsetX / offsetY の代わりの架空の値） */
  const OX = 56;
  const OY = 8;

  function pointOf(base: PnlBase, sc: Scenario) {
    const chart = chartOf(base, sc);
    const mm = metricsModel({ base, scenario: sc, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario: sc, chart, unit: mm.unit });
    const handle = stageHandle(chart, marks);
    const p = surfacePoint({ base, scenario: sc, chart, handle, unit: mm.unit });
    if (!p) throw new Error('点が無い');
    return { chart, px: { x: p.px - OX, y: p.py - OY } };
  }

  const patchAt = (
    base: PnlBase,
    sc: Scenario,
    x: number,
    y: number,
    pointPx: { x: number; y: number } | null,
  ) =>
    surfaceDragPatch({
      x,
      y,
      chart: chartOf(base, sc),
      offsetX: OX,
      offsetY: OY,
      x0: base.ctx.x0,
      maxDays: base.maxDays,
      scenario: sc,
      pointPx,
    });

  const GRID_SCENARIOS = (base: PnlBase): Scenario[] => [
    { ...ZERO_SCENARIO },
    { ...ZERO_SCENARIO, dX: -400, days: 3 },
    { ...ZERO_SCENARIO, dX: 1_250, days: Math.floor(base.maxDays) - 1, dSigma: 2 },
  ];

  it('(1) 往復: 整数の d・10 円の格子の ΔX の点の画素 → null（pointPx あり / なし）', () => {
    for (const base of [strangle, perf]) {
      for (const sc of GRID_SCENARIOS(base)) {
        const { px } = pointOf(base, sc);
        expect(patchAt(base, sc, px.x, px.y, px)).toBeNull();
        expect(patchAt(base, sc, px.x, px.y, null)).toBeNull();
      }
    }
  });

  it('(2) 別の (ΔX′, d′) の点の画素 → { dX: ΔX′, days: d′ }', () => {
    for (const base of [strangle, perf]) {
      const scs = GRID_SCENARIOS(base);
      for (const a of scs) {
        const from = pointOf(base, a).px;
        for (const b of scs) {
          if (a === b) continue;
          const to = pointOf(base, { ...a, dX: b.dX, days: b.days }).px;
          const want: { dX?: number; days?: number } = {};
          if (b.dX !== a.dX) want.dX = b.dX;
          if (b.days !== a.days) want.days = b.days;
          expect(patchAt(base, a, to.x, to.y, from)).toEqual(want);
        }
      }
    }
  });

  it('(3) dX は 10 の倍数・dXRange の中、days は [0, maxDays] の整数か maxDays', () => {
    for (const base of [strangle, perf]) {
      const chart = chartOf(base, ZERO_SCENARIO);
      const { plot } = chart;
      const [lo, hi] = dXRange(base.ctx.x0);
      for (let k = 0; k <= 40; k++) {
        const x = plot.left - OX - 30 + ((plot.width + 60) * k) / 40;
        const y = plot.top - OY - 30 + ((plot.height + 60) * ((k * 7) % 41)) / 40;
        const r = patchAt(base, { ...ZERO_SCENARIO, dX: 7, days: 0.3 }, x, y, null);
        if (!r) throw new Error('patch が無い');
        expect(r.dX !== undefined && r.dX % 10 === 0).toBe(true);
        expect(r.dX).toBeGreaterThanOrEqual(lo);
        expect(r.dX).toBeLessThanOrEqual(hi);
        const d = r.days as number;
        expect(d >= 0 && d <= base.maxDays).toBe(true);
        expect(Number.isInteger(d) || d === base.maxDays).toBe(true);
      }
    }
  });

  it('(4) 描画域の外: 上 → maxDays、下 → 0、左右 → 表示範囲の端の値（の格子）', () => {
    expect(Number.isInteger(strangle.maxDays)).toBe(false);
    for (const base of [strangle, perf]) {
      const sc = { ...ZERO_SCENARIO, dX: 10, days: 1 };
      const { plot, domain } = chartOf(base, sc);
      const midX = plot.left + plot.width / 2 - OX;
      const midY = plot.top + plot.height / 2 - OY;
      expect(patchAt(base, sc, midX, plot.top - OY - 40, null)?.days).toBe(base.maxDays);
      expect(patchAt(base, sc, midX, plot.top - OY, null)?.days).toBe(base.maxDays);
      expect(patchAt(base, sc, midX, plot.top + plot.height - OY + 40, null)?.days).toBe(0);
      const left = patchAt(base, sc, plot.left - OX - 100, midY, null)?.dX;
      const right = patchAt(base, sc, plot.left + plot.width - OX + 100, midY, null)?.dX;
      const [lo, hi] = dXRange(base.ctx.x0);
      const snap = (v: number) => Math.min(Math.max(Math.round(v / 10) * 10, lo), hi);
      expect(left).toBe(snap(domain[0] - base.ctx.x0));
      expect(right).toBe(snap(domain[1] - base.ctx.x0));
    }
  });

  it('(5) 横だけ動かすと端数の d を保ち、縦だけ動かすと格子の外の ΔX を保つ', () => {
    for (const base of [strangle, perf]) {
      const sc = { ...ZERO_SCENARIO, dX: 0, days: 2.5 };
      const { px } = pointOf(base, sc);
      expect(patchAt(base, sc, px.x + 60, px.y, px)).toEqual({
        dX: expect.any(Number) as number,
      });
      expect(patchAt(base, sc, px.x + 60, px.y + 0.4, px)?.days).toBeUndefined();
      const odd = { ...ZERO_SCENARIO, dX: 125, days: 2 };
      const q = pointOf(base, odd).px;
      const r = patchAt(base, odd, q.x, q.y - 40, q);
      expect(r?.dX).toBeUndefined();
      expect(r?.days).toBeGreaterThan(2);
      // maxDays（端数）の点を横に動かしても maxDays のまま
      const top = { ...ZERO_SCENARIO, days: base.maxDays };
      const t = pointOf(base, top).px;
      expect(patchAt(base, top, t.x - 50, t.y, t)?.days).toBeUndefined();
    }
  });

  it('極限: x0 が無効 → dX なし、非有限の x / y → その軸なし、maxDays ≤ 0 → days なし', () => {
    const sc = { ...ZERO_SCENARIO, dX: 0, days: 0 };
    const chart = chartOf(perf, sc);
    const mid = { x: chart.plot.left + 100 - OX, y: chart.plot.top + 20 - OY };
    const base = { chart, offsetX: OX, offsetY: OY, scenario: sc, pointPx: null };
    expect(
      surfaceDragPatch({ ...base, ...mid, x0: Number.NaN, maxDays: perf.maxDays })?.dX,
    ).toBeUndefined();
    expect(
      surfaceDragPatch({ ...base, x: Number.NaN, y: mid.y, x0: perf.ctx.x0, maxDays: perf.maxDays })
        ?.dX,
    ).toBeUndefined();
    expect(
      surfaceDragPatch({ ...base, x: mid.x, y: Number.NaN, x0: perf.ctx.x0, maxDays: perf.maxDays })
        ?.days,
    ).toBeUndefined();
    expect(
      surfaceDragPatch({ ...base, ...mid, x0: perf.ctx.x0, maxDays: 0 })?.days,
    ).toBeUndefined();
    expect(
      surfaceDragPatch({ ...base, x: Number.NaN, y: Number.NaN, x0: perf.ctx.x0, maxDays: 0 }),
    ).toBeNull();
  });
});

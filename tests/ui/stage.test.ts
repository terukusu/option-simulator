import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, type Scenario, ZERO_SCENARIO } from '../../model';
import { linear } from '../../ui/chart/scale';
import { type Action, initialState, reduce, type State, type UiLeg } from '../../ui/state';
import { fmtNum, fmtSigned } from '../../ui/view/format';
import { fmtAmount, metricsModel } from '../../ui/view/metrics';
import { metricTiles } from '../../ui/view/metricsPanel';
import {
  axisX,
  DEFAULT_PNL_Y,
  PNL_MARGIN,
  type PnlBase,
  type PnlChartModel,
  pnlChartModel,
  pnlDomains,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { readoutModel } from '../../ui/view/readout';
import {
  daysToTarget,
  dXRange,
  type EvalTimeTarget,
  evalTimeTargets,
} from '../../ui/view/scenario';
import { labelWidth, scenarioMarks } from '../../ui/view/scenarioMarks';
import {
  bigReadout,
  emptyStageGrid,
  IV_RAIL_MAX_RATE,
  IV_RAIL_PAD,
  ivRailBubble,
  ivRailDragValue,
  ivRailObstacle,
  ivRailRelative,
  ivRailValue,
  ivRailY,
  legMarkers,
  type MarkObstacle,
  railPick,
  STAGE_LABEL_SHIFT,
  stageFill,
  stageFrame,
  stageHandle,
  stageKey,
  stageMarkLabels,
  strikeAtPx,
  TIME_RAIL_PAD,
  type TimeRailTick,
  timeRailLayout,
  timeRailNow,
  timeRailText,
  timeRailTicks,
  timeRailValue,
  timeRailX,
} from '../../ui/view/stage';
import { fixture } from '../support/fixtures';
import { SUB_MAX_UNITS, widthUnits } from '../support/widthUnits';

/** #82: 舞台の付属の表示モデル（ハンドル・塗り・足マーカー・読み取り・キー・レール）。合成の板（架空の値）。 */

const chain = normalizeChain(fixture('latest'));
const M1 = chain.months[0]?.id ?? '';
const W = 1000;
const H = 260;

function stateWith(...actions: Action[]): State {
  return [{ type: 'loaded', chain, label: 'latest' } as Action, ...actions].reduce(
    reduce,
    initialState,
  );
}

const strangle = (): State =>
  stateWith(
    { type: 'addBoardLeg', expiry: M1, k: 63500, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: M1, k: 71000, optionType: 'call', side: 'sell' },
  );

function baseOf(s: State, settings: ModelSettings = DEFAULT_SETTINGS): PnlBase {
  const pm = positionModel(s.chain as Chain, s.legs, s.atmBasis, s.calendar, settings);
  const base = pnlDomains(s.chain as Chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

function chartOf(
  base: PnlBase | null,
  scenario: Scenario,
  viewport: PnlChartModel['domain'] | null = null,
) {
  return pnlChartModel({
    base,
    scenario,
    viewport,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: W,
    plotHeight: H,
  });
}

/** path の数（M・L の座標）を [x, y] の列にする */
function points(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

describe('stageHandle（AC-2 a）', () => {
  const s = strangle();
  const base = baseOf(s);

  it('ΔX = 0: 画素 = x0Px、● は今日の線（d = Δσ = Δs = 0）', () => {
    const chart = chartOf(base, ZERO_SCENARIO);
    const marks = scenarioMarks({ base, scenario: ZERO_SCENARIO, chart, unit: 'yen' });
    expect(chart.scenarioPx).toBeNull();
    const h = stageHandle(chart, marks);
    expect(h?.px).toBe(chart.x0Px);
    expect(h?.dotPy).toBe(marks?.marks.find((m) => m.kind === 'today')?.py);
    expect(h?.top).toBe(PNL_MARGIN.top);
    expect(h?.bottom).toBe(PNL_MARGIN.top + H);
  });

  it('ΔX ≠ 0: 画素 = scenarioPx、● は指定日の線（d > 0 か Δσ ≠ 0）', () => {
    const sc = { ...ZERO_SCENARIO, dX: -400, dSigma: 2 };
    const chart = chartOf(base, sc);
    const marks = scenarioMarks({ base, scenario: sc, chart, unit: 'yen' });
    const h = stageHandle(chart, marks);
    expect(chart.scenarioPx).not.toBeNull();
    expect(h?.px).toBe(chart.scenarioPx);
    expect(h?.dotPy).toBe(marks?.marks.find((m) => m.kind === 'date')?.py);
    expect(h?.dotPy).not.toBe(marks?.marks.find((m) => m.kind === 'today')?.py);
  });

  it('表示範囲の外・空は null', () => {
    const sc = { ...ZERO_SCENARIO, dX: 0 };
    const chart = chartOf(base, sc, [40_000, 42_000]);
    expect(
      stageHandle(chart, scenarioMarks({ base, scenario: sc, chart, unit: 'yen' })),
    ).toBeNull();
    const far = { ...ZERO_SCENARIO, dX: 20_000 };
    const c2 = chartOf(base, far);
    expect(
      stageHandle(c2, scenarioMarks({ base, scenario: far, chart: c2, unit: 'yen' })),
    ).toBeNull();
    expect(stageHandle(chartOf(null, ZERO_SCENARIO), null)).toBeNull();
  });
});

describe('stageFill（AC-2 b）', () => {
  const s = strangle();
  const base = baseOf(s);
  const sc = { ...ZERO_SCENARIO, days: 10 };
  const chart = chartOf(base, sc);
  const fill = stageFill(chart);
  const line = chart.lines.find((l) => l.kind === 'date');
  if (!line) throw new Error('指定日の線が無い');
  const sx = linear(chart.domain, [chart.plot.left, chart.plot.left + chart.plot.width]);
  // 線の 0 との最初・最後の交点（画素）
  const crossings: number[] = [];
  for (let i = 1; i < line.ys.length; i++) {
    const a = line.ys[i - 1] as number;
    const b = line.ys[i] as number;
    if (a > 0 !== b > 0) {
      const x1 = sx(line.xs[i - 1] as number);
      const x2 = sx(line.xs[i] as number);
      crossings.push(x1 + (x2 - x1) * (a / (a - b)));
    }
  }

  it('売りストラングル: 利益側は線の 0 との交点の内側・満期の BEP の内側、損失側は外側だけ', () => {
    expect(crossings.length).toBe(2);
    const [c0, c1] = crossings as [number, number];
    const gain = points(fill.gain);
    const loss = points(fill.loss);
    expect(gain.length).toBeGreaterThan(10);
    expect(loss.length).toBeGreaterThan(4);
    const gx = gain.map((p) => p[0]);
    expect(Math.min(...gx)).toBeGreaterThanOrEqual(c0 - 1);
    expect(Math.max(...gx)).toBeLessThanOrEqual(c1 + 1);
    const beps = chart.breakevens.map((b) => b.px);
    expect(beps.length).toBe(2);
    expect(Math.min(...gx)).toBeGreaterThanOrEqual(Math.min(...beps) - 1);
    expect(Math.max(...gx)).toBeLessThanOrEqual(Math.max(...beps) + 1);
    for (const [x] of loss) expect(x <= c0 + 1 || x >= c1 - 1).toBe(true);
    // 閉じたパス（利益側 1 つ・損失側 2 つ）
    expect(fill.gain.match(/Z/g)?.length).toBe(1);
    expect(fill.loss.match(/Z/g)?.length).toBe(2);
  });

  it('全頂点が描画域の中', () => {
    const { left, top, width, height } = chart.plot;
    for (const [x, y] of [...points(fill.gain), ...points(fill.loss)]) {
      expect(x).toBeGreaterThanOrEqual(left - 0.05);
      expect(x).toBeLessThanOrEqual(left + width + 0.05);
      expect(y).toBeGreaterThanOrEqual(top - 0.05);
      expect(y).toBeLessThanOrEqual(top + height + 0.05);
    }
    // 縦軸を絞っても描画域の中に収める
    const tight = pnlChartModel({
      base,
      scenario: sc,
      viewport: null,
      pnlY: { mode: 'manual', manual: [-1000, 1000], n: 5 },
      plotWidth: W,
      plotHeight: H,
    });
    const f2 = stageFill(tight);
    for (const [, y] of [...points(f2.gain), ...points(f2.loss)]) {
      expect(y).toBeGreaterThanOrEqual(top - 0.05);
      expect(y).toBeLessThanOrEqual(top + height + 0.05);
    }
  });

  it('足 0 本は空', () => {
    expect(stageFill(chartOf(null, ZERO_SCENARIO))).toEqual({ gain: '', loss: '' });
  });

  it('今日の線（指定日の線が無い）を塗る', () => {
    const c0 = chartOf(base, ZERO_SCENARIO);
    expect(c0.lines.some((l) => l.kind === 'date')).toBe(false);
    const f0 = stageFill(c0);
    expect(f0.gain.length + f0.loss.length).toBeGreaterThan(0);
  });
});

describe('legMarkers（AC-2 c）', () => {
  const s = stateWith(
    { type: 'addBoardLeg', expiry: M1, k: 63500, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: M1, k: 71000, optionType: 'call', side: 'buy' },
    {
      type: 'addFutureLeg',
      input: { product: 'fut_mini', contract: chain.future.id, side: 'buy', qty: 1 },
    },
  );
  const withQty = reduce(s, { type: 'editLeg', id: 1, patch: { qty: 3 } });

  it.each<ModelSettings['basisMode']>(['yen', 'pct'])(
    'basis %s: 横の画素が axisX の写像と一致、▲ call / ▼ put、×N は枚数 > 1 だけ、先物は出ない',
    (basisMode) => {
      const settings = { ...DEFAULT_SETTINGS, basisMode };
      const base = baseOf(withQty, settings);
      const chart = chartOf(base, ZERO_SCENARIO);
      const ms = legMarkers(withQty.legs, base, chart, { selected: 2, drag: null });
      expect(ms.map((m) => m.id)).toEqual([1, 2]);
      const sx = linear(chart.domain, [chart.plot.left, chart.plot.left + chart.plot.width]);
      const F = base.ctx.options[M1]?.forward as number;
      for (const m of ms) expect(m.px).toBeCloseTo(sx(axisX(m.k, F, base.ctx.x0, settings)), 9);
      const [put, call] = ms as [(typeof ms)[0], (typeof ms)[0]];
      const axisY = chart.plot.top + chart.plot.height;
      // put ▼: 先頭の点が下（axisY − 1）、call ▲: 先頭の点が上（axisY − 9）
      expect(points(put.path)[0]?.[1]).toBeCloseTo(axisY - 1, 1);
      expect(points(call.path)[0]?.[1]).toBeCloseTo(axisY - 9, 1);
      expect(put).toMatchObject({
        type: 'put',
        side: 'sell',
        qty: 3,
        times: '×3',
        selected: false,
      });
      expect(call).toMatchObject({
        type: 'call',
        side: 'buy',
        qty: 1,
        times: null,
        selected: true,
      });
      expect(put.draggable).toBe(true);
    },
  );

  it('表示範囲の外は出さない・ドラッグ中の足は drag.k の位置', () => {
    const base = baseOf(withQty);
    const narrow = chartOf(base, ZERO_SCENARIO, [62_000, 66_000]);
    expect(
      legMarkers(withQty.legs, base, narrow, { selected: null, drag: null }).map((m) => m.id),
    ).toEqual([1]);
    const chart = chartOf(base, ZERO_SCENARIO);
    const [a] = legMarkers(withQty.legs, base, chart, { selected: null, drag: null });
    const [b] = legMarkers(withQty.legs, base, chart, {
      selected: null,
      drag: { id: 1, k: 64000 },
    });
    expect(b?.k).toBe(64000);
    expect((b?.px ?? 0) - (a?.px ?? 0)).toBeGreaterThan(0);
    expect(
      legMarkers([], null, chartOf(null, ZERO_SCENARIO), { selected: null, drag: null }),
    ).toEqual([]);
  });

  it('手入力の OP の足（optionMarket あり）はドラッグしない', () => {
    const base = baseOf(withQty);
    const chart = chartOf(base, ZERO_SCENARIO);
    const leg = withQty.legs[0] as UiLeg;
    const manual: UiLeg = {
      ...leg,
      optionMarket: {
        expiry: M1,
        market: base.ctx.options[M1] as NonNullable<UiLeg['optionMarket']>['market'],
      },
    };
    const [m] = legMarkers([manual], base, chart, { selected: null, drag: null });
    expect(m?.draggable).toBe(false);
  });
});

describe('strikeAtPx', () => {
  const s = strangle();
  const base = baseOf(s);
  const chart = chartOf(base, ZERO_SCENARIO);
  const month = chain.months[0];
  if (!month) throw new Error('限月が無い');
  const F = base.ctx.options[M1]?.forward as number;

  it('板の K の画素を渡すとその K（往復）。等距離は小さい方', () => {
    const sx = linear(chart.domain, [chart.plot.left, chart.plot.left + chart.plot.width]);
    for (const k of [63500, 63625, 64000, 70875]) {
      const px = sx(axisX(k, F, base.ctx.x0, base.settings));
      expect(strikeAtPx(px, month.rows, F, base.ctx.x0, base.settings, chart)).toBe(k);
    }
    const mid = sx(axisX(63562.5, F, base.ctx.x0, base.settings));
    expect(strikeAtPx(mid, month.rows, F, base.ctx.x0, base.settings, chart)).toBe(63500);
    expect(strikeAtPx(0, [], F, base.ctx.x0, base.settings, chart)).toBeNull();
    expect(strikeAtPx(0, month.rows, Number.NaN, base.ctx.x0, base.settings, chart)).toBeNull();
  });
});

describe('bigReadout（AC-2 d）', () => {
  const s = strangle();
  const base = baseOf(s);

  it('Δ +0.324 → +0.32 (+3.2)、損益の符号と色、0 は無色', () => {
    const sc = { ...ZERO_SCENARIO, days: 3, dX: -400, dSigma: 2 };
    const metrics = metricsModel({ base, scenario: sc, unit: 'auto' });
    const r = readoutModel({ base, metrics, scenario: sc });
    const fake = {
      ...r,
      greeks: { ...r.greeks, deltaLarge: 0.324, deltaMini: 3.24, gammaPer100: -0.0104 },
      text: { ...r.text, pnlDate: '+1,234', pnlExpiry: '−617', pnlToday: '0' },
    };
    const items = bigReadout(fake, metrics.premium, base.ctx.evalTime, sc.dSigma);
    expect(items.map((i) => i.key)).toEqual([
      'date',
      'expiry',
      'delta',
      'theta',
      'vega',
      'premium',
    ]);
    expect(items.map((i) => i.tier)).toEqual(['base', 'base', 'base', 'x1', 'x1', 'x2']);
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by.delta?.value).toBe('+0.32 (+3.2)');
    expect(by.delta?.sub).toBe('Γ −0.010 /100円');
    expect(by.delta?.tone).toBeNull();
    expect(by.date).toMatchObject({ value: '+1,234', tone: 'gain', hero: true, unit: r.unitLabel });
    expect(by.expiry).toMatchObject({ value: '−617', tone: 'loss', sub: '今日 0' });
    expect(
      bigReadout({ ...fake, text: { ...fake.text, pnlDate: '0' } }, null, null)[0]?.tone,
    ).toBeNull();
    expect(by.date?.label).toMatch(/^損益 · d 3（\d\d\/\d\d）$/);
    // #107: Δσ は全文（と IV レールの吹き出し）で読む。副題は X と ΔX（円と %）だけ
    expect(by.date?.sub).toBe(`X ${r.text.x} (${r.text.dX}/${r.text.dXPct}%)`);
    expect(by.delta?.label).toBe('Δ ラージ(ミニ)');
  });

  it('値は readoutModel の文字列のまま（丸めだけが違う）', () => {
    const sc = { ...ZERO_SCENARIO, dX: 300 };
    const metrics = metricsModel({ base, scenario: sc, unit: 'auto' });
    const r = readoutModel({ base, metrics, scenario: sc });
    const by = Object.fromEntries(
      bigReadout(r, metrics.premium, base.ctx.evalTime).map((i) => [i.key, i]),
    );
    expect(by.date?.value).toBe(r.text.pnlDate);
    expect(by.date?.label).toBe('損益 · 今日（シナリオ 0）');
    expect(by.expiry?.value).toBe(r.text.pnlExpiry);
    expect(by.theta?.value).toBe(r.text.theta);
    expect(by.vega?.value).toBe(r.text.vega);
    expect(r.text.deltaLarge.startsWith(by.delta?.value.slice(0, 4) ?? 'x')).toBe(true);
    // 売りだけ = 受取超 → 受取 − 支払（符号付き）
    expect(by.premium?.label).toBe('受取 − 支払');
    expect(by.premium?.value.startsWith('+')).toBe(true);
  });

  it('足 0 本は「—」', () => {
    const metrics = metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'auto' });
    const r = readoutModel({ base: null, metrics, scenario: ZERO_SCENARIO });
    const items = bigReadout(r, null, null);
    expect(items).toHaveLength(6);
    for (const i of items) expect(i).toMatchObject({ value: '—', sub: '', tone: null, unit: '' });
  });
});

describe('bigReadout の全文（#107 AC-1・AC-2）', () => {
  const s = strangle();
  const base = baseOf(s);
  const buy2 = stateWith(
    { type: 'addBoardLeg', expiry: M1, k: 63500, optionType: 'put', side: 'buy' },
    { type: 'addBoardLeg', expiry: M1, k: 71000, optionType: 'call', side: 'buy' },
  );
  const sc = { ...ZERO_SCENARIO, days: 1.5, dX: -400, dSigma: 2 };
  const itemsOf = (st: State, scenario: Scenario) => {
    const b = baseOf(st);
    const metrics = metricsModel({ base: b, scenario, unit: 'auto' });
    const r = readoutModel({ base: b, metrics, scenario });
    const items = bigReadout(r, metrics.premium, b.ctx.evalTime, scenario.dSigma);
    return { r, metrics, by: Object.fromEntries(items.map((i) => [i.key, i])), items };
  };

  it('date の全文に副題で省いた Δσ（0 でも出す）、X と ΔX（円と %）', () => {
    const { r, by } = itemsOf(s, sc);
    expect(by.date?.full).toEqual([
      { k: by.date?.label, v: `${r.text.pnlDate} ${r.unitLabel}` },
      { k: 'X', v: r.text.x },
      { k: 'ΔX', v: `${r.text.dX} / ${r.text.dXPct}%` },
      { k: 'Δσ', v: '+2.0 pt' },
    ]);
    expect(by.date?.sub).not.toContain('Δσ');
    const zero = itemsOf(s, { ...sc, dSigma: 0 }).by;
    expect(zero.date?.full?.at(-1)).toEqual({ k: 'Δσ', v: `${fmtSigned(0, 1)} pt` });
  });

  it('expiry・delta・premium の全文（値は readoutModel の文字列・タイルの全文と同じ）、theta・vega は null', () => {
    for (const st of [s, buy2]) {
      const { r, metrics, by } = itemsOf(st, sc);
      expect(by.expiry?.full).toEqual([
        { k: '満期（SQ）', v: `${r.text.pnlExpiry} ${r.unitLabel}` },
        { k: '今日', v: `${r.text.pnlToday} ${r.unitLabel}` },
      ]);
      const g = r.greeks;
      expect(by.delta?.full).toEqual([
        { k: 'Δ ラージ(ミニ)', v: by.delta?.value },
        { k: 'Γ', v: `${fmtSigned(g.gammaPer100, 3)} /100円` },
      ]);
      // premium の全文はタイルの掛け金 / 受取 − 支払の全文と同じ行
      const tile = metricTiles(metrics).find((t) => t.key === 'premium');
      expect(by.premium?.full).toEqual(tile?.full);
      expect(by.premium?.full?.at(-1)).toEqual({
        k: '手数料の合計',
        v: `${fmtAmount(metrics.premium.fees, r.unit)} ${r.unitLabel}`,
      });
      expect(by.theta?.full).toBeNull();
      expect(by.vega?.full).toBeNull();
    }
  });

  it('足 0 本・premium なしは全文 null', () => {
    const metrics = metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'auto' });
    const r = readoutModel({ base: null, metrics, scenario: ZERO_SCENARIO });
    for (const i of bigReadout(r, null, null)) expect(i.full).toBeNull();
    const metricsB = metricsModel({ base, scenario: sc, unit: 'auto' });
    const rb = readoutModel({ base, metrics: metricsB, scenario: sc });
    expect(
      bigReadout(rb, null, base.ctx.evalTime).find((i) => i.key === 'premium')?.full,
    ).toBeNull();
  });

  it(`売り 2 本・買い 2 本: 全文のある 4 項目の副題が幅の単位 ${SUB_MAX_UNITS} 以下`, () => {
    for (const st of [s, buy2]) {
      const { items } = itemsOf(st, sc);
      const withFull = items.filter((i) => i.full !== null);
      expect(withFull.map((i) => i.key)).toEqual(['date', 'expiry', 'delta', 'premium']);
      for (const i of withFull) {
        expect(widthUnits(i.sub), `${i.key}: ${i.sub}`).toBeLessThanOrEqual(SUB_MAX_UNITS);
      }
    }
  });
});

describe('stageKey（AC-4）', () => {
  const x0 = 67_812;
  const ctx = { x0, maxDays: 27.4 };
  const sc = (p: Partial<Scenario>): Scenario => ({ ...ZERO_SCENARIO, ...p });
  const [lo, hi] = dXRange(x0);

  it('← / → で ΔX ∓100（Shift ∓1,000）、dXRange の端で止まる', () => {
    expect(stageKey('ArrowRight', false, sc({}), ctx)).toEqual({ patch: { dX: 100 } });
    expect(stageKey('ArrowLeft', false, sc({}), ctx)).toEqual({ patch: { dX: -100 } });
    expect(stageKey('ArrowRight', true, sc({ dX: 50 }), ctx)).toEqual({ patch: { dX: 1050 } });
    expect(stageKey('ArrowLeft', true, sc({}), ctx)).toEqual({ patch: { dX: -1000 } });
    expect(stageKey('ArrowRight', false, sc({ dX: hi }), ctx)).toBeNull();
    expect(stageKey('ArrowLeft', true, sc({ dX: lo }), ctx)).toBeNull();
    expect(stageKey('ArrowLeft', false, sc({ dX: lo + 40 }), ctx)).toEqual({ patch: { dX: lo } });
  });

  it('↑ / ↓ で Δσ ±0.5、−10 / +40 で止まる', () => {
    expect(stageKey('ArrowUp', false, sc({}), ctx)).toEqual({ patch: { dSigma: 0.5 } });
    expect(stageKey('ArrowDown', false, sc({ dSigma: 2 }), ctx)).toEqual({
      patch: { dSigma: 1.5 },
    });
    expect(stageKey('ArrowUp', false, sc({ dSigma: 40 }), ctx)).toBeNull();
    expect(stageKey('ArrowDown', false, sc({ dSigma: -10 }), ctx)).toBeNull();
  });

  it('[ / ] で d ∓1（格子に乗せない）、0 / 上限で止まる', () => {
    expect(stageKey(']', false, sc({ days: 1.5 }), ctx)).toEqual({ patch: { days: 2.5 } });
    expect(stageKey('[', false, sc({ days: 1.5 }), ctx)).toEqual({ patch: { days: 0.5 } });
    expect(stageKey('[', false, sc({ days: 0.5 }), ctx)).toEqual({ patch: { days: 0 } });
    expect(stageKey('[', false, sc({ days: 0 }), ctx)).toBeNull();
    expect(stageKey(']', false, sc({ days: 27 }), ctx)).toEqual({ patch: { days: 27.4 } });
    expect(stageKey(']', false, sc({ days: 27.4 }), ctx)).toBeNull();
    expect(stageKey(']', false, sc({}), { x0, maxDays: 0 })).toBeNull();
  });

  it('0 は resetScenario、他のキーは null（+ − R は今の規則）', () => {
    expect(stageKey('0', false, sc({ dX: 100 }), ctx)).toEqual({ reset: true });
    for (const k of ['+', '-', 'r', 'R', ',', 'a', 'Enter'])
      expect(stageKey(k, false, sc({}), ctx)).toBeNull();
  });
});

describe('stageFrame・stageMarkLabels', () => {
  it('通常は余白を残し、ミニは viewBox の原点を余白の分ずらす', () => {
    expect(stageFrame(400, 200, false)).toEqual({
      plotWidth: 400 - PNL_MARGIN.left - PNL_MARGIN.right,
      plotHeight: 200 - PNL_MARGIN.top - PNL_MARGIN.bottom,
      viewBox: '0 0 400 200',
      offsetX: 0,
      offsetY: 0,
    });
    expect(stageFrame(360, 40, true)).toEqual({
      plotWidth: 360,
      plotHeight: 40,
      viewBox: `${PNL_MARGIN.left} ${PNL_MARGIN.top} 360 40`,
      offsetX: PNL_MARGIN.left,
      offsetY: PNL_MARGIN.top,
    });
    expect(stageFrame(10, 10, false).plotWidth).toBe(1);
  });

  it('ラベルをハンドルから 16px（入らなければ動かさない）。文言・向きは同じ', () => {
    const s = strangle();
    const base = baseOf(s);
    const chart = chartOf(base, { ...ZERO_SCENARIO, days: 5 });
    const marks = scenarioMarks({
      base,
      scenario: { ...ZERO_SCENARIO, days: 5 },
      chart,
      unit: 'yen',
    });
    if (!marks) throw new Error('交点が無い');
    const moved = stageMarkLabels(marks, chart);
    moved.forEach((m, i) => {
      const o = marks.marks[i];
      expect(m.text).toBe(o?.text);
      expect(m.anchor).toBe(o?.anchor);
      expect(Math.abs(m.labelX - marks.px)).toBe(16);
      expect(m.labelX - (o?.labelX ?? 0)).toBe(
        m.anchor === 'start' ? STAGE_LABEL_SHIFT : -STAGE_LABEL_SHIFT,
      );
    });
    // 右端の近くで右に入らなければ動かさない（線が無ければ縦も動かさない）
    const plot = { left: 56, top: 10, width: 200, height: 100 };
    const text = '満 +1,234円';
    const w = labelWidth(text);
    const px = 56 + 200 - 4 - w - 6;
    const near = {
      x: 0,
      px,
      marks: [
        {
          kind: 'expiry' as const,
          y: 0,
          py: 50,
          edge: null,
          text,
          labelX: px + 4,
          labelY: 50,
          anchor: 'start' as const,
        },
      ],
    };
    const flat = {
      plot,
      lines: [],
      domain: [0, 1] as [number, number],
      yDomain: [-1, 1] as [number, number],
    };
    expect(stageMarkLabels(near, flat)[0]).toEqual(near.marks[0]);
  });

  /** ラベルの箱（11px の文字の見積もり）が線・他のラベルと重ならず、描画域の中 */
  function expectClear(chart: PnlChartModel, labels: ReturnType<typeof stageMarkLabels>) {
    const { plot } = chart;
    const sx = linear(chart.domain, [plot.left, plot.left + plot.width]);
    const sy = linear(chart.yDomain, [plot.top + plot.height, plot.top]);
    const boxes = labels.map((m) => {
      const w = labelWidth(m.text) * 1.15;
      const x0 = m.anchor === 'start' ? m.labelX : m.labelX - w;
      return { x0, x1: x0 + w, y0: m.labelY - 7, y1: m.labelY + 7 };
    });
    for (const b of boxes) {
      expect(b.y0).toBeGreaterThanOrEqual(plot.top - 1e-9);
      expect(b.y1).toBeLessThanOrEqual(plot.top + plot.height + 1e-9);
      for (const l of chart.lines) {
        // 箱の横の範囲を 1px ごとに線の値で調べる（折れ線の線形補間）
        const px = l.xs.map((x) => sx(x));
        const py = l.ys.map((y) => sy(y));
        for (let x = Math.ceil(b.x0); x <= b.x1; x++) {
          const i = px.findIndex((p) => p >= x);
          if (i <= 0) continue;
          const t = (x - (px[i - 1] as number)) / ((px[i] as number) - (px[i - 1] as number));
          const y = (py[i - 1] as number) + ((py[i] as number) - (py[i - 1] as number)) * t;
          expect(y < b.y0 || y > b.y1, `${l.kind} x ${x}`).toBe(true);
        }
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i] as (typeof boxes)[0];
        const c = boxes[j] as (typeof boxes)[0];
        const xOverlap = a.x0 < c.x1 && c.x0 < a.x1;
        expect(xOverlap && Math.abs((labels[i]?.labelY ?? 0) - (labels[j]?.labelY ?? 0)) < 13).toBe(
          false,
        );
      }
    }
  }

  it.each([
    ['d 5', { days: 5 }, 1000, 260],
    ['d 12・ΔX +300・Δσ −1.5', { days: 12, dX: 300, dSigma: -1.5 }, 1000, 260],
    ['d 1.5・ΔX −400・Δσ +2（スマホの高さ）', { days: 1.5, dX: -400, dSigma: 2 }, 1000, 120],
    ['d 0（満期と今日だけ）', {}, 1000, 260],
    // 実機の大きさ（390×844 の peek・360×780 の peek と、ピンで縦が詰まったとき）。±45px に空きが無い
    ['390 peek: d 1.5・ΔX −400・Δσ +2', { days: 1.5, dX: -400, dSigma: 2 }, 290, 130],
    ['360 peek: d 1.5・ΔX −400・Δσ +2', { days: 1.5, dX: -400, dSigma: 2 }, 262, 95],
    ['390 ピン: d 1.5・ΔX −400・Δσ +2', { days: 1.5, dX: -400, dSigma: 2 }, 290, 80],
    ['390 peek: d 5・ΔX +200', { days: 5, dX: 200 }, 290, 130],
  ] as const)(
    '%s: ラベルは線（満期・指定日・今日）と他のラベルに重ならない',
    (_n, p, width, height) => {
      const base = baseOf(strangle());
      const sc = { ...ZERO_SCENARIO, ...p };
      const chart = pnlChartModel({
        base,
        scenario: sc,
        viewport: null,
        pnlY: DEFAULT_PNL_Y,
        plotWidth: width,
        plotHeight: height,
      });
      const marks = scenarioMarks({ base, scenario: sc, chart, unit: 'thousand' });
      if (!marks) throw new Error('交点が無い');
      expectClear(chart, stageMarkLabels(marks, chart));
    },
  );

  /** ラベルの箱（11px の文字の見積もり）が箱 o と重なるか */
  const hitsBox = (m: ReturnType<typeof stageMarkLabels>[number], o: MarkObstacle) => {
    const w = labelWidth(m.text) * 1.15;
    const x0 = m.anchor === 'start' ? m.labelX : m.labelX - w;
    return o.x0 < x0 + w && x0 < o.x1 && o.y0 < m.labelY + 7 && m.labelY - 7 < o.y1;
  };

  it('避ける箱（IV レールの吹き出しなど）に重ならない（レビュー should-1）', () => {
    const base = baseOf(strangle());
    const sc = { ...ZERO_SCENARIO, days: 12, dX: 300, dSigma: -1.5 };
    // 390×844 の peek の大きさ（描画域 290×130、要素の幅 = 290 + 56 + 12）
    const chart = pnlChartModel({
      base,
      scenario: sc,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 290,
      plotHeight: 130,
    });
    const marks = scenarioMarks({ base, scenario: sc, chart, unit: 'thousand' });
    if (!marks) throw new Error('交点が無い');
    // (1) 置いた後のラベルの 1 つの場所を箱にすると、その箱を避けて置き直す
    const free = stageMarkLabels(marks, chart);
    const target = free[free.length - 1] as (typeof free)[number];
    const w = labelWidth(target.text) * 1.15;
    const x0 = target.anchor === 'start' ? target.labelX : target.labelX - w;
    const box: MarkObstacle = { x0, x1: x0 + w, y0: target.labelY - 7, y1: target.labelY + 7 };
    expect(hitsBox(target, box)).toBe(true);
    const moved = stageMarkLabels(marks, chart, [box]);
    for (const m of moved) expect(hitsBox(m, box)).toBe(false);
    expectClear(chart, moved);
    // (2) 実際の IV レールの吹き出し（Δσ −1.5・レールの高さ = 描画域の要素の高さ 130 + 36）
    const rail = ivRailObstacle(sc.dSigma, 130 + 36, 290 + 56 + 12);
    expect(rail.x1 - rail.x0).toBeGreaterThan(40);
    for (const m of stageMarkLabels(marks, chart, [rail])) expect(hitsBox(m, rail)).toBe(false);
  });

  it('ivRailBubble / ivRailObstacle: 文言・箱は ivRailY と同じ高さ、レールの左 4px で終わる', () => {
    const b = ivRailBubble(-1.5, 200);
    expect(b.text).toBe('Δσ −1.5pt');
    expect(b.y).toBe(ivRailY(-1.5, 200));
    const o = ivRailObstacle(-1.5, 200, 300);
    expect(o).toEqual({ x0: 296 - b.w, x1: 296, y0: b.y - 7.5, y1: b.y + 7.5 });
  });
});

describe('レール（AC-3）', () => {
  it('IV レール: 上端 = +40・下端 = −10、0.5 の格子、範囲の外で止まる、往復で同じ値', () => {
    const h = 300;
    expect(ivRailY(40, h)).toBe(IV_RAIL_PAD);
    expect(ivRailY(-10, h)).toBe(h - IV_RAIL_PAD);
    expect(ivRailY(99, h)).toBe(IV_RAIL_PAD);
    expect(ivRailValue(0, h)).toBe(40);
    expect(ivRailValue(h, h)).toBe(-10);
    for (let v = -10; v <= 40; v += 0.5) expect(ivRailValue(ivRailY(v, h), h)).toBe(v);
    expect(ivRailValue(ivRailY(2, h) - 1, h)).toBe(2);
    expect(Number.isInteger(ivRailValue(123.4, h) * 2)).toBe(true);
  });

  it('時間レール: 0 → 左端・最遠の SQ → 右端、1 日の格子、上限 0 で無効', () => {
    const w = 400;
    const max = 27.4;
    expect(timeRailX(0, w, max)).toBe(TIME_RAIL_PAD);
    expect(timeRailX(max, w, max)).toBe(w - TIME_RAIL_PAD);
    expect(timeRailValue(TIME_RAIL_PAD, w, max)).toBe(0);
    expect(timeRailValue(w - TIME_RAIL_PAD, w, max)).toBe(max);
    expect(timeRailValue(w, w, max)).toBe(max);
    expect(timeRailValue(-50, w, max)).toBe(0);
    const v = timeRailValue(150, w, max);
    expect(Number.isInteger(v)).toBe(true);
    for (let d = 0; d <= 27; d++) expect(timeRailValue(timeRailX(d, w, max), w, max)).toBe(d);
    expect(timeRailX(5, w, 0)).toBe(TIME_RAIL_PAD);
    expect(timeRailValue(200, w, 0)).toBe(0);
    expect(timeRailTicks([], 0, 0, w)).toEqual([]);
  });

  it('目盛りの値は daysToTarget、近い目盛りの文字は重ならない、railPick は目盛りの ±10px', () => {
    const s = stateWith(
      { type: 'addBoardLeg', expiry: M1, k: 63500, optionType: 'put', side: 'sell' },
      {
        type: 'addBoardLeg',
        expiry: chain.months[1]?.id ?? '',
        k: 63000,
        optionType: 'put',
        side: 'sell',
      },
    );
    const base = baseOf(s);
    const targets: EvalTimeTarget[] = evalTimeTargets(chain, s.legs, s.calendar);
    expect(targets.length).toBe(2);
    const et = base.ctx.evalTime;
    const w = 360;
    const ticks = timeRailTicks(targets, et, base.maxDays, w);
    expect(ticks).toHaveLength(4);
    for (const t of targets) {
      const sq = ticks.find((x) => x.id === `${t.id}:sq`);
      const last = ticks.find((x) => x.id === `${t.id}:last`);
      expect(sq?.days).toBe(daysToTarget(et, t.sqTime, base.maxDays));
      expect(last?.days).toBe(daysToTarget(et, t.lastTradeClose, base.maxDays));
      expect(sq?.label).toMatch(/^\d+月 SQ \d\d\/\d\d$/);
      expect(last?.label).toBeNull();
    }
    // 最遠の SQ は右端
    expect(Math.max(...ticks.map((t) => t.x))).toBeCloseTo(w - TIME_RAIL_PAD, 6);
    // 文字の区間が重ならない（左寄せ・中央・右寄せを考えて）
    const spans = ticks
      .filter((t) => t.label !== null)
      .map((t) => {
        const lw = labelWidth(t.label as string);
        const l =
          t.anchor === 'start' ? t.labelX : t.anchor === 'end' ? t.labelX - lw : t.labelX - lw / 2;
        return [l, l + lw] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
    for (const [l, r] of spans) {
      expect(l).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(w);
    }
    // 狭いと重なる文字を省く（点は残す）
    const narrow = timeRailTicks(targets, et, base.maxDays, 120);
    expect(narrow).toHaveLength(4);
    expect(narrow.filter((t) => t.label !== null).length).toBeLessThan(2);
    // タップ: 目盛りの ±10px ならその d（端数あり）、それ以外は 1 日の格子
    const sq1 = ticks.find((t) => t.id === `${M1}:sq`);
    if (!sq1) throw new Error('SQ の目盛りが無い');
    expect(railPick(sq1.x + 9, ticks, w, base.maxDays)).toBe(sq1.days);
    expect(Number.isInteger(railPick(TIME_RAIL_PAD + 40, ticks, w, base.maxDays))).toBe(true);
  });
});

describe('timeRailText', () => {
  it('「d N 日 · MM/DD HH:mm（曜）」（JST）', () => {
    // 2026-11-13 09:00 JST（金）= 2026-11-13T00:00Z
    const t = Date.UTC(2026, 10, 13, 0, 0);
    expect(timeRailText(0, t)).toBe('d 0 日 · 11/13 09:00（金）');
    expect(timeRailText(1.5, t)).toBe('d 1.5 日 · 11/14 21:00（土）');
    expect(timeRailText(2, null)).toBe('d 2 日');
  });
});

describe('timeRailNow', () => {
  it('左端に「今 MM/DD」。目盛りの文字と重なるときは出さない', () => {
    const t = Date.UTC(2026, 9, 13, 12, 31);
    const far: TimeRailTick[] = [
      {
        id: 'a:sq',
        kind: 'sq',
        days: 30,
        x: 340,
        label: '11月 SQ 11/13',
        labelX: 352,
        anchor: 'end',
      },
    ];
    expect(timeRailNow(t, far)).toEqual({ label: '今 10/13', x: 6 });
    const near: TimeRailTick[] = [
      { ...(far[0] as TimeRailTick), x: 40, labelX: 40, anchor: 'middle' },
    ];
    expect(timeRailNow(t, near)).toBeNull();
    expect(timeRailNow(null, far)).toBeNull();
  });
});

describe('timeRailLayout（レビュー S4）', () => {
  const tick = (x: number, label: string | null): TimeRailTick => ({
    id: `t${x}`,
    kind: 'sq',
    days: x / 10,
    x,
    label,
    labelX: x,
    anchor: 'middle',
  });
  it('吹き出しはレールの幅の中、重なる目盛りの文字・「今」は消す（点は残す）', () => {
    const text = 'd 1.5 日 · 10/15 09:31（木）';
    const ticks = [tick(60, '11月 SQ 11/13'), tick(300, '12月 SQ 12/11')];
    const now = { label: '今 10/13', x: 6 };
    const a = timeRailLayout(ticks, now, 14, text, 360);
    expect(a.bubble.x0).toBeGreaterThanOrEqual(0);
    expect(a.now).toBeNull();
    expect(a.ticks[0]?.label).toBeNull();
    expect(a.ticks[1]?.label).toBe('12月 SQ 12/11');
    expect(a.ticks).toHaveLength(2);
    const b = timeRailLayout(ticks, now, 355, text, 360);
    expect(b.bubble.x1).toBeLessThanOrEqual(360);
    expect(b.now).toEqual(now);
    expect(b.ticks[1]?.label).toBeNull();
    // 残った文字は吹き出しと重ならない
    for (const l of [a, b]) {
      for (const t of l.ticks) {
        if (t.label === null) continue;
        const w = labelWidth(t.label);
        expect(t.x + w / 2 <= l.bubble.x0 || t.x - w / 2 >= l.bubble.x1).toBe(true);
      }
    }
  });
});

describe('IV レールの感度の上限（レビュー）', () => {
  it('トラック < 200px は相対（1px あたり 0.25pt まで）、それ以上は押した位置の値', () => {
    expect(IV_RAIL_MAX_RATE).toBe(0.25);
    expect(ivRailRelative(2 * IV_RAIL_PAD + 199)).toBe(true);
    expect(ivRailRelative(2 * IV_RAIL_PAD + 200)).toBe(false);
    expect(ivRailRelative(10)).toBe(true);
    expect(ivRailDragValue(2, -40)).toBe(12);
    expect(ivRailDragValue(2, 1)).toBe(2);
    expect(ivRailDragValue(2, 3)).toBe(1.5);
    expect(ivRailDragValue(39, -40)).toBe(40);
    expect(ivRailDragValue(-9, 40)).toBe(-10);
    // 1px の移動で動くのは 0.5pt 以下
    for (let dy = -60; dy < 60; dy++) {
      expect(Math.abs(ivRailDragValue(0, dy + 1) - ivRailDragValue(0, dy))).toBeLessThanOrEqual(
        0.5,
      );
    }
  });
});

describe('emptyStageGrid（#111）', () => {
  /** 架空の X₀ */
  const X0 = 70_000;
  const NUM = /^\d{1,3}(,\d{3})*$/;
  const inside = (g: ReturnType<typeof emptyStageGrid>) => {
    const { left, top, width, height } = g.plot;
    for (const x of g.xLines) {
      expect(x).toBeGreaterThanOrEqual(left - 1e-9);
      expect(x).toBeLessThanOrEqual(left + width + 1e-9);
    }
    for (const y of [...g.yLines, g.zeroPy]) {
      expect(y).toBeGreaterThanOrEqual(top - 1e-9);
      expect(y).toBeLessThanOrEqual(top + height + 1e-9);
    }
  };

  it('空の格子: X₀ があれば X₀ が横軸の範囲の内側で、横の目盛りの文言は足があるときと同じ書式', () => {
    // 足があるときの横の目盛りの書式（合成の板のストラングル）
    const full = chartOf(baseOf(strangle()), ZERO_SCENARIO);
    expect(full.xTicks.length).toBeGreaterThan(0);
    for (const t of full.xTicks) expect(t.label).toMatch(NUM);
    for (const plotWidth of [292, 540, 1200]) {
      const g = emptyStageGrid({ x0: X0, plotWidth, plotHeight: 200 });
      expect(g.xTicks.length).toBeGreaterThanOrEqual(2);
      const lo = X0 * 0.98;
      const hi = X0 * 1.02;
      expect(lo).toBeLessThan(X0);
      expect(X0).toBeLessThan(hi);
      let prev = -Infinity;
      for (const t of g.xTicks) {
        expect(t.v).toBeGreaterThanOrEqual(lo);
        expect(t.v).toBeLessThanOrEqual(hi);
        expect(t.v).toBeGreaterThan(prev);
        prev = t.v;
        expect(t.label).toBe(fmtNum(t.v, 0));
        expect(t.label).toMatch(NUM);
        expect(t.px).toBeCloseTo(
          linear([lo, hi], [g.plot.left, g.plot.left + g.plot.width])(t.v),
          9,
        );
      }
      expect(g.xLines).toEqual(g.xTicks.map((t) => t.px));
      inside(g);
    }
  });

  it('空の格子: X₀ が NaN なら横の目盛りの文言なし・格子線は縦横とも 2 本以上', () => {
    for (const x0 of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const g = emptyStageGrid({ x0, plotWidth: 292, plotHeight: 180 });
      expect(g.xTicks).toEqual([]);
      expect(g.xLines.length).toBeGreaterThanOrEqual(2);
      expect(g.yLines.length).toBeGreaterThanOrEqual(2);
      expect(g.xLines[0]).toBeCloseTo(g.plot.left, 9);
      expect(g.xLines.at(-1)).toBeCloseTo(g.plot.left + g.plot.width, 9);
      inside(g);
    }
  });

  it('空の格子: 0 の線は描画域の内側（縦の中央）・縦の目盛りの文言なし', () => {
    const g = emptyStageGrid({ x0: X0, plotWidth: 540, plotHeight: 220 });
    expect(g.zeroPy).toBeGreaterThan(g.plot.top);
    expect(g.zeroPy).toBeLessThan(g.plot.top + g.plot.height);
    expect(g.zeroPy).toBeCloseTo(g.plot.top + g.plot.height / 2, 9);
    expect(g.yLines[0]).toBeCloseTo(g.plot.top, 9);
    expect(g.yLines.at(-1)).toBeCloseTo(g.plot.top + g.plot.height, 9);
    // 縦の目盛り（値・文言・単位）を持たない
    expect(Object.keys(g).sort()).toEqual(['plot', 'xLines', 'xTicks', 'yLines', 'zeroPy']);
    // 描画域は pnlChartModel の空のときと同じ
    const empty = pnlChartModel({
      base: null,
      scenario: ZERO_SCENARIO,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 540,
      plotHeight: 220,
    });
    expect(empty.empty).toBe(true);
    expect(g.plot).toEqual(empty.plot);
    expect(g.plot.left).toBe(PNL_MARGIN.left);
  });

  it('空の格子: 幅・高さが 1 でも例外なし・値はすべて有限', () => {
    for (const x0 of [X0, Number.NaN]) {
      for (const size of [1, 0, -5, Number.NaN]) {
        const g = emptyStageGrid({ x0, plotWidth: size, plotHeight: size });
        const all = [
          ...Object.values(g.plot),
          ...g.xLines,
          ...g.yLines,
          g.zeroPy,
          ...g.xTicks.flatMap((t) => [t.v, t.px]),
        ];
        for (const v of all) expect(Number.isFinite(v)).toBe(true);
        expect(g.plot.width).toBe(1);
        expect(g.plot.height).toBe(1);
        inside(g);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { preparePosition, type Scenario, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import type { Domain } from '../../ui/chart/scale';
import { amountUnit, fmtAmount, metricsModel } from '../../ui/view/metrics';
import {
  DEFAULT_PNL_Y,
  type PnlBase,
  type PnlChartModel,
  pnlChartModel,
  pnlDomains,
  todayScenario,
} from '../../ui/view/pnlChart';
import {
  LABEL_GAP,
  LABEL_H,
  labelWidth,
  markText,
  placeLabels,
  scenarioMarks,
} from '../../ui/view/scenarioMarks';
import { M1, M2, makeMarket } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/**
 * #52 AC-6〜AC-8: シナリオ点の縦線と線の交点・金額のラベル（純関数）。合成の板・架空の値。
 * pnlChart.test.ts（#32 で重い）とは分けて置く。
 */

const { ctx, rows } = makeMarket();
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const base = pnlDomains(board, preparePosition(PERF_LEGS.slice(0, 4), ctx), ctx) as PnlBase;
if (!base) throw new Error('損益グラフの基礎が作れない');
const x0 = base.ctx.x0;
const PLOT_W = 600;
const PLOT_H = 220;

function chartOf(sc: Scenario, viewport: Domain | null = null): PnlChartModel {
  return pnlChartModel({
    base,
    scenario: sc,
    viewport,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: PLOT_W,
    plotHeight: PLOT_H,
  });
}

const marksOf = (sc: Scenario, viewport: Domain | null = null, unit = 'yen' as const) =>
  scenarioMarks({ base, scenario: sc, chart: chartOf(sc, viewport), unit });

describe('交点の値（AC-6）', () => {
  it('満期 = base.expiry(X_s)、指定日 = 指標の scenarioPoint.pnl、今日 = theoreticalPnl(todayScenario) と 1 円以内', () => {
    for (const sc of [
      { ...ZERO_SCENARIO, days: 6, dX: -1_230, dSigma: 3, beta: 1 },
      { ...ZERO_SCENARIO, days: 0, dX: 870, skew: 1.5 },
      { ...ZERO_SCENARIO, days: 12.5, dX: 2_000, ivDynamics: 'sticky_moneyness' as const },
    ]) {
      const r = marksOf(sc);
      if (!r) throw new Error('交点が無い');
      const xs = x0 + sc.dX;
      expect(r.x).toBeCloseTo(xs, 9);
      const by = Object.fromEntries(r.marks.map((m) => [m.kind, m.y]));
      const mm = metricsModel({ base, scenario: sc, unit: 'auto' });
      expect(Math.abs((by.expiry as number) - base.expiry(xs))).toBeLessThan(1);
      expect(Math.abs((by.date as number) - mm.scenarioPoint.pnl)).toBeLessThan(1);
      const today = theoreticalPnl(base.legs, xs, todayScenario(sc), base.ctx, base.settings);
      expect(Math.abs((by.today as number) - today)).toBeLessThan(1);
      expect(r.marks.map((m) => m.kind)).toEqual(['expiry', 'date', 'today']);
    }
  });

  it('指定日の線を描かない条件（d = 0・Δσ = Δs = 0）では指定日の交点が無い', () => {
    const r = marksOf({ ...ZERO_SCENARIO, dX: 500 });
    expect(r?.marks.map((m) => m.kind)).toEqual(['expiry', 'today']);
  });

  it('ΔX = 0 なら X₀ 上に出る。X_s が表示範囲外なら交点なし', () => {
    const r = marksOf(ZERO_SCENARIO);
    expect(r?.x).toBe(x0);
    const chart = chartOf(ZERO_SCENARIO);
    expect(r?.px).toBeCloseTo(chart.x0Px as number, 9);
    expect(marksOf({ ...ZERO_SCENARIO, dX: -3_000 }, [x0, x0 + 5_000])).toBeNull();
    expect(marksOf({ ...ZERO_SCENARIO, dX: 3_000 }, [x0 - 5_000, x0])).toBeNull();
  });

  it('足なし・空のグラフは null（例外なし）', () => {
    const empty = pnlChartModel({
      base: null,
      scenario: ZERO_SCENARIO,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
    });
    expect(
      scenarioMarks({ base: null, scenario: ZERO_SCENARIO, chart: empty, unit: 'yen' }),
    ).toBeNull();
  });

  it('交点の画素は線の縦軸の写像と同じ（描画域の内側なら点を出す）', () => {
    const sc = { ...ZERO_SCENARIO, days: 6, dX: -800 };
    const chart = chartOf(sc);
    const r = scenarioMarks({ base, scenario: sc, chart, unit: 'yen' });
    const { plot, yDomain } = chart;
    for (const m of r?.marks ?? []) {
      const want =
        plot.top + plot.height - ((m.y - yDomain[0]) / (yDomain[1] - yDomain[0])) * plot.height;
      expect(m.edge).toBeNull();
      expect(m.py).toBeCloseTo(want, 6);
    }
  });
});

describe('ラベルの配置（AC-7）', () => {
  const plot = { left: 56, top: 10, width: 300, height: 184 };
  const bottom = plot.top + plot.height;
  const right = plot.left + plot.width;
  const texts = ['満 +12,345円', '指 −6,789円', '今 +1,234円'];

  function check(pys: number[], px: number) {
    const placed = placeLabels(
      pys.map((py, i) => ({ py, text: texts[i] as string })),
      plot,
      px,
    );
    const ys = placed.map((p) => p.labelY).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(LABEL_GAP - 1e-9);
    }
    placed.forEach((p, i) => {
      expect(p.labelY - LABEL_H / 2).toBeGreaterThanOrEqual(plot.top - 1e-9);
      expect(p.labelY + LABEL_H / 2).toBeLessThanOrEqual(bottom + 1e-9);
      const w = labelWidth(texts[i] as string);
      const x1 = p.anchor === 'start' ? p.labelX : p.labelX - w;
      expect(x1).toBeGreaterThanOrEqual(plot.left - 1e-9);
      expect(x1 + w).toBeLessThanOrEqual(right + 1e-9);
    });
    return placed;
  }

  it('3 つが同じ高さでも中心の間隔 ≥ 13px、描画域の内側', () => {
    check([100, 100, 100], 150);
  });

  it('描画域の上端・下端ちょうど、範囲外（上下に外れる）でも内側に収まる', () => {
    check([plot.top, plot.top, plot.top], 150);
    check([bottom, bottom, bottom], 150);
    check([-500, bottom + 900, plot.top + 1], 150);
    check([Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 100], 150);
  });

  it('右端に近いと縦線の左側（text-anchor: end）、余裕があれば右側', () => {
    const near = check([60, 100, 140], right - 3);
    expect(near.every((p) => p.anchor === 'end' && p.labelX < right - 3)).toBe(true);
    const far = check([60, 100, 140], plot.left + 10);
    expect(far.every((p) => p.anchor === 'start' && p.labelX > plot.left + 10)).toBe(true);
  });

  it('範囲外の交点は点を出さず、ラベルの先頭に ▲ / ▼ の印', () => {
    // 縦軸を狭くして満期の値を範囲外にする
    const sc = { ...ZERO_SCENARIO, days: 6, dX: -4_000, dSigma: 5 };
    const chart = chartOf(sc);
    const y = base.expiry(x0 + sc.dX);
    const narrow: PnlChartModel = {
      ...chart,
      yDomain: y > 0 ? [y - 2_000_000, y - 1_000_000] : [y + 1_000_000, y + 2_000_000],
    };
    const r = scenarioMarks({ base, scenario: sc, chart: narrow, unit: 'yen' });
    const ex = r?.marks.find((m) => m.kind === 'expiry');
    expect(ex?.py).toBeNull();
    expect(ex?.edge).toBe(y > 0 ? 'top' : 'bottom');
    expect(ex?.text.startsWith(y > 0 ? '▲満 ' : '▼満 ')).toBe(true);
    for (const m of r?.marks ?? []) {
      expect(m.labelY - LABEL_H / 2).toBeGreaterThanOrEqual(narrow.plot.top - 1e-9);
      expect(m.labelY + LABEL_H / 2).toBeLessThanOrEqual(
        narrow.plot.top + narrow.plot.height + 1e-9,
      );
    }
  });
});

describe('ラベルの金額の単位（AC-8）', () => {
  it('fmtAmount と同じ: 指標の単位（受取 + 支払 99,999 円 = 円、100,000 円 = 千円）の文字列', () => {
    expect(markText('expiry', 12_345, 'yen', null)).toBe(`満 ${fmtAmount(12_345, 'yen', true)}円`);
    expect(markText('date', -6_789, 'thousand', null)).toBe(
      `指 ${fmtAmount(-6_789, 'thousand', true)}千円`,
    );
    expect(markText('today', 0, 'yen', 'bottom')).toBe('▼今 0円');
    expect(markText('expiry', 250_000, 'thousand', 'top')).toBe('▲満 +250千円');
  });

  it('受取 + 支払 99,999 円なら円、100,000 円なら千円（amountUnit → markText）', () => {
    const u1 = amountUnit(60_000, 39_999, 'auto');
    const u2 = amountUnit(60_000, 40_000, 'auto');
    expect(u1).toBe('yen');
    expect(u2).toBe('thousand');
    expect(markText('expiry', 12_345, u1, null)).toBe('満 +12,345円');
    expect(markText('expiry', 12_345, u2, null)).toBe('満 +12.3千円');
  });

  it('指標の単位をそのまま使う（グラフの縦軸の単位とは別）', () => {
    const sc = { ...ZERO_SCENARIO, days: 3, dX: 300 };
    const chart = chartOf(sc);
    const yen = scenarioMarks({ base, scenario: sc, chart, unit: 'yen' });
    const th = scenarioMarks({ base, scenario: sc, chart, unit: 'thousand' });
    yen?.marks.forEach((m, i) => {
      expect(m.text).toBe(markText(m.kind, m.y, 'yen', m.edge));
      expect(th?.marks[i]?.text).toBe(markText(m.kind, m.y, 'thousand', m.edge));
    });
  });
});

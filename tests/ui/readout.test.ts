import { describe, expect, it } from 'vitest';
import { preparePosition, type Scenario, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import { amountUnit, fmtAmount, metricsModel } from '../../ui/view/metrics';
import {
  DEFAULT_PNL_Y,
  type PnlBase,
  pnlChartModel,
  pnlDomains,
  todayScenario,
} from '../../ui/view/pnlChart';
import { readoutModel } from '../../ui/view/readout';
import { scenarioMarks } from '../../ui/view/scenarioMarks';
import { M1, M2, makeMarket } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/** #52 AC-8・AC-9: 読み取りの帯（シナリオ点の値）の表示モデル。合成の板・架空の値。 */

const { ctx, rows } = makeMarket();
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const base = pnlDomains(board, preparePosition(PERF_LEGS, ctx), ctx) as PnlBase;
if (!base) throw new Error('損益グラフの基礎が作れない');
const x0 = base.ctx.x0;

const scenarios: Scenario[] = [
  { ...ZERO_SCENARIO, days: 6, dX: -1_230, dSigma: 3, beta: 1 },
  { ...ZERO_SCENARIO, dX: 870 },
  { ...ZERO_SCENARIO, days: 999, dX: 2_000, skew: -1 },
];

describe('読み取りの帯（AC-9）', () => {
  it('X_s・ΔX（円・%）・d・指定日の損益・合計グリークが metricsModel と一致', () => {
    for (const sc of scenarios) {
      const metrics = metricsModel({ base, scenario: sc, unit: 'auto' });
      const r = readoutModel({ base, metrics, scenario: sc });
      expect(r.empty).toBe(false);
      expect(r.x).toBe(metrics.scenarioPoint.x);
      expect(r.x).toBeCloseTo(x0 + sc.dX, 9);
      expect(r.dX).toBeCloseTo(sc.dX, 9);
      expect(r.dXPct).toBe(metrics.scenarioPoint.dXPct);
      expect(r.days).toBe(metrics.days);
      expect(r.pnl.date).toBe(metrics.scenarioPoint.pnl);
      expect(r.greeks).toEqual(metrics.scenarioPoint.total);
      expect(r.unit).toBe(metrics.unit);
    }
  });

  it('満期・今日の損益が交点（AC-6）と一致', () => {
    for (const sc of scenarios) {
      const metrics = metricsModel({ base, scenario: sc, unit: 'auto' });
      const r = readoutModel({ base, metrics, scenario: sc });
      const xs = x0 + sc.dX;
      expect(r.pnl.expiry).toBe(base.expiry(xs));
      expect(r.pnl.today).toBe(
        theoreticalPnl(base.legs, xs, todayScenario(sc), base.ctx, base.settings),
      );
      const chart = pnlChartModel({
        base,
        scenario: sc,
        viewport: [xs - 3_000, xs + 3_000],
        pnlY: DEFAULT_PNL_Y,
        plotWidth: 400,
        plotHeight: 200,
      });
      const marks = scenarioMarks({ base, scenario: sc, chart, unit: metrics.unit });
      const by = Object.fromEntries(marks?.marks.map((m) => [m.kind, m.y]) ?? []);
      expect(Math.abs((by.expiry as number) - r.pnl.expiry)).toBeLessThan(1);
      expect(Math.abs((by.today as number) - r.pnl.today)).toBeLessThan(1);
      if (by.date !== undefined) expect(Math.abs(by.date - r.pnl.date)).toBeLessThan(1);
      expect(r.hasDate).toBe(by.date !== undefined);
    }
  });

  it('文字列: 金額は指標と同じ単位（fmtAmount）、桁は指標と同じ', () => {
    const sc = scenarios[0] as Scenario;
    const metrics = metricsModel({ base, scenario: sc, unit: 'auto' });
    const r = readoutModel({ base, metrics, scenario: sc });
    const u = metrics.unit;
    expect(r.text.pnlDate).toBe(fmtAmount(r.pnl.date, u, true));
    expect(r.text.pnlExpiry).toBe(fmtAmount(r.pnl.expiry, u, true));
    expect(r.text.pnlToday).toBe(fmtAmount(r.pnl.today, u, true));
    expect(r.text.theta).toBe(fmtAmount(r.greeks.thetaPerDay, u, true));
    expect(r.text.vega).toBe(fmtAmount(r.greeks.vegaPerPt, u, true));
    expect(r.text.x).toBe('66,580');
    expect(r.text.dX).toBe('−1,230');
    expect(r.text.dXPct).toBe('−1.8');
    expect(r.text.days).toBe('6');
    // 単位の固定
    const th = readoutModel({
      base,
      metrics: metricsModel({ base, scenario: sc, unit: 'thousand' }),
      scenario: sc,
    });
    expect(th.unitLabel).toBe('千円');
    expect(th.text.pnlDate).toBe(fmtAmount(r.pnl.date, 'thousand', true));
  });

  it('受取 + 支払 99,999 円なら円、100,000 円なら千円の文字列（AC-8）', () => {
    expect(fmtAmount(-54_321, amountUnit(50_000, 49_999, 'auto'), true)).toBe('−54,321');
    expect(fmtAmount(-54_321, amountUnit(50_000, 50_000, 'auto'), true)).toBe('−54.3');
  });

  it('足 0 本・評価できる足が無いときは空で例外を出さない', () => {
    const metrics = metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'auto' });
    expect(readoutModel({ base: null, metrics, scenario: ZERO_SCENARIO }).empty).toBe(true);
    const noLegs = { ...base, legs: [] };
    const m2 = metricsModel({ base: noLegs, scenario: ZERO_SCENARIO, unit: 'auto' });
    expect(readoutModel({ base: noLegs, metrics: m2, scenario: ZERO_SCENARIO }).empty).toBe(true);
  });
});

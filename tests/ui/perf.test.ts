import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { buildWideChainJson } from '../../scripts/synthBoard';
import { CALENDAR } from '../../ui/calendar';
import { atmStrike, boardRows } from '../../ui/view/board';
import { headerModel } from '../../ui/view/header';
import { metricsModel } from '../../ui/view/metrics';
import {
  DEFAULT_PNL_Y,
  dateLine,
  pnlChartModel,
  pnlDomains,
  todayLine,
} from '../../ui/view/pnlChart';
import { readoutModel } from '../../ui/view/readout';
import { scenarioMarks } from '../../ui/view/scenarioMarks';
import { smileModel } from '../../ui/view/smile';
import { M1, M2, makeMarket } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/**
 * AC-18 の補助（計算部分）: 322 行の板の限月切替で作り直す表示モデル（板の行・スマイル・ヘッダ）の
 * 生成が予算以内。描画（DOM）はブラウザの Performance で手動確認する。
 * CI は共有ランナーなので環境変数 PERF_BUDGET_MS で緩い閾値にする。
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const BUDGET_MS = Number(env?.PERF_BUDGET_MS ?? 16);

describe('性能（AC-18 の計算部分）', () => {
  const chain = normalizeChain(buildWideChainJson());

  function rebuild(): number {
    let acc = 0;
    for (const m of chain.months) {
      acc += boardRows(chain, m).length;
      acc += atmStrike(m, 'A') ?? 0;
      acc += smileModel(m, 'B', 'delta').points.length;
    }
    acc += headerModel(chain, 'B', CALENDAR).months.length;
    return acc;
  }

  it(`2 限月分の表示モデルの生成が ${BUDGET_MS} ms 以内（20 回の最小値）`, () => {
    for (let i = 0; i < 10; i++) rebuild();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      rebuild();
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(BUDGET_MS);
  });
});

/**
 * #11 AC-13（AC8 のグラフの計算部分）: 足 10 本・描画幅 1,000px・d = 5 の損益グラフの表示モデル
 * （3 本の線・縦軸の自動範囲・目盛り・path）の生成が予算以内。ドラッグ・ホイールの 1 フレームで
 * 走るのはこれだけ（板・スマイル・ポジションは memo で作り直さない）。
 */
describe('性能（#11 AC-13: 損益グラフの表示モデル）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario = { ...ZERO_SCENARIO, days: 5 };
  let shift = 0;

  function redraw(): number {
    // パン中を模して表示範囲を毎回少しずらす
    shift = (shift + 37) % 1000;
    const lo = (base?.initial[0] ?? 0) + shift;
    const m = pnlChartModel({
      base,
      scenario,
      viewport: [lo, lo + 20_000],
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
    });
    return m.lines.length + m.yTicks.length + m.xTicks.length + (m.lines[1]?.d.length ?? 0);
  }

  it(`表示モデルの生成が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(redraw()).toBeGreaterThan(3);
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
    });
    expect(m.lines.map((l) => l.xs.length)).toEqual([m.lines[0]?.xs.length, 1000, 1000]);
    for (let i = 0; i < 20; i++) redraw();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      redraw();
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(BUDGET_MS);
  });
});

/**
 * #6 AC-11（AC8 の計算部分）: 足 10 本・描画幅 1,000px で、スライダー 1 回の描き直しに要る計算
 * （損益グラフの表示モデル + 指標 + テール表）が予算以内。今日の線はスライダーで変わらないので部品が memo した
 * 前計算（todayLine）を渡す。表示範囲・β・動き方を変えたとき（今日の線も作り直す）は上の #11 のテスト
 * （3 本の線をすべて作る）と同じ量。
 */
describe('性能（#6 AC-11: スライダー 1 回の描き直し）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario0 = { ...ZERO_SCENARIO, days: 5 };
  const today = todayLine(base, null, 1000, scenario0);
  let tick = 0;

  function slide(): number {
    // ドラッグ中を模して d・ΔX・Δσ・Δs を毎回少しずつ動かす
    tick = (tick + 1) % 40;
    const scenario = {
      ...scenario0,
      days: 5 + tick * 0.5,
      dX: -tick * 100,
      dSigma: tick * 0.5,
      skew: (tick % 10) * 0.5,
    };
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    return (
      m.lines.length + (m.lines[1]?.d.length ?? 0) + mm.tail.rows.length + mm.dateBreakevens.length
    );
  }

  it(`グラフの表示モデル + 指標 + テール表が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(slide()).toBeGreaterThan(8);
    for (let i = 0; i < 20; i++) slide();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      slide();
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(BUDGET_MS);
  });
});

/**
 * #52 AC-10: 長押しドラッグの 1 フレーム（ΔX だけが変わる）。部品が memo した今日・指定日の線（todayLine・
 * dateLine）を渡したグラフの表示モデル + 交点のラベル + 指標 + 読み取りの帯が、足 10 本・幅 1,000px で予算以内。
 */
describe('性能（#52 AC-10: 長押しドラッグの 1 フレーム）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario0 = { ...ZERO_SCENARIO, days: 5, dSigma: 2 };
  const today = todayLine(base, null, 1000, scenario0);
  const date = dateLine(base, null, 1000, scenario0);
  let tick = 0;

  function scrubFrame(): number {
    tick = (tick + 1) % 40;
    const scenario = { ...scenario0, dX: -2_000 + tick * 100 };
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
      dateYs: date,
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
    const r = readoutModel({ base, metrics: mm, scenario });
    return m.lines.length + (marks?.marks.length ?? 0) + mm.tail.rows.length + r.text.x.length;
  }

  it(`グラフの表示モデル + 交点 + 指標 + 帯が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(date).not.toBeNull();
    expect(scrubFrame()).toBeGreaterThan(8);
    for (let i = 0; i < 20; i++) scrubFrame();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      scrubFrame();
      best = Math.min(best, performance.now() - t0);
    }
    console.info(`#52 長押しドラッグの 1 フレーム: ${best.toFixed(2)} ms`);
    expect(best).toBeLessThan(BUDGET_MS);
  });
});

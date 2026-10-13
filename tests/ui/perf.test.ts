import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { buildWideChainJson } from '../../scripts/synthBoard';
import { CALENDAR } from '../../ui/calendar';
import { atmStrike, boardRows } from '../../ui/view/board';
import { headerModel } from '../../ui/view/header';
import { DEFAULT_PNL_Y, pnlChartModel, pnlDomains } from '../../ui/view/pnlChart';
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

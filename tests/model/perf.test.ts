import { describe, expect, it } from 'vitest';
import { expiryPnlFn, expiryProfile, tailTable } from '../../model/pnl';
import { evaluatePosition, preparePosition, theoreticalPnl } from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { makeMarket } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/**
 * AC8 の計算部分: 4 スライダーの 1 回の描き直しに要る計算（横軸 1 画素 1 点 = 1,000 点 × 足 10 本の
 * 指定日・今日・満期の 3 本 + シナリオ点の指標 + テール表）が 16 ms 以内。
 * CI は共有ランナーなので環境変数 PERF_BUDGET_MS で緩い閾値にする。
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const BUDGET_MS = Number(env?.PERF_BUDGET_MS ?? 16);

describe('性能（AC8 の計算部分）', () => {
  const { ctx } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const sc: Scenario = { ...ZERO_SCENARIO, days: 5, dX: -2000, dSigma: 5, skew: 1, beta: 1 };
  const width = 1000;
  const lo = ctx.x0 * 0.55;
  const hi = ctx.x0 * 1.25;

  function redraw(): number {
    let acc = 0;
    const expiry = expiryPnlFn(legs, ctx);
    for (let i = 0; i < width; i++) {
      const x = lo + ((hi - lo) * i) / (width - 1);
      acc += theoreticalPnl(legs, x, sc, ctx); // 指定日
      acc += theoreticalPnl(legs, x, ZERO_SCENARIO, ctx); // 今日
      acc += expiry(x); // 満期
    }
    acc += evaluatePosition(legs, sc, ctx).pnl;
    acc += expiryProfile(legs, ctx).rightSlope;
    acc += tailTable(legs, sc, ctx).rows.length;
    return acc;
  }

  it(`1 回の描き直しの計算が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    for (let i = 0; i < 20; i++) redraw(); // ウォームアップ（JIT）
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const v = redraw();
      times.push(performance.now() - t0);
      expect(Number.isFinite(v)).toBe(true);
    }
    // 他のテストファイルと並列に走るので、割り込みの影響を除くため最小値で判定する（中央値は参考に表示）
    times.sort((a, b) => a - b);
    const min = times[0] as number;
    const median = times[15] as number;
    console.info(
      `AC8 計算部分: 最小 ${min.toFixed(2)} ms / 中央値 ${median.toFixed(2)} ms（閾値 ${BUDGET_MS} ms）`,
    );
    expect(min).toBeLessThan(BUDGET_MS);
  });
});

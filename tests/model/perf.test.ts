import { describe, expect, it } from 'vitest';
import { type JsccPosition, jsccVarMargin } from '../../model/jsccMargin';
import { expiryPnlFn, expiryProfile, tailTable } from '../../model/pnl';
import { evaluatePosition, preparePosition, theoreticalPnl } from '../../model/position';
import { type Scenario, ZERO_SCENARIO } from '../../model/scenario';
import { makeMarket } from '../support/market';
import { BUDGET_MS, expectWithinBudget } from '../support/perf';
import { PERF_LEGS } from '../support/perfPosition';
import { realisticSet, rng, synthFuture, synthOption } from '../support/synthJscc';

/**
 * AC8 の計算部分: 4 スライダーの 1 回の描き直しに要る計算（横軸 1 画素 1 点 = 1,000 点 × 足 10 本の
 * 指定日・今日・満期の 3 本 + シナリオ点の指標 + テール表）が 16 ms 以内。
 * 閾値は `npm test`・CI が 200 ms（桁違いの悪化だけを落とす）、16 ms の判定は `npm run perf`（負荷の低いときに。
 * 2 ファイルだけを並列なしで）。計測の手順は tests/support/perf.ts。
 */

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
    // 他のテストファイルと並列に走りうるので、割り込みの影響を除くため最小値で判定する（中央値は参考に表示）
    expectWithinBudget('AC8 計算部分', redraw, {
      warmup: 20,
      runs: 30,
      after: (v) => expect(Number.isFinite(v)).toBe(true),
    });
  });
});

/**
 * #382 AC7: 今の必要証拠金の JSCC の計算（足 30 本 × シナリオ 1,422 本の和 + 並べ替え 1 回 + BigInt の和）。
 * 描画の 16 ms の経路では作り直さない（memo は足・板・設定・JSCC の応答だけ）が、足の編集 1 回で 1 回走るので同じ予算で見る
 */
describe('性能（#382 今の JSCC の計算）', () => {
  const set = realisticSet();
  const n = set.isHist.length;
  const r = rng(30);
  const positions: JsccPosition[] = Array.from({ length: 30 }, (_, i) =>
    i % 5 === 4
      ? { inst: synthFuture(n, 100, r), qty: (i % 2 === 0 ? 1 : -1) * (1 + (i % 3)), option: false }
      : {
          inst: synthOption(n, 50 + i * 20, r),
          qty: (i % 2 === 0 ? -1 : 1) * (1 + (i % 4)),
          option: true,
        },
  );
  it(`足 30 本の VaR 証拠金額が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expectWithinBudget('#382 JSCC 足 30 本', () => jsccVarMargin(positions, set).varMargin, {
      warmup: 20,
      runs: 30,
      after: (v) => expect(Number.isFinite(v)).toBe(true),
    });
  });
});

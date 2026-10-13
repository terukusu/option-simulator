import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { buildWideChainJson } from '../../scripts/synthBoard';
import { CALENDAR } from '../../ui/calendar';
import { atmStrike, boardRows } from '../../ui/view/board';
import { headerModel } from '../../ui/view/header';
import { smileModel } from '../../ui/view/smile';

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

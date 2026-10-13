/**
 * テスト用の市場（架空の値）: 2 限月の合成の板 + 先物 1 本。
 * 1 限月 F = 67,810（T = 30.5 日）、2 限月 F = 67,885（T = 58.5 日）、先物（2 限月と同じ SQ）67,880。
 * 横軸の基準 X₀ = 1 限月の F。
 */

import type { MarketContext } from '../../model/position';
import { buildSmile, type SmileFit } from '../../model/smile';
import { DAY_MS, jstInstant } from '../../model/time';
import type { StrikeRow } from '../../model/types';
import { synthChain } from './synthChain';

export const R = 0.005;
export const EVAL_TIME = jstInstant('2026-10-13', 21, 31);
export const M1 = { id: 'M1', F: 67810, days: 30.5 };
export const M2 = { id: 'M2', F: 67885, days: 58.5 };
export const FUT = { id: 'FUT', price: 67880, days: 58.5 };

export interface TestMarket {
  ctx: MarketContext;
  rows: Record<string, StrikeRow[]>;
  fits: Record<string, SmileFit>;
}

export function makeMarket(opts: { withSmile?: boolean; seed?: number } = {}): TestMarket {
  const withSmile = opts.withSmile ?? true;
  const rows: Record<string, StrikeRow[]> = {};
  const fits: Record<string, SmileFit> = {};
  const options: Record<string, MarketContext['options'][string]> = {};
  for (const m of [M1, M2]) {
    const T = m.days / 365;
    const chain = synthChain({ F: m.F, T, r: R, seed: opts.seed ?? 3 });
    rows[m.id] = chain.rows;
    const fit = buildSmile(chain.rows, m.F, T, R);
    if (!fit) throw new Error('スマイルが作れない');
    fits[m.id] = fit;
    options[m.id] = {
      sqTime: EVAL_TIME + m.days * DAY_MS,
      forward: m.F,
      smile: withSmile ? fit.smile : null,
    };
  }
  return {
    ctx: {
      evalTime: EVAL_TIME,
      r: R,
      x0: M1.F,
      options,
      futures: { [FUT.id]: { sqTime: EVAL_TIME + FUT.days * DAY_MS, price: FUT.price } },
    },
    rows,
    fits,
  };
}

/** 板から足を入れるときの建値（買い = ask、売り = bid）と mid。 */
export function quoteOf(rows: StrikeRow[], k: number, type: 'call' | 'put') {
  const row = rows.find((r) => r.k === k);
  if (!row) throw new Error(`行使価格が板に無い: ${k}`);
  const q = row[type];
  if (q.bid === null || q.ask === null) throw new Error(`両側気配が無い: ${k} ${type}`);
  return { bid: q.bid, ask: q.ask, mid: (q.bid + q.ask) / 2 };
}

/**
 * IV 推移（#79）のテストの合成の足（架空の値。種つきの決まった値）。時刻は JST の ISO から UNIX 秒にする。
 */

import type { AtmIvData, IvBar } from '../../data';
import type { CmMonth } from '../../model/constantMaturity';
import { makeSvi, rng, type SviParams, synthChain } from './synthChain';

/** JST の 'YYYY-MM-DDTHH:MM' → UNIX 秒 */
export function jst(local: string): number {
  return Date.parse(`${local}:00+09:00`) / 1000;
}

/** 時刻の列（UNIX 秒）に架空の OHLC（20% 前後）を付ける */
export function barsAt(times: readonly number[], seed = 1): IvBar[] {
  const r = rng(seed);
  return times.map((t) => {
    const o = 18 + r() * 4;
    const c = 18 + r() * 4;
    const h = Math.max(o, c) + r();
    const l = Math.min(o, c) - r();
    return { t, o, h, l, c };
  });
}

/** from から step 秒ごとに count 本の時刻 */
export function everyStep(from: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i * step);
}

/** 検証済みの応答の形（ivLoad の loaded に渡す） */
export function ivData(
  tf: AtmIvData['tf'],
  bars: IvBar[],
  over: Partial<AtmIvData> = {},
): AtmIvData {
  const start = bars[0]?.t ?? 0;
  const end = (bars.at(-1)?.t ?? 0) + 60;
  return { tf, start, end, lastAt: bars.at(-1)?.t ?? null, bars, ...over };
}

/** 30 日固定の ATM IV（model/constantMaturity.ts）の合成の限月の入力 */
export interface SynthCmMonthOptions {
  lastTradingDay: string;
  F: number;
  /** SQ までの暦日（Black-76 の T = days / 365。r = 0） */
  days: number;
  /** ATM の IV（小数）。スマイルは makeSvi の形 */
  atmVol: number;
  /** bid / ask = 理論価格 ∓ halfSpread 円（mid = 理論価格） */
  halfSpread?: number;
  /** bid_iv / ask_iv = 真の IV（%）∓ ivHalf */
  ivHalf?: number;
  /** is_atm を付ける行使価格（既定 = F に最も近い行使価格。null なら付けない） */
  atmK?: number | null;
}

/**
 * Black-76（r = 0）+ SVI のスマイルから作った架空の限月（JPX の bid_iv / ask_iv の代わりに真の IV ∓ ivHalf を入れる）。
 * r = 0 なので C − P + K = F、mid IV = 真の IV（%）
 */
export function synthCmMonth(o: SynthCmMonthOptions): {
  month: CmMonth;
  trueVol: Map<number, number>;
  svi: SviParams;
} {
  const T = o.days / 365;
  const svi = makeSvi(T, o.atmVol);
  const half = o.halfSpread ?? 0.5;
  const ivHalf = o.ivHalf ?? 0.2;
  const { rows, trueVol } = synthChain({ F: o.F, T, r: 0, svi, exactHalfSpread: half });
  const nearest = rows.reduce((a, b) => (Math.abs(b.k - o.F) < Math.abs(a.k - o.F) ? b : a)).k;
  const atmK = o.atmK === undefined ? nearest : o.atmK;
  const side = (q: { bid: number | null; ask: number | null }, vol: number, k: number) => ({
    bid: q.bid,
    ask: q.ask,
    bid_iv: vol * 100 - ivHalf,
    ask_iv: vol * 100 + ivHalf,
    is_atm: k === atmK,
  });
  return {
    month: {
      lastTradingDay: o.lastTradingDay,
      rows: rows.map((r) => {
        const v = trueVol.get(r.k) as number;
        return { k: r.k, call: side(r.call, v, r.k), put: side(r.put, v, r.k) };
      }),
    },
    trueVol,
    svi,
  };
}

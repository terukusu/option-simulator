/**
 * IV 推移（#79）のテストの合成の足（架空の値。種つきの決まった値）。時刻は JST の ISO から UNIX 秒にする。
 */

import type { AtmIvData, IvBar } from '../../data';
import { rng } from './synthChain';

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

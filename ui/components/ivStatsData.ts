/**
 * AI のツール iv_stats（#138・#158）のデータの読み込み（DOM を持たない。fetch とブラウザの中の覚え）。
 *
 * - 読むのはツールが呼ばれたとき（useAiChat が tool_use に iv_stats を見たとき）だけ。ポーリングしない
 * - 既存の口だけ: 日次の値 `/api/atm_daily`（追証マップの過去の点と同じ要求。パラメータなし = サーバーのキャッシュを共有）と、
 *   今の IV として `/api/atm_iv?tf=1h`（範囲なし = IV 推移の画面の既定の右端と同じ要求）の最後の足の終値（時刻は値の
 *   時刻 = 応答の lastAt。足の中に無ければ足の始まり）。1 時間足はまだ確定していない日の終値の近似にも渡す。新しいクエリは無い
 * - 口の組ごとに IV_STATS_CACHE_MS（10 分）覚える。日次が読めなければ失敗（ツールは no_data。失敗は覚えない）。今の IV が
 *   読めなければ now = null（ツールは最後の日次の終値で代える）
 */

import { type AtmDailyData, type AtmIvData, loadAtmDaily, loadAtmIv } from '../../data';
import type { IvStatsData } from '../view/aiIvStats';

/** 覚える時間（ms） */
export const IV_STATS_CACHE_MS = 10 * 60 * 1000;

export interface IvStatsLoaders {
  daily: (endpoint: string) => Promise<AtmDailyData>;
  iv: (endpoint: string) => Promise<AtmIvData>;
}

const DEFAULT_LOADERS: IvStatsLoaders = {
  daily: (endpoint) => loadAtmDaily({ endpoint }),
  iv: (endpoint) => loadAtmIv('1h', { endpoint }),
};

const cache = new Map<string, { at: number; value: Promise<IvStatsData> }>();

const HOUR_S = 3600;

/** 1 時間足の最後の足の終値と、その値の時刻（lastAt が最後の足の中ならそれ、無ければ足の始まり。無ければ null） */
export function ivNowOf(d: AtmIvData): { t: number; iv: number } | null {
  const b = d.bars[d.bars.length - 1];
  if (!b) return null;
  const at = d.lastAt;
  const t = at !== null && at >= b.t && at < b.t + HOUR_S ? at : b.t;
  return { t, iv: b.c };
}

/** ツールのデータ。now は覚えの期限の判定だけに使う */
export function loadIvStatsData(
  dailyEndpoint: string,
  ivEndpoint: string,
  loaders: IvStatsLoaders = DEFAULT_LOADERS,
  now: number = Date.now(),
): Promise<IvStatsData> {
  const key = `${dailyEndpoint}\n${ivEndpoint}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < IV_STATS_CACHE_MS) return hit.value;
  const value = Promise.all([
    loaders.daily(dailyEndpoint),
    loaders.iv(ivEndpoint).then(
      (d) => d,
      () => null,
    ),
  ]).then(([daily, iv]) => ({
    days: daily.days,
    now: iv ? ivNowOf(iv) : null,
    hourly: iv ? iv.bars.map((b) => ({ t: b.t, c: b.c })) : [],
  }));
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** 覚えを消す（テスト用） */
export function clearIvStatsCache(): void {
  cache.clear();
}

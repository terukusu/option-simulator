/**
 * AI のツール technicals（#200）のデータの読み込み（DOM を持たない。fetch とブラウザの中の覚え）。
 *
 * - 読むのはツールが呼ばれたとき（useAiChat が tool_use に technicals を見たとき）だけ。ポーリングしない
 * - 既存の口 `/api/future_bars` を先物推移の画面と同じ範囲で読む = サーバーのキャッシュ（キー = (tf, start, end)）を共有:
 *   日足の右端の 1 回分（365 日）+ その左の 1 回分（365 日）= 約 2 年（週足の MACD の助走 34 本を超える）、1 時間足の
 *   右端の 1 回分（60 日）+ その左の 1 回分（60 日）= 約 120 日（4 時間足 約 400 本）。要求 4 本（右端 2 本 → 左 2 本）
 * - 口ごとに TECH_CACHE_MS（10 分）覚える（同じ会話で何度呼ばれても読み直さない）。右端が読めなければ失敗（ツールは
 *   no_data）、左が読めなければ右端だけで返す。失敗は覚えない
 */

import { type FutBar, loadFutureBars } from '../../data';
import type { TechnicalsData } from '../view/aiTechnicals';
import { mergeBars } from '../view/ivHistory';
import { IV_CHUNK_DAYS, IV_EPOCH } from '../view/ivLoad';

/** 覚える時間（ms） */
export const TECH_CACHE_MS = 10 * 60 * 1000;

const DAY_S = 86400;

type Loader = typeof loadFutureBars;

const cache = new Map<string, { at: number; value: Promise<TechnicalsData> }>();

/** 右端の応答の start の左の 1 回分（先物推移の画面の左の追加読み込みと同じ範囲 = ivLeftRange） */
export function techLeftRange(
  start: number,
  tf: '1d' | '1h',
): { start: number; end: number } | null {
  const end = Math.floor(start / DAY_S) * DAY_S;
  if (end <= IV_EPOCH) return null;
  return { start: Math.max(end - IV_CHUNK_DAYS[tf] * DAY_S, IV_EPOCH), end };
}

async function loadOne(
  endpoint: string,
  tf: '1d' | '1h',
  loader: Loader,
): Promise<readonly FutBar[]> {
  const right = await loader(tf, { endpoint });
  const range = techLeftRange(right.start, tf);
  if (!range) return right.bars;
  try {
    const left = await loader(tf, { endpoint, range });
    return mergeBars(left.bars, right.bars);
  } catch {
    return right.bars;
  }
}

/** ツールのデータ（日足・1 時間足）。now は覚えの期限の判定だけに使う */
export function loadTechnicalsData(
  endpoint: string,
  loader: Loader = loadFutureBars,
  now: number = Date.now(),
): Promise<TechnicalsData> {
  const hit = cache.get(endpoint);
  if (hit && now - hit.at < TECH_CACHE_MS) return hit.value;
  const value = Promise.all([
    loadOne(endpoint, '1d', loader),
    loadOne(endpoint, '1h', loader),
  ]).then(([daily, hourly]) => ({ daily, hourly }));
  cache.set(endpoint, { at: now, value });
  value.catch(() => {
    if (cache.get(endpoint)?.value === value) cache.delete(endpoint);
  });
  return value;
}

/** 覚えを消す（テスト用） */
export function clearTechnicalsCache(): void {
  cache.clear();
}

/**
 * 建てた板 t₀ と 3 日後の板 t₀ + 3 日（#299。架空の値）。t₀ = 合成の latest（2026-10-13 21:31）、
 * t₀ + 3 日 = scripts/synthBoard.ts の buildLaterChainJson（F・先物を約 1.3% 下げ、ATM の IV を 2pt 上げ、
 * 乱数の種を変えた別の板。行使価格は latest と同じ）。どちらも Black-76 から作った合成の板。
 */

import { type Chain, type ChainJson, normalizeChain, validateChainJson } from '../../data';
import { buildLaterChainJson } from '../../scripts/synthBoard';
import { fixture } from './fixtures';

/** t₀ + days 日の板の JSON（検証済み・毎回新しいコピー） */
export function laterJson(days = 3): ChainJson {
  const res = validateChainJson(structuredClone(buildLaterChainJson(days)));
  if (!res.ok) throw new Error(`後の板が不正: ${res.errors.join('; ')}`);
  return res.value;
}

/** 建てた板 t₀（latest）と t₀ + days 日の板（正規化済み） */
export function boardsT0AndLater(days = 3): { t0: Chain; later: Chain } {
  return { t0: normalizeChain(fixture('latest')), later: normalizeChain(laterJson(days)) };
}

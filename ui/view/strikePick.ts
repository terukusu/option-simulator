/**
 * 板の行使価格の選び方（純関数。DOM・通信・時計に依存しない）。AI の提案（ui/view/aiPropose.ts の structure_candidates・
 * propose_position の abs_delta。#139）と戦略テンプレート（ui/view/templates.ts。#20）が共用する。
 *
 * - quotedStrikes / deltaAt / strikeByDelta / strikeNear / defaultMonthOf は #139 の aiPropose.ts から中身を変えずに
 *   移した（strict `<` で最初に見つけた行・OTM の判定は F・NaN の Δ は飛ばす。AI の提案の結果を変えない）
 * - atmSigma / nearestQuoted / atmOffsetK は #20 で足した（docs/design.md 5.9・13.4「戦略テンプレート」）
 *
 * 単位: K・水準は円、σ は小数（0.25 = 25%）、Δ は |Δ|（0〜1）、T は年（m.T）。
 */

import type { Chain, ChainMonth } from '../../data';
import { type AtmBasis, black76Greeks, type OptionType } from '../../model';
import type { UiLeg } from '../state';
import { fin } from './finite';

export const rowIndex = (m: ChainMonth, k: number) => m.rows.findIndex((r) => r.k === k);

/** 両気配の行の行使価格（種別の側。昇順） */
export function quotedStrikes(m: ChainMonth, type: OptionType): number[] {
  return m.strikes.filter((s) => s[type].quote === 'two_sided').map((s) => s.k);
}

/** 行使価格の Δ（スマイルの IV と Black-76。画面の足の Δ と同じ式。求まらなければ NaN） */
export function deltaAt(chain: Chain, m: ChainMonth, k: number, type: OptionType): number {
  const info = m.strikes[rowIndex(m, k)];
  const sigma = info?.smileIv ?? null;
  if (sigma === null || !fin(m.F) || !(m.T > 0)) return Number.NaN;
  return black76Greeks(type, m.F, k, m.T, sigma, chain.r).delta;
}

/** OTM 側で |Δ| が目標に最も近い行（無ければ null） */
export function strikeByDelta(
  chain: Chain,
  m: ChainMonth,
  type: OptionType,
  target: number,
): number | null {
  let best: number | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const k of quotedStrikes(m, type)) {
    if (type === 'put' ? k > m.F : k < m.F) continue;
    const d = Math.abs(deltaAt(chain, m, k, type));
    if (!fin(d)) continue;
    const g = Math.abs(d - target);
    if (g < gap) {
      gap = g;
      best = k;
    }
  }
  return best;
}

/** 目標の水準に最も近い行（far の側 = put は k より下、call は上。無ければ null） */
export function strikeNear(
  m: ChainMonth,
  type: OptionType,
  from: number,
  level: number,
): number | null {
  let best: number | null = null;
  for (const k of quotedStrikes(m, type)) {
    if (type === 'put' ? k >= from : k <= from) continue;
    if (best === null || Math.abs(k - level) < Math.abs(best - level)) best = k;
  }
  return best;
}

/** 限月を選べるか（スマイルと F がある） */
export const usableMonth = (m: ChainMonth) => m.smile !== null && fin(m.F) && m.F > 0;

/**
 * 既定の限月: 足の最初の OP の限月（選べる限月なら）、無ければ残存 2 日以上の最初の限月、それも無ければ先頭。
 * 候補はスマイルと F がある限月（無ければ null）
 */
export function defaultMonthOf(chain: Chain, legs: readonly UiLeg[]): ChainMonth | null {
  const months = chain.months.filter(usableMonth);
  const legMonth = legs.find((l) => l.leg.kind === 'option')?.leg;
  if (legMonth?.kind === 'option') {
    const m = months.find((x) => x.id === legMonth.expiry);
    if (m) return m;
  }
  return months.find((m) => m.T * 365 >= 2) ?? months[0] ?? null;
}

// ---------------------------------------------------------------- #20 で足したもの

/**
 * σ_ATM,i（5.9）: ATM の行（`m.atm[basis].pick`）の OTM 側の節点の mid IV（小数）。ATM が無い・節点が無い・mid IV が
 * 無い / 有限でない / 0 以下なら null（スマイルの補間値や反対側の IV へは逃がさない）
 */
export function atmSigma(m: ChainMonth, basis: AtmBasis): number | null {
  const k = m.atm[basis].pick?.k;
  if (k === undefined) return null;
  const v = m.strikes[rowIndex(m, k)]?.node?.midIv ?? null;
  return fin(v) && v > 0 ? v : null;
}

/**
 * 目標の水準に最も近い両気配の行（種別の側）。side = 'below' は K ≤ bound、'above' は K ≥ bound、null は制限なし。
 * 同じ距離は OTM の遠い方（put は低い K、call は高い K）。level・bound が有限でなければ null
 */
export function nearestQuoted(
  m: ChainMonth,
  type: OptionType,
  level: number,
  side: 'below' | 'above' | null,
  bound: number = level,
): number | null {
  if (!fin(level) || (side !== null && !fin(bound))) return null;
  let best: number | null = null;
  for (const k of quotedStrikes(m, type)) {
    if (side === 'below' && k > bound) continue;
    if (side === 'above' && k < bound) continue;
    if (best === null) {
      best = k;
      continue;
    }
    const g = Math.abs(k - level);
    const b = Math.abs(best - level);
    if (g < b || (g === b && (type === 'put' ? k < best : k > best))) best = k;
  }
  return best;
}

/** 板の行（`m.rows` の昇順）で atmK から n 本（+ = 高い K）。atmK が行に無い・範囲外は null */
export function atmOffsetK(m: ChainMonth, atmK: number | null, n: number): number | null {
  if (atmK === null || !Number.isInteger(n)) return null;
  const ks = m.rows.map((r) => r.k).sort((a, b) => a - b);
  const i = ks.indexOf(atmK);
  if (i < 0) return null;
  return ks[i + n] ?? null;
}

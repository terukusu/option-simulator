/**
 * ATM の判定（限月ごと）。設計 docs/design.md 5.9。
 *
 * - 限月 i の ATM = その限月の上場行使価格のうち基準価格 X₀,i に最も近いもの
 * - 同距離（500 円刻み以上の領域でだけ起きる）は |C_mid − P_mid| が小さい方。
 *   どちらかの行で call / put の両側気配が無ければ低い方
 * - 基準価格は (A) 直近四半期のラージ先物（両限月共通）/ (B) 限月ごとの合成先物 F_i。
 *   (B) が決まらない（合成が先物へのフォールバック）ときは (A) を使う
 * - 板の ATM（市場 ATM）もシナリオ ATM（シナリオ後の X₀,i'）も同じ関数で求める
 * - JPX の is_atm は使わない
 */

import { midOf, type StrikeRow } from './types';

export type AtmBasis = 'A' | 'B';

export type AtmTieBreak = 'none' | 'pcp' | 'lower';

export interface AtmPick {
  /** ATM の行使価格 */
  k: number;
  /** 判定に使った基準価格 */
  reference: number;
  /** |K − 基準価格| */
  distance: number;
  /** 同距離の候補があったときの決め方（無ければ none） */
  tieBreak: AtmTieBreak;
}

/** 同距離とみなす差（円）。行使価格は整数円なので浮動小数の誤差だけを吸収する。 */
const TIE_EPS = 1e-6;

function pcpGap(row: StrikeRow): number | null {
  const c = midOf(row.call);
  const p = midOf(row.put);
  return c === null || p === null ? null : Math.abs(c - p);
}

/**
 * 行使価格の列から ATM を選ぶ。行が無い・基準価格が有限でなければ null。
 */
export function findAtm(rows: readonly StrikeRow[], reference: number): AtmPick | null {
  if (!Number.isFinite(reference) || rows.length === 0) return null;
  let best: StrikeRow[] = [];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const d = Math.abs(row.k - reference);
    if (d < bestDist - TIE_EPS) {
      best = [row];
      bestDist = d;
    } else if (Math.abs(d - bestDist) <= TIE_EPS && !best.some((b) => b.k === row.k)) {
      best.push(row);
    }
  }
  const sorted = [...best].sort((a, b) => a.k - b.k);
  const lowest = sorted[0];
  if (!lowest) return null;
  if (sorted.length === 1) {
    return { k: lowest.k, reference, distance: bestDist, tieBreak: 'none' };
  }
  const gaps = sorted.map(pcpGap);
  if (gaps.every((g) => g !== null)) {
    let pick = 0;
    for (let i = 1; i < sorted.length; i++) {
      if ((gaps[i] as number) < (gaps[pick] as number)) pick = i;
    }
    const row = sorted[pick] as StrikeRow;
    return { k: row.k, reference, distance: bestDist, tieBreak: 'pcp' };
  }
  return { k: lowest.k, reference, distance: bestDist, tieBreak: 'lower' };
}

export interface AtmReferenceInput {
  /** 直近四半期のラージ先物の価格（無ければ null） */
  future: number | null;
  /** 限月の合成先物 F_i（決まらなければ null か NaN） */
  synthetic: number | null;
}

export interface AtmReference {
  basis: AtmBasis;
  /** 基準価格（決まらなければ null） */
  price: number | null;
  /** (B) を求めたが合成が決まらず (A) を使った */
  fellBack: boolean;
}

/** 基準 A / B の基準価格 X₀,i（5.9。B が決まらなければ A へフォールバック）。 */
export function atmReference(basis: AtmBasis, input: AtmReferenceInput): AtmReference {
  const fut = input.future !== null && Number.isFinite(input.future) ? input.future : null;
  if (basis === 'A') return { basis, price: fut, fellBack: false };
  const syn = input.synthetic !== null && Number.isFinite(input.synthetic) ? input.synthetic : null;
  if (syn !== null) return { basis, price: syn, fellBack: false };
  return { basis, price: fut, fellBack: true };
}

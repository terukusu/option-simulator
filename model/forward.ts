/**
 * 限月ごとの原資産 F（PCP 合成先物）の推定。設計 docs/design.md 5.1。
 *
 * 1. 基準価格 ±4% で call / put とも両側気配のある行使価格ごとに、無裁定の箱
 *    [K + (C_bid − P_ask) e^{rT}, K + (C_ask − P_bid) e^{rT}] を作る
 * 2. 外れ値を除く: 箱の幅が中央値の 3 倍超、または他の箱の交差区間から 300 円超離れる箱
 * 3. 残った箱の交差区間の中点を F とする。交差が空なら幅の逆数で重み付けした中央値
 * 4. 不確かさ（± の半幅）を返す。ペアが 5 組未満なら先物価格にフォールバック
 */

import { hasTwoSided, type StrikeRow } from './types';

export interface ForwardBox {
  k: number;
  lo: number;
  hi: number;
}

export type ForwardMethod = 'intersection' | 'weighted_median' | 'future_fallback';

export interface ForwardEstimate {
  /** 推定した F（フォールバック時は先物価格。先物も無ければ NaN） */
  forward: number;
  /** ± の半幅（交差区間の半幅、または重み付き四分位範囲の半分）。フォールバックは NaN */
  uncertainty: number;
  method: ForwardMethod;
  /** 推定に使った箱 */
  used: ForwardBox[];
  /** 外れ値として除いた箱 */
  outliers: ForwardBox[];
}

export interface ForwardOptions {
  /** 箱を作る範囲: 基準価格 ± windowPct（既定 0.04） */
  windowPct?: number;
  /** 幅が中央値のこの倍数を超える箱を除く（既定 3） */
  widthMultiple?: number;
  /** 他の箱の交差区間からこの円数を超えて離れる箱を除く（既定 300） */
  maxDistance?: number;
  /** この組数未満なら先物にフォールバック（既定 5） */
  minPairs?: number;
}

export function buildBoxes(
  rows: readonly StrikeRow[],
  T: number,
  r: number,
  center: number,
  windowPct: number,
): ForwardBox[] {
  const growth = Math.exp(r * Math.max(T, 0));
  const boxes: ForwardBox[] = [];
  for (const row of rows) {
    if (Math.abs(row.k / center - 1) > windowPct) continue;
    if (!hasTwoSided(row.call) || !hasTwoSided(row.put)) continue;
    boxes.push({
      k: row.k,
      lo: row.k + (row.call.bid - row.put.ask) * growth,
      hi: row.k + (row.call.ask - row.put.bid) * growth,
    });
  }
  return boxes;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  const m = n >> 1;
  return n % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function intersect(boxes: readonly ForwardBox[]): { lo: number; hi: number } {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (const b of boxes) {
    lo = Math.max(lo, b.lo);
    hi = Math.min(hi, b.hi);
  }
  return { lo, hi };
}

/** 重み付き分位点（重みの累積が q を超える最初の点。中点で補間しない単純な定義）。 */
function weightedQuantile(
  values: readonly number[],
  weights: readonly number[],
  q: number,
): number {
  const idx = values.map((_, i) => i).sort((a, b) => (values[a] as number) - (values[b] as number));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const i of idx) {
    acc += weights[i] as number;
    if (acc >= q * total) return values[i] as number;
  }
  return values[idx[idx.length - 1] as number] as number;
}

const widthOf = (b: ForwardBox) => Math.max(b.hi - b.lo, 1e-9);

function weightedMedianEstimate(boxes: readonly ForwardBox[]): {
  forward: number;
  uncertainty: number;
} {
  const mids = boxes.map((b) => (b.lo + b.hi) / 2);
  const w = boxes.map((b) => 1 / widthOf(b));
  const forward = weightedQuantile(mids, w, 0.5);
  const iqr = weightedQuantile(mids, w, 0.75) - weightedQuantile(mids, w, 0.25);
  return { forward, uncertainty: iqr / 2 };
}

/** 箱と区間（または点）との距離（重なれば 0）。 */
function distance(b: ForwardBox, lo: number, hi: number): number {
  if (b.hi < lo) return lo - b.hi;
  if (b.lo > hi) return b.lo - hi;
  return 0;
}

/**
 * 合成先物 F を推定する。
 * @param center ±4% の窓の中心（先物価格や前回の F）。推定後に窓を F に寄せてもう一度だけ推定する
 * @param futurePrice フォールバック用の先物価格（無ければ null）
 */
export function estimateForward(
  rows: readonly StrikeRow[],
  T: number,
  r: number,
  center: number,
  futurePrice: number | null,
  opts: ForwardOptions = {},
): ForwardEstimate {
  const first = estimateOnce(rows, T, r, center, futurePrice, opts);
  if (first.method === 'future_fallback' || !Number.isFinite(first.forward)) return first;
  if (Math.abs(first.forward - center) < 1) return first;
  return estimateOnce(rows, T, r, first.forward, futurePrice, opts);
}

function estimateOnce(
  rows: readonly StrikeRow[],
  T: number,
  r: number,
  center: number,
  futurePrice: number | null,
  opts: ForwardOptions,
): ForwardEstimate {
  const windowPct = opts.windowPct ?? 0.04;
  const widthMultiple = opts.widthMultiple ?? 3;
  const maxDistance = opts.maxDistance ?? 300;
  const minPairs = opts.minPairs ?? 5;

  const all = buildBoxes(rows, T, r, center, windowPct);
  const fallback = (used: ForwardBox[], outliers: ForwardBox[]): ForwardEstimate => ({
    forward: futurePrice ?? Number.NaN,
    uncertainty: Number.NaN,
    method: 'future_fallback',
    used,
    outliers,
  });
  if (all.length < minPairs) return fallback(all, []);

  // (a) 幅の外れ値
  const medWidth = median(all.map(widthOf));
  let used = all.filter((b) => widthOf(b) <= widthMultiple * medWidth);
  const outliers = all.filter((b) => widthOf(b) > widthMultiple * medWidth);

  // (b) 位置の外れ値: 他の箱の交差区間（空なら他の箱の重み付き中央値）から maxDistance 超。
  //     最も離れた 1 つずつ除き、無くなるまで繰り返す
  for (;;) {
    if (used.length < 2) break;
    let worst = -1;
    let worstDist = maxDistance;
    used.forEach((b, i) => {
      const others = used.filter((_, j) => j !== i);
      const x = intersect(others);
      let d: number;
      if (x.lo <= x.hi) d = distance(b, x.lo, x.hi);
      else {
        const m = weightedMedianEstimate(others).forward;
        d = distance(b, m, m);
      }
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    });
    if (worst < 0) break;
    outliers.push(used[worst] as ForwardBox);
    used = used.filter((_, j) => j !== worst);
  }

  if (used.length < minPairs) return fallback(used, outliers);

  const x = intersect(used);
  if (x.lo <= x.hi) {
    return {
      forward: (x.lo + x.hi) / 2,
      uncertainty: (x.hi - x.lo) / 2,
      method: 'intersection',
      used,
      outliers,
    };
  }
  const wm = weightedMedianEstimate(used);
  return { ...wm, method: 'weighted_median', used, outliers };
}

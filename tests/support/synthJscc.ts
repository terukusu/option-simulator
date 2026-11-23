/**
 * テスト用の合成の JSCC の VaR パラメータ（#382。架空の値 = 種つき乱数）。本物の形（H が先・S が後、OP はシナリオ後の
 * 評価額 ≥ 0、先物はシナリオの損益、pnl は 1 枚あたりの円の整数）に合わせた小さな表。dev サーバーの合成の応答は
 * scripts/devFixtures.mjs の中に別に持つ（イメージに tests/ を入れないため）。
 */

import type { JsccData, JsccInstrument, JsccScenarioSet } from '../../model';

/** 種つきの一様乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 本物と同じ本数の並び（H 1,250・S 172。信頼水準 97.5%・ストレス 2 本） */
export function realisticSet(nh = 1250, ns = 172, nStress = 2, confidence = 97.5): JsccScenarioSet {
  return {
    isHist: [...Array(nh).fill(true), ...Array(ns).fill(false)],
    confidence,
    nStress,
  };
}

/** 小さな並び（性質テスト用） */
export function smallSet(nh = 40, ns = 8, nStress = 2, confidence = 97.5): JsccScenarioSet {
  return realisticSet(nh, ns, nStress, confidence);
}

/** 架空の OP の行: 評価額 = 清算値段 × 1,000 のまわりに散らばる非負の整数 */
export function synthOption(
  n: number,
  price: number,
  r: () => number,
  spread = 0.8,
): JsccInstrument {
  const pnl = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    pnl[j] = Math.max(0, Math.round(price * 1000 * (1 + spread * (r() * 2 - 1) ** 3 * 3)));
  }
  return { aggregationGroup: 'IDX_IDX', contractSize: 1000, price, pnl };
}

/** 架空の先物の行: シナリオの損益（1 枚あたり。乗数に比例） */
export function synthFuture(n: number, multiplier: number, r: () => number): JsccInstrument {
  const pnl = new Float64Array(n);
  for (let j = 0; j < n; j++) pnl[j] = Math.round((r() * 2 - 1) * 3000 * multiplier);
  return { aggregationGroup: 'IDX_IDX', contractSize: multiplier, price: 50000, pnl };
}

/** 銘柄のキー → 行の表から JsccData を作る */
export function jsccData(
  set: JsccScenarioSet,
  instruments: Record<string, JsccInstrument>,
  businessDate = '2026-10-09',
): JsccData {
  return { businessDate, set, instruments: new Map(Object.entries(instruments)) };
}

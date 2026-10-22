/**
 * 理論価格（妥当な価格。#264、docs/design.md 5.3「理論価格」）の表示の文字列（純関数）。
 * 値は model/ の smileFairIvs / smileFairValue（その行の気配を使わず、周りの気配の狭い行のスマイルの IV で Black-76）。
 * 板の K のポップオーバー・K の title（ui/view/boardPanel.ts）、スマイルの操作行（ui/view/smilePanel.ts）、
 * 足の詳細（ui/view/positionsRegion.ts）で共用する。
 */

import type { ChainMonth } from '../../data';
import {
  type FairPosition,
  type FairValue,
  fairPosition,
  type OptionType,
  smileFairValue,
} from '../../model';
import { fmtNum } from './format';

/** 理論価格が気配のどこか（両側: 幅の 1/3・2/3 で区切る。片側: その側より上か下か） */
export const FAIR_POSITION_LABEL: Readonly<Record<FairPosition, string>> = {
  below_bid: 'bid より下',
  near_bid: 'bid 寄り',
  middle: '気配の中ほど',
  near_ask: 'ask 寄り',
  above_ask: 'ask より上',
  above_bid: 'bid より上',
  below_ask: 'ask より下',
};

/** 理論価格を小数 1 桁で出す上限（円。小数 1 桁に丸めた値がこれ未満なら小数 1 桁、以上は整数） */
export const FAIR_DECIMAL_BELOW = 100;

/** 足の詳細・板のポップオーバーの見出しの語 */
export const FAIR_LABEL = '理論価格（周りの行から）';

export interface FairView {
  /**
   * 理論価格。呼値に丸めない。100 円未満は小数 1 桁（一桁〜数十円の行では呼値 1 円が価格の 1% 超で、どちらの呼値に
   * 近いかを残す）、100 円以上は整数（丸めの差が 0.5% 未満。狭い操作行に収める）
   */
  price: string;
  /** 使った IV（%・小数 1 桁。スマイルの線の IV とは違いうる） */
  iv: string;
  /** 気配の中の位置（気配が無ければ null） */
  position: string | null;
  /** 周りの気配の狭い行の外側（外挿。確からしさが落ちる） */
  extrapolated: boolean;
  /** 全文（title・読み上げ。`理論価格 10.0（IV 58.9・気配の中ほど）`） */
  label: string;
}

type Fmt = (v: number, digits: number) => string;

/** 理論価格の数字（小数 1 桁に丸めた値で桁を決める = 99.96 は `100`）。 */
export function fairPriceText(price: number, fmt: Fmt = fmtNum): string {
  return Math.round(price * 10) / 10 < FAIR_DECIMAL_BELOW ? fmt(price, 1) : fmt(price, 0);
}

/** model の理論価格（null なら null）とその行の気配から表示の文字列。fmt は板の大量の行では fmtNumFast を渡す。 */
export function fairViewOf(
  v: FairValue | null,
  bid: number | null,
  ask: number | null,
  fmt: Fmt = fmtNum,
): FairView | null {
  if (!v) return null;
  const pos = fairPosition(v.price, bid, ask);
  const price = fairPriceText(v.price, fmt);
  const iv = fmt(v.iv * 100, 1);
  const position = pos === null ? null : FAIR_POSITION_LABEL[pos];
  const extrapolated = v.mark === 'extrapolated';
  const notes = [`IV ${iv}`, position, extrapolated ? '外挿' : null].filter((t) => t !== null);
  return {
    price,
    iv,
    position,
    extrapolated,
    label: `理論価格 ${price}（${notes.join('・')}）`,
  };
}

/** 限月 month の行使価格 k・種別 type の理論価格の表示（出せなければ null）。bid / ask はその行の気配。 */
export function fairView(
  month: ChainMonth,
  k: number,
  type: OptionType,
  r: number,
  bid: number | null,
  ask: number | null,
): FairView | null {
  return fairViewOf(smileFairValue(month.smile, month.F, month.T, r, k, type), bid, ask);
}

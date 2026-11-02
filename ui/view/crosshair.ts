/**
 * 十字線の共通の部品（#217。純関数）。設計 docs/ui-redesign.md §4.1「十字線の共通の規則」。
 *
 * - 札（横軸 = 目盛りの行、縦軸 = 目盛りの列）の矩形は IV 推移（#130）・損益グラフ（#201）と同じ大きさ（IV_TAG_H・labelPx）で、
 *   svg の内側へ寄せる
 * - タッチの読み取りは、交点をつかんで動かす間だけ指で隠れない所（描画域の上端。指が上 40% なら下端）。先物推移の段の
 *   `.ind-float`（#207）と同じ規則。離した後（置いたまま）は PC のホバーと同じ所（#227）
 */

import { IV_TAG_H, IV_TAG_PAD_X, IV_TAG_PAD_Y, labelPx } from './ivHistory';

export interface CrossTagBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** 指がこの割合より上にあるとき、タッチの読み取りを下端に置く（#207 の .ind-float と同じ） */
export const CROSS_FLOAT_TOP_RATIO = 0.4;

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(hi, lo));

/** 横軸の札: 縦線 px を中心に、上端 top（目盛りの行）。svg の幅 width の内側へ寄せる */
export function crossTagX(
  text: string,
  px: number,
  top: number,
  width: number,
  height: number,
): CrossTagBox {
  const w = r1(Math.min(labelPx(text) + IV_TAG_PAD_X, width));
  return {
    x: r1(clamp(px - w / 2, 0, width - w)),
    y: r1(clamp(top, 0, height - IV_TAG_H)),
    w,
    h: IV_TAG_H,
    text,
  };
}

/** 縦軸の札: 横線 py を中心に、右端 right（目盛りの列 = 描画域の左 − 1）。左端 0 で止める */
export function crossTagY(
  text: string,
  py: number,
  right: number,
  width: number,
  height: number,
): CrossTagBox {
  const w = r1(Math.min(labelPx(text) + IV_TAG_PAD_Y, width));
  return {
    x: r1(Math.max(0, right - w)),
    y: r1(clamp(py - IV_TAG_H / 2, 0, height - IV_TAG_H)),
    w,
    h: IV_TAG_H,
    text,
  };
}

/** タッチの読み取りを下端に置くか（指の y が描画域の高さの上 40% にある） */
export function crossFloatBottom(fingerY: number, height: number): boolean {
  return height > 0 && fingerY < height * CROSS_FLOAT_TOP_RATIO;
}

/** 交点をつかむ距離（px。損益グラフの CROSS_GRAB_PX と同じ。#217 の共通の規則） */
export const CROSS_TOUCH_GRAB_PX = 14;

/**
 * タッチのタップの十字線（#217 の共通の規則）: 出ていなければ置く、出ていれば消す（移さない。次のタップでまた置く）。
 * 交点の ±14px の押下はつかむ（gesture.ts の cross）ので、ここに来るのはそれ以外のタップと交点の上の短いタップ
 */
export function crossTapAction(shown: boolean): 'place' | 'hide' {
  return shown ? 'hide' : 'place';
}

/**
 * 目盛りの文字の高さの半分（px。10.5px の文字の半分 5.25 + 余裕。#349）。縦軸の目盛りは文字の中心 = 目盛りの位置
 */
export const TICK_TEXT_HALF_H = 6;
/** 札と目盛りの文字の間に空ける隙間（px。#349） */
export const TICK_TAG_GAP = 2;
/** 浮動小数の誤差（ちょうど隙間のときに残す） */
const TICK_EPS = 1e-6;

/**
 * 縦軸の札と重ならない目盛り（#349。十字線の出ている間、札と重なる目盛りの文字は描かない。格子の線は残す）。
 * 目盛りの列は札の真下なので横は必ず重なる → 高さだけで見る: 中心の差 >= 札の高さの半分 + TICK_TEXT_HALF_H + TICK_TAG_GAP
 * なら残す。札が無ければ同じ配列を返す。元の順を保つ
 */
export function ticksClearY<T>(
  ticks: readonly T[],
  tag: Pick<CrossTagBox, 'y' | 'h'> | null,
  at: (t: T) => number,
): readonly T[] {
  if (!tag) return ticks;
  const mid = tag.y + tag.h / 2;
  const min = tag.h / 2 + TICK_TEXT_HALF_H + TICK_TAG_GAP;
  return ticks.filter((t) => Math.abs(at(t) - mid) >= min - TICK_EPS);
}

/**
 * 横軸の札と重ならない目盛り（#349。規則は ticksClearY と同じ）。目盛りの行は札と同じ行なので幅だけで見る:
 * 文字の区間 [at − labelPx/2, at + labelPx/2] と [札の左 − GAP, 札の右 + GAP] が交わらなければ残す（ちょうど接するなら残す）
 */
export function ticksClearX<T>(
  ticks: readonly T[],
  tag: Pick<CrossTagBox, 'x' | 'w'> | null,
  at: (t: T) => number,
  label: (t: T) => string,
): readonly T[] {
  if (!tag) return ticks;
  const lo = tag.x - TICK_TAG_GAP;
  const hi = tag.x + tag.w + TICK_TAG_GAP;
  return ticks.filter((t) => {
    const c = at(t);
    const half = labelPx(label(t)) / 2;
    return c + half <= lo + TICK_EPS || c - half >= hi - TICK_EPS;
  });
}

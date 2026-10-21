/**
 * パン・拡大の無いチャートの長押しの十字線（#217。DOM を持たない純関数の状態機械）。追証マップで使う。
 * 規則は docs/ui-redesign.md §4.1「十字線の共通の規則」（gesture.ts の長押しと同じ時間・距離）。
 *
 * - タッチ・ペンの 1 本目: 押すと pending。6px（TAP_MOVE_PX）以上動けば scroll（ページのスクロールに譲る。以後この押下は
 *   何もしない）。6px 未満のまま LONG_PRESS_MS 経てば（タイマーは DOM 側）cross になり押した位置を返す
 * - cross の間: move で位置を返し、block（ページを動かさない = touchmove の preventDefault）を返す。離しても十字線は残す
 *   （swallowClick = この押下の後の click を選択に使わない）。cancel も idle（十字線は残す）
 * - マウスはここを通さない（ホバー・クリックは部品が扱う）。2 本目以降の指は無視
 */

import { LONG_PRESS_MS, TAP_MOVE_PX } from './gesture';

export type PressMode = 'idle' | 'pending' | 'cross' | 'scroll';

export interface PressState {
  mode: PressMode;
  /** 追っている pointer（idle なら null） */
  id: number | null;
  x0: number;
  y0: number;
  t0: number;
}

export interface PressSample {
  id: number;
  x: number;
  y: number;
  /** ミリ秒（単調増加の時計） */
  t: number;
}

export interface PressResult {
  state: PressState;
  /** 十字線の位置（要素の座標の画素） */
  cross?: { x: number; y: number };
  /** ページのスクロールを止める（cross の間の move） */
  block?: true;
  /** この押下の後の click を選択に使わない（長押しで十字線にした押下を離した） */
  swallowClick?: true;
}

export function initialPress(): PressState {
  return { mode: 'idle', id: null, x0: 0, y0: 0, t0: 0 };
}

export function pressDown(s: PressState, p: PressSample): PressResult {
  if (s.id !== null) return { state: s };
  return { state: { mode: 'pending', id: p.id, x0: p.x, y0: p.y, t0: p.t } };
}

/** 長押しのタイマーの発火（DOM 側が押下から LONG_PRESS_MS 後に呼ぶ。at = 今の指の位置） */
export function pressLong(s: PressState, t: number, at: { x: number; y: number }): PressResult {
  if (s.mode !== 'pending' || t - s.t0 < LONG_PRESS_MS) return { state: s };
  if (Math.hypot(at.x - s.x0, at.y - s.y0) >= TAP_MOVE_PX) return { state: s };
  return { state: { ...s, mode: 'cross' }, cross: { x: at.x, y: at.y } };
}

export function pressMove(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  if (s.mode === 'cross') return { state: s, cross: { x: p.x, y: p.y }, block: true };
  if (s.mode === 'pending' && Math.hypot(p.x - s.x0, p.y - s.y0) >= TAP_MOVE_PX) {
    return { state: { ...s, mode: 'scroll' } };
  }
  return { state: s };
}

export function pressUp(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  if (s.mode === 'cross') return { state: initialPress(), swallowClick: true };
  return { state: initialPress() };
}

export function pressCancel(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  return { state: initialPress() };
}

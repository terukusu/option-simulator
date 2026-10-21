/**
 * パン・拡大の無いチャートのタッチの十字線（#217。DOM を持たない純関数の状態機械）。追証マップで使う。
 * 規則は docs/ui-redesign.md §4.1「十字線の共通の規則」（タップで置く / 消す・交点をつかんで動かす。gesture.ts と同じ距離・時間）。
 *
 * - タッチ・ペンの 1 本目: 十字線の交点（crossAt）から grabPx 以内ならすぐ cross（交点と指のずれを保つ。ページを止める）。
 *   それ以外は pending
 * - pending: 6px（TAP_MOVE_PX）以上動けば scroll（ページのスクロールに譲る。以後この押下は何もしない）。動かさずに
 *   TAP_MAX_MS 未満で離せば tap（部品が置く / 消す・選択）
 * - cross: move で位置と block（touchmove の preventDefault）を返す。動かさずに TAP_MAX_MS 未満で離せば tap（消す）
 * - マウスはここを通さない（ホバー・クリックは部品が扱う）。2 本目以降の指は無視。cancel で idle
 */

import { TAP_MAX_MS, TAP_MOVE_PX } from './gesture';

export type PressMode = 'idle' | 'pending' | 'cross' | 'scroll';

export interface PressState {
  mode: PressMode;
  /** 追っている pointer（idle なら null） */
  id: number | null;
  x0: number;
  y0: number;
  t0: number;
  /** 一度 6px 動いた（離してもタップにしない） */
  moved: boolean;
  /** cross の間の、指から交点までのずれ */
  ox: number;
  oy: number;
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
  /** ページのスクロールを止める（cross の間） */
  block?: true;
  /** 動かさない短い押下（離した位置） */
  tap?: { x: number; y: number };
}

export function initialPress(): PressState {
  return { mode: 'idle', id: null, x0: 0, y0: 0, t0: 0, moved: false, ox: 0, oy: 0 };
}

/** 押下。crossAt = 今の十字線の交点（無ければ null）、grabPx = つかむ距離 */
export function pressDown(
  s: PressState,
  p: PressSample,
  crossAt: { x: number; y: number } | null,
  grabPx: number,
): PressResult {
  if (s.id !== null) return { state: s };
  const base = { id: p.id, x0: p.x, y0: p.y, t0: p.t, moved: false };
  if (crossAt && Math.hypot(p.x - crossAt.x, p.y - crossAt.y) <= grabPx) {
    return {
      state: { ...base, mode: 'cross', ox: crossAt.x - p.x, oy: crossAt.y - p.y },
      block: true,
    };
  }
  return { state: { ...base, mode: 'pending', ox: 0, oy: 0 } };
}

export function pressMove(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  const far = Math.hypot(p.x - s.x0, p.y - s.y0) >= TAP_MOVE_PX;
  if (s.mode === 'cross') {
    const state = far && !s.moved ? { ...s, moved: true } : s;
    return { state, cross: { x: p.x + s.ox, y: p.y + s.oy }, block: true };
  }
  if (s.mode === 'pending' && far) return { state: { ...s, mode: 'scroll', moved: true } };
  return { state: s };
}

export function pressUp(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  const short =
    !s.moved && Math.hypot(p.x - s.x0, p.y - s.y0) < TAP_MOVE_PX && p.t - s.t0 < TAP_MAX_MS;
  if ((s.mode === 'pending' || s.mode === 'cross') && short) {
    return { state: initialPress(), tap: { x: p.x, y: p.y } };
  }
  return { state: initialPress() };
}

export function pressCancel(s: PressState, p: PressSample): PressResult {
  if (p.id !== s.id) return { state: s };
  return { state: initialPress() };
}

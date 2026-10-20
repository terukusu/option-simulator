/**
 * 境目（スプリッター）の押下の状態機械（DOM を持たない純関数。#207 先物推移の価格と指標の段の境目）。
 *
 * - 1 本（マウス・指）で境目を押す → move のたびに押した位置からの縦の移動量 dy を返す（高さの計算は
 *   ui/view/indicators.ts の futPaneDrag。1 フレーム 1 回にまとめるのは DOM 側の requestAnimationFrame）
 * - 離す: 6px 未満・500ms 未満（gesture.ts の TAP_MOVE_PX・TAP_MAX_MS）ならタップ。同じ境目の 2 回のタップが
 *   300ms・20px 以内（DOUBLE_TAP_MS・DOUBLE_TAP_PX）ならダブルタップ = reset（既定の高さに戻す）。1 回目のタップは cancel
 *   （6px 未満の動きを戻す = 保存しない）。それ以外は end（確定）
 * - 2 本目以降の指は無視。cancel は押す前の高さに戻す（cancel を返す）
 * - マウスのダブルクリックもこの判定で拾う（dblclick を別に聞くと二重に効く）
 */

import { DOUBLE_TAP_MS, DOUBLE_TAP_PX, TAP_MAX_MS, TAP_MOVE_PX } from './gesture';

export interface SplitSample {
  id: number;
  y: number;
  /** ミリ秒（単調増加の時計） */
  t: number;
}

export interface SplitState {
  /** 押している境目（無ければ null = idle） */
  border: number | null;
  id: number;
  y0: number;
  t0: number;
  /** 一度でも 6px 以上動いた（戻ってきてもタップに数えない） */
  moved: boolean;
  /** 直前のタップ（ダブルタップの判定） */
  lastTap: { border: number; y: number; t: number } | null;
}

export interface SplitResult {
  state: SplitState;
  /** 押した位置からの縦の移動量（px。下が正） */
  dy?: number;
  /** 動かした押下を離した（高さを確定して保存する） */
  end?: true;
  /** ダブルタップ（既定の高さに戻す） */
  reset?: true;
  /** 取り消し（押す前の高さに戻す） */
  cancel?: true;
}

export function initialSplit(): SplitState {
  return { border: null, id: -1, y0: 0, t0: 0, moved: false, lastTap: null };
}

export function splitDown(s: SplitState, p: SplitSample, border: number): SplitResult {
  if (s.border !== null) return { state: s };
  return { state: { ...s, border, id: p.id, y0: p.y, t0: p.t, moved: false } };
}

export function splitMove(s: SplitState, p: SplitSample): SplitResult {
  if (s.border === null || p.id !== s.id) return { state: s };
  const dy = p.y - s.y0;
  const moved = s.moved || Math.abs(dy) >= TAP_MOVE_PX;
  return { state: moved === s.moved ? s : { ...s, moved }, dy };
}

export function splitUp(s: SplitState, p: SplitSample): SplitResult {
  if (s.border === null || p.id !== s.id) return { state: s };
  const border = s.border;
  const idle: SplitState = { ...initialSplit(), lastTap: s.lastTap };
  const dy = p.y - s.y0;
  if (s.moved || Math.abs(dy) >= TAP_MOVE_PX || p.t - s.t0 >= TAP_MAX_MS) {
    return { state: { ...idle, lastTap: null }, dy, end: true };
  }
  const last = s.lastTap;
  if (
    last &&
    last.border === border &&
    p.t - last.t <= DOUBLE_TAP_MS &&
    Math.abs(p.y - last.y) <= DOUBLE_TAP_PX
  ) {
    return { state: { ...idle, lastTap: null }, reset: true };
  }
  // 動かさない短い押下（タップ）: 少しの移動（< 6px）は戻し（保存しない）、ダブルタップの 1 回目に数える
  return { state: { ...idle, lastTap: { border, y: p.y, t: p.t } }, cancel: true };
}

export function splitCancel(s: SplitState): SplitResult {
  if (s.border === null) return { state: s };
  return { state: initialSplit(), cancel: true };
}

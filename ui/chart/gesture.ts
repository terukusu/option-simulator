/**
 * グラフのジェスチャーの状態機械（DOM を持たない純関数）。損益グラフとスマイルで共用する（#11）。
 *
 * - 1 本（マウス・指）: 6px 以上動かすとドラッグ = パン（開始時の範囲から、指の下の値が付いてくる）。
 *   6px 未満・500ms 未満で離すとタップ。2 回のタップが 300ms・20px 以内ならダブルタップ = リセット
 * - 2 本: ピンチ（2 本の指の下の値を保つ）。1 本離すと残りの指の位置と現在の範囲で取り直す（飛ばない）
 * - 3 本目以降の指は無視。cancel で状態を捨てる
 *
 * 拡大・パンの規則そのものは ui/chart/scale.ts（panBy・pinchViewport）。DOM のイベントの受け口は
 * ui/components/useChartGestures.ts。
 */

import { type Domain, panBy, pinchViewport } from './scale';

export const TAP_MOVE_PX = 6;
export const TAP_MAX_MS = 500;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 20;

export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** ミリ秒（単調増加の時計） */
  t: number;
}

export interface GestureCtx {
  /** 現在の表示範囲 */
  viewport: Domain;
  /** 描画域の横の画素範囲（要素の座標） */
  range: Domain;
  full: Domain;
  minWidth: number;
}

interface TrackedPointer {
  id: number;
  x: number;
  y: number;
  /** 押した位置と時刻 */
  x0: number;
  y0: number;
  t0: number;
}

export type GestureMode = 'idle' | 'pending' | 'drag' | 'pinch';

export interface GestureState {
  mode: GestureMode;
  pointers: TrackedPointer[];
  /** ドラッグ・ピンチの開始時の表示範囲 */
  start: Domain | null;
  /** ドラッグの基準の画素（x）、ピンチの開始時の 2 本の画素 */
  anchorPx: readonly [number, number] | null;
  /** 直前のタップ（ダブルタップの判定） */
  lastTap: { x: number; y: number; t: number } | null;
}

export interface GestureResult {
  state: GestureState;
  viewport?: Domain;
  tap?: { x: number; y: number };
  reset?: true;
}

export function initialGesture(): GestureState {
  return { mode: 'idle', pointers: [], start: null, anchorPx: null, lastTap: null };
}

function pinchPx(ps: readonly TrackedPointer[]): readonly [number, number] {
  const a = ps[0] as TrackedPointer;
  const b = ps[1] as TrackedPointer;
  return [a.x, b.x];
}

export function gestureDown(s: GestureState, p: PointerSample, ctx: GestureCtx): GestureResult {
  if (s.pointers.some((q) => q.id === p.id) || s.pointers.length >= 2) return { state: s };
  const tracked: TrackedPointer = { id: p.id, x: p.x, y: p.y, x0: p.x, y0: p.y, t0: p.t };
  const pointers = [...s.pointers, tracked];
  if (pointers.length === 1) {
    return {
      state: { ...s, mode: 'pending', pointers, start: ctx.viewport, anchorPx: [p.x, p.x] },
    };
  }
  return {
    state: { ...s, mode: 'pinch', pointers, start: ctx.viewport, anchorPx: pinchPx(pointers) },
  };
}

export function gestureMove(s: GestureState, p: PointerSample, ctx: GestureCtx): GestureResult {
  const i = s.pointers.findIndex((q) => q.id === p.id);
  if (i < 0) return { state: s };
  const pointers = s.pointers.map((q, j) => (j === i ? { ...q, x: p.x, y: p.y } : q));
  let mode = s.mode;
  const cur = pointers[i] as TrackedPointer;
  if (mode === 'pending' && Math.hypot(cur.x - cur.x0, cur.y - cur.y0) >= TAP_MOVE_PX) {
    mode = 'drag';
  }
  const state: GestureState = { ...s, mode, pointers };
  if (!s.start || !s.anchorPx) return { state };
  if (mode === 'drag') {
    const rangeWidth = ctx.range[1] - ctx.range[0];
    if (!(rangeWidth > 0)) return { state };
    const perPx = (s.start[1] - s.start[0]) / rangeWidth;
    return { state, viewport: panBy(s.start, -(cur.x - s.anchorPx[0]) * perPx, ctx.full) };
  }
  if (mode === 'pinch' && pointers.length === 2) {
    return {
      state,
      viewport: pinchViewport(
        s.start,
        s.anchorPx,
        pinchPx(pointers),
        ctx.range,
        ctx.full,
        ctx.minWidth,
      ),
    };
  }
  return { state };
}

export function gestureUp(s: GestureState, p: PointerSample, ctx: GestureCtx): GestureResult {
  const i = s.pointers.findIndex((q) => q.id === p.id);
  if (i < 0) return { state: s };
  const released = s.pointers[i] as TrackedPointer;
  const pointers = s.pointers.filter((_, j) => j !== i);
  if (s.mode === 'pinch') {
    const rest = pointers[0];
    if (!rest) return { state: { ...initialGesture(), lastTap: s.lastTap } };
    // 残りの 1 本でドラッグを取り直す（現在の範囲から）
    return {
      state: {
        ...s,
        mode: 'drag',
        pointers,
        start: ctx.viewport,
        anchorPx: [rest.x, rest.x],
      },
    };
  }
  const idle: GestureState = { ...initialGesture(), lastTap: s.lastTap };
  if (s.mode !== 'pending') return { state: idle };
  const moved = Math.hypot(p.x - released.x0, p.y - released.y0);
  if (moved >= TAP_MOVE_PX || p.t - released.t0 >= TAP_MAX_MS) return { state: idle };
  const last = s.lastTap;
  if (
    last &&
    p.t - last.t <= DOUBLE_TAP_MS &&
    Math.hypot(p.x - last.x, p.y - last.y) <= DOUBLE_TAP_PX
  ) {
    return { state: { ...idle, lastTap: null }, reset: true };
  }
  return { state: { ...idle, lastTap: { x: p.x, y: p.y, t: p.t } }, tap: { x: p.x, y: p.y } };
}

export function gestureCancel(
  _s: GestureState,
  _p: PointerSample,
  _ctx: GestureCtx,
): GestureResult {
  return { state: initialGesture() };
}

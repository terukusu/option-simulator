/**
 * グラフのジェスチャーの状態機械（DOM を持たない純関数）。損益グラフとスマイルで共用する（#11）。
 *
 * - 1 本（マウス・指）: 6px 以上動かすとドラッグ = パン（開始時の範囲から、指の下の値が付いてくる）。
 *   6px 未満・500ms 未満で離すとタップ。2 回のタップが 300ms・20px 以内ならダブルタップ = リセット
 * - 2 本: ピンチ（2 本の指の下の値を保つ）。1 本離すと残りの指の位置と現在の範囲で取り直す（飛ばない）
 * - 3 本目以降の指は無視。cancel で状態を捨てる
 * - 長押し・つかむ（ctx.scrub を渡したときだけ。損益グラフのシナリオ点。#52）: 6px 未満のまま 450ms 押すと
 *   つかむ状態（scrub）になり押した位置を返す（タイマーは DOM 側。gestureLongPress）。縦線（linePx）の
 *   ±12px を押したらすぐつかむ（押した位置と線のずれを保つ）。つかんでいる間は move の位置を返し、表示範囲は
 *   変えない。2 本目以降の指は無視。離す・cancel で idle（タップ・リセットは出さない）
 *
 * 拡大・パンの規則そのものは ui/chart/scale.ts（panBy・pinchViewport）。DOM のイベントの受け口は
 * ui/components/useChartGestures.ts。
 */

import { type Domain, panBy, pinchViewport } from './scale';

export const TAP_MOVE_PX = 6;
export const TAP_MAX_MS = 500;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 20;
/** 長押しの時間（TAP_MAX_MS より短い。#52） */
export const LONG_PRESS_MS = 450;
/** 縦線をつかむ幅（左右の画素。#52） */
export const GRAB_PX = 12;

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
  /**
   * 長押し・つかむを有効にする（損益グラフ。無ければ従来どおり = スマイル）。linePx = つかめる縦線の画素
   * （要素の座標。無ければ null）
   */
  scrub?: { linePx: number | null };
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

export type GestureMode = 'idle' | 'pending' | 'drag' | 'pinch' | 'scrub';

export interface GestureState {
  mode: GestureMode;
  pointers: TrackedPointer[];
  /** ドラッグ・ピンチの開始時の表示範囲 */
  start: Domain | null;
  /** ドラッグの基準の画素（x）、ピンチの開始時の 2 本の画素 */
  anchorPx: readonly [number, number] | null;
  /** 直前のタップ（ダブルタップの判定） */
  lastTap: { x: number; y: number; t: number } | null;
  /** つかんでいる間の、指の位置から縦線までのずれ（画素。長押しは 0） */
  scrubOffset: number;
}

export interface GestureResult {
  state: GestureState;
  viewport?: Domain;
  tap?: { x: number; y: number };
  reset?: true;
  /** つかんでいる縦線の位置（要素の座標の画素） */
  scrub?: { x: number };
}

export function initialGesture(): GestureState {
  return {
    mode: 'idle',
    pointers: [],
    start: null,
    anchorPx: null,
    lastTap: null,
    scrubOffset: 0,
  };
}

function pinchPx(ps: readonly TrackedPointer[]): readonly [number, number] {
  const a = ps[0] as TrackedPointer;
  const b = ps[1] as TrackedPointer;
  return [a.x, b.x];
}

export function gestureDown(s: GestureState, p: PointerSample, ctx: GestureCtx): GestureResult {
  if (s.mode === 'scrub' || s.pointers.some((q) => q.id === p.id) || s.pointers.length >= 2) {
    return { state: s };
  }
  const tracked: TrackedPointer = { id: p.id, x: p.x, y: p.y, x0: p.x, y0: p.y, t0: p.t };
  const pointers = [...s.pointers, tracked];
  if (pointers.length === 1) {
    const line = ctx.scrub?.linePx;
    if (line !== undefined && line !== null && Math.abs(p.x - line) <= GRAB_PX) {
      // 縦線の近く: 待たずにつかむ（線は飛ばさず、押した位置とのずれを保つ）
      return {
        state: {
          ...s,
          mode: 'scrub',
          pointers,
          start: null,
          anchorPx: null,
          scrubOffset: line - p.x,
        },
      };
    }
    return {
      state: { ...s, mode: 'pending', pointers, start: ctx.viewport, anchorPx: [p.x, p.x] },
    };
  }
  return {
    state: { ...s, mode: 'pinch', pointers, start: ctx.viewport, anchorPx: pinchPx(pointers) },
  };
}

/**
 * 長押しのタイマーの発火（DOM 側が押下から LONG_PRESS_MS 後に呼ぶ。t は押下と同じ時計）。ctx.scrub があり、
 * 1 本で pending（6px 未満）のまま LONG_PRESS_MS 経っていれば、つかむ状態にして指の位置を返す。
 * それ以外は状態そのまま。
 */
export function gestureLongPress(s: GestureState, t: number, ctx: GestureCtx): GestureResult {
  if (!ctx.scrub || s.mode !== 'pending' || s.pointers.length !== 1) return { state: s };
  const p = s.pointers[0] as TrackedPointer;
  if (t - p.t0 < LONG_PRESS_MS || Math.hypot(p.x - p.x0, p.y - p.y0) >= TAP_MOVE_PX) {
    return { state: s };
  }
  return {
    state: { ...s, mode: 'scrub', start: null, anchorPx: null, scrubOffset: 0 },
    scrub: { x: p.x },
  };
}

export function gestureMove(s: GestureState, p: PointerSample, ctx: GestureCtx): GestureResult {
  const i = s.pointers.findIndex((q) => q.id === p.id);
  if (i < 0) return { state: s };
  const pointers = s.pointers.map((q, j) => (j === i ? { ...q, x: p.x, y: p.y } : q));
  if (s.mode === 'scrub') {
    return { state: { ...s, pointers }, scrub: { x: p.x + s.scrubOffset } };
  }
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
  // つかむ操作の後はタップ・ダブルタップの判定を続けない
  if (s.mode === 'scrub') return { state: initialGesture() };
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

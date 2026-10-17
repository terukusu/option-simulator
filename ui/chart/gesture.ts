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
 *   変えない。2 本目以降の指は無視。離す・cancel で idle（タップ・リセットは出さない）。つかむ幅は scrub.grabPx
 *   （省略時 GRAB_PX = 12。新しい画面の舞台は 14。#82）
 * - 足マーカー（ctx.markers を渡したときだけ。新しい画面の舞台。#82）: 1 本目をマーカーの当たり判定
 *   （横 ±MARKER_HIT_PX・band の縦の範囲）で押すと 'marker'。6px 未満・500ms 未満で離せば markerTap
 *   （ダブルタップの 1 回目に数えない）、6px 動けばパン（今のまま）、drag: true のマーカーを LONG_PRESS_MS 押すと
 *   'markerDrag'（move で markerDrag、離して markerDrop。表示範囲は変えない）。markerDrag 中に 2 本目の指が来るか
 *   cancel なら markerCancel（drop は出さない）。マーカーはハンドルより優先（band の外ならハンドル）
 * - 面の上の点（ctx.surface を渡したときだけ。新しい画面の舞台の面モード。#88 段 B）: 1 本目をマーカーの外で押すと
 *   すぐ 'surface'（パン・長押しを待たない）。点（pointPx）から grabPx 以内（距離）なら点の位置を返して点と指の
 *   ずれを保ち、それ以外は押した位置を返す（surfaceStart）。move で surface（viewport は返さない = パンしない）。
 *   離して idle + surfaceEnd、6px 未満・500ms 未満の押下はタップとしてダブルタップ（reset）に数える（tap は出さない）。
 *   2 本目の指でピンチに移り surfaceCancel（押す前に戻す）、cancel も surfaceCancel。長押しは何もしない。
 *   マーカーの上で押して 6px 動かすとパンではなく 'surface'（その位置から）。ctx.surface があると ctx.scrub は使わない
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
/** 足マーカーの当たり判定の横の幅（左右の画素。#82） */
export const MARKER_HIT_PX = 8;

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
   * （要素の座標。無ければ null）。grabPx = 縦線をつかむ幅（省略時 GRAB_PX）
   */
  scrub?: { linePx: number | null; grabPx?: number };
  /**
   * 足マーカーの当たり判定（#82。無ければ従来どおり）。band = 縦の範囲（要素の座標）、items = マーカーの横の画素と
   * 長押しでドラッグできるか
   */
  markers?: {
    band: readonly [number, number];
    items: ReadonlyArray<{ id: number; px: number; drag: boolean }>;
  };
  /**
   * 面の上の点（#88 段 B。無ければ従来どおり）。pointPx = 今の点の画素（要素の座標。無ければ null）、grabPx = 点を
   * つかむ距離（px）。渡すと scrub は使わない
   */
  surface?: { pointPx: { x: number; y: number } | null; grabPx: number };
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

export type GestureMode =
  | 'idle'
  | 'pending'
  | 'drag'
  | 'pinch'
  | 'scrub'
  | 'marker'
  | 'markerDrag'
  | 'surface';

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
  /** 押したマーカー（'marker'・'markerDrag' の間だけ。それ以外は null） */
  marker: { id: number; drag: boolean } | null;
  /** 面の点をつかんでいる間の、指の位置から点までのずれ（画素。'surface' の間だけ。それ以外は null） */
  surfaceOffset: { x: number; y: number } | null;
}

export interface GestureResult {
  state: GestureState;
  viewport?: Domain;
  tap?: { x: number; y: number };
  reset?: true;
  /** つかんでいる縦線の位置（要素の座標の画素） */
  scrub?: { x: number };
  /** マーカーのタップ（#82） */
  markerTap?: { id: number };
  /** マーカーのドラッグ中の指の位置（要素の座標の画素） */
  markerDrag?: { id: number; x: number };
  /** マーカーのドラッグを離した位置 */
  markerDrop?: { id: number; x: number };
  /** マーカーのドラッグの取り消し（2 本目の指・cancel） */
  markerCancel?: { id: number };
  /** 面の点の位置（要素の座標の画素。#88 段 B） */
  surface?: { x: number; y: number };
  /** 面の点をつかみ始めた（最初の surface より前に押す前の値を覚える） */
  surfaceStart?: true;
  /** 面の点を離した */
  surfaceEnd?: true;
  /** 面の点の取り消し（2 本目の指・cancel。押す前の値に戻す） */
  surfaceCancel?: true;
}

export function initialGesture(): GestureState {
  return {
    mode: 'idle',
    pointers: [],
    start: null,
    anchorPx: null,
    lastTap: null,
    scrubOffset: 0,
    marker: null,
    surfaceOffset: null,
  };
}

/**
 * 押した位置のマーカー（band の縦の範囲の中で |x − px| ≤ MARKER_HIT_PX の最も近いもの。等距離は配列の先）。
 * ctx.markers が無い・当たらなければ null。
 */
export function markerAt(
  ctx: GestureCtx,
  x: number,
  y: number,
): { id: number; drag: boolean } | null {
  const m = ctx.markers;
  if (!m || y < m.band[0] || y > m.band[1]) return null;
  let best: { id: number; px: number; drag: boolean } | null = null;
  for (const it of m.items) {
    const d = Math.abs(x - it.px);
    if (d <= MARKER_HIT_PX && (best === null || d < Math.abs(x - best.px))) best = it;
  }
  return best ? { id: best.id, drag: best.drag } : null;
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
  if (s.mode === 'surface') {
    // 面の点をつかんでいる間の 2 本目の指: 押す前の値に戻してピンチへ
    return {
      state: {
        ...s,
        mode: 'pinch',
        pointers,
        start: ctx.viewport,
        anchorPx: pinchPx(pointers),
        surfaceOffset: null,
      },
      surfaceCancel: true,
    };
  }
  if (s.mode === 'markerDrag' && s.marker) {
    // マーカーのドラッグ中の 2 本目の指: 取り消してピンチへ（確定しない）
    return {
      state: {
        ...s,
        mode: 'pinch',
        pointers,
        start: ctx.viewport,
        anchorPx: pinchPx(pointers),
        marker: null,
      },
      markerCancel: { id: s.marker.id },
    };
  }
  if (pointers.length === 1) {
    const hit = ctx.markers ? markerAt(ctx, p.x, p.y) : null;
    if (hit) {
      // マーカーの上: タップ / 長押しでドラッグ / 6px 動けばパン（pending と同じ）
      return {
        state: {
          ...s,
          mode: 'marker',
          pointers,
          start: ctx.viewport,
          anchorPx: [p.x, p.x],
          marker: hit,
        },
      };
    }
    if (ctx.surface) {
      // 面の上: すぐ点をつかむ（点の近くはずれを保つ = 飛ばない、それ以外は押した位置へ）
      const pt = ctx.surface.pointPx;
      const near = pt !== null && Math.hypot(p.x - pt.x, p.y - pt.y) <= ctx.surface.grabPx;
      const offset = near && pt ? { x: pt.x - p.x, y: pt.y - p.y } : { x: 0, y: 0 };
      return {
        state: {
          ...s,
          mode: 'surface',
          pointers,
          start: null,
          anchorPx: null,
          surfaceOffset: offset,
        },
        surface: { x: p.x + offset.x, y: p.y + offset.y },
        surfaceStart: true,
      };
    }
    const line = ctx.scrub?.linePx;
    const grab = ctx.scrub?.grabPx ?? GRAB_PX;
    if (line !== undefined && line !== null && Math.abs(p.x - line) <= grab) {
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
    state: {
      ...s,
      mode: 'pinch',
      pointers,
      start: ctx.viewport,
      anchorPx: pinchPx(pointers),
      marker: null,
    },
  };
}

/**
 * 長押しのタイマーの発火（DOM 側が押下から LONG_PRESS_MS 後に呼ぶ。t は押下と同じ時計）。ctx.scrub があり、
 * 1 本で pending（6px 未満）のまま LONG_PRESS_MS 経っていれば、つかむ状態にして指の位置を返す。
 * それ以外は状態そのまま。
 */
export function gestureLongPress(s: GestureState, t: number, ctx: GestureCtx): GestureResult {
  if (s.mode === 'marker') {
    // マーカーの長押し: ドラッグできるマーカーだけ（#82）
    const q = s.pointers[0];
    if (!s.marker?.drag || s.pointers.length !== 1 || !q) return { state: s };
    if (t - q.t0 < LONG_PRESS_MS || Math.hypot(q.x - q.x0, q.y - q.y0) >= TAP_MOVE_PX) {
      return { state: s };
    }
    return {
      state: { ...s, mode: 'markerDrag', start: null, anchorPx: null },
      markerDrag: { id: s.marker.id, x: q.x },
    };
  }
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
  if (s.mode === 'markerDrag' && s.marker) {
    return { state: { ...s, pointers }, markerDrag: { id: s.marker.id, x: p.x } };
  }
  const cur = pointers[i] as TrackedPointer;
  const far = Math.hypot(cur.x - cur.x0, cur.y - cur.y0) >= TAP_MOVE_PX;
  if (s.mode === 'surface' && s.surfaceOffset) {
    const o = s.surfaceOffset;
    // 一度 6px 動いた押下は戻ってきてもタップに数えない（pending が drag になるのと同じ。押した時刻を捨てる）
    const kept = far
      ? pointers.map((q, j) => (j === i ? { ...q, t0: Number.NEGATIVE_INFINITY } : q))
      : pointers;
    return { state: { ...s, pointers: kept }, surface: { x: p.x + o.x, y: p.y + o.y } };
  }
  if (ctx.surface && s.mode === 'marker' && far) {
    // 面モードのマーカーの上で動かした: パンではなく点をつかむ（その位置から）。6px 動いたのでタップに数えない
    return {
      state: {
        ...s,
        mode: 'surface',
        pointers: pointers.map((q, j) => (j === i ? { ...q, t0: Number.NEGATIVE_INFINITY } : q)),
        start: null,
        anchorPx: null,
        marker: null,
        surfaceOffset: { x: 0, y: 0 },
      },
      surface: { x: p.x, y: p.y },
      surfaceStart: true,
    };
  }
  let mode = s.mode;
  let marker = s.marker;
  if ((mode === 'pending' || mode === 'marker') && far) {
    mode = 'drag';
    marker = null;
  }
  const state: GestureState = { ...s, mode, pointers, marker };
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
  if (s.mode === 'surface') {
    // 面の点を離す。動かさない短い押下はダブルタップ（リセット）の判定に数える（tap は出さない）
    const idle: GestureState = { ...initialGesture(), lastTap: s.lastTap };
    const moved = Math.hypot(p.x - released.x0, p.y - released.y0);
    if (moved >= TAP_MOVE_PX || p.t - released.t0 >= TAP_MAX_MS) {
      return { state: idle, surfaceEnd: true };
    }
    const last = s.lastTap;
    if (
      last &&
      p.t - last.t <= DOUBLE_TAP_MS &&
      Math.hypot(p.x - last.x, p.y - last.y) <= DOUBLE_TAP_PX
    ) {
      return { state: { ...idle, lastTap: null }, surfaceEnd: true, reset: true };
    }
    return { state: { ...idle, lastTap: { x: p.x, y: p.y, t: p.t } }, surfaceEnd: true };
  }
  if (s.mode === 'markerDrag' && s.marker) {
    return { state: initialGesture(), markerDrop: { id: s.marker.id, x: p.x } };
  }
  if (s.mode === 'marker' && s.marker) {
    // マーカーのタップはダブルタップ（リセット）の 1 回目に数えない
    const idle = initialGesture();
    const moved = Math.hypot(p.x - released.x0, p.y - released.y0);
    if (moved >= TAP_MOVE_PX || p.t - released.t0 >= TAP_MAX_MS) return { state: idle };
    return { state: idle, markerTap: { id: s.marker.id } };
  }
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

export function gestureCancel(s: GestureState, _p: PointerSample, _ctx: GestureCtx): GestureResult {
  if (s.mode === 'surface') return { state: initialGesture(), surfaceCancel: true };
  if (s.mode === 'markerDrag' && s.marker) {
    return { state: initialGesture(), markerCancel: { id: s.marker.id } };
  }
  return { state: initialGesture() };
}

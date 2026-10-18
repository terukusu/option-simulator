/**
 * グラフの拡大・パンのジェスチャー（DOM の薄いフック）。損益グラフとスマイルで共用する（#11、M10）。
 *
 * - ホイール: カーソル位置を固定して拡大・縮小（ページはスクロールしない）。横スクロールはパン
 * - ドラッグ / 1 本指: パン。2 本指: ピンチ。ダブルクリック / ダブルタップ: リセット
 * - フォーカス時のキー: + / = 拡大、− 縮小（中心固定）、← / → 幅の 10% パン、R リセット
 * - タップ（動かさずに離す）は onTap に要素の座標で渡す（スマイルの点の選択）
 * - scrub を渡したとき（損益グラフ。#52）: 長押し（6px 未満のまま 450ms）・縦線の ±12px の押下でつかみ、
 *   指の位置を onScrub に要素の座標で渡す。キー , . < > は onScrubKey に渡す。長押しの OS のメニュー
 *   （contextmenu）を止める
 * - 舞台（#82。スマイルは渡さない = 今のまま。旧画面の損益グラフも渡さなかった）: scrub.grabPx でつかむ幅、arrowPan: false で
 *   ← / → をパンに使わず onScrubKey(key, shiftKey) へ、markers で足マーカーのタップ・長押しドラッグ
 *   （onMarkerTap / onMarkerDrag（1 フレーム 1 回）/ onMarkerDrop / onMarkerCancel）。マーカーの上の dblclick は
 *   リセットしない。長押しでつかんだ（ハンドル・マーカー）ときは onLongPress
 * - 面モード（#88 段 B）: surface を渡すと 1 本目の押下ですぐ面の点をつかむ。onSurfaceStart（同期。最初の onSurface
 *   より前）→ onSurface(x, y)（1 フレーム 1 回）→ onSurfaceEnd（同期。最後の位置は次のフレームで流す）。2 本目の指・
 *   cancel は未反映の位置を捨てて onSurfaceCancel。リセット（ダブルタップ・dblclick・R）の前に未反映の位置を流す
 *
 * 規則はすべて純関数（ui/chart/scale.ts・ui/chart/gesture.ts）。ここはイベントを受けて渡すだけ。
 * move・wheel の反映は requestAnimationFrame で 1 フレーム 1 回にまとめる。最新の props は ref で持ち、
 * リスナーの付け外しは要素ごとに 1 回だけ行う。要素の CSS に touch-action: none を付けること。
 */

import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  type GestureCtx,
  type GestureResult,
  gestureCancel,
  gestureDown,
  gestureLongPress,
  gestureMove,
  gestureUp,
  initialGesture,
  LONG_PRESS_MS,
  markerAt,
  type PointerSample,
} from '../chart/gesture';
import { type Domain, panBy, pixelToValue, wheelFactor, zoom, zoomAt } from '../chart/scale';

/** キーの拡大・縮小の倍率と、← / → のパンの割合 */
export const KEY_ZOOM_IN = 0.8;
export const KEY_ZOOM_OUT = 1.25;
export const KEY_PAN_RATIO = 0.1;

export interface ChartGestureOptions {
  /** 現在の表示範囲 */
  viewport: Domain;
  full: Domain;
  minWidth: number;
  /** 描画域の横の画素範囲（要素の座標） */
  range: Domain;
  /** 描くものが無いときは操作を受けない */
  disabled: boolean;
  /** 表示範囲の変更（null = リセット） */
  onViewport: (viewport: Domain | null) => void;
  onTap?: (x: number, y: number) => void;
  /**
   * 長押し・縦線をつかむ操作を有効にする（linePx = つかめる縦線の画素。無ければ null。#52）。
   * grabPx = つかむ幅（省略時は GRAB_PX。#82）
   */
  scrub?: { linePx: number | null; grabPx?: number };
  /** つかんでいる位置（要素の座標の画素。1 フレーム 1 回） */
  onScrub?: (x: number) => void;
  /** グラフのキー（, . < >。arrowPan: false なら ← / → も）。扱ったら true（既定の動作を止める） */
  onScrubKey?: (key: string, shiftKey: boolean) => boolean;
  /** ← / → をパンに使う（省略時 true = 今のまま。false なら onScrubKey に渡す。#82） */
  arrowPan?: boolean;
  /** 足マーカーの当たり判定（#82。gesture.ts の GestureCtx.markers） */
  markers?: GestureCtx['markers'];
  onMarkerTap?: (id: number) => void;
  /** マーカーのドラッグ中の指の位置（要素の座標の画素。1 フレーム 1 回） */
  onMarkerDrag?: (id: number, x: number) => void;
  onMarkerDrop?: (id: number, x: number) => void;
  onMarkerCancel?: (id: number) => void;
  /** 長押しでつかんだ（ハンドル・マーカーのドラッグの開始。端末の軽い振動などに使う） */
  onLongPress?: () => void;
  /** 面の上の点（#88 段 B。gesture.ts の GestureCtx.surface。渡すと scrub は使わない） */
  surface?: GestureCtx['surface'];
  onSurfaceStart?: () => void;
  /** 面の点の位置（要素の座標の画素。1 フレーム 1 回） */
  onSurface?: (x: number, y: number) => void;
  onSurfaceEnd?: () => void;
  onSurfaceCancel?: () => void;
}

export function useChartGestures(ref: RefObject<HTMLElement>, opts: ChartGestureOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let state = initialGesture();
    /** まだ反映していない表示範囲（同じフレームの wheel を重ねる・ピンチの取り直しに使う） */
    let pending: Domain | null = null;
    /** まだ反映していない、つかんでいる位置 */
    let pendingScrub: number | null = null;
    /** まだ反映していない、マーカーのドラッグの位置 */
    let pendingMarker: { id: number; x: number } | null = null;
    /** まだ反映していない、面の点の位置 */
    let pendingSurface: { x: number; y: number } | null = null;
    let frame = 0;
    /** 長押しのタイマー */
    let longTimer = 0;

    const current = (): Domain => pending ?? optsRef.current.viewport;
    const ctx = (): GestureCtx => {
      const o = optsRef.current;
      return {
        viewport: current(),
        range: o.range,
        full: o.full,
        minWidth: o.minWidth,
        ...(o.scrub ? { scrub: o.scrub } : {}),
        ...(o.markers ? { markers: o.markers } : {}),
        ...(o.surface ? { surface: o.surface } : {}),
      };
    };
    const flush = () => {
      frame = 0;
      const v = pending;
      const sx = pendingScrub;
      const mk = pendingMarker;
      const sf = pendingSurface;
      pending = null;
      pendingScrub = null;
      pendingMarker = null;
      pendingSurface = null;
      if (v) optsRef.current.onViewport(v);
      if (sx !== null) optsRef.current.onScrub?.(sx);
      if (mk) optsRef.current.onMarkerDrag?.(mk.id, mk.x);
      if (sf) optsRef.current.onSurface?.(sf.x, sf.y);
    };
    const schedule = (v: Domain) => {
      pending = v;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const scheduleScrub = (x: number) => {
      pendingScrub = x;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const scheduleMarker = (m: { id: number; x: number }) => {
      pendingMarker = m;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const scheduleSurface = (pt: { x: number; y: number }) => {
      pendingSurface = pt;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const clearLong = () => {
      if (longTimer) clearTimeout(longTimer);
      longTimer = 0;
    };
    const reset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      pendingScrub = null;
      // 面の点はリセットの前に流す（位置は今の表示範囲で読む）
      const sf = pendingSurface;
      pendingSurface = null;
      if (sf) optsRef.current.onSurface?.(sf.x, sf.y);
      optsRef.current.onViewport(null);
    };
    const sample = (e: PointerEvent): PointerSample => {
      const r = el.getBoundingClientRect();
      return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
    };
    const apply = (res: GestureResult) => {
      state = res.state;
      if (res.surfaceCancel) {
        // 未反映の位置を捨ててから押す前に戻す
        pendingSurface = null;
        optsRef.current.onSurfaceCancel?.();
      }
      if (res.surfaceStart) optsRef.current.onSurfaceStart?.();
      if (res.surface) scheduleSurface(res.surface);
      if (res.surfaceEnd) optsRef.current.onSurfaceEnd?.();
      if (res.reset) reset();
      else if (res.viewport) schedule(res.viewport);
      if (res.scrub) scheduleScrub(res.scrub.x);
      if (res.tap) optsRef.current.onTap?.(res.tap.x, res.tap.y);
      if (res.markerDrag) scheduleMarker(res.markerDrag);
      // 離す・取り消しの後に前のフレームの位置を流さない
      if (res.markerDrop || res.markerCancel) pendingMarker = null;
      if (res.markerTap) optsRef.current.onMarkerTap?.(res.markerTap.id);
      if (res.markerDrop) optsRef.current.onMarkerDrop?.(res.markerDrop.id, res.markerDrop.x);
      if (res.markerCancel) optsRef.current.onMarkerCancel?.(res.markerCancel.id);
      // 長押しを待つのは 1 本の押下（pending・マーカーの上）の間だけ
      if ((state.mode !== 'pending' && state.mode !== 'marker') || state.pointers.length !== 1) {
        clearLong();
      }
    };

    const onDown = (e: PointerEvent) => {
      if (optsRef.current.disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // ボタン・入力欄の上は対象外（グラフの外のツール行）
      if ((e.target as Element | null)?.closest('button, input, select, label')) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture できない環境でも操作は続ける
      }
      apply(gestureDown(state, sample(e), ctx()));
      const waits =
        (optsRef.current.scrub && state.mode === 'pending') ||
        (state.mode === 'marker' && state.marker?.drag === true);
      if (waits && state.pointers.length === 1) {
        clearLong();
        // PointerEvent.timeStamp と同じ時計（performance.now）で発火時刻を渡す
        longTimer = window.setTimeout(() => {
          longTimer = 0;
          const before = state.mode;
          apply(gestureLongPress(state, performance.now(), ctx()));
          if (before !== state.mode) optsRef.current.onLongPress?.();
        }, LONG_PRESS_MS);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (state.pointers.length === 0) return;
      apply(gestureMove(state, sample(e), ctx()));
      if (
        state.mode === 'drag' ||
        state.mode === 'pinch' ||
        state.mode === 'scrub' ||
        state.mode === 'markerDrag' ||
        state.mode === 'surface'
      ) {
        e.preventDefault();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (state.pointers.length === 0) return;
      apply(gestureUp(state, sample(e), ctx()));
    };
    const onCancel = (e: PointerEvent) => {
      apply(gestureCancel(state, sample(e), ctx()));
    };
    const onWheel = (e: WheelEvent) => {
      const o = optsRef.current;
      if (o.disabled) return;
      e.preventDefault();
      const v = current();
      const rangeWidth = o.range[1] - o.range[0];
      if (!(rangeWidth > 0)) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dx = e.deltaX * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rangeWidth : 1);
        schedule(panBy(v, (dx * (v[1] - v[0])) / rangeWidth, o.full));
        return;
      }
      const r = el.getBoundingClientRect();
      const anchor = pixelToValue(v, o.range, e.clientX - r.left);
      const f = wheelFactor(e.deltaY, e.deltaMode, el.clientHeight || 200);
      schedule(zoomAt(v, f, anchor, o.full, o.minWidth));
    };
    const onKey = (e: KeyboardEvent) => {
      const o = optsRef.current;
      if (o.disabled || e.altKey || e.ctrlKey || e.metaKey) return;
      const v = current();
      let next: Domain | null = null;
      switch (e.key) {
        case '+':
        case '=':
          next = zoom(v, KEY_ZOOM_IN, o.full, o.minWidth);
          break;
        case '-':
        case '−':
          next = zoom(v, KEY_ZOOM_OUT, o.full, o.minWidth);
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (o.arrowPan === false) {
            if (o.onScrubKey?.(e.key, e.shiftKey)) e.preventDefault();
            return;
          }
          next = panBy(v, (e.key === 'ArrowLeft' ? -1 : 1) * (v[1] - v[0]) * KEY_PAN_RATIO, o.full);
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          reset();
          return;
        default:
          if (o.onScrubKey?.(e.key, e.shiftKey)) e.preventDefault();
          return;
      }
      e.preventDefault();
      schedule(next);
    };
    const onDbl = (e: MouseEvent) => {
      if (optsRef.current.disabled) return;
      if ((e.target as Element | null)?.closest('button, input, select, label')) return;
      // 足マーカーの上のダブルクリックはリセットしない（#82）
      if (optsRef.current.markers) {
        const r = el.getBoundingClientRect();
        if (markerAt(ctx(), e.clientX - r.left, e.clientY - r.top)) return;
      }
      e.preventDefault();
      reset();
    };

    // 長押しで OS のメニュー（Android Chrome の長押しメニュー・右クリック）を出さない（損益グラフだけ）
    const onContextMenu = (e: Event) => {
      const o = optsRef.current;
      if ((o.scrub || o.markers || o.surface) && !o.disabled) e.preventDefault();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKey);
    el.addEventListener('dblclick', onDbl);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      clearLong();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('dblclick', onDbl);
    };
  }, [ref]);
}

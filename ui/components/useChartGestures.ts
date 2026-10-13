/**
 * グラフの拡大・パンのジェスチャー（DOM の薄いフック）。損益グラフとスマイルで共用する（#11、M10）。
 *
 * - ホイール: カーソル位置を固定して拡大・縮小（ページはスクロールしない）。横スクロールはパン
 * - ドラッグ / 1 本指: パン。2 本指: ピンチ。ダブルクリック / ダブルタップ: リセット
 * - フォーカス時のキー: + / = 拡大、− 縮小（中心固定）、← / → 幅の 10% パン、R リセット
 * - タップ（動かさずに離す）は onTap に要素の座標で渡す（スマイルの点の選択）
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
  gestureMove,
  gestureUp,
  initialGesture,
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
    let frame = 0;

    const current = (): Domain => pending ?? optsRef.current.viewport;
    const ctx = (): GestureCtx => {
      const o = optsRef.current;
      return { viewport: current(), range: o.range, full: o.full, minWidth: o.minWidth };
    };
    const flush = () => {
      frame = 0;
      const v = pending;
      pending = null;
      if (v) optsRef.current.onViewport(v);
    };
    const schedule = (v: Domain) => {
      pending = v;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const reset = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      optsRef.current.onViewport(null);
    };
    const sample = (e: PointerEvent): PointerSample => {
      const r = el.getBoundingClientRect();
      return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
    };
    const apply = (res: GestureResult) => {
      state = res.state;
      if (res.reset) reset();
      else if (res.viewport) schedule(res.viewport);
      if (res.tap) optsRef.current.onTap?.(res.tap.x, res.tap.y);
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
    };
    const onMove = (e: PointerEvent) => {
      if (state.pointers.length === 0) return;
      apply(gestureMove(state, sample(e), ctx()));
      if (state.mode === 'drag' || state.mode === 'pinch') e.preventDefault();
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
          next = panBy(v, -(v[1] - v[0]) * KEY_PAN_RATIO, o.full);
          break;
        case 'ArrowRight':
          next = panBy(v, (v[1] - v[0]) * KEY_PAN_RATIO, o.full);
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          reset();
          return;
        default:
          return;
      }
      e.preventDefault();
      schedule(next);
    };
    const onDbl = (e: MouseEvent) => {
      if (optsRef.current.disabled) return;
      if ((e.target as Element | null)?.closest('button, input, select, label')) return;
      e.preventDefault();
      reset();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKey);
    el.addEventListener('dblclick', onDbl);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', onDown);
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

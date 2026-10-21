import { describe, expect, it } from 'vitest';
import {
  type GestureCtx,
  type GestureMode,
  type GestureState,
  gestureDown,
  gestureLongPress,
  gestureMove,
  gestureUp,
  grabStarted,
  initialGesture,
  LONG_PRESS_MS,
} from '../../ui/chart/gesture';
import type { Domain } from '../../ui/chart/scale';

/**
 * #223: つかんで動かす間は PC のホバーの十字線を出さない（docs/ui-redesign.md §4.1）。つかみ始めの判定 grabStarted と、
 * 状態機械の遷移（ハンドルの即つかみ・長押し・足マーカーの長押し・面の点）がそれで true になること。パン・ピンチ・
 * 十字線の交点のつかみは false
 */
const full: Domain = [30_000, 90_000];
const range: Domain = [56, 1056];
const V0: Domain = [50_000, 70_000];
const BAND: [number, number] = [256, 270];
const base: GestureCtx = { viewport: V0, range, full, minWidth: 250 };

describe('grabStarted（#223）', () => {
  const modes: GestureMode[] = [
    'idle',
    'pending',
    'drag',
    'pinch',
    'scrub',
    'marker',
    'markerDrag',
    'surface',
    'cross',
  ];
  it('つかむ状態（scrub・markerDrag・surface）に入ったときだけ true', () => {
    for (const prev of modes) {
      for (const next of modes) {
        const want = prev !== next && ['scrub', 'markerDrag', 'surface'].includes(next);
        expect(grabStarted(prev, next), `${prev} → ${next}`).toBe(want);
      }
    }
  });
  it('パン（drag）・ピンチ・十字線の交点（cross）・押しただけ（pending・marker）は false', () => {
    expect(grabStarted('pending', 'drag')).toBe(false);
    expect(grabStarted('drag', 'pinch')).toBe(false);
    expect(grabStarted('idle', 'cross')).toBe(false);
    expect(grabStarted('idle', 'pending')).toBe(false);
    expect(grabStarted('idle', 'marker')).toBe(false);
  });
});

describe('状態機械の遷移とつかみ始め（#223）', () => {
  const step = (s: GestureState, r: { state: GestureState }) => ({
    grab: grabStarted(s.mode, r.state.mode),
    state: r.state,
  });

  it('ハンドルの ±14px の押下はすぐつかむ（down で true）', () => {
    const ctx: GestureCtx = { ...base, scrub: { linePx: 500, grabPx: 14 } };
    const s0 = initialGesture();
    const a = step(s0, gestureDown(s0, { id: 1, x: 510, y: 100, t: 0 }, ctx));
    expect(a.state.mode).toBe('scrub');
    expect(a.grab).toBe(true);
    // 動かしている間は true にならない（同じモードのまま）
    const b = step(a.state, gestureMove(a.state, { id: 1, x: 540, y: 100, t: 50 }, ctx));
    expect(b.state.mode).toBe('scrub');
    expect(b.grab).toBe(false);
  });

  it('離れた所は長押しでつかむ（down では false、長押しで true）', () => {
    const ctx: GestureCtx = { ...base, scrub: { linePx: 500, grabPx: 14 } };
    const s0 = initialGesture();
    const a = step(s0, gestureDown(s0, { id: 1, x: 200, y: 100, t: 0 }, ctx));
    expect(a.state.mode).toBe('pending');
    expect(a.grab).toBe(false);
    const b = step(a.state, gestureLongPress(a.state, LONG_PRESS_MS, ctx));
    expect(b.state.mode).toBe('scrub');
    expect(b.grab).toBe(true);
  });

  it('足マーカーの長押しで markerDrag に入ると true', () => {
    const ctx: GestureCtx = {
      ...base,
      markers: { band: BAND, items: [{ id: 7, px: 300, drag: true }] },
    };
    const s0 = initialGesture();
    const a = step(s0, gestureDown(s0, { id: 1, x: 302, y: 265, t: 0 }, ctx));
    expect(a.state.mode).toBe('marker');
    expect(a.grab).toBe(false);
    const b = step(a.state, gestureLongPress(a.state, LONG_PRESS_MS, ctx));
    expect(b.state.mode).toBe('markerDrag');
    expect(b.grab).toBe(true);
  });

  it('面の点は押すとすぐつかむ（true）', () => {
    const ctx: GestureCtx = { ...base, surface: { pointPx: { x: 400, y: 120 }, grabPx: 14 } };
    const s0 = initialGesture();
    const a = step(s0, gestureDown(s0, { id: 1, x: 600, y: 150, t: 0 }, ctx));
    expect(a.state.mode).toBe('surface');
    expect(a.grab).toBe(true);
  });

  it('6px 以上動かしたパン・離した後は false', () => {
    const ctx: GestureCtx = { ...base, scrub: { linePx: 500, grabPx: 14 } };
    const s0 = initialGesture();
    const a = step(s0, gestureDown(s0, { id: 1, x: 200, y: 100, t: 0 }, ctx));
    const b = step(a.state, gestureMove(a.state, { id: 1, x: 240, y: 100, t: 30 }, ctx));
    expect(b.state.mode).toBe('drag');
    expect(b.grab).toBe(false);
    const c = step(b.state, gestureUp(b.state, { id: 1, x: 240, y: 100, t: 60 }, ctx));
    expect(c.state.mode).toBe('idle');
    expect(c.grab).toBe(false);
  });
});

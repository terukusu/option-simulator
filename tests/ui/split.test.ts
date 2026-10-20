/** #207: 境目（スプリッター）の押下の状態機械（ui/chart/split.ts。DOM なし） */
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_MS, TAP_MAX_MS, TAP_MOVE_PX } from '../../ui/chart/gesture';
import {
  initialSplit,
  type SplitState,
  splitCancel,
  splitDown,
  splitMove,
  splitUp,
} from '../../ui/chart/split';

const press = (s: SplitState, border: number, y: number, t: number, id = 1) =>
  splitDown(s, { id, y, t }, border).state;

describe('境目のドラッグ', () => {
  it('押した位置からの縦の移動量を返し、離すと end（確定）', () => {
    let s = press(initialSplit(), 1, 300, 0);
    const m1 = splitMove(s, { id: 1, y: 290, t: 16 });
    expect(m1.dy).toBe(-10);
    s = m1.state;
    const m2 = splitMove(s, { id: 1, y: 330, t: 32 });
    expect(m2.dy).toBe(30);
    const up = splitUp(m2.state, { id: 1, y: 334, t: 48 });
    expect(up).toMatchObject({ dy: 34, end: true });
    expect(up.state.border).toBeNull();
    expect(up.reset).toBeUndefined();
  });

  it('一度 6px 動いた押下は戻ってきてもタップに数えない（end）', () => {
    let s = press(initialSplit(), 0, 100, 0);
    s = splitMove(s, { id: 1, y: 100 + TAP_MOVE_PX, t: 10 }).state;
    s = splitMove(s, { id: 1, y: 100, t: 20 }).state;
    const up = splitUp(s, { id: 1, y: 100, t: 30 });
    expect(up.end).toBe(true);
    expect(up.state.lastTap).toBeNull();
  });

  it('ほかの指（id 違い）・押している間の 2 本目は無視', () => {
    const s = press(initialSplit(), 1, 100, 0, 1);
    expect(splitMove(s, { id: 2, y: 200, t: 5 }).dy).toBeUndefined();
    expect(splitDown(s, { id: 2, y: 200, t: 5 }, 2).state).toBe(s);
    expect(splitUp(s, { id: 2, y: 200, t: 5 }).state).toBe(s);
  });

  it('cancel は押す前に戻す（cancel）。idle の cancel は何もしない', () => {
    const s = press(initialSplit(), 1, 100, 0);
    expect(splitCancel(s)).toMatchObject({ cancel: true, state: { border: null } });
    expect(splitCancel(initialSplit()).cancel).toBeUndefined();
  });
});

describe('境目のダブルタップ（既定の高さに戻す）', () => {
  it('動かさない短い押下はタップ = cancel（保存しない）で、同じ境目の 2 回目が 300ms 以内なら reset', () => {
    let s = press(initialSplit(), 2, 100, 0);
    const t1 = splitUp(s, { id: 1, y: 102, t: 60 });
    expect(t1.cancel).toBe(true);
    expect(t1.end).toBeUndefined();
    s = press(t1.state, 2, 101, 120);
    const t2 = splitUp(s, { id: 1, y: 101, t: 160 });
    expect(t2.reset).toBe(true);
    expect(t2.state.lastTap).toBeNull();
  });

  it('違う境目・遅い 2 回目・長い押下は reset にしない', () => {
    const tap = (s: SplitState, b: number, t: number, len = 40) =>
      splitUp(press(s, b, 100, t), { id: 1, y: 100, t: t + len });
    const a = tap(initialSplit(), 1, 0);
    expect(tap(a.state, 2, 100).reset).toBeUndefined();
    const b = tap(initialSplit(), 1, 0);
    expect(tap(b.state, 1, 40 + DOUBLE_TAP_MS + 1).reset).toBeUndefined();
    const c = tap(initialSplit(), 1, 0, TAP_MAX_MS);
    expect(c.end).toBe(true);
    expect(tap(c.state, 1, TAP_MAX_MS + 50).reset).toBeUndefined();
  });
});

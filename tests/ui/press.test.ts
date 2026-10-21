import { describe, expect, it } from 'vitest';
import { LONG_PRESS_MS, TAP_MOVE_PX } from '../../ui/chart/gesture';
import {
  initialPress,
  pressCancel,
  pressDown,
  pressLong,
  pressMove,
  pressUp,
} from '../../ui/chart/press';

/** #217: パンの無いチャート（追証マップ）の長押しの十字線の状態機械 */
const p = (x: number, y: number, t: number, id = 1) => ({ id, x, y, t });

describe('長押しの十字線（press.ts。#217）', () => {
  it('6px 未満のまま LONG_PRESS_MS で cross になり押した位置を返す。move で位置と block、離して swallowClick', () => {
    let s = pressDown(initialPress(), p(50, 60, 0)).state;
    expect(s.mode).toBe('pending');
    // 時間が足りない発火は何もしない
    expect(pressLong(s, LONG_PRESS_MS - 1, { x: 50, y: 60 }).state.mode).toBe('pending');
    s = pressMove(s, p(53, 62, 100)).state;
    const r = pressLong(s, LONG_PRESS_MS, { x: 53, y: 62 });
    expect(r.state.mode).toBe('cross');
    expect(r.cross).toEqual({ x: 53, y: 62 });
    const m = pressMove(r.state, p(120, 90, 600));
    expect(m.cross).toEqual({ x: 120, y: 90 });
    expect(m.block).toBe(true);
    const u = pressUp(m.state, p(120, 90, 700));
    expect(u.state.mode).toBe('idle');
    expect(u.swallowClick).toBe(true);
  });

  it('長押しの前に 6px 動けば scroll（ページに譲る）。以後の長押し・move は何もしない、離しても swallowClick なし', () => {
    let s = pressDown(initialPress(), p(50, 60, 0)).state;
    const m = pressMove(s, p(50, 60 + TAP_MOVE_PX, 80));
    expect(m.state.mode).toBe('scroll');
    expect(m.block).toBeUndefined();
    s = m.state;
    expect(pressLong(s, LONG_PRESS_MS, { x: 50, y: 66 }).cross).toBeUndefined();
    expect(pressMove(s, p(50, 200, 500)).cross).toBeUndefined();
    const u = pressUp(s, p(50, 200, 600));
    expect(u.state.mode).toBe('idle');
    expect(u.swallowClick).toBeUndefined();
  });

  it('発火の時点で指が 6px 以上離れていれば cross にしない', () => {
    const s = pressDown(initialPress(), p(50, 60, 0)).state;
    expect(pressLong(s, LONG_PRESS_MS, { x: 57, y: 60 }).state.mode).toBe('pending');
  });

  it('短い押下（タップ）は idle に戻るだけ（click の選択は部品のまま）', () => {
    const s = pressDown(initialPress(), p(50, 60, 0)).state;
    const u = pressUp(s, p(51, 60, 120));
    expect(u.state.mode).toBe('idle');
    expect(u.swallowClick).toBeUndefined();
    expect(u.cross).toBeUndefined();
  });

  it('2 本目の指・別の id は無視、cancel で idle', () => {
    const s = pressDown(initialPress(), p(50, 60, 0)).state;
    expect(pressDown(s, p(90, 90, 10, 2)).state).toBe(s);
    expect(pressMove(s, p(200, 200, 20, 2)).state).toBe(s);
    expect(pressUp(s, p(200, 200, 20, 2)).state).toBe(s);
    const c = pressLong(s, LONG_PRESS_MS, { x: 50, y: 60 }).state;
    expect(pressCancel(c, p(50, 60, 900)).state.mode).toBe('idle');
  });
});

import { describe, expect, it } from 'vitest';
import { TAP_MAX_MS, TAP_MOVE_PX } from '../../ui/chart/gesture';
import { initialPress, pressCancel, pressDown, pressMove, pressUp } from '../../ui/chart/press';

/** #217: パンの無いチャート（追証マップ）のタッチの十字線の状態機械（タップで置く / 消す・交点をつかむ） */
const p = (x: number, y: number, t: number, id = 1) => ({ id, x, y, t });
const GRAB = 14;

describe('タッチの十字線（press.ts。#217）', () => {
  it('動かさない短い押下は tap（置く / 消すは部品）。交点が無ければ pending から', () => {
    const d = pressDown(initialPress(), p(50, 60, 0), null, GRAB);
    expect(d.state.mode).toBe('pending');
    expect(d.block).toBeUndefined();
    const u = pressUp(d.state, p(52, 61, 120));
    expect(u.tap).toEqual({ x: 52, y: 61 });
    expect(u.state.mode).toBe('idle');
    // 長い押下はタップにしない（長押しは何もしない）
    const slow = pressUp(d.state, p(50, 60, TAP_MAX_MS));
    expect(slow.tap).toBeUndefined();
  });

  it('交点の ±14px の押下はすぐ cross（ずれを保って move の位置・block）。動かして離すと tap なし', () => {
    const d = pressDown(initialPress(), p(108, 95, 0), { x: 100, y: 100 }, GRAB);
    expect(d.state.mode).toBe('cross');
    expect(d.block).toBe(true);
    const m = pressMove(d.state, p(160, 140, 50));
    expect(m.cross).toEqual({ x: 152, y: 145 });
    expect(m.block).toBe(true);
    // 戻ってきてもタップにしない
    const back = pressMove(m.state, p(108, 95, 90));
    expect(pressUp(back.state, p(108, 95, 120)).tap).toBeUndefined();
    // 14px を超えたら pending
    expect(pressDown(initialPress(), p(111, 111, 0), { x: 100, y: 100 }, GRAB).state.mode).toBe(
      'pending',
    );
  });

  it('交点の上の動かさない短い押下は tap（消す）', () => {
    const d = pressDown(initialPress(), p(102, 101, 0), { x: 100, y: 100 }, GRAB);
    const u = pressUp(d.state, p(102, 101, 80));
    expect(u.tap).toEqual({ x: 102, y: 101 });
  });

  it('pending で 6px 動けば scroll（ページに譲る）: 位置・block・tap を出さない', () => {
    const d = pressDown(initialPress(), p(50, 60, 0), null, GRAB);
    const m = pressMove(d.state, p(50, 60 + TAP_MOVE_PX, 40));
    expect(m.state.mode).toBe('scroll');
    expect(m.cross).toBeUndefined();
    expect(m.block).toBeUndefined();
    expect(pressMove(m.state, p(50, 200, 80)).cross).toBeUndefined();
    expect(pressUp(m.state, p(50, 60, 100)).tap).toBeUndefined();
  });

  it('2 本目の指・別の id は無視、cancel で idle', () => {
    const s = pressDown(initialPress(), p(50, 60, 0), null, GRAB).state;
    expect(pressDown(s, p(90, 90, 10, 2), null, GRAB).state).toBe(s);
    expect(pressMove(s, p(200, 200, 20, 2)).state).toBe(s);
    expect(pressUp(s, p(200, 200, 20, 2)).state).toBe(s);
    expect(pressCancel(s, p(50, 60, 30)).state.mode).toBe('idle');
  });
});

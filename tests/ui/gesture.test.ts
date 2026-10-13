import { describe, expect, it } from 'vitest';
import {
  type GestureCtx,
  type GestureResult,
  type GestureState,
  gestureCancel,
  gestureDown,
  gestureMove,
  gestureUp,
  initialGesture,
} from '../../ui/chart/gesture';
import { type Domain, linear, pixelToValue } from '../../ui/chart/scale';

/** #11 AC-4・AC-10・AC-12: ジェスチャーの状態機械（DOM なし）。 */
const full: Domain = [30_000, 90_000];
const range: Domain = [50, 1050];
const ctxOf = (viewport: Domain): GestureCtx => ({ viewport, range, full, minWidth: 250 });

/** 操作の列を流し、最後の表示範囲・タップ・リセットを集める。 */
function play(
  steps: Array<['down' | 'move' | 'up' | 'cancel', number, number, number, number?]>,
  viewport0: Domain = [50_000, 70_000],
) {
  let state: GestureState = initialGesture();
  let viewport = viewport0;
  const taps: Array<{ x: number; y: number }> = [];
  let resets = 0;
  const fns = { down: gestureDown, move: gestureMove, up: gestureUp, cancel: gestureCancel };
  for (const [kind, id, x, t, y] of steps) {
    const r: GestureResult = fns[kind](state, { id, x, y: y ?? 100, t }, ctxOf(viewport));
    state = r.state;
    if (r.viewport) viewport = r.viewport;
    if (r.tap) taps.push(r.tap);
    if (r.reset) resets++;
  }
  return { state, viewport, taps, resets };
}

describe('ジェスチャー（共用の状態機械）', () => {
  it('1 本: 6px 以上動かすとドラッグ = パン（指の下の値が付いてくる）。タップは出さない', () => {
    const v0: Domain = [50_000, 70_000];
    const grabbed = pixelToValue(v0, range, 500);
    const r = play(
      [
        ['down', 1, 500, 0],
        ['move', 1, 503, 10],
        ['move', 1, 600, 20],
        ['up', 1, 600, 30],
      ],
      v0,
    );
    expect(Math.abs(linear(r.viewport, range)(grabbed) - 600)).toBeLessThan(1e-6);
    expect(r.viewport[1] - r.viewport[0]).toBeCloseTo(20_000, 9);
    expect(r.taps).toEqual([]);
    expect(r.state.mode).toBe('idle');
  });

  it('1 本: 動かずに離すとタップ（6px 未満・500ms 未満）。遅い・動いた押下はタップでない', () => {
    expect(
      play([
        ['down', 1, 500, 0],
        ['move', 1, 504, 50],
        ['up', 1, 504, 100],
      ]).taps,
    ).toEqual([{ x: 504, y: 100 }]);
    expect(
      play([
        ['down', 1, 500, 0],
        ['up', 1, 500, 600],
      ]).taps,
    ).toEqual([]);
    const dragged = play([
      ['down', 1, 500, 0],
      ['move', 1, 520, 50],
      ['move', 1, 500, 80],
      ['up', 1, 500, 100],
    ]);
    expect(dragged.taps).toEqual([]);
  });

  it('ダブルタップ（300ms・20px 以内）でリセット。2 回目はタップを出さない', () => {
    const r = play([
      ['down', 1, 500, 0],
      ['up', 1, 500, 50],
      ['down', 2, 510, 200],
      ['up', 2, 510, 250],
    ]);
    expect(r.taps).toEqual([{ x: 500, y: 100 }]);
    expect(r.resets).toBe(1);
    // 間が空けば 2 回のタップ
    const slow = play([
      ['down', 1, 500, 0],
      ['up', 1, 500, 50],
      ['down', 2, 500, 500],
      ['up', 2, 500, 550],
    ]);
    expect(slow.taps).toHaveLength(2);
    expect(slow.resets).toBe(0);
    // 離れていれば 2 回のタップ
    const far = play([
      ['down', 1, 500, 0],
      ['up', 1, 500, 50],
      ['down', 2, 560, 150],
      ['up', 2, 560, 200],
    ]);
    expect(far.taps).toHaveLength(2);
    expect(far.resets).toBe(0);
  });

  it('2 本: ピンチで 2 本の指の下の値が保たれる。タップは出さない', () => {
    const v0: Domain = [50_000, 70_000];
    const va = pixelToValue(v0, range, 400);
    const vb = pixelToValue(v0, range, 600);
    const r = play(
      [
        ['down', 1, 400, 0],
        ['down', 2, 600, 5],
        ['move', 1, 350, 20],
        ['move', 2, 680, 25],
      ],
      v0,
    );
    const sx = linear(r.viewport, range);
    expect(Math.abs(sx(va) - 350)).toBeLessThan(1e-6);
    expect(Math.abs(sx(vb) - 680)).toBeLessThan(1e-6);
    expect(r.state.mode).toBe('pinch');
    const after = play([
      ['down', 1, 400, 0],
      ['down', 2, 600, 5],
      ['up', 2, 600, 30],
      ['up', 1, 400, 40],
    ]);
    expect(after.taps).toEqual([]);
  });

  it('2 本 → 1 本: 残った指の位置と現在の範囲で取り直す（飛ばない）', () => {
    const v0: Domain = [50_000, 70_000];
    let state = initialGesture();
    let viewport = v0;
    const step = (r: GestureResult) => {
      state = r.state;
      if (r.viewport) viewport = r.viewport;
      return r;
    };
    step(gestureDown(state, { id: 1, x: 400, y: 0, t: 0 }, ctxOf(viewport)));
    step(gestureDown(state, { id: 2, x: 600, y: 0, t: 1 }, ctxOf(viewport)));
    step(gestureMove(state, { id: 2, x: 700, y: 0, t: 2 }, ctxOf(viewport)));
    const afterPinch = viewport;
    const r = step(gestureUp(state, { id: 2, x: 700, y: 0, t: 3 }, ctxOf(viewport)));
    expect(r.viewport).toBeUndefined();
    expect(state.mode).toBe('drag');
    // 指 1 がまだ 400 にいる → 動かさなければ範囲は変わらない
    const still = gestureMove(state, { id: 1, x: 400, y: 0, t: 4 }, ctxOf(viewport));
    expect(still.viewport ?? afterPinch).toEqual(afterPinch);
    // 動かすと、指 1 の下の値が付いてくる
    const grabbed = pixelToValue(afterPinch, range, 400);
    step(gestureMove(state, { id: 1, x: 450, y: 0, t: 5 }, ctxOf(viewport)));
    expect(Math.abs(linear(viewport, range)(grabbed) - 450)).toBeLessThan(1e-6);
  });

  it('cancel で状態を捨てる。3 本目の指は無視', () => {
    const r = play([
      ['down', 1, 400, 0],
      ['down', 2, 600, 1],
      ['down', 3, 800, 2],
      ['cancel', 1, 400, 3],
    ]);
    expect(r.state.mode).toBe('idle');
    expect(r.state.pointers).toEqual([]);
    const three = play([
      ['down', 1, 400, 0],
      ['down', 2, 600, 1],
      ['down', 3, 800, 2],
    ]);
    expect(three.state.pointers.map((p) => p.id)).toEqual([1, 2]);
  });
});

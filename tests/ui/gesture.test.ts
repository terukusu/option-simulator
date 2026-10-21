import { describe, expect, it } from 'vitest';
import {
  crossHoldChange,
  type GestureCtx,
  type GestureResult,
  type GestureState,
  GRAB_PX,
  gestureCancel,
  gestureDown,
  gestureLongPress,
  gestureMove,
  gestureUp,
  initialGesture,
  LONG_PRESS_MS,
  TAP_MOVE_PX,
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

/** #52 AC-1〜AC-3: 長押し・縦線をつかむ（scrub）。損益グラフだけ ctx.scrub を渡す。 */
describe('ジェスチャー: 長押しでシナリオ点をつかむ（#52）', () => {
  type Step =
    | ['down' | 'move' | 'up' | 'cancel', number, number, number, number?]
    | ['long', number];
  /** scrub の文脈で操作の列を流す（'long' はタイマーの発火 = gestureLongPress）。 */
  function scrubPlay(
    steps: Step[],
    linePx: number | null = null,
    viewport0: Domain = [50_000, 70_000],
    scrub = true,
  ) {
    let state: GestureState = initialGesture();
    let viewport = viewport0;
    const scrubs: number[] = [];
    const taps: Array<{ x: number; y: number }> = [];
    let resets = 0;
    let viewportChanged = false;
    const fns = { down: gestureDown, move: gestureMove, up: gestureUp, cancel: gestureCancel };
    for (const step of steps) {
      const ctx: GestureCtx = { ...ctxOf(viewport), ...(scrub ? { scrub: { linePx } } : {}) };
      let r: GestureResult;
      if (step[0] === 'long') r = gestureLongPress(state, step[1], ctx);
      else {
        const [kind, id, x, t, y] = step;
        r = fns[kind](state, { id, x, y: y ?? 100, t }, ctx);
      }
      state = r.state;
      if (r.viewport) {
        viewport = r.viewport;
        viewportChanged = true;
      }
      if (r.scrub) scrubs.push(r.scrub.x);
      if (r.tap) taps.push(r.tap);
      if (r.reset) resets++;
    }
    return { state, viewport, scrubs, taps, resets, viewportChanged };
  }

  it('長押し: 6px 未満のまま 450ms でつかみ、押した位置 → move の位置を返す。パンせず、離してもタップ・リセットなし', () => {
    const r = scrubPlay([
      ['down', 1, 500, 0],
      ['move', 1, 503, 100],
      ['long', LONG_PRESS_MS],
      ['move', 1, 560, 500],
      ['move', 1, 420, 520],
      ['up', 1, 420, 600],
    ]);
    expect(r.scrubs).toEqual([503, 560, 420]);
    expect(r.viewportChanged).toBe(false);
    expect(r.taps).toEqual([]);
    expect(r.resets).toBe(0);
    expect(r.state.mode).toBe('idle');
    expect(r.state.lastTap).toBeNull();
  });

  it('長押し: 450ms 前の発火・離した後の発火ではつかまない', () => {
    const early = scrubPlay([
      ['down', 1, 500, 0],
      ['long', LONG_PRESS_MS - 1],
    ]);
    expect(early.state.mode).toBe('pending');
    expect(early.scrubs).toEqual([]);
    const after = scrubPlay([
      ['down', 1, 500, 0],
      ['up', 1, 500, 100],
      ['long', LONG_PRESS_MS],
    ]);
    expect(after.state.mode).toBe('idle');
    expect(after.scrubs).toEqual([]);
  });

  it('長押しの前に 6px 以上動かすと従来どおりパン（発火してもつかまない）', () => {
    const r = scrubPlay([
      ['down', 1, 500, 0],
      ['move', 1, 500 + TAP_MOVE_PX, 100],
      ['long', LONG_PRESS_MS],
      ['move', 1, 600, 500],
    ]);
    expect(r.state.mode).toBe('drag');
    expect(r.scrubs).toEqual([]);
    expect(r.viewportChanged).toBe(true);
  });

  it('長押しを有効にした文脈でも 2 本指はピンチ、ダブルタップはリセット', () => {
    const pinch = scrubPlay([
      ['down', 1, 400, 0],
      ['down', 2, 600, 5],
      ['long', LONG_PRESS_MS],
      ['move', 2, 700, 500],
    ]);
    expect(pinch.state.mode).toBe('pinch');
    expect(pinch.scrubs).toEqual([]);
    expect(pinch.viewportChanged).toBe(true);
    const dbl = scrubPlay([
      ['down', 1, 500, 0],
      ['up', 1, 500, 50],
      ['down', 2, 505, 200],
      ['up', 2, 505, 250],
    ]);
    expect(dbl.resets).toBe(1);
  });

  it('つかんでいる間の 2 本目の指は無視（ピンチにならない）', () => {
    const r = scrubPlay([
      ['down', 1, 500, 0],
      ['long', LONG_PRESS_MS],
      ['down', 2, 700, 500],
      ['move', 2, 800, 510],
      ['move', 1, 520, 520],
      ['up', 2, 800, 530],
    ]);
    expect(r.state.mode).toBe('scrub');
    expect(r.state.pointers.map((p) => p.id)).toEqual([1]);
    expect(r.scrubs).toEqual([500, 520]);
    expect(r.viewportChanged).toBe(false);
  });

  it('cancel でつかむ状態を捨てる（ΔX は戻さない = 何も返さない）', () => {
    const r = scrubPlay([
      ['down', 1, 500, 0],
      ['long', LONG_PRESS_MS],
      ['cancel', 1, 500, 600],
    ]);
    expect(r.state.mode).toBe('idle');
    expect(r.scrubs).toEqual([500]);
  });

  it('長押しを有効にしない文脈（スマイル）では 450ms 経っても従来と同じ', () => {
    const r = scrubPlay(
      [
        ['down', 1, 500, 0],
        ['long', LONG_PRESS_MS + 100],
        ['up', 1, 500, 520],
      ],
      null,
      [50_000, 70_000],
      false,
    );
    expect(r.scrubs).toEqual([]);
    expect(r.state.mode).toBe('idle');
    // 従来: 500ms 以上の押下はタップでない
    expect(r.taps).toEqual([]);
    const tap = scrubPlay(
      [
        ['down', 1, 500, 0],
        ['long', LONG_PRESS_MS],
        ['up', 1, 500, LONG_PRESS_MS + 10],
      ],
      null,
      [50_000, 70_000],
      false,
    );
    expect(tap.taps).toEqual([{ x: 500, y: 100 }]);
  });

  it(`縦線から ${GRAB_PX}px 以内を押すと待たずにつかむ（線は飛ばずにずれを保つ）。超えると従来の押下`, () => {
    const near = scrubPlay(
      [
        ['down', 1, 500 + GRAB_PX, 0],
        ['move', 1, 600 + GRAB_PX, 10],
      ],
      500,
    );
    expect(near.state.mode).toBe('scrub');
    expect(near.scrubs).toEqual([600]);
    expect(near.viewportChanged).toBe(false);
    const left = scrubPlay([['down', 1, 500 - GRAB_PX, 0]], 500);
    expect(left.state.mode).toBe('scrub');
    const far = scrubPlay([['down', 1, 500 + GRAB_PX + 0.5, 0]], 500);
    expect(far.state.mode).toBe('pending');
    // 縦線が無い（ΔX = 0・範囲外）なら押下は pending
    expect(scrubPlay([['down', 1, 500, 0]], null).state.mode).toBe('pending');
  });
});

/**
 * #207: 先物推移の指標の段も同じ状態機械（ctx.scrub = { linePx: null }）。長押し 450ms → 十字線（scrub）、長押しの前に
 * 6px 以上動いたらパン（その後の長押しのタイマーは何もしない）、ダブルタップ = reset（段では useChartGestures が
 * onDouble = 最大化に渡す）。損益グラフ・価格の描画域と同じ決まり
 */
describe('#207 指標の段（scrub の縦線なし）', () => {
  const v0: Domain = [50_000, 70_000];
  const pane: GestureCtx = { viewport: v0, range, full, minWidth: 250, scrub: { linePx: null } };
  it('6px 未満のまま 450ms で scrub（押した位置）、move で位置、表示範囲は変えない', () => {
    let s = gestureDown(initialGesture(), { id: 1, x: 400, y: 30, t: 0 }, pane).state;
    s = gestureMove(s, { id: 1, x: 403, y: 31, t: 100 }, pane).state;
    const lp = gestureLongPress(s, LONG_PRESS_MS, pane);
    expect(lp.state.mode).toBe('scrub');
    expect(lp.scrub).toEqual({ x: 403 });
    const mv = gestureMove(lp.state, { id: 1, x: 500, y: 60, t: 600 }, pane);
    expect(mv.scrub).toEqual({ x: 500 });
    expect(mv.viewport).toBeUndefined();
    const up = gestureUp(mv.state, { id: 1, x: 500, y: 60, t: 700 }, pane);
    expect(up.tap).toBeUndefined();
    expect(up.reset).toBeUndefined();
  });
  it('長押しの前に 6px 動いたらパン（drag）。その後の長押しは何もしない', () => {
    let s = gestureDown(initialGesture(), { id: 1, x: 400, y: 30, t: 0 }, pane).state;
    const mv = gestureMove(s, { id: 1, x: 400 + TAP_MOVE_PX, y: 30, t: 100 }, pane);
    expect(mv.state.mode).toBe('drag');
    expect(mv.viewport).toBeDefined();
    s = mv.state;
    const lp = gestureLongPress(s, LONG_PRESS_MS, pane);
    expect(lp.state.mode).toBe('drag');
    expect(lp.scrub).toBeUndefined();
  });
  it('ダブルタップは reset（1 回目は tap = 十字線を外す）', () => {
    let s = gestureDown(initialGesture(), { id: 1, x: 400, y: 30, t: 0 }, pane).state;
    const t1 = gestureUp(s, { id: 1, x: 400, y: 30, t: 50 }, pane);
    expect(t1.tap).toEqual({ x: 400, y: 30 });
    s = gestureDown(t1.state, { id: 1, x: 402, y: 32, t: 150 }, pane).state;
    const t2 = gestureUp(s, { id: 1, x: 402, y: 32, t: 200 }, pane);
    expect(t2.reset).toBe(true);
  });
  it('2 本目の指はピンチ（scrub の前）', () => {
    const s = gestureDown(initialGesture(), { id: 1, x: 300, y: 30, t: 0 }, pane).state;
    const p2 = gestureDown(s, { id: 2, x: 600, y: 30, t: 50 }, pane);
    expect(p2.state.mode).toBe('pinch');
    expect(gestureLongPress(p2.state, LONG_PRESS_MS, pane).scrub).toBeUndefined();
  });
});

// ---- #227: 十字線の交点をつかんでいる間（crossHoldChange）。つかむ間だけ読み取りを指から離れた所に出す
describe('#227 AC4: 十字線の交点をつかむ / 離す（crossHoldChange）', () => {
  const cross = { pointPx: { x: 500, y: 100 }, grabPx: 14 };
  const ctx: GestureCtx = { ...ctxOf([50_000, 70_000]), cross };
  /** 操作の列を流し、モードが変わるたびの crossHoldChange を集める */
  const holds = (steps: Array<(s: GestureState) => GestureResult>) => {
    let s = initialGesture();
    const out: boolean[] = [];
    for (const f of steps) {
      const prev = s.mode;
      s = f(s).state;
      const h = crossHoldChange(prev, s.mode);
      if (h !== null) out.push(h);
    }
    return { out, mode: s.mode };
  };
  it('交点の ±14px の押下で true、動かして離すと false', () => {
    const r = holds([
      (s) => gestureDown(s, { id: 1, x: 505, y: 104, t: 0 }, ctx),
      (s) => gestureMove(s, { id: 1, x: 540, y: 110, t: 50 }, ctx),
      (s) => gestureUp(s, { id: 1, x: 540, y: 110, t: 100 }, ctx),
    ]);
    expect(r.out).toEqual([true, false]);
    expect(r.mode).toBe('idle');
  });
  it('交点の上の短いタップも離せば false（タップは十字線を消す）', () => {
    const r = holds([
      (s) => gestureDown(s, { id: 1, x: 500, y: 100, t: 0 }, ctx),
      (s) => gestureUp(s, { id: 1, x: 500, y: 100, t: 60 }, ctx),
    ]);
    expect(r.out).toEqual([true, false]);
  });
  it('つかんでいる間の 2 本目の指（ピンチ）・cancel で false', () => {
    const pinch = holds([
      (s) => gestureDown(s, { id: 1, x: 500, y: 100, t: 0 }, ctx),
      (s) => gestureDown(s, { id: 2, x: 800, y: 100, t: 20 }, ctx),
    ]);
    expect(pinch.out).toEqual([true, false]);
    expect(pinch.mode).toBe('pinch');
    const cancel = holds([
      (s) => gestureDown(s, { id: 1, x: 500, y: 100, t: 0 }, ctx),
      (s) => gestureCancel(s, { id: 1, x: 500, y: 100, t: 20 }, ctx),
    ]);
    expect(cancel.out).toEqual([true, false]);
  });
  it('交点から離れた押下（パン・タップ）では出ない', () => {
    const r = holds([
      (s) => gestureDown(s, { id: 1, x: 300, y: 100, t: 0 }, ctx),
      (s) => gestureMove(s, { id: 1, x: 340, y: 100, t: 50 }, ctx),
      (s) => gestureUp(s, { id: 1, x: 340, y: 100, t: 100 }, ctx),
      (s) => gestureDown(s, { id: 1, x: 300, y: 100, t: 1000 }, ctx),
      (s) => gestureUp(s, { id: 1, x: 300, y: 100, t: 1040 }, ctx),
    ]);
    expect(r.out).toEqual([]);
  });
  it('モードが変わらない・cross と関係ない変化は null', () => {
    expect(crossHoldChange('cross', 'cross')).toBeNull();
    expect(crossHoldChange('idle', 'drag')).toBeNull();
    expect(crossHoldChange('pinch', 'drag')).toBeNull();
    expect(crossHoldChange('idle', 'cross')).toBe(true);
    expect(crossHoldChange('cross', 'idle')).toBe(false);
  });
});

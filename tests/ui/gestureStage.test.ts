import { describe, expect, it } from 'vitest';
import {
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
  MARKER_HIT_PX,
  markerAt,
  TAP_MOVE_PX,
} from '../../ui/chart/gesture';
import type { Domain } from '../../ui/chart/scale';

/**
 * #82 AC-5: 新しい画面の舞台のジェスチャー（つかむ幅・足マーカー）。既存の tests/ui/gesture.test.ts は変えない
 * （旧画面・スマイルは新しい欄を渡さない = 今のまま）。
 */
const full: Domain = [30_000, 90_000];
const range: Domain = [56, 1056];
const V0: Domain = [50_000, 70_000];
const AXIS_Y = 270;
const BAND: [number, number] = [AXIS_Y - 14, AXIS_Y];

type Step = ['down' | 'move' | 'up' | 'cancel', number, number, number, number?] | ['long', number];

interface Played {
  state: GestureState;
  viewport: Domain;
  results: GestureResult[];
}

function play(steps: Step[], extra: Partial<GestureCtx> = {}, viewport0: Domain = V0): Played {
  let state: GestureState = initialGesture();
  let viewport = viewport0;
  const results: GestureResult[] = [];
  const fns = { down: gestureDown, move: gestureMove, up: gestureUp, cancel: gestureCancel };
  for (const step of steps) {
    const ctx: GestureCtx = { viewport, range, full, minWidth: 250, ...extra };
    const r =
      step[0] === 'long'
        ? gestureLongPress(state, step[1], ctx)
        : fns[step[0]](state, { id: step[1], x: step[2], y: step[4] ?? 100, t: step[3] }, ctx);
    state = r.state;
    if (r.viewport) viewport = r.viewport;
    results.push(r);
  }
  return { state, viewport, results };
}

const collect = <K extends keyof GestureResult>(p: Played, k: K) =>
  p.results.map((r) => r[k]).filter((v) => v !== undefined);

const markers = (drag = true): NonNullable<GestureCtx['markers']> => ({
  band: BAND,
  items: [
    { id: 1, px: 300, drag },
    { id: 2, px: 600, drag: false },
  ],
});

describe('つかむ幅（AC-5 a）', () => {
  it('grabPx 14: 縦線の ±14px で即つかむ、15px は pending', () => {
    const scrub = { linePx: 500, grabPx: 14 };
    expect(play([['down', 1, 514, 0]], { scrub }).state.mode).toBe('scrub');
    expect(play([['down', 1, 486, 0]], { scrub }).state.mode).toBe('scrub');
    expect(play([['down', 1, 515, 0]], { scrub }).state.mode).toBe('pending');
    // 押した位置と線のずれを保つ
    const p = play(
      [
        ['down', 1, 510, 0],
        ['move', 1, 530, 20],
      ],
      { scrub },
    );
    expect(collect(p, 'scrub')).toEqual([{ x: 520 }]);
  });

  it('省略時は ±12px（今のまま）', () => {
    expect(GRAB_PX).toBe(12);
    const scrub = { linePx: 500 };
    expect(play([['down', 1, 512, 0]], { scrub }).state.mode).toBe('scrub');
    expect(play([['down', 1, 513, 0]], { scrub }).state.mode).toBe('pending');
  });
});

describe('足マーカー（AC-5 b）', () => {
  it('markerAt: 帯の中で ±8px の最も近いもの、帯の外・遠いと null', () => {
    const ctx: GestureCtx = { viewport: V0, range, full, minWidth: 250, markers: markers() };
    expect(MARKER_HIT_PX).toBe(8);
    expect(markerAt(ctx, 305, AXIS_Y - 5)).toEqual({ id: 1, drag: true });
    expect(markerAt(ctx, 292, AXIS_Y)).toEqual({ id: 1, drag: true });
    expect(markerAt(ctx, 291, AXIS_Y - 5)).toBeNull();
    expect(markerAt(ctx, 300, AXIS_Y - 15)).toBeNull();
    expect(markerAt(ctx, 600, AXIS_Y - 1)).toEqual({ id: 2, drag: false });
    const { markers: _m, ...bare } = ctx;
    expect(markerAt(bare, 300, AXIS_Y - 5)).toBeNull();
  });

  it('マーカーの上のタップ → markerTap（ダブルタップの 1 回目に数えない）', () => {
    const p = play(
      [
        ['down', 1, 301, 0, AXIS_Y - 4],
        ['up', 1, 302, 80, AXIS_Y - 4],
        ['down', 1, 301, 200, AXIS_Y - 4],
        ['up', 1, 301, 260, AXIS_Y - 4],
      ],
      { markers: markers() },
    );
    expect(collect(p, 'markerTap')).toEqual([{ id: 1 }, { id: 1 }]);
    expect(collect(p, 'reset')).toEqual([]);
    expect(collect(p, 'tap')).toEqual([]);
    expect(p.state.lastTap).toBeNull();
    expect(p.state.mode).toBe('idle');
  });

  it('マーカーのタップの直後の描画域のタップもダブルタップにならない', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['up', 1, 300, 50, AXIS_Y - 4],
        ['down', 1, 305, 150, AXIS_Y - 30],
        ['up', 1, 305, 200, AXIS_Y - 30],
      ],
      { markers: markers() },
    );
    expect(collect(p, 'reset')).toEqual([]);
    expect(collect(p, 'tap')).toEqual([{ x: 305, y: AXIS_Y - 30 }]);
  });

  it('長押し 450ms → マーカーのドラッグ: move で markerDrag、up で markerDrop。表示範囲は変えない', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['move', 1, 320, 500, AXIS_Y - 40],
        ['move', 1, 340, 520, AXIS_Y - 40],
        ['up', 1, 345, 540, AXIS_Y - 40],
      ],
      { markers: markers() },
    );
    expect(p.results[1]?.markerDrag).toEqual({ id: 1, x: 300 });
    expect(p.results[1]?.state.mode).toBe('markerDrag');
    expect(collect(p, 'markerDrag')).toEqual([
      { id: 1, x: 300 },
      { id: 1, x: 320 },
      { id: 1, x: 340 },
    ]);
    expect(collect(p, 'markerDrop')).toEqual([{ id: 1, x: 345 }]);
    expect(collect(p, 'viewport')).toEqual([]);
    expect(p.viewport).toEqual(V0);
    expect(p.state).toEqual(initialGesture());
  });

  it('450ms 未満・6px 動いた後・drag: false のマーカーの長押しはドラッグにしない', () => {
    expect(
      play(
        [
          ['down', 1, 300, 0, AXIS_Y - 4],
          ['long', LONG_PRESS_MS - 1],
        ],
        { markers: markers() },
      ).state.mode,
    ).toBe('marker');
    expect(
      play(
        [
          ['down', 1, 600, 0, AXIS_Y - 4],
          ['long', LONG_PRESS_MS],
        ],
        { markers: markers() },
      ).state.mode,
    ).toBe('marker');
    const fixed = play(
      [
        ['down', 1, 600, 0, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['up', 1, 600, 470, AXIS_Y - 4],
      ],
      { markers: markers() },
    );
    expect(collect(fixed, 'markerDrop')).toEqual([]);
    expect(collect(fixed, 'markerDrag')).toEqual([]);
  });

  it('長押し前に 6px 動く → パン（今のまま）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['move', 1, 300 + TAP_MOVE_PX, 30, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['move', 1, 400, 600, AXIS_Y - 4],
        ['up', 1, 400, 620, AXIS_Y - 4],
      ],
      { markers: markers() },
    );
    expect(p.results[1]?.state.mode).toBe('drag');
    expect(p.results[1]?.state.marker).toBeNull();
    expect(collect(p, 'markerDrag')).toEqual([]);
    expect(collect(p, 'markerTap')).toEqual([]);
    expect(p.viewport[0]).toBeLessThan(V0[0]);
  });

  it('ドラッグ中の 2 本目の指 → 取り消し（drop を出さない）してピンチへ', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['move', 1, 320, 500, AXIS_Y - 4],
        ['down', 2, 700, 520],
        ['move', 2, 760, 540],
        ['up', 1, 330, 560],
        ['up', 2, 760, 580],
      ],
      { markers: markers() },
    );
    expect(collect(p, 'markerCancel')).toEqual([{ id: 1 }]);
    expect(collect(p, 'markerDrop')).toEqual([]);
    expect(p.results[3]?.state.mode).toBe('pinch');
    expect(collect(p, 'viewport').length).toBeGreaterThan(0);
  });

  it('cancel でも取り消し', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['cancel', 1, 300, 500, AXIS_Y - 4],
      ],
      { markers: markers() },
    );
    expect(collect(p, 'markerCancel')).toEqual([{ id: 1 }]);
    expect(collect(p, 'markerDrop')).toEqual([]);
  });

  it('マーカーとハンドルが重なる: 帯の中はマーカー、帯の外はハンドル', () => {
    const extra = { markers: markers(), scrub: { linePx: 304, grabPx: 14 } };
    expect(play([['down', 1, 302, 0, AXIS_Y - 4]], extra).state.mode).toBe('marker');
    expect(play([['down', 1, 302, 0, AXIS_Y - 40]], extra).state.mode).toBe('scrub');
    // 帯の中でもマーカーから外れていればハンドル
    expect(play([['down', 1, 316, 0, AXIS_Y - 4]], extra).state.mode).toBe('scrub');
  });

  it('マーカーの上で押してから 2 本目 → ピンチ（マーカーを捨てる）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['down', 2, 700, 30],
      ],
      { markers: markers() },
    );
    expect(p.state.mode).toBe('pinch');
    expect(p.state.marker).toBeNull();
    expect(collect(p, 'markerCancel')).toEqual([]);
  });
});

describe('後方互換（AC-5 c）: マーカー・つかむ幅を渡さないときは今と同じ', () => {
  /** 旧の規則の期待値（状態から新しい欄 marker を除いたもの）と比べる */
  const strip = (s: GestureState) => {
    const { marker: _m, ...rest } = s;
    return rest;
  };
  const seqs: Step[][] = [
    [
      ['down', 1, 500, 0],
      ['move', 1, 503, 10],
      ['move', 1, 600, 20],
      ['up', 1, 600, 40],
    ],
    [
      ['down', 1, 300, 0],
      ['up', 1, 301, 50],
      ['down', 1, 302, 150],
      ['up', 1, 302, 200],
    ],
    [
      ['down', 1, 300, 0, AXIS_Y - 4],
      ['long', LONG_PRESS_MS],
      ['move', 1, 320, 500],
      ['up', 1, 320, 520],
    ],
    [
      ['down', 1, 300, 0],
      ['down', 2, 700, 10],
      ['move', 2, 800, 30],
      ['up', 2, 800, 50],
      ['move', 1, 350, 60],
      ['up', 1, 350, 70],
    ],
  ];

  it.each(seqs.map((s, i) => [i, s] as const))('列 %i: 状態の marker は常に null', (_i, seq) => {
    const p = play(seq, { scrub: { linePx: 500 } });
    for (const r of p.results) {
      expect(r.state.marker).toBeNull();
      expect(r.markerTap ?? r.markerDrag ?? r.markerDrop ?? r.markerCancel).toBeUndefined();
    }
  });

  it.each(seqs.map((s, i) => [i, s] as const))(
    '列 %i: markers に空の当たり判定を渡しても、渡さないときと同じ状態・結果',
    (_i, seq) => {
      const a = play(seq, { scrub: { linePx: 500 } });
      const b = play(seq, { scrub: { linePx: 500, grabPx: GRAB_PX } });
      const c = play(seq, { scrub: { linePx: 500 }, markers: { band: BAND, items: [] } });
      for (const other of [b, c]) {
        expect(other.results.map((r) => strip(r.state))).toEqual(
          a.results.map((r) => strip(r.state)),
        );
        expect(other.results.map(({ state: _s, ...rest }) => rest)).toEqual(
          a.results.map(({ state: _s, ...rest }) => rest),
        );
      }
    },
  );

  it('初期状態の marker は null', () => {
    expect(initialGesture().marker).toBeNull();
  });
});

/**
 * #201: 損益グラフの十字線。舞台の文脈（scrub + markers）のタップ（十字線を置く）と、タッチで置いた十字線の交点を
 * つかむ cross。
 */
describe('十字線のタップ（#201）', () => {
  const stage = { scrub: { linePx: 500, grabPx: 14 }, markers: markers() };

  it('短い押下（6px 未満・500ms 未満）は tap、長押し（450ms で発火）は tap を出さずにつかむ', () => {
    const tap = play(
      [
        ['down', 1, 700, 0, 120],
        ['move', 1, 703, 50, 121],
        ['up', 1, 703, 120, 121],
      ],
      stage,
    );
    expect(collect(tap, 'tap')).toEqual([{ x: 703, y: 121 }]);
    const long = play(
      [
        ['down', 1, 700, 0, 120],
        ['long', LONG_PRESS_MS],
        ['up', 1, 700, LONG_PRESS_MS + 20, 120],
      ],
      stage,
    );
    expect(collect(long, 'tap')).toEqual([]);
    expect(collect(long, 'scrub')).toEqual([{ x: 700 }]);
  });

  it('ダブルタップは 1 回目だけ tap、2 回目は reset（tap なし）。パンは tap なし', () => {
    const dbl = play(
      [
        ['down', 1, 700, 0],
        ['up', 1, 700, 60],
        ['down', 2, 704, 150],
        ['up', 2, 704, 200],
      ],
      stage,
    );
    expect(collect(dbl, 'tap')).toHaveLength(1);
    expect(collect(dbl, 'reset')).toEqual([true]);
    const pan = play(
      [
        ['down', 1, 700, 0],
        ['move', 1, 700 + TAP_MOVE_PX, 30],
        ['up', 1, 700 + TAP_MOVE_PX, 60],
      ],
      stage,
    );
    expect(collect(pan, 'tap')).toEqual([]);
    expect(collect(pan, 'viewport').length).toBeGreaterThan(0);
  });

  it('足マーカーのタップは markerTap（tap なし）', () => {
    const r = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 5],
        ['up', 1, 300, 60, AXIS_Y - 5],
      ],
      stage,
    );
    expect(collect(r, 'markerTap')).toEqual([{ id: 1 }]);
    expect(collect(r, 'tap')).toEqual([]);
  });

  it('ハンドルの縦線で即つかんだ短い押下は tap（ダブルタップに数えない）。動かした・長い押下は tap なし', () => {
    const r = play(
      [
        ['down', 1, 505, 0, 90],
        ['up', 1, 505, 80, 90],
      ],
      stage,
    );
    expect(collect(r, 'tap')).toEqual([{ x: 505, y: 90 }]);
    expect(r.state.mode).toBe('idle');
    expect(r.state.lastTap).toBeNull();
    const moved = play(
      [
        ['down', 1, 505, 0],
        ['move', 1, 505 + TAP_MOVE_PX, 30],
        ['up', 1, 505 + TAP_MOVE_PX, 60],
      ],
      stage,
    );
    expect(collect(moved, 'tap')).toEqual([]);
    // 6px 動かして戻した押下も tap なし
    const back = play(
      [
        ['down', 1, 505, 0],
        ['move', 1, 505 + TAP_MOVE_PX + 4, 30],
        ['move', 1, 506, 60],
        ['up', 1, 506, 90],
      ],
      stage,
    );
    expect(collect(back, 'tap')).toEqual([]);
    const slow = play(
      [
        ['down', 1, 505, 0],
        ['up', 1, 505, LONG_PRESS_MS],
      ],
      stage,
    );
    expect(collect(slow, 'tap')).toEqual([]);
  });
});

describe('十字線の交点をつかむ cross（#201）', () => {
  const cross = (x: number, y: number, grabPx = 14): Partial<GestureCtx> => ({
    scrub: { linePx: 500, grabPx: 14 },
    markers: markers(),
    cross: { pointPx: { x, y }, grabPx },
  });

  it('交点から 14px 以内（距離）の押下ですぐ cross: ずれを保って move の位置を返す。パンしない・長押しでつかまない', () => {
    const r = play(
      [
        ['down', 1, 708, 0, 108],
        ['long', LONG_PRESS_MS],
        ['move', 1, 760, 500, 150],
        ['move', 1, 640, 520, 60],
        ['up', 1, 640, 900, 60],
      ],
      cross(700, 100),
    );
    expect(r.results[0]?.state.mode).toBe('cross');
    expect(collect(r, 'cross')).toEqual([
      { x: 752, y: 142 },
      { x: 632, y: 52 },
    ]);
    expect(collect(r, 'viewport')).toEqual([]);
    expect(collect(r, 'scrub')).toEqual([]);
    expect(collect(r, 'tap')).toEqual([]);
    expect(r.state.mode).toBe('idle');
    // 14px を超えたら今の押下（pending）
    expect(play([['down', 1, 711, 0, 111]], cross(700, 100)).state.mode).toBe('pending');
  });

  it('動かさずに離しても tap・reset を出さない', () => {
    const r = play(
      [
        ['down', 1, 700, 0, 100],
        ['up', 1, 700, 50, 100],
        ['down', 2, 700, 120, 100],
        ['up', 2, 700, 160, 100],
      ],
      cross(700, 100),
    );
    expect(collect(r, 'tap')).toEqual([]);
    expect(collect(r, 'reset')).toEqual([]);
  });

  it('足マーカーが先、交点がハンドルより先', () => {
    const onMarker = play([['down', 1, 300, 0, AXIS_Y - 5]], cross(300, AXIS_Y - 5));
    expect(onMarker.state.mode).toBe('marker');
    const onHandle = play([['down', 1, 500, 0, 100]], cross(505, 100));
    expect(onHandle.state.mode).toBe('cross');
  });

  it('2 本目の指でピンチ（cross を出さない）、cancel で idle', () => {
    const r = play(
      [
        ['down', 1, 700, 0, 100],
        ['down', 2, 900, 10, 100],
        ['move', 2, 950, 20, 100],
      ],
      cross(700, 100),
    );
    expect(r.state.mode).toBe('pinch');
    expect(r.state.crossOffset).toBeNull();
    expect(collect(r, 'cross')).toEqual([]);
    expect(collect(r, 'viewport').length).toBeGreaterThan(0);
    const c = play(
      [
        ['down', 1, 700, 0, 100],
        ['cancel', 1, 700, 10, 100],
      ],
      cross(700, 100),
    );
    expect(c.state.mode).toBe('idle');
  });

  it('pointPx が null・cross を渡さない文脈では今のまま', () => {
    const none = play([['down', 1, 700, 0, 100]], {
      scrub: { linePx: 500, grabPx: 14 },
      cross: { pointPx: null, grabPx: 14 },
    });
    expect(none.state.mode).toBe('pending');
    expect(initialGesture().crossOffset).toBeNull();
  });
});

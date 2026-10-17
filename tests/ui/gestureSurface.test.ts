import { describe, expect, it } from 'vitest';
import {
  type GestureCtx,
  type GestureResult,
  type GestureState,
  gestureCancel,
  gestureDown,
  gestureLongPress,
  gestureMove,
  gestureUp,
  initialGesture,
  LONG_PRESS_MS,
  TAP_MOVE_PX,
} from '../../ui/chart/gesture';
import { type Domain, pinchViewport } from '../../ui/chart/scale';

/**
 * #88 AC-7: 面モードの面の上の点（ctx.surface。段 B）。既存の tests/ui/gesture.test.ts・gestureStage.test.ts は変えない
 * （ctx.surface を渡さない = 今のまま）。
 */
const full: Domain = [30_000, 90_000];
const range: Domain = [56, 1056];
const V0: Domain = [50_000, 70_000];
const AXIS_Y = 270;
const BAND: [number, number] = [AXIS_Y - 14, AXIS_Y];
const POINT = { x: 500, y: 120 };
const surface = { pointPx: POINT, grabPx: 14 };

type Step = ['down' | 'move' | 'up' | 'cancel', number, number, number, number?] | ['long', number];

interface Played {
  state: GestureState;
  viewport: Domain;
  results: GestureResult[];
  /** 各ステップの前の表示範囲 */
  before: Domain[];
}

function play(steps: Step[], extra: Partial<GestureCtx> = {}, viewport0: Domain = V0): Played {
  let state: GestureState = initialGesture();
  let viewport = viewport0;
  const results: GestureResult[] = [];
  const before: Domain[] = [];
  const fns = { down: gestureDown, move: gestureMove, up: gestureUp, cancel: gestureCancel };
  for (const step of steps) {
    const ctx: GestureCtx = { viewport, range, full, minWidth: 250, ...extra };
    before.push(viewport);
    const r =
      step[0] === 'long'
        ? gestureLongPress(state, step[1], ctx)
        : fns[step[0]](state, { id: step[1], x: step[2], y: step[4] ?? 100, t: step[3] }, ctx);
    state = r.state;
    if (r.viewport) viewport = r.viewport;
    results.push(r);
  }
  return { state, viewport, results, before };
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

describe('押した位置・点のずれ（AC-7 a）', () => {
  it('マーカーの帯の外の down で即 surface（押した位置）と surfaceStart', () => {
    const p = play([['down', 1, 300, 0, 80]], { surface, markers: markers() });
    expect(p.state.mode).toBe('surface');
    expect(p.results[0]?.surface).toEqual({ x: 300, y: 80 });
    expect(p.results[0]?.surfaceStart).toBe(true);
    expect(p.results[0]?.viewport).toBeUndefined();
  });

  it('点の 14px 以内は点の位置を返し、move でずれを保つ（飛ばない）', () => {
    // 距離 √(5² + 10²) ≈ 11.2
    const p = play(
      [
        ['down', 1, 505, 0, 130],
        ['move', 1, 535, 20, 110],
      ],
      { surface },
    );
    expect(p.results[0]?.surface).toEqual({ x: 500, y: 120 });
    expect(p.results[1]?.surface).toEqual({ x: 530, y: 100 });
    // 距離ちょうど 14 も点
    expect(play([['down', 1, 514, 0, 120]], { surface }).results[0]?.surface).toEqual(POINT);
  });

  it('点から 15px は押した位置（ずれ 0）', () => {
    // 距離 √(9² + 12²) = 15
    const p = play(
      [
        ['down', 1, 509, 0, 132],
        ['move', 1, 539, 20, 112],
      ],
      { surface },
    );
    expect(p.results[0]?.surface).toEqual({ x: 509, y: 132 });
    expect(p.results[1]?.surface).toEqual({ x: 539, y: 112 });
    expect(p.state.surfaceOffset).toEqual({ x: 0, y: 0 });
  });

  it('pointPx が null ならいつも押した位置', () => {
    const p = play([['down', 1, 500, 0, 120]], { surface: { pointPx: null, grabPx: 14 } });
    expect(p.results[0]?.surface).toEqual({ x: 500, y: 120 });
  });

  it('ctx.surface があると scrub は使わない（線の近くでも surface）', () => {
    const p = play([['down', 1, 500, 0, 200]], { surface, scrub: { linePx: 500, grabPx: 14 } });
    expect(p.state.mode).toBe('surface');
    expect(p.results[0]?.scrub).toBeUndefined();
  });
});

describe('move と up（AC-7 b）', () => {
  it('move で surface、up で idle と surfaceEnd。どの結果も viewport を返さない', () => {
    const p = play(
      [
        ['down', 1, 300, 0, 80],
        ['move', 1, 340, 30, 60],
        ['move', 1, 400, 60, 40],
        ['up', 1, 400, 900, 40],
      ],
      { surface },
    );
    expect(collect(p, 'surface')).toEqual([
      { x: 300, y: 80 },
      { x: 340, y: 60 },
      { x: 400, y: 40 },
    ]);
    expect(collect(p, 'surfaceEnd')).toEqual([true]);
    expect(collect(p, 'surfaceStart')).toEqual([true]);
    expect(collect(p, 'viewport')).toEqual([]);
    expect(collect(p, 'tap')).toEqual([]);
    expect(p.viewport).toEqual(V0);
    expect(p.state.mode).toBe('idle');
    expect(p.state.surfaceOffset).toBeNull();
    expect(p.state.pointers).toEqual([]);
  });

  it('長押しは何もしない（状態そのまま）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, 80],
        ['long', LONG_PRESS_MS],
      ],
      { surface },
    );
    expect(p.results[1]?.state).toBe(p.results[0]?.state);
    expect(p.results[1]?.scrub).toBeUndefined();
    expect(p.results[1]?.surface).toBeUndefined();
  });
});

describe('ダブルタップ（AC-7 c）', () => {
  it('6px 未満・500ms 未満の 2 回（300ms・20px 以内）で 2 回目の up に reset', () => {
    const p = play(
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 302, 80, 80],
        ['down', 1, 310, 200, 90],
        ['up', 1, 310, 260, 90],
      ],
      { surface },
    );
    expect(p.results[1]?.reset).toBeUndefined();
    expect(p.results[1]?.state.lastTap).toEqual({ x: 302, y: 80, t: 80 });
    expect(p.results[3]?.reset).toBe(true);
    expect(p.results[3]?.surfaceEnd).toBe(true);
    expect(p.state.lastTap).toBeNull();
    expect(collect(p, 'tap')).toEqual([]);
  });

  it.each([
    [
      '6px 動かした',
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 300, 80, 80],
        ['down', 1, 300, 200, 80],
        ['move', 1, 300 + TAP_MOVE_PX, 220, 80],
        ['up', 1, 300 + TAP_MOVE_PX, 260, 80],
      ],
    ],
    [
      '6px 動かして戻した',
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 300, 80, 80],
        ['down', 1, 300, 150, 80],
        ['move', 1, 300 + TAP_MOVE_PX, 170, 80],
        ['move', 1, 300, 190, 80],
        ['up', 1, 300, 210, 80],
      ],
    ],
    [
      '600ms 押した',
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 300, 80, 80],
        ['down', 1, 300, 100, 80],
        ['up', 1, 300, 700, 80],
      ],
    ],
    [
      '400ms 空けた',
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 300, 80, 80],
        ['down', 1, 300, 400, 80],
        ['up', 1, 300, 480, 80],
      ],
    ],
  ] as Array<[string, Step[]]>)('%s → reset なし', (_name, seq) => {
    const p = play(seq, { surface });
    expect(collect(p, 'reset')).toEqual([]);
  });

  it('タップでない離しは前のタップを保つ（pending と同じ）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, 80],
        ['up', 1, 300, 50, 80],
        ['down', 1, 300, 100, 80],
        ['move', 1, 340, 120, 80],
        ['up', 1, 340, 140, 80],
      ],
      { surface },
    );
    expect(p.state.lastTap).toEqual({ x: 300, y: 80, t: 50 });
  });
});

describe('2 本目の指（AC-7 d）', () => {
  it('surface 中の 2 本目の down → surfaceCancel とピンチ、以後の move で viewport（surface なし）', () => {
    const p = play(
      [
        ['down', 1, 400, 0, 100],
        ['move', 1, 420, 20, 90],
        ['down', 2, 700, 40, 100],
        ['move', 2, 800, 60, 100],
        ['move', 1, 380, 80, 100],
      ],
      { surface },
    );
    expect(p.results[2]?.surfaceCancel).toBe(true);
    expect(p.results[2]?.state.mode).toBe('pinch');
    expect(p.results[2]?.state.surfaceOffset).toBeNull();
    expect(p.results[2]?.surface).toBeUndefined();
    // ピンチの開始は 2 本目の down の時点の範囲と 2 本の画素
    const start = p.before[2] as Domain;
    expect(p.results[3]?.viewport).toEqual(
      pinchViewport(start, [420, 700], [420, 800], range, full, 250),
    );
    expect(p.results[4]?.viewport).toEqual(
      pinchViewport(start, [420, 700], [380, 800], range, full, 250),
    );
    expect(p.results.slice(3).map((r) => r.surface)).toEqual([undefined, undefined]);
  });

  it('ピンチから 1 本離すと残りの指はパン（点は動かさない）', () => {
    const p = play(
      [
        ['down', 1, 400, 0, 100],
        ['down', 2, 700, 40, 100],
        ['move', 2, 800, 60, 100],
        ['up', 2, 800, 80, 100],
        ['move', 1, 450, 100, 100],
        ['up', 1, 450, 120, 100],
      ],
      { surface },
    );
    expect(p.results[3]?.state.mode).toBe('drag');
    expect(p.results[4]?.viewport).toBeDefined();
    expect(p.results[4]?.surface).toBeUndefined();
    expect(collect(p, 'surfaceEnd')).toEqual([]);
    expect(p.state.mode).toBe('idle');
  });

  it('cancel → idle と surfaceCancel', () => {
    const p = play(
      [
        ['down', 1, 400, 0, 100],
        ['move', 1, 420, 20, 90],
        ['cancel', 1, 420, 30, 90],
      ],
      { surface },
    );
    expect(p.results[2]?.surfaceCancel).toBe(true);
    expect(p.state).toEqual(initialGesture());
  });
});

describe('足マーカーの優先（AC-7 e）', () => {
  const extra = { surface, markers: markers() };

  it('帯の中のタップ → markerTap（surface なし）', () => {
    const p = play(
      [
        ['down', 1, 301, 0, AXIS_Y - 4],
        ['up', 1, 302, 80, AXIS_Y - 4],
      ],
      extra,
    );
    expect(p.results[0]?.state.mode).toBe('marker');
    expect(collect(p, 'markerTap')).toEqual([{ id: 1 }]);
    expect(collect(p, 'surface')).toEqual([]);
    expect(collect(p, 'surfaceStart')).toEqual([]);
  });

  it('帯の中の長押し → markerDrag、離して markerDrop（surface なし）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['long', LONG_PRESS_MS],
        ['move', 1, 330, 500, AXIS_Y - 40],
        ['up', 1, 340, 520, AXIS_Y - 40],
      ],
      extra,
    );
    expect(collect(p, 'markerDrag')).toEqual([
      { id: 1, x: 300 },
      { id: 1, x: 330 },
    ]);
    expect(collect(p, 'markerDrop')).toEqual([{ id: 1, x: 340 }]);
    expect(collect(p, 'surface')).toEqual([]);
  });

  it('帯の中で押して 6px 動かして戻した押下はタップに数えない（直前のタップと reset にならない）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 20],
        ['up', 1, 300, 60, AXIS_Y - 20],
        ['down', 1, 301, 150, AXIS_Y - 4],
        ['move', 1, 301 + TAP_MOVE_PX, 170, AXIS_Y - 4],
        ['move', 1, 301, 190, AXIS_Y - 4],
        ['up', 1, 301, 210, AXIS_Y - 4],
      ],
      extra,
    );
    expect(p.results[1]?.state.lastTap).toEqual({ x: 300, y: AXIS_Y - 20, t: 60 });
    expect(p.results[3]?.state.mode).toBe('surface');
    expect(collect(p, 'reset')).toEqual([]);
    expect(collect(p, 'markerTap')).toEqual([]);
    expect(p.results[5]?.surfaceEnd).toBe(true);
  });

  it('帯の中で押して 6px 動かす → パンではなく surface（その位置から）', () => {
    const p = play(
      [
        ['down', 1, 300, 0, AXIS_Y - 4],
        ['move', 1, 300 + TAP_MOVE_PX, 30, AXIS_Y - 4],
        ['move', 1, 340, 60, AXIS_Y - 30],
        ['up', 1, 340, 80, AXIS_Y - 30],
      ],
      extra,
    );
    expect(p.results[1]?.state.mode).toBe('surface');
    expect(p.results[1]?.state.marker).toBeNull();
    expect(p.results[1]?.surfaceStart).toBe(true);
    expect(collect(p, 'surface')).toEqual([
      { x: 300 + TAP_MOVE_PX, y: AXIS_Y - 4 },
      { x: 340, y: AXIS_Y - 30 },
    ]);
    expect(collect(p, 'viewport')).toEqual([]);
    expect(collect(p, 'markerTap')).toEqual([]);
    expect(collect(p, 'surfaceEnd')).toEqual([true]);
  });
});

describe('後方互換（AC-7 f）: ctx.surface を渡さないときは今と同じ', () => {
  /** tests/ui/gestureStage.test.ts の後方互換と同じ 4 つの入力の列 */
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
  const extras: Record<string, Partial<GestureCtx>> = {
    none: {},
    scrub: { scrub: { linePx: 500 } },
    scrubMarkers: { scrub: { linePx: 500, grabPx: 14 }, markers: markers() },
  };
  /**
   * 段 B の前の関数（origin/main 0467c45 の ui/chart/gesture.ts）に同じ列を流した各ステップの mode と結果（state 以外）。
   * 段 B の前の関数を一時に実行して書き写した固定の期待値（手で直さない）
   */
  const BEFORE: Record<string, Array<Array<Record<string, unknown>>>> = {
    none: [
      [
        { mode: 'pending' },
        { mode: 'pending' },
        { mode: 'drag', viewport: [48000, 68000] },
        { mode: 'idle' },
      ],
      [
        { mode: 'pending' },
        { mode: 'idle', tap: { x: 301, y: 100 } },
        { mode: 'pending' },
        { mode: 'idle', reset: true },
      ],
      [
        { mode: 'pending' },
        { mode: 'pending' },
        { mode: 'drag', viewport: [49600, 69600] },
        { mode: 'idle' },
      ],
      [
        { mode: 'pending' },
        { mode: 'pinch' },
        { mode: 'pinch', viewport: [50976, 66976] },
        { mode: 'drag' },
        { mode: 'drag', viewport: [50176, 66176] },
        { mode: 'idle' },
      ],
    ],
    scrub: [
      [
        { mode: 'scrub' },
        { mode: 'scrub', scrub: { x: 503 } },
        { mode: 'scrub', scrub: { x: 600 } },
        { mode: 'idle' },
      ],
      [
        { mode: 'pending' },
        { mode: 'idle', tap: { x: 301, y: 100 } },
        { mode: 'pending' },
        { mode: 'idle', reset: true },
      ],
      [
        { mode: 'pending' },
        { mode: 'scrub', scrub: { x: 300 } },
        { mode: 'scrub', scrub: { x: 320 } },
        { mode: 'idle' },
      ],
      [
        { mode: 'pending' },
        { mode: 'pinch' },
        { mode: 'pinch', viewport: [50976, 66976] },
        { mode: 'drag' },
        { mode: 'drag', viewport: [50176, 66176] },
        { mode: 'idle' },
      ],
    ],
    scrubMarkers: [
      [
        { mode: 'scrub' },
        { mode: 'scrub', scrub: { x: 503 } },
        { mode: 'scrub', scrub: { x: 600 } },
        { mode: 'idle' },
      ],
      [
        { mode: 'pending' },
        { mode: 'idle', tap: { x: 301, y: 100 } },
        { mode: 'pending' },
        { mode: 'idle', reset: true },
      ],
      [
        { mode: 'marker' },
        { mode: 'markerDrag', markerDrag: { id: 1, x: 300 } },
        { mode: 'markerDrag', markerDrag: { id: 1, x: 320 } },
        { mode: 'idle', markerDrop: { id: 1, x: 320 } },
      ],
      [
        { mode: 'pending' },
        { mode: 'pinch' },
        { mode: 'pinch', viewport: [50976, 66976] },
        { mode: 'drag' },
        { mode: 'drag', viewport: [50176, 66176] },
        { mode: 'idle' },
      ],
    ],
  };

  const cases = Object.keys(extras).flatMap((name) =>
    seqs.map((seq, i) => [name, i, seq] as const),
  );

  it.each(cases)('%s 列 %i: 段 B の前の関数と同じ mode・結果', (name, i, seq) => {
    const p = play(seq, extras[name]);
    const got = p.results.map(({ state, ...rest }) => ({ mode: state.mode, ...rest }));
    expect(got).toEqual(BEFORE[name]?.[i]);
  });

  it.each(cases)('%s 列 %i: surface にならず、surface の欄が出ない', (name, _i, seq) => {
    const p = play(seq, extras[name]);
    for (const r of p.results) {
      expect(r.state.mode).not.toBe('surface');
      expect(r.state.surfaceOffset).toBeNull();
      expect(r.surface ?? r.surfaceStart ?? r.surfaceEnd ?? r.surfaceCancel).toBeUndefined();
    }
  });

  it('初期状態の surfaceOffset は null', () => {
    expect(initialGesture().surfaceOffset).toBeNull();
  });
});

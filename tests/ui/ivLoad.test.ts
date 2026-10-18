import { describe, expect, it } from 'vitest';
import { ivEdges, ivFollowViewport } from '../../ui/view/ivHistory';
import {
  INITIAL_IV_LOAD,
  IV_EPOCH,
  type IvEntry,
  type IvLoadAction,
  type IvLoadResult,
  type IvLoadState,
  ivInProgress,
  ivLoadReduce,
  ivLoadView,
  mergeIvEntry,
} from '../../ui/view/ivLoad';
import { barsAt, everyStep, ivData, jst } from '../support/synthIv';

/**
 * #79: IV 推移の読み込みの状態機械（ui/view/ivLoad.ts）。段 B = AC10（遅延ロード・開き直しで読まない・最新化で 1 回）と
 * AC9 のうち読み中は 2 本目を出さない・足の切替で古い応答を捨てる・読み済みは要求しない。段 C = AC9 の残り（端から 10 本で
 * 1 回・左 3 回空で止まる・前に足しても時間範囲が変わらない・上限を超えたら遠い側を捨てる）と読み済みの範囲の隙間。値は架空。
 */

/** action を順に流し、出した要求を集める */
function run(actions: IvLoadAction[], from: IvLoadState = INITIAL_IV_LOAD) {
  let s = from;
  const results: IvLoadResult[] = [];
  for (const a of actions) {
    const r = ivLoadReduce(s, a);
    results.push(r);
    s = r.state;
  }
  return {
    state: s,
    requests: results.flatMap((r) => (r.request ? [r.request] : [])),
    aborts: results.flatMap((r) => (r.abort === null ? [] : [r.abort])),
  };
}

const hourBars = barsAt(everyStep(jst('2026-10-13T09:00'), 3600, 5));
const minuteBars = barsAt(everyStep(jst('2026-10-13T09:00'), 60, 30), 2);
const dayBars = barsAt(everyStep(jst('2026-10-01T00:00'), 86400, 10), 3);

describe('AC10: 遅延ロード', () => {
  it('起動時は読まない（open の前は要求 0・open されていなければ最新化・足の切替でも読まない）', () => {
    expect(INITIAL_IV_LOAD.opened).toBe(false);
    expect(INITIAL_IV_LOAD.tf).toBe('1h');
    const r = run([{ type: 'refresh' }, { type: 'setTf', tf: '1d' }, { type: 'setTf', tf: '1h' }]);
    expect(r.requests).toEqual([]);
    expect(r.state.opened).toBe(false);
  });

  it('初めて開くと今の足の右端を 1 回、開き直しても読まない（読み中・読み済みとも）', () => {
    const a = run([{ type: 'open' }, { type: 'open' }]);
    expect(a.requests).toEqual([{ id: 1, src: '1h', side: 'right', gen: 0 }]);
    const b = run(
      [{ type: 'loaded', id: 1, data: ivData('1h', hourBars) }, { type: 'open' }, { type: 'open' }],
      a.state,
    );
    expect(b.requests).toEqual([]);
    const v = ivLoadView(b.state);
    expect(v.loading).toBe(false);
    expect(v.entry?.bars).toEqual(hourBars);
    expect(v.entry?.rightLoaded).toBe(true);
  });

  it('最新化ボタンで右端の 1 回（読み中は出さない）。応答は時刻をキーにつなぐ（同じ時刻は新しい方）', () => {
    const opened = run([{ type: 'open' }, { type: 'loaded', id: 1, data: ivData('1h', hourBars) }]);
    const r = run([{ type: 'refresh' }, { type: 'refresh' }], opened.state);
    expect(r.requests).toEqual([{ id: 2, src: '1h', side: 'refresh', gen: 0 }]);
    const last = hourBars.at(-1);
    if (!last) throw new Error('足が無い');
    const newer = [
      { ...last, c: 25, h: 25 },
      { ...last, t: last.t + 3600 },
    ];
    const done = run(
      [{ type: 'loaded', id: 2, data: ivData('1h', newer, { lastAt: last.t + 3700 }) }],
      r.state,
    );
    const e = ivLoadView(done.state).entry;
    expect(e?.bars).toHaveLength(hourBars.length + 1);
    expect(e?.bars.at(-2)?.c).toBe(25);
    expect(e?.lastAt).toBe(last.t + 3700);
    expect(e?.start).toBe(hourBars[0]?.t);
    // 応答の後はもう一度押せる
    expect(run([{ type: 'refresh' }], done.state).requests).toHaveLength(1);
  });
});

describe('足の切替（AC9 の段 B の分）', () => {
  const opened = run([{ type: 'open' }, { type: 'loaded', id: 1, data: ivData('1h', hourBars) }]);

  it('読んでいない足に替えると右端を 1 回、読み済みの足に戻すと要求しない', () => {
    const r = run(
      [
        { type: 'setTf', tf: '1d' },
        { type: 'loaded', id: 2, data: ivData('1d', dayBars) },
        { type: 'setTf', tf: '1h' },
        { type: 'setTf', tf: '1d' },
      ],
      opened.state,
    );
    expect(r.requests).toEqual([{ id: 2, src: '1d', side: 'right', gen: 1 }]);
    expect(r.state.gen).toBe(3);
  });

  it('5 分・15 分は 1 分の読み込みを共有する（1 回だけ。読み中の 1 分を止めない）', () => {
    const r = run(
      [
        { type: 'setTf', tf: '1m' },
        { type: 'setTf', tf: '5m' },
        { type: 'setTf', tf: '15m' },
        { type: 'loaded', id: 2, data: ivData('1m', minuteBars) },
        { type: 'setTf', tf: '1m' },
      ],
      opened.state,
    );
    expect(r.requests).toEqual([{ id: 2, src: '1m', side: 'right', gen: 1 }]);
    expect(r.aborts).toEqual([]);
    expect(ivLoadView(r.state).entry?.bars).toEqual(minuteBars);
  });

  it('読み中に別の足へ替えると前の要求を止め、遅れて来た古い応答は捨てる', () => {
    const r = run(
      [
        { type: 'setTf', tf: '1d' },
        { type: 'setTf', tf: '1m' },
        { type: 'loaded', id: 2, data: ivData('1d', dayBars) },
      ],
      opened.state,
    );
    expect(r.requests.map((q) => [q.id, q.src])).toEqual([
      [2, '1d'],
      [3, '1m'],
    ]);
    expect(r.aborts).toEqual([2]);
    expect(r.state.entries['1d']).toBeUndefined();
    expect(r.state.inflight?.id).toBe(3);
    // 今の要求の応答は入る
    const done = run([{ type: 'loaded', id: 3, data: ivData('1m', minuteBars) }], r.state);
    expect(done.state.inflight).toBeNull();
    expect(done.state.entries['1m']?.bars).toEqual(minuteBars);
  });

  it('違う世代・違う id・違う足の応答は捨てる', () => {
    const a = run([{ type: 'refresh' }], opened.state);
    const req = a.requests[0];
    if (!req) throw new Error('要求が無い');
    // 足の違う応答（サーバーの取り違え）は入れず、読み中のままにしない（失敗 → [再試行]。段 B のレビュー指摘 1）
    const wrong = ivLoadReduce(a.state, {
      type: 'loaded',
      id: req.id,
      data: ivData('1d', dayBars),
    });
    expect(wrong.state.entries).toBe(a.state.entries);
    expect(wrong.state.inflight).toBeNull();
    expect(wrong.state.error).toEqual({ src: '1h', side: 'refresh' });
    expect(
      ivLoadReduce(a.state, { type: 'loaded', id: 99, data: ivData('1h', hourBars) }).state,
    ).toBe(a.state);
    expect(ivLoadReduce(a.state, { type: 'failed', id: 99 }).state).toBe(a.state);
  });
});

describe('失敗と再試行', () => {
  it('失敗したら error、開き直しでは読まない、[再試行] で同じ要求をもう 1 回', () => {
    const r = run([{ type: 'open' }, { type: 'failed', id: 1 }, { type: 'open' }]);
    expect(r.requests).toHaveLength(1);
    expect(r.state.error).toEqual({ src: '1h', side: 'right' });
    expect(ivLoadView(r.state)).toEqual({
      entry: null,
      loading: false,
      pending: null,
      failed: true,
      failedSide: 'right',
    });
    const again = run([{ type: 'retry' }, { type: 'retry' }], r.state);
    expect(again.requests).toEqual([{ id: 2, src: '1h', side: 'right', gen: 0 }]);
    expect(again.state.error).toBeNull();
    expect(ivLoadView(again.state).loading).toBe(true);
  });

  it('最新化の失敗は読み済みの足を残す。足を替えたら error を消して新しい足を読む', () => {
    const r = run([
      { type: 'open' },
      { type: 'loaded', id: 1, data: ivData('1h', hourBars) },
      { type: 'refresh' },
      { type: 'failed', id: 2 },
    ]);
    expect(r.state.error).toEqual({ src: '1h', side: 'refresh' });
    expect(ivLoadView(r.state).entry?.bars).toEqual(hourBars);
    const sw = run([{ type: 'setTf', tf: '1d' }], r.state);
    expect(sw.state.error).toBeNull();
    expect(sw.requests).toEqual([{ id: 3, src: '1d', side: 'right', gen: 1 }]);
  });
});

// ---- 段 C（AC9 の残り）
const DAY = 86400;
/** UTC の 0 時 */
const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
/** [start, end) の 1 時間ごとの足（架空。立会の時間に関係なく毎時） */
const hourly = (start: number, end: number, seed = 1) =>
  barsAt(everyStep(start, 3600, Math.max(0, (end - start) / 3600)), seed);

/** 1 時間足の右端（最新）を読み済みの状態（now = 10-14 12:00Z。範囲 = 明日の 0 時 − 60 日〜now） */
const NOW = utcDay('2026-10-14') + 12 * 3600;
const RIGHT_START = utcDay('2026-10-15') - 60 * DAY;
function openedHour() {
  return run([
    { type: 'open' },
    {
      type: 'loaded',
      id: 1,
      data: ivData('1h', hourly(RIGHT_START, NOW), {
        start: RIGHT_START,
        end: NOW,
        lastAt: NOW - 3000,
      }),
    },
  ]);
}

describe('AC9: 左の追加読み込み', () => {
  it('左端が最初の足から 10 本未満で 1 回だけ（end = 読み済みの start、1 回分 = 60 日。UTC の 0 時）。読み中は 2 本目を出さない', () => {
    const o = openedHour();
    const n = o.state.entries['1h']?.bars.length as number;
    expect(ivEdges([9.4, 120], n, 10)).toEqual({ left: true, right: false });
    expect(ivEdges([10, 120], n, 10).left).toBe(false);
    const r = run(
      [
        { type: 'edge', nudge: 1, left: false, right: false },
        { type: 'edge', nudge: 2, ...ivEdges([12, 130], n, 10) },
        { type: 'edge', nudge: 3, left: true, right: false },
        { type: 'edge', nudge: 4, left: true, right: false },
      ],
      o.state,
    );
    expect(r.requests).toEqual([
      {
        id: 2,
        src: '1h',
        side: 'left',
        gen: 0,
        range: { start: RIGHT_START - 60 * DAY, end: RIGHT_START },
      },
    ]);
    expect((r.requests[0]?.range?.start as number) % DAY).toBe(0);
  });

  it('読み済みの範囲を二度要求しない: 左を読んだ後の左は、その前の 1 回分', () => {
    const o = openedHour();
    const a = run([{ type: 'edge', nudge: 5, left: true, right: false }], o.state);
    const b = run(
      [
        {
          type: 'loaded',
          id: 2,
          data: ivData('1h', hourly(RIGHT_START - 60 * DAY, RIGHT_START), {
            start: RIGHT_START - 60 * DAY,
            end: RIGHT_START,
          }),
        },
        { type: 'edge', nudge: 6, left: true, right: false },
      ],
      a.state,
    );
    expect(b.requests.map((q) => q.range)).toEqual([
      { start: RIGHT_START - 120 * DAY, end: RIGHT_START - 60 * DAY },
    ]);
    const e = b.state.entries['1h'] as IvEntry;
    expect(e.start).toBe(RIGHT_START - 60 * DAY);
    expect(e.rightLoaded).toBe(true);
  });

  it('左が 3 回続けて空なら止まる（空の後は続けて次を読む = デバウンスなし）。止まった後は edge でも読まない', () => {
    const o = openedHour();
    let s = run([{ type: 'edge', nudge: 7, left: true, right: false }], o.state).state;
    const reqs = [];
    for (let i = 0; i < 3; i++) {
      const f = s.inflight;
      if (!f?.range) throw new Error('左の要求が無い');
      const r = ivLoadReduce(s, {
        type: 'loaded',
        id: f.id,
        data: ivData('1h', [], { start: f.range.start, end: f.range.end, lastAt: null }),
      });
      if (r.request) reqs.push(r.request);
      s = r.state;
    }
    // 1・2 回目の空の後は続けて次（3 回目の空で止まる）
    expect(reqs.map((q) => q.side)).toEqual(['left', 'left']);
    expect(s.inflight).toBeNull();
    expect(s.entries['1h']?.leftDone).toBe(true);
    expect(run([{ type: 'edge', nudge: 8, left: true, right: false }], s).requests).toEqual([]);
  });

  it('空の後に足があれば数え直す（空・足あり・空・空 では止まらない）', () => {
    let s = openedHour().state;
    s = run([{ type: 'edge', nudge: 9, left: true, right: false }], s).state;
    const answer = (bars: boolean) => {
      const f = s.inflight;
      if (!f?.range) throw new Error('左の要求が無い');
      const data = ivData('1h', bars ? hourly(f.range.end - 5 * 3600, f.range.end) : [], {
        start: f.range.start,
        end: f.range.end,
      });
      const r = ivLoadReduce(s, { type: 'loaded', id: f.id, data });
      s = r.state;
      if (!r.request) s = run([{ type: 'edge', nudge: 10, left: true, right: false }], s).state;
    };
    answer(false);
    answer(true);
    answer(false);
    answer(false);
    expect(s.entries['1h']?.leftDone).toBe(false);
    expect(s.entries['1h']?.emptyLeft).toBe(2);
    expect(s.inflight?.side).toBe('left');
  });

  it('EPOCH（2010-01-01）より前は読まない: 左の 1 回分は EPOCH で切り、届いたら終わり', () => {
    const start = IV_EPOCH + 30 * DAY;
    const data = ivData('1d', barsAt(everyStep(start, DAY, 10)), { start, end: start + 10 * DAY });
    let s = run([{ type: 'setTf', tf: '1d' }, { type: 'open' }]).state;
    s = run([{ type: 'loaded', id: 1, data }], s).state;
    const r = run([{ type: 'edge', nudge: 11, left: true, right: false }], s);
    expect(r.requests[0]?.range).toEqual({ start: IV_EPOCH, end: start });
    const f = r.requests[0];
    if (!f?.range) throw new Error('左の要求が無い');
    const done = run(
      [
        {
          type: 'loaded',
          id: f.id,
          data: ivData('1d', barsAt([IV_EPOCH + 5 * DAY]), { start: IV_EPOCH, end: start }),
        },
      ],
      r.state,
    );
    expect(done.state.entries['1d']?.leftDone).toBe(true);
  });

  it('左の失敗は [再試行] で同じ範囲をもう 1 回。失敗中は edge で読まない', () => {
    const o = openedHour();
    const a = run(
      [
        { type: 'edge', nudge: 12, left: true, right: false },
        { type: 'failed', id: 2 },
      ],
      o.state,
    );
    expect(ivLoadView(a.state)).toMatchObject({ failed: true, failedSide: 'left' });
    expect(run([{ type: 'edge', nudge: 13, left: true, right: false }], a.state).requests).toEqual(
      [],
    );
    const b = run([{ type: 'retry' }], a.state);
    expect(b.requests).toEqual([
      {
        id: 3,
        src: '1h',
        side: 'left',
        gen: 0,
        range: { start: RIGHT_START - 60 * DAY, end: RIGHT_START },
      },
    ]);
  });
});

describe('AC9: 前に足しても表示の時間範囲が変わらない', () => {
  it('前に k 本足したら表示範囲を k だけずらす（見ている足の時刻が同じ）', () => {
    const prev = hourly(RIGHT_START, NOW);
    const added = hourly(RIGHT_START - 2 * DAY, RIGHT_START, 2);
    const next = [...added, ...prev];
    const vp: [number, number] = [3.2, 40.7];
    const out = ivFollowViewport(prev, next, vp);
    expect(out).toEqual([3.2 + added.length, 40.7 + added.length]);
    const at = (bars: typeof prev, v: number) => bars[Math.round(v)]?.t;
    expect(at(next, (out as [number, number])[0])).toBe(at(prev, vp[0]));
    expect(at(next, (out as [number, number])[1])).toBe(at(prev, vp[1]));
  });

  it('右端が見えていれば右端に付いていく（⟳ で右に足した足が見える。段 B のレビュー指摘 4）。見えていなければ動かない', () => {
    const prev = hourly(RIGHT_START, NOW);
    const next = [...prev, ...hourly(NOW, NOW + 3 * 3600, 3)];
    const n = prev.length;
    expect(ivFollowViewport(prev, next, [n - 50, n + 2])).toEqual([n - 47, n + 5]);
    expect(ivFollowViewport(prev, next, [n - 80, n - 30])).toEqual([n - 80, n - 30]);
    // 明示の表示範囲が無い（初期表示 = 右端）・共通の足が無い（置き換えた）なら初期表示
    expect(ivFollowViewport(prev, next, null)).toBeNull();
    expect(ivFollowViewport(prev, hourly(NOW + 10 * DAY, NOW + 11 * DAY), [1, 20])).toBeNull();
  });

  it('左を捨てたら捨てた本数だけ左へずらす', () => {
    const prev = hourly(RIGHT_START, NOW);
    const next = prev.slice(24);
    expect(ivFollowViewport(prev, next, [100, 200])).toEqual([76, 176]);
  });
});

describe('AC9: 覚える範囲の上限を超えたら遠い側を捨てる', () => {
  // 1 分足: 上限 9 日、1 回分 3 日
  const m = (start: number, end: number) =>
    barsAt(everyStep(start, 600, Math.max(0, (end - start) / 600)), 4);

  it('左を読んで 9 日を超えたら右（遠い側）を捨てて rightLoaded = false。右端へ戻ると右の 1 回分（start = 読み済みの end）', () => {
    const d0 = utcDay('2026-10-12');
    const now = d0 + 2 * DAY + 12 * 3600;
    let e: IvEntry = mergeIvEntry(undefined, ivData('1m', m(d0, now), { start: d0, end: now }), {
      src: '1m',
      side: 'right',
    });
    expect(e.rightLoaded).toBe(true);
    for (const k of [1, 2]) {
      const end = e.start;
      const start = end - 3 * DAY;
      e = mergeIvEntry(e, ivData('1m', m(start, end), { start, end }), {
        src: '1m',
        side: 'left',
        range: { start, end },
      });
      expect(e.rightLoaded).toBe(true);
      expect(e.start).toBe(d0 - k * 3 * DAY);
    }
    // 3 回目で 11.5 日 > 9 日 → 右を捨てる
    const end = e.start;
    const start = end - 3 * DAY;
    e = mergeIvEntry(e, ivData('1m', m(start, end), { start, end }), {
      src: '1m',
      side: 'left',
      range: { start, end },
    });
    expect(e.start).toBe(start);
    expect(e.end).toBe(start + 9 * DAY);
    expect(e.rightLoaded).toBe(false);
    expect(e.bars.at(-1)?.t).toBeLessThan(e.end);
    expect(e.bars[0]?.t).toBe(start);
    expect(ivInProgress(e)).toBe(false);

    // 右端へ戻る → 右の 1 回分
    let s: IvLoadState = { ...INITIAL_IV_LOAD, tf: '1m', opened: true, entries: { '1m': e } };
    const r = run([{ type: 'edge', nudge: 14, left: false, right: true }], s);
    expect(r.requests).toEqual([
      { id: 1, src: '1m', side: 'next', gen: 0, range: { start: e.end, end: e.end + 3 * DAY } },
    ]);
    // サーバーが end を now に縮めた → 右端に届いた。9 日を超えたので左（遠い側）を捨てる
    s = r.state;
    const rr = r.requests[0]?.range as { start: number; end: number };
    const back = run(
      [
        {
          type: 'loaded',
          id: 1,
          data: ivData('1m', m(rr.start, now), { start: rr.start, end: now, lastAt: now - 60 }),
        },
      ],
      s,
    );
    const e2 = back.state.entries['1m'] as IvEntry;
    expect(e2.rightLoaded).toBe(true);
    expect(e2.end).toBe(now);
    expect(e2.end - e2.start).toBeLessThanOrEqual(9 * DAY);
    expect(e2.start % DAY).toBe(0);
    expect(e2.leftDone).toBe(false);
    expect(ivInProgress(e2)).toBe(true);
  });

  it('両端が見えている（全体を表示）ときは、反対側を捨てることになる追加は読まない（左右の読み直しを繰り返さない）', () => {
    const d0 = utcDay('2026-10-12');
    const e: IvEntry = {
      bars: m(d0, d0 + 9 * DAY),
      start: d0,
      end: d0 + 9 * DAY,
      lastAt: null,
      rightLoaded: false,
      leftDone: false,
      emptyLeft: 0,
    };
    const s: IvLoadState = { ...INITIAL_IV_LOAD, tf: '1m', opened: true, entries: { '1m': e } };
    expect(run([{ type: 'edge', nudge: 15, left: true, right: true }], s).requests).toEqual([]);
    expect(run([{ type: 'edge', nudge: 16, left: true, right: false }], s).requests).toHaveLength(
      1,
    );
    expect(run([{ type: 'edge', nudge: 17, left: false, right: true }], s).requests).toHaveLength(
      1,
    );
  });

  it('日足は上限なし', () => {
    const start = utcDay('2020-01-01');
    const e = mergeIvEntry(
      {
        bars: [],
        start,
        end: start + 3000 * DAY,
        lastAt: null,
        rightLoaded: true,
        leftDone: false,
        emptyLeft: 0,
      },
      ivData('1d', [], { start: start - 365 * DAY, end: start }),
      { src: '1d', side: 'left', range: { start: start - 365 * DAY, end: start } },
    );
    expect(e.end - e.start).toBe(3365 * DAY);
    expect(e.rightLoaded).toBe(true);
  });
});

describe('読み済みの範囲の隙間（段 B のレビュー指摘 2）', () => {
  it('⟳ の応答が読み済みと離れていれば置き換える（読んでいない間を読み済みにしない）。つながっていればつなぐ', () => {
    const o = openedHour();
    const later = NOW + 70 * DAY;
    const start = utcDay('2026-12-24') - 60 * DAY;
    const far = ivData('1h', hourly(start, later, 5), { start, end: later });
    const r = run([{ type: 'refresh' }, { type: 'loaded', id: 2, data: far }], o.state);
    const e = r.state.entries['1h'] as IvEntry;
    expect(e.start).toBe(start);
    expect(e.bars[0]?.t).toBe(start);
    expect(e.leftDone).toBe(false);
    // つながる ⟳ は時刻をキーにつなぐ
    const near = ivData('1h', hourly(NOW - DAY, NOW + 3600, 6), {
      start: NOW - DAY,
      end: NOW + 3600,
    });
    const j = run([{ type: 'refresh' }, { type: 'loaded', id: 2, data: near }], o.state);
    expect(j.state.entries['1h']?.start).toBe(RIGHT_START);
    expect(j.state.entries['1h']?.end).toBe(NOW + 3600);
  });
});

describe('足の切替で見ていた時間の範囲を読む（段 C）', () => {
  it('見ていた時間が読み済みの外なら、その終わりを含む 1 回分（jump）。右端が見えていたなら右端', () => {
    const o = openedHour();
    const to = utcDay('2026-09-20') + 5 * 3600;
    const r = run([{ type: 'setTf', tf: '1m', at: { from: to - DAY, to, right: false } }], o.state);
    expect(r.requests).toEqual([
      {
        id: 2,
        src: '1m',
        side: 'jump',
        gen: 1,
        range: { start: utcDay('2026-09-21') - 3 * DAY, end: utcDay('2026-09-21') },
      },
    ]);
    // 応答の end が縮められていない → 右端ではない（右へパンすると右を読む）
    const done = run(
      [
        {
          type: 'loaded',
          id: 2,
          data: ivData('1m', barsAt(everyStep(to - 3600, 60, 30)), {
            start: utcDay('2026-09-18'),
            end: utcDay('2026-09-21'),
          }),
        },
      ],
      r.state,
    );
    expect(done.state.entries['1m']?.rightLoaded).toBe(false);
    const right = run(
      [{ type: 'setTf', tf: '1d', at: { from: to - DAY, to: NOW, right: true } }],
      o.state,
    );
    expect(right.requests.map((q) => [q.side, q.range])).toEqual([['right', undefined]]);
    // 読み済みの中なら要求しない
    const inside = run(
      [
        { type: 'setTf', tf: '1d' },
        { type: 'setTf', tf: '1h', at: { from: NOW - DAY, to: NOW - 3600, right: false } },
      ],
      o.state,
    );
    expect(inside.requests.map((q) => q.src)).toEqual(['1d']);
  });
});

describe('右端の足の進行中（段 B のレビュー指摘 3）', () => {
  it('表の最後の行が最後の右端の応答（サーバーの now）から 3 時間以内なら進行中、週末・夜明けで止まっていれば確定', () => {
    const base: IvEntry = {
      bars: [],
      start: RIGHT_START,
      end: NOW,
      lastAt: NOW - 50 * 60,
      rightLoaded: true,
      leftDone: false,
      emptyLeft: 0,
    };
    expect(ivInProgress(base)).toBe(true);
    // 土曜の昼に開いた: 表の最後は土曜 06:00 の取り込み（8 時間前）
    expect(ivInProgress({ ...base, lastAt: NOW - 8 * 3600 })).toBe(false);
    expect(ivInProgress({ ...base, rightLoaded: false })).toBe(false);
    expect(ivInProgress({ ...base, lastAt: null })).toBe(false);
    expect(ivInProgress(null)).toBe(false);
  });
});

describe('Phase 4 の指摘への対応', () => {
  it('指摘 4: 端に居続けても、表示範囲が変わらなければ（同じ nudge）2 回目を読まない。動かせばもう 1 回', () => {
    const o = openedHour();
    const a = run([{ type: 'edge', nudge: 1, left: true, right: false }], o.state);
    expect(a.requests).toHaveLength(1);
    const req = a.requests[0];
    if (!req?.range) throw new Error('左の要求が無い');
    // 足した本数が少ない（3 本）= 左端に居続ける
    const few = ivData('1h', hourly(req.range.end - 3 * 3600, req.range.end), {
      start: req.range.start,
      end: req.range.end,
    });
    const b = run(
      [
        { type: 'loaded', id: req.id, data: few },
        { type: 'edge', nudge: 1, left: true, right: false },
        { type: 'edge', nudge: 1, left: true, right: false },
        { type: 'edge', nudge: 0, left: true, right: false },
      ],
      a.state,
    );
    expect(b.requests).toEqual([]);
    expect(b.state.edgeNudge).toBe(1);
    // 利用者が表示範囲を変えた（nudge 2）→ 1 回だけ
    const c = run(
      [
        { type: 'edge', nudge: 2, left: true, right: false },
        { type: 'edge', nudge: 2, left: true, right: false },
      ],
      b.state,
    );
    expect(c.requests.map((q) => q.side)).toEqual(['left']);
    // 端でない nudge は数を使わない（次に端へ来た同じ nudge は読まない規則の外 = 新しい nudge が要る）
    const d = run([{ type: 'edge', nudge: 3, left: false, right: false }], b.state);
    expect(d.state.edgeNudge).toBe(1);
  });

  it('指摘 3: 右端の 1 回分が 0 本でも左へ読める（「データがありません」のまま止まらない）', () => {
    expect(ivEdges([-0.5, 0.5], 0, 10)).toEqual({ left: true, right: false });
    const empty = run([
      { type: 'open' },
      {
        type: 'loaded',
        id: 1,
        data: ivData('1h', [], { start: RIGHT_START, end: NOW, lastAt: null }),
      },
    ]);
    expect(empty.state.entries['1h']?.bars).toEqual([]);
    const r = run([{ type: 'edge', nudge: 0, ...ivEdges([-0.5, 0.5], 0, 10) }], empty.state);
    expect(r.requests).toEqual([
      {
        id: 2,
        src: '1h',
        side: 'left',
        gen: 0,
        range: { start: RIGHT_START - 60 * DAY, end: RIGHT_START },
      },
    ]);
  });
});

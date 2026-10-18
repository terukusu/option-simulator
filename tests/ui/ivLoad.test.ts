import { describe, expect, it } from 'vitest';
import {
  INITIAL_IV_LOAD,
  type IvLoadAction,
  type IvLoadResult,
  type IvLoadState,
  ivLoadReduce,
  ivLoadView,
} from '../../ui/view/ivLoad';
import { barsAt, everyStep, ivData, jst } from '../support/synthIv';

/**
 * #79 段 B: IV 推移の読み込みの状態機械（ui/view/ivLoad.ts）。AC10（遅延ロード・開き直しで読まない・最新化で 1 回）と、
 * AC9 のうち段 B の分（読み中は 2 本目を出さない・足の切替で古い応答を捨てる・読み済みは要求しない）。値は架空。
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
    // 足の違う応答（サーバーの取り違え）
    expect(
      ivLoadReduce(a.state, { type: 'loaded', id: req.id, data: ivData('1d', dayBars) }).state,
    ).toBe(a.state);
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
    expect(ivLoadView(r.state)).toEqual({ entry: null, loading: false, failed: true });
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

/**
 * 過去の急落の再生の表示モデル（#307。ui/view/replay.ts）。板・日次の値は合成（架空の値）。
 */

import { describe, expect, it } from 'vitest';
import type { AtmDailyDay } from '../../data/atmDaily';
import { type ReplayEvent, replayPath } from '../../data/replay';
import {
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  type Leg,
  type MarginParams,
  preparePosition,
  replayDay,
} from '../../model';
import { HOLD_MAP_FAILED, HOLD_MAP_LOADING, HOLD_MAP_NO_CAPITAL } from '../../ui/view/holdMap';
import { pnlDomains } from '../../ui/view/pnlChart';
import {
  REPLAY_BROKEN,
  REPLAY_GAP_NOTE,
  REPLAY_NO_DATA,
  REPLAY_NO_LEGS,
  REPLAY_NO_RECOVERY_NONE,
  type ReplayPathOk,
  type ReplayRow,
  replayCalcOf,
  replayEventLine,
  replayHalfNote,
  replayInput,
  replayLevelNote,
  replayResultOf,
  replayStatusText,
  replaySummaryText,
  replayTableNotes,
  replayTableRows,
} from '../../ui/view/replay';
import { M1, M2, makeMarket, quoteOf } from '../support/market';

const { ctx, rows } = makeMarket();
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const PARAMS: MarginParams = { ...DEFAULT_MARGIN_PARAMS };

function putSell(month: string, k: number, qty = 2): Leg {
  const q = quoteOf(rows[month] ?? [], k, 'put');
  return {
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: month,
    strike: k,
    side: 'sell',
    qty,
    entry: q.bid,
    mid: q.mid,
  };
}

function baseOf(legs: readonly Leg[]) {
  const b = pnlDomains(board, preparePosition(legs, ctx), ctx, DEFAULT_SETTINGS);
  if (!b) throw new Error('基礎が作れない');
  return b;
}

const NOV = '2031-11-13'; // 架空の最終取引日
const DEC = '2031-12-11';
const JAN = '2032-01-15';

/** 架空の日次の値: 2031-11-03（月）から 10 取引日。下げて底を打ち、半値以上戻る。11-07 の値が欠ける */
function synthDays(): AtmDailyDay[] {
  const fs = [
    30000, 29100, 28200, 27000, /* 11-07 欠け */ 26100, 25500, 26400, 27300, 28200, 28500,
  ];
  const ds = [
    '2031-11-03',
    '2031-11-04',
    '2031-11-05',
    '2031-11-06',
    '2031-11-10',
    '2031-11-11',
    '2031-11-12',
    '2031-11-13',
    '2031-11-14',
    '2031-11-17',
  ];
  return ds.map((d, i) => {
    const f = fs[i] as number;
    const iv = 20 + (30000 - f) / 300;
    const roll = d >= '2031-11-14';
    return {
      d,
      t: Date.parse(`${d}T15:00:00+09:00`) / 1000,
      iv,
      f1: f,
      l1: roll ? DEC : NOV,
      f2: f + 5,
      l2: roll ? JAN : DEC,
      v1: iv * 1.1,
      v2: iv * 0.95,
    };
  });
}

const EV: ReplayEvent = { id: 'x', name: '架空の下げ', start: '2031-11-03', end: '2031-11-17' };

function okPath(): ReplayPathOk {
  const b = replayPath(synthDays(), EV, []);
  if (b.status !== 'ok') throw new Error(b.status);
  return b;
}

describe('replayInput', () => {
  it('板・足・資金が無ければ null', () => {
    const base = baseOf([putSell(M1.id, 62000)]);
    expect(replayInput(null, 'sticky_strike', PARAMS, 3e6, [])).toBeNull();
    expect(replayInput(base, 'sticky_strike', PARAMS, null, [])).toBeNull();
    expect(replayInput({ ...base, legs: [] }, 'sticky_strike', PARAMS, 3e6, [])).toBeNull();
    expect(replayInput(base, 'sticky_strike', PARAMS, 3e6, [])).not.toBeNull();
  });
});

describe('replayResultOf（日ごとの計算）', () => {
  const base = baseOf([putSell(M1.id, 64000), putSell(M2.id, 62000, 1)]);
  const input = replayInput(base, 'sticky_strike', PARAMS, 2_000_000, []);
  if (!input) throw new Error('入力が作れない');
  const path = okPath();

  it('実際の各日 = replayDay、戻らなかった道筋の底までは実際と同じ結果（同じ参照）', () => {
    const r = replayResultOf(input, path);
    const calc = replayCalcOf(input);
    expect(r.actual.length).toBe(path.actual.length);
    r.actual.forEach((row, i) => {
      expect(row.day).toBe(path.actual[i]);
      const want = replayDay(calc, row.day, path.actual[0] as (typeof path.actual)[0]);
      expect(row.res.room).toBe(want.room);
      expect(row.res.pnl).toBe(want.pnl);
    });
    expect(r.noRecovery).not.toBeNull();
    const nr = r.noRecovery as ReplayRow[];
    for (let i = 0; i <= path.bottom; i++) expect(nr[i]).toBe(r.actual[i]);
    expect(nr.length).toBe(path.noRecovery?.length);
    expect(nr.slice(path.bottom + 1).every((x) => x.day.cont)).toBe(true);
    expect(r.actualEnd).toBeNull();
    expect(r.noRecoveryEnd).toBeNull();
  });

  it('最も遠い足の SQ を過ぎた日で切る（ended の日は行に入れず、切った日を返す）', () => {
    const short = replayInput(baseOf([putSell(M1.id, 64000)]), 'sticky_strike', PARAMS, 2e6, []);
    if (!short) throw new Error('入力が作れない');
    // M1（30.5 日）より長い道筋: 25 取引日おきの架空の日
    const long: ReplayPathOk = {
      ...path,
      actual: path.actual.map((d, i) => ({ ...d, k: i * 3 })),
      noRecovery: null,
    };
    const r = replayResultOf(short, long);
    expect(r.actualEnd).not.toBeNull();
    expect(r.actual.length).toBeLessThan(long.actual.length);
    expect(r.actual.every((x) => Number.isFinite(x.res.pnl))).toBe(true);
    expect(replayTableNotes(r.actual, r.actualEnd).at(-1)).toContain('SQ');
  });
});

describe('表示モデル', () => {
  const path = okPath();

  it('状態の文: 足なし・資金なし・読み込み中・失敗（再試行）・データが無い・つながらない', () => {
    const o = { noLegs: false, noCapital: false, loadStatus: 'ok' as const, build: path };
    expect(replayStatusText({ ...o, noLegs: true }).main).toBe(REPLAY_NO_LEGS);
    expect(replayStatusText({ ...o, noCapital: true }).main).toBe(HOLD_MAP_NO_CAPITAL);
    expect(replayStatusText({ ...o, loadStatus: 'loading', build: null })).toEqual({
      main: HOLD_MAP_LOADING,
      retry: false,
      wait: true,
    });
    expect(replayStatusText({ ...o, loadStatus: 'failed', build: null })).toEqual({
      main: HOLD_MAP_FAILED,
      retry: true,
      wait: false,
    });
    expect(replayStatusText({ ...o, build: { status: 'no_data' } }).main).toBe(REPLAY_NO_DATA);
    expect(replayStatusText({ ...o, build: { status: 'broken', at: '2031-11-05' } }).main).toBe(
      `${REPLAY_BROKEN}（2031-11-05）`,
    );
    expect(replayStatusText(o).main).toBeNull();
  });

  it('出来事の 1 行・半値の注記', () => {
    const b = path.actual[path.bottom];
    expect(b?.d).toBe('2031-11-11');
    expect(replayEventLine(EV, path)).toBe(
      `2031-11-03 → 11-17 · 下げ −15.0%（底 11/11・${b?.k} 営業日目）`,
    );
    // 底 −15% の半分 = −7.5% 以上に戻った最初の日 = 11-13（−9%）ではなく 11-14（−6%）
    expect(replayHalfNote(path)).toBe(`底から 3 営業日で半値まで戻った（当時 11/14）`);
    expect(replayHalfNote({ ...path, half: null })).toBe('期間の中では半値まで戻っていない');
    // 始まりが底
    const after: ReplayPathOk = { ...path, bottom: 0, half: null, noRecovery: null };
    expect(replayHalfNote(after)).toBeNull();
    expect(replayEventLine(EV, after)).toMatch(/^2031-11-03 → 11-17 · 始まりが底 · 終わり −5\.0%$/);
  });

  const row = (k: number, room: number, pnl: number, extra: Partial<ReplayRow['day']> = {}) => ({
    day: {
      k,
      d: `2031-11-${String(3 + k).padStart(2, '0')}`,
      gap: 0,
      u: -0.01 * k,
      iv: 20,
      term: null,
      cont: false,
      ...extra,
    },
    res: { room, pnl, c: 1 + 0.1 * k, days: k, ended: false },
  });

  it('要約: 最初の追証の日（営業日目と当時の日付）・最も足りない額・最悪の損益・終わり・許容損失', () => {
    const rs: ReplayRow[] = [
      row(0, 500_000, 0),
      row(1, 100_000, -200_000),
      row(2, -50_000, -600_000),
      row(3, -300_000, -900_000),
      row(4, 20_000, -400_000),
    ];
    expect(replaySummaryText(rs, null, 'thousand', null)).toBe(
      '追証 2 営業日目（当時 11/5） · 最も足りない −300 · 最悪 −900（11/6） · 終わり −400（千円）',
    );
    expect(replaySummaryText(rs, null, 'thousand', 500_000)).toContain('許容損失超 2 営業日目');
    expect(replaySummaryText(rs, null, 'thousand', 5_000_000)).toContain('許容損失超なし');
    const ok = rs.map((r) => ({ ...r, res: { ...r.res, room: Math.abs(r.res.room) } }));
    expect(replaySummaryText(ok, 7, 'yen', null)).toBe(
      '追証なし（最小の余力 20,000） · 最悪 −900,000（11/6） · 終わり −400,000 · SQ で 7 営業日目に終わり（円）',
    );
    // 続落の日の追証は「続落」
    const cont = [row(0, 1, 0), row(3, -5, -7, { d: null, cont: true })];
    expect(replaySummaryText(cont, null, 'yen', null)).toContain('追証 3 営業日目（続落）');
    expect(replaySummaryText(null, null, 'yen', null)).toBe(REPLAY_NO_RECOVERY_NONE);
  });

  it('表の行: 追証の印・欠けた日の印・続落・倍率', () => {
    const rs: ReplayRow[] = [
      row(0, 1000, 0),
      row(2, -1000, -3000, { gap: 1 }),
      row(5, 2000, 500, { d: null, cont: true }),
    ];
    const t = replayTableRows(rs, 'yen');
    expect(t.map((r) => [r.k, r.date, r.call, r.tone, r.cont])).toEqual([
      ['0', '11/3', false, null, false],
      ['2*', '11/5', true, 'loss', false],
      ['5', '続落', false, null, true],
    ]);
    expect(t[1]?.u).toBe('−2.0%');
    expect(t[1]?.c).toBe('×1.20');
    expect(t[1]?.pnl).toBe('−3,000');
    expect(t[1]?.room).toBe('−1,000');
    expect(new Set(t.map((r) => r.key)).size).toBe(3);
    expect(replayTableNotes(rs, null)).toEqual([REPLAY_GAP_NOTE]);
    expect(replayTableNotes([rs[0] as ReplayRow], null)).toEqual([]);
  });

  it('合成の道筋の欠けた日（11-07）の行に印が付く', () => {
    const base = baseOf([putSell(M1.id, 64000)]);
    const input = replayInput(base, 'sticky_strike', PARAMS, 2e6, []);
    if (!input) throw new Error('入力が作れない');
    const r = replayResultOf(input, path);
    const t = replayTableRows(r.actual, 'thousand');
    expect(t.find((x) => x.date === '11/10')?.k).toBe('5*');
  });

  it('水準の注記: 当時の始まりの 30 日の IV と今の IV（無ければ当時だけ）、iv30 に戻した日数', () => {
    expect(replayLevelNote(path, 25.04)).toContain(
      '当時の始まりの 30 日の IV は 20.0%、今の 30 日の IV は 25.0%',
    );
    expect(replayLevelNote(path, null)).not.toContain('今の 30 日');
    expect(replayLevelNote({ ...path, iv30Days: 3 }, null)).toContain('3 日は 30 日の IV');
  });
});

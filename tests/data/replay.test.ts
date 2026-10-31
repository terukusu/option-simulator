/**
 * 過去の急落の再生（#307。設計 docs/design.md 5.14）の出来事の一覧と道筋の組み立て（data/replay.ts）。
 * 日次の値はすべて架空（F 30,000 前後・IV 20% 前後）。
 */

import { describe, expect, it } from 'vitest';
import type { AtmDailyDay } from '../../data/atmDaily';
import { buildCalendar } from '../../data/calendar';
import bundledJson from '../../data/calendar/calendar.json';
import {
  atmTermOf,
  REPLAY_DATA_FROM,
  REPLAY_DEFAULT_ID,
  REPLAY_EVENTS,
  type ReplayDay,
  type ReplayEvent,
  replayEventOf,
  replayPath,
} from '../../data/replay';
import { cmSqTime } from '../../model/constantMaturity';
import { DAY_MS } from '../../model/time';

const NOV = '2026-11-12'; // 架空の 11 月限の取引最終日
const DEC = '2026-12-10';
const JAN = '2027-01-14';
const FEB = '2027-02-10';

const day = (
  d: string,
  f1: number,
  l1: string,
  f2: number | null,
  l2: string | null,
  iv = 20,
  v1: number | null = 21,
  v2: number | null = 19,
): AtmDailyDay => ({
  d,
  t: Date.parse(`${d}T15:00:00+09:00`) / 1000,
  iv,
  f1,
  l1,
  f2,
  l2,
  v1,
  v2: l2 === null ? null : v2,
});

const NONE: string[] = [];
const ev = (start: string, end: string): ReplayEvent => ({ id: 'x', name: 'x', start, end });

describe('出来事の一覧（REPLAY_EVENTS）', () => {
  it('名前と日付（文字列）だけ・id は一意・始まり < 終わり・2018-10 以降', () => {
    expect(REPLAY_EVENTS.length).toBeGreaterThanOrEqual(6);
    expect(REPLAY_EVENTS.length).toBeLessThanOrEqual(8);
    const ids = new Set<string>();
    for (const e of REPLAY_EVENTS) {
      expect(Object.keys(e).sort()).toEqual(['end', 'id', 'name', 'start']);
      for (const v of Object.values(e)) expect(typeof v).toBe('string');
      expect(e.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.start < e.end).toBe(true);
      expect(e.start >= REPLAY_DATA_FROM).toBe(true);
      expect(REPLAY_DATA_FROM).toBe('2018-10-01');
      ids.add(e.id);
    }
    expect(ids.size).toBe(REPLAY_EVENTS.length);
  });
  it('始まりと終わりは取引日（同梱のカレンダー）', () => {
    const cal = buildCalendar(bundledJson, 'bundled');
    for (const e of REPLAY_EVENTS) {
      for (const d of [e.start, e.end]) {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        expect(dow !== 0 && dow !== 6 && !cal.nonTradingDays.has(d), `${e.id} ${d}`).toBe(true);
      }
    }
  });
  it('既定はコロナ・ショック。知らない id は既定', () => {
    expect(replayEventOf(undefined).id).toBe(REPLAY_DEFAULT_ID);
    expect(replayEventOf('nope').id).toBe(REPLAY_DEFAULT_ID);
    expect(replayEventOf('2024-08').id).toBe('2024-08');
    expect(REPLAY_DEFAULT_ID).toBe('2020-covid');
  });
});

describe('replayPath（道筋）', () => {
  // 2026-10-13（火）〜 10-23（金）。10-16（金）の値が欠ける。10-15 → 10-19 で 1 限月が 11 月限 → 12 月限に切り替わる
  // （架空の切り替え）。10-21 は 2 限月が null
  const DAYS: AtmDailyDay[] = [
    day('2026-10-13', 30000, NOV, 30010, DEC, 20),
    day('2026-10-14', 29400, NOV, 29405, DEC, 22),
    day('2026-10-15', 28500, NOV, 28520, DEC, 26),
    // 10-16 欠け
    day('2026-10-19', 28000, DEC, 28010, JAN, 30),
    day('2026-10-20', 27200, DEC, 27215, JAN, 33),
    day('2026-10-21', 27600, DEC, null, null, 31, 32, null),
    day('2026-10-22', 28100, DEC, 28100, JAN, 28, null, null),
    day('2026-10-23', 28900, DEC, 28910, JAN, 25),
  ];
  const E = ev('2026-10-13', '2026-10-23');

  it('原資産の累積 = 同じ限月のフォワードどうしの比の積（切り替わり・2 限月 null・欠けた日。1e−12）', () => {
    const r = replayPath(DAYS, E, NONE);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const ratios = [
      1,
      29400 / 30000,
      28500 / 29400,
      28000 / 28520, // 1 限月が前の日の 2 限月（欠けた日をまたぐ）
      27200 / 28000,
      27600 / 27200,
      28100 / 27600, // 前の日の 2 限月が null でも 1 限月が同じならつながる
      28900 / 28100,
    ];
    let acc = 1;
    r.actual.forEach((x, i) => {
      acc *= ratios[i] as number;
      expect(Math.abs(x.u - (acc - 1)), `${x.d}`).toBeLessThan(1e-12);
    });
    expect(r.actual.map((x) => x.k)).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
    expect(r.actual.map((x) => x.gap)).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
    expect(r.actual.every((x) => !x.cont && x.d !== null)).toBe(true);
  });

  it('始まり = 変化 0・底 = 累積の最小・半値 = 底の後に初めて底の半分まで戻った日', () => {
    const r = replayPath(DAYS, E, NONE);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.actual[0]?.u).toBe(0);
    const min = Math.min(...r.actual.map((x) => x.u));
    expect(r.bottom).toBe(4);
    expect(r.actual[r.bottom]?.u).toBe(min);
    const ub = min;
    const half = r.actual.findIndex((x, i) => i > r.bottom && x.u >= ub / 2);
    expect(r.half).toBe(half);
    expect(r.half).not.toBeNull();
  });

  it('戻らなかった道筋: 底まで実際と同じ、底の後の日数 = 始まり → 底、終わりの比 = 底の比の 2 乗、IV は底のまま', () => {
    const r = replayPath(DAYS, E, NONE);
    if (r.status !== 'ok' || !r.noRecovery) throw new Error('道筋が無い');
    const nr = r.noRecovery;
    const b = r.actual[r.bottom] as ReplayDay;
    for (let i = 0; i <= r.bottom; i++) expect(nr[i]).toBe(r.actual[i]);
    expect(nr.length).toBe(2 * r.bottom + 1);
    expect(r.actual.slice(1, r.bottom + 1).some((x) => x.gap > 0)).toBe(true);
    const last = nr[nr.length - 1] as ReplayDay;
    expect(last.k).toBe(2 * b.k);
    expect(Math.abs(1 + last.u - (1 + b.u) ** 2)).toBeLessThan(1e-12);
    for (let j = 1; j <= r.bottom; j++) {
      const x = nr[r.bottom + j] as ReplayDay;
      const s = r.actual[j] as ReplayDay;
      expect(x.cont).toBe(true);
      expect(x.d).toBeNull();
      expect(x.k).toBe(b.k + s.k);
      // 続落の行は当時の日付が無いので欠けた日の印を付けない（元の日 10-19 は欠けた日をまたぐ）
      expect(x.gap).toBe(0);
      expect(Math.abs(1 + x.u - (1 + b.u) * (1 + s.u))).toBeLessThan(1e-12);
      expect(x.iv).toBe(b.iv);
      expect(x.term).toBe(b.term);
    }
  });

  it('始まりが底（下げの後の区間）なら戻らなかった道筋・半値は無い', () => {
    const up = [
      day('2026-10-13', 27000, NOV, 27010, DEC),
      day('2026-10-14', 27400, NOV, 27410, DEC),
      day('2026-10-15', 27200, NOV, 27210, DEC),
    ];
    const r = replayPath(up, ev('2026-10-13', '2026-10-15'), NONE);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.bottom).toBe(0);
    expect(r.noRecovery).toBeNull();
    expect(r.half).toBeNull();
  });

  it('同じ限月がつながらない（限月が 2 つ進む欠け）は broken', () => {
    const bad = [
      day('2026-10-13', 30000, NOV, 30010, DEC),
      day('2026-10-14', 29000, JAN, 29010, FEB),
    ];
    expect(replayPath(bad, ev('2026-10-13', '2026-10-14'), NONE)).toEqual({
      status: 'broken',
      at: '2026-10-14',
    });
    // 前の日の 2 限月が null で 1 限月が変わる
    const bad2 = [
      day('2026-10-13', 30000, NOV, null, null),
      day('2026-10-14', 29000, DEC, 29010, JAN),
    ];
    expect(replayPath(bad2, ev('2026-10-13', '2026-10-14'), NONE).status).toBe('broken');
  });

  it('範囲の外 → no_data（例外を出さない）', () => {
    // 始まりの日の行が無い（データより前）
    expect(replayPath(DAYS, ev('2026-10-09', '2026-10-20'), NONE).status).toBe('no_data');
    // 始まりの日の行が欠けている
    expect(replayPath(DAYS, ev('2026-10-16', '2026-10-21'), NONE).status).toBe('no_data');
    // 終わりがデータの最後の日より後（まだ読めていない）
    expect(replayPath(DAYS, ev('2026-10-13', '2026-10-30'), NONE).status).toBe('no_data');
    // 2018-10 より前
    expect(replayPath(DAYS, ev('2018-09-03', '2026-10-20'), NONE).status).toBe('no_data');
    // 空
    expect(replayPath([], E, NONE).status).toBe('no_data');
    for (const e of REPLAY_EVENTS) expect(replayPath(DAYS, e, NONE).status).toBe('no_data');
  });

  it('取引日の数 k は休業日（nonTradingDays）と土日を飛ばす。欠けた日の数は gap', () => {
    const r = replayPath(DAYS, E, new Set(['2026-10-16']));
    if (r.status !== 'ok') throw new Error(r.status);
    // 10-16 が休業日なら欠けではない
    expect(r.actual.map((x) => x.gap)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.actual.map((x) => x.k)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('期間構造: t は終値の時刻から SQ（cmSqTime）までの暦日、v1 が無ければ null（iv30 の比に戻す日を数える）', () => {
    const d0 = DAYS[0] as AtmDailyDay;
    const term = atmTermOf(d0, new Set());
    const sq1 = cmSqTime(NOV, new Set()) as number;
    const sq2 = cmSqTime(DEC, new Set()) as number;
    expect(term).toEqual({
      t1: (sq1 - d0.t * 1000) / DAY_MS,
      v1: 21,
      t2: (sq2 - d0.t * 1000) / DAY_MS,
      v2: 19,
    });
    // 15:00 の終値から翌日 9:00 の SQ まで = 0.75 日の端数
    expect(Math.abs(((term?.t1 ?? 0) % 1) - 0.75)).toBeLessThan(1e-12);
    // 2 限月が null の日は t2・v2 が null
    expect(atmTermOf(DAYS[5] as AtmDailyDay, new Set())).toMatchObject({
      t2: null,
      v2: null,
      v1: 32,
    });
    const r = replayPath(DAYS, E, NONE);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.actual[6]?.term).toBeNull();
    expect(r.iv30Days).toBe(1);
    // 始まりの日の期間構造が無ければ全日を iv30 の比で当てる = 全行を数える
    const noTerm0 = [{ ...(DAYS[0] as AtmDailyDay), v1: null }, ...DAYS.slice(1)];
    const r0 = replayPath(noTerm0, E, NONE);
    if (r0.status !== 'ok') throw new Error(r0.status);
    expect(r0.iv30Days).toBe(r0.actual.length);
    // SQ まで 3 日未満の 1 限月で 2 限月が無い日（termIv が作れない。時刻だけ 12 月限の SQ の前々日にずらした架空の行）も数える
    const nearSq = DAYS.map((x) =>
      x.d === '2026-10-21' ? { ...x, t: Date.parse('2026-12-09T15:00:00+09:00') / 1000 } : x,
    );
    const r1 = replayPath(nearSq, E, NONE);
    if (r1.status !== 'ok') throw new Error(r1.status);
    expect(r1.actual[5]?.term?.t1).toBeLessThan(3);
    expect(r1.iv30Days).toBe(2);
    // v1・v2 のキーが無い（古いサーバー）日も null
    const { v1: _a, v2: _b, ...old } = d0;
    expect(atmTermOf(old, new Set())).toBeNull();
  });
});

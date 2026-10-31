/**
 * 過去の急落の再生（#307。設計 docs/design.md 5.14）の出来事の一覧と道筋の組み立て（純関数。DOM・通信に依存しない）。
 *
 * - 一覧はコードの定数で、名前と始まり・終わりの日付だけを持つ（値は持たない = JPX 由来の値をリポジトリに置かない）。
 *   値は `/api/atm_daily`（data/atmDaily.ts）で読み、底の日・半値まで戻った日は読み込んだ値から求める
 * - 原資産 = 同じ限月のフォワードどうしの日々の比をつないだ累積（atmMoves と同じ規則: 今日の 1 限月が前の行の 1 限月なら
 *   その f1、前の行の 2 限月ならその f2。どちらでもなければつながらない = broken）。値の欠けた取引日は飛ばし、
 *   飛ばした数を gap に持つ（当時の取引日の数 k は欠けた日も数える）
 * - ATM の期間構造（term）= その日の 1・2 限月の ATM IV（v1・v2）と SQ までの暦日（cmSqTime = optionchan の m*_days と
 *   同じ定義の SQ。終値の時刻からの暦日）。v1 が無ければ null（iv30 の比に戻す）
 * - 戻らなかった道筋: 底の日までは実際と同じ行。底の後は「始まり → 底」の日々の変化をもう一度（続落）。原資産は
 *   (1 + u_底)(1 + u_j) − 1、IV（term・iv）は底の日の値のまま。始まりが底（下げの後の区間）なら作れない（null）
 */

import { cmSqTime } from '../model/constantMaturity';
import { type AtmTerm, termIv } from '../model/replay';
import { DAY_MS, type Holidays, nextBusinessDay } from '../model/time';
import type { AtmDailyDay } from './atmDaily';

/** 出来事（名前と日付だけ。始まり = 下げの前の高値の日、終わり = 底の後に初めて半値まで戻った日。5.14） */
export interface ReplayEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD（含む） */
  start: string;
  /** YYYY-MM-DD（含む） */
  end: string;
}

/**
 * 出来事の一覧（選び方は設計 5.14: 2018-10 以降の日中の引けで、同じ限月のフォワードをつないだ原資産が 20 営業日以内に
 * 8% を超えて下げた区間から、下げ幅・IV の反応・年をばらして選んだ。コロナの山の後は、底からの IV のしぼみを見る区間）
 */
export const REPLAY_EVENTS: readonly ReplayEvent[] = [
  { id: '2018-12', name: '2018 年 12 月の下げ', start: '2018-12-03', end: '2019-01-25' },
  { id: '2020-covid', name: 'コロナ・ショック', start: '2020-02-20', end: '2020-04-30' },
  {
    id: '2020-after',
    name: 'コロナの山の後（IV がしぼむ）',
    start: '2020-03-19',
    end: '2020-04-30',
  },
  { id: '2022-q1', name: '2022 年 1〜3 月の下げ', start: '2022-01-05', end: '2022-03-22' },
  { id: '2024-08', name: '2024 年 8 月の急落', start: '2024-07-11', end: '2024-08-15' },
  { id: '2025-04', name: '2025 年 4 月の急落', start: '2025-03-26', end: '2025-04-18' },
  { id: '2026-03', name: '2026 年 3 月の下げ', start: '2026-02-27', end: '2026-04-08' },
  {
    id: '2026-07',
    name: '2026 年 7 月のじわ下げ（IV がほとんど上がらない）',
    start: '2026-07-01',
    end: '2026-08-05',
  },
];

/** 既定の出来事 */
export const REPLAY_DEFAULT_ID = '2020-covid';
/** 日次の値の始まり（これより前に始まる出来事は「データが無い」） */
export const REPLAY_DATA_FROM = '2018-10-01';

/** id の出来事（知らない id・未定義は既定） */
export function replayEventOf(id: string | undefined): ReplayEvent {
  return (
    REPLAY_EVENTS.find((e) => e.id === id) ??
    (REPLAY_EVENTS.find((e) => e.id === REPLAY_DEFAULT_ID) as ReplayEvent)
  );
}

/** 道筋の 1 日 */
export interface ReplayDay {
  /** 始まりからの当時の取引日の数（欠けた日も数える。始まり = 0） */
  k: number;
  /** 当時の日付（戻らなかった道筋の続落の部分は null） */
  d: string | null;
  /** 前の行との間に値の欠けた取引日の数（0 が普通） */
  gap: number;
  /** 原資産の累積の変化（比 − 1。始まり = 0） */
  u: number;
  /** その日の iv30（%） */
  iv: number;
  /** その日の ATM の期間構造（無ければ null = iv30 の比に戻す） */
  term: AtmTerm | null;
  /** 戻らなかった道筋の続落の部分 */
  cont: boolean;
}

export type ReplayBuild =
  | { status: 'no_data' }
  | { status: 'broken'; at: string }
  | {
      status: 'ok';
      actual: ReplayDay[];
      /** 戻らなかった道筋（始まりが底なら null） */
      noRecovery: ReplayDay[] | null;
      /** 底の行の添字（actual の中） */
      bottom: number;
      /** 底の後に初めて半値まで戻った行の添字（無ければ・始まりが底なら null） */
      half: number | null;
      /**
       * iv30 の比に戻した日の数（始まりの日を含む行の数）: 始まりの日の期間構造から倍率を作れなければ全行、作れれば
       * その日の期間構造から作れない行（v1 が無い・SQ まで 3 日未満の 1 限月で 2 限月が無いなど）
       */
      iv30Days: number;
    };

/** その日の ATM の期間構造（t は終値の時刻から SQ までの暦日） */
export function atmTermOf(day: AtmDailyDay, nonTradingDays: ReadonlySet<string>): AtmTerm | null {
  const v1 = day.v1 ?? null;
  if (v1 === null) return null;
  const at = day.t * 1000;
  const sq1 = cmSqTime(day.l1, nonTradingDays);
  if (sq1 === null) return null;
  const v2 = day.v2 ?? null;
  const sq2 = v2 !== null && day.l2 !== null ? cmSqTime(day.l2, nonTradingDays) : null;
  return {
    t1: (sq1 - at) / DAY_MS,
    v1,
    t2: sq2 === null ? null : (sq2 - at) / DAY_MS,
    v2: sq2 === null ? null : v2,
  };
}

/** 期間構造から倍率を作れるか（termIv が有限。作れなければ iv30 の比に戻す。model/replay.ts の replayIvRatio） */
function termUsable(term: AtmTerm | null): boolean {
  return term !== null && Number.isFinite(termIv(term, term.t1));
}

const toSet = (h: Holidays): ReadonlySet<string> =>
  h instanceof Set ? h : new Set(h as readonly string[]);

/**
 * 出来事の道筋。前提: days は検証済み（d の昇順・重複なし）。始まりの日の行が無い・終わりの日がデータの最後の日より
 * 後・始まりが REPLAY_DATA_FROM より前なら no_data（例外を出さない）。同じ限月がつながらない行があれば broken
 */
export function replayPath(
  days: readonly AtmDailyDay[],
  ev: ReplayEvent,
  nonTradingDays: Holidays,
): ReplayBuild {
  const holidays = toSet(nonTradingDays);
  const last = days[days.length - 1];
  if (ev.start < REPLAY_DATA_FROM || !last || last.d < ev.end) return { status: 'no_data' };
  const rows = days.filter((x) => x.d >= ev.start && x.d <= ev.end);
  const first = rows[0];
  if (!first || first.d !== ev.start) return { status: 'no_data' };
  const actual: ReplayDay[] = [];
  let k = 0;
  let u = 0;
  let prev: AtmDailyDay | null = null;
  let iv30Days = 0;
  for (const row of rows) {
    let gap = 0;
    if (prev) {
      const f0 =
        row.l1 === prev.l1 ? prev.f1 : prev.l2 !== null && row.l1 === prev.l2 ? prev.f2 : null;
      if (f0 === null) return { status: 'broken', at: row.d };
      u = (1 + u) * (row.f1 / f0) - 1;
      let n = 0;
      let x = prev.d;
      while (x < row.d) {
        x = nextBusinessDay(x, holidays);
        n++;
      }
      k += n;
      gap = n - 1;
    }
    const term = atmTermOf(row, holidays);
    actual.push({ k, d: row.d, gap, u, iv: row.iv, term, cont: false });
    prev = row;
  }
  const day0Ok = termUsable((actual[0] as ReplayDay).term);
  for (const x of actual) if (!day0Ok || !termUsable(x.term)) iv30Days++;
  let bottom = 0;
  actual.forEach((x, i) => {
    if (x.u < (actual[bottom] as ReplayDay).u) bottom = i;
  });
  const b = actual[bottom] as ReplayDay;
  let half: number | null = null;
  if (bottom > 0) {
    for (let i = bottom + 1; i < actual.length; i++) {
      if ((actual[i] as ReplayDay).u >= b.u / 2) {
        half = i;
        break;
      }
    }
  }
  let noRecovery: ReplayDay[] | null = null;
  if (bottom > 0) {
    noRecovery = actual.slice(0, bottom + 1);
    for (let j = 1; j <= bottom; j++) {
      const s = actual[j] as ReplayDay;
      noRecovery.push({
        k: b.k + s.k,
        d: null,
        // 続落の行は当時の日付が無いので欠けた日の印を付けない
        gap: 0,
        u: (1 + b.u) * (1 + s.u) - 1,
        iv: b.iv,
        term: b.term,
        cont: true,
      });
    }
  }
  return { status: 'ok', actual, noRecovery, bottom, half, iv30Days };
}

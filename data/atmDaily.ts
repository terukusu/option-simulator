/**
 * 日次の値（optionchan の atm_cm_iv の日中の終値の iv30 と 1 / 2 限月のフォワード。#152）の `/api/atm_daily` の JSON の
 * 型と検証、2 営業日の動きの組（追証マップの過去の点）。設計 docs/design.md 7.1・13.4。読み込みは
 * data/adapter.ts の loadAtmDaily。
 *
 * - 応答: `{ schema_version: 1, start, end, days: [{ d, t, iv, f1, l1, f2, l2, v1, v2 }] }`（d は JST の日付、t は日中の
 *   終値の行の時刻（ISO 8601 のオフセット付き）、iv は %、f1 / f2 は 1 / 2 限月のフォワード、l1 / l2 はその最終取引日。f2・l2
 *   は両方 null か両方値。v1 / v2 は 1 / 2 限月の ATM IV %（#307。無い・null・有限の正の数でなければ null に読む = エラーに
 *   しない。古いサーバーの応答にはキーが無い）。サーバーは api/src/simulator_api/atm_daily.py の atm_daily_json
 * - 2 営業日の組はブラウザで作る（計算はブラウザの原則）。休業日は取引カレンダーの nonTradingDays（is_trading_day = false。
 *   祝日取引の実施日は取引日）と土日
 * - 純関数（DOM・通信に依存しない）
 */

import { MARGIN_HORIZON_BUSINESS_DAYS } from '../model/margin';
import { type Holidays, isBusinessDay, nextBusinessDay } from '../model/time';
import { isIsoDate, isIsoInstant } from './calendar';
import type { ValidationResult } from './chainJson';

export const ATM_DAILY_SCHEMA_VERSION = 1;

/** 1 日の値（t = 日中の終値の行の UNIX 秒。iv は %） */
export interface AtmDailyDay {
  d: string;
  t: number;
  iv: number;
  f1: number;
  l1: string;
  f2: number | null;
  l2: string | null;
  /**
   * 1 / 2 限月の ATM IV（%。#307 の再生の倍率）。検証は常に値か null を入れる（省略可は合成の値・テストの literal のため。
   * 無いのは null と同じ）
   */
  v1?: number | null;
  v2?: number | null;
}

/** 検証済みの応答（start・end は日付。end は含まない = 確定した日の次の日） */
export interface AtmDailyData {
  start: string;
  end: string;
  /** d の昇順・重複なし */
  days: AtmDailyDay[];
}

/** 2 営業日の動き（dx・ivRatio は比 = −0.05 は −5%・1.2 は ×1.2、ivPt は % の pt） */
export interface AtmMove {
  d0: string;
  d1: string;
  dx: number;
  iv0: number;
  iv1: number;
  ivRatio: number;
  ivPt: number;
}

const MAX_ERRORS = 50;

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** `/api/atm_daily` の JSON の形の検査。余分なキーは見ない。v1・v2 は不正でもエラーにせず null（#307） */
export function validateAtmDailyJson(v: unknown): ValidationResult<AtmDailyData> {
  const errors: string[] = [];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: ['$: オブジェクトでない'] };
  }
  const o = v as Record<string, unknown>;
  if (o.schema_version !== ATM_DAILY_SCHEMA_VERSION) {
    add('$.schema_version', `${ATM_DAILY_SCHEMA_VERSION} でない`);
  }
  if (!isIsoDate(o.start)) add('$.start', '実在する YYYY-MM-DD でない');
  if (!isIsoDate(o.end)) add('$.end', '実在する YYYY-MM-DD でない');
  if (isIsoDate(o.start) && isIsoDate(o.end) && !(o.start < o.end))
    add('$.end', 'start より後でない');
  const days: AtmDailyDay[] = [];
  if (!Array.isArray(o.days)) add('$.days', '配列でない');
  else {
    let prev: string | null = null;
    o.days.forEach((x, i) => {
      const p = `$.days[${i}]`;
      if (typeof x !== 'object' || x === null || Array.isArray(x)) {
        add(p, 'オブジェクトでない');
        return;
      }
      const r = x as Record<string, unknown>;
      if (!isIsoDate(r.d)) {
        add(`${p}.d`, '実在する YYYY-MM-DD でない');
        return;
      }
      if (prev !== null && r.d <= prev) add(`${p}.d`, `昇順でない・重複（前は ${prev}）`);
      prev = r.d;
      let bad = false;
      if (!isIsoInstant(r.t)) {
        add(`${p}.t`, 'ISO 8601 の日時でない');
        bad = true;
      }
      if (!positive(r.iv)) {
        add(`${p}.iv`, '有限の正の数でない');
        bad = true;
      }
      if (!positive(r.f1)) {
        add(`${p}.f1`, '有限の正の数でない');
        bad = true;
      }
      if (!isIsoDate(r.l1)) {
        add(`${p}.l1`, '実在する YYYY-MM-DD でない');
        bad = true;
      }
      const pair = r.f2 === null && r.l2 === null;
      if (!pair && !(positive(r.f2) && isIsoDate(r.l2))) {
        add(p, 'f2・l2 が両方 null か、有限の正の数と YYYY-MM-DD でない');
        bad = true;
      }
      if (bad) return;
      days.push({
        d: r.d,
        t: Math.floor(Date.parse(r.t as string) / 1000),
        iv: r.iv as number,
        f1: r.f1 as number,
        l1: r.l1 as string,
        f2: pair ? null : (r.f2 as number),
        l2: pair ? null : (r.l2 as string),
        // 緩い検証（#307）: 無い・不正は null（追証マップ・AI の IV の統計の読み込みを落とさない）
        v1: positive(r.v1) ? r.v1 : null,
        v2: !pair && positive(r.v2) ? r.v2 : null,
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { start: o.start as string, end: o.end as string, days } };
}

/**
 * 2 営業日の動きの組（d0 の昇順）。d0 が取引日（土日でなく nonTradingDays に無い）で、d1 = d0 の n 営業日後の行が
 * あるときだけ組む。原資産は同じ限月のフォワードどうし: d1 の 1 限月が d0 の 1 限月と同じなら f1(d0)、d0 の 2 限月と
 * 同じならその f2(d0)、どちらでもなければ組まない（0 にしない）。dx = f1(d1) / f0 − 1、ivRatio = iv1 / iv0、ivPt = iv1 − iv0。
 * 前提: days は検証済み（d の昇順・重複なし）。
 */
export function atmMoves(
  days: readonly AtmDailyDay[],
  nonTradingDays: Holidays,
  n: number = MARGIN_HORIZON_BUSINESS_DAYS,
): AtmMove[] {
  const holidays: ReadonlySet<string> =
    nonTradingDays instanceof Set ? nonTradingDays : new Set(nonTradingDays as readonly string[]);
  const byDate = new Map(days.map((x) => [x.d, x]));
  const out: AtmMove[] = [];
  for (const a of days) {
    if (!isBusinessDay(a.d, holidays)) continue;
    let d1 = a.d;
    for (let i = 0; i < n; i++) d1 = nextBusinessDay(d1, holidays);
    const b = byDate.get(d1);
    if (!b) continue;
    const f0 = b.l1 === a.l1 ? a.f1 : a.l2 !== null && b.l1 === a.l2 ? a.f2 : null;
    if (f0 === null) continue;
    out.push({
      d0: a.d,
      d1,
      dx: b.f1 / f0 - 1,
      iv0: a.iv,
      iv1: b.iv,
      ivRatio: b.iv / a.iv,
      ivPt: b.iv - a.iv,
    });
  }
  return out;
}

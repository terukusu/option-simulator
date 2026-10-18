/**
 * 取引カレンダー（`/api/calendar` の版 = optionchan の trading_calendar_latest）。設計 docs/design.md 5.2・7.5。
 *
 * - `/api/calendar` の JSON（同梱の版 data/calendar/calendar.json も同じ形）の形を検証し、
 *   SQ 日・取引最終日の判定に使う休業日の集合（版の全行。is_trading_day を問わない。土日は model/time.ts が
 *   常に休業日扱い）と「確定の最終日」（covered_until）を作る
 * - 壊れていても例外を出さない（ok = false、休業日なし = 土日だけ、期限切れ扱い）
 * - 純関数。同梱の JSON の import は ui/calendar.ts だけ、API の読み込みは data/adapter.ts
 */

import { secondFriday } from '../model/time';
import type { ValidationResult } from './chainJson';

export const CALENDAR_SCHEMA_VERSION = 1;

/** 版の 1 行（平日の休業日・祝日取引の実施日など。土日は入らないこともある） */
export interface CalendarDayJson {
  date: string;
  /** 取引日か（祝日取引の実施日は true。SQ 日・取引最終日の判定では問わない） */
  is_trading_day: boolean;
  /** confirmed / planned など（値は問わない） */
  status: string;
  name: string;
}

/** `/api/calendar` の応答（api/src/simulator_api/calendar.py の calendar_json） */
export interface CalendarJson {
  schema_version: 1;
  /** 取得元（"bigquery"。検証しない） */
  source?: unknown;
  /** 版の日時（ISO 8601、オフセットつき） */
  version_at: string;
  /** 休業日を確定で書いた最終日（YYYY-MM-DD） */
  covered_until: string;
  /** 掲載の最終日（YYYY-MM-DD） */
  listed_until: string;
  /** 版の全行（日付の昇順・重複なし） */
  days: CalendarDayJson[];
}

/** 版の出どころ: API から読んだ版か、ビルドに同梱した版か */
export type CalendarOrigin = 'api' | 'bundled';

export interface Calendar {
  /** 形の検査に通った */
  ok: boolean;
  errors: string[];
  /** SQ 日・取引最終日の判定に使う休業日 = 版の全行の date（is_trading_day を問わない。壊れていれば空） */
  holidays: ReadonlySet<string>;
  /**
   * 取引の無い平日 = 版の is_trading_day = false の日（IV 推移の日足・欠けの判定。#79。optionchan のビューアーの
   * trading_holidays と同じ集合。祝日取引の実施日は入らない。壊れていれば空 = 土日だけ）
   */
  nonTradingDays: ReadonlySet<string>;
  /** 確定の最終日 = covered_until（期限切れ・「休業日未確定」の判定。壊れていれば null） */
  coveredUntil: string | null;
  /** 掲載の最終日 = listed_until */
  listedUntil: string | null;
  /** 版の日時（version_at。同じ版かの比較に使う） */
  versionAt: string | null;
  /** 版の日付（version_at の JST の日付。ヘッダに出す） */
  versionOn: string | null;
  origin: CalendarOrigin;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const JST_OFFSET_MS = 9 * 3_600_000;
const MAX_ERRORS = 50;

/** 実在する YYYY-MM-DD か。 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** epoch ミリ秒の JST の暦日（YYYY-MM-DD）。 */
export function jstDate(t: number): string {
  return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

class Errors {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    if (this.list.length < MAX_ERRORS) this.list.push(`${path}: ${msg}`);
  }
}

function asObject(v: unknown, path: string, e: Errors): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    e.add(path, 'オブジェクトでない');
    return null;
  }
  return v as Record<string, unknown>;
}

/** 日付の配列が実在の日付で厳密に昇順（重複なし）か。 */
function checkAscendingDates(dates: unknown[], path: (i: number) => string, e: Errors): void {
  let prev: string | null = null;
  dates.forEach((d, i) => {
    if (!isIsoDate(d)) {
      e.add(path(i), '実在する YYYY-MM-DD でない');
      return;
    }
    if (prev !== null && d <= prev) e.add(path(i), `昇順でない・重複（前は ${prev}）`);
    prev = d;
  });
}

/** ISO 8601 の日時（オフセットつき）か。日付の部分は実在の日、時刻は 00:00〜23:59（:60 は不可）。 */
export function isIsoInstant(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_INSTANT.test(v) || !isIsoDate(v.slice(0, 10))) return false;
  const hh = Number(v.slice(11, 13));
  const mm = Number(v.slice(14, 16));
  const ss = v[16] === ':' ? Number(v.slice(17, 19)) : 0;
  const off = /([+-])(\d{2}):(\d{2})$/.exec(v);
  if (off && (Number(off[2]) > 23 || Number(off[3]) > 59)) return false;
  return hh <= 23 && mm <= 59 && ss <= 59 && Number.isFinite(Date.parse(v));
}

/** `/api/calendar` の JSON の形の検査。status の値・source・余分なキーは見ない。 */
export function validateCalendarJson(v: unknown): ValidationResult<CalendarJson> {
  const e = new Errors();
  const o = asObject(v, '$', e);
  if (o) {
    if (o.schema_version !== CALENDAR_SCHEMA_VERSION) {
      e.add('$.schema_version', `${CALENDAR_SCHEMA_VERSION} でない`);
    }
    if (!isIsoInstant(o.version_at)) e.add('$.version_at', 'ISO 8601 の日時でない');
    if (!isIsoDate(o.covered_until)) e.add('$.covered_until', '実在する YYYY-MM-DD でない');
    if (!isIsoDate(o.listed_until)) e.add('$.listed_until', '実在する YYYY-MM-DD でない');
    if (!Array.isArray(o.days)) e.add('$.days', '配列でない');
    else {
      const dates: unknown[] = [];
      o.days.forEach((d, i) => {
        const p = `$.days[${i}]`;
        const x = asObject(d, p, e);
        dates.push(x?.date);
        if (!x) return;
        if (typeof x.is_trading_day !== 'boolean') e.add(`${p}.is_trading_day`, 'boolean でない');
        if (typeof x.status !== 'string' || x.status === '') {
          e.add(`${p}.status`, '空でない文字列でない');
        }
        if (typeof x.name !== 'string') e.add(`${p}.name`, '文字列でない');
      });
      checkAscendingDates(dates, (i) => `$.days[${i}].date`, e);
    }
  }
  return e.list.length === 0
    ? { ok: true, value: v as CalendarJson }
    : { ok: false, errors: e.list };
}

/** `/api/calendar` の形の JSON から画面で使うカレンダーを作る。壊れていても例外を出さない。 */
export function buildCalendar(json: unknown, origin: CalendarOrigin): Calendar {
  const r = validateCalendarJson(json);
  if (!r.ok) {
    return {
      ok: false,
      errors: r.errors,
      holidays: new Set(),
      nonTradingDays: new Set(),
      coveredUntil: null,
      listedUntil: null,
      versionAt: null,
      versionOn: null,
      origin,
    };
  }
  const v = r.value;
  return {
    ok: true,
    errors: [],
    holidays: new Set(v.days.map((d) => d.date)),
    nonTradingDays: new Set(v.days.filter((d) => !d.is_trading_day).map((d) => d.date)),
    coveredUntil: v.covered_until,
    listedUntil: v.listed_until,
    versionAt: v.version_at,
    versionOn: jstDate(Date.parse(v.version_at)),
    origin,
  };
}

/**
 * その限月の SQ 日・取引最終日が確定した休業日で求まるか。SQ 日・取引最終日の決定に使う日は
 * すべて第 2 金曜以前なので、第 2 金曜が確定の最終日（covered_until）以前なら両方確定（設計 7.5）。
 */
export function isExpiryConfirmed(cal: Calendar, year: number, month: number): boolean {
  return cal.ok && cal.coveredUntil !== null && secondFriday(year, month) <= cal.coveredUntil;
}

/** 評価時刻（epoch ミリ秒）の JST の日付が covered_until より後なら期限切れ。壊れていれば期限切れ。 */
export function isCalendarExpired(cal: Calendar, evalTime: number): boolean {
  if (!cal.ok || cal.coveredUntil === null) return true;
  return jstDate(evalTime) > cal.coveredUntil;
}

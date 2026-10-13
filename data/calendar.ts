/**
 * 取引カレンダー（optionchan から同期）と国民の祝日の一覧。設計 docs/design.md 5.2・7.5。
 *
 * - 同期した JSON（data/calendar/*.json。`npm run calendar:sync` が書く生成物）の形を検証し、
 *   SQ 日・取引最終日の判定に使う休業日の集合（closed_dates ∪ 祝日。土日は model/time.ts が常に休業日扱い）と
 *   「確定の最終日」（2 つの covered_until の早い方）を作る
 * - 壊れていても例外を出さない（ok = false、休業日なし = 土日だけ、期限切れ扱い）
 * - 純関数。JSON の import は ui/calendar.ts だけ（同期スクリプトも書く前にここの検証を通す）
 */

import { secondFriday } from '../model/time';
import type { ValidationResult } from './chainJson';

export const CALENDAR_SCHEMA_VERSION = 1;

export interface CalendarSource {
  /** 取得元の名前（URL は入れない） */
  name: string;
  /** 取得した内容（バイト列）の SHA-256（16 進 64 桁） */
  sha256: string;
  /** 取得日時（ISO 8601） */
  fetched_at: string;
}

/** data/calendar/trading_calendar.json（optionchan の config/trading_calendar.toml から） */
export interface TradingCalendarJson {
  schema_version: 1;
  source: CalendarSource;
  /** 休業日を漏れなく書いた最終日（YYYY-MM-DD） */
  covered_until: string;
  /** 平日の休業日（昇順・重複なし。covered_until より後の「予定」の日も含む） */
  closed_dates: string[];
}

export interface HolidayEntry {
  date: string;
  name: string;
}

/** data/calendar/holidays_jp.json（内閣府「国民の祝日」の CSV から） */
export interface HolidaysJson {
  schema_version: 1;
  source: CalendarSource;
  /** 収録の最終日（CSV の最終年の 12/31） */
  covered_until: string;
  /** 祝日（振替休日・国民の休日を含む。昇順・重複なし） */
  holidays: HolidayEntry[];
}

export interface Calendar {
  /** 2 つの JSON がどちらも形の検査に通った */
  ok: boolean;
  errors: string[];
  /** SQ 日・取引最終日の判定に使う休業日（closed_dates ∪ 祝日。壊れていれば空） */
  holidays: ReadonlySet<string>;
  /** 取引カレンダーの covered_until（期限切れの判定） */
  coveredUntil: string | null;
  /** 確定の最終日 = 取引カレンダーと祝日の一覧の covered_until の早い方 */
  confirmedUntil: string | null;
  /** 取引カレンダーを同期した日（fetched_at の JST の日付） */
  syncedOn: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/;
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

function checkHeader(o: Record<string, unknown>, e: Errors): void {
  if (o.schema_version !== CALENDAR_SCHEMA_VERSION) {
    e.add('$.schema_version', `${CALENDAR_SCHEMA_VERSION} でない`);
  }
  const s = asObject(o.source, '$.source', e);
  if (s) {
    if (typeof s.name !== 'string' || s.name === '') e.add('$.source.name', '空でない文字列でない');
    if (typeof s.sha256 !== 'string' || !SHA256.test(s.sha256)) {
      e.add('$.source.sha256', '16 進 64 桁でない');
    }
    if (
      typeof s.fetched_at !== 'string' ||
      !ISO_INSTANT.test(s.fetched_at) ||
      !Number.isFinite(Date.parse(s.fetched_at))
    ) {
      e.add('$.source.fetched_at', 'ISO 8601 の日時でない');
    }
  }
  if (!isIsoDate(o.covered_until)) e.add('$.covered_until', '実在する YYYY-MM-DD でない');
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

export function validateTradingCalendarJson(v: unknown): ValidationResult<TradingCalendarJson> {
  const e = new Errors();
  const o = asObject(v, '$', e);
  if (o) {
    checkHeader(o, e);
    if (!Array.isArray(o.closed_dates)) e.add('$.closed_dates', '配列でない');
    else checkAscendingDates(o.closed_dates, (i) => `$.closed_dates[${i}]`, e);
  }
  return e.list.length === 0
    ? { ok: true, value: v as TradingCalendarJson }
    : { ok: false, errors: e.list };
}

export function validateHolidaysJson(v: unknown): ValidationResult<HolidaysJson> {
  const e = new Errors();
  const o = asObject(v, '$', e);
  if (o) {
    checkHeader(o, e);
    if (!Array.isArray(o.holidays)) e.add('$.holidays', '配列でない');
    else {
      const dates: unknown[] = [];
      o.holidays.forEach((h, i) => {
        const ho = asObject(h, `$.holidays[${i}]`, e);
        dates.push(ho?.date);
        if (ho && (typeof ho.name !== 'string' || ho.name === '')) {
          e.add(`$.holidays[${i}].name`, '空でない文字列でない');
        }
      });
      checkAscendingDates(dates, (i) => `$.holidays[${i}].date`, e);
    }
  }
  return e.list.length === 0
    ? { ok: true, value: v as HolidaysJson }
    : { ok: false, errors: e.list };
}

/** 2 つの JSON から画面で使うカレンダーを作る。壊れていても例外を出さない。 */
export function buildCalendar(trading: unknown, holidays: unknown): Calendar {
  const t = validateTradingCalendarJson(trading);
  const h = validateHolidaysJson(holidays);
  if (!t.ok || !h.ok) {
    return {
      ok: false,
      errors: [
        ...(t.ok ? [] : t.errors.map((x) => `trading_calendar.json ${x}`)),
        ...(h.ok ? [] : h.errors.map((x) => `holidays_jp.json ${x}`)),
      ],
      holidays: new Set(),
      coveredUntil: null,
      confirmedUntil: null,
      syncedOn: null,
    };
  }
  const set = new Set<string>(t.value.closed_dates);
  for (const x of h.value.holidays) set.add(x.date);
  const a = t.value.covered_until;
  const b = h.value.covered_until;
  return {
    ok: true,
    errors: [],
    holidays: set,
    coveredUntil: a,
    confirmedUntil: a < b ? a : b,
    syncedOn: jstDate(Date.parse(t.value.source.fetched_at)),
  };
}

/**
 * その限月の SQ 日・取引最終日が確定した休業日で求まるか。SQ 日・取引最終日の決定に使う日は
 * すべて第 2 金曜以前なので、第 2 金曜が確定の最終日以前なら両方確定（設計 7.5）。
 */
export function isExpiryConfirmed(cal: Calendar, year: number, month: number): boolean {
  return cal.ok && cal.confirmedUntil !== null && secondFriday(year, month) <= cal.confirmedUntil;
}

/** 評価時刻（epoch ミリ秒）の JST の日付が covered_until より後なら期限切れ。壊れていれば期限切れ。 */
export function isCalendarExpired(cal: Calendar, evalTime: number): boolean {
  if (!cal.ok || cal.coveredUntil === null) return true;
  return jstDate(evalTime) > cal.coveredUntil;
}

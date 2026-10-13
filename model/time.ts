/**
 * 時間: SQ 日・取引最終日・満期までの年数 T。設計 docs/design.md 3 章・5.2。
 *
 * - SQ 日 = その月の第 2 金曜。休業日なら前営業日へ順次繰り上げ
 * - 取引最終日 = SQ 日の前営業日
 * - T = (SQ 日 09:00 JST − 評価時刻) / 365 日（暦日）
 * - T ≤ T_min（1 分）は本源的価値に切り替える
 *
 * 日付は 'YYYY-MM-DD'（JST の暦日）、時刻は epoch ミリ秒。休業日の一覧は引数で受け取る
 * （一次情報は optionchan の config/trading_calendar.toml。設計 7.5）。土日は常に休業日。
 */

export const DAY_MS = 86_400_000;
export const YEAR_MS = 365 * DAY_MS;
/** T_min = 1 分（年） */
export const T_MIN_YEARS = 60_000 / YEAR_MS;

const JST_OFFSET_MS = 9 * 3_600_000;

export type Holidays = ReadonlySet<string> | readonly string[];

function toSet(h: Holidays): ReadonlySet<string> {
  return h instanceof Set ? h : new Set(h as readonly string[]);
}

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`日付の形式が不正: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatDate(utcMidnight: number): string {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function isBusinessDay(date: string, holidays: Holidays): boolean {
  const dow = new Date(parseDate(date)).getUTCDay();
  return dow !== 0 && dow !== 6 && !toSet(holidays).has(date);
}

export function previousBusinessDay(date: string, holidays: Holidays): string {
  const set = toSet(holidays);
  let d = addDays(date, -1);
  while (!isBusinessDay(d, set)) d = addDays(d, -1);
  return d;
}

export function nextBusinessDay(date: string, holidays: Holidays): string {
  const set = toSet(holidays);
  let d = addDays(date, 1);
  while (!isBusinessDay(d, set)) d = addDays(d, 1);
  return d;
}

/** その月の第 2 金曜（month は 1〜12）。 */
export function secondFriday(year: number, month: number): string {
  const first = Date.UTC(year, month - 1, 1);
  const dow = new Date(first).getUTCDay();
  const firstFriday = 1 + ((5 - dow + 7) % 7);
  return formatDate(Date.UTC(year, month - 1, firstFriday + 7));
}

/** SQ 日: 第 2 金曜。休業日なら前営業日へ繰り上げ。 */
export function sqDate(year: number, month: number, holidays: Holidays): string {
  const set = toSet(holidays);
  let d = secondFriday(year, month);
  while (!isBusinessDay(d, set)) d = addDays(d, -1);
  return d;
}

/** 取引最終日: SQ 日の前営業日。 */
export function lastTradingDay(year: number, month: number, holidays: Holidays): string {
  return previousBusinessDay(sqDate(year, month, holidays), holidays);
}

/** JST の暦日 date の hh:mm を epoch ミリ秒に。 */
export function jstInstant(date: string, hour: number, minute = 0): number {
  return parseDate(date) + hour * 3_600_000 + minute * 60_000 - JST_OFFSET_MS;
}

/** SQ 日 09:00 JST（T の終端）。 */
export function sqInstant(sq: string): number {
  return jstInstant(sq, 9, 0);
}

/** 取引最終日 15:45 JST（日中のクロージング）。 */
export function lastTradingCloseInstant(ltd: string): number {
  return jstInstant(ltd, 15, 45);
}

/** 評価時刻から満期時刻までの年数（暦日 / 365）。過ぎていれば負。 */
export function yearFraction(evalTime: number, expiryTime: number): number {
  return (expiryTime - evalTime) / YEAR_MS;
}

/** 評価時刻を target に置くための経過日数 d（小数）。「SQ 日 9:00」「取引最終日 15:45」のボタン用。 */
export function daysUntil(evalTime: number, target: number): number {
  return (target - evalTime) / DAY_MS;
}

/** シナリオの経過日数 d を引いた T' = T − d / 365。 */
export function shiftT(T: number, days: number): number {
  return T - days / 365;
}

export interface MonthlyExpiry {
  /** 'YYYY-MM' */
  id: string;
  year: number;
  month: number;
  sqDate: string;
  lastTradingDay: string;
  /** SQ 日 09:00 JST の epoch ミリ秒 */
  sqTime: number;
}

export function monthlyExpiry(year: number, month: number, holidays: Holidays): MonthlyExpiry {
  const set = toSet(holidays);
  const sq = sqDate(year, month, set);
  return {
    id: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    sqDate: sq,
    lastTradingDay: previousBusinessDay(sq, set),
    sqTime: sqInstant(sq),
  };
}

/**
 * from（epoch ミリ秒）以降に SQ（9:00）を迎える月次限月を count 本（設計 5.7: 先の月次限月、最長 12 か月）。
 */
export function upcomingMonthlyExpiries(
  from: number,
  count: number,
  holidays: Holidays,
): MonthlyExpiry[] {
  const set = toSet(holidays);
  const jst = new Date(from + JST_OFFSET_MS);
  let year = jst.getUTCFullYear();
  let month = jst.getUTCMonth() + 1;
  const out: MonthlyExpiry[] = [];
  while (out.length < count) {
    const e = monthlyExpiry(year, month, set);
    if (e.sqTime > from) out.push(e);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

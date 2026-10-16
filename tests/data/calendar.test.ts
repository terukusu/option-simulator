import { describe, expect, it } from 'vitest';
import {
  buildCalendar,
  isCalendarExpired,
  isExpiryConfirmed,
  validateCalendarJson,
} from '../../data/calendar';
import bundledJson from '../../data/calendar/calendar.json';
import {
  isBusinessDay,
  jstInstant,
  lastTradingDay,
  monthlyExpiry,
  nextBusinessDay,
  secondFriday,
  sqDate,
} from '../../model/time';
import { RAW_FIXTURES } from '../support/fixtures';

/**
 * #39: 取引カレンダー（`/api/calendar` の形。同梱の版 data/calendar/calendar.json も同じ形）。
 * 板の値は合成の固定 JSON（架空の値）。テストの版の日付は公開の祝日・休業日。
 */

const cal = buildCalendar(bundledJson, 'bundled');

/** 架空の版（`/api/calendar` の形。日付は公開の祝日・休業日） */
function synthCalendar(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    source: 'bigquery',
    version_at: '2026-10-14T08:30:00+09:00',
    covered_until: '2027-06-30',
    listed_until: '2027-12-31',
    days: [
      { date: '2026-12-31', is_trading_day: false, status: 'confirmed', name: '年末休業日' },
      { date: '2027-01-01', is_trading_day: false, status: 'confirmed', name: '元日' },
      { date: '2027-02-11', is_trading_day: true, status: 'confirmed', name: '建国記念の日' },
    ],
    ...over,
  };
}

const day = (date: unknown, over: Record<string, unknown> = {}) => ({
  date,
  is_trading_day: false,
  status: 'confirmed',
  name: '休業日',
  ...over,
});

describe('AC-1: validateCalendarJson・buildCalendar（検証）', () => {
  it('(a) 正しい版 → ok = true、休業日 = 全行、確定 = covered_until、掲載 = listed_until、版の日付', () => {
    const c = buildCalendar(synthCalendar(), 'api');
    expect(c.ok).toBe(true);
    expect(c.errors).toEqual([]);
    expect([...c.holidays]).toEqual(['2026-12-31', '2027-01-01', '2027-02-11']);
    expect(c.coveredUntil).toBe('2027-06-30');
    expect(c.listedUntil).toBe('2027-12-31');
    expect(c.versionAt).toBe('2026-10-14T08:30:00+09:00');
    expect(c.versionOn).toBe('2026-10-14');
    expect(c.origin).toBe('api');
  });

  it('版の日付は version_at の JST の日付（UTC の表記でも）', () => {
    // 2026-10-13T15:30Z = 10/14 00:30 JST
    expect(
      buildCalendar(synthCalendar({ version_at: '2026-10-13T15:30:00Z' }), 'api').versionOn,
    ).toBe('2026-10-14');
  });

  it.each([
    '2026-10-14T08:30:00+09:00',
    '2026-10-13T23:30:00Z',
    '2026-10-13T23:30Z',
    '2026-10-13T23:59:59.123Z',
    '2028-02-29T00:00:00-05:00',
  ])('version_at %s は通る', (version_at) => {
    expect(validateCalendarJson(synthCalendar({ version_at })).ok).toBe(true);
  });

  it('days が空でも ok（休業日は土日だけ）', () => {
    const c = buildCalendar(synthCalendar({ days: [] }), 'api');
    expect(c.ok).toBe(true);
    expect(c.holidays.size).toBe(0);
  });

  const omit = (k: string) => {
    const o = synthCalendar();
    delete o[k];
    return o;
  };

  it.each([
    ['オブジェクトでない', 'x', '$'],
    ['null', null, '$'],
    ['配列', [], '$'],
    ['schema_version が 2', synthCalendar({ schema_version: 2 }), '$.schema_version'],
    ['schema_version が文字列', synthCalendar({ schema_version: '1' }), '$.schema_version'],
    ['version_at が ISO 8601 の日時でない', synthCalendar({ version_at: '昨日' }), '$.version_at'],
    ['version_at が日付だけ', synthCalendar({ version_at: '2026-10-14' }), '$.version_at'],
    [
      'version_at が実在しない日時',
      synthCalendar({ version_at: '2026-13-01T00:00:00Z' }),
      '$.version_at',
    ],
    ['version_at の欠落', omit('version_at'), '$.version_at'],
    [
      'version_at が実在しない日（2/30）',
      synthCalendar({ version_at: '2026-02-30T00:00:00Z' }),
      '$.version_at',
    ],
    [
      'version_at が 24:00',
      synthCalendar({ version_at: '2026-10-14T24:00:00+09:00' }),
      '$.version_at',
    ],
    [
      'version_at の分が 60',
      synthCalendar({ version_at: '2026-10-14T08:60:00+09:00' }),
      '$.version_at',
    ],
    [
      'version_at の秒が 60',
      synthCalendar({ version_at: '2026-10-14T08:30:60+09:00' }),
      '$.version_at',
    ],
    [
      'version_at のオフセットが不正',
      synthCalendar({ version_at: '2026-10-14T08:30:00+24:00' }),
      '$.version_at',
    ],
    [
      'covered_until が実在しない日付',
      synthCalendar({ covered_until: '2027-02-30' }),
      '$.covered_until',
    ],
    ['covered_until が null', synthCalendar({ covered_until: null }), '$.covered_until'],
    [
      'listed_until が実在しない日付',
      synthCalendar({ listed_until: '2027-12-32' }),
      '$.listed_until',
    ],
    ['listed_until の欠落', omit('listed_until'), '$.listed_until'],
    ['days が配列でない', synthCalendar({ days: 'x' }), '$.days'],
    ['days の要素がオブジェクトでない', synthCalendar({ days: ['2027-01-01'] }), '$.days[0]'],
    [
      'days[].date が実在しない日付',
      synthCalendar({ days: [day('2027-13-01')] }),
      '$.days[0].date',
    ],
    ['days[].date の形式違い', synthCalendar({ days: [day('2027/01/01')] }), '$.days[0].date'],
    [
      'days が昇順でない',
      synthCalendar({ days: [day('2027-01-01'), day('2026-12-31')] }),
      '$.days[1].date',
    ],
    [
      'days の重複',
      synthCalendar({ days: [day('2027-01-01'), day('2027-01-01')] }),
      '$.days[1].date',
    ],
    [
      'is_trading_day が boolean でない',
      synthCalendar({ days: [day('2027-01-01', { is_trading_day: 'false' })] }),
      '$.days[0].is_trading_day',
    ],
    [
      'status が文字列でない',
      synthCalendar({ days: [day('2027-01-01', { status: 1 })] }),
      '$.days[0].status',
    ],
    [
      'status が空',
      synthCalendar({ days: [day('2027-01-01', { status: '' })] }),
      '$.days[0].status',
    ],
    [
      'name が文字列でない',
      synthCalendar({ days: [day('2027-01-01', { name: null })] }),
      '$.days[0].name',
    ],
  ])('(b) %s → 例外なしで ok = false、明細つき、休業日は空・期限切れ扱い', (_n, v, path) => {
    const r = validateCalendarJson(v);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(
        r.errors.some((e) => e.startsWith(`${path}:`)),
        r.errors.join('; '),
      ).toBe(true);
    for (const origin of ['api', 'bundled'] as const) {
      const c = buildCalendar(v, origin);
      expect(c.ok).toBe(false);
      expect(c.errors.length).toBeGreaterThan(0);
      expect(c.holidays.size).toBe(0);
      expect(c.coveredUntil).toBeNull();
      expect(c.listedUntil).toBeNull();
      expect(c.versionAt).toBeNull();
      expect(c.versionOn).toBeNull();
      expect(c.origin).toBe(origin);
      expect(isExpiryConfirmed(c, 2026, 11)).toBe(false);
      expect(isCalendarExpired(c, jstInstant('2026-10-13', 21, 31))).toBe(true);
      // 土日だけ: 2027-02 限は 2/11 を避けない
      expect(monthlyExpiry(2027, 2, c.holidays).lastTradingDay).toBe('2027-02-11');
    }
  });

  it('明細は最大 50 件', () => {
    const days = Array.from({ length: 80 }, () => day('x'));
    const r = validateCalendarJson(synthCalendar({ days }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(50);
  });

  it('(c) status が未知の値でも通る', () => {
    const c = buildCalendar(
      synthCalendar({ days: [day('2027-01-01', { status: 'tentative' })] }),
      'api',
    );
    expect(c.ok).toBe(true);
    expect(c.holidays.has('2027-01-01')).toBe(true);
  });

  it('(d) 余分なキーは無視（ルート・行とも。source が無くても）', () => {
    const o = synthCalendar({
      extra: { a: 1 },
      days: [day('2027-01-01', { day_type: 'national_holiday', note: 1 })],
    });
    delete o.source;
    const c = buildCalendar(o, 'api');
    expect(c.ok).toBe(true);
    expect([...c.holidays]).toEqual(['2027-01-01']);
  });
});

describe('AC-2: 休業日 = 版の全行（同梱の版）', () => {
  it('is_trading_day = true の行も休業日に入る', () => {
    const trading = bundledJson.days.filter((d) => d.is_trading_day);
    expect(trading.length).toBeGreaterThan(0);
    for (const d of trading) expect(cal.holidays.has(d.date), d.date).toBe(true);
    expect(cal.holidays.size).toBe(bundledJson.days.length);
  });

  it.each([
    [2023, 8, '2023-08-10', '2023-08-09'],
    [2022, 8, '2022-08-12', '2022-08-10'],
    [2021, 2, '2021-02-12', '2021-02-10'],
    [2027, 2, '2027-02-12', '2027-02-10'],
    [2027, 1, '2027-01-08', '2027-01-07'],
  ])('%i-%i 限: SQ 日 %s・取引最終日 %s', (y, m, sq, ltd) => {
    const e = monthlyExpiry(y, m, cal.holidays);
    expect(e.sqDate).toBe(sq);
    expect(e.lastTradingDay).toBe(ltd);
  });

  it('対照: is_trading_day = false の行だけを休業日にすると 2023-08 限・2027-02 限が違う値になる', () => {
    const closedOnly = new Set(
      bundledJson.days.filter((d) => !d.is_trading_day).map((d) => d.date),
    );
    const a = monthlyExpiry(2023, 8, closedOnly);
    expect([a.sqDate, a.lastTradingDay]).toEqual(['2023-08-11', '2023-08-10']);
    const b = monthlyExpiry(2027, 2, closedOnly);
    expect([b.sqDate, b.lastTradingDay]).toEqual(['2027-02-12', '2027-02-11']);
    expect([a.sqDate, a.lastTradingDay]).not.toEqual(['2023-08-10', '2023-08-09']);
    expect([b.sqDate, b.lastTradingDay]).not.toEqual(['2027-02-12', '2027-02-10']);
  });
});

describe('AC-3: 確定（covered_until）と掲載範囲（listed_until）の外', () => {
  it('第 2 金曜がちょうど covered_until の月は確定、翌月は未確定', () => {
    // 2027-05 の第 2 金曜は 5/14
    expect(secondFriday(2027, 5)).toBe('2027-05-14');
    const c = buildCalendar(synthCalendar({ covered_until: '2027-05-14' }), 'api');
    expect(isExpiryConfirmed(c, 2027, 5)).toBe(true);
    expect(isExpiryConfirmed(c, 2027, 6)).toBe(false);
    const c2 = buildCalendar(synthCalendar({ covered_until: '2027-05-13' }), 'api');
    expect(isExpiryConfirmed(c2, 2027, 5)).toBe(false);
  });

  it('listed_until より後の 2028-02 限: 土日だけで SQ 日 2028-02-11・取引最終日 2028-02-10、未確定', () => {
    expect(cal.listedUntil).toBe('2027-12-31');
    expect(cal.holidays.has('2028-02-11')).toBe(false);
    expect(sqDate(2028, 2, cal.holidays)).toBe('2028-02-11');
    expect(lastTradingDay(2028, 2, cal.holidays)).toBe('2028-02-10');
    expect(isExpiryConfirmed(cal, 2028, 2)).toBe(false);
  });

  it('期限切れ: covered_until 当日 23:59 JST は期限内、翌日 00:00 JST は期限切れ', () => {
    const c = buildCalendar(synthCalendar({ covered_until: '2026-10-13' }), 'api');
    expect(isCalendarExpired(c, jstInstant('2026-10-13', 23, 59))).toBe(false);
    expect(isCalendarExpired(c, jstInstant('2026-10-14', 0, 0))).toBe(true);
  });
});

describe('AC-8: 同梱の版（data/calendar/calendar.json）', () => {
  it('data/calendar/ の JSON は 1 つで、検証に通る（origin = bundled）', () => {
    const files = Object.keys(import.meta.glob('../../data/calendar/*.json'));
    expect(files).toEqual(['../../data/calendar/calendar.json']);
    const r = validateCalendarJson(bundledJson);
    expect(r.ok ? [] : r.errors).toEqual([]);
    expect(cal.ok).toBe(true);
    expect(cal.origin).toBe('bundled');
    expect(cal.coveredUntil).toBe(bundledJson.covered_until);
    expect(cal.listedUntil).toBe(bundledJson.listed_until);
  });

  it('掲載の最初の月から確定の最終日までの全月: 取引最終日の翌営業日 = SQ 日、SQ 日・取引最終日は休業日でない', () => {
    const weekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    const first = bundledJson.days[0]?.date as string;
    let y = Number(first.slice(0, 4));
    let m = Number(first.slice(5, 7));
    let n = 0;
    while (secondFriday(y, m) <= (cal.coveredUntil as string)) {
      const sq = sqDate(y, m, cal.holidays);
      const ltd = lastTradingDay(y, m, cal.holidays);
      expect(nextBusinessDay(ltd, cal.holidays)).toBe(sq);
      for (const d of [sq, ltd]) {
        expect(weekend(d), d).toBe(false);
        expect(cal.holidays.has(d), d).toBe(false);
        expect(isBusinessDay(d, cal.holidays)).toBe(true);
      }
      n++;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    expect(n).toBeGreaterThan(100); // 2018-01〜（9 年以上）
  });

  it('合成の固定 JSON 3 本の限月と先物の sq_date・last_trading_day が、カレンダーで求めた値と一致', () => {
    let n = 0;
    for (const [name, raw] of Object.entries(RAW_FIXTURES)) {
      const json = raw as {
        future: { contract_month: string; sq_date: string; last_trading_day: string };
        months: { contract_month: string; sq_date: string; last_trading_day: string }[];
      };
      for (const e of [json.future, ...json.months]) {
        const [y, m] = e.contract_month.split('-').map(Number) as [number, number];
        expect(e.sq_date, `${name} ${e.contract_month}`).toBe(sqDate(y, m, cal.holidays));
        expect(e.last_trading_day, `${name} ${e.contract_month}`).toBe(
          lastTradingDay(y, m, cal.holidays),
        );
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(9);
  });
});

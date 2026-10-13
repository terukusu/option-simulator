import { describe, expect, it } from 'vitest';
import {
  buildCalendar,
  isCalendarExpired,
  isExpiryConfirmed,
  validateHolidaysJson,
  validateTradingCalendarJson,
} from '../../data/calendar';
import holidaysJson from '../../data/calendar/holidays_jp.json';
import tradingJson from '../../data/calendar/trading_calendar.json';
import {
  isBusinessDay,
  jstInstant,
  lastTradingDay,
  nextBusinessDay,
  secondFriday,
  sqDate,
} from '../../model/time';
import { RAW_FIXTURES } from '../support/fixtures';

/**
 * AC-3（#14）: コミット済みの取引カレンダー（optionchan から同期）と国民の祝日の一覧。
 * 板の値は合成の固定 JSON（架空の値）。
 */

const cal = buildCalendar(tradingJson, holidaysJson);

/** 合成のカレンダー JSON（buildCalendar の境界の確認用。日付は例） */
function synthTrading(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    source: {
      name: 'test',
      sha256: 'a'.repeat(64),
      fetched_at: '2026-10-13T15:30:00Z',
    },
    covered_until: '2027-06-30',
    closed_dates: ['2026-12-31', '2027-01-01'],
    ...over,
  };
}

function synthHolidays(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    source: { name: 'test', sha256: 'b'.repeat(64), fetched_at: '2026-10-13T15:30:00Z' },
    covered_until: '2027-12-31',
    holidays: [
      { date: '2027-01-01', name: '元日' },
      { date: '2027-02-11', name: '建国記念の日' },
    ],
    ...over,
  };
}

describe('コミット済みのカレンダー', () => {
  it('形の検査に通る（日付の形式・昇順・重複なし・covered_until が日付）', () => {
    const t = validateTradingCalendarJson(tradingJson);
    const h = validateHolidaysJson(holidaysJson);
    expect(t.ok ? [] : t.errors).toEqual([]);
    expect(h.ok ? [] : h.errors).toEqual([]);
    expect(cal.ok).toBe(true);
    expect(cal.errors).toEqual([]);
  });

  it('確定の最終日 = covered_until と祝日の収録の最終日の早い方', () => {
    const min = [tradingJson.covered_until, holidaysJson.covered_until].sort()[0];
    expect(cal.confirmedUntil).toBe(min);
    expect(cal.coveredUntil).toBe(tradingJson.covered_until);
    // 祝日の一覧は少なくとも 2026-01-01〜2027-12-31 を含む（Issue の「やること 3」）
    expect(holidaysJson.covered_until >= '2027-12-31').toBe(true);
    expect((holidaysJson.holidays[0]?.date ?? '9999') <= '2026-01-01').toBe(true);
  });

  it('休業日 = closed_dates ∪ 祝日', () => {
    for (const d of tradingJson.closed_dates) expect(cal.holidays.has(d)).toBe(true);
    for (const h of holidaysJson.holidays) expect(cal.holidays.has(h.date)).toBe(true);
    expect(cal.holidays.has('2027-02-11')).toBe(true); // 建国記念の日
    expect(cal.holidays.has('2023-08-11')).toBe(true); // 山の日
  });

  it('2027-02 限: SQ 日 2027-02-12、取引最終日 2027-02-10（2/11 の祝日を避ける）', () => {
    expect(sqDate(2027, 2, cal.holidays)).toBe('2027-02-12');
    expect(lastTradingDay(2027, 2, cal.holidays)).toBe('2027-02-10');
  });

  it('2026-11 限・2026-12 限: SQ 日 2026-11-13・2026-12-11', () => {
    expect(sqDate(2026, 11, cal.holidays)).toBe('2026-11-13');
    expect(sqDate(2026, 12, cal.holidays)).toBe('2026-12-11');
  });

  it('確定の最終日までの全月: 取引最終日の翌営業日 = SQ 日、SQ 日・取引最終日は休業日でない', () => {
    const closed = new Set(tradingJson.closed_dates);
    const holidays = new Set(holidaysJson.holidays.map((h) => h.date));
    const weekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    let n = 0;
    for (let y = 2020; ; y++) {
      let done = false;
      for (let m = 1; m <= 12; m++) {
        if (secondFriday(y, m) > (cal.confirmedUntil as string)) {
          done = true;
          break;
        }
        const sq = sqDate(y, m, cal.holidays);
        const ltd = lastTradingDay(y, m, cal.holidays);
        expect(nextBusinessDay(ltd, cal.holidays)).toBe(sq);
        for (const d of [sq, ltd]) {
          expect(weekend(d), d).toBe(false);
          expect(closed.has(d), d).toBe(false);
          expect(holidays.has(d), d).toBe(false);
          expect(isBusinessDay(d, cal.holidays)).toBe(true);
        }
        n++;
      }
      if (done) break;
    }
    expect(n).toBeGreaterThan(80); // 2020-01〜（7 年以上）
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

describe('validateTradingCalendarJson / validateHolidaysJson（壊れた入力）', () => {
  it.each([
    ['schema_version 違い', synthTrading({ schema_version: 2 })],
    ['covered_until 欠落', (({ covered_until: _, ...rest }) => rest)(synthTrading())],
    ['covered_until が日付でない', synthTrading({ covered_until: '2027-02-30' })],
    ['closed_dates が降順', synthTrading({ closed_dates: ['2027-01-01', '2026-12-31'] })],
    ['closed_dates の重複', synthTrading({ closed_dates: ['2026-12-31', '2026-12-31'] })],
    ['closed_dates が日付でない', synthTrading({ closed_dates: ['2026/12/31'] })],
    [
      'sha256 が 64 桁の 16 進でない',
      synthTrading({ source: { name: 'x', sha256: 'z', fetched_at: '2026-10-13T15:30:00Z' } }),
    ],
    [
      'fetched_at が ISO 8601 でない',
      synthTrading({ source: { name: 'x', sha256: 'a'.repeat(64), fetched_at: '昨日' } }),
    ],
    ['オブジェクトでない', 'x'],
  ])('取引カレンダー: %s → エラー', (_name, v) => {
    const r = validateTradingCalendarJson(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it.each([
    [
      '降順',
      synthHolidays({
        holidays: [
          { date: '2027-02-11', name: 'a' },
          { date: '2027-01-01', name: 'b' },
        ],
      }),
    ],
    [
      '重複',
      synthHolidays({
        holidays: [
          { date: '2027-01-01', name: 'a' },
          { date: '2027-01-01', name: 'b' },
        ],
      }),
    ],
    ['名称が空', synthHolidays({ holidays: [{ date: '2027-01-01', name: '' }] })],
    ['日付でない', synthHolidays({ holidays: [{ date: '2027-13-01', name: 'a' }] })],
    ['covered_until 欠落', (({ covered_until: _, ...rest }) => rest)(synthHolidays())],
  ])('祝日: %s → エラー', (_name, v) => {
    expect(validateHolidaysJson(v).ok).toBe(false);
  });
});

describe('buildCalendar・isExpiryConfirmed・isCalendarExpired', () => {
  it('壊れたカレンダー → 例外なし、ok = false、休業日は空（土日だけ）、日付は null', () => {
    for (const [t, h] of [
      [null, synthHolidays()],
      [synthTrading(), { broken: true }],
      [synthTrading({ closed_dates: 'x' }), synthHolidays()],
    ] as const) {
      const c = buildCalendar(t, h);
      expect(c.ok).toBe(false);
      expect(c.errors.length).toBeGreaterThan(0);
      expect(c.holidays.size).toBe(0);
      expect(c.coveredUntil).toBeNull();
      expect(c.confirmedUntil).toBeNull();
      expect(c.syncedOn).toBeNull();
      expect(isExpiryConfirmed(c, 2026, 11)).toBe(false);
      expect(isCalendarExpired(c, jstInstant('2026-10-13', 21, 31))).toBe(true);
    }
  });

  it('syncedOn は fetched_at の JST の日付', () => {
    // 2026-10-13T15:30Z = 10/14 00:30 JST
    expect(buildCalendar(synthTrading(), synthHolidays()).syncedOn).toBe('2026-10-14');
  });

  it('確定の最終日は 2 つの covered_until の早い方（祝日の方が短い場合も）', () => {
    expect(buildCalendar(synthTrading(), synthHolidays()).confirmedUntil).toBe('2027-06-30');
    const c = buildCalendar(
      synthTrading({ covered_until: '2028-06-30' }),
      synthHolidays({ covered_until: '2027-12-31' }),
    );
    expect(c.coveredUntil).toBe('2028-06-30');
    expect(c.confirmedUntil).toBe('2027-12-31');
  });

  it('第 2 金曜がちょうど確定の最終日の月は確定、翌月は未確定', () => {
    // 2027-05 の第 2 金曜は 5/14
    expect(secondFriday(2027, 5)).toBe('2027-05-14');
    const c = buildCalendar(synthTrading({ covered_until: '2027-05-14' }), synthHolidays());
    expect(isExpiryConfirmed(c, 2027, 5)).toBe(true);
    expect(isExpiryConfirmed(c, 2027, 6)).toBe(false);
    const c2 = buildCalendar(synthTrading({ covered_until: '2027-05-13' }), synthHolidays());
    expect(isExpiryConfirmed(c2, 2027, 5)).toBe(false);
  });

  it('期限切れ: covered_until 当日 23:59 JST は期限内、翌日 00:00 JST は期限切れ', () => {
    const c = buildCalendar(synthTrading({ covered_until: '2026-10-13' }), synthHolidays());
    expect(isCalendarExpired(c, jstInstant('2026-10-13', 23, 59))).toBe(false);
    expect(isCalendarExpired(c, jstInstant('2026-10-14', 0, 0))).toBe(true);
  });
});

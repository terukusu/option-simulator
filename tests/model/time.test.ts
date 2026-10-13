import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  isBusinessDay,
  jstInstant,
  lastTradingCloseInstant,
  lastTradingDay,
  monthlyExpiry,
  nextBusinessDay,
  secondFriday,
  sqDate,
  sqInstant,
  T_MIN_YEARS,
  upcomingMonthlyExpiries,
  yearFraction,
} from '../../model/time';

// 休業日はテスト用の架空の一覧（実在のカレンダーの写しではない）
const HOLIDAYS = ['2026-11-13', '2026-11-12', '2027-01-01'];

describe('SQ 日・取引最終日', () => {
  it('第 2 金曜', () => {
    expect(secondFriday(2026, 10)).toBe('2026-10-09');
    expect(secondFriday(2026, 11)).toBe('2026-11-13');
    expect(secondFriday(2026, 12)).toBe('2026-12-11');
    expect(secondFriday(2027, 1)).toBe('2027-01-08');
    expect(secondFriday(2026, 5)).toBe('2026-05-08'); // 1 日が金曜の月
  });

  it('休業日なら前営業日へ順次繰り上げ', () => {
    expect(sqDate(2026, 12, [])).toBe('2026-12-11');
    // 11/13（金）と 11/12（木）が休業日 → 11/11（水）
    expect(sqDate(2026, 11, HOLIDAYS)).toBe('2026-11-11');
    expect(lastTradingDay(2026, 11, HOLIDAYS)).toBe('2026-11-10');
    // 休業日が無ければ取引最終日は木曜
    expect(lastTradingDay(2026, 12, HOLIDAYS)).toBe('2026-12-10');
  });

  // 往復確認: 同じ関数で求めた取引最終日と SQ 日の整合だけを見る（自己参照）。
  // optionchan の last_trading_day との照合は縦切り 2（実データ・カレンダーの写しが入ってから）
  it('往復確認: 取引最終日の翌営業日 = SQ 日（optionchan の last_trading_day との照合は縦切り 2）', () => {
    for (let y = 2026; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        const ltd = lastTradingDay(y, m, HOLIDAYS);
        expect(nextBusinessDay(ltd, HOLIDAYS)).toBe(sqDate(y, m, HOLIDAYS));
        expect(isBusinessDay(sqDate(y, m, HOLIDAYS), HOLIDAYS)).toBe(true);
      }
    }
  });

  it('月曜の前営業日は金曜、Set でも配列でも同じ', () => {
    expect(lastTradingDay(2026, 11, new Set(HOLIDAYS))).toBe('2026-11-10');
    expect(nextBusinessDay('2026-10-09', [])).toBe('2026-10-12');
  });
});

describe('T（SQ 日 9:00 JST まで、暦日 / 365）', () => {
  it('SQ 9:00 JST は UTC 0:00、取引最終日 15:45 JST は UTC 6:45', () => {
    expect(new Date(sqInstant('2026-11-13')).toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(new Date(lastTradingCloseInstant('2026-11-12')).toISOString()).toBe(
      '2026-11-12T06:45:00.000Z',
    );
  });

  it('2026-10-13 21:31 JST → 11/13 9:00 は 30.479… 日', () => {
    const now = jstInstant('2026-10-13', 21, 31);
    const sq = sqInstant('2026-11-13');
    const days = 31 - (12 * 60 + 31) / (24 * 60); // 10/13 21:31 → 11/13 21:31 から 12 時間 31 分引く
    expect(daysUntil(now, sq)).toBeCloseTo(days, 12);
    expect(yearFraction(now, sq)).toBeCloseTo(days / 365, 15);
  });

  it('T_min は 1 分', () => {
    expect(T_MIN_YEARS * 365 * 24 * 60).toBeCloseTo(1, 12);
  });

  it('先の月次限月を SQ 時刻が評価時刻より後のものから並べる', () => {
    const now = jstInstant('2026-11-13', 9, 30); // 11 月限の SQ（休業日なし）の後
    const list = upcomingMonthlyExpiries(now, 3, []);
    expect(list.map((e) => e.id)).toEqual(['2026-12', '2027-01', '2027-02']);
    const before = jstInstant('2026-11-13', 8, 59);
    expect(upcomingMonthlyExpiries(before, 1, [])[0]?.id).toBe('2026-11');
    expect(monthlyExpiry(2026, 11, HOLIDAYS).lastTradingDay).toBe('2026-11-10');
  });
});

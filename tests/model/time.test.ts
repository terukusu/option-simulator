import { describe, expect, it } from 'vitest';
import {
  businessDaysAfter,
  businessDaysAhead,
  crossesDayClose,
  DAY_MS,
  daysUntil,
  isBusinessDay,
  jstInstant,
  lastTradingCloseInstant,
  lastTradingDay,
  monthlyExpiry,
  nextBusinessDay,
  nextDayClose,
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

  // AC-2（#14）: SQ 日・取引最終日は国民の祝日を避けて繰り上がる（設計 5.2）。2023-08 限は第 2 金曜
  // 8/11 が山の日で、JPX のページの取引最終日は 8/9（= SQ 日 8/10）だった（旧系データの日付。価格ではない）
  it('祝日 2023-08-11（山の日）を休業日に入れると SQ 日 8/10・取引最終日 8/9', () => {
    expect(sqDate(2023, 8, [])).toBe('2023-08-11');
    expect(sqDate(2023, 8, ['2023-08-11'])).toBe('2023-08-10');
    expect(lastTradingDay(2023, 8, ['2023-08-11'])).toBe('2023-08-09');
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

describe('base の翌営業日から target までの営業日数（両端を含む。#393）', () => {
  it('optionchan に確認した 3 例（日付だけ）: 04-07（月）→ 04-10 = 3、04-09 → 04-10 = 1、2026-03-11 → 03-12 = 1', () => {
    expect(businessDaysAfter('2025-04-07', '2025-04-10', [])).toBe(3);
    expect(businessDaysAfter('2025-04-09', '2025-04-10', [])).toBe(1);
    expect(businessDaysAfter('2026-03-11', '2026-03-12', [])).toBe(1);
  });

  it('target ≤ base は 0、週末・休業日は数えない、土日の base からも翌営業日から', () => {
    expect(businessDaysAfter('2025-04-10', '2025-04-10', [])).toBe(0);
    expect(businessDaysAfter('2025-04-11', '2025-04-10', [])).toBe(0);
    // 金曜 → 次の水曜 = 月・火・水の 3 日、月曜が休業なら 2 日
    expect(businessDaysAfter('2025-04-04', '2025-04-09', [])).toBe(3);
    expect(businessDaysAfter('2025-04-04', '2025-04-09', ['2025-04-07'])).toBe(2);
    expect(businessDaysAfter('2025-04-04', '2025-04-09', new Set(['2025-04-07']))).toBe(2);
    expect(businessDaysAfter('2025-04-05', '2025-04-07', [])).toBe(1);
    // target が休業日なら、その前の営業日まで
    expect(businessDaysAfter('2025-04-07', '2025-04-12', [])).toBe(4);
  });

  it('limit を超えたら limit + 1 で止める（limit 以下の数は変わらない）', () => {
    expect(businessDaysAfter('2025-04-01', '2026-04-01', [], 3)).toBe(4);
    expect(businessDaysAfter('2025-04-07', '2025-04-10', [], 3)).toBe(3);
    expect(businessDaysAfter('2025-04-07', '2025-04-10', [], 2)).toBe(3);
    // 種つきでない総当たり: limit の有無で「≤ limit か」の判定が同じ
    for (let d = 1; d <= 28; d++) {
      const base = `2025-02-${String(d).padStart(2, '0')}`;
      for (const lim of [0, 1, 3, 5]) {
        const full = businessDaysAfter(base, '2025-03-13', HOLIDAYS);
        expect(businessDaysAfter(base, '2025-03-13', HOLIDAYS, lim) <= lim).toBe(full <= lim);
      }
    }
  });
});

describe('n 営業日後までの暦日（証拠金の保有期間。設計 5.10）', () => {
  // 2026-10-16 は金曜。休業日は架空（2026-10-19 の月曜）
  it('金曜 → 火曜 = 4、木曜 → 月曜 = 4、月曜 → 水曜 = 2', () => {
    expect(businessDaysAhead(jstInstant('2026-10-16', 15, 0), 2, [])).toBe(4);
    expect(businessDaysAhead(jstInstant('2026-10-15', 10, 0), 2, [])).toBe(4);
    expect(businessDaysAhead(jstInstant('2026-10-12', 10, 0), 2, [])).toBe(2);
    expect(businessDaysAhead(jstInstant('2026-10-13', 21, 31), 1, [])).toBe(1);
  });

  it('休業日を挟む: 月曜が休業なら金曜 → 水曜 = 5', () => {
    expect(businessDaysAhead(jstInstant('2026-10-16', 15, 0), 2, ['2026-10-19'])).toBe(5);
    expect(businessDaysAhead(jstInstant('2026-10-16', 15, 0), 2, new Set(['2026-10-19']))).toBe(5);
  });

  it('土日の S からも次の営業日から数える（JST の暦日）', () => {
    expect(businessDaysAhead(jstInstant('2026-10-17', 12, 0), 2, [])).toBe(3);
    expect(businessDaysAhead(jstInstant('2026-10-18', 12, 0), 2, [])).toBe(2);
    // 金曜 23:59 JST はまだ金曜、土曜 0:30 JST（UTC では金曜）は土曜
    expect(businessDaysAhead(jstInstant('2026-10-16', 23, 59), 2, [])).toBe(4);
    expect(businessDaysAhead(jstInstant('2026-10-17', 0, 30), 2, [])).toBe(3);
  });

  it('n = 0 → 0', () => {
    expect(businessDaysAhead(jstInstant('2026-10-17', 12, 0), 0, [])).toBe(0);
  });
});

describe('値洗い（営業日の 15:45 JST）をまたぐか（証拠金の余力の先物の項。設計 5.10・#381）', () => {
  // 2026-11-10 は火曜。11-12（木）・11-13（金）は架空の休業日（HOLIDAYS）
  const close = (d: string) => jstInstant(d, 15, 45);

  it('日中 10:00 の板: + 0.2 日（14:48）はまたがない、+ 0.25 日（16:00）はまたぐ', () => {
    const t = jstInstant('2026-11-10', 10, 0);
    expect(nextDayClose(t, HOLIDAYS)).toBe(close('2026-11-10'));
    expect(crossesDayClose(t, t + 0.2 * DAY_MS, HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t, t + 0.25 * DAY_MS, HOLIDAYS)).toBe(true);
    // 15:45 ちょうどに着く状態はまたぐ（その引けの値洗いの後）
    expect(crossesDayClose(t, close('2026-11-10'), HOLIDAYS)).toBe(true);
    expect(crossesDayClose(t, close('2026-11-10') - 1, HOLIDAYS)).toBe(false);
  });

  it('15:45 ちょうどの板はその引けを数えない（次は翌営業日の 15:45）。+ 0 はまたがない', () => {
    const t = close('2026-11-10');
    expect(nextDayClose(t, HOLIDAYS)).toBe(close('2026-11-11'));
    expect(crossesDayClose(t, t, HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t, t + DAY_MS - 1, HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t, t + DAY_MS, HOLIDAYS)).toBe(true);
  });

  it('金曜の夜間・土曜の朝の板: 月曜 15:45 まではまたがない、その後はまたぐ', () => {
    for (const t of [jstInstant('2026-11-06', 20, 0), jstInstant('2026-11-07', 5, 0)]) {
      expect(nextDayClose(t, HOLIDAYS)).toBe(close('2026-11-09'));
      expect(crossesDayClose(t, close('2026-11-09') - 1, HOLIDAYS)).toBe(false);
      expect(crossesDayClose(t, close('2026-11-09'), HOLIDAYS)).toBe(true);
    }
  });

  it('休業日の 15:45 は数えない（水曜の夜 → 木・金が休業日・土日 → 月曜 15:45）', () => {
    const t = jstInstant('2026-11-11', 20, 0);
    expect(nextDayClose(t, HOLIDAYS)).toBe(close('2026-11-16'));
    expect(crossesDayClose(t, close('2026-11-13'), HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t, close('2026-11-16'), HOLIDAYS)).toBe(true);
    // 休業日の一覧が空なら木曜 15:45
    expect(nextDayClose(t, [])).toBe(close('2026-11-12'));
  });

  it('有限でない・逆向きは false', () => {
    const t = jstInstant('2026-11-10', 10, 0);
    expect(crossesDayClose(Number.NaN, t, HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t, Number.POSITIVE_INFINITY, HOLIDAYS)).toBe(false);
    expect(crossesDayClose(t + 2 * DAY_MS, t, HOLIDAYS)).toBe(false);
  });
});

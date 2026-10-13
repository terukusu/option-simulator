import { describe, expect, it } from 'vitest';
import { buildCalendar, normalizeChain } from '../../data';
import holidaysJson from '../../data/calendar/holidays_jp.json';
import tradingJson from '../../data/calendar/trading_calendar.json';
import { CALENDAR } from '../../ui/calendar';
import { fmtNum } from '../../ui/view/format';
import { headerModel, STALE_MINUTES } from '../../ui/view/header';
import { fixture } from '../support/fixtures';

/** AC-6: ヘッダ（M1・5.9）。値は合成の板（架空）。 */
describe('ヘッダの表示モデル', () => {
  it('latest: 板の時刻・遅れ・先物・限月ごとの日付・F・A / B の基準価格・ATM', () => {
    const chain = normalizeChain(fixture('latest'));
    const h = headerModel(chain, 'B', CALENDAR);
    expect(h.snapshot).toBe('2026-10-13 21:31');
    expect(h.delay).toBe('約 15 分遅れ');
    expect(h.reason).toBe('最新');
    expect(h.future.contract).toBe('2026-12');
    expect(h.future.time).toBe('21:25'); // 約定はスナップショットの 6 分前
    expect(h.future.price).toBe(fmtNum(chain.future.price, 0));
    expect(h.spot.time).toBe('15:45');
    expect(h.months.map((m) => [m.id, m.lastTradingDay, m.sqDate])).toEqual([
      ['2026-11', '2026-11-12', '2026-11-13'],
      ['2026-12', '2026-12-10', '2026-12-11'],
    ]);
    chain.months.forEach((m, i) => {
      const v = h.months[i];
      expect(v?.forward.startsWith(fmtNum(m.F, 0))).toBe(true);
      expect(v?.forwardKindLabel).toBe('合成先物');
      expect(v?.refA.price).toBe(fmtNum(m.atm.A.reference.price, 0));
      expect(v?.refB.price).toBe(fmtNum(m.atm.B.reference.price, 0));
      expect(v?.atmK).toBe(m.atm.B.pick?.k);
      expect(v?.atm).toBe(fmtNum(m.atm.B.pick?.k ?? null, 0));
      expect(v?.refA.stale).toBe(false);
      expect(v?.refB.stale).toBe(false);
    });
    const a = headerModel(chain, 'A', CALENDAR);
    chain.months.forEach((m, i) => {
      expect(a.months[i]?.atmK).toBe(m.atm.A.pick?.k);
    });
    expect(h.assumptions[2]).toBe(
      `取引カレンダー: optionchan から同期（${CALENDAR.syncedOn}）・確定 ${CALENDAR.confirmedUntil} まで`,
    );
    expect(h.calendarExpired).toBe(false);
    expect(h.calendarWarning).toBeNull();
    expect(h.assumptions[0]).toBe('金利 0.5%');
  });

  it('pre_open: reason が「板寄せ前」', () => {
    const h = headerModel(normalizeChain(fixture('pre_open')), 'B', CALENDAR);
    expect(h.reason).toBe('板寄せ前');
    expect(h.snapshot).toBe('2026-10-13 15:40');
  });

  it.each([
    [STALE_MINUTES, true],
    [STALE_MINUTES - 1, false],
  ])('基準価格（先物の約定）がスナップショットの %i 分前 → 古い = %s', (minutes, stale) => {
    const json = fixture('latest');
    const snap = Date.parse(json.snapshot_at);
    json.future.price_time = new Date(snap - minutes * 60_000).toISOString();
    const h = headerModel(normalizeChain(json), 'A', CALENDAR);
    for (const m of h.months) {
      expect(m.refA.stale).toBe(stale);
      // B は合成先物（スナップショット時刻）なので古くならない
      expect(m.refB.stale).toBe(false);
    }
  });

  it('B が A にフォールバックしたら先物の約定時刻で判定する', () => {
    const json = fixture('latest');
    const snap = Date.parse(json.snapshot_at);
    json.future.price_time = new Date(snap - 45 * 60_000).toISOString();
    for (const m of json.months) {
      for (const r of m.rows) {
        for (const s of [r.call, r.put]) {
          s.bid = null;
          s.ask = null;
          s.price = null;
        }
      }
    }
    const h = headerModel(normalizeChain(json), 'B', CALENDAR);
    for (const m of h.months) {
      expect(m.refB.fellBack).toBe(true);
      expect(m.refB.stale).toBe(true);
      expect(m.forwardKind).not.toBe('synthetic');
    }
    expect(h.months[0]?.forwardKindLabel).toBe('先物で代用（限月違い）');
    expect(h.months[1]?.forwardKindLabel).toBe('先物で代用');
  });
});

/** AC-6（#14）: 取引カレンダーの期限切れ。合成の板の評価時刻は 2026-10-13 21:31 JST。 */
describe('ヘッダの前提: 取引カレンダー', () => {
  const chain = normalizeChain(fixture('latest'));
  const withCoveredUntil = (d: string) =>
    buildCalendar({ ...tradingJson, covered_until: d }, holidaysJson);

  it('評価時刻が covered_until 当日 → 「カレンダー期限切れ」は出ない', () => {
    const h = headerModel(chain, 'B', withCoveredUntil('2026-10-13'));
    expect(h.calendarExpired).toBe(false);
    expect(h.assumptions.some((a) => a.includes('カレンダー期限切れ'))).toBe(false);
    expect(h.assumptions[2]).toContain('確定 2026-10-13 まで');
  });

  it('評価時刻が covered_until の翌日 → 前提に「カレンダー期限切れ」', () => {
    const h = headerModel(chain, 'B', withCoveredUntil('2026-10-12'));
    expect(h.calendarExpired).toBe(true);
    expect(h.calendarWarning).toBe(
      'カレンダー期限切れ（評価時刻が 2026-10-12 より後。休業日が漏れている可能性）',
    );
    expect(h.assumptions).toContain(h.calendarWarning);
  });

  it('壊れたカレンダー → 例外を出さず「読めない」と「カレンダー期限切れ」', () => {
    const broken = buildCalendar(tradingJson, { holidays: 'x' });
    const h = headerModel(chain, 'B', broken);
    expect(h.assumptions).toContain('取引カレンダー: 読めない（SQ 日は土日だけで計算）');
    expect(h.calendarExpired).toBe(true);
    expect(h.calendarWarning).toBe('カレンダー期限切れ（カレンダーを読めない）');
    expect(h.assumptions).toContain(h.calendarWarning);
  });
});

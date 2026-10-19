import { describe, expect, it } from 'vitest';
import { buildCalendar, normalizeChain } from '../../data';
import bundledJson from '../../data/calendar/calendar.json';
import { CALENDAR } from '../../ui/calendar';
import { fmtNum } from '../../ui/view/format';
import {
  calendarAssumption,
  calendarOriginLabel,
  delayText,
  headerModel,
  keptBoardNote,
  REASON_LABEL,
  reasonNote,
  STALE_MINUTES,
} from '../../ui/view/header';
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
      `取引カレンダー: 同梱の版（${CALENDAR.versionOn}）・確定 ${CALENDAR.coveredUntil} まで`,
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
    buildCalendar({ ...bundledJson, covered_until: d }, 'bundled');

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
    const broken = buildCalendar({ ...bundledJson, days: 'x' }, 'bundled');
    const h = headerModel(chain, 'B', broken);
    expect(h.assumptions).toContain('取引カレンダー: 読めない（SQ 日は土日だけで計算）');
    expect(h.calendarExpired).toBe(true);
    expect(h.calendarWarning).toBe('カレンダー期限切れ（カレンダーを読めない）');
    expect(h.assumptions).toContain(h.calendarWarning);
  });
});

/** #34 AC-5: 鮮度（取得時刻・データ元）と reason の理由の行。板は合成（reason は書き換え）。 */
describe('ヘッダ: 取得時刻・データ元・reason の理由', () => {
  const FETCHED = Date.parse('2026-10-13T21:47:30+09:00');

  it('(a)(b) 取得時刻は JST の HH:MM、データ元はラベル。省略時は null', () => {
    const chain = normalizeChain(fixture('latest'));
    const h = headerModel(chain, 'B', CALENDAR, { fetchedAt: FETCHED, label: 'API' });
    expect(h.fetched).toBe('21:47');
    expect(h.loadedFrom).toBe('API');
    const bare = headerModel(chain, 'B', CALENDAR);
    expect(bare.fetched).toBeNull();
    expect(bare.loadedFrom).toBeNull();
    expect(headerModel(chain, 'B', CALENDAR, { fetchedAt: null, label: null }).fetched).toBeNull();
  });

  it('(c) タグは 最新 / 板寄せ前 / 引け後 / 時間外', () => {
    expect(REASON_LABEL).toEqual({
      latest: '最新',
      pre_open: '板寄せ前',
      after_close: '引け後',
      closed: '時間外',
    });
  });

  it('(c) latest は理由の行なし', () => {
    const chain = normalizeChain(fixture('latest'));
    expect(reasonNote(chain)).toBeNull();
    expect(headerModel(chain, 'B', CALENDAR).reasonNote).toBeNull();
  });

  it('(c) pre_open（合成の pre_open.json）は板の時刻を含む理由の行', () => {
    const chain = normalizeChain(fixture('pre_open'));
    const h = headerModel(chain, 'B', CALENDAR);
    expect(h.reason).toBe('板寄せ前');
    expect(h.reasonNote).toBe(
      '寄り前のため、板寄せ前の最後のスナップショット（2026-10-13 15:40）を表示',
    );
  });

  it.each([
    ['after_close', '引け後', /^引け後のため、.*（2026-10-13 21:31）を表示$/],
    [
      'closed',
      '時間外',
      /^時間外・休業日、または取り込みの停止のため、.*（2026-10-13 21:31）を表示$/,
    ],
  ] as const)('(c) %s → タグ「%s」と板の時刻を含む理由の行', (reason, tag, note) => {
    const json = fixture('latest');
    json.reason = reason;
    const h = headerModel(normalizeChain(json), 'B', CALENDAR);
    expect(h.reason).toBe(tag);
    expect(h.reasonNote).toMatch(note);
  });

  it('keptBoardNote: 取得時刻が無ければ null、あれば「前の板のまま（取得 HH:MM）」', () => {
    expect(keptBoardNote(null)).toBeNull();
    expect(keptBoardNote(FETCHED)).toBe('前の板のまま（取得 21:47）');
  });

  it('#23 保存した板: keptBoardNote は日付つき、ヘッダは「古い板」と日付つきの取得時刻', () => {
    expect(keptBoardNote(FETCHED, true)).toBe('保存した板を表示（取得 2026-10-13 21:47）');
    const chain = normalizeChain(fixture('latest'));
    const h = headerModel(chain, 'B', CALENDAR, {
      fetchedAt: FETCHED,
      label: '保存した板（API）',
      stale: true,
    });
    expect(h.boardStale).toBe(true);
    expect(h.fetched).toBe('2026-10-13 21:47');
    expect(h.loadedFrom).toBe('保存した板（API）');
    expect(headerModel(chain, 'B', CALENDAR, { fetchedAt: FETCHED }).boardStale).toBe(false);
  });
});

/** AC-7（#39）: 前提の文言（API の版 / 同梱の版 / 読めない / 期限切れ）。架空の版（日付は公開の休業日）。 */
describe('calendarAssumption', () => {
  // 2026-10-13T23:30:00Z = 2026-10-14 08:30 JST（版の日付は JST）
  const json = {
    schema_version: 1,
    source: 'bigquery',
    version_at: '2026-10-13T23:30:00Z',
    covered_until: '2027-06-30',
    listed_until: '2027-12-31',
    days: [{ date: '2027-01-01', is_trading_day: false, status: 'confirmed', name: '元日' }],
  };
  const t = Date.parse('2026-10-13T12:31:00Z'); // 2026-10-13 21:31 JST

  it('(a) API の版: 版の日付（version_at の JST の日付）と確定の最終日', () => {
    const r = calendarAssumption(buildCalendar(json, 'api'), t);
    expect(r.text).toBe('取引カレンダー: optionchan の版（2026-10-14）・確定 2027-06-30 まで');
    expect(r.warning).toBeNull();
  });

  it('(b) 同梱の版: 同梱と分かる文（API の版の文と異なる）', () => {
    const r = calendarAssumption(buildCalendar(json, 'bundled'), t);
    expect(r.text).toBe('取引カレンダー: 同梱の版（2026-10-14）・確定 2027-06-30 まで');
    expect(r.text).not.toBe(calendarAssumption(buildCalendar(json, 'api'), t).text);
    expect(r.warning).toBeNull();
  });

  it('(c) 読めない: 「読めない」と「カレンダー期限切れ（カレンダーを読めない）」（API・同梱とも）', () => {
    for (const origin of ['api', 'bundled'] as const) {
      const r = calendarAssumption(buildCalendar({ ...json, schema_version: 2 }, origin), t);
      expect(r.text).toBe('取引カレンダー: 読めない（SQ 日は土日だけで計算）');
      expect(r.warning).toBe('カレンダー期限切れ（カレンダーを読めない）');
    }
  });

  it('(d) 評価時刻が covered_until より後 → 期限切れの警告', () => {
    const c = buildCalendar({ ...json, covered_until: '2026-10-12' }, 'api');
    const r = calendarAssumption(c, t);
    expect(r.text).toBe('取引カレンダー: optionchan の版（2026-10-14）・確定 2026-10-12 まで');
    expect(r.warning).toBe(
      'カレンダー期限切れ（評価時刻が 2026-10-12 より後。休業日が漏れている可能性）',
    );
  });
});

describe('遅れの表示（#154）', () => {
  it('分の遅れ / 遅れのない供給元 / 不明', () => {
    expect(delayText(15)).toBe('約 15 分遅れ');
    expect(delayText(0)).toBe('遅れなし');
    expect(delayText(Number.NaN)).toBe('—');
  });
});

describe('カレンダーの出どころ（#154）', () => {
  it('API の版: source が bigquery / 無しなら optionchan の版、それ以外は API の版。同梱は同梱の版', () => {
    expect(calendarOriginLabel(buildCalendar(bundledJson, 'api'))).toBe('optionchan の版');
    expect(calendarOriginLabel(buildCalendar({ ...bundledJson, source: 'file' }, 'api'))).toBe(
      'API の版',
    );
    const { source: _s, ...noSource } = bundledJson;
    expect(calendarOriginLabel(buildCalendar(noSource, 'api'))).toBe('optionchan の版');
    expect(calendarOriginLabel(buildCalendar({ ...bundledJson, source: 'file' }, 'bundled'))).toBe(
      '同梱の版',
    );
  });
});

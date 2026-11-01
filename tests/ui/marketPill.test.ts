import { describe, expect, it } from 'vitest';
import { buildCalendar, normalizeChain } from '../../data';
import bundledJson from '../../data/calendar/calendar.json';
import { CALENDAR } from '../../ui/calendar';
import { loaderNote } from '../../ui/load';
import { fmtNum } from '../../ui/view/format';
import { type HeaderModel, headerModel, keptBoardNote } from '../../ui/view/header';
import {
  ASSUMPTION_HINT_TEXT,
  marketPill,
  PILL_TAG_ORDER,
  type PillLoad,
  pillClock,
  pillDate,
  visibleTags,
} from '../../ui/view/marketPill';
import { fixture } from '../support/fixtures';

/** #87 AC-2: 市場ピル（要約 + 全文）。板は合成（架空の値）。 */
const IDLE: PillLoad = { loading: false, error: null, kept: null, loaderNote: '' };
const FETCHED = Date.parse('2026-10-13T21:47:30+09:00');

function latestHeader(basis: 'A' | 'B' = 'B', load = {}): HeaderModel {
  return headerModel(normalizeChain(fixture('latest')), basis, CALENDAR, load);
}

/** 全文の文字列すべて（部品が描く文字列の集合） */
const fullText = (m: ReturnType<typeof marketPill>) => JSON.stringify(m.full);

describe('marketPill の要約', () => {
  it('(a) F・ATM は monthId の限月の値（もう一方の限月の値を含まない）', () => {
    const chain = normalizeChain(fixture('latest'));
    const h = headerModel(chain, 'B', CALENDAR);
    const [m1, m2] = h.months;
    if (!m1 || !m2) throw new Error('2 限月の板のはず');
    const p1 = marketPill(h, m1.id, IDLE);
    const p2 = marketPill(h, m2.id, IDLE);
    const f = (m: typeof m1) =>
      `F ${fmtNum(chain.months.find((c) => c.id === m.id)?.F ?? null, 0)}`;
    expect(p1.values).toEqual({ f: f(m1), atm: `ATM ${m1.atm}`, future: `先物 ${h.future.price}` });
    expect(p2.values).toEqual({ f: f(m2), atm: `ATM ${m2.atm}`, future: `先物 ${h.future.price}` });
    expect(f(m1)).not.toBe(f(m2));
    expect(p1.summary).not.toContain(f(m2));
    expect(p2.summary).not.toContain(f(m1));
    // F の ± は全文だけ
    expect(p1.values?.f).not.toContain('±');
    expect(m1.forward).toContain('±');
    expect(fullText(p1)).toContain(m1.forward);
    // 知らない id・null は先頭の限月
    expect(marketPill(h, null, IDLE).values).toEqual(p1.values);
    expect(marketPill(h, 'nope', IDLE).values).toEqual(p1.values);
  });

  it('(a) ATM は今の基準（A / B を替えると変わる）', () => {
    const chain = normalizeChain(fixture('latest'));
    const b = headerModel(chain, 'B', CALENDAR);
    const a = headerModel(chain, 'A', CALENDAR);
    const id = b.months[0]?.id ?? null;
    const atmA = fmtNum(chain.months[0]?.atm.A.pick?.k ?? null, 0);
    const atmB = fmtNum(chain.months[0]?.atm.B.pick?.k ?? null, 0);
    expect(atmA).not.toBe(atmB);
    expect(marketPill(b, id, IDLE).values?.atm).toBe(`ATM ${atmB}`);
    expect(marketPill(a, id, IDLE).values?.atm).toBe(`ATM ${atmA}`);
  });

  it('時刻: 板 MM/DD HH:mm、短縮形は HH:mm。aria-label に要約の全文', () => {
    const h = latestHeader();
    const p = marketPill(h, null, IDLE);
    expect(pillDate('2026-10-13 21:31')).toBe('10/13 21:31');
    expect(pillClock('2026-10-13 21:31')).toBe('21:31');
    expect(pillDate('—')).toBe('—');
    expect(p.time).toBe('板 10/13 21:31');
    expect(p.clock).toBe('21:31');
    expect(p.state).toBe('ready');
    expect(p.tags.map((t) => t.label)).toEqual(['最新']);
    expect(p.warn).toBe(false);
    expect(p.shortTag).toBeNull();
    expect(p.summary).toBe(
      `板 10/13 21:31 · 最新 · ${p.values?.f} · ${p.values?.atm} · ${p.values?.future}`,
    );
  });

  it('(b) タグ: 古い板・カレンダー期限切れ・読み込み中…・読めない、重い順', () => {
    const chain = normalizeChain(fixture('latest'));
    const cal = buildCalendar({ ...bundledJson, covered_until: '2026-10-12' }, 'bundled');
    const h = headerModel(chain, 'B', cal, { fetchedAt: FETCHED, label: 'x', stale: true });
    const p = marketPill(h, null, {
      loading: true,
      error: { message: '板を読めない（HTTP 500）', errors: [] },
      kept: keptBoardNote(FETCHED, true),
      loaderNote: loaderNote(true, 'x'),
    });
    expect(p.tags.map((t) => t.label)).toEqual([
      '読み込み中…',
      '読めない',
      '古い板',
      'カレンダー期限切れ',
      '最新',
    ]);
    expect(p.state).toBe('loading');
    expect(p.warn).toBe(true);
    const idle = marketPill(h, null, { ...IDLE, error: { message: 'x', errors: [] } });
    expect(idle.state).toBe('failed');
    expect(idle.tags[0]?.label).toBe('読めない');
  });

  it('(b) タグ: F が無い限月 → F なし・ATM なし', () => {
    const json = fixture('latest');
    json.future.price = null;
    json.future.price_time = null;
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
    const p = marketPill(h, null, IDLE);
    // B は合成先物が決まらず A に代用（情報のタグ）
    expect(p.tags.map((t) => t.label)).toEqual(['F なし', 'ATM なし', 'A で代用', '最新']);
    expect(p.values?.f).toBeNull();
    expect(p.values?.atm).toBeNull();
    expect(p.shortTag?.label).toBe('F なし');
  });

  it('(b) タグ: 今の基準の参照が fellBack → A で代用、30 分以上古い → 古い、F の種別 → 先物で代用', () => {
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
    const chain = normalizeChain(json);
    const h = headerModel(chain, 'B', CALENDAR);
    expect(h.months[0]?.refB.fellBack).toBe(true);
    const p = marketPill(h, h.months[1]?.id ?? null, IDLE);
    const labels = p.tags.map((t) => t.label);
    expect(labels).toContain('古い');
    expect(labels).toContain('A で代用');
    expect(labels).toContain('先物で代用');
    const order = p.tags.map((t) => PILL_TAG_ORDER.indexOf(t.key));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(p.tags.find((t) => t.label === 'A で代用')?.warn).toBe(false);
    expect(p.tags.find((t) => t.label === '古い')?.warn).toBe(true);
  });

  it('(b) reason が pre_open → 板寄せ前', () => {
    const h = headerModel(normalizeChain(fixture('pre_open')), 'B', CALENDAR);
    const p = marketPill(h, null, IDLE);
    expect(p.tags.at(-1)?.label).toBe('板寄せ前');
    expect(p.time).toBe('板 10/13 15:40');
  });

  it('(c) スマホの短縮形 = HH:mm + 最も重い警告のタグ 1 つ（カレンダー期限切れ → 期限切れ）', () => {
    const chain = normalizeChain(fixture('latest'));
    const cal = buildCalendar({ ...bundledJson, covered_until: '2026-10-12' }, 'bundled');
    const h = headerModel(chain, 'B', cal);
    const p = marketPill(h, null, IDLE);
    expect(p.clock).toBe('21:31');
    expect(p.shortTag?.label).toBe('カレンダー期限切れ');
    expect(p.shortTag?.short).toBe('期限切れ');
    const stale = marketPill(
      headerModel(chain, 'B', cal, { fetchedAt: FETCHED, stale: true }),
      null,
      {
        ...IDLE,
        loading: true,
      },
    );
    // 読み込み中…（警告でない）より 古い板 が短縮形
    expect(stale.shortTag?.label).toBe('古い板');
    for (const t of stale.tags) if (t.key !== 'calendar') expect(t.short).toBe(t.label);
  });

  it('(d) 全文に旧 Header の文字列がすべて入る（+ ⓘ の文・表示中・失敗の詳細）', () => {
    const chain = normalizeChain(fixture('pre_open'));
    const cal = buildCalendar({ ...bundledJson, covered_until: '2026-10-12' }, 'bundled');
    const h = headerModel(chain, 'B', cal, { fetchedAt: FETCHED, label: 'pre_open.json' });
    const error = {
      message: '板を読めない（HTTP 500）',
      errors: ['months[0]: 形が違う', 'rows: 空'],
    };
    const kept = keptBoardNote(FETCHED);
    const p = marketPill(h, null, {
      loading: false,
      error,
      kept,
      loaderNote: loaderNote(false, 'pre_open.json'),
    });
    const text = fullText(p);
    const want: string[] = [
      h.snapshot,
      h.delay,
      h.reason,
      h.reasonNote ?? '',
      h.fetched ?? '',
      h.loadedFrom ?? '',
      h.spot.price,
      h.spot.time,
      h.future.contract,
      h.future.price,
      h.future.time,
      h.future.sqDate,
      ...h.months.flatMap((m) => [
        m.id,
        m.lastTradingDay,
        m.sqDate,
        m.forward,
        m.forwardKindLabel,
        m.refA.price,
        m.refA.time,
        m.refB.price,
        m.refB.time,
        m.atm,
      ]),
      h.calendarWarning ?? '',
      ASSUMPTION_HINT_TEXT,
      '表示中: pre_open.json',
      error.message,
      kept ?? '',
      ...error.errors,
    ];
    expect(h.reasonNote).not.toBeNull();
    for (const s of want) {
      expect(s).not.toBe('');
      expect(text).toContain(s);
    }
    expect(p.full.calendarWarning).toBe(h.calendarWarning);
    expect(p.full.months.filter((m) => m.current).map((m) => m.id)).toEqual([h.months[0]?.id]);
    expect(h.source).not.toBeNull();
    expect(text).toContain(h.source ?? '');
  });

  it('#279 V-06 前提の一覧（金利・評価時刻）は出さず（設定の末尾にある）、カレンダー期限切れの警告の文だけ', () => {
    const chain = normalizeChain(fixture('latest'));
    const ok = headerModel(chain, 'B', CALENDAR);
    const p = marketPill(ok, null, IDLE);
    const text = fullText(p);
    for (const a of ok.assumptions) expect(text).not.toContain(a);
    expect(p.full.calendarWarning).toBeNull();
    const cal = buildCalendar({ ...bundledJson, covered_until: '2026-10-12' }, 'bundled');
    const expired = headerModel(chain, 'B', cal);
    const q = marketPill(expired, null, IDLE);
    expect(expired.calendarWarning).not.toBeNull();
    expect(q.full.calendarWarning).toBe(expired.calendarWarning);
    for (const a of expired.assumptions) {
      if (a !== expired.calendarWarning) expect(fullText(q)).not.toContain(a);
    }
  });

  it('全文の欠損: 取得・データ元・理由の行が無ければ出さない', () => {
    const p = marketPill({ ...latestHeader(), source: null }, null, IDLE);
    expect(p.full.rows.map((r) => r.k)).toEqual(['板', '日経平均', '先物', 'ATM の基準']);
    const src = marketPill(latestHeader(), null, IDLE).full.rows.find((r) => r.k === 'データ元');
    expect(src?.v).toBe(latestHeader().source);
    expect(p.full.reasonNote).toBeNull();
    expect(p.full.loaderNote).toBeNull();
    expect(p.full.error).toBeNull();
  });

  it('板が無いとき: 読み込み中… / 板を読めない / 板なし と知らせの行の文', () => {
    const loading = marketPill(null, null, { ...IDLE, loading: true, loaderNote: '読み込み中…' });
    expect([loading.state, loading.time, loading.values]).toEqual(['loading', '読み込み中…', null]);
    expect(loading.full.notice).toEqual({ text: '読み込み中…', warn: false });
    const failed = marketPill(null, null, { ...IDLE, error: { message: 'x', errors: ['e1'] } });
    expect([failed.state, failed.time, failed.warn]).toEqual(['failed', '板を読めない', true]);
    expect(failed.full.notice?.text).toBe(
      '板を読めない。[最新] で読み直すか、板の JSON を選んでください。',
    );
    expect(failed.full.error?.errors).toEqual(['e1']);
    const none = marketPill(null, null, IDLE);
    expect([none.state, none.time, none.warn]).toEqual(['none', '板なし', false]);
    expect(none.full.notice?.text).toBe('板の JSON を選んでください。');
  });

  it('#341: ログイン切れ（reload）の失敗は全文の error に reload: true（ほかは無い）', () => {
    const auth = { message: 'ログインが切れた', errors: [], reload: true as const };
    for (const h of [latestHeader(), null]) {
      expect(marketPill(h, null, { ...IDLE, error: auth }).full.error?.reload).toBe(true);
      const http = marketPill(h, null, { ...IDLE, error: { message: 'x', errors: [] } });
      expect(http.full.error).not.toHaveProperty('reload');
    }
  });

  it('visibleTags: 幅の段階の数だけ、残りは +N', () => {
    const p = marketPill(latestHeader('B', { stale: true }), null, {
      ...IDLE,
      loading: true,
      error: { message: 'x', errors: [] },
    });
    expect(p.tags.length).toBe(4);
    expect(visibleTags(p.tags, 3).more).toBe(1);
    expect(visibleTags(p.tags, 2).shown.map((t) => t.label)).toEqual(['読み込み中…', '読めない']);
    expect(visibleTags(p.tags, 9).more).toBe(0);
  });

  it('同じ入力で同じ出力', () => {
    const h = latestHeader();
    expect(marketPill(h, null, IDLE)).toEqual(marketPill(h, null, IDLE));
  });
});

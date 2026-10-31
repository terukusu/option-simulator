import { describe, expect, it } from 'vitest';
import { ChainLoadError, loadAtmDaily } from '../../data/adapter';
import { type AtmDailyDay, atmMoves, validateAtmDailyJson } from '../../data/atmDaily';
import { buildCalendar } from '../../data/calendar';
import bundledJson from '../../data/calendar/calendar.json';
import { MARGIN_HORIZON_BUSINESS_DAYS } from '../../model/margin';
import { isBusinessDay } from '../../model/time';
import { SYNTH_IV_NOW, synthAtmDaily } from '../../scripts/devFixtures.mjs';

/**
 * #152 段 A: `/api/atm_daily` の JSON の検証と読み込み（data/atmDaily.ts・data/adapter.ts の loadAtmDaily）と、
 * 2 営業日の動きの組（atmMoves）。値はすべて架空（F 30,000 前後・IV 20% 前後）。dev の合成の応答
 * （scripts/devFixtures.mjs の synthAtmDaily）がこの検証に通ることも確かめる。
 */

const NOV = '2026-11-12'; // 架空の 11 月限の取引最終日
const DEC = '2026-12-10';
const JAN = '2027-01-14';

const day = (
  d: string,
  iv: number,
  f1: number,
  l1 = NOV,
  f2: number | null = f1 + 10,
  l2: string | null = l1 === NOV ? DEC : JAN,
) => ({
  d,
  t: `${d}T15:00:00+09:00`,
  iv,
  f1,
  l1,
  f2: l2 === null ? null : f2,
  l2: f2 === null ? null : l2,
});

const ok = {
  schema_version: 1,
  start: '2010-01-01',
  end: '2026-10-15',
  days: [day('2026-10-13', 20, 30000), day('2026-10-14', 21.5, 29700.5, NOV, null, null)],
};

interface Init {
  signal?: AbortSignal;
  cache?: RequestCache;
  redirect?: RequestRedirect;
}

describe('validateAtmDailyJson', () => {
  it('正しい応答 → t を UNIX 秒にして返す（f2・l2 が両方 null の日も通る）', () => {
    const r = validateAtmDailyJson(ok);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.start).toBe('2010-01-01');
    expect(r.value.end).toBe('2026-10-15');
    expect(r.value.days).toEqual([
      {
        d: '2026-10-13',
        t: Date.parse('2026-10-13T15:00:00+09:00') / 1000,
        iv: 20,
        f1: 30000,
        l1: NOV,
        f2: 30010,
        l2: DEC,
        v1: null,
        v2: null,
      },
      {
        d: '2026-10-14',
        t: Date.parse('2026-10-14T15:00:00+09:00') / 1000,
        iv: 21.5,
        f1: 29700.5,
        l1: NOV,
        f2: null,
        l2: null,
        v1: null,
        v2: null,
      },
    ]);
  });

  it('v1・v2（#307）: 有限の正の数なら値、無い・null・不正はエラーにせず null。v2 は f2・l2 の組があるときだけ', () => {
    const r = validateAtmDailyJson({
      ...ok,
      days: [
        { ...day('2026-10-06', 20, 30000), v1: 22.5, v2: 19.75 },
        { ...day('2026-10-07', 20, 30000), v1: null, v2: null },
        day('2026-10-08', 20, 30000),
        { ...day('2026-10-09', 20, 30000), v1: 0, v2: -1 },
        { ...day('2026-10-13', 20, 30000), v1: '22', v2: Number.NaN },
        { ...day('2026-10-14', 20, 30000, NOV, null, null), v1: 23, v2: 21 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vs = r.value.days.map((x) => [x.v1, x.v2]);
    expect(vs).toEqual([
      [22.5, 19.75],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [23, null],
    ]);
  });

  it('日が 0 件でも通る', () => {
    expect(validateAtmDailyJson({ ...ok, days: [] }).ok).toBe(true);
  });

  const broken: [string, unknown][] = [
    ['版が違う', { ...ok, schema_version: 2 }],
    ['オブジェクトでない', [ok]],
    ['start が日付でない', { ...ok, start: '2010-01-01T00:00:00Z' }],
    ['end が実在しない日付', { ...ok, end: '2026-02-30' }],
    ['end が start より前', { ...ok, end: '2009-12-31' }],
    ['days が配列でない', { ...ok, days: {} }],
    ['昇順でない', { ...ok, days: [ok.days[1], ok.days[0]] }],
    ['重複', { ...ok, days: [ok.days[0], ok.days[0]] }],
    ['d の形', { ...ok, days: [{ ...ok.days[0], d: '2026/10/13' }] }],
    ['t がオフセットなし', { ...ok, days: [{ ...ok.days[0], t: '2026-10-13T15:00:00' }] }],
    ['iv が 0', { ...ok, days: [{ ...ok.days[0], iv: 0 }] }],
    ['iv が文字列', { ...ok, days: [{ ...ok.days[0], iv: '20' }] }],
    ['f1 が負', { ...ok, days: [{ ...ok.days[0], f1: -1 }] }],
    ['f1 が null', { ...ok, days: [{ ...ok.days[0], f1: null }] }],
    ['l1 が null', { ...ok, days: [{ ...ok.days[0], l1: null }] }],
    ['f2 だけ null', { ...ok, days: [{ ...ok.days[0], f2: null }] }],
    ['l2 だけ null', { ...ok, days: [{ ...ok.days[0], l2: null }] }],
    ['f2 が無限', { ...ok, days: [{ ...ok.days[0], f2: Number.POSITIVE_INFINITY }] }],
    ['要素が null', { ...ok, days: [null] }],
  ];
  for (const [name, v] of broken) {
    it(`壊れた応答は ok = false: ${name}`, () => {
      const r = validateAtmDailyJson(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    });
  }

  it('エラーは 50 件で打ち切る', () => {
    const days = Array.from({ length: 80 }, (_, i) => ({ ...ok.days[0], d: `x${i}` }));
    const r = validateAtmDailyJson({ ...ok, days });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(50);
  });
});

describe('atmMoves（2 営業日の動き）', () => {
  const NONE: ReadonlySet<string> = new Set();
  const v = (days: ReturnType<typeof day>[]): AtmDailyDay[] => {
    const r = validateAtmDailyJson({ ...ok, end: '2027-01-01', days });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    return r.value.days;
  };

  it('保有期間は証拠金と同じ 2 営業日', () => {
    expect(MARGIN_HORIZON_BUSINESS_DAYS).toBe(2);
  });

  it('同じ限月: dx = f1(d1) / f1(d0) − 1・ivRatio = iv1 / iv0・ivPt = iv1 − iv0（1e-12）', () => {
    // 水曜 → 金曜、木曜 → 月曜（土日を飛ばす）
    const days = v([
      day('2026-10-14', 20, 30000),
      day('2026-10-15', 21, 29900),
      day('2026-10-16', 23, 29100),
      day('2026-10-19', 22.5, 29400),
    ]);
    const moves = atmMoves(days, NONE);
    expect(moves.map((m) => [m.d0, m.d1])).toEqual([
      ['2026-10-14', '2026-10-16'],
      ['2026-10-15', '2026-10-19'],
    ]);
    const [a, b] = moves;
    expect(a?.dx).toBeCloseTo(29100 / 30000 - 1, 12);
    expect(a?.ivRatio).toBeCloseTo(23 / 20, 12);
    expect(a?.ivPt).toBeCloseTo(3, 12);
    expect(a?.iv0).toBe(20);
    expect(a?.iv1).toBe(23);
    expect(b?.dx).toBeCloseTo(29400 / 29900 - 1, 12);
    expect(b?.ivRatio).toBeCloseTo(22.5 / 21, 12);
    expect(b?.ivPt).toBeCloseTo(1.5, 12);
  });

  it('限月を跨ぐ: d1 の 1 限月が d0 の 2 限月なら f2(d0) と比べる', () => {
    const days = v([
      day('2026-11-11', 20, 30000, NOV, 30040, DEC),
      day('2026-11-13', 19, 30100, DEC, 30150, JAN),
    ]);
    const [m] = atmMoves(days, NONE);
    expect(m?.d1).toBe('2026-11-13');
    expect(m?.dx).toBeCloseTo(30100 / 30040 - 1, 12);
  });

  it('限月を跨ぐのに d0 の 2 限月が無ければ組まない（0 にしない）', () => {
    const days = v([
      day('2026-11-11', 20, 30000, NOV, null, null),
      day('2026-11-13', 19, 30100, DEC),
    ]);
    expect(atmMoves(days, NONE)).toEqual([]);
  });

  it('d1 の 1 限月が d0 の 1 限月とも 2 限月とも違えば組まない（限月が 2 つ進む欠け）', () => {
    const days = v([
      day('2026-11-11', 20, 30000, NOV, 30040, DEC),
      day('2026-11-13', 19, 30100, JAN),
    ]);
    expect(atmMoves(days, NONE)).toEqual([]);
  });

  it('d1 の行が欠けたら組まない（次の日で代えない）', () => {
    const days = v([day('2026-10-14', 20, 30000), day('2026-10-19', 21, 30100)]);
    expect(atmMoves(days, NONE)).toEqual([]);
  });

  it('土日・取引の無い日の d0 は組まない', () => {
    const days = v([
      day('2026-10-17', 20, 30000), // 土曜（行があっても）
      day('2026-10-19', 21, 30100),
      day('2026-11-03', 20, 30000), // 取引の無い日
      day('2026-11-04', 20, 30000),
      day('2026-11-05', 22, 29800),
      day('2026-11-06', 21, 29900),
    ]);
    const moves = atmMoves(days, new Set(['2026-11-03']));
    expect(moves.map((m) => m.d0)).toEqual(['2026-11-04']);
    expect(moves[0]?.d1).toBe('2026-11-06');
  });

  it('取引の無い日を跨ぐ 2 営業日（月曜 → 木曜）', () => {
    const days = v([day('2026-11-02', 20, 30000), day('2026-11-05', 22, 29400)]);
    expect(atmMoves(days, new Set(['2026-11-03'])).map((m) => [m.d0, m.d1])).toEqual([
      ['2026-11-02', '2026-11-05'],
    ]);
    // 休業日の集合が空なら（カレンダーが壊れたとき）土日だけ飛ばす → d1 = 水曜の行が無いので組まない
    expect(atmMoves(days, new Set())).toEqual([]);
  });

  it('休業日は取引カレンダーの nonTradingDays（祝日取引の実施日は取引日として数える）', () => {
    const cal = buildCalendar(
      {
        schema_version: 1,
        source: 'bigquery',
        version_at: '2026-10-01T06:40:00+09:00',
        covered_until: '2026-12-31',
        listed_until: '2027-12-31',
        days: [
          { date: '2026-11-03', is_trading_day: false, status: 'confirmed', name: '休日 A' },
          { date: '2026-11-23', is_trading_day: true, status: 'confirmed', name: '取引日 B' },
        ],
      },
      'api',
    );
    expect(cal.ok).toBe(true);
    // 11/20（金）→ 11/24（火）: 11/23（月）は祝日取引の実施日 = 取引日なので 2 営業日目は 11/24
    const days = v([
      day('2026-11-20', 20, 30000, DEC),
      day('2026-11-23', 21, 29900, DEC),
      day('2026-11-24', 22, 29800, DEC),
      day('2026-11-25', 21, 29900, DEC),
    ]);
    const moves = atmMoves(days, cal.nonTradingDays);
    expect(moves.map((m) => [m.d0, m.d1])).toEqual([
      ['2026-11-20', '2026-11-24'],
      ['2026-11-23', '2026-11-25'],
    ]);
    // holidays（版の全行）を使うと 11/23 を休みとして数えてしまう（使わない）
    expect(atmMoves(days, cal.holidays).map((m) => m.d0)).toEqual(['2026-11-20']);
    expect(atmMoves(days, cal.holidays)[0]?.d1).toBe('2026-11-25');
  });

  it('n を変えられる（1 営業日）。休業日は配列でもよい', () => {
    const days = v([day('2026-11-02', 20, 30000), day('2026-11-04', 22, 29400)]);
    expect(atmMoves(days, ['2026-11-03'], 1).map((m) => m.d1)).toEqual(['2026-11-04']);
  });
});

describe('loadAtmDaily（/api/atm_daily を読む）', () => {
  it('既定の URL（パラメータなし）・cache no-cache・redirect manual・signal を渡し、検証して返す', async () => {
    const calls: [string, Init | undefined][] = [];
    const ac = new AbortController();
    const data = await loadAtmDaily({
      signal: ac.signal,
      fetch: async (url, init) => {
        calls.push([url, init]);
        return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
      },
    });
    expect(data.days).toHaveLength(2);
    expect(calls).toEqual([
      ['/api/atm_daily', { cache: 'no-cache', redirect: 'manual', signal: ac.signal }],
    ]);
  });

  it('endpoint を差し替える（dev の /fixtures/atm_daily）', async () => {
    const calls: string[] = [];
    await loadAtmDaily({
      endpoint: '/fixtures/atm_daily',
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
      },
    });
    expect(calls).toEqual(['/fixtures/atm_daily']);
  });

  it('503・404・ログイン切れ・壊れた JSON・形の違いは ChainLoadError（応答の本文を出さない）。AbortError はそのまま', async () => {
    const res = (status: number, body: string, type?: string) => async () => ({
      ok: status >= 200 && status < 300,
      status,
      ...(type ? { type } : {}),
      text: async () => body,
    });
    const e503 = await loadAtmDaily({ fetch: res(503, 'secret') }).catch((e) => e);
    expect(e503).toBeInstanceOf(ChainLoadError);
    expect(e503.message).toBe('過去の値動きを読めない（api: HTTP 503）');
    expect(e503.kind).toBe('http');
    const e404 = await loadAtmDaily({ fetch: res(404, 'secret') }).catch((e) => e);
    expect(e404.kind).toBe('http');
    expect(e404.status).toBe(404);
    const auth = await loadAtmDaily({ fetch: res(0, '', 'opaqueredirect') }).catch((e) => e);
    expect(auth.kind).toBe('auth');
    const broken = await loadAtmDaily({ fetch: res(200, '<html>secret') }).catch((e) => e);
    expect(broken.message).toBe('過去の値動きの JSON が不正（api）');
    expect(broken.message).not.toMatch(/secret/);
    const shape = await loadAtmDaily({
      fetch: res(200, JSON.stringify({ ...ok, schema_version: 2 })),
    }).catch((e) => e);
    expect(shape).toBeInstanceOf(ChainLoadError);
    expect(shape.errors.some((x: string) => x.startsWith('$.schema_version'))).toBe(true);
    const abort = await loadAtmDaily({
      fetch: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    }).catch((e) => e);
    expect(abort.name).toBe('AbortError');
  });
});

describe('dev の合成の応答（scripts/devFixtures.mjs の synthAtmDaily。架空の値）', () => {
  it('validateAtmDailyJson で ok。取引日だけ・範囲の終わりは確定した日の次の日', () => {
    const json = synthAtmDaily();
    const r = validateAtmDailyJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const days = r.value.days;
    expect(days.length).toBeGreaterThan(400);
    // 今 = 2026-10-13 21:31 JST → 範囲の終わり = 10/13（含まない）
    expect(r.value.end).toBe('2026-10-13');
    expect(days.at(-1)?.d).toBe('2026-10-12');
    const nonTrading = buildCalendar(bundledJson, 'bundled').nonTradingDays;
    expect(days.every((d) => isBusinessDay(d.d, nonTrading))).toBe(true);
    // 8:00 前は前日まで
    const early = synthAtmDaily(Date.parse('2026-10-13T07:59:00+09:00') / 1000);
    expect(early.end).toBe('2026-10-12');
    expect(synthAtmDaily(SYNTH_IV_NOW)).toEqual(json); // 種つき（同じ要求には同じ応答）
  });

  it('毎月の限月の切り替えで組が途切れず、下げで IV が上がる（架空の反応）', () => {
    const r = validateAtmDailyJson(synthAtmDaily());
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const days = r.value.days;
    const rolls = days.filter((d, i) => i > 0 && d.l1 !== days[i - 1]?.l1).length;
    expect(rolls).toBeGreaterThan(12);
    const moves = atmMoves(days, buildCalendar(bundledJson, 'bundled').nonTradingDays);
    expect(moves.length).toBeGreaterThan(days.length * 0.9);
    const down = moves.filter((m) => m.dx < -0.01);
    const up = moves.filter((m) => m.dx > 0.01);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(down.map((m) => m.ivPt))).toBeGreaterThan(0);
    expect(mean(up.map((m) => m.ivPt))).toBeLessThan(0);
  });
});

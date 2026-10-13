import { describe, expect, it } from 'vitest';
import { validateHolidaysJson, validateTradingCalendarJson } from '../../data/calendar';
import {
  CalendarSyncError,
  HOLIDAYS_FILE,
  parseHolidaysCsv,
  parseTradingCalendarToml,
  runCalendarSync,
  TRADING_CALENDAR_FILE,
} from '../../scripts/calendarSync';

/**
 * AC-4（#14）: 取引カレンダー（optionchan の toml）と国民の祝日（内閣府の CSV）の同期。
 * toml・CSV はテスト内の合成の文字列 / バイト列で、ネットワークに出ない（fetch は偽物）。
 * 日付・名称は形を確かめるための例（optionchan の実際の toml の写しではない）。
 */

const TOML = `# 合成の取引カレンダー（optionchan の config/trading_calendar.toml と同じ構造）
#
# コメント行。URL らしき文字列 https://example.invalid/x も無視される

# 確定分の最終日
covered_until = 2027-06-30

grace_minutes = 30

# 平日の休業日
closed_dates = [
  2026-12-31, # 年末休業日
  2026-11-23, # 祝日取引を実施しない日（順不同でも昇順にする）
  2027-01-01, # 元日 # コメントの中の # も可
  2027-12-31,
]

no_night_session_before = []

# 立会時間。この表より後に書いたキーは [sessions] に入る
[sessions]
day_open = "08:45"
day_close = "15:45"
night_open = "17:00"
night_close = "06:00"
`;

const URL_OK = 'https://example.invalid/config/trading_calendar.toml';
const HOLIDAYS_URL = 'https://example.invalid/holidays.csv';

// ---------------------------------------------------------------- 合成の CSV（Shift_JIS）

function hex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);
/** 「国民の祝日・休日月日,国民の祝日・休日名称」（Shift_JIS） */
const SJIS_HEADER = hex(
  '8d9196af82cc8f6a93fa81458b7893fa8c8e93fa2c8d9196af82cc8f6a93fa81458b7893fa96bc8fcc',
);
const SJIS_YAMA = hex('8e5282cc93fa'); // 山の日
const SJIS_GANJITSU = hex('8cb393fa'); // 元日

/**
 * 合成の CSV: 2019〜lastYear の各年に 12 件（各月 1 日。名称は ASCII）と、2023/8/11 山の日・
 * 2027/2/11（名称 ASCII）。1 行目は見出し、CRLF。実在の祝日の一覧ではない。
 */
function holidaysCsv(lastYear = 2027, opts: { header?: Uint8Array } = {}): Uint8Array {
  const parts: Uint8Array[] = [opts.header ?? SJIS_HEADER, ascii('\r\n')];
  for (let y = 2019; y <= lastYear; y++) {
    for (let m = 1; m <= 12; m++) {
      if (m === 1) parts.push(ascii(`${y}/1/1,`), SJIS_GANJITSU, ascii('\r\n'));
      else parts.push(ascii(`${y}/${m}/1,day${m}\r\n`));
    }
    if (y === 2023) parts.push(ascii('2023/8/11,'), SJIS_YAMA, ascii('\r\n'));
    if (y === 2027) parts.push(ascii('2027/2/11,kenkoku\r\n'));
  }
  return concat(parts);
}

// ---------------------------------------------------------------- 偽の IO

interface FakeIo {
  files: Map<string, string>;
  writes: string[];
  fetched: string[];
  opts: Parameters<typeof runCalendarSync>[0];
}

function fakeIo(
  over: {
    env?: Record<string, string | undefined>;
    toml?: string | Uint8Array;
    csv?: Uint8Array;
    status?: number;
    files?: Map<string, string>;
    now?: string;
    /** URL ごとの応答の差し替え（リダイレクトなど） */
    respond?: (url: string) => Response | undefined;
    readText?: (p: string) => Promise<string | null>;
    writeFiles?: () => Promise<void>;
  } = {},
): FakeIo {
  const files = over.files ?? new Map<string, string>();
  const writes: string[] = [];
  const fetched: string[] = [];
  const env = over.env ?? { OPTIONCHAN_CALENDAR_URL: URL_OK, HOLIDAYS_CSV_URL: HOLIDAYS_URL };
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const custom = over.respond?.(url);
    if (custom) return custom;
    const body =
      url === HOLIDAYS_URL || !url.includes('trading_calendar')
        ? (over.csv ?? holidaysCsv())
        : (over.toml ?? TOML);
    const bytes = typeof body === 'string' ? ascii(body) : body;
    return new Response(new Uint8Array(bytes), {
      status: url === URL_OK ? (over.status ?? 200) : 200,
    });
  }) as typeof fetch;
  return {
    files,
    writes,
    fetched,
    opts: {
      env,
      fetch: fakeFetch,
      readText: over.readText ?? (async (p) => files.get(p) ?? null),
      writeFiles:
        over.writeFiles ??
        (async (list) => {
          for (const [p, c] of list) {
            writes.push(p);
            files.set(p, c);
          }
        }),
      now: () => new Date(over.now ?? '2026-10-14T01:02:03.456Z'),
      outDir: 'out',
    },
  };
}

const TC = `out/${TRADING_CALENDAR_FILE}`;
const HJ = `out/${HOLIDAYS_FILE}`;

// ---------------------------------------------------------------- toml

describe('toml の部分集合の読み込み（optionchan の calendar.py と同じ検査）', () => {
  it('optionchan と同じ構造の toml → covered_until と昇順・重複なしの closed_dates', () => {
    expect(parseTradingCalendarToml(TOML)).toEqual({
      covered_until: '2027-06-30',
      closed_dates: ['2026-11-23', '2026-12-31', '2027-01-01', '2027-12-31'],
    });
  });

  it('空の配列・1 行の配列・重複した日付', () => {
    const t = TOML.replace(
      /closed_dates = \[[^\]]*\]/,
      'closed_dates = [2027-01-01, 2026-12-31, 2027-01-01]',
    );
    expect(parseTradingCalendarToml(t).closed_dates).toEqual(['2026-12-31', '2027-01-01']);
    const e = TOML.replace(/closed_dates = \[[^\]]*\]/, 'closed_dates = []');
    expect(parseTradingCalendarToml(e).closed_dates).toEqual([]);
  });

  it.each([
    ['キーの欠落（covered_until）', TOML.replace('covered_until = 2027-06-30\n', '')],
    ['キーの欠落（grace_minutes）', TOML.replace('grace_minutes = 30\n', '')],
    ['実在しない日付', TOML.replace('covered_until = 2027-06-30', 'covered_until = 2026-02-30')],
    ['日付でない値（引用符つき）', TOML.replace('2026-11-23,', '"2026-11-23",')],
    ['日付でない値（数）', TOML.replace('covered_until = 2027-06-30', 'covered_until = 20270630')],
    ['grace_minutes が整数でない', TOML.replace('grace_minutes = 30', 'grace_minutes = "30"')],
    ['未知のキー', TOML.replace('grace_minutes = 30', 'grace_minutes = 30\nextra = 1')],
    ['キーの重複', TOML.replace('grace_minutes = 30', 'grace_minutes = 30\ngrace_minutes = 31')],
    ['未知の表', `${TOML}\n[other]\nx = 1\n`],
    ['[sessions] のキー不足', TOML.replace('night_close = "06:00"\n', '')],
    ['インライン表', TOML.replace('grace_minutes = 30', 'grace_minutes = { a = 1 }')],
    ['日時（日付でない）', TOML.replace('2026-12-31,', '2026-12-31T00:00:00,')],
    ['閉じない配列', TOML.replace('  2027-12-31,\n]', '  2027-12-31,\n')],
  ])('想定外の形は失敗: %s', (_name, text) => {
    expect(() => parseTradingCalendarToml(text)).toThrow(CalendarSyncError);
  });

  it('[sessions] の後に closed_dates を書いた toml は失敗（キーが [sessions] に入る）', () => {
    const moved = TOML.replace(/closed_dates = \[[^\]]*\]\n/, '').concat(
      'closed_dates = [2026-12-31]\n',
    );
    // closed_dates が [sessions] に入り、トップレベルに 3 キーしか残らない
    expect(() => parseTradingCalendarToml(moved)).toThrow(
      /トップレベルのキーが \[covered_until, grace_minutes, no_night_session_before\]/,
    );
  });
});

// ---------------------------------------------------------------- CSV

describe('国民の祝日の CSV（内閣府の形。Shift_JIS）', () => {
  it('Shift_JIS の名称を復号し、HOLIDAYS_FROM 以降だけを昇順で。収録の最終日 = 最終年の 12/31', () => {
    const r = parseHolidaysCsv(holidaysCsv());
    expect(r.covered_until).toBe('2027-12-31');
    expect(r.holidays[0]).toEqual({ date: '2020-01-01', name: '元日' });
    expect(r.holidays.find((h) => h.date === '2023-08-11')).toEqual({
      date: '2023-08-11',
      name: '山の日',
    });
    expect(r.holidays.some((h) => h.date.startsWith('2019'))).toBe(false);
    const dates = r.holidays.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it.each([
    ['見出し違い（1 行目がデータ）', concat([ascii('2020/1/1,x\r\n'), holidaysCsv()])],
    ['Shift_JIS として読めない', holidaysCsv(2027, { header: hex('ff2cff') })],
    ['実在しない日付', concat([holidaysCsv(), ascii('2027/2/30,x\r\n')])],
    ['日付の形が違う', concat([holidaysCsv(), ascii('2027-03-01,x\r\n')])],
    ['重複', concat([holidaysCsv(), ascii('2027/3/1,dup\r\n')])],
    ['名称が空', concat([holidaysCsv(), ascii('2027/3/2,\r\n')])],
    [
      '収録の年の件数が少ない（途中で切れた）',
      concat([holidaysCsv(2026), ascii('2027/1/1,x\r\n')]),
    ],
  ])('想定外の形は失敗: %s', (_name, bytes) => {
    expect(() => parseHolidaysCsv(bytes)).toThrow(CalendarSyncError);
  });
});

// ---------------------------------------------------------------- 同期（IO は偽物）

describe('runCalendarSync', () => {
  it('URL 未設定 → 理由を出して code ≠ 0、取得も書き込みもしない', async () => {
    const io = fakeIo({ env: {} });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(r.lines.join('\n')).toContain('OPTIONCHAN_CALENDAR_URL');
    expect(io.fetched).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it('https 以外の URL は失敗（取得しない）', async () => {
    const io = fakeIo({ env: { OPTIONCHAN_CALENDAR_URL: 'http://example.invalid/x.toml' } });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(io.fetched).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it('成功 → 2 ファイルを書き、data/calendar.ts の検証に通る。出力に URL を含めない', async () => {
    const io = fakeIo();
    const r = await runCalendarSync(io.opts);
    expect(r.code).toBe(0);
    expect(io.writes.sort()).toEqual([HJ, TC].sort());
    const tc = JSON.parse(io.files.get(TC) as string);
    const v = validateTradingCalendarJson(tc);
    expect(v.ok).toBe(true);
    expect(tc).toMatchObject({
      schema_version: 1,
      covered_until: '2027-06-30',
      closed_dates: ['2026-11-23', '2026-12-31', '2027-01-01', '2027-12-31'],
      source: { fetched_at: '2026-10-14T01:02:03Z' },
    });
    expect(tc.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateHolidaysJson(JSON.parse(io.files.get(HJ) as string)).ok).toBe(true);
    const all = [...io.files.values(), ...r.lines].join('\n');
    expect(all).not.toContain('example.invalid');
    expect(io.files.get(TC)?.endsWith('}\n')).toBe(true);
  });

  it('祝日の URL は既定値（内閣府）、HOLIDAYS_CSV_URL で上書き', async () => {
    const io = fakeIo({ env: { OPTIONCHAN_CALENDAR_URL: URL_OK } });
    expect((await runCalendarSync(io.opts)).code).toBe(0);
    expect(io.fetched).toContain('https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv');
  });

  it('内容が同じなら 2 回目は書かない（fetched_at だけ違っても差分ゼロ）', async () => {
    const io = fakeIo();
    await runCalendarSync(io.opts);
    const before = new Map(io.files);
    const io2 = fakeIo({ files: io.files, now: '2026-10-21T00:00:00Z' });
    const r = await runCalendarSync(io2.opts);
    expect(r.code).toBe(0);
    expect(io2.writes).toEqual([]);
    expect(io2.files).toEqual(before);
    expect(r.lines.filter((l) => l.includes('変更なし'))).toHaveLength(2);
  });

  it('closed_dates が変わったファイルだけ書き換え、差分を要約する', async () => {
    const io = fakeIo();
    await runCalendarSync(io.opts);
    const changed = TOML.replace('covered_until = 2027-06-30', 'covered_until = 2027-12-31')
      .replace('  2027-12-31,\n', '  2027-09-20,\n  2027-12-31,\n')
      .replace('  2026-11-23, # 祝日取引を実施しない日（順不同でも昇順にする）\n', '');
    const io2 = fakeIo({ files: io.files, toml: changed });
    const r = await runCalendarSync(io2.opts);
    expect(r.code).toBe(0);
    expect(io2.writes).toEqual([TC]);
    expect(r.lines.join('\n')).toContain('covered_until 2027-06-30 → 2027-12-31');
    expect(r.lines.join('\n')).toContain('closed_dates +1 / −1');
  });

  it.each([
    ['toml の HTTP 404', { status: 404 }],
    ['toml のキーの欠落', { toml: TOML.replace('covered_until = 2027-06-30\n', '') }],
    ['toml の日付でない値', { toml: TOML.replace('2026-11-23,', '"2026-11-23",') }],
    [
      'toml の [sessions] の後の closed_dates',
      { toml: TOML.replace(/closed_dates = \[[^\]]*\]\n/, '').concat('closed_dates = []\n') },
    ],
    ['toml が UTF-8 でない', { toml: hex('ff') }],
    ['CSV の見出し違い', { csv: concat([ascii('2020/1/1,x\r\n'), holidaysCsv()]) }],
    ['CSV の収録期間が既存より短い', { csv: holidaysCsv(2026) }],
  ])('失敗（%s）→ code ≠ 0、既存のファイルを変えない', async (_name, over) => {
    const io = fakeIo();
    await runCalendarSync(io.opts);
    const before = new Map(io.files);
    const io2 = fakeIo({ ...over, files: io.files });
    const r = await runCalendarSync(io2.opts);
    expect(r.code).not.toBe(0);
    expect(io2.writes).toEqual([]);
    expect(io2.files).toEqual(before);
    expect(r.lines.join('\n')).not.toContain('example.invalid');
  });

  it('リダイレクトは https の転送先だけ辿る', async () => {
    const moved = 'https://example.invalid/moved/trading_calendar.toml';
    const io = fakeIo({
      respond: (u) =>
        u === URL_OK
          ? new Response(null, { status: 302, headers: { location: moved } })
          : undefined,
    });
    expect((await runCalendarSync(io.opts)).code).toBe(0);
    expect(io.fetched).toContain(moved);
  });

  it('http への転送は、転送先に要求を出さずに失敗', async () => {
    const insecure = 'http://example.invalid/trading_calendar.toml';
    const io = fakeIo({
      respond: (u) =>
        u === URL_OK
          ? new Response(null, { status: 301, headers: { location: insecure } })
          : undefined,
    });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(io.fetched).not.toContain(insecure);
    expect(io.writes).toEqual([]);
  });

  it('転送が多すぎると失敗', async () => {
    const io = fakeIo({
      respond: (u) =>
        u.includes('trading_calendar')
          ? new Response(null, { status: 302, headers: { location: `${u}x` } })
          : undefined,
    });
    expect((await runCalendarSync(io.opts)).code).not.toBe(0);
    expect(io.writes).toEqual([]);
  });

  it('既存のファイルが読めない（無い以外の理由）→ 新規扱いにせず失敗', async () => {
    const io = fakeIo({
      readText: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(r.lines.join('\n')).toContain('EACCES');
    expect(io.writes).toEqual([]);
  });

  it('書き込みの失敗 → code ≠ 0、書き込みの失敗と分かる文', async () => {
    const io = fakeIo({
      writeFiles: async () => {
        throw new Error('ENOSPC');
      },
    });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(r.lines.join('\n')).toMatch(/ENOSPC.*書き込みに失敗/);
  });

  it('エラー文に取得先の URL が入っても伏せる', async () => {
    const io = fakeIo({
      readText: async () => {
        throw new Error(`boom ${URL_OK} / ${HOLIDAYS_URL}`);
      },
    });
    const r = await runCalendarSync(io.opts);
    const text = r.lines.join('\n');
    expect(r.code).not.toBe(0);
    expect(text).not.toContain('example.invalid');
    expect(text).toContain('boom <URL> / <URL>');
  });

  it('content-length の無いストリームでも 1 MiB を超えた時点で失敗', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x23);
    let sent = 0;
    const io = fakeIo({
      respond: (u) =>
        u === URL_OK
          ? new Response(
              new ReadableStream<Uint8Array>({
                pull(c) {
                  sent++;
                  if (sent > 64) c.close();
                  else c.enqueue(chunk);
                },
              }),
              { status: 200 },
            )
          : undefined,
    });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(r.lines.join('\n')).toContain('1 MiB');
    expect(sent).toBeLessThan(64); // 最後まで読まずに打ち切る
  });

  it('1 MiB を超える応答は失敗', async () => {
    const io = fakeIo({ toml: new Uint8Array(1024 * 1024 + 1).fill(0x23) });
    const r = await runCalendarSync(io.opts);
    expect(r.code).not.toBe(0);
    expect(io.writes).toEqual([]);
  });
});

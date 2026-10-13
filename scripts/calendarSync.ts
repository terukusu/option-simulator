/**
 * 取引カレンダーと国民の祝日の一覧の同期（`npm run calendar:sync`。入口は scripts/syncCalendar.mjs。
 * 同名の .mjs にすると import の解決で .mjs が先に選ばれるので名前を変えている）。
 * 設計 docs/design.md 7.5。
 *
 * - 取引カレンダー: 環境変数 OPTIONCHAN_CALENDAR_URL の optionchan の config/trading_calendar.toml
 *   （URL はリポジトリに書かない。CI ではリポジトリ変数）→ data/calendar/trading_calendar.json
 * - 国民の祝日: 内閣府の CSV（既定 DEFAULT_HOLIDAYS_CSV_URL、環境変数 HOLIDAYS_CSV_URL で上書き）
 *   → data/calendar/holidays_jp.json
 * - 両方を取得・変換・検証してから書く（どちらかが失敗したら何も書かない）。内容が同じなら書かない
 * - toml は依存を足さずに、optionchan の toml に要る部分集合だけを読む（それ以外の形は失敗）
 * - 出力（標準出力・JSON）に URL を出さない
 *
 * IO（fetch・ファイル・時刻・環境変数）は引数で受ける（テストは偽物）。node:* は import しない。
 */

import {
  CALENDAR_SCHEMA_VERSION,
  type HolidayEntry,
  type HolidaysJson,
  isIsoDate,
  type TradingCalendarJson,
  validateHolidaysJson,
  validateTradingCalendarJson,
} from '../data/calendar';

export const TRADING_CALENDAR_FILE = 'trading_calendar.json';
export const HOLIDAYS_FILE = 'holidays_jp.json';
/** 内閣府「国民の祝日について」の CSV（公的な URL） */
export const DEFAULT_HOLIDAYS_CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
/** 祝日の一覧に入れる最初の日（バンドルを小さく、出力を実行日に依存させない） */
export const HOLIDAYS_FROM = '2020-01-01';
/** 収録の各年に最低これだけの祝日がある（途中で切れた CSV を取り込まない） */
const MIN_HOLIDAYS_PER_YEAR = 10;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 30_000;

const TRADING_SOURCE_NAME = 'optionchan config/trading_calendar.toml';
const HOLIDAYS_SOURCE_NAME = '内閣府「国民の祝日」CSV（syukujitsu.csv）';

export class CalendarSyncError extends Error {
  override name = 'CalendarSyncError';
}

// ---------------------------------------------------------------- toml の部分集合

type TomlValue =
  | { kind: 'date'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'array'; items: TomlValue[] };

const TOP_KEYS = ['closed_dates', 'covered_until', 'grace_minutes', 'no_night_session_before'];
const SESSION_KEYS = ['day_close', 'day_open', 'night_close', 'night_open'];

/** 文字列の外の `#` から行末までを除く。文字列内のバックスラッシュは扱わない（失敗）。 */
function stripComment(line: string, lineNo: number): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString && c === '\\') {
      throw new CalendarSyncError(`toml ${lineNo} 行: 文字列のエスケープは扱わない`);
    }
    if (c === '"') inString = !inString;
    else if (c === '#' && !inString) return line.slice(0, i);
  }
  if (inString) throw new CalendarSyncError(`toml ${lineNo} 行: 文字列が閉じていない`);
  return line;
}

/** 文字列の外の `[` と `]` の数の差。 */
function bracketDepth(text: string): number {
  let depth = 0;
  let inString = false;
  for (const c of text) {
    if (c === '"') inString = !inString;
    else if (!inString && c === '[') depth++;
    else if (!inString && c === ']') depth--;
  }
  return depth;
}

function parseScalar(text: string, where: string): TomlValue {
  const t = text.trim();
  if (/^"[^"\\]*"$/.test(t)) return { kind: 'string', value: t.slice(1, -1) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    if (!isIsoDate(t)) throw new CalendarSyncError(`toml ${where}: 実在しない日付 ${t}`);
    return { kind: 'date', value: t };
  }
  if (/^[+-]?(0|[1-9]\d*)$/.test(t)) return { kind: 'int', value: Number(t) };
  throw new CalendarSyncError(`toml ${where}: 扱わない値の形（${t.slice(0, 40)}）`);
}

function parseValue(text: string, where: string): TomlValue {
  const t = text.trim();
  if (!t.startsWith('[')) return parseScalar(t, where);
  if (!t.endsWith(']') || bracketDepth(t) !== 0) {
    throw new CalendarSyncError(`toml ${where}: 配列の形が不正`);
  }
  const inner = t.slice(1, -1);
  if (inner.includes('[') || inner.includes(']')) {
    throw new CalendarSyncError(`toml ${where}: 入れ子の配列は扱わない`);
  }
  const parts = inner.split(',').map((p) => p.trim());
  // 末尾カンマ（と空配列）
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const items = parts.map((p) => {
    if (p === '') throw new CalendarSyncError(`toml ${where}: 配列に空の要素`);
    return parseScalar(p, where);
  });
  return { kind: 'array', items };
}

/** optionchan の toml に要る部分集合を読む: トップレベルのキーと表 [sessions]。 */
export function parseTomlSubset(text: string): {
  top: Map<string, TomlValue>;
  sessions: Map<string, TomlValue> | null;
} {
  const top = new Map<string, TomlValue>();
  let sessions: Map<string, TomlValue> | null = null;
  let current = top;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(lines[i] as string, lineNo).trim();
    if (line === '') continue;
    const table = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (table) {
      if (table[1] !== 'sessions' || sessions !== null) {
        throw new CalendarSyncError(`toml ${lineNo} 行: 扱わない表 [${table[1]}]`);
      }
      sessions = new Map();
      current = sessions;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new CalendarSyncError(`toml ${lineNo} 行: key = value の形でない`);
    const key = kv[1] as string;
    let value = kv[2] as string;
    // 複数行の配列: 括弧が閉じるまで次の行をつなぐ
    while (value.trim().startsWith('[') && bracketDepth(value) > 0) {
      i++;
      if (i >= lines.length) throw new CalendarSyncError(`toml ${lineNo} 行: 配列が閉じていない`);
      value += ` ${stripComment(lines[i] as string, i + 1)}`;
    }
    if (current.has(key)) throw new CalendarSyncError(`toml ${lineNo} 行: キー ${key} の重複`);
    current.set(key, parseValue(value, `${lineNo} 行（${key}）`));
  }
  return { top, sessions };
}

function sameKeys(m: Map<string, unknown>, expected: string[]): boolean {
  const keys = [...m.keys()].sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
}

function dateArray(v: TomlValue | undefined, key: string): string[] {
  if (v?.kind !== 'array' || !v.items.every((x) => x.kind === 'date')) {
    throw new CalendarSyncError(`toml の ${key} が日付の配列でない`);
  }
  return v.items.map((x) => (x as { value: string }).value);
}

/**
 * optionchan の config/trading_calendar.toml を読み、calendar.py（load_calendar）と同じキーの検査
 * （トップレベルのキーがちょうど 4 つ、[sessions] がちょうど 4 キー）に加えて、型を calendar.py より厳しく見る:
 * [sessions] は "HH:MM"（2 桁）、grace_minutes は整数、no_night_session_before は日付の配列。
 * 使わない値も見るのは、形の変化を optionchan 側の変更のサインとして同期を止め（何も書かない）、人が確かめる
 * ため。calendar.py が受ける形（"8:45"・30.0 など）でも失敗しうるが、失敗側に倒れるだけで誤った休業日は入らない
 */
export function parseTradingCalendarToml(text: string): {
  covered_until: string;
  closed_dates: string[];
} {
  const { top, sessions } = parseTomlSubset(text);
  if (!sameKeys(top, TOP_KEYS)) {
    throw new CalendarSyncError(
      `toml のトップレベルのキーが [${[...top.keys()].sort().join(', ')}]（期待 [${TOP_KEYS.join(', ')}]。[sessions] より後に書いたキーは [sessions] に入る）`,
    );
  }
  if (sessions === null || !sameKeys(sessions, SESSION_KEYS)) {
    throw new CalendarSyncError(
      `toml の [sessions] のキーが [${[...(sessions?.keys() ?? [])].sort().join(', ')}]（期待 [${SESSION_KEYS.join(', ')}]）`,
    );
  }
  for (const [k, v] of sessions) {
    if (v.kind !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.value)) {
      throw new CalendarSyncError(`toml の [sessions].${k} が "HH:MM" でない`);
    }
  }
  const covered = top.get('covered_until');
  if (covered?.kind !== 'date') throw new CalendarSyncError('toml の covered_until が日付でない');
  if (top.get('grace_minutes')?.kind !== 'int') {
    throw new CalendarSyncError('toml の grace_minutes が整数でない');
  }
  dateArray(top.get('no_night_session_before'), 'no_night_session_before');
  const closed = [...new Set(dateArray(top.get('closed_dates'), 'closed_dates'))].sort();
  return { covered_until: covered.value, closed_dates: closed };
}

// ---------------------------------------------------------------- 祝日の CSV

/**
 * 内閣府「国民の祝日」の CSV（Shift_JIS、1 行目は見出し、データ行は `YYYY/M/D,名称`）を読む。
 * HOLIDAYS_FROM 以降だけを昇順で返す。収録の最終日は CSV の最終年の 12/31。
 */
export function parseHolidaysCsv(bytes: Uint8Array): {
  covered_until: string;
  holidays: HolidayEntry[];
} {
  let text: string;
  try {
    text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  } catch {
    throw new CalendarSyncError('祝日の CSV が Shift_JIS として読めない');
  }
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  const header = lines.shift() ?? '';
  const cols = header.split(',');
  if (cols.length !== 2 || /^\d/.test(cols[0]?.trim() ?? '') || header.trim() === '') {
    throw new CalendarSyncError('祝日の CSV の 1 行目が見出し（2 列）でない');
  }
  const seen = new Set<string>();
  const all: HolidayEntry[] = [];
  lines.forEach((line, i) => {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),([^,]+)$/.exec(line.trim());
    if (!m) throw new CalendarSyncError(`祝日の CSV ${i + 2} 行: YYYY/M/D,名称 の形でない`);
    const date = `${m[1]}-${(m[2] as string).padStart(2, '0')}-${(m[3] as string).padStart(2, '0')}`;
    if (!isIsoDate(date)) throw new CalendarSyncError(`祝日の CSV ${i + 2} 行: 実在しない日付`);
    if (seen.has(date)) throw new CalendarSyncError(`祝日の CSV ${i + 2} 行: 日付 ${date} の重複`);
    const name = (m[4] as string).trim();
    if (name === '') throw new CalendarSyncError(`祝日の CSV ${i + 2} 行: 名称が空`);
    seen.add(date);
    all.push({ date, name });
  });
  if (all.length === 0) throw new CalendarSyncError('祝日の CSV にデータ行が無い');
  const lastYear = Math.max(...all.map((h) => Number(h.date.slice(0, 4))));
  const holidays = all
    .filter((h) => h.date >= HOLIDAYS_FROM)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const firstYear = Number(HOLIDAYS_FROM.slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    const n = holidays.filter((h) => h.date.startsWith(`${y}-`)).length;
    if (n < MIN_HOLIDAYS_PER_YEAR) {
      throw new CalendarSyncError(
        `祝日の CSV の ${y} 年が ${n} 件（${MIN_HOLIDAYS_PER_YEAR} 件未満。途中で切れている）`,
      );
    }
  }
  return { covered_until: `${lastYear}-12-31`, holidays };
}

// ---------------------------------------------------------------- 同期

export interface CalendarSyncIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** ファイルが無ければ null。読めない（権限など）なら例外（新規扱いにしない） */
  readText(path: string): Promise<string | null>;
  /**
   * 複数のファイルをまとめて書く。全部を一時ファイルに書いてから rename し、途中で失敗したら
   * 書いたものを元に戻して例外（呼び出し側は「何も書いていない」として扱う）
   */
  writeFiles(files: ReadonlyArray<readonly [path: string, content: string]>): Promise<void>;
  now(): Date;
  outDir: string;
}

export interface CalendarSyncResult {
  /** 0 = 成功（書いた / 変更なし）、1 = 失敗（何も書いていない） */
  code: number;
  /** 標準出力に出す行（URL を含めない） */
  lines: string[];
}

function requireHttps(url: string, name: string): void {
  let ok = false;
  try {
    ok = new URL(url).protocol === 'https:';
  } catch {
    ok = false;
  }
  if (!ok) throw new CalendarSyncError(`${name} が https の URL でない`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * https の URL から 1 MiB までを取得する。リダイレクトは自分で辿り、転送先も https だけ（http への転送先には
 * 要求を出さない）。本文はストリームで読み、1 MiB を超えた時点で打ち切る（content-length を信用しない）。
 */
async function fetchBytes(
  f: typeof fetch,
  url: string,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = url;
  let res: Response;
  for (let hop = 0; ; hop++) {
    requireHttps(current, hop === 0 ? label : `${label} の転送先`);
    try {
      res = await f(current, { redirect: 'manual', signal });
    } catch (e) {
      const name = e instanceof Error ? e.name : 'Error';
      throw new CalendarSyncError(`${label} を取得できない（${name}）`);
    }
    if (!REDIRECT_STATUSES.has(res.status)) break;
    const location = res.headers.get('location');
    if (location === null || hop >= MAX_REDIRECTS) {
      throw new CalendarSyncError(`${label} の転送を辿れない（HTTP ${res.status}）`);
    }
    try {
      current = new URL(location, current).href;
    } catch {
      throw new CalendarSyncError(`${label} の転送先が URL でない`);
    }
  }
  if (res.status !== 200) throw new CalendarSyncError(`${label} の取得が HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) throw new CalendarSyncError(`${label} が 1 MiB を超える`);
  const out = new Uint8Array(MAX_BYTES);
  let n = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        throw new CalendarSyncError(`${label} を読み切れない（${name}）`);
      }
      if (chunk.done) break;
      if (n + chunk.value.byteLength > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CalendarSyncError(`${label} が 1 MiB を超える`);
      }
      out.set(chunk.value, n);
      n += chunk.value.byteLength;
    }
  }
  return out.slice(0, n);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function serializeCalendarJson(v: TradingCalendarJson | HolidaysJson): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

/** fetched_at 以外の全項目（sha256 を含む）が同じか。 */
function sameContent(a: { source: { fetched_at: string } }, b: unknown): boolean {
  const strip = (v: unknown) => {
    const c = structuredClone(v) as { source?: { fetched_at?: string } };
    if (c?.source) c.source.fetched_at = '';
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
}

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function diffCount(before: readonly string[], after: readonly string[]): string {
  const b = new Set(before);
  const a = new Set(after);
  const added = after.filter((x) => !b.has(x)).length;
  const removed = before.filter((x) => !a.has(x)).length;
  return `+${added} / −${removed}`;
}

export async function runCalendarSync(io: CalendarSyncIo): Promise<CalendarSyncResult> {
  const url = io.env.OPTIONCHAN_CALENDAR_URL?.trim() ?? '';
  const holidaysUrl = io.env.HOLIDAYS_CSV_URL?.trim() || DEFAULT_HOLIDAYS_CSV_URL;
  let writing = false;
  if (url === '') {
    return {
      code: 1,
      lines: [
        '失敗: OPTIONCHAN_CALENDAR_URL が未設定（optionchan の config/trading_calendar.toml の URL を環境変数で渡す）。何も取得・書き込みしない',
      ],
    };
  }
  try {
    requireHttps(url, 'OPTIONCHAN_CALENDAR_URL');
    requireHttps(holidaysUrl, 'HOLIDAYS_CSV_URL');
    const fetchedAt = io
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const [tomlBytes, csvBytes] = await Promise.all([
      fetchBytes(io.fetch, url, '取引カレンダー（toml）'),
      fetchBytes(io.fetch, holidaysUrl, '祝日の CSV'),
    ]);

    let tomlText: string;
    try {
      tomlText = new TextDecoder('utf-8', { fatal: true }).decode(tomlBytes);
    } catch {
      throw new CalendarSyncError('取引カレンダー（toml）が UTF-8 として読めない');
    }
    const t = parseTradingCalendarToml(tomlText);
    const trading: TradingCalendarJson = {
      schema_version: CALENDAR_SCHEMA_VERSION,
      source: {
        name: TRADING_SOURCE_NAME,
        sha256: await sha256Hex(tomlBytes),
        fetched_at: fetchedAt,
      },
      covered_until: t.covered_until,
      closed_dates: t.closed_dates,
    };
    const h = parseHolidaysCsv(csvBytes);
    const holidays: HolidaysJson = {
      schema_version: CALENDAR_SCHEMA_VERSION,
      source: {
        name: HOLIDAYS_SOURCE_NAME,
        sha256: await sha256Hex(csvBytes),
        fetched_at: fetchedAt,
      },
      covered_until: h.covered_until,
      holidays: h.holidays,
    };
    // 形の正は data/calendar.ts（画面が読むときと同じ検査）
    const vt = validateTradingCalendarJson(trading);
    if (!vt.ok) throw new CalendarSyncError(`変換結果が不正: ${vt.errors.join('; ')}`);
    const vh = validateHolidaysJson(holidays);
    if (!vh.ok) throw new CalendarSyncError(`変換結果が不正: ${vh.errors.join('; ')}`);

    const tPath = `${io.outDir}/${TRADING_CALENDAR_FILE}`;
    const hPath = `${io.outDir}/${HOLIDAYS_FILE}`;
    const oldT = parseJsonOrNull(await io.readText(tPath));
    const oldH = parseJsonOrNull(await io.readText(hPath));
    const oldTv = validateTradingCalendarJson(oldT);
    const oldHv = validateHolidaysJson(oldH);
    if (oldHv.ok && holidays.covered_until < oldHv.value.covered_until) {
      throw new CalendarSyncError(
        `祝日の CSV の収録の最終日が既存より短い（${oldHv.value.covered_until} → ${holidays.covered_until}）`,
      );
    }

    const lines: string[] = [];
    const writes: Array<[string, string]> = [];
    if (sameContent(trading, oldT)) lines.push(`${TRADING_CALENDAR_FILE}: 変更なし`);
    else {
      writes.push([tPath, serializeCalendarJson(trading)]);
      lines.push(
        oldTv.ok
          ? `${TRADING_CALENDAR_FILE}: 更新（covered_until ${oldTv.value.covered_until} → ${trading.covered_until}、closed_dates ${diffCount(oldTv.value.closed_dates, trading.closed_dates)}）`
          : `${TRADING_CALENDAR_FILE}: 新規（covered_until ${trading.covered_until}、closed_dates ${trading.closed_dates.length} 件）`,
      );
    }
    if (sameContent(holidays, oldH)) lines.push(`${HOLIDAYS_FILE}: 変更なし`);
    else {
      writes.push([hPath, serializeCalendarJson(holidays)]);
      const dates = holidays.holidays.map((x) => x.date);
      lines.push(
        oldHv.ok
          ? `${HOLIDAYS_FILE}: 更新（covered_until ${oldHv.value.covered_until} → ${holidays.covered_until}、祝日 ${diffCount(
              oldHv.value.holidays.map((x) => x.date),
              dates,
            )}）`
          : `${HOLIDAYS_FILE}: 新規（covered_until ${holidays.covered_until}、祝日 ${dates.length} 件）`,
      );
    }
    writing = true;
    if (writes.length > 0) await io.writeFiles(writes);
    return { code: 0, lines };
  } catch (e) {
    const msg =
      e instanceof CalendarSyncError
        ? e.message
        : `予期しないエラー（${e instanceof Error ? e.message : String(e)}）`;
    // 念のため URL を伏せる（ログ・PR 本文に取得先を出さない）
    const safe = [url, holidaysUrl].reduce((s, u) => s.split(u).join('<URL>'), msg);
    const state = writing
      ? '書き込みに失敗（書いたファイルは元に戻す。戻せなければエラー文に出る）'
      : '何も書き込んでいない';
    return { code: 1, lines: [`失敗: ${safe}。${state}`] };
  }
}

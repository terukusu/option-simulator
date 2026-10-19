/**
 * データ元のアダプタ。設計 docs/design.md 7.4・M9。
 *
 * どのアダプタも `/api/chain` と同じ JSON を返し、検証まで済ませる（正規化は normalizeChain。
 * 金利・評価時刻の設定を変えても読み直さずに正規化し直せるよう分けている）。
 *
 * - `file`: 開発の既定。URL（Vite の dev サーバーが配る fixture など）か、ブラウザで選んだファイル（Blob）
 * - `bigquery`: 本番の既定（#34）。ブラウザからは同一オリジンの `/api/chain` を読む（サーバーは api/）
 * - 手入力は板を読まない（legs.ts の manualOptionLeg / futureLeg）
 *
 * 取引カレンダーは板と別に同一オリジンの `/api/calendar` を読む（loadCalendarJson。7.5）。
 * IV 推移は IV 推移を開いたときだけ同一オリジンの `/api/atm_iv` を読む（loadAtmIv。7.1。#79）。
 * 日次の値は追証マップを開いたときだけ同一オリジンの `/api/atm_daily` を読む（loadAtmDaily。7.1。#152）。
 */

import { type AtmDailyData, validateAtmDailyJson } from './atmDaily';
import { type AtmIvData, type AtmIvSource, atmIvUrl, validateAtmIvJson } from './atmIv';
import { type CalendarJson, validateCalendarJson } from './calendar';
import { type ChainJson, parseChainJson } from './chainJson';
import { type Chain, type NormalizeOptions, normalizeChain } from './normalize';

export type AdapterKind = 'file' | 'bigquery';

export interface LoadOptions {
  /** この時刻以前で最新の使える板（ISO 8601。bigquery だけ。file は無視） */
  at?: string;
  signal?: AbortSignal;
}

export interface ChainAdapter {
  readonly kind: AdapterKind;
  /** 板の JSON を読んで検証する。壊れていれば ChainLoadError */
  loadChain(opts?: LoadOptions): Promise<ChainJson>;
}

/**
 * 板とカレンダーの読み込みの失敗の種別（画面の文言を分ける。ui/load.ts の describeLoadError）。
 * - `invalid`: JSON の検証エラー（errors に明細）
 * - `http`: 2xx 以外（status あり）
 * - `auth`: IAP のログイン切れ（redirect: 'manual' の opaqueredirect か 401）
 * - `network`: 通信エラー（fetch の例外。AbortError は除く）
 */
export type ChainLoadErrorKind = 'invalid' | 'http' | 'auth' | 'network';

export class ChainLoadError extends Error {
  readonly errors: readonly string[];
  readonly kind: ChainLoadErrorKind;
  /** HTTP の状態（http / auth。opaqueredirect は 0）。それ以外は null */
  readonly status: number | null;

  constructor(
    message: string,
    errors: readonly string[] = [],
    opts: { kind?: ChainLoadErrorKind; status?: number | null } = {},
  ) {
    super(message);
    this.name = 'ChainLoadError';
    this.errors = errors;
    this.kind = opts.kind ?? 'invalid';
    this.status = opts.status ?? null;
  }
}

interface FetchInit {
  signal?: AbortSignal;
  cache?: RequestCache;
  redirect?: RequestRedirect;
}

export type FetchLike = (
  input: string,
  init?: FetchInit,
) => Promise<{
  ok: boolean;
  status: number;
  /** Response.type（redirect: 'manual' でリダイレクトされると 'opaqueredirect'） */
  type?: string;
  text(): Promise<string>;
}>;

function parseOrThrow(text: string, origin: string): ChainJson {
  const res = parseChainJson(text);
  if (!res.ok) throw new ChainLoadError(`板の JSON が不正（${origin}）`, res.errors);
  return res.value;
}

async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  opts: LoadOptions,
  label: string,
  base: Omit<FetchInit, 'signal'>,
  /** 何を読むか（エラーの文言の名詞） */
  what: '板' | 'カレンダー' | 'IV 推移' | '過去の値動き' = '板',
): Promise<string> {
  const init: FetchInit = { ...base };
  if (opts.signal) init.signal = opts.signal;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new ChainLoadError(`${what}を読めない（${label}: 通信エラー）`, [], { kind: 'network' });
  }
  // 応答の本文はエラーメッセージに入れない（サーバーの例外本文・ログイン画面を画面に反射しない）
  if (res.type === 'opaqueredirect' || res.status === 401) {
    throw new ChainLoadError(`ログインが切れた（${label}）`, [], {
      kind: 'auth',
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new ChainLoadError(`${what}を読めない（${label}: HTTP ${res.status}）`, [], {
      kind: 'http',
      status: res.status,
    });
  }
  return res.text();
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export type FileAdapterSource =
  | { url: string; fetch?: FetchLike }
  | { blob: { text(): Promise<string> }; name?: string };

/** `file` アダプタ: URL かファイル（Blob）から板の JSON を読む。 */
export function createFileAdapter(source: FileAdapterSource): ChainAdapter {
  return {
    kind: 'file',
    async loadChain(opts: LoadOptions = {}) {
      if ('blob' in source) {
        const text = await source.blob.text();
        return parseOrThrow(text, source.name ?? 'ファイル');
      }
      const text = await fetchText(source.fetch ?? defaultFetch, source.url, opts, 'file', {
        cache: 'no-store',
      });
      return parseOrThrow(text, source.url);
    },
  };
}

export interface BigQueryAdapterOptions {
  /** API の URL（既定は同一オリジンの /api/chain） */
  endpoint?: string;
  fetch?: FetchLike;
}

/**
 * `bigquery` アダプタ（ブラウザ側）: サーバーの `/api/chain`（BigQuery から使える板を選んで返す。7.1・7.2）を読む。
 *
 * - `cache: 'no-cache'`: 毎回 If-None-Match でサーバーに再検証する（変わっていなければ 304 で本文なし）
 * - `redirect: 'manual'`: IAP のログイン切れ（ログイン画面への 302）に追従せず、ログイン切れとして扱う
 */
export function createBigQueryAdapter(opts: BigQueryAdapterOptions = {}): ChainAdapter {
  const endpoint = opts.endpoint ?? '/api/chain';
  return {
    kind: 'bigquery',
    async loadChain(load: LoadOptions = {}) {
      const url = load.at ? `${endpoint}?at=${encodeURIComponent(load.at)}` : endpoint;
      const text = await fetchText(opts.fetch ?? defaultFetch, url, load, 'api', {
        cache: 'no-cache',
        redirect: 'manual',
      });
      return parseOrThrow(text, 'api');
    },
  };
}

export interface CalendarLoadOptions {
  /** API の URL（既定は同一オリジンの /api/calendar） */
  endpoint?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * 取引カレンダー（`/api/calendar`。optionchan の trading_calendar_latest の版）を読んで検証する（7.5）。
 * fetch の作法は `/api/chain` と同じ（`cache: 'no-cache'` で再検証・`redirect: 'manual'` でログイン切れを検出）。
 * 失敗は ChainLoadError（kind・status。応答の本文は入れない）。AbortError はそのまま投げる。
 */
export async function loadCalendarJson(opts: CalendarLoadOptions = {}): Promise<CalendarJson> {
  const load: LoadOptions = opts.signal ? { signal: opts.signal } : {};
  const text = await fetchText(
    opts.fetch ?? defaultFetch,
    opts.endpoint ?? '/api/calendar',
    load,
    'api',
    { cache: 'no-cache', redirect: 'manual' },
    'カレンダー',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChainLoadError('カレンダーの JSON が不正（api）', ['$: JSON として解析できない']);
  }
  const r = validateCalendarJson(parsed);
  if (!r.ok) throw new ChainLoadError('カレンダーの JSON が不正（api）', r.errors);
  return r.value;
}

export interface AtmIvLoadOptions {
  /** API の URL（既定は同一オリジンの /api/atm_iv。dev の合成の応答は /fixtures/atm_iv） */
  endpoint?: string;
  /** 読む範囲（UNIX 秒。UTC の 0 時にそろえる。省略 = 右端の 1 回分） */
  range?: { start: number; end: number };
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * IV 推移（`/api/atm_iv`。#79）を読んで検証する。fetch の作法は `/api/calendar` と同じ（`cache: 'no-cache'`・
 * `redirect: 'manual'` でログイン切れを検出）。失敗は ChainLoadError（応答の本文は入れない）。AbortError はそのまま投げる。
 */
export async function loadAtmIv(tf: AtmIvSource, opts: AtmIvLoadOptions = {}): Promise<AtmIvData> {
  const load: LoadOptions = opts.signal ? { signal: opts.signal } : {};
  const text = await fetchText(
    opts.fetch ?? defaultFetch,
    atmIvUrl(opts.endpoint ?? '/api/atm_iv', tf, opts.range),
    load,
    'api',
    { cache: 'no-cache', redirect: 'manual' },
    'IV 推移',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChainLoadError('IV 推移の JSON が不正（api）', ['$: JSON として解析できない']);
  }
  const r = validateAtmIvJson(parsed, tf);
  if (!r.ok) throw new ChainLoadError('IV 推移の JSON が不正（api）', r.errors);
  return r.value;
}

export interface AtmDailyLoadOptions {
  /** API の URL（既定は同一オリジンの /api/atm_daily。dev の合成の応答は /fixtures/atm_daily） */
  endpoint?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * 日次の値（`/api/atm_daily`。#152。追証マップの過去の点）を読んで検証する。パラメータなし。fetch の作法は
 * `/api/calendar` と同じ（`cache: 'no-cache'`・`redirect: 'manual'` でログイン切れを検出）。失敗は ChainLoadError
 * （応答の本文は入れない）。AbortError はそのまま投げる。
 */
export async function loadAtmDaily(opts: AtmDailyLoadOptions = {}): Promise<AtmDailyData> {
  const load: LoadOptions = opts.signal ? { signal: opts.signal } : {};
  const text = await fetchText(
    opts.fetch ?? defaultFetch,
    opts.endpoint ?? '/api/atm_daily',
    load,
    'api',
    { cache: 'no-cache', redirect: 'manual' },
    '過去の値動き',
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChainLoadError('過去の値動きの JSON が不正（api）', ['$: JSON として解析できない']);
  }
  const r = validateAtmDailyJson(parsed);
  if (!r.ok) throw new ChainLoadError('過去の値動きの JSON が不正（api）', r.errors);
  return r.value;
}

/** 読んで正規化まで（UI の既定の経路）。 */
export async function loadNormalizedChain(
  adapter: ChainAdapter,
  normalize: NormalizeOptions = {},
  load: LoadOptions = {},
): Promise<Chain> {
  return normalizeChain(await adapter.loadChain(load), normalize);
}

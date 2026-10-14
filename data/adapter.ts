/**
 * データ元のアダプタ。設計 docs/design.md 7.4・M9。
 *
 * どのアダプタも `/api/chain` と同じ JSON を返し、検証まで済ませる（正規化は normalizeChain。
 * 金利・評価時刻の設定を変えても読み直さずに正規化し直せるよう分けている）。
 *
 * - `file`: 開発の既定。URL（Vite の dev サーバーが配る fixture など）か、ブラウザで選んだファイル（Blob）
 * - `bigquery`: 本番の既定（#34）。ブラウザからは同一オリジンの `/api/chain` を読む（サーバーは api/）
 * - 手入力は板を読まない（legs.ts の manualOptionLeg / futureLeg）
 */

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
 * 読み込みの失敗の種別（画面の文言を分ける。ui/load.ts の describeLoadError）。
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

type FetchLike = (
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
): Promise<string> {
  const init: FetchInit = { ...base };
  if (opts.signal) init.signal = opts.signal;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new ChainLoadError(`板を読めない（${label}: 通信エラー）`, [], { kind: 'network' });
  }
  // 応答の本文はエラーメッセージに入れない（サーバーの例外本文・ログイン画面を画面に反射しない）
  if (res.type === 'opaqueredirect' || res.status === 401) {
    throw new ChainLoadError(`ログインが切れた（${label}）`, [], {
      kind: 'auth',
      status: res.status,
    });
  }
  if (!res.ok) {
    throw new ChainLoadError(`板を読めない（${label}: HTTP ${res.status}）`, [], {
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

/** 読んで正規化まで（UI の既定の経路）。 */
export async function loadNormalizedChain(
  adapter: ChainAdapter,
  normalize: NormalizeOptions = {},
  load: LoadOptions = {},
): Promise<Chain> {
  return normalizeChain(await adapter.loadChain(load), normalize);
}

/**
 * データ元のアダプタ。設計 docs/design.md 7.4・M9。
 *
 * どのアダプタも `/api/chain` と同じ JSON を返し、検証まで済ませる（正規化は normalizeChain。
 * 金利・評価時刻の設定を変えても読み直さずに正規化し直せるよう分けている）。
 *
 * - `file`: 開発の既定。URL（Vite の dev サーバーが配る fixture など）か、ブラウザで選んだファイル（Blob）
 * - `bigquery`: 本番。ブラウザからは同一オリジンの `/api/chain` を読む（サーバー側は縦切り 2）
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

export class ChainLoadError extends Error {
  readonly errors: readonly string[];

  constructor(message: string, errors: readonly string[] = []) {
    super(message);
    this.name = 'ChainLoadError';
    this.errors = errors;
  }
}

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; cache?: RequestCache },
) => Promise<{
  ok: boolean;
  status: number;
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
): Promise<string> {
  const init: { signal?: AbortSignal; cache: RequestCache } = { cache: 'no-store' };
  if (opts.signal) init.signal = opts.signal;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new ChainLoadError(`板を読めない（${label}: 通信エラー）`);
  }
  // 応答の本文はエラーメッセージに入れない（サーバーの例外本文を画面に反射しない）
  if (!res.ok) throw new ChainLoadError(`板を読めない（${label}: HTTP ${res.status}）`);
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
      const text = await fetchText(source.fetch ?? defaultFetch, source.url, opts, 'file');
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
 * サーバーは縦切り 2 で作る。ここは file と同じインターフェースに合わせただけ。
 */
export function createBigQueryAdapter(opts: BigQueryAdapterOptions = {}): ChainAdapter {
  const endpoint = opts.endpoint ?? '/api/chain';
  return {
    kind: 'bigquery',
    async loadChain(load: LoadOptions = {}) {
      const url = load.at ? `${endpoint}?at=${encodeURIComponent(load.at)}` : endpoint;
      const text = await fetchText(opts.fetch ?? defaultFetch, url, load, 'api');
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

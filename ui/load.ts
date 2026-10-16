/**
 * 板の読み込み。設計 docs/design.md 7.4・M9。
 * 本番は開いたら 1 回と [最新] で `bigquery` アダプタ（同一オリジンの /api/chain。#34）。
 * dev サーバーは合成の fixture（vite.config.ts のプラグインが配る）が既定で、API（Vite の /api プロキシ）にも切り替えられる。
 * ファイル選択（`file` アダプタ）はどちらでも使える。自動ポーリングはしない（7.3 (4)）。
 */

import {
  type Chain,
  type ChainJson,
  ChainLoadError,
  createBigQueryAdapter,
  createFileAdapter,
  DEFAULT_RATE,
  normalizeChain,
} from '../data';
import type { LoadErrorView } from './state';

/** 読み込みエラーで出す明細の最大件数 */
export const MAX_ERROR_LINES = 20;

/** API から読んだ板のデータ元のラベル（Loader の「表示中」・ヘッダの取得時刻に出す） */
export const API_LABEL = 'API';

/** 保存した最後の板で表示しているときのデータ元の表示（#23） */
export function savedBoardLabel(label: string): string {
  return `保存した板（${label}）`;
}

export type InitialSource = { kind: 'fixture'; name: 'latest' } | { kind: 'api' };

/** 画面を開いたときに最初に読むデータ元（dev = 合成の latest、本番 = API）。 */
export function initialSource(isDev: boolean): InitialSource {
  return isDev ? { kind: 'fixture', name: 'latest' } : { kind: 'api' };
}

/** 読み込みの行の文言（読み込み中 / 「表示中: <データ元>」。ファイルならその名前。#48）。 */
export function loaderNote(loading: boolean, sourceLabel: string | null): string {
  if (loading) return '読み込み中…';
  return sourceLabel ? `表示中: ${sourceLabel}` : '';
}

/** dev サーバーが配る合成の板の URL（`/fixtures/<name>.json`）。 */
export function fixtureUrl(name: string): string {
  return `/fixtures/${encodeURIComponent(name)}.json`;
}

/** 読み込んだ板（正規化した板と、保存に使う検証済みの板 JSON。#23）。 */
export interface LoadedBoard {
  chain: Chain;
  json: ChainJson;
}

function board(json: ChainJson): LoadedBoard {
  return { chain: normalizeChain(json, { r: DEFAULT_RATE }), json };
}

/** URL（dev の合成の fixture）から板を読む。 */
export async function loadBoardFromUrl(url: string, signal?: AbortSignal): Promise<LoadedBoard> {
  return board(await createFileAdapter({ url }).loadChain(signal ? { signal } : {}));
}

/** API（`/api/chain`）から最新の板を読む。 */
export async function loadBoardFromApi(signal?: AbortSignal): Promise<LoadedBoard> {
  return board(await createBigQueryAdapter().loadChain(signal ? { signal } : {}));
}

export async function loadFromUrl(url: string, signal?: AbortSignal): Promise<Chain> {
  return (await loadBoardFromUrl(url, signal)).chain;
}

/** API（`/api/chain`）から最新の板を読んで正規化する。 */
export async function loadFromApi(signal?: AbortSignal): Promise<Chain> {
  return (await loadBoardFromApi(signal)).chain;
}

export async function loadFromFile(file: Blob & { name?: string }): Promise<Chain> {
  const json = await createFileAdapter({ blob: file, name: file.name ?? 'ファイル' }).loadChain();
  return normalizeChain(json, { r: DEFAULT_RATE });
}

/** 例外を画面に出す形に（明細は検証エラーだけ、最大 MAX_ERROR_LINES 件）。応答の本文は含めない。 */
export function describeLoadError(e: unknown): LoadErrorView {
  if (e instanceof ChainLoadError) {
    switch (e.kind) {
      case 'http':
        return {
          message:
            e.status === 503
              ? 'API が板を返せない（HTTP 503: 使える板が無いか BigQuery に届かない。しばらくして [最新]）'
              : `板を読めない（HTTP ${e.status ?? '?'}）`,
          errors: [],
        };
      case 'auth':
        return { message: 'ログインが切れた（ページを読み直してから [最新]）', errors: [] };
      case 'network':
        return { message: '板を読めない（通信エラー）', errors: [] };
      case 'invalid': {
        const errors = e.errors.slice(0, MAX_ERROR_LINES);
        if (e.errors.length > MAX_ERROR_LINES) {
          errors.push(`ほか ${e.errors.length - MAX_ERROR_LINES} 件`);
        }
        return { message: e.message, errors };
      }
    }
  }
  return { message: '板を読めない（JSON として読めないか、正規化に失敗）', errors: [] };
}

/**
 * 板の読み込み。設計 docs/design.md 7.4・M9。
 * 本番は開いたら 1 回と [最新] で `bigquery` アダプタ（同一オリジンの /api/chain。#34）。
 * dev サーバーは合成の fixture（vite.config.ts のプラグインが配る）が既定で、API（Vite の /api プロキシ）にも切り替えられる。
 * ファイル選択（`file` アダプタ）はどちらでも使える。自動ポーリングはしない（7.3 (4)）。
 */

import {
  type Chain,
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

export type InitialSource = { kind: 'fixture'; name: 'latest' } | { kind: 'api' };

/** 画面を開いたときに最初に読むデータ元（dev = 合成の latest、本番 = API）。 */
export function initialSource(isDev: boolean): InitialSource {
  return isDev ? { kind: 'fixture', name: 'latest' } : { kind: 'api' };
}

/** dev サーバーが配る合成の板の URL（`/fixtures/<name>.json`）。 */
export function fixtureUrl(name: string): string {
  return `/fixtures/${encodeURIComponent(name)}.json`;
}

export async function loadFromUrl(url: string, signal?: AbortSignal): Promise<Chain> {
  const json = await createFileAdapter({ url }).loadChain(signal ? { signal } : {});
  return normalizeChain(json, { r: DEFAULT_RATE });
}

/** API（`/api/chain`）から最新の板を読んで正規化する。 */
export async function loadFromApi(signal?: AbortSignal): Promise<Chain> {
  const json = await createBigQueryAdapter().loadChain(signal ? { signal } : {});
  return normalizeChain(json, { r: DEFAULT_RATE });
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

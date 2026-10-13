/**
 * 板の読み込み（`file` アダプタ）。設計 docs/design.md 7.4・M9。
 * dev サーバーでは合成の fixture（vite.config.ts のプラグインが配る）、本番はファイル選択だけ。
 */

import {
  type Chain,
  ChainLoadError,
  createFileAdapter,
  DEFAULT_RATE,
  normalizeChain,
} from '../data';
import type { LoadErrorView } from './state';

/** 読み込みエラーで出す明細の最大件数 */
export const MAX_ERROR_LINES = 20;

/** dev サーバーが配る合成の板の URL（`/fixtures/<name>.json`）。 */
export function fixtureUrl(name: string): string {
  return `/fixtures/${encodeURIComponent(name)}.json`;
}

export async function loadFromUrl(url: string, signal?: AbortSignal): Promise<Chain> {
  const json = await createFileAdapter({ url }).loadChain(signal ? { signal } : {});
  return normalizeChain(json, { r: DEFAULT_RATE });
}

export async function loadFromFile(file: Blob & { name?: string }): Promise<Chain> {
  const json = await createFileAdapter({ blob: file, name: file.name ?? 'ファイル' }).loadChain();
  return normalizeChain(json, { r: DEFAULT_RATE });
}

/** 例外を画面に出す形に（明細は最大 MAX_ERROR_LINES 件）。 */
export function describeLoadError(e: unknown): LoadErrorView {
  if (e instanceof ChainLoadError) {
    const errors = e.errors.slice(0, MAX_ERROR_LINES);
    if (e.errors.length > MAX_ERROR_LINES) {
      errors.push(`ほか ${e.errors.length - MAX_ERROR_LINES} 件`);
    }
    return { message: e.message, errors };
  }
  return { message: '板を読めない（JSON として読めないか、正規化に失敗）', errors: [] };
}

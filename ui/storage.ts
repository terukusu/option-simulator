/**
 * localStorage の薄い I/O（#23）。例外を外に出さない。Storage は引数で受ける（テストは偽物を渡す）。
 *
 * - `window.localStorage` の参照そのものが例外を投げることがある（Safari の一部設定・Cookie のブロック）
 * - 書き込みは容量超過（QuotaExceededError）と、それ以外（private モードの一部・無効化）を分けて返す
 */

export type WriteResult = 'ok' | 'quota' | 'unavailable';

/** 使える localStorage（参照で例外・無ければ null）。 */
export function getStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readKey(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** 容量超過の例外か（名前・旧来の code 22 / Firefox の 1014）。 */
export function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

export function writeKey(storage: Storage | null, key: string, value: string): WriteResult {
  if (!storage) return 'unavailable';
  try {
    storage.setItem(key, value);
    return 'ok';
  } catch (e) {
    return isQuotaError(e) ? 'quota' : 'unavailable';
  }
}

export function removeKey(storage: Storage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // 消せなくても画面は続ける
  }
}

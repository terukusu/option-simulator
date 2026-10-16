/**
 * ポジ帳の読み書き（#70）。Storage は引数で受ける（テストは偽物を渡す）。例外を外に出さない。
 *
 * - 操作のたびに storage から読み直してから純関数（ui/book.ts）を当てて書く（別のタブの変更を潰さない）
 * - 新しい版の入れ物は書かない。読めない入れ物は [空にする] だけ書ける（allowInvalid）
 * - 容量超過（quota）は最後に取れた板のキーを消して 1 回だけ再試行（#23 と同じ: 利用者のデータ > 板のキャッシュ）。
 *   それでも書けなければ変更しない（呼び出し側は state を変えない）
 */

import {
  BOOK_KEY,
  type Book,
  type BookFail,
  type BookOp,
  type BookRead,
  EMPTY_BOOK,
  readBook,
} from './book';
import { BOARD_KEY } from './persist';
import { readKey, removeKey, writeKey } from './storage';

export function loadBook(storage: Storage | null): BookRead {
  return readBook(readKey(storage, BOOK_KEY));
}

export type CommitFail = BookFail | 'invalid' | 'newer' | 'quota' | 'unavailable';

export type CommitResult =
  | { ok: true; read: Extract<BookRead, { kind: 'ok' }>; added?: number; skipped?: number }
  | { ok: false; reason: CommitFail; read: BookRead };

/** 読み直し → 操作 → 書き込み（quota なら板を消して 1 回だけ再試行）。 */
export function commitBook(
  storage: Storage | null,
  op: (book: Book) => BookOp,
  opts: { allowInvalid?: boolean } = {},
): CommitResult {
  const read = loadBook(storage);
  if (read.kind === 'newer') return { ok: false, reason: 'newer', read };
  if (read.kind === 'invalid' && !opts.allowInvalid) return { ok: false, reason: 'invalid', read };
  const book = read.kind === 'ok' ? read.book : EMPTY_BOOK;
  const res = op(book);
  if (!res.ok) return { ok: false, reason: res.reason, read };
  let written = writeKey(storage, BOOK_KEY, res.text);
  if (written === 'quota') {
    removeKey(storage, BOARD_KEY);
    written = writeKey(storage, BOOK_KEY, res.text);
  }
  if (written !== 'ok') return { ok: false, reason: written, read };
  const out: CommitResult = {
    ok: true,
    read: { kind: 'ok', book: res.book, chars: res.text.length },
  };
  if (res.added !== undefined) out.added = res.added;
  if (res.skipped !== undefined) out.skipped = res.skipped;
  return out;
}

/** 項目の id（crypto.randomUUID。使えない環境（http の非 localhost など）は時刻 + 乱数）。 */
export function newBookId(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    // 下の代わりの値
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

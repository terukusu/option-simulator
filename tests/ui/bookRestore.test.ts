/**
 * #87 (C) AC-6: 保存一覧の上書きを戻す（`restoreEntry`）。
 * 合成の板（fixtures/synthetic の latest。架空の値）から作った作業で、項目 3 件の真ん中を上書きして戻す。
 */
import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  addEntry,
  type Book,
  type BookOp,
  type BookRead,
  EMPTY_BOOK,
  type OkEntry,
  overwriteEntry,
  readBook,
  removeEntry,
  renameEntry,
  restoreEntry,
  serializeBook,
} from '../../ui/book';
import { type SavedWorkspaceV1, toSaved } from '../../ui/persist';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { fixture } from '../support/fixtures';

const NOW = Date.parse('2026-10-16T03:00:00.000Z');
const chain: Chain = normalizeChain(fixture('latest'));

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

function okOp(r: BookOp): Extract<BookOp, { ok: true }> {
  if (!r.ok) throw new Error(`断られた: ${r.reason}`);
  return r;
}

function okRead(r: BookRead): Book {
  if (r.kind !== 'ok') throw new Error(`読めない: ${r.kind}`);
  return r.book;
}

function entryAt(book: Book, i: number): OkEntry {
  const e = book.entries[i];
  if (e?.status !== 'ok') throw new Error(`項目 ${i} が読めない`);
  return e;
}

const loaded = (): State =>
  run({ ...initialState, feePerLot: 50 }, { type: 'loaded', chain, label: 'latest' });

/** 足 2 本（架空の行使価格の売り 2 本） */
function twoLegs(): State {
  return run(
    loaded(),
    { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 70500, optionType: 'call', side: 'sell' },
  );
}

/** 足 3 本（2 本 + 買い 1 本、手数料も変える） */
function threeLegs(): State {
  return run(
    twoLegs(),
    { type: 'addBoardLeg', expiry: '2026-11', k: 67000, optionType: 'call', side: 'buy' },
    { type: 'setFee', fee: 300 },
  );
}

const savedOf = (s: State, now: number): SavedWorkspaceV1 => toSaved(s, now);

/** 項目 3 件（先頭が c、真ん中が b、末尾が a。addEntry は先頭に入れる） */
function book3(): Book {
  let book: Book = EMPTY_BOOK;
  const saved = savedOf(twoLegs(), NOW);
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    book = okOp(addEntry(book, saved, `P${i + 1}`, NOW + i * 1000, id)).book;
  }
  return book;
}

/** 真ん中（b）を 3 本の作業で上書きし、戻すのに要る 2 つの項目を返す */
function overwriteMiddle(book: Book, at = NOW + 60_000) {
  const prev = entryAt(book, 1);
  const res = okOp(overwriteEntry(book, prev.id, savedOf(threeLegs(), at)));
  const written = entryAt(res.book, 1);
  return { prev, written, after: res.book };
}

describe('restoreEntry（#87 AC-6）', () => {
  it('(a) 上書き → 戻すで serializeBook が上書きの前と一致し、id・名前・並び・作った時刻が同じ', () => {
    const book = book3();
    const before = serializeBook(book);
    const { prev, written, after } = overwriteMiddle(book);
    expect(serializeBook(after)).not.toBe(before);
    expect(written.ws.position.legs).toHaveLength(3);
    const back = okOp(restoreEntry(after, prev, written));
    expect(serializeBook(back.book)).toBe(before);
    expect(back.text).toBe(before);
    expect(back.book.entries.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    const mid = entryAt(back.book, 1);
    expect(mid.name).toBe(prev.name);
    expect(mid.createdAt).toBe(prev.createdAt);
    expect(mid.ws.savedAt).toBe(prev.ws.savedAt);
    expect(mid.ws.position.legs).toHaveLength(2);
    // 他の項目は同じ参照
    expect(back.book.entries[0]).toBe(after.entries[0]);
    expect(back.book.entries[2]).toBe(after.entries[2]);
  });

  it('(b) 書いた文字列を readBook で読み直した book に当てても同じ（commitBook は読み直してから当てる）', () => {
    const stored = readBook(serializeBook(book3()));
    const book = okRead(stored);
    const before = serializeBook(book);
    const { prev, written, after } = overwriteMiddle(book);
    const reread = okRead(readBook(serializeBook(after)));
    const back = okOp(restoreEntry(reread, prev, written));
    expect(back.text).toBe(before);
    // 戻した文字列を読み直しても同じ
    expect(serializeBook(okRead(readBook(back.text)))).toBe(before);
  });

  it('(c) 上書きの後に名前の変更・削除・別の上書きがあったら notFound で断る', () => {
    const { prev, written, after } = overwriteMiddle(book3());
    const renamed = okOp(renameEntry(after, 'b', '別の名前')).book;
    expect(restoreEntry(renamed, prev, written)).toEqual({ ok: false, reason: 'notFound' });
    const removed = okOp(removeEntry(after, 'b')).book;
    expect(restoreEntry(removed, prev, written)).toEqual({ ok: false, reason: 'notFound' });
    // 同じ中身でも保存の時刻が違う上書き
    const again = okOp(overwriteEntry(after, 'b', savedOf(threeLegs(), NOW + 120_000))).book;
    expect(restoreEntry(again, prev, written)).toEqual({ ok: false, reason: 'notFound' });
    // 中身の違う上書き
    const other = okOp(overwriteEntry(after, 'b', savedOf(twoLegs(), NOW + 60_000))).book;
    expect(restoreEntry(other, prev, written)).toEqual({ ok: false, reason: 'notFound' });
    // 断っても book は変えない（入力の参照のまま）
    const snap = serializeBook(renamed);
    restoreEntry(renamed, prev, written);
    expect(serializeBook(renamed)).toBe(snap);
  });

  it('(d) 他の項目を足した後でも id で探して戻せ、足した項目は残る', () => {
    const { prev, written, after } = overwriteMiddle(book3());
    const added = okOp(addEntry(after, savedOf(twoLegs(), NOW), '新しい', NOW + 9, 'd')).book;
    const back = okOp(restoreEntry(added, prev, written)).book;
    expect(back.entries.map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(entryAt(back, 2).ws.position.legs).toHaveLength(2);
    expect(entryAt(back, 0).name).toBe('新しい');
  });

  it('(e) prev と written の id が違えば notFound', () => {
    const { prev, written, after } = overwriteMiddle(book3());
    const otherPrev = entryAt(after, 0);
    expect(restoreEntry(after, otherPrev, written)).toEqual({ ok: false, reason: 'notFound' });
    expect(restoreEntry(after, prev, entryAt(after, 2))).toEqual({
      ok: false,
      reason: 'notFound',
    });
  });

  it('(f) 項目の名前・中身・時刻の組み合わせを変えた上書き → 戻すで、どれも上書きの前と一致する', () => {
    const states = [twoLegs, threeLegs];
    for (const [k, mk] of states.entries()) {
      for (const idx of [0, 1, 2]) {
        const book = okRead(readBook(serializeBook(book3())));
        const before = serializeBook(book);
        const prev = entryAt(book, idx);
        const res = okOp(overwriteEntry(book, prev.id, savedOf(mk(), NOW + 1000 * (k + idx + 7))));
        const written = entryAt(res.book, idx);
        const reread = okRead(readBook(res.text));
        expect(okOp(restoreEntry(reread, prev, written)).text).toBe(before);
      }
    }
  });
});

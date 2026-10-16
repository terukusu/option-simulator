import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import type { Leg } from '../../model';
import {
  addEntry,
  BOOK_KEY,
  BOOK_MAX_CHARS,
  type Book,
  type BookOp,
  type BookRead,
  bookKey,
  bookStorageChange,
  clearBook,
  clipName,
  copyName,
  defaultName,
  duplicateEntry,
  EMPTY_BOOK,
  entryKey,
  exportBook,
  exportFilename,
  IMPORT_MAX_BYTES,
  importIntoBook,
  MAX_ENTRIES,
  MAX_ENTRIES_READ,
  NAME_MAX,
  type OkEntry,
  overwriteEntry,
  readBook,
  removeEntry,
  renameEntry,
  sanitizeName,
  serializeBook,
  uniqueName,
} from '../../ui/book';
import {
  type SavedWorkspaceV1,
  serializeWorkspace,
  toSaved,
  WORKSPACE_KEY,
} from '../../ui/persist';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { fixture } from '../support/fixtures';
import bookV1 from './saved/book-v1.json';

const NOW = Date.parse('2026-10-16T03:00:00.000Z');

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

function okRead(r: BookRead): { book: Book; chars: number } {
  if (r.kind !== 'ok') throw new Error(`読めない: ${r.kind}`);
  return r;
}

function okOp(r: BookOp): Extract<BookOp, { ok: true }> {
  if (!r.ok) throw new Error(`断られた: ${r.reason}`);
  return r;
}

function okEntryAt(book: Book, i: number): OkEntry {
  const e = book.entries[i];
  if (e?.status !== 'ok') throw new Error(`項目 ${i} が読めない`);
  return e;
}

const chain: Chain = normalizeChain(fixture('latest'));

/** 板の足 2 本（2026-11 の P64,000 売り・C70,500 売り）の作業 */
function strangle(): State {
  return run(
    { ...initialState, feePerLot: 50 },
    { type: 'loaded', chain, label: 'latest' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 70500, optionType: 'call', side: 'sell' },
  );
}

function savedOf(state: State, now = NOW): SavedWorkspaceV1 {
  return toSaved(state, now);
}

let seq = 0;
const newId = () => `id-${++seq}`;

/** 項目 n 件のポジ帳（同じ中身・名前は「P1」…） */
function bookOf(n: number): Book {
  let book: Book = EMPTY_BOOK;
  const saved = savedOf(strangle());
  for (let i = 0; i < n; i++) book = okOp(addEntry(book, saved, `P${i + 1}`, NOW, `n${i}`)).book;
  return book;
}

/** AC2: 版 1 の fixture（tests/ui/saved/book-v1.json。一度書いたら変えない）の後方互換。 */
describe('ポジ帳の版 1 の読み取り（後方互換の固定）', () => {
  it('v1 の fixture を読むと期待の項目になる', () => {
    const { book } = okRead(readBook(JSON.stringify(bookV1)));
    expect(book.entries).toHaveLength(2);
    const a = okEntryAt(book, 0);
    expect(a.id).toBe('0b7e2c1a-5d4f-4e8a-9c3b-1f2e3d4c5b6a');
    expect(a.name).toBe('11月 ストラングル');
    expect(a.createdAt).toBe(Date.parse('2026-10-13T12:40:00.000Z'));
    expect(a.ws.savedAt).toBe(Date.parse('2026-10-13T12:45:00.000Z'));
    expect(a.ws.position.boardSnapshotAt).toBe(Date.parse('2026-10-13T21:31:00+09:00'));
    expect(a.ws.position.legs.map((l) => l.leg)).toEqual([
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2026-11',
        strike: 64000,
        side: 'sell',
        qty: 1,
        entry: 780,
        mid: 792.5,
      },
      {
        kind: 'option',
        product: 'op_large',
        type: 'call',
        expiry: '2026-11',
        strike: 70500,
        side: 'sell',
        qty: 1,
        entry: 840,
        mid: 850,
      },
    ]);
    expect(a.ws.ui.feePerLot).toBe(50);
    const b = okEntryAt(book, 1);
    expect(b.name).toBe('先物 + 手入力のコール');
    expect(b.ws.position.boardSnapshotAt).toBeNull();
    expect(b.ws.position.legs[1]?.marks).toEqual(['no_board', 'forward_from_future']);
    expect(b.ws.position.legs[1]?.optionMarket?.market.forward).toBeNaN();
    expect(b.ws.position.scenario.ivDynamics).toBe('sticky_moneyness');
    expect(b.ws.ui.futureBasis).toBe('decay');
  });

  it('書き戻しても同じ項目に読める（直列化は安定）', () => {
    const { book } = okRead(readBook(JSON.stringify(bookV1)));
    const text = serializeBook(book);
    const again = okRead(readBook(text));
    expect(again.book).toEqual(book);
    expect(serializeBook(again.book)).toBe(text);
  });
});

describe('ポジ帳の読み取りの検証（AC2・AC11）', () => {
  it('無い・JSON でない・オブジェクトでない・版が無い / 不正は empty / invalid', () => {
    expect(readBook(null)).toEqual({ kind: 'empty' });
    expect(readBook('{')).toEqual({ kind: 'invalid' });
    expect(readBook('[]')).toEqual({ kind: 'invalid' });
    expect(readBook('"x"')).toEqual({ kind: 'invalid' });
    expect(readBook(JSON.stringify({ entries: [] }))).toEqual({ kind: 'invalid' });
    expect(readBook(JSON.stringify({ schema_version: 0, entries: [] }))).toEqual({
      kind: 'invalid',
    });
    expect(readBook(JSON.stringify({ schema_version: 1.5, entries: [] }))).toEqual({
      kind: 'invalid',
    });
    expect(readBook(JSON.stringify({ schema_version: 1, entries: {} }))).toEqual({
      kind: 'invalid',
    });
  });

  it('新しい版の入れ物は読まない', () => {
    expect(readBook(JSON.stringify({ schema_version: 2, entries: [] }))).toEqual({
      kind: 'newer',
      version: 2,
    });
  });

  it(`${MAX_ENTRIES_READ} 件を超える配列は読まない（巨大な配列で固まらない）`, () => {
    const entries = Array.from({ length: MAX_ENTRIES_READ + 1 }, () => 0);
    expect(readBook(JSON.stringify({ schema_version: 1, entries }))).toEqual({ kind: 'invalid' });
  });

  it('読めない項目・新しい版の項目は残し、読んだ値のまま書き戻す（勝手に消さない）', () => {
    const v = structuredClone(bookV1) as { entries: unknown[] };
    const first = structuredClone(bookV1.entries[0]) as { workspace: Record<string, unknown> };
    const newerWs = {
      ...first,
      id: 'newer-1',
      workspace: { ...first.workspace, schema_version: 9 },
    };
    const broken = { id: 'broken-1', name: 'x', workspace: { schema_version: 1, position: 1 } };
    v.entries.push(newerWs, broken, 42, null);
    const { book } = okRead(readBook(JSON.stringify(v)));
    expect(book.entries.map((e) => e.status)).toEqual([
      'ok',
      'ok',
      'newer',
      'invalid',
      'invalid',
      'invalid',
    ]);
    expect(book.entries[2]?.status === 'newer' && book.entries[2].savedAt).toBe(
      Date.parse('2026-10-13T12:45:00.000Z'),
    );
    const back = JSON.parse(serializeBook(book)) as { entries: unknown[] };
    expect(back.entries.slice(2)).toEqual([newerWs, broken, 42, null]);
  });

  it('足が 1 本でも読めない項目は invalid（足が黙って消えない）', () => {
    const v = structuredClone(bookV1);
    (v.entries[0]?.workspace.position.legs[0]?.leg as { qty: unknown }).qty = -1;
    const { book } = okRead(readBook(JSON.stringify(v)));
    expect(book.entries[0]?.status).toBe('invalid');
    expect(book.entries[1]?.status).toBe('ok');
  });

  it('余計なキー・__proto__ は写さない（書き戻すと既知のキーだけ）', () => {
    const text = JSON.stringify(bookV1).replace(
      '"id":"0b7e2c1a',
      '"__proto__":{"polluted":true},"extra":"<img src=x>","id":"0b7e2c1a',
    );
    const { book } = okRead(readBook(text));
    const a = okEntryAt(book, 0);
    expect(Object.keys(a)).not.toContain('extra');
    const back = JSON.parse(serializeBook(book)) as { entries: Array<Record<string, unknown>> };
    expect(Object.keys(back.entries[0] ?? {})).toEqual(['id', 'name', 'created_at', 'workspace']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('id が不正・重複なら ~番号（正しい id と衝突しない）', () => {
    const v = structuredClone(bookV1) as { entries: Array<{ id: unknown }> };
    const second = v.entries[1];
    if (second) second.id = v.entries[0]?.id;
    v.entries.push({ ...structuredClone(v.entries[0]), id: '<script>' } as never);
    const { book } = okRead(readBook(JSON.stringify(v)));
    expect(book.entries.map((e) => e.id)).toEqual([
      '0b7e2c1a-5d4f-4e8a-9c3b-1f2e3d4c5b6a',
      '~1',
      '~2',
    ]);
  });

  it('名前は正規化して読む。名前が無ければ既定名', () => {
    const v = structuredClone(bookV1) as { entries: Array<{ name: unknown }> };
    const [a, b] = v.entries;
    if (!a || !b) throw new Error('fixture');
    a.name = `‮abc\u0000\n${'あ'.repeat(60)}`;
    b.name = 123;
    const { book } = okRead(readBook(JSON.stringify(v)));
    expect(okEntryAt(book, 0).name).toBe(`abc${'あ'.repeat(NAME_MAX - 3)}`);
    expect(okEntryAt(book, 1).name).toBe('2027-01 買ミニ先物 買C70,000');
  });
});

describe('名前（AC1・AC11）', () => {
  it('制御文字・双方向の制御を除き、前後の空白を取り、40 字（コードポイント）で切る', () => {
    expect(sanitizeName('  a\tb\u0007c‏⁦d  ')).toBe('abcd');
    expect(sanitizeName('\u0000\u001F')).toBe('');
    expect(sanitizeName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    const emoji = '😀'.repeat(NAME_MAX + 5);
    expect(Array.from(sanitizeName(emoji))).toHaveLength(NAME_MAX);
    expect(clipName('abc', 2)).toBe('ab');
  });

  it('既定名: 限月 + 先頭 3 本の短い文言 + 他 N 本（40 字に収まるよう本数を減らす）', () => {
    const op = (
      type: 'put' | 'call',
      strike: number,
      side: 'buy' | 'sell',
      expiry = '2026-11',
    ): Leg => ({
      kind: 'option',
      product: 'op_large',
      type,
      expiry,
      strike,
      side,
      qty: 1,
      entry: 100,
    });
    expect(defaultName([])).toBe('ポジション');
    expect(defaultName([op('put', 64000, 'sell'), op('call', 70500, 'sell')])).toBe(
      '2026-11 売P64,000 売C70,500',
    );
    expect(
      defaultName([
        op('put', 64000, 'sell'),
        op('call', 70500, 'sell', '2026-12'),
        op('put', 60000, 'buy'),
        op('call', 73000, 'buy'),
        op('put', 58000, 'buy'),
      ]),
    ).toBe('2026-11・2026-12 売P64,000 売C70,500 他3本');
    expect(
      defaultName([
        op('put', 64000, 'sell'),
        op('call', 70500, 'sell'),
        op('put', 60000, 'buy'),
        op('call', 73000, 'buy'),
      ]),
    ).toBe('2026-11 売P64,000 売C70,500 買P60,000 他1本');
    expect(
      defaultName([
        op('put', 1, 'sell', '2026-11'),
        op('put', 2, 'sell', '2026-12'),
        op('put', 3, 'sell', '2027-01'),
      ]),
    ).toBe('2026-11〜 売P1 売P2 売P3');
    const long = defaultName(
      Array.from({ length: 3 }, (_, i) => op('put', 100_000_000 + i, 'sell')),
    );
    expect(Array.from(long).length).toBeLessThanOrEqual(NAME_MAX);
  });

  it('同名に (2)・(3)。複製は (コピー)。どちらも 40 字に収める', () => {
    expect(uniqueName('A', new Set())).toBe('A');
    expect(uniqueName('A', new Set(['A']))).toBe('A (2)');
    expect(uniqueName('A', new Set(['A', 'A (2)']))).toBe('A (3)');
    const long = 'x'.repeat(NAME_MAX);
    expect(uniqueName(long, new Set([long]))).toBe(`${'x'.repeat(NAME_MAX - 4)} (2)`);
    expect(copyName('A')).toBe('A (コピー)');
    expect(Array.from(copyName(long))).toHaveLength(NAME_MAX);
  });
});

describe('操作（AC1・AC3・AC7）', () => {
  it('保存: 先頭に入る。空の名前は既定名。足 0 本は断る', () => {
    const book1 = okOp(addEntry(EMPTY_BOOK, savedOf(strangle()), '最初', NOW, 'a')).book;
    const r = okOp(addEntry(book1, savedOf(strangle(), NOW + 1), '   ', NOW + 1, 'b'));
    expect(r.book.entries.map((e) => e.id)).toEqual(['b', 'a']);
    const b = okEntryAt(r.book, 0);
    expect(b.name).toBe('2026-11 売P64,000 売C70,500');
    expect(b.createdAt).toBe(NOW + 1);
    expect(b.ws.savedAt).toBe(NOW + 1);
    expect(b.ws.ui.feePerLot).toBe(50);
    expect(readBook(r.text)).toEqual({ kind: 'ok', book: r.book, chars: r.text.length });
    const empty = run(initialState, { type: 'loaded', chain, label: 'latest' });
    expect(addEntry(EMPTY_BOOK, savedOf(empty), 'x', NOW, 'c')).toEqual({
      ok: false,
      reason: 'noLegs',
    });
  });

  it(`${MAX_ENTRIES} 件を超える保存・複製は断る`, () => {
    const full = bookOf(MAX_ENTRIES);
    expect(full.entries).toHaveLength(MAX_ENTRIES);
    expect(addEntry(full, savedOf(strangle()), 'x', NOW, 'x')).toEqual({
      ok: false,
      reason: 'full',
    });
    expect(duplicateEntry(full, 'n0', NOW, 'x')).toEqual({ ok: false, reason: 'full' });
    // 減らす・変える操作はできる
    expect(okOp(removeEntry(full, 'n0')).book.entries).toHaveLength(MAX_ENTRIES - 1);
    expect(okOp(renameEntry(full, 'n0', 'y')).book.entries).toHaveLength(MAX_ENTRIES);
  });

  it(`文字数 ${BOOK_MAX_CHARS.toLocaleString()} を超える保存は断る`, () => {
    // 足 200 本（MAX_SAVED_LEGS）の巨大な項目を重ねる
    const legs = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      leg: {
        kind: 'option' as const,
        product: 'op_large' as const,
        type: 'put' as const,
        expiry: '2026-11',
        strike: 40000 + i * 125,
        side: 'sell' as const,
        qty: 1,
        entry: 123.25,
        mid: 124.5,
      },
      marks: [],
    }));
    const big = savedOf({ ...strangle(), legs });
    let book: Book = EMPTY_BOOK;
    let res: BookOp = { ok: true, book, text: '' };
    for (let i = 0; i < MAX_ENTRIES && res.ok; i++) {
      res = addEntry(book, big, `big${i}`, NOW, `b${i}`);
      if (res.ok) book = res.book;
    }
    expect(res).toEqual({ ok: false, reason: 'tooLarge' });
    expect(serializeBook(book).length).toBeLessThanOrEqual(BOOK_MAX_CHARS);
    expect(book.entries.length).toBeLessThan(MAX_ENTRIES);
  });

  it('上書き: 中身と保存の時刻だけ変わり、id・名前・作った時刻・並びは変わらない', () => {
    const book = bookOf(3);
    const changed = run(
      strangle(),
      { type: 'setFee', fee: 0 },
      { type: 'editLeg', id: 1, patch: { qty: 3 } },
    );
    const r = okOp(overwriteEntry(book, 'n1', savedOf(changed, NOW + 5000)));
    expect(r.book.entries.map((e) => e.id)).toEqual(book.entries.map((e) => e.id));
    const before = okEntryAt(book, 1);
    const after = okEntryAt(r.book, 1);
    expect(after.name).toBe(before.name);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.ws.savedAt).toBe(NOW + 5000);
    expect(after.ws.position.legs[0]?.leg.qty).toBe(3);
    expect(after.ws.ui.feePerLot).toBe(0);
    expect(overwriteEntry(book, 'nope', savedOf(changed))).toEqual({
      ok: false,
      reason: 'notFound',
    });
  });

  it('複製: 元の直後に (コピー)・新しい id・作った時刻は今', () => {
    const book = bookOf(2);
    const r = okOp(duplicateEntry(book, 'n1', NOW + 9, 'dup'));
    expect(r.book.entries.map((e) => e.id)).toEqual(['n1', 'dup', 'n0']);
    const d = okEntryAt(r.book, 1);
    expect(d.name).toBe('P2 (コピー)');
    expect(d.createdAt).toBe(NOW + 9);
    expect(d.ws).toEqual(okEntryAt(book, 0).ws);
  });

  it('名前の変更: 正規化して入れる。空・制御文字だけは断る', () => {
    const book = bookOf(1);
    expect(okEntryAt(okOp(renameEntry(book, 'n0', ' 新しい\u0000名前 ')).book, 0).name).toBe(
      '新しい名前',
    );
    expect(renameEntry(book, 'n0', '\u0000 ')).toEqual({ ok: false, reason: 'emptyName' });
    expect(renameEntry(book, 'x', 'a')).toEqual({ ok: false, reason: 'notFound' });
  });

  it('削除: 読めない項目も消せる。空にする', () => {
    const v = structuredClone(bookV1) as { entries: unknown[] };
    v.entries.push({ id: 'bad', workspace: null });
    const { book } = okRead(readBook(JSON.stringify(v)));
    const r = okOp(removeEntry(book, 'bad'));
    expect(r.book.entries).toHaveLength(2);
    expect(removeEntry(book, 'none')).toEqual({ ok: false, reason: 'notFound' });
    const c = okOp(clearBook());
    expect(readBook(c.text)).toEqual({ kind: 'ok', book: EMPTY_BOOK, chars: c.text.length });
  });
});

describe('作業中の判定（bookKey。AC6）', () => {
  it('保存した直後は同じ key。足・シナリオ・手数料・basis を変えると違う key。表示の設定では変わらない', () => {
    const s = strangle();
    const e = okEntryAt(okOp(addEntry(EMPTY_BOOK, savedOf(s), 'a', NOW, 'a')).book, 0);
    const key = (st: State) => bookKey(st.legs, st.scenario, st.feePerLot, st.futureBasis);
    expect(entryKey(e)).toBe(key(s));
    expect(key(run(s, { type: 'setBasis', basis: 'A' }))).toBe(key(s));
    expect(key(run(s, { type: 'setMetricsUnit', unit: 'yen' }))).toBe(key(s));
    expect(key(run(s, { type: 'editLeg', id: 1, patch: { qty: 2 } }))).not.toBe(key(s));
    expect(key(run(s, { type: 'setDays', days: 1 }))).not.toBe(key(s));
    expect(key(run(s, { type: 'setFee', fee: 0 }))).not.toBe(key(s));
    expect(key(run(s, { type: 'setFutureBasis', basis: 'decay' }))).not.toBe(key(s));
    // 開いた作業（openPosition）は保存した項目と同じ key
    const opened = run(
      { ...initialState },
      { type: 'loaded', chain, label: 'latest' },
      {
        type: 'openPosition',
        legs: e.ws.position.legs,
        scenario: e.ws.position.scenario,
        feePerLot: e.ws.ui.feePerLot,
        futureBasis: e.ws.ui.futureBasis,
      },
    );
    expect(key(opened)).toBe(entryKey(e));
  });
});

describe('書き出し / 読み込み（AC8・AC11）', () => {
  it('書き出しは読める項目だけ。ファイル名は時刻だけ（JST）', () => {
    const v = structuredClone(bookV1) as { entries: unknown[] };
    v.entries.push({ id: 'bad', workspace: null });
    const { book } = okRead(readBook(JSON.stringify(v)));
    const out = exportBook(book, NOW);
    expect(out.count).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.filename).toBe('option-simulator-positions-20261016-1200.json');
    expect(exportFilename(Number.NaN)).toBe('option-simulator-positions-export.json');
    const parsed = JSON.parse(out.text) as {
      schema_version: number;
      exported_at: string;
      entries: unknown[];
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.exported_at).toBe(new Date(NOW).toISOString());
    expect(parsed.entries).toHaveLength(2);
  });

  it('書き出したファイルを読み込むと、同名に (2) を付けて先頭に追加する（id は振り直す）', () => {
    const { book } = okRead(readBook(JSON.stringify(bookV1)));
    const out = exportBook(book, NOW);
    let n = 0;
    const r = okOp(importIntoBook(book, out.text, NOW + 1, () => `imp-${++n}`));
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.book.entries.map((e) => e.id)).toEqual([
      'imp-1',
      'imp-2',
      '0b7e2c1a-5d4f-4e8a-9c3b-1f2e3d4c5b6a',
      '7c9d8e6f-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    ]);
    const a = okEntryAt(r.book, 0);
    expect(a.name).toBe('11月 ストラングル (2)');
    expect(a.createdAt).toBe(NOW + 1);
    // 保存の時刻・中身はファイルの値
    expect(a.ws).toEqual(okEntryAt(book, 0).ws);
    expect(okEntryAt(r.book, 1).name).toBe('先物 + 手入力のコール (2)');
    // 空のポジ帳へは同じ名前で入る
    const fresh = okOp(importIntoBook(EMPTY_BOOK, out.text, NOW, newId));
    expect(fresh.book.entries.map((e) => (e.status === 'ok' ? e.name : ''))).toEqual([
      '11月 ストラングル',
      '先物 + 手入力のコール',
    ]);
  });

  it('#23 の作業 1 つも読み込める（名前は既定名）', () => {
    const r = okOp(importIntoBook(EMPTY_BOOK, JSON.stringify(savedOf(strangle())), NOW, newId));
    expect(r.added).toBe(1);
    expect(okEntryAt(r.book, 0).name).toBe('2026-11 売P64,000 売C70,500');
  });

  it('読めない項目は追加せず件数を返す', () => {
    const v = structuredClone(bookV1) as { entries: unknown[] };
    v.entries.push({ id: 'bad', workspace: null }, 'x');
    const r = okOp(importIntoBook(EMPTY_BOOK, JSON.stringify(v), NOW, newId));
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.book.entries).toHaveLength(2);
  });

  it('壊れた JSON・形の違う JSON・新しい版・大きすぎるファイルは断る', () => {
    const imp = (text: string) => importIntoBook(EMPTY_BOOK, text, NOW, newId);
    expect(imp('{')).toEqual({ ok: false, reason: 'importInvalid' });
    expect(imp('[]')).toEqual({ ok: false, reason: 'importInvalid' });
    expect(imp('{"a":1}')).toEqual({ ok: false, reason: 'importInvalid' });
    expect(imp(JSON.stringify({ schema_version: 1, entries: [] }))).toEqual({
      ok: false,
      reason: 'importEmpty',
    });
    expect(imp(JSON.stringify({ schema_version: 2, entries: [] }))).toEqual({
      ok: false,
      reason: 'importNewer',
    });
    expect(imp(JSON.stringify({ ...savedOf(strangle()), schema_version: 2 }))).toEqual({
      ok: false,
      reason: 'importNewer',
    });
    const v = structuredClone(bookV1);
    for (const e of v.entries) (e.workspace as { schema_version: number }).schema_version = 3;
    expect(imp(JSON.stringify(v))).toEqual({ ok: false, reason: 'importNewer' });
    expect(imp(' '.repeat(IMPORT_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'fileTooLarge' });
  });

  it('件数の上限を超える読み込みは全体を断る（一部だけ入れない）', () => {
    const book = bookOf(MAX_ENTRIES - 1);
    const { book: two } = okRead(readBook(JSON.stringify(bookV1)));
    expect(importIntoBook(book, exportBook(two, NOW).text, NOW, newId)).toEqual({
      ok: false,
      reason: 'full',
    });
  });
});

describe('別のタブ', () => {
  it('ポジ帳のキー（と全消去）だけ読み直す', () => {
    expect(bookStorageChange(BOOK_KEY)).toBe(true);
    expect(bookStorageChange(null)).toBe(true);
    expect(bookStorageChange(WORKSPACE_KEY)).toBe(false);
  });
});

/** #71: 作業のキーは版 2（タブの並び）になったが、保存一覧の項目・書き出すファイルは 1 ポジションの文書の版 1 のまま。 */
describe('BOX タブ（#71）との関係', () => {
  it('タブが複数でも保存するのは作業中のタブ 1 つ（版 1）。book-v1 の fixture は今も読める', () => {
    const two = run(
      strangle(),
      { type: 'addTab', mode: 'empty' },
      {
        type: 'addBoardLeg',
        expiry: '2026-11',
        k: 60000,
        optionType: 'put',
        side: 'buy',
      },
    );
    const r = addEntry(EMPTY_BOOK, savedOf(two), '', NOW, newId());
    if (!r.ok) throw new Error(r.reason);
    const entry = (JSON.parse(r.text) as { entries: Array<{ workspace: Record<string, unknown> }> })
      .entries[0];
    expect(entry?.workspace.schema_version).toBe(1);
    expect(entry?.workspace).not.toHaveProperty('tabs');
    const first = r.book.entries[0];
    expect(first?.status === 'ok' && first.ws.position.legs.length).toBe(1);
    const read = readBook(JSON.stringify(bookV1));
    expect(read.kind === 'ok' && read.book.entries.every((e) => e.status === 'ok')).toBe(true);
  });

  it('作業のキー（版 2）の文字列は読み込めない（1 ポジションの文書・保存一覧ではない）', () => {
    const text = serializeWorkspace(strangle(), NOW);
    expect(importIntoBook(EMPTY_BOOK, text, NOW, newId)).toEqual({
      ok: false,
      reason: 'importInvalid',
    });
  });
});

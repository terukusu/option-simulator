import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { addEntry, BOOK_KEY, clearBook, exportBook, readBook, removeEntry } from '../../ui/book';
import { commitBook, loadBook } from '../../ui/bookIo';
import { BOARD_KEY, toSaved } from '../../ui/persist';
import { DEFAULT_MARGIN_PREFS, PREFS_KEY, serializePrefs } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { fixture } from '../support/fixtures';

const NOW = Date.parse('2026-10-16T03:00:00.000Z');

/** 偽の Storage（容量を文字数で決める。quota を超える setItem は QuotaExceededError） */
class FakeStorage implements Storage {
  map = new Map<string, string>();
  capacity = Number.POSITIVE_INFINITY;
  failWith: unknown = null;
  writes = 0;
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.writes++;
    if (this.failWith) throw this.failWith;
    let used = value.length;
    for (const [k, v] of this.map) if (k !== key) used += v.length;
    if (used > this.capacity)
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    this.map.set(key, value);
  }
}

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

const chain = normalizeChain(fixture('latest'));
const state = run(
  initialState,
  { type: 'loaded', chain, label: 'latest' },
  { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
);
const saved = toSaved(state, NOW);
const add = (id: string) => (b: Parameters<typeof addEntry>[0]) => addEntry(b, saved, id, NOW, id);

describe('ポジ帳の読み書き（AC3）', () => {
  it('読み直してから操作して書く（別のタブの変更を潰さない）', () => {
    const st = new FakeStorage();
    expect(commitBook(st, add('a')).ok).toBe(true);
    // 別のタブが b を足した
    const other = readBook(st.getItem(BOOK_KEY));
    if (other.kind !== 'ok') throw new Error('読めない');
    const r = addEntry(other.book, saved, 'b', NOW, 'b');
    if (!r.ok) throw new Error(r.reason);
    st.setItem(BOOK_KEY, r.text);
    const res = commitBook(st, add('c'));
    expect(res.ok && res.read.book.entries.map((e) => e.id)).toEqual(['c', 'b', 'a']);
    expect(loadBook(st)).toEqual(res.ok ? res.read : null);
  });

  it('容量超過なら最後に取れた板を消して 1 回だけ再試行する', () => {
    const st = new FakeStorage();
    st.map.set(BOARD_KEY, 'x'.repeat(5000));
    st.capacity = 5000;
    const res = commitBook(st, add('a'));
    expect(res.ok).toBe(true);
    expect(st.map.has(BOARD_KEY)).toBe(false);
    expect(st.writes).toBe(2);
  });

  it('それでも書けなければ変更しない（quota / unavailable）', () => {
    const st = new FakeStorage();
    st.capacity = 10;
    const res = commitBook(st, add('a'));
    expect(res).toMatchObject({ ok: false, reason: 'quota' });
    expect(st.map.has(BOOK_KEY)).toBe(false);
    const st2 = new FakeStorage();
    st2.failWith = new Error('SecurityError');
    expect(commitBook(st2, add('a'))).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(commitBook(null, add('a'))).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('操作が断られたら書かない', () => {
    const st = new FakeStorage();
    expect(commitBook(st, (b) => removeEntry(b, 'none'))).toMatchObject({
      ok: false,
      reason: 'notFound',
    });
    expect(st.writes).toBe(0);
  });

  it('新しい版の入れ物は書かない。読めない入れ物は [空にする] だけ書ける（勝手に上書きしない）', () => {
    const st = new FakeStorage();
    const newer = JSON.stringify({ schema_version: 2, entries: [] });
    st.map.set(BOOK_KEY, newer);
    expect(commitBook(st, add('a'))).toMatchObject({ ok: false, reason: 'newer' });
    expect(commitBook(st, () => clearBook(), { allowInvalid: true })).toMatchObject({
      ok: false,
      reason: 'newer',
    });
    expect(st.map.get(BOOK_KEY)).toBe(newer);

    st.map.set(BOOK_KEY, '{broken');
    expect(commitBook(st, add('a'))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(st.map.get(BOOK_KEY)).toBe('{broken');
    const res = commitBook(st, () => clearBook(), { allowInvalid: true });
    expect(res.ok && res.read.book.entries).toEqual([]);
  });
});

/** #131 AC15: 資金は端末の設定（option-simulator.prefs）だけ。保存一覧の中身・書き出しに載らない */
describe('資金を保存一覧・書き出しに載せない（#131 AC15）', () => {
  it('端末の設定に資金があっても、保存一覧の値と書き出しの文字列に資金の値もキーも無い', () => {
    const CAPITAL = 12_345_678; // 架空
    const st = new FakeStorage();
    st.setItem(
      PREFS_KEY,
      serializePrefs({ theme: 'auto', margin: { ...DEFAULT_MARGIN_PREFS, capitalYen: CAPITAL } }),
    );
    const res = commitBook(st, add('a'));
    if (!res.ok) throw new Error(res.reason);
    const out = exportBook(res.read.book, NOW);
    expect(out.count).toBe(1);
    const stored = st.getItem(BOOK_KEY) ?? '';
    expect(stored).not.toBe('');
    for (const text of [stored, out.text]) {
      expect(text).not.toContain(String(CAPITAL));
      expect(text).not.toContain('capital');
      expect(text).not.toContain('margin_');
    }
    // 設定のキーは別（書いたまま残る）
    expect(st.getItem(PREFS_KEY)).toContain(`"capital_yen":${CAPITAL}`);
  });
});

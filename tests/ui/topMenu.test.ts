/**
 * #87 (C) AC-14: トップバーの ⋯ メニューの行（topMenuModel）と、保存一覧の上書き・書き出し / 読み込みのトーストの文。
 */
import { describe, expect, it } from 'vitest';
import type { BookRead } from '../../ui/book';
import type { CommitFail } from '../../ui/bookIo';
import { BOOK_FAIL_TEXT } from '../../ui/view/bookList';
import {
  bookIoToast,
  CLEAR_NO_LEGS_TEXT,
  overwrittenText,
  RESTORE_ENTRY_CHANGED_TEXT,
  restoreEntryFailText,
  type TopMenuInput,
  topMenuModel,
} from '../../ui/view/topMenu';

const base: TopMenuInput = {
  bookCount: 3,
  bookState: 'ok',
  legCount: 2,
  share: { disabled: false, title: 't' },
  fixtures: [],
  sourceLabel: null,
  theme: 'auto',
};

const row = (i: TopMenuInput, key: string) => topMenuModel(i).find((r) => r.key === key);

describe('topMenuModel', () => {
  it('並びと区切り（本番 = 合成の板なし）', () => {
    const rows = topMenuModel(base);
    expect(rows.map((r) => [r.label, r.sep === true])).toEqual([
      ['保存一覧（3）…', false],
      ['URL をコピー', false],
      ['書き出し', false],
      ['読み込み…', false],
      ['ファイルを開く…', true],
      ['全クリア', true],
      ['設定…', true],
      ['端末に合わせる', true],
      ['ダーク', false],
      ['ライト', false],
    ]);
  });

  it('dev: 合成の板 3 つはファイルを開く… の直後（区切りなし）、今の板に checked', () => {
    const rows = topMenuModel({
      ...base,
      fixtures: ['latest', 'night_early', 'pre_open'],
      sourceLabel: 'night_early',
    });
    expect(rows.map((r) => r.key)).toEqual([
      'book',
      'share',
      'export',
      'import',
      'file',
      'fixture:latest',
      'fixture:night_early',
      'fixture:pre_open',
      'clear',
      'settings',
      'theme:auto',
      'theme:dark',
      'theme:light',
    ]);
    const fx = rows.filter((r) => r.key.startsWith('fixture:'));
    expect(fx.map((r) => [r.label, r.checked, r.sep])).toEqual([
      ['合成の板 latest', false, undefined],
      ['合成の板 night_early', true, undefined],
      ['合成の板 pre_open', false, undefined],
    ]);
  });

  it('保存一覧の件数: null → 保存一覧…、0 → 保存一覧（0）…', () => {
    expect(row({ ...base, bookCount: null }, 'book')?.label).toBe('保存一覧…');
    expect(row({ ...base, bookCount: 0 }, 'book')?.label).toBe('保存一覧（0）…');
  });

  it('書き出し・読み込み… の押せる / 押せない（invalid / newer / empty / ok）', () => {
    const cases: [BookRead['kind'], boolean, boolean, string | null][] = [
      ['ok', false, false, null],
      ['empty', true, false, null],
      ['invalid', true, true, BOOK_FAIL_TEXT.invalid],
      ['newer', true, true, BOOK_FAIL_TEXT.newer],
    ];
    for (const [bookState, exportOff, importOff, reason] of cases) {
      const ex = row({ ...base, bookState }, 'export');
      const im = row({ ...base, bookState }, 'import');
      expect(ex?.disabled === true).toBe(exportOff);
      expect(im?.disabled === true).toBe(importOff);
      if (reason !== null) {
        expect(ex?.title).toBe(reason);
        expect(im?.title).toBe(reason);
      }
    }
  });

  it('足 0 本で全クリアが押せない（理由は title）', () => {
    expect(row({ ...base, legCount: 0 }, 'clear')).toMatchObject({
      disabled: true,
      title: CLEAR_NO_LEGS_TEXT,
    });
    expect(row(base, 'clear')?.disabled).toBeUndefined();
  });

  it('URL をコピーの状態をそのまま映す', () => {
    expect(row({ ...base, share: { disabled: true, title: '足が無い' } }, 'share')).toMatchObject({
      disabled: true,
      title: '足が無い',
    });
    expect(row(base, 'share')).toEqual({ key: 'share', label: 'URL をコピー', title: 't' });
  });

  it('テーマの checked は 1 つだけ', () => {
    for (const theme of ['auto', 'dark', 'light'] as const) {
      const rows = topMenuModel({ ...base, theme }).filter((r) => r.key.startsWith('theme:'));
      expect(rows.filter((r) => r.checked).map((r) => r.key)).toEqual([`theme:${theme}`]);
    }
  });
});

describe('上書きを戻す・書き出し / 読み込みのトースト', () => {
  it('overwrittenText', () => {
    expect(overwrittenText('11月 ストラングル')).toBe('「11月 ストラングル」を上書きした');
  });

  it('restoreEntryFailText: notFound だけ置き換え、ほかは BOOK_FAIL_TEXT と同じ', () => {
    for (const r of Object.keys(BOOK_FAIL_TEXT) as CommitFail[]) {
      expect(restoreEntryFailText(r)).toBe(
        r === 'notFound' ? RESTORE_ENTRY_CHANGED_TEXT : BOOK_FAIL_TEXT[r],
      );
    }
    expect(RESTORE_ENTRY_CHANGED_TEXT).toBe('戻せなかった（保存一覧が変わった）');
  });

  it('bookIoToast: 失敗は警告の知らせ、成功は普通のトースト', () => {
    expect(bookIoToast({ text: '2 件を書き出した', warn: false })).toEqual({
      kind: 'book-io',
      text: '2 件を書き出した',
    });
    expect(bookIoToast({ text: BOOK_FAIL_TEXT.importInvalid, warn: true })).toEqual({
      kind: 'book-io',
      text: BOOK_FAIL_TEXT.importInvalid,
      note: 'warn',
    });
  });
});

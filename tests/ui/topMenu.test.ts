/**
 * #87 (C) AC-14・#275: トップバーの ⋯ メニューの行（topMenuModel）と、保存一覧の上書きを戻すトーストの文。
 */
import { describe, expect, it } from 'vitest';
import type { CommitFail } from '../../ui/bookIo';
import { BOOK_FAIL_TEXT } from '../../ui/view/bookList';
import { TABS_FULL_TEXT } from '../../ui/view/tabs';
import {
  CLEAR_HELD_TEXT,
  CLEAR_NO_LEGS_TEXT,
  clearBlockedText,
  NO_CHAIN_TEXT,
  overwrittenText,
  REBASE_COPY_LABEL,
  REBASE_LABEL,
  RESTORE_ENTRY_CHANGED_TEXT,
  rebaseBlockedText,
  rebaseLabel,
  restoreEntryFailText,
  type TopMenuInput,
  topMenuModel,
} from '../../ui/view/topMenu';

const base: TopMenuInput = {
  bookCount: 3,
  share: { disabled: false, title: 't' },
  fixtures: [],
  sourceLabel: null,
};

const row = (i: TopMenuInput, key: string) => topMenuModel(i).find((r) => r.key === key);

describe('topMenuModel', () => {
  it('#275（EPIC #281 終了条件 4）: 本番（合成の板なし）の行は 6 以下 = 保有ポジション…（#302）/ 保存一覧… / URL をコピー / ファイルを開く… / 設定…', () => {
    const rows = topMenuModel(base);
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(rows.map((r) => [r.label, r.sep === true])).toEqual([
      ['保有ポジション…', false],
      ['保存一覧（3）…', false],
      ['URL をコピー', false],
      ['ファイルを開く…', true],
      ['設定…', true],
    ]);
  });

  it('#275: 別の入口がある行（テーマ・用語集・全クリア・書き出し / 読み込み）は無い', () => {
    const keys = topMenuModel({ ...base, fixtures: ['latest'] }).map((r) => r.key as string);
    for (const k of [
      'theme:auto',
      'theme:dark',
      'theme:light',
      'glossary',
      'clear',
      'export',
      'import',
    ])
      expect(keys).not.toContain(k);
  });

  it('dev: 合成の板 3 つはファイルを開く… の直後（区切りなし）、今の板に checked', () => {
    const rows = topMenuModel({
      ...base,
      fixtures: ['latest', 'night_early', 'pre_open'],
      sourceLabel: 'night_early',
    });
    expect(rows.map((r) => r.key)).toEqual([
      'holdings',
      'book',
      'share',
      'file',
      'fixture:latest',
      'fixture:night_early',
      'fixture:pre_open',
      'settings',
    ]);
    const fx = rows.filter((r) => r.key.startsWith('fixture:'));
    expect(fx.map((r) => [r.label, r.checked, r.sep])).toEqual([
      ['合成の板 latest', false, undefined],
      ['合成の板 night_early', true, undefined],
      ['合成の板 pre_open', false, undefined],
    ]);
  });

  it('#302 AC9: 保有ポジション… は保存一覧の上（先頭）。件数を出さず、押せない状態を持たない（板が無くても開ける）', () => {
    const rows = topMenuModel({ ...base, bookCount: null });
    expect(rows[0]).toEqual({ key: 'holdings', label: '保有ポジション…' });
    expect(rows[1]?.key).toBe('book');
  });

  it('保存一覧の件数: null → 保存一覧…、0 → 保存一覧（0）…', () => {
    expect(row({ ...base, bookCount: null }, 'book')?.label).toBe('保存一覧…');
    expect(row({ ...base, bookCount: 0 }, 'book')?.label).toBe('保存一覧（0）…');
  });

  it('URL をコピーの状態をそのまま映す', () => {
    expect(row({ ...base, share: { disabled: true, title: '足が無い' } }, 'share')).toMatchObject({
      disabled: true,
      title: '足が無い',
    });
    expect(row(base, 'share')).toEqual({ key: 'share', label: 'URL をコピー', title: 't' });
  });
});

describe('上書きを戻すトースト', () => {
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
});

describe('#301 保有のタブの全クリア・建て直しの理由と名前（ポジションの ⋯ とパレットが共用）', () => {
  it('建て直しの理由の順: 板が無い → 足が無い → 保有のタブでタブが上限', () => {
    expect(rebaseBlockedText(false, 0, true, false)).toBe(NO_CHAIN_TEXT);
    expect(rebaseBlockedText(true, 0, true, false)).toBe(CLEAR_NO_LEGS_TEXT);
    expect(rebaseBlockedText(true, 2, true, false)).toBe(TABS_FULL_TEXT);
    expect(rebaseBlockedText(true, 2, true, true)).toBeNull();
    // 検討中のタブは上限でも押せる（今のタブを建て直す。#298 のまま）
    expect(rebaseBlockedText(true, 2, false, false)).toBeNull();
    expect(rebaseBlockedText(true, 2)).toBeNull();
  });

  it('全クリアの理由: 足が無い → 保有のタブ', () => {
    expect(clearBlockedText(0, true)).toBe(CLEAR_NO_LEGS_TEXT);
    expect(clearBlockedText(0, false)).toBe(CLEAR_NO_LEGS_TEXT);
    expect(clearBlockedText(2, true)).toBe(CLEAR_HELD_TEXT);
    expect(clearBlockedText(2, false)).toBeNull();
  });

  it('建て直しの名前: 保有のタブは「写しを今の板で建て直す」', () => {
    expect(rebaseLabel(true)).toBe(REBASE_COPY_LABEL);
    expect(REBASE_COPY_LABEL).toBe('写しを今の板で建て直す');
    expect(rebaseLabel(false)).toBe(REBASE_LABEL);
  });
});

/**
 * 新しい画面のトップバーの ⋯ メニュー（#87 (C)・#275。docs/ui-redesign.md §2.1・§3）と、保存一覧の上書きを戻す
 * トーストの文（純関数。DOM・時計を読まない）。TopBar は行を描くだけ。
 */

import type { CommitFail } from '../bookIo';
import type { ThemePref } from '../prefs';
import { BOOK_FAIL_TEXT } from './bookList';
import type { MenuRow, ShareItemState } from './boxTabs';

export type TopMenuKey = 'book' | 'share' | 'file' | `fixture:${string}` | 'settings';

export interface TopMenuInput {
  /** 保存一覧の件数（読めない・新しい版なら null） */
  bookCount: number | null;
  share: ShareItemState;
  /** dev サーバーが配る合成の板の名前（本番は空） */
  fixtures: readonly string[];
  /** 今の板の名前（合成の板の checked） */
  sourceLabel: string | null;
}

/** 足 0 本で全クリアが押せない理由（ポジションの ⋯ とパレット） */
export const CLEAR_NO_LEGS_TEXT = '足が無い';

/** テーマの選択肢（トップバーの ☾ とコマンドパレットのテーマの行） */
export const THEMES: readonly { theme: ThemePref; label: string }[] = [
  { theme: 'auto', label: '端末に合わせる' },
  { theme: 'dark', label: 'ダーク' },
  { theme: 'light', label: 'ライト' },
];

/**
 * ⋯ の行（#275 で入口を 1 本に絞った）: 保存一覧（N）… / URL をコピー /（区切り）ファイルを開く… /（dev）合成の板 /
 * （区切り）設定…。ほかの入口は 1 か所ずつ: 書き出し / 読み込み… = 保存一覧のダイアログ、全クリア = ポジションの ⋯、
 * テーマ = トップバーの ☾（とキー T）、用語集 = ⓘ の末尾・内訳・AI の用語（PC はパレットの `?`）。
 * 押せない: URL をコピー = shareItemState のまま。
 */
export function topMenuModel(i: TopMenuInput): MenuRow<TopMenuKey>[] {
  return [
    { key: 'book', label: i.bookCount === null ? '保存一覧…' : `保存一覧（${i.bookCount}）…` },
    {
      key: 'share',
      label: 'URL をコピー',
      title: i.share.title,
      ...(i.share.disabled ? { disabled: true } : {}),
    },
    { key: 'file', label: 'ファイルを開く…', sep: true },
    ...i.fixtures.map(
      (name): MenuRow<TopMenuKey> => ({
        key: `fixture:${name}`,
        label: `合成の板 ${name}`,
        checked: i.sourceLabel === name,
      }),
    ),
    { key: 'settings', label: '設定…', sep: true },
  ];
}

// ---------------------------------------------------------------- 上書きを戻す

/** 保存一覧の [上書き] のトーストの文（[元に戻す] 付き） */
export function overwrittenText(name: string): string {
  return `「${name}」を上書きした`;
}

export const RESTORE_ENTRY_CHANGED_TEXT = '戻せなかった（保存一覧が変わった）';

/** 上書きを戻せなかった理由の文（notFound = 上書きの後に保存一覧が変わった。ほかは BOOK_FAIL_TEXT のまま） */
export function restoreEntryFailText(r: CommitFail): string {
  return r === 'notFound' ? RESTORE_ENTRY_CHANGED_TEXT : BOOK_FAIL_TEXT[r];
}

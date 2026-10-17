/**
 * 新しい画面のトップバーの ⋯ メニュー（#87 (C)。docs/ui-redesign.md §2.1・§3）と、保存一覧の上書き・書き出し /
 * 読み込みのトーストの文（純関数。DOM・時計を読まない）。TopBar は行を描くだけ。
 */

import type { BookRead } from '../book';
import type { CommitFail } from '../bookIo';
import type { ThemePref } from '../prefs';
import { BOOK_FAIL_TEXT } from './bookList';
import type { MenuRow, ShareItemState } from './boxTabs';
import type { ToastInput } from './toast';

export type TopMenuKey =
  | 'book'
  | 'share'
  | 'export'
  | 'import'
  | 'file'
  | `fixture:${string}`
  | 'clear'
  | 'settings'
  | `theme:${ThemePref}`;

export interface TopMenuInput {
  /** 保存一覧の件数（読めない・新しい版なら null） */
  bookCount: number | null;
  bookState: BookRead['kind'];
  /** 作業中のタブの足の本数 */
  legCount: number;
  share: ShareItemState;
  /** dev サーバーが配る合成の板の名前（本番は空） */
  fixtures: readonly string[];
  /** 今の板の名前（合成の板の checked） */
  sourceLabel: string | null;
  theme: ThemePref;
}

/** テーマの選択肢（⋯ とコマンドパレットのテーマの行） */
export const THEMES: readonly { theme: ThemePref; label: string }[] = [
  { theme: 'auto', label: '端末に合わせる' },
  { theme: 'dark', label: 'ダーク' },
  { theme: 'light', label: 'ライト' },
];

export const CLEAR_NO_LEGS_TEXT = '足が無い';
const EXPORT_TITLE = '保存一覧を JSON のファイルに書き出す';
const IMPORT_TITLE = '書き出した JSON を読み込んで保存一覧に追加する';

/** 保存一覧が読めない / 新しい版なら、その理由（書き出し・読み込み… の title）。読めれば null */
function bookBlocked(state: BookRead['kind']): string | null {
  return state === 'invalid'
    ? BOOK_FAIL_TEXT.invalid
    : state === 'newer'
      ? BOOK_FAIL_TEXT.newer
      : null;
}

/**
 * ⋯ の行: 保存一覧（N）… / URL をコピー / 書き出し / 読み込み… /（区切り）ファイルを開く… /（dev）合成の板 /
 * （区切り）全クリア /（区切り）設定… /（区切り）テーマ 3 つ（radio）。
 * 押せない: 書き出し = 保存一覧が読めて項目がある（ok）でない、読み込み… = 読めない・新しい版（旧 Book と同じ）、
 * 全クリア = 足 0 本、URL をコピー = shareItemState のまま。
 */
export function topMenuModel(i: TopMenuInput): MenuRow<TopMenuKey>[] {
  const blocked = bookBlocked(i.bookState);
  const rows: MenuRow<TopMenuKey>[] = [
    { key: 'book', label: i.bookCount === null ? '保存一覧…' : `保存一覧（${i.bookCount}）…` },
    {
      key: 'share',
      label: 'URL をコピー',
      title: i.share.title,
      ...(i.share.disabled ? { disabled: true } : {}),
    },
    i.bookState === 'ok'
      ? { key: 'export', label: '書き出し', title: EXPORT_TITLE }
      : {
          key: 'export',
          label: '書き出し',
          disabled: true,
          title: blocked ?? '保存一覧が空（保存すると書き出せる）',
        },
    blocked === null
      ? { key: 'import', label: '読み込み…', title: IMPORT_TITLE }
      : { key: 'import', label: '読み込み…', disabled: true, title: blocked },
    { key: 'file', label: 'ファイルを開く…', sep: true },
    ...i.fixtures.map(
      (name): MenuRow<TopMenuKey> => ({
        key: `fixture:${name}`,
        label: `合成の板 ${name}`,
        checked: i.sourceLabel === name,
      }),
    ),
    i.legCount > 0
      ? { key: 'clear', label: '全クリア', sep: true }
      : { key: 'clear', label: '全クリア', sep: true, disabled: true, title: CLEAR_NO_LEGS_TEXT },
    { key: 'settings', label: '設定…', sep: true },
    ...THEMES.map(
      (t, n): MenuRow<TopMenuKey> => ({
        key: `theme:${t.theme}`,
        label: t.label,
        checked: i.theme === t.theme,
        ...(n === 0 ? { sep: true } : {}),
      }),
    ),
  ];
  return rows;
}

// ---------------------------------------------------------------- 上書きを戻す / 書き出し・読み込みのトースト

/** 保存一覧の [上書き] のトーストの文（[元に戻す] 付き） */
export function overwrittenText(name: string): string {
  return `「${name}」を上書きした`;
}

export const RESTORE_ENTRY_CHANGED_TEXT = '戻せなかった（保存一覧が変わった）';

/** 上書きを戻せなかった理由の文（notFound = 上書きの後に保存一覧が変わった。ほかは BOOK_FAIL_TEXT のまま） */
export function restoreEntryFailText(r: CommitFail): string {
  return r === 'notFound' ? RESTORE_ENTRY_CHANGED_TEXT : BOOK_FAIL_TEXT[r];
}

/** ⋯ の書き出し / 読み込み… の結果のトースト（失敗 = 警告の知らせ。文は長いので 1 行のトーストに入れない） */
export function bookIoToast(m: { text: string; warn: boolean }): ToastInput {
  return m.warn
    ? { kind: 'book-io', text: m.text, note: 'warn' }
    : { kind: 'book-io', text: m.text };
}

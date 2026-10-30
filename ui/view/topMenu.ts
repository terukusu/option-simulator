/**
 * 新しい画面のトップバーの ⋯ メニュー（#87 (C)・#275。docs/ui-redesign.md §2.1・§3）と、保存一覧の上書きを戻す
 * トーストの文（純関数。DOM・時計を読まない）。TopBar は行を描くだけ。
 */

import type { CommitFail } from '../bookIo';
import type { ThemePref } from '../prefs';
import { BOOK_FAIL_TEXT } from './bookList';
import type { MenuRow, ShareItemState } from './boxTabs';
import { TABS_FULL_TEXT } from './tabs';

export type TopMenuKey = 'holdings' | 'book' | 'share' | 'file' | `fixture:${string}` | 'settings';

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

/** 板が無くて押せない理由（パレットの ATM・建値を今の板に合わせる） */
export const NO_CHAIN_TEXT = '板が無い';

/** 保有のタブで全クリアが押せない理由（#301。ポジションの ⋯ とパレット） */
export const CLEAR_HELD_TEXT = '保有のタブ（保有を外すと消せる）';

/** 全クリアが押せない理由（押せるなら null）。足が無い → 保有のタブ（#301） */
export function clearBlockedText(legCount: number, held = false): string | null {
  if (legCount === 0) return CLEAR_NO_LEGS_TEXT;
  return held ? CLEAR_HELD_TEXT : null;
}

/** 建値を今の板に合わせる（#298）の項目名（ポジションの ⋯ とパレット） */
export const REBASE_LABEL = '建値を今の板に合わせる';

/** 保有のタブの建て直しの項目名（#301。保有のタブはそのまま、写しを新しいタブで建て直す） */
export const REBASE_COPY_LABEL = '写しを今の板で建て直す';

/** 建て直しの項目名（保有のタブなら写し。#301） */
export const rebaseLabel = (held: boolean): string => (held ? REBASE_COPY_LABEL : REBASE_LABEL);

/**
 * 建値を今の板に合わせる が押せない理由（押せるなら null）。板が無い → 足 0 本 → 保有のタブでタブが上限（写しの
 * タブを足せない。#301）の順
 */
export function rebaseBlockedText(
  hasChain: boolean,
  legCount: number,
  held = false,
  canAddTab = true,
): string | null {
  if (!hasChain) return NO_CHAIN_TEXT;
  if (legCount === 0) return CLEAR_NO_LEGS_TEXT;
  return held && !canAddTab ? TABS_FULL_TEXT : null;
}

/** テーマの選択肢（トップバーの ☾ とコマンドパレットのテーマの行） */
export const THEMES: readonly { theme: ThemePref; label: string }[] = [
  { theme: 'auto', label: '端末に合わせる' },
  { theme: 'dark', label: 'ダーク' },
  { theme: 'light', label: 'ライト' },
];

/** 保有ポジションの一覧（#302）の項目名（⋯ とパレット。件数は出さない = ⋯ を開くたびに判定しない） */
export const HOLDINGS_LABEL = '保有ポジション…';

/**
 * ⋯ の行（#275 で入口を 1 本に絞った）: 保有ポジション…（#302。ほかの入口はパレットだけ）/ 保存一覧（N）… / URL をコピー /（区切り）ファイルを開く… /（dev）合成の板 /
 * （区切り）設定…。ほかの入口は 1 か所ずつ: 書き出し / 読み込み… = 保存一覧のダイアログ、全クリア = ポジションの ⋯、
 * テーマ = トップバーの ☾（とキー T）、用語集 = ⓘ の末尾・内訳・AI の用語（PC はパレットの `?`）。
 * 押せない: URL をコピー = shareItemState のまま。
 */
export function topMenuModel(i: TopMenuInput): MenuRow<TopMenuKey>[] {
  return [
    { key: 'holdings', label: HOLDINGS_LABEL },
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

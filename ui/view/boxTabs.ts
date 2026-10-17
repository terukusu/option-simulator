/**
 * 新しい画面の BOX タブ（#87 (B)。docs/ui-redesign.md §3・§4.5）の表示モデル・文言（純関数。DOM・時計を読まない）。
 * 帯の表示モデル（tabsModel）・名前の検証（renameError）・共有の文言は ui/view/tabs.ts のまま使う。
 */

import type { ShareMake } from '../share';
import { MAX_TABS, sanitizeTabName } from '../state';
import {
  SHARE_PREPARING_TEXT,
  shareCopiedMessage,
  shareCopyDisabled,
  shareMakeError,
  TABS_FULL_TEXT,
  type TabsView,
} from './tabs';
import type { ToastInput } from './toast';

// ---------------------------------------------------------------- 閉じる / 戻す

/** タブを閉じたトーストの文（足の本数は TabView.label と同じ数え方。0 本は出さない） */
export function closedTabText(name: string, legCount: number): string {
  return legCount > 0 ? `タブ ${name}（足 ${legCount} 本）を閉じた` : `タブ ${name} を閉じた`;
}

export const RESTORE_TAB_FULL_TEXT = '戻せなかった（タブが上限）';
export const RESTORE_TAB_TAKEN_TEXT = '戻せなかった（同じ名前のタブがある）';

/**
 * 閉じたタブを戻せない理由（戻せるなら null）。reducer の restoreTab と同じ規則: 上限が先、次に名前が空か同じ名前。
 */
export function restoreTabError(
  tabs: ReadonlyArray<{ name: string }>,
  name: string,
): string | null {
  if (tabs.length >= MAX_TABS) return RESTORE_TAB_FULL_TEXT;
  const n = sanitizeTabName(name);
  return n === '' || tabs.some((t) => t.name === n) ? RESTORE_TAB_TAKEN_TEXT : null;
}

// ---------------------------------------------------------------- メニュー

export interface MenuRow<K extends string = string> {
  key: K;
  label: string;
  disabled?: boolean;
  /** 押せない理由・説明（項目の title） */
  title?: string;
  /** 前に区切り */
  sep?: boolean;
  /** 選択中（radio の項目。#87 (C) の ⋯ のテーマ・合成の板） */
  checked?: boolean;
}

/** [URL をコピー] の項目の状態 */
export interface ShareItemState {
  disabled: boolean;
  title: string;
}

export type TabMenuKey = 'rename' | 'copy' | 'save' | 'share' | 'close';

/**
 * 作業中のタブのメニュー: 名前を変える… / 複製 / 保存一覧に保存…（#87 (C)。常に押せる = 保存一覧を開くだけ）/
 * URL をコピー /（区切り）閉じる（最後の 1 個では出さない）。
 */
export function tabMenuModel(view: TabsView, share: ShareItemState): MenuRow<TabMenuKey>[] {
  const rows: MenuRow<TabMenuKey>[] = [
    { key: 'rename', label: '名前を変える…' },
    view.canAdd
      ? { key: 'copy', label: '複製' }
      : { key: 'copy', label: '複製', disabled: true, title: TABS_FULL_TEXT },
    { key: 'save', label: '保存一覧に保存…' },
    { key: 'share', label: 'URL をコピー', disabled: share.disabled, title: share.title },
  ];
  if (view.canClose) rows.push({ key: 'close', label: '閉じる', sep: true });
  return rows;
}

/** ＋ のメニュー: 空のタブ / このタブを複製（上限ならどちらも押せない。＋ 自体も押せない） */
export function addMenuModel(view: TabsView): MenuRow<'empty' | 'copy'>[] {
  const off = view.canAdd ? {} : { disabled: true, title: TABS_FULL_TEXT };
  return [
    { key: 'empty', label: '空のタブ', ...off },
    { key: 'copy', label: 'このタブを複製', ...off },
  ];
}

const SHARE_ITEM_TEXT = '作業中のタブを URL にしてコピーする（別の端末で開ける）';

/**
 * [URL をコピー] の項目: 足 0 本・作れないブラウザ・作っている間は押せない（理由は title）。
 * 作れた / 作れなかった（長すぎるなど）は押せる（押すと結果のトースト）。文は旧 WorkTabs と同じ
 */
export function shareItemState(
  legCount: number,
  supported: boolean,
  make: ShareMake | null,
): ShareItemState {
  const reason = shareCopyDisabled(legCount, supported);
  if (reason !== null) return { disabled: true, title: reason };
  if (make === null) return { disabled: true, title: SHARE_PREPARING_TEXT };
  return { disabled: false, title: shareMakeError(make) ?? SHARE_ITEM_TEXT };
}

export type ShareResult =
  /** クリップボードに書けた / 書けなかった（欄に出す） */
  | { kind: 'copied' | 'fallback'; make: Extract<ShareMake, { kind: 'ok' }> }
  /** URL を作れなかった・長すぎる */
  | { kind: 'error'; make: ShareMake };

export type ShareResultView = { toast: ToastInput } | { dialog: { url: string; text: string } };

/**
 * [URL をコピー] の結果の出し方: 書けた = トースト（長い URL は警告の知らせ）、書けない = ダイアログ「共有の URL」、
 * 作れない = 警告の知らせ。文は shareCopiedMessage / shareMakeError のまま
 */
export function shareResultView(r: ShareResult): ShareResultView {
  if (r.kind === 'error') {
    return { toast: { kind: 'share', text: shareMakeError(r.make) ?? '', note: 'warn' } };
  }
  const msg = shareCopiedMessage(r.make, r.kind === 'fallback');
  if (r.kind === 'fallback') return { dialog: { url: r.make.url, text: msg.text } };
  return r.make.long
    ? { toast: { kind: 'share', text: msg.text, note: 'warn' } }
    : { toast: { kind: 'share', text: msg.text } };
}

// ---------------------------------------------------------------- 帯のスクロール

/**
 * 項目（帯の中の左端 itemLeft・幅 itemWidth）を見せる帯の scrollLeft（CSS px）。左に切れていれば左端を合わせ、
 * 右に切れていれば右端を合わせ、収まっていれば今のまま。帯より広ければ左端。非有限の入力は今のまま。
 * pad（#87 (C)。帯の padding。フォーカスの輪が帯の端で切れない）を左は引き（0 未満にしない）、右は足す。非有限は 0
 */
export function revealScrollLeft(
  scrollLeft: number,
  viewWidth: number,
  itemLeft: number,
  itemWidth: number,
  pad = 0,
): number {
  if (![scrollLeft, viewWidth, itemLeft, itemWidth].every(Number.isFinite)) return scrollLeft;
  const p = Number.isFinite(pad) ? pad : 0;
  if (itemLeft < scrollLeft || itemWidth > viewWidth) return Math.max(0, itemLeft - p);
  const right = itemLeft + itemWidth;
  if (right > scrollLeft + viewWidth) return right - viewWidth + p;
  return scrollLeft;
}

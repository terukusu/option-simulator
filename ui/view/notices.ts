/**
 * 知らせの振り分け（#87。docs/ui-redesign.md §3「自動保存の知らせ」・§5・§10.1。純関数）。
 * #81 の暫定の知らせの行をやめ、知らせごとに出し方を決める。文はすべて今のまま（PersistNote.text・今の知らせの行の文）。
 *
 * | 知らせ | 出し方 |
 * |---|---|
 * | restored・shared（開いた） | 情報のトースト（6 秒） |
 * | invalid・dropped・shared（読めない…） | 警告のトースト（[閉じる] まで） |
 * | saveFailed・otherTab・newer | トップバーの警告のタグ（押すと全文と [閉じる]） |
 * | 読み込みの失敗 | 市場ピル（ui/view/marketPill.ts）+ 警告のトースト |
 * | 足を追加できない（legError） | 警告のトースト |
 *
 * 共有を開く確認（タブが上限）はダイアログ（ui/next/top/ShareConfirm.tsx。文は shareReplaceConfirmText）。
 */

import type { PersistNote, PersistNoteKind } from './persistNote';
import type { ToastInput } from './toast';

/** 警告のタグに出す知らせの種類 */
export type WarnTagKind = Extract<PersistNoteKind, 'saveFailed' | 'otherTab' | 'newer'>;

export const WARN_TAG_LABEL: Record<WarnTagKind, string> = {
  newer: '新しい版',
  saveFailed: '保存できない',
  otherTab: '別のタブ',
};

/** 重い順（新しい版 > 保存できない > 別のタブ） */
const WARN_TAG_ORDER: readonly WarnTagKind[] = ['newer', 'saveFailed', 'otherTab'];

/** 知らせのトースト（note 付き） */
export type NoteToast = ToastInput & { note: 'info' | 'warn' };

export type NoticeRoute =
  | { to: 'toast'; toast: NoteToast }
  | { to: 'tag'; kind: WarnTagKind; label: string; text: string };

const isTagKind = (k: PersistNoteKind): k is WarnTagKind =>
  k === 'saveFailed' || k === 'otherTab' || k === 'newer';

/** 知らせ 1 つの出し方。トーストの種類は `note-<kind>`（同じ種類は置き換え）。 */
export function noticeRoute(note: PersistNote): NoticeRoute {
  if (isTagKind(note.kind)) {
    return { to: 'tag', kind: note.kind, label: WARN_TAG_LABEL[note.kind], text: note.text };
  }
  // restored は情報、invalid・dropped は警告、shared は開いた = 情報・読めない = 警告（PersistNote.warn）
  const warn = note.kind === 'restored' ? false : note.kind === 'shared' ? note.warn : true;
  return {
    to: 'toast',
    toast: { kind: `note-${note.kind}`, text: note.text, note: warn ? 'warn' : 'info' },
  };
}

export interface WarnTag {
  kind: WarnTagKind;
  label: string;
  /** 全文（PersistNote.text） */
  text: string;
}

export interface WarnTagsModel {
  /** 重い順 */
  tags: WarnTag[];
  /** ボタンの aria-label（`警告: 新しい版・別のタブ`） */
  label: string;
}

/** トップバーの警告のタグ（無ければ null）。 */
export function warnTagsModel(notes: readonly PersistNote[]): WarnTagsModel | null {
  const tags: WarnTag[] = [];
  for (const kind of WARN_TAG_ORDER) {
    const n = notes.find((x) => x.kind === kind);
    if (n) tags.push({ kind, label: WARN_TAG_LABEL[kind], text: n.text });
  }
  if (tags.length === 0) return null;
  return { tags, label: `警告: ${tags.map((t) => t.label).join('・')}` };
}

/** 板の読み込みの知らせ（#81 の知らせの行・旧画面と同じ文）。 */
export function boardNoticeText(
  hasChain: boolean,
  loading: boolean,
  error: { message: string } | null,
  kept: string | null,
): { text: string; warn: boolean } | null {
  if (loading) return { text: '読み込み中…', warn: false };
  if (!hasChain) {
    return error
      ? { text: '板を読めない。[最新] で読み直すか、板の JSON を選んでください。', warn: true }
      : { text: '板の JSON を選んでください。', warn: false };
  }
  if (error) return { text: kept ? `${error.message}。${kept}` : error.message, warn: true };
  return null;
}

export const LOAD_FAILED_KIND = 'load-failed';

/** 読み込みに失敗した瞬間の警告のトースト（文は知らせの行の失敗の文 1 行）。 */
export function loadFailedToast(
  hasChain: boolean,
  error: { message: string },
  kept: string | null,
): NoteToast {
  const n = boardNoticeText(hasChain, false, error, kept);
  return { kind: LOAD_FAILED_KIND, text: n?.text ?? error.message, note: 'warn' };
}

/** 足を追加できないときの警告のトースト（出したら clearLegError）。 */
export function legErrorToast(legError: string): NoteToast {
  return { kind: 'leg-error', text: `足を追加できない: ${legError}`, note: 'warn' };
}

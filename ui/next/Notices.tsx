import type { PersistNote, PersistNoteKind } from '../view/persistNote';

/**
 * 知らせの行（暫定。#87 でトーストとトップバーのタグへ移す）。旧画面と同じ文を新しい部品の見た目で出す:
 * 共有を開く確認（[置き換える] / [やめる]）・保存の知らせ・読み込み中・読み込めない・足を追加できない。
 * 文は <p> の中のテキスト（説明文なので折り返してよい。§5.1）、ボタンは折り返さない。
 */
export interface NoticesProps {
  notes: readonly PersistNote[];
  onCloseNote: (kind: PersistNoteKind) => void;
  /** 共有を開く確認の文（無ければ null） */
  shareConfirm: string | null;
  onConfirmShare: () => void;
  onCancelShare: () => void;
  /** 板の読み込み: 読み込み中・失敗の固定文（無ければ null） */
  board: { text: string; warn: boolean } | null;
  legError: string | null;
  onClearLegError: () => void;
}

export function Notices(p: NoticesProps) {
  const any = p.notes.length > 0 || p.shareConfirm || p.board || p.legError;
  if (!any) return null;
  return (
    <div class="notices">
      {p.shareConfirm && (
        <p class="notice warn" role="alert">
          {p.shareConfirm}
          <span class="acts">
            <button type="button" class="btn sm primary" onClick={p.onConfirmShare}>
              置き換える
            </button>
            <button type="button" class="btn sm" onClick={p.onCancelShare}>
              やめる
            </button>
          </span>
        </p>
      )}
      {p.board && (
        <p class={p.board.warn ? 'notice warn' : 'notice'} role="status">
          {p.board.text}
        </p>
      )}
      {p.legError && (
        <p class="notice warn" role="alert">
          足を追加できない: {p.legError}
          <span class="acts">
            <button type="button" class="btn sm" onClick={p.onClearLegError}>
              閉じる
            </button>
          </span>
        </p>
      )}
      {p.notes.map((n) => (
        <p key={n.kind} class={n.warn ? 'notice warn' : 'notice'} role="status">
          {n.text}
          <span class="acts">
            <button type="button" class="btn sm" onClick={() => p.onCloseNote(n.kind)}>
              閉じる
            </button>
          </span>
        </p>
      ))}
    </div>
  );
}

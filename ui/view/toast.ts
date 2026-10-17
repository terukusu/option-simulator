/**
 * トースト（#81。docs/ui-redesign.md §5・§11-8）。時計を読まない純関数（now は引数）。
 * 部品とタイマーは ui/next/parts/Toast.tsx（次の期限まで 1 本だけ）。
 *
 * - 2.2 秒で消える。[元に戻す] 付きは 5 秒
 * - 同じ種類（kind）は置き換える（末尾へ・時間は新しく）。同時に最大 3 件（4 件目で最も古いものを捨てる）
 * - [元に戻す] は呼び出し元の関数を 1 回だけ返し、そのトーストを消す
 * - 知らせのトースト（#87。note 付き。§5 の例外）: 説明文として折り返し、[閉じる] を出す。情報は 6 秒、
 *   警告は [閉じる] まで消えない（until = Infinity。nextDeadline は有限の期限だけを見る）
 * - keep 付き（#87）: タブの切り替えで閉じない [元に戻す]（dropUndoToasts の対象外。タブを閉じたトースト）
 */

export const TOAST_MS = 2200;
export const UNDO_TOAST_MS = 5000;
export const MAX_TOASTS = 3;
/** 知らせのトースト（情報）の時間（#87） */
export const NOTE_TOAST_MS = 6000;

export interface ToastInput {
  /** 種類（同じ種類は置き換える） */
  kind: string;
  /** 固定文 + 数・時刻（折り返さない） */
  text: string;
  undo?: () => void;
  /** 知らせのトースト（#87）: info = 6 秒、warn = [閉じる] まで。文は説明文として折り返す */
  note?: 'info' | 'warn';
  /** タブの切り替えで閉じない（dropUndoToasts の対象外。#87） */
  keep?: boolean;
}

export interface Toast extends ToastInput {
  id: number;
  /** 消える時刻（ms） */
  until: number;
}

export function pushToast(list: readonly Toast[], t: ToastInput, id: number, now: number): Toast[] {
  const until =
    t.note === 'warn'
      ? Number.POSITIVE_INFINITY
      : now + (t.note === 'info' ? NOTE_TOAST_MS : t.undo ? UNDO_TOAST_MS : TOAST_MS);
  const next = [...list.filter((x) => x.kind !== t.kind), { ...t, id, until }];
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
}

/** 期限の来たものを消す（消えるものが無ければ同じ参照）。 */
export function expireToasts(list: readonly Toast[], now: number): Toast[] {
  const next = list.filter((t) => t.until > now);
  return next.length === list.length ? (list as Toast[]) : next;
}

/** 次に消える時刻（無ければ null）。消えないもの（until = Infinity）は見ない（setTimeout(Infinity) は即時に発火する）。 */
export function nextDeadline(list: readonly Toast[]): number | null {
  let min: number | null = null;
  for (const t of list) {
    if (!Number.isFinite(t.until)) continue;
    if (min === null || t.until < min) min = t.until;
  }
  return min;
}

/** その種類のトーストを消す（無ければ同じ参照。#87: 読み込みが成功したら読み込みの失敗の知らせを消す）。 */
export function dropToastKind(list: readonly Toast[], kind: string): Toast[] {
  return list.some((t) => t.kind === kind)
    ? list.filter((t) => t.kind !== kind)
    : (list as Toast[]);
}

/** [元に戻す]: そのトーストを消し、関数を返す（もう無ければ null。2 回目は null）。 */
export function takeUndo(
  list: readonly Toast[],
  id: number,
): { list: Toast[]; undo: (() => void) | null } {
  const t = list.find((x) => x.id === id);
  if (!t) return { list: list as Toast[], undo: null };
  return { list: list.filter((x) => x.id !== id), undo: t.undo ?? null };
}

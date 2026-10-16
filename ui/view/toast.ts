/**
 * トースト（#81。docs/ui-redesign.md §5・§11-8）。時計を読まない純関数（now は引数）。
 * 部品とタイマーは ui/next/parts/Toast.tsx（次の期限まで 1 本だけ）。
 *
 * - 2.2 秒で消える。[元に戻す] 付きは 5 秒
 * - 同じ種類（kind）は置き換える（末尾へ・時間は新しく）。同時に最大 3 件（4 件目で最も古いものを捨てる）
 * - [元に戻す] は呼び出し元の関数を 1 回だけ返し、そのトーストを消す
 */

export const TOAST_MS = 2200;
export const UNDO_TOAST_MS = 5000;
export const MAX_TOASTS = 3;

export interface ToastInput {
  /** 種類（同じ種類は置き換える） */
  kind: string;
  /** 固定文 + 数・時刻（折り返さない） */
  text: string;
  undo?: () => void;
}

export interface Toast extends ToastInput {
  id: number;
  /** 消える時刻（ms） */
  until: number;
}

export function pushToast(list: readonly Toast[], t: ToastInput, id: number, now: number): Toast[] {
  const until = now + (t.undo ? UNDO_TOAST_MS : TOAST_MS);
  const next = [...list.filter((x) => x.kind !== t.kind), { ...t, id, until }];
  return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
}

/** 期限の来たものを消す（消えるものが無ければ同じ参照）。 */
export function expireToasts(list: readonly Toast[], now: number): Toast[] {
  const next = list.filter((t) => t.until > now);
  return next.length === list.length ? (list as Toast[]) : next;
}

/** 次に消える時刻（無ければ null）。 */
export function nextDeadline(list: readonly Toast[]): number | null {
  let min: number | null = null;
  for (const t of list) if (min === null || t.until < min) min = t.until;
  return min;
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

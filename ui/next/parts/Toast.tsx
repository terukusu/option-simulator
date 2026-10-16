import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  expireToasts,
  nextDeadline,
  pushToast,
  type Toast,
  type ToastInput,
  takeUndo,
} from '../../view/toast';

/**
 * トースト（docs/ui-redesign.md §5・§11-8。規則は ui/view/toast.ts）。下中央（ドックの上）・role="status"・折り返さない。
 * タイマーは次に消える時刻まで 1 本だけ。
 */
export function useToasts(): {
  toasts: readonly Toast[];
  push: (t: ToastInput) => void;
  undo: (id: number) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const listRef = useRef<readonly Toast[]>(toasts);
  const seq = useRef(0);
  const set = useCallback((next: readonly Toast[]) => {
    listRef.current = next;
    setToasts(next);
  }, []);

  useEffect(() => {
    const at = nextDeadline(toasts);
    if (at === null) return;
    const t = setTimeout(
      () => set(expireToasts(listRef.current, Date.now())),
      Math.max(0, at - Date.now()),
    );
    return () => clearTimeout(t);
  }, [toasts, set]);

  const push = useCallback(
    (t: ToastInput) => set(pushToast(listRef.current, t, ++seq.current, Date.now())),
    [set],
  );
  const undo = useCallback(
    (id: number) => {
      const r = takeUndo(listRef.current, id);
      set(r.list);
      r.undo?.();
    },
    [set],
  );
  const dismiss = useCallback(
    (id: number) => set(listRef.current.filter((t) => t.id !== id)),
    [set],
  );
  return { toasts, push, undo, dismiss };
}

export function Toasts(p: { toasts: readonly Toast[]; onUndo: (id: number) => void }) {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {p.toasts.map((t) => (
        <div class="toast" key={t.id}>
          <span class="txt">{t.text}</span>
          {t.undo && (
            <button type="button" onClick={() => p.onUndo(t.id)}>
              元に戻す
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

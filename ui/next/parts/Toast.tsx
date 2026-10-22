import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { dropUndoToasts } from '../../view/positionsRegion';
import {
  dropToastKind,
  expireToasts,
  nextDeadline,
  pushToast,
  type Toast,
  type ToastInput,
  takeUndo,
} from '../../view/toast';

/**
 * トースト（docs/ui-redesign.md §5・§11-8。規則は ui/view/toast.ts）。下中央（ドックの上）・折り返さない。
 * タイマーは次に消える時刻まで 1 本だけ。
 * #87: 知らせのトースト（note 付き）は文を説明文（<p>）として折り返し、[閉じる]（onDismiss）を出す。
 * note の無いトーストの DOM は #81 のまま。#87 (C): .toasts は位置の箱だけにし、中に常設の読み上げの領域を 2 つ置く
 * （.toast-alerts = role="alert" に警告の知らせ、.toast-log = role="status" にほか全部。各領域の中は古い順）。
 * #124: 箱は useToastHost で 1 つだけ作り、置き場（ToastSlot）の間を移す（保存一覧の開閉で作り直さない）。
 */
export function useToasts(): {
  toasts: readonly Toast[];
  push: (t: ToastInput) => void;
  undo: (id: number) => void;
  dismiss: (id: number) => void;
  /** [元に戻す] 付きのトーストを閉じる（タブの切り替え。#84。keep 付きは残す。#87） */
  dropUndo: () => void;
  /** その種類のトーストを閉じる（#87: 読み込みが成功したら読み込みの失敗の知らせを消す） */
  drop: (kind: string) => void;
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
  const dropUndo = useCallback(() => set(dropUndoToasts(listRef.current)), [set]);
  const drop = useCallback((kind: string) => set(dropToastKind(listRef.current, kind)), [set]);
  return { toasts, push, undo, dismiss, dropUndo, drop };
}

interface ToastsProps {
  toasts: readonly Toast[];
  onUndo: (id: number) => void;
  /** 知らせのトーストの [閉じる]（#87） */
  onDismiss?: (id: number) => void;
}

/**
 * トーストの箱（.toasts）を 1 つだけ作って描く（#124）。箱は Preact の別の根（render）で描き、置き場は ToastSlot
 * （保存一覧を開いている間はモーダルのダイアログの中 = 押せて読み上げられる、ほかは画面の直下）。置き場が替わっても
 * 箱と中の読み上げの領域（.toast-alerts / .toast-log）は同じ要素のまま移るだけ（作り直さない）。
 */
export function useToastHost(p: ToastsProps): HTMLElement {
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'toasts';
    return el;
  });
  const { toasts, onUndo, onDismiss } = p;
  useLayoutEffect(() => {
    render(
      <ToastRegions toasts={toasts} onUndo={onUndo} {...(onDismiss && { onDismiss })} />,
      host,
    );
  }, [host, toasts, onUndo, onDismiss]);
  useLayoutEffect(() => () => render(null, host), [host]);
  return host;
}

/** トーストの箱の置き場（配置を持たない = display: contents）。描いたら箱をこの中へ移す */
export function ToastSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.appendChild(host);
  }, [host]);
  return <div class="toast-slot" ref={ref} />;
}

function ToastRegions(p: ToastsProps) {
  const { onDismiss } = p;
  const item = (t: Toast) =>
    t.note ? (
      <div
        class={t.note === 'warn' ? 'toast note warn' : 'toast note'}
        key={t.id}
        data-kind={t.kind}
      >
        <p class="txt">{t.text}</p>
        {onDismiss && (
          <button type="button" aria-label="知らせを閉じる" onClick={() => onDismiss(t.id)}>
            閉じる
          </button>
        )}
      </div>
    ) : (
      <div class="toast" key={t.id}>
        <span class="txt">{t.text}</span>
        {t.undo && (
          <button type="button" onClick={() => p.onUndo(t.id)}>
            元に戻す
          </button>
        )}
      </div>
    );
  // 読み上げの領域は常設の 2 つ（入れ子にしない。#87 (C)）: 警告の知らせ = alert、ほか = status（polite）。
  // 外側の .toasts は useToastHost の箱
  return (
    <>
      <div class="toast-alerts" role="alert">
        {p.toasts.filter((t) => t.note === 'warn').map(item)}
      </div>
      <div class="toast-log" role="status" aria-live="polite">
        {p.toasts.filter((t) => t.note !== 'warn').map(item)}
      </div>
    </>
  );
}

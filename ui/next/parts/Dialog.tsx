import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';

/**
 * ダイアログ（docs/ui-redesign.md §5）。<dialog class="sheet"> + showModal()。
 * Esc（cancel）と [×] で onClose、閉じたら開く前にフォーカスのあった要素へ戻す（旧 Book.tsx と同じ）。
 * 幅 min(520px, 100vw − 32px)、中身（.sheet-body）だけスクロール。
 */
export function Dialog(p: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  if (!p.open) return null;
  return (
    <DialogBody title={p.title} onClose={p.onClose}>
      {p.children}
    </DialogBody>
  );
}

function DialogBody(p: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // 開いたら showModal、閉じる（アンマウント）ときは開く前の要素へフォーカスを戻す
  useLayoutEffect(() => {
    const dlg = ref.current;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dlg && !dlg.open) dlg.showModal();
    return () => {
      if (dlg?.open) dlg.close();
      prev?.focus();
    };
  }, []);
  return (
    <dialog
      class="sheet"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Esc: 閉じるのは呼び出し側の状態で（アンマウントで close する）
        e.preventDefault();
        p.onClose();
      }}
    >
      <div class="sheet-head">
        <h2 id={titleId}>{p.title}</h2>
        <button type="button" class="btn ghost icon" aria-label="閉じる" onClick={p.onClose}>
          ×
        </button>
      </div>
      <div class="sheet-body">{p.children}</div>
    </dialog>
  );
}

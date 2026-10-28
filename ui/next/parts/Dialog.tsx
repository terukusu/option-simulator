import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon';

/**
 * ダイアログ（docs/ui-redesign.md §5）。<dialog class="sheet"> + showModal()。
 * Esc（cancel）と [×] で onClose、閉じたら開く前にフォーカスのあった要素へ戻す（旧 Book.tsx と同じ）。
 * 幅 min(520px, 100vw − 32px)、中身（.sheet-body）だけスクロール。
 *
 * 省略可能な props（#87 (C)。省略時の DOM は今のまま）:
 * - head: 見出しと × の間に置くもの（ⓘ のポップオーバー）
 * - after: .sheet-body の後（ダイアログの直下）に置くもの（保存一覧を開いている間のトースト。モーダルの外は押せないため）
 * Esc はダイアログの中に開いたポップオーバーがあればそれだけを閉じる（cancel を止める。旧 Book の Hint と同じ規則）。
 */
export function Dialog(p: {
  open: boolean;
  title: string;
  onClose: () => void;
  head?: ComponentChildren;
  after?: ComponentChildren;
  /** dialog.sheet に足すクラス（中身の幅・余白。省略時は sheet だけ） */
  class?: string;
  children: ComponentChildren;
}) {
  if (!p.open) return null;
  return (
    <DialogBody title={p.title} onClose={p.onClose} head={p.head} after={p.after} cls={p.class}>
      {p.children}
    </DialogBody>
  );
}

function DialogBody(p: {
  title: string;
  onClose: () => void;
  head: ComponentChildren | undefined;
  after: ComponentChildren | undefined;
  cls: string | undefined;
  children: ComponentChildren;
}) {
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
      class={p.cls ? `sheet ${p.cls}` : 'sheet'}
      ref={ref}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        // 中のポップオーバーが開いていれば Esc はそれだけを閉じる（ポップオーバーは document の keydown で閉じるので
        // 伝播は止めない。cancel だけ止める）
        if (e.key === 'Escape' && ref.current?.querySelector('.popover:not([hidden])')) {
          e.preventDefault();
        }
      }}
      onCancel={(e) => {
        // Esc: 閉じるのは呼び出し側の状態で（アンマウントで close する）
        e.preventDefault();
        p.onClose();
      }}
    >
      <div class="sheet-head">
        <h2 id={titleId}>{p.title}</h2>
        {p.head}
        <button type="button" class="btn ghost icon" aria-label="閉じる" onClick={p.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div class="sheet-body">{p.children}</div>
      {p.after}
    </dialog>
  );
}

import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type HintEvent, hintAlign, hintNext } from '../../view/hint';
import { useOverlay } from './overlay';

/**
 * ポップオーバー（docs/ui-redesign.md §5）。開閉の規則は旧 Hint と同じ ui/view/hint.ts の hintNext
 * （押すたびに反転・外側の pointerdown で閉じる・Esc で閉じてボタンへ戻す・同時に 1 つだけ = ./overlay.ts をメニューと共有）。
 * 位置は .pop-wrap に対する絶対配置 + .end（hintAlign。style 属性を使わない）。
 */
export function Popover(p: {
  label: string;
  button: ComponentChildren;
  children: ComponentChildren;
  buttonClass?: string;
}) {
  const id = useId();
  const { open, setOpen } = useOverlay(id);
  const [align, setAlign] = useState<'start' | 'end'>('start');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const send = (ev: HintEvent) => setOpen(hintNext(open, ev));

  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setAlign(hintAlign((b.left + b.right) / 2, 0, window.innerWidth));
  }, [open]);

  // 外側の pointerdown・Esc は開いた描画の直後から購読する
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const w = wrapRef.current;
      if (w && e.target instanceof Node && w.contains(e.target)) return;
      setOpen(hintNext(true, 'outside'));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = wrapRef.current?.contains(document.activeElement) ?? false;
      setOpen(hintNext(true, 'escape'));
      if (inside) btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  return (
    <span class="pop-wrap" ref={wrapRef}>
      <button
        type="button"
        class={p.buttonClass ?? 'hintbtn'}
        ref={btnRef}
        aria-label={p.label}
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        onClick={() => send('toggle')}
      >
        {p.button}
      </button>
      <div class={align === 'end' ? 'popover end' : 'popover'} id={`${id}-pop`} hidden={!open}>
        {p.children}
      </div>
    </span>
  );
}

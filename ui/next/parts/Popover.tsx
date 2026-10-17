import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type HintEvent, hintAlign, hintNext, revealDelta } from '../../view/hint';
import { useOverlay } from './overlay';

/**
 * ポップオーバー（docs/ui-redesign.md §5）。開閉の規則は旧 Hint と同じ ui/view/hint.ts の hintNext
 * （押すたびに反転・外側の pointerdown で閉じる・Esc で閉じてボタンへ戻す・同時に 1 つだけ = ./overlay.ts をメニューと共有）。
 * 位置は .pop-wrap に対する絶対配置 + .end（hintAlign。style 属性を使わない）。
 *
 * 省略可能な props（#107。省略時の DOM・動きは #81 のまま）:
 * - label: 省略すると aria-label を出さない（名前はボタンの中身。指標のタイル・読み取りの全文）
 * - up: ボタンの上に開く（.popover.up。舞台の下端の読み取り）
 * - within: 祖先のセレクタ。左右の揃えをその祖先の左右で判定し、祖先が縦にスクロールする要素なら
 *   開いたときにポップオーバーの下端が見えるまでその祖先の scrollTop だけを動かす（revealDelta）
 */
export function Popover(p: {
  label?: string;
  button: ComponentChildren;
  children: ComponentChildren;
  buttonClass?: string;
  up?: boolean;
  within?: string;
}) {
  const id = useId();
  const { open, setOpen } = useOverlay(id);
  const [align, setAlign] = useState<'start' | 'end'>('start');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const send = (ev: HintEvent) => setOpen(hintNext(open, ev));

  const within = p.within;
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const host = within ? (wrapRef.current?.closest(within) ?? null) : null;
    const h = host?.getBoundingClientRect();
    setAlign(hintAlign((b.left + b.right) / 2, h ? h.left : 0, h ? h.right : window.innerWidth));
  }, [open, within]);

  // 開いた後（揃えが決まった後）、スクロールする祖先の中で下端が見えるようにする
  useLayoutEffect(() => {
    if (!open || !within) return;
    const host = wrapRef.current?.closest(within);
    const pop = wrapRef.current?.querySelector('.popover');
    if (!(host instanceof HTMLElement) || !pop) return;
    const oy = getComputedStyle(host).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') return;
    const r = pop.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const d = revealDelta(r.top, r.bottom, h.top, h.bottom);
    if (d > 0) host.scrollTop += d;
  }, [open, within, align]);

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
        aria-label={p.label || undefined}
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        onClick={() => send('toggle')}
      >
        {p.button}
      </button>
      <div
        class={`popover${p.up ? ' up' : ''}${align === 'end' ? ' end' : ''}`}
        id={`${id}-pop`}
        hidden={!open}
      >
        {p.children}
      </div>
    </span>
  );
}

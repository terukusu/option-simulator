import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { type HintEvent, hintAlign, hintNext } from '../view/hint';

/** いま開いている ⓘ を閉じる関数（同時に 1 つだけ開く。キーボードで別の ⓘ を開いたときも閉じるため）。 */
let closeActive: (() => void) | null = null;

/**
 * 説明の吹き出し（#63）。ⓘ を押すと説明が出て、もう一度・外側のタップ・Esc で閉じる。
 * 置く親の行（ブロック要素）に class="hint-host" を付ける。吹き出しはその行の幅に収まる（CSS）。
 * 要素は span だけなので p・caption の中に置ける。h2 / h3 の中には置かない（見出しの名前に混ざる）。
 * 位置はクラスの付け替えだけで決める（style 属性を使わない。CSP）。
 */
export function Hint({ label, children }: { label: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<'start' | 'end'>('start');
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const popId = useId();

  const send = useCallback((ev: HintEvent) => setOpen((o) => hintNext(o, ev)), []);
  const close = useCallback(() => send('other'), [send]);

  // 同時に 1 つだけ: 開いたら前の ⓘ を閉じ、自分を登録する。
  useEffect(() => {
    if (!open) return;
    if (closeActive && closeActive !== close) closeActive();
    closeActive = close;
    return () => {
      if (closeActive === close) closeActive = null;
    };
  }, [open, close]);

  // 外側のタップ・Esc は開いている間だけ購読する（既定動作は止めない）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      send('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = rootRef.current?.contains(document.activeElement) ?? false;
      send('escape');
      if (inside) btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, send]);

  // 開いたときにボタンが行の右半分にあれば、吹き出しを行の右端に揃える。
  useLayoutEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    const host = rootRef.current?.closest('.hint-host');
    if (!btn || !host) return;
    const b = btn.getBoundingClientRect();
    const r = host.getBoundingClientRect();
    setAlign(hintAlign((b.left + b.right) / 2, r.left, r.right));
  }, [open]);

  // 開いた吹き出しが画面・列（PC のシミュレーターの列）の下端で切れていれば、見える所までだけスクロールする。
  useEffect(() => {
    if (open) popRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  return (
    <span class="hint" ref={rootRef}>
      <button
        type="button"
        class="hint-btn"
        ref={btnRef}
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`${label}の説明`}
        onClick={() => send('toggle')}
      >
        ⓘ
      </button>
      <span
        class={align === 'end' ? 'hint-pop end' : 'hint-pop'}
        id={popId}
        hidden={!open}
        ref={popRef}
      >
        {children}
      </span>
    </span>
  );
}

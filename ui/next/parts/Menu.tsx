import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { hintAlign } from '../../view/hint';
import { isMenuKey, menuMove } from '../../view/menu';
import { useOverlay } from './overlay';

/**
 * メニュー（docs/ui-redesign.md §5。キー移動の規則は ui/view/menu.ts）。
 *
 * - ボタン（aria-haspopup="menu"・aria-expanded）+ role="menu"。開いたら最初の有効な項目へフォーカス
 * - ↑↓ / Home / End で移動（端で回る・無効を飛ばす）、Enter / Space で実行して閉じてボタンへ戻す、
 *   Esc で閉じてボタンへ戻す、外側の pointerdown・Tab で閉じる
 * - 同時に 1 つだけ（ポップオーバーとも共有。./overlay.ts）
 * - 位置はボタンの親（.menu-wrap）に対する絶対配置 + .end（ボタンが画面の右半分なら右端に揃える）。
 *   overflow を切る親（.panel-body など）の中には置かない（切れる）。トップバー・.panel-head に置く
 */

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** 右に出すキー（表示だけ） */
  kbd?: string;
  disabled?: boolean;
  /** 渡すと role="menuitemradio" + aria-checked */
  checked?: boolean;
}

export function Menu(p: {
  label: string;
  button: ComponentChildren;
  items: readonly MenuItem[];
  buttonClass?: string;
}) {
  const id = useId();
  const { open, setOpen } = useOverlay(id);
  const [align, setAlign] = useState<'start' | 'end'>('start');
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = p.items.map((it) => it.disabled === true);

  const focusAt = (i: number) => {
    if (i >= 0) itemRefs.current[i]?.focus();
  };
  const closeToButton = () => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const select = (it: MenuItem) => {
    if (it.disabled) return;
    closeToButton();
    it.onSelect();
  };

  // 開いたら位置（左右）を決め、最初の有効な項目へフォーカス
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setAlign(hintAlign((b.left + b.right) / 2, 0, window.innerWidth));
    focusAt(menuMove(disabled, -1, 'Home'));
  }, [open]);

  // 外側の pointerdown で閉じる（既定の動作は止めない）。開いた描画の直後に購読する（useEffect だと次の操作に間に合わないことがある）
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const w = wrapRef.current;
      if (w && e.target instanceof Node && w.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, setOpen]);

  const onKeyDown = (e: KeyboardEvent) => {
    const index = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement | null);
    if (isMenuKey(e.key)) {
      e.preventDefault();
      focusAt(menuMove(disabled, index, e.key));
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeToButton();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = p.items[index];
      if (it) select(it);
    }
  };

  return (
    <span class="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        class={p.buttonClass ?? 'btn ghost icon'}
        ref={btnRef}
        aria-label={p.label}
        title={p.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {p.button}
      </button>
      {open && (
        <div
          class={align === 'end' ? 'menu end' : 'menu'}
          role="menu"
          id={`${id}-menu`}
          aria-label={p.label}
          onKeyDown={onKeyDown}
        >
          {p.items.map((it, i) => (
            <button
              type="button"
              key={it.key}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              {...(it.checked === undefined
                ? { role: 'menuitem' }
                : { role: 'menuitemradio', 'aria-checked': it.checked })}
              aria-disabled={it.disabled ? true : undefined}
              tabIndex={-1}
              onClick={() => select(it)}
            >
              {it.checked !== undefined && (
                <span class="mark" aria-hidden="true">
                  {it.checked ? '✓' : ''}
                </span>
              )}
              <span>{it.label}</span>
              {it.kbd && <span class="kbd">{it.kbd}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

import { type ComponentChildren, Fragment, type RefObject, type VNode } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
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
 * - 中身は useMenu（#87 (B)）。ボタンと一覧（list）を別の場所に置ける（BOX タブ: 帯の中のチップ + 帯の外の一覧）。
 *   Menu は useMenu で #81 と同じ DOM（span.menu-wrap > button + div.menu）を描く
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
  /** 項目の前に区切り（<hr> = role="separator"。#87。省略時の DOM は #81 のまま） */
  sep?: boolean;
  /** 項目の title（押せない理由など。#87 (B)。省略時は出さない） */
  title?: string;
}

/** ボタンに付ける属性（aria-label・title・class は呼び出し側） */
export interface MenuButtonProps {
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export interface UseMenu {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** この要素の中の pointerdown では閉じない（ボタンと一覧を含む要素に付ける） */
  wrapRef: RefObject<HTMLElement>;
  /** メニューのボタン（左右の位置を決める・閉じたらフォーカスを戻す） */
  btnRef: RefObject<HTMLButtonElement>;
  buttonProps: MenuButtonProps;
  /** 開いているときの div.menu（閉じていれば null） */
  list: VNode | null;
}

export function useMenu(o: {
  label: string;
  items: readonly MenuItem[];
  /** 開閉が変わったとき（#87 (B): 開いたら共有の URL を作る） */
  onOpenChange?: ((open: boolean) => void) | undefined;
}): UseMenu {
  const id = useId();
  // 戻るで閉じるときは Esc と同じ（閉じてボタンへ戻す。#320）
  const { open, setOpen } = useOverlay(id, () => closeToButton());
  const [align, setAlign] = useState<'start' | 'end'>('start');
  const wrapRef = useRef<HTMLElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = o.items.map((it) => it.disabled === true);

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

  // 開閉の通知（最初の描画では呼ばない）
  const { onOpenChange } = o;
  const shown = useRef(open);
  useEffect(() => {
    if (shown.current === open) return;
    shown.current = open;
    onOpenChange?.(open);
  }, [open, onOpenChange]);

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
      const it = o.items[index];
      if (it) select(it);
    }
  };

  const buttonProps: MenuButtonProps = {
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? `${id}-menu` : undefined,
    onClick: () => setOpen(!open),
    onKeyDown: (e) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setOpen(true);
      }
    },
  };

  const list = open ? (
    <div
      class={align === 'end' ? 'menu end' : 'menu'}
      role="menu"
      id={`${id}-menu`}
      aria-label={o.label}
      onKeyDown={onKeyDown}
    >
      {o.items.map((it, i) => {
        const item = (
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
            title={it.title}
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
        );
        return it.sep ? (
          <Fragment key={it.key}>
            <hr class="menu-sep" />
            {item}
          </Fragment>
        ) : (
          item
        );
      })}
    </div>
  ) : null;

  return { open, setOpen, wrapRef, btnRef, buttonProps, list };
}

export function Menu(p: {
  label: string;
  button: ComponentChildren;
  items: readonly MenuItem[];
  buttonClass?: string;
  /** 開閉が変わったとき（#87 (B)） */
  onOpenChange?: (open: boolean) => void;
}) {
  const m = useMenu({ label: p.label, items: p.items, onOpenChange: p.onOpenChange });
  return (
    <span class="menu-wrap" ref={m.wrapRef as RefObject<HTMLSpanElement>}>
      <button
        type="button"
        class={p.buttonClass ?? 'btn ghost icon'}
        ref={m.btnRef}
        aria-label={p.label}
        title={p.label}
        {...m.buttonProps}
      >
        {p.button}
      </button>
      {m.list}
    </span>
  );
}

import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { pure } from '../../components/pure';
import type { ShareMake } from '../../share';
import type { Action } from '../../state';
import {
  addMenuModel,
  type MenuRow,
  revealScrollLeft,
  type ShareResult,
  tabMenuModel,
} from '../../view/boxTabs';
import { type TabsView, tabKeyTarget } from '../../view/tabs';
import { Icon } from '../parts/Icon';
import { type MenuItem, useMenu } from '../parts/Menu';
import { RenameDialog } from './RenameDialog';
import { useShareCopy } from './useShareCopy';

export interface BoxTabsProps {
  view: TabsView;
  dispatch: (a: Action) => void;
  /** 作業中のタブを閉じる（NextApp: 写しを控えて closeTab し、[元に戻す] のトーストを出す） */
  onCloseTab: (id: number) => void;
  makeShareUrl: () => Promise<ShareMake>;
  subscribeShare: (f: () => void) => () => void;
  shareSupported: boolean;
  onShareResult: (r: ShareResult) => void;
  /** 保存一覧に保存…（#87 (C)。保存一覧のダイアログを名前の欄にフォーカスして開く） */
  onSaveToBook: () => void;
}

export const toItems = <K extends string>(rows: MenuRow<K>[], on: (k: K) => void): MenuItem[] =>
  rows.map((r) => ({
    key: r.key,
    label: r.label,
    onSelect: () => on(r.key),
    ...(r.disabled ? { disabled: true } : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.sep ? { sep: true } : {}),
    ...(r.checked !== undefined ? { checked: r.checked } : {}),
  }));

/**
 * BOX タブ（#87 (B)。docs/ui-redesign.md §2.1・§3・§4.5）: 帯（role="tablist"。チップ = 名前 + 足の本数）+ ＋ のメニュー
 * + 作業中のタブのメニュー（帯の外 = .boxtabs-wrap の直下。帯は横スクロールで中身を切るため）。
 *
 * - 作業中でないチップのクリック = 切替だけ。作業中のチップのクリック / Enter / Space / ↓ = タブのメニュー
 * - ← → Home End は tablist で切り替え、新しい作業中のチップへフォーカス（旧 WorkTabs と同じ。自動アクティベーション）
 * - 作業中のタブが変わったら帯の scrollLeft だけを動かして作業中のチップを見せ（scrollIntoView を使わない）、メニューを閉じる
 * - 閉じるは確認なし（NextApp が [元に戻す] のトーストを出す）。名前を変える…は小さなダイアログ（ブラウザの入力の窓を使わない）
 * pure: 入力は c.tabsView と参照の変わらない関数だけ（シナリオの操作で描き直さない）。
 */
function BoxTabsView(p: BoxTabsProps) {
  const { view, dispatch, onCloseTab } = p;
  const { active } = view;
  const stripRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const focusNext = useRef(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const share = useShareCopy({
    open: menuOpen,
    legCount: active.legCount,
    supported: p.shareSupported,
    make: p.makeShareUrl,
    subscribe: p.subscribeShare,
    onResult: p.onShareResult,
  });

  const tabMenu = useMenu({
    label: `タブ ${active.name} のメニュー`,
    items: toItems(tabMenuModel(view, share.item), (k) => {
      if (k === 'rename') setRenaming({ id: active.id, name: active.name });
      else if (k === 'copy') {
        // 新しい作業中のチップへフォーカス（閉じると同じ。ロービングのフォーカスを作業中のチップに保つ）
        focusNext.current = true;
        dispatch({ type: 'addTab', mode: 'copy' });
      } else if (k === 'save') p.onSaveToBook();
      else if (k === 'share') share.copy();
      else {
        focusNext.current = true;
        onCloseTab(active.id);
      }
    }),
    onOpenChange: setMenuOpen,
  });
  const addMenu = useMenu({
    label: 'タブを足す',
    items: toItems(addMenuModel(view), (k) => dispatch({ type: 'addTab', mode: k })),
  });

  // メニューのボタン = 作業中のチップ（位置の左右・閉じたらフォーカスを戻す先）
  useLayoutEffect(() => {
    tabMenu.btnRef.current = buttons.current.get(active.id) ?? null;
  });

  // 作業中のタブが変わったら: メニューを閉じ、帯の中で見せ、キー操作・閉じたなら新しいチップへフォーカス
  const { setOpen: setTabMenuOpen } = tabMenu;
  const count = view.tabs.length;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const chip = buttons.current.get(active.id);
    if (strip && chip) {
      // 帯の padding の分も見せる（左端のチップのフォーカスの輪が帯の端で切れない。#87 (C)）
      const pad = Number.parseFloat(getComputedStyle(strip).paddingLeft);
      strip.scrollLeft = revealScrollLeft(
        strip.scrollLeft,
        strip.clientWidth,
        chip.offsetLeft,
        chip.offsetWidth,
        pad,
      );
    }
  }, [active.id, count]);
  useEffect(() => {
    setTabMenuOpen(false);
    if (focusNext.current) {
      focusNext.current = false;
      buttons.current.get(active.id)?.focus();
    }
  }, [active.id, setTabMenuOpen]);

  return (
    <div class="boxtabs-wrap" ref={tabMenu.wrapRef as RefObject<HTMLDivElement>}>
      <div
        class="boxtabs"
        role="tablist"
        aria-label="作業中のポジション"
        ref={stripRef}
        onKeyDown={(e) => {
          const id = tabKeyTarget(
            view.tabs.map((t) => t.id),
            active.id,
            e.key,
          );
          if (id === null) return;
          e.preventDefault();
          if (id === active.id) return;
          focusNext.current = true;
          dispatch({ type: 'switchTab', id });
        }}
      >
        {view.tabs.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            class="boxtab"
            ref={(el) => {
              if (el) buttons.current.set(t.id, el);
              else buttons.current.delete(t.id);
            }}
            aria-selected={t.active}
            tabIndex={t.active ? 0 : -1}
            aria-label={t.label}
            title={t.label}
            {...(t.active
              ? tabMenu.buttonProps
              : { onClick: () => dispatch({ type: 'switchTab', id: t.id }) })}
          >
            <span class="nm">{t.name}</span>
            {t.countText !== null && <span class="n">{t.countText}</span>}
          </button>
        ))}
      </div>
      <span class="menu-wrap" ref={addMenu.wrapRef as RefObject<HTMLSpanElement>}>
        <button
          type="button"
          class="btn ghost icon boxtabs-add"
          ref={addMenu.btnRef}
          aria-label="タブを足す"
          title={view.addTitle}
          disabled={!view.canAdd}
          {...addMenu.buttonProps}
        >
          <Icon name="plus" />
        </button>
        {addMenu.list}
      </span>
      {tabMenu.list}
      <RenameDialog
        open={renaming !== null}
        tabs={view.tabs}
        id={renaming?.id ?? active.id}
        name={renaming?.name ?? active.name}
        onRename={(name) => {
          if (renaming) dispatch({ type: 'renameTab', id: renaming.id, name });
        }}
        onClose={() => setRenaming(null)}
      />
    </div>
  );
}

export const BoxTabs = pure(BoxTabsView);

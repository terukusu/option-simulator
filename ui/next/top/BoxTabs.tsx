import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { LONG_PRESS_MS } from '../../chart/gesture';
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
import {
  clickSwallowed,
  initialTabDrag,
  previewOrder,
  type TabDragResult,
  tabDragCancel,
  tabDragDown,
  tabDragEdge,
  tabDragLongPress,
  tabDragLostCapture,
  tabDragMove,
  tabDragSync,
  tabDragUp,
} from '../../view/tabDrag';
import {
  type TabKeyInput,
  type TabsView,
  tabKeyKind,
  tabKeyTarget,
  tabMoveKey,
} from '../../view/tabs';
import { Icon } from '../parts/Icon';
import { type MenuItem, useMenu } from '../parts/Menu';
import { claimEscape } from '../parts/overlay';
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
 * - 並べ替え（#323）: メニューの左へ移動 / 右へ移動・Ctrl / ⌘ + Shift + ← →（端で回らない）・ドラッグ（マウスは 6px 動かす、
 *   タッチ・ペンは 450ms の長押しでつかむ。状態機械は ui/view/tabDrag.ts）。作業中のタブは変えない。つかんでいる間の
 *   入れ替わりは DOM を動かさず data-pos と CSS の order で見せ（style を使わない。DOM を並べ替えると touch の対象・
 *   pointer capture・フォーカスが外れうる）、離したときに moveTab を 1 回。離した後は動かしたチップを帯の中で見せる
 * pure: 入力は c.tabsView と参照の変わらない関数だけ（シナリオの操作で描き直さない）。
 */
function BoxTabsView(p: BoxTabsProps) {
  const { view, dispatch, onCloseTab } = p;
  const { active } = view;
  const stripRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const focusNext = useRef(false);
  /** 次の並びの変化で帯の中で見せるチップ（ドラッグで置いたチップ。null は作業中のチップ） */
  const revealNext = useRef<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  /** つかんでいる間のプレビュー（入れ替わって見える id の並びとつかんだタブの id）。BoxTabs の中だけで描き直す */
  const [drag, setDrag] = useState<{ order: number[]; grabbed: number } | null>(null);
  const ids = view.tabs.map((t) => t.id);
  const order = ids.join(',');

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
      } else if (k === 'held') dispatch({ type: 'setTabHeld', held: !active.held });
      else if (k === 'save') p.onSaveToBook();
      else if (k === 'share') share.copy();
      else if (k === 'left' || k === 'right') {
        // Menu の select が先に閉じて作業中のチップへフォーカスを戻す。動いた後もそのチップへ（並べ替えで DOM が動く）
        const i = view.tabs.findIndex((t) => t.active);
        focusNext.current = true;
        dispatch({ type: 'moveTab', id: active.id, to: k === 'left' ? i - 1 : i + 1 });
      } else {
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

  // 作業中のタブ・並びが変わったら: 帯の中で見せ、キー操作・閉じた・並べ替えたなら作業中のチップへフォーカス。
  // ドラッグで置いたときは置いたチップを見せる（自動スクロールで作業中のチップが帯の外にあっても、置けたことが見える）。
  // メニューを閉じるのは作業中のタブが変わったときだけ
  const { setOpen: setTabMenuOpen } = tabMenu;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const target = revealNext.current ?? active.id;
    revealNext.current = null;
    const chip = buttons.current.get(target);
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
  }, [active.id, order]);
  useEffect(() => {
    setTabMenuOpen(false);
  }, [active.id, setTabMenuOpen]);
  // フォーカスは描画の直後に戻す（並べ替えで DOM が動くとフォーカスが外れ、useEffect では続けて押したキーが body に落ちる）。
  // 帯の位置は上の effect が決める（focus のスクロールで、ドラッグで置いたチップを帯の外へ戻さない）
  useLayoutEffect(() => {
    if (focusNext.current) {
      focusNext.current = false;
      buttons.current.get(active.id)?.focus({ preventScroll: true });
    }
  }, [active.id, order]);

  // ---- ドラッグの並べ替え（#323）。イベントは帯にまとめて受ける（帯はチャートではないので useChartGestures を使わない）
  const dragRef = useRef(initialTabDrag());
  /** 描画ごとの最新の値（listener は帯に 1 度だけ付ける） */
  const latest = useRef({ ids, dispatch, setTabMenuOpen, activeId: active.id });
  latest.current = { ids, dispatch, setTabMenuOpen, activeId: active.id };
  const applyRef = useRef<(r: TabDragResult) => void>(() => {});

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let timer: number | undefined;
    let raf: number | undefined;
    /** click を捨てる印を立てた時刻（null は印なし。TAB_CLICK_SWALLOW_MS で切れる） */
    let swallowAt: number | null = null;
    /** window（capture）で取りやめに使った押下（帯の pointerdown で新しく始めない） */
    let cancelledDown: PointerEvent | null = null;
    /** 最後の pointer の位置（client 座標。自動スクロールで入れ替わり先を測り直す） */
    let last = { id: 0, x: 0, y: 0 };

    const contentX = (clientX: number) =>
      clientX - strip.getBoundingClientRect().left - strip.clientLeft + strip.scrollLeft;
    const stopTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const stopRaf = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
    };
    const release = (id: number) => {
      if (strip.hasPointerCapture(id)) strip.releasePointerCapture(id);
    };
    // 帯の見えている端の近くで帯を流し、入れ替わり先を測り直す（つかんでいる間だけ。つかんだだけでは流さない = armed）
    const edgeLoop = () => {
      raf = undefined;
      if (dragRef.current.mode !== 'grab') return;
      const r = strip.getBoundingClientRect();
      const e = tabDragEdge(dragRef.current, last.x, r.left, r.width);
      dragRef.current = e.state;
      if (e.step !== 0) {
        const before = strip.scrollLeft;
        strip.scrollLeft = before + e.step;
        if (strip.scrollLeft !== before) apply(tabDragMove(e.state, last, contentX(last.x)));
      }
      raf = requestAnimationFrame(edgeLoop);
    };
    const preview = (from: number, to: number) => {
      const s = dragRef.current;
      const grabbed = s.ids[from];
      if (grabbed !== undefined) setDrag({ order: previewOrder(s.ids, from, to), grabbed });
    };
    const apply = (r: TabDragResult) => {
      const prev = dragRef.current;
      const s = r.state;
      dragRef.current = s;
      if (r.swallowClick) swallowAt = performance.now();
      if (s.mode !== 'pending') stopTimer();
      if (r.grabbed) {
        // メニューの項目にフォーカスがあれば、消える前に作業中のチップへ戻す（body に落とさない）
        const a = document.activeElement;
        const wrap = strip.parentElement;
        if (a && wrap?.contains(a) && !strip.contains(a) && a.closest('[role="menu"]'))
          buttons.current.get(latest.current.activeId)?.focus({ preventScroll: true });
        latest.current.setTabMenuOpen(false);
        if (s.kind === 'mouse' && s.id !== null) {
          try {
            strip.setPointerCapture(s.id);
          } catch {
            // 既に離した pointer（取れなくてもドラッグは続けられる）
          }
        }
        if (r.vibrate) navigator.vibrate?.(8);
        preview(s.from, s.to);
        if (raf === undefined) raf = requestAnimationFrame(edgeLoop);
      } else if (s.mode === 'grab' && s.to !== prev.to) {
        preview(s.from, s.to);
      }
      if (s.mode !== 'grab' && prev.mode === 'grab') {
        stopRaf();
        if (prev.id !== null) release(prev.id);
        setDrag(null);
      }
      if (r.drop) {
        // 動かすチップにフォーカスがあれば、並び替わった後も作業中のチップへ戻す（DOM の並べ替えで外れうる）
        if (strip.contains(document.activeElement)) focusNext.current = true;
        revealNext.current = r.drop.id;
        latest.current.dispatch({ type: 'moveTab', id: r.drop.id, to: r.drop.to });
      }
    };
    applyRef.current = apply;

    // 押している間の別の押下（2 本目の指など。帯の外でも）: 取りやめ。window の capture で帯より先に受ける
    const onAnyDown = (e: PointerEvent) => {
      if (dragRef.current.mode === 'idle') return;
      cancelledDown = e;
      apply(
        tabDragDown(
          dragRef.current,
          { id: e.pointerId, x: e.clientX, y: e.clientY },
          performance.now(),
          'touch',
          0,
          [],
          [],
        ),
      );
    };
    const onDown = (e: PointerEvent) => {
      if (e === cancelledDown) return;
      // 前の押下の click を捨てる印は次の押下で下ろす（Android は長押しの後に click が来ないことがある）
      swallowAt = null;
      const p = { id: e.pointerId, x: e.clientX, y: e.clientY };
      if (dragRef.current.mode !== 'idle' || e.button !== 0) return;
      const chip = e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
      if (!chip) return;
      const ids = latest.current.ids;
      const from = ids.findIndex((id) => buttons.current.get(id) === chip);
      if (from < 0) return;
      const centers = ids.map((id) => {
        const b = buttons.current.get(id);
        return b ? b.offsetLeft + b.offsetWidth / 2 : Number.NaN;
      });
      if (!centers.every(Number.isFinite)) return;
      const kind = e.pointerType === 'mouse' ? 'mouse' : 'touch';
      last = p;
      const started = tabDragDown(dragRef.current, p, performance.now(), kind, from, ids, centers);
      apply(started);
      if (kind === 'touch' && started.state.mode === 'pending') {
        const fire = () => {
          timer = undefined;
          const s = dragRef.current;
          apply(tabDragLongPress(s, performance.now()));
          // タイマーが早く来たら残りを待つ
          const left = LONG_PRESS_MS - (performance.now() - s.t0);
          if (dragRef.current.mode === 'pending')
            timer = window.setTimeout(fire, Math.max(1, left));
        };
        timer = window.setTimeout(fire, LONG_PRESS_MS);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (dragRef.current.mode === 'idle' || e.pointerId !== dragRef.current.id) return;
      last = { id: e.pointerId, x: e.clientX, y: e.clientY };
      apply(tabDragMove(dragRef.current, last, contentX(e.clientX)));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== dragRef.current.id) return;
      apply(tabDragUp(dragRef.current, { id: e.pointerId, x: e.clientX, y: e.clientY }));
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== dragRef.current.id) return;
      apply(tabDragCancel(dragRef.current));
    };
    // 離すが届かないまま、つかんだ状態を残さない: capture を失った・ウィンドウが blur・ページが隠れた
    const onLost = (e: PointerEvent) => apply(tabDragLostCapture(dragRef.current, e.pointerId));
    const onBlur = () => apply(tabDragCancel(dragRef.current));
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') apply(tabDragCancel(dragRef.current));
    };
    // つかんでいる間は帯・ページを流さない（Chrome は touchstart の時点のリスナーで止められる touch かを決めるので常に付ける）
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current.mode === 'grab') e.preventDefault();
    };
    // 押している間は長押しのメニュー（右クリックは主ボタンでないので idle = 今のまま）を出さない
    const onMenu = (e: Event) => {
      if (dragRef.current.mode !== 'idle') e.preventDefault();
    };
    // つかんだ押下の click（切り替え・メニュー）を捨てる
    const onClick = (e: MouseEvent) => {
      if (!clickSwallowed(swallowAt, performance.now())) return;
      swallowAt = null;
      e.stopPropagation();
      e.preventDefault();
    };
    // つかんでいる間の Esc = 取りやめ（開いているほかのものを閉じない）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || dragRef.current.mode !== 'grab') return;
      claimEscape(e);
      e.preventDefault();
      apply(tabDragCancel(dragRef.current));
    };

    // キー操作の click（Enter / Space）は捨てない
    const onStripKey = () => {
      swallowAt = null;
    };

    window.addEventListener('pointerdown', onAnyDown, true);
    strip.addEventListener('pointerdown', onDown);
    // 移動・離す・取りやめは window で受ける（帯の外で離しても押している状態を残さない。idle なら何もしない）
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    strip.addEventListener('touchmove', onTouchMove, { passive: false });
    strip.addEventListener('contextmenu', onMenu);
    strip.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    strip.addEventListener('lostpointercapture', onLost);
    strip.addEventListener('keydown', onStripKey);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopTimer();
      stopRaf();
      window.removeEventListener('pointerdown', onAnyDown, true);
      strip.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      strip.removeEventListener('touchmove', onTouchMove);
      strip.removeEventListener('contextmenu', onMenu);
      strip.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      strip.removeEventListener('lostpointercapture', onLost);
      strip.removeEventListener('keydown', onStripKey);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      dragRef.current = initialTabDrag();
    };
  }, []);

  // 外から並び・数が変わったら（閉じた・別のブラウザのタブの保存など）つかんでいるのを取りやめる
  useEffect(() => {
    applyRef.current(
      tabDragSync(dragRef.current, order === '' ? [] : order.split(',').map(Number)),
    );
  }, [order]);

  return (
    <div class="boxtabs-wrap" ref={tabMenu.wrapRef as RefObject<HTMLDivElement>}>
      <div
        class="boxtabs"
        role="tablist"
        aria-label="作業中のポジション"
        ref={stripRef}
        {...(drag ? { 'data-dragging': '' } : {})}
        onKeyDown={(e) => {
          const k: TabKeyInput = {
            key: e.key,
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey,
            shift: e.shiftKey,
            isComposing: e.isComposing,
            keyCode: e.keyCode,
          };
          const kind = tabKeyKind(k);
          if (kind === 'other') return;
          if (kind === 'move') {
            // 並べ替え（#323）: 端では何もしない（回らない・切り替えに落とさない）
            e.preventDefault();
            const to = tabMoveKey(ids, active.id, k);
            if (to === null) return;
            focusNext.current = true;
            dispatch({ type: 'moveTab', id: active.id, to });
            return;
          }
          const id = tabKeyTarget(ids, active.id, e.key);
          if (id === null) return;
          e.preventDefault();
          if (id === active.id) return;
          focusNext.current = true;
          dispatch({ type: 'switchTab', id });
        }}
      >
        {view.tabs.map((t, i) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            class="boxtab"
            data-pos={drag ? drag.order.indexOf(t.id) : i}
            {...(drag?.grabbed === t.id ? { 'data-grabbed': '' } : {})}
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
            {/* 保有の印（#301）: 色だけに頼らない文字のタグ。読み上げは aria-label の「保有」 */}
            {t.held && (
              <span class="hd" aria-hidden="true">
                保
              </span>
            )}
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

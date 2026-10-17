import { useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { menuMove } from '../../view/menu';
import {
  type PaletteItem,
  type PaletteRun,
  paletteFilter,
  paletteGroupName,
  paletteKey,
  paletteView,
} from '../../view/palette';
import { useOverlay } from './overlay';

/**
 * コマンドパレット（docs/ui-redesign.md §4.6・§5。#89 段 B）。<dialog class="palette" aria-modal="true"> を show() で開き、
 * dialog 自身を窓いっぱいの下敷き（固定位置・最前面）にする = 背景は押せない、Tab は入力欄から出さない（中の操作は入力欄
 * だけ）。showModal() にしないのは、モーダルにすると文書の全要素の inert を作り直す（322 行の板の PC で 40〜50ms、
 * 開く操作の Long Animation Frame が 50ms を超える。#89 AC-B5(j)）ため。行・検索・キーの規則は ui/view/palette.ts、
 * 行は NextApp が開いている間だけ作る。
 *
 * - 開くと入力欄が空・フォーカスは入力欄・選択は先頭の押せる行。開いている間は overlay として数える（開いていた
 *   メニュー / ポップオーバーは閉じる）
 * - ↑ / ↓ = 押せる行だけ（端で回る）、Enter = 選択中の行を実行（押せない・0 件なら何もしない）、Esc / 背景のクリック =
 *   閉じる、行のクリック = その行を実行、Tab = 何もしない（入力欄に留める）。IME の変換中のキーは処理しない
 * - 箱の中の mousedown は入力欄からフォーカスを外さない
 * - 閉じ方は 1 か所（finish）: close → 開く前の要素へフォーカスを戻す（無ければ body）→ onClose → onRun
 * - 問い合わせ・行の文字は JSX のテキスト / value だけ（HTML 文字列・style を使わない）。DOM の id は useId + 位置
 */
export function Palette(p: {
  open: boolean;
  items: readonly PaletteItem[];
  onClose: () => void;
  onRun: (run: PaletteRun) => void;
}) {
  if (!p.open) return null;
  return <PaletteBody items={p.items} onClose={p.onClose} onRun={p.onRun} />;
}

function PaletteBody(p: {
  items: readonly PaletteItem[];
  onClose: () => void;
  onRun: (run: PaletteRun) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const { setOpen } = useOverlay('palette');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(-1);

  const view = useMemo(() => paletteView(paletteFilter(p.items, query)), [p.items, query]);
  const disabled = view.shown.map((it) => it.disabled);
  // 選択中の位置（行が変わって押せない / 範囲外になったら先頭の押せる行）
  const cur =
    sel >= 0 && sel < disabled.length && disabled[sel] === false
      ? sel
      : menuMove(disabled, -1, 'Home');

  useLayoutEffect(() => {
    const dlg = ref.current;
    prevRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dlg && !dlg.open) dlg.show();
    setOpen(true);
    inputRef.current?.focus();
    // 非モーダルなので背景は inert でない。フォーカスがパレットの外へ出たら（文書の外から Tab で戻った・背景へ移った）
    // 入力欄へ戻す（#89 段 B のレビュー 1）
    const onFocusIn = (e: FocusEvent) => {
      if (!dlg?.open) return;
      if (e.target instanceof Node && dlg.contains(e.target)) return;
      inputRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      // アンマウントではフォーカスを戻さない（finish で戻した後に実行した行が動かしたフォーカスを奪わない）
      if (dlg?.open) dlg.close();
      setOpen(false);
    };
  }, [setOpen]);

  // 選択した行が一覧の枠の外なら枠の scrollTop だけを動かす（scrollIntoView はページ・シートを動かすので使わない）
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = cur >= 0 ? list?.children[cur] : undefined;
    if (!list || !(el instanceof HTMLElement)) return;
    const l = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top + 6;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 6;
  }, [cur]);

  const finish = (run: PaletteRun | null) => {
    const dlg = ref.current;
    if (dlg?.open) dlg.close();
    const prev = prevRef.current;
    if (prev?.isConnected) prev.focus({ preventScroll: true });
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    p.onClose();
    if (run) p.onRun(run);
  };

  const runAt = (i: number) => {
    const it = view.shown[i];
    if (it && !it.disabled && it.run) finish(it.run);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景のクリックだけ。キーの閉じ方は Esc（入力欄の onKeyDown）
    <dialog
      class="palette"
      ref={ref}
      aria-label="コマンドパレット"
      aria-modal="true"
      onCancel={(e) => {
        // 念のため（非モーダルの dialog は Esc で cancel しないが、来たら実行せずに閉じる）
        e.preventDefault();
        finish(null);
      }}
      onMouseDown={(e) => {
        // 箱の中（入力欄以外）・背景の mousedown で入力欄からフォーカスを外さない
        if (e.target !== inputRef.current) e.preventDefault();
      }}
      onClick={(e) => {
        // 背景（dialog 自身の、箱の外）のクリックで閉じる
        if (e.target !== ref.current) return;
        const b = boxRef.current?.getBoundingClientRect();
        const inside =
          b !== undefined &&
          e.clientX >= b.left &&
          e.clientX <= b.right &&
          e.clientY >= b.top &&
          e.clientY <= b.bottom;
        if (!inside) finish(null);
      }}
    >
      <div class="pal-box" ref={boxRef}>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="コマンド"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(cur >= 0 ? { 'aria-activedescendant': `${listId}-${cur}` } : {})}
          placeholder="コマンド・足・シナリオ…"
          autocomplete="off"
          spellcheck={false}
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSel(-1);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            const k = paletteKey({
              key: e.key,
              isComposing: e.isComposing,
              keyCode: e.keyCode,
              ctrl: e.ctrlKey,
              meta: e.metaKey,
              alt: e.altKey,
              shift: e.shiftKey,
            });
            if (k === null) return;
            e.preventDefault();
            if (k === 'run') runAt(cur);
            else if (k === 'close') finish(null);
            else if (k === 'up' || k === 'down')
              setSel(menuMove(disabled, cur, k === 'down' ? 'ArrowDown' : 'ArrowUp'));
          }}
        />
        <div class="pal-list" id={listId} ref={listRef} role="listbox" aria-label="コマンド">
          {view.shown.map((it, i) => {
            const grp = paletteGroupName(it.group);
            return (
              // 行のキーは入力欄（combobox）が受ける（aria-activedescendant）。行はフォーカスを取らない
              // biome-ignore lint/a11y/useKeyWithClickEvents: ↑↓ Enter は入力欄の onKeyDown
              <div
                key={it.id}
                class="pal-opt"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === cur ? 'true' : 'false'}
                aria-label={`${grp}: ${it.label}`}
                {...(it.disabled ? { 'aria-disabled': 'true' } : {})}
                {...(it.title !== undefined ? { title: it.title } : {})}
                {...(it.checked !== undefined
                  ? { 'aria-checked': it.checked ? 'true' : 'false' }
                  : {})}
                tabIndex={-1}
                onClick={() => runAt(i)}
              >
                <span class="pal-grp">{grp}</span>
                <span class="pal-lbl">{it.label}</span>
                {it.checked === true && (
                  <span class="pal-check" aria-hidden="true">
                    ✓
                  </span>
                )}
                {it.kbd !== undefined && <span class="kbd">{it.kbd}</span>}
              </div>
            );
          })}
        </div>
        <p class="pal-foot" role="status">
          {view.status}
        </p>
      </div>
    </dialog>
  );
}

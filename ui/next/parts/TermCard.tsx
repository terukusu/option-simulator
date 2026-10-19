import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { type TermCardView, termCardView } from '../../view/glossary';
import { useOverlay } from './overlay';
import { closeTerm, openTerm, useTermCard } from './termCard';

/**
 * 用語の説明カード（#167。docs/ui-redesign.md §5）。<dialog class="term-card" aria-modal="true"> を show() で開き、
 * dialog 自身を窓いっぱいの下敷きにする（コマンドパレットと同じ。showModal() の inert の作り直しを避ける）。
 * NextApp に 1 つだけ置き、開く用語は ./termCard.ts のストア（ⓘ の「用語:」・内訳の見出し・パレットの用語の行）。
 *
 * - 開くと見出しへフォーカス。フォーカスがカードの外へ出たら見出しへ戻す。開いている間は overlay として数える
 *   （開いていたメニュー / ポップオーバーは閉じる）。全体のキーは dialog[open] で止まる
 * - Esc・×・背景（箱の外）のクリックで閉じ、開く前の要素へフォーカスを戻す（その要素が閉じたポップオーバーの中なら
 *   その ⓘ のボタンへ。無ければ blur）
 * - 関連する用語のボタンで中身を替える（本文の枠を先頭へ・見出しへフォーカス）
 * - 中身は表示モデル（ui/view/glossary.ts の termCardView）を JSX のテキストで描くだけ（HTML 文字列・style を使わない）
 */
export function TermCard() {
  const id = useTermCard();
  const view = id === null ? null : termCardView(id);
  if (!view) return null;
  return <TermCardBody view={view} />;
}

/** 戻す先: 開く前の要素。閉じたポップオーバー（[hidden]）の中ならその ⓘ のボタン */
function returnTarget(prev: HTMLElement | null): HTMLElement | null {
  if (!prev?.isConnected) return null;
  if (prev.closest('[hidden]') === null) return prev;
  const btn = prev.closest('.pop-wrap')?.querySelector(':scope > button');
  return btn instanceof HTMLElement && btn.isConnected ? btn : null;
}

function TermCardBody({ view }: { view: TermCardView }) {
  const ref = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const { setOpen } = useOverlay('term-card');

  useLayoutEffect(() => {
    const dlg = ref.current;
    prevRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dlg && !dlg.open) dlg.show();
    setOpen(true);
    const onFocusIn = (e: FocusEvent) => {
      if (!dlg?.open) return;
      if (e.target instanceof Node && dlg.contains(e.target)) return;
      headRef.current?.focus({ preventScroll: true });
    };
    // 非モーダルの dialog は Esc で cancel しないので文書の keydown で閉じる（フォーカスが body に落ちていても効く）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      closeTerm();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKey);
      if (dlg?.open) dlg.close();
      setOpen(false);
      const back = returnTarget(prevRef.current);
      if (back) back.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
  }, [setOpen]);

  // 開いたとき・関連する用語へ移ったとき: 本文の枠を先頭へ、見出しへフォーカス
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    headRef.current?.focus({ preventScroll: true });
  }, [view.id]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景のクリックだけ。キーの閉じ方は Esc（文書の keydown）と ×
    <dialog
      class="term-card"
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        closeTerm();
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
        if (!inside) closeTerm();
      }}
    >
      <div class="tc-box" ref={boxRef}>
        <div class="tc-head">
          <h2 id={titleId} ref={headRef} tabIndex={-1}>
            {view.title}
          </h2>
          <button type="button" class="btn ghost icon" aria-label="閉じる" onClick={closeTerm}>
            ×
          </button>
        </div>
        <div class="tc-body" ref={bodyRef} tabIndex={-1}>
          <p class="tc-reading">{view.reading}</p>
          {view.aliases !== '' && <p class="tc-aliases">別名: {view.aliases}</p>}
          <p class="tc-summary">{view.summary}</p>
          {view.body.map((p, i) => (
            // 段落は毎回同じ順（並べ替えない）
            <p key={i}>{p}</p>
          ))}
          {view.formula !== null && (
            <>
              <h3>式</h3>
              <p class="tc-formula">{view.formula}</p>
            </>
          )}
          {view.example !== null && (
            <>
              <h3>例</h3>
              <p>{view.example}</p>
            </>
          )}
          <h3>出る場所</h3>
          <ul class="tc-where">
            {view.where.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p class="tc-guide">マニュアル: {view.guide}</p>
          {view.related.length > 0 && (
            <>
              <h3>関連する用語</h3>
              <p class="tc-related">
                {view.related.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    class="term-link"
                    aria-label={`用語: ${r.title}`}
                    onClick={() => openTerm(r.id)}
                  >
                    {r.short}
                  </button>
                ))}
              </p>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

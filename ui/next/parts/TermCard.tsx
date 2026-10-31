import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { type TermCardView, termCardView } from '../../view/glossary';
import { cardTitle, type TermChainItem } from '../../view/termChain';
import { hideBackground } from './background';
import { Icon } from './Icon';
import { ManualContent } from './ManualBody';
import { useManual } from './manualDoc';
import { claimEscape } from './overlay';
import {
  backTerm,
  closeTerm,
  openManual,
  openTerm,
  setTermScrollReader,
  useTermCard,
} from './termCard';

/**
 * 用語の説明カード（#167。docs/ui-redesign.md §5）。<dialog class="term-card" aria-modal="true"> を show() で開き、
 * dialog 自身を窓いっぱいの下敷きにする（コマンドパレットと同じ。showModal() の inert の作り直しを避ける）。ただし
 * モーダルのダイアログ（保存一覧・保有ポジション）が開いているときは showModal() でその上に出す（#322）。
 * NextApp に 1 つだけ置き、開く用語は ./termCard.ts のストア（ⓘ の「用語:」・内訳の見出し・パレットの用語の行）。
 *
 * - 開くと見出しへフォーカス。フォーカスがカードの外へ出たら見出しへ戻す。Tab はカードの中のボタンで回る。
 *   開いている間は背景（兄弟の要素）に aria-hidden（#124。./background.ts）。overlay として数えない（#320 第 2 弾。
 *   ⓘ の吹き出しから開いても吹き出しは閉じずに下に残る）。全体のキーは dialog[open] で止まる
 * - 関連する用語のボタンで用語の列に積む（#320 第 2 弾。ui/view/termChain.ts）。今の本文の位置を控え、新しい用語は
 *   本文の先頭・見出しへフォーカス
 * - 戻る・Esc・[← 戻る]（1 つ前の用語があるときだけ）は 1 つ前の用語へ（控えた本文の位置に戻す）。最初の用語なら閉じる
 * - ×・背景（箱の外）のクリックは全部閉じる。閉じたら開く前の要素へフォーカスを戻す（その要素が閉じたポップオーバーの
 *   中ならその ⓘ のボタンへ。無ければ blur）
 * - 中身は表示モデル（ui/view/glossary.ts の termCardView）を JSX のテキストで描くだけ（HTML 文字列・style を使わない）
 * - 列には用語のほかにマニュアルの節・目次・AI の根拠の節を積む（#322。ui/view/termChain.ts の CardEntry）。マニュアルは
 *   それをカードに出したときに初めて読み込む（./manualDoc.ts）。中身は ./ManualBody.tsx
 */
export function TermCard() {
  const { current, prev } = useTermCard();
  const entry = current?.entry ?? null;
  const manual = useManual(entry !== null && entry.kind !== 'term');
  if (current === null || entry === null) return null;
  const index = manual.status === 'ready' ? manual.index : null;
  const prevTitle = prev === null ? null : cardTitle(prev, index);
  if (entry.kind === 'term') {
    const view = termCardView(entry.id);
    if (!view) return null;
    return (
      <TermCardBody title={view.title} item={current} prevTitle={prevTitle}>
        <TermBody view={view} />
      </TermCardBody>
    );
  }
  return (
    <TermCardBody title={cardTitle(entry, index)} oneLine item={current} prevTitle={prevTitle}>
      <ManualContent entry={entry} manual={manual} />
    </TermCardBody>
  );
}

/** 戻す先: 開く前の要素。閉じたポップオーバー（[hidden]）の中ならその ⓘ のボタン */
function returnTarget(prev: HTMLElement | null): HTMLElement | null {
  if (!prev?.isConnected) return null;
  if (prev.closest('[hidden]') === null) return prev;
  const btn = prev.closest('.pop-wrap')?.querySelector(':scope > button');
  return btn instanceof HTMLElement && btn.isConnected ? btn : null;
}

/**
 * Tab の輪（#124）: 後ろにボタンが無いところ（最後のボタン・ボタンより後ろの本文）で Tab → 最初のボタン、
 * 最初のボタン・見出し・本文で Shift + Tab → 最後のボタン
 */
function tabRing(dlg: HTMLDialogElement, e: KeyboardEvent): void {
  const list = Array.from(dlg.querySelectorAll('button'));
  const first = list[0];
  const last = list.at(-1);
  if (!first || !last) return;
  const act = document.activeElement;
  const i = list.indexOf(act as HTMLButtonElement);
  // 本文（tabIndex=-1）などボタンでないところ: 文書の順で後ろにボタンが無ければ既定の Tab はカードの外へ出る
  const noneAfter =
    act !== null &&
    !list.some((b) => (act.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  if (e.shiftKey ? i <= 0 : i === list.length - 1 || (i < 0 && noneAfter)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

function TermCardBody({
  title,
  oneLine = false,
  item,
  prevTitle,
  children,
}: {
  title: string;
  /** 見出しを 1 行に収める（入らなければ省略記号。マニュアルの節。全文は本文の先頭の節の道筋と title） */
  oneLine?: boolean;
  item: TermChainItem;
  /** 戻り先の見出し（無ければ [← 戻る] を出さない） */
  prevTitle: string | null;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dlg = ref.current;
    prevRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // モーダルのダイアログ（保存一覧・保有ポジション。./Dialog.tsx の showModal()）の中の ⓘ から開いたときは、カードも
    // showModal() で top layer のその上に出す（show() のままだとモーダルの下に描かれ、inert で押せない。#322）。
    // カードを閉じればモーダルのダイアログが一番上に戻る。それ以外は今のまま show()（inert の作り直しを避ける）
    if (dlg && !dlg.open) {
      if (document.querySelector('dialog.sheet[open]') !== null) dlg.showModal();
      else dlg.show();
    }
    setTermScrollReader(() => bodyRef.current?.scrollTop ?? 0);
    // 見出しへフォーカスしてから背景を読み上げから外す（#124。./background.ts）
    headRef.current?.focus({ preventScroll: true });
    const showBg = dlg ? hideBackground(dlg) : null;
    const onFocusIn = (e: FocusEvent) => {
      if (!dlg?.open) return;
      if (e.target instanceof Node && dlg.contains(e.target)) return;
      headRef.current?.focus({ preventScroll: true });
    };
    // 非モーダルの dialog は Esc で cancel しないので文書の keydown で閉じる（フォーカスが body に落ちていても効く）
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && dlg) {
        tabRing(dlg, e);
        return;
      }
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      claimEscape(e);
      backTerm();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKey);
      showBg?.();
      if (dlg?.open) dlg.close();
      setTermScrollReader(null);
      const back = returnTarget(prevRef.current);
      if (back) back.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
  }, []);

  // 開いたとき・用語が替わったとき: 本文の枠を控えた位置へ（新しく積んだ用語は先頭）、見出しへフォーカス
  const scroll = item.scroll;
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = scroll;
    headRef.current?.focus({ preventScroll: true });
  }, [item.key]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 背景のクリックだけ。キーの閉じ方は Esc（文書の keydown）と ×
    <dialog
      class="term-card"
      ref={ref}
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        backTerm();
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
          {prevTitle !== null && (
            <button
              type="button"
              class="btn ghost icon"
              aria-label={`「${prevTitle}」に戻る`}
              title={`「${prevTitle}」に戻る`}
              onClick={backTerm}
            >
              <Icon name="back" />
            </button>
          )}
          <h2
            id={titleId}
            ref={headRef}
            tabIndex={-1}
            class={oneLine ? 'tc-one' : undefined}
            title={oneLine ? title : undefined}
          >
            {title}
          </h2>
          <button type="button" class="btn ghost icon" aria-label="閉じる" onClick={closeTerm}>
            <Icon name="close" />
          </button>
        </div>
        <div class="tc-body" ref={bodyRef} tabIndex={-1}>
          {children}
        </div>
      </div>
    </dialog>
  );
}

/** 用語の中身（#167） */
function TermBody({ view }: { view: TermCardView }) {
  return (
    <>
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
      <p class="tc-guide">
        マニュアル:{' '}
        <button
          type="button"
          class="tc-link"
          aria-haspopup="dialog"
          onClick={() => openManual(view.guideAnchor)}
        >
          {view.guide}
        </button>
      </p>
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
    </>
  );
}

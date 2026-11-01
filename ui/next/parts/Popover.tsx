import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  type HintEvent,
  hintAbove,
  hintAlign,
  hintNext,
  popAlign,
  revealDelta,
} from '../../view/hint';
import { escapeClaimed, overlayOnTop, useOverlay } from './overlay';

/**
 * ポップオーバー（docs/ui-redesign.md §5）。開閉の規則は旧 Hint と同じ ui/view/hint.ts の hintNext
 * （押すたびに反転・外側の pointerdown で閉じる・Esc で閉じてボタンへ戻す・同時に 1 つだけ = ./overlay.ts をメニューと共有）。
 * 位置は .pop-wrap に対する絶対配置 + 左右の揃え（style 属性を使わない）。揃えは開いた後に吹き出しの幅を測って
 * popAlign で決める（#344）: start（左端をボタンに）/ end（.end。右端をボタンに）/ fit（.fit。どちらに揃えても基準に
 * 入らないとき、窓の左右 8px の内側で中央 = 固定の位置。縦は .pop-wrap の flex の静的な位置 + translate でボタンの下（上））。
 * fit の間は窓が基準（上に開くかは窓で見る・祖先の scrollTop は動かさない）で、祖先がスクロールしたら閉じる
 * （固定の位置はスクロールについていかない。中にフォーカスがあればボタンへ戻す）。within の祖先に入らず fit でも、
 * その祖先が横を切らなければ窓に入る揃え（start / end）を使う。.pop-wrap が位置を持たない（position: static。スマホのピンの中身）ときは
 * 呼び出し側の CSS が位置を決めるので、今までの 2 択（hintAlign）のまま。
 *
 * 省略可能な props（#107。省略時の DOM・動きは #81 のまま）:
 * - label: 省略すると aria-label を出さない（名前はボタンの中身。指標のタイルの全文）
 * （#274 で読み取りの全文をやめ、上に開く up をなくした）
 * - within: 祖先のセレクタ。左右の揃えをその祖先の左右で判定し、祖先が縦にスクロールする要素なら
 *   開いたときにポップオーバーの下端が見えるまでその祖先の scrollTop だけを動かす（revealDelta）
 * - popClass（#87）: .popover に足すクラス（市場ピル・警告のタグの .wide）。省略時の DOM は #81 のまま
 *
 * 窓の下端で切れるとき（スクロールする祖先が無く、下に開くと窓の下端を越え、上なら入る）はボタンの上に開く（.above。
 * hintAbove。#320 第 2 弾で、説明カードの下に残す吹き出しの「用語:」が PC の窓の下で切れていたため）
 */
export function Popover(p: {
  label?: string;
  button: ComponentChildren;
  children: ComponentChildren;
  buttonClass?: string;
  within?: string;
  popClass?: string;
}) {
  const id = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // Esc で閉じる: 中にフォーカスがあればボタンへ戻す（戻るで閉じるときも同じ。#320）
  const closeByEscape = () => {
    const inside = wrapRef.current?.contains(document.activeElement) ?? false;
    setOpen(hintNext(true, 'escape'));
    if (inside) btnRef.current?.focus();
  };
  const { open, setOpen } = useOverlay(id, closeByEscape);
  const [align, setAlign] = useState<'start' | 'end' | 'fit'>('start');
  const [above, setAbove] = useState(false);
  const send = (ev: HintEvent) => setOpen(hintNext(open, ev));

  const within = p.within;
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const b = btnRef.current?.getBoundingClientRect();
    if (!wrap || !b) return;
    const host = within ? wrap.closest(within) : null;
    const h = host?.getBoundingClientRect();
    const hl = h ? h.left : 0;
    const hr = h ? h.right : window.innerWidth;
    // .pop-wrap が位置を持たない = 呼び出し側の CSS が位置を決める（スマホのピンの中身）。2 択のまま
    if (getComputedStyle(wrap).position === 'static') {
      setAlign(hintAlign((b.left + b.right) / 2, hl, hr));
      return;
    }
    // 幅は揃え（start / end / fit）に依らない（max-content + max-width・.wide は固定の幅）ので 1 回の測定で決まる
    const pop = wrap.querySelector('.popover');
    const pw = pop instanceof HTMLElement ? pop.getBoundingClientRect().width : 0;
    const a = popAlign(b.left, b.right, pw, hl, hr);
    // 祖先（within）に入らなくても、その祖先が横を切らない（overflow-x: visible）なら窓に入る揃えを使う（窓の中央に
    // 跳ぶのは窓に入らないときだけ）。横を切る祖先（スクロールする .panel-body）では外へ出た部分が切れるので fit のまま
    const widen = a === 'fit' && host && getComputedStyle(host).overflowX === 'visible';
    setAlign(widen ? popAlign(b.left, b.right, pw, 0, window.innerWidth) : a);
  }, [open, within]);

  // 開いた後（揃えが決まった後）、窓の下端で切れるなら上に開く（スクロールする祖先があればその祖先の中で見せる = 下）
  useLayoutEffect(() => {
    if (!open) {
      setAbove(false);
      return;
    }
    const wrap = wrapRef.current;
    const pop = wrap?.querySelector('.popover');
    if (!wrap || !(pop instanceof HTMLElement)) return;
    // fit（固定の位置）は窓が基準。スクロールする祖先の中で見せる（revealDelta）ことはしない
    if (align !== 'fit') {
      for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return;
      }
    }
    const w = wrap.getBoundingClientRect();
    const r = pop.getBoundingClientRect();
    const gap = above ? w.top - r.bottom : r.top - w.bottom;
    setAbove(hintAbove(w.top, w.bottom, gap, r.height, 0, window.innerHeight));
  }, [open, align]);

  // 開いた後（揃えが決まった後）、スクロールする祖先の中で下端が見えるようにする
  useLayoutEffect(() => {
    if (!open || !within || align === 'fit') return;
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

  // fit（固定の位置）で開いている間に祖先（または文書）がスクロールしたら閉じる（#344。固定の位置はスクロールに
  // ついていかず、ボタンから離れる）。吹き出しの中（.wide の中身）のスクロールは閉じない。中にフォーカスがあれば
  // Esc と同じくボタンへ戻す（preventScroll: 戻す操作で祖先をまた動かさない）
  useLayoutEffect(() => {
    if (!open || align !== 'fit') return;
    const onScroll = (e: Event) => {
      const w = wrapRef.current;
      const t = e.target;
      if (!w) return;
      if (t === document || (t instanceof Node && t !== w && !w.contains(t) && t.contains(w))) {
        const inside = w.contains(document.activeElement);
        setOpen(hintNext(true, 'other'));
        if (inside) btnRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [open, align, setOpen]);

  // 外側の pointerdown・Esc は開いた描画の直後から購読する。上に説明カードなどが重なっている間は閉じない
  // （#320 第 2 弾。カードの操作・Esc はカードのもの。カードを閉じると吹き出しが開いたまま残る）
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!overlayOnTop(id)) return;
      const w = wrapRef.current;
      if (w && e.target instanceof Node && w.contains(e.target)) return;
      setOpen(hintNext(true, 'outside'));
    };
    const onKey = (e: KeyboardEvent) => {
      // 上に重なったもの（説明カード）が処理した Esc では閉じない（listener の登録順に頼らない。#320 第 2 弾）
      if (e.key !== 'Escape' || escapeClaimed(e) || !overlayOnTop(id)) return;
      closeByEscape();
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
        class={`popover${p.popClass ? ` ${p.popClass}` : ''}${align === 'end' ? ' end' : align === 'fit' ? ' fit' : ''}${above ? ' above' : ''}`}
        id={`${id}-pop`}
        hidden={!open}
      >
        {p.children}
      </div>
    </span>
  );
}

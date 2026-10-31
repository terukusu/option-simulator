import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * 横にスクロールする枠の続きのある側（#234・#322。AI の返答の表と、説明カードのマニュアルの表・コードブロック）。
 * 'start' | 'end' | 'both' を data-more に書き、CSS が端をぼかす。続きが無ければ null
 */
export function moreOf(el: HTMLElement): string | null {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : null;
}

/**
 * 横にスクロールする枠の共通の動き（#234・#322）: 続きのある側を data-more に書き（DOM の属性を直接書く = 描き直しを
 * 起こさない。style 属性は使わない）、はみ出しているか（over）を返す。測るのは mount・scroll（onScroll を枠に付ける）・
 * ResizeObserver（枠と中身 = 最初の子要素。流れで行が増えたときも中身の大きさの変化で届く）のときだけ。
 * over のときだけ枠をフォーカスできる名前つきの region にする（呼び出し側）
 */
export function useScrollMore(): {
  ref: RefObject<HTMLDivElement>;
  over: boolean;
  onScroll: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const m = moreOf(el);
    if (m === null) el.removeAttribute('data-more');
    else el.setAttribute('data-more', m);
    setOver(el.scrollWidth > el.clientWidth + 1);
  };
  useLayoutEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, []);
  return { ref, over, onScroll: update };
}

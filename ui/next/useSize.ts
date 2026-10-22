import { useEffect, useRef, useState } from 'preact/hooks';

/** スマホのシート（shell.css の `transition: height` が付くのはこの 2 つだけ。#91 段 C） */
const SHEET_SEL = 'section.panel.side, section.scenario';

/** 走っているシートの高さの補間（peek ⇄ full） */
export function sheetTransition(anims: readonly Animation[]): Animation | undefined {
  return anims.find((a) => {
    if (!(a instanceof CSSTransition)) return false;
    if (a.transitionProperty !== 'height' || a.playState !== 'running') return false;
    const t = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    return t instanceof Element && t.matches(SHEET_SEL);
  });
}

/**
 * el の幅と高さ（CSS px、整数に切り捨て）を ResizeObserver で追い、変わったら onSize に渡す（最初に 1 回すぐ渡す）。
 * 反映は次のフレーム（ResizeObserver loop completed with undelivered notifications を出さない）。シートの高さの補間が
 * 走っている間は反映を止め、終わり（finished。取り消しでも）で 1 回だけ反映する（補間の間に舞台・パネルをフレームごとに
 * 描き直さない。#123）。返り値で止める（止めた後は onSize を呼ばない）
 */
export function watchSize(el: HTMLElement, onSize: (w: number, h: number) => void): () => void {
  let alive = true;
  const update = () => onSize(Math.floor(el.clientWidth), Math.floor(el.clientHeight));
  update();
  let frame = 0;
  let waiting = false;
  const schedule = () => {
    if (frame || waiting) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const move = sheetTransition(document.getAnimations());
      if (!move) {
        update();
        return;
      }
      waiting = true;
      const done = () => {
        waiting = false;
        if (alive) schedule();
      };
      move.finished.then(done, done);
    });
  };
  const ro = new ResizeObserver(schedule);
  ro.observe(el);
  return () => {
    alive = false;
    if (frame) cancelAnimationFrame(frame);
    ro.disconnect();
  };
}

/**
 * 要素の幅と高さ（CSS px、整数に切り捨て）を追う DOM のフック（#82。舞台の描画域・レール）。規則は watchSize
 */
export function useSize<T extends HTMLElement = HTMLDivElement>(
  initialWidth: number,
  initialHeight: number,
) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: initialWidth, height: initialHeight });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watchSize(el, (width, height) =>
      setSize((s) => (s.width === width && s.height === height ? s : { width, height })),
    );
  }, []);
  return { ref, width: size.width, height: size.height };
}

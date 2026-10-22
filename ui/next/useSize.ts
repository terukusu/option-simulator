import { useEffect, useRef, useState } from 'preact/hooks';

/** ページで走っている高さの補間（スマホのシート peek ⇄ full。shell.css の `transition: height`。#91 段 C） */
const heightTransition = (): Animation | undefined =>
  document
    .getAnimations()
    .find(
      (a) =>
        a instanceof CSSTransition &&
        a.transitionProperty === 'height' &&
        a.playState === 'running',
    );

/**
 * 要素の幅と高さ（CSS px、整数に切り捨て）を ResizeObserver で追う DOM のフック（#82。舞台の描画域・レール）。
 * ページで高さの補間が走っている間は反映を止め、終わり（finished。取り消しでも）で 1 回だけ反映する
 * （シートの補間の間に舞台・パネルをフレームごとに描き直さない。#123）。
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
    let alive = true;
    const update = () => {
      const width = Math.floor(el.clientWidth);
      const height = Math.floor(el.clientHeight);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    update();
    // 大きさの変更で描き直すと同じフレームの観測が続くので、反映は次のフレームに回す
    // （ResizeObserver loop completed with undelivered notifications を出さない）
    let frame = 0;
    let waiting = false;
    const schedule = () => {
      if (frame || waiting) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const move = heightTransition();
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
  }, []);
  return { ref, width: size.width, height: size.height };
}

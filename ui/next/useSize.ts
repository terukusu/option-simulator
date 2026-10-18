import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * 要素の幅と高さ（CSS px、整数に切り捨て）を ResizeObserver で追う DOM のフック（#82。舞台の描画域・レール）。
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
    const update = () => {
      const width = Math.floor(el.clientWidth);
      const height = Math.floor(el.clientHeight);
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    update();
    // 大きさの変更で描き直すと同じフレームの観測が続くので、反映は次のフレームに回す
    // （ResizeObserver loop completed with undelivered notifications を出さない）
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
    });
    ro.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);
  return { ref, width: size.width, height: size.height };
}

import { useEffect, useRef, useState } from 'preact/hooks';

/** 要素の幅（CSS px、最小 200）を ResizeObserver で追う。スマイルと損益グラフで共用。 */
export function useWidth<T extends HTMLElement = HTMLDivElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(200, Math.floor(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { SurfaceImage } from '../../view/pnlSurface';

/** backing の倍率の上限（格子を平滑化して広げるだけなので 2 倍を超えても見た目は変わらない） */
const MAX_DPR = 2;

const backingDpr = () => {
  const d = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return Math.min(Math.max(Number.isFinite(d) ? d : 1, 1), MAX_DPR);
};

/**
 * 面モードの canvas（docs/ui-redesign.md §8。#88 段 A）。`.chart` 全体に重ね（SVG の下）、backing は CSS px × DPR
 * （width / height 属性）、見た目の大きさはクラスの CSS。格子の RGBA を nx × ny のオフスクリーン canvas に
 * putImageData → 描画域の矩形（device px の整数）へ平滑化して drawImage。描くのは 2D API だけ（画像の URL にしない。CSP）。
 * image が null なら消すだけ。
 */
export function SurfaceCanvas(p: {
  width: number;
  height: number;
  image: SurfaceImage | null;
  /** 描画域（.chart の CSS px） */
  rect: { left: number; top: number; width: number; height: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const dpr = backingDpr();
  const bw = Math.max(Math.round(p.width * dpr), 1);
  const bh = Math.max(Math.round(p.height * dpr), 1);
  const { image } = p;
  const { left, top, width, height } = p.rect;
  useLayoutEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    if (!image || !(width > 0 && height > 0)) return;
    let off = offRef.current;
    if (!off) {
      off = document.createElement('canvas');
      offRef.current = off;
    }
    if (off.width !== image.nx) off.width = image.nx;
    if (off.height !== image.ny) off.height = image.ny;
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.putImageData(new ImageData(image.data, image.nx, image.ny), 0, 0);
    // 描画域の矩形は device px の整数（平滑化の端が描画域の外へにじまない）
    const x0 = Math.round(left * dpr);
    const y0 = Math.round(top * dpr);
    const x1 = Math.round((left + width) * dpr);
    const y1 = Math.round((top + height) * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.drawImage(off, 0, 0, image.nx, image.ny, x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }, [image, left, top, width, height, dpr, bw, bh]);
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 飾りの canvas（tabindex なし・pointer-events: none。値は描画域の aria-label と読み取りで読む）
    <canvas class="surface" aria-hidden="true" ref={ref} width={bw} height={bh} />
  );
}

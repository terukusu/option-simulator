/**
 * 建玉の一覧の画像を送る形に作り直す（#318・docs/adr-0009-ai-image-read-positions.md）。DOM（createImageBitmap・canvas・
 * Blob）を使う所だけ。規則（寸法・段・base64）は ui/view/imageScale.ts の純関数。
 *
 * - 選んだ画像を createImageBitmap（向きは EXIF のとおり）→ canvas に長辺 2,000 px 以下で描き直す → PNG、上限を超えたら
 *   JPEG の品質を下げる段。canvas の再エンコードは画素だけを書くので EXIF・撮影位置・端末名などのメタデータは落ちる
 * - プレビューは送るものと同じ画像（作り直した Blob の ImageBitmap）を canvas に描く（<img src=blob:|data:> を使わない
 *   = CSP の img-src を変えない）
 * - 巨大な画像（30 MB 超・見出しの寸法で 4,000 万画素超）は復号する前に断る（端末のメモリを守る。error `huge`）
 * - 画像はメモリだけ（Web Storage・IndexedDB・Cache・URL に入れない）。使い終わったら dispose で ImageBitmap を閉じる
 */

import {
  ENCODE_STEPS,
  type EncodeStep,
  fitLongEdge,
  pickEncoding,
  sniffImageDims,
  toBase64,
  tooBigToDecode,
} from './view/imageScale';

export interface EncodedImage {
  mediaType: 'image/png' | 'image/jpeg';
  /** 送る base64（標準の字母・改行なし） */
  base64: string;
  /** 送る生のバイト数 */
  bytes: number;
  /** 送る寸法 */
  width: number;
  height: number;
  /** 選んだ画像の寸法 */
  srcWidth: number;
  srcHeight: number;
  /** 送るものと同じ画像（プレビュー用。dispose で閉じる） */
  preview: ImageBitmap;
}

export type EncodeError = 'not_image' | 'too_large' | 'huge';
export type EncodeResult = { ok: true; image: EncodedImage } | { ok: false; error: EncodeError };

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toBlob(canvas: AnyCanvas, step: EncodeStep): Promise<Blob | null> {
  const opts =
    step.quality === undefined ? { type: step.type } : { type: step.type, quality: step.quality };
  if ('convertToBlob' in canvas) return canvas.convertToBlob(opts).catch(() => null);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), step.type, step.quality));
}

/** 画像（ファイル・貼り付け）を送る形に作り直す。画像として読めない → not_image、下げきっても上限を超える → too_large */
export async function encodeImage(file: Blob): Promise<EncodeResult> {
  if (tooBigToDecode(file.size, null)) return { ok: false, error: 'huge' };
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
  } catch {
    return { ok: false, error: 'not_image' };
  }
  if (tooBigToDecode(file.size, sniffImageDims(head))) return { ok: false, error: 'huge' };
  let src: ImageBitmap;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, error: 'not_image' };
  }
  try {
    if (!(src.width > 0 && src.height > 0)) return { ok: false, error: 'not_image' };
    const { w, h } = fitLongEdge(src.width, src.height);
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) return { ok: false, error: 'not_image' };
    // JPEG は透明を持たないので白の上に描く（透明の PNG が黒くならない）。PNG もそのまま白の上（読み取りの見え方を同じに）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    for (const step of ENCODE_STEPS) {
      const blob = await toBlob(canvas, step);
      // ブラウザが JPEG を作れず PNG で返した段などは使わない（形式と中身を合わせる）
      if (!blob || blob.type !== step.type || pickEncoding([blob.size]) === null) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const preview = await createImageBitmap(blob);
      return {
        ok: true,
        image: {
          mediaType: step.type,
          base64: toBase64(bytes),
          bytes: bytes.length,
          width: w,
          height: h,
          srcWidth: src.width,
          srcHeight: src.height,
          preview,
        },
      };
    }
    return { ok: false, error: 'too_large' };
  } finally {
    src.close();
  }
}

/** プレビューを閉じる（参照を捨てる前に） */
export function disposeImage(img: EncodedImage | null): void {
  img?.preview.close();
}

export type PickOutcome =
  | { kind: 'ok'; image: EncodedImage }
  | { kind: 'error'; error: EncodeError }
  /** もっと新しい選択がある（この結果は捨てた） */
  | { kind: 'stale' };

/**
 * 画像の選択を「最後に選んだものだけ」にする（世代番号）。作り直しの途中でもう 1 枚選ばれたら、古い方の結果は dispose して
 * stale を返す。作り直しの例外は not_image にする（呼び出し側が「作り直し中」のまま固まらない）。cancel はダイアログを
 * 閉じたとき（途中の結果を捨てる）
 */
export function latestPicker(
  encode: (file: Blob) => Promise<EncodeResult> = encodeImage,
  dispose: (img: EncodedImage) => void = (img) => disposeImage(img),
) {
  let gen = 0;
  return {
    async pick(file: Blob): Promise<PickOutcome> {
      const mine = ++gen;
      let r: EncodeResult;
      try {
        r = await encode(file);
      } catch {
        r = { ok: false, error: 'not_image' };
      }
      if (mine !== gen) {
        if (r.ok) dispose(r.image);
        return { kind: 'stale' };
      }
      return r.ok ? { kind: 'ok', image: r.image } : { kind: 'error', error: r.error };
    },
    cancel(): void {
      gen++;
    },
  };
}

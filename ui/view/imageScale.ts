/**
 * 建玉の一覧の画像を送る前の作り直しの規則（#318・docs/adr-0009-ai-image-read-positions.md。純関数。DOM を読まない）。
 *
 * 画像はブラウザで canvas に描き直して PNG / JPEG に再エンコードする（EXIF などのメタデータ = 撮影位置・端末名を落とす）。
 * 上限は同梱の CLI が画像を作り直さずにバイトのまま上流へ渡す範囲（中継の AI_IMAGE_MAX_EDGE・AI_IMAGE_MAX_BYTES と同じ）:
 * 長辺 ≤ 2,000 px・生のバイト数 ≤ 500,000 B。超えたら品質を下げる段を順に試し、下げきっても超えたら送らない。
 * canvas・Blob を触るのは ui/imageEncode.ts。
 */

/** 長辺の上限（px。中継の AI_IMAGE_MAX_EDGE） */
export const IMAGE_MAX_EDGE = 2000;
/** 生のバイト数の上限（中継の AI_IMAGE_MAX_BYTES） */
export const IMAGE_MAX_BYTES = 500_000;
/**
 * 画像 1 枚のトークンの上限（公式の文書の高解像度の段。中継の AI_IMAGE_MAX_TOKENS）。⌈w/28⌉×⌈h/28⌉ の素の計算は
 * 2,000×2,000 で 5,184 だが、4,784 を超える寸法は上流が縮めて 4,784 に収める前提（モデル・SDK の更新時に見直す）
 */
export const IMAGE_MAX_TOKENS = 4784;

/** 長辺を max 以下に縮めた寸法（縦横比を保つ。短辺は四捨五入で 1 以上）。w・h は正の整数 */
export function fitLongEdge(w: number, h: number, max = IMAGE_MAX_EDGE): { w: number; h: number } {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) {
    throw new Error('寸法は正の整数');
  }
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const s = max / long;
  return w >= h
    ? { w: max, h: Math.max(1, Math.round(h * s)) }
    : { w: Math.max(1, Math.round(w * s)), h: max };
}

/** 画像 1 枚のトークンの目安（⌈w/28⌉ × ⌈h/28⌉。上限 IMAGE_MAX_TOKENS） */
export function visualTokens(w: number, h: number): number {
  return Math.min(Math.ceil(w / 28) * Math.ceil(h / 28), IMAGE_MAX_TOKENS);
}

export interface EncodeStep {
  type: 'image/png' | 'image/jpeg';
  /** JPEG の品質（0〜1） */
  quality?: number;
}

/** 試す段: PNG（文字の画面は PNG が小さく、にじまない）→ JPEG の品質 0.92 → 0.85 → 0.75 → 0.65 */
export const ENCODE_STEPS: readonly EncodeStep[] = [
  { type: 'image/png' },
  { type: 'image/jpeg', quality: 0.92 },
  { type: 'image/jpeg', quality: 0.85 },
  { type: 'image/jpeg', quality: 0.75 },
  { type: 'image/jpeg', quality: 0.65 },
];

/** 段ごとの大きさ（バイト）から使う段の番号（最初に max 以下になった段。どれも超えたら null = 送らない） */
export function pickEncoding(sizes: readonly number[], max = IMAGE_MAX_BYTES): number | null {
  const i = sizes.findIndex((n) => n > 0 && n <= max);
  return i < 0 ? null : i;
}

/** バイト列 → base64（標準の字母・改行なし）。32 KB ずつ btoa に渡す（Buffer は使わない） */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** EXIF の印（`Exif\0\0`）がバイト列に含まれるか（作り直した画像に残っていないことの確かめ） */
export function hasExifMark(bytes: Uint8Array): boolean {
  const mark = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  outer: for (let i = 0; i + mark.length <= bytes.length; i++) {
    for (let j = 0; j < mark.length; j++) if (bytes[i + j] !== mark[j]) continue outer;
    return true;
  }
  return false;
}

/** 送る大きさの表示（KB。1 KB = 1,000 B、小数 0 桁） */
export function sizeText(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1000)).toLocaleString('en-US')} KB`;
}

/** 選んだファイルの大きさの上限（復号する前に断る。端末のメモリを守る） */
export const SOURCE_MAX_BYTES = 30_000_000;
/** 選んだ画像の画素数の上限（復号する前に見出しの寸法で断る。巨大な画像を原寸で展開しない） */
export const SOURCE_MAX_PIXELS = 40_000_000;

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 0x10000 + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);

/**
 * 画像の先頭のバイト列（見出し）から寸法を読む（PNG の IHDR・JPEG の SOF・WebP の VP8 / VP8L / VP8X）。画素は復号しない。
 * 読めなければ null（そのときは復号に任せる）
 */
export function sniffImageDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[12] === 0x49 && b[13] === 0x48) {
    return { w: u32be(b, 16), h: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1] ?? 0;
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null;
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: u16be(b, i + 7), h: u16be(b, i + 5) };
      }
      i += 2 + len;
    }
    return null;
  }
  const tag = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
  if (b.length >= 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const kind = tag(12);
    if (kind === 'VP8X') return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** 復号する前に断るか（大きさ・見出しの画素数が上限を超える）。寸法が読めなければ大きさだけで判定 */
export function tooBigToDecode(size: number, dims: { w: number; h: number } | null): boolean {
  return size > SOURCE_MAX_BYTES || (dims !== null && dims.w * dims.h > SOURCE_MAX_PIXELS);
}

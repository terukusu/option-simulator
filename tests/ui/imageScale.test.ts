import { describe, expect, it } from 'vitest';
import {
  ENCODE_STEPS,
  fitLongEdge,
  hasExifMark,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_TOKENS,
  pickEncoding,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_PIXELS,
  sizeText,
  sniffImageDims,
  toBase64,
  tooBigToDecode,
  visualTokens,
} from '../../ui/view/imageScale';

/**
 * #318 AC4: 送る前の画像の作り直しの規則（ui/view/imageScale.ts）。上限は中継（api の AI_IMAGE_MAX_EDGE・
 * AI_IMAGE_MAX_BYTES・AI_IMAGE_MAX_TOKENS）と同じ。
 */

describe('fitLongEdge（長辺 2,000 px 以下・縦横比を保つ）', () => {
  it('上限は中継と同じ（長辺 2,000・500,000 B・1 枚 4,784 トークン）', () => {
    expect([IMAGE_MAX_EDGE, IMAGE_MAX_BYTES, IMAGE_MAX_TOKENS]).toEqual([2000, 500_000, 4784]);
  });

  it('長辺が上限以下ならそのまま（1080×1920・2000×2000）', () => {
    expect(fitLongEdge(1080, 1920)).toEqual({ w: 1080, h: 1920 });
    expect(fitLongEdge(2000, 2000)).toEqual({ w: 2000, h: 2000 });
    expect(fitLongEdge(1, 1)).toEqual({ w: 1, h: 1 });
  });

  it('Android のスクリーンショット 1080×2400 → 900×2000', () => {
    expect(fitLongEdge(1080, 2400)).toEqual({ w: 900, h: 2000 });
  });

  it('1440×3200 → 長辺 2,000 以下・縦横比 ±1 px', () => {
    const r = fitLongEdge(1440, 3200);
    expect(Math.max(r.w, r.h)).toBeLessThanOrEqual(2000);
    expect(r.h).toBe(2000);
    expect(Math.abs(r.w - (1440 * 2000) / 3200)).toBeLessThanOrEqual(1);
  });

  it('横長も同じ（2576×1000 → 2000×776）・極端な比でも短辺 ≥ 1', () => {
    expect(fitLongEdge(2576, 1000)).toEqual({ w: 2000, h: 776 });
    expect(fitLongEdge(8000, 1)).toEqual({ w: 2000, h: 1 });
  });

  it('寸法が正の整数でなければ例外', () => {
    expect(() => fitLongEdge(0, 10)).toThrow();
    expect(() => fitLongEdge(10.5, 10)).toThrow();
    expect(() => fitLongEdge(Number.NaN, 10)).toThrow();
  });
});

describe('visualTokens', () => {
  it('⌈w/28⌉ × ⌈h/28⌉、上限 4,784', () => {
    expect(visualTokens(900, 2000)).toBe(33 * 72);
    expect(visualTokens(28, 28)).toBe(1);
    expect(visualTokens(2000, 2000)).toBe(4784);
  });
});

describe('pickEncoding（大きさの上限を超えたら品質を下げる段、下げきっても超えたら送らない）', () => {
  it('段は PNG → JPEG 0.92 → 0.85 → 0.75 → 0.65', () => {
    expect(ENCODE_STEPS.map((s) => `${s.type}${s.quality ?? ''}`)).toEqual([
      'image/png',
      'image/jpeg0.92',
      'image/jpeg0.85',
      'image/jpeg0.75',
      'image/jpeg0.65',
    ]);
  });

  it('PNG が上限以下なら PNG', () => {
    expect(pickEncoding([120_000, 90_000])).toBe(0);
    expect(pickEncoding([500_000])).toBe(0);
  });

  it('PNG が超えたら最初に上限以下になった JPEG の段', () => {
    expect(pickEncoding([900_000, 620_000, 480_000, 300_000])).toBe(2);
    expect(pickEncoding([500_001, 500_000])).toBe(1);
  });

  it('全部の段で超えたら null（送らない）', () => {
    expect(pickEncoding([900_000, 800_000, 700_000, 600_000, 500_001])).toBeNull();
    expect(pickEncoding([])).toBeNull();
  });

  it('0 バイト（作れなかった段）は使わない', () => {
    expect(pickEncoding([0, 100])).toBe(1);
  });
});

describe('toBase64・hasExifMark', () => {
  it('btoa の結果と一致（32 KB の境をまたぐ長さ・全部のバイト値）', () => {
    const n = 0x8000 * 2 + 17;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(toBase64(bytes)).toBe(btoa(bin));
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect(toBase64(new Uint8Array([0xff, 0xd8]))).toBe('/9g=');
  });

  it('EXIF の印（Exif\\0\\0）を見つける（作り直した画像に無いことの確かめに使う）', () => {
    const exif = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0, 0, 1,
    ]);
    expect(hasExifMark(exif)).toBe(true);
    expect(hasExifMark(new Uint8Array([0xff, 0xd8, 0x45, 0x78, 0x69, 0x66, 0]))).toBe(false);
    expect(hasExifMark(new Uint8Array(0))).toBe(false);
  });

  it('送る大きさの表示', () => {
    expect(sizeText(123_456)).toBe('123 KB');
    expect(sizeText(1_200)).toBe('1 KB');
    expect(sizeText(10)).toBe('1 KB');
  });
});

describe('sniffImageDims・tooBigToDecode（巨大な画像を復号する前に断る。#318 レビュー N1）', () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (w: number, h: number) =>
    new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      ...be32(w),
      ...be32(h),
      8,
      2,
      0,
      0,
      0,
    ]);
  const jpeg = (w: number, h: number) =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0,
      4,
      0,
      0,
      0xff,
      0xc0,
      0,
      17,
      8,
      h >> 8,
      h & 255,
      w >> 8,
      w & 255,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
    ]);
  const webpX = (w: number, h: number) => {
    const b = new Uint8Array(30);
    b.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    );
    b.set(
      [...'WEBP'].map((c) => c.charCodeAt(0)),
      8,
    );
    b.set(
      [...'VP8X'].map((c) => c.charCodeAt(0)),
      12,
    );
    const w1 = w - 1;
    const h1 = h - 1;
    b.set(
      [w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255, h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255],
      24,
    );
    return b;
  };

  it('PNG・JPEG・WebP（VP8X）の見出しから寸法を読む。読めなければ null', () => {
    expect(sniffImageDims(png(1080, 2400))).toEqual({ w: 1080, h: 2400 });
    expect(sniffImageDims(jpeg(30000, 20000))).toEqual({ w: 30000, h: 20000 });
    expect(sniffImageDims(webpX(16383, 9000))).toEqual({ w: 16383, h: 9000 });
    expect(sniffImageDims(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('30 MB 超・4,000 万画素超は復号する前に断る（寸法が読めなければ大きさだけ）', () => {
    expect([SOURCE_MAX_BYTES, SOURCE_MAX_PIXELS]).toEqual([30_000_000, 40_000_000]);
    expect(tooBigToDecode(1_000_000, { w: 1080, h: 2400 })).toBe(false);
    expect(tooBigToDecode(1_000_000, { w: 30000, h: 20000 })).toBe(true);
    expect(tooBigToDecode(30_000_001, null)).toBe(true);
    expect(tooBigToDecode(29_000_000, null)).toBe(false);
  });
});

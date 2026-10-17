/**
 * 副題の幅の単位（#107 AC-2 の目安。実装には入れない）: ASCII 1・全角（U+3000–U+9FFF・U+FF00–U+FFEF）2、ほかは 1。
 * 等幅 10.5px で ASCII 5.25px・全角 10.5px。360px の 2 列のタイルの .s は 144px → 27。
 */
export function widthUnits(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ? 2 : 1;
  }
  return w;
}

/** 360px の 2 列のタイルの副題の目安（144px ÷ 5.25px） */
export const SUB_MAX_UNITS = 27;

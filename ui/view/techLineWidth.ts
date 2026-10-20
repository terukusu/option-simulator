/**
 * テクニカルの線の太さ（#214。docs/ui-redesign.md §4.8・§5）。設定の節「テクニカル指標」の 3 段（細い / 普通 / 太い）を、
 * 先物推移の EMA の 3 本と指標の段の線（RSI・MACD とシグナル・SO の %K / %D）の太さ（px。SVG の stroke-width 属性）に
 * 当てる。1 つの設定で両方に効く。EMA は価格のローソクに重なるので段の線より一段細い（普通の段の線は #200 の 1.25 のまま）。
 * MACD のヒストの棒・ガイド・カーソルは対象外。純関数だけ。
 */

export type TechLineWidth = 'thin' | 'normal' | 'thick';

export const TECH_LINE_WIDTH_VALUES: readonly TechLineWidth[] = ['thin', 'normal', 'thick'];

export const DEFAULT_TECH_LINE_WIDTH: TechLineWidth = 'normal';

/** 段ごとの太さ（px）。ema = EMA の 3 本（3 本とも同じ）、pane = 指標の段の線 */
export const TECH_LINE_WIDTHS: Record<TechLineWidth, { ema: number; pane: number }> = {
  thin: { ema: 0.75, pane: 1 },
  normal: { ema: 1, pane: 1.25 },
  thick: { ema: 1.5, pane: 1.75 },
};

/** 設定の Seg の選択肢 */
export const TECH_LINE_WIDTH_OPTIONS: readonly { value: TechLineWidth; text: string }[] = [
  { value: 'thin', text: '細い' },
  { value: 'normal', text: '普通' },
  { value: 'thick', text: '太い' },
];

export const isTechLineWidth = (v: unknown): v is TechLineWidth =>
  typeof v === 'string' && (TECH_LINE_WIDTH_VALUES as readonly string[]).includes(v);

/** 段 → 太さ（無い・不正 → 普通） */
export function techLineWidths(w: TechLineWidth | undefined): { ema: number; pane: number } {
  return TECH_LINE_WIDTHS[isTechLineWidth(w) ? w : DEFAULT_TECH_LINE_WIDTH];
}

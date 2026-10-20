/**
 * テクニカルの線の太さ（#214。docs/ui-redesign.md §4.8・§5）。設定の節「テクニカル指標」の 2 つの選択（px）を、
 * 先物推移の EMA の 3 本（3 本とも同じ太さ）と指標の段の線（RSI・MACD とシグナル・SO の %K / %D）の太さ（CSS px。
 * SVG の stroke-width 属性 + CSS の vector-effect: non-scaling-stroke = 拡大縮小に関係なく画面の px）に当てる。
 * 選べる値は TradingView と同じ 1 / 1.5 / 2 / 3 px に、段の線の既定 1.25 px（#200 からの今の太さ = 既定の見た目を
 * 変えない）を足した 5 つ。MACD のヒストの棒・ガイド・カーソルは対象外。純関数だけ。
 */

/** 選べる太さ（CSS px。小さい順） */
export const TECH_LINE_PX: readonly number[] = [1, 1.25, 1.5, 2, 3];

export interface TechLineWidths {
  /** EMA の 3 本（px） */
  ema: number;
  /** 指標の段の線（px） */
  pane: number;
}

export type TechLineKey = keyof TechLineWidths;

/** 既定（EMA 1 px = #214 の 3 本同じ太さ、段 1.25 px = #200 のまま） */
export const DEFAULT_TECH_LINE_WIDTHS: TechLineWidths = { ema: 1, pane: 1.25 };

export const isTechLinePx = (v: unknown): v is number =>
  typeof v === 'number' && TECH_LINE_PX.includes(v);

/** 欠けた・不正な項目を既定で埋める */
export function techLineWidthsOr(w: Partial<TechLineWidths> | undefined): TechLineWidths {
  return {
    ema: isTechLinePx(w?.ema) ? w.ema : DEFAULT_TECH_LINE_WIDTHS.ema,
    pane: isTechLinePx(w?.pane) ? w.pane : DEFAULT_TECH_LINE_WIDTHS.pane,
  };
}

/** 表示の文字（「1 px」「1.25 px」） */
export const techLinePxText = (px: number): string => `${px} px`;

/** 設定の選択肢（value は select の文字） */
export const TECH_LINE_PX_OPTIONS: readonly { value: string; text: string }[] = TECH_LINE_PX.map(
  (px) => ({ value: String(px), text: techLinePxText(px) }),
);

/** select の文字 → px（選択肢に無ければ null） */
export function techLinePxOf(text: string): number | null {
  const v = Number(text);
  return isTechLinePx(v) ? v : null;
}

/** 設定の 2 行（並び・見出し） */
export const TECH_LINE_FIELDS: readonly { key: TechLineKey; label: string; aria: string }[] = [
  { key: 'ema', label: 'EMA の線', aria: 'EMA の線の太さ' },
  { key: 'pane', label: '段の線', aria: '指標の段の線の太さ' },
];

/**
 * 公開前の作業中の版の段（tech_line_width = thin / normal / thick）を px に読み替える（細い → 1、普通 → 既定、太い → 2。
 * EMA と段の両方）。知らない値 → null（= 既定）
 */
export function legacyStepWidths(step: unknown): TechLineWidths | null {
  if (step === 'thin') return { ema: 1, pane: 1 };
  if (step === 'normal') return { ...DEFAULT_TECH_LINE_WIDTHS };
  if (step === 'thick') return { ema: 2, pane: 2 };
  return null;
}

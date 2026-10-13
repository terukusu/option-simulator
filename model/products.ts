/**
 * 商品の定義（乗数・呼値）。設計 docs/design.md 3 章・3.1。
 * 確認日: 2026-10-13（JPX の制度概要ページ）。制度が変わったらここだけ直す。
 */

export type OptionProduct = 'op_large';
export type FutureProduct = 'fut_large' | 'fut_mini' | 'fut_micro';
export type Product = OptionProduct | FutureProduct;

export const PRODUCT_SPEC_CHECKED_AT = '2026-10-13';

export interface ProductSpec {
  /** 乗数（円 / 価格 1 単位） */
  multiplier: number;
  /** 表示名 */
  label: string;
  /** 一次情報で確認できていない項目があれば true（設計 3.1 の「要確認」） */
  unconfirmed?: boolean;
}

export const PRODUCTS: Record<Product, ProductSpec> = {
  op_large: { multiplier: 1000, label: '日経225オプション（ラージ）' },
  fut_large: { multiplier: 1000, label: '日経225先物（ラージ）' },
  fut_mini: { multiplier: 100, label: '日経225mini' },
  // マイクロ先物の限月の設定・呼値は要確認（設計 3.1）
  fut_micro: { multiplier: 10, label: '日経225マイクロ先物', unconfirmed: true },
};

/** デルタの「ラージ換算」の基準乗数 */
export const LARGE_MULTIPLIER = 1000;

/** オプションの呼値: 価格 300 円以下 1 円、300 円超 5 円（ラージ・ミニ共通） */
export const OPTION_TICK_RULE = { threshold: 300, small: 1, large: 5 } as const;

/**
 * 先物の呼値（建値の入力の丸めにだけ使う。設計 5.8）。
 * ラージ 10 円・ミニ 5 円は制度概要ページで確認、マイクロは要確認（ミニと同じ 5 円を仮置き）。
 */
export const FUTURE_TICK: Record<FutureProduct, number> = {
  // 出典: JPX 制度概要ページ（日経225先物・日経225mini）。確認日 2026-10-13
  fut_large: 10,
  fut_mini: 5,
  // 要確認（設計 3.1）: マイクロ先物の呼値は一次情報で未確認。ミニと同じ 5 円を仮置き（2026-10-13 時点）
  fut_micro: 5,
};

/** 呼値が一次情報で確認できていない先物（UI で「要確認」を出すのに使う） */
export const FUTURE_TICK_UNCONFIRMED: ReadonlySet<FutureProduct> = new Set(['fut_micro']);

/** 板の JSON の型（設計 docs/design.md 7.1。検証は chainJson.ts）。 */

/** JSON の版。形を変えたら上げる（file アダプタ・API・fixture で共通） */
export const SCHEMA_VERSION = 1;

export type ChainReason = 'latest' | 'pre_open' | 'after_close' | 'closed';

/** 1 つの行使価格の call か put（optionchan の option_price の 1 行）。欠損は null。 */
export interface ChainSide {
  /** 買い気配（円） */
  bid: number | null;
  /** 売り気配（円） */
  ask: number | null;
  /** bid の IV（%） */
  bid_iv: number | null;
  /** ask の IV（%） */
  ask_iv: number | null;
  /** 約定価格（その立会内。円） */
  price: number | null;
  /** 約定時刻（ISO 8601、オフセット付き） */
  price_time: string | null;
  /** 約定の IV（%。JPX） */
  iv: number | null;
  /** 取引高 */
  volume: number | null;
  /** 建玉残 */
  positions: number | null;
  /** 清算値（円）。任意 */
  quotation: number | null;
  /** 清算値の日付（YYYY-MM-DD）。任意 */
  quotation_date: string | null;
  /** JPX グリーク（約定のあった行だけ。約定時点の値。原資産 1 単位あたり: δ、Γ は 1 円あたり（小数 4 桁に丸め）、Θ は円 / 暦日、V は円 / IV 1pt。設計 5.6・data/jpxGreeks.ts） */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** JPX の ATM 表示（参考。判定には使わない）。任意 */
  is_atm: boolean | null;
}

export interface ChainRow {
  /** 行使価格（円、整数） */
  k: number;
  call: ChainSide;
  put: ChainSide;
}

export interface ChainMonthJson {
  /** 限月（YYYY-MM）。足・市場の ID に使う */
  contract_month: string;
  /** 取引最終日（YYYY-MM-DD） */
  last_trading_day: string;
  /** SQ 日（YYYY-MM-DD。サーバーがカレンダーから入れる） */
  sq_date: string;
  /** 行使価格の昇順（重複なし） */
  rows: ChainRow[];
}

export interface ChainJson {
  schema_version: typeof SCHEMA_VERSION;
  /** スナップショット時刻（ページ時刻。ISO 8601、オフセット付き） */
  snapshot_at: string;
  /** 実時刻からの遅れ（分。JPX のページは約 15 分） */
  delayed_minutes: number;
  /** 使える板の判定の結果（7.2） */
  reason: ChainReason;
  /** データ元の表示用（例 "synthetic"、"bigquery"）。任意 */
  source?: string;
  /** 日経平均（夜間は 15:45 で止まる） */
  spot: { price: number | null; price_time: string | null };
  /** 直近四半期のラージ先物 1 本 */
  future: {
    price: number | null;
    price_time: string | null;
    /** 先物の限月（YYYY-MM） */
    contract_month: string;
    /** 先物の取引最終日・SQ 日（サーバーがカレンダーから入れる） */
    last_trading_day: string;
    sq_date: string;
  };
  /** オプションの限月（SQ 日の昇順。optionchan は直近 2 限月） */
  months: ChainMonthJson[];
}

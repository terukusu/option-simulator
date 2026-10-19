/**
 * 板の JSON の型（設計 docs/design.md 7.1。検証は chainJson.ts）。
 *
 * 供給元に依らない契約（docs/data-sources.md「板の契約」。#154）: 画面が動くのに要るのは気配（bid / ask）・行使価格・
 * 限月の日付・先物と時刻だけ。それ以外（気配の IV・約定・約定 IV・グリーク・取引高・建玉・清算値・ATM の表示・日経平均）は
 * 供給元によって **欠けうる**（全行 null でよい）。欠けうる項目には `欠けうる` と書いた。キーの省略は `任意` の項目だけ。
 */

/** JSON の版。形を変えたら上げる（file アダプタ・API・fixture で共通） */
export const SCHEMA_VERSION = 1;

export type ChainReason = 'latest' | 'pre_open' | 'after_close' | 'closed';

/** 1 つの行使価格の call か put（optionchan なら option_price の 1 行）。欠損は null。 */
export interface ChainSide {
  /** 買い気配（円） */
  bid: number | null;
  /** 売り気配（円） */
  ask: number | null;
  /** bid の IV（%）。欠けうる（板全体で無ければ画面は気配から求める） */
  bid_iv: number | null;
  /** ask の IV（%）。欠けうる */
  ask_iv: number | null;
  /** 約定価格（その立会内。円）。欠けうる */
  price: number | null;
  /** 約定時刻（ISO 8601、オフセット付き）。欠けうる */
  price_time: string | null;
  /** 約定の IV（%。JPX）。欠けうる */
  iv: number | null;
  /** 取引高。欠けうる */
  volume: number | null;
  /** 建玉残。欠けうる */
  positions: number | null;
  /** 清算値（円）。任意・欠けうる */
  quotation: number | null;
  /** 清算値の日付（YYYY-MM-DD）。任意・欠けうる */
  quotation_date: string | null;
  /** JPX グリーク（約定のあった行だけ。約定時点の値。原資産 1 単位あたり: δ、Γ は 1 円あたり（小数 4 桁に丸め）、Θ は円 / 暦日、V は円 / IV 1pt。設計 5.6・data/jpxGreeks.ts）。欠けうる */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** JPX の ATM 表示（参考。判定には使わない）。任意・欠けうる */
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
  /** 実時刻からの遅れ（分。JPX のページは約 15 分。リアルタイムの供給元は 0） */
  delayed_minutes: number;
  /** 使える板の判定の結果（7.2） */
  reason: ChainReason;
  /** データ元の表示用（例 "synthetic"、"bigquery"）。任意 */
  source?: string;
  /** 日経平均（夜間は 15:45 で止まる）。値は欠けうる（キーは必須） */
  spot: { price: number | null; price_time: string | null };
  /** 直近四半期のラージ先物 1 本（価格は null 可だが、無いと F は合成先物だけで決まる） */
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

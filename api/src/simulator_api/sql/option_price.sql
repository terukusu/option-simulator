-- 1 スナップショットの板: [@start_at, @end_at) = [snapshot_at, snapshot_at + 1 秒)。
-- option_price は created_at の UTC 日パーティション（require_partition_filter）。テーブル関数が created_at で絞る。
-- 列は contract.py の option_price と同じ順（4.1 の 20 列）
SELECT
  type, target_price, last_trading_day,
  bid, ask, bid_iv, ask_iv,
  price, price_time, iv,
  delta, gamma, theta, vega,
  quotation, quotation_date, volume, positions, is_atm,
  created_at
FROM `${project}.${dataset}.option_price_latest`(@start_at, @end_at)
ORDER BY last_trading_day, target_price, type

-- 1 スナップショットの先物（ラージの直近四半期限月 1 本）: [snapshot_at, snapshot_at + 1 秒)。
-- 列は contract.py の future_price と同じ順
SELECT price, price_time, contract_month
FROM `${project}.${dataset}.future_price_latest`(@start_at, @end_at)

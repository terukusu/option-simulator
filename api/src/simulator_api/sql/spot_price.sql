-- 1 スナップショットの日経平均: [snapshot_at, snapshot_at + 1 秒)。列は contract.py の spot_price と同じ順
SELECT price, price_time
FROM `${project}.${dataset}.spot_price_latest`(@start_at, @end_at)

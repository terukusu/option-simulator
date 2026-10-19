-- /api/future_bars（#190）: 先物（ラージの直近四半期限月 1 本。15 分遅れの現在値）のスナップショットを @step 秒（60 / 3600）の足に束ねる。
-- テーブル関数 future_price_latest(@start_at, @end_at) は created_at の範囲の全スナップショット（スナップショットごとに最新の完了した
-- 実行の行）を返す。読む列は contract.py の future_bars と同じ 4 列だけ。CURRENT_TIMESTAMP を使わない（同じパラメータの結果を
-- BigQuery の結果キャッシュで返せるように）。
-- 足は price_time（JST の約定の分。DATETIME）で切る: 立会の外で値が止まった行は前の足に入り、新しい足を作らない。
-- open / close = (traded_at, created_at) の順で最初 / 最後、high / low = 最大 / 最小（1 分ごとの現在値の高安。約定の高安ではない）。
-- price が NULL / 0 以下・price_time が NULL の行は捨てる。last_at = 足に入った行の created_at の最大。
-- contract_month は生の値の最大（ログの照合だけ。限月はアプリが取引カレンダーから求める）。
-- 列は contract.py の OUTPUTS の future_bars と同じ順
WITH points AS (
  SELECT created_at, price, price_time, contract_month
  FROM `${project}.${dataset}.future_price_latest`(@start_at, @end_at)
  WHERE price > 0 AND price_time IS NOT NULL
),
traded AS (
  SELECT created_at, price, contract_month, TIMESTAMP(price_time, 'Asia/Tokyo') AS traded_at
  FROM points
)
SELECT
  TIMESTAMP_SECONDS(UNIX_SECONDS(traded_at) - MOD(UNIX_SECONDS(traded_at), @step)) AS started_at,
  ARRAY_AGG(price ORDER BY traded_at, created_at LIMIT 1)[OFFSET(0)] AS open,
  MAX(price) AS high,
  MIN(price) AS low,
  ARRAY_AGG(price ORDER BY traded_at DESC, created_at DESC LIMIT 1)[OFFSET(0)] AS close,
  MAX(created_at) AS last_at,
  MAX(contract_month) AS contract_month
FROM traded
GROUP BY started_at
ORDER BY started_at

-- /api/atm_iv（#79）: 30 日固定の ATM IV（表 atm_cm_iv の iv30。%）の [@start_at, @end_at) を @step 秒（60 / 3600）の足に束ねる。
-- 表は月パーティション（created_at）で requirePartitionFilter が無いので、created_at の半開区間の絞りを必ず書く
-- （tests/test_atm_iv.py の静的検査）。読む列は contract.py の atm_cm_iv と同じ 2 列だけ。CURRENT_TIMESTAMP を使わない
-- （同じパラメータの結果を BigQuery の結果キャッシュで返せるように）。
-- 足の区間は UNIX 秒で切る（JST の正分・正時）。open / close = 時間順で最初 / 最後の NULL でない値、high / low = 最大 / 最小。
-- iv30 が全部 NULL の足も行を返し（high が NULL）、last_at（NULL の行を含めた最後の created_at）を取ってからアプリが捨てる。
-- 列は contract.py の OUTPUTS の atm_cm_iv と同じ順
WITH points AS (
  SELECT created_at, iv30
  FROM `${project}.${dataset}.atm_cm_iv`
  WHERE created_at >= @start_at AND created_at < @end_at
)
SELECT
  TIMESTAMP_SECONDS(UNIX_SECONDS(created_at) - MOD(UNIX_SECONDS(created_at), @step)) AS started_at,
  ARRAY_AGG(iv30 IGNORE NULLS ORDER BY created_at LIMIT 1)[SAFE_OFFSET(0)] AS open,
  MAX(iv30) AS high,
  MIN(iv30) AS low,
  ARRAY_AGG(iv30 IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS close,
  MAX(created_at) AS last_at
FROM points
GROUP BY started_at
ORDER BY started_at

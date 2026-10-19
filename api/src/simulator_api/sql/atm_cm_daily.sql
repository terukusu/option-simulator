-- /api/atm_daily（#152）: 表 atm_cm_iv の JST の日付ごとの日中の終値 = JST 9:00〜15:00（両端含む）の行のうち iv30・
-- m1_forward・m1_last_trading_day が NULL でない最後の行（iv30 は %、フォワードは 1 / 2 限月の F）。範囲は [@start_at, @end_at)。
-- 表は月パーティション（created_at）で requirePartitionFilter が無いので、created_at の半開区間の絞りを必ず書く
-- （tests/test_atm_daily.py の静的検査）。読む列は contract.py の atm_cm_daily と同じ 6 列だけ。CURRENT_TIMESTAMP を使わない。
-- 窓の時刻は settings.ATM_DAILY_CLOSE_WINDOW と同じ（静的検査が照合する）。列は contract.py の OUTPUTS の atm_cm_daily と同じ順
WITH points AS (
  SELECT created_at, iv30, m1_last_trading_day, m1_forward, m2_last_trading_day, m2_forward
  FROM `${project}.${dataset}.atm_cm_iv`
  WHERE created_at >= @start_at AND created_at < @end_at
),
closes AS (
  SELECT
    DATE(created_at, 'Asia/Tokyo') AS day,
    ARRAY_AGG(
      STRUCT(created_at, iv30, m1_last_trading_day, m1_forward, m2_last_trading_day, m2_forward)
      ORDER BY created_at DESC LIMIT 1
    )[OFFSET(0)] AS last
  FROM points
  WHERE TIME(created_at, 'Asia/Tokyo') BETWEEN TIME '09:00:00' AND TIME '15:00:00'
    AND iv30 IS NOT NULL AND m1_forward IS NOT NULL AND m1_last_trading_day IS NOT NULL
  GROUP BY day
)
SELECT
  day,
  last.created_at AS close_at,
  last.iv30 AS iv30,
  last.m1_last_trading_day AS m1_last_trading_day,
  last.m1_forward AS m1_forward,
  last.m2_last_trading_day AS m2_last_trading_day,
  last.m2_forward AS m2_forward
FROM closes
ORDER BY day

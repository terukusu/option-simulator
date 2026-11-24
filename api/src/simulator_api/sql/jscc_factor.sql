-- /api/jscc_factors（#387）: 基準日 @d の、optionchan が jscc_var_scenario から当てはめた限月ごとの r（先物の対数リターン）・
-- g（標準化 moneyness の 13 節点の IV の対数変化）。表は business_date の日パーティション（require_partition_filter）で
-- 1 日 約 6 MB（最小課金 10 MiB）なので 1 日の全限月を 1 回読み、アプリが (日, run_id) でキャッシュする。
-- 週次（NK225W*・NK225C*）は読まない。列は contract.py の jscc_factor と同じ 9 列だけ（check_* = 推定の質、forward = 基準日の
-- F = 急変の係数の x。#395）
SELECT jscc_run_id, product_code, contract_period_code, forward, nodes, r, g, check_median_rel, check_p90_rel
FROM `${project}.${dataset}.jscc_var_scenario_factor`
WHERE business_date = @d
  AND file_version = '1600'
  AND product_code IN ('NK225E', 'NK225F', 'NK225MF', 'NK225MCF')

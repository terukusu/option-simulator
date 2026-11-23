-- /api/jscc_scenarios（#382）: 基準日 @d の 1 限月（@cp = YYYYMM の整数）の日経225 OP（NK225E）と先物 3 商品の全銘柄の
-- シナリオの値。表は require_partition_filter（business_date の日パーティション）で、1 日のパーティションは約 131 MiB。
-- クラスタ（product_code・contract_period_code・put_call_type・strike_price）の絞りはこの大きさでは課金を減らさない
-- （1 銘柄の等号でも 1 日分）ので、限月ごとに全行を読んでアプリが (日, run_id, 限月) でキャッシュする。週次（NK225W*・
-- NK225C*・YYYYMMW）は読まない。pnl は 1 枚あたりの円（contract_size を掛けない）。
-- 列は contract.py の jscc_scenario と同じ 10 列だけ
SELECT jscc_run_id, product_code, contract_type, put_call_type, contract_period_code, strike_price, contract_size, aggregation_group, price, pnl
FROM `${project}.${dataset}.jscc_var_scenario`
WHERE business_date = @d
  AND file_version = '1600'
  AND product_code IN ('NK225E', 'NK225F', 'NK225MF', 'NK225MCF')
  AND contract_period_code = FORMAT('%d', @cp)

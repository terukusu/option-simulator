-- /api/jscc_scenarios（#382）: 基準日 @d の VaRParameter のレコード 0（集計グループごとの信頼水準・ストレスの本数）のうち
-- 日経225 の集計グループ IDX_IDX（settings.JSCC_AGGREGATION_GROUP。tests/test_jscc.py が一致を見る）の行。
-- 列は contract.py の jscc_parameter と同じ 5 列だけ
SELECT jscc_run_id, aggregation_group, record_id, confidence_level, stress_scenario_number
FROM `${project}.${dataset}.jscc_var_parameter`
WHERE business_date = @d
  AND file_version = '1600'
  AND record_id = 0
  AND aggregation_group = 'IDX_IDX'

-- /api/jscc_factors（#387）: @d0〜@d の当て直しの表の、日・限月ごとの推定の質（配列の列を読まない = 小さい）。アプリが
-- 要求の限月がそろい、OP の行の check_median_rel が閾値以下の最も新しい日を選ぶ（その日の全行は jscc_factor で読む）。
-- 週次は読まない。列は contract.py の jscc_factor_quality と同じ 5 列だけ
SELECT business_date, jscc_run_id, product_code, contract_period_code, check_median_rel
FROM `${project}.${dataset}.jscc_var_scenario_factor`
WHERE business_date BETWEEN @d0 AND @d
  AND file_version = '1600'
  AND product_code IN ('NK225E', 'NK225F', 'NK225MF', 'NK225MCF')

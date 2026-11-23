-- /api/jscc_scenarios（#382）: 基準日 @d のシナリオの並び（1 日 1 行。scenarios の 0 始まりの添字 = jscc_var_scenario.pnl の
-- 添字。H が先・S が後。日ごとに並びが変わりうる = 同じ日の行を使う）。jscc_run_id はアプリが取り込みの記録と照らす。
-- 列は contract.py の jscc_scenario_set と同じ 2 列だけ
SELECT jscc_run_id, scenarios
FROM `${project}.${dataset}.jscc_var_scenario_set`
WHERE business_date = @d
  AND file_version = '1600'

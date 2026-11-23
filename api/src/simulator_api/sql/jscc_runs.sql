-- /api/jscc_scenarios（#382）: 基準日 @d の JSCC の取り込みの記録（1 日に複数行ありうる。追記のみ）。アプリが
-- status = 'succeeded' の最新の finished_at の jscc_run_id を選ぶ（失敗した日は表の間で中身がずれうるので使わない）。
-- business_date の等号でパーティションを 1 個に。値はすべてクエリパラメータ（CURRENT_* を使わない = 結果キャッシュが効く）。
-- 列は contract.py の jscc_runs と同じ 3 列だけ（SELECT * を使わない）
SELECT jscc_run_id, status, finished_at
FROM `${project}.${dataset}.jscc_ingest_runs`
WHERE business_date = @d
  AND file_version = '1600'

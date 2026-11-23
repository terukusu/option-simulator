-- /api/jscc_factors（#387）: 基準日 @d から @d0 まで（遡る範囲。settings.JSCC_FACTOR_RANGE_DAYS 暦日）の JSCC の取り込みの記録。
-- アプリが日ごとに status = 'succeeded' の最新の finished_at の jscc_run_id を選び、新しい日から
-- JSCC_FACTOR_MAX_BACK 営業日（succeeded のある日）まで、使える当て直しの表のある日を探す。値はクエリパラメータだけ。
-- 列は contract.py の jscc_runs_range と同じ 4 列だけ
SELECT business_date, jscc_run_id, status, finished_at
FROM `${project}.${dataset}.jscc_ingest_runs`
WHERE business_date BETWEEN @d0 AND @d
  AND file_version = '1600'

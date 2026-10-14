-- /api/chain の候補: [@start_at, @end_at)（アプリが now − 14 日〜now + 1 秒を渡す）のスナップショットごとに最新の完了した実行。
-- 新しい順。列は contract.py の latest_runs と同じ順
SELECT snapshot_at, rows_option, finished_at
FROM `${project}.${dataset}.latest_runs`(@start_at, @end_at)
ORDER BY snapshot_at DESC

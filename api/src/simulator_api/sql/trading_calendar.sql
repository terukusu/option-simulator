-- 取引カレンダーの最新版（ビュー。版の全行）。日付の昇順。列は contract.py の trading_calendar と同じ順
SELECT version_at, calendar_date, is_trading_day, status, name, covered_until, listed_until
FROM `${project}.${dataset}.trading_calendar_latest`
ORDER BY calendar_date

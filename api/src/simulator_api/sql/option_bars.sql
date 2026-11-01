-- /api/option_bars（#319）: 1 銘柄（限月 × 行使価格 × put / call）の 1 時間足を表 option_price_hourly から読む。
-- 表は optionchan が全銘柄の毎分の行を 1 時間足に束ねたもの（パーティション = last_trading_day の月、クラスタ =
-- target_price, type, started_at）。last_trading_day の等号でパーティションを 1 個に、target_price・type の等号で
-- クラスタを絞り、started_at を半開区間 [@start_at, @end_at) で読む（銘柄の一生。アプリが決める）。
-- 値はすべてクエリパラメータ。CURRENT_TIMESTAMP を使わない（同じパラメータの結果を BigQuery の結果キャッシュで返せる
-- ように）。列は contract.py の option_bars と同じ 12 列だけ（SELECT * を使わない）
SELECT started_at, mid_open, mid_high, mid_low, mid_close, bid_close, ask_close, bid_iv_close, ask_iv_close, trade_close, iv_close, last_at
FROM `${project}.${dataset}.option_price_hourly`
WHERE last_trading_day = @ltd
  AND target_price = @k
  AND type = @type
  AND started_at >= @start_at
  AND started_at < @end_at
ORDER BY started_at

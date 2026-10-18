"""API の SQL を BigQuery で dry run する検査（AC-4・AC-8 の手元分。課金 0）。

CI では動かさない（BigQuery の認証が要る）。手元で（ADC。gcloud の構成は CLOUDSDK_ACTIVE_CONFIG_NAME 等で渡す）:
    OPTIONCHAN_BQ_TEST=1 OPTIONCHAN_BQ_PROJECT=<PROJECT_ID> uv run --locked pytest -q tests/test_sql_bq.py
データセットは OPTIONCHAN_BQ_DATASET（既定 optionchan_tokyo）、ロケーションは OPTIONCHAN_BQ_LOCATION。

- 実際の runner と同じ SQL・パラメータの型で dry_run=True・use_query_cache=False のジョブを作る
- 見積もり（total_bytes_processed）が 512 MiB 以下（atm_cm_iv は 64 MiB 以下。値は -s で表示。PR に記録する）
- 結果の列名・型が contract.py の宣言（集計するクエリは OUTPUTS）と一致（dry run の job.schema）
- atm_cm_iv（#79 AC6）は足ごとの最大の範囲（1m 3 日・1h 100 日・1d 400 日 + 読み足しの 11 日）でも見る
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from simulator_api import atm_iv, bq, contract
from simulator_api import settings as st

PROJECT = os.environ.get("OPTIONCHAN_BQ_PROJECT", "")
DATASET = os.environ.get("OPTIONCHAN_BQ_DATASET", "optionchan_tokyo")
LOCATION = os.environ.get("OPTIONCHAN_BQ_LOCATION", "asia-northeast1")

pytestmark = pytest.mark.skipif(
    os.environ.get("OPTIONCHAN_BQ_TEST") != "1" or not PROJECT,
    reason="OPTIONCHAN_BQ_TEST=1 と OPTIONCHAN_BQ_PROJECT のときだけ",
)

MiB = 1024**2


@pytest.fixture(scope="module")
def runner():
    cfg = st.Settings(project=PROJECT, dataset=DATASET, location=LOCATION)
    return bq.BigQueryRunner(cfg)


def params(name, now):
    if name == "trading_calendar":
        return {}
    if name == "atm_cm_iv":
        return atm_iv_params("1h", now)
    if name == "latest_runs":
        return {"start_at": now - timedelta(days=st.SEARCH_DAYS), "end_at": now + timedelta(seconds=1)}
    # 1 秒の窓。日中の後半（UTC の日の終わりに近い時刻 = 同じパーティションに日中 + 夜間 + 翌朝が入る）を見る。
    # 当日（書き込み中）のパーティションは dry run の見積もりが小さく出るので前日にする
    at = (now - timedelta(days=1)).replace(hour=6, minute=40, second=0, microsecond=0)  # JST 15:40
    return {"start_at": at, "end_at": at + timedelta(seconds=1)}


def atm_iv_params(tf, now):
    """右端の end（明日の UTC の 0 時）から足ごとの最大の日数（1d は読み足し込み）"""
    _, max_days, _ = st.ATM_IV_TIMEFRAMES[tf]
    end = atm_iv.right_edge(now)
    req = atm_iv.AtmIvRequest(tf, end - timedelta(days=max_days), end)
    start_at, end_at, step = atm_iv.read_window(req, now)
    return {"start_at": start_at, "end_at": end_at, "step": step}


def dry_run(runner, name, query_params, label, record_property):
    from google.cloud import bigquery

    cfg = runner.job_config(name, query_params)
    cfg.dry_run = True
    cfg.use_query_cache = False
    assert isinstance(cfg, bigquery.QueryJobConfig)
    job = runner.client.query(runner.sql[name], job_config=cfg, location=LOCATION)
    nbytes = job.total_bytes_processed
    record_property("bytes", nbytes)
    print(f"dry run {label}: {nbytes} bytes ({nbytes / MiB:.2f} MiB)")
    assert nbytes <= runner.maximum_bytes_billed(name) <= st.MAX_BYTES_BILLED_LIMIT
    schema = [(f.name, f.field_type) for f in (job.schema or [])]
    assert schema, f"{name}: dry run の結果の列が取れない"
    assert schema == list(contract.output_columns(name))


@pytest.mark.parametrize("name", contract.QUERY_NAMES)
def test_dry_run(runner, name, record_property):
    now = datetime.now(UTC).replace(microsecond=0)
    dry_run(runner, name, params(name, now), name, record_property)


@pytest.mark.parametrize("tf", tuple(st.ATM_IV_TIMEFRAMES))
def test_atm_cm_iv_max_range_dry_run(runner, tf, record_property):
    now = datetime.now(UTC).replace(microsecond=0)
    p = atm_iv_params(tf, now)
    days = (p["end_at"] - p["start_at"]).days
    dry_run(runner, "atm_cm_iv", p, f"atm_cm_iv {tf} {days} 日", record_property)
    assert runner.maximum_bytes_billed("atm_cm_iv") == 64 * MiB

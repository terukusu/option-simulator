"""BigQuery の実行（AC-4 の maximum_bytes_billed、AC-5 のパラメータ化、#95 の query_and_wait・起動時の準備）。
クライアントは偽物。"""

import json
import threading
import time
from datetime import UTC, date, datetime, timedelta

import pytest

from simulator_api import bq, contract
from simulator_api import settings as st
from simulator_api.service import ChainService

CFG = st.Settings(project="example-project", dataset="example_dataset", location="asia-northeast1")


class FakeRows:
    """query_and_wait の戻り値（RowIterator）の偽物"""

    total_bytes_processed = 1234

    def __init__(self, rows):
        self.rows = rows

    def __iter__(self):
        return iter([FakeRow(r) for r in self.rows])


class FakeRow:
    def __init__(self, d):
        self.d = d

    def items(self):
        return self.d.items()


class FakeClient:
    """query（jobs.insert + result）は持たない（旧経路を使ったら AttributeError）"""

    def __init__(self, rows=()):
        self.queries = []
        self.rows = list(rows)

    def query_and_wait(self, sql, *, job_config=None, location=None, wait_timeout=None, api_timeout=None):
        q = {"sql": sql, "job_config": job_config, "location": location}
        q.update(wait_timeout=wait_timeout, api_timeout=api_timeout)
        self.queries.append(q)
        return FakeRows(self.rows)


def test_all_sql_loaded_with_identifiers_only():
    runner = bq.BigQueryRunner(CFG, client=FakeClient())
    assert set(runner.sql) == set(contract.QUERY_NAMES)
    for name, sql in runner.sql.items():
        assert "${" not in sql, name
        assert f"`example-project.example_dataset.{contract.RELATIONS[name].name}`" in sql


def test_unknown_placeholder_rejected(monkeypatch):
    class Files:
        def joinpath(self, *a):
            return self

        def read_text(self, encoding):
            return "SELECT 1 FROM `${project}.${other}.t`"

    monkeypatch.setattr(bq.resources, "files", lambda _pkg: Files())
    with pytest.raises(ValueError):
        bq.load_sql("x", CFG)


def test_job_config_has_limits_and_parameters(capsys):
    client = FakeClient([{"snapshot_at": datetime(2026, 10, 13, 12, 31, tzinfo=UTC)}])
    runner = bq.BigQueryRunner(CFG, client=client)
    start = datetime(2026, 9, 29, 12, 46, 7, tzinfo=UTC)
    end = datetime(2026, 10, 13, 12, 46, 8, tzinfo=UTC)
    rows = runner("latest_runs", {"start_at": start, "end_at": end})
    assert rows == [{"snapshot_at": datetime(2026, 10, 13, 12, 31, tzinfo=UTC)}]
    q = client.queries[0]
    sql, cfg = q["sql"], q["job_config"]
    assert q["location"] == "asia-northeast1"
    assert q["wait_timeout"] == st.JOB_TIMEOUT_SECONDS == 20
    assert cfg.maximum_bytes_billed == 536870912
    assert cfg.use_legacy_sql is False
    assert int(cfg.job_timeout_ms) == st.JOB_TIMEOUT_SECONDS * 1000
    params = {p.name: (p.type_, p.value) for p in cfg.query_parameters}
    assert params == {"start_at": ("TIMESTAMP", start), "end_at": ("TIMESTAMP", end)}
    # 時刻の値が SQL に文字列として入らない（AC-5）
    for text in ("2026", "12:46", start.isoformat(), str(start)):
        assert text not in sql
    assert "@start_at" in sql and "@end_at" in sql
    rec = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert rec["event"] == "bq_job" and rec["name"] == "latest_runs"
    assert rec["total_bytes_processed"] == 1234 and rec["rows"] == 1 and isinstance(rec["elapsed_ms"], int)
    # query_and_wait の結果は課金量・キャッシュの有無を持たない（課金量の監視は監査ログ）
    assert "total_bytes_billed" not in rec and "cache_hit" not in rec
    assert "sql" not in rec and "2026" not in json.dumps(rec)


def test_every_job_has_maximum_bytes_billed():
    cfg = st.Settings(project="example-project", maximum_bytes_billed=1048576)
    client = FakeClient()
    runner = bq.BigQueryRunner(cfg, client=client)
    t = datetime(2026, 10, 13, tzinfo=UTC)
    for name in contract.QUERY_NAMES:
        params = {} if name == "trading_calendar" else {"start_at": t, "end_at": t + timedelta(seconds=1)}
        if name == "atm_cm_iv":
            params["step"] = 3600
        runner(name, params)
    assert len(client.queries) == len(contract.QUERY_NAMES)
    assert all(q["job_config"].maximum_bytes_billed == 1048576 for q in client.queries)
    assert all(q["wait_timeout"] == st.JOB_TIMEOUT_SECONDS for q in client.queries)


def test_param_types():
    assert bq.param_type(datetime(2026, 1, 1, tzinfo=UTC)) == "TIMESTAMP"
    assert bq.param_type(date(2026, 1, 1)) == "DATE"
    assert bq.param_type(3) == "INT64"
    for bad in (True, "2026-01-01", 1.5, datetime(2026, 1, 1)):
        with pytest.raises(TypeError):
            bq.param_type(bad)


def test_service_passes_only_timestamp_parameters():
    # サービスが runner に渡す値はすべて aware な datetime（SQL に値を埋めない）
    from support import Clock, FakeRunner, World, load_fixture

    w = World()
    snap = w.add_fixture(load_fixture("latest"))
    clock = Clock(snap + timedelta(minutes=15))
    runner = FakeRunner(w)
    ChainService(runner, clock, monotonic=clock.monotonic).chain()
    for _name, params in runner.calls:
        for v in params.values():
            assert isinstance(v, datetime) and v.tzinfo is not None
            bq.param_type(v)


def test_client_is_created_once_under_concurrency(monkeypatch):
    created = []

    def new_client(self):
        time.sleep(0.05)  # 生成中に他のスレッドが来るように
        created.append(1)
        return FakeClient()

    monkeypatch.setattr(bq.BigQueryRunner, "_new_client", new_client)
    runner = bq.BigQueryRunner(CFG)
    barrier = threading.Barrier(8)
    got = []

    def work():
        barrier.wait()
        got.append(runner.client)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(created) == 1
    assert len(got) == 8 and all(c is got[0] for c in got)


def test_warm_does_not_run_jobs(monkeypatch, capsys):
    fake = FakeClient()
    monkeypatch.setattr(bq.BigQueryRunner, "_new_client", lambda self: fake)
    runner = bq.BigQueryRunner(CFG)
    thread = runner.start_warm()
    assert thread.daemon
    thread.join(10)
    assert runner._client is fake and fake.queries == []
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [r["event"] for r in recs] == ["bq_warm"]
    assert recs[0]["severity"] == "INFO" and isinstance(recs[0]["elapsed_ms"], int)


def test_warm_failure_is_logged_and_retried(monkeypatch, capsys):
    def broken(self):
        raise RuntimeError("secret detail")

    monkeypatch.setattr(bq.BigQueryRunner, "_new_client", broken)
    runner = bq.BigQueryRunner(CFG)
    runner.warm()  # 例外を外に出さない
    out = capsys.readouterr().out
    recs = [json.loads(line) for line in out.splitlines()]
    assert [r["event"] for r in recs] == ["bq_warm_failed"]
    assert recs[0]["severity"] == "WARNING" and recs[0]["error_type"] == "RuntimeError"
    assert "secret detail" not in out
    assert runner._client is None
    # 最初の要求で作り直す
    fake = FakeClient()
    monkeypatch.setattr(bq.BigQueryRunner, "_new_client", lambda self: fake)
    runner("trading_calendar", {})
    assert len(fake.queries) == 1


def test_concurrent_calls_fit_connection_pool():
    # 同時に走る呼び出しは requests の接続プール（既定 10）以内（超えると urllib3 が "Connection pool is full"）
    from requests.adapters import DEFAULT_POOLSIZE

    assert st.BQ_CONCURRENCY == DEFAULT_POOLSIZE

    class SlowClient(FakeClient):
        def __init__(self):
            super().__init__()
            self.lock = threading.Lock()
            self.running = self.peak = 0
            self.release = threading.Event()

        def query_and_wait(self, sql, **kw):
            with self.lock:
                self.running += 1
                self.peak = max(self.peak, self.running)
            self.release.wait(5)
            with self.lock:
                self.running -= 1
            return super().query_and_wait(sql, **kw)

    client = SlowClient()
    runner = bq.BigQueryRunner(CFG, client=client)
    n = st.BQ_CONCURRENCY + 2  # 要求のスレッド 8 + 候補内の並列 4
    threads = [threading.Thread(target=runner, args=("trading_calendar", {})) for _ in range(n)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + 5
    while client.peak < st.BQ_CONCURRENCY and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.1)
    assert client.peak == st.BQ_CONCURRENCY
    client.release.set()
    for t in threads:
        t.join(10)
    assert len(client.queries) == n


def test_atm_cm_iv_job_has_64mib_cap():
    # #79 AC2・判断 6: atm_cm_iv は min(MAX_BYTES_BILLED, 64 MiB)。他のクエリは設定の値のまま。パラメータは
    # TIMESTAMP・INT64 の ScalarQueryParameter
    from google.cloud import bigquery

    client = FakeClient()
    runner = bq.BigQueryRunner(CFG, client=client)
    start = datetime(2026, 9, 1, tzinfo=UTC)
    end = datetime(2026, 10, 1, tzinfo=UTC)
    runner("atm_cm_iv", {"start_at": start, "end_at": end, "step": 3600})
    runner("trading_calendar", {})
    cfg = client.queries[0]["job_config"]
    assert cfg.maximum_bytes_billed == 64 * 1024**2 == st.QUERY_MAX_BYTES_BILLED["atm_cm_iv"]
    assert client.queries[1]["job_config"].maximum_bytes_billed == st.MAX_BYTES_BILLED_LIMIT
    assert all(isinstance(p, bigquery.ScalarQueryParameter) for p in cfg.query_parameters)
    params = {p.name: (p.type_, p.value) for p in cfg.query_parameters}
    assert params == {"start_at": ("TIMESTAMP", start), "end_at": ("TIMESTAMP", end), "step": ("INT64", 3600)}
    sql = "\n".join(line for line in client.queries[0]["sql"].splitlines() if not line.lstrip().startswith("--"))
    assert "`example-project.example_dataset.atm_cm_iv`" in sql and "2026" not in sql and "3600" not in sql
    # 設定の上限のほうが小さければ設定の値
    small = bq.BigQueryRunner(st.Settings(project="example-project", maximum_bytes_billed=1048576), client=client)
    assert small.job_config("atm_cm_iv", {}).maximum_bytes_billed == 1048576


def test_atm_cm_daily_job_has_128mib_cap():
    # #152 A6: atm_cm_daily は min(MAX_BYTES_BILLED, 128 MiB)。パラメータは TIMESTAMP の start_at・end_at だけ
    from google.cloud import bigquery

    from simulator_api import atm_daily

    client = FakeClient()
    runner = bq.BigQueryRunner(CFG, client=client)
    start, end = atm_daily.read_window(date(2026, 10, 14))
    runner("atm_cm_daily", {"start_at": start, "end_at": end})
    cfg = client.queries[0]["job_config"]
    assert cfg.maximum_bytes_billed == 128 * 1024**2 == st.QUERY_MAX_BYTES_BILLED["atm_cm_daily"]
    assert all(isinstance(p, bigquery.ScalarQueryParameter) for p in cfg.query_parameters)
    params = {p.name: (p.type_, p.value) for p in cfg.query_parameters}
    assert params == {"start_at": ("TIMESTAMP", start), "end_at": ("TIMESTAMP", end)}
    sql = "\n".join(line for line in client.queries[0]["sql"].splitlines() if not line.lstrip().startswith("--"))
    assert "`example-project.example_dataset.atm_cm_iv`" in sql and "2026" not in sql and "2010" not in sql
    small = bq.BigQueryRunner(st.Settings(project="example-project", maximum_bytes_billed=1048576), client=client)
    assert small.job_config("atm_cm_daily", {}).maximum_bytes_billed == 1048576

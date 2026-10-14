"""BigQuery の実行（AC-4 の maximum_bytes_billed、AC-5 のパラメータ化）。クライアントは偽物。"""

import json
from datetime import UTC, date, datetime, timedelta

import pytest

from simulator_api import bq, contract
from simulator_api import settings as st
from simulator_api.service import ChainService

CFG = st.Settings(project="example-project", dataset="example_dataset", location="asia-northeast1")


class FakeJob:
    total_bytes_billed = 10485760
    total_bytes_processed = 1234
    cache_hit = False

    def __init__(self, rows):
        self.rows = rows
        self.timeout = None

    def result(self, timeout=None):
        self.timeout = timeout
        return [FakeRow(r) for r in self.rows]


class FakeRow:
    def __init__(self, d):
        self.d = d

    def items(self):
        return self.d.items()


class FakeClient:
    def __init__(self, rows=()):
        self.queries = []
        self.rows = list(rows)

    def query(self, sql, job_config=None, location=None):
        self.queries.append((sql, job_config, location))
        return FakeJob(self.rows)


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
    sql, cfg, location = client.queries[0]
    assert location == "asia-northeast1"
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
    assert rec["total_bytes_billed"] == 10485760 and rec["total_bytes_processed"] == 1234
    assert "sql" not in rec and "2026" not in json.dumps(rec)


def test_every_job_has_maximum_bytes_billed():
    cfg = st.Settings(project="example-project", maximum_bytes_billed=1048576)
    client = FakeClient()
    runner = bq.BigQueryRunner(cfg, client=client)
    t = datetime(2026, 10, 13, tzinfo=UTC)
    for name in contract.QUERY_NAMES:
        runner(name, {} if name == "trading_calendar" else {"start_at": t, "end_at": t + timedelta(seconds=1)})
    assert len(client.queries) == len(contract.QUERY_NAMES)
    assert all(c.maximum_bytes_billed == 1048576 for _, c, _ in client.queries)


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

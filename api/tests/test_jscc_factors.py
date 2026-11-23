"""/api/jscc_factors（当て直しの r・g、#387 AC4）: SQL の静的検査・要求の検証・行 → 応答（純関数）と、サービスの
キャッシュ・single-flight・run_id の照合・アプリの応答（Cache-Control・400・no_source・503）。偽の runner・時計。
値はすべて架空（種つき乱数の合成の表。support.jscc_factor_world）。"""

import json
import re
import threading
from datetime import date

import pytest
from conftest import PKG_DIR
from support import JSCC_TYPES, Clock, FakeRunner, World, jscc_factor_world, jscc_world, jst
from werkzeug.datastructures import MultiDict

from simulator_api import atm_iv, contract, jscc
from simulator_api import settings as st
from simulator_api.app import create_app
from simulator_api.service import FileChainService, JsccService

D = date(2026, 11, 20)  # 架空の基準日（金曜）
NOW = jst(2026, 11, 24, 10, 0)
CFG = st.Settings(project="example-project")
N = len(JSCC_TYPES)


def sql_text():
    text = (PKG_DIR / "sql" / "jscc_factor.sql").read_text(encoding="utf-8")
    return re.sub(r"\s+", " ", "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--")))


def world(periods=("202612",), futures_only=("202703",), **kw):
    w = World()
    jscc_world(w, D)
    jscc_factor_world(w, D, periods=periods, futures_only=futures_only, **kw)
    return w


def req(*periods, d=D):
    return jscc.FactorRequest(d, tuple(sorted(periods or ("202612",))))


# ---- SQL ----

def test_sql_reads_one_partition_version_and_monthly_products():
    t = sql_text()
    assert "business_date = @d" in t and "file_version = '1600'" in t
    assert "product_code IN ('NK225E', 'NK225F', 'NK225MF', 'NK225MCF')" in t
    assert "jscc_var_scenario_factor" in t
    assert t.startswith("SELECT " + ", ".join(contract.column_names("jscc_factor")) + " FROM")


def test_bytes_billed_cap():
    assert st.QUERY_MAX_BYTES_BILLED["jscc_factor"] == 64 * st.MiB


# ---- 要求 ----

def args(**kw):
    m = MultiDict()
    for k, v in kw.items():
        for x in v if isinstance(v, list) else [v]:
            m.add(k, x)
    return m


def test_parse_ok_sorted():
    r = jscc.parse_factor_request(args(date="2026-11-20", p=["202703", "202612"]), NOW)
    assert r == jscc.FactorRequest(D, ("202612", "202703"))


@pytest.mark.parametrize("ps", [[], ["2026-12"], ["202613"], ["202600"], ["202612", "202612"],
                                [f"2027{m:02d}" for m in range(1, 10)], ["<x>"]])
def test_parse_bad_periods(ps):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_factor_request(args(date="2026-11-20", p=ps), NOW)
    assert e.value.param == "p"


@pytest.mark.parametrize("d", ["2026-11-15", "2026-12-31", "2026-02-30", "x"])
def test_parse_bad_date(d):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_factor_request(args(date=d, p="202612"), NOW)
    assert e.value.param == "date"


# ---- 行 → 応答 ----

def frow(**kw):
    r = {"jscc_run_id": "r", "product_code": "NK225E", "contract_period_code": "202612",
         "nodes": [-5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3], "r": [0.01] * 4, "g": [0.1] * 52}
    r.update(kw)
    return r


def test_factor_day_quantizes_and_keeps_futures_only_rows():
    day = jscc.factor_day("r", [frow(), frow(product_code="NK225F", contract_period_code="202703", nodes=[], g=[]),
                                frow(product_code="NK225W1", contract_period_code="2026121")], 4)
    assert set(day.rows) == {"NK225E-202612", "NK225F-202703"}
    assert day.rows["NK225E-202612"].r.tolist() == [10000] * 4
    assert day.rows["NK225E-202612"].g.tolist() == [1000] * 52
    assert day.rows["NK225F-202703"].g is None
    assert day.nodes == (-5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3)


@pytest.mark.parametrize("bad", [dict(r=[0.01] * 3), dict(r=[2.0] * 4), dict(g=[0.1] * 51), dict(g=[4.0] * 52),
                                 dict(nodes=[0] * 13), dict(r=[float("nan")] * 4), dict(r=["x"] * 4)])
def test_factor_day_drops_bad_rows(bad):
    day = jscc.factor_day("r", [frow(**bad)], 4)
    assert day.rows == {} and day.dropped == 1


@pytest.mark.parametrize("rows", [[frow(jscc_run_id="other")], [frow(), frow()],
                                  [frow(), frow(contract_period_code="202703", nodes=[-6, -4, -3, -2, -1.5, -1, -0.5,
                                                                                       0, 0.5, 1, 1.5, 2, 3])]])
def test_factor_day_inconsistent(rows):
    with pytest.raises(jscc.Inconsistent):
        jscc.factor_day("r", rows, 4)


def test_ok_json_rows_of_requested_periods_and_missing():
    s = jscc.ScenarioSet("r", "HHHS", 97.5, 1)
    day = jscc.factor_day("r", [frow(), frow(product_code="NK225F", contract_period_code="202703", nodes=[], g=[])],
                          4)
    obj = jscc.factors_ok_json(jscc.FactorRequest(D, ("202612", "202703", "202706")), s, day)
    assert obj["scale"] == {"r": 1_000_000, "g": 10_000}
    assert [r["key"] for r in obj["rows"]] == ["NK225E-202612", "NK225F-202703"]
    assert obj["rows"][1]["g"] is None and obj["missing"] == ["202706"]
    assert obj["scenario_types"] == "HHHS" and len(obj["nodes"]) == 13


# ---- サービス ----

def svc(w, clock=None):
    clock = clock or Clock(NOW)
    runner = FakeRunner(w)
    return JsccService(runner, clock, clock.monotonic), runner, clock


def test_service_reads_day_once_and_shares_run_cache():
    s, runner, _ = svc(world())
    p = s.factors(req("202612", "202703"))
    obj = json.loads(p.json_bytes)
    assert p.status == "ok" and {r["key"] for r in obj["rows"]} == {"NK225E-202612", "NK225F-202703"}
    assert all(len(r["r"]) == N for r in obj["rows"])
    assert runner.names() == ["jscc_runs", "jscc_scenario_set", "jscc_parameter", "jscc_factor"]
    runner.reset()
    s.factors(req("202703"))
    assert runner.names() == []
    # /api/jscc_scenarios と取り込みの記録・並びを共用
    assert s.get(jscc.JsccRequest(D, ("NK225E-202612-P-30000",))).status == "ok"
    assert runner.names() == ["jscc_scenario"]


def test_service_empty_table_is_not_ready_and_not_cached():
    w = world(periods=(), futures_only=())
    s, runner, _ = svc(w)
    assert s.factors(req()).reason == "not_ready"
    jscc_factor_world(w, D)
    assert s.factors(req()).status == "ok"


def test_service_other_run_is_inconsistent():
    w = world()
    w.jscc_factors[0]["jscc_run_id"] = "other"
    s, _, _ = svc(w)
    assert s.factors(req()).reason == "inconsistent"


def test_service_no_run_is_not_ready():
    w = World()
    jscc_factor_world(w, D)
    s, _, _ = svc(w)
    assert s.factors(req()).reason == "not_ready"


def test_service_single_flight():
    w = world()
    gate = threading.Event()
    clock = Clock(NOW)
    runner = FakeRunner(w, gates={"jscc_factor": gate})
    s = JsccService(runner, clock, clock.monotonic)
    out = []
    ts = [threading.Thread(target=lambda p=p: out.append(s.factors(req(p)))) for p in ("202612", "202703", "202706")]
    for t in ts:
        t.start()
    runner.started["jscc_factor"].wait(5)
    gate.set()
    for t in ts:
        t.join(5)
    assert len(out) == 3 and all(p.status == "ok" for p in out)
    assert runner.count("jscc_factor") == 1


def test_service_does_not_log_periods(capsys):
    s, _, _ = svc(world())
    s.factors(req("202612"))
    text = "".join(capsys.readouterr())
    assert "jscc_factors_served" in text and "202612" not in text


# ---- アプリ ----

def client(w=None, cfg=CFG):
    clock = Clock(NOW)
    app = create_app(runner=FakeRunner(w or world()), clock=clock, monotonic=clock.monotonic, cfg=cfg,
                     ai_cfg=st.AiSettings())
    return app.test_client()


def test_app_ok_and_cache_control():
    res = client().get("/api/jscc_factors?date=2026-11-20&p=202612", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == f"private, max-age={st.JSCC_MAX_AGE_SECONDS}"
    assert res.headers["Content-Encoding"] == "gzip"


def test_app_not_ready_short_max_age():
    res = client(World()).get("/api/jscc_factors?date=2026-11-20&p=202612")
    assert res.get_json()["reason"] == "not_ready"
    assert res.headers["Cache-Control"] == f"private, max-age={st.JSCC_NOT_READY_MAX_AGE_SECONDS}"


def test_app_bad_request_does_not_reflect():
    res = client().get("/api/jscc_factors?date=2026-11-20&p=<script>")
    assert res.status_code == 400 and res.get_data(as_text=True) == '{"error":"bad_request"}'


def test_app_query_failure_is_503():
    clock = Clock(NOW)
    app = create_app(runner=FakeRunner(world(), errors={"jscc_factor": RuntimeError("secret project 123")}),
                     clock=clock, monotonic=clock.monotonic, cfg=CFG, ai_cfg=st.AiSettings())
    res = app.test_client().get("/api/jscc_factors?date=2026-11-20&p=202612")
    assert res.status_code == 503 and "secret" not in res.get_data(as_text=True)


def test_file_source_is_no_source(tmp_path):
    p = FileChainService(tmp_path / "x.json").jscc_factors(req())
    assert json.loads(p.json_bytes)["reason"] == "no_source"
    cfg = st.Settings(project="example-project", data_source="file", chain_file=tmp_path / "x.json")
    res = client(cfg=cfg).get("/api/jscc_factors?date=2026-11-20&p=202612")
    assert res.status_code == 200 and res.get_json()["reason"] == "no_source"

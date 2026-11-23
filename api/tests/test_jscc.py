"""/api/jscc_scenarios（JSCC の VaR パラメータ、#382 AC3）: SQL の静的検査・要求の検証・行 → 応答（純関数）と、
サービスのキャッシュ・single-flight・run_id の照合・アプリの応答（Cache-Control・400・no_source・503）。
偽の runner・時計。値はすべて架空（種つき乱数の合成の表。support.jscc_world）。"""

import json
import re
import threading
from array import array
from datetime import date, timedelta
from decimal import Decimal

import pytest
from conftest import PKG_DIR
from support import JSCC_TYPES, Clock, FakeRunner, World, jscc_world, jst
from werkzeug.datastructures import MultiDict

from simulator_api import atm_iv, jscc
from simulator_api import settings as st
from simulator_api.app import create_app
from simulator_api.service import ChainService, FileChainService, JsccService

D = date(2026, 11, 20)  # 架空の基準日（金曜）
NOW = jst(2026, 11, 24, 10, 0)
CFG = st.Settings(project="example-project")
K_P = "NK225E-202612-P-30000"
K_C = "NK225E-202612-C-31000"
K_F = "NK225MCF-202612"


def sql_text(name):
    text = (PKG_DIR / "sql" / f"{name}.sql").read_text(encoding="utf-8")
    return re.sub(r"\s+", " ", "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--")))


def req(*keys, d=D):
    return jscc.JsccRequest(d, tuple(sorted(keys or (K_P,))))


def world(**kw):
    w = World()
    jscc_world(w, D, **kw)
    return w


# ---- SQL の静的検査 ----

@pytest.mark.parametrize("name", ["jscc_runs", "jscc_scenario_set", "jscc_parameter", "jscc_scenario"])
def test_sql_filters_one_partition_and_version_by_params(name):
    text = sql_text(name)
    # パーティション列（business_date）の等号はパラメータ、版は 1600 だけ。CURRENT_* を使わない（結果キャッシュ）
    assert "WHERE business_date = @d" in text
    assert f"AND file_version = '{st.JSCC_FILE_VERSION}'" in text
    assert "*" not in text and "CURRENT_" not in text.upper()


def test_sql_scenario_reads_one_period_and_monthly_products_only():
    text = sql_text("jscc_scenario")
    assert "AND contract_period_code = FORMAT('%d', @cp)" in text
    assert "AND product_code IN ('NK225E', 'NK225F', 'NK225MF', 'NK225MCF')" in text
    assert set(re.findall(r"@(\w+)", text)) == {"d", "cp"}
    assert (jscc.OPTION_PRODUCT, *jscc.FUTURE_PRODUCTS) == ("NK225E", "NK225F", "NK225MF", "NK225MCF")


def test_sql_parameter_reads_record0_of_the_group():
    text = sql_text("jscc_parameter")
    assert "AND record_id = 0" in text
    assert f"AND aggregation_group = '{st.JSCC_AGGREGATION_GROUP}'" in text


def test_bytes_billed_caps():
    assert st.QUERY_MAX_BYTES_BILLED["jscc_scenario"] == 256 * st.MiB
    for name in ("jscc_runs", "jscc_scenario_set", "jscc_parameter"):
        assert st.QUERY_MAX_BYTES_BILLED[name] == 64 * st.MiB


# ---- 要求の検証 ----

def args(**kw):
    md = MultiDict()
    md.add("date", kw.pop("date", "2026-11-20"))
    for k in kw.pop("i", [K_P]):
        md.add("i", k)
    for k, v in kw.items():
        md.add(k, v)
    return md


def test_parse_request_ok_sorted_and_periods():
    r = jscc.parse_request(args(i=[K_F, K_P, "NK225E-202703-C-35000"], other="x"), NOW)
    assert r.date == D
    assert r.keys == tuple(sorted([K_F, K_P, "NK225E-202703-C-35000"]))
    assert r.periods == ("202612", "202703")


@pytest.mark.parametrize("bad", [
    {"date": "2026-11-31"}, {"date": "20261120"}, {"date": "2026-11-15"},  # 実在しない・形・始まりより前
    {"date": (NOW.date() + timedelta(days=st.JSCC_MAX_AHEAD_DAYS + 1)).isoformat()},
])
def test_parse_request_bad_date(bad):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_request(args(**bad), NOW)
    assert e.value.param == "date"


@pytest.mark.parametrize("keys", [
    [], [K_P, K_P], ["NK225E-202613-P-30000"], ["NK225E-202612-P-030000"], ["NK225E-202612-X-30000"],
    ["NK225W1-202612-P-30000"], ["NK225F-202612W"], ["nk225f-202612"], ["NK225E-202612-P-12345678"],
    [f"NK225E-202612-P-{30000 + i}" for i in range(st.JSCC_MAX_KEYS + 1)],
    [f"NK225F-2026{m:02d}" for m in range(1, st.JSCC_MAX_PERIODS + 2)],
])
def test_parse_request_bad_keys(keys):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_request(args(i=keys), NOW)
    assert e.value.param == "i"


def test_parse_request_two_dates_is_bad():
    md = args()
    md.add("date", "2026-11-20")
    with pytest.raises(atm_iv.BadRequest):
        jscc.parse_request(md, NOW)


# ---- 純関数 ----

def test_pick_run_latest_succeeded():
    t = jst(2026, 11, 20, 18, 40)
    rows = [{"jscc_run_id": "a", "status": "succeeded", "finished_at": t},
            {"jscc_run_id": "b", "status": "failed", "finished_at": t + timedelta(hours=2)},
            {"jscc_run_id": "c", "status": "succeeded", "finished_at": t + timedelta(hours=1)}]
    assert jscc.pick_run(rows) == "c"
    assert jscc.pick_run([rows[1]]) is None
    assert jscc.pick_run([]) is None


def set_rows(run="r", types=JSCC_TYPES):
    return [{"jscc_run_id": run, "scenarios": [{"scenario_id": "1", "scenario_type": t} for t in types]}]


def param_rows(run="r", conf=97.5, n=2):
    return [{"jscc_run_id": run, "aggregation_group": "IDX_IDX", "record_id": 0, "confidence_level": conf,
             "stress_scenario_number": n}]


def test_scenario_set_ok():
    s = jscc.scenario_set("r", set_rows(), param_rows())
    assert s == jscc.ScenarioSet("r", JSCC_TYPES, 97.5, 2)


@pytest.mark.parametrize("sets,params", [
    (set_rows(run="x"), param_rows()),  # 並びの run_id が違う
    (set_rows(), param_rows(run="x")),  # パラメータの run_id が違う
    (set_rows() * 2, param_rows()),  # 並びが 2 行
    ([], param_rows()),
    (set_rows(), []),
    (set_rows(types="SSS"), param_rows()),  # H が無い
    (set_rows(types="HHX"), param_rows()),
    (set_rows(), param_rows(conf=100.0)),
    (set_rows(), param_rows(n=5)),  # S の本数より多い
    (set_rows(), param_rows(n=None)),
])
def test_scenario_set_inconsistent(sets, params):
    with pytest.raises(jscc.Inconsistent):
        jscc.scenario_set("r", sets, params)


def row(**kw):
    base = {"jscc_run_id": "r", "product_code": "NK225E", "contract_type": "OOP", "put_call_type": "P",
            "contract_period_code": "202612", "strike_price": Decimal("30000"), "contract_size": 1000,
            "aggregation_group": "IDX_IDX", "price": 120.0, "pnl": list(range(len(JSCC_TYPES)))}
    base.update(kw)
    return base


def test_row_key():
    assert jscc.row_key(row()) == K_P
    assert jscc.row_key(row(strike_price=Decimal("30000.000000000"))) == K_P
    assert jscc.row_key(row(strike_price=31000, put_call_type="C")) == K_C
    assert jscc.row_key(row(product_code="NK225MCF", contract_type="FUT", put_call_type=None,
                            strike_price=None)) == K_F
    assert jscc.row_key(row(strike_price=Decimal("30000.5"))) is None
    assert jscc.row_key(row(product_code="NK225W1")) is None
    assert jscc.row_key(row(contract_period_code="202612W")) is None
    assert jscc.row_key(row(product_code="NK225F", contract_type="OOP")) is None


def test_instruments_from_rows_and_int_arrays():
    big = [2**40] + [0] * (len(JSCC_TYPES) - 1)
    out = jscc.instruments_from_rows("r", [row(), row(put_call_type="C", pnl=big),
                                           row(product_code="NK225W1")], len(JSCC_TYPES))
    assert set(out) == {K_P, "NK225E-202612-C-30000"}
    assert out[K_P].pnl.typecode == "i" and out["NK225E-202612-C-30000"].pnl.typecode == "q"
    assert out[K_P].price == 120.0 and out[K_P].contract_size == 1000


@pytest.mark.parametrize("bad", [
    {"jscc_run_id": "x"}, {"pnl": [1, 2]}, {"pnl": [1.5] * len(JSCC_TYPES)}, {"contract_size": 0},
])
def test_instruments_from_rows_inconsistent(bad):
    with pytest.raises(jscc.Inconsistent):
        jscc.instruments_from_rows("r", [row(**bad)], len(JSCC_TYPES))


def test_instruments_duplicate_is_inconsistent():
    with pytest.raises(jscc.Inconsistent):
        jscc.instruments_from_rows("r", [row(), row()], len(JSCC_TYPES))


def test_ok_json_missing_and_other_group():
    s = jscc.ScenarioSet("r", JSCC_TYPES, 97.5, 2)
    insts = jscc.instruments_from_rows("r", [row(), row(put_call_type="C", aggregation_group="OTHER")],
                                       len(JSCC_TYPES))
    r = req(K_P, "NK225E-202612-C-30000", K_F)
    out = jscc.ok_json(r, s, {"202612": insts})
    assert out["status"] == "ok" and out["business_date"] == "2026-11-20"
    assert out["scenario_types"] == JSCC_TYPES
    assert [i["key"] for i in out["instruments"]] == [K_P]
    assert out["instruments"][0]["pnl"] == list(range(len(JSCC_TYPES)))
    assert out["missing"] == ["NK225E-202612-C-30000", K_F]


# ---- サービス ----

def svc(w, clock=None):
    clock = clock or Clock(NOW)
    runner = FakeRunner(w)
    return JsccService(runner, clock, clock.monotonic), runner, clock


def test_service_ok_reads_each_table_once_and_caches_by_period():
    s, runner, _ = svc(world(periods=("202612", "202703")))
    p = s.get(req(K_P, K_F))
    obj = json.loads(p.json_bytes)
    assert p.status == "ok" and obj["status"] == "ok"
    assert {i["key"] for i in obj["instruments"]} == {K_P, K_F}
    assert runner.names() == ["jscc_runs", "jscc_scenario_set", "jscc_parameter", "jscc_scenario"]
    # パラメータの型: 日付は DATE、限月は INT64（文字列のパラメータを使わない）
    for _name, params in runner.calls:
        assert params["d"] == D
    assert runner.calls[-1][1]["cp"] == 202612
    runner.reset()
    # 同じ限月の別の銘柄はキャッシュから（クエリなし）、別の限月は行だけ読む
    s.get(req(K_C))
    assert runner.names() == []
    s.get(req("NK225E-202703-P-30000"))
    assert runner.names() == ["jscc_scenario"]


def test_service_not_ready_then_ready_after_miss_ttl():
    w = World()
    s, runner, clock = svc(w)
    p = s.get(req())
    assert p.status == "unavailable" and p.reason == "not_ready"
    assert json.loads(p.json_bytes) == {"schema_version": 1, "status": "unavailable", "reason": "not_ready",
                                        "business_date": "2026-11-20"}
    jscc_world(w, D)
    clock.advance(st.JSCC_RUNS_MISS_TTL_SECONDS - 1)
    assert s.get(req()).reason == "not_ready"
    clock.advance(2)
    assert s.get(req()).status == "ok"


def test_service_failed_run_is_not_ready():
    s, _, _ = svc(world(status="failed"))
    assert s.get(req()).reason == "not_ready"


def test_service_inconsistent_run_ids_not_cached():
    w = world()
    w.jscc_set[0]["jscc_run_id"] = "other"
    s, runner, _ = svc(w)
    assert s.get(req()).reason == "inconsistent"
    w.jscc_set[0]["jscc_run_id"] = "run-1"
    runner.reset()
    assert s.get(req()).status == "ok"
    assert "jscc_scenario_set" in runner.names()


def test_service_rows_from_another_run_are_inconsistent():
    w = world()
    w.jscc_rows[0]["jscc_run_id"] = "other"
    s, _, _ = svc(w)
    assert s.get(req()).reason == "inconsistent"


def test_service_single_flight_per_period():
    w = world()
    gate = threading.Event()
    clock = Clock(NOW)
    runner = FakeRunner(w, gates={"jscc_scenario": gate})
    s = JsccService(runner, clock, clock.monotonic)
    out = []
    ts = [threading.Thread(target=lambda k=k: out.append(s.get(req(k)))) for k in (K_P, K_C, K_F)]
    for t in ts:
        t.start()
    runner.started["jscc_scenario"].wait(5)
    gate.set()
    for t in ts:
        t.join(5)
    assert len(out) == 3 and all(p.status == "ok" for p in out)
    assert runner.count("jscc_scenario") == 1


def test_service_does_not_log_keys(capsys):
    s, _, _ = svc(world())
    s.get(req(K_P))
    logs = capsys.readouterr()
    text = logs.out + logs.err
    assert "jscc_served" in text
    assert "NK225" not in text and "30000" not in text


def test_pnl_array_memory():
    # 1 限月の行は int32 の配列で持つ（約 700 行 × 1,422 × 4 B ≈ 4 MB の見積もりの前提）
    assert array("i").itemsize == 4


# ---- アプリ ----

def client(w=None, cfg=CFG, clock=None):
    clock = clock or Clock(NOW)
    app = create_app(runner=FakeRunner(w or world()), clock=clock, monotonic=clock.monotonic, cfg=cfg,
                     ai_cfg=st.AiSettings())
    return app.test_client()


def test_app_ok_cache_control_and_gzip():
    c = client()
    res = c.get(f"/api/jscc_scenarios?date=2026-11-20&i={K_P}&i={K_F}", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == f"private, max-age={st.JSCC_MAX_AGE_SECONDS}"
    assert res.headers["Content-Encoding"] == "gzip"


def test_app_not_ready_short_max_age():
    res = client(World()).get(f"/api/jscc_scenarios?date=2026-11-20&i={K_P}")
    assert res.status_code == 200 and res.get_json()["reason"] == "not_ready"
    assert res.headers["Cache-Control"] == f"private, max-age={st.JSCC_NOT_READY_MAX_AGE_SECONDS}"


def test_app_bad_request_does_not_reflect():
    res = client().get("/api/jscc_scenarios?date=2026-11-20&i=<script>")
    assert res.status_code == 400
    assert res.get_data(as_text=True) == '{"error":"bad_request"}'
    assert client().get("/api/jscc_scenarios?i=" + K_P).status_code == 400


def test_app_query_failure_is_503():
    clock = Clock(NOW)
    app = create_app(runner=FakeRunner(world(), errors={"jscc_scenario": RuntimeError("secret project 123")}),
                     clock=clock, monotonic=clock.monotonic, cfg=CFG, ai_cfg=st.AiSettings())
    res = app.test_client().get(f"/api/jscc_scenarios?date=2026-11-20&i={K_P}")
    assert res.status_code == 503 and "secret" not in res.get_data(as_text=True)


def test_file_and_quotes_sources_are_no_source(tmp_path):
    p = FileChainService(tmp_path / "x.json").jscc_scenarios(req())
    assert json.loads(p.json_bytes) == {"schema_version": 1, "status": "unavailable", "reason": "no_source",
                                        "business_date": "2026-11-20"}
    cfg = st.Settings(project="example-project", data_source="file", chain_file=tmp_path / "x.json")
    res = client(cfg=cfg).get(f"/api/jscc_scenarios?date=2026-11-20&i={K_P}")
    assert res.status_code == 200 and res.get_json()["reason"] == "no_source"


def test_chain_service_delegates():
    clock = Clock(NOW)
    s = ChainService(FakeRunner(world()), clock, clock.monotonic)
    assert s.jscc_scenarios(req()).status == "ok"

"""/api/jscc_factors（当て直しの r・g、#387 AC4）: SQL の静的検査・要求の検証・行 → 応答（純関数）と、サービスの
キャッシュ・single-flight・run_id の照合・アプリの応答（Cache-Control・400・no_source・503）。偽の runner・時計。
値はすべて架空（種つき乱数の合成の表。support.jscc_factor_world）。"""

import json
import re
import threading
from datetime import date, timedelta

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
                                [f"{2027 + m // 12}{m % 12 + 1:02d}" for m in range(25)], ["<x>"]])
def test_parse_bad_periods(ps):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_factor_request(args(date="2026-11-20", p=ps), NOW)
    assert e.value.param == "p"


@pytest.mark.parametrize("at", ["2026-11-21", "2026-10-29", "x", ["2026-11-19", "2026-11-18"]])
def test_parse_bad_at(at):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_factor_request(args(date="2026-11-20", p="202612", at=at), NOW)
    assert e.value.param == "at"


def test_parse_at_ok():
    r = jscc.parse_factor_request(args(date="2026-11-20", p="202612", at="2026-11-19"), NOW)
    assert r.at == date(2026, 11, 19)


@pytest.mark.parametrize("d", ["2026-11-15", "2026-12-31", "2026-02-30", "x"])
def test_parse_bad_date(d):
    with pytest.raises(atm_iv.BadRequest) as e:
        jscc.parse_factor_request(args(date=d, p="202612"), NOW)
    assert e.value.param == "date"


# ---- 行 → 応答 ----

def frow(**kw):
    r = {"jscc_run_id": "r", "product_code": "NK225E", "contract_period_code": "202612",
         "nodes": [-5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3], "r": [0.01] * 4, "g": [0.1] * 52,
         "check_median_rel": 0.003, "check_p90_rel": 0.15}
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


@pytest.mark.parametrize("v,want", [(0.02, 0.02), (None, None), (float("nan"), None), (-0.1, None), ("x", None),
                                    (True, None)])
def test_factor_day_quality_is_nonnegative_finite_or_none(v, want):
    day = jscc.factor_day("r", [frow(check_median_rel=v)], 4)
    assert day.rows["NK225E-202612"].check_median_rel == want


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
    assert obj["rows"][0]["check_median_rel"] == 0.003 and obj["rows"][0]["check_p90_rel"] == 0.15
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
    assert runner.names() == ["jscc_runs_range", "jscc_factor_quality", "jscc_scenario_set", "jscc_parameter",
                              "jscc_factor"]
    assert obj["business_date"] == obj["requested_date"] == "2026-11-20"
    # 遡りの範囲の日付は DATE のパラメータ（文字列を使わない）
    assert runner.calls[0][1] == {"d0": max(jscc.MIN_DATE, D - timedelta(days=st.JSCC_FACTOR_RANGE_DAYS)), "d": D}
    runner.reset()
    s.factors(req("202703"))
    assert runner.names() == []
    # /api/jscc_scenarios と並びを共用（取り込みの記録は日ごとの別のキャッシュ）
    assert s.get(jscc.JsccRequest(D, ("NK225E-202612-P-30000",))).status == "ok"
    assert runner.names() == ["jscc_runs", "jscc_scenario"]


def test_service_empty_table_is_no_recent_until_index_ttl():
    w = world(periods=(), futures_only=())
    s, runner, clock = svc(w)
    assert s.factors(req()).reason == "no_recent"
    jscc_factor_world(w, D)
    clock.advance(st.JSCC_RUNS_TTL_SECONDS + 1)
    assert s.factors(req()).status == "ok"


def test_service_other_run_is_inconsistent():
    # 要求の限月（202612）の行は使える日でも、同じ日のほかの行（202703 の先物）の run_id が違えば使わない
    w = world()
    w.jscc_factors[1]["jscc_run_id"] = "other"
    s, _, _ = svc(w)
    assert s.factors(req()).reason == "inconsistent"


def test_service_no_run_is_no_recent():
    w = World()
    jscc_factor_world(w, D)
    s, _, _ = svc(w)
    assert s.factors(req()).reason == "no_recent"


def back_world(days, d0_quality=0.004, periods=("202612",)):
    """days 個の営業日（D から前の平日）に JSCC の表と当て直しの表を足す（run_id は日ごと）"""
    w = World()
    d = D
    out = []
    while len(out) < days:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    for i, x in enumerate(out):
        jscc_world(w, x, run_id=f"run-{i}")
        jscc_factor_world(w, x, run_id=f"run-{i}", periods=periods, futures_only=())
    for r in w.jscc_factors:
        if r["business_date"] == D:
            r["check_median_rel"] = d0_quality
    return w, out


def test_service_goes_back_to_latest_usable_day():
    # 基準日の取り込みが無い（17:00〜18:30 など）→ 前の営業日
    w, days = back_world(3)
    w.jscc_runs = [r for r in w.jscc_runs if r["business_date"] != D]
    s, _, _ = svc(w)
    obj = json.loads(s.factors(req()).json_bytes)
    assert obj["business_date"] == days[1].isoformat() and obj["requested_date"] == D.isoformat()


def test_app_back_is_short_max_age():
    w, days = back_world(2)
    w.jscc_runs = [r for r in w.jscc_runs if r["business_date"] != D]
    res = client(w).get("/api/jscc_factors?date=2026-11-20&p=202612")
    assert res.get_json()["business_date"] == days[1].isoformat()
    assert res.headers["Cache-Control"] == f"private, max-age={st.JSCC_NOT_READY_MAX_AGE_SECONDS}"


def test_service_skips_day_with_poor_quality_or_missing_period():
    w, days = back_world(3, d0_quality=st.JSCC_FACTOR_MAX_MEDIAN_REL + 0.01)
    s, _, _ = svc(w)
    assert json.loads(s.factors(req()).json_bytes)["business_date"] == days[1].isoformat()
    # 限月がそろわない日も飛ばす（前の日にだけ 202703 がある）
    jscc_factor_world(w, days[2], run_id="run-2", periods=("202703",), futures_only=())
    s2, _, _ = svc(w)
    assert json.loads(s2.factors(req("202612", "202703")).json_bytes)["business_date"] == days[2].isoformat()


def test_service_at_forces_the_day():
    # N3: 要求を分けたとき、2 回目以降は 1 回目の日（at）にそろえる。その日が使えなければ no_recent
    w, days = back_world(3)
    s, _, _ = svc(w)
    r = jscc.FactorRequest(D, ("202612",), days[1])
    assert json.loads(s.factors(r).json_bytes)["business_date"] == days[1].isoformat()
    w.jscc_factors = [x for x in w.jscc_factors if x["business_date"] != days[2]]
    s2, _, _ = svc(w)
    assert s2.factors(jscc.FactorRequest(D, ("202612",), days[2])).reason == "no_recent"


def test_service_back_limit(monkeypatch):
    # データの始まり（JSCC_MIN_DATE）より前まで遡れるようにして、上限（JSCC_FACTOR_MAX_BACK 営業日）だけを見る
    monkeypatch.setattr(jscc, "MIN_DATE", date(2026, 10, 1))
    w, days = back_world(st.JSCC_FACTOR_MAX_BACK + 2)
    last_ok = days[st.JSCC_FACTOR_MAX_BACK - 1]  # 10 営業日目
    w.jscc_factors = [r for r in w.jscc_factors if r["business_date"] == last_ok]
    s, _, _ = svc(w)
    assert json.loads(s.factors(req()).json_bytes)["business_date"] == last_ok.isoformat()
    w2, days2 = back_world(st.JSCC_FACTOR_MAX_BACK + 2)
    w2.jscc_factors = [r for r in w2.jscc_factors if r["business_date"] == days2[st.JSCC_FACTOR_MAX_BACK]]
    s2, _, _ = svc(w2)
    assert s2.factors(req()).reason == "no_recent"


def test_pick_factor_date_pure():
    runs = [{"business_date": D, "jscc_run_id": "a", "status": "failed", "finished_at": 1},
            {"business_date": D - timedelta(days=1), "jscc_run_id": "b", "status": "succeeded", "finished_at": 1}]
    q = [{"business_date": D, "jscc_run_id": "a", "product_code": "NK225E", "contract_period_code": "202612",
          "check_median_rel": 0.0},
         {"business_date": D - timedelta(days=1), "jscc_run_id": "b", "product_code": "NK225F",
          "contract_period_code": "202612", "check_median_rel": None}]
    assert jscc.pick_factor_date(req(), runs, q) == (D - timedelta(days=1), "b")
    assert jscc.pick_factor_date(req(), runs, q, max_back=0) is None


def test_service_single_flight():
    w = world()
    gate = threading.Event()
    clock = Clock(NOW)
    runner = FakeRunner(w, gates={"jscc_factor": gate})
    s = JsccService(runner, clock, clock.monotonic)
    out = []
    ts = [threading.Thread(target=lambda p=p: out.append(s.factors(req(*p))))
          for p in (("202612",), ("202703",), ("202612", "202703"))]
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
    assert res.get_json()["reason"] == "no_recent"
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

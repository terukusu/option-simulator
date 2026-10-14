"""Flask のアプリ（AC-5 の応答・ログ、AC-6 の /api/calendar、AC-7 のヘッダ・入力、AC-10 の静的ファイル）。"""

import gzip
import json
import re
from datetime import timedelta

import pytest
from support import Clock, FakeRunner, World, jst, load_fixture, synth_board

from simulator_api import settings as st
from simulator_api.app import SECURITY_HEADERS, create_app

CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
CFG = st.Settings(project="example-project")


def make(world=None, errors=None, cfg=CFG, **kw):
    fx = load_fixture("latest")
    if world is None:
        world = World()
        world.add_fixture(fx)
    clock = Clock(jst(2026, 10, 13, 21, 46))
    runner = FakeRunner(world, errors=errors)
    app = create_app(runner=runner, clock=clock, monotonic=clock.monotonic, cfg=cfg, **kw)
    return app.test_client(), runner, clock


def assert_security_headers(res):
    assert res.headers["Content-Security-Policy"] == CSP
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    assert res.headers["Referrer-Policy"] == "no-referrer"
    assert res.headers["X-Frame-Options"] == "DENY"


def test_csp_same_as_viewer():
    assert SECURITY_HEADERS["Content-Security-Policy"] == CSP


def test_chain_ok_headers():
    client, _, _ = make()
    res = client.get("/api/chain")
    assert res.status_code == 200
    assert res.headers["Content-Type"] == "application/json; charset=utf-8"
    assert res.headers["Cache-Control"] == "private, max-age=60"
    assert res.headers["Vary"] == "Accept-Encoding"
    # "<snapshot_at>-<finished_at>-<reason>-<カレンダーの版>"（UTC の秒）
    assert re.fullmatch(r'"\d+-\d+-latest-\d+"', res.headers["ETag"])
    assert_security_headers(res)
    body = res.get_json()
    assert body["schema_version"] == 1 and body["reason"] == "latest"


def test_chain_etag_304():
    client, runner, _ = make()
    etag = client.get("/api/chain").headers["ETag"]
    res = client.get("/api/chain", headers={"If-None-Match": etag})
    assert res.status_code == 304
    assert res.data == b""
    assert res.headers["ETag"] == etag
    assert_security_headers(res)
    assert client.get("/api/chain", headers={"If-None-Match": '"other"'}).status_code == 200


def test_chain_gzip():
    client, _, _ = make()
    plain = client.get("/api/chain").data
    res = client.get("/api/chain", headers={"Accept-Encoding": "gzip, deflate"})
    assert res.headers["Content-Encoding"] == "gzip"
    assert gzip.decompress(res.data) == plain
    assert len(res.data) < len(plain) / 3
    res = client.get("/api/chain", headers={"Accept-Encoding": "gzip;q=0"})
    assert "Content-Encoding" not in res.headers


def test_chain_at_is_400_without_reflection(capsys):
    # AC-7: ?at= は後段（#33 では 400）。本文・ログに入力値を含めず、BigQuery を呼ばない
    client, runner, _ = make()
    probe = "2026-10-13T12:00:00+09:00<script>"
    res = client.get("/api/chain", query_string={"at": probe})
    assert res.status_code == 400
    assert res.get_json() == {"error": "bad_request"}
    assert res.headers["Cache-Control"] == "no-store"
    assert_security_headers(res)
    assert probe.encode() not in res.data and b"2026" not in res.data
    out = capsys.readouterr().out
    assert "2026-10-13T12" not in out and "script" not in out
    assert json.loads(out.splitlines()[-1])["event"] == "bad_request"
    assert runner.calls == []


def test_chain_unknown_params_ignored():
    client, _, _ = make()
    assert client.get("/api/chain?foo=1").status_code == 200


def test_chain_runner_error_is_503_with_type_only(capsys):
    # AC-5: runner の例外 → 503。応答に例外本文を含まず、ログは例外の型だけ
    secret = "projects/123456/datasets/secret: Access Denied for user@example.com"
    client, _, _ = make(errors={"latest_runs": PermissionError(secret)})
    res = client.get("/api/chain")
    assert res.status_code == 503
    assert res.get_json() == {"error": "unavailable"}
    assert res.headers["Cache-Control"] == "no-store"
    assert_security_headers(res)
    out = capsys.readouterr().out
    assert "123456" not in out and "example.com" not in out and "Access Denied" not in out
    rec = [json.loads(line) for line in out.splitlines() if '"query_failed"' in line][-1]
    assert rec["error_type"] == "PermissionError" and rec["severity"] == "ERROR"


def test_chain_no_usable_board_is_503():
    w = World()
    at = jst(2026, 10, 13, 21, 31)
    w.add(at, synth_board(at, quoted=0), 30000.0)
    client, _, _ = make(world=w)
    res = client.get("/api/chain")
    assert res.status_code == 503
    assert res.get_json() == {"error": "unavailable"}


def test_chain_logs_served(capsys):
    client, _, _ = make()
    client.get("/api/chain")
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    served = [r for r in recs if r["event"] == "chain_served"][-1]
    assert served["reason"] == "latest" and served["board_reads"] == 1 and served["snapshot_at"]


def test_calendar_endpoint():
    # AC-6: 版の全行を日付の昇順で、covered_until・listed_until・version_at を含む
    w = World()
    w.calendar = list(reversed(w.calendar))
    client, _, _ = make(world=w)
    res = client.get("/api/calendar")
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == "private, max-age=3600"
    assert res.headers["Content-Type"] == "application/json; charset=utf-8"
    assert_security_headers(res)
    body = res.get_json()
    assert set(body) == {"schema_version", "source", "version_at", "covered_until", "listed_until", "days"}
    dates = [d["date"] for d in body["days"]]
    assert dates == sorted(dates) and len(dates) == len(w.calendar)
    assert any(d["is_trading_day"] for d in body["days"]) and not all(d["is_trading_day"] for d in body["days"])
    assert body["version_at"].endswith("+09:00")
    etag = res.headers["ETag"]
    assert client.get("/api/calendar", headers={"If-None-Match": etag}).status_code == 304


def test_calendar_error_is_503():
    client, _, _ = make(errors={"trading_calendar": RuntimeError("x")})
    res = client.get("/api/calendar")
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    assert client.get("/api/chain").status_code == 503


def test_healthz_does_not_touch_bigquery():
    client, runner, _ = make()
    res = client.get("/healthz")
    assert res.status_code == 200 and res.data == b"ok\n"
    assert_security_headers(res)
    assert runner.calls == []


def test_not_found_has_headers():
    client, _, _ = make()
    res = client.get("/nope")
    assert res.status_code == 404
    assert_security_headers(res)


# ---- 静的ファイル（AC-10）----

@pytest.fixture
def static_dir(tmp_path):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
    (d / "assets" / "index-abc.js").write_text("console.log(1)", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    return d


def test_static_files(static_dir):
    client, _, _ = make(cfg=st.Settings(project="example-project", static_dir=static_dir))
    res = client.get("/")
    assert res.status_code == 200 and b"<title>t</title>" in res.data
    assert res.headers["Cache-Control"] == "no-cache"
    assert_security_headers(res)
    res = client.get("/assets/index-abc.js")
    assert res.status_code == 200 and res.data == b"console.log(1)"
    assert res.headers["Cache-Control"] == "private, max-age=31536000, immutable"
    assert_security_headers(res)
    for path in ("/assets/../index.html", "/assets/..%2f..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt",
                 "/assets/missing.js", "/index.html/../../secret.txt"):
        r = client.get(path)
        assert r.status_code == 404, path
        assert b"secret" not in r.data


def test_static_disabled_without_dir():
    client, _, _ = make()
    assert client.get("/").status_code == 404
    assert client.get("/assets/index-abc.js").status_code == 404


# ---- DATA_SOURCE=file ----

def test_file_source(tmp_path):
    f = tmp_path / "chain.json"
    f.write_text(json.dumps(load_fixture("night_early")), encoding="utf-8")
    cfg = st.Settings(data_source="file", chain_file=f)
    app = create_app(cfg=cfg)
    client = app.test_client()
    res = client.get("/api/chain")
    assert res.status_code == 200
    assert res.get_json() == load_fixture("night_early")
    assert_security_headers(res)
    assert client.get("/api/calendar").status_code == 503
    f.write_text(json.dumps({"schema_version": 2}), encoding="utf-8")
    assert client.get("/api/chain").status_code == 503


def test_clock_is_used_for_freshness():
    client, _, clock = make()
    clock.advance(timedelta(hours=3).total_seconds())
    assert client.get("/api/chain").get_json()["reason"] == "closed"

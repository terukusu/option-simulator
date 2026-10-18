"""Flask のアプリ（AC-5 の応答・ログ、AC-6 の /api/calendar、AC-7 のヘッダ・入力、AC-10 の静的ファイル、
#90 の manifest・アイコン）。"""

import gzip
import json
import re
import threading
from datetime import timedelta

import pytest
from support import Clock, FakeRunner, World, jst, load_fixture, synth_board

from simulator_api import bq
from simulator_api import settings as st
from simulator_api.app import ROOT_FILES, SECURITY_HEADERS, create_app

# optionchan のビューアーと同じ CSP（#90 の前の値）。#90 で manifest-src 'self' を 1 つ足した
VIEWER_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
              "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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


def directives(csp):
    return {d.strip() for d in csp.split(";") if d.strip()}


def test_csp():
    # #90 AC-4(c): ビューアーの CSP に manifest-src 'self' を足しただけ（他のディレクティブは同じ）
    assert SECURITY_HEADERS["Content-Security-Policy"] == CSP
    assert directives(CSP) == directives(VIEWER_CSP) | {"manifest-src 'self'"}


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
    assert isinstance(served["elapsed_ms"], int) and served["elapsed_ms"] >= 0


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
    # #90: manifest とアイコン（中身はダミー）と、決まった名前以外の直下のファイル（配らないこと）
    for name in ROOT_FILES:
        (d / name).write_text(f"root:{name}", encoding="utf-8")
    (d / "secret.txt").write_text("secret", encoding="utf-8")
    (d / "index-abc.js").write_text("secret()", encoding="utf-8")
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


ROOT_FILE_TYPES = {
    "/manifest.webmanifest": "application/manifest+json",
    "/favicon.svg": "image/svg+xml",
    "/apple-touch-icon.png": "image/png",
    "/icon-192.png": "image/png",
    "/icon-512.png": "image/png",
}


def test_root_files_names():
    assert {f"/{n}": t for n, t in ROOT_FILES.items()} == ROOT_FILE_TYPES


def test_root_files(static_dir):
    # #90 AC-4(a): 5 つの名前は 200・Content-Type・no-cache・ETag で 304・CSP
    client, _, _ = make(cfg=st.Settings(project="example-project", static_dir=static_dir))
    for path, mimetype in ROOT_FILE_TYPES.items():
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.data == f"root:{path[1:]}".encode(), path
        assert res.mimetype == mimetype, path  # SVG は Werkzeug が "; charset=utf-8" を付ける
        assert res.headers["Cache-Control"] == "no-cache", path
        assert "manifest-src 'self'" in res.headers["Content-Security-Policy"]
        assert_security_headers(res)
        etag = res.headers["ETag"]
        r = client.get(path, headers={"If-None-Match": etag})
        assert r.status_code == 304, path
        assert r.headers["Cache-Control"] == "no-cache", path
        assert_security_headers(r)
    # クエリ文字列は無視
    assert client.get("/manifest.webmanifest?x=1").status_code == 200


def test_root_files_allowlist(static_dir):
    # #90 AC-4(b): 静的ディレクトリに同名のファイルがあっても 5 つ以外は配らない。ディレクトリの外にも出ない
    client, _, _ = make(cfg=st.Settings(project="example-project", static_dir=static_dir))
    for path in ("/secret.txt", "/index-abc.js", "/manifest.webmanifest/../secret.txt", "/%2e%2e/secret.txt",
                 "/favicon.svg/", "/Favicon.svg", "/manifest.json", "/favicon.ico",
                 "/apple-touch-icon-precomposed.png", "/icon-192.png/../../secret.txt"):
        r = client.get(path)
        assert r.status_code == 404, path
        assert b"secret" not in r.data, path
        assert_security_headers(r)


def test_root_files_missing_is_404(tmp_path):
    # ビルド物に無い名前は 404（500 にしない）
    d = tmp_path / "dist"
    d.mkdir()
    (d / "index.html").write_text("<!doctype html>", encoding="utf-8")
    client, _, _ = make(cfg=st.Settings(project="example-project", static_dir=d))
    for path in ROOT_FILE_TYPES:
        assert client.get(path).status_code == 404, path


def test_static_disabled_without_dir():
    client, _, _ = make()
    assert client.get("/").status_code == 404
    assert client.get("/assets/index-abc.js").status_code == 404
    for path in ROOT_FILE_TYPES:
        r = client.get(path)
        assert r.status_code == 404, path
        assert_security_headers(r)


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


# ---- 起動時の BigQuery の準備（#95） ----

def test_warm_does_not_block_startup(monkeypatch):
    # 準備が終わらないままでも create_app が返り、/healthz が 200
    release, entered = threading.Event(), threading.Event()

    def stuck(self):
        entered.set()
        release.wait(5)
        raise RuntimeError("not ready")

    threads = []
    start_warm = bq.BigQueryRunner.start_warm
    monkeypatch.setattr(bq.BigQueryRunner, "_new_client", stuck)
    monkeypatch.setattr(bq.BigQueryRunner, "start_warm", lambda self: threads.append(start_warm(self)))
    try:
        app = create_app(cfg=CFG)
        assert entered.wait(5)  # 準備はバックグラウンドで始まっている
        res = app.test_client().get("/healthz")
        assert res.status_code == 200 and res.data == b"ok\n"
        assert len(threads) == 1 and threads[0].is_alive()
    finally:
        release.set()
        for t in threads:
            t.join(5)


def test_warm_only_for_default_runner(monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(bq.BigQueryRunner, "start_warm", lambda self: started.append(self))
    make()  # runner を渡す（テスト）
    f = tmp_path / "chain.json"
    f.write_text(json.dumps(load_fixture("night_early")), encoding="utf-8")
    create_app(cfg=st.Settings(data_source="file", chain_file=f))
    assert started == []
    create_app(cfg=CFG)
    assert len(started) == 1


# ---- /api/atm_iv（#79 AC3・AC5） ----

def atm_world():
    from support import cm_rows

    w = World()
    w.add_fixture(load_fixture("latest"))
    w.cm = cm_rows(jst(2026, 10, 13, 8, 45), jst(2026, 10, 13, 21, 0), value=lambda t: 20.0 + t.minute / 100)
    return w


def test_atm_iv_ok_headers():
    client, runner, _ = make(world=atm_world())
    res = client.get("/api/atm_iv?tf=1h")
    assert res.status_code == 200
    assert res.headers["Content-Type"] == "application/json; charset=utf-8"
    assert res.headers["Cache-Control"] == "private, max-age=60"
    assert "ETag" not in res.headers
    assert_security_headers(res)
    body = res.get_json()
    assert set(body) == {"schema_version", "tf", "start", "end", "last_at", "bars"}
    assert body["schema_version"] == 1 and body["tf"] == "1h" and body["bars"]
    assert set(body["bars"][0]) == {"t", "o", "h", "l", "c"}
    assert runner.names() == ["atm_cm_iv"]  # 板・カレンダーは読まない
    gz = client.get("/api/atm_iv?tf=1h", headers={"Accept-Encoding": "gzip"})
    assert gz.headers["Content-Encoding"] == "gzip" and json.loads(gzip.decompress(gz.data)) == body
    assert runner.names() == ["atm_cm_iv"]  # 2 回目はキャッシュ


def test_atm_iv_settled_cache_control():
    client, _, _ = make(world=atm_world())
    res = client.get("/api/atm_iv?tf=1h&start=2026-09-01T00:00:00Z&end=2026-10-11T00:00:00Z")
    assert res.status_code == 200 and res.headers["Cache-Control"] == "private, max-age=3600"


@pytest.mark.parametrize("tf,days", [("1m", 3), ("1h", 100), ("1d", 400)])
def test_atm_iv_max_range_boundary(tf, days):
    client, runner, _ = make(world=atm_world())
    end = "2026-10-14T00:00:00Z"
    start = (jst(2026, 10, 14, 9) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    res = client.get("/api/atm_iv", query_string={"tf": tf, "start": start, "end": end})
    assert res.status_code == 200, (tf, days)
    over = (jst(2026, 10, 14, 9) - timedelta(days=days + 1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    runner.reset()
    res = client.get("/api/atm_iv", query_string={"tf": tf, "start": over, "end": end})
    assert res.status_code == 400 and res.get_json() == {"error": "bad_request"}
    assert runner.calls == []


@pytest.mark.parametrize("query", [
    {"tf": "5m"},
    {},
    {"tf": "1h", "start": "2026-10-01T00:00:00Z"},
    {"tf": "1h", "start": "2026-10-01T00:00:00", "end": "2026-10-02T00:00:00"},
    {"tf": "1h", "start": "2026-10-01T00:00:00.5Z", "end": "2026-10-02T00:00:00Z"},
    {"tf": "1h", "start": "2026-10-01T03:00:00Z", "end": "2026-10-02T00:00:00Z"},
    {"tf": "1h", "start": "2026-10-02T00:00:00Z", "end": "2026-10-01T00:00:00Z"},
    {"tf": "1d", "start": "2009-01-01T00:00:00Z", "end": "2009-06-01T00:00:00Z"},
])
def test_atm_iv_bad_request_without_reflection(query, capsys):
    client, runner, _ = make(world=atm_world())
    probe = "<script>x</script>"
    q = dict(query)
    q["tf"] = q.get("tf", "") + ("" if q.get("tf") in ("1h", "1d") else probe)
    res = client.get("/api/atm_iv", query_string=q)
    assert res.status_code == 400
    assert res.get_json() == {"error": "bad_request"}
    assert res.headers["Cache-Control"] == "no-store"
    assert_security_headers(res)
    assert b"script" not in res.data and b"2026" not in res.data and b"2009" not in res.data
    out = capsys.readouterr().out
    assert "script" not in out and "2026-10" not in out and "2009" not in out
    rec = json.loads(out.splitlines()[-1])
    assert rec["event"] == "bad_request" and rec["endpoint"] == "atm_iv"
    assert rec["param"] in ("tf", "start", "end", "range")
    assert runner.calls == []


def test_atm_iv_unknown_params_ignored():
    client, _, _ = make(world=atm_world())
    assert client.get("/api/atm_iv?tf=1m&foo=1").status_code == 200


def test_atm_iv_runner_error_is_503_with_type_only(capsys):
    secret = "projects/123456: bytesBilledLimitExceeded for user@example.com"
    client, _, _ = make(world=atm_world(), errors={"atm_cm_iv": RuntimeError(secret)})
    res = client.get("/api/atm_iv?tf=1h")
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    assert res.headers["Cache-Control"] == "no-store"
    out = capsys.readouterr().out
    assert "123456" not in out and "example.com" not in out and "bytesBilled" not in out
    rec = [json.loads(line) for line in out.splitlines() if '"query_failed"' in line][-1]
    assert rec["endpoint"] == "atm_iv" and rec["error_type"] == "RuntimeError"


def test_atm_iv_concurrent_requests_share_one_job():
    gate = threading.Event()
    w = atm_world()
    clock = Clock(jst(2026, 10, 13, 21, 46))
    runner = FakeRunner(w, gate=gate)
    app = create_app(runner=runner, clock=clock, monotonic=clock.monotonic, cfg=CFG)
    codes = []

    def work():
        codes.append(app.test_client().get("/api/atm_iv?tf=1h").status_code)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    runner.started["atm_cm_iv"].wait(5)
    threading.Event().wait(0.2)
    gate.set()
    for t in threads:
        t.join(10)
    assert codes == [200] * 8
    assert runner.count("atm_cm_iv") == 1


def test_atm_iv_file_source_is_503(tmp_path):
    f = tmp_path / "chain.json"
    f.write_text(json.dumps(load_fixture("latest")), encoding="utf-8")
    client = create_app(cfg=st.Settings(data_source="file", chain_file=f)).test_client()
    assert client.get("/api/atm_iv?tf=1h").status_code == 503
    assert client.get("/api/atm_iv?tf=5m").status_code == 400

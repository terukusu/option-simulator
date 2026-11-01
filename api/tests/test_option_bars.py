"""/api/option_bars（銘柄の推移、#319 AC 2）: SQL の静的検査・要求の検証・足の作り方（純関数）と、サービス・アプリの
キャッシュ・single-flight・範囲の外・供給元の 503。偽の runner・時計。値はすべて架空。"""

import json
import math
import random
import re
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from conftest import PKG_DIR
from support import Clock, FakeRunner, World, jst, load_fixture, opt_row

from simulator_api import atm_iv, bq, contract, option_bars
from simulator_api import settings as st
from simulator_api.app import create_app
from simulator_api.option_bars import OptionBarsRequest
from simulator_api.service import ChainService, FileChainService, OptionBarsService, QuotesFileService, Unavailable

MiB = 1024**2
LTD = date(2026, 11, 12)  # 木曜（架空の限月）
K = 30000
NOW = jst(2026, 11, 5, 21, 46)  # 木曜の夜間（合成のカレンダーの 11-03 は休業日）
CFG = st.Settings(project="example-project")
ARGS = {"ltd": "2026-11-12", "k": "30000", "type": "put", "tf": "1h"}


def req(tf="1h", ltd=LTD, k=K, typ=2):
    return OptionBarsRequest(ltd, k, typ, tf)


def sql_text():
    text = (PKG_DIR / "sql" / "option_bars.sql").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


# ---- SQL の静的検査 ----

def test_sql_filters_partition_cluster_and_half_open_range_by_params():
    text = re.sub(r"\s+", " ", sql_text())
    # パーティション列（last_trading_day の月）の等号・クラスタ列の等号・started_at の半開区間（どれもパラメータ）
    assert "WHERE last_trading_day = @ltd" in text
    assert "AND target_price = @k" in text and "AND type = @type" in text
    assert "AND started_at >= @start_at" in text and "AND started_at < @end_at" in text
    assert "<= @end_at" not in text
    assert "*" not in text and "CURRENT_TIMESTAMP" not in text.upper()
    assert set(re.findall(r"@(\w+)", text)) == {"ltd", "k", "type", "start_at", "end_at"}
    assert re.findall(r"`\$\{project\}\.\$\{dataset\}\.(\w+)`", text) == ["option_price_hourly"]


def test_service_params_match_sql_and_types():
    w = World()
    w.opt.append(opt_row(jst(2026, 11, 5, 9)))
    runner = FakeRunner(w)
    clock = Clock(NOW)
    svc = OptionBarsService(runner, clock, clock.monotonic)
    svc.get(req())
    (name, params), = runner.calls
    assert name == "option_bars"
    assert set(params) == {"ltd", "k", "type", "start_at", "end_at"}
    assert {k: bq.param_type(v) for k, v in params.items()} == {
        "ltd": "DATE", "k": "INT64", "type": "INT64", "start_at": "TIMESTAMP", "end_at": "TIMESTAMP"}


def test_maximum_bytes_billed_is_the_query_cap():
    runner = bq.BigQueryRunner(st.Settings(project="example-project"))
    assert runner.maximum_bytes_billed("option_bars") == st.QUERY_MAX_BYTES_BILLED["option_bars"] == 64 * MiB
    assert runner.maximum_bytes_billed("option_bars") < st.MAX_BYTES_BILLED_LIMIT
    small = bq.BigQueryRunner(st.Settings(project="example-project", maximum_bytes_billed=32 * MiB))
    assert small.maximum_bytes_billed("option_bars") == 32 * MiB  # 設定の方が小さければそれ


def test_contract_columns():
    assert contract.column_names("option_bars") == (
        "started_at", "mid_open", "mid_high", "mid_low", "mid_close", "bid_close", "ask_close", "bid_iv_close",
        "ask_iv_close", "trade_close", "iv_close", "last_at")


# ---- 要求 ----

def test_parse_request_ok():
    r = option_bars.parse_request(ARGS)
    assert r == OptionBarsRequest(LTD, K, 2, "1h")
    assert option_bars.parse_request({**ARGS, "type": "call", "tf": "1d", "x": "?"}) == OptionBarsRequest(
        LTD, K, 1, "1d")


@pytest.mark.parametrize(("change", "param"), [
    ({"ltd": None}, "ltd"),
    ({"ltd": "2026-02-30"}, "ltd"),
    ({"ltd": "2026-11-12T00:00:00"}, "ltd"),
    ({"ltd": "20261112"}, "ltd"),
    ({"ltd": "2026-11-12\n"}, "ltd"),
    ({"k": None}, "k"),
    ({"k": "0"}, "k"),
    ({"k": "-500"}, "k"),
    ({"k": "30000.5"}, "k"),
    ({"k": "030000"}, "k"),
    ({"k": "12345678"}, "k"),
    ({"type": "P"}, "type"),
    ({"type": "2"}, "type"),
    ({"type": None}, "type"),
    ({"tf": "1m"}, "tf"),
    ({"tf": None}, "tf"),
])
def test_parse_request_rejects(change, param):
    args = {**ARGS, **change}
    args = {k: v for k, v in args.items() if v is not None}
    with pytest.raises(atm_iv.BadRequest) as e:
        option_bars.parse_request(args)
    assert e.value.param == param


def test_parse_request_rejects_duplicates():
    from werkzeug.datastructures import MultiDict

    args = MultiDict([*ARGS.items(), ("k", "31000")])
    with pytest.raises(atm_iv.BadRequest) as e:
        option_bars.parse_request(args)
    assert e.value.param == "k"


def test_read_window_is_jst_midnights_and_101_days():
    start_at, end_at = option_bars.read_window(req())
    assert end_at - start_at == timedelta(days=101)
    assert start_at == jst(2026, 8, 4, 0) and end_at == jst(2026, 11, 13, 0)
    assert start_at.tzinfo is not None and end_at.tzinfo is not None


def test_in_range():
    assert option_bars.in_range(req(), NOW)
    assert option_bars.in_range(req(ltd=date(2018, 10, 11)), NOW)
    assert not option_bars.in_range(req(ltd=date(2018, 9, 13)), NOW)  # 表の始まりより前
    # 100 日先までの限月は載りうる（今日 = 2026-11-05）。それより先は読まない
    assert option_bars.in_range(req(ltd=date(2027, 2, 13)), NOW)
    assert not option_bars.in_range(req(ltd=date(2027, 2, 14)), NOW)


def test_is_settled():
    end = jst(2026, 11, 13, 0)
    assert not option_bars.is_settled(req(), end + timedelta(hours=47, minutes=59))
    assert option_bars.is_settled(req(), end + timedelta(hours=48))


# ---- 1 時間足 ----

def hourly_of(rows):
    return option_bars.rows_to_hourly(rows)


def test_hourly_sorted_without_duplicates():
    a, b, c = jst(2026, 11, 5, 9), jst(2026, 11, 5, 10), jst(2026, 11, 5, 11)
    rows = [opt_row(c), opt_row(a), opt_row(b, mid=(101.0, 111.0, 96.0, 106.0)), opt_row(b)]
    bars, last_at, dup = hourly_of(rows)
    assert [x["started_at"] for x in bars] == [a, b, c]
    assert dup == 1
    assert bars[1]["open"] == 101.0  # 同じ started_at は先の行を残す
    assert last_at == c + timedelta(minutes=59)


def test_hourly_duplicate_takes_the_row_that_makes_a_bar():
    # 同じ started_at の 1 行目が気配も約定も無いときは 2 行目を採る（足を消さない）。重複は 1 と数える
    t = jst(2026, 11, 5, 9)
    empty = opt_row(t, mid=None, bid=None, ask=None, trade=None, last_at=t + timedelta(minutes=10))
    rows = [empty, opt_row(t, mid=(101.0, 111.0, 96.0, 106.0))]
    bars, last_at, dup = hourly_of(rows)
    assert [b["open"] for b in bars] == [101.0] and dup == 1
    assert last_at == t + timedelta(minutes=59)
    # どちらも足にならなければ足は無い
    bars, last_at, dup = hourly_of([empty, empty])
    assert bars == [] and last_at is None and dup == 1


@pytest.mark.parametrize("change", [
    {"bid": 120, "ask": 110},  # 逆転
    {"bid": None},
    {"ask": 0},
    {"mid": (100.0, 110.0, math.nan, 105.0)},
    {"mid": (100.0, math.inf, 95.0, 105.0)},
    {"mid": (100.0, 110.0, 101.0, 105.0)},  # 安値 > 始値
    {"mid": (100.0, 104.0, 95.0, 105.0)},  # 高値 < 終値
    {"mid": None},
])
def test_hourly_without_quote_keeps_trade_and_nulls_quote(change):
    t = jst(2026, 11, 5, 9)
    bars, _, _ = hourly_of([opt_row(t, trade=104, trade_iv=20.5, **change)])
    (bar,) = bars
    assert all(bar[k] is None for k in ("open", "high", "low", "close", "bid", "ask", "bid_iv", "ask_iv"))
    assert bar["trade"] == 104 and bar["trade_iv"] == 20.5


def test_hourly_without_quote_and_trade_is_dropped():
    bars, last_at, _ = hourly_of([opt_row(jst(2026, 11, 5, 9), bid=None, trade=None)])
    assert bars == [] and last_at is None


def test_hourly_iv_one_side_and_trade_iv_only_with_trade():
    t = jst(2026, 11, 5, 9)
    (bar,), _, _ = hourly_of([opt_row(t, bid_iv=None, ask_iv=-1.0, trade=None, trade_iv=19.0)])
    assert bar["bid_iv"] is None and bar["ask_iv"] is None and bar["open"] == 100.0
    assert bar["trade"] is None and bar["trade_iv"] is None
    (bar,), _, _ = hourly_of([opt_row(t, bid_iv=20.0, ask_iv=None, trade=104, trade_iv=math.nan)])
    assert bar["bid_iv"] == 20.0 and bar["ask_iv"] is None and bar["trade"] == 104 and bar["trade_iv"] is None


def test_hourly_properties_random():
    rng = random.Random(319)
    for _ in range(50):
        rows = []
        for _ in range(rng.randint(0, 40)):
            t = jst(2026, 11, 2, 0) + timedelta(hours=rng.randint(0, 200))
            lo = rng.uniform(1, 200)
            vals = [rng.choice([lo + rng.uniform(0, 50), None, math.nan, -1.0, 0.0]) for _ in range(4)]
            bid = rng.choice([None, 0, rng.randint(1, 300)])
            ask = rng.choice([None, rng.randint(1, 300)])
            rows.append(opt_row(t, mid=tuple(vals), bid=bid, ask=ask, trade=rng.choice([None, 0, 150]),
                                trade_iv=rng.choice([None, 20.0])))
        bars, _, _ = hourly_of(rows)
        ts = [b["started_at"] for b in bars]
        assert ts == sorted(set(ts))
        for b in bars:
            assert b["open"] is not None or b["trade"] is not None
            if b["open"] is not None:
                assert b["low"] <= min(b["open"], b["close"]) and max(b["open"], b["close"]) <= b["high"]
                assert 0 < b["bid"] <= b["ask"]
        daily = option_bars.daily_bars(bars, frozenset())
        for d in daily:
            members = [b for b in bars if atm_iv.trading_day(b["started_at"], frozenset())
                       == d["started_at"].astimezone(option_bars.JST).date()]
            quoted = [b for b in members if b["open"] is not None]
            if quoted:
                assert d["high"] == max(b["high"] for b in quoted) and d["low"] == min(b["low"] for b in quoted)


# ---- 日足 ----

def test_daily_night_goes_to_next_trading_day_and_first_day_is_kept():
    non_trading = frozenset({date(2026, 11, 3)})
    rows = [
        # 金曜 10-30 の日中（読んだ範囲の先頭の取引日。捨てない）
        opt_row(jst(2026, 10, 30, 9), mid=(100.0, 120.0, 90.0, 110.0), bid=105, ask=115),
        opt_row(jst(2026, 10, 30, 14), mid=(110.0, 130.0, 100.0, 125.0), bid=120, ask=130, trade=126,
                trade_iv=21.0),
        # 金曜の夜間 → 月曜 11-02
        opt_row(jst(2026, 10, 30, 17), mid=(125.0, 126.0, 80.0, 85.0), bid=80, ask=90),
        # 月曜 11-02 の夜間 → 休業日 11-03 を飛ばして水曜 11-04。気配なし・約定だけ
        opt_row(jst(2026, 11, 2, 18), mid=None, bid=None, ask=None, trade=70, trade_iv=24.0),
    ]
    hourly, _, _ = hourly_of(rows)
    days = option_bars.daily_bars(hourly, non_trading)
    assert [d["started_at"] for d in days] == [jst(2026, 10, 30, 0), jst(2026, 11, 2, 0), jst(2026, 11, 4, 0)]
    fri, mon, wed = days
    assert (fri["open"], fri["high"], fri["low"], fri["close"]) == (100.0, 130.0, 90.0, 125.0)
    assert (fri["bid"], fri["ask"], fri["trade"], fri["trade_iv"]) == (120, 130, 126, 21.0)
    assert (mon["open"], mon["close"], mon["trade"], mon["trade_iv"]) == (125.0, 85.0, None, None)
    assert wed["open"] is None and wed["bid"] is None and wed["trade"] == 70 and wed["trade_iv"] == 24.0


def test_json_shape():
    hourly, last_at, _ = hourly_of([opt_row(jst(2026, 11, 5, 9), trade=104, trade_iv=20.5)])
    obj = option_bars.option_bars_json(req(), hourly, last_at)
    assert obj == {
        "schema_version": 1, "tf": "1h", "ltd": "2026-11-12", "k": 30000, "type": "put",
        "last_at": "2026-11-05T09:59:00+09:00",
        "bars": [{"t": "2026-11-05T09:00:00+09:00", "o": 100.0, "h": 110.0, "l": 95.0, "c": 105.0, "bid": 100,
                  "ask": 110, "bid_iv": 20.0, "ask_iv": 21.0, "trade": 104, "trade_iv": 20.5}]}


# ---- サービス ----

def world():
    w = World()
    t = jst(2026, 11, 2, 8)
    i = 0
    while t < jst(2026, 11, 5, 21):
        w.opt.append(opt_row(t, mid=(100.0 + i % 7, 112.0 + i % 7, 95.0, 104.0 + i % 7), bid=100, ask=110,
                             trade=(105 if i % 5 == 0 else None), trade_iv=(20.0 if i % 5 == 0 else None)))
        t += timedelta(hours=1)
        i += 1
    w.opt.append(opt_row(jst(2026, 11, 3, 9), k=31000))  # 別の銘柄
    w.opt.append(opt_row(jst(2026, 11, 3, 9), typ=1))  # call
    return w


def make(w=None, gate=None, errors=None):
    clock = Clock(NOW)
    runner = FakeRunner(w or world(), gate=gate, errors=errors)
    return ChainService(runner, clock, monotonic=clock.monotonic), runner, clock


def body(payload):
    return json.loads(payload.json_bytes)


def test_cached_second_time_and_1d_reuses_rows(capsys):
    svc, runner, _ = make()
    first = svc.option_bars(req())
    assert runner.count("option_bars") == 1
    obj = body(first)
    assert obj["ltd"] == "2026-11-12" and obj["k"] == K and obj["type"] == "put" and obj["tf"] == "1h"
    assert len(obj["bars"]) == len([r for r in world().opt if r["target_price"] == K and r["type"] == 2])
    second = svc.option_bars(req())
    assert second.json_bytes == first.json_bytes and runner.count("option_bars") == 1
    daily = body(svc.option_bars(req("1d")))
    assert runner.count("option_bars") == 1 and runner.count("trading_calendar") == 1
    # 11-03 は休業日: 11-02 の夜間 → 11-04
    assert [b["t"][:10] for b in daily["bars"]] == ["2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06"]
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    served = [r for r in recs if r["event"] == "option_bars_served"]
    assert [s["cache"] for s in served] == ["miss", "hit", "hit"]
    out = json.dumps(served)
    assert "30000" not in out and "2026-11-12" not in out and "put" not in out


def test_single_flight_8_concurrent():
    gate = threading.Event()
    svc, runner, _ = make(gate=gate)
    results, errors = [], []
    barrier = threading.Barrier(8)

    def work():
        barrier.wait()
        try:
            results.append(svc.option_bars(req()).json_bytes)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    runner.started["option_bars"].wait(5)
    threading.Event().wait(0.2)
    gate.set()
    for t in threads:
        t.join(10)
    assert not errors and len(results) == 8 and len(set(results)) == 1
    assert runner.count("option_bars") == 1


def test_ttl_open_300s_and_settled_a_day():
    svc, runner, clock = make()
    svc.option_bars(req())
    clock.advance(st.OPTION_BARS_TTL_SECONDS - 1)
    svc.option_bars(req())
    assert runner.count("option_bars") == 1
    clock.advance(1)
    svc.option_bars(req())
    assert runner.count("option_bars") == 2
    old = req(ltd=date(2026, 10, 8))  # 確定した銘柄（取引最終日の翌日から 48 時間より後）
    svc.option_bars(old)
    clock.advance(st.OPTION_BARS_SETTLED_TTL_SECONDS - 1)
    svc.option_bars(old)
    assert runner.count("option_bars") == 3
    clock.advance(1)
    svc.option_bars(old)
    assert runner.count("option_bars") == 4


def test_unlisted_and_out_of_range_are_empty():
    svc, runner, _ = make()
    obj = body(svc.option_bars(req(k=29875)))  # 表に行の無い K: 1 回読んで 0 本
    assert obj["bars"] == [] and obj["last_at"] is None and runner.count("option_bars") == 1
    for r in (req(ltd=date(2018, 6, 14)), req(ltd=date(2027, 6, 10)), req("1d", ltd=date(2027, 6, 10))):
        obj = body(svc.option_bars(r))
        assert obj["bars"] == [] and obj["last_at"] is None
    assert runner.count("option_bars") == 1 and runner.count("trading_calendar") == 0  # 範囲の外はクエリなし


def test_bigquery_error_is_raised_and_not_cached():
    svc, runner, _ = make(errors={"option_bars": RuntimeError("boom")})
    with pytest.raises(RuntimeError):
        svc.option_bars(req())
    runner.errors.clear()
    assert body(svc.option_bars(req()))["bars"]
    assert runner.count("option_bars") == 2


def test_daily_calendar_error_and_missing_calendar():
    svc, _, _ = make(errors={"trading_calendar": RuntimeError("x")})
    with pytest.raises(RuntimeError):
        svc.option_bars(req("1d"))
    clock = Clock(NOW)
    standalone = OptionBarsService(FakeRunner(world()), clock, clock.monotonic, calendar=None)
    assert body(standalone.get(req()))["bars"]
    with pytest.raises(Unavailable):
        standalone.get(req("1d"))


def test_file_and_quotes_sources_are_unavailable(tmp_path: Path):
    with pytest.raises(Unavailable) as e:
        FileChainService(tmp_path / "c.json").option_bars(req())
    assert e.value.args == ("file_source",)
    with pytest.raises(Unavailable) as e:
        QuotesFileService(tmp_path / "q.json", tmp_path / "cal.json", Clock(NOW)).option_bars(req())
    assert e.value.args == ("quotes_source",)


# ---- アプリ ----

def app_client(w=None, errors=None, cfg=CFG):
    clock = Clock(NOW)
    runner = FakeRunner(w or world(), errors=errors)
    app = create_app(runner=runner, clock=clock, monotonic=clock.monotonic, cfg=cfg)
    return app.test_client(), runner


def test_app_ok_headers():
    client, runner = app_client()
    res = client.get("/api/option_bars", query_string=ARGS)
    assert res.status_code == 200
    assert res.headers["Content-Type"] == "application/json; charset=utf-8"
    assert res.headers["Cache-Control"] == "private, max-age=60"
    assert "ETag" not in res.headers
    obj = res.get_json()
    assert set(obj) == {"schema_version", "tf", "ltd", "k", "type", "last_at", "bars"}
    assert set(obj["bars"][0]) == {"t", "o", "h", "l", "c", "bid", "ask", "bid_iv", "ask_iv", "trade", "trade_iv"}
    assert runner.names() == ["option_bars"]  # 板・カレンダーは読まない（1h）
    settled = client.get("/api/option_bars", query_string={**ARGS, "ltd": "2026-10-08"})
    assert settled.status_code == 200 and settled.headers["Cache-Control"] == "private, max-age=3600"


@pytest.mark.parametrize("query", [
    {**ARGS, "ltd": "2026-13-01<script>"},
    {**ARGS, "k": "-1<script>"},
    {**ARGS, "type": "<script>"},
    {**ARGS, "tf": "5m<script>"},
    {k: v for k, v in ARGS.items() if k != "k"},
])
def test_app_bad_request_logs_param_only(query, capsys):
    client, runner = app_client()
    res = client.get("/api/option_bars", query_string=query)
    assert res.status_code == 400 and res.get_json() == {"error": "bad_request"}
    assert res.headers["Cache-Control"] == "no-store"
    assert b"script" not in res.data and b"2026" not in res.data
    out = capsys.readouterr().out
    assert "script" not in out and "2026-1" not in out and "30000" not in out
    rec = json.loads(out.splitlines()[-1])
    assert rec["event"] == "bad_request" and rec["endpoint"] == "option_bars"
    assert rec["param"] in ("ltd", "k", "type", "tf")
    assert runner.calls == []


def test_app_runner_error_is_503_with_type_only(capsys):
    secret = "projects/123456: bytesBilledLimitExceeded for user@example.com"
    client, _ = app_client(errors={"option_bars": RuntimeError(secret)})
    res = client.get("/api/option_bars", query_string=ARGS)
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    out = capsys.readouterr().out
    assert "123456" not in out and "example.com" not in out
    rec = [json.loads(line) for line in out.splitlines() if '"query_failed"' in line][-1]
    assert rec["endpoint"] == "option_bars" and rec["error_type"] == "RuntimeError"


@pytest.mark.parametrize("source", ["file", "quotes"])
def test_app_file_and_quotes_are_503(tmp_path, source):
    f = tmp_path / "chain.json"
    f.write_text(json.dumps(load_fixture("latest")), encoding="utf-8")
    cfg = (st.Settings(data_source="file", chain_file=f) if source == "file" else
           st.Settings(data_source="quotes", quotes_file=tmp_path / "q.json", calendar_file=tmp_path / "c.json"))
    client = create_app(cfg=cfg).test_client()
    res = client.get("/api/option_bars", query_string=ARGS)
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    assert client.get("/api/option_bars", query_string={**ARGS, "tf": "5m"}).status_code == 400


def test_response_does_not_echo_input_strings():
    client, _ = app_client()
    obj = client.get("/api/option_bars", query_string={**ARGS, "type": "call"}).get_json()
    assert obj["type"] == "call" and obj["k"] == 30000 and obj["ltd"] == "2026-11-12"
    assert datetime.fromisoformat(obj["bars"][0]["t"]).utcoffset() == timedelta(hours=9)

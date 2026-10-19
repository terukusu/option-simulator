"""中立の気配の一覧 → 板の JSON 版 1（quotes.py）と DATA_SOURCE=quotes（#154。docs/data-sources.md）。

気配の一覧は合成の板（fixtures/synthetic/*.json。架空の値）から作る。実際の API は呼ばない。
"""

import copy
import json
import re
from datetime import date, datetime, timedelta

import pytest
from conftest import REPO_ROOT
from support import SIDE_KEYS, Clock, jst, load_fixture

from simulator_api import calendar as cal_mod
from simulator_api import quotes
from simulator_api import settings as st
from simulator_api.app import create_app

CALENDAR_FILE = REPO_ROOT / "data" / "calendar" / "calendar.json"
CAL = cal_mod.from_json(json.loads(CALENDAR_FILE.read_text(encoding="utf-8")))
NOW = jst(2026, 10, 13, 21, 32)  # latest.json（21:31）の 1 分後


def quotes_from_board(fx: dict, *, source="synthetic-quotes", optional=True) -> dict:
    """板の JSON 版 1 → 中立の気配の一覧（optional=False なら bid / ask 以外の任意の項目を省く）"""
    options = []
    for m in fx["months"]:
        for r in m["rows"]:
            for typ in ("call", "put"):
                side = r[typ]
                o = {"contract_month": m["contract_month"], "type": typ, "k": r["k"], "bid": side["bid"],
                     "ask": side["ask"]}
                if optional:
                    o.update({k: side[k] for k in SIDE_KEYS if k not in ("bid", "ask")})
                options.append(o)
    out = {"quotes_version": 1, "source": source, "snapshot_at": fx["snapshot_at"],
           "delayed_minutes": fx["delayed_minutes"],
           "future": {"contract_month": fx["future"]["contract_month"], "price": fx["future"]["price"],
                      "price_time": fx["future"]["price_time"]},
           "spot": dict(fx["spot"]) if optional else None,
           "options": options}
    return out


def build(obj: dict, now: datetime = NOW) -> tuple[dict, str]:
    return quotes.chain_from_quotes(quotes.parse_quotes(obj), CAL, now)


# ---- 画面の検証（data/chainJson.ts の validateChainJson）と同じ規則 ----

ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
YEAR_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def assert_board_v1(obj: dict):
    assert obj["schema_version"] == 1
    assert ISO_INSTANT.match(obj["snapshot_at"])
    assert isinstance(obj["delayed_minutes"], int | float) and obj["delayed_minutes"] >= 0
    assert obj["reason"] in ("latest", "pre_open", "after_close", "closed")
    assert set(obj["spot"]) == {"price", "price_time"}
    fut = obj["future"]
    assert YEAR_MONTH.match(fut["contract_month"])
    assert fut["sq_date"].startswith(fut["contract_month"]) and fut["last_trading_day"] < fut["sq_date"]
    assert obj["months"], "限月が 0 本"
    prev_sq = ""
    for m in obj["months"]:
        assert YEAR_MONTH.match(m["contract_month"])
        assert ISO_DATE.match(m["last_trading_day"]) and ISO_DATE.match(m["sq_date"])
        assert m["sq_date"].startswith(m["contract_month"]) and m["last_trading_day"] < m["sq_date"]
        assert m["sq_date"] > prev_sq
        prev_sq = m["sq_date"]
        prev_k = 0
        for r in m["rows"]:
            assert isinstance(r["k"], int) and r["k"] > prev_k
            prev_k = r["k"]
            for typ in ("call", "put"):
                side = r[typ]
                assert set(side) == set(SIDE_KEYS), "キーの欠け / 余り"
                for k in ("bid", "ask", "bid_iv", "ask_iv", "price", "iv", "quotation"):
                    assert side[k] is None or (isinstance(side[k], int | float) and side[k] >= 0)
                assert side["price_time"] is None or ISO_INSTANT.match(side["price_time"])


# ---- 純関数 ----

@pytest.mark.parametrize("name", ["latest", "night_early", "pre_open"])
def test_round_trip_reproduces_board(name):
    """合成の板 → 気配の一覧 → 板 で、限月・行・先物・現物・時刻が元と一致する"""
    fx = load_fixture(name)
    now = datetime.fromisoformat(fx["snapshot_at"]) + timedelta(minutes=1)
    obj, _ = build(quotes_from_board(fx), now)
    assert_board_v1(obj)
    assert obj["months"] == fx["months"]
    assert obj["future"] == fx["future"]
    assert obj["spot"] == fx["spot"]
    assert obj["snapshot_at"] == fx["snapshot_at"]
    assert obj["delayed_minutes"] == fx["delayed_minutes"]
    assert obj["source"] == "synthetic-quotes"


def test_quotes_only_fills_missing_with_null():
    """気配だけ（任意の項目を省く・現物なし）でも版 1 の形（全キー、欠けは null）"""
    fx = load_fixture("latest")
    obj, reason = build(quotes_from_board(fx, optional=False))
    assert reason == "latest"
    assert_board_v1(obj)
    assert obj["spot"] == {"price": None, "price_time": None}
    for m, src in zip(obj["months"], fx["months"], strict=True):
        assert [r["k"] for r in m["rows"]] == [r["k"] for r in src["rows"]]
        for r, sr in zip(m["rows"], src["rows"], strict=True):
            for typ in ("call", "put"):
                assert r[typ]["bid"] == sr[typ]["bid"] and r[typ]["ask"] == sr[typ]["ask"]
                assert all(r[typ][k] is None for k in SIDE_KEYS if k not in ("bid", "ask"))


def test_dates_from_calendar():
    """限月の取引最終日・SQ 日はカレンダーの規則（第 2 金曜、休業日なら前へ）"""
    obj, _ = build(quotes_from_board(load_fixture("latest")))
    m1 = obj["months"][0]
    assert (m1["contract_month"], m1["sq_date"], m1["last_trading_day"]) == ("2026-11", "2026-11-13", "2026-11-12")
    holidays = frozenset({date(2026, 11, 13)})  # 架空の休業日: SQ 日が前に繰り上がる
    cal = cal_mod.Calendar(version_at=CAL.version_at, covered_until=CAL.covered_until, listed_until=CAL.listed_until,
                           days=tuple(cal_mod.CalendarDay(d, False, "confirmed", "架空") for d in holidays))
    obj2, _ = quotes.chain_from_quotes(quotes.parse_quotes(quotes_from_board(load_fixture("latest"))), cal, NOW)
    assert obj2["months"][0]["sq_date"] == "2026-11-12" and obj2["months"][0]["last_trading_day"] == "2026-11-11"


def test_duplicate_and_order():
    """順不同の行は限月・行使価格の昇順に、同じ (限月, K, 種別) の重複は最初の 1 件"""
    q = quotes_from_board(load_fixture("latest"))
    first = copy.deepcopy(q["options"][0])
    dup = dict(first, bid=None, ask=None)
    q["options"] = list(reversed(q["options"])) + [dup]
    q["options"].remove(first)
    q["options"].insert(0, first)
    obj, _ = build(q)
    assert_board_v1(obj)
    row = obj["months"][0]["rows"][0]
    assert row["k"] == first["k"] and row[first["type"]]["bid"] == first["bid"]


@pytest.mark.parametrize("at,now,reason", [
    (jst(2026, 10, 13, 21, 31), jst(2026, 10, 13, 21, 32), "latest"),
    (jst(2026, 10, 14, 10, 0), jst(2026, 10, 14, 10, 40), "latest"),
    (jst(2026, 10, 14, 15, 45), jst(2026, 10, 14, 15, 50), "after_close"),
    (jst(2026, 10, 14, 8, 40), jst(2026, 10, 14, 8, 42), "pre_open"),
    (jst(2026, 10, 13, 21, 31), jst(2026, 10, 13, 22, 30), "closed"),
])
def test_reason(at, now, reason):
    assert quotes.reason_at(at, now) == reason


def test_unusable_board():
    q = quotes_from_board(load_fixture("latest"))
    q["future"]["price"] = None
    with pytest.raises(quotes.QuotesUnusable):
        build(q)
    q = quotes_from_board(load_fixture("latest"))
    for o in q["options"]:
        o["ask"] = None  # 両側気配なし
    with pytest.raises(quotes.QuotesUnusable):
        build(q)


SECRET = "SECRET-VALUE-9301"


@pytest.mark.parametrize("mutate,where", [
    (lambda q: q.update(quotes_version=2), "$.quotes_version"),
    (lambda q: q.update(quotes_version=True), "$.quotes_version"),
    (lambda q: q.update(snapshot_at="2026-10-13T21:31:00"), "$.snapshot_at"),  # オフセットなし
    (lambda q: q.pop("delayed_minutes"), "$.delayed_minutes"),
    (lambda q: q.update(source=SECRET + " <b>"), "$.source"),
    (lambda q: q["future"].update(contract_month="2026-13"), "$.future.contract_month"),
    (lambda q: q.update(options=[]), "$.options"),
    (lambda q: q["options"][3].update(type=SECRET), "$.options[3].type"),
    (lambda q: q["options"][3].update(k=67812.5), "$.options[3].k"),
    (lambda q: q["options"][3].update(bid=SECRET), "$.options[3].bid"),
    (lambda q: q["options"][3].update(ask=True), "$.options[3].ask"),
    (lambda q: q["options"][3].update(ask=-1), "$.options[3].ask"),
    (lambda q: q["options"][3].pop("bid"), "$.options[3].bid"),
    (lambda q: q["options"][3].update(volume=1.5), "$.options[3].volume"),
    (lambda q: q["options"][3].update(price_time=SECRET), "$.options[3].price_time"),
    (lambda q: q["options"][3].update(quotation_date="2026-02-30"), "$.options[3].quotation_date"),
    (lambda q: q["options"][3].update(is_atm="yes"), "$.options[3].is_atm"),
])
def test_invalid_input_reports_path_only(mutate, where):
    q = quotes_from_board(load_fixture("latest"))
    mutate(q)
    with pytest.raises(quotes.QuotesError) as e:
        quotes.parse_quotes(q)
    assert str(e.value).startswith(where)
    assert SECRET not in str(e.value)


def test_unknown_keys_ignored_and_optional_omitted():
    q = quotes_from_board(load_fixture("latest"), optional=False)
    q["extra"] = {"x": 1}
    q["options"][0]["broker_code"] = "abc"
    del q["spot"]
    q.pop("source")
    obj, _ = build(q)
    assert obj["source"] == quotes.DEFAULT_SOURCE
    assert_board_v1(obj)


# ---- カレンダーのファイル（calendar.from_json） ----

def test_calendar_from_json_round_trip():
    raw = json.loads(CALENDAR_FILE.read_text(encoding="utf-8"))
    out = cal_mod.calendar_json(CAL, source=raw["source"])
    assert out == raw


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(schema_version=2),
    lambda c: c.update(version_at="2026-10-14T08:39:40"),
    lambda c: c.update(covered_until="2027-02-30"),
    lambda c: c["days"].reverse(),
    lambda c: c["days"][0].update(is_trading_day="no"),
    lambda c: c["days"][0].update(status=""),
])
def test_calendar_from_json_rejects(mutate):
    raw = json.loads(CALENDAR_FILE.read_text(encoding="utf-8"))
    mutate(raw)
    with pytest.raises(ValueError):
        cal_mod.from_json(raw)


# ---- DATA_SOURCE=quotes（app） ----

def quotes_app(tmp_path, q: dict | str, calendar_file=CALENDAR_FILE):
    qf = tmp_path / "quotes.json"
    qf.write_text(q if isinstance(q, str) else json.dumps(q), encoding="utf-8")
    cfg = st.Settings(data_source="quotes", quotes_file=qf, calendar_file=calendar_file)
    clock = Clock(NOW)
    return create_app(cfg=cfg, clock=clock, monotonic=clock.monotonic).test_client(), qf


def test_quotes_source_endpoints(tmp_path):
    fx = load_fixture("latest")
    client, _ = quotes_app(tmp_path, quotes_from_board(fx))
    res = client.get("/api/chain")
    assert res.status_code == 200
    body = res.get_json()
    assert body["months"] == fx["months"] and body["reason"] == "latest" and body["source"] == "synthetic-quotes"
    assert res.headers["Cache-Control"] == "private, max-age=60"
    cal = client.get("/api/calendar")
    assert cal.status_code == 200
    assert cal.get_json()["source"] == "file" and cal.get_json()["version_at"] == "2026-10-14T08:39:40+09:00"
    assert cal.headers["ETag"]
    assert client.get("/api/calendar", headers={"If-None-Match": cal.headers["ETag"]}).status_code == 304
    assert client.get("/api/atm_iv?tf=1h").status_code == 503
    assert client.get("/api/atm_daily").status_code == 503


def test_quotes_source_errors_are_503_without_values(tmp_path, capsys):
    q = quotes_from_board(load_fixture("latest"))
    q["options"][0]["bid"] = SECRET
    client, qf = quotes_app(tmp_path, q)
    res = client.get("/api/chain")
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"}
    out = capsys.readouterr().out
    assert SECRET not in out and "quotes_file_invalid" in out
    qf.write_text("{not json", encoding="utf-8")
    assert client.get("/api/chain").status_code == 503
    qf.unlink()
    assert client.get("/api/chain").status_code == 503
    q = quotes_from_board(load_fixture("latest"))
    q["future"]["price"] = None
    qf.write_text(json.dumps(q), encoding="utf-8")
    assert client.get("/api/chain").status_code == 503


def test_future_snapshot_rejected():
    """snapshot_at が今 + 5 分を超える未来なら不正（時計・オフセットの誤り）。5 分ちょうどまでは通す"""
    q = quotes_from_board(load_fixture("latest"))  # 21:31
    build(q, jst(2026, 10, 13, 21, 26))  # 5 分先 = 上限ちょうど
    with pytest.raises(quotes.QuotesError) as e:
        build(q, jst(2026, 10, 13, 21, 25, 59))
    assert str(e.value).startswith("$.snapshot_at")


def test_quotes_source_future_snapshot_is_503(tmp_path):
    q = quotes_from_board(load_fixture("latest"))
    q["snapshot_at"] = "2026-10-13T22:00:00+09:00"  # NOW（21:32）の 28 分先
    client, _ = quotes_app(tmp_path, q)
    assert client.get("/api/chain").status_code == 503


@pytest.mark.parametrize("which", ["quotes", "calendar"])
def test_quotes_source_file_size_limit(tmp_path, monkeypatch, capsys, which):
    """QUOTES_FILE・CALENDAR_FILE が上限を超えたら読まずに 503（上限ちょうどは読む）"""
    cf = tmp_path / "calendar.json"
    cf.write_bytes(CALENDAR_FILE.read_bytes())
    client, qf = quotes_app(tmp_path, quotes_from_board(load_fixture("latest")), calendar_file=cf)
    limit = max(qf.stat().st_size, cf.stat().st_size) + 100
    monkeypatch.setattr(st, "QUOTES_MAX_FILE_BYTES", limit)
    target = qf if which == "quotes" else cf
    pad = limit - target.stat().st_size
    with target.open("a", encoding="utf-8") as f:
        f.write(" " * pad)  # 上限ちょうど（JSON としては同じ）
    assert target.stat().st_size == limit
    assert client.get("/api/chain").status_code == 200
    with target.open("a", encoding="utf-8") as f:
        f.write(" ")  # 上限 + 1 バイト
    read = []
    orig = type(target).read_bytes
    monkeypatch.setattr(type(target), "read_bytes", lambda self: (read.append(self), orig(self))[1])
    assert client.get("/api/chain").status_code == 503
    assert target not in read  # 上限を超えたファイルは読まない
    assert "file_too_large" in capsys.readouterr().out
    if which == "calendar":
        assert client.get("/api/calendar").status_code == 503

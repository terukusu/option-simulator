"""先物推移（/api/future_bars、#190）の純粋な関数と SQL の静的検査（AC-1・AC-2）。値はすべて架空。"""

import re
from datetime import UTC, date, datetime, timedelta

import pytest
from conftest import PKG_DIR
from support import calendar_rows, fut_bars, fut_row, jst
from werkzeug.datastructures import MultiDict

from simulator_api import atm_iv, contract, future_bars
from simulator_api import calendar as cal_mod
from simulator_api import settings as st

NOW = jst(2026, 12, 10, 21, 46)  # 木曜（12 月限の取引最終日）の夜間
CAP = datetime(2026, 12, 11, tzinfo=UTC)
CAL = cal_mod.from_rows(calendar_rows())
NON_TRADING = atm_iv.non_trading_days(CAL)
SQ_HOLIDAYS = CAL.holidays
FAR = (datetime(2000, 1, 1, tzinfo=UTC), datetime(2100, 1, 1, tzinfo=UTC))


def sql_body():
    text = (PKG_DIR / "sql" / "future_bars.sql").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


# ---- SQL（AC-2） ----

def test_sql_reads_table_function_with_declared_columns():
    body = re.sub(r"\s+", " ", sql_body())
    cols = ", ".join(contract.column_names("future_bars"))
    assert f"SELECT {cols} FROM `${{project}}.${{dataset}}.future_price_latest`(@start_at, @end_at)" in body
    assert contract.column_names("future_bars") == ("created_at", "price", "price_time", "contract_month")
    assert "*" not in body
    assert "CURRENT_TIMESTAMP" not in body.upper() and "CURRENT_DATE" not in body.upper()
    assert re.findall(r"`([^`]*)`", body) == ["${project}.${dataset}.future_price_latest"]
    assert set(re.findall(r"@(\w+)", body)) == {"start_at", "end_at", "step"}


def test_sql_cuts_by_price_time_and_drops_bad_prices():
    body = re.sub(r"\s+", " ", sql_body())
    assert "WHERE price > 0 AND price_time IS NOT NULL" in body
    assert "TIMESTAMP(price_time, 'Asia/Tokyo') AS traded_at" in body
    assert "MOD(UNIX_SECONDS(traded_at), @step)) AS started_at" in body
    assert "ARRAY_AGG(price ORDER BY traded_at, created_at LIMIT 1)[OFFSET(0)] AS open" in body
    assert "ARRAY_AGG(price ORDER BY traded_at DESC, created_at DESC LIMIT 1)[OFFSET(0)] AS close" in body
    assert "MAX(price) AS high" in body and "MIN(price) AS low" in body
    assert "MAX(created_at) AS last_at" in body and "MAX(contract_month) AS contract_month" in body
    assert "GROUP BY started_at ORDER BY started_at" in body
    assert [c for c, _ in contract.output_columns("future_bars")] == [
        "started_at", "open", "high", "low", "close", "last_at", "contract_month"]
    assert st.QUERY_MAX_BYTES_BILLED["future_bars"] == 64 * st.MiB


# ---- 要求（/api/atm_iv と同じ。AC-1） ----

def req(**args):
    return atm_iv.parse_request(MultiDict(args), NOW)


@pytest.mark.parametrize("args,param", [
    ({}, "tf"),
    ({"tf": "5m"}, "tf"),
    ({"tf": "1h", "start": "2026-09-01T00:00:00Z"}, "end"),
    ({"tf": "1h", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1h", "start": "2026-09-01T00:00:00", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1h", "start": "2026-09-01T03:00:00Z", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1m", "start": "2026-09-01T00:00:00Z", "end": "2026-09-05T00:00:00Z"}, "range"),
    ({"tf": "1d", "start": "2009-12-31T00:00:00Z", "end": "2010-02-01T00:00:00Z"}, "start"),
])
def test_bad_requests_same_as_atm_iv(args, param):
    with pytest.raises(atm_iv.BadRequest) as e:
        req(**args)
    assert e.value.param == param


def test_read_window_adds_minutes_after_end():
    r = req(tf="1h", start="2026-09-01T00:00:00Z", end="2026-10-01T00:00:00Z")
    after = timedelta(minutes=st.FUTURE_BARS_READ_AFTER_MINUTES)
    assert future_bars.read_window(r, NOW) == (r.start, r.end + after, 3600, r.end)
    assert future_bars.read_window(req(tf="1m"), NOW)[2] == 60
    d = req(tf="1d", start="2026-01-01T00:00:00Z", end="2026-10-01T00:00:00Z")
    assert future_bars.read_window(d, NOW) == (d.start - timedelta(days=10), d.end + timedelta(days=1) + after, 3600,
                                               d.end + timedelta(days=1))
    assert future_bars.read_window(req(tf="1d"), NOW)[3] == CAP  # 右端は明日の UTC の 0 時まで


# ---- 足（AC-1） ----

def bars(rows, step, lo=FAR[0], hi=FAR[1]):
    return future_bars.bars_from_rows(fut_bars(rows, step), lo, hi)


def test_minute_and_hour_ohlc_by_price_time():
    t0 = jst(2026, 10, 13, 10, 0)
    prices = [30000.0, 30050.0, 29950.0, 30010.0]
    rows = [fut_row(t0 + timedelta(minutes=i, seconds=40), p) for i, p in enumerate(prices)]
    hour, last_at = bars(rows, 3600)
    assert len(hour) == 1
    b = hour[0]
    assert (b["started_at"], b["open"], b["high"], b["low"], b["close"]) == (t0, 30000.0, 30050.0, 29950.0, 30010.0)
    assert last_at == t0 + timedelta(minutes=3, seconds=40)
    minute, _ = bars(rows, 60)
    assert [(m["started_at"], m["open"], m["close"]) for m in minute] == [
        (t0 + timedelta(minutes=i), p, p) for i, p in enumerate(prices)]


def test_late_created_at_goes_to_the_traded_minute():
    # created_at が 2 分遅れても足は price_time の分。同じ分の 2 行は created_at の順で始値 / 終値
    t0 = jst(2026, 10, 13, 10, 0)
    rows = [fut_row(t0 + timedelta(minutes=2), 30000.0, traded=t0), fut_row(t0 + timedelta(minutes=3), 30020.0,
                                                                            traded=t0)]
    minute, _ = bars(rows, 60)
    assert [(m["started_at"], m["open"], m["close"]) for m in minute] == [(t0, 30000.0, 30020.0)]


def test_stale_rows_do_not_make_new_bars():
    # 金曜の 15:45 の値が週末まで止まる（price_time が古いまま）: 新しい足を作らず、前の足に入る
    fri = jst(2026, 10, 16, 15, 45)
    rows = [fut_row(fri, 30100.0)]
    rows += [fut_row(fri + timedelta(hours=h), 30100.0, traded=fri) for h in range(1, 40)]
    hour, last_at = bars(rows, 3600)
    assert [b["started_at"] for b in hour] == [jst(2026, 10, 16, 15, 0)]
    minute, _ = bars(rows, 60)
    assert [b["started_at"] for b in minute] == [fri]
    assert last_at == fri + timedelta(hours=39)


def test_bars_outside_range_are_dropped():
    t0 = jst(2026, 10, 13, 9, 0)  # = UTC 0 時
    rows = [fut_row(t0 - timedelta(minutes=1), 30000.0), fut_row(t0, 30010.0), fut_row(t0 + timedelta(hours=1),
                                                                                     30020.0)]
    # 足の上限の直前（08:59 の約定）が上限の後に取り込まれた行は残し、上限以後の足は捨てる
    rows.append(fut_row(t0 + timedelta(minutes=1), 30005.0, traded=t0 - timedelta(minutes=1)))
    minute, last_at = bars(rows, 60, t0 - timedelta(hours=1), t0)
    assert [(b["started_at"], b["close"]) for b in minute] == [(t0 - timedelta(minutes=1), 30005.0)]
    assert last_at is None  # 読み足しの分（上限以後の created_at）は数えない
    minute, _ = bars(rows, 60, t0, t0 + timedelta(hours=1))
    assert [b["started_at"] for b in minute] == [t0]


@pytest.mark.parametrize("price", [None, 0.0, -1.0])
def test_null_and_non_positive_prices_are_dropped(price):
    t0 = jst(2026, 10, 13, 10, 0)
    rows = [fut_row(t0, price), fut_row(t0 + timedelta(minutes=1), 30000.0)]
    minute, _ = bars(rows, 60)
    assert [b["started_at"] for b in minute] == [t0 + timedelta(minutes=1)]
    # SQL の行に入ってしまった値（有限でない・0 以下）も捨てる
    bad = {"started_at": t0, "open": price, "high": 1.0, "low": 1.0, "close": 1.0, "last_at": t0,
           "contract_month": date(2026, 12, 1)}
    assert future_bars.bars_from_rows([bad], *FAR) == ([], None)
    nan = dict(bad, open=float("nan"))
    assert future_bars.bars_from_rows([nan], *FAR) == ([], None)


# ---- 限月（AC-1） ----

def test_front_contract_rolls_after_last_trading_day():
    # 合成のカレンダー: 12 月限の SQ = 12/11（金）、取引最終日 = 12/10（木）
    assert cal_mod.last_trading_day(2026, 12, SQ_HOLIDAYS) == date(2026, 12, 10)
    assert future_bars.front_contract(date(2026, 12, 10), SQ_HOLIDAYS) == (2026, 12)
    assert future_bars.front_contract(date(2026, 12, 11), SQ_HOLIDAYS) == (2027, 3)
    assert future_bars.front_contract(date(2026, 10, 1), SQ_HOLIDAYS) == (2026, 12)
    assert future_bars.front_contract(date(2026, 12, 28), SQ_HOLIDAYS) == (2027, 3)
    assert future_bars.front_contract(date(2027, 1, 4), SQ_HOLIDAYS) == (2027, 3)


def with_m(rows, step, raw=date(2026, 12, 1)):
    for r in rows:
        r["contract_month"] = raw
    b, _ = bars(rows, step)
    return future_bars.with_contracts(b, NON_TRADING, SQ_HOLIDAYS)


def test_roll_at_17_on_last_trading_day():
    thu = jst(2026, 12, 10, 16, 59)
    rows = [fut_row(thu, 30000.0), fut_row(thu + timedelta(minutes=1), 30090.0)]  # 16:59・17:00
    got = [(b["started_at"], b["m"]) for b in with_m(rows, 60)]
    assert got == [(thu, "2026-12"), (thu + timedelta(minutes=1), "2027-03")]
    hours = [(b["started_at"], b["m"]) for b in with_m(rows, 3600)]
    assert hours == [(jst(2026, 12, 10, 16, 0), "2026-12"), (jst(2026, 12, 10, 17, 0), "2027-03")]


def test_raw_contract_month_one_year_ahead_is_ignored():
    # SQ のある月の 1 日〜取引最終日に生の contract_month が 1 年先になる行（2027-12）でも m は 2026-12
    rows = [fut_row(jst(2026, 12, 3, 10, 0), 30000.0)]
    out = with_m(rows, 60, raw=date(2027, 12, 1))
    assert [b["m"] for b in out] == ["2026-12"]
    assert future_bars.contract_mismatches(out) == 1
    assert future_bars.contract_mismatches(with_m(rows, 60)) == 0


def test_daily_trading_days_and_contracts():
    # 夜間は次の取引日、休業日（11/3）を飛ばす。日足の限月は取引日から
    sessions = [
        (jst(2026, 10, 29, 20, 0), 30000.0),  # 木曜の夜間 → 金曜 10/30（読んだ範囲の先頭の取引日 10/29 は捨てる）
        (jst(2026, 10, 30, 9, 0), 30100.0),
        (jst(2026, 10, 30, 20, 0), 30200.0),  # 金曜の夜間 → 月曜 11/2
        (jst(2026, 11, 2, 10, 0), 30150.0),
        (jst(2026, 11, 2, 21, 0), 30300.0),  # 休業日 11/3 の前の夜間 → 11/4
        (jst(2026, 11, 4, 10, 0), 30250.0),
        (jst(2026, 12, 10, 10, 0), 31000.0),  # 取引最終日の日中 → 12/10（旧限月）
        (jst(2026, 12, 10, 18, 0), 31100.0),  # 取引最終日の夜間 → 12/11（新限月）
    ]
    rows = [fut_row(t + timedelta(minutes=i), p + i) for t, p in sessions for i in range(3)]
    hourly, _ = bars(rows, 3600)
    r = atm_iv.AtmIvRequest("1d", datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 12, 20, tzinfo=UTC))
    days = future_bars.daily_bars(hourly, NON_TRADING, r, jst(2026, 10, 29, 16, 0), jst(2026, 12, 20, 0, 0))
    out = future_bars.with_contracts(days, NON_TRADING, SQ_HOLIDAYS, daily=True)
    got = [(b["started_at"].astimezone(atm_iv.JST).date(), b["open"], b["close"], b["m"]) for b in out]
    assert got == [
        (date(2026, 10, 30), 30000.0, 30102.0, "2026-12"),
        (date(2026, 11, 2), 30200.0, 30152.0, "2026-12"),
        (date(2026, 11, 4), 30300.0, 30252.0, "2026-12"),
        (date(2026, 12, 10), 31000.0, 31002.0, "2026-12"),
        (date(2026, 12, 11), 31100.0, 31102.0, "2027-03"),
    ]


def test_json_shape():
    t0 = jst(2026, 12, 10, 10, 0)
    rows = [fut_row(t0 + timedelta(minutes=i), 30000.5 + i) for i in range(3)]
    b, last_at = bars(rows, 3600)
    out = future_bars.with_contracts(b, NON_TRADING, SQ_HOLIDAYS)
    obj = future_bars.future_bars_json(req(tf="1h"), NOW.replace(microsecond=5), out, last_at)
    assert obj == {
        "schema_version": 1, "tf": "1h",
        "start": "2026-10-12T09:00:00+09:00",
        "end": "2026-12-10T21:46:00+09:00",
        "last_at": "2026-12-10T10:02:00+09:00",
        "bars": [{"t": "2026-12-10T10:00:00+09:00", "o": 30000.5, "h": 30002.5, "l": 30000.5, "c": 30002.5,
                  "m": "2026-12"}],
    }

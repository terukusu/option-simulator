"""板の JSON（版 1。docs/design.md 7.1・data/chainTypes.ts）の組み立て。値は架空。"""

import json
from datetime import UTC, date, datetime

from support import CALENDAR_DAYS, calendar_rows, jst, option_row

from simulator_api import calendar, chain

SNAP = jst(2026, 10, 13, 21, 31)
M1, M2 = date(2026, 11, 12), date(2026, 12, 10)
CAL = calendar.from_rows(calendar_rows())
FUTURE = {"price": 30010.0, "price_time": datetime(2026, 10, 13, 21, 25), "contract_month": date(2026, 12, 1)}
SPOT = {"price": 29900.5, "price_time": datetime(2026, 10, 13, 15, 45)}


def build(rows, future=FUTURE, spot=SPOT, reason="latest", cal=CAL):
    board = chain.parse_board(rows)
    return chain.chain_json(SNAP, reason, board, future, spot, cal)


def test_shape_and_times():
    rows = [
        option_row(SNAP, 1, 30000, M1, bid=500, ask=510, bid_iv=20.5, ask_iv=21.25, price=505,
                   price_time=datetime(2026, 10, 13, 20, 32), iv=20.9, volume=3, positions=10, quotation=500,
                   quotation_date=date(2026, 10, 13), delta=0.5, gamma=0.0001, theta=-5.0, vega=40.0, is_atm=True),
        option_row(SNAP, 2, 30000, M1, bid=480, ask=490, is_atm=False),
    ]
    j = build(rows)
    assert list(j) == ["schema_version", "snapshot_at", "delayed_minutes", "reason", "source", "spot", "future",
                       "months"]
    assert j["schema_version"] == 1
    assert j["snapshot_at"] == "2026-10-13T21:31:00+09:00"
    assert j["delayed_minutes"] == 15
    assert (j["reason"], j["source"]) == ("latest", "bigquery")
    assert j["spot"] == {"price": 29900.5, "price_time": "2026-10-13T15:45:00+09:00"}
    assert j["future"] == {"price": 30010.0, "price_time": "2026-10-13T21:25:00+09:00", "contract_month": "2026-12",
                           "last_trading_day": "2026-12-10", "sq_date": "2026-12-11"}
    [m] = j["months"]
    assert (m["contract_month"], m["last_trading_day"], m["sq_date"]) == ("2026-11", "2026-11-12", "2026-11-13")
    [row] = m["rows"]
    assert row["k"] == 30000
    assert row["call"] == {"bid": 500, "ask": 510, "bid_iv": 20.5, "ask_iv": 21.25, "price": 505,
                           "price_time": "2026-10-13T20:32:00+09:00", "iv": 20.9, "volume": 3, "positions": 10,
                           "quotation": 500, "quotation_date": "2026-10-13", "delta": 0.5, "gamma": 0.0001,
                           "theta": -5.0, "vega": 40.0, "is_atm": True}
    assert row["put"]["bid"] == 480 and row["put"]["price_time"] is None and row["put"]["is_atm"] is False
    # JSON にできる（date・datetime が残っていない）
    json.dumps(j)


def test_snapshot_at_is_jst_even_across_utc_date():
    j = chain.chain_json(datetime(2026, 10, 13, 23, 59, tzinfo=UTC), "latest",
                         chain.parse_board([option_row(SNAP, 1, 30000, M1)]), FUTURE, SPOT, CAL)
    assert j["snapshot_at"] == "2026-10-14T08:59:00+09:00"


def test_rows_sorted_and_missing_side_is_all_null():
    rows = [
        option_row(SNAP, 2, 30125, M1, bid=1, ask=2),
        option_row(SNAP, 1, 30000, M1, bid=3, ask=4),
        option_row(SNAP, 1, 30000, M2, bid=5, ask=6),
    ]
    j = build(rows)
    assert [m["contract_month"] for m in j["months"]] == ["2026-11", "2026-12"]
    m1 = j["months"][0]
    assert [r["k"] for r in m1["rows"]] == [30000, 30125]
    assert set(m1["rows"][0]["put"].values()) == {None}
    assert len(m1["rows"][0]["put"]) == 16
    assert set(m1["rows"][1]["call"].values()) == {None}


def test_null_type_dropped_and_duplicates_keep_first(capsys):
    rows = [
        option_row(SNAP, 1, 30000, M1, bid=3, ask=4),
        option_row(SNAP, 1, 30000, M1, bid=99, ask=99),
        option_row(SNAP, None, 30000, M1, bid=98, ask=98),
    ]
    j = build(rows)
    [row] = j["months"][0]["rows"]
    assert row["call"]["bid"] == 3
    logs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    events = {e["event"]: e for e in logs}
    assert events["board_rows_dropped"]["null_type"] == 1
    assert events["board_rows_dropped"]["duplicates"] == 1
    # 値（価格）はログに出さない
    assert "99" not in json.dumps(logs) and "98" not in json.dumps(logs)


def test_spot_missing_is_null():
    j = build([option_row(SNAP, 1, 30000, M1)], spot=None)
    assert j["spot"] == {"price": None, "price_time": None}


def test_sq_date_from_calendar_and_mismatch_logged(capsys):
    # 合成のカレンダーに 11/13（第 2 金曜）を休業日として足す → 規則の SQ 日は 11/12、取引最終日は 11/11。
    # 板の取引最終日（11/12）と違うので calendar_mismatch（限月の ID だけ）を出し、値は板のまま・SQ 日は規則
    cal = calendar.from_rows(calendar_rows((*CALENDAR_DAYS, (date(2026, 11, 13), False, "confirmed", "休日 X"))))
    j = build([option_row(SNAP, 1, 30000, M1)], cal=cal)
    m = j["months"][0]
    assert (m["last_trading_day"], m["sq_date"]) == ("2026-11-12", "2026-11-12")
    out = capsys.readouterr().out
    rec = json.loads(out.splitlines()[0])
    assert rec["event"] == "calendar_mismatch" and rec["severity"] == "WARNING"
    assert rec["contract_month"] == "2026-11"


def test_no_mismatch_log_when_consistent(capsys):
    build([option_row(SNAP, 1, 30000, M1), option_row(SNAP, 1, 30000, M2)])
    assert "calendar_mismatch" not in capsys.readouterr().out


def test_price_time_aware_values_are_converted_to_jst():
    rows = [option_row(SNAP, 1, 30000, M1, price_time=datetime(2026, 10, 13, 11, 32, tzinfo=UTC))]
    assert build(rows)["months"][0]["rows"][0]["call"]["price_time"] == "2026-10-13T20:32:00+09:00"

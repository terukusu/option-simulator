"""IV 推移（/api/atm_iv、#79）の純粋な関数と SQL の静的検査（AC2・AC3・AC4）。値はすべて架空。"""

import re
from datetime import UTC, date, datetime, timedelta

import pytest
from conftest import PKG_DIR
from support import calendar_rows, cm_bars, cm_rows, jst
from werkzeug.datastructures import MultiDict

from simulator_api import atm_iv
from simulator_api import calendar as cal_mod
from simulator_api import settings as st

NOW = jst(2026, 10, 13, 21, 46)  # 火曜の夜間
CAP = datetime(2026, 10, 14, tzinfo=UTC)  # utc_day(NOW) + 1 日


def sql_body(name="atm_cm_iv"):
    text = (PKG_DIR / "sql" / f"{name}.sql").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


# ---- SQL（AC2） ----

def test_atm_cm_iv_sql_filters_partition():
    # requirePartitionFilter の無い表なので、created_at の半開区間の絞りを必ず書く。値はパラメータだけ
    body = re.sub(r"\s+", " ", sql_body())
    assert "WHERE created_at >= @start_at AND created_at < @end_at" in body
    assert "CURRENT_TIMESTAMP" not in body.upper() and "CURRENT_DATE" not in body.upper()
    assert "*" not in body
    # 読む表は 1 つだけ・識別子は ${project}.${dataset} だけ
    assert re.findall(r"`([^`]*)`", body) == ["${project}.${dataset}.atm_cm_iv"]
    assert set(re.findall(r"@(\w+)", body)) == {"start_at", "end_at", "step"}


def test_atm_cm_iv_sql_aggregation():
    # open / close = 時間順で最初 / 最後の NULL でない値、high / low = 最大 / 最小、last_at は NULL の行を含めた最大
    body = re.sub(r"\s+", " ", sql_body())
    assert "ARRAY_AGG(iv30 IGNORE NULLS ORDER BY created_at LIMIT 1)[SAFE_OFFSET(0)] AS open" in body
    assert "ARRAY_AGG(iv30 IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS close" in body
    assert "MAX(iv30) AS high" in body and "MIN(iv30) AS low" in body
    assert "MAX(created_at) AS last_at" in body
    assert "GROUP BY started_at ORDER BY started_at" in body


# ---- 要求の検査（AC3） ----

def req(**args):
    return atm_iv.parse_request(MultiDict(args), NOW)


def test_default_is_right_edge():
    for tf, days in (("1m", 3), ("1h", 60), ("1d", 365)):
        r = req(tf=tf)
        assert (r.tf, r.end, r.start) == (tf, CAP, CAP - timedelta(days=days))
        assert st.ATM_IV_TIMEFRAMES[tf][2] == days


@pytest.mark.parametrize("tf,max_days", [("1m", 3), ("1h", 100), ("1d", 400)])
def test_max_range_boundary(tf, max_days):
    end = datetime(2026, 9, 1, tzinfo=UTC)
    ok = req(tf=tf, start=(end - timedelta(days=max_days)).isoformat(), end=end.isoformat())
    assert ok.end - ok.start == timedelta(days=max_days)
    with pytest.raises(atm_iv.BadRequest) as e:
        req(tf=tf, start=(end - timedelta(days=max_days + 1)).isoformat(), end=end.isoformat())
    assert e.value.param == "range"


def test_offsets_and_z_are_accepted():
    a = req(tf="1h", start="2026-09-01T00:00:00Z", end="2026-09-02T09:00:00+09:00")
    assert a.start == datetime(2026, 9, 1, tzinfo=UTC) and a.end == datetime(2026, 9, 2, tzinfo=UTC)


def test_future_end_is_clamped_not_rejected():
    r = req(tf="1m", start="2026-10-12T00:00:00Z", end="2026-10-20T00:00:00Z")
    assert r.end == CAP and r.start == datetime(2026, 10, 12, tzinfo=UTC)


@pytest.mark.parametrize("args,param", [
    ({}, "tf"),
    ({"tf": "5m"}, "tf"),
    ({"tf": "1H"}, "tf"),
    ({"tf": " 1h"}, "tf"),
    ({"tf": "1h", "start": "2026-09-01T00:00:00Z"}, "end"),
    ({"tf": "1h", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1h", "start": "2026-09-01T00:00:00", "end": "2026-09-02T00:00:00Z"}, "start"),  # オフセットなし
    ({"tf": "1h", "start": "2026-09-01T00:00:00.000Z", "end": "2026-09-02T00:00:00Z"}, "start"),  # 小数秒
    ({"tf": "1h", "start": "2026-09-01 00:00:00Z", "end": "2026-09-02T00:00:00Z"}, "start"),  # 空白
    ({"tf": "1h", "start": "2026-09-01T00:00:00Z\n", "end": "2026-09-02T00:00:00Z"}, "start"),  # 改行
    ({"tf": "1h", "start": "2026-09-01", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1h", "start": "1788220800", "end": "2026-09-02T00:00:00Z"}, "start"),  # UNIX 秒
    ({"tf": "1h", "start": "2026-09-01T00:00:00+09:00", "end": "2026-09-02T00:00:00Z"}, "start"),  # UTC 0 時でない
    ({"tf": "1h", "start": "2026-09-01T00:00:00Z", "end": "2026-09-02T00:00:01Z"}, "end"),
    ({"tf": "1h", "start": "2026-02-30T00:00:00Z", "end": "2026-03-02T00:00:00Z"}, "start"),  # 無い日
    ({"tf": "1h", "start": "2026-09-02T00:00:00Z", "end": "2026-09-02T00:00:00Z"}, "start"),  # start = end
    ({"tf": "1h", "start": "2026-09-03T00:00:00Z", "end": "2026-09-02T00:00:00Z"}, "start"),
    ({"tf": "1d", "start": "2009-12-31T00:00:00Z", "end": "2010-02-01T00:00:00Z"}, "start"),  # EPOCH より前
    ({"tf": "1h", "start": "2026-10-15T00:00:00Z", "end": "2026-10-16T00:00:00Z"}, "start"),  # 縮めた end 以降
])
def test_bad_requests(args, param):
    with pytest.raises(atm_iv.BadRequest) as e:
        req(**args)
    assert e.value.param == param


def test_epoch_is_accepted():
    r = req(tf="1d", start="2010-01-01T00:00:00Z", end="2010-02-01T00:00:00Z")
    assert r.start == atm_iv.EPOCH


def test_repeated_params_are_rejected():
    with pytest.raises(atm_iv.BadRequest) as e:
        atm_iv.parse_request(MultiDict([("tf", "1h"), ("tf", "1d")]), NOW)
    assert e.value.param == "tf"


def test_settled():
    old = req(tf="1h", start="2026-09-01T00:00:00Z", end="2026-10-11T00:00:00Z")
    assert atm_iv.is_settled(old, NOW)  # 2 日 21 時間前
    assert not atm_iv.is_settled(req(tf="1h"), NOW)
    near = req(tf="1h", start="2026-09-01T00:00:00Z", end="2026-10-12T00:00:00Z")
    assert not atm_iv.is_settled(near, NOW)  # 45 時間前（作り直しの範囲にかかりうる）


def test_read_window():
    r = req(tf="1h", start="2026-09-01T00:00:00Z", end="2026-10-01T00:00:00Z")
    assert atm_iv.read_window(r, NOW) == (r.start, r.end, 3600)
    assert atm_iv.read_window(req(tf="1m"), NOW)[2] == 60
    d = req(tf="1d", start="2026-01-01T00:00:00Z", end="2026-10-01T00:00:00Z")
    assert atm_iv.read_window(d, NOW) == (d.start - timedelta(days=10), d.end + timedelta(days=1), 3600)
    right = req(tf="1d")
    assert atm_iv.read_window(right, NOW)[1] == CAP  # 右端は明日の UTC の 0 時まで


# ---- 束ね方（AC4） ----

def hourly(points):
    rows = cm_bars(points, 3600)
    return atm_iv.bars_from_rows(rows, datetime(2000, 1, 1, tzinfo=UTC), datetime(2100, 1, 1, tzinfo=UTC))


def test_minute_and_hour_ohlc_use_first_last_non_null_and_extremes():
    t0 = jst(2026, 10, 13, 10, 0)
    values = [None, 21.5, 23.0, None, 19.25, 22.0, None]  # 先頭・末尾は NULL
    points = [(t0 + timedelta(minutes=i), v) for i, v in enumerate(values)]
    bars, last_at = hourly(points)
    assert len(bars) == 1
    b = bars[0]
    assert (b["open"], b["high"], b["low"], b["close"]) == (21.5, 23.0, 19.25, 22.0)
    assert b["started_at"] == t0  # JST の正時 = UNIX 秒で切った時刻
    assert last_at == t0 + timedelta(minutes=6)  # NULL の行も含めた最後
    minute = atm_iv.bars_from_rows(cm_bars(points, 60), t0, t0 + timedelta(hours=1))[0]
    assert [(m["open"], m["close"]) for m in minute] == [(v, v) for v in values if v is not None]


def test_all_null_bar_is_dropped_but_counts_for_last_at():
    t0 = jst(2026, 10, 13, 10, 0)
    points = cm_rows(t0, t0 + timedelta(minutes=30), value=lambda t: 20.0)
    points += cm_rows(t0 + timedelta(hours=1), t0 + timedelta(hours=1, minutes=30), value=lambda t: None)
    bars, last_at = hourly(points)
    assert [b["started_at"] for b in bars] == [t0]
    assert last_at == t0 + timedelta(hours=1, minutes=29)
    assert all(b["high"] is not None for b in bars)


def test_last_at_is_limited_to_requested_range():
    t0 = jst(2026, 10, 13, 10, 0)
    rows = cm_bars(cm_rows(t0, t0 + timedelta(hours=3)), 3600)
    _, last_at = atm_iv.bars_from_rows(rows, t0, t0 + timedelta(hours=2))
    assert last_at == t0 + timedelta(hours=1, minutes=59)
    assert atm_iv.bars_from_rows([], t0, t0 + timedelta(hours=1)) == ([], None)


def test_non_finite_bar_is_dropped():
    t0 = jst(2026, 10, 13, 10, 0)
    rows = [{"started_at": t0, "open": float("nan"), "high": 1.0, "low": 1.0, "close": 1.0, "last_at": t0}]
    assert atm_iv.bars_from_rows(rows, t0, t0 + timedelta(hours=1))[0] == []


def non_trading():
    return atm_iv.non_trading_days(cal_mod.from_rows(calendar_rows()))


def test_non_trading_days_exclude_holiday_trading_days():
    # 合成のカレンダー: 11/3 休業、11/23 は祝日取引の実施日（is_trading_day = true）
    days = non_trading()
    assert date(2026, 11, 3) in days and date(2026, 11, 23) not in days
    assert date(2026, 11, 23) in cal_mod.from_rows(calendar_rows()).holidays  # SQ の規則の集合とは別


def test_trading_day_rules():
    h = non_trading()
    assert atm_iv.trading_day(jst(2026, 10, 30, 9, 0), h) == date(2026, 10, 30)  # 金曜の日中
    assert atm_iv.trading_day(jst(2026, 10, 30, 16, 59), h) == date(2026, 10, 30)
    assert atm_iv.trading_day(jst(2026, 10, 30, 17, 0), h) == date(2026, 11, 2)  # 金曜の夜間 → 月曜
    assert atm_iv.trading_day(jst(2026, 10, 31, 5, 0), h) == date(2026, 11, 2)  # 土曜の朝（金曜の夜間の続き）
    assert atm_iv.trading_day(jst(2026, 11, 2, 20, 0), h) == date(2026, 11, 4)  # 休業日の前の夜間 → 休み明け
    assert atm_iv.trading_day(jst(2026, 11, 20, 22, 0), h) == date(2026, 11, 23)  # 祝日取引の日は取引日


def test_daily_bars_group_sessions_and_drop_first_day():
    h = non_trading()
    sessions = [  # (日中 / 夜間の始まり, IV)
        (jst(2026, 10, 29, 20, 0), 30.0),  # 木曜の夜間 → 金曜 10/30
        (jst(2026, 10, 30, 9, 0), 21.0),  # 金曜の日中 → 10/30
        (jst(2026, 10, 30, 20, 0), 22.0),  # 金曜の夜間 → 月曜 11/2
        (jst(2026, 11, 2, 10, 0), 18.0),  # 月曜の日中 → 11/2
        (jst(2026, 11, 2, 15, 0), 24.0),
        (jst(2026, 11, 2, 21, 0), 26.0),  # 休業日 11/3 の前の夜間 → 11/4
        (jst(2026, 11, 4, 10, 0), 25.0),
    ]
    points = [(t + timedelta(minutes=i), v) for t, v in sessions for i in range(3)]
    points.insert(5, (jst(2026, 10, 30, 9, 30), None))  # NULL の行
    rows, _ = hourly(points)
    read_start = jst(2026, 10, 29, 16, 0)  # 木曜 16:00（読んだ範囲の先頭。木曜の取引日の中）
    r = atm_iv.AtmIvRequest("1d", datetime(2026, 10, 1, tzinfo=UTC), CAP + timedelta(days=60))
    out = atm_iv.daily_bars(rows, h, r, read_start, NOW + timedelta(days=30))
    got = [(b["started_at"].astimezone(atm_iv.JST).date(), b["open"], b["high"], b["low"], b["close"]) for b in out]
    assert got == [
        (date(2026, 10, 30), 30.0, 30.0, 21.0, 21.0),  # 木曜の夜間 + 金曜の日中（先頭の取引日 10/29 は捨てる）
        (date(2026, 11, 2), 22.0, 24.0, 18.0, 24.0),
        (date(2026, 11, 4), 26.0, 26.0, 25.0, 25.0),
    ]
    assert all(b["started_at"] == datetime.combine(d, datetime.min.time(), atm_iv.JST).astimezone(UTC)
               for b, (d, *_) in zip(out, got, strict=True))
    # 読んだ範囲の先頭が木曜の夜間の途中なら、10/30 は前の夜間が欠けうるので出さない
    out2 = atm_iv.daily_bars(rows, h, r, jst(2026, 10, 29, 18, 0), NOW + timedelta(days=30))
    assert [b["started_at"].astimezone(atm_iv.JST).date() for b in out2] == [date(2026, 11, 2), date(2026, 11, 4)]


def test_daily_bars_range_filter():
    h = non_trading()
    points = [(jst(2026, 11, d, 10, 0), 20.0) for d in (2, 4, 5, 6)]
    rows, _ = hourly(points)
    start, end = datetime(2026, 11, 3, tzinfo=UTC), datetime(2026, 11, 5, tzinfo=UTC)
    r = atm_iv.AtmIvRequest("1d", start, end)
    out = atm_iv.daily_bars(rows, h, r, start - timedelta(days=10), NOW + timedelta(days=60))
    # started_at（00:00 JST = 前日 15:00 UTC）が [start, end)
    assert [b["started_at"].astimezone(atm_iv.JST).date() for b in out] == [date(2026, 11, 4), date(2026, 11, 5)]
    # end ≥ now（右端）なら上端なし
    out = atm_iv.daily_bars(rows, h, r, start - timedelta(days=10), end)
    assert [b["started_at"].astimezone(atm_iv.JST).date() for b in out] == [date(2026, 11, 4), date(2026, 11, 5),
                                                                           date(2026, 11, 6)]


def test_json_shape():
    t0 = jst(2026, 10, 13, 10, 0)
    bars, last_at = hourly(cm_rows(t0, t0 + timedelta(minutes=5), value=lambda t: 20.5))
    r = req(tf="1h")
    obj = atm_iv.atm_iv_json(r, NOW.replace(microsecond=123), bars, last_at)
    assert obj == {
        "schema_version": 1, "tf": "1h",
        "start": "2026-08-15T09:00:00+09:00",
        "end": "2026-10-13T21:46:00+09:00",  # min(end, now) を秒に切り捨て
        "last_at": "2026-10-13T10:04:00+09:00",
        "bars": [{"t": "2026-10-13T10:00:00+09:00", "o": 20.5, "h": 20.5, "l": 20.5, "c": 20.5}],
    }
    assert atm_iv.atm_iv_json(r, NOW, [], None)["last_at"] is None

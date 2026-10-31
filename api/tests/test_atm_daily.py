"""日次の値（/api/atm_daily、#152）の純粋な関数と SQL の静的検査（A1・A2・A3）。値はすべて架空。"""

import math
import re
from datetime import UTC, date, datetime

from conftest import PKG_DIR
from support import jst

from simulator_api import atm_daily
from simulator_api import settings as st


def sql_body(name="atm_cm_daily"):
    text = (PKG_DIR / "sql" / f"{name}.sql").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


# ---- SQL（A1） ----

def test_atm_cm_daily_sql_filters_partition():
    # requirePartitionFilter の無い表なので、created_at の半開区間の絞りを必ず書く。値はパラメータだけ
    body = re.sub(r"\s+", " ", sql_body())
    assert "WHERE created_at >= @start_at AND created_at < @end_at" in body
    assert "CURRENT_TIMESTAMP" not in body.upper() and "CURRENT_DATE" not in body.upper()
    assert "*" not in body
    # 読む表は 1 つだけ・識別子は ${project}.${dataset} だけ
    assert re.findall(r"`([^`]*)`", body) == ["${project}.${dataset}.atm_cm_iv"]
    assert set(re.findall(r"@(\w+)", body)) == {"start_at", "end_at"}
    # 日中の終値の窓（settings と同じ時刻）と非 NULL の絞り
    lo, hi = st.ATM_DAILY_CLOSE_WINDOW
    window = (f"TIME(created_at, 'Asia/Tokyo') BETWEEN TIME '{lo.strftime('%H:%M:%S')}' "
              f"AND TIME '{hi.strftime('%H:%M:%S')}'")
    assert window in body
    assert "iv30 IS NOT NULL AND m1_forward IS NOT NULL" in body
    # #307: m1_iv・m2_iv は読むだけで、非 NULL の絞りに入れない（選ぶ行 = 追証マップの過去の点を変えない）
    assert "AND iv30 IS NOT NULL AND m1_forward IS NOT NULL AND m1_last_trading_day IS NOT NULL GROUP BY day" in body
    assert "m1_iv IS" not in body and "m2_iv IS" not in body


def test_atm_cm_daily_sql_reads_atm_ivs():
    # #307: 1・2 限月の ATM IV を points・STRUCT・最後の SELECT の末尾に足す
    body = re.sub(r"\s+", " ", sql_body())
    assert "m2_last_trading_day, m2_forward, m1_iv, m2_iv FROM" in body
    cols = "created_at, iv30, m1_last_trading_day, m1_forward, m2_last_trading_day, m2_forward, m1_iv, m2_iv"
    assert f"STRUCT({cols})" in body
    assert "last.m2_forward AS m2_forward, last.m1_iv AS m1_iv, last.m2_iv AS m2_iv FROM closes" in body


def test_atm_cm_daily_sql_takes_last_row_per_jst_day():
    body = re.sub(r"\s+", " ", sql_body())
    assert "DATE(created_at, 'Asia/Tokyo') AS day" in body
    assert "ORDER BY created_at DESC LIMIT 1 )[OFFSET(0)] AS last" in body
    assert "GROUP BY day" in body and body.rstrip().endswith("ORDER BY day")


# ---- 確定した範囲（A2） ----

def test_settled_end():
    # JST 8:00 から当日（その日を含まない = 前日までが確定）。8:00 前は前日
    assert atm_daily.settled_end(jst(2026, 10, 14, 7, 59)) == date(2026, 10, 13)
    assert atm_daily.settled_end(jst(2026, 10, 14, 8, 0)) == date(2026, 10, 14)
    assert atm_daily.settled_end(jst(2026, 10, 14, 7, 59, 59)) == date(2026, 10, 13)
    # 月曜の朝・休日明けでも同じ規則（土日・休業日は行が無いだけ）
    assert atm_daily.settled_end(jst(2026, 10, 19, 7, 30)) == date(2026, 10, 18)
    assert atm_daily.settled_end(jst(2026, 10, 19, 8, 0)) == date(2026, 10, 19)
    assert atm_daily.settled_end(jst(2026, 11, 4, 9, 0)) == date(2026, 11, 4)
    # UTC の日跨ぎ（JST 8:30 = UTC の前日 23:30）・JST の深夜
    assert atm_daily.settled_end(datetime(2026, 10, 13, 23, 30, tzinfo=UTC)) == date(2026, 10, 14)
    assert atm_daily.settled_end(datetime(2026, 10, 13, 15, 30, tzinfo=UTC)) == date(2026, 10, 13)  # JST 0:30
    assert st.ATM_DAILY_SETTLED_AT.hour == 8


def test_read_window():
    start_at, end_at = atm_daily.read_window(date(2026, 10, 14))
    assert start_at == datetime.fromisoformat(st.ATM_IV_EPOCH_ISO)
    assert end_at == jst(2026, 10, 14, 0) and end_at.tzinfo is not None


# ---- 行 → JSON（A3） ----

def row(d, h=15, mi=0, iv=20.0, f1=30000.0, l1=date(2026, 11, 12), f2=30010.0, l2=date(2026, 12, 10), v1=21.0,
        v2=19.5):
    y, mo, dd = d
    return {"day": date(y, mo, dd), "close_at": jst(y, mo, dd, h, mi), "iv30": iv, "m1_last_trading_day": l1,
            "m1_forward": f1, "m2_last_trading_day": l2, "m2_forward": f2, "m1_iv": v1, "m2_iv": v2}


def test_rows_to_json():
    end = date(2026, 10, 15)
    rows = [
        row((2026, 10, 14), iv=21.5, f1=30100.5, f2=None),  # 2 限月の F が NULL → 両方 null
        row((2026, 10, 9), h=14, mi=59, iv=19.25),
        row((2026, 10, 13), iv=20.0, l2=None),  # 2 限月の最終取引日が NULL → 両方 null
        row((2026, 10, 9), iv=99.0),  # 重複（後を捨てる）
        row((2026, 10, 8), iv=0.0),  # iv が正でない
        row((2026, 10, 7), f1=float("nan")),  # f1 が有限でない
        row((2026, 10, 6), l1=None),  # l1 が NULL
        row((2026, 10, 5), iv=None),
        row((2026, 10, 2), f2=-1.0),  # f2 が正でない → 両方 null
        row((2026, 10, 1), f2=float("inf")),
        row((2026, 10, 15)),  # 範囲の終わり（含まない）
    ]
    days = atm_daily.days_from_rows(rows, end)
    obj = atm_daily.atm_daily_json(end, days)
    assert obj["schema_version"] == 1 and obj["start"] == "2010-01-01" and obj["end"] == "2026-10-15"
    assert set(obj) == {"schema_version", "start", "end", "days"}
    ds = obj["days"]
    assert [d["d"] for d in ds] == ["2026-10-01", "2026-10-02", "2026-10-09", "2026-10-13", "2026-10-14"]
    assert all(set(d) == {"d", "t", "iv", "f1", "l1", "f2", "l2", "v1", "v2"} for d in ds)
    assert ds[2] == {"d": "2026-10-09", "t": "2026-10-09T14:59:00+09:00", "iv": 19.25, "f1": 30000.0,
                     "l1": "2026-11-12", "f2": 30010.0, "l2": "2026-12-10", "v1": 21.0, "v2": 19.5}
    assert ds[4]["iv"] == 21.5 and ds[4]["f1"] == 30100.5 and ds[4]["t"] == "2026-10-14T15:00:00+09:00"
    for d in (ds[0], ds[1], ds[3], ds[4]):
        assert d["f2"] is None and d["l2"] is None
        # 2 限月の組が無ければ v2 も null（v1 はそのまま）
        assert d["v2"] is None and d["v1"] == 21.0
    assert all(d["t"].endswith("+09:00") for d in ds)


def test_rows_values_are_not_rounded():
    v = 20.123456789012345
    days = atm_daily.days_from_rows([row((2026, 10, 9), iv=v, f1=30000.123456789)], date(2026, 10, 10))
    assert days[0]["iv"] == v and days[0]["f1"] == 30000.123456789


def test_rows_reject_non_numbers():
    rows = [row((2026, 10, 9), iv=True), row((2026, 10, 8), f1="30000"), row((2026, 10, 7), f2=True)]
    days = atm_daily.days_from_rows(rows, date(2026, 10, 10))
    assert [d["d"] for d in days] == ["2026-10-07"] and days[0]["f2"] is None and days[0]["l2"] is None
    assert all(math.isfinite(d["iv"]) for d in days)


def test_rows_atm_ivs():
    # #307: v1・v2 は有限で正のときだけ値（丸めない）。無効でも行は捨てない
    end = date(2026, 10, 20)
    rows = [
        row((2026, 10, 1), v1=23.456789012345, v2=21.0),
        row((2026, 10, 2), v1=None, v2=None),
        row((2026, 10, 5), v1=0.0, v2=-1.0),
        row((2026, 10, 6), v1=float("nan"), v2=float("inf")),
        row((2026, 10, 7), v1=True, v2="20"),
        row((2026, 10, 8), v1=22.0, v2=20.0, f2=None),  # 2 限月の組が無い → v2 は null
    ]
    ds = atm_daily.days_from_rows(rows, end)
    assert [d["d"] for d in ds] == ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]
    assert ds[0]["v1"] == 23.456789012345 and ds[0]["v2"] == 21.0
    for d in ds[1:5]:
        assert d["v1"] is None and d["v2"] is None
    assert ds[5]["v1"] == 22.0 and ds[5]["v2"] is None
    # キーが無い行（古い runner）でも null
    old = {k: v for k, v in row((2026, 10, 9)).items() if k not in ("m1_iv", "m2_iv")}
    got = atm_daily.days_from_rows([old], end)[0]
    assert got["v1"] is None and got["v2"] is None


def test_etag_shape():
    assert atm_daily.ETAG_SHAPE == "v"


def test_empty_rows():
    obj = atm_daily.atm_daily_json(date(2026, 10, 15), atm_daily.days_from_rows([], date(2026, 10, 15)))
    assert obj["days"] == []

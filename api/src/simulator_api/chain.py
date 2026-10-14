"""板の JSON（版 1。docs/design.md 7.1・data/chainTypes.ts）の組み立て。純粋な関数（ログだけ出す）。

- 時刻は ISO 8601 のオフセット付き（+09:00）。TIMESTAMP（aware）は JST に変換、DATETIME（naive）は JST の
  壁時計なので +09:00 を付ける。日付は YYYY-MM-DD、限月は YYYY-MM
- 限月 = 板の last_trading_day ごと（SQ 日の昇順）。contract_month = 取引最終日の月、last_trading_day = 板の値（JPX）、
  sq_date = カレンダーの規則。規則の取引最終日が板と違えば calendar_mismatch（限月の ID だけ）
- 行 = 行使価格ごと（昇順）。call / put の片側が無ければ全キー null。type が NULL の行は捨てる。
  同じ (限月, K, type) の重複は最初の 1 行（件数だけログ）
- 先物の last_trading_day・sq_date はカレンダーから。現物が無ければ {price: null, price_time: null}
- オプションの全キー（quotation・quotation_date・is_atm を含む）を常に出す
"""

from dataclasses import dataclass
from datetime import date, datetime

from . import calendar as cal_mod
from . import settings as st
from .calendar import JST, Calendar
from .log import log

SCHEMA_VERSION = 1
SIDE_KEYS = ("bid", "ask", "bid_iv", "ask_iv", "price", "price_time", "iv", "volume", "positions", "quotation",
             "quotation_date", "delta", "gamma", "theta", "vega", "is_atm")
TYPES = {1: "call", 2: "put"}
EMPTY_SIDE = dict.fromkeys(SIDE_KEYS)


def instant(at: datetime | None) -> str | None:
    """TIMESTAMP（aware）→ JST の +09:00。DATETIME（naive = JST の壁時計）→ +09:00 を付ける"""
    if at is None:
        return None
    if at.tzinfo is not None:
        at = at.astimezone(JST)
    return at.strftime("%Y-%m-%dT%H:%M:%S+09:00")


def iso_date(d: date | None) -> str | None:
    return None if d is None else d.isoformat()


def year_month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _side(row: dict) -> dict:
    side = {k: row.get(k) for k in SIDE_KEYS}
    side["price_time"] = instant(row.get("price_time"))
    side["quotation_date"] = iso_date(row.get("quotation_date"))
    return side


@dataclass(frozen=True)
class Month:
    last_trading_day: date
    rows: tuple[dict, ...]  # [{k, call, put}]（JSON の形）


def parse_board(option_rows: list[dict]) -> tuple[Month, ...]:
    """option_price_latest の行 → 限月ごとの行（JSON の形。カレンダーに依らない部分）"""
    null_type = duplicates = 0
    by_month: dict[date, dict[int, dict]] = {}
    for row in sorted(option_rows, key=lambda r: (r["last_trading_day"], r["target_price"])):
        key = TYPES.get(row.get("type"))
        if key is None:
            null_type += 1
            continue
        strikes = by_month.setdefault(row["last_trading_day"], {})
        entry = strikes.setdefault(row["target_price"], {"k": row["target_price"], "call": None, "put": None})
        if entry[key] is not None:
            duplicates += 1
            continue
        entry[key] = _side(row)
    if null_type or duplicates:
        log("WARNING", "board_rows_dropped", null_type=null_type, duplicates=duplicates)
    months = []
    for ltd in sorted(by_month):
        rows = []
        for k in sorted(by_month[ltd]):
            e = by_month[ltd][k]
            rows.append({"k": k, "call": e["call"] or dict(EMPTY_SIDE), "put": e["put"] or dict(EMPTY_SIDE)})
        months.append(Month(last_trading_day=ltd, rows=tuple(rows)))
    return tuple(months)


def chain_json(snapshot_at: datetime, reason: str, months: tuple[Month, ...], future: dict, spot: dict | None,
               cal: Calendar) -> dict:
    holidays = cal.holidays
    out_months = []
    for m in months:
        y, mo = m.last_trading_day.year, m.last_trading_day.month
        sq = cal_mod.sq_date(y, mo, holidays)
        if cal_mod.last_trading_day(y, mo, holidays) != m.last_trading_day:
            log("WARNING", "calendar_mismatch", contract_month=year_month(m.last_trading_day))
        out_months.append({"contract_month": year_month(m.last_trading_day),
                           "last_trading_day": m.last_trading_day.isoformat(), "sq_date": sq.isoformat(),
                           "rows": list(m.rows)})
    fm = future["contract_month"]
    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_at": instant(snapshot_at),
        "delayed_minutes": st.DELAYED_MINUTES,
        "reason": reason,
        "source": "bigquery",
        "spot": {"price": spot.get("price") if spot else None,
                 "price_time": instant(spot.get("price_time")) if spot else None},
        "future": {"price": future.get("price"), "price_time": instant(future.get("price_time")),
                   "contract_month": year_month(fm),
                   "last_trading_day": cal_mod.last_trading_day(fm.year, fm.month, holidays).isoformat(),
                   "sq_date": cal_mod.sq_date(fm.year, fm.month, holidays).isoformat()},
        "months": out_months,
    }

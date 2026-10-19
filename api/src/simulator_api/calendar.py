"""取引カレンダー（optionchan の trading_calendar_latest。docs/design.md 7.5・5.2）。純粋な関数。

- SQ 日・取引最終日の休業日 = 版の **全行**（is_trading_day を問わない。祝日取引の実施日も SQ は前へ）+ 土日
  （optionchan の契約・#39 のコメント）
- SQ 日 = 第 2 金曜。休業日なら前営業日へ繰り上げ。取引最終日 = SQ 日の前営業日
  （model/time.ts の sqDate / lastTradingDay と同じ規則）
- /api/calendar の JSON: {schema_version: 1, source, version_at, covered_until, listed_until,
  days: [{date, is_trading_day, status, name}]}（日付の昇順。ブラウザ側の型・検証は #39）
- from_json: 同じ形の JSON（同梱の data/calendar/calendar.json など）→ Calendar（DATA_SOURCE=quotes の CALENDAR_FILE。
  #154）。検証は data/calendar.ts の validateCalendarJson と同じ規則。失敗は ValueError（値は入れない）
"""

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .usable import JST

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class CalendarDay:
    date: date
    is_trading_day: bool
    status: str
    name: str


@dataclass(frozen=True)
class Calendar:
    version_at: datetime
    covered_until: date
    listed_until: date
    days: tuple[CalendarDay, ...]

    @property
    def holidays(self) -> frozenset[date]:
        return frozenset(d.date for d in self.days)


def from_rows(rows: list[dict]) -> Calendar:
    """trading_calendar_latest の行 → Calendar。版が混ざっていれば最新の版の行だけ（ビューは最新版だけを返す）"""
    if not rows:
        raise ValueError("取引カレンダーが空")
    version_at = max(r["version_at"] for r in rows)
    rows = sorted((r for r in rows if r["version_at"] == version_at), key=lambda r: r["calendar_date"])
    first = rows[0]
    days = tuple(CalendarDay(date=r["calendar_date"], is_trading_day=bool(r["is_trading_day"]),
                             status=r["status"], name=r["name"]) for r in rows)
    return Calendar(version_at=version_at, covered_until=first["covered_until"], listed_until=first["listed_until"],
                    days=days)


_ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _date(v, path: str) -> date:
    if not isinstance(v, str) or not _ISO_DATE.match(v):
        raise ValueError(f"{path}: YYYY-MM-DD の日付でない")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise ValueError(f"{path}: 存在しない日付") from None


def from_json(obj) -> Calendar:
    """/api/calendar と同じ形の JSON → Calendar（days は日付の厳密な昇順。source と余分なキーは見ない）"""
    if not isinstance(obj, dict):
        raise ValueError("$: オブジェクトでない")
    if obj.get("schema_version") != SCHEMA_VERSION or isinstance(obj.get("schema_version"), bool):
        raise ValueError("$.schema_version: 未対応の版")
    v = obj.get("version_at")
    if not isinstance(v, str) or not _ISO_INSTANT.match(v):
        raise ValueError("$.version_at: ISO 8601（オフセット付き）の時刻でない")
    version_at = datetime.fromisoformat(v.replace("Z", "+00:00"))
    covered = _date(obj.get("covered_until"), "$.covered_until")
    listed = _date(obj.get("listed_until"), "$.listed_until")
    raw = obj.get("days")
    if not isinstance(raw, list):
        raise ValueError("$.days: 配列でない")
    days = []
    prev = None
    for i, d in enumerate(raw):
        p = f"$.days[{i}]"
        if not isinstance(d, dict):
            raise ValueError(f"{p}: オブジェクトでない")
        cd = _date(d.get("date"), f"{p}.date")
        if prev is not None and cd <= prev:
            raise ValueError(f"{p}.date: 昇順でない")
        prev = cd
        if not isinstance(d.get("is_trading_day"), bool):
            raise ValueError(f"{p}.is_trading_day: 真偽値でない")
        if not isinstance(d.get("status"), str) or not d["status"]:
            raise ValueError(f"{p}.status: 空でない文字列でない")
        if not isinstance(d.get("name"), str):
            raise ValueError(f"{p}.name: 文字列でない")
        days.append(CalendarDay(date=cd, is_trading_day=d["is_trading_day"], status=d["status"], name=d["name"]))
    return Calendar(version_at=version_at, covered_until=covered, listed_until=listed, days=tuple(days))


def is_business_day(d: date, holidays: frozenset[date]) -> bool:
    return d.weekday() < 5 and d not in holidays


def previous_business_day(d: date, holidays: frozenset[date]) -> date:
    d -= timedelta(days=1)
    while not is_business_day(d, holidays):
        d -= timedelta(days=1)
    return d


def second_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(4 - first.weekday()) % 7 + 7)


def sq_date(year: int, month: int, holidays: frozenset[date]) -> date:
    d = second_friday(year, month)
    while not is_business_day(d, holidays):
        d -= timedelta(days=1)
    return d


def last_trading_day(year: int, month: int, holidays: frozenset[date]) -> date:
    return previous_business_day(sq_date(year, month, holidays), holidays)


def jst_iso(at: datetime) -> str:
    return at.astimezone(JST).strftime("%Y-%m-%dT%H:%M:%S+09:00")


def calendar_json(cal: Calendar, source: str = "bigquery") -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": source,
        "version_at": jst_iso(cal.version_at),
        "covered_until": cal.covered_until.isoformat(),
        "listed_until": cal.listed_until.isoformat(),
        "days": [{"date": d.date.isoformat(), "is_trading_day": d.is_trading_day, "status": d.status,
                  "name": d.name} for d in cal.days],
    }

"""取引カレンダー（optionchan の trading_calendar_latest。docs/design.md 7.5・5.2）。純粋な関数。

- SQ 日・取引最終日の休業日 = 版の **全行**（is_trading_day を問わない。祝日取引の実施日も SQ は前へ）+ 土日
  （optionchan の契約・#39 のコメント）
- SQ 日 = 第 2 金曜。休業日なら前営業日へ繰り上げ。取引最終日 = SQ 日の前営業日
  （model/time.ts の sqDate / lastTradingDay と同じ規則）
- /api/calendar の JSON: {schema_version: 1, source, version_at, covered_until, listed_until,
  days: [{date, is_trading_day, status, name}]}（日付の昇順。ブラウザ側の型・検証は #39）
"""

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


def calendar_json(cal: Calendar) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "source": "bigquery",
        "version_at": jst_iso(cal.version_at),
        "covered_until": cal.covered_until.isoformat(),
        "listed_until": cal.listed_until.isoformat(),
        "days": [{"date": d.date.isoformat(), "is_trading_day": d.is_trading_day, "status": d.status,
                  "name": d.name} for d in cal.days],
    }

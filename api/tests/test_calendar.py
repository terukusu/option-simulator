"""取引カレンダー（AC-6。docs/design.md 7.5・5.2）。休業日は合成の行。"""

from datetime import UTC, date, datetime

import pytest
from support import calendar_rows

from simulator_api import calendar

# 2023-08: 第 2 金曜は 8/11。合成の行で 8/11 を is_trading_day = true（祝日取引の実施日）にしても、
# SQ 日の規則では版の全行を休業日として扱う → SQ 日 8/10（木）、取引最終日 8/9（水）
AUG_2023 = (
    (date(2023, 8, 11), True, "confirmed", "取引日 Y"),
    (date(2023, 9, 18), False, "confirmed", "休日 Z"),
)


def cal(days=AUG_2023, **kw):
    return calendar.from_rows(calendar_rows(days, **kw))


def test_sq_date_treats_all_rows_as_holidays():
    c = cal()
    assert calendar.sq_date(2023, 8, c.holidays) == date(2023, 8, 10)
    assert calendar.last_trading_day(2023, 8, c.holidays) == date(2023, 8, 9)


def test_sq_date_weekends_only_outside_version():
    c = cal()
    # 2026-11: 第 2 金曜 11/13、前営業日 11/12（版の行は無関係）
    assert calendar.sq_date(2026, 11, c.holidays) == date(2026, 11, 13)
    assert calendar.last_trading_day(2026, 11, c.holidays) == date(2026, 11, 12)
    # 土日だけ: 2023-08 は 8/11
    assert calendar.sq_date(2023, 8, frozenset()) == date(2023, 8, 11)


def test_last_trading_day_skips_weekend_and_holidays():
    # 2024-02: 第 2 金曜 2/9。2/8（木）を休業日にすると取引最終日は 2/7
    c = cal(((date(2024, 2, 8), False, "confirmed", "休日 W"),))
    assert calendar.sq_date(2024, 2, c.holidays) == date(2024, 2, 9)
    assert calendar.last_trading_day(2024, 2, c.holidays) == date(2024, 2, 7)
    # 第 2 金曜と前日が休業日 → SQ 日は水曜、取引最終日は火曜（月曜も休業日なら前週の金曜）
    c = cal(((date(2024, 2, 9), False, "confirmed", "a"), (date(2024, 2, 8), True, "confirmed", "b"),
             (date(2024, 2, 6), False, "confirmed", "c"), (date(2024, 2, 5), False, "confirmed", "d")))
    assert calendar.sq_date(2024, 2, c.holidays) == date(2024, 2, 7)
    assert calendar.last_trading_day(2024, 2, c.holidays) == date(2024, 2, 2)


def test_second_friday():
    assert calendar.second_friday(2026, 11) == date(2026, 11, 13)
    assert calendar.second_friday(2026, 12) == date(2026, 12, 11)
    assert calendar.second_friday(2026, 5) == date(2026, 5, 8)  # 5/1 が金曜


def test_json_has_all_rows_sorted():
    rows = calendar_rows(((date(2023, 9, 18), False, "planned", "休日 Z"),
                          (date(2023, 8, 11), True, "confirmed", "取引日 Y")),
                         version_at=datetime(2026, 10, 1, 21, 40, 5, tzinfo=UTC),
                         covered_until=date(2023, 12, 31), listed_until=date(2024, 12, 31))
    j = calendar.calendar_json(calendar.from_rows(rows))
    assert j == {
        "schema_version": 1,
        "source": "bigquery",
        "version_at": "2026-10-02T06:40:05+09:00",
        "covered_until": "2023-12-31",
        "listed_until": "2024-12-31",
        "days": [
            {"date": "2023-08-11", "is_trading_day": True, "status": "confirmed", "name": "取引日 Y"},
            {"date": "2023-09-18", "is_trading_day": False, "status": "planned", "name": "休日 Z"},
        ],
    }


def test_from_rows_uses_newest_version_only():
    old = calendar_rows(((date(2023, 8, 14), False, "confirmed", "old"),),
                        version_at=datetime(2026, 9, 1, tzinfo=UTC))
    new = calendar_rows(AUG_2023)
    c = calendar.from_rows(old + new)
    assert c.version_at == new[0]["version_at"]
    assert [d.date for d in c.days] == [date(2023, 8, 11), date(2023, 9, 18)]


def test_from_rows_rejects_empty():
    with pytest.raises(ValueError):
        calendar.from_rows([])

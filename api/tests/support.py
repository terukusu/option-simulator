"""テストの補助: 合成の板（fixtures/synthetic/*.json）→ optionchan のテーブル関数の行、偽の runner・時計。

値はすべて架空（合成の板・合成のカレンダー）。BigQuery クライアントが返す Python の型に合わせる
（TIMESTAMP = aware な datetime（UTC）、DATETIME = naive な datetime（JST の壁時計）、DATE = date）。
"""

import json
import threading
from datetime import UTC, date, datetime, timedelta, timezone

from conftest import REPO_ROOT

JST = timezone(timedelta(hours=9))
FIXTURES_DIR = REPO_ROOT / "fixtures" / "synthetic"
SIDE_KEYS = ("bid", "ask", "bid_iv", "ask_iv", "price", "price_time", "iv", "volume", "positions", "quotation",
             "quotation_date", "delta", "gamma", "theta", "vega", "is_atm")


def jst(y, mo, d, h, mi=0, s=0) -> datetime:
    """JST の壁時計の時刻を aware な UTC の datetime にする（TIMESTAMP の値）"""
    return datetime(y, mo, d, h, mi, s, tzinfo=JST).astimezone(UTC)


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text(encoding="utf-8"))


def parse_instant(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone(UTC)


def wall(s: str | None) -> datetime | None:
    """'2026-10-13T20:32:00+09:00' → DATETIME（JST の壁時計の naive な datetime）"""
    if s is None:
        return None
    return datetime.fromisoformat(s).astimezone(JST).replace(tzinfo=None)


def day(s: str | None) -> date | None:
    return None if s is None else date.fromisoformat(s)


def option_row(created_at, typ, k, ltd, **side) -> dict:
    row = {"type": typ, "target_price": k, "last_trading_day": ltd, "created_at": created_at}
    for key in ("bid", "ask", "bid_iv", "ask_iv", "price", "price_time", "iv", "delta", "gamma", "theta", "vega",
                "quotation", "quotation_date", "volume", "positions", "is_atm"):
        row[key] = side.get(key)
    return row


def fixture_tables(fx: dict) -> dict:
    """板の JSON（版 1）→ option_price / future_price / spot_price の行（created_at = snapshot_at）"""
    snap = parse_instant(fx["snapshot_at"])
    options = []
    for m in fx["months"]:
        ltd = day(m["last_trading_day"])
        for r in m["rows"]:
            for typ, key in ((1, "call"), (2, "put")):
                s = r[key]
                options.append(option_row(
                    snap, typ, r["k"], ltd,
                    **{k: s.get(k) for k in SIDE_KEYS if k not in ("price_time", "quotation_date")},
                    price_time=wall(s.get("price_time")), quotation_date=day(s.get("quotation_date"))))
    fut = fx["future"]
    y, mo = map(int, fut["contract_month"].split("-"))
    future = {"price": None if fut["price"] is None else float(fut["price"]), "price_time": wall(fut["price_time"]),
              "contract_month": date(y, mo, 1)}
    spot = {"price": None if fx["spot"]["price"] is None else float(fx["spot"]["price"]),
            "price_time": wall(fx["spot"]["price_time"])}
    return {"snapshot_at": snap, "option_price": options, "future_price": [future], "spot_price": [spot]}


# 合成のカレンダー（版の全行）。2026-10〜12 の SQ に掛からない休業日と、祝日取引の実施日（is_trading_day = true）
VERSION_AT = datetime(2026, 10, 1, 21, 40, tzinfo=UTC)
CALENDAR_DAYS = (
    (date(2026, 11, 3), False, "confirmed", "休日 A"),
    (date(2026, 11, 23), True, "confirmed", "取引日 B"),
    (date(2026, 12, 31), False, "planned", "休日 C"),
    (date(2027, 1, 1), False, "planned", "休日 D"),
)


def calendar_rows(days=CALENDAR_DAYS, version_at=VERSION_AT, covered_until=date(2026, 12, 31),
                  listed_until=date(2027, 12, 31)) -> list[dict]:
    return [{"version_at": version_at, "calendar_date": d, "is_trading_day": t, "status": s, "name": n,
             "covered_until": covered_until, "listed_until": listed_until} for d, t, s, n in days]


def run(at: datetime, rows_option=800, finished_after=40) -> dict:
    return {"snapshot_at": at, "rows_option": rows_option, "finished_at": at + timedelta(seconds=finished_after)}


class World:
    """偽の BigQuery の中身: 実行（latest_runs）とスナップショットごとの板・先物・現物、カレンダー"""

    def __init__(self):
        self.runs: list[dict] = []
        self.options: dict[datetime, list[dict]] = {}
        self.futures: dict[datetime, list[dict]] = {}
        self.spots: dict[datetime, list[dict]] = {}
        self.calendar: list[dict] = calendar_rows()

    def add(self, at, options, future_price, spot_price=None, rows_option=800, finished_after=40):
        """rows_option は latest_runs の行数（判定用の小さな板でも既定は 800 行として扱う）"""
        self.runs.append(run(at, rows_option, finished_after))
        self.options[at] = options
        self.futures[at] = [] if future_price is None else (
            [future_price] if isinstance(future_price, dict) else
            [{"price": future_price, "price_time": wall_of(at), "contract_month": date(2026, 12, 1)}])
        self.spots[at] = [] if spot_price is None else [
            {"price": float(spot_price), "price_time": wall_of(at)}]
        return self

    def add_run_only(self, at, rows_option=800):
        self.runs.append(run(at, rows_option))
        return self

    def add_fixture(self, fx: dict, rows_option=None):
        t = fixture_tables(fx)
        snap = t["snapshot_at"]
        self.runs.append(run(snap, len(t["option_price"]) if rows_option is None else rows_option))
        self.options[snap] = t["option_price"]
        self.futures[snap] = t["future_price"]
        self.spots[snap] = t["spot_price"]
        return snap


def wall_of(at: datetime) -> datetime:
    return at.astimezone(JST).replace(tzinfo=None)


class FakeRunner:
    """runner の偽物。World をテーブル関数の窓 [start_at, end_at) で引き、呼び出し（名前とパラメータ）を記録する。

    errors: 名前 → 例外（その名前の呼び出しで投げる）。gate: threading.Event（セットされるまで待つ。同時実行の検査）
    """

    def __init__(self, world: World, errors=None, gate: threading.Event | None = None):
        self.world = world
        self.errors = errors or {}
        self.gate = gate
        self.calls: list[tuple[str, dict]] = []
        self._lock = threading.Lock()

    def names(self) -> list[str]:
        with self._lock:
            return [n for n, _ in self.calls]

    def count(self, name: str) -> int:
        return self.names().count(name)

    def reset(self):
        with self._lock:
            self.calls.clear()

    def __call__(self, name, params):
        with self._lock:
            self.calls.append((name, dict(params)))
        if self.gate is not None:
            self.gate.wait(5)
        if name in self.errors:
            raise self.errors[name]
        w = self.world
        if name == "trading_calendar":
            return [dict(r) for r in w.calendar]
        start, end = params["start_at"], params["end_at"]
        if name == "latest_runs":
            rows = [dict(r) for r in w.runs if start <= r["snapshot_at"] < end]
            return sorted(rows, key=lambda r: r["snapshot_at"], reverse=True)
        table = {"option_price": w.options, "future_price": w.futures, "spot_price": w.spots}[name]
        return [dict(r) for at, rows in table.items() if start <= at < end for r in rows]


class Clock:
    """現在時刻（UTC）と単調時計（秒）。テストで進める"""

    def __init__(self, now: datetime):
        self.now = now
        self.mono = 1000.0

    def __call__(self) -> datetime:
        return self.now

    def monotonic(self) -> float:
        return self.mono

    def advance(self, seconds: float):
        self.now += timedelta(seconds=seconds)
        self.mono += seconds


def synth_board(at: datetime, future=30000.0, band_rows=100, quoted=100, ltd=date(2026, 11, 12),
                ltd2=date(2026, 12, 10)) -> list[dict]:
    """判定用の小さな合成の板。1 限月の先物 ±5% に call・put 合わせて band_rows 行（うち quoted 行に両側気配）、
    帯の外と 2 限月は気配なし（割合に入らないことの確認用）"""
    assert band_rows % 2 == 0
    n = band_rows // 2
    step = int(future * 0.09 / n) // 5 * 5 or 5
    k0 = int(future * 0.955) // 5 * 5
    strikes = [k0 + step * i for i in range(n)]
    assert all(0.95 * future <= k <= 1.05 * future for k in strikes)
    rows = []
    i = 0
    for k in strikes:
        for typ in (1, 2):
            both = i < quoted
            rows.append(option_row(at, typ, k, ltd, bid=100 if both else None, ask=110 if both else 120))
            i += 1
    for k in (int(future * 0.5) // 5 * 5, int(future * 1.5) // 5 * 5):
        for typ in (1, 2):
            rows.append(option_row(at, typ, k, ltd))
    for k in strikes[:4]:
        for typ in (1, 2):
            rows.append(option_row(at, typ, k, ltd2))
    return rows

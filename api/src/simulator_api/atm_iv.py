"""/api/atm_iv（IV 推移。表 atm_cm_iv の 30 日固定の ATM IV = iv30、#79）の純粋な関数。docs/design.md 7.1・13.4。

- 要求: tf ∈ {1m, 1h, 1d}（完全一致。5m・15m は画面が 1m から束ねる）、start・end（両方か無し）は ISO 8601 の
  オフセット付き（Z か ±HH:MM。秒まで）で UTC の 0 時ちょうど。end は utc_day(now) + 1 日に縮める（端末の時計の進みで
  400 にしない）。縮めた後の end − start が足ごとの最大日数以下。両方無ければ右端（最新）の既定の 1 回分
- 足: 1m・1h は SQL（sql/atm_cm_iv.sql）が束ねた足から iv30 が全部 NULL の足を捨てる。1d は 1 時間足を取引日ごとに
  束ねる（optionchan のビューアーの bars.trading_day・bars.daily・api._daily と同じ規則）。取引日 = JST + 7 時間の
  日付から土日・休業日（取引カレンダーの is_trading_day = false の日）を飛ばした最初の日（夜間は次の取引日。祝日取引の
  実施日は取引日）。読んだ範囲の先頭の取引日（前の夜間が欠けうる）は出さない
- JSON: {schema_version: 1, tf, start, end, last_at, bars: [{t, o, h, l, c}]}。時刻は +09:00、値は %（iv30 のまま）
"""

import math
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from . import settings as st
from .calendar import Calendar, jst_iso
from .usable import JST

SCHEMA_VERSION = 1
DAY = timedelta(days=1)
EPOCH = datetime.fromisoformat(st.ATM_IV_EPOCH_ISO)
# 秒までのオフセット付き（小数秒・空白・末尾の改行・オフセットなしを受け付けない。fullmatch で使う）
_ISO_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})")
# 夜間（17:00〜翌朝 JST）を次の日に寄せるずらし: JST + 7 時間の日付が取引日の候補（ビューアーの bars._SESSION_SHIFT）
_SESSION_SHIFT = timedelta(hours=7)


class BadRequest(Exception):
    """400 にする。引数はパラメータの名前だけ（値は応答・ログに出さない）"""

    def __init__(self, param: str):
        super().__init__(param)
        self.param = param


@dataclass(frozen=True)
class AtmIvRequest:
    tf: str
    start: datetime  # aware な UTC。UTC の 0 時
    end: datetime  # aware な UTC。UTC の 0 時（utc_day(now) + 1 日以下に縮めた後）


def utc_day(t: datetime) -> datetime:
    """t（aware）を含む UTC の日の 0 時"""
    return t.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)


def right_edge(now: datetime) -> datetime:
    """end の上限 = 右端の end: 明日の UTC の 0 時（表に未来の行は無いので結果は now までと同じ。1 日中同じ値になり、
    サーバーと BigQuery の結果キャッシュが効く）"""
    return utc_day(now) + DAY


def _one(args, name: str) -> str | None:
    values = args.getlist(name) if hasattr(args, "getlist") else ([args[name]] if name in args else [])
    if len(values) > 1:
        raise BadRequest(name)
    return values[0] if values else None


def _parse_instant(raw: str, name: str) -> datetime:
    if not _ISO_RE.fullmatch(raw):
        raise BadRequest(name)
    try:
        t = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        raise BadRequest(name) from None
    if t != utc_day(t):  # UTC の 0 時ちょうど（キャッシュのキー・BigQuery の結果キャッシュを効かせる）
        raise BadRequest(name)
    return t


def parse_request(args, now: datetime) -> AtmIvRequest:
    """クエリパラメータ（MultiDict か dict）→ 要求。不正なら BadRequest(パラメータの名前)。知らないパラメータは無視"""
    tf = _one(args, "tf")
    if tf not in st.ATM_IV_TIMEFRAMES:
        raise BadRequest("tf")
    _, max_days, default_days = st.ATM_IV_TIMEFRAMES[tf]
    raw_start, raw_end = _one(args, "start"), _one(args, "end")
    cap = right_edge(now)
    if raw_start is None and raw_end is None:
        return AtmIvRequest(tf, cap - timedelta(days=default_days), cap)
    if raw_start is None:
        raise BadRequest("start")
    if raw_end is None:
        raise BadRequest("end")
    start = _parse_instant(raw_start, "start")
    end = min(_parse_instant(raw_end, "end"), cap)
    if start < EPOCH or start >= end:
        raise BadRequest("start")
    if end - start > timedelta(days=max_days):
        raise BadRequest("range")
    return AtmIvRequest(tf, start, end)


def is_settled(req: AtmIvRequest, now: datetime) -> bool:
    """end が now − ATM_IV_SETTLED_HOURS 以前（表の作り直しの外 = 中身が変わらない範囲）"""
    return req.end <= now - timedelta(hours=st.ATM_IV_SETTLED_HOURS)


def read_window(req: AtmIvRequest, now: datetime) -> tuple[datetime, datetime, int]:
    """SQL のパラメータ (start_at, end_at, step)。1d は start の ATM_IV_DAILY_LOOKBEHIND_DAYS 日前〜end の 1 日後
    （右端まで）の 1 時間足"""
    step = st.ATM_IV_TIMEFRAMES[req.tf][0]
    if req.tf != "1d":
        return req.start, req.end, step
    return (req.start - timedelta(days=st.ATM_IV_DAILY_LOOKBEHIND_DAYS), min(req.end + DAY, right_edge(now)), step)


def _finite(row: dict) -> bool:
    return all(isinstance(row[k], (int, float)) and math.isfinite(row[k]) for k in ("open", "high", "low", "close"))


def bars_from_rows(rows: list[dict], start: datetime, end: datetime) -> tuple[list[dict], datetime | None]:
    """SQL の行 → (値のある足（started_at の昇順）, last_at)。last_at は [start, end) の行の created_at の最大
    （iv30 が NULL の行を含む。足を捨てる前に取る）。値の無い足（high が NULL）・有限でない値の足は捨てる"""
    last_ats = [r["last_at"] for r in rows if r.get("last_at") is not None and start <= r["last_at"] < end]
    last_at = max(last_ats) if last_ats else None
    bars = sorted((r for r in rows if r["high"] is not None and _finite(r)), key=lambda r: r["started_at"])
    return bars, last_at


def non_trading_days(cal: Calendar) -> frozenset[date]:
    """日足の休業日: 取引カレンダーの is_trading_day = false の日（ビューアーの trading_holidays.sql と同じ。祝日取引の
    実施日は取引日。SQ の規則の版の全行（Calendar.holidays）とは別の集合）"""
    return frozenset(d.date for d in cal.days if not d.is_trading_day)


def trading_day(t: datetime, holidays: frozenset[date]) -> date:
    """t（aware）が属する取引日（ビューアーの bars.trading_day）。その日の 16:59 JST まではその日、夜間（17:00〜翌朝）は
    次の取引日（金曜・休業日の前日の夜間は休み明けの日）"""
    d = (t.astimezone(JST) + _SESSION_SHIFT).date()
    while d.weekday() >= 5 or d in holidays:
        d += DAY
    return d


def daily(rows: list[dict], holidays: frozenset[date], after: date) -> list[dict]:
    """値のある 1 時間足 → 取引日ごとの日足（ビューアーの bars.daily）。after 以下の取引日は出さない。
    started_at = その取引日の 00:00 JST（UTC で表す）"""
    groups: dict[date, list[dict]] = {}
    for r in sorted(rows, key=lambda r: r["started_at"]):
        groups.setdefault(trading_day(r["started_at"], holidays), []).append(r)
    out = []
    for d, rs in groups.items():
        if d > after:
            out.append({
                "started_at": datetime.combine(d, time(0), JST).astimezone(UTC),
                "open": rs[0]["open"],
                "high": max(r["high"] for r in rs),
                "low": min(r["low"] for r in rs),
                "close": rs[-1]["close"],
            })
    return out


def daily_bars(hourly: list[dict], holidays: frozenset[date], req: AtmIvRequest, read_start: datetime,
               now: datetime) -> list[dict]:
    """1 時間足を日足に束ね、started_at が [start, end) のものを返す（end ≥ now なら上端なし: 今夜の夜間は明日の取引日で
    00:00 JST が now より後になる）。読んだ範囲の先頭の取引日は捨てる（ビューアーの api._daily）"""
    after = trading_day(read_start - timedelta(microseconds=1), holidays)
    return [r for r in daily(hourly, holidays, after)
            if r["started_at"] >= req.start and (req.end >= now or r["started_at"] < req.end)]


def atm_iv_json(req: AtmIvRequest, now: datetime, bars: list[dict], last_at: datetime | None) -> dict:
    """応答の JSON。start・end は実際に読んだ範囲（end は min(end, now) を秒に切り捨て）"""
    end = min(req.end, now.astimezone(UTC).replace(microsecond=0))
    return {
        "schema_version": SCHEMA_VERSION,
        "tf": req.tf,
        "start": jst_iso(req.start),
        "end": jst_iso(end),
        "last_at": None if last_at is None else jst_iso(last_at),
        "bars": [{"t": jst_iso(b["started_at"]), "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"]}
                 for b in bars],
    }

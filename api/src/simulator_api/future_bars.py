"""/api/future_bars（先物推移。テーブル関数 future_price_latest の現在値、#190）の純粋な関数。docs/design.md 7.1・13.4。

- 要求: /api/atm_iv と同じ（atm_iv.parse_request・同じ最大日数・既定の範囲・EPOCH。型も
  AtmIvRequest をそのまま）
- 読む窓: created_at を [start（1d は − ATM_IV_DAILY_LOOKBEHIND_DAYS 日）, min(end（1d は + 1 日）, 右端) +
  FUTURE_BARS_READ_AFTER_MINUTES 分) で読む（足は price_time で切るので、UTC 0 時 = JST 9:00 の境で
  created_at が 1〜2 分遅れた行を落とさない）。足の始まりが [start, end)（1d は読む窓の [始め, 終わり)）の外の
  足は捨てる
- 足: 1m・1h は SQL（sql/future_bars.sql）が price_time で束ねた足。1d は 1 時間足を取引日に束ねる
  （atm_iv.daily_bars と同じ規則）
- 限月 m（YYYY-MM）: 足の取引日（atm_iv.trading_day）以後に取引最終日がある最初の四半期限月（3・6・9・12 月。
  取引最終日は calendar.last_trading_day = SQ の規則の休業日は版の全行）。交代は取引最終日の夜間の始まり
  （17:00 = 取引日の境）なので、1m・1h・1d のどの足も 2 限月にまたがらない。生の contract_month（SQ のある月の
  1 日〜取引最終日に 1 年先になる行がある）は使わず、食い違った足の数をログに出すだけ
- JSON: {schema_version: 1, tf, start, end, last_at, bars: [{t, o, h, l, c, m}]}。時刻は +09:00、値は円（丸めない）
"""

import math
from datetime import date, datetime, timedelta

from . import atm_iv
from . import calendar as cal_mod
from . import settings as st
from .atm_iv import DAY, AtmIvRequest
from .calendar import jst_iso

SCHEMA_VERSION = 1
QUARTER_MONTHS = (3, 6, 9, 12)


def read_window(req: AtmIvRequest, now: datetime) -> tuple[datetime, datetime, int, datetime]:
    """(SQL の start_at, SQL の end_at, step, 足の始まりの上限)。SQL の end_at = 足の上限 + 読み足しの分"""
    step = st.ATM_IV_TIMEFRAMES[req.tf][0]
    if req.tf == "1d":
        lo = req.start - timedelta(days=st.ATM_IV_DAILY_LOOKBEHIND_DAYS)
        hi = min(req.end + DAY, atm_iv.right_edge(now))
    else:
        lo, hi = req.start, req.end
    return lo, hi + timedelta(minutes=st.FUTURE_BARS_READ_AFTER_MINUTES), step, hi


def _usable(row: dict) -> bool:
    vals = [row.get(k) for k in ("open", "high", "low", "close")]
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0 for v in vals)


def bars_from_rows(rows: list[dict], lo: datetime, hi: datetime) -> tuple[list[dict], datetime | None]:
    """SQL の行 → (足の始まりが [lo, hi) で値が有限かつ正の足（started_at の昇順）, last_at)。last_at は残した足の
    created_at の最大のうち hi より前のもの（読み足しの分の行は数えない）"""
    bars = sorted((r for r in rows if lo <= r["started_at"] < hi and _usable(r)), key=lambda r: r["started_at"])
    last_ats = [r["last_at"] for r in bars if r.get("last_at") is not None and r["last_at"] < hi]
    return bars, (max(last_ats) if last_ats else None)


def front_contract(day: date, holidays: frozenset[date]) -> tuple[int, int]:
    """day（取引日）以後に取引最終日がある最初の四半期限月 (年, 月)。holidays は SQ の規則の休業日
    （Calendar.holidays）"""
    y = day.year
    for _ in range(3):  # 今年の 3・6・9・12 月、来年の 3 月…（12 月限の取引最終日を過ぎた 12 月の後半は翌年の 3 月限）
        for m in QUARTER_MONTHS:
            if cal_mod.last_trading_day(y, m, holidays) >= day:
                return y, m
        y += 1
    raise ValueError("限月が求められない")


def month_label(ym: tuple[int, int]) -> str:
    return f"{ym[0]:04d}-{ym[1]:02d}"


def with_contracts(bars: list[dict], non_trading: frozenset[date], sq_holidays: frozenset[date],
                   daily: bool = False) -> list[dict]:
    """足に限月 m を付ける（新しい dict）。daily は started_at が取引日の 00:00 JST の足（日足）"""
    out = []
    for b in bars:
        day = b["started_at"].astimezone(atm_iv.JST).date() if daily else atm_iv.trading_day(b["started_at"],
                                                                                            non_trading)
        out.append({**b, "m": month_label(front_contract(day, sq_holidays))})
    return out


def contract_mismatches(bars: list[dict]) -> int:
    """生の contract_month（DATE。月の 1 日）と求めた限月が違う足の数（ログの照合だけ）"""
    n = 0
    for b in bars:
        raw = b.get("contract_month")
        if isinstance(raw, date) and f"{raw.year:04d}-{raw.month:02d}" != b["m"]:
            n += 1
    return n


def daily_bars(hourly: list[dict], non_trading: frozenset[date], req: AtmIvRequest, read_start: datetime,
               now: datetime) -> list[dict]:
    """1 時間足 → 日足（atm_iv.daily_bars。生の contract_month は日の最後の足の値を運ぶ）"""
    days = atm_iv.daily_bars(hourly, non_trading, req, read_start, now)
    raw: dict[date, object] = {}
    for b in sorted(hourly, key=lambda r: r["started_at"]):
        raw[atm_iv.trading_day(b["started_at"], non_trading)] = b.get("contract_month")
    return [{**d, "contract_month": raw.get(d["started_at"].astimezone(atm_iv.JST).date())} for d in days]


def future_bars_json(req: AtmIvRequest, now: datetime, bars: list[dict], last_at: datetime | None) -> dict:
    """応答の JSON。start・end は atm_iv と同じ（end は min(end, now) を秒に切り捨て）"""
    base = atm_iv.atm_iv_json(req, now, [], last_at)
    base["bars"] = [{"t": jst_iso(b["started_at"]), "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"],
                     "m": b["m"]} for b in bars]
    return base

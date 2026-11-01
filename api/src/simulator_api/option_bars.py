"""/api/option_bars（銘柄の推移。表 option_price_hourly の 1 時間足、#319）の純粋な関数。docs/design.md 7.1・13.4。

- 要求: ltd（YYYY-MM-DD。実在する日付）・k（[1-9]\\d{0,6}）・type（call / put → 1 / 2）・tf（1h / 1d）の 4 つとも必須。
  同じ名前の重複・外れた値は BadRequest（パラメータの名前だけ。値は応答・ログに出さない）。知らないパラメータは無視
- 範囲の外（ltd が表の始まりより前・ltd − OPTION_BARS_LOOKBACK_DAYS 日が今日より後）はクエリを出さず bars: []
- 読む窓: started_at を [JST 0 時の (ltd − LOOKBACK 日), JST 0 時の (ltd + 1 日))。今で打ち切らない（未来の行は無い。
  キーが今に依らない = サーバー・BigQuery の結果キャッシュが効く）
- 気配: mid_open/high/low/close が有限で正かつ low ≤ open, close ≤ high、bid_close・ask_close が正で bid ≤ ask の
  ときだけ「気配あり」。そうでなければ o/h/l/c・bid・ask・bid_iv・ask_iv を null（逆転・欠けを画面に流さない。7.1）。
  bid_iv・ask_iv は片方ずつ（有限で正でなければ null）。この判定を変えるときは画面の検証（data/optionBars.ts の
  validateOptionBarsJson）も合わせる。約定は trade_close が正のときだけ、約定 IV は約定があり
  iv_close が有限で正のときだけ。気配も約定も無い足は返さない
- 1d: 1 時間足を取引日（atm_iv.trading_day。夜間 17:00 からは次の取引日）に束ねる。mid の始値 = 日の最初の気配のある
  足の o、高 / 安 = 最大 / 最小、終値 = 最後の気配のある足の c、bid / ask / bid_iv / ask_iv = 最後の気配のある足、
  約定・約定 IV = 最後の約定のある足。読んだ範囲の先頭の取引日も出す（銘柄の一生の始まりには前の夜間が無い）
- JSON: {schema_version: 1, tf, ltd, k, type, last_at, bars: [{t, o, h, l, c, bid, ask, bid_iv, ask_iv, trade,
  trade_iv}]}。時刻は +09:00、値は円（丸めない）、IV は %（表のまま）
"""

import math
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from . import atm_iv
from . import settings as st
from .atm_iv import DAY, BadRequest
from .calendar import jst_iso
from .usable import JST

SCHEMA_VERSION = 1
TYPES = {"call": 1, "put": 2}
TYPE_NAMES = {v: k for k, v in TYPES.items()}
MIN_LTD = date.fromisoformat(st.OPTION_BARS_MIN_LTD_ISO)
_LTD_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_K_RE = re.compile(r"[1-9]\d{0,6}")
# 足の値の鍵（応答の JSON の順）
QUOTE_KEYS = ("open", "high", "low", "close", "bid", "ask", "bid_iv", "ask_iv")
TRADE_KEYS = ("trade", "trade_iv")


@dataclass(frozen=True)
class OptionBarsRequest:
    ltd: date  # 取引最終日（限月）
    k: int  # 行使価格
    type: int  # 1 = call、2 = put（optionchan の type）
    tf: str  # 1h / 1d

    @property
    def key(self) -> tuple[date, int, int]:
        """行のキャッシュのキー（1h と 1d は同じ行から作る）"""
        return (self.ltd, self.k, self.type)


def _one(args, name: str) -> str:
    values = args.getlist(name) if hasattr(args, "getlist") else ([args[name]] if name in args else [])
    if len(values) != 1:
        raise BadRequest(name)
    return values[0]


def parse_request(args) -> OptionBarsRequest:
    """クエリパラメータ（MultiDict か dict）→ 要求。不正なら BadRequest(パラメータの名前)"""
    raw_ltd = _one(args, "ltd")
    if not _LTD_RE.fullmatch(raw_ltd):
        raise BadRequest("ltd")
    try:
        ltd = date.fromisoformat(raw_ltd)
    except ValueError:
        raise BadRequest("ltd") from None
    raw_k = _one(args, "k")
    if not _K_RE.fullmatch(raw_k):
        raise BadRequest("k")
    raw_type = _one(args, "type")
    if raw_type not in TYPES:
        raise BadRequest("type")
    tf = _one(args, "tf")
    if tf not in st.OPTION_BARS_TIMEFRAMES:
        raise BadRequest("tf")
    return OptionBarsRequest(ltd, int(raw_k), TYPES[raw_type], tf)


def _jst_midnight(d: date) -> datetime:
    """JST の d の 0 時（aware な UTC）"""
    return datetime.combine(d, time(0), JST).astimezone(UTC)


def in_range(req: OptionBarsRequest, now: datetime) -> bool:
    """表に行がありうる限月か（false ならクエリを出さず bars: []）"""
    today = now.astimezone(JST).date()
    return req.ltd >= MIN_LTD and req.ltd - timedelta(days=st.OPTION_BARS_LOOKBACK_DAYS) <= today


def read_window(req: OptionBarsRequest) -> tuple[datetime, datetime]:
    """SQL の (start_at, end_at)。どちらも JST の 0 時（aware な UTC）"""
    return (_jst_midnight(req.ltd - timedelta(days=st.OPTION_BARS_LOOKBACK_DAYS)), _jst_midnight(req.ltd + DAY))


def is_settled(req: OptionBarsRequest, now: datetime) -> bool:
    """取引最終日の翌日 0 時（JST）から OPTION_BARS_SETTLED_HOURS 時間が経った（表の作り直しの外 = 中身が変わらない）"""
    return now >= _jst_midnight(req.ltd + DAY) + timedelta(hours=st.OPTION_BARS_SETTLED_HOURS)


def _pos(v) -> float | int | None:
    """有限で正の数ならそのまま、そうでなければ None（bool は数として扱わない）"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v if math.isfinite(v) and v > 0 else None


def _bar(row: dict) -> dict | None:
    """表の 1 行 → 足（気配も約定も無ければ None）"""
    o, h, lo, c = (_pos(row.get(k)) for k in ("mid_open", "mid_high", "mid_low", "mid_close"))
    bid, ask = _pos(row.get("bid_close")), _pos(row.get("ask_close"))
    quoted = (None not in (o, h, lo, c, bid, ask) and lo <= min(o, c) and max(o, c) <= h and bid <= ask)
    trade = _pos(row.get("trade_close"))
    if not quoted and trade is None:
        return None
    bar = {"started_at": row["started_at"]}
    if quoted:
        bar.update(open=o, high=h, low=lo, close=c, bid=bid, ask=ask, bid_iv=_pos(row.get("bid_iv_close")),
                   ask_iv=_pos(row.get("ask_iv_close")))
    else:
        bar.update(dict.fromkeys(QUOTE_KEYS))
    bar["trade"] = trade
    bar["trade_iv"] = None if trade is None else _pos(row.get("iv_close"))
    return bar


def rows_to_hourly(rows: list[dict]) -> tuple[list[dict], datetime | None, int]:
    """SQL の行 → (1 時間足（started_at の昇順・重複なし）, last_at, 捨てた重複の数)。同じ started_at が 2 行以上あれば
    足になる（気配か約定のある）最初の行を採り、残りを重複として数える（表は一意の前提。崩れても足を消さない）。
    last_at は残した足の行の last_at の最大"""
    groups: dict[datetime, list[dict]] = {}
    for row in sorted(rows, key=lambda r: r["started_at"]):
        groups.setdefault(row["started_at"], []).append(row)
    bars: list[dict] = []
    last_ats: list[datetime] = []
    duplicates = 0
    for t in sorted(groups):
        rs = groups[t]
        duplicates += len(rs) - 1
        for row in rs:
            bar = _bar(row)
            if bar is None:
                continue
            bars.append(bar)
            if row.get("last_at") is not None:
                last_ats.append(row["last_at"])
            break
    return bars, (max(last_ats) if last_ats else None), duplicates


def daily_bars(hourly: list[dict], non_trading: frozenset[date]) -> list[dict]:
    """1 時間足 → 日足（取引日ごと。started_at = その取引日の 00:00 JST）。non_trading は is_trading_day = false の日
    （atm_iv.non_trading_days）"""
    groups: dict[date, list[dict]] = {}
    for b in sorted(hourly, key=lambda r: r["started_at"]):
        groups.setdefault(atm_iv.trading_day(b["started_at"], non_trading), []).append(b)
    out = []
    for d in sorted(groups):
        bs = groups[d]
        quoted = [b for b in bs if b["open"] is not None]
        traded = [b for b in bs if b["trade"] is not None]
        if not quoted and not traded:
            continue
        bar = {"started_at": _jst_midnight(d)}
        if quoted:
            last = quoted[-1]
            bar.update(open=quoted[0]["open"], high=max(b["high"] for b in quoted),
                       low=min(b["low"] for b in quoted), close=last["close"], bid=last["bid"], ask=last["ask"],
                       bid_iv=last["bid_iv"], ask_iv=last["ask_iv"])
        else:
            bar.update(dict.fromkeys(QUOTE_KEYS))
        if traded:
            bar.update(trade=traded[-1]["trade"], trade_iv=traded[-1]["trade_iv"])
        else:
            bar.update(dict.fromkeys(TRADE_KEYS))
        out.append(bar)
    return out


def option_bars_json(req: OptionBarsRequest, bars: list[dict], last_at: datetime | None) -> dict:
    """応答の JSON。ltd・k・type は検証後の値から作り直す（入力文字列を反射しない）"""
    return {
        "schema_version": SCHEMA_VERSION,
        "tf": req.tf,
        "ltd": req.ltd.isoformat(),
        "k": req.k,
        "type": TYPE_NAMES[req.type],
        "last_at": None if last_at is None else jst_iso(last_at),
        "bars": [{"t": jst_iso(b["started_at"]), "o": b["open"], "h": b["high"], "l": b["low"], "c": b["close"],
                  "bid": b["bid"], "ask": b["ask"], "bid_iv": b["bid_iv"], "ask_iv": b["ask_iv"],
                  "trade": b["trade"], "trade_iv": b["trade_iv"]} for b in bars],
    }

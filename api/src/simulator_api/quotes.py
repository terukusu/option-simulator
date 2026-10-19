"""中立の「気配の一覧」→ 板の JSON 版 1（docs/data-sources.md「中立の気配の一覧」。#154）。純粋な関数（ログだけ出す）。

供給元（証券会社の API・有料のデータ API）ごとに違うのは「自分の API から気配を取り出して、この形に書く」部分だけにし、
限月の取引最終日・SQ 日（カレンダーの規則）、行の組み立て（chain.parse_board）、reason、使える板の判定
（usable.board_ok）、板の JSON の形（chain.chain_json）は optionchan の板と同じコードを通す。

形（版 1。知らないキーは無視。任意のキーは省略 = null）:

    {quotes_version: 1, source?: "<表示名>", snapshot_at: <ISO 8601・オフセット付き>, delayed_minutes: <≥ 0>,
     future: {contract_month: "YYYY-MM", price, price_time?},
     spot?: {price, price_time?} | null,
     options: [{contract_month: "YYYY-MM", type: "call" | "put", k: <整数円>, bid, ask,
                bid_iv?, ask_iv?, price?, price_time?, iv?, volume?, positions?, delta?, gamma?, theta?, vega?,
                quotation?, quotation_date?, is_atm?}]}

- bid・ask は null 可（キーは必須）。価格は円、IV は %（板の JSON と同じ）。グリークは原資産 1 単位あたり（設計 5.6）
- 検証の失敗は QuotesError（メッセージは JSON の位置だけで、値を入れない）。使える板でなければ QuotesUnusable
- snapshot_at が今から QUOTES_MAX_FUTURE_SECONDS より先（未来）なら QuotesError（chain_from_quotes。時計の誤り）
"""

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from . import calendar as cal_mod
from . import chain, usable
from . import settings as st

QUOTES_VERSION = 1
DEFAULT_SOURCE = "quotes"
MAX_OPTIONS = 10000  # 1 つの一覧の行の上限（2 限月 × 322 行 × 2 種別でも約 1,300）
_SOURCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$")
_ISO_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_YEAR_MONTH = re.compile(r"^(\d{4})-(\d{2})$")
_TYPES = {"call": 1, "put": 2}
# 任意の数値の列 → 下限（None = 下限なし）
_PRICE_KEYS = ("bid_iv", "ask_iv", "price", "iv", "quotation")
_GREEK_KEYS = ("delta", "gamma", "theta", "vega")
_COUNT_KEYS = ("volume", "positions")


class QuotesError(ValueError):
    """気配の一覧の形が不正（引数は JSON の位置と理由。値は入れない）"""


class QuotesUnusable(Exception):
    """形は正しいが使える板でない（先物の価格が無い・先物 ±5% の両側気配が足りない）"""


@dataclass(frozen=True)
class Quotes:
    snapshot_at: datetime  # aware
    delayed_minutes: int | float
    source: str
    future: dict  # {price, price_time, contract_month: date（月の 1 日）}
    spot: dict | None
    options: tuple[dict, ...]  # {contract_month: date（月の 1 日）, type: 1 | 2, target_price, bid, ...}


def _num(o: dict, key: str, path: str, *, required=False, minimum: float | None = 0, integer=False):
    if key not in o:
        if required:
            raise QuotesError(f"{path}.{key}: キーが無い")
        return None
    v = o[key]
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
        raise QuotesError(f"{path}.{key}: 有限の数でない")
    if minimum is not None and v < minimum:
        raise QuotesError(f"{path}.{key}: {minimum} 未満")
    if integer and not float(v).is_integer():
        raise QuotesError(f"{path}.{key}: 整数でない")
    return int(v) if integer else v


def _instant(v, path: str, *, required=False) -> datetime | None:
    if v is None and not required:
        return None
    if not isinstance(v, str) or not _ISO_INSTANT.match(v):
        raise QuotesError(f"{path}: ISO 8601（オフセット付き）の時刻でない")
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise QuotesError(f"{path}: 存在しない時刻") from None


def _date(v, path: str) -> date | None:
    if v is None:
        return None
    if not isinstance(v, str) or not _ISO_DATE.match(v):
        raise QuotesError(f"{path}: YYYY-MM-DD の日付でない")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise QuotesError(f"{path}: 存在しない日付") from None


def _month(v, path: str) -> date:
    m = _YEAR_MONTH.match(v) if isinstance(v, str) else None
    if m is None or not 1 <= int(m.group(2)) <= 12:
        raise QuotesError(f"{path}: YYYY-MM の限月でない")
    return date(int(m.group(1)), int(m.group(2)), 1)


def _object(v, path: str) -> dict:
    if not isinstance(v, dict):
        raise QuotesError(f"{path}: オブジェクトでない")
    return v


def _option(o, path: str) -> dict:
    o = _object(o, path)
    if "contract_month" not in o:
        raise QuotesError(f"{path}.contract_month: キーが無い")
    typ = _TYPES.get(o.get("type")) if isinstance(o.get("type"), str) else None
    if typ is None:
        raise QuotesError(f"{path}.type: call / put でない")
    k = _num(o, "k", path, required=True, minimum=1, integer=True)
    if k is None:
        raise QuotesError(f"{path}.k: null は不可")
    for key in ("bid", "ask"):
        if key not in o:
            raise QuotesError(f"{path}.{key}: キーが無い（欠損は null）")
    row = {"contract_month": _month(o["contract_month"], f"{path}.contract_month"), "type": typ, "target_price": k,
           "bid": _num(o, "bid", path), "ask": _num(o, "ask", path)}
    for key in _PRICE_KEYS:
        row[key] = _num(o, key, path)
    for key in _GREEK_KEYS:
        row[key] = _num(o, key, path, minimum=None)
    for key in _COUNT_KEYS:
        row[key] = _num(o, key, path, integer=True)
    row["price_time"] = _instant(o.get("price_time"), f"{path}.price_time")
    row["quotation_date"] = _date(o.get("quotation_date"), f"{path}.quotation_date")
    is_atm = o.get("is_atm")
    if is_atm is not None and not isinstance(is_atm, bool):
        raise QuotesError(f"{path}.is_atm: 真偽値でない")
    row["is_atm"] = is_atm
    return row


def parse_quotes(obj) -> Quotes:
    """JSON.loads の結果 → Quotes（形の検証だけ。中身の矛盾（bid > ask など）は画面の正規化に任せる）"""
    root = _object(obj, "$")
    version = root.get("quotes_version")
    if isinstance(version, bool) or version != QUOTES_VERSION:
        raise QuotesError(f"$.quotes_version: 未対応の版（対応は {QUOTES_VERSION}）")
    snapshot_at = _instant(root.get("snapshot_at"), "$.snapshot_at", required=True)
    delayed = _num(root, "delayed_minutes", "$", required=True)
    if delayed is None:
        raise QuotesError("$.delayed_minutes: null は不可")
    source = root.get("source", DEFAULT_SOURCE)
    if not isinstance(source, str) or not _SOURCE_RE.match(source):
        raise QuotesError("$.source: 英数字と _ . - の 40 文字までの名前でない")
    fo = _object(root.get("future"), "$.future")
    if "contract_month" not in fo:
        raise QuotesError("$.future.contract_month: キーが無い")
    future = {"contract_month": _month(fo["contract_month"], "$.future.contract_month"),
              "price": _num(fo, "price", "$.future"),
              "price_time": _instant(fo.get("price_time"), "$.future.price_time")}
    spot = None
    if root.get("spot") is not None:
        so = _object(root["spot"], "$.spot")
        spot = {"price": _num(so, "price", "$.spot"), "price_time": _instant(so.get("price_time"), "$.spot.price_time")}
    options = root.get("options")
    if not isinstance(options, list):
        raise QuotesError("$.options: 配列でない")
    if not options:
        raise QuotesError("$.options: 行が 0 件")
    if len(options) > MAX_OPTIONS:
        raise QuotesError(f"$.options: 行が {MAX_OPTIONS} 件を超える")
    rows = tuple(_option(o, f"$.options[{i}]") for i, o in enumerate(options))
    return Quotes(snapshot_at=snapshot_at, delayed_minutes=delayed, source=source, future=future, spot=spot,
                  options=rows)


def reason_at(snapshot_at: datetime, now: datetime) -> str:
    """気配の時刻の reason（7.2 と同じ窓）: 新しい（CLOSED_AFTER_MINUTES 以内）かつ連続売買の窓なら latest、
    それ以外は usable.classify（寄り前 / 引け後 / closed）"""
    run = usable.Run(snapshot_at=snapshot_at, rows_option=st.MIN_ROWS, finished_at=snapshot_at)
    if usable.is_fresh(run, now) and usable.in_session(snapshot_at):
        return "latest"
    return usable.classify(run, now)


def chain_from_quotes(q: Quotes, cal: cal_mod.Calendar, now: datetime) -> tuple[dict, str]:
    """Quotes + 取引カレンダー → (板の JSON 版 1, reason)。snapshot_at が未来なら QuotesError、使える板でなければ
    QuotesUnusable"""
    if q.snapshot_at > now + timedelta(seconds=st.QUOTES_MAX_FUTURE_SECONDS):
        raise QuotesError("$.snapshot_at: 今より先の時刻")
    holidays = cal.holidays
    ltd_of: dict[date, date] = {}
    option_rows = []
    for o in q.options:
        cm = o["contract_month"]
        if cm not in ltd_of:
            ltd_of[cm] = cal_mod.last_trading_day(cm.year, cm.month, holidays)
        row = {k: v for k, v in o.items() if k != "contract_month"}
        row["last_trading_day"] = ltd_of[cm]
        option_rows.append(row)
    if not usable.board_ok(option_rows, q.future["price"]):
        raise QuotesUnusable("quotes_unusable")
    reason = reason_at(q.snapshot_at, now)
    months = chain.parse_board(option_rows)
    obj = chain.chain_json(q.snapshot_at, reason, months, q.future, q.spot, cal, source=q.source,
                           delayed_minutes=q.delayed_minutes)
    return obj, reason

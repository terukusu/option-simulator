"""/api/jscc_scenarios（JSCC の VaR パラメータ。#382・docs/design.md 5.10・7.1・ADR-0013）の純粋な関数。

画面は今の必要証拠金を JSCC と同じ手順（HS-ES）でブラウザで計算する（model/jsccMargin.ts）。サーバーは基準日の 1 限月の
行を optionchan の表から読んでキャッシュし、要求の銘柄の行だけを返す（額は計算しない = 計算はブラウザ）。

- 要求: date（YYYY-MM-DD。実在の日付、JSCC_MIN_DATE 以上・今日 + JSCC_MAX_AHEAD_DAYS 日以下）・i（銘柄のキー。1〜
  JSCC_MAX_KEYS 個・重複不可。OP = NK225E-YYYYMM-C|P-行使価格、先物 = NK225F|NK225MF|NK225MCF-YYYYMM。限月は
  JSCC_MAX_PERIODS 個まで）。外れは BadRequest（パラメータの名前だけ。値は応答・ログに出さない）。
  知らないパラメータは無視
- 読み方: jscc_runs（基準日の取り込みの記録）→ succeeded の最新の finished_at の run_id。無ければ
  unavailable / not_ready。
  シナリオの並び・パラメータ（集計グループ IDX_IDX のレコード 0）・行（限月ごと）は同じ日の表から読み、どれかの
  jscc_run_id が run_id と違えば unavailable / inconsistent（失敗した後の取り直しの途中など）
- pnl は 1 枚あたりの円（Contract Size を掛けた後。掛けない）。行は array（int32。入らなければ int64）で持つ
- 応答: {schema_version: 1, status: "ok", business_date, confidence_level, stress_scenario_number, scenario_types,
  instruments: [{key, aggregation_group, contract_size, price, pnl}], missing: [key…]} / {schema_version: 1,
  status: "unavailable", reason, business_date}
"""

import math
import re
from array import array
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal

from . import settings as st
from .atm_iv import BadRequest
from .usable import JST

SCHEMA_VERSION = 1
MIN_DATE = date.fromisoformat(st.JSCC_MIN_DATE_ISO)
OPTION_PRODUCT = "NK225E"
FUTURE_PRODUCTS = ("NK225F", "NK225MF", "NK225MCF")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_KEY_RE = re.compile(r"(NK225E)-(\d{4})(\d{2})-([CP])-([1-9]\d{0,6})|(NK225F|NK225MF|NK225MCF)-(\d{4})(\d{2})")


@dataclass(frozen=True)
class JsccRequest:
    date: date
    keys: tuple[str, ...]  # 昇順・重複なし

    @property
    def periods(self) -> tuple[str, ...]:
        """要求の限月（YYYYMM。昇順）"""
        return tuple(sorted({period_of(k) for k in self.keys}))


def period_of(key: str) -> str:
    return key.split("-")[1]


def _valid_key(raw: str) -> bool:
    m = _KEY_RE.fullmatch(raw)
    if not m:
        return False
    month = int(m.group(3) or m.group(8))
    return 1 <= month <= 12


def parse_request(args, now: datetime) -> JsccRequest:
    """クエリパラメータ（MultiDict か dict）→ 要求。不正なら BadRequest(パラメータの名前)"""
    dates = args.getlist("date") if hasattr(args, "getlist") else ([args["date"]] if "date" in args else [])
    if len(dates) != 1 or not _DATE_RE.fullmatch(dates[0]):
        raise BadRequest("date")
    try:
        d = date.fromisoformat(dates[0])
    except ValueError:
        raise BadRequest("date") from None
    today = now.astimezone(JST).date()
    if d < MIN_DATE or d > today + timedelta(days=st.JSCC_MAX_AHEAD_DAYS):
        raise BadRequest("date")
    keys = args.getlist("i") if hasattr(args, "getlist") else ([args["i"]] if "i" in args else [])
    if not 1 <= len(keys) <= st.JSCC_MAX_KEYS or len(set(keys)) != len(keys):
        raise BadRequest("i")
    if not all(isinstance(k, str) and _valid_key(k) for k in keys):
        raise BadRequest("i")
    if len({period_of(k) for k in keys}) > st.JSCC_MAX_PERIODS:
        raise BadRequest("i")
    return JsccRequest(d, tuple(sorted(keys)))


def pick_run(rows: list[dict]) -> str | None:
    """jscc_runs の行 → succeeded の最新の finished_at の jscc_run_id（無ければ None）"""
    ok = [r for r in rows if r.get("status") == "succeeded" and r.get("finished_at") is not None]
    if not ok:
        return None
    return max(ok, key=lambda r: r["finished_at"])["jscc_run_id"]


@dataclass(frozen=True)
class ScenarioSet:
    run_id: str
    types: str  # "HH…S"（添字 = pnl の添字）
    confidence_level: float
    stress_scenario_number: int


class Inconsistent(Exception):
    """表の間で jscc_run_id が違う・シナリオの並びが読めない（unavailable / inconsistent）"""


def scenario_set(run_id: str, set_rows: list[dict], param_rows: list[dict]) -> ScenarioSet:
    """jscc_scenario_set・jscc_parameter の行 → 並びとパラメータ。run_id が違う・行が 1 つでない・形が違えば
    Inconsistent"""
    sets = [r for r in set_rows if r.get("jscc_run_id") == run_id]
    if len(sets) != 1 or len(set_rows) != 1:
        raise Inconsistent("scenario_set")
    types = "".join(str((s or {}).get("scenario_type", "")) for s in (sets[0].get("scenarios") or []))
    if not types or not re.fullmatch(r"[HS]+", types) or "H" not in types:
        raise Inconsistent("scenario_set")
    params = [r for r in param_rows if r.get("aggregation_group") == st.JSCC_AGGREGATION_GROUP]
    if len(params) != 1 or params[0].get("jscc_run_id") != run_id or any(
            r.get("jscc_run_id") != run_id for r in param_rows):
        raise Inconsistent("parameter")
    conf = params[0].get("confidence_level")
    n_stress = params[0].get("stress_scenario_number")
    if (not isinstance(conf, (int, float)) or isinstance(conf, bool) or not math.isfinite(conf)
            or not 0 < conf < 100):
        raise Inconsistent("parameter")
    if not isinstance(n_stress, int) or isinstance(n_stress, bool) or not 0 <= n_stress <= types.count("S"):
        raise Inconsistent("parameter")
    return ScenarioSet(run_id, types, float(conf), n_stress)


@dataclass(frozen=True)
class Instrument:
    key: str
    aggregation_group: str
    contract_size: int
    price: float | None
    pnl: array


def _strike_text(v) -> str | None:
    """NUMERIC の行使価格（Decimal / int / float）→ 整数の文字列（整数でなければ None）"""
    if v is None or isinstance(v, bool):
        return None
    d = Decimal(str(v)) if not isinstance(v, Decimal) else v
    if not d.is_finite() or d != d.to_integral_value() or d <= 0:
        return None
    return str(int(d))


def row_key(row: dict) -> str | None:
    """jscc_scenario の行 → 銘柄のキー（扱わない行は None）"""
    product = row.get("product_code")
    cp = row.get("contract_period_code")
    if not isinstance(cp, str) or not re.fullmatch(r"\d{6}", cp):
        return None
    if product == OPTION_PRODUCT and row.get("contract_type") == "OOP":
        pc = row.get("put_call_type")
        k = _strike_text(row.get("strike_price"))
        if pc not in ("C", "P") or k is None:
            return None
        return f"{product}-{cp}-{pc}-{k}"
    if product in FUTURE_PRODUCTS and row.get("contract_type") == "FUT":
        return f"{product}-{cp}"
    return None


def _pnl_array(values) -> array:
    try:
        return array("i", values)
    except OverflowError:
        return array("q", values)


def instruments_from_rows(run_id: str, rows: list[dict], n: int) -> dict[str, Instrument]:
    """jscc_scenario の行（1 限月）→ キー → 行。run_id が違う行・pnl の長さが n でない行があれば Inconsistent。
    同じキーが 2 行あれば Inconsistent（表は銘柄で一意の前提）"""
    out: dict[str, Instrument] = {}
    for r in rows:
        if r.get("jscc_run_id") != run_id:
            raise Inconsistent("scenario")
        key = row_key(r)
        if key is None:
            continue
        pnl = r.get("pnl") or []
        if len(pnl) != n or not all(isinstance(x, int) and not isinstance(x, bool) for x in pnl):
            raise Inconsistent("scenario")
        if key in out:
            raise Inconsistent("scenario")
        price = r.get("price")
        price = float(price) if isinstance(price, (int, float, Decimal)) and not isinstance(price, bool) else None
        if price is not None and not math.isfinite(price):
            price = None
        cs = r.get("contract_size")
        if not isinstance(cs, int) or isinstance(cs, bool) or cs <= 0:
            raise Inconsistent("scenario")
        out[key] = Instrument(key, str(r.get("aggregation_group") or ""), cs, price, _pnl_array(pnl))
    return out


def ok_json(req: JsccRequest, s: ScenarioSet, by_period: dict[str, dict[str, Instrument]]) -> dict:
    """応答（ok）。要求のキーの順。行の無いキー・集計グループの違うキーは missing"""
    instruments = []
    missing = []
    for key in req.keys:
        inst = by_period.get(period_of(key), {}).get(key)
        # パラメータ（信頼水準・ストレスの本数）は集計グループ JSCC_AGGREGATION_GROUP のものだけを返すので、
        # ほかのグループの銘柄は無い扱い（日経225 の銘柄はすべて IDX_IDX。画面は概算に戻る）
        if inst is None or inst.aggregation_group != st.JSCC_AGGREGATION_GROUP:
            missing.append(key)
            continue
        instruments.append({"key": key, "aggregation_group": inst.aggregation_group,
                            "contract_size": inst.contract_size, "price": inst.price, "pnl": inst.pnl.tolist()})
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "business_date": req.date.isoformat(),
        "confidence_level": s.confidence_level,
        "stress_scenario_number": s.stress_scenario_number,
        "scenario_types": s.types,
        "instruments": instruments,
        "missing": missing,
    }


def unavailable_json(d: date, reason: str) -> dict:
    return {"schema_version": SCHEMA_VERSION, "status": "unavailable", "reason": reason,
            "business_date": d.isoformat()}


# ---- 当て直しの r・g（/api/jscc_factors。#387・docs/design.md 5.10・ADR-0014） ----
# optionchan が毎日 jscc_var_scenario から当てはめた限月ごとの r（先物の対数リターン）・g（標準化 moneyness の 13 節点の
# IV の対数変化）を読み、要求の限月の行だけを整数に量子化して返す（当てはめはしない = 計算はブラウザと optionchan）。

FACTOR_PRODUCTS = (OPTION_PRODUCT, *FUTURE_PRODUCTS)
FACTOR_NODE_COUNT = 13
FACTOR_SCALE_R = 1_000_000
FACTOR_SCALE_G = 10_000
_PERIOD_RE = re.compile(r"(\d{4})(\d{2})")


@dataclass(frozen=True)
class FactorRequest:
    date: date
    periods: tuple[str, ...]  # YYYYMM（昇順・重複なし）


def parse_factor_request(args, now: datetime) -> FactorRequest:
    """クエリパラメータ → 要求（date は parse_request と同じ検査、p = YYYYMM を 1〜JSCC_FACTOR_MAX_PERIODS 個・
    重複なし）。
    不正なら BadRequest(パラメータの名前)。値は応答・ログに出さない"""
    dates = args.getlist("date") if hasattr(args, "getlist") else ([args["date"]] if "date" in args else [])
    if len(dates) != 1 or not _DATE_RE.fullmatch(dates[0]):
        raise BadRequest("date")
    try:
        d = date.fromisoformat(dates[0])
    except ValueError:
        raise BadRequest("date") from None
    today = now.astimezone(JST).date()
    if d < MIN_DATE or d > today + timedelta(days=st.JSCC_MAX_AHEAD_DAYS):
        raise BadRequest("date")
    ps = args.getlist("p") if hasattr(args, "getlist") else ([args["p"]] if "p" in args else [])
    if not 1 <= len(ps) <= st.JSCC_FACTOR_MAX_PERIODS or len(set(ps)) != len(ps):
        raise BadRequest("p")
    for p in ps:
        m = _PERIOD_RE.fullmatch(p) if isinstance(p, str) else None
        if not m or not 1 <= int(m.group(2)) <= 12:
            raise BadRequest("p")
    return FactorRequest(d, tuple(sorted(ps)))


@dataclass(frozen=True)
class FactorRow:
    r: array  # int32（r × 1e6）
    g: array | None  # int32（g × 1e4。13 × 本数）。先物だけ・当てはめられない行は None
    check_median_rel: float | None = None  # 推定の質（基準の状態の 1 枚の売りの ES の相対誤差の中央値。比）
    check_p90_rel: float | None = None  # 同じ 90 パーセンタイル


@dataclass(frozen=True)
class FactorDay:
    nodes: tuple[float, ...] | None  # 13 個の昇順（OP の行が 1 つも無ければ None）
    rows: dict[str, FactorRow]  # キー = 商品-YYYYMM
    dropped: int  # 範囲の外・形の違う行（使わない）の数


def _floats(values) -> list[float] | None:
    out = []
    for x in values or []:
        if isinstance(x, bool) or not isinstance(x, (int, float, Decimal)):
            return None
        f = float(x)
        if not math.isfinite(f):
            return None
        out.append(f)
    return out


def _rel(v) -> float | None:
    """相対誤差（比）。数でない・有限でない・負は None（質が分からない）"""
    if isinstance(v, bool) or not isinstance(v, (int, float, Decimal)):
        return None
    f = float(v)
    return f if math.isfinite(f) and f >= 0 else None


def factor_day(run_id: str, rows: list[dict], n: int) -> FactorDay:
    """jscc_factor の行（1 日分）→ キー → 量子化した r・g。run_id の違う行・同じキーが 2 行・行の間で節点が違えば
    Inconsistent。長さ・範囲（|r| ≤ 1・|g| ≤ 3）の外れた行は使わない（その限月は missing）。週次などは飛ばす"""
    out: dict[str, FactorRow] = {}
    nodes: tuple[float, ...] | None = None
    dropped = 0
    for row in rows:
        if row.get("jscc_run_id") != run_id:
            raise Inconsistent("factor")
        product = row.get("product_code")
        cp = row.get("contract_period_code")
        if product not in FACTOR_PRODUCTS or not isinstance(cp, str) or not _PERIOD_RE.fullmatch(cp):
            continue
        key = f"{product}-{cp}"
        if key in out:
            raise Inconsistent("factor")
        r = _floats(row.get("r"))
        g = _floats(row.get("g"))
        nd = _floats(row.get("nodes"))
        if r is None or g is None or nd is None or len(r) != n or any(abs(x) > 1 for x in r):
            dropped += 1
            continue
        if g:
            if (len(g) != FACTOR_NODE_COUNT * n or any(abs(x) > 3 for x in g) or len(nd) != FACTOR_NODE_COUNT
                    or any(b <= a for a, b in zip(nd, nd[1:], strict=False))):
                dropped += 1
                continue
            if nodes is None:
                nodes = tuple(nd)
            elif nodes != tuple(nd):
                raise Inconsistent("factor")
        out[key] = FactorRow(array("i", (round(x * FACTOR_SCALE_R) for x in r)),
                             array("i", (round(x * FACTOR_SCALE_G) for x in g)) if g else None,
                             _rel(row.get("check_median_rel")), _rel(row.get("check_p90_rel")))
    return FactorDay(nodes, out, dropped)


def pick_factor_date(req: FactorRequest, runs: list[dict], quality: list[dict],
                     max_back: int = st.JSCC_FACTOR_MAX_BACK,
                     max_median: float = st.JSCC_FACTOR_MAX_MEDIAN_REL) -> tuple[date, str] | None:
    """遡り（#387）: 基準日 req.date 以前で、succeeded のある日を新しい順に max_back 日まで見て、要求の限月がすべて
    当て直しの表にあり（OP・先物のどちらかの行）、OP（NK225E）の行の推定の質（check_median_rel）が max_median 以下
    （NULL は分からない = 使う）の最も新しい日と、その日の run_id。無ければ None。runs・quality は
    jscc_runs_range・jscc_factor_quality の行（日をまたぐ）。行の run_id がその日の run_id と違う行は見ない"""
    by_date: dict = {}
    for r in runs:
        d = r.get("business_date")
        if isinstance(d, date) and d <= req.date:
            by_date.setdefault(d, []).append(r)
    days = sorted(((d, pick_run(rs)) for d, rs in by_date.items()), key=lambda x: x[0], reverse=True)
    days = [(d, run) for d, run in days if run is not None and d >= MIN_DATE][:max_back]
    for d, run in days:
        have: set[str] = set()
        bad: set[str] = set()
        for q in quality:
            if q.get("business_date") != d or q.get("jscc_run_id") != run:
                continue
            cp = q.get("contract_period_code")
            if q.get("product_code") not in FACTOR_PRODUCTS or not isinstance(cp, str):
                continue
            have.add(cp)
            med = _rel(q.get("check_median_rel"))
            if q.get("product_code") == OPTION_PRODUCT and med is not None and med > max_median:
                bad.add(cp)
        if all(p in have and p not in bad for p in req.periods):
            return d, run
    return None


def factors_ok_json(req: FactorRequest, s: ScenarioSet, day: FactorDay, used: date | None = None) -> dict:
    """応答（ok）。business_date = 使った日（遡ったときは基準日より前。#387）、requested_date = 要求の基準日。
    要求の限月の行だけ（商品-限月の昇順）。行の 1 つも無い限月は missing。節点が無い日（OP の行が無い）
    は g のある行を返さない（missing に入る）"""
    rows = []
    missing = []
    for p in req.periods:
        keys = sorted(k for k in day.rows if k.endswith(f"-{p}"))
        got = False
        for k in keys:
            fr = day.rows[k]
            rows.append({"key": k, "r": fr.r.tolist(), "g": fr.g.tolist() if fr.g is not None else None,
                         "check_median_rel": fr.check_median_rel, "check_p90_rel": fr.check_p90_rel})
            got = True
        if not got:
            missing.append(p)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "business_date": (used or req.date).isoformat(),
        "requested_date": req.date.isoformat(),
        "confidence_level": s.confidence_level,
        "stress_scenario_number": s.stress_scenario_number,
        "scenario_types": s.types,
        "nodes": list(day.nodes) if day.nodes is not None else [-5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3],
        "scale": {"r": FACTOR_SCALE_R, "g": FACTOR_SCALE_G},
        "rows": rows,
        "missing": missing,
    }

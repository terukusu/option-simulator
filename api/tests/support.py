"""テストの補助: 合成の板（fixtures/synthetic/*.json）→ optionchan のテーブル関数の行、偽の runner・時計。

値はすべて架空（合成の板・合成のカレンダー）。BigQuery クライアントが返す Python の型に合わせる
（TIMESTAMP = aware な datetime（UTC）、DATETIME = naive な datetime（JST の壁時計）、DATE = date）。
"""

import json
import threading
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta, timezone

from conftest import REPO_ROOT

JST = timezone(timedelta(hours=9))
FIXTURES_DIR = REPO_ROOT / "fixtures" / "synthetic"
SIDE_KEYS = ("bid", "ask", "bid_iv", "ask_iv", "price", "price_time", "iv", "volume", "positions", "quotation",
             "quotation_date", "delta", "gamma", "theta", "vega", "is_atm")
# 気配だけの供給元で NULL になりうる列（docs/data-sources.md 2 章。#272）。scripts/synthBoard.ts の
# QUOTES_ONLY_NULL_KEYS と同じ
QUOTES_ONLY_NULL_KEYS = tuple(k for k in SIDE_KEYS if k not in ("bid", "ask"))


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


def quotes_only(fx: dict) -> dict:
    """板の JSON の写しで、欠けうる列（QUOTES_ONLY_NULL_KEYS）と日経平均を null にしたもの
    （気配 bid / ask と限月・先物だけ）"""
    out = json.loads(json.dumps(fx))
    out["spot"] = {"price": None, "price_time": None}
    for m in out["months"]:
        for r in m["rows"]:
            for side in (r["call"], r["put"]):
                side.update(dict.fromkeys(QUOTES_ONLY_NULL_KEYS))
    return out


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
        self.cm: list[tuple[datetime, float | None]] = []  # atm_cm_iv の (created_at, iv30)
        # atm_cm_iv の行（created_at・iv30・m1_last_trading_day・m1_forward・m2_last_trading_day・m2_forward。#152）
        self.cm_daily: list[dict] = []
        # future_price_latest を範囲で読む行（created_at・price・price_time・contract_month。#190）
        self.fut: list[dict] = []

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
    gates: 名前 → threading.Event（その名前の呼び出しだけ止める）。started: 名前 → 呼び出しの開始で set される Event。
    events: ("start" | "end", 名前) の順の記録（end は例外でも記録する）
    """

    def __init__(self, world: World, errors=None, gate: threading.Event | None = None,
                 gates: dict[str, threading.Event] | None = None):
        self.world = world
        self.errors = errors or {}
        self.gate = gate
        self.gates = gates or {}
        self.calls: list[tuple[str, dict]] = []
        self.events: list[tuple[str, str]] = []
        self.started: defaultdict[str, threading.Event] = defaultdict(threading.Event)
        self._lock = threading.Lock()

    def names(self) -> list[str]:
        with self._lock:
            return [n for n, _ in self.calls]

    def count(self, name: str) -> int:
        return self.names().count(name)

    def reset(self):
        with self._lock:
            self.calls.clear()
            self.events.clear()

    def ended(self, name: str) -> bool:
        with self._lock:
            return ("end", name) in self.events

    def __call__(self, name, params):
        with self._lock:
            self.calls.append((name, dict(params)))
            self.events.append(("start", name))
            started = self.started[name]
        started.set()
        try:
            return self._answer(name, params)
        finally:
            with self._lock:
                self.events.append(("end", name))

    def _answer(self, name, params):
        if self.gate is not None:
            self.gate.wait(5)
        if name in self.gates:
            self.gates[name].wait(5)
        if name in self.errors:
            raise self.errors[name]
        w = self.world
        if name == "trading_calendar":
            return [dict(r) for r in w.calendar]
        start, end = params["start_at"], params["end_at"]
        if name == "atm_cm_iv":
            return cm_bars([p for p in w.cm if start <= p[0] < end], params["step"])
        if name == "atm_cm_daily":
            return cm_daily([r for r in w.cm_daily if start <= r["created_at"] < end])
        if name == "future_bars":
            return fut_bars([r for r in w.fut if start <= r["created_at"] < end], params["step"])
        if name == "latest_runs":
            rows = [dict(r) for r in w.runs if start <= r["snapshot_at"] < end]
            return sorted(rows, key=lambda r: r["snapshot_at"], reverse=True)
        table = {"option_price": w.options, "future_price": w.futures, "spot_price": w.spots}[name]
        return [dict(r) for at, rows in table.items() if start <= at < end for r in rows]


def cm_rows(start: datetime, end: datetime, every_minutes=1, value=lambda t: 20.0) -> list[tuple]:
    """合成の atm_cm_iv の (created_at, iv30)（架空の IV）。[start, end) の every_minutes 分ごと。
    value(t) が None ならその行の iv30 は NULL"""
    out, t = [], start
    while t < end:
        out.append((t, value(t)))
        t += timedelta(minutes=every_minutes)
    return out


def cm_bars(points: list[tuple], step: int) -> list[dict]:
    """sql/atm_cm_iv.sql と同じ束ね方（偽の runner 用）: UNIX 秒で step 秒に切り、open / close = 時間順で最初 / 最後の
    NULL でない値、high / low = 最大 / 最小、last_at = NULL の行を含めた created_at の最大。全部 NULL の足も行を返す"""
    groups: dict[int, list[tuple]] = {}
    for at, iv in sorted(points):
        ts = int(at.timestamp())
        groups.setdefault(ts - ts % step, []).append((at, iv))
    rows = []
    for key in sorted(groups):
        ps = groups[key]
        vals = [iv for _, iv in ps if iv is not None]
        rows.append({"started_at": datetime.fromtimestamp(key, UTC), "open": vals[0] if vals else None,
                     "high": max(vals) if vals else None, "low": min(vals) if vals else None,
                     "close": vals[-1] if vals else None, "last_at": max(at for at, _ in ps)})
    return rows


def fut_row(created_at: datetime, price, traded: datetime | None = None, contract_month=date(2026, 12, 1)) -> dict:
    """合成の future_price_latest の 1 行（#190。架空の値）。traded は約定の時刻（既定は created_at の分）。
    price_time は JST の壁時計（DATETIME）"""
    t = created_at if traded is None else traded
    return {"created_at": created_at, "price": price, "price_time": wall_of(t.replace(second=0, microsecond=0)),
            "contract_month": contract_month}


def fut_bars(rows: list[dict], step: int) -> list[dict]:
    """sql/future_bars.sql と同じ束ね方（偽の runner 用）: price > 0 かつ price_time が NULL でない行を
    price_time（JST）の UNIX 秒で step 秒に切り、open / close = (traded_at, created_at) の順で最初 / 最後、
    high / low = 最大 / 最小、last_at = created_at の最大、contract_month = 最大"""
    groups: dict[int, list[tuple]] = {}
    for r in rows:
        if r["price"] is None or r["price"] <= 0 or r["price_time"] is None:
            continue
        traded = r["price_time"].replace(tzinfo=JST)
        ts = int(traded.timestamp())
        groups.setdefault(ts - ts % step, []).append((traded, r["created_at"], r))
    out = []
    for key in sorted(groups):
        ps = sorted(groups[key], key=lambda p: (p[0], p[1]))
        prices = [p[2]["price"] for p in ps]
        out.append({"started_at": datetime.fromtimestamp(key, UTC), "open": prices[0], "high": max(prices),
                    "low": min(prices), "close": prices[-1], "last_at": max(p[1] for p in ps),
                    "contract_month": max(p[2]["contract_month"] for p in ps)})
    return out


def cm_daily_row(at: datetime, iv30=20.0, f1=30000.0, l1=date(2026, 11, 12), f2=30010.0,
                 l2=date(2026, 12, 10), m1_iv=21.0, m2_iv=19.5) -> dict:
    """合成の atm_cm_iv の 1 行（#152。m1_iv・m2_iv は #307。架空の値）"""
    return {"created_at": at, "iv30": iv30, "m1_last_trading_day": l1, "m1_forward": f1, "m2_last_trading_day": l2,
            "m2_forward": f2, "m1_iv": m1_iv, "m2_iv": m2_iv}


def cm_daily(rows: list[dict]) -> list[dict]:
    """sql/atm_cm_daily.sql と同じ束ね方（偽の runner 用）: JST 9:00〜15:00（両端含む）の行のうち iv30・m1_forward・
    m1_last_trading_day が NULL でない最後の行を JST の日付ごとに。day の昇順"""
    lo, hi = time(9, 0), time(15, 0)
    last: dict[date, dict] = {}
    for r in sorted(rows, key=lambda r: r["created_at"]):
        local = r["created_at"].astimezone(JST)
        if not lo <= local.time() <= hi:
            continue
        if r["iv30"] is None or r["m1_forward"] is None or r["m1_last_trading_day"] is None:
            continue
        last[local.date()] = r
    return [{"day": d, "close_at": r["created_at"], "iv30": r["iv30"],
             "m1_last_trading_day": r["m1_last_trading_day"], "m1_forward": r["m1_forward"],
             "m2_last_trading_day": r["m2_last_trading_day"], "m2_forward": r["m2_forward"],
             "m1_iv": r.get("m1_iv"), "m2_iv": r.get("m2_iv")}
            for d, r in sorted(last.items())]


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


def synth_board(at: datetime, future=30000.0, quoted=None, fine_quoted=True, ltd=date(2026, 11, 12),
                ltd2=date(2026, 12, 10)) -> list[dict]:
    """判定用の小さな合成の板。1 限月の先物 ±5% に 125 円刻みの行使価格（call・put）。判定が数える 500 円の倍数の
    行（帯の端から call → put の順）のうち先頭 quoted 行（None = 全部）に両側気配、500 円の倍数でない行は
    fine_quoted なら両側気配・そうでなければ気配なし（#196 の深夜の薄い板の形）。帯の外と 2 限月は気配なし
    （割合に入らないことの確認用）。F = 30000 なら帯に 25 行使価格、うち 500 円の倍数は 7（14 行）"""
    lo, hi = 0.95 * future, 1.05 * future
    k = -(-int(lo) // 125) * 125
    strikes = []
    while k <= hi:
        strikes.append(k)
        k += 125
    rows = []
    i = 0
    for k in strikes:
        for typ in (1, 2):
            if k % 500 == 0:
                both = quoted is None or i < quoted
                i += 1
            else:
                both = fine_quoted
            rows.append(option_row(at, typ, k, ltd, bid=100 if both else None, ask=110 if both else 120))
    for k in (int(future * 0.5) // 500 * 500, int(future * 1.5) // 500 * 500):
        for typ in (1, 2):
            rows.append(option_row(at, typ, k, ltd))
    for k in strikes[:4]:
        for typ in (1, 2):
            rows.append(option_row(at, typ, k, ltd2))
    return rows


# ---- AI の中継（#134）: 合成の文脈・会話・テスト専用のツールの登録。値はすべて架空 ----

FAKE_KEY = "sk-ant-api03-" + "Zq7XyW3vU9tS1rQ5pO8nM2lK6jH4gF0eD9cB3aZ1yX5wV7uT"  # 鍵の形の架空の値（漏れの検査用）
FAKE_TOKEN = "sk-ant-oat01-" + "Hj2Kl4Mn6Pq8Rs0Tu2Vw4Xy6Za8Bc0De2Fg4Hi6Jk8Lm0No"  # トークンの形の架空の値
# WIF（#184）の架空の値: Google の ID トークン（JWT の形）・交換で返るトークン・ID
FAKE_ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Rz"
FAKE_EXCHANGED = "sk-ant-oat01-" + "Wf3Xg5Yh7Zi9Aj1Bk3Cl5Dm7En9Fo1Gp3Hq5Ir7Js9Kt1Lu"
FAKE_WIF_ENV = {"ANTHROPIC_FEDERATION_RULE_ID": "fdrl_0example0rule",
                "ANTHROPIC_ORGANIZATION_ID": "00000000-0000-4000-8000-000000000000",
                "ANTHROPIC_SERVICE_ACCOUNT_ID": "svac_0example0account",
                "ANTHROPIC_WORKSPACE_ID": "wrkspc_0example0workspace"}


def ai_registry():
    """テスト専用のツール 2 本（#135 の本物の登録でも同じテストが効くように、登録を引数にして使う）"""
    from simulator_api.ai.shape import Num, Obj
    from simulator_api.ai.tools import ToolSpec

    payoff = ToolSpec(
        name="payoff_at", description="満期の損益（テスト用）",
        input_shape=Obj({"x": Num(0, 1e7, lo_open=True), "days": Num(0, 400)}),
        result_shape=Obj({"pnl_yen": Num(-1e12, 1e12)}),
        input_schema={"type": "object", "properties": {"x": {"type": "number"}, "days": {"type": "number"}},
                      "required": ["x", "days"], "additionalProperties": False})
    greeks = ToolSpec(
        name="greeks", description="グリーク（テスト用）", input_shape=Obj({}),
        result_shape=Obj({"delta_large": Num(-1e6, 1e6), "vega_yen": Num(-1e12, 1e12)}),
        input_schema={"type": "object", "properties": {}, "additionalProperties": False})
    return {t.name: t for t in (payoff, greeks)}


def ai_context(rows_months=1, with_precomputed=True) -> dict:
    """合成の板（fixtures/synthetic/latest.json）から作る文脈（許可リストの形）。IV は架空の一定の値"""
    fx = load_fixture("latest")
    expiries = []
    for i, m in enumerate(fx["months"]):
        ks = [r["k"] for r in m["rows"]]
        f = float(fx["future"]["price"] or ks[len(ks) // 2])
        atm = min(ks, key=lambda k: abs(k - f))
        e = {"expiry": m["contract_month"], "sq_date": m["sq_date"], "t_days": 25.5 + 28 * i, "forward": f,
             "atm_k": atm, "atm_iv": 18.5, "smile": [{"m": round(-0.5 + 0.1 * j, 2), "iv": 18.5 + abs(j - 5) * 0.4}
                                                      for j in range(11)]}
        if i < rows_months:
            rows = []
            for r in m["rows"][:80]:
                for typ, key in (("C", "call"), ("P", "put")):
                    s = r[key]
                    rows.append({"k": r["k"], "type": typ, "bid": s["bid"], "ask": s["ask"], "iv": 19.0})
            e["rows"] = rows
        expiries.append(e)
    ctx = {
        "snapshot": {"snapshot_at": fx["snapshot_at"], "source": "synthetic", "delayed_minutes": 15},
        "expiries": expiries,
        "position": {"legs": [
            {"product": "op", "type": "P", "expiry": expiries[0]["expiry"], "k": expiries[0]["atm_k"] - 500,
             "side": "sell", "qty": 2, "price": 120},
            {"product": "op", "type": "P", "expiry": expiries[0]["expiry"], "k": expiries[0]["atm_k"] - 1000,
             "side": "buy", "qty": 2, "price": 45},
            {"product": "fut_mini", "expiry": "2026-12", "side": "buy", "qty": 1, "price": 30010},
        ]},
        "scenario": {"days": 5, "iv_shift_pt": -2, "x_range": [27000, 33000]},
        "capital": {"capital_yen": 3_000_000, "max_loss_yen": 300_000},
    }
    if with_precomputed:
        ctx["precomputed"] = {"greeks": {"delta_large": -0.12, "vega_yen": -15000}}
    return ctx


def ai_body(messages=None, context=None, **extra) -> dict:
    body = {"schema_version": 1, "kind": "chat", "context": ai_context() if context is None else context,
            "messages": messages if messages is not None else [
                {"role": "user", "content": [{"type": "text", "text": "このポジションの弱点は？"}]}]}
    body.update(extra)
    return body


def ai_tool_roundtrip() -> list[dict]:
    """会話 1 往復 + ツールの往復（AI の thinking・tool_use → ブラウザの tool_result）"""
    return [
        {"role": "user", "content": [{"type": "text", "text": "このポジションの弱点は？"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "下に弱い形です。"}]},
        {"role": "user", "content": [{"type": "text", "text": "29000 まで下げたら？"}]},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "満期の損益を見る", "signature": "c2lnbmF0dXJl"},
            {"type": "tool_use", "id": "toolu_01AbCd", "name": "payoff_at", "input": {"x": 29000, "days": 0}}]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_01AbCd",
             "content": [{"type": "text", "text": '{"pnl_yen": -760000}'}]}]},
    ]


SAME_ORIGIN = {"Sec-Fetch-Site": "same-origin", "Origin": "http://localhost"}


def ai_settings(credential="fake", limit_micro=3_000_000, deadline=50.0, secret=None):
    from simulator_api import settings as st

    store = None if credential == "oauth_token" else "memory"
    if secret is None:
        secret = {"api_key": FAKE_KEY, "oauth_token": FAKE_TOKEN}.get(credential)
    wif = None
    if credential == "wif":
        e = FAKE_WIF_ENV
        wif = st.WifIds(e["ANTHROPIC_FEDERATION_RULE_ID"], e["ANTHROPIC_ORGANIZATION_ID"],
                        e["ANTHROPIC_SERVICE_ACCOUNT_ID"], e["ANTHROPIC_WORKSPACE_ID"])
    return st.AiSettings(credential=credential, daily_limit_micro_usd=limit_micro, budget_store=store,
                         deadline_seconds=deadline, disabled=None, secret=secret, wif=wif)


def ai_app(gateway=None, store=None, ai_cfg=None, registry=None, clock=None, **kw):
    """AI の中継を偽の送信先・メモリの計上で。戻り値 (client, gateway, store, clock)"""
    from simulator_api import settings as st
    from simulator_api.ai.budget import MemoryStore
    from simulator_api.ai.gateway import FakeGateway
    from simulator_api.app import create_app

    gateway = FakeGateway() if gateway is None else gateway
    store = MemoryStore() if store is None else store
    clock = clock or Clock(jst(2026, 10, 19, 21, 0))
    app = create_app(runner=FakeRunner(World()), clock=clock, monotonic=clock.monotonic,
                     cfg=st.Settings(project="example-project"), ai_cfg=ai_cfg or ai_settings(**kw),
                     ai_gateway=gateway, ai_store=store, ai_registry=ai_registry() if registry is None else registry)
    return app.test_client(), gateway, store, clock


def ai_post(client, body, headers=None, raw: bytes | None = None, content_type="application/json", **kw):
    data = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    return client.post("/api/ai/messages", data=data, headers=SAME_ORIGIN if headers is None else headers,
                       content_type=content_type, **kw)


def sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for chunk in text.split("\n\n"):
        if not chunk.strip():
            continue
        lines = dict(line.split(": ", 1) for line in chunk.split("\n"))
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def log_records(out: str) -> list[dict]:
    recs = []
    for line in out.splitlines():
        try:
            recs.append(json.loads(line))
        except ValueError:
            continue
    return recs


# ---- 画像の読み取り（#318）: テストの画像はここで組む（画像ファイルをリポジトリに置かない。値は架空）

def _png_chunk(kind: bytes, data: bytes) -> bytes:
    import struct
    import zlib

    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_bytes(w: int, h: int, rgb=(200, 30, 30), noise_seed: int | None = None, text: str | None = None) -> bytes:
    """合成の PNG（8 bit RGB）。noise_seed で画素を種つき乱数に（圧縮が効かない = 大きい画像）。
    text は tEXt のチャンクに入れる架空の文字列（ログ・応答に出ないことの確かめ用）"""
    import random
    import struct
    import zlib

    rnd = random.Random(noise_seed) if noise_seed is not None else None
    row = bytes(rgb) * w
    raw = b"".join(b"\x00" + (rnd.randbytes(3 * w) if rnd else row) for _ in range(h))
    out = b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    if text is not None:
        out += _png_chunk(b"tEXt", b"Comment\x00" + text.encode("latin-1"))
    return out + _png_chunk(b"IDAT", zlib.compress(raw)) + _png_chunk(b"IEND", b"")


def jpeg_bytes(w: int, h: int) -> bytes:
    """寸法だけを持つ最小の JPEG の枠（SOI・APP0・SOF0・EOI。中継はマジックバイトと寸法しか見ない）"""
    import struct

    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = b"\xff\xc0" + struct.pack(">HBHHB", 17, 8, h, w, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def read_body(raw: bytes, media_type="image/png", **extra) -> dict:
    import base64

    return {"schema_version": 1, "image": {"media_type": media_type, "data": base64.b64encode(raw).decode("ascii")},
            **extra}


def read_post(client, body, headers=None, raw: bytes | None = None, content_type="application/json", **kw):
    data = raw if raw is not None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    return client.post("/api/ai/read_positions", data=data, headers=SAME_ORIGIN if headers is None else headers,
                       content_type=content_type, **kw)

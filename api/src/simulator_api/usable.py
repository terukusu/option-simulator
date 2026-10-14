"""使える板の判定（docs/design.md 7.2。AC2）。BigQuery から切り離した純粋な関数。

時刻はすべて snapshot_at（ページ時刻）を JST にした壁時計で判定する（UTC の日跨ぎ = JST 9:00 に依らない）。
定数は settings.py の上部（#38 の実測で直すのはそこだけ）。

手順（select）:
1. 最新の実行 R0 が「新しい（CLOSED_AFTER_MINUTES 以内）・連続売買の窓・rows_option ≥ MIN_ROWS」なら R0 を評価する。
   使える → latest
2. それ以外は R0 で reason を決める（古い → closed、寄り前の窓 → pre_open、引け後の窓 → after_close、他 → closed）。
   R0 より前（R0 を評価していなければ R0 も）の「連続売買の窓・rows_option ≥ MIN_ROWS」の候補を新しい順に評価し、
   最初に使えた板を返す（= 板寄せ前の最後のスナップショット）。1 で R0 を評価して使えなかった場合、
   同じ立会の板なら latest
3. 板を読むのは MAX_BOARD_READS 回まで、先物を読むのは MAX_FUTURE_READS 回まで。尽きたら使える板なし
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone

from . import settings as st

JST = timezone(timedelta(hours=9))


@dataclass(frozen=True)
class Run:
    """latest_runs の 1 行"""

    snapshot_at: datetime  # aware（UTC）
    rows_option: int
    finished_at: datetime

    @classmethod
    def from_row(cls, row: dict) -> "Run":
        return cls(snapshot_at=row["snapshot_at"], rows_option=row["rows_option"], finished_at=row["finished_at"])


class NoUsableBoard(Exception):
    """候補が無い / 上限まで読んでも使える板が無い"""


def jst_time(at: datetime) -> time:
    return at.astimezone(JST).time()


def _in(t: time, window: tuple[time, time]) -> bool:
    start, end = window
    if start <= end:
        return start <= t <= end
    return t >= start or t <= end  # 日を跨ぐ窓（夜間）


def in_session(at: datetime) -> bool:
    """連続売買の窓（日中 8:45〜15:40、夜間 17:00〜翌 5:55。両端含む）"""
    t = jst_time(at)
    return _in(t, st.DAY_SESSION) or _in(t, st.NIGHT_SESSION)


def session_key(at: datetime) -> tuple[str, date]:
    """立会の識別（日中 = その日、夜間 = 17:00 の日）。窓の外の時刻にも値を返す（比較にだけ使う）"""
    local = at.astimezone(JST)
    if _in(local.time(), st.DAY_SESSION):
        return ("day", local.date())
    start = local if local.time() >= st.NIGHT_SESSION[0] else local - timedelta(days=1)
    return ("night", start.date())


def is_fresh(run: Run, now: datetime) -> bool:
    return now - run.snapshot_at <= timedelta(minutes=st.CLOSED_AFTER_MINUTES)


def is_candidate(run: Run) -> bool:
    return in_session(run.snapshot_at) and run.rows_option >= st.MIN_ROWS


def classify(latest: Run, now: datetime) -> str:
    """最新の実行が使えないときの reason（pre_open / after_close / closed）"""
    if not is_fresh(latest, now):
        return "closed"
    t = jst_time(latest.snapshot_at)
    if any(_in(t, w) for w in st.PRE_OPEN_WINDOWS):
        return "pre_open"
    if any(_in(t, w) for w in st.AFTER_CLOSE_WINDOWS):
        return "after_close"
    return "closed"


def future_ok(price) -> bool:
    return price is not None and price > 0


def board_ok(option_rows: Iterable[dict], future_price) -> bool:
    """1 限月（last_trading_day の最小）の 0.95F ≤ K ≤ 1.05F の行（call・put を別に数える）のうち、
    bid と ask が両方 NULL でない行の割合が FILL_RATIO 以上（分母 0 は不採用）"""
    if not future_ok(future_price):
        return False
    rows = [r for r in option_rows if r.get("type") in (1, 2) and r.get("last_trading_day") is not None]
    if not rows:
        return False
    m1 = min(r["last_trading_day"] for r in rows)
    lo, hi = (1 - st.BAND) * future_price, (1 + st.BAND) * future_price
    n = both = 0
    for r in rows:
        if r["last_trading_day"] == m1 and lo <= r["target_price"] <= hi:
            n += 1
            if r.get("bid") is not None and r.get("ask") is not None:
                both += 1
    num, den = st.FILL_RATIO
    return n > 0 and both * den >= n * num


@dataclass(frozen=True)
class Evaluation:
    """1 候補の評価の結果（評価関数が返す）。board_read: 板の段階まで進んだか（先物で不採用なら False）"""

    usable: bool
    board_read: bool
    payload: object = None


@dataclass(frozen=True)
class Selection:
    run: Run
    reason: str
    evaluation: Evaluation


def select(runs: list[Run], now: datetime, evaluate: Callable[[Run], Evaluation]) -> Selection:
    """runs は新しい順。evaluate は 1 候補を評価する（先物 → 板。キャッシュ込み）"""
    if not runs:
        raise NoUsableBoard("no_runs")
    board_reads = future_reads = 0

    def attempt(run: Run) -> Evaluation | None:
        nonlocal board_reads, future_reads
        if board_reads >= st.MAX_BOARD_READS or future_reads >= st.MAX_FUTURE_READS:
            return None
        ev = evaluate(run)
        future_reads += 1
        board_reads += 1 if ev.board_read else 0
        return ev

    r0 = runs[0]
    tried_r0 = False
    if is_fresh(r0, now) and is_candidate(r0):
        tried_r0 = True
        ev = attempt(r0)
        if ev is not None and ev.usable:
            return Selection(r0, "latest", ev)
    fallback = classify(r0, now)
    for run in runs[1 if tried_r0 else 0:]:
        if not is_candidate(run):
            continue
        ev = attempt(run)
        if ev is None:
            break
        if ev.usable:
            same = tried_r0 and session_key(run.snapshot_at) == session_key(r0.snapshot_at)
            return Selection(run, "latest" if same else fallback, ev)
    raise NoUsableBoard("no_usable_board")

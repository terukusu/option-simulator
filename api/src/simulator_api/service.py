"""/api/chain・/api/calendar の中身（BigQuery の読み方・キャッシュ・single-flight。docs/design.md 7.2・7.3・13.4）。

runner: (name, params) -> 行（dict）のリスト。name は sql/<name>.sql、params の値は aware な datetime だけ。

- latest_runs: TTL RUNS_TTL_SECONDS + single-flight
- 板: キー = (snapshot_at, finished_at)（再処理で書き直されたら取り直す）、値 = 判定の結果（使えない板も
  「不採用」として持つ）と限月ごとの行。LRU BOARD_CACHE_SIZE 件 + single-flight。応答の JSON（と gzip）は
  (reason, カレンダーの版) ごとに 1 回だけ作る → 同じ snapshot_at の 2 回目は latest_runs だけ
- カレンダー: TTL CALENDAR_TTL_SECONDS + single-flight。読めなければ古い版（WARNING）、一度も読めていなければ失敗
- 1 リクエストの BigQuery 待ちの合計が REQUEST_BUDGET_SECONDS を超えたら次のクエリを出さずに Unavailable
- 候補の評価: 先物（安い）を先に読み、価格が NULL / 0 以下なら板を読まない。板が使えたら現物を読む
"""

import gzip
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import calendar as cal_mod
from . import chain, usable
from . import settings as st
from .cache import LRUCache, TTLCache
from .log import log

ONE_SECOND = timedelta(seconds=1)


class Unavailable(Exception):
    """503 にする（使える板が無い・上限を超えた・データ元が file でカレンダーが無い等）。引数は理由の符号だけ"""


@dataclass(frozen=True)
class Payload:
    json_bytes: bytes
    gzip_bytes: bytes
    etag: str | None


@dataclass(frozen=True)
class ChainResult(Payload):
    reason: str = ""
    snapshot_at: datetime | None = None


def _encode(obj) -> tuple[bytes, bytes]:
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return body, gzip.compress(body, compresslevel=6, mtime=0)


class _Budget:
    def __init__(self, monotonic):
        self._monotonic = monotonic
        self._start = monotonic()

    def check(self):
        if self._monotonic() - self._start > st.REQUEST_BUDGET_SECONDS:
            raise Unavailable("request_budget")


@dataclass
class _Board:
    """1 候補の評価の結果（キャッシュの値）"""

    usable: bool
    board_read: bool
    snapshot_at: datetime
    finished_at: datetime
    months: tuple = ()
    future: dict | None = None
    spot: dict | None = None
    rendered: dict = field(default_factory=dict)  # (reason, version_at) → Payload
    lock: threading.Lock = field(default_factory=threading.Lock)

    def render(self, reason: str, cal: cal_mod.Calendar) -> Payload:
        key = (reason, cal.version_at)
        with self.lock:
            if key not in self.rendered:
                obj = chain.chain_json(self.snapshot_at, reason, self.months, self.future, self.spot, cal)
                body, gz = _encode(obj)
                etag = (f'"{int(self.snapshot_at.timestamp())}-{int(self.finished_at.timestamp())}-{reason}-'
                        f'{int(cal.version_at.timestamp())}"')
                self.rendered[key] = Payload(body, gz, etag)
            return self.rendered[key]


class ChainService:
    def __init__(self, runner, clock, monotonic=time.monotonic):
        self.runner = runner
        self.clock = clock
        self.monotonic = monotonic
        self._runs = TTLCache(st.RUNS_TTL_SECONDS, monotonic)
        self._calendar = TTLCache(st.CALENDAR_TTL_SECONDS, monotonic)
        self._calendar_payloads: dict = {}
        self._boards = LRUCache(st.BOARD_CACHE_SIZE)

    def _query(self, budget: _Budget, name: str, params: dict) -> list[dict]:
        budget.check()
        return self.runner(name, params)

    # ---- カレンダー ----

    def _calendar_value(self, budget: _Budget) -> cal_mod.Calendar:
        def load():
            return cal_mod.from_rows(self._query(budget, "trading_calendar", {}))

        try:
            return self._calendar.get(load)
        except Exception as e:
            stale = self._calendar.stale()
            if stale is None:
                raise
            log("WARNING", "calendar_stale", error_type=type(e).__name__)
            return stale

    def calendar(self) -> Payload:
        cal = self._calendar_value(_Budget(self.monotonic))
        payload = self._calendar_payloads.get(cal.version_at)
        if payload is None:
            body, gz = _encode(cal_mod.calendar_json(cal))
            payload = Payload(body, gz, f'"{int(cal.version_at.timestamp())}"')
            self._calendar_payloads = {cal.version_at: payload}
        return payload

    # ---- 板 ----

    def _load_board(self, run: usable.Run, budget: _Budget, counter: dict) -> _Board:
        window = {"start_at": run.snapshot_at, "end_at": run.snapshot_at + ONE_SECOND}
        base = {"snapshot_at": run.snapshot_at, "finished_at": run.finished_at}
        futures = self._query(budget, "future_price", window)
        future = futures[0] if futures else None
        if future is None or not usable.future_ok(future.get("price")):
            return _Board(usable=False, board_read=False, **base)
        options = self._query(budget, "option_price", window)
        counter["board_reads"] += 1
        if not usable.board_ok(options, future["price"]):
            return _Board(usable=False, board_read=True, **base)
        spots = self._query(budget, "spot_price", window)
        return _Board(usable=True, board_read=True, months=chain.parse_board(options), future=future,
                      spot=spots[0] if spots else None, **base)

    def chain(self) -> ChainResult:
        budget = _Budget(self.monotonic)
        now = self.clock()
        rows = self._runs.get(lambda: self._query(
            budget, "latest_runs",
            {"start_at": now - timedelta(days=st.SEARCH_DAYS), "end_at": now + ONE_SECOND}))
        runs = sorted((usable.Run.from_row(r) for r in rows), key=lambda r: r.snapshot_at, reverse=True)
        counter = {"board_reads": 0}

        def evaluate(run: usable.Run) -> usable.Evaluation:
            board = self._boards.get((run.snapshot_at, run.finished_at),
                                     lambda: self._load_board(run, budget, counter))
            return usable.Evaluation(usable=board.usable, board_read=board.board_read, payload=board)

        try:
            sel = usable.select(runs, now, evaluate)
        except usable.NoUsableBoard as e:
            raise Unavailable(str(e)) from None
        cal = self._calendar_value(budget)
        payload = sel.evaluation.payload.render(sel.reason, cal)
        log("INFO", "chain_served", snapshot_at=chain.instant(sel.run.snapshot_at), reason=sel.reason,
            board_reads=counter["board_reads"], cache="miss" if counter["board_reads"] else "hit")
        return ChainResult(payload.json_bytes, payload.gzip_bytes, payload.etag, reason=sel.reason,
                           snapshot_at=sel.run.snapshot_at)


class FileChainService:
    """DATA_SOURCE=file: GCP なしで動かす（clone した人・コンテナの起動確認）。CHAIN_FILE の JSON をそのまま返す。
    検査は schema_version == 1 だけ（中身の検証はブラウザの parseChainJson）。カレンダーは無い（503）"""

    def __init__(self, path: Path):
        self.path = path

    def chain(self) -> ChainResult:
        try:
            body = self.path.read_bytes()
            obj = json.loads(body)
        except (OSError, ValueError):
            raise Unavailable("chain_file") from None
        if not isinstance(obj, dict) or obj.get("schema_version") != chain.SCHEMA_VERSION:
            raise Unavailable("chain_file")
        return ChainResult(body, gzip.compress(body, mtime=0), None, reason=str(obj.get("reason", "")))

    def calendar(self) -> Payload:
        raise Unavailable("file_source")

"""/api/chain・/api/calendar の中身（BigQuery の読み方・キャッシュ・single-flight。docs/design.md 7.2・7.3・13.4）。

runner: (name, params) -> 行（dict）のリスト。name は sql/<name>.sql、params の値は aware な datetime だけ。

- latest_runs: TTL RUNS_TTL_SECONDS + single-flight
- 板: キー = (snapshot_at, finished_at)（再処理で書き直されたら取り直す）、値 = 判定の結果（使えない板も
  「不採用」として持つ）と限月ごとの行。LRU BOARD_CACHE_SIZE 件 + single-flight。応答の JSON（と gzip）は
  (reason, カレンダーの版) ごとに 1 回だけ作る → 同じ snapshot_at の 2 回目は latest_runs だけ。先物の限月はそのとき
  snapshot_at と取引カレンダーから求める（future_bars.board_future。生の値と違えばログ future_contract_mismatch。#192）
- カレンダー: TTL CALENDAR_TTL_SECONDS + single-flight。読めなければ古い版（WARNING）、一度も読めていなければ失敗
- 1 リクエストの BigQuery 待ちの合計が REQUEST_BUDGET_SECONDS を超えたら次のクエリを出さずに Unavailable
- 候補の評価: 先物（安い）を先に読み、価格が NULL / 0 以下なら板も現物も読まない。先物が使えたら板と現物を同時に
  読み、板が不採用なら現物は捨てる（読み直しの候補ごとに現物 1 本が増えうる）
- 並列: カレンダー（新しくないときだけ）は latest_runs と、現物は板と同時に、ChainService ごとの上限付きのスレッド
  （QUERY_THREADS）で読む。片方が失敗したら両方の終わりを待ってから例外（キャッシュしない）
- /api/atm_iv（#79）: AtmIvService。キー = (tf, start, end)（正規化した後）、値 = 応答の Payload。期限付きの LRU
  （確定した範囲 = end ≤ now − 48 時間は 24 時間、それ以外 300 秒、ATM_IV_CACHE_SIZE 件）+ single-flight。日足は
  ChainService と同じカレンダーのキャッシュを使う
- 供給元（DATA_SOURCE）: ChainService = bigquery（optionchan）、FileChainService = file、QuotesFileService = quotes
  （中立の気配の一覧のファイル。#154）。値 → 実装の表は sources.py
- /api/atm_daily（#152）: AtmDailyService。キー = 範囲の終わりの日（atm_daily.settled_end）、値 = 応答の Payload。
  期限付きの LRU（24 時間、ATM_DAILY_CACHE_SIZE 件）+ single-flight。範囲の終わりが変わる（JST 8:00）と読み直す
- /api/future_bars（#190）: FutureBarsService。AtmIvService と同じ形（キー = (tf, start, end)、確定した範囲 24 時間・
  それ以外 300 秒、ATM_IV_CACHE_SIZE 件 + single-flight）。限月を求めるのでどの足もカレンダーを使う
- /api/option_bars（#319）: OptionBarsService。行のキャッシュ（キー = (ltd, k, type)。1h と 1d は同じ行から作る =
  1 銘柄 1 クエリ）と応答のキャッシュ（キー = (ltd, k, type, tf)）。どちらも期限付きの LRU（確定した銘柄 24 時間・
  それ以外 300 秒、OPTION_BARS_CACHE_SIZE 件）+ single-flight。範囲の外の限月はクエリを出さない。日足だけカレンダー
"""

import concurrent.futures
import gzip
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import atm_daily, atm_iv, chain, future_bars, option_bars, quotes, usable
from . import calendar as cal_mod
from . import settings as st
from .atm_iv import AtmIvRequest
from .cache import ExpiringLRUCache, LRUCache, TTLCache
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
                # 先物の限月は生の contract_month（1 年先になる行がある）ではなく取引カレンダーから（#192）
                future, mismatch = future_bars.board_future(self.future, self.snapshot_at, cal)
                if mismatch:
                    log("INFO", "future_contract_mismatch")
                obj = chain.chain_json(self.snapshot_at, reason, self.months, future, self.spot, cal)
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
        # プールのタスク（カレンダー・現物）はプールの他のタスクを待たない（カレンダーの single-flight の leader は
        # 必ず実行中）ので詰まらない
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=st.QUERY_THREADS, thread_name_prefix="bq")
        self._atm_iv = AtmIvService(runner, clock, monotonic, calendar=self._calendar_value)
        self._atm_daily = AtmDailyService(runner, clock, monotonic)
        self._future_bars = FutureBarsService(runner, clock, monotonic, calendar=self._calendar_value)
        self._option_bars = OptionBarsService(runner, clock, monotonic, calendar=self._calendar_value)

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
        spot_f = self._pool.submit(self._query, budget, "spot_price", window)
        try:
            options = self._query(budget, "option_price", window)
        except BaseException:
            concurrent.futures.wait([spot_f])  # 現物の終わりを待ってから（結果・例外は捨てる）
            raise
        counter["board_reads"] += 1
        if not usable.board_ok(options, future["price"]):
            concurrent.futures.wait([spot_f])
            return _Board(usable=False, board_read=True, **base)
        spots = spot_f.result()  # 失敗ならそのまま例外（板はキャッシュしない）
        return _Board(usable=True, board_read=True, months=chain.parse_board(options), future=future,
                      spot=spots[0] if spots else None, **base)

    def chain(self) -> ChainResult:
        started = self.monotonic()
        budget = _Budget(self.monotonic)
        now = self.clock()
        cal_f = None if self._calendar.fresh() else self._pool.submit(self._calendar_value, budget)
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
        cal = cal_f.result() if cal_f is not None else self._calendar_value(budget)
        payload = sel.evaluation.payload.render(sel.reason, cal)
        log("INFO", "chain_served", snapshot_at=chain.instant(sel.run.snapshot_at), reason=sel.reason,
            board_reads=counter["board_reads"], cache="miss" if counter["board_reads"] else "hit",
            elapsed_ms=round((self.monotonic() - started) * 1000))
        return ChainResult(payload.json_bytes, payload.gzip_bytes, payload.etag, reason=sel.reason,
                           snapshot_at=sel.run.snapshot_at)


    def atm_iv(self, req: atm_iv.AtmIvRequest) -> Payload:
        return self._atm_iv.get(req)

    def atm_daily(self) -> Payload:
        return self._atm_daily.get()

    def future_bars(self, req: AtmIvRequest) -> Payload:
        return self._future_bars.get(req)

    def option_bars(self, req: option_bars.OptionBarsRequest) -> Payload:
        return self._option_bars.get(req)


class AtmIvService:
    """/api/atm_iv の中身。calendar: (budget) -> Calendar（日足の休業日。ChainService._calendar_value）"""

    def __init__(self, runner, clock, monotonic=time.monotonic, calendar=None):
        self.runner = runner
        self.clock = clock
        self.monotonic = monotonic
        self._calendar = calendar
        self._cache = ExpiringLRUCache(st.ATM_IV_CACHE_SIZE, monotonic)

    def _load(self, req: atm_iv.AtmIvRequest, now: datetime, budget: _Budget) -> Payload:
        start_at, end_at, step = atm_iv.read_window(req, now)
        budget.check()
        rows = self.runner("atm_cm_iv", {"start_at": start_at, "end_at": end_at, "step": step})
        bars, last_at = atm_iv.bars_from_rows(rows, req.start, req.end)
        if req.tf == "1d":
            if self._calendar is None:
                raise Unavailable("calendar")
            holidays = atm_iv.non_trading_days(self._calendar(budget))
            bars = atm_iv.daily_bars(bars, holidays, req, start_at, now)
        body, gz = _encode(atm_iv.atm_iv_json(req, now, bars, last_at))
        return _AtmIvPayload(body, gz, None, bars=len(bars))

    def get(self, req: atm_iv.AtmIvRequest) -> Payload:
        started = self.monotonic()
        budget = _Budget(self.monotonic)
        now = self.clock()
        loaded = []

        def load():
            loaded.append(1)
            return self._load(req, now, budget)

        ttl = st.ATM_IV_SETTLED_TTL_SECONDS if atm_iv.is_settled(req, now) else st.ATM_IV_TTL_SECONDS
        payload = self._cache.get((req.tf, req.start, req.end), load, ttl)
        log("INFO", "atm_iv_served", tf=req.tf, days=(req.end - req.start).days, bars=payload.bars,
            cache="miss" if loaded else "hit", elapsed_ms=round((self.monotonic() - started) * 1000))
        return payload


@dataclass(frozen=True)
class _AtmIvPayload(Payload):
    bars: int = 0


class AtmDailyService:
    """/api/atm_daily の中身（範囲は確定した日だけなので、範囲の終わりごとに 1 回読む）"""

    def __init__(self, runner, clock, monotonic=time.monotonic):
        self.runner = runner
        self.clock = clock
        self.monotonic = monotonic
        self._cache = ExpiringLRUCache(st.ATM_DAILY_CACHE_SIZE, monotonic)

    def _load(self, end_day, budget: _Budget) -> Payload:
        start_at, end_at = atm_daily.read_window(end_day)
        budget.check()
        rows = self.runner("atm_cm_daily", {"start_at": start_at, "end_at": end_at})
        days = atm_daily.days_from_rows(rows, end_day)
        body, gz = _encode(atm_daily.atm_daily_json(end_day, days))
        etag = f'"atm-daily-{end_day.isoformat()}-{len(days)}-{atm_daily.ETAG_SHAPE}"'
        return _AtmDailyPayload(body, gz, etag, days=len(days))

    def get(self) -> Payload:
        started = self.monotonic()
        budget = _Budget(self.monotonic)
        end_day = atm_daily.settled_end(self.clock())
        loaded = []

        def load():
            loaded.append(1)
            return self._load(end_day, budget)

        payload = self._cache.get(end_day, load, st.ATM_DAILY_TTL_SECONDS)
        log("INFO", "atm_daily_served", end=end_day.isoformat(), days=payload.days,
            cache="miss" if loaded else "hit", elapsed_ms=round((self.monotonic() - started) * 1000))
        return payload


@dataclass(frozen=True)
class _AtmDailyPayload(Payload):
    days: int = 0


class FutureBarsService:
    """/api/future_bars の中身。calendar: (budget) -> Calendar（限月・日足の取引日。ChainService._calendar_value）"""

    def __init__(self, runner, clock, monotonic=time.monotonic, calendar=None):
        self.runner = runner
        self.clock = clock
        self.monotonic = monotonic
        self._calendar = calendar
        self._cache = ExpiringLRUCache(st.ATM_IV_CACHE_SIZE, monotonic)

    def _load(self, req: atm_iv.AtmIvRequest, now: datetime, budget: _Budget) -> Payload:
        if self._calendar is None:
            raise Unavailable("calendar")
        start_at, end_at, step, hi = future_bars.read_window(req, now)
        budget.check()
        rows = self.runner("future_bars", {"start_at": start_at, "end_at": end_at, "step": step})
        cal = self._calendar(budget)
        non_trading = atm_iv.non_trading_days(cal)
        if req.tf == "1d":
            hourly, _ = future_bars.bars_from_rows(rows, start_at, hi)
            _, last_at = future_bars.bars_from_rows(rows, req.start, req.end)
            bars = future_bars.with_contracts(future_bars.daily_bars(hourly, non_trading, req, start_at, now),
                                              non_trading, cal.holidays, daily=True)
        else:
            bars, last_at = future_bars.bars_from_rows(rows, req.start, req.end)
            bars = future_bars.with_contracts(bars, non_trading, cal.holidays)
        body, gz = _encode(future_bars.future_bars_json(req, now, bars, last_at))
        return _FutureBarsPayload(body, gz, None, bars=len(bars), mismatch=future_bars.contract_mismatches(bars))

    def get(self, req: atm_iv.AtmIvRequest) -> Payload:
        started = self.monotonic()
        budget = _Budget(self.monotonic)
        now = self.clock()
        loaded = []

        def load():
            loaded.append(1)
            return self._load(req, now, budget)

        ttl = st.ATM_IV_SETTLED_TTL_SECONDS if atm_iv.is_settled(req, now) else st.ATM_IV_TTL_SECONDS
        payload = self._cache.get((req.tf, req.start, req.end), load, ttl)
        log("INFO", "future_bars_served", tf=req.tf, days=(req.end - req.start).days, bars=payload.bars,
            contract_mismatch=payload.mismatch, cache="miss" if loaded else "hit",
            elapsed_ms=round((self.monotonic() - started) * 1000))
        return payload


@dataclass(frozen=True)
class _FutureBarsPayload(Payload):
    bars: int = 0
    mismatch: int = 0


class OptionBarsService:
    """/api/option_bars の中身。calendar: (budget) -> Calendar（日足の取引日。ChainService._calendar_value）"""

    def __init__(self, runner, clock, monotonic=time.monotonic, calendar=None):
        self.runner = runner
        self.clock = clock
        self.monotonic = monotonic
        self._calendar = calendar
        self._rows = ExpiringLRUCache(st.OPTION_BARS_CACHE_SIZE, monotonic)
        self._payloads = ExpiringLRUCache(st.OPTION_BARS_CACHE_SIZE, monotonic)

    def _hourly(self, req: option_bars.OptionBarsRequest, budget: _Budget, ttl: float, loaded: list):
        """(1 時間足, last_at)。範囲の外の限月はクエリを出さない"""

        def load():
            loaded.append(1)
            start_at, end_at = option_bars.read_window(req)
            budget.check()
            rows = self.runner("option_bars", {"ltd": req.ltd, "k": req.k, "type": req.type,
                                               "start_at": start_at, "end_at": end_at})
            bars, last_at, duplicates = option_bars.rows_to_hourly(rows)
            if duplicates:
                log("WARNING", "option_bars_duplicate", count=duplicates)
            return bars, last_at

        return self._rows.get(req.key, load, ttl)

    def _load(self, req: option_bars.OptionBarsRequest, now: datetime, budget: _Budget, ttl: float,
              loaded: list) -> Payload:
        if option_bars.in_range(req, now):
            bars, last_at = self._hourly(req, budget, ttl, loaded)
        else:
            bars, last_at = [], None
        if req.tf == "1d" and bars:
            if self._calendar is None:
                raise Unavailable("calendar")
            bars = option_bars.daily_bars(bars, atm_iv.non_trading_days(self._calendar(budget)))
        body, gz = _encode(option_bars.option_bars_json(req, bars, last_at))
        return _OptionBarsPayload(body, gz, None, bars=len(bars))

    def get(self, req: option_bars.OptionBarsRequest) -> Payload:
        started = self.monotonic()
        budget = _Budget(self.monotonic)
        now = self.clock()
        loaded: list = []
        ttl = st.OPTION_BARS_SETTLED_TTL_SECONDS if option_bars.is_settled(req, now) else st.OPTION_BARS_TTL_SECONDS
        payload = self._payloads.get((*req.key, req.tf), lambda: self._load(req, now, budget, ttl, loaded), ttl)
        # 銘柄（ltd・k・type）は利用者の検討内容なのでログに出さない
        log("INFO", "option_bars_served", tf=req.tf, bars=payload.bars, cache="miss" if loaded else "hit",
            elapsed_ms=round((self.monotonic() - started) * 1000))
        return payload


@dataclass(frozen=True)
class _OptionBarsPayload(Payload):
    bars: int = 0


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

    def atm_iv(self, req) -> Payload:
        raise Unavailable("file_source")

    def atm_daily(self) -> Payload:
        raise Unavailable("file_source")

    def future_bars(self, req) -> Payload:
        raise Unavailable("file_source")

    def option_bars(self, req) -> Payload:
        raise Unavailable("file_source")


class QuotesFileService:
    """DATA_SOURCE=quotes: 利用者が自分の API から書き出した中立の気配の一覧（QUOTES_FILE）と取引カレンダー
    （CALENDAR_FILE。/api/calendar と同じ形）から板を組み立てる（quotes.py。#154）。要求ごとに読む（file と同じ）。
    検証の失敗は 503（ログは JSON の位置だけ。値は出さない）。IV 推移・日次の値・先物推移・銘柄の推移は無い（503）"""

    def __init__(self, quotes_file: Path, calendar_file: Path, clock):
        self.quotes_file = quotes_file
        self.calendar_file = calendar_file
        self.clock = clock

    @staticmethod
    def _read(path: Path, code: str) -> bytes:
        """大きさの上限（QUOTES_MAX_FILE_BYTES）を超えるファイルは読まずに 503"""
        try:
            if path.stat().st_size > st.QUOTES_MAX_FILE_BYTES:
                log("WARNING", "file_too_large", code=code)
                raise Unavailable(code)
            return path.read_bytes()
        except OSError:
            raise Unavailable(code) from None

    def _calendar(self) -> cal_mod.Calendar:
        raw = self._read(self.calendar_file, "calendar_file")
        try:
            return cal_mod.from_json(json.loads(raw))
        except ValueError as e:
            log("WARNING", "calendar_file_invalid", detail=str(e))
            raise Unavailable("calendar_file") from None

    def chain(self) -> ChainResult:
        cal = self._calendar()
        raw = self._read(self.quotes_file, "quotes_file")
        try:
            q = quotes.parse_quotes(json.loads(raw))
            obj, reason = quotes.chain_from_quotes(q, cal, self.clock())
        except quotes.QuotesError as e:
            log("WARNING", "quotes_file_invalid", detail=str(e))
            raise Unavailable("quotes_file") from None
        except ValueError:  # JSON として読めない
            raise Unavailable("quotes_file") from None
        except quotes.QuotesUnusable:
            raise Unavailable("quotes_unusable") from None
        body, gz = _encode(obj)
        log("INFO", "chain_served", snapshot_at=chain.instant(q.snapshot_at), reason=reason, source=q.source)
        return ChainResult(body, gz, None, reason=reason, snapshot_at=q.snapshot_at)

    def calendar(self) -> Payload:
        cal = self._calendar()
        body, gz = _encode(cal_mod.calendar_json(cal, source="file"))
        return Payload(body, gz, f'"{int(cal.version_at.timestamp())}"')

    def atm_iv(self, req) -> Payload:
        raise Unavailable("quotes_source")

    def atm_daily(self) -> Payload:
        raise Unavailable("quotes_source")

    def future_bars(self, req) -> Payload:
        raise Unavailable("quotes_source")

    def option_bars(self, req) -> Payload:
        raise Unavailable("quotes_source")

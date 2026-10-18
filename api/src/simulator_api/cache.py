"""プロセス内のキャッシュと single-flight（docs/design.md 7.3・13.4）。

- 同じキーの読み込みが同時に来たら 1 本だけ実行し、他は結果（例外を含む）を待つ（single-flight）
- 例外はキャッシュしない（次の呼び出しで読み直す）
- gunicorn のワーカー（プロセス）ごとに独立。スレッドから同時に呼んでよい
"""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable

# 待つ側の上限（読み込み側は BigQuery のジョブの上限と 1 リクエストの上限で止まる。保険）
WAIT_TIMEOUT_SECONDS = 60


class _Flight:
    def __init__(self):
        self.done = threading.Event()
        self.value = None
        self.error: BaseException | None = None


class _SingleFlight:
    def __init__(self):
        self._lock = threading.Lock()
        self._flights: dict[object, _Flight] = {}

    def run(self, key, load: Callable[[], object], lookup: Callable[[], tuple[bool, object]],
            store: Callable[[object], None]):
        """lookup（キャッシュの参照）と store（保存）はこの lock の中で呼ぶ。保存と flight の片付けを同時にするので、
        読み込みの終わり際に来た呼び出しも、保存済みの値か実行中の flight のどちらかを必ず見る"""
        with self._lock:
            hit, value = lookup()
            if hit:
                return value
            flight = self._flights.get(key)
            leader = flight is None
            if leader:
                flight = self._flights[key] = _Flight()
        if not leader:
            if not flight.done.wait(WAIT_TIMEOUT_SECONDS):
                raise TimeoutError("single-flight の待ちが上限を超えた")
            if flight.error is not None:
                raise flight.error
            return flight.value
        try:
            flight.value = load()
        except BaseException as e:
            flight.error = e
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()
            raise
        with self._lock:
            store(flight.value)
            self._flights.pop(key, None)
        flight.done.set()
        return flight.value


class TTLCache:
    """値 1 つを ttl 秒だけ持つ"""

    def __init__(self, ttl: float, monotonic: Callable[[], float] = time.monotonic):
        self.ttl = ttl
        self._monotonic = monotonic
        self._value = None
        self._at: float | None = None
        self._flight = _SingleFlight()

    def _lookup(self):
        fresh = self._at is not None and self._monotonic() - self._at < self.ttl
        return fresh, self._value

    def _store(self, value):
        self._value, self._at = value, self._monotonic()

    def fresh(self) -> bool:
        """期限内の値があるか（ロックなしの目安。読み込むかどうかの判断だけに使い、値は get で取る）"""
        return self._lookup()[0]

    def stale(self):
        """期限に関わらず最後に読めた値（一度も読めていなければ None）"""
        return self._value if self._at is not None else None

    def get(self, load: Callable[[], object], stale_ok: bool = False):
        """stale_ok: 期限切れで読み込みに失敗したら古い値を返す（一度も読めていなければ例外）"""
        try:
            return self._flight.run(None, load, self._lookup, self._store)
        except Exception:
            stale, has_stale = self._value, self._at is not None
            if stale_ok and has_stale:
                return stale
            raise


class LRUCache:
    """キーごとの値を最大 maxsize 件（古いものから捨てる）。期限なし（キーが内容を決める）"""

    def __init__(self, maxsize: int):
        self.maxsize = maxsize
        self._items: OrderedDict = OrderedDict()
        self._flight = _SingleFlight()

    def get(self, key, load: Callable[[], object]):
        def lookup():
            if key in self._items:
                self._items.move_to_end(key)
                return True, self._items[key]
            return False, None

        def store(v):
            self._items[key] = v
            self._items.move_to_end(key)
            while len(self._items) > self.maxsize:
                self._items.popitem(last=False)

        return self._flight.run(key, load, lookup, store)


class ExpiringLRUCache:
    """キーごとの値を最大 maxsize 件、値ごとの期限（get の ttl 秒）つきで持つ（/api/atm_iv。#79）。
    期限切れの値は使わずに読み直す。古いもの（最後に使った順）から捨てる。例外はキャッシュしない"""

    def __init__(self, maxsize: int, monotonic: Callable[[], float] = time.monotonic):
        self.maxsize = maxsize
        self._monotonic = monotonic
        self._items: OrderedDict = OrderedDict()  # key → (値, 期限)
        self._flight = _SingleFlight()

    def get(self, key, load: Callable[[], object], ttl: float):
        def lookup():
            item = self._items.get(key)
            if item is not None and self._monotonic() < item[1]:
                self._items.move_to_end(key)
                return True, item[0]
            return False, None

        def store(v):
            self._items[key] = (v, self._monotonic() + ttl)
            self._items.move_to_end(key)
            while len(self._items) > self.maxsize:
                self._items.popitem(last=False)

        return self._flight.run(key, load, lookup, store)

    def __len__(self) -> int:
        return len(self._items)

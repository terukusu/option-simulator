"""キャッシュと single-flight（AC-3 の部品）。"""

import threading
import time

import pytest

from simulator_api.cache import LRUCache, TTLCache


class Mono:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_ttl_cache_reuses_until_expiry():
    mono = Mono()
    c = TTLCache(10, monotonic=mono)
    calls = []
    load = lambda: calls.append(1) or len(calls)  # noqa: E731
    assert c.get(load) == 1
    mono.t = 9.9
    assert c.get(load) == 1
    mono.t = 10.0
    assert c.get(load) == 2
    assert len(calls) == 2


def test_ttl_cache_error_is_not_cached_and_stale_is_used():
    mono = Mono()
    c = TTLCache(10, monotonic=mono)
    with pytest.raises(RuntimeError):
        c.get(lambda: (_ for _ in ()).throw(RuntimeError("x")))
    assert c.get(lambda: "a") == "a"
    mono.t = 11
    # 期限切れ + 読み込み失敗: stale_ok なら古い値
    assert c.get(lambda: (_ for _ in ()).throw(RuntimeError("x")), stale_ok=True) == "a"
    with pytest.raises(RuntimeError):
        c.get(lambda: (_ for _ in ()).throw(RuntimeError("x")))


def test_ttl_cache_fresh():
    mono = Mono()
    c = TTLCache(10, monotonic=mono)
    assert c.fresh() is False  # 空
    c.get(lambda: "a")
    mono.t = 9.9
    assert c.fresh() is True  # TTL 内
    mono.t = 10.0
    assert c.fresh() is False  # 期限切れ（古い値はある）
    assert c.stale() == "a"


def concurrently(n, fn):
    results, errors = [], []
    barrier = threading.Barrier(n)

    def work():
        barrier.wait()
        try:
            results.append(fn())
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(n)]
    for t in threads:
        t.start()
    return threads, results, errors


def test_ttl_single_flight():
    c = TTLCache(10)
    gate = threading.Event()
    calls = []

    def load():
        calls.append(1)
        gate.wait(5)
        return "v"

    threads, results, errors = concurrently(10, lambda: c.get(load))
    while not calls:
        pass
    gate.set()
    for t in threads:
        t.join(5)
    assert results == ["v"] * 10 and not errors
    assert len(calls) == 1


def test_single_flight_error_reaches_all_waiters_and_is_not_cached():
    c = LRUCache(4)
    gate = threading.Event()
    calls = []

    def load():
        calls.append(1)
        gate.wait(5)
        raise RuntimeError("boom")

    threads, results, errors = concurrently(5, lambda: c.get("k", load))
    while not calls:
        pass
    # 失敗はキャッシュしないので、全員が flight に入ってから失敗させる（遅れて来た呼び出しは読み直すのが正しい）
    time.sleep(0.3)
    gate.set()
    for t in threads:
        t.join(5)
    assert len(calls) == 1 and len(errors) == 5 and not results
    assert c.get("k", lambda: "ok") == "ok"


def test_lru_evicts_oldest():
    c = LRUCache(2)
    c.get("a", lambda: 1)
    c.get("b", lambda: 2)
    c.get("a", lambda: 99)  # a を新しくする
    c.get("c", lambda: 3)  # b が落ちる
    assert c.get("a", lambda: 100) == 1
    assert c.get("b", lambda: 200) == 200

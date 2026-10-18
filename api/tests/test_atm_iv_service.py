"""/api/atm_iv のキャッシュと single-flight（AC5）、日足のカレンダー（AC4）。偽の runner・時計。値はすべて架空。"""

import json
import threading
from datetime import UTC, datetime, timedelta

import pytest
from support import Clock, FakeRunner, World, cm_rows, jst

from simulator_api import atm_iv
from simulator_api import settings as st
from simulator_api.service import AtmIvService, ChainService, Unavailable

NOW = jst(2026, 10, 13, 21, 46)


def world():
    w = World()
    # 月曜の日中〜火曜の夜間の途中まで 1 分ごと（架空の IV）。深夜の 1 時間は NULL
    def value(t):
        return None if t.astimezone(atm_iv.JST).hour == 2 else 20.0 + (t.minute % 7) / 4
    w.cm = cm_rows(jst(2026, 10, 12, 8, 45), jst(2026, 10, 13, 21, 0), value=value)
    return w


def make(w=None, gate=None):
    clock = Clock(NOW)
    runner = FakeRunner(w or world(), gate=gate)
    return ChainService(runner, clock, monotonic=clock.monotonic), runner, clock


def parse(**args):
    return atm_iv.parse_request(args, NOW)


def body(payload):
    return json.loads(payload.json_bytes)


def test_right_edge_once_then_cached(capsys):
    svc, runner, _ = make()
    r = parse(tf="1m")
    first = svc.atm_iv(r)
    assert runner.count("atm_cm_iv") == 1
    name, params = runner.calls[0]
    assert params == {"start_at": r.start, "end_at": r.end, "step": 60}
    obj = body(first)
    assert obj["tf"] == "1m" and obj["bars"] and obj["last_at"] == "2026-10-13T20:59:00+09:00"
    assert all(b["h"] is not None for b in obj["bars"])
    ts = [b["t"] for b in obj["bars"]]
    assert ts == sorted(ts) and len(ts) == len(set(ts))
    assert not any("T02:" in t for t in ts)  # NULL の時間は足が無い
    runner.reset()
    second = svc.atm_iv(parse(tf="1m"))
    assert runner.calls == [] and second.json_bytes == first.json_bytes
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    served = [r for r in recs if r["event"] == "atm_iv_served"]
    assert [s["cache"] for s in served] == ["miss", "hit"]
    assert served[0]["tf"] == "1m" and served[0]["days"] == 3 and served[0]["bars"] == len(ts)
    out = json.dumps(served)
    assert "20.0" not in out and "2026-10" not in out  # 範囲・IV の値をログに出さない


def test_single_flight_8_concurrent():
    gate = threading.Event()
    svc, runner, _ = make(gate=gate)
    r = parse(tf="1h")
    results, errors = [], []
    barrier = threading.Barrier(8)

    def work():
        barrier.wait()
        try:
            results.append(svc.atm_iv(r).json_bytes)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    runner.started["atm_cm_iv"].wait(5)
    threading.Event().wait(0.2)  # 残りが flight に入るのを待つ
    gate.set()
    for t in threads:
        t.join(10)
    assert not errors and len(results) == 8 and len(set(results)) == 1
    assert runner.count("atm_cm_iv") == 1


def test_right_edge_is_reread_after_ttl():
    svc, runner, clock = make()
    svc.atm_iv(parse(tf="1h"))
    clock.advance(st.ATM_IV_TTL_SECONDS - 1)
    svc.atm_iv(atm_iv.parse_request({"tf": "1h"}, clock()))
    assert runner.count("atm_cm_iv") == 1
    clock.advance(1)
    svc.atm_iv(atm_iv.parse_request({"tf": "1h"}, clock()))
    assert runner.count("atm_cm_iv") == 2
    assert st.ATM_IV_TTL_SECONDS == 300


def test_new_rows_appear_after_ttl():
    w = world()
    svc, _, clock = make(w)
    r = parse(tf="1m")
    before = body(svc.atm_iv(r))
    w.cm += cm_rows(jst(2026, 10, 13, 21, 0), jst(2026, 10, 13, 21, 45))  # 表が毎時 45 分に更新された
    assert body(svc.atm_iv(r)) == before
    clock.advance(st.ATM_IV_TTL_SECONDS)
    after = body(svc.atm_iv(atm_iv.parse_request({"tf": "1m"}, clock())))
    assert after["last_at"] == "2026-10-13T21:44:00+09:00" and len(after["bars"]) > len(before["bars"])


def test_settled_range_is_cached_for_a_day():
    svc, runner, clock = make()
    args = {"tf": "1h", "start": "2026-09-01T00:00:00Z", "end": "2026-10-11T00:00:00Z"}
    svc.atm_iv(parse(**args))
    clock.advance(st.ATM_IV_SETTLED_TTL_SECONDS - 1)
    svc.atm_iv(atm_iv.parse_request(args, clock()))
    assert runner.count("atm_cm_iv") == 1
    clock.advance(1)
    svc.atm_iv(atm_iv.parse_request(args, clock()))
    assert runner.count("atm_cm_iv") == 2


def test_different_keys_are_separate():
    svc, runner, _ = make()
    svc.atm_iv(parse(tf="1m"))
    svc.atm_iv(parse(tf="1h"))
    svc.atm_iv(parse(tf="1h", start="2026-09-01T00:00:00Z", end="2026-10-01T00:00:00Z"))
    assert runner.count("atm_cm_iv") == 3


def test_errors_are_not_cached():
    w = world()
    clock = Clock(NOW)
    runner = FakeRunner(w, errors={"atm_cm_iv": RuntimeError("boom")})
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    with pytest.raises(RuntimeError):
        svc.atm_iv(parse(tf="1h"))
    runner.errors.clear()
    assert body(svc.atm_iv(parse(tf="1h")))["bars"]
    assert runner.count("atm_cm_iv") == 2


def test_cache_size_is_bounded():
    svc, _, _ = make()
    end = datetime(2026, 9, 1, tzinfo=UTC)
    for i in range(st.ATM_IV_CACHE_SIZE + 5):
        e = end - timedelta(days=i)
        svc.atm_iv(atm_iv.AtmIvRequest("1m", e - timedelta(days=1), e))
    assert len(svc._atm_iv._cache) == st.ATM_IV_CACHE_SIZE


def test_daily_uses_calendar_and_hourly_reads():
    svc, runner, _ = make()
    r = parse(tf="1d")
    obj = body(svc.atm_iv(r))
    assert runner.names().count("atm_cm_iv") == 1 and runner.count("trading_calendar") == 1
    params = dict(runner.calls)["atm_cm_iv"]
    assert params["step"] == 3600
    assert params["start_at"] == r.start - timedelta(days=10) and params["end_at"] == r.end
    # 月曜 10/12 の日中（先頭の取引日の前の夜間が無い = 読んだ範囲の先頭ではないので出る）と、月曜の夜間 + 火曜の日中・
    # 火曜の夜間（→ 水曜 10/14）
    assert [b["t"] for b in obj["bars"]] == ["2026-10-12T00:00:00+09:00", "2026-10-13T00:00:00+09:00",
                                             "2026-10-14T00:00:00+09:00"]
    # カレンダーは ChainService のキャッシュを共有（/api/calendar で読み直さない）
    svc.calendar()
    assert runner.count("trading_calendar") == 1


def test_daily_without_calendar_is_unavailable():
    clock = Clock(NOW)
    runner = FakeRunner(world(), errors={"trading_calendar": RuntimeError("x")})
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    with pytest.raises(RuntimeError):
        svc.atm_iv(parse(tf="1d"))
    assert body(svc.atm_iv(parse(tf="1h")))["bars"]  # 1m・1h はカレンダーを使わない
    standalone = AtmIvService(runner, clock, clock.monotonic, calendar=None)
    with pytest.raises(Unavailable):
        standalone.get(parse(tf="1d"))


def test_empty_range():
    svc, _, _ = make(World())
    obj = body(svc.atm_iv(parse(tf="1h")))
    assert obj["bars"] == [] and obj["last_at"] is None

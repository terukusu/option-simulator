"""/api/future_bars のキャッシュと single-flight・供給元の 503（#190 AC-4）。偽の runner・時計。値はすべて架空。"""

import json
import threading
from datetime import timedelta
from pathlib import Path

import pytest
from support import Clock, FakeRunner, World, fut_row, jst

from simulator_api import atm_iv
from simulator_api import settings as st
from simulator_api.service import (
    ChainService,
    FileChainService,
    FutureBarsService,
    QuotesFileService,
    Unavailable,
)

NOW = jst(2026, 12, 10, 21, 46)  # 木曜（12 月限の取引最終日）の夜間


def world():
    w = World()
    # 水曜の日中〜木曜の夜間の途中まで 1 分ごと（架空の値）。17:00 で限月交代
    t, i = jst(2026, 12, 9, 8, 45), 0
    while t < jst(2026, 12, 10, 21, 0):
        w.fut.append(fut_row(t, 30000.0 + (i % 13) * 5))
        t += timedelta(minutes=1)
        i += 1
    return w


def make(w=None, gate=None, errors=None):
    clock = Clock(NOW)
    runner = FakeRunner(w or world(), gate=gate, errors=errors)
    return ChainService(runner, clock, monotonic=clock.monotonic), runner, clock


def parse(**args):
    return atm_iv.parse_request(args, NOW)


def body(payload):
    return json.loads(payload.json_bytes)


def test_once_then_cached_and_logs(capsys):
    svc, runner, _ = make()
    r = parse(tf="1m")
    first = svc.future_bars(r)
    assert runner.count("future_bars") == 1
    params = dict(runner.calls)["future_bars"]
    assert params == {"start_at": r.start, "end_at": r.end + timedelta(minutes=10), "step": 60}
    obj = body(first)
    assert obj["tf"] == "1m" and obj["last_at"] == "2026-12-10T20:59:00+09:00"
    ms = [b["m"] for b in obj["bars"]]
    assert ms[0] == "2026-12" and ms[-1] == "2027-03"
    roll = next(b["t"] for b in obj["bars"] if b["m"] == "2027-03")
    assert roll == "2026-12-10T17:00:00+09:00"
    runner.reset()
    second = svc.future_bars(parse(tf="1m"))
    assert runner.calls == [] and second.json_bytes == first.json_bytes
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    served = [r for r in recs if r["event"] == "future_bars_served"]
    assert [s["cache"] for s in served] == ["miss", "hit"]
    # 生の contract_month は 2026-12 のままなので、17:00 以後の足は食い違いとして数える（値は出さない）
    assert served[0]["contract_mismatch"] == sum(1 for m in ms if m != "2026-12")
    out = json.dumps(served)
    assert "30000" not in out and "2026-12" not in out


def test_single_flight_8_concurrent():
    gate = threading.Event()
    svc, runner, _ = make(gate=gate)
    r = parse(tf="1h")
    results, errors = [], []
    barrier = threading.Barrier(8)

    def work():
        barrier.wait()
        try:
            results.append(svc.future_bars(r).json_bytes)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    runner.started["future_bars"].wait(5)
    threading.Event().wait(0.2)
    gate.set()
    for t in threads:
        t.join(10)
    assert not errors and len(results) == 8 and len(set(results)) == 1
    assert runner.count("future_bars") == 1


def test_right_edge_ttl_300_and_settled_ttl_a_day():
    svc, runner, clock = make()
    svc.future_bars(parse(tf="1h"))
    clock.advance(st.ATM_IV_TTL_SECONDS - 1)
    svc.future_bars(atm_iv.parse_request({"tf": "1h"}, clock()))
    assert runner.count("future_bars") == 1
    clock.advance(1)
    svc.future_bars(atm_iv.parse_request({"tf": "1h"}, clock()))
    assert runner.count("future_bars") == 2
    args = {"tf": "1h", "start": "2026-10-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}
    svc.future_bars(atm_iv.parse_request(args, clock()))
    clock.advance(st.ATM_IV_SETTLED_TTL_SECONDS - 1)
    svc.future_bars(atm_iv.parse_request(args, clock()))
    assert runner.count("future_bars") == 3
    clock.advance(1)
    svc.future_bars(atm_iv.parse_request(args, clock()))
    assert runner.count("future_bars") == 4


def test_iv_and_futures_are_separate():
    svc, runner, _ = make()
    svc.future_bars(parse(tf="1h"))
    svc.atm_iv(parse(tf="1h"))
    assert runner.count("future_bars") == 1 and runner.count("atm_cm_iv") == 1


def test_daily_uses_hourly_reads_and_calendar():
    svc, runner, _ = make()
    r = parse(tf="1d")
    obj = body(svc.future_bars(r))
    params = dict(runner.calls)["future_bars"]
    assert params["step"] == 3600 and params["start_at"] == r.start - timedelta(days=10)
    assert params["end_at"] == r.end + timedelta(minutes=10)
    assert runner.count("trading_calendar") == 1
    assert [(b["t"], b["m"]) for b in obj["bars"]] == [("2026-12-09T00:00:00+09:00", "2026-12"),
                                                       ("2026-12-10T00:00:00+09:00", "2026-12"),
                                                       ("2026-12-11T00:00:00+09:00", "2027-03")]


def test_bigquery_error_is_raised_and_not_cached():
    svc, runner, _ = make(errors={"future_bars": RuntimeError("boom")})
    with pytest.raises(RuntimeError):
        svc.future_bars(parse(tf="1h"))
    runner.errors.clear()
    assert body(svc.future_bars(parse(tf="1h")))["bars"]
    assert runner.count("future_bars") == 2


def test_calendar_error_is_raised():
    svc, _, _ = make(errors={"trading_calendar": RuntimeError("x")})
    with pytest.raises(RuntimeError):
        svc.future_bars(parse(tf="1h"))
    clock = Clock(NOW)
    standalone = FutureBarsService(FakeRunner(world()), clock, clock.monotonic, calendar=None)
    with pytest.raises(Unavailable):
        standalone.get(parse(tf="1h"))


def test_file_and_quotes_sources_are_unavailable(tmp_path: Path):
    with pytest.raises(Unavailable) as e:
        FileChainService(tmp_path / "c.json").future_bars(parse(tf="1h"))
    assert e.value.args == ("file_source",)
    with pytest.raises(Unavailable) as e:
        QuotesFileService(tmp_path / "q.json", tmp_path / "cal.json", Clock(NOW)).future_bars(parse(tf="1h"))
    assert e.value.args == ("quotes_source",)


def test_empty_range():
    svc, _, _ = make(World())
    obj = body(svc.future_bars(parse(tf="1h")))
    assert obj["bars"] == [] and obj["last_at"] is None

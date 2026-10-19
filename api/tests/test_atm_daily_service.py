"""/api/atm_daily のキャッシュと single-flight（A4）。偽の runner・時計。値はすべて架空。"""

import json
import threading
from datetime import date, timedelta
from pathlib import Path

import pytest
from support import Clock, FakeRunner, World, cm_daily_row, jst

from simulator_api import settings as st
from simulator_api.service import ChainService, FileChainService, Unavailable

NOW = jst(2026, 10, 14, 10, 30)  # 水曜の日中（範囲の終わり = 10/14。10/13 までが確定）


def world():
    w = World()
    # 10/12（月）〜10/14（水）の日中・夜間の行（架空の値）。10/14 の日中は範囲の外
    for d, iv, f in ((12, 19.5, 30000.0), (13, 20.25, 29850.0), (14, 21.0, 29700.0)):
        for h, mi in ((8, 50), (9, 0), (12, 0), (15, 0), (15, 10), (21, 0)):
            w.cm_daily.append(cm_daily_row(jst(2026, 10, d, h, mi), iv30=iv + mi / 1000, f1=f + h))
    return w


def make(w=None, gate=None, errors=None):
    clock = Clock(NOW)
    runner = FakeRunner(w or world(), gate=gate, errors=errors)
    return ChainService(runner, clock, monotonic=clock.monotonic), runner, clock


def body(payload):
    return json.loads(payload.json_bytes)


def test_once_then_cached(capsys):
    svc, runner, _ = make()
    first = svc.atm_daily()
    assert runner.names() == ["atm_cm_daily"]
    _, params = runner.calls[0]
    assert params == {"start_at": jst(2010, 1, 1, 9), "end_at": jst(2026, 10, 14, 0)}
    obj = body(first)
    assert obj["end"] == "2026-10-14"
    # 日中の終値 = 15:00 の行（15:10・夜間は窓の外）
    assert [(d["d"], d["t"], d["f1"]) for d in obj["days"]] == [
        ("2026-10-12", "2026-10-12T15:00:00+09:00", 30015.0),
        ("2026-10-13", "2026-10-13T15:00:00+09:00", 29865.0),
    ]
    assert first.etag == '"atm-daily-2026-10-14-2"'
    runner.reset()
    second = svc.atm_daily()
    assert runner.calls == [] and second.json_bytes == first.json_bytes and second.gzip_bytes == first.gzip_bytes
    recs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    served = [r for r in recs if r["event"] == "atm_daily_served"]
    assert [s["cache"] for s in served] == ["miss", "hit"]
    assert served[0]["end"] == "2026-10-14" and served[0]["days"] == 2 and isinstance(served[0]["elapsed_ms"], int)
    out = json.dumps(served)
    assert "19.5" not in out and "30015" not in out  # IV・フォワードの値をログに出さない


def test_single_flight_8_concurrent():
    gate = threading.Event()
    svc, runner, _ = make(gate=gate)
    results, errors = [], []
    barrier = threading.Barrier(8)

    def work():
        barrier.wait()
        try:
            results.append(svc.atm_daily().json_bytes)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for t in threads:
        t.start()
    runner.started["atm_cm_daily"].wait(5)
    threading.Event().wait(0.2)  # 残りが flight に入るのを待つ
    gate.set()
    for t in threads:
        t.join(10)
    assert not errors and len(results) == 8 and len(set(results)) == 1
    assert runner.count("atm_cm_daily") == 1


def test_reread_when_end_day_changes():
    svc, runner, clock = make()
    assert body(svc.atm_daily())["end"] == "2026-10-14"
    # 翌朝 7:59 まで同じ範囲（キャッシュ）、8:00 で範囲の終わりが変わり読み直す
    clock.advance((jst(2026, 10, 15, 7, 59) - clock()).total_seconds())
    svc.atm_daily()
    assert runner.count("atm_cm_daily") == 1
    clock.advance(60)
    obj = body(svc.atm_daily())
    assert runner.count("atm_cm_daily") == 2
    assert obj["end"] == "2026-10-15" and [d["d"] for d in obj["days"]][-1] == "2026-10-14"
    _, params = runner.calls[-1]
    assert params["end_at"] == jst(2026, 10, 15, 0)


def test_ttl_rereads_same_end_day():
    svc, runner, clock = make()
    svc.atm_daily()
    # 時計（壁時計）を止めたまま単調時計だけ TTL 分進める（同じ範囲でも 24 時間で読み直す）
    clock.mono += st.ATM_DAILY_TTL_SECONDS - 1
    svc.atm_daily()
    assert runner.count("atm_cm_daily") == 1
    clock.mono += 1
    svc.atm_daily()
    assert runner.count("atm_cm_daily") == 2
    assert st.ATM_DAILY_TTL_SECONDS == 86400


def test_errors_are_not_cached():
    svc, runner, _ = make(errors={"atm_cm_daily": RuntimeError("boom")})
    with pytest.raises(RuntimeError):
        svc.atm_daily()
    runner.errors.clear()
    assert body(svc.atm_daily())["days"]
    assert runner.count("atm_cm_daily") == 2


def test_budget_exceeded_is_unavailable():
    # 1 リクエストの BigQuery 待ちの予算を超えていたらクエリを出さない（単調時計が呼ぶたびに予算より進む）
    svc, runner, _ = make()
    t = [0.0]

    def stepping():
        t[0] += st.REQUEST_BUDGET_SECONDS + 1
        return t[0]

    svc._atm_daily.monotonic = stepping
    with pytest.raises(Unavailable):
        svc.atm_daily()
    assert runner.count("atm_cm_daily") == 0


def test_cache_size_is_bounded():
    svc, _, clock = make()
    for i in range(st.ATM_DAILY_CACHE_SIZE + 3):
        clock.now = jst(2026, 10, 14, 9) + timedelta(days=i)
        svc.atm_daily()
    assert len(svc._atm_daily._cache) == st.ATM_DAILY_CACHE_SIZE


def test_empty_table():
    svc, _, _ = make(World())
    obj = body(svc.atm_daily())
    assert obj["days"] == [] and obj["end"] == date(2026, 10, 14).isoformat()


def test_file_source_is_unavailable(tmp_path: Path):
    svc = FileChainService(tmp_path / "chain.json")
    with pytest.raises(Unavailable):
        svc.atm_daily()

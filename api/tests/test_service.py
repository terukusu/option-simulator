"""/api/chain の組み立ての通し（AC-1 の round-trip、AC-3 のキャッシュ・single-flight、待ち時間の上限）。"""

import json
import threading
from datetime import timedelta

import pytest
from support import Clock, FakeRunner, World, jst, load_fixture, synth_board

from simulator_api.service import ChainService, Unavailable


def without(d, *keys):
    return {k: v for k, v in d.items() if k not in keys}


def fixture_world(name):
    """fixture の板を最新（または板寄せ前の最後）として持つ World と、そのときの現在時刻"""
    fx = load_fixture(name)
    w = World()
    snap = w.add_fixture(fx)
    if name == "pre_open":
        # 15:40 の後に引け後の 15:41〜16:14（窓の外）と、夜間の寄り前 16:50（42 行の壊れた板）
        t = snap + timedelta(minutes=1)
        while t <= jst(2026, 10, 13, 16, 14):
            w.add(t, synth_board(t, quoted=5), 67700.0)
            t += timedelta(minutes=1)
        latest = jst(2026, 10, 13, 16, 50)
        w.add(latest, synth_board(latest, quoted=0)[:42], None, rows_option=42)
        now = latest + timedelta(minutes=15)
    else:
        # 1 分前の板（読まれないこと）
        prev = snap - timedelta(minutes=1)
        w.add(prev, synth_board(prev), 67000.0)
        now = snap + timedelta(minutes=15)
    return fx, w, now


@pytest.mark.parametrize("name,reason", [("latest", "latest"), ("night_early", "latest"), ("pre_open", "pre_open")])
def test_roundtrip_fixture(name, reason):
    # AC-1: 合成の fixture → 偽の runner の行 → /api/chain の JSON が元の fixture と一致（source・reason を除く）
    fx, w, now = fixture_world(name)
    clock = Clock(now)
    svc = ChainService(FakeRunner(w), clock, monotonic=clock.monotonic)
    res = svc.chain()
    got = json.loads(res.json_bytes)
    assert got["reason"] == reason
    assert got["source"] == "bigquery"
    assert without(got, "source", "reason") == without(fx, "source", "reason")
    # 型も一致（float の 1.0 と int の 1 の違いは JSON の数として同じなので、bool / null / 文字列だけを厳密に）
    for gm, fm in zip(got["months"], fx["months"], strict=True):
        for gr, fr in zip(gm["rows"], fm["rows"], strict=True):
            for side in ("call", "put"):
                for k, v in fr[side].items():
                    assert type(gr[side][k]) is type(v) or (isinstance(v, (int, float)) and not isinstance(v, bool)
                                                            and isinstance(gr[side][k], (int, float))), (k, v)
    # 時刻はすべて +09:00
    text = res.json_bytes.decode()
    assert "Z\"" not in text and "+00:00" not in text
    assert text.count("+09:00") >= 3


def test_second_request_reads_only_latest_runs():
    # AC-3: 同じ snapshot_at の 2 回目は latest_runs だけ（板・先物・現物・カレンダーのクエリ 0 回）
    fx, w, now = fixture_world("latest")
    clock = Clock(now)
    runner = FakeRunner(w)
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    first = svc.chain()
    assert sorted(set(runner.names())) == ["future_price", "latest_runs", "option_price", "spot_price",
                                           "trading_calendar"]
    runner.reset()
    clock.advance(11)  # latest_runs の TTL（10 秒）を過ぎる
    second = svc.chain()
    assert runner.names() == ["latest_runs"]
    assert second.json_bytes == first.json_bytes and second.etag == first.etag
    # TTL 内なら latest_runs も読まない
    runner.reset()
    clock.advance(1)
    svc.chain()
    assert runner.names() == []


def test_unusable_board_is_cached_too():
    # 不採用の板も (snapshot_at, finished_at) で覚える → 2 回目は読み直さない
    at = jst(2026, 10, 13, 21, 31)
    w = World()
    prev = at - timedelta(minutes=1)
    w.add(prev, synth_board(prev), 30000.0)
    w.add(at, synth_board(at, quoted=10), 30000.0)
    clock = Clock(at + timedelta(minutes=15))
    runner = FakeRunner(w)
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    assert svc.chain().snapshot_at == prev
    runner.reset()
    clock.advance(11)
    assert svc.chain().snapshot_at == prev
    assert runner.names() == ["latest_runs"]


def test_reprocessed_snapshot_is_read_again():
    # 再処理で同じ snapshot_at の finished_at が変わったら取り直す
    fx, w, now = fixture_world("latest")
    clock = Clock(now)
    runner = FakeRunner(w)
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    first = svc.chain()
    for r in w.runs:
        r["finished_at"] += timedelta(minutes=5)
    runner.reset()
    clock.advance(11)
    second = svc.chain()
    assert runner.count("option_price") == 1
    assert second.etag != first.etag


def test_ten_concurrent_requests_read_board_once():
    # AC-3: 同時 10 リクエスト（スレッド）で板のクエリが 1 回
    fx, w, now = fixture_world("latest")
    clock = Clock(now)
    gate = threading.Event()
    runner = FakeRunner(w, gate=gate)
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    results, errors = [], []
    barrier = threading.Barrier(10)

    def work():
        barrier.wait()
        try:
            results.append(svc.chain())
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work) for _ in range(10)]
    for t in threads:
        t.start()
    while not runner.calls:
        pass
    gate.set()
    for t in threads:
        t.join(10)
    assert not errors and len(results) == 10
    assert runner.count("latest_runs") == 1
    assert runner.count("option_price") == 1
    assert len({r.json_bytes for r in results}) == 1


def test_runner_error_is_unavailable_and_not_cached():
    fx, w, now = fixture_world("latest")
    clock = Clock(now)
    runner = FakeRunner(w, errors={"option_price": RuntimeError("secret detail")})
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    with pytest.raises(RuntimeError):
        svc.chain()
    runner.errors = {}
    clock.advance(11)
    assert svc.chain().reason == "latest"


class SlowRunner(FakeRunner):
    """1 回の呼び出しで単調時計を進める（BigQuery の待ち時間の代わり）"""

    def __init__(self, world, clock, seconds):
        super().__init__(world)
        self.clock = clock
        self.seconds = seconds

    def __call__(self, name, params):
        self.clock.advance(self.seconds)
        return super().__call__(name, params)


def test_request_budget_stops_reading():
    # 1 リクエストの BigQuery 待ちの合計が 40 秒を超えたら候補の読み込みをやめて 503
    at = jst(2026, 10, 13, 21, 31)
    w = World()
    for back in (2, 1, 0):
        t = at - timedelta(minutes=back)
        w.add(t, synth_board(t, quoted=10 if back < 2 else 100), 30000.0)
    clock = Clock(at + timedelta(minutes=15))
    runner = SlowRunner(w, clock, 9)
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    with pytest.raises(Unavailable):
        svc.chain()
    # latest_runs（9）+ カレンダー（18）+ 先物（27）+ 板（36）+ 次の先物（45 > 40 で止まる手前の確認）
    assert runner.count("option_price") <= 2


def test_calendar_stale_on_error_and_503_when_never_loaded():
    fx, w, now = fixture_world("latest")
    clock = Clock(now)
    runner = FakeRunner(w, errors={"trading_calendar": RuntimeError("x")})
    svc = ChainService(runner, clock, monotonic=clock.monotonic)
    with pytest.raises(Exception):  # noqa: B017
        svc.calendar()
    runner.errors = {}
    first = svc.calendar()
    runner.errors = {"trading_calendar": RuntimeError("x")}
    clock.advance(3601)
    assert svc.calendar().etag == first.etag  # 古い版を使う
    assert runner.count("trading_calendar") == 3

"""使える板の判定（AC-2。docs/design.md 7.2）: 純粋な関数と、偽の runner を通した候補の読み方。"""

import time
from datetime import UTC, date, datetime, timedelta

import pytest
from support import Clock, FakeRunner, World, jst, option_row, synth_board

from simulator_api import usable
from simulator_api.service import ChainService, Unavailable
from simulator_api.usable import Run


def r(at, rows=800):
    return Run(snapshot_at=at, rows_option=rows, finished_at=at + timedelta(seconds=40))


# ---- 時刻（snapshot_at の JST）----

@pytest.mark.parametrize("h,m,expected", [
    (8, 44, False), (8, 45, True), (12, 0, True), (15, 40, True), (15, 41, False),
    (16, 59, False), (17, 0, True), (23, 59, True), (0, 0, True), (5, 55, True), (5, 56, False),
])
def test_in_session(h, m, expected):
    assert usable.in_session(jst(2026, 10, 13, h, m)) is expected


def test_time_is_jst_across_utc_midnight():
    # JST 9:00 = UTC 0:00（日跨ぎ）。UTC の時刻で判定すると 0:00 は夜間の窓に見えてしまう
    at = datetime(2026, 10, 13, 0, 0, tzinfo=UTC)
    assert usable.jst_time(at).hour == 9
    assert usable.in_session(at)
    # JST 8:40 = UTC 前日 23:40 は寄り前
    pre = datetime(2026, 10, 12, 23, 40, tzinfo=UTC)
    assert usable.classify(r(pre), pre + timedelta(minutes=15)) == "pre_open"


@pytest.mark.parametrize("h,m,expected", [
    (8, 39, "pre_open"), (8, 46, "pre_open"), (16, 45, "pre_open"), (16, 50, "pre_open"), (17, 0, "pre_open"),
    (15, 41, "after_close"), (15, 59, "after_close"), (16, 44, "after_close"),
    (5, 56, "after_close"), (6, 30, "after_close"), (8, 38, "after_close"),
    (12, 0, "closed"), (21, 0, "closed"),
])
def test_classify_by_latest_time(h, m, expected):
    at = jst(2026, 10, 13, h, m)
    assert usable.classify(r(at), at + timedelta(minutes=15)) == expected


def test_classify_stale_is_closed():
    at = jst(2026, 10, 13, 15, 59)
    assert usable.classify(r(at), at + timedelta(minutes=45)) == "after_close"
    assert usable.classify(r(at), at + timedelta(minutes=45, seconds=1)) == "closed"


def test_is_candidate_needs_session_and_rows():
    at = jst(2026, 10, 13, 21, 0)
    assert usable.is_candidate(r(at, 300))
    assert not usable.is_candidate(r(at, 299))
    assert not usable.is_candidate(r(jst(2026, 10, 13, 15, 41), 1000))


def test_session_key_night_spans_midnight():
    assert usable.session_key(jst(2026, 10, 13, 23, 0)) == usable.session_key(jst(2026, 10, 14, 5, 55))
    assert usable.session_key(jst(2026, 10, 14, 9, 0)) != usable.session_key(jst(2026, 10, 14, 5, 55))


# ---- 板の判定（1 限月の先物 ±5% の両側気配）----

def _round_rows(rows, future):
    """1 限月・帯の中・500 円の倍数の行（判定が数える行）"""
    m1 = min(r["last_trading_day"] for r in rows)
    return [r for r in rows if r["last_trading_day"] == m1 and 0.95 * future <= r["target_price"] <= 1.05 * future
            and r["target_price"] % 500 == 0]


def test_board_ok_threshold_on_round_strikes():
    # 下限 3/5。F = 30000 は 500 円の倍数が 7 行使価格（14 行）: 9 行（63%）採用 / 8 行（57%）不採用
    at = jst(2026, 10, 13, 21, 0)
    assert len(_round_rows(synth_board(at), 30000.0)) == 14
    assert usable.board_ok(synth_board(at, quoted=9), 30000.0)
    assert not usable.board_ok(synth_board(at, quoted=8), 30000.0)
    # F = 64840（実の板の大きさ）は 13 行使価格（26 行）: 16 行（16×5=80 ≥ 78）採用 / 15 行（75 < 78）不採用
    assert len(_round_rows(synth_board(at, future=64840.0), 64840.0)) == 26
    assert usable.board_ok(synth_board(at, future=64840.0, quoted=16), 64840.0)
    assert not usable.board_ok(synth_board(at, future=64840.0, quoted=15), 64840.0)
    # 4 行なら 3 行採用 / 2 行不採用（ちょうど 1/2 = call だけ・put だけの板は通さない）
    m1 = date(2026, 11, 12)
    sides = ((1, 29500, True), (2, 29500, True), (1, 30000, True), (2, 30000, False))
    four = [option_row(at, typ, k, m1, bid=1 if q else None, ask=2 if q else None) for typ, k, q in sides]
    assert usable.board_ok(four, 30000.0)
    calls_only = [dict(r, bid=1, ask=2) if r["type"] == 1 else dict(r, bid=None, ask=None) for r in four]
    assert not usable.board_ok(calls_only, 30000.0)


def test_board_ok_thin_night_round_strikes_only():
    # #196: 深夜の薄い板（2026-10-20 01:10 の形を模した架空の値）。125 円刻みだけの行は気配なし、250 円刻み
    # （500 でない）は半分、500 円刻みは 26 行中 25 行。全行では 38/104（37%）で旧の判定（75%）なら不採用、
    # 500 円刻みでは採用
    at = jst(2026, 10, 20, 1, 10)
    future = 64840.0
    m1 = date(2026, 11, 12)
    rows = []
    i250 = i500 = 0
    k = 61625
    while k <= 1.05 * future:
        for typ in (1, 2):
            if k % 500 == 0:
                q = i500 != 0  # 1 行だけ欠ける
                i500 += 1
            elif k % 250 == 0:
                q = i250 % 2 == 0
                i250 += 1
            else:
                q = False
            rows.append(option_row(at, typ, k, m1, bid=10 if q else None, ask=15 if q else None))
        k += 125
    band = [r for r in rows if 0.95 * future <= r["target_price"] <= 1.05 * future]
    both = sum(r["bid"] is not None for r in band)
    assert (len(band), both) == (104, 38)
    assert both * 4 < len(band) * 3  # 旧の判定（全行・75%）なら不採用
    assert usable.board_ok(rows, future)
    # 500 円刻みからも気配が抜けていく: 26 行中 19 行（73%。10-20 未明の最も薄い形）は採用、14 行（54%）は不採用
    round_ids = [id(r) for r in _round_rows(rows, future)]

    def drop(n):  # 500 円刻みの行のうち先頭（気配の無い 1 行の後）から n 行の気配を消す
        ids = set(round_ids[1:1 + n])
        return [dict(r, bid=None, ask=None) if id(r) in ids else r for r in rows]

    def round_both(rs):
        return sum(r["bid"] is not None for r in _round_rows(rs, future))

    assert (round_both(drop(6)), round_both(drop(11))) == (19, 14)
    assert usable.board_ok(drop(6), future)
    assert not usable.board_ok(drop(11), future)


def test_board_ok_counts_only_round_strikes():
    # 500 円の倍数でない行は数えない（気配が全部あっても、全部無くても判定は変わらない）
    at = jst(2026, 10, 13, 21, 0)
    assert usable.board_ok(synth_board(at, fine_quoted=False), 30000.0)
    assert not usable.board_ok(synth_board(at, quoted=0, fine_quoted=True), 30000.0)
    # 帯に 500 円の倍数の行が無い（分母 0）は不採用
    m1 = date(2026, 11, 12)
    assert not usable.board_ok([option_row(at, 1, 30125, m1, bid=1, ask=2)], 30000.0)


def test_board_ok_counts_only_first_month_within_band():
    at = jst(2026, 10, 13, 21, 0)
    rows = synth_board(at)
    # 帯の外・2 限月に気配が無くても採用（数えない）
    assert usable.board_ok(rows, 30000.0)
    # 帯の端（0.95F・1.05F）は含む
    edge = [option_row(at, 1, 28500, date(2026, 11, 12), bid=1, ask=2),
            option_row(at, 2, 31500, date(2026, 11, 12))]
    assert not usable.board_ok(edge, 30000.0)  # 1/2
    assert usable.board_ok(edge[:1], 30000.0)


def test_board_ok_rejects_missing_future_or_empty_band():
    at = jst(2026, 10, 13, 21, 0)
    rows = synth_board(at)
    assert not usable.board_ok(rows, None)
    assert not usable.board_ok(rows, 0.0)
    assert not usable.board_ok(rows, -1.0)
    assert not usable.board_ok([], 30000.0)
    # 帯の中に行が無い（分母 0）
    assert not usable.board_ok(rows, 90000.0)
    # type が NULL の行は数えない
    assert not usable.board_ok([option_row(at, None, 30000, date(2026, 11, 12), bid=1, ask=2)], 30000.0)


def test_board_ok_one_sided_quotes_are_not_both():
    at = jst(2026, 10, 13, 21, 0)
    m1 = date(2026, 11, 12)
    rows = [option_row(at, 1, 30000, m1, bid=1, ask=None), option_row(at, 2, 30000, m1, bid=None, ask=2)]
    assert not usable.board_ok(rows, 30000.0)


# ---- 候補の読み方（偽の runner）----

def service(world, now):
    clock = Clock(now)
    runner = FakeRunner(world)
    return ChainService(runner, clock, monotonic=clock.monotonic), runner, clock


def test_latest_usable():
    at = jst(2026, 10, 13, 21, 31)
    w = World().add(at - timedelta(minutes=1), synth_board(at - timedelta(minutes=1)), 30000.0)
    w.add(at, synth_board(at), 30000.0, spot_price=29000)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (at, "latest")
    assert runner.count("option_price") == 1
    assert runner.count("spot_price") == 1


def test_future_null_rejects_without_reading_board():
    # (b) 先物価格 NULL（夜間の寄り前）は板を読まずに不採用 → 次の候補
    at = jst(2026, 10, 13, 21, 31)
    prev = at - timedelta(minutes=1)
    w = World().add(prev, synth_board(prev), 30000.0)
    w.add(at, synth_board(at), {"price": None, "price_time": None, "contract_month": date(2026, 12, 1)})
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (prev, "latest")
    # 板は 1 回（prev）だけ。at は先物だけ読んだ
    reads = [p["start_at"] for n, p in runner.calls if n == "option_price"]
    assert reads == [prev]
    assert [p["start_at"] for n, p in runner.calls if n == "future_price"] == [at, prev]


def test_future_row_missing_rejects_without_reading_board():
    at = jst(2026, 10, 13, 21, 31)
    prev = at - timedelta(minutes=1)
    w = World().add(prev, synth_board(prev), 30000.0)
    w.add(at, synth_board(at), None)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    assert svc.chain().snapshot_at == prev
    assert [p["start_at"] for n, p in runner.calls if n == "option_price"] == [prev]


def test_few_rows_are_not_read():
    # (c) rows_option < 300 の候補は板も先物も読まない。最新が 299 行なら時刻で分類（21:31 は closed）
    at = jst(2026, 10, 13, 21, 31)
    prev = at - timedelta(minutes=1)
    w = World().add(prev, synth_board(prev), 30000.0)
    w.add(at, synth_board(at), 30000.0, rows_option=299)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    res = svc.chain()
    assert res.snapshot_at == prev
    assert at not in [p["start_at"] for n, p in runner.calls if n in ("option_price", "future_price")]


def day_close_world(latest_hm):
    """日中の 15:38〜15:40 は使える板、15:41〜latest は気配の消えた板（引け後）"""
    w = World()
    for m in (38, 39, 40):
        at = jst(2026, 10, 13, 15, m)
        w.add(at, synth_board(at), 30000.0, spot_price=29000)
    h, m_end = latest_hm
    t = jst(2026, 10, 13, 15, 41)
    end = jst(2026, 10, 13, h, m_end)
    while t <= end:
        w.add(t, synth_board(t, quoted=1), 30000.0)
        t += timedelta(minutes=1)
    return w


def test_after_close_15_59_returns_15_40():
    # (d) 最新 15:59（引け後）→ 15:40 以前の最後の板を after_close で。15:41〜15:59 は窓の外なので読まない
    w = day_close_world((15, 59))
    svc, runner, _ = service(w, jst(2026, 10, 13, 16, 14))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (jst(2026, 10, 13, 15, 40), "after_close")
    assert runner.count("option_price") == 1


def test_pre_open_16_50_returns_15_40():
    # (d) 最新 16:50（夜間の寄り前。42 行の壊れた板）→ 15:40 の板を pre_open で
    w = day_close_world((16, 14))
    at = jst(2026, 10, 13, 16, 50)
    w.add(at, synth_board(at, quoted=0)[:42], None, rows_option=42)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (jst(2026, 10, 13, 15, 40), "pre_open")
    assert runner.count("option_price") == 1


def test_stale_latest_is_closed():
    # (d) 最新が 45 分より古い（土日・休業日・取り込みの停止）→ closed。板は 15:40
    w = day_close_world((16, 14))
    now = jst(2026, 10, 13, 16, 14) + timedelta(minutes=45, seconds=1)
    svc, _, _ = service(w, now)
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (jst(2026, 10, 13, 15, 40), "closed")
    # 土曜の昼
    svc, _, _ = service(w, jst(2026, 10, 17, 12, 0))
    assert svc.chain().reason == "closed"


def test_stale_latest_in_session_is_returned_as_closed():
    # 取り込みが立会中に止まった: 最新（窓の中・使える）でも古ければ closed で返す
    at = jst(2026, 10, 13, 21, 31)
    w = World().add(at, synth_board(at), 30000.0)
    svc, _, _ = service(w, at + timedelta(hours=2))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (at, "closed")


def test_night_after_close_returns_5_55():
    # (e) 夜間の引け後 5:56〜6:30 は 5:55 以前の板を after_close で（JST の日跨ぎ = 前日 17:00 からの夜間）
    w = World()
    for h, m in ((5, 54), (5, 55)):
        at = jst(2026, 10, 14, h, m)
        w.add(at, synth_board(at), 30000.0)
    t = jst(2026, 10, 14, 5, 56)
    while t <= jst(2026, 10, 14, 6, 10):
        w.add(t, synth_board(t, quoted=5), 30000.0)
        t += timedelta(minutes=1)
    for now_hm in ((6, 11), (6, 25)):
        svc, runner, _ = service(w, jst(2026, 10, 14, *now_hm))
        res = svc.chain()
        assert (res.snapshot_at, res.reason) == (jst(2026, 10, 14, 5, 55), "after_close")
        assert runner.count("option_price") == 1


def test_morning_pre_open_across_utc_date():
    # 日中の寄り前 8:40（UTC では前日 23:40）→ 前夜の 5:55 の板を pre_open で
    w = World()
    night = jst(2026, 10, 14, 5, 55)
    w.add(night, synth_board(night), 30000.0)
    pre = jst(2026, 10, 14, 8, 40)
    w.add(pre, synth_board(pre, quoted=5), 30000.0, rows_option=1000)
    svc, _, _ = service(w, pre + timedelta(minutes=15))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (night, "pre_open")


def test_day_session_start_at_9_jst_is_latest():
    # JST 9:00 = UTC 0:00 の板は窓の中（latest）
    at = jst(2026, 10, 14, 9, 0)
    w = World().add(at, synth_board(at), 30000.0)
    svc, _, _ = service(w, at + timedelta(minutes=15))
    assert svc.chain().reason == "latest"


def test_unusable_latest_in_session_goes_older_as_latest():
    # 窓の中で最新が使えない（まれ）→ 古い方へ。同じ立会の板なら latest
    at = jst(2026, 10, 13, 21, 31)
    w = World()
    for back, quoted in ((2, None), (1, 5)):
        t = at - timedelta(minutes=back)
        w.add(t, synth_board(t, quoted=quoted), 30000.0)
    w.add(at, synth_board(at, quoted=1), 30000.0)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    res = svc.chain()
    assert (res.snapshot_at, res.reason) == (at - timedelta(minutes=2), "latest")
    assert runner.count("option_price") == 3


def test_three_reads_then_503():
    # (f) 3 回読んでも使えなければ 503（4 つ目の使える板は読まない）
    at = jst(2026, 10, 13, 21, 31)
    w = World()
    t = at - timedelta(minutes=3)
    w.add(t, synth_board(t), 30000.0)
    for back in (2, 1, 0):
        t = at - timedelta(minutes=back)
        w.add(t, synth_board(t, quoted=1), 30000.0)
    svc, runner, clock = service(w, at + timedelta(minutes=15))
    with pytest.raises(Unavailable):
        svc.chain()
    assert runner.count("option_price") == 3
    # 上限はキャッシュ済みの評価（不採用として覚えた板）も数える（7.2 の 4。#245）: 同じ候補のままなら 2 回目は
    # 4 つ目へ読み進まず、板を読まずに 503（使える板が無いときに要求のたびに板を読む費用を出さない）
    # 503 の経路はカレンダー（別スレッド）を待たないので、キャッシュに入るまで待ってから数え直す
    deadline = time.monotonic() + 5
    while not svc._calendar.fresh() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert svc._calendar.fresh()
    runner.reset()
    clock.advance(11)  # latest_runs の TTL（10 秒）を過ぎる
    with pytest.raises(Unavailable):
        svc.chain()
    assert runner.names() == ["latest_runs"]


def test_no_runs_is_503():
    svc, runner, _ = service(World(), jst(2026, 10, 13, 21, 31))
    with pytest.raises(Unavailable):
        svc.chain()
    # 板・先物・現物は読まない（カレンダーは latest_runs と同時に読み始めるので 0〜1 回。#95）
    assert [n for n in runner.names() if n != "trading_calendar"] == ["latest_runs"]
    assert runner.count("trading_calendar") <= 1


def test_no_candidates_is_503():
    at = jst(2026, 10, 13, 16, 50)
    w = World().add(at, synth_board(at, quoted=0)[:42], None, rows_option=42)
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    with pytest.raises(Unavailable):
        svc.chain()
    assert runner.count("option_price") == 0


def test_future_reads_are_capped():
    # 先物 NULL が続くときの安全弁: 先物を読むのは 1 リクエスト MAX_FUTURE_READS 回まで
    at = jst(2026, 10, 13, 21, 31)
    w = World()
    for back in range(30, -1, -1):
        t = at - timedelta(minutes=back)
        w.add(t, synth_board(t), {"price": None, "price_time": None, "contract_month": date(2026, 12, 1)})
    svc, runner, _ = service(w, at + timedelta(minutes=15))
    with pytest.raises(Unavailable):
        svc.chain()
    assert runner.count("future_price") == usable.st.MAX_FUTURE_READS
    assert runner.count("option_price") == 0


def test_latest_runs_window_is_14_days():
    at = jst(2026, 10, 13, 21, 31)
    now = at + timedelta(minutes=15)
    w = World().add(at, synth_board(at), 30000.0)
    svc, runner, _ = service(w, now)
    svc.chain()
    # カレンダーは latest_runs と同時に読むので、順序ではなく名前で探す（#95）
    runs = [p for n, p in runner.calls if n == "latest_runs"]
    assert runs == [{"start_at": now - timedelta(days=14), "end_at": now + timedelta(seconds=1)}]
    # 板・先物・現物は 1 秒の窓
    for n, p in runner.calls:
        if n not in ("latest_runs", "trading_calendar"):
            assert p == {"start_at": at, "end_at": at + timedelta(seconds=1)}

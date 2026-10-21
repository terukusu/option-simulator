"""費用の 1 日上限の純関数と MemoryStore（#134 AC2。docs/ai-advisor.md 論点 3）。"""

from datetime import UTC, datetime

import pytest
from support import jst

from simulator_api import settings as st
from simulator_api.ai import budget

M = "claude-opus-5-5"


def test_price_table_matches_official():
    # 公式の料金表（AI_PRICE_CHECKED に確認）: 入力 $4・5 分の書き込み $5・1 時間 $8・読み取り $0.20・出力 $20 / MTok
    assert st.AI_PRICES[M] == {"input": 4_000_000, "cache_write_5m": 5_000_000, "cache_write_1h": 8_000_000,
                               "cache_read": 200_000, "output": 20_000_000}
    assert st.AI_PRICES[M]["cache_read"] * 20 == st.AI_PRICES[M]["input"]  # 読み取りは入力の 0.05 倍
    assert st.AI_PRICE_CHECKED == "2026-10-19"


OH = st.AI_INPUT_OVERHEAD_TOKENS


@pytest.mark.parametrize("text,tokens", [("", OH), ("a", OH + 1), ("abcde", OH + 5), ("あ", OH + 3), ("abあ", OH + 5),
                                         ('{"ask":123.5,"bid":122}', OH + 23)])
def test_estimate_input_tokens(text, tokens):
    # UTF-8 のバイト数（トークン 1 つは 1 バイト以上 = 上界）+ 見えない分の余裕
    assert budget.estimate_input_tokens(text) == tokens


def test_estimate_not_below_dense_json():
    # 数字・記号の多い板の JSON でも、1 字 1 トークン（ASCII の上界）を下回らない
    text = ",".join(f'{{"k":{30000 + 125 * i},"type":"C","bid":{i}.5,"ask":{i + 1},"iv":19.25}}' for i in range(200))
    assert budget.estimate_input_tokens(text) >= len(text)


def test_reserve():
    # 1 turn: 入力 10,000 × $8/M（書き込みの単価は 5 分 $5 と 1 時間 $8 の大きい方。#221）+ 8,000 × $20/M
    # = 0.08 + 0.16 = $0.24
    assert budget.reserve_micro_usd(M, 10_000, 8000) == 240_000
    assert budget.reserve_micro_usd(M, 1, 0) == 8  # 切り上げ（8 µUSD ちょうど）
    assert budget.reserve_micro_usd(M, 0, 1) == 20


def test_reserve_covers_turns_and_skills():
    # #221: T = 3 turn、E = 25,000、M = 8,000、K = 5,000 の手計算
    #   turn 0: 入力 25,000、turn 1: 25,000 + 13,000 = 38,000、turn 2: 51,000 → 入力の和 114,000 × $8/M = $0.912
    #   出力 3 × 8,000 × $20/M = $0.48 → $1.392
    assert budget.reserve_micro_usd(M, 25_000, 8000, 3, 5_000) == 1_392_000
    assert budget.reserve_micro_usd(M, 25_000, 8000, 1, 5_000) == budget.reserve_micro_usd(M, 25_000, 8000)
    # 各 turn で入力を全部 1 時間の書き込み・出力を max_tokens まで・毎回スキルを読んだ最悪の実額を下回らない
    est, k, mt = 12_345, budget.skill_tokens(), 8000
    worst = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0,
             "cache_creation": {"ephemeral_1h_input_tokens": 0}}
    for i in range(st.AI_MAX_TURNS):
        n = est + i * (mt + k)
        worst["cache_creation_input_tokens"] += n
        worst["cache_creation"]["ephemeral_1h_input_tokens"] += n
        worst["output_tokens"] += mt
    assert budget.reserve_micro_usd(M, est, mt, st.AI_MAX_TURNS, k) >= budget.cost_micro_usd(M, worst)
    # スキルの上界は SKILL.md の合計のバイト数 + 余裕
    from simulator_api.ai import skills

    assert budget.skill_tokens() == skills.total_bytes() + st.AI_SKILL_OVERHEAD_TOKENS


def test_cost():
    usage = {"input_tokens": 1000, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 10_000,
             "output_tokens": 500}
    # 1000×4 + 2000×5 + 10000×0.2 + 500×20 = 4000 + 10000 + 2000 + 10000 = 26,000 µUSD
    assert budget.cost_micro_usd(M, usage) == 26_000
    # 1 時間の書き込みの内訳があればその分は $8
    usage["cache_creation"] = {"ephemeral_5m_input_tokens": 1500, "ephemeral_1h_input_tokens": 500}
    assert budget.cost_micro_usd(M, usage) == 26_000 + 500 * 3
    # 欠けた値・負・真偽値は 0
    assert budget.cost_micro_usd(M, {"input_tokens": None, "output_tokens": -5, "cache_read_input_tokens": True}) == 0
    assert budget.cost_micro_usd(M, {"cache_read_input_tokens": 1}) == 1  # 0.2 µUSD の切り上げ


def test_reserve_covers_worst_cost():
    # 予約 ≥ 見積もりどおりの入力を全部書き込み（5 分 / 1 時間）・出力を max_tokens まで使ったときの実額
    est = 12_345
    worst = {"input_tokens": 0, "cache_creation_input_tokens": est, "output_tokens": 8000}
    assert budget.reserve_micro_usd(M, est, 8000) >= budget.cost_micro_usd(M, worst)
    worst["cache_creation"] = {"ephemeral_1h_input_tokens": est}
    assert budget.reserve_micro_usd(M, est, 8000) >= budget.cost_micro_usd(M, worst)


def test_jst_day_boundary():
    assert budget.jst_day(jst(2026, 10, 19, 23, 59, 59)) == "2026-10-19"
    assert budget.jst_day(jst(2026, 10, 20, 0, 0, 0)) == "2026-10-20"
    assert budget.jst_day(datetime(2026, 10, 19, 14, 59, 59, tzinfo=UTC)) == "2026-10-19"
    assert budget.jst_day(datetime(2026, 10, 19, 15, 0, 0, tzinfo=UTC)) == "2026-10-20"
    assert budget.resets_at(jst(2026, 10, 19, 23, 59, 59)) == "2026-10-20T00:00:00+09:00"
    assert budget.resets_at(jst(2026, 10, 20, 0, 0, 0)) == "2026-10-21T00:00:00+09:00"


def test_memory_store_reserve_and_adjust():
    s = budget.MemoryStore({"d": 100})
    assert s.reserve("d", 50, 150) == (True, 150)  # ちょうど上限は通す
    assert s.reserve("d", 1, 150) == (False, 150)
    assert s.adjust("d", -30) == 120
    assert s.read("d") == 120 and s.read("other") == 0
    assert s.requests == {"d": 1}
    s.fail = True
    with pytest.raises(budget.StoreUnavailable):
        s.read("d")

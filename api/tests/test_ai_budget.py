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


OH = st.AI_INPUT_OVERHEAD_TOKENS + st.AI_CLI_OVERHEAD_TOKENS  # 見えない分 + CLI が足す分（#221）


@pytest.mark.parametrize("text,tokens", [("", OH), ("a", OH + 1), ("abcde", OH + 5), ("あ", OH + 3), ("abあ", OH + 5),
                                         ('{"ask":123.5,"bid":122}', OH + 23)])
def test_estimate_input_tokens(text, tokens):
    # UTF-8 のバイト数（トークン 1 つは 1 バイト以上 = 上界）+ 見えない分の余裕 + CLI が足す分
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
    # #221: T = 3 turn、E = 25,000、M = 8,000、K = 5,000（g = 13,000）の手計算
    #   書き込み: turn 0 の E 25,000 + turn 1・2 の増えた分 13,000 × 2 = 51,000 × $8/M = $0.408
    #   読み出し: turn 1 は turn 0 の要求 25,000、turn 2 は turn 1 の要求 38,000 → 63,000 × $0.2/M = $0.0126
    #   出力: 3 × 8,000 × $20/M = $0.48 → $0.9006
    assert budget.reserve_micro_usd(M, 25_000, 8000, 3, 5_000) == 900_600
    assert budget.reserve_micro_usd(M, 25_000, 8000, 1, 5_000) == budget.reserve_micro_usd(M, 25_000, 8000)
    from simulator_api.ai import skills

    # #137: 文書の read_doc の 1 要求の上限と枠も足す
    assert budget.loaded_tokens() == (skills.total_bytes() + st.AI_SKILL_OVERHEAD_TOKENS
                                      + st.AI_DOC_REQUEST_MAX_BYTES + st.AI_DOC_OVERHEAD_TOKENS)


def worst_usage(est: int, mt: int, k: int, turns: int, read_hit: bool = True) -> dict:
    """turn i の入力 = 前の turn の要求（読み出し。read_hit=False なら書き込み）+ 増えた分の書き込み（1 時間の単価）、
    出力は max_tokens まで、毎回スキルを全部読む = 前提の下で最も高い使い方"""
    u = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
         "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}
    prev = 0
    for i in range(turns):
        prompt = est + i * (mt + k)
        read = prev if read_hit else 0
        u["cache_read_input_tokens"] += read
        u["cache_creation_input_tokens"] += prompt - read
        u["cache_creation"]["ephemeral_1h_input_tokens"] += prompt - read
        u["output_tokens"] += mt
        prev = prompt
    return u


@pytest.mark.parametrize("est", [1, 12_345, 31_447, 92_500, 300_000])
@pytest.mark.parametrize("turns", [1, 2, 3])
def test_reserve_is_upper_bound_when_previous_turn_is_cached(est, turns):
    # 前の turn の要求が読み出しになる（CLI の要求の形 = tests/test_ai_agent_sdk_cli.py で固定）限り、実額 ≤ 予約。
    # 使った turn が上限より少ない・出力が少ない・読み出しが多い（前の要求より前のキャッシュ）は安い側
    k, mt = budget.loaded_tokens(), st.AI_MAX_TOKENS
    reserve = budget.reserve_micro_usd(M, est, mt, st.AI_MAX_TURNS, k)
    assert budget.cost_micro_usd(M, worst_usage(est, mt, k, turns)) <= reserve
    if turns == st.AI_MAX_TURNS:  # 最悪の組み合わせでちょうど（切り上げの 1 µUSD まで）
        assert reserve - budget.cost_micro_usd(M, worst_usage(est, mt, k, turns)) <= 1


def test_reserve_cache_miss_is_the_documented_exception():
    # 前の turn の要求がキャッシュから読めない（追い出し）と予約を越えうる（精算で 1 要求ぶん。次の要求は 429）。
    # 越える分は前の要求 × (書き込み − 読み出し) の和以下
    est, k, mt, t = 31_447, budget.loaded_tokens(), st.AI_MAX_TOKENS, st.AI_MAX_TURNS
    reserve = budget.reserve_micro_usd(M, est, mt, t, k)
    miss = budget.cost_micro_usd(M, worst_usage(est, mt, k, t, read_hit=False))
    assert miss > reserve
    prev_total = sum(est + i * (mt + k) for i in range(t - 1))
    assert miss - reserve <= -(-prev_total * (8_000_000 - 200_000) // 1_000_000) + 1


def test_reserve_long_conversation_not_rejected_at_day_start():
    # api_key / wif で本文 90k トークン（ツールの往復が数回ある長い会話）でも日の始めに上限 $3 に収まる
    # （#137 で文書の 1 要求の上限を K に足して 約 $1.51 → 約 $1.84。ADR-0007）
    est = budget.estimate_input_tokens("x" * 90_000)
    assert budget.reserve_micro_usd(M, est, st.AI_MAX_TOKENS, st.AI_MAX_TURNS, budget.loaded_tokens()) < 2_000_000


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
    # 1 turn: 予約 ≥ 見積もりどおりの入力を全部書き込み（5 分 / 1 時間）・出力を max_tokens まで使ったときの実額
    est = 12_345
    worst = {"input_tokens": 0, "cache_creation_input_tokens": est, "output_tokens": 8000}
    assert budget.reserve_micro_usd(M, est, 8000) >= budget.cost_micro_usd(M, worst)
    worst["cache_creation"] = {"ephemeral_1h_input_tokens": est}
    assert budget.reserve_micro_usd(M, est, 8000) >= budget.cost_micro_usd(M, worst)


def test_estimate_includes_cli_overhead():
    assert budget.estimate_input_tokens("") == st.AI_INPUT_OVERHEAD_TOKENS + st.AI_CLI_OVERHEAD_TOKENS


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

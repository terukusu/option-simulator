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
    # #221: T = 3 turn、E = 25,000、M = 8,000、S = 5,000（D = 0。g = M + S = 13,000）の手計算
    #   書き込み: turn 0 の E 25,000 + turn 1・2 の増えた分 13,000 × 2 = 51,000 × $8/M = $0.408
    #   読み出し: turn 1 は turn 0 の要求 25,000、turn 2 は turn 1 の要求 38,000 → 63,000 × $0.2/M = $0.0126
    #   出力: 3 × 8,000 × $20/M = $0.48 → $0.9006
    assert budget.reserve_micro_usd(M, 25_000, 8000, 3, 5_000) == 900_600
    assert budget.reserve_micro_usd(M, 25_000, 8000, 1, 5_000) == budget.reserve_micro_usd(M, 25_000, 8000)
    from simulator_api.ai import skills

    # #338: スキルの分 S は turn ごと、文書の read_doc の分 D（1 要求の上限と枠。#137）は 1 要求に 1 回
    assert budget.skill_tokens() == skills.total_bytes() + st.AI_SKILL_OVERHEAD_TOKENS
    assert budget.doc_tokens() == st.AI_DOC_REQUEST_MAX_BYTES + st.AI_DOC_OVERHEAD_TOKENS == 19_384


def test_reserve_counts_docs_once_per_request():
    # #338: E = 25,000、M = 8,000、S = 5,000、D = 4,000、T = 3 の手計算（最悪は turn 0 の結果で文書を全部読む並び）
    #   書き込み: E 25,000 + (M + S) × 2 = 26,000 + D 4,000 = 55,000 × $8/M = $0.44
    #   読み出し: turn 1 は turn 0 の要求 25,000、turn 2 は turn 1 の要求 25,000 + 13,000 + 4,000 = 42,000
    #     → 67,000 × $0.2/M = $0.0134
    #   出力: 3 × 8,000 × $20/M = $0.48 → $0.9334
    assert budget.reserve_micro_usd(M, 25_000, 8000, 3, 5_000, 4_000) == 933_400
    # T = 1（画像の読み取り read_positions = (model, E, M, 1, 0)）は S・D によらず 1 turn の式のまま
    for e in (1, 12_345, 31_000, 96_000):
        assert budget.reserve_micro_usd(M, e, 6000, 1, 0) == -(-(e * 8_000_000 + 6000 * 20_000_000) // 1_000_000)
        assert budget.reserve_micro_usd(M, e, 8000, 1, 5_000, 4_000) == budget.reserve_micro_usd(M, e, 8000)
    # T = 1・2 は旧式（S + D を turn ごとに足す）と同じ値。T = 3 だけ D の 2 回目の分が下がる
    for e in (1, 12_345, 31_000, 96_000):
        for t in (1, 2):
            assert (budget.reserve_micro_usd(M, e, 8000, t, 5_000, 4_000)
                    == budget.reserve_micro_usd(M, e, 8000, t, 9_000))
        assert (budget.reserve_micro_usd(M, e, 8000, 3, 9_000) - budget.reserve_micro_usd(M, e, 8000, 3, 5_000, 4_000)
                == -(-4_000 * 8_000_000 // 1_000_000))  # D の書き込み 1 回ぶん（読み出しは同じ）


def test_reserve_fixed_value_for_current_skills():
    # 今の SKILL.md の合計で本文 90k の予約（式の固定値。docs/design.md 13.4・api/README.md の目安 約 $1.84）。
    # 期待値は SKILL.md の合計に合わせて 16.2 µUSD / B で自動で追従する（固定するのは合計 15,283 B のときの値と傾き）。
    # SKILL.md を直しても手で直す必要はないが、文書の目安は計算し直す
    from simulator_api.ai import skills

    est = budget.estimate_input_tokens("x" * 90_000)
    reserve = budget.reserve_micro_usd(M, est, st.AI_MAX_TOKENS, st.AI_MAX_TURNS, budget.skill_tokens(),
                                       budget.doc_tokens())
    expected = 1_838_734 + round((skills.total_bytes() - 15_283) * 16.2)
    assert abs(reserve - expected) <= 1


def worst_usage(est: int, mt: int, s: int, d: int, turns: int, doc_turn: int | None = None,
                read_hit: bool = True) -> dict:
    """turn i の入力 = 前の turn の要求（読み出し。read_hit=False なら書き込み）+ 増えた分の書き込み（1 時間の単価）。
    増えた分 = 前の出力（max_tokens まで）+ スキル S（毎回全部読む）+ 文書 D（1 要求の合計。doc_turn の turn の結果に
    全部入れる。None は読まない）= 前提の下で最も高い使い方（実額は文書の置き方に線形なので 1 つの turn が端点）"""
    u = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
         "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0}}
    prev = 0
    for i in range(turns):
        prompt = est + i * (mt + s) + (d if doc_turn is not None and doc_turn < i else 0)
        read = prev if read_hit else 0
        u["cache_read_input_tokens"] += read
        u["cache_creation_input_tokens"] += prompt - read
        u["cache_creation"]["ephemeral_1h_input_tokens"] += prompt - read
        u["output_tokens"] += mt
        prev = prompt
    return u


@pytest.mark.parametrize("est", [1, 12_345, 31_447, 92_500, 300_000])
@pytest.mark.parametrize("turns,doc_turn", [(t, j) for t in (1, 2, 3) for j in (None, *range(t - 1))])
def test_reserve_is_upper_bound_when_previous_turn_is_cached(est, turns, doc_turn):
    # 前の turn の要求が読み出しになる（CLI の要求の形 = tests/test_ai_agent_sdk_cli.py で固定）限り、実額 ≤ 予約。
    # 使った turn が上限より少ない・出力が少ない・読み出しが多い（前の要求より前のキャッシュ）・文書を後の turn で
    # 読む・分けて読むは安い側
    s, d, mt = budget.skill_tokens(), budget.doc_tokens(), st.AI_MAX_TOKENS
    reserve = budget.reserve_micro_usd(M, est, mt, st.AI_MAX_TURNS, s, d)
    cost = budget.cost_micro_usd(M, worst_usage(est, mt, s, d, turns, doc_turn))
    assert cost <= reserve
    if turns == st.AI_MAX_TURNS and doc_turn == 0:  # 最悪の並び（文書は turn 0 の結果）でちょうど（切り上げの 1 µUSD）
        assert reserve - cost <= 1


def test_reserve_cache_miss_is_the_documented_exception():
    # 前の turn の要求がキャッシュから読めない（追い出し）と予約を越えうる（精算で 1 要求ぶん。次の要求は 429）。
    # 越える分は前の要求 × (書き込み − 読み出し) の和以下
    est, s, d, mt, t = 31_447, budget.skill_tokens(), budget.doc_tokens(), st.AI_MAX_TOKENS, st.AI_MAX_TURNS
    reserve = budget.reserve_micro_usd(M, est, mt, t, s, d)
    miss = budget.cost_micro_usd(M, worst_usage(est, mt, s, d, t, 0, read_hit=False))
    assert miss > reserve
    prev_total = sum(est + i * (mt + s) + (d if i > 0 else 0) for i in range(t - 1))
    assert miss - reserve <= -(-prev_total * (8_000_000 - 200_000) // 1_000_000) + 1


def test_reserve_long_conversation_not_rejected_at_day_start():
    # api_key / wif で本文 90k トークン（ツールの往復が数回ある長い会話）でも、日の始めの 1 要求の予約が日の上限 $3 の
    # 2/3 未満（閾値の根拠は ADR-0007 の追補 #338）。スキルは実際の合計ではなく上限 AI_SKILL_MAX_BYTES ちょうどで
    # 計算する（上限の内側ならスキルを足してもこのテストは落ちない。24 KiB ちょうどで 約 $1.99）
    assert st.AI_SKILL_MAX_BYTES >= 24 * 1024
    est = budget.estimate_input_tokens("x" * 90_000)
    s = st.AI_SKILL_MAX_BYTES + st.AI_SKILL_OVERHEAD_TOKENS
    assert budget.reserve_micro_usd(M, est, st.AI_MAX_TOKENS, st.AI_MAX_TURNS, s, budget.doc_tokens()) < 2_000_000


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

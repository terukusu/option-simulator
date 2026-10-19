"""AI の中継の許可リスト（#134 AC1。docs/ai-advisor.md 論点 1・6）。正常形 1 本から 1 か所ずつ壊す表駆動。

登録（道具）は引数にして使う: テスト専用の 2 本（support.ai_registry）と、本物の REGISTRY（#134 は空。#135 で入る）。
"""

import copy
import json

import pytest
from support import ai_body, ai_context, ai_registry, ai_tool_roundtrip

from simulator_api.ai import allowlist
from simulator_api.ai.shape import Bad
from simulator_api.ai.tools import REGISTRY

REG = ai_registry()


def parse(body, registry=REG):
    return allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode("utf-8"), registry)


def bad(body, registry=REG) -> Bad:
    with pytest.raises(Bad) as e:
        parse(body, registry)
    return e.value


def test_ok_chat_with_board_and_position():
    req = parse(ai_body())
    assert req.kind == "chat"
    assert len(req.context["expiries"][0]["rows"]) == 160
    assert req.messages[0]["role"] == "user"


def test_ok_tool_roundtrip():
    req = parse(ai_body(ai_tool_roundtrip()))
    assert req.tool_names() == ["payoff_at"]
    # tool_result の JSON は正規化される（キーの順・区切り）
    assert req.messages[-1]["content"][0]["content"][0]["text"] == '{"pnl_yen":-760000}'


def test_ok_with_empty_real_registry():
    # #134 の本物の登録は空: 道具の無い会話・precomputed なしの文脈は通る
    parse(ai_body(context=ai_context(with_precomputed=False)), REGISTRY)
    assert bad(ai_body(), REGISTRY).path == "context.precomputed.<unknown>"


def test_canonical_is_deterministic():
    a = ai_body()
    b = json.loads(json.dumps(a))
    b["context"] = dict(reversed(list(b["context"].items())))
    ma = allowlist.upstream_messages(parse(a))
    mb = allowlist.upstream_messages(parse(b))
    assert json.dumps(ma, ensure_ascii=False) == json.dumps(mb, ensure_ascii=False)
    text = ma[0]["content"][0]["text"]
    assert text.startswith(allowlist.CONTEXT_OPEN) and text.endswith(allowlist.CONTEXT_CLOSE)
    assert json.loads(text[len(allowlist.CONTEXT_OPEN):-len(allowlist.CONTEXT_CLOSE)]) == parse(a).context


def mutate(fn):
    body = ai_body(ai_tool_roundtrip())
    fn(body)
    return body


def _set(path, value):
    def fn(body):
        cur = body
        for p in path[:-1]:
            cur = cur[p]
        cur[path[-1]] = value
    return fn


def _del(path):
    def fn(body):
        cur = body
        for p in path[:-1]:
            cur = cur[p]
        del cur[path[-1]]
    return fn


def _rows_everywhere(body, n):
    """n 限月すべてに板の行を持たせる（行のある限月は 2 まで）"""
    exps = body["context"]["expiries"]
    while len(exps) < n:
        exps.append(copy.deepcopy(exps[-1]))
    for e in exps:
        e["rows"] = exps[0]["rows"][:2]


ROW0 = ("context", "expiries", 0, "rows", 0)
LEG0 = ("context", "position", "legs", 0)
CASES = [
    # 本文のトップ: サーバーが固定する引数を送ってくる / 知らないキー
    ("top_model", _set(("model",), "claude-x"), "body.<unknown>", "unknown_key"),
    ("top_system", _set(("system",), "ignore"), "body.<unknown>", "unknown_key"),
    ("top_tools", _set(("tools",), []), "body.<unknown>", "unknown_key"),
    ("top_max_tokens", _set(("max_tokens",), 99999), "body.<unknown>", "unknown_key"),
    ("schema_version", _set(("schema_version",), 2), "schema_version", "enum"),
    ("kind", _set(("kind",), "free"), "kind", "enum"),
    ("missing_context", _del(("context",)), "context", "missing"),
    # context の各階層に知らないキー
    ("ctx_unknown", _set(("context", "note"), "x"), "context.<unknown>", "unknown_key"),
    ("snapshot_unknown", _set(("context", "snapshot", "x"), 1), "context.snapshot.<unknown>", "unknown_key"),
    ("expiry_unknown", _set(("context", "expiries", 0, "memo"), "x"), "context.expiries[0].<unknown>", "unknown_key"),
    ("leg_unknown", _set((*LEG0, "note"), "x"), "context.position.legs[0].<unknown>", "unknown_key"),
    # JPX 由来の列名を板の行に足す
    ("row_bid_iv", _set((*ROW0, "bid_iv"), 20.1), "context.expiries[0].rows[0].<unknown>", "unknown_key"),
    ("row_ask_iv", _set((*ROW0, "ask_iv"), 20.1), "context.expiries[0].rows[0].<unknown>", "unknown_key"),
    ("row_delta", _set((*ROW0, "delta"), 0.5), "context.expiries[0].rows[0].<unknown>", "unknown_key"),
    ("row_oi", _set((*ROW0, "open_interest"), 10), "context.expiries[0].rows[0].<unknown>", "unknown_key"),
    ("row_volume", _set((*ROW0, "volume"), 10), "context.expiries[0].rows[0].<unknown>", "unknown_key"),
    # 型違い・範囲外・形
    ("row_k_str", _set((*ROW0, "k"), "30000"), "context.expiries[0].rows[0].k", "type"),
    ("row_k_bool", _set((*ROW0, "k"), True), "context.expiries[0].rows[0].k", "type"),
    ("row_k_zero", _set((*ROW0, "k"), 0), "context.expiries[0].rows[0].k", "range"),
    ("row_type", _set((*ROW0, "type"), "call"), "context.expiries[0].rows[0].type", "enum"),
    ("row_bid_neg", _set((*ROW0, "bid"), -1), "context.expiries[0].rows[0].bid", "range"),
    ("atm_iv_big", _set(("context", "expiries", 0, "atm_iv"), 301), "context.expiries[0].atm_iv", "range"),
    ("expiry_fmt", _set(("context", "expiries", 0, "expiry"), "2026-13"), "context.expiries[0].expiry", "format"),
    ("sq_date_bad", _set(("context", "expiries", 0, "sq_date"), "2026-02-30"), "context.expiries[0].sq_date",
     "format"),
    ("snapshot_naive", _set(("context", "snapshot", "snapshot_at"), "2026-10-13T21:45:00"),
     "context.snapshot.snapshot_at", "format"),
    ("source_free", _set(("context", "snapshot", "source"), "jpx"), "context.snapshot.source", "enum"),
    ("qty_float", _set((*LEG0, "qty"), 1.5), "context.position.legs[0].qty", "type"),
    ("qty_big", _set((*LEG0, "qty"), 1001), "context.position.legs[0].qty", "range"),
    ("leg_side", _set((*LEG0, "side"), "short"), "context.position.legs[0].side", "enum"),
    ("op_without_k", _del((*LEG0, "k")), "context.position.legs[0]", "shape"),
    ("fut_with_k", _set(("context", "position", "legs", 2, "k"), 30000), "context.position.legs[2]", "shape"),
    ("x_range_len", _set(("context", "scenario", "x_range"), [1, 2, 3]), "context.scenario.x_range", "size"),
    ("precomputed_unknown_tool", _set(("context", "precomputed", "secret_tool"), {}), "context.precomputed.<unknown>",
     "unknown_key"),
    ("precomputed_bad_result", _set(("context", "precomputed", "greeks"), {"delta_large": "x", "vega_yen": 1}),
     "context.precomputed.greeks.delta_large", "type"),
    # 大きさ超過
    ("too_many_rows", lambda b: b["context"]["expiries"][0].__setitem__(
        "rows", b["context"]["expiries"][0]["rows"] * 4), "context.expiries[0].rows", "size"),
    ("rows_in_3_expiries", lambda b: _rows_everywhere(b, 3), "context.expiries[2].rows", "size"),
    ("too_many_expiries", lambda b: b["context"]["expiries"].extend(
        copy.deepcopy(b["context"]["expiries"][1]) for _ in range(5)), "context.expiries", "size"),
    ("user_text_long", _set(("messages", 0, "content", 0, "text"), "あ" * 4001), "messages[0].content[0].text", "size"),
    # 会話: role・block の型・道具
    ("role_system", _set(("messages", 0, "role"), "system"), "messages[0].role", "enum"),
    ("role_order", _set(("messages", 1, "role"), "user"), "messages[1].role", "order"),
    ("ends_with_assistant", lambda b: b["messages"].pop(), "messages", "order"),
    ("message_unknown_key", _set(("messages", 0, "name"), "x"), "messages[0].<unknown>", "unknown_key"),
    ("block_image", _set(("messages", 0, "content", 0), {"type": "image", "source": {}}), "messages[0].content[0].type",
     "enum"),
    ("block_extra_key", _set(("messages", 0, "content", 0, "cache_control"), {"type": "ephemeral"}),
     "messages[0].content[0].<unknown>", "unknown_key"),
    ("unknown_tool", _set(("messages", 3, "content", 1, "name"), "run_shell"), "messages[3].content[1].name",
     "unknown_tool"),
    ("tool_input_extra", _set(("messages", 3, "content", 1, "input", "cmd"), "rm"),
     "messages[3].content[1].input.<unknown>", "unknown_key"),
    ("tool_result_unmatched", _set(("messages", 4, "content", 0, "tool_use_id"), "toolu_other"),
     "messages[4].content[0].tool_use_id", "unmatched"),
    ("tool_result_bad_json", _set(("messages", 4, "content", 0, "content", 0, "text"), "{nope"),
     "messages[4].content[0].content[0].text", "json"),
    ("tool_result_bad_shape", _set(("messages", 4, "content", 0, "content", 0, "text"), '{"pnl_yen":"x"}'),
     "messages[4].content[0].content[0].text.pnl_yen", "type"),
    ("tool_result_missing", _set(("messages", 4, "content"), [{"type": "text", "text": "続けて"}]),
     "messages[4].content", "missing_tool_result"),
]


@pytest.mark.parametrize("name,fn,path,reason", CASES, ids=[c[0] for c in CASES])
def test_rejected(name, fn, path, reason):
    e = bad(mutate(fn))
    assert (e.path, e.reason) == (path, reason)


def test_unknown_key_name_not_in_path():
    # 利用者が入れたキー名を道筋に出さない（反射しない）
    body = ai_body()
    body["context"]["INJECTED_KEY_zzz"] = 1
    e = bad(body)
    assert "INJECTED" not in e.path and "INJECTED" not in str(e)


@pytest.mark.parametrize("raw", [b"{", b"[]", b'{"schema_version": NaN}', b'{"a":1,"a":2}', b"\xff\xfe"])
def test_body_not_json_object(raw):
    with pytest.raises(Bad):
        allowlist.parse_request(raw, REG)


def test_free_text_total_limit():
    msgs = []
    for _ in range(30):
        msgs.append({"role": "user", "content": [{"type": "text", "text": "あ" * 4000}]})
        msgs.append({"role": "assistant", "content": [{"type": "text", "text": "い"}]})
    msgs.pop()
    e = bad(ai_body(msgs))
    assert e.reason == "size" and e.path.startswith("messages[")


def test_too_many_messages():
    msgs = []
    for _ in range(31):
        msgs += [{"role": "user", "content": [{"type": "text", "text": "q"}]},
                 {"role": "assistant", "content": [{"type": "text", "text": "a"}]}]
    msgs.append({"role": "user", "content": [{"type": "text", "text": "q"}]})
    assert bad(ai_body(msgs)).path == "messages"


def test_thinking_signature_kept_and_redacted_ok():
    msgs = ai_tool_roundtrip()
    msgs[1]["content"].insert(0, {"type": "redacted_thinking", "data": "cmVkYWN0ZWQ="})
    req = parse(ai_body(msgs))
    assert req.messages[1]["content"][0] == {"type": "redacted_thinking", "data": "cmVkYWN0ZWQ="}
    assert req.messages[3]["content"][0]["signature"] == "c2lnbmF0dXJl"
    msgs[3]["content"][0]["signature"] = "not base64 <script>"
    assert bad(ai_body(msgs)).path == "messages[3].content[0].signature"


def test_tool_result_is_error():
    msgs = ai_tool_roundtrip()
    msgs[4]["content"][0]["is_error"] = True
    msgs[4]["content"][0]["content"][0]["text"] = '{"error":"out_of_range"}'
    req = parse(ai_body(msgs))
    assert req.messages[4]["content"][0]["is_error"] is True
    msgs[4]["content"][0]["content"][0]["text"] = '{"error":"自由文"}'
    assert bad(ai_body(msgs)).reason == "format"

"""道具の登録（#135 AC3）。ブラウザの実装（ui/view/aiTools.ts）が生成した見本 fixtures/synthetic/ai_tools.json を、
中継の形（tools.py の result_shape・allowlist.py の context_shape）に通す = 言語をまたぐ契約。値はすべて架空。"""

import copy
import json
from pathlib import Path

import pytest
from support import ai_body

from simulator_api.ai import allowlist
from simulator_api.ai.shape import Bad, Obj
from simulator_api.ai.tools import REGISTRY, definitions

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "synthetic" / "ai_tools.json"
SAMPLE = json.loads(FIXTURE.read_text(encoding="utf-8"))
PRECOMPUTED = ["margin_summary", "position_summary", "scenario_grid", "smile_position", "tail_table"]


def test_names_match_browser():
    assert SAMPLE["tools"] == sorted(REGISTRY)
    assert sorted(REGISTRY) == sorted([*PRECOMPUTED, "evaluate_scenario", "technicals"])


def test_definitions_sorted_and_deterministic():
    a = definitions(REGISTRY)
    assert [t["name"] for t in a] == sorted(REGISTRY)
    assert allowlist.canonical(a) == allowlist.canonical(definitions(dict(reversed(list(REGISTRY.items())))))
    for t in a:
        assert set(t) == {"name", "description", "input_schema"}
        assert t["description"]


def test_input_schema_matches_input_shape():
    for spec in REGISTRY.values():
        schema = spec.input_schema
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert isinstance(spec.input_shape, Obj)
        assert set(schema["properties"]) == set(spec.input_shape.fields)
        required = set(schema.get("required", []))
        assert required == set(spec.input_shape.fields) - set(spec.input_shape.optional)


@pytest.mark.parametrize("case", SAMPLE["cases"], ids=[c["name"] for c in SAMPLE["cases"]])
def test_sample_context_and_results_pass_shapes(case):
    # 文脈（事前計算 5 本を含む）が許可リストの形を通る
    ctx = allowlist._check_context(case["context"], REGISTRY)
    assert sorted(ctx["precomputed"]) == PRECOMPUTED
    for name, result in case["context"]["precomputed"].items():
        REGISTRY[name].result_shape.check(result, name)
    # evaluate_scenario の入力と結果
    spec = REGISTRY["evaluate_scenario"]
    for e in case["evaluate"]:
        spec.input_shape.check(e["input"], "input")
        spec.result_shape.check(e["result"], "result")
    for e in case["errors"]:
        allowlist.TOOL_ERROR.check(e["result"], "result")
    # 要求の本文として 1 往復（tool_use → tool_result）が通る
    msgs = [
        {"role": "user", "content": [{"type": "text", "text": "下げたら？"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "evaluate_scenario",
                                           "input": case["evaluate"][0]["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": [
            {"type": "text", "text": json.dumps(case["evaluate"][0]["result"], ensure_ascii=False)}]}]},
    ]
    body = ai_body(msgs, context=case["context"], kind="diagnose")
    req = allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode(), REGISTRY)
    assert req.tool_names() == ["evaluate_scenario"]


def _bad_input(inp):
    with pytest.raises(Bad) as e:
        REGISTRY["evaluate_scenario"].input_shape.check(inp, "input")
    return (e.value.path, e.value.reason)


def test_evaluate_input_unknown_key_and_range():
    ok = {"dx_pct": -6, "days": 3, "iv_shift_pt": 5}
    REGISTRY["evaluate_scenario"].input_shape.check(ok, "input")
    assert _bad_input({**ok, "cmd": "x"}) == ("input.<unknown>", "unknown_key")
    assert _bad_input({**ok, "days": 401}) == ("input.days", "range")
    assert _bad_input({**ok, "iv_shift_pt": 41}) == ("input.iv_shift_pt", "range")
    assert _bad_input({**ok, "dx_pct": -61}) == ("input.dx_pct", "range")
    assert _bad_input({"dx_pct": 1, "iv_shift_pt": 0}) == ("input.days", "missing")
    # 入力なしの道具に引数
    with pytest.raises(Bad):
        REGISTRY["tail_table"].input_shape.check({"x": 1}, "input")


def test_result_unknown_key_rejected():
    case = SAMPLE["cases"][0]
    bad = copy.deepcopy(case["context"]["precomputed"]["tail_table"])
    bad["rows"][0]["bid_iv"] = 20.0
    with pytest.raises(Bad) as e:
        REGISTRY["tail_table"].result_shape.check(bad, "r")
    assert e.value.reason == "unknown_key"
    bad2 = copy.deepcopy(case["context"]["precomputed"]["position_summary"])
    bad2["legs"][0]["side"] = "short"
    with pytest.raises(Bad):
        REGISTRY["position_summary"].result_shape.check(bad2, "r")


def test_sample_body_size_within_limits():
    # 事前計算つきの文脈で診断の最初の要求が本文の上限（512 KiB）より十分小さい
    from simulator_api import settings as st

    for case in SAMPLE["cases"]:
        body = ai_body(context=case["context"], kind="diagnose")
        assert len(json.dumps(body, ensure_ascii=False).encode()) < st.AI_MAX_BODY_BYTES / 8


def test_technicals_sample_passes_shapes():
    """#200: technicals の見本（合成の先物の足）の入力・結果・失敗が tools.py の形を通り、1 往復の要求の本文になる"""
    spec = REGISTRY["technicals"]
    tech = SAMPLE["technicals"]
    assert len(tech["results"]) >= 3
    for e in tech["results"]:
        spec.input_shape.check(e["input"], "input")
        r = spec.result_shape.check(e["result"], "result")
        for f in r["frames"]:
            for b in f["base_rates"].values():
                assert b["insufficient"] == (b["n"] < 20)
            # 1 足あたりの大きさ（JSON の字数。1.5k トークン ≈ 3,750 字の目安より十分小さい）
            assert len(allowlist.canonical(f)) < 3750
    codes = [e["result"]["error"] for e in tech["errors"]]
    assert codes == ["bad_input", "out_of_range", "no_data"]
    for e in tech["errors"]:
        allowlist.TOOL_ERROR.check(e["result"], "result")
    first = tech["results"][0]
    msgs = [
        {"role": "user", "content": [{"type": "text", "text": "日足の RSI は？"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_t", "name": "technicals",
                                           "input": first["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_t", "content": [
            {"type": "text", "text": json.dumps(first["result"], ensure_ascii=False)}]}]},
    ]
    body = ai_body(msgs, context=SAMPLE["cases"][0]["context"])
    req = allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode(), REGISTRY)
    assert req.tool_names() == ["technicals"]


def test_technicals_input_rejects():
    spec = REGISTRY["technicals"].input_shape
    spec.check({}, "input")
    spec.check({"timeframes": ["weekly", "4h"], "indicators": ["stoch"], "horizon_bars": 20}, "input")
    for bad, reason in [({"timeframes": ["1m"]}, "enum"), ({"timeframes": []}, "size"),
                        ({"indicators": ["rsi", "macd", "stoch", "rsi"]}, "size"), ({"horizon_bars": 21}, "range"),
                        ({"horizon_bars": 2.5}, "type"), ({"cmd": "x"}, "unknown_key")]:
        with pytest.raises(Bad) as e:
            spec.check(bad, "input")
        assert e.value.reason == reason


def test_technicals_result_rejects_raw_bars():
    """生の足の列（o・h・l・c）や知らないキーは結果の形を通らない"""
    r = copy.deepcopy(SAMPLE["technicals"]["results"][0]["result"])
    r["frames"][0]["bars"] = [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1}]
    with pytest.raises(Bad) as e:
        REGISTRY["technicals"].result_shape.check(r, "r")
    assert e.value.reason == "unknown_key"
    r2 = copy.deepcopy(SAMPLE["technicals"]["results"][0]["result"])
    r2["frames"][0]["rsi"]["recent"] = list(range(21))
    with pytest.raises(Bad):
        REGISTRY["technicals"].result_shape.check(r2, "r")


def test_technicals_params_range_fits_result_shape():
    """#205: 設定の期間の範囲（ブラウザの TECH_PARAM_RANGE。期間 2〜100・スロー / %D 1〜20）の両端が結果の形を通る
    （中継のスキーマは変えない）。101 は通らない"""
    spec = REGISTRY["technicals"].result_shape
    r = copy.deepcopy(SAMPLE["technicals"]["results"][0]["result"])
    for rsi, m, s in [(2, [2, 3, 2], [2, 1, 1]), (100, [99, 100, 100], [100, 20, 20])]:
        r["params"].update({"rsi": rsi, "macd": m, "stoch": s})
        spec.check(r, "r")
    r["params"]["rsi"] = 101
    with pytest.raises(Bad) as e:
        spec.check(r, "r")
    assert e.value.reason == "range"

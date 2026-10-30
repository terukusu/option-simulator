"""ツールの登録（#135 AC3）。ブラウザの実装（ui/view/aiTools.ts）が生成した見本 fixtures/synthetic/ai_tools.json を、
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
    assert sorted(REGISTRY) == sorted([*PRECOMPUTED, "evaluate_scenario", "technicals", "strike_scan",
                                       "structure_candidates", "propose_position", "iv_stats", "strike_quote"])


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
    # 入力なしのツールに引数
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
    spec.check({"indicators": ["ema"]}, "input")
    for bad, reason in [({"timeframes": ["1m"]}, "enum"), ({"timeframes": []}, "size"),
                        ({"indicators": ["rsi", "macd", "stoch", "ema", "rsi"]}, "size"),
                        ({"horizon_bars": 21}, "range"),
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


def test_technicals_ema_shape():
    """#206: EMA の 3 本（params.ema・足ごとの ema・基準率 ema）が形を通る。古い画面（ema を送らない）の結果も通る。
    ウォームアップ中（値・並び順が null）も通る。期間の範囲 2〜100 の両端も通る"""
    spec = REGISTRY["technicals"].result_shape
    full = SAMPLE["technicals"]["results"][0]["result"]
    assert full["params"]["ema"] == [5, 25, 75]
    f0 = full["frames"][0]
    assert [ln["period"] for ln in f0["ema"]["lines"]] == [5, 25, 75]
    assert f0["ema"]["order"] in ("up", "down", "mixed")
    assert f0["base_rates"]["ema"]["condition"] == f"ema_order_{f0['ema']['order']}"
    only = next(e for e in SAMPLE["technicals"]["results"] if e["input"].get("indicators") == ["ema"])
    assert set(only["result"]["frames"][0]) >= {"ema"} and "rsi" not in only["result"]["frames"][0]
    old = copy.deepcopy(full)
    del old["params"]["ema"]
    for f in old["frames"]:
        del f["ema"]
        del f["base_rates"]["ema"]
    spec.check(old, "r")
    warm = copy.deepcopy(full)
    warm["frames"][0]["ema"].update({"order": None, "bars_in_order": 0})
    warm["frames"][0]["ema"]["lines"][2].update({"ema_x": None, "dist_yen": None, "dist_pct": None})
    warm["frames"][0]["ema"]["crosses"][1].update({"shorter_above": None, "bars_since_cross": None})
    del warm["frames"][0]["base_rates"]["ema"]
    spec.check(warm, "r")
    for e in ([2, 3, 4], [98, 99, 100]):
        warm["params"]["ema"] = e
        spec.check(warm, "r")
    bad = copy.deepcopy(full)
    bad["frames"][0]["ema"]["order"] = "perfect"
    with pytest.raises(Bad):
        spec.check(bad, "r")


PROPOSE = SAMPLE["propose"]


def test_propose_samples_pass_shapes():
    """#139: 提案のツール 3 本の見本（合成の板）の入力・結果・失敗が tools.py の形を通る"""
    scan, cand, prop = REGISTRY["strike_scan"], REGISTRY["structure_candidates"], REGISTRY["propose_position"]
    for e in PROPOSE["scan"]:
        scan.input_shape.check(e["input"], "input")
        r = scan.result_shape.check(e["result"], "result")
        assert 1 <= len(r["rows"]) <= 25
    assert PROPOSE["scan"][0]["result"]["best_k"] is not None
    for e in PROPOSE["candidates"]:
        cand.input_shape.check(e["input"], "input")
        cand.result_shape.check(e["result"], "result")
    assert sorted(e["input"]["structure"] for e in PROPOSE["candidates"]) == sorted(
        cand.input_shape.fields["structure"].values)
    for e in PROPOSE["proposals"]:
        prop.input_shape.check(e["input"], "input")
        prop.result_shape.check(e["result"], "result")
    for e in [*PROPOSE["scan_errors"], *PROPOSE["candidate_errors"], *PROPOSE["proposal_errors"]]:
        allowlist.TOOL_ERROR.check(e["result"], "result")


def test_propose_round_trip_request():
    """候補 → 提案の 2 往復が要求の本文として通る（tool_use の入力の検査・tool_result の結果の形）"""
    case = SAMPLE["cases"][0]
    scan = PROPOSE["scan"][0]
    prop = PROPOSE["proposals"][0]
    msgs = [
        {"role": "user", "content": [{"type": "text", "text": "ヘッジを足して"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "strike_scan",
                                           "input": scan["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": [
            {"type": "text", "text": json.dumps(scan["result"], ensure_ascii=False)}]}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_2", "name": "propose_position",
                                           "input": prop["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_2", "content": [
            {"type": "text", "text": json.dumps(prop["result"], ensure_ascii=False)}]}]},
    ]
    body = ai_body(msgs, context=case["context"], kind="chat")
    req = allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode(), REGISTRY)
    assert req.tool_names() == ["strike_scan", "propose_position"]


def _bad(name, inp):
    with pytest.raises(Bad) as e:
        REGISTRY[name].input_shape.check(inp, "input")
    return e.value.reason


def test_propose_input_rejects_free_text_and_ranges():
    """足は構造だけ（自由な文字列・知らないキー・範囲外は 400）"""
    ok = {"target": "current", "changes": [{"action": "add", "type": "P", "expiry": "2026-11", "k": 60000,
                                            "side": "buy"}]}
    REGISTRY["propose_position"].input_shape.check(ok, "input")
    assert _bad("propose_position", {**ok, "note": "買うべき"}) == "unknown_key"
    assert _bad("propose_position", {"target": "current", "changes": [{"action": "add", "memo": "x"}]}) == "unknown_key"
    assert _bad("propose_position", {"target": "elsewhere"}) == "enum"
    assert _bad("propose_position", {"target": "current", "changes": [{"action": "remove", "leg_no": 21}]}) == "range"
    assert _bad("propose_position", {"target": "current", "changes": []}) == "size"
    assert _bad("strike_scan", {"type": "P", "side": "buy", "max_loss_floor_yen": 1}) == "range"
    assert _bad("structure_candidates", {"structure": "butterfly"}) == "enum"


def test_position_summary_without_leg_no_still_passes():
    """#139 レビュー M3: デプロイの前に開いた画面（leg_no の無い position_summary）でも 400 にしない"""
    old = copy.deepcopy(SAMPLE["cases"][0]["context"]["precomputed"]["position_summary"])
    for leg in old["legs"]:
        leg.pop("leg_no")
    REGISTRY["position_summary"].result_shape.check(old, "r")


def test_position_summary_put_side_keys():
    """#260: 無限なら max_loss_yen は null で有限の put 側は put_side_*。古い画面（put_side_* なし）も通す"""
    shape = REGISTRY["position_summary"].result_shape
    cur = copy.deepcopy(SAMPLE["cases"][0]["context"]["precomputed"]["position_summary"])
    unbounded = [c["context"]["precomputed"]["position_summary"] for c in SAMPLE["cases"]
                 if c["context"]["precomputed"]["position_summary"]["expiry"]["max_loss_unbounded"]]
    assert unbounded, "合成のケースに右端が無限のポジションが無い"
    for ps in unbounded:
        assert ps["expiry"]["max_loss_yen"] is None
        assert isinstance(ps["expiry"]["put_side_max_loss_yen"], int)
    old = copy.deepcopy(cur)
    for k in ("put_side_max_profit_yen", "put_side_max_profit_x", "put_side_max_loss_yen", "put_side_max_loss_x"):
        old["expiry"].pop(k, None)
    shape.check(old, "r")
    shape.check(cur, "r")


def test_position_summary_held_keys():
    """#302 AC13: pnl_now_yen・unrealized_yen は任意（古い画面は送らない）。型の外は 400"""
    shape = REGISTRY["position_summary"].result_shape
    held = [c for c in SAMPLE["cases"] if c["context"].get("position", {}).get("held") is True]
    assert held, "合成のケースに保有の文脈が無い"
    for c in held:
        ps = c["context"]["precomputed"]["position_summary"]
        assert isinstance(ps["pnl_now_yen"], int) and isinstance(ps["unrealized_yen"], int)
        assert c["context"]["position"]["other_held"] >= 1
        assert any("opened_days" in leg for leg in c["context"]["position"]["legs"])
    # 保有でない文脈には無い（変更前と同じ形）
    for c in SAMPLE["cases"]:
        if c in held:
            continue
        ps = c["context"]["precomputed"]["position_summary"]
        assert "pnl_now_yen" not in ps and "unrealized_yen" not in ps
    cur = copy.deepcopy(held[0]["context"]["precomputed"]["position_summary"])
    old = copy.deepcopy(cur)
    old.pop("pnl_now_yen")
    old.pop("unrealized_yen")
    shape.check(old, "r")
    shape.check({**cur, "unrealized_yen": None}, "r")
    with pytest.raises(Bad) as e:
        shape.check({**cur, "pnl_now_yen": "1"}, "r")
    assert (e.value.path, e.value.reason) == ("r.pnl_now_yen", "type")


def test_proposal_summary_widths_optional():
    """#260: 提案の要約の形の幅（put_width_x・call_width_x・short_gap_x）。古い画面（キーなし）も通す"""
    from simulator_api.ai.tools import SUMMARY

    found = []

    def walk(v):
        if isinstance(v, dict):
            if "short_gap_x" in v:
                found.append(v)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(SAMPLE)
    assert found, "見本に形の幅の入った要約が無い"
    for summ in found:
        SUMMARY.check(summ, "r")
        old = {k: v for k, v in summ.items() if k not in ("put_width_x", "call_width_x", "short_gap_x")}
        SUMMARY.check(old, "r")
    assert any(isinstance(x["put_width_x"], int) for x in found)


def test_iv_stats_sample_passes_shapes():
    """#138・#158: iv_stats の見本（合成の日次の値）の入力・結果・失敗が tools.py の形を通り、1 往復の要求の
    本文になる"""
    spec = REGISTRY["iv_stats"]
    ivs = SAMPLE["iv_stats"]
    assert len(ivs["results"]) >= 4
    sources = set()
    for e in ivs["results"]:
        spec.input_shape.check(e["input"], "input")
        r = spec.result_shape.check(e["result"], "result")
        sources.add(r["data"]["now_source"])
        # 結果の大きさ（JSON の字数。technicals の 1 足の目安と同じ桁）
        assert len(allowlist.canonical(r)) < 6000
        for b in r.get("moves", {}).get("buckets", []):
            assert b["insufficient"] == (b["n"] < 20)
    assert sources == {"intraday", "daily_close"}
    full = ivs["results"][0]["result"]
    assert set(full) == {"data", "level", "spikes", "moves", "hv"}
    codes = [e["result"]["error"] for e in ivs["errors"]]
    assert codes == ["bad_input", "out_of_range", "no_data"]
    for e in ivs["errors"]:
        allowlist.TOOL_ERROR.check(e["result"], "result")
    msgs = [
        {"role": "user", "content": [{"type": "text", "text": "今の IV は過去のどの辺？"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_i", "name": "iv_stats",
                                           "input": ivs["results"][0]["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_i", "content": [
            {"type": "text", "text": json.dumps(full, ensure_ascii=False)}]}]},
    ]
    body = ai_body(msgs, context=SAMPLE["cases"][0]["context"])
    req = allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode(), REGISTRY)
    assert req.tool_names() == ["iv_stats"]


def test_iv_stats_input_rejects():
    spec = REGISTRY["iv_stats"].input_shape
    spec.check({}, "input")
    spec.check({"sections": ["level", "spikes", "moves", "hv"], "spike_rise_pct": 100}, "input")
    for bad, reason in [({"sections": ["iv"]}, "enum"), ({"sections": []}, "size"),
                        ({"sections": ["level"] * 5}, "size"), ({"spike_rise_pct": 9}, "range"),
                        ({"spike_rise_pct": "30"}, "type"), ({"cmd": "x"}, "unknown_key")]:
        with pytest.raises(Bad) as e:
            spec.check(bad, "input")
        assert e.value.reason == reason


def test_iv_stats_result_rejects_raw_days():
    """生の日次の列や知らないキー・長すぎる回の一覧は結果の形を通らない"""
    spec = REGISTRY["iv_stats"].result_shape
    r = copy.deepcopy(SAMPLE["iv_stats"]["results"][0]["result"])
    r["data"]["days"] = [{"d": "2026-01-05", "iv": 20, "f1": 30000}]
    with pytest.raises(Bad) as e:
        spec.check(r, "r")
    assert e.value.reason == "unknown_key"
    r2 = copy.deepcopy(SAMPLE["iv_stats"]["results"][0]["result"])
    r2["spikes"]["recent"] = r2["spikes"]["recent"][:1] * 9
    with pytest.raises(Bad):
        spec.check(r2, "r")
    r3 = copy.deepcopy(SAMPLE["iv_stats"]["results"][0]["result"])
    r3["data"]["now_at"] = "<script>"
    with pytest.raises(Bad):
        spec.check(r3, "r")


QUOTE = SAMPLE["quote"]


def test_strike_quote_samples_pass_shapes():
    """#266: strike_quote の見本（合成の板）の入力・結果・失敗が tools.py の形を通り、1 往復の要求の本文になる"""
    spec = REGISTRY["strike_quote"]
    for e in QUOTE["results"]:
        spec.input_shape.check(e["input"], "input")
        spec.result_shape.check(e["result"], "result")
    rows = QUOTE["results"][0]["result"]["rows"]
    # 板に無い行使価格（間と外）も理論価格が出て、気配は null
    off = [r for r in rows if not r["on_board"]]
    assert off and all(r["fair_yen"] is not None and r["bid_yen"] is None and r["iv_unstable"] is None for r in off)
    assert {r["type"] for r in rows} == {"P", "C"}
    assert [e["result"]["error"] for e in QUOTE["errors"]] == ["bad_input", "bad_input", "out_of_range",
                                                               "not_on_board"]
    for e in QUOTE["errors"]:
        allowlist.TOOL_ERROR.check(e["result"], "result")
    first = QUOTE["results"][0]
    msgs = [
        {"role": "user", "content": [{"type": "text", "text": "遠い OTM の put の妥当な値段は？"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_q", "name": "strike_quote",
                                           "input": first["input"]}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_q", "content": [
            {"type": "text", "text": json.dumps(first["result"], ensure_ascii=False)}]}]},
    ]
    body = ai_body(msgs, context=SAMPLE["cases"][0]["context"])
    req = allowlist.parse_request(json.dumps(body, ensure_ascii=False).encode(), REGISTRY)
    assert req.tool_names() == ["strike_quote"]


def test_strike_quote_input_rejects():
    spec = REGISTRY["strike_quote"].input_shape
    spec.check({"ks": [45000]}, "input")
    spec.check({"ks": [45000] * 10, "expiry": "2026-11", "type": "C"}, "input")
    for bad, reason in [({}, "missing"), ({"ks": []}, "size"), ({"ks": [45000] * 11}, "size"),
                        ({"ks": [0]}, "range"), ({"ks": ["45000"]}, "type"), ({"ks": [45000], "type": "X"}, "enum"),
                        ({"ks": [45000], "note": "x"}, "unknown_key")]:
        with pytest.raises(Bad) as e:
            spec.check(bad, "input")
        assert e.value.reason == reason


def test_strike_quote_result_rejects_unknown_and_long():
    spec = REGISTRY["strike_quote"].result_shape
    r = copy.deepcopy(QUOTE["results"][0]["result"])
    r["rows"][0]["volume"] = 10
    with pytest.raises(Bad) as e:
        spec.check(r, "r")
    assert e.value.reason == "unknown_key"
    r2 = copy.deepcopy(QUOTE["results"][0]["result"])
    r2["rows"] = r2["rows"][:1] * 11
    with pytest.raises(Bad):
        spec.check(r2, "r")

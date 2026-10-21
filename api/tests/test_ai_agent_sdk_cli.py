"""結合: 同梱の本物の Claude Code CLI を、pytest の中で立てた 127.0.0.1 の偽の Messages API に向ける（#186 AC2、
#221 AC4〜AC7 = スキルの往復・turn の上限・usage の合計・資格情報の 3 種類（wif の交換も偽の交換口で））。

Anthropic は呼ばない（ANTHROPIC_BASE_URL は 127.0.0.1、トークンはダミー）。CLI の内部（transcript の形・
CLAUDE_CODE_RESUME_*・ツールの名前の付け方）に依存する作りを、SDK の版を上げたときにここで検出する（ADR-0005）。
同梱の CLI が無い環境（wheel の無いプラットフォーム）では skip。
"""

import copy
import json
import os
import tempfile
import threading
import time
from pathlib import Path

import pytest
from fake_messages_api import EXCHANGED, SIG, SKILL_NAME, THINKING_PARTS, FakeMessagesApi, turn_usage
from support import FAKE_ID_TOKEN, FAKE_KEY, ai_app, ai_body, ai_context, ai_settings, log_records, sse_events
from support import ai_post as post
from test_ai_agent_sdk import _full_history, built, tool_result_text
from test_ai_skills import frontmatter

from simulator_api import settings as st
from simulator_api.ai import agent_sdk, budget, relay, skills
from simulator_api.ai.agent_sdk import AgentSdkGateway
from simulator_api.ai.gateway import UpstreamError
from simulator_api.ai.tools import REGISTRY

try:
    import claude_agent_sdk

    BUNDLED = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
except ImportError:  # pragma: no cover
    BUNDLED = None

pytestmark = pytest.mark.skipif(BUNDLED is None or not BUNDLED.exists(),
                                reason="同梱の Claude Code CLI が無い（wheel の無いプラットフォーム）")

DUMMY = "dummy-oauth-value-for-tests-0000"  # 32 文字の架空の値（sk-ant- の形にしない）
PARENT = "parent-credential-dummy-value-0123456789"  # 親の環境の資格情報（どれとも長さが違う架空の値）


def live_children() -> list[int]:
    me = os.getpid()
    out = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            fields = (d / "stat").read_text().rsplit(")", 1)[1].split()
        except OSError:
            continue
        if int(fields[1]) == me and fields[0] != "Z":
            out.append(int(d.name))
    return out


@pytest.fixture
def parent_creds(monkeypatch, tmp_path):
    """親の環境に CLI が読む全種類の資格情報・送信先の選択（ダミー）を置く（Cloud Run の ANTHROPIC_AUTH_TOKEN を
    真似る。#221 AC7: WIF の ID・プロファイル・Bedrock / Vertex の切り替えも）。
    一時ディレクトリを tmp_path に寄せ、テストの後に子（CLI）と要求ごとの一時ディレクトリが残らないことを確かめる"""
    for k in agent_sdk.CREDENTIAL_ENV + agent_sdk.ROUTING_ENV:  # 送信先・転送・証明書の変数も（#221 N4）
        monkeypatch.setenv(k, PARENT)
    monkeypatch.setenv("CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK", "1")
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    yield
    deadline = time.monotonic() + 10
    while (live_children() or list(tmp_path.glob("ai-sdk-*"))) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert live_children() == []
    assert list(tmp_path.glob("ai-sdk-*")) == []


def gateway(api: FakeMessagesApi) -> AgentSdkGateway:
    return AgentSdkGateway(DUMMY, extra_env={"ANTHROPIC_BASE_URL": api.base_url})


def strip(messages: list[dict]) -> list[dict]:
    """CLI が足す role=system の message と cache_control を除いて、content を block の list にそろえる"""
    out = []
    for m in messages:
        if m["role"] == "system":
            continue
        c = m["content"]
        if isinstance(c, str):
            c = [{"type": "text", "text": c}]
        out.append({"role": m["role"], "content": [{k: v for k, v in b.items() if k != "cache_control"} for b in c]})
    return out


def cli_named(messages: list[dict]) -> list[dict]:
    out = copy.deepcopy(messages)
    for m in out:
        for b in m["content"]:
            if b.get("type") == "tool_use":
                b["name"] = agent_sdk.to_cli_name(b["name"])
    return out


def test_diagnose_roundtrip_through_real_cli(parent_creds):
    with FakeMessagesApi("tool2") as api:
        gw = gateway(api)
        client, _, _, _ = ai_app(gateway=gw, ai_cfg=ai_settings("oauth_token"), registry=REGISTRY)
        body = ai_body([{"role": "user", "content": [{"type": "text", "text": relay.DIAGNOSE_TEXT}]}],
                       context=ai_context(with_precomputed=False), kind="diagnose")
        evs = sse_events(post(client, body).get_data(as_text=True))
        posts = api.posts()
    names = [e for e, _ in evs]
    # 中継の事象の順: thinking → text → tool_use → done（ツールは実行しない）
    assert names == ["accepted", "progress", *["thinking"] * len(THINKING_PARTS), "progress", "text", "text", "text",
                     "progress", "tool_use", "tool_use", "done"]
    done = dict(evs)["done"]
    assert done["stop_reason"] == "tool_use"
    assert [b["type"] for b in done["content"]] == ["thinking", "text", "tool_use", "tool_use"]
    assert done["content"][0]["signature"] == SIG
    assert [b["name"] for b in done["content"][2:]] == ["evaluate_scenario", "evaluate_scenario"]
    assert gw.tool_calls == 0
    assert len(posts) == 1  # 上流は 1 回（ツールの往復を CLI がしない・再試行しない）
    req = posts[0]
    # 資格情報: Bearer は CLAUDE_CODE_OAUTH_TOKEN（長さがダミーと同じ）、x-api-key なし（親の値は渡らない）
    assert req["authorization"] == {"scheme": "Bearer", "len": len(DUMMY)}
    assert req["x_api_key"] is None
    assert "oauth-2025-04-20" in (req["anthropic_beta"] or "")
    b = req["body"]
    assert b["model"] == "claude-opus-5-5" and b["max_tokens"] == 8000
    assert b["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert b["output_config"]["effort"] == "medium"
    # system: CLI が先頭に 2 block を足し、最後が我々の SYSTEM_PROMPT（バイト一致）
    assert b["system"][-1]["text"] == relay.SYSTEM_PROMPT and len(b["system"]) == 3
    # ツールは我々の 7 本（#200 で technicals）と組み込みの Skill だけ（#221）
    assert sorted(t["name"] for t in b["tools"]) == sorted(
        [agent_sdk.SKILL_TOOL, *(agent_sdk.to_cli_name(n) for n in REGISTRY)])
    # messages: role=system（CLI の環境）を除けば、最初の user（context + 診断の文）だけ
    assert strip(b["messages"]) == [{"role": "user", "content": [
        {"type": "text", "text": json_ctx_text(body)}, {"type": "text", "text": relay.DIAGNOSE_TEXT}]}]


def json_ctx_text(body) -> str:
    from simulator_api.ai import allowlist

    raw = json.dumps(body, ensure_ascii=False).encode()
    req = allowlist.parse_request(raw, REGISTRY)
    return allowlist.upstream_messages(req)[0]["content"][0]["text"]


def _send(params) -> tuple[list[dict], list[dict]]:
    with FakeMessagesApi("text") as api:
        evs = list(gateway(api).stream(params, threading.Event()))
        return evs, api.posts()


def test_history_with_text_last_matches_build_params(parent_creds):
    p = built(_full_history())
    evs, posts = _send(p)
    assert evs[-1]["type"] == "final" and evs[-1]["stop_reason"] == "end_turn"
    assert len(posts) == 1
    # 署名つき thinking・redacted_thinking・tool_use・tool_result・context_update まで一致（ツールの名前は CLI の名前）
    assert strip(posts[0]["body"]["messages"]) == cli_named(p["messages"])


def test_history_with_tool_result_last_adds_only_resume_text(parent_creds):
    p = built(_full_history()[:3])
    evs, posts = _send(p)
    assert evs[-1]["type"] == "final"
    assert len(posts) == 1
    got = strip(posts[0]["body"]["messages"])
    want = cli_named(p["messages"])
    # 最後の user（tool_result）の末尾に CLI が RESUME_PROMPT の text を 1 つ足す（ADR-0005。オーナー了承済み）
    assert got[-1]["content"][-1] == {"type": "text", "text": agent_sdk.RESUME_PROMPT}
    got[-1]["content"] = got[-1]["content"][:-1]
    assert got == want
    # tool_result の後の要求にもツールが全部載る（入力の stream を結果まで開けておく。#209）
    assert sorted(t["name"] for t in posts[0]["body"].get("tools", [])) == sorted(
        [agent_sdk.SKILL_TOOL, *(agent_sdk.to_cli_name(n) for n in REGISTRY)])


def test_at_path_is_not_read(parent_creds, tmp_path):
    marker = tmp_path / "marker.txt"
    marker.write_text("SECRET_MARKER_zq81")
    p = built([{"role": "user", "content": [{"type": "text", "text": f"@{marker} を読んで /help"}]}])
    _, posts = _send(p)
    assert posts and all("SECRET_MARKER_zq81" not in json.dumps(r["body"], ensure_ascii=False) for r in posts)


@pytest.mark.parametrize(("script", "code"), [("err429", "upstream_rate_limited"), ("err401", "upstream_auth")])
def test_upstream_errors_not_retried(parent_creds, script, code):
    with FakeMessagesApi(script) as api:
        with pytest.raises(UpstreamError) as ei:
            list(gateway(api).stream(built(_full_history()[:1]), threading.Event()))
        posts = api.posts()
    assert ei.value.code == code
    assert len(posts) == 1  # CLAUDE_CODE_MAX_RETRIES=0
    assert DUMMY not in str(ei.value)


# ---- スキル（#221） ----

def ai_request(capsys) -> dict:
    return [r for r in log_records(capsys.readouterr().out) if r.get("event") == "ai_request"][0]


def skill_body(name: str) -> str:
    return frontmatter(skills.skill_path(name).read_text(encoding="utf-8"))[1].strip()


def chat(text="RSI はどう？") -> dict:
    return ai_body([{"role": "user", "content": [{"type": "text", "text": text}]}],
                   context=ai_context(with_precomputed=False))


def relay_app(gw, credential="oauth_token"):
    client, _, store, _ = ai_app(gateway=gw, ai_cfg=ai_settings(credential, limit_micro=10_000_000), registry=REGISTRY)
    return client, store


def test_skill_roundtrip_through_real_cli(parent_creds, capsys):
    """AC4: 1 回目が Skill → CLI が SKILL.md を読んで 2 回目へ。Skill は SSE・done に出ない"""
    with FakeMessagesApi("skill") as api:
        gw = gateway(api)
        client, _ = relay_app(gw)
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        posts = api.posts()
    assert len(posts) == 2
    first, second = posts[0]["body"], posts[1]["body"]
    # 1 回目: Skill のツールと、一覧の 2 本だけ（CLI が system の message に載せる）
    assert agent_sdk.SKILL_TOOL in [t["name"] for t in first["tools"]]
    listing = json.dumps(first["messages"], ensure_ascii=False)
    for name in skills.ENABLED:
        assert name in listing
    # 2 回目の messages に SKILL.md の本文（frontmatter を除く）が入る。読んでいない方は入らない
    sent = json.dumps(second["messages"], ensure_ascii=False)
    assert json.dumps(skill_body("technicals"), ensure_ascii=False)[1:-1] in sent
    assert json.dumps(skill_body("proposals"), ensure_ascii=False)[1:-1] not in sent
    # SSE: Skill の tool_use は出ない（tool_use 自体が無い）。done の content に Skill の block が無い
    assert "tool_use" not in [e for e, _ in evs]
    done = dict(evs)["done"]
    assert done["stop_reason"] == "end_turn"
    assert [b["type"] for b in done["content"]] == ["thinking", "text"]
    assert all(b.get("name") != "Skill" for b in done["content"])
    assert gw.tool_calls == 0
    rec = ai_request(capsys)
    assert rec["skills"] == [SKILL_NAME] and rec["turns"] == 2 and rec.get("error") is None
    assert skill_body("technicals") not in json.dumps(rec, ensure_ascii=False)  # 本文はログに出さない


def test_skill_then_sim_tool_stops_at_hook(parent_creds, capsys):
    """AC5: Skill の後に simulator のツール → フックで止まる（上流 2 回）。次の要求（tool_result）も通る"""
    with FakeMessagesApi("skill_tool") as api:
        gw = gateway(api)
        client, _ = relay_app(gw)
        body = chat("ボラ売りの候補を出して")
        evs = sse_events(post(client, body).get_data(as_text=True))
        assert len(api.posts()) == 2
    uses = [d for e, d in evs if e == "tool_use"]
    assert [u["name"] for u in uses] == ["evaluate_scenario"]
    done = dict(evs)["done"]
    assert done["stop_reason"] == "tool_use"
    assert [b["type"] for b in done["content"]] == ["thinking", "text", "tool_use"]
    assert ai_request(capsys)["skills"] == [SKILL_NAME]
    # 次の要求: ブラウザが done の content と tool_result を足して送る（Skill の往復は履歴に無い = 要れば読み直す）
    body["messages"] += [{"role": "assistant", "content": done["content"]},
                         {"role": "user", "content": [{"type": "tool_result", "tool_use_id": uses[0]["id"],
                                                       "content": [{"type": "text", "text": tool_result_text()}]}]}]
    with FakeMessagesApi("skill") as api:
        gw2 = gateway(api)
        client2, _ = relay_app(gw2)
        evs2 = sse_events(post(client2, body).get_data(as_text=True))
        posts = api.posts()
    assert evs2[-1][0] == "done" and evs2[-1][1]["stop_reason"] == "end_turn"
    assert len(posts) == 2
    assert any(b.get("type") == "tool_result" and b.get("tool_use_id") == uses[0]["id"]
               for m in posts[0]["body"]["messages"] if isinstance(m["content"], list) for b in m["content"])
    assert gw.tool_calls == 0 and gw2.tool_calls == 0


def test_unlisted_skill_denied_and_turn_continues(parent_creds, capsys):
    """一覧に無いスキル名の Skill はフックが deny（turn は続き、モデルは答える）。本文は読まれない"""
    with FakeMessagesApi("skill_unknown") as api:
        client, _ = relay_app(gateway(api))
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        posts = api.posts()
    assert evs[-1][0] == "done" and len(posts) == 2
    sent = json.dumps(posts[1]["body"]["messages"], ensure_ascii=False)
    for name in skills.NAMES:
        assert json.dumps(skill_body(name), ensure_ascii=False)[1:-1] not in sent
    rec = ai_request(capsys)
    assert rec["skills"] == [] and rec["turns"] == 2


def test_skill_loop_hits_max_turns(parent_creds, capsys):
    """AC5: Skill を上限の turn を超えて呼び続ける → SSE は error で終わる（子と一時ディレクトリは parent_creds が
    残らないことを確かめる）"""
    with FakeMessagesApi("skill_loop") as api:
        client, _ = relay_app(gateway(api))
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        posts = api.posts()
    assert evs[-1] == ("error", {"code": "upstream_unavailable"})
    assert "done" not in [e for e, _ in evs]
    assert len(posts) == st.AI_MAX_TURNS
    rec = ai_request(capsys)
    assert rec["error"] == "upstream_unavailable" and rec["error_type"] == "result:error_max_turns"
    assert rec["turns"] == st.AI_MAX_TURNS and rec["skills"] == [SKILL_NAME]


def summed_usage(n: int) -> dict:
    total: dict = {}
    for i in range(n):
        start, delta = turn_usage(i)
        agent_sdk._add_usage(total, {**start, **delta})
    return total


def test_usage_summed_over_turns_api_key(parent_creds, capsys):
    """AC6: turn ごとに違う usage → ai_request の usage・cost_usd_est・精算は全 turn の合計（api_key = 数える）。
    AC7: api_key は x-api-key だけ（Authorization なし。親の値は渡らない）"""
    with FakeMessagesApi("skill") as api:
        gw = AgentSdkGateway(FAKE_KEY, credential="api_key", extra_env={"ANTHROPIC_BASE_URL": api.base_url})
        client, store = relay_app(gw, "api_key")
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        posts = api.posts()
    assert evs[-1][0] == "done" and len(posts) == 2
    for r in posts:
        assert r["x_api_key"] == {"scheme": None, "len": len(FAKE_KEY)} and r["authorization"] is None
    want = summed_usage(2)
    assert want["input_tokens"] == 1234 + 2234 and want["output_tokens"] == 321 + 331
    assert want["cache_creation"] == {"ephemeral_5m_input_tokens": 40, "ephemeral_1h_input_tokens": 60}
    rec = ai_request(capsys)
    for k in agent_sdk.USAGE_KEYS:
        assert rec[k] == want[k]
    cost = budget.cost_micro_usd("claude-opus-5-5", want)
    assert rec["cost_usd_est"] == budget.usd(cost) == rec["charged_usd"]
    assert store.charged["2026-10-19"] == cost


def test_usage_matches_result_message(parent_creds):
    """Assembler の合計（生の事象）と CLI の ResultMessage.usage が一致する（CLI の集計の形を版の更新で検出）"""
    from claude_agent_sdk import ResultMessage
    from claude_agent_sdk import query as real_query

    seen = []

    def q(prompt, options):
        async def gen():
            async for m in real_query(prompt=prompt, options=options):
                if isinstance(m, ResultMessage):
                    seen.append(m.usage)
                yield m

        return gen()

    with FakeMessagesApi("skill") as api:
        gw = AgentSdkGateway(DUMMY, query_fn=q, extra_env={"ANTHROPIC_BASE_URL": api.base_url})
        evs = list(gw.stream(built([{"role": "user", "content": [{"type": "text", "text": "RSI"}]}]),
                             threading.Event()))
    final = evs[-1]
    assert final["type"] == "final" and final["usage"] == summed_usage(2)
    assert {k: seen[0][k] for k in agent_sdk.USAGE_KEYS} == {k: final["usage"][k] for k in agent_sdk.USAGE_KEYS}


def wif_gateway(api, identity_token=lambda: FAKE_ID_TOKEN) -> AgentSdkGateway:
    return AgentSdkGateway(None, credential="wif", wif=ai_settings("wif").wif, identity_token=identity_token,
                           extra_env={"ANTHROPIC_BASE_URL": api.base_url})


def test_wif_exchange_through_real_cli(parent_creds, capsys):
    """AC7（wif）: CLI が ID トークンを交換（POST /v1/oauth/token。偽の交換口）し、交換したトークンの Bearer だけで
    送る（親の値・x-api-key は渡らない）。Anthropic は呼ばない"""
    with FakeMessagesApi("skill") as api:
        client, store = relay_app(wif_gateway(api), "wif")
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        exchanges, posts = api.exchanges(), api.posts()
    assert evs[-1][0] == "done"
    assert len(exchanges) == 1  # 1 要求 1 回（キャッシュは要求ごとの一時ディレクトリ）
    ex = exchanges[0]["body"]
    assert ex["grant_type"] == "urn:ietf:params:oauth:grant-type:jwt-bearer"
    assert ex["keys"] == ["assertion", "federation_rule_id", "grant_type", "organization_id", "service_account_id",
                          "workspace_id"]
    assert ex["assertion_len"] == len(FAKE_ID_TOKEN)
    assert "oidc-federation-2026-04-01" in (exchanges[0]["anthropic_beta"] or "")
    assert len(posts) == 2
    for r in posts:
        assert r["authorization"] == {"scheme": "Bearer", "len": len(EXCHANGED)} and r["x_api_key"] is None
    rec = ai_request(capsys)
    assert rec["credential"] == "wif" and rec.get("error") is None and rec["skills"] == [SKILL_NAME]
    assert store.charged["2026-10-19"] == budget.cost_micro_usd("claude-opus-5-5", summed_usage(2))


@pytest.mark.parametrize(("status", "code"), [(401, "upstream_auth"), (403, "upstream_auth"),
                                              (500, "upstream_unavailable")])
def test_wif_exchange_failure_classified(parent_creds, capsys, status, code):
    with FakeMessagesApi("text", exchange_status=status) as api:
        client, _ = relay_app(wif_gateway(api), "wif")
        evs = sse_events(post(client, chat()).get_data(as_text=True))
        posts = api.posts()
    assert evs[-1] == ("error", {"code": code})
    assert posts == []  # 交換に失敗したら /v1/messages を呼ばない
    out = capsys.readouterr().out
    rec = [r for r in log_records(out) if r.get("event") == "ai_request"][0]
    assert rec["upstream_status"] == status and rec["error_type"] == "token_exchange"
    assert "Token exchange failed" not in out and FAKE_ID_TOKEN not in out


# ---- CLI の要求の形（予約額の上界の前提。#221 N2・N3） ----

def _bytes(x) -> int:
    return len(json.dumps(x, ensure_ascii=False, separators=(",", ":")).encode())


def _norm(messages: list[dict]) -> list[dict]:
    """content を block の list にそろえ cache_control を除く（キャッシュの前置きの比較用）"""
    out = []
    for m in messages:
        c = m["content"]
        if isinstance(c, str):
            c = [{"type": "text", "text": c}]
        out.append({"role": m["role"], "content": [{k: v for k, v in b.items() if k != "cache_control"} for b in c]})
    return out


def _strip_cc(blocks):
    return [{k: v for k, v in b.items() if k != "cache_control"} for b in blocks]


@pytest.mark.parametrize("history", [False, True])
def test_cli_overhead_and_cache_prefix_for_reserve(parent_creds, history):
    """予約額（budget.reserve_micro_usd）の前提を CLI の要求の形で固定する:
    1. CLI が足す本文（system の先頭・Skill の定義・環境の message）は AI_CLI_OVERHEAD_TOKENS 以下 = 見積もり E に入る
    2. 各要求の最後の message に cache_control が付き、次の turn の要求は前の turn の要求をそのまま前置きに持つ
       （system・tools は同じ）= 前の turn の要求はキャッシュの読み出しになる
    3. turn ごとに増える分（前の出力を除く）は Skill の本文と枠 = K（skill_tokens）以下"""
    msgs = _full_history() if history else [{"role": "user", "content": [{"type": "text", "text": "RSI は？"}]}]
    p = built(msgs)
    with FakeMessagesApi("skill") as api:
        list(gateway(api).stream(p, threading.Event()))
        posts = [r["body"] for r in api.posts()]
    assert len(posts) == 2
    sent = [_bytes({k: b.get(k) for k in ("system", "tools", "messages")}) for b in posts]
    base = len(relay.params_text(p).encode())
    assert sent[0] - base <= st.AI_CLI_OVERHEAD_TOKENS
    assert budget.estimate_input_tokens(relay.params_text(p)) >= sent[0] + st.AI_INPUT_OVERHEAD_TOKENS
    for b in posts:
        last = b["messages"][-1]["content"]
        assert isinstance(last, list) and "cache_control" in last[-1]
    first, second = posts
    assert _strip_cc(first["system"]) == _strip_cc(second["system"])
    assert [t["name"] for t in first["tools"]] == [t["name"] for t in second["tools"]]
    n0 = _norm(first["messages"])
    assert _norm(second["messages"])[:len(n0)] == n0
    added = _norm(second["messages"])[len(n0):]
    out_bytes = sum(_bytes(m) for m in added if m["role"] == "assistant")
    assert sent[1] - sent[0] - out_bytes <= budget.skill_tokens()


def test_parent_base_url_does_not_redirect(parent_creds, monkeypatch):
    """親の ANTHROPIC_BASE_URL（別の宛先）は子に渡らない（中継が空で上書き。テストの extra_env だけが効く）"""
    with FakeMessagesApi("text") as decoy, FakeMessagesApi("text") as api:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", decoy.base_url)
        monkeypatch.setenv("CLAUDE_CODE_API_BASE_URL", decoy.base_url)
        evs = list(gateway(api).stream(built(_full_history()[:1]), threading.Event()))
        assert evs[-1]["type"] == "final" and len(api.posts()) == 1
        assert decoy.requests == []


def test_empty_routing_env_falls_back_to_default_host(parent_creds):
    """送信先の変数を全部空にしても CLI は既定の api.anthropic.com に送る（本番の形）。127.0.0.1 の受け口を
    HTTPS_PROXY にして CONNECT の宛先だけを見る（502 を返すので Anthropic には届かない。TLS も始まらない）"""
    import socket

    seen: list[str] = []
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    srv.settimeout(30)

    def loop():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            with c:
                seen.append(c.recv(4096).split(b"\r\n")[0].decode(errors="replace"))
                c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")

    threading.Thread(target=loop, daemon=True).start()
    proxy = f"http://127.0.0.1:{srv.getsockname()[1]}"
    gw = AgentSdkGateway(DUMMY, extra_env={"HTTPS_PROXY": proxy, "HTTP_PROXY": proxy, "NO_PROXY": ""})
    try:
        with pytest.raises(UpstreamError):
            list(gw.stream(built(_full_history()[:1]), threading.Event()))
    finally:
        srv.close()
    assert seen and set(seen) == {"CONNECT api.anthropic.com:443 HTTP/1.1"}

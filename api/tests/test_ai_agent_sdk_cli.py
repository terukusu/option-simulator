"""結合: 同梱の本物の Claude Code CLI を、pytest の中で立てた 127.0.0.1 の偽の Messages API に向ける（#186 AC2）。

Anthropic は呼ばない（ANTHROPIC_BASE_URL は 127.0.0.1、トークンはダミー）。CLI の内部（transcript の形・
CLAUDE_CODE_RESUME_*・道具の名前の付け方）に依存する作りを、SDK の版を上げたときにここで検出する（ADR-0005）。
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
from fake_messages_api import SIG, THINKING_PARTS, FakeMessagesApi
from support import ai_app, ai_body, ai_context, ai_settings, sse_events
from support import ai_post as post
from test_ai_agent_sdk import _full_history, built

from simulator_api.ai import agent_sdk, relay
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
    """親の環境に別の長さの資格情報（ダミー）を置く（Cloud Run の ANTHROPIC_AUTH_TOKEN を真似る）。
    一時ディレクトリを tmp_path に寄せ、テストの後に子（CLI）と要求ごとの一時ディレクトリが残らないことを確かめる"""
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "parent-auth-dummy-value")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "parent-key-dummy-value-0123456789")
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
    # 中継の事象の順: thinking → text → tool_use → done（道具は実行しない）
    assert names == ["accepted", "progress", *["thinking"] * len(THINKING_PARTS), "progress", "text", "text", "text",
                     "progress", "tool_use", "tool_use", "done"]
    done = dict(evs)["done"]
    assert done["stop_reason"] == "tool_use"
    assert [b["type"] for b in done["content"]] == ["thinking", "text", "tool_use", "tool_use"]
    assert done["content"][0]["signature"] == SIG
    assert [b["name"] for b in done["content"][2:]] == ["evaluate_scenario", "evaluate_scenario"]
    assert gw.tool_calls == 0
    assert len(posts) == 1  # 上流は 1 回（道具の往復を CLI がしない・再試行しない）
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
    # 道具は我々の 7 本だけ（組み込みの道具は 0 本。#200 で technicals）
    assert sorted(t["name"] for t in b["tools"]) == sorted(agent_sdk.to_cli_name(n) for n in REGISTRY)
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
    # 署名つき thinking・redacted_thinking・tool_use・tool_result・context_update まで一致（道具の名前は CLI の名前）
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

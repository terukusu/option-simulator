"""AI_CREDENTIAL=oauth_token の送信先（Claude Agent SDK 経由。#186 AC2・AC3）。

偽の query（SDK の事象の列を流す関数）と偽の CLI（Python のスクリプト）だけを使い、ネットワークに出ない。
本物の同梱 CLI と偽の Messages API の結合は tests/test_ai_agent_sdk_cli.py。値はすべて架空。
"""

import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent
from claude_agent_sdk._errors import CLINotFoundError, ProcessError, ResultError
from conftest import REPO_ROOT
from support import (
    FAKE_KEY,
    FAKE_TOKEN,
    ai_app,
    ai_body,
    ai_context,
    ai_settings,
    log_records,
    sse_events,
)
from support import ai_post as post

from simulator_api import settings as st
from simulator_api.ai import agent_sdk, allowlist, relay
from simulator_api.ai.agent_sdk import AgentSdkGateway
from simulator_api.ai.gateway import UpstreamError
from simulator_api.ai.tools import REGISTRY

SIG = "c2lnLXVuaXQtMDAx"


def ai_request_log(capsys) -> dict:
    return [r for r in log_records(capsys.readouterr().out) if r.get("event") == "ai_request"][0]


def se(event: dict) -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event=event)


def result(is_error=False, status=None, subtype="success", usage=None) -> ResultMessage:
    return ResultMessage(subtype=subtype, duration_ms=1, duration_api_ms=1, is_error=is_error, num_turns=1,
                         session_id="s", usage=usage, api_error_status=status)


USAGE = {"input_tokens": 1500, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 20,
         "output_tokens": 300, "server_tool_use": {"web_search_requests": 0}}


def turn_events(tools=2, redacted=True) -> list:
    """モデルの 1 turn（thinking → redacted_thinking → text → 道具）の StreamEvent と、CLI が足す AssistantMessage"""
    ev = [se({"type": "message_start", "message": {"usage": {"input_tokens": 1, "output_tokens": 1}}}),
          se({"type": "content_block_start", "index": 0,
              "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
          se({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "下を"}}),
          se({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "見る"}}),
          se({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": SIG}}),
          se({"type": "content_block_stop", "index": 0}),
          AssistantMessage(content=[], model="m")]
    i = 1
    if redacted:
        ev += [se({"type": "content_block_start", "index": i,
                   "content_block": {"type": "redacted_thinking", "data": "UkVE"}}),
               se({"type": "content_block_stop", "index": i})]
        i += 1
    ev += [se({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}),
           se({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": "弱点 1:"}}),
           se({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": " 急落"}}),
           se({"type": "content_block_stop", "index": i})]
    for j in range(tools):
        i += 1
        ev += [se({"type": "content_block_start", "index": i, "content_block": {
                   "type": "tool_use", "id": f"toolu_u{j}", "name": "mcp__sim__evaluate_scenario", "input": {}}}),
               se({"type": "content_block_delta", "index": i,
                   "delta": {"type": "input_json_delta", "partial_json": '{"days": 5, '}}),
               se({"type": "content_block_delta", "index": i,
                   "delta": {"type": "input_json_delta", "partial_json": f'"iv_shift_pt": {j}}}'}}),
               se({"type": "content_block_stop", "index": i})]
    ev += [se({"type": "message_delta", "delta": {"stop_reason": "tool_use" if tools else "end_turn"},
               "usage": {"output_tokens": 300}}),
           se({"type": "message_stop"})]
    return ev


class FakeQuery:
    """claude_agent_sdk.query の代わり。受けた options・prompt を記録し、決まった事象の列を流す
    （raise_after 件の後に raise）"""

    def __init__(self, events, raise_after: int | None = None, error: BaseException | None = None,
                 tail=(), gate: threading.Event | None = None):
        self.events = list(events)
        self.raise_after = raise_after
        self.error = error
        self.tail = list(tail)
        self.gate = gate
        self.options = None
        self.prompts: list[dict] = []
        self.closed = False

    def __call__(self, prompt, options):
        self.options = options

        async def drain():
            async for p in prompt:
                self.prompts.append(p)

        async def gen():
            # 本物の SDK と同じく入力の stream は並行して読む（中継は結果まで stream を開けておく。#209）
            reader = asyncio.ensure_future(drain())
            try:
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                if self.gate is not None:
                    while not self.gate.is_set():
                        await asyncio.sleep(0.01)
                for n, m in enumerate(self.events + self.tail):
                    if self.raise_after is not None and n == self.raise_after:
                        raise self.error
                    yield m
                if self.raise_after is not None and self.raise_after >= len(self.events + self.tail):
                    raise self.error
            finally:
                reader.cancel()
                self.closed = True

        return gen()


def params(messages=None, tools=True) -> dict:
    p = {"model": "claude-opus-5-5", "max_tokens": st.AI_MAX_TOKENS, "system": relay.SYSTEM_PROMPT,
         "thinking": dict(relay.THINKING), "output_config": dict(relay.OUTPUT_CONFIG),
         "cache_control": dict(relay.CACHE_CONTROL),
         "messages": messages or [{"role": "user", "content": [{"type": "text", "text": relay.DIAGNOSE_TEXT}]}]}
    if tools:
        p["tools"] = [t.definition() for t in REGISTRY.values()]
    return p


def run(gw, p=None, cancel=None) -> list[dict]:
    return list(gw.stream(p or params(), cancel or threading.Event()))


# ---- 事象の形・順（AnthropicGateway と同じ） ----

def test_events_same_shape_and_order_as_anthropic_gateway():
    fq = FakeQuery(turn_events(), tail=[result(usage=USAGE)])
    gw = AgentSdkGateway(FAKE_TOKEN, query_fn=fq)
    evs = run(gw)
    assert evs[0]["type"] == "meta" and isinstance(evs[0]["spawn_ms"], int)
    evs = evs[1:]
    assert [e["type"] for e in evs] == ["thinking", "thinking", "text", "text", "tool_use", "tool_use", "final"]
    assert evs[0] == {"type": "thinking", "text": "下を"}
    assert evs[2] == {"type": "text", "text": "弱点 1:"}
    # tool_use の name は登録の名前に戻す。input は input_json_delta を join したもの
    assert evs[4] == {"type": "tool_use", "id": "toolu_u0", "name": "evaluate_scenario",
                      "input": {"days": 5, "iv_shift_pt": 0}}
    final = evs[-1]
    assert final["stop_reason"] == "tool_use"
    assert final["usage"] == {k: USAGE[k] for k in agent_sdk.USAGE_KEYS}  # ResultMessage の usage の 4 キー
    assert final["content"] == [
        {"type": "thinking", "thinking": "下を見る", "signature": SIG},
        {"type": "redacted_thinking", "data": "UkVE"},  # AssistantMessage は落とすが StreamEvent から残す
        {"type": "text", "text": "弱点 1: 急落"},
        {"type": "tool_use", "id": "toolu_u0", "name": "evaluate_scenario", "input": {"days": 5, "iv_shift_pt": 0}},
        {"type": "tool_use", "id": "toolu_u1", "name": "evaluate_scenario", "input": {"days": 5, "iv_shift_pt": 1}},
    ]
    assert gw.tool_calls == 0  # 道具の関数は呼ばれない
    assert fq.closed


def test_relay_sse_through_agent_sdk_gateway(capsys):
    fq = FakeQuery(turn_events(), tail=[result(usage=USAGE)])
    gw = AgentSdkGateway(FAKE_TOKEN, query_fn=fq)
    client, _, _, _ = ai_app(gateway=gw, ai_cfg=ai_settings("oauth_token"), registry=REGISTRY)
    out = post(client, ai_body(context=ai_context(with_precomputed=False))).get_data(as_text=True)
    names = [e for e, _ in sse_events(out)]
    assert names == ["accepted", "progress", "thinking", "thinking", "progress", "text", "text", "progress",
                     "tool_use", "tool_use", "done"]
    done = dict(sse_events(out))["done"]
    assert done["stop_reason"] == "tool_use"
    assert [b["type"] for b in done["content"]] == ["thinking", "redacted_thinking", "text", "tool_use", "tool_use"]
    rec = ai_request_log(capsys)
    assert rec["credential"] == "oauth_token" and rec["charged_usd"] == 0.0 and rec.get("error") is None
    assert isinstance(rec["spawn_ms"], int) and rec["input_tokens"] == 1500
    assert gw.tool_calls == 0


def test_end_turn_without_tools():
    fq = FakeQuery(turn_events(tools=0, redacted=False), tail=[result(usage=USAGE)])
    evs = run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq))
    assert evs[-1]["stop_reason"] == "end_turn"
    assert [b["type"] for b in evs[-1]["content"]] == ["thinking", "text"]


def test_no_final_without_message_stop():
    fq = FakeQuery(turn_events()[:-1], tail=[result(usage=USAGE)])
    evs = run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq))
    assert "final" not in [e["type"] for e in evs]  # 中継が upstream_incomplete にする


def test_second_api_turn_is_an_error():
    fq = FakeQuery(turn_events() + turn_events(), tail=[result()])
    with pytest.raises(UpstreamError) as ei:
        run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq))
    assert ei.value.code == "upstream_unavailable" and ei.value.error_type == "unexpected_turn"


# ---- 固定する値（options） ----

def test_options_fixed_values_and_text_prompt():
    fq = FakeQuery(turn_events(), tail=[result()])
    gw = AgentSdkGateway(FAKE_TOKEN, query_fn=fq)
    p = params()
    run(gw, p)
    o = fq.options
    assert o.tools == [] and o.setting_sources == [] and o.strict_mcp_config is True
    assert o.verbatim_prompts is True and o.include_partial_messages is True and o.max_turns == 1
    assert o.system_prompt == relay.SYSTEM_PROMPT and o.model == "claude-opus-5-5"
    assert o.thinking == {"type": "adaptive", "display": "summarized"} and o.effort == st.AI_EFFORT
    assert list(o.mcp_servers) == ["sim"] and set(o.hooks) == {"PreToolUse"}
    assert o.session_store is None and o.resume is None  # 最初の発言: 履歴なし
    env = o.env
    assert env["CLAUDE_CODE_MAX_RETRIES"] == "0"
    assert env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == str(st.AI_MAX_TOKENS)
    assert env["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] == ""
    assert env["CLAUDE_CONFIG_DIR"].endswith("/cfg") and str(o.cwd).endswith("/cwd")
    assert not Path(str(o.cwd)).exists()  # 一時ディレクトリは終わったら消える
    # prompt は最後の user の content そのもの（stream-json）
    assert fq.prompts == [{"type": "user", "message": {"role": "user", "content": p["messages"][-1]["content"]},
                           "parent_tool_use_id": None, "session_id": "default"}]


def test_pre_tool_use_hook_denies_and_stops():
    fq = FakeQuery(turn_events(), tail=[result()])
    run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq), params())
    hook = fq.options.hooks["PreToolUse"][0].hooks[0]
    out = asyncio.run(hook({"tool_name": "mcp__sim__evaluate_scenario"}, "toolu_x", {}))
    assert out["continue_"] is False
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_sdk_tool_handler_does_not_compute():
    gw = AgentSdkGateway(FAKE_TOKEN)
    defs = [t.definition() for t in REGISTRY.values()]
    tools = gw.sdk_tools(defs)
    assert [t.name for t in tools] == [d["name"] for d in defs]
    assert [t.input_schema for t in tools] == [d["input_schema"] for d in defs]
    out = asyncio.run(tools[0].handler({}))  # 呼ばれない前提。呼ばれても計算せずにエラーを返す
    assert out["is_error"] is True and gw.tool_calls == 1
    server = gw._server(defs)
    assert server["type"] == "sdk" and server["name"] == "sim"


# ---- 履歴（S3）: transcript の項目から取り出した messages が build_params の messages と一致 ----

def tool_result_text() -> str:
    """道具の結果の見本（fixtures/synthetic/ai_tools.json の evaluate_scenario。合成の値）"""
    sample = json.loads((REPO_ROOT / "fixtures" / "synthetic" / "ai_tools.json").read_text(encoding="utf-8"))
    return json.dumps(sample["cases"][0]["evaluate"][0]["result"], ensure_ascii=False)


def _full_history() -> list[dict]:
    upd = ai_context(with_precomputed=False)
    upd["scenario"]["days"] = 9
    return [
        {"role": "user", "content": [{"type": "text", "text": relay.DIAGNOSE_TEXT}]},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "前の考え 1。", "signature": "U0lHLWhpc3QtQQ=="},
            {"type": "text", "text": "## 弱点 1: 急落"},
            {"type": "tool_use", "id": "toolu_h1", "name": "evaluate_scenario",
             "input": {"days": 5, "iv_shift_pt": 2, "dx_pct": -6}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_h1",
                                      "content": [{"type": "text", "text": tool_result_text()}]}]},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "前の考え 2。", "signature": "U0lHLWhpc3QtQg=="},
            {"type": "redacted_thinking", "data": "UkVEQUNURUQtZmFrZQ=="},
            {"type": "text", "text": "結論です。"}]},
        {"role": "user", "content": [{"type": "text", "text": "急落したらどうなる？"},
                                     {"type": "context_update", "context": upd}]},
    ]


def built(messages) -> dict:
    raw = json.dumps(ai_body(messages, context=ai_context(with_precomputed=False)), ensure_ascii=False).encode()
    req = allowlist.parse_request(raw, REGISTRY)
    return relay.build_params(req, st.AiSettings(credential="oauth_token", secret="x"), REGISTRY)


def test_history_text_turn_roundtrips_to_build_params_messages():
    p = built(_full_history())
    history, prompt = agent_sdk.split_last(p["messages"])
    entries = agent_sdk.history_entries(history, "sid", "/tmp/x", "claude-opus-5-5", "2.1.283")
    assert agent_sdk.entries_messages(entries) + [{"role": "user", "content": prompt}] == p["messages"]
    # thinking の値と署名・redacted_thinking・tool_result・context_update（text block）まで同じ
    assert entries[1]["message"]["content"][0]["signature"] == "U0lHLWhpc3QtQQ=="
    assert entries[1]["message"]["content"][2]["name"] == "mcp__sim__evaluate_scenario"  # CLI の名前に付け直す
    assert entries[3]["message"]["content"][1] == {"type": "redacted_thinking", "data": "UkVEQUNURUQtZmFrZQ=="}
    assert prompt[1]["text"].startswith(allowlist.UPDATE_OPEN)
    # 鎖（parentUuid）と共通の欄
    assert entries[0]["parentUuid"] is None
    assert all(e["parentUuid"] == prev["uuid"] for prev, e in zip(entries, entries[1:], strict=False))
    assert {e["sessionId"] for e in entries} == {"sid"} and {e["version"] for e in entries} == {"2.1.283"}


def test_history_tool_result_turn_goes_into_transcript():
    msgs = _full_history()[:3]
    p = built(msgs)
    history, prompt = agent_sdk.split_last(p["messages"])
    assert prompt is None
    entries = agent_sdk.history_entries(history, "sid", "/tmp/x", "m", "2.1.283")
    assert agent_sdk.entries_messages(entries) == p["messages"]


def test_resume_options_for_tool_result_turn():
    fq = FakeQuery(turn_events(tools=0), tail=[result()])
    run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq), built(_full_history()[:3]))
    o = fq.options
    assert o.resume and o.session_store is not None
    assert o.env["CLAUDE_CODE_RESUME_INTERRUPTED_TURN"] == "1"
    assert o.env["CLAUDE_CODE_RESUME_PROMPT"] == agent_sdk.RESUME_PROMPT
    assert fq.prompts == []  # prompt は空（CLI が turn を続ける）
    loaded = asyncio.run(o.session_store.load({"project_key": "k", "session_id": o.resume}))
    assert len(loaded) == 3
    assert asyncio.run(o.session_store.load({"project_key": "k", "session_id": "other"})) is None


def test_split_last_requires_user():
    with pytest.raises(ValueError):
        agent_sdk.split_last([{"role": "assistant", "content": []}])


# ---- 子の環境（S5） ----

def test_child_env_only_oauth_token(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "parent-auth-dummy")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "parent-key-dummy")
    env = agent_sdk.child_env(FAKE_TOKEN, "/tmp/c", 8000, False)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == FAKE_TOKEN
    assert env["ANTHROPIC_AUTH_TOKEN"] == "" and env["ANTHROPIC_API_KEY"] == ""


FAKE_CLI = """#!{python}
import json, os, sys, time
if "-v" in sys.argv[1:] or "--version" in sys.argv[1:]:
    print("2.1.283 (Claude Code)")
    sys.exit(0)
out = os.environ.get("FAKE_CLI_OUT")
state = {{k: ("set" if os.environ.get(k) else ("empty" if k in os.environ else "absent"))
         for k in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")}}
state["oauth_matches"] = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == os.environ.get("FAKE_CLI_EXPECT")
state["pid"] = os.getpid()
with open(out + ".tmp", "w") as f:
    json.dump(state, f)
os.replace(out + ".tmp", out)
if os.environ.get("FAKE_CLI_SLEEP"):
    time.sleep(float(os.environ["FAKE_CLI_SLEEP"]))
if os.environ.get("FAKE_CLI_UNTIL_EOF"):  # 本物の CLI と同じく stdin の EOF で終わる
    sys.stdin.read()
sys.stderr.write("fake cli stderr " + (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or "") + "\\n")
sys.exit(3)
"""


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK", "1")
    path = tmp_path / "fake-claude"
    path.write_text(FAKE_CLI.format(python=sys.executable))
    path.chmod(0o755)
    return str(path), str(tmp_path / "state.json")


def _alive(pid: int) -> bool:
    try:
        st_ = Path(f"/proc/{pid}/status").read_text()
    except FileNotFoundError:
        return False
    return "State:\tZ" not in st_


def test_child_process_env_with_parent_credentials(fake_cli, monkeypatch, capsys):
    cli, out = fake_cli
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "parent-auth-dummy")
    monkeypatch.setenv("ANTHROPIC_API_KEY", FAKE_KEY)
    gw = AgentSdkGateway(FAKE_TOKEN, cli_path=cli, extra_env={"FAKE_CLI_OUT": out, "FAKE_CLI_EXPECT": FAKE_TOKEN})
    with pytest.raises(UpstreamError) as ei:
        run(gw)
    state = json.loads(Path(out).read_text())
    assert state["CLAUDE_CODE_OAUTH_TOKEN"] == "set" and state["oauth_matches"] is True
    assert state["ANTHROPIC_AUTH_TOKEN"] == "empty" and state["ANTHROPIC_API_KEY"] == "empty"  # 空 = 未設定扱い
    # 失敗は型と状態だけ。トークン・CLI の標準エラーは例外・repr・ログに出ない
    e = ei.value
    assert e.code == "upstream_unavailable"
    for s in (str(e), repr(e), repr(gw), str(e.error_type), capsys.readouterr().out):
        assert FAKE_TOKEN not in s and "fake cli stderr" not in s
    assert not _alive(state["pid"])


def test_cancel_stops_child_even_if_it_ignores_stdin_eof(fake_cli):
    """cancel → SDK の後始末（stdin を閉じる → 5 秒待って SIGTERM）。偽の CLI は stdin の EOF を無視して眠る"""
    cli, out = fake_cli
    gw = AgentSdkGateway(FAKE_TOKEN, cli_path=cli, extra_env={"FAKE_CLI_OUT": out, "FAKE_CLI_SLEEP": "60"})
    cancel = threading.Event()
    box: dict = {}

    def consume():
        try:
            box["events"] = list(gw.stream(params(), cancel))
        except UpstreamError as e:
            box["error"] = e

    th = threading.Thread(target=consume, daemon=True)
    th.start()
    t0 = time.monotonic()
    while not Path(out).exists() and time.monotonic() - t0 < 30:
        time.sleep(0.05)
    pid = json.loads(Path(out).read_text())["pid"]
    assert _alive(pid)
    cancel.set()
    t1 = time.monotonic()
    th.join(20)
    assert not th.is_alive()
    assert "final" not in [e["type"] for e in box.get("events") or []]
    while _alive(pid) and time.monotonic() - t1 < 15:
        time.sleep(0.05)
    assert not _alive(pid)  # 子は残らない


def test_deadline_closes_sse_with_timeout_and_stops_child(fake_cli, capsys):
    cli, out = fake_cli
    gw = AgentSdkGateway(FAKE_TOKEN, cli_path=cli, extra_env={"FAKE_CLI_OUT": out, "FAKE_CLI_UNTIL_EOF": "1"})
    client, _, _, _ = ai_app(gateway=gw, ai_cfg=ai_settings("oauth_token", deadline=1.5), registry=REGISTRY)
    res = post(client, ai_body(context=ai_context(with_precomputed=False)))
    evs = sse_events(res.get_data(as_text=True))
    assert evs[-1] == ("error", {"code": "timeout"})
    pid = json.loads(Path(out).read_text())["pid"]
    t1 = time.monotonic()
    while _alive(pid) and time.monotonic() - t1 < 10:
        time.sleep(0.05)
    assert not _alive(pid)
    rec = ai_request_log(capsys)
    assert rec["error"] == "timeout" and rec["charged_usd"] == 0.0


def test_client_disconnect_stops_child(fake_cli):
    """流している途中で切断（gunicorn が応答を close）→ 中継の finally の cancel → 子（偽の CLI）が止まる"""
    from claude_agent_sdk import query as real_query

    def first_event_then_real(prompt, options):
        async def gen():  # 最初の thinking を出してから本物の query（偽の CLI）を待つ
            for ev in turn_events()[:3]:
                yield ev
            async for m in real_query(prompt=prompt, options=options):
                yield m

        return gen()

    cli, out = fake_cli
    gw = AgentSdkGateway(FAKE_TOKEN, cli_path=cli, query_fn=first_event_then_real,
                         extra_env={"FAKE_CLI_OUT": out, "FAKE_CLI_UNTIL_EOF": "1"})
    client, _, _, _ = ai_app(gateway=gw, ai_cfg=ai_settings("oauth_token"), registry=REGISTRY)
    res = post(client, ai_body(context=ai_context(with_precomputed=False)), buffered=False)
    chunks = iter(res.response)
    assert next(chunks).startswith(b"event: accepted")
    assert next(chunks).startswith(b"event: progress")
    t0 = time.monotonic()
    while not Path(out).exists() and time.monotonic() - t0 < 30:
        time.sleep(0.05)
    pid = json.loads(Path(out).read_text())["pid"]
    assert _alive(pid)
    res.close()  # 切断（生成器の GeneratorExit → cancel）
    t1 = time.monotonic()
    while _alive(pid) and time.monotonic() - t1 < 15:
        time.sleep(0.05)
    assert not _alive(pid)


# ---- 失敗の分類（本文を持ち出さない） ----

@pytest.mark.parametrize(("status", "aerr", "code"), [
    (429, "rate_limit", "upstream_rate_limited"),
    (401, "authentication_failed", "upstream_auth"),
    (403, None, "upstream_auth"),
    (529, None, "upstream_overloaded"),
    (400, "invalid_request", "upstream_bad_request"),
    (500, "server_error", "upstream_unavailable"),
    (None, "rate_limit", "upstream_rate_limited"),
])
def test_result_error_classified(status, aerr, code):
    msg = AssistantMessage(content=[], model="m", error=aerr)
    fq = FakeQuery([msg], tail=[result(is_error=True, status=status, subtype="success")],
                   raise_after=2,
                   error=ResultError("API Error: secret body " + FAKE_TOKEN, {"api_error_status": status}))
    with pytest.raises(UpstreamError) as ei:
        run(AgentSdkGateway(FAKE_TOKEN, query_fn=fq))
    e = ei.value
    assert e.code == code and e.status == status
    assert FAKE_TOKEN not in str(e) and "secret body" not in repr(e.__dict__)


@pytest.mark.parametrize(("error", "code", "etype"), [
    (ProcessError("boom " + FAKE_TOKEN, exit_code=1, stderr="stderr " + FAKE_TOKEN), "upstream_unavailable",
     "ProcessError"),
    (CLINotFoundError("no cli"), "upstream_unavailable", "CLINotFoundError"),
    (ResultError("x", {"api_error_status": 529}), "upstream_overloaded", "ResultError"),
    (RuntimeError("x " + FAKE_TOKEN), "upstream_unavailable", "RuntimeError"),
])
def test_midstream_exception_classified(error, code, etype):
    fq = FakeQuery(turn_events(), raise_after=4, error=error)
    gw = AgentSdkGateway(FAKE_TOKEN, query_fn=fq)
    got: list = []
    with pytest.raises(UpstreamError) as ei:
        for ev in gw.stream(params(), threading.Event()):
            got.append(ev)
    assert [e["type"] for e in got] == ["meta", "thinking", "thinking"]  # 途中までは流れる
    assert ei.value.code == code and ei.value.error_type == etype
    assert FAKE_TOKEN not in str(ei.value)
    assert fq.closed


def test_relay_maps_rate_limit_to_sse_error(capsys):
    fq = FakeQuery([AssistantMessage(content=[], model="m", error="rate_limit")],
                   tail=[result(is_error=True, status=429)])
    gw = AgentSdkGateway(FAKE_TOKEN, query_fn=fq)
    client, _, _, _ = ai_app(gateway=gw, ai_cfg=ai_settings("oauth_token"), registry=REGISTRY)
    evs = sse_events(post(client, ai_body(context=ai_context(with_precomputed=False))).get_data(as_text=True))
    assert evs[-1] == ("error", {"code": "upstream_rate_limited"})
    rec = ai_request_log(capsys)
    assert rec["upstream_status"] == 429 and rec["error"] == "upstream_rate_limited"
    assert FAKE_TOKEN not in json.dumps(rec)


def test_repr_has_no_token():
    gw = AgentSdkGateway(FAKE_TOKEN)
    assert FAKE_TOKEN not in repr(gw) and FAKE_TOKEN not in str(gw)
    assert "oauth_token" in repr(gw)


def test_name_mapping():
    assert agent_sdk.to_cli_name("tail_table") == "mcp__sim__tail_table"
    assert agent_sdk.from_cli_name("mcp__sim__tail_table") == "tail_table"
    assert agent_sdk.from_cli_name("Bash") == "Bash"  # 中継が登録に無い名前として bad_tool_input にする


def test_sdk_logger_quieted():
    import logging

    AgentSdkGateway(FAKE_TOKEN)
    lg = logging.getLogger("claude_agent_sdk")
    assert lg.propagate is False and lg.level >= logging.WARNING


def test_no_child_left_in_process_tree():
    """このテストのプロセスの子に偽 / 本物の CLI が残っていない（他のテストの後始末の確認）"""
    me = os.getpid()
    kids = []
    for d in Path("/proc").iterdir():
        if d.name.isdigit():
            try:
                stat = (d / "stat").read_text()
            except OSError:
                continue
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
            state = stat.rsplit(")", 1)[1].split()[0]
            if ppid == me and state != "Z":
                kids.append(d.name)
    assert kids == []

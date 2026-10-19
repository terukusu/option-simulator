"""AI の設定と資格情報の渡し方（#134 AC6。K15・ADR-0001）。SDK は本物を使い、送信は httpx2 の MockTransport で
捕まえる（ネットワークに出ない・Anthropic を呼ばない）。"""

import json

import anthropic
import httpx2
import pytest
from support import (
    FAKE_EXCHANGED,
    FAKE_ID_TOKEN,
    FAKE_KEY,
    FAKE_TOKEN,
    FAKE_WIF_ENV,
    ai_app,
    ai_body,
    ai_settings,
    log_records,
    sse_events,
)
from support import ai_post as post

from simulator_api import settings as st
from simulator_api.ai import gateway as gw

BASE_ENV = {"GCP_PROJECT": "example-project"}


def ai_env(**kw):
    return {**BASE_ENV, **kw}


# ---- 設定の組み合わせ ----

def test_unset_or_none_is_disabled(capsys):
    assert st.ai_from_env(BASE_ENV).enabled is False
    assert st.ai_from_env(ai_env(AI_CREDENTIAL="none", ANTHROPIC_API_KEY=FAKE_KEY)).enabled is False
    assert capsys.readouterr().out == ""  # 未設定は WARNING なし


def test_api_key():
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY))
    assert cfg.enabled and cfg.credential == "api_key" and cfg.secret == FAKE_KEY
    assert cfg.budget_store == "firestore" and cfg.counted and cfg.project == "example-project"
    assert cfg.model == "claude-opus-5-5" and cfg.daily_limit_micro_usd == 3_000_000
    assert FAKE_KEY not in repr(cfg)


def test_oauth_token_not_counted():
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="oauth_token", ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN))
    assert cfg.enabled and cfg.secret == FAKE_TOKEN and cfg.budget_store is None and not cfg.counted


def test_fake_uses_memory():
    cfg = st.ai_from_env({"AI_CREDENTIAL": "fake"})
    assert cfg.enabled and cfg.secret is None and cfg.budget_store == "memory"


@pytest.mark.parametrize("env,reason", [
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN),
     "ai_credential_conflict"),
    (ai_env(AI_CREDENTIAL="oauth_token", ANTHROPIC_API_KEY=FAKE_KEY, ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN),
     "ai_credential_conflict"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN), "ai_credential_missing"),
    (ai_env(AI_CREDENTIAL="oauth_token", ANTHROPIC_API_KEY=FAKE_KEY), "ai_credential_missing"),
    (ai_env(AI_CREDENTIAL="key"), "ai_credential_invalid"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_MODEL="claude-unknown"), "ai_model_unpriced"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_DAILY_LIMIT_USD="21"), "ai_daily_limit_invalid"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_DAILY_LIMIT_USD="0"), "ai_daily_limit_invalid"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_DAILY_LIMIT_USD="1e3"),
     "ai_daily_limit_invalid"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_BUDGET_STORE="redis"), "ai_budget_store_invalid"),
    ({"AI_CREDENTIAL": "api_key", "ANTHROPIC_API_KEY": FAKE_KEY}, "ai_budget_project_missing"),
], ids=["both_key", "both_token", "key_missing", "token_missing", "invalid", "model", "limit_big", "limit_zero",
        "limit_exp", "store", "project"])
def test_disabled_with_warning_without_values(capsys, env, reason):
    cfg = st.ai_from_env(env)
    assert cfg.enabled is False and cfg.disabled == reason and cfg.secret is None
    out = capsys.readouterr().out
    rec = log_records(out)[0]
    assert rec["severity"] == "WARNING" and rec["event"] == "ai_disabled" and rec["reason"] == reason
    assert FAKE_KEY not in out and FAKE_TOKEN not in out and "sk-ant-" not in out


@pytest.mark.parametrize("raw,micro", [("3", 3_000_000), ("0.5", 500_000), ("12.25", 12_250_000), ("20", 20_000_000)])
def test_daily_limit(raw, micro):
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_DAILY_LIMIT_USD=raw))
    assert cfg.daily_limit_micro_usd == micro


@pytest.mark.parametrize(("env", "kind"), [
    (ai_env(AI_CREDENTIAL="oauth_token", ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN), "AgentSdkGateway"),
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_BUDGET_STORE="memory"), "AnthropicGateway"),
    (ai_env(AI_CREDENTIAL="wif", AI_BUDGET_STORE="memory", **FAKE_WIF_ENV), "AnthropicGateway"),
    (ai_env(AI_CREDENTIAL="fake"), "FakeGateway"),
    (ai_env(AI_CREDENTIAL="none"), None),
    (ai_env(), None),
], ids=["oauth_token", "api_key", "wif", "fake", "none", "unset"])
def test_credential_selects_gateway(env, kind):
    """AI_CREDENTIAL の切り替え（#186 AC3）: oauth_token → Agent SDK 経由、api_key・wif → anthropic SDK、fake → 偽"""
    from simulator_api.ai.budget import MemoryStore
    from simulator_api.app import _ai_relay

    cfg = st.ai_from_env(env)
    relay = _ai_relay(cfg, None, MemoryStore() if cfg.counted else None, None, lambda: None, lambda: 0.0)
    assert (type(relay.gateway).__name__ if relay.gateway is not None else None) == kind
    if kind == "AgentSdkGateway":
        assert cfg.counted is False and FAKE_TOKEN not in repr(relay.gateway)


def test_api_key_with_memory_store_warns(capsys):
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_BUDGET_STORE="memory"))
    assert cfg.budget_store == "memory"
    assert log_records(capsys.readouterr().out)[0]["event"] == "ai_budget_memory"


def test_disabled_503_reason_logged(capsys):
    client, g, _, _ = ai_app(ai_cfg=st.ai_from_env(ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY,
                                                           ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN)))
    res = post(client, ai_body())
    assert res.status_code == 503 and res.get_json() == {"error": "ai_disabled"}
    out = capsys.readouterr().out
    assert FAKE_KEY not in out and FAKE_TOKEN not in out


# ---- SDK のコンストラクタ ----

def test_client_kwargs_api_key_only():
    kw = gw.client_kwargs("api_key", FAKE_KEY)
    assert kw["api_key"] == FAKE_KEY and "auth_token" not in kw and "default_headers" not in kw
    assert kw["max_retries"] == 0


def test_client_kwargs_oauth_only():
    kw = gw.client_kwargs("oauth_token", FAKE_TOKEN)
    assert kw["auth_token"] == FAKE_TOKEN and "api_key" not in kw
    assert kw["default_headers"] == {"anthropic-beta": "oauth-2025-04-20"}


class Capture:
    """MockTransport の受け口: 要求の見出しと本文を記録し、決めた応答を返す"""

    def __init__(self, status=200, body: bytes = b"", content_type="text/event-stream"):
        self.status = status
        self.body = body
        self.content_type = content_type
        self.requests: list[httpx2.Request] = []

    def __call__(self, request):
        self.requests.append(request)
        return httpx2.Response(self.status, content=self.body, headers={"content-type": self.content_type})


def sdk_gateway(credential, secret, capture):
    def factory(**kw):
        return anthropic.Anthropic(**kw, base_url="http://anthropic.invalid",
                                   http_client=httpx2.Client(transport=httpx2.MockTransport(capture)))

    return gw.AnthropicGateway(credential, secret, factory=factory)


def sse_body(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events).encode()


UPSTREAM = [
    {"type": "message_start", "message": {
        "id": "msg_01", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [],
        "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": 1200, "output_tokens": 1, "cache_creation_input_tokens": 3000,
                  "cache_read_input_tokens": 0}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "考え中"}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "c2ln"}},
    {"type": "content_block_stop", "index": 0},
    {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "下に弱い"}},
    {"type": "content_block_stop", "index": 1},
    {"type": "content_block_start", "index": 2,
     "content_block": {"type": "tool_use", "id": "toolu_01X", "name": "payoff_at", "input": {}}},
    {"type": "content_block_delta", "index": 2,
     "delta": {"type": "input_json_delta", "partial_json": '{"x": 29000, "days": 0}'}},
    {"type": "content_block_stop", "index": 2},
    {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None},
     "usage": {"output_tokens": 240}},
    {"type": "message_stop"},
]


@pytest.mark.parametrize("credential,secret,present,absent", [
    ("api_key", FAKE_KEY, "x-api-key", "authorization"),
    ("oauth_token", FAKE_TOKEN, "authorization", "x-api-key"),
])
def test_sdk_sends_only_selected_credential(monkeypatch, credential, secret, present, absent):
    # 環境変数にもう片方があっても、明示で渡した片方だけが送られる
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-" + "E" * 40)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-" + "E" * 40)
    cap = Capture(body=sse_body(UPSTREAM))
    client, _, store, _ = ai_app(gateway=sdk_gateway(credential, secret, cap), ai_cfg=ai_settings(credential))
    events = sse_events(post(client, ai_body()).get_data(as_text=True))
    assert len(cap.requests) == 1
    h = cap.requests[0].headers
    assert present in h and absent not in h
    if credential == "oauth_token":
        assert h["authorization"] == f"Bearer {FAKE_TOKEN}"
        assert "oauth-2025-04-20" in h["anthropic-beta"]
    else:
        assert h["x-api-key"] == FAKE_KEY and "oauth-2025-04-20" not in h.get("anthropic-beta", "")
    # SDK の事象 → 中継の SSE（thinking・text・tool_use・done）
    assert [e for e, _ in events] == ["accepted", "progress", "thinking", "progress", "text", "progress", "tool_use",
                                      "done"]
    done = events[-1][1]
    assert done["stop_reason"] == "tool_use"
    assert done["content"][0] == {"type": "thinking", "thinking": "考え中", "signature": "c2ln"}
    assert done["content"][1] == {"type": "text", "text": "下に弱い"}
    assert done["content"][2] == {"type": "tool_use", "id": "toolu_01X", "name": "payoff_at",
                                  "input": {"x": 29000, "days": 0}}
    sent = json.loads(cap.requests[0].content)
    assert sent["model"] == "claude-opus-5-5" and sent["stream"] is True
    assert sent["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert sent["output_config"] == {"effort": "medium"} and sent["cache_control"] == {"type": "ephemeral"}


def test_sdk_settles_from_final_usage():
    cap = Capture(body=sse_body(UPSTREAM))
    client, _, store, _ = ai_app(gateway=sdk_gateway("api_key", FAKE_KEY, cap), ai_cfg=ai_settings("api_key"))
    post(client, ai_body()).get_data()
    from simulator_api.ai import budget

    usage = {"input_tokens": 1200, "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 0,
             "output_tokens": 240}
    assert store.charged["2026-10-19"] == budget.cost_micro_usd("claude-opus-5-5", usage)


@pytest.mark.parametrize("status,code", [(401, "upstream_auth"), (403, "upstream_auth"), (429, "upstream_rate_limited"),
                                         (529, "upstream_overloaded"), (400, "upstream_bad_request"),
                                         (500, "upstream_unavailable")])
def test_sdk_errors_classified_without_body(capsys, status, code):
    # 上流の失敗の本文に鍵を含めても、応答・ログには出ない（型名と状態だけ）
    body = json.dumps({"type": "error", "error": {"type": "authentication_error",
                                                  "message": f"invalid x-api-key {FAKE_KEY} {FAKE_TOKEN}"}}).encode()
    cap = Capture(status=status, body=body, content_type="application/json")
    client, _, store, _ = ai_app(gateway=sdk_gateway("api_key", FAKE_KEY, cap), ai_cfg=ai_settings("api_key"))
    res = post(client, ai_body())
    text = res.get_data(as_text=True)
    assert sse_events(text)[-1] == ("error", {"code": code})
    out = capsys.readouterr().out
    for s in (FAKE_KEY, FAKE_TOKEN, "sk-ant-", "invalid x-api-key"):
        assert s not in text and s not in out
    rec = [r for r in log_records(out) if r["event"] == "ai_request"][0]
    assert rec["upstream_status"] == status and rec["error"] == code
    assert len(cap.requests) == 1  # max_retries=0（再試行しない）


def test_sdk_connection_error(capsys):
    def boom(request):
        raise httpx2.ConnectError(f"refused {FAKE_KEY}")

    client, _, _, _ = ai_app(gateway=sdk_gateway("api_key", FAKE_KEY, boom), ai_cfg=ai_settings("api_key"))
    text = post(client, ai_body()).get_data(as_text=True)
    assert sse_events(text)[-1] == ("error", {"code": "upstream_unavailable"})
    out = capsys.readouterr().out
    assert FAKE_KEY not in out and FAKE_KEY not in text


def test_gateway_repr_hides_secret():
    g = gw.AnthropicGateway("api_key", FAKE_KEY)
    assert FAKE_KEY not in repr(g)


# ---- Anthropic の WIF（#184。ADR-0001 の追補）----

WIF_REQUIRED = {k: FAKE_WIF_ENV[k] for k in ("ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID")}


def wif_values_absent(text: str):
    for v in (*FAKE_WIF_ENV.values(), FAKE_ID_TOKEN, FAKE_EXCHANGED, FAKE_KEY, FAKE_TOKEN):
        assert v not in text
    assert "sk-ant-" not in text


def test_wif_counted_like_api_key():
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="wif", **FAKE_WIF_ENV))
    assert cfg.enabled and cfg.credential == "wif" and cfg.secret is None
    assert cfg.budget_store == "firestore" and cfg.counted and cfg.project == "example-project"
    assert cfg.wif == st.WifIds(*FAKE_WIF_ENV.values())
    wif_values_absent(repr(cfg))


def test_wif_optional_ids():
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="wif", ANTHROPIC_WORKSPACE_ID="", **WIF_REQUIRED))
    assert cfg.enabled and cfg.wif.service_account_id is None and cfg.wif.workspace_id is None


def test_wif_memory_store_warns(capsys):
    cfg = st.ai_from_env(ai_env(AI_CREDENTIAL="wif", AI_BUDGET_STORE="memory", **WIF_REQUIRED))
    assert cfg.budget_store == "memory" and cfg.counted
    assert log_records(capsys.readouterr().out)[0]["event"] == "ai_budget_memory"


@pytest.mark.parametrize("env,reason", [
    (ai_env(AI_CREDENTIAL="wif", ANTHROPIC_API_KEY=FAKE_KEY, **FAKE_WIF_ENV), "ai_credential_conflict"),
    (ai_env(AI_CREDENTIAL="wif", ANTHROPIC_AUTH_TOKEN=FAKE_TOKEN, **FAKE_WIF_ENV), "ai_credential_conflict"),
    (ai_env(AI_CREDENTIAL="wif", ANTHROPIC_ORGANIZATION_ID=FAKE_WIF_ENV["ANTHROPIC_ORGANIZATION_ID"]),
     "ai_credential_missing"),
    (ai_env(AI_CREDENTIAL="wif", ANTHROPIC_FEDERATION_RULE_ID=FAKE_WIF_ENV["ANTHROPIC_FEDERATION_RULE_ID"]),
     "ai_credential_missing"),
    (ai_env(AI_CREDENTIAL="wif", **{**FAKE_WIF_ENV, "ANTHROPIC_ORGANIZATION_ID": "fdrl_not_a_uuid"}),
     "ai_wif_invalid"),
    (ai_env(AI_CREDENTIAL="wif", **{**FAKE_WIF_ENV, "ANTHROPIC_FEDERATION_RULE_ID": "fdrl x"}), "ai_wif_invalid"),
    (ai_env(AI_CREDENTIAL="wif", **{**FAKE_WIF_ENV, "ANTHROPIC_SERVICE_ACCOUNT_ID": "svac/../x"}), "ai_wif_invalid"),
    (ai_env(AI_CREDENTIAL="wif", **{**FAKE_WIF_ENV, "ANTHROPIC_WORKSPACE_ID": "w" * 129}), "ai_wif_invalid"),
    ({"AI_CREDENTIAL": "wif", **FAKE_WIF_ENV}, "ai_budget_project_missing"),
], ids=["key", "token", "no_rule", "no_org", "org_shape", "rule_shape", "sa_shape", "ws_long", "project"])
def test_wif_disabled_with_warning_without_values(capsys, env, reason):
    cfg = st.ai_from_env(env)
    assert cfg.enabled is False and cfg.disabled == reason and cfg.wif is None
    out = capsys.readouterr().out
    rec = log_records(out)[0]
    assert rec["event"] == "ai_disabled" and rec["reason"] == reason
    for v in FAKE_WIF_ENV.values():
        assert v not in out
    assert FAKE_KEY not in out and FAKE_TOKEN not in out


def test_client_kwargs_wif_only():
    kw = gw.client_kwargs("wif", None, ai_settings("wif").wif, identity_token=lambda: FAKE_ID_TOKEN)
    assert isinstance(kw["credentials"], anthropic.WorkloadIdentityCredentials)
    assert "api_key" not in kw and "auth_token" not in kw and "default_headers" not in kw
    assert kw["max_retries"] == 0
    # 交換のタイムアウトは締め切りの中に収まる値（SDK の既定 30 秒ではない）
    timeout = kw["credentials"]._http_client.timeout
    assert timeout.read == st.AI_TOKEN_EXCHANGE_TIMEOUT_SECONDS and timeout.connect == st.AI_CONNECT_TIMEOUT_SECONDS
    assert 2 * (st.AI_IDENTITY_TOKEN_TIMEOUT_SECONDS + st.AI_TOKEN_EXCHANGE_TIMEOUT_SECONDS) < st.AI_DEADLINE_SECONDS
    kw["credentials"]._http_client.close()


class WifUpstream:
    """WIF の交換（POST /v1/oauth/token）と /v1/messages の両方を受ける偽の Anthropic"""

    def __init__(self, exchange_status=200, messages_body: bytes | None = None, expires_in=600, statuses=None):
        self.exchange_status = exchange_status
        self.statuses = list(statuses or [])  # 交換ごとの状態（尽きたら exchange_status）
        self.expires_in = expires_in
        self.messages = Capture(body=sse_body(UPSTREAM) if messages_body is None else messages_body)
        self.exchanges: list[httpx2.Request] = []

    def __call__(self, request):
        if request.url.path == "/v1/oauth/token":
            self.exchanges.append(request)
            status = self.statuses.pop(0) if self.statuses else self.exchange_status
            if status != 200:
                body = {"type": "error", "error": {"type": "authentication_error",
                                                   "message": f"Authentication failed {FAKE_ID_TOKEN}"}}
                return httpx2.Response(status, json=body)
            return httpx2.Response(200, json={"access_token": FAKE_EXCHANGED, "token_type": "bearer",
                                              "expires_in": self.expires_in})
        return self.messages(request)


def wif_gateway(upstream, identity_token=lambda: FAKE_ID_TOKEN):
    http = httpx2.Client(transport=httpx2.MockTransport(upstream))

    def factory(**kw):
        return anthropic.Anthropic(**kw, base_url="https://anthropic.invalid", http_client=http)

    return gw.AnthropicGateway("wif", None, factory=factory, wif=ai_settings("wif").wif,
                               identity_token=identity_token, exchange_http_client=http)


def test_sdk_wif_exchanges_and_sends_bearer_only(monkeypatch, capsys):
    # 環境変数にキー・トークンがあっても送られない（credentials= を明示で渡すので SDK は環境変数を読まない）
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-" + "E" * 40)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-" + "E" * 40)
    up = WifUpstream()
    client, _, store, _ = ai_app(gateway=wif_gateway(up), ai_cfg=ai_settings("wif"))
    text = post(client, ai_body()).get_data(as_text=True)
    assert [e for e, _ in sse_events(text)][-1] == "done"
    assert len(up.exchanges) == 1 and len(up.messages.requests) == 1
    sent = json.loads(up.exchanges[0].content)
    assert sent == {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": FAKE_ID_TOKEN,
                    "federation_rule_id": FAKE_WIF_ENV["ANTHROPIC_FEDERATION_RULE_ID"],
                    "organization_id": FAKE_WIF_ENV["ANTHROPIC_ORGANIZATION_ID"],
                    "service_account_id": FAKE_WIF_ENV["ANTHROPIC_SERVICE_ACCOUNT_ID"],
                    "workspace_id": FAKE_WIF_ENV["ANTHROPIC_WORKSPACE_ID"]}
    for r in (*up.exchanges, *up.messages.requests):
        assert "x-api-key" not in r.headers
    h = up.messages.requests[0].headers
    assert h["authorization"] == f"Bearer {FAKE_EXCHANGED}"
    assert "oauth-2025-04-20" in h["anthropic-beta"]
    # 2 回目は交換したトークンを使い回す（SDK の TokenCache）
    post(client, ai_body()).get_data()
    assert len(up.exchanges) == 1 and len(up.messages.requests) == 2
    out = capsys.readouterr().out
    wif_values_absent(text + out)


def test_sdk_wif_settles_from_final_usage():
    from simulator_api.ai import budget

    up = WifUpstream()
    client, _, store, _ = ai_app(gateway=wif_gateway(up), ai_cfg=ai_settings("wif"))
    post(client, ai_body()).get_data()
    usage = {"input_tokens": 1200, "cache_creation_input_tokens": 3000, "cache_read_input_tokens": 0,
             "output_tokens": 240}
    assert store.charged["2026-10-19"] == budget.cost_micro_usd("claude-opus-5-5", usage)


@pytest.mark.parametrize("status,code", [(401, "upstream_auth"), (403, "upstream_auth"),
                                         (500, "upstream_unavailable")])
def test_sdk_wif_exchange_failure(capsys, status, code):
    up = WifUpstream(exchange_status=status)
    client, _, store, _ = ai_app(gateway=wif_gateway(up), ai_cfg=ai_settings("wif"))
    text = post(client, ai_body()).get_data(as_text=True)
    assert sse_events(text)[-1] == ("error", {"code": code})
    assert len(up.messages.requests) == 0  # 交換に失敗したら /v1/messages を呼ばない
    assert len(up.exchanges) == (2 if status == 401 else 1)  # 401 だけ SDK の TokenCache が 1 回試し直す
    out = capsys.readouterr().out
    rec = [r for r in log_records(out) if r["event"] == "ai_request"][0]
    assert rec["error"] == code and rec["upstream_status"] == status and rec["credential"] == "wif"
    wif_values_absent(text + out)
    assert "Authentication failed" not in text + out


def test_sdk_wif_identity_token_unavailable(capsys):
    def no_token():
        raise gw.IdentityTokenError("URLError")

    up = WifUpstream()
    client, _, _, _ = ai_app(gateway=wif_gateway(up, identity_token=no_token), ai_cfg=ai_settings("wif"))
    text = post(client, ai_body()).get_data(as_text=True)
    assert sse_events(text)[-1] == ("error", {"code": "upstream_auth"})
    assert up.exchanges == [] and up.messages.requests == []
    out = capsys.readouterr().out
    rec = [r for r in log_records(out) if r["event"] == "ai_request"][0]
    assert rec["error"] == "upstream_auth" and rec["error_type"] == "IdentityTokenError"
    wif_values_absent(text + out)


def test_sdk_wif_fetches_identity_token_each_exchange():
    # Google の ID トークンは約 1 時間で切れるので、交換のたびに取り直す（中継・SDK でキャッシュしない）。
    # expires_in 10 秒 = SDK の必須の更新の窓の中なので、要求ごとに交換する
    calls = []

    def provider():
        calls.append(1)
        return FAKE_ID_TOKEN

    up = WifUpstream(expires_in=10)
    client, _, _, _ = ai_app(gateway=wif_gateway(up, identity_token=provider), ai_cfg=ai_settings("wif"))
    for _ in range(2):
        post(client, ai_body()).get_data()
    assert len(calls) == 2 and len(up.exchanges) == 2 and len(up.messages.requests) == 2


def test_sdk_warning_replaced_without_body(capsys):
    # 期限の手前（SDK の advisory の窓。残り 30〜120 秒）の交換し直しが失敗すると、SDK は交換の失敗の本文を
    # WARNING に書いて古いトークンで続ける。stderr（Python の lastResort）にも stdout にも本文を出さず、
    # 本文なしの ai_sdk_warning にする
    up = WifUpstream(expires_in=75, statuses=[200, 401, 401])
    client, _, _, _ = ai_app(gateway=wif_gateway(up), ai_cfg=ai_settings("wif"))
    first = post(client, ai_body()).get_data(as_text=True)
    second = post(client, ai_body()).get_data(as_text=True)
    assert sse_events(first)[-1][0] == "done" and sse_events(second)[-1][0] == "done"
    assert len(up.exchanges) == 3 and len(up.messages.requests) == 2
    cap = capsys.readouterr()
    assert cap.err == ""
    recs = [r for r in log_records(cap.out) if r["event"] == "ai_sdk_warning"]
    assert len(recs) == 1
    assert recs[0]["error_type"] == "WorkloadIdentityError" and recs[0]["upstream_status"] == 401
    assert recs[0]["logger"].startswith("anthropic")
    wif_values_absent(cap.out + first + second)
    assert "Authentication failed" not in cap.out and "Token exchange failed" not in cap.out


def test_quiet_sdk_logs_idempotent():
    import logging

    gw.quiet_sdk_logs()
    gw.quiet_sdk_logs()
    sdk = logging.getLogger("anthropic")
    assert sum(isinstance(h, gw._SdkLogBridge) for h in sdk.handlers) == 1
    assert sdk.propagate is False and sdk.level == logging.WARNING


# ---- ID トークン（メタデータサーバー。偽の opener でネットワークに出ない）----

class FakeOpener:
    def __init__(self, body: bytes = FAKE_ID_TOKEN.encode(), error: Exception | None = None):
        self.body = body
        self.error = error
        self.requests = []

    def open(self, req, timeout=None):
        import io

        self.requests.append((req, timeout))
        if self.error is not None:
            raise self.error
        return io.BytesIO(self.body)


def test_metadata_identity_token_request():
    op = FakeOpener()
    assert gw.metadata_identity_token(op) == FAKE_ID_TOKEN
    assert gw.metadata_identity_token(op) == FAKE_ID_TOKEN
    assert len(op.requests) == 2  # 呼ぶたびにメタデータサーバーへ（キャッシュしない）
    req, timeout = op.requests[0]
    assert req.full_url == ("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/"
                            "identity?audience=https://api.anthropic.com&format=full")
    assert req.get_header("Metadata-flavor") == "Google" and req.get_method() == "GET"
    assert timeout == st.AI_IDENTITY_TOKEN_TIMEOUT_SECONDS


@pytest.mark.parametrize("opener", [
    FakeOpener(error=OSError("metadata.google.internal unreachable")),
    FakeOpener(body=b"<html>not a token</html>"),
    FakeOpener(body=b"a.b.c" + b"x" * (16 * 1024)),
    FakeOpener(body="\u3042.\u3044.\u3046".encode()),
], ids=["unreachable", "not_jwt", "too_big", "not_ascii"])
def test_metadata_identity_token_errors_without_body(opener):
    with pytest.raises(gw.IdentityTokenError) as e:
        gw.metadata_identity_token(opener)
    assert "not a token" not in str(e.value) and "unreachable" not in str(e.value)

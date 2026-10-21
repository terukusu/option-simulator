"""AI の設定と送信先の選び方（#134 AC6・#221 AC8。K15・ADR-0001・ADR-0006）。資格情報の子への渡し方は
tests/test_ai_agent_sdk.py（偽の CLI）と tests/test_ai_agent_sdk_cli.py（本物の CLI と偽の Messages API）。
ネットワークに出ない・Anthropic を呼ばない。"""

import logging

import pytest
from support import (
    FAKE_ID_TOKEN,
    FAKE_KEY,
    FAKE_TOKEN,
    FAKE_WIF_ENV,
    ai_app,
    ai_body,
    log_records,
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
    (ai_env(AI_CREDENTIAL="api_key", ANTHROPIC_API_KEY=FAKE_KEY, AI_BUDGET_STORE="memory"), "AgentSdkGateway"),
    (ai_env(AI_CREDENTIAL="wif", AI_BUDGET_STORE="memory", **FAKE_WIF_ENV), "AgentSdkGateway"),
    (ai_env(AI_CREDENTIAL="fake"), "FakeGateway"),
    (ai_env(AI_CREDENTIAL="none"), None),
    (ai_env(), None),
], ids=["oauth_token", "api_key", "wif", "fake", "none", "unset"])
def test_credential_selects_gateway(env, kind):
    """AI_CREDENTIAL の切り替え（#186 AC3・#221 AC8）: oauth_token・api_key・wif → Agent SDK 経由（資格情報の種類を
    渡す）、fake → 偽"""
    from simulator_api.ai.budget import MemoryStore
    from simulator_api.app import _ai_relay

    cfg = st.ai_from_env(env)
    relay = _ai_relay(cfg, None, MemoryStore() if cfg.counted else None, None, lambda: None, lambda: 0.0)
    assert (type(relay.gateway).__name__ if relay.gateway is not None else None) == kind
    if kind == "AgentSdkGateway":
        assert repr(relay.gateway) == f"AgentSdkGateway(credential={cfg.credential!r})"
        assert cfg.counted is (cfg.credential != "oauth_token")
        for v in (FAKE_TOKEN, FAKE_KEY, *FAKE_WIF_ENV.values()):
            assert v not in repr(relay.gateway)


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


# ---- Anthropic の WIF（#184。ADR-0001 の追補）----

WIF_REQUIRED = {k: FAKE_WIF_ENV[k] for k in ("ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID")}


def wif_values_absent(text: str):
    for v in (*FAKE_WIF_ENV.values(), FAKE_ID_TOKEN, FAKE_KEY, FAKE_TOKEN):
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


def test_quiet_sdk_logs_idempotent():
    gw.quiet_sdk_logs()
    gw.quiet_sdk_logs()
    sdk = logging.getLogger("claude_agent_sdk")
    assert sum(isinstance(h, gw._SdkLogBridge) for h in sdk.handlers) == 1
    assert sdk.propagate is False and sdk.level == logging.WARNING


def test_sdk_warning_replaced_without_body(capsys):
    # SDK の WARNING は本文なしの ai_sdk_warning に置き換わる（stderr にも stdout にも本文を出さない）
    class Boom(Exception):
        status_code = 401

    gw.quiet_sdk_logs()
    logging.getLogger("claude_agent_sdk._internal").warning("failed %s %s", Boom(f"body {FAKE_TOKEN}"), FAKE_KEY)
    logging.getLogger("claude_agent_sdk").info("info %s", FAKE_TOKEN)  # INFO 以下は作らない
    cap = capsys.readouterr()
    assert cap.err == ""
    recs = [r for r in log_records(cap.out) if r["event"] == "ai_sdk_warning"]
    assert len(recs) == 1
    assert recs[0]["error_type"] == "Boom" and recs[0]["upstream_status"] == 401
    assert recs[0]["logger"] == "claude_agent_sdk._internal"
    assert FAKE_TOKEN not in cap.out and FAKE_KEY not in cap.out and "body" not in cap.out


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

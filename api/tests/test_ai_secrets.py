"""鍵の形の値が応答・ログに出ないこと（#134 AC6・EPIC #141 終了条件 5）。値は架空（support.FAKE_KEY・FAKE_TOKEN）。

環境変数に鍵の形の値を入れ、全エンドポイントの応答（本文と見出し）と、上流の認証エラー（本文に鍵を含む）・成功の
ときのログ（stdout）を集め、sk-ant- の形が 0 件であることを確かめる。送信先は本物の同梱 CLI と 127.0.0.1 の偽の
Messages API（#221 で送信路を Claude Agent SDK に一本化。Anthropic は呼ばない）。
"""

import json
import re

import pytest
from fake_messages_api import FakeMessagesApi
from support import (
    FAKE_EXCHANGED,
    FAKE_ID_TOKEN,
    FAKE_KEY,
    FAKE_TOKEN,
    FAKE_WIF_ENV,
    SAME_ORIGIN,
    Clock,
    FakeRunner,
    World,
    ai_body,
    ai_registry,
    jst,
    load_fixture,
)
from test_ai_agent_sdk_cli import BUNDLED

from simulator_api import settings as st
from simulator_api.ai.agent_sdk import AgentSdkGateway
from simulator_api.app import create_app

pytestmark = pytest.mark.skipif(BUNDLED is None or not BUNDLED.exists(),
                                reason="同梱の Claude Code CLI が無い（wheel の無いプラットフォーム）")

KEY_SHAPE = re.compile(r"sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}")  # .github/scripts/repo-values-check.sh と同じ


def make(credential, api):
    env = {"GCP_PROJECT": "example-project", "AI_CREDENTIAL": credential, "AI_BUDGET_STORE": "memory"}
    if credential == "wif":
        env.update(FAKE_WIF_ENV)
    else:
        env["ANTHROPIC_API_KEY" if credential == "api_key" else "ANTHROPIC_AUTH_TOKEN"] = (
            FAKE_KEY if credential == "api_key" else FAKE_TOKEN)
    ai_cfg = st.ai_from_env(env)
    world = World()
    world.add_fixture(load_fixture("latest"))
    clock = Clock(jst(2026, 10, 13, 21, 46))
    secret = ai_cfg.secret  # 環境変数から中継が選んだ片方
    gateway = AgentSdkGateway(secret, credential=credential, wif=ai_cfg.wif, identity_token=lambda: FAKE_ID_TOKEN,
                              extra_env={"ANTHROPIC_BASE_URL": api.base_url})
    app = create_app(runner=FakeRunner(world), clock=clock, monotonic=clock.monotonic,
                     cfg=st.Settings(project="example-project"), ai_cfg=ai_cfg, ai_gateway=gateway,
                     ai_registry=ai_registry())
    return app.test_client()


def dump(res) -> str:
    return json.dumps(dict(res.headers)) + res.get_data(as_text=True)


@pytest.mark.parametrize("credential", ["api_key", "oauth_token", "wif"])
@pytest.mark.parametrize("upstream", ["ok", "auth_error"])
def test_no_key_shape_in_responses_or_logs(capsys, monkeypatch, credential, upstream):
    monkeypatch.setenv("CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK", "1")
    # 失敗の本文に鍵・トークン・ID トークンを含めても出ない。wif は交換の成否（キーの形の値は交換で返るトークン）
    message = f"bad credential {FAKE_KEY} / {FAKE_TOKEN} / {FAKE_ID_TOKEN}"
    if credential == "wif":
        api = FakeMessagesApi("text", exchange_status=200 if upstream == "ok" else 401, error_message=message,
                              exchanged=FAKE_EXCHANGED)
    else:
        api = FakeMessagesApi("text" if upstream == "ok" else "err401", error_message=message)
    with api:
        client = make(credential, api)
        seen = []
        for path in ("/healthz", "/api/chain", "/api/calendar", "/api/atm_iv?tf=1h", "/api/atm_daily",
                     "/api/ai/status"):
            seen.append(dump(client.get(path)))
        seen.append(dump(client.post("/api/ai/messages", data=json.dumps(ai_body()), headers=SAME_ORIGIN,
                                     content_type="application/json")))
        # 拒否の応答（400・403・415）も
        seen.append(dump(client.post("/api/ai/messages", data=json.dumps({"x": FAKE_KEY}), headers=SAME_ORIGIN,
                                     content_type="application/json")))
        seen.append(dump(client.post("/api/ai/messages", data="{}", content_type="application/json")))
        seen.append(dump(client.post("/api/ai/messages", data="{}", headers=SAME_ORIGIN, content_type="text/plain")))
        exchanges, posts = api.exchanges(), api.posts()
    if credential == "wif":  # 交換に失敗したら /v1/messages を呼ばない
        assert len(exchanges) == 1
        assert len(posts) == (1 if upstream == "ok" else 0)
    else:
        assert exchanges == [] and len(posts) == 1
    out = capsys.readouterr().out
    assert out  # ログは出ている（ai_request など）
    for text in [*seen, out]:
        assert not KEY_SHAPE.search(text)
        assert FAKE_KEY not in text and FAKE_TOKEN not in text
        assert FAKE_ID_TOKEN not in text and FAKE_EXCHANGED not in text
        for v in FAKE_WIF_ENV.values():  # WIF の ID（個人の値）も応答・ログに出さない
            assert v not in text
    events = [json.loads(line).get("event") for line in out.splitlines() if line.startswith("{")]
    assert "ai_request" in events

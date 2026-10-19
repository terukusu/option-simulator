"""鍵の形の値が応答・ログに出ないこと（#134 AC6・EPIC #141 終了条件 5）。値は架空（support.FAKE_KEY・FAKE_TOKEN）。

環境変数に鍵の形の値を入れ、全エンドポイントの応答（本文と見出し）と、上流の認証エラー（本文に鍵を含む）・成功の
ときのログ（stdout）を集め、sk-ant- の形が 0 件であることを確かめる。
"""

import json
import re

import pytest
from support import FAKE_KEY, FAKE_TOKEN, SAME_ORIGIN, Clock, FakeRunner, World, ai_body, ai_registry, jst, load_fixture
from test_ai_settings import UPSTREAM, Capture, sdk_gateway, sse_body

from simulator_api import settings as st
from simulator_api.app import create_app

KEY_SHAPE = re.compile(r"sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}")  # .github/scripts/repo-values-check.sh と同じ


def make(credential, capture):
    env = {"GCP_PROJECT": "example-project", "AI_CREDENTIAL": credential, "AI_BUDGET_STORE": "memory",
           "ANTHROPIC_API_KEY" if credential == "api_key" else "ANTHROPIC_AUTH_TOKEN":
               FAKE_KEY if credential == "api_key" else FAKE_TOKEN}
    ai_cfg = st.ai_from_env(env)
    world = World()
    world.add_fixture(load_fixture("latest"))
    clock = Clock(jst(2026, 10, 13, 21, 46))
    secret = ai_cfg.secret  # 環境変数から中継が選んだ片方
    app = create_app(runner=FakeRunner(world), clock=clock, monotonic=clock.monotonic,
                     cfg=st.Settings(project="example-project"), ai_cfg=ai_cfg,
                     ai_gateway=sdk_gateway(credential, secret, capture), ai_registry=ai_registry())
    return app.test_client()


def dump(res) -> str:
    return json.dumps(dict(res.headers)) + res.get_data(as_text=True)


@pytest.mark.parametrize("credential", ["api_key", "oauth_token"])
@pytest.mark.parametrize("upstream", ["ok", "auth_error"])
def test_no_key_shape_in_responses_or_logs(capsys, credential, upstream):
    if upstream == "ok":
        cap = Capture(body=sse_body(UPSTREAM))
    else:
        body = json.dumps({"type": "error", "error": {"type": "authentication_error",
                                                      "message": f"bad credential {FAKE_KEY} / {FAKE_TOKEN}"}})
        cap = Capture(status=401, body=body.encode(), content_type="application/json")
    client = make(credential, cap)
    seen = []
    for path in ("/healthz", "/api/chain", "/api/calendar", "/api/atm_iv?tf=1h", "/api/atm_daily", "/api/ai/status"):
        seen.append(dump(client.get(path)))
    seen.append(dump(client.post("/api/ai/messages", data=json.dumps(ai_body()), headers=SAME_ORIGIN,
                                 content_type="application/json")))
    # 拒否の応答（400・403・415）も
    seen.append(dump(client.post("/api/ai/messages", data=json.dumps({"x": FAKE_KEY}), headers=SAME_ORIGIN,
                                 content_type="application/json")))
    seen.append(dump(client.post("/api/ai/messages", data="{}", content_type="application/json")))
    seen.append(dump(client.post("/api/ai/messages", data="{}", headers=SAME_ORIGIN, content_type="text/plain")))
    assert len(cap.requests) == 1
    out = capsys.readouterr().out
    assert out  # ログは出ている（ai_request など）
    for text in [*seen, out]:
        assert not KEY_SHAPE.search(text)
        assert FAKE_KEY not in text and FAKE_TOKEN not in text
    events = [json.loads(line).get("event") for line in out.splitlines() if line.startswith("{")]
    assert "ai_request" in events

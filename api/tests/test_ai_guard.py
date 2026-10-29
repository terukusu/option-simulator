"""エンドポイントの守り（#134 AC5。docs/ai-advisor.md 論点 8 = A）。どの拒否も送信 0 回・計上 0。"""

import threading

import pytest
from support import ai_app, ai_body
from support import ai_post as post

from simulator_api import settings as st
from simulator_api.ai import guard
from simulator_api.ai.gateway import FakeGateway


@pytest.mark.parametrize("headers", [
    {"Sec-Fetch-Site": "cross-site", "Origin": "http://localhost"},
    {"Sec-Fetch-Site": "same-site"},
    {"Sec-Fetch-Site": "none"},
    {"Origin": "https://evil.example.com"},
    {"Sec-Fetch-Site": "same-origin", "Origin": "https://evil.example.com"},
    {"Origin": "null"},
    {},
], ids=["cross_site", "same_site", "none", "other_origin", "same_origin_but_other_origin", "null_origin", "neither"])
def test_forbidden_origin(headers):
    client, gw, store, _ = ai_app()
    res = post(client, ai_body(), headers=headers)
    assert res.status_code == 403 and res.get_json() == {"error": "forbidden"}
    assert gw.count() == 0 and store.charged == {}


@pytest.mark.parametrize("headers", [{"Sec-Fetch-Site": "same-origin"}, {"Origin": "http://localhost"}])
def test_either_header_is_enough(headers):
    client, gw, _, _ = ai_app()
    res = post(client, ai_body(), headers=headers)
    assert res.status_code == 200
    res.get_data()
    assert gw.count() == 1


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data",
                                   "application/jsonx"])
def test_unsupported_media_type(ctype):
    client, gw, store, _ = ai_app()
    res = post(client, ai_body(), content_type=ctype)
    assert res.status_code == 415 and res.get_json() == {"error": "unsupported_media_type"}
    assert gw.count() == 0 and store.charged == {}


def test_json_with_charset_ok():
    client, gw, _, _ = ai_app()
    res = post(client, ai_body(), content_type="application/json; charset=utf-8")
    assert res.status_code == 200
    res.get_data()


def test_too_large_413():
    client, gw, store, _ = ai_app()
    res = post(client, None, raw=b" " * (st.AI_MAX_BODY_BYTES + 1))
    assert res.status_code == 413 and res.get_json() == {"error": "too_large"}
    assert gw.count() == 0 and store.charged == {}


def test_concurrency_429_busy():
    gate = threading.Event()
    client, gw, store, _ = ai_app(gateway=FakeGateway(gate=gate))
    open_ = []
    for _ in range(st.AI_MAX_CONCURRENT):
        res = post(client, ai_body(), buffered=False)
        it = iter(res.response)
        next(it)  # accepted まで進めて枠を持ったまま
        open_.append((res, it))
    charged = dict(store.charged)
    res = post(client, ai_body())
    assert res.status_code == 429 and res.get_json() == {"error": "busy"}
    assert store.charged == charged  # 予約しない
    gate.set()
    for r, it in open_:
        b"".join(it)
        r.close()
    assert gw.count() == st.AI_MAX_CONCURRENT
    res = post(client, ai_body())
    assert res.status_code == 200
    res.get_data()


def test_rate_limit_429():
    client, gw, store, clock = ai_app()
    for _ in range(st.AI_RATE_PER_MINUTE):
        res = post(client, ai_body())
        assert res.status_code == 200
        res.get_data()
    res = post(client, ai_body())
    assert res.status_code == 429 and res.get_json() == {"error": "rate_limited"}
    assert gw.count() == st.AI_RATE_PER_MINUTE
    clock.advance(60)
    res = post(client, ai_body())
    assert res.status_code == 200
    res.get_data()


def test_rate_limit_window():
    t = [0.0]
    rl = guard.RateLimit(2, 60.0, lambda: t[0])
    assert rl.allow() and rl.allow() and not rl.allow()
    t[0] = 59.9
    assert not rl.allow()
    t[0] = 60.0
    assert rl.allow()


def test_get_not_allowed():
    client, gw, _, _ = ai_app()
    assert client.get("/api/ai/messages").status_code == 405
    assert gw.count() == 0

"""建玉の一覧の画像の読み取り（POST /api/ai/read_positions。#318 AC5）。偽の送信先（FakeGateway）とメモリの計上。
Anthropic は呼ばない。画像はテストの中で合成する（support.png_bytes・jpeg_bytes。値は架空）。"""

import base64
import copy
import json
import threading

import pytest
from support import (
    SAME_ORIGIN,
    ai_app,
    ai_body,
    jpeg_bytes,
    log_records,
    png_bytes,
    read_body,
    read_post,
)
from support import ai_post as post

from simulator_api import settings as st
from simulator_api.ai import budget
from simulator_api.ai import read_positions as rp
from simulator_api.ai.budget import MemoryStore
from simulator_api.ai.gateway import FakeGateway, UpstreamError
from simulator_api.ai.shape import Bad

DAY = "2026-10-19"  # support.ai_app の時計（JST 2026-10-19 21:00）
SECRET = "SECRETNAME_q7Zx"  # 合成の画像に埋めた架空の文字列（ログ・応答に出ないこと）
PNG = png_bytes(64, 48, text=SECRET)
ROW = {"product": "op_large", "expiry_year": 2026, "expiry_month": 12, "type": "P", "strike": 60000,
       "side": "sell", "qty": 2, "price": 150, "opened_on": "2026-10-01"}
FUT = {"product": "fut_mini", "expiry_year": 2026, "expiry_month": 12, "type": None, "strike": None,
       "side": "buy", "qty": 1, "price": 66000, "opened_on": "2026-10-02"}


def report(result, extra=()):
    """report_positions の tool_use を返す台本（先頭に thinking・text。text・thinking はブラウザに返らない）"""
    return [{"type": "thinking", "text": "THINKING_SECRET_x1"}, {"type": "text", "text": "TEXT_SECRET_x2"},
            *extra, {"type": "tool_use", "id": "toolu_r1", "name": "report_positions", "input": result}]


def gw_with(result, **kw) -> FakeGateway:
    return FakeGateway(read_script=report(result), **kw)


def logs(capsys, event=None):
    recs = log_records(capsys.readouterr().out)
    return [r for r in recs if event is None or r.get("event") == event]


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


# ---- 成功・送るもの ----

def test_reads_rows_and_sends_only_image_and_fixed_text(capsys):
    client, gw, store, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [ROW, FUT]}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200 and res.headers["Cache-Control"] == "no-store"
    body = res.get_json()
    assert body["schema_version"] == 1 and body["kind"] == "positions"
    assert body["rows"] == [ROW, FUT]
    assert body["remaining_usd"] is not None
    assert set(body) == {"schema_version", "kind", "rows", "remaining_usd"}
    text = res.get_data(as_text=True)
    assert "THINKING_SECRET_x1" not in text and "TEXT_SECRET_x2" not in text  # text・thinking は返さない
    params = gw.calls[0]
    assert params["mode"] == "read" and params["system"] == rp.READ_SYSTEM
    assert params["max_tokens"] == st.AI_READ_MAX_TOKENS == 6000
    assert params["output_config"] == {"effort": "low"}
    assert params["tools"] == [rp.TOOL_DEFINITION]
    assert "server_tools" not in params
    # 送る messages は user 1 件 = 画像（送ったバイトのまま）+ 決まった文だけ（板・ポジション・前提は無い）
    assert params["messages"] == [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64(PNG)}},
        {"type": "text", "text": rp.READ_TEXT}]}]
    rec = logs(capsys, "ai_request")[0]
    assert rec["kind"] == "read_positions" and rec["result_kind"] == "positions" and rec["rows"] == 2
    assert rec["media_type"] == "image/png" and rec["image_bytes"] == len(PNG)
    assert (rec["width"], rec["height"]) == (64, 48)
    assert store.charged[DAY] == budget.cost_micro_usd("claude-opus-5-5", FakeGateway.DEFAULT_USAGE)


def test_jpeg_accepted():
    client, gw, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [ROW]}))
    res = read_post(client, read_body(jpeg_bytes(900, 2000), "image/jpeg"))
    assert res.status_code == 200 and len(res.get_json()["rows"]) == 1
    assert gw.calls[0]["messages"][0]["content"][0]["source"]["media_type"] == "image/jpeg"


def test_not_positions_returns_empty_rows():
    client, _, _, _ = ai_app(gateway=gw_with({"kind": "not_positions", "rows": [ROW]}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200 and res.get_json()["kind"] == "not_positions" and res.get_json()["rows"] == []


def test_default_fake_gateway_reads_synthetic_rows():
    # AI_CREDENTIAL=fake の既定の台本（手元の確かめ用）
    client, _, _, _ = ai_app()
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200 and len(res.get_json()["rows"]) == 2


# ---- 許可リスト（要求）: 400 / 413 で送らない・値を反射しない ----

def _bad_bodies():
    big = png_bytes(st.AI_IMAGE_MAX_EDGE + 1, 4)
    tall = png_bytes(4, st.AI_IMAGE_MAX_EDGE + 1)
    return {
        "gif": read_body(b"GIF89a" + b"\x00" * 20, "image/gif"),
        "webp": read_body(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),
        "text": read_body(b"plain", "text/plain"),
        "b64_bad_char": {"schema_version": 1, "image": {"media_type": "image/png", "data": "iVBO*w0K"}},
        "b64_padding": {"schema_version": 1, "image": {"media_type": "image/png", "data": b64(PNG)[:-1]}},
        "b64_newline": {"schema_version": 1, "image": {"media_type": "image/png",
                                                       "data": b64(PNG)[:8] + "\n" + b64(PNG)[8:]}},
        "empty": {"schema_version": 1, "image": {"media_type": "image/png", "data": ""}},
        "magic_mismatch": read_body(PNG, "image/jpeg"),
        "magic_mismatch2": read_body(jpeg_bytes(10, 10), "image/png"),
        "not_image": read_body(b"\x89PNG\r\n\x1a\n" + b"\x00" * 4, "image/png"),
        "edge_2001_w": read_body(big),
        "edge_2001_h": read_body(tall),
        "unknown_key": read_body(PNG, INJECT_zz9=1),
        "unknown_image_key": {"schema_version": 1, "image": {"media_type": "image/png", "data": b64(PNG),
                                                              "INJECT_zz9": 1}},
        "messages": read_body(PNG, messages=[]),
        "schema_version": {"schema_version": 2, "image": read_body(PNG)["image"]},
        "missing_image": {"schema_version": 1},
    }


@pytest.mark.parametrize("name", list(_bad_bodies()))
def test_bad_request_400_without_upstream(capsys, name):
    body = _bad_bodies()[name]
    client, gw, store, _ = ai_app()
    res = read_post(client, body)
    assert res.status_code == 400 and res.get_json() == {"error": "bad_request"}
    assert gw.count() == 0 and store.charged == {}
    out = capsys.readouterr().out
    data = (body.get("image") or {}).get("data") or ""
    for s in ("INJECT_zz9", data[:32] if len(data) >= 8 else "\x00never"):
        assert s not in out and s not in res.get_data(as_text=True)
    rej = [r for r in log_records(out) if r["event"] == "ai_rejected"]
    assert rej and rej[0]["status"] == 400 and "path" in rej[0]


def test_raw_bytes_over_limit_400():
    raw = png_bytes(470, 360, noise_seed=7)  # 圧縮の効かない画素で 500,000 B を超える
    assert len(raw) > st.AI_IMAGE_MAX_BYTES
    client, gw, _, _ = ai_app()
    res = read_post(client, read_body(raw))
    assert res.status_code == 400 and gw.count() == 0


def test_limits_inclusive_edge_2000():
    client, gw, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": []}))
    assert read_post(client, read_body(png_bytes(900, 2000))).status_code == 200
    assert read_post(client, read_body(png_bytes(2000, 2000))).status_code == 200
    assert gw.count() == 2


def test_parse_reports_size_dims():
    raw = png_bytes(900, 2000)
    req = rp.parse_read_request(json.dumps(read_body(raw)).encode())
    assert (req.width, req.height, req.n_bytes, req.media_type) == (900, 2000, len(raw), "image/png")
    with pytest.raises(Bad) as e:
        rp.parse_read_request(json.dumps(read_body(b"\x00" * (st.AI_IMAGE_MAX_BYTES + 1))).encode())
    assert e.value.reason == "size"


def test_body_over_read_limit_413():
    client, gw, store, _ = ai_app()
    res = read_post(client, None, raw=b" " * (st.AI_READ_MAX_BODY_BYTES + 1))
    assert res.status_code == 413 and res.get_json() == {"error": "too_large"}
    assert gw.count() == 0 and store.charged == {}


def test_read_limit_separate_from_chat_limit():
    # 会話の上限（512 KiB）は変えない。読み取りの上限は base64 の 500,000 B が入る大きさ
    assert st.AI_MAX_BODY_BYTES == 512 * 1024
    assert st.AI_READ_MAX_BODY_BYTES > -(-st.AI_IMAGE_MAX_BYTES // 3) * 4 + 200


# ---- 結果の検査 ----

def _bad_results():
    def row(**kw):
        return {**ROW, **kw}

    return {
        "unknown_row_key": {"kind": "positions", "rows": [row(name="氏名")]},
        "unknown_top_key": {"kind": "positions", "rows": [], "account": "1234"},
        "free_text_in_enum": {"kind": "positions", "rows": [row(side="売建 FREE")]},
        "free_text_product": {"kind": "positions", "rows": [row(product="日経225ミニオプション")]},
        "string_in_number": {"kind": "positions", "rows": [row(qty="2")]},
        "string_in_strike": {"kind": "positions", "rows": [row(strike="60,000")]},
        "date_free_text": {"kind": "positions", "rows": [row(opened_on="10月1日")]},
        "bool_as_number": {"kind": "positions", "rows": [row(qty=True)]},
        "rows_21": {"kind": "positions", "rows": [ROW] * 21},
        "rows_not_list": {"kind": "positions", "rows": {"0": ROW}},
        "kind_free": {"kind": "something", "rows": []},
        "not_object": ["positions"],
        "row_not_object": {"kind": "positions", "rows": ["FREE"]},
    }


@pytest.mark.parametrize("name", list(_bad_results()))
def test_bad_result_502_without_values(capsys, name):
    client, _, store, _ = ai_app(gateway=gw_with(_bad_results()[name]))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 502
    body = res.get_json()
    assert body["error"] == "bad_result" and "rows" not in body
    out = capsys.readouterr().out
    for s in ("氏名", "FREE", "1234", "60,000", "10月1日", "ミニオプション"):
        assert s not in out and s not in res.get_data(as_text=True)
    rec = [r for r in log_records(out) if r["event"] == "ai_request"][0]
    assert rec["error"] == "bad_result" and rec["charged_usd"] > 0  # 精算は実額
    assert store.charged[DAY] > 0


@pytest.mark.parametrize("field,value", [
    ("qty", 0), ("qty", 100_001), ("qty", 1.5), ("price", -1), ("strike", 0), ("strike", -100),
    ("expiry_year", 1999), ("expiry_year", 2101), ("expiry_month", 13), ("expiry_month", 0),
    ("opened_on", "2026-02-30"), ("opened_on", "1999-12-31"),
])
def test_out_of_range_field_becomes_null(field, value):
    client, _, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [{**ROW, field: value}]}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200
    row = res.get_json()["rows"][0]
    assert row[field] is None
    assert {k: v for k, v in row.items() if k != field} == {k: v for k, v in ROW.items() if k != field}


def test_missing_fields_become_null_and_rows_have_all_keys():
    client, _, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [{"product": "op_large"}, {}]}))
    rows = read_post(client, read_body(PNG)).get_json()["rows"]
    assert [set(r) for r in rows] == [set(rp.ROW_KEYS)] * 2
    assert rows[1]["product"] == "unknown" and all(rows[0][k] is None for k in rp.ROW_KEYS if k != "product")


def test_rows_20_ok():
    client, _, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [ROW] * 20}))
    assert len(read_post(client, read_body(PNG)).get_json()["rows"]) == 20


def test_no_tool_use_502_no_result(capsys):
    client, _, store, _ = ai_app(gateway=FakeGateway(read_script=[{"type": "text", "text": "TEXT_ONLY_x3"}]))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 502 and res.get_json()["error"] == "no_result"
    assert "TEXT_ONLY_x3" not in res.get_data(as_text=True)
    assert "TEXT_ONLY_x3" not in capsys.readouterr().out
    assert store.charged[DAY] == budget.cost_micro_usd("claude-opus-5-5", FakeGateway.DEFAULT_USAGE)


def test_two_tool_uses_or_other_tool_is_bad_result():
    two = report({"kind": "positions", "rows": [ROW]}) + [
        {"type": "tool_use", "id": "toolu_r2", "name": "report_positions", "input": {"kind": "positions", "rows": []}}]
    client, _, _, _ = ai_app(gateway=FakeGateway(read_script=two))
    assert read_post(client, read_body(PNG)).get_json()["error"] == "bad_result"
    other = [{"type": "tool_use", "id": "toolu_x", "name": "evaluate_scenario", "input": {}}]
    client, _, _, _ = ai_app(gateway=FakeGateway(read_script=other))
    assert read_post(client, read_body(PNG)).get_json()["error"] == "bad_result"


def test_upstream_error_502_and_timeout_504():
    client, _, store, _ = ai_app(gateway=FakeGateway(read_script=report({"kind": "positions", "rows": []}),
                                                     error=UpstreamError("upstream_rate_limited", 429, "X")))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 502 and res.get_json()["error"] == "upstream_rate_limited"
    # 途中で切れた: 予約額のまま
    assert store.charged[DAY] == rp.read_reserve("claude-opus-5-5", rp.read_estimate(
        rp.build_read_params(rp.parse_read_request(json.dumps(read_body(PNG)).encode()), _cfg())))
    gate = threading.Event()
    client, _, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": []}, gate=gate), deadline=0.2)
    res = read_post(client, read_body(PNG))
    gate.set()
    assert res.status_code == 504 and res.get_json() == {"error": "timeout"}


def _cfg():
    from support import ai_settings

    return ai_settings()


# ---- 予約額 ----

def test_reserve_for_max_image_below_half_dollar():
    # 上限の画像（長辺 2,000・500,000 B 近く）でも予約は < $0.5（base64 のバイト数をトークンに数えない）
    raw = png_bytes(470, 350, noise_seed=3)
    assert 400_000 < len(raw) <= st.AI_IMAGE_MAX_BYTES
    req = rp.parse_read_request(json.dumps(read_body(raw)).encode())
    params = rp.build_read_params(req, _cfg())
    est = rp.read_estimate(params)
    assert est < 20_000  # base64（約 66 万字）を数えていない
    reserved = rp.read_reserve("claude-opus-5-5", est)
    assert reserved < 500_000
    assert est >= st.AI_IMAGE_MAX_TOKENS + st.AI_CLI_OVERHEAD_TOKENS + st.AI_INPUT_OVERHEAD_TOKENS
    # 見積もりの本文に base64 が入らない
    assert b64(raw)[:64] not in json.dumps(params["system"]) + json.dumps(params["tools"])


def test_reserve_counted_and_settled(capsys):
    client, _, store, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [ROW]}),
                                 store=MemoryStore({DAY: 100}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200
    actual = budget.cost_micro_usd("claude-opus-5-5", FakeGateway.DEFAULT_USAGE)
    assert store.charged[DAY] == 100 + actual
    assert res.get_json()["remaining_usd"] == budget.usd(3_000_000 - 100 - actual)
    rec = logs(capsys, "ai_request")[0]
    assert rec["reserved_usd"] > rec["charged_usd"] == budget.usd(actual)


def test_budget_exceeded_429():
    client, gw, _, _ = ai_app(store=MemoryStore({DAY: 3_000_000}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 429 and res.get_json() == {"error": "budget_exceeded", "remaining_usd": 0.0}
    assert gw.count() == 0


def test_store_unavailable_503():
    store = MemoryStore()
    store.fail = True
    client, gw, _, _ = ai_app(store=store)
    res = read_post(client, read_body(PNG))
    assert res.status_code == 503 and res.get_json() == {"error": "unavailable"} and gw.count() == 0


def test_oauth_not_counted():
    store = MemoryStore({DAY: 3_000_000})
    client, gw, _, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": []}), store=store,
                              credential="oauth_token")
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200 and res.get_json()["remaining_usd"] is None
    assert store.charged == {DAY: 3_000_000}


# ---- ログ・保存しない ----

def test_log_has_no_image_or_values(capsys):
    client, _, store, _ = ai_app(gateway=gw_with({"kind": "positions", "rows": [ROW]}))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 200
    out = capsys.readouterr().out
    assert b64(PNG)[:32] not in out and SECRET not in out
    for v in ("60000", "66000", "2026-10-01", "THINKING_SECRET_x1", "TEXT_SECRET_x2"):
        assert v not in out
    recs = [r for r in log_records(out) if r["event"] == "ai_request"]
    assert len(recs) == 1
    assert set(recs[0]) <= {"severity", "message", "event", "kind", "model", "credential", "request_bytes",
                            "media_type", "image_bytes", "width", "height", "est_input_tokens", "price_checked",
                            "reserved_usd", "cost_usd_est", "charged_usd", "input_tokens",
                            "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens",
                            "result_kind", "rows", "total_ms", "stop_reason", "spawn_ms", "turns"}
    # 計上の置き場所には費用だけ（画像・結果を書かない）
    assert set(store.charged) == {DAY} and isinstance(store.charged[DAY], int)
    assert set(store.requests) == {DAY}


# ---- 守り（会話と同じ規則・同じ応答。回数と同時の本数は共用） ----

def test_disabled_503():
    from simulator_api import settings as s

    client, gw, _, _ = ai_app(ai_cfg=s.AiSettings())
    res = read_post(client, read_body(PNG))
    assert res.status_code == 503 and res.get_json() == {"error": "ai_disabled"} and gw.count() == 0


@pytest.mark.parametrize("headers", [{"Sec-Fetch-Site": "cross-site", "Origin": "http://localhost"},
                                     {"Origin": "https://evil.example.com"}, {}])
def test_forbidden_origin_403(headers):
    client, gw, store, _ = ai_app()
    res = read_post(client, read_body(PNG), headers=headers)
    assert res.status_code == 403 and res.get_json() == {"error": "forbidden"}
    assert gw.count() == 0 and store.charged == {}


@pytest.mark.parametrize("ctype", ["text/plain", "multipart/form-data", "image/png"])
def test_unsupported_media_type_415(ctype):
    client, gw, _, _ = ai_app()
    res = read_post(client, read_body(PNG), content_type=ctype)
    assert res.status_code == 415 and res.get_json() == {"error": "unsupported_media_type"} and gw.count() == 0


def test_rate_limit_shared_with_chat():
    client, gw, _, clock = ai_app()
    for i in range(st.AI_RATE_PER_MINUTE):
        if i % 2:
            res = post(client, ai_body())
            res.get_data()
        else:
            res = read_post(client, read_body(PNG))
        assert res.status_code == 200
    res = read_post(client, read_body(PNG))
    assert res.status_code == 429 and res.get_json() == {"error": "rate_limited"}
    clock.advance(60)
    assert read_post(client, read_body(PNG)).status_code == 200


def test_concurrency_shared_with_chat():
    gate = threading.Event()
    client, gw, _, _ = ai_app(gateway=FakeGateway(gate=gate, read_script=report({"kind": "positions", "rows": []})))
    open_ = []
    for _ in range(st.AI_MAX_CONCURRENT):
        res = post(client, ai_body(), buffered=False)
        it = iter(res.response)
        next(it)
        open_.append((res, it))
    res = read_post(client, read_body(PNG))
    assert res.status_code == 429 and res.get_json() == {"error": "busy"}
    gate.set()
    for r, it in open_:
        b"".join(it)
        r.close()
    # 読み取りが終われば枠を返す（次の要求が通る）
    assert read_post(client, read_body(PNG)).status_code == 200
    assert read_post(client, read_body(PNG)).status_code == 200


def test_chat_endpoint_unchanged():
    # 会話の要求に image は入れられない（許可リストの外 = 400）
    client, gw, _, _ = ai_app()
    body = ai_body()
    body = copy.deepcopy(body)
    body["messages"][0]["content"].append(
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64(PNG)}})
    res = post(client, body)
    assert res.status_code == 400 and gw.count() == 0
    assert SAME_ORIGIN  # 同じ見出しで送っている

"""テストの補助: 127.0.0.1 だけで待ち受ける偽の Messages API（Anthropic を呼ばない。#186 の結合テスト）。

届いた要求を記録し（Authorization・x-api-key は scheme と長さだけ。値は持たない）、決まった SSE を返す。
script: "tool2"（thinking → text → ツール 2 本。最後の user が tool_result なら text まで）/ "text" /
"redact"（thinking の後に
redacted_thinking）/ "err429" / "err401" /
スキル（#221）: "skill"（1 回目は thinking → Skill の tool_use、Skill の往復の後は text）/
"skill_tool"（1 回目は Skill、その後は text → simulator のツール 1 本）/ "skill_loop"（毎回 Skill）/
"skill_unknown"（1 回目は一覧に無いスキル、その後は text）。
文書（#137）: "doc"（1 回目は thinking → read_doc の tool_use、往復の後は text）/ "skill_doc"（1 回目に Skill と
read_doc を並べて、その後は text）/ "doc_outside"（1 回目は許可リストの外の節 design 13 の read_doc、その後は text）/
"doc_many"（1 回目に read_doc を DOC_MANY 本並べる = 1 要求の回数の上限を超える）。
usage は要求ごとに変える（n 回目 = 0 始まり: input_tokens 1234 + 1000n、output_tokens 321 + 10n、cache は 100・50。
n = 1 だけ cache_creation の内訳を付ける）。値はすべて架空。
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SIG = "c2lnLWZha2UtMDAx"  # 偽の署名（base64）
REDACTED = "UkVEQUNULW5ldw=="
THINKING_PARTS = ("考え中の", "要約その1。", "要約その2。")
TEXT_PARTS = ("弱点 1:", " 急落で", "損が膨らむ。")
EXCHANGED = "exchanged-access-value-for-tests-00000000"  # WIF の交換で返す架空のトークン（長さで照合する）
SKILL_NAME = "simulator:technicals"
DOC_TOOL = "mcp__docs__read_doc"
DOC_INPUT = {"file": "user-guide", "section": "8.5"}
DOC_OUTSIDE = {"file": "design", "section": "13"}
DOC_MANY = 7
UNKNOWN_SKILL = "simulator:unknown"


def turn_usage(n: int) -> tuple[dict, dict]:
    """n 回目（0 始まり）の要求の usage（message_start の分, message_delta の分）"""
    start = {"input_tokens": 1234 + 1000 * n, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 50,
             "output_tokens": 1}
    if n == 1:
        start["cache_creation"] = {"ephemeral_5m_input_tokens": 40, "ephemeral_1h_input_tokens": 60}
    return start, {"output_tokens": 321 + 10 * n}


def skill_uses(messages: list) -> int:
    """messages の中の Skill の tool_use の数（CLI が往復を足した回数）"""
    return sum(1 for m in messages if m.get("role") == "assistant" and isinstance(m.get("content"), list)
               for b in m["content"]
               if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill")


def doc_uses(messages: list) -> int:
    """messages の中の read_doc の tool_use の数"""
    return sum(1 for m in messages if m.get("role") == "assistant" and isinstance(m.get("content"), list)
               for b in m["content"]
               if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == DOC_TOOL)


def _shape(v: str | None) -> dict | None:
    if v is None:
        return None
    parts = v.split(" ", 1)
    if len(parts) == 2:
        return {"scheme": parts[0], "len": len(parts[1])}
    return {"scheme": None, "len": len(v)}


class FakeMessagesApi:
    def __init__(self, script: str = "tool2", delay: float = 0.0, exchange_status: int = 200,
                 error_message: str = "Error", exchanged: str = EXCHANGED):
        """error_message: 失敗の応答（err429・err401・交換の失敗）の本文の文（漏れの検査で鍵の形を入れる）。
        exchanged: WIF の交換で返すトークン"""
        self.script = script
        self.exchange_status = exchange_status
        self.error_message = error_message
        self.exchanged = exchanged
        self.delay = delay
        self.requests: list[dict] = []
        self.streamed = 0  # 流した要求の数（usage の n）
        self._lock = threading.Lock()
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _rec(self, body):
                h = {k.lower(): v for k, v in self.headers.items()}
                with api._lock:
                    api.requests.append({"method": self.command, "path": self.path,
                                         "authorization": _shape(h.get("authorization")),
                                         "x_api_key": _shape(h.get("x-api-key")),
                                         "anthropic_beta": h.get("anthropic-beta"), "body": body})

            def _empty(self, code):
                self.send_response(code)
                self.send_header("content-length", "0")
                self.end_headers()

            def do_GET(self):
                self._rec(None)
                self._empty(404)

            def do_HEAD(self):
                self.do_GET()

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = {"_raw_len": len(raw)}
                if self.path.startswith("/v1/oauth/token"):  # WIF の交換（値は持たない。キーと grant_type だけ）
                    self._rec({"keys": sorted(body) if isinstance(body, dict) else None,
                               "grant_type": body.get("grant_type") if isinstance(body, dict) else None,
                               "assertion_len": len(body.get("assertion") or "") if isinstance(body, dict) else 0})
                    if api.exchange_status == 200:
                        b = json.dumps({"access_token": api.exchanged, "token_type": "bearer",
                                        "expires_in": 600}).encode()
                    else:
                        b = json.dumps({"type": "error", "error": {"type": "authentication_error",
                                                                   "message": api.error_message}}).encode()
                    self.send_response(api.exchange_status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(b)))
                    self.end_headers()
                    self.wfile.write(b)
                    return
                self._rec(body)
                if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
                    return self._empty(404)
                if api.script in ("err429", "err401"):
                    code, typ = (429, "rate_limit_error") if api.script == "err429" else (401, "authentication_error")
                    b = json.dumps({"type": "error", "error": {"type": typ, "message": api.error_message}}).encode()
                    self.send_response(code)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(b)))
                    self.end_headers()
                    self.wfile.write(b)
                    return
                if not body.get("stream"):
                    b = json.dumps({"id": "msg_fake_ns", "type": "message", "role": "assistant",
                                    "model": body.get("model"), "content": [{"type": "text", "text": "ok"}],
                                    "stop_reason": "end_turn", "stop_sequence": None,
                                    "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(b)))
                    self.end_headers()
                    self.wfile.write(b)
                    return
                self._stream(body)

            def ev(self, data):
                if api.delay:
                    time.sleep(api.delay)
                self.wfile.write(f"event: {data['type']}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()

            def _stream(self, body):
                tname = next((t["name"] for t in body.get("tools") or [] if t["name"].endswith("evaluate_scenario")),
                             None)
                messages = body.get("messages") or [{}]
                last = messages[-1]
                after_tool = isinstance(last.get("content"), list) and any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in last["content"])
                with api._lock:
                    n = api.streamed
                    api.streamed += 1
                used = skill_uses(messages)
                skill = None  # この turn で呼ぶスキル
                if api.script == "skill_loop" or (api.script in ("skill", "skill_tool") and used == 0):
                    skill = SKILL_NAME
                elif api.script == "skill_unknown" and used == 0:
                    skill = UNKNOWN_SKILL
                elif api.script == "skill_doc" and used == 0:
                    skill = SKILL_NAME
                doc = None  # この turn で読む節（list で並べる）
                if doc_uses(messages) == 0 and api.script in ("doc", "skill_doc", "doc_outside"):
                    doc = [DOC_OUTSIDE if api.script == "doc_outside" else DOC_INPUT]
                elif doc_uses(messages) == 0 and api.script == "doc_many":
                    doc = [{"file": "user-guide", "section": str(k + 1)} for k in range(DOC_MANY)]
                start_usage, delta_usage = turn_usage(n)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                self.ev({"type": "message_start", "message": {
                    "id": f"msg_fake_{n + 1}", "type": "message", "role": "assistant", "model": body.get("model"),
                    "content": [], "stop_reason": None, "stop_sequence": None, "usage": start_usage}})
                i = 0
                self.ev({"type": "content_block_start", "index": i,
                         "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
                for part in THINKING_PARTS:
                    self.ev({"type": "content_block_delta", "index": i,
                             "delta": {"type": "thinking_delta", "thinking": part}})
                self.ev({"type": "content_block_delta", "index": i,
                         "delta": {"type": "signature_delta", "signature": SIG}})
                self.ev({"type": "content_block_stop", "index": i})
                if skill is not None or doc is not None:
                    if skill is not None:
                        i += 1
                        self.ev({"type": "content_block_start", "index": i, "content_block": {
                            "type": "tool_use", "id": f"toolu_skill_{n}", "name": "Skill", "input": {}}})
                        self.ev({"type": "content_block_delta", "index": i, "delta": {
                            "type": "input_json_delta", "partial_json": json.dumps({"skill": skill})}})
                        self.ev({"type": "content_block_stop", "index": i})
                    for k, d in enumerate(doc or []):
                        i += 1
                        self.ev({"type": "content_block_start", "index": i, "content_block": {
                            "type": "tool_use", "id": f"toolu_doc_{n}_{k}", "name": DOC_TOOL, "input": {}}})
                        self.ev({"type": "content_block_delta", "index": i, "delta": {
                            "type": "input_json_delta", "partial_json": json.dumps(d)}})
                        self.ev({"type": "content_block_stop", "index": i})
                    self.ev({"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                             "usage": delta_usage})
                    self.ev({"type": "message_stop"})
                    self.close_connection = True
                    return
                if api.script == "redact":
                    i += 1
                    self.ev({"type": "content_block_start", "index": i,
                             "content_block": {"type": "redacted_thinking", "data": REDACTED}})
                    self.ev({"type": "content_block_stop", "index": i})
                i += 1
                self.ev({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                for part in TEXT_PARTS:
                    self.ev({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": part}})
                self.ev({"type": "content_block_stop", "index": i})
                stop = "end_turn"
                ntools = 0
                if tname and api.script == "tool2" and not after_tool:
                    ntools = 2
                elif tname and api.script == "skill_tool" and skill_uses(
                        [m for m in messages if m.get("role") == "assistant"][-1:]) > 0:
                    ntools = 1  # Skill の往復の直後（simulator のツールの tool_result の後は text まで）
                for j in range(ntools):
                    i += 1
                    self.ev({"type": "content_block_start", "index": i, "content_block": {
                        "type": "tool_use", "id": f"toolu_fake_{j}", "name": tname, "input": {}}})
                    for part in ('{"days": 5', f', "iv_shift_pt": {j + 2}', ', "dx_pct": -6}'):
                        self.ev({"type": "content_block_delta", "index": i,
                                 "delta": {"type": "input_json_delta", "partial_json": part}})
                    self.ev({"type": "content_block_stop", "index": i})
                if ntools:
                    stop = "tool_use"
                self.ev({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                         "usage": delta_usage})
                self.ev({"type": "message_stop"})
                self.close_connection = True

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def exchanges(self) -> list[dict]:
        with self._lock:
            return [r for r in self.requests if r["method"] == "POST" and r["path"].startswith("/v1/oauth/token")]

    def posts(self) -> list[dict]:
        with self._lock:
            return [r for r in self.requests if r["method"] == "POST" and r["path"].startswith("/v1/messages")]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()

"""テストの補助: 127.0.0.1 だけで待ち受ける偽の Messages API（Anthropic を呼ばない。#186 の結合テスト）。

届いた要求を記録し（Authorization・x-api-key は scheme と長さだけ。値は持たない）、決まった SSE を返す。
script: "tool2"（thinking → text → 道具 2 本。最後の user が tool_result なら text まで）/ "text" /
"redact"（thinking の後に
redacted_thinking）/ "err429" / "err401"。値はすべて架空。
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SIG = "c2lnLWZha2UtMDAx"  # 偽の署名（base64）
REDACTED = "UkVEQUNULW5ldw=="
THINKING_PARTS = ("考え中の", "要約その1。", "要約その2。")
TEXT_PARTS = ("弱点 1:", " 急落で", "損が膨らむ。")


def _shape(v: str | None) -> dict | None:
    if v is None:
        return None
    parts = v.split(" ", 1)
    if len(parts) == 2:
        return {"scheme": parts[0], "len": len(parts[1])}
    return {"scheme": None, "len": len(v)}


class FakeMessagesApi:
    def __init__(self, script: str = "tool2", delay: float = 0.0):
        self.script = script
        self.delay = delay
        self.requests: list[dict] = []
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
                self._rec(body)
                if not self.path.startswith("/v1/messages") or "count_tokens" in self.path:
                    return self._empty(404)
                if api.script in ("err429", "err401"):
                    code, typ = (429, "rate_limit_error") if api.script == "err429" else (401, "authentication_error")
                    b = json.dumps({"type": "error", "error": {"type": typ, "message": "Error"}}).encode()
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
                last = (body.get("messages") or [{}])[-1]
                after_tool = isinstance(last.get("content"), list) and any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in last["content"])
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                self.ev({"type": "message_start", "message": {
                    "id": "msg_fake_1", "type": "message", "role": "assistant", "model": body.get("model"),
                    "content": [], "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": 1234, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 50,
                              "output_tokens": 1}}})
                i = 0
                self.ev({"type": "content_block_start", "index": i,
                         "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
                for part in THINKING_PARTS:
                    self.ev({"type": "content_block_delta", "index": i,
                             "delta": {"type": "thinking_delta", "thinking": part}})
                self.ev({"type": "content_block_delta", "index": i,
                         "delta": {"type": "signature_delta", "signature": SIG}})
                self.ev({"type": "content_block_stop", "index": i})
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
                if api.script == "tool2" and tname and not after_tool:
                    for j in range(2):
                        i += 1
                        self.ev({"type": "content_block_start", "index": i, "content_block": {
                            "type": "tool_use", "id": f"toolu_fake_{j}", "name": tname, "input": {}}})
                        for part in ('{"days": 5', f', "iv_shift_pt": {j + 2}', ', "dx_pct": -6}'):
                            self.ev({"type": "content_block_delta", "index": i,
                                     "delta": {"type": "input_json_delta", "partial_json": part}})
                        self.ev({"type": "content_block_stop", "index": i})
                    stop = "tool_use"
                self.ev({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                         "usage": {"output_tokens": 321}})
                self.ev({"type": "message_stop"})
                self.close_connection = True

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def posts(self) -> list[dict]:
        with self._lock:
            return [r for r in self.requests if r["method"] == "POST" and r["path"].startswith("/v1/messages")]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()

"""AI の送信先の共通の部品と偽の送信先（FakeGateway: AI_CREDENTIAL=fake・テスト）。本物の送信先は
agent_sdk.AgentSdkGateway（Claude Agent SDK = 同梱の CLI。oauth_token・api_key・wif のすべて。#221・ADR-0006）。

stream(params, cancel) は次の事象（dict）を順に返す:
  {"type": "thinking", "text"} / {"type": "text", "text"} /
  {"type": "tool_use", "id", "name", "input"}（block の終わり）/
  {"type": "final", "content": [block…], "usage": {…}, "stop_reason"}（最後に 1 回）
  （送信先の計測 {"type": "meta", …} を挟んでよい。中継はログに載せるだけ）
失敗は UpstreamError(code, status, error_type)。code は列挙、status は HTTP の状態、error_type は例外の型名だけ
（例外の本文は要求・応答の一部や鍵の断片を含みうるので持ち出さない）。

ここに残すもの: UpstreamError、SDK のログの置き換え（quiet_sdk_logs）、WIF の Google の ID トークン
（metadata_identity_token。中継が要求ごとに取り、CLI に渡す）、FakeGateway。
"""

import logging
import threading
import urllib.request

from .. import settings as st


class UpstreamError(Exception):
    def __init__(self, code: str, status: int | None = None, error_type: str | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.error_type = error_type


class _SdkLogBridge(logging.Handler):
    """SDK（logger "claude_agent_sdk" 以下）の WARNING 以上を、本文なしの構造化ログ ai_sdk_warning に置き換える。
    SDK の文言は上流のメッセージ・CLI の出力の一部を含みうるので出さない。
    出すのは logger の名前・レベル・引数の中の例外の型名と状態だけ"""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            from ..log import log

            args = record.args if isinstance(record.args, tuple) else ()
            errs = [a for a in args if isinstance(a, BaseException)]
            if record.exc_info and record.exc_info[1] is not None:
                errs.append(record.exc_info[1])
            status = next((getattr(e, "status_code", None) for e in errs
                           if isinstance(getattr(e, "status_code", None), int)), None)
            log("WARNING", "ai_sdk_warning", logger=record.name, level=record.levelname,
                error_type=",".join(type(e).__name__ for e in errs) or None, upstream_status=status)
        except Exception:
            pass


_sdk_log_lock = threading.Lock()


def quiet_sdk_logs(name: str = "claude_agent_sdk") -> None:
    """logger name を親（root・Python の lastResort = stderr）に流さず、_SdkLogBridge だけに渡す（何度呼んでもよい）"""
    sdk = logging.getLogger(name)
    with _sdk_log_lock:
        if not any(isinstance(h, _SdkLogBridge) for h in sdk.handlers):
            sdk.addHandler(_SdkLogBridge(level=logging.WARNING))
        sdk.propagate = False
        if sdk.level == logging.NOTSET or sdk.level < logging.WARNING:
            sdk.setLevel(logging.WARNING)  # DEBUG / INFO（要求の中身を含む）は作らない


class IdentityTokenError(Exception):
    """Google の ID トークンが取れない（メタデータサーバーに届かない・JWT でない応答）。応答の本文は持たない"""


def metadata_identity_token(opener=None) -> str:
    """Cloud Run のメタデータサーバーから実行 SA の ID トークン（audience https://api.anthropic.com・format=full）。
    プロキシを通さない（メタデータサーバーはインスタンスの中だけ）。
    opener はテスト用（urllib の OpenerDirector と同じ open）"""
    if opener is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(st.AI_IDENTITY_TOKEN_URL, headers={"Metadata-Flavor": "Google"})
    try:
        with opener.open(req, timeout=st.AI_IDENTITY_TOKEN_TIMEOUT_SECONDS) as res:
            raw = res.read(st.AI_IDENTITY_TOKEN_MAX_BYTES + 1)
    except Exception as e:
        raise IdentityTokenError(type(e).__name__) from None
    try:
        token = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        raise IdentityTokenError("not_ascii") from None
    if len(raw) > st.AI_IDENTITY_TOKEN_MAX_BYTES or token.count(".") != 2 or " " in token:
        raise IdentityTokenError("not_jwt")
    return token


class FakeGateway:
    """偽の送信先（Anthropic を呼ばない）。script: 返す事象の列（最後に final を自分で足す）。
    gate: セットされるまで最初の事象を返さない（止まった送信先）。error: 途中で投げる UpstreamError（after 件の後）。
    calls: 受けた params の記録"""

    DEFAULT_SCRIPT = (
        {"type": "thinking", "text": "（偽の送信先の考え中の要約）"},
        {"type": "text", "text": "偽の送信先の応答です。Anthropic は呼んでいません。"},
    )
    DEFAULT_USAGE = {"input_tokens": 1200, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                     "output_tokens": 300}

    def __init__(self, script=None, usage=None, stop_reason="end_turn", gate: threading.Event | None = None,
                 error: UpstreamError | None = None, error_after: int = 0, final: bool = True):
        self.script = list(self.DEFAULT_SCRIPT if script is None else script)
        self.usage = dict(self.DEFAULT_USAGE if usage is None else usage)
        self.stop_reason = stop_reason
        self.gate = gate
        self.error = error
        self.error_after = error_after
        self.final = final
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def start_warm(self):
        return None

    def count(self) -> int:
        with self._lock:
            return len(self.calls)

    def stream(self, params, cancel):
        with self._lock:
            self.calls.append(params)
        if self.gate is not None:
            self.gate.wait(10)
        content: list[dict] = []
        for i, ev in enumerate(self.script):
            if self.error is not None and i == self.error_after:
                raise self.error
            if cancel.is_set():
                return
            yield dict(ev)
            if ev["type"] == "text":
                if content and content[-1]["type"] == "text":
                    content[-1]["text"] += ev["text"]
                else:
                    content.append({"type": "text", "text": ev["text"]})
            elif ev["type"] == "thinking":
                if content and content[-1]["type"] == "thinking":
                    content[-1]["thinking"] += ev["text"]
                else:
                    content.append({"type": "thinking", "thinking": ev["text"], "signature": "ZmFrZQ=="})
            elif ev["type"] == "tool_use":
                content.append({"type": "tool_use", "id": ev["id"], "name": ev["name"], "input": ev["input"]})
        if self.error is not None and self.error_after >= len(self.script):
            raise self.error
        if self.final:
            yield {"type": "final", "content": content, "usage": dict(self.usage), "stop_reason": self.stop_reason}

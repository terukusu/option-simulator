"""Anthropic の送信先。SDK の薄い包み（AnthropicGateway）と偽の送信先（FakeGateway: AI_CREDENTIAL=fake・テスト）。

stream(params, cancel) は次の事象（dict）を順に返す:
  {"type": "thinking", "text"} / {"type": "text", "text"} /
  {"type": "tool_use", "id", "name", "input"}（block の終わり）/
  {"type": "final", "content": [block…], "usage": {…}, "stop_reason"}（最後に 1 回）
失敗は UpstreamError(code, status, error_type)。code は列挙、status は HTTP の状態、error_type は例外の型名だけ
（SDK の例外の本文は要求・応答の一部や鍵の断片を含みうるので持ち出さない）。

資格情報は中継が選んだ種類の 1 つだけを明示で渡す（SDK は明示の引数があると環境変数を読まない。キーとトークンが
両方あると X-Api-Key と Authorization の両方を送る）。api_key → Anthropic(api_key=…)、
oauth_token → Anthropic(auth_token=…, anthropic-beta)、
wif → Anthropic(credentials=WorkloadIdentityCredentials(…))（#184。ID トークンはメタデータサーバーから。
交換したトークンは SDK の TokenCache が持ち、期限の前に交換し直す。Bearer と anthropic-beta は SDK が付ける）。
max_retries=0（途中まで流した後の再試行で二重に流さない・締め切りを読める）。
"""

import logging
import threading
import urllib.request
from collections.abc import Callable, Iterator

from .. import settings as st


class UpstreamError(Exception):
    def __init__(self, code: str, status: int | None = None, error_type: str | None = None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.error_type = error_type


class _SdkLogBridge(logging.Handler):
    """SDK（logger "anthropic" 以下）の WARNING 以上を、本文なしの構造化ログ ai_sdk_warning に置き換える。
    SDK の文言は交換の失敗の本文（上流のメッセージ。assertion を含みうる）を含むので出さない。
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


def quiet_sdk_logs() -> None:
    """logger "anthropic" を親（root・Python の lastResort = stderr）に流さず、_SdkLogBridge だけに渡す
    （何度呼んでもよい）。
    例: TokenCache の期限前の交換が失敗すると、SDK は WARNING に交換の失敗の本文を書く"""
    sdk = logging.getLogger("anthropic")
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


def classify(e: Exception) -> UpstreamError:
    """SDK の例外 → UpstreamError（型と状態だけ）"""
    import anthropic

    name = type(e).__name__
    status = getattr(e, "status_code", None)
    if isinstance(e, anthropic.WorkloadIdentityError):  # WIF の交換（POST /v1/oauth/token）の失敗。401 はルールの不一致
        if status in (401, 403):
            return UpstreamError("upstream_auth", status, name)
        return UpstreamError("upstream_unavailable", status if isinstance(status, int) else None, name)
    if isinstance(e, anthropic.APIConnectionError):  # APITimeoutError を含む
        if isinstance(e.__cause__, IdentityTokenError):  # SDK は ID トークンの関数の例外を接続の失敗に包む
            return UpstreamError("upstream_auth", None, "IdentityTokenError")
        return UpstreamError("upstream_unavailable", None, name)
    if isinstance(e, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return UpstreamError("upstream_auth", status, name)
    if isinstance(e, anthropic.RateLimitError):
        return UpstreamError("upstream_rate_limited", status, name)
    if isinstance(e, anthropic.OverloadedError):
        return UpstreamError("upstream_overloaded", status, name)
    if isinstance(e, anthropic.APIStatusError) and status is not None and 400 <= status < 500:
        return UpstreamError("upstream_bad_request", status, name)
    return UpstreamError("upstream_unavailable", status if isinstance(status, int) else None, name)


def client_kwargs(credential: str, secret: str | None, wif: st.WifIds | None = None,
                  identity_token: Callable[[], str] | None = None, exchange_http_client=None) -> dict:
    """SDK のコンストラクタの引数（選んだ種類の 1 つだけ）。exchange_http_client は WIF の交換の送信先（テスト用。
    省略時は中継のタイムアウトの httpx2.Client）"""
    import anthropic
    import httpx2

    kw: dict = {"max_retries": 0,
                "timeout": anthropic.Timeout(st.AI_READ_TIMEOUT_SECONDS, connect=st.AI_CONNECT_TIMEOUT_SECONDS)}
    if credential == "api_key":
        kw["api_key"] = secret
    elif credential == "oauth_token":
        kw["auth_token"] = secret
        kw["default_headers"] = {"anthropic-beta": st.AI_OAUTH_BETA}
    elif credential == "wif":
        if wif is None:
            raise ValueError("wif")
        opt = {k: v for k, v in (("service_account_id", wif.service_account_id),
                                 ("workspace_id", wif.workspace_id)) if v is not None}
        # 交換の送信先。SDK の既定（30 秒）では 401 の交換し直しを含めて締め切りを越えうるので短くする
        opt["http_client"] = exchange_http_client or httpx2.Client(
            timeout=httpx2.Timeout(st.AI_TOKEN_EXCHANGE_TIMEOUT_SECONDS, connect=st.AI_CONNECT_TIMEOUT_SECONDS))
        kw["credentials"] = anthropic.WorkloadIdentityCredentials(
            identity_token_provider=identity_token or metadata_identity_token,
            federation_rule_id=wif.federation_rule_id, organization_id=wif.organization_id, **opt)
    else:
        raise ValueError("credential")
    return kw


class AnthropicGateway:
    def __init__(self, credential: str, secret: str | None, factory=None, wif: st.WifIds | None = None,
                 identity_token: Callable[[], str] | None = None, exchange_http_client=None):
        self._credential = credential
        self._secret = secret
        self._wif = wif
        self._identity_token = identity_token  # テスト用: 偽の ID トークン（省略時はメタデータサーバー）
        self._exchange_http_client = exchange_http_client  # テスト用: WIF の交換の送信先
        self._factory = factory  # テスト用: kwargs -> client（省略時は anthropic.Anthropic）
        self._client = None
        self._lock = threading.Lock()
        quiet_sdk_logs()

    def __repr__(self) -> str:  # 鍵・WIF の ID を repr に出さない
        return f"AnthropicGateway(credential={self._credential!r})"

    def client(self):
        with self._lock:
            if self._client is None:
                factory = self._factory
                if factory is None:
                    import anthropic

                    factory = anthropic.Anthropic
                self._client = factory(**client_kwargs(self._credential, self._secret, self._wif,
                                                       self._identity_token, self._exchange_http_client))
            return self._client

    def warm(self) -> None:
        """import（pydantic など重い）とクライアントの組み立てを先に済ませる。失敗は最初の要求で出る"""
        try:
            self.client()
        except Exception:
            pass

    def start_warm(self) -> threading.Thread:
        thread = threading.Thread(target=self.warm, name="ai-warm", daemon=True)
        thread.start()
        return thread

    def stream(self, params: dict, cancel: threading.Event) -> Iterator[dict]:
        try:
            client = self.client()
            with client.messages.stream(**params) as s:
                for ev in s:
                    if cancel.is_set():
                        return
                    t = ev.type
                    if t == "thinking":
                        yield {"type": "thinking", "text": ev.thinking}
                    elif t == "text":
                        yield {"type": "text", "text": ev.text}
                    elif t == "content_block_stop" and getattr(ev.content_block, "type", None) == "tool_use":
                        b = ev.content_block
                        yield {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
                final = s.get_final_message()
            usage = final.usage.model_dump(mode="json", exclude_none=True) if final.usage is not None else {}
            yield {"type": "final", "content": [b.model_dump(mode="json", exclude_none=True) for b in final.content],
                   "usage": usage, "stop_reason": final.stop_reason}
        except UpstreamError:
            raise
        except Exception as e:
            raise classify(e) from None


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

"""AI_CREDENTIAL=oauth_token の送信先: Claude Agent SDK（claude-agent-sdk。同梱の Claude Code CLI を子プロセスで動かす）
を **送信路としてだけ** 使う（#186、docs/adr-0005-ai-oauth-via-agent-sdk.md）。

サブスクリプションの OAuth トークンは Messages API の直接呼び出しでは 429 になり、CLI 経由でだけ使える
（ADR-0001 の追補）。
中継の残り（許可リスト・system prompt・ツールの登録・SSE・締め切り・中止・同時の本数・1 分の回数・ログ）は
変えない。
stream(params, cancel) は AnthropicGateway と同じ事象（thinking / text / tool_use / final）を返し、最初の事象の前に
{"type": "meta", "spawn_ms"}（子の起動 → 最初の StreamEvent）を 1 回返す（中継は ai_request に載せるだけ）。

作り（spike S1〜S6 の結果。ADR-0005）:
- ツール 6 本は in-process の SDK MCP ツール（名前は mcp__sim__<名>）として CLI に見せる。モデルが tool_use を出したら
  PreToolUse フックが deny + continue_=False を返し、CLI はツールを実行せずに turn を終える（関数は呼ばれない前提。
  呼ばれたら is_error を返す）。組み込みのツールは tools=[] で 0 本
- 事象は include_partial_messages の StreamEvent（生の API の SSE 事象）から組み立てる。AssistantMessage は
  redacted_thinking を落とすので content には使わない（error の種類だけ見る）
- 履歴は要求ごとのメモリ上の SessionStore（load だけが履歴から作った transcript の項目を返す）+ resume=<新しい uuid>。
  最後の user が text なら stream-json の prompt で渡す（verbatim_prompts=True: `@<パス>` をファイルとして読ませない）。
  最後の user が tool_result なら、それも transcript に入れ、prompt は空にして CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 で
  turn を続けさせる（CLI はその user の末尾に CLAUDE_CODE_RESUME_PROMPT の文を 1 つ足す）
- 子の環境は親に「重なる」だけなので、ANTHROPIC_AUTH_TOKEN・ANTHROPIC_API_KEY を空で上書きし、資格情報は
  CLAUDE_CODE_OAUTH_TOKEN だけにする（空でないと CLI はそちらを Bearer / x-api-key で送る = 429 の経路）
- 設定・CLAUDE.md・自動のメモリを読まない（setting_sources=[]・CLAUDE_CODE_DISABLE_AUTO_MEMORY）。設定ディレクトリと
  cwd は要求ごとの一時ディレクトリ（終わったら消す）。CLI の標準エラーは捨てる（本文をログに出さない）
- 再試行しない（CLAUDE_CODE_MAX_RETRIES=0。既定では 429 を 100 秒以上再試行する）。出力の上限は max_tokens を
  CLAUDE_CODE_MAX_OUTPUT_TOKENS で

transcript の形・CLAUDE_CODE_RESUME_* は文書化されていない CLI の内部に依存する。SDK の版（= 同梱の CLI の版）を
pyproject.toml・uv.lock で固定し、tests/test_ai_agent_sdk_cli.py（本物の CLI と 127.0.0.1 の偽の Messages API）で守る。

SDK は async なので、要求ごとに専用のスレッドで event loop を立て（asyncio.run）、事象を queue で gthread の側へ渡す。
cancel（中継の締め切り・中止・切断）を 0.05 秒ごとに見て、anyio の cancel scope で query を取り消す（SDK の後始末が
子の stdin を閉じ、終わらなければ SIGTERM・SIGKILL で止める）。
"""

import asyncio
import json
import os
import queue
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

from .gateway import UpstreamError, quiet_sdk_logs

SERVER = "sim"  # SDK MCP の server 名（CLI のツールの名前は mcp__sim__<名>）
CLI_PREFIX = f"mcp__{SERVER}__"
# 最後の user が tool_result の turn で CLI がその user の末尾に足す文（空にはできない。ADR-0005）
RESUME_PROMPT = "Continue from the tool results."
CANCEL_POLL_SECONDS = 0.05
USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
DENY_REASON = "The browser runs this tool and returns tool_result in the next request."
_DONE = object()


def to_cli_name(name: str) -> str:
    return CLI_PREFIX + name


def from_cli_name(name: str) -> str:
    """CLI の名前 → 登録の名前（接頭辞が無ければそのまま。中継が登録に無い名前を bad_tool_input にする）"""
    return name[len(CLI_PREFIX):] if isinstance(name, str) and name.startswith(CLI_PREFIX) else name


def _is_tool_result_turn(message: dict) -> bool:
    return message["role"] == "user" and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in message["content"])


def split_last(messages: list[dict]) -> tuple[list[dict], list[dict] | None]:
    """messages（relay.build_params の。最後は user）→ (transcript に入れる履歴, prompt の content)。
    最後の user が tool_result なら全部を履歴に入れ prompt は None（CLI に turn を続けさせる）"""
    if not messages or messages[-1]["role"] != "user":
        raise ValueError("last message must be user")
    if _is_tool_result_turn(messages[-1]):
        return list(messages), None
    return list(messages[:-1]), list(messages[-1]["content"])


def _cli_blocks(content: list[dict]) -> list[dict]:
    out = []
    for b in content:
        b = dict(b)
        if b.get("type") == "tool_use":
            b["name"] = to_cli_name(b["name"])
        out.append(b)
    return out


def history_entries(messages: list[dict], session_id: str, cwd: str, model: str, cli_version: str,
                    now: datetime | None = None) -> list[dict]:
    """履歴 → CLI の transcript の項目（1 message = 1 項目。parentUuid で鎖にする。CLI 2.1.283 が受け付けた最小の形）。
    tool_use の name は CLI の名前に付け直す"""
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    base = {"isSidechain": False, "userType": "external", "entrypoint": "sdk-py", "cwd": cwd, "sessionId": session_id,
            "version": cli_version, "timestamp": stamp}
    out, parent = [], None
    for i, m in enumerate(messages):
        u = str(uuid.uuid4())
        if m["role"] == "user":
            entry = {**base, "parentUuid": parent, "type": "user", "uuid": u,
                     "message": {"role": "user", "content": _cli_blocks(m["content"])}}
        else:
            entry = {**base, "parentUuid": parent, "type": "assistant", "uuid": u,
                     "message": {"id": f"msg_hist_{i}", "type": "message", "role": "assistant", "model": model,
                                 "content": _cli_blocks(m["content"]), "stop_reason": None, "stop_sequence": None,
                                 "usage": {"input_tokens": 0, "output_tokens": 0}}}
        out.append(entry)
        parent = u
    return out


def entries_messages(entries: list[dict]) -> list[dict]:
    """transcript の項目 → Messages API の messages（テストの照合用。name は登録の名前に戻す）"""
    out = []
    for e in entries:
        content = []
        for b in e["message"]["content"]:
            b = dict(b)
            if b.get("type") == "tool_use":
                b["name"] = from_cli_name(b["name"])
            content.append(b)
        out.append({"role": e["message"]["role"], "content": content})
    return out


class OneShotStore:
    """要求ごとの SessionStore（メモリだけ）。load は 1 つの session の項目を返し、
    append（CLI の transcript の鏡）は捨てる"""

    def __init__(self, session_id: str, entries: list[dict]):
        self.session_id = session_id
        self._entries = entries

    async def append(self, key, entries) -> None:
        return None

    async def load(self, key):
        if key.get("session_id") != self.session_id or key.get("subpath"):
            return None
        return list(self._entries)


def child_env(secret: str, config_dir: str, max_tokens: int, resume_turn: bool,
              extra: dict[str, str] | None = None) -> dict[str, str]:
    """子の環境（親の環境に重なる）。資格情報は CLAUDE_CODE_OAUTH_TOKEN だけ（ANTHROPIC_AUTH_TOKEN・ANTHROPIC_API_KEY は
    空で上書き = CLI は未設定として扱う。spike S5）。extra はテスト用（ANTHROPIC_BASE_URL を偽の送信先に）"""
    env = {
        "CLAUDE_CODE_OAUTH_TOKEN": secret,
        "ANTHROPIC_AUTH_TOKEN": "",
        "ANTHROPIC_API_KEY": "",
        "CLAUDE_CONFIG_DIR": config_dir,
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "CLAUDE_CODE_MAX_RETRIES": "0",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(max_tokens),
        "CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1" if resume_turn else "",
        "CLAUDE_CODE_RESUME_PROMPT": RESUME_PROMPT,
    }
    if extra:
        env.update(extra)
    return env


def code_for(status: int | None, assistant_error: str | None) -> str:
    """上流の状態（ResultMessage.api_error_status）・AssistantMessage.error → UpstreamError の code"""
    if status in (401, 403) or assistant_error in ("authentication_failed", "billing_error"):
        return "upstream_auth"
    if status == 429 or assistant_error == "rate_limit":
        return "upstream_rate_limited"
    if status == 529:
        return "upstream_overloaded"
    if (isinstance(status, int) and 400 <= status < 500) or assistant_error == "invalid_request":
        return "upstream_bad_request"
    return "upstream_unavailable"


def classify_exception(e: BaseException, assistant_error: str | None = None) -> UpstreamError:
    """SDK の例外 → UpstreamError（型と状態だけ。ProcessError は CLI の標準エラーを本文に含むので持ち出さない）"""
    status = getattr(e, "api_error_status", None)
    status = status if isinstance(status, int) else None
    return UpstreamError(code_for(status, assistant_error), status, type(e).__name__)


class Assembler:
    """StreamEvent.event（生の API の SSE 事象）→ 中継の事象と final の content"""

    def __init__(self):
        self.blocks: dict[int, dict] = {}
        self.order: list[int] = []
        self.partial: dict[int, list[str]] = {}
        self.stop_reason: str | None = None
        self.usage: dict = {}
        self.messages = 0
        self.stopped = False

    def feed(self, ev: dict) -> list[dict]:
        t = ev.get("type")
        out: list[dict] = []
        if t == "message_start":
            self.messages += 1
            if self.messages > 1:  # max_turns=1・フックで止めるので 1 回だけのはず
                raise UpstreamError("upstream_unavailable", None, "unexpected_turn")
            self.usage.update((ev.get("message") or {}).get("usage") or {})
        elif t == "content_block_start":
            i = ev["index"]
            cb = dict(ev.get("content_block") or {})
            if cb.get("type") == "thinking":
                cb = {"type": "thinking", "thinking": cb.get("thinking") or "", "signature": cb.get("signature") or ""}
            elif cb.get("type") == "text":
                cb = {"type": "text", "text": cb.get("text") or ""}
            elif cb.get("type") == "tool_use":
                cb = {"type": "tool_use", "id": cb.get("id"), "name": from_cli_name(cb.get("name")), "input": {}}
                self.partial[i] = []
            self.blocks[i] = cb
            self.order.append(i)
        elif t == "content_block_delta":
            i = ev["index"]
            d = ev.get("delta") or {}
            b = self.blocks.get(i)
            dt = d.get("type")
            if b is None:
                return out
            if dt == "thinking_delta":
                b["thinking"] += d.get("thinking", "")
                out.append({"type": "thinking", "text": d.get("thinking", "")})
            elif dt == "text_delta":
                b["text"] += d.get("text", "")
                out.append({"type": "text", "text": d.get("text", "")})
            elif dt == "signature_delta":
                b["signature"] = b.get("signature", "") + d.get("signature", "")
            elif dt == "input_json_delta" and i in self.partial:
                self.partial[i].append(d.get("partial_json", ""))
        elif t == "content_block_stop":
            i = ev["index"]
            b = self.blocks.get(i)
            if b is not None and b.get("type") == "tool_use":
                raw = "".join(self.partial.pop(i, []))
                try:
                    b["input"] = json.loads(raw) if raw else {}
                except ValueError:
                    raise UpstreamError("upstream_unavailable", None, "bad_tool_json") from None
                out.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"]})
        elif t == "message_delta":
            self.stop_reason = (ev.get("delta") or {}).get("stop_reason") or self.stop_reason
            self.usage.update(ev.get("usage") or {})
        elif t == "message_stop":
            self.stopped = True
        return out

    def final(self, result_usage: dict | None) -> dict | None:
        if not self.stopped:
            return None
        src = result_usage if isinstance(result_usage, dict) and result_usage else self.usage
        usage = {k: src[k] for k in USAGE_KEYS if isinstance(src.get(k), int)}
        return {"type": "final", "content": [dict(self.blocks[i]) for i in self.order], "usage": usage,
                "stop_reason": self.stop_reason}


def _deny_hook():
    async def pre_tool_use(input_data, tool_use_id, context):
        return {"continue_": False,
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": DENY_REASON}}

    return pre_tool_use


class AgentSdkGateway:
    """query_fn: テスト用（claude_agent_sdk.query と同じ形の async generator 関数）。cli_path: テスト用（偽の CLI）。
    extra_env: テスト用（ANTHROPIC_BASE_URL など）。tool_calls: SDK のツールの関数が呼ばれた回数（0 のはず）"""

    def __init__(self, secret: str | None, query_fn: Callable | None = None, cli_path: str | None = None,
                 extra_env: dict[str, str] | None = None, monotonic: Callable[[], float] = time.monotonic):
        self._secret = secret
        self._query_fn = query_fn
        self._cli_path = cli_path
        self._extra_env = dict(extra_env or {})
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self.tool_calls = 0
        quiet_sdk_logs("anthropic")
        quiet_sdk_logs("claude_agent_sdk")

    def __repr__(self) -> str:  # トークンを repr に出さない
        return "AgentSdkGateway(credential='oauth_token')"

    def warm(self) -> None:
        """import だけ（子は起動しない）。失敗は最初の要求で出る"""
        try:
            import claude_agent_sdk  # noqa: F401
        except Exception:
            pass

    def start_warm(self) -> threading.Thread:
        thread = threading.Thread(target=self.warm, name="ai-warm", daemon=True)
        thread.start()
        return thread

    # ---- 組み立て ----
    def _server(self, tools: list[dict]):
        from claude_agent_sdk import create_sdk_mcp_server

        return create_sdk_mcp_server(name=SERVER, version="1.0.0", tools=self.sdk_tools(tools))

    def sdk_tools(self, tools: list[dict]) -> list:
        """ツールの定義（relay の params["tools"]）→ SDK MCP のツール（名前・説明・JSON Schema はそのまま）"""
        from claude_agent_sdk import tool as sdk_tool

        def make(t: dict):
            async def handler(args):  # 呼ばれない前提（フックが止める）。呼ばれたら実行せずにエラーを返す
                with self._lock:
                    self.tool_calls += 1
                return {"content": [{"type": "text", "text": "not available"}], "is_error": True}

            return sdk_tool(t["name"], t["description"], t["input_schema"])(handler)

        return [make(t) for t in tools]

    def options(self, params: dict, base_dir: str, resume_turn: bool, store=None, session_id: str | None = None):
        from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

        cfg_dir, cwd = f"{base_dir}/cfg", f"{base_dir}/cwd"
        tools = params.get("tools") or []
        kw = {}
        if store is not None:
            kw = {"session_store": store, "resume": session_id}
        return ClaudeAgentOptions(
            tools=[],
            system_prompt=params["system"],
            mcp_servers={SERVER: self._server(tools)} if tools else {},
            strict_mcp_config=True,
            setting_sources=[],
            model=params["model"],
            thinking=dict(params["thinking"]),
            effort=(params.get("output_config") or {}).get("effort"),
            include_partial_messages=True,
            verbatim_prompts=True,
            max_turns=1,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[_deny_hook()])]},
            cli_path=self._cli_path,
            cwd=cwd,
            env=child_env(self._secret or "", cfg_dir, params["max_tokens"], resume_turn, self._extra_env),
            stderr=lambda line: None,  # CLI の標準エラーは本文を含みうるので捨てる
            **kw,
        )

    # ---- 送信 ----
    def stream(self, params: dict, cancel: threading.Event) -> Iterator[dict]:
        started = self._monotonic()  # spawn_ms の起点（import・子の起動・CLI の初期化を含む）
        q: queue.Queue = queue.Queue()
        stop = threading.Event()
        thread = threading.Thread(target=self._thread, args=(params, cancel, stop, q, started), name="ai-agent-sdk",
                                  daemon=True)
        thread.start()
        try:
            while True:
                item = q.get()
                if item is _DONE:
                    return
                if isinstance(item, UpstreamError):
                    raise item
                yield item
        finally:
            stop.set()  # 受け手が止めた（中継の cancel・締め切り・切断）: 子を止めて一時ディレクトリを消す

    def _thread(self, params, cancel, stop, q, started) -> None:
        base = tempfile.mkdtemp(prefix="ai-sdk-")
        try:
            os.mkdir(f"{base}/cfg", 0o700)
            os.mkdir(f"{base}/cwd", 0o700)
            asyncio.run(self._run(params, cancel, stop, q, base, started))
        except BaseException as e:  # noqa: BLE001 - 型だけを中継に渡す
            q.put(UpstreamError("upstream_unavailable", None, type(e).__name__))
        finally:
            shutil.rmtree(base, ignore_errors=True)
            q.put(_DONE)

    async def _run(self, params, cancel, stop, q, base, started) -> None:
        """取り消しは anyio の cancel scope で（SDK の後始末 = 子の stdin を閉じ → 5 秒待って SIGTERM → SIGKILL は
        anyio の shield の中で走る。asyncio の素の task.cancel() だと後始末の段階が飛ばされ子が残る）"""
        import anyio

        with anyio.CancelScope() as scope:
            async with anyio.create_task_group() as tg:
                async def watch() -> None:
                    while not (cancel.is_set() or stop.is_set()):
                        await anyio.sleep(CANCEL_POLL_SECONDS)
                    scope.cancel()

                tg.start_soon(watch)
                await self._consume(params, q, base, started)
                tg.cancel_scope.cancel()

    async def _consume(self, params, q, base, started) -> None:
        from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent
        from claude_agent_sdk._cli_version import __cli_version__

        query_fn = self._query_fn
        if query_fn is None:
            from claude_agent_sdk import query as query_fn

        history, prompt = split_last(params["messages"])
        store = session_id = None
        if history:
            session_id = str(uuid.uuid4())
            store = OneShotStore(session_id, history_entries(history, session_id, f"{base}/cwd", params["model"],
                                                             __cli_version__))
        opts = self.options(params, base, prompt is None, store, session_id)

        # 入力の stream は結果（ResultMessage）か報告・終わりまで開けておく。prompt が None（最後が tool_result）で
        # 空のまま終えると、SDK は 1 件も書いていないので stdin をすぐ閉じ（Query.stream_input）、CLI からの制御要求
        # （SDK MCP の接続・tools/list、PreToolUse のフック）に答えられず、上流への要求からツールが全部落ちる（#209）
        input_done = asyncio.Event()

        async def prompt_stream():
            if prompt is not None:
                yield {"type": "user", "message": {"role": "user", "content": prompt}, "parent_tool_use_id": None,
                       "session_id": "default"}
            else:
                await input_done.wait()

        asm = Assembler()
        assistant_error = None
        spawned = False
        reported = False  # final か失敗を 1 回だけ中継に渡す

        def report(item) -> None:
            nonlocal reported
            if not reported:
                reported = True
                q.put(item)
            input_done.set()

        # 途中で抜けない（break・return・本体の例外）: 公開の query() は内側の generator を aclose しないので、抜けると
        # 子の後始末（SDK の shield の中の close）が走らない。報告の後は CLI が終わるまで読み捨て、中継の cancel
        # （final の直後に必ず来る）で cancel scope ごと取り消す = 内側の finally まで届いて子が止まる
        try:
            async for m in query_fn(prompt=prompt_stream(), options=opts):
                if reported:
                    continue
                try:
                    if isinstance(m, StreamEvent):
                        if m.parent_tool_use_id is not None:
                            continue
                        if not spawned:
                            spawned = True
                            q.put({"type": "meta", "spawn_ms": round((self._monotonic() - started) * 1000)})
                        for ev in asm.feed(m.event):
                            q.put(ev)
                    elif isinstance(m, AssistantMessage):
                        assistant_error = m.error or assistant_error
                    elif isinstance(m, ResultMessage):
                        if m.is_error:
                            status = m.api_error_status if isinstance(m.api_error_status, int) else None
                            report(UpstreamError(code_for(status, assistant_error), status, f"result:{m.subtype}"))
                        else:
                            final = asm.final(m.usage)
                            if final is not None:  # final が無ければ中継が upstream_incomplete にする
                                report(final)
                except UpstreamError as e:
                    report(e)
        except Exception as e:  # noqa: BLE001
            report(classify_exception(e, assistant_error))
        finally:
            input_done.set()

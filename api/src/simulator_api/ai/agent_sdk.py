"""AI の送信先: Claude Agent SDK（claude-agent-sdk。同梱の Claude Code CLI を子プロセスで動かす）を **送信路としてだけ**
使う（#186 = ADR-0005。#221 = ADR-0006 で資格情報の 3 種類 oauth_token・api_key・wif をすべてこの送信路に一本化し、
スキル（Agent Skills）を読ませる）。

サブスクリプションの OAuth トークンは Messages API の直接呼び出しでは 429 になり、CLI 経由でだけ使える
（ADR-0001 の追補）。api_key・wif も同じ送信路で送る（送信路を 1 つにして、スキルの仕組みを 1 つにする）。
中継の残り（許可リスト・system prompt・ツールの登録・SSE・締め切り・中止・同時の本数・1 分の回数・ログ）は
変えない。
stream(params, cancel) は事象（thinking / text / tool_use / final）を返し、最初の事象の前に
{"type": "meta", "spawn_ms"}（子の起動 → 最初の StreamEvent）を、final の前に {"type": "meta", "skills", "turns",
"docs"}（読んだスキルの名前・上流の turn の数・読んだ文書の節の番号）を 1 回ずつ返す（中継は ai_request に載せるだけ）。

作り（spike S1〜S6 の結果。ADR-0005・ADR-0006）:
- ツール 6 本は in-process の SDK MCP ツール（名前は mcp__sim__<名>）として CLI に見せる。モデルが tool_use を出したら
  PreToolUse フックが deny + continue_=False を返し、CLI はツールを実行せずに turn を終える（関数は呼ばれない前提。
  呼ばれたら is_error を返す）。組み込みのツールは tools=["Skill"] の 1 本だけ。例外は文書の read_doc（下）
- スキル（ai/skills.py・ai/plugin/）: plugins にパッケージ内のプラグインを、skills に一覧を渡す。Skill はフックで
  一覧の名前だけ通し（CLI の中で SKILL.md を読んで次の turn へ）、一覧に無い名前は deny（turn は続く）。1 要求で上流を
  最大 AI_MAX_TURNS 回呼ぶ。Skill の tool_use は事象に出さず final にも入れない（final は最後の message の block）。
  読んだ内容は次の要求に残らない（中継は状態を持たない。要れば次の要求で読み直す）
- 文書（ai/docs.py。#137 = ADR-0007）: 文書を読むツール read_doc は **中継の中で実行する** in-process の
  SDK MCP ツール（server 名 docs = CLI の名前 mcp__docs__read_doc。relay が params["server_tools"] に定義を
  入れたときだけ）。フックが allow し、関数（docs.Reader。要求ごとに大きさ・回数を数える）が節の本文を返す。
  tool_use は Skill と同じく事象・final に出さず、読んだ節の番号だけを meta の docs に残す
- 事象は include_partial_messages の StreamEvent（生の API の SSE 事象）から組み立てる。AssistantMessage は
  redacted_thinking を落とすので content には使わない（error の種類だけ見る）
- 履歴は要求ごとのメモリ上の SessionStore（load だけが履歴から作った transcript の項目を返す）+ resume=<新しい uuid>。
  最後の user が text なら stream-json の prompt で渡す（verbatim_prompts=True: `@<パス>` をファイルとして読ませない）。
  最後の user が tool_result なら、それも transcript に入れ、prompt は空にして CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 で
  turn を続けさせる（CLI はその user の末尾に CLAUDE_CODE_RESUME_PROMPT の文を 1 つ足す）
- 子の環境は親に「重なる」だけなので、CLI が資格情報・送信先の選択として読む変数（CREDENTIAL_ENV）を全部空で
  上書きし、選んだ種類のものだけを入れる: oauth_token → CLAUDE_CODE_OAUTH_TOKEN、api_key → ANTHROPIC_API_KEY、
  wif → WIF の ID と ANTHROPIC_IDENTITY_TOKEN（要求ごとにメタデータサーバーから取る。CLI は自分で取らない）。
  交換したトークンのキャッシュ（ANTHROPIC_CONFIG_DIR・CLAUDE_CODE_FEDERATION_CACHE_DIR）は要求ごとの一時ディレクトリ
- 設定・CLAUDE.md・自動のメモリを読まない（setting_sources=[]・CLAUDE_CODE_DISABLE_AUTO_MEMORY）。設定ディレクトリと
  cwd は要求ごとの一時ディレクトリ（終わったら消す）。CLI の標準エラーは捨てる（本文をログに出さない）
- 再試行しない（CLAUDE_CODE_MAX_RETRIES=0。既定では 429 を 100 秒以上再試行する）。出力の上限は max_tokens を
  CLAUDE_CODE_MAX_OUTPUT_TOKENS で

transcript の形・CLAUDE_CODE_RESUME_*・Skill の入力の形は文書化されていない CLI の内部に依存する。SDK の版
（= 同梱の CLI の版）を pyproject.toml・uv.lock で固定し、tests/test_ai_agent_sdk_cli.py（本物の CLI と 127.0.0.1 の
偽の Messages API）で守る。

SDK は async なので、要求ごとに専用のスレッドで event loop を立て（asyncio.run）、事象を queue で gthread の側へ渡す。
cancel（中継の締め切り・中止・切断）を 0.05 秒ごとに見て、anyio の cancel scope で query を取り消す（SDK の後始末が
子の stdin を閉じ、終わらなければ SIGTERM・SIGKILL で止める）。
"""

import asyncio
import json
import os
import queue
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

from .. import settings as st
from . import docs, skills
from .gateway import IdentityTokenError, UpstreamError, metadata_identity_token, quiet_sdk_logs

SERVER = "sim"  # SDK MCP の server 名（CLI のツールの名前は mcp__sim__<名>）
CLI_PREFIX = f"mcp__{SERVER}__"
# 最後の user が tool_result の turn で CLI がその user の末尾に足す文（空にはできない。ADR-0005）
RESUME_PROMPT = "Continue from the tool results."
CANCEL_POLL_SECONDS = 0.05
USAGE_KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
CACHE_CREATION_KEYS = ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")
DENY_REASON = "The browser runs this tool and returns tool_result in the next request."
_DONE = object()  # 事象の queue の終わりの印
SKILL_TOOL = "Skill"  # CLI の組み込みのツール（入力は {"skill": "<プラグイン>:<スキル>", "args"?}）
SKILL_DENY_REASON = "This skill is not available."
# CLI が資格情報・送信先（プロバイダ）の選択として読む変数（同梱の CLI 2.1.283 の文字列から）。子には全部を空で渡し、
# 選んだ種類のものだけを入れる（SDK の env は親の環境に重なるだけ = 空で上書きしないと親の値が子に渡る。ADR-0005 S5）
CREDENTIAL_ENV = (
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_GATEWAY_TOKEN", "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_PROFILE", "ANTHROPIC_SCOPE", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_AWS_API_KEY",
)
# CLI が読む送信先・転送・クライアント証明書の変数（同梱の CLI 2.1.283 の文字列から）。親に残っていると、選んだ
# 資格情報が別の宛先に送られうるので子には空で渡す（空なら CLI は既定の api.anthropic.com に送る =
# tests/test_ai_agent_sdk_cli.py）。テストの extra_env（偽の送信先の ANTHROPIC_BASE_URL）はこの後に重ねる
ROUTING_ENV = (
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_HOST", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_PROXY_URL", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
)
CREDENTIALS = ("oauth_token", "api_key", "wif")
# WIF の交換（POST /v1/oauth/token）の失敗。CLI は状態を api_error_status に入れず、AssistantMessage の文
# （error="unknown"）にだけ書くので、文から状態の 3 桁だけを取る（文はログ・応答に出さない。CLI 2.1.283 の文言。
# tests/test_ai_agent_sdk_cli.py で固定）
_EXCHANGE_FAILED_RE = re.compile(r"Token exchange failed with status (\d{3})\b")


def exchange_failure_status(content) -> int | None:
    for b in content or []:
        m = _EXCHANGE_FAILED_RE.search(getattr(b, "text", None) or "")
        if m:
            return int(m.group(1))
    return None


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


def credential_env(credential: str, secret: str | None, wif: st.WifIds | None = None,
                   identity_token: str | None = None) -> dict[str, str]:
    """資格情報の変数（CREDENTIAL_ENV の全部。選んだ種類のものだけ非空）"""
    env = dict.fromkeys(CREDENTIAL_ENV, "")
    if credential == "oauth_token":
        env["CLAUDE_CODE_OAUTH_TOKEN"] = secret or ""
    elif credential == "api_key":
        env["ANTHROPIC_API_KEY"] = secret or ""
    elif credential == "wif":
        if wif is None or not identity_token:
            raise ValueError("wif")
        env["ANTHROPIC_FEDERATION_RULE_ID"] = wif.federation_rule_id
        env["ANTHROPIC_ORGANIZATION_ID"] = wif.organization_id
        env["ANTHROPIC_SERVICE_ACCOUNT_ID"] = wif.service_account_id or ""
        env["ANTHROPIC_WORKSPACE_ID"] = wif.workspace_id or ""
        env["ANTHROPIC_IDENTITY_TOKEN"] = identity_token
    else:
        raise ValueError("credential")
    return env


def child_env(credential: str, secret: str | None, config_dir: str, max_tokens: int, resume_turn: bool,
              wif: st.WifIds | None = None, identity_token: str | None = None,
              extra: dict[str, str] | None = None) -> dict[str, str]:
    """子の環境（親の環境に重なる）。資格情報は選んだ種類のものだけ（他は空で上書き = CLI は未設定として扱う。
    spike S5）。送信先・転送の変数（ROUTING_ENV）も空。extra はテスト用（ANTHROPIC_BASE_URL を偽の送信先に）"""
    env = {
        **dict.fromkeys(ROUTING_ENV, ""),
        **credential_env(credential, secret, wif, identity_token),
        "CLAUDE_CONFIG_DIR": config_dir,
        # WIF の交換したトークンのキャッシュ・プロファイルの置き場所（要求ごとの一時ディレクトリ = 要求の間で持たない）
        "ANTHROPIC_CONFIG_DIR": f"{config_dir}/anthropic",
        "CLAUDE_CODE_FEDERATION_CACHE_DIR": f"{config_dir}/federation",
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


def _add_usage(total: dict, part: dict) -> None:
    """usage を足す（4 キーの整数と cache_creation の内訳）"""
    for k in USAGE_KEYS:
        v = part.get(k)
        if isinstance(v, int) and not isinstance(v, bool):
            total[k] = total.get(k, 0) + v
    cc = part.get("cache_creation")
    if isinstance(cc, dict):
        dst = total.setdefault("cache_creation", {})
        for k in CACHE_CREATION_KEYS:
            v = cc.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                dst[k] = dst.get(k, 0) + v


class Assembler:
    """StreamEvent.event（生の API の SSE 事象）→ 中継の事象と final の content。

    1 要求で上流の message は複数ありうる（Skill の turn の後に答えの turn。最大 AI_MAX_TURNS）。message ごとに
    block を作り直し、final の content と stop_reason は最後の message のもの。Skill の tool_use は事象に出さず
    content からも落とす（読んだスキルの名前だけを skills に残す）。usage は全 message の合計"""

    def __init__(self):
        self.blocks: dict[int, dict] = {}
        self.order: list[int] = []
        self.partial: dict[int, list[str]] = {}
        self.skill_blocks: set[int] = set()
        self.hidden_blocks: set[int] = set()  # 事象・final に出さない tool_use（Skill と read_doc）
        self.stop_reason: str | None = None
        self.usage: dict = {}  # 終わった message の合計
        self.current_usage: dict = {}  # 流れている message の（message_start の後に message_delta で更新）
        self.messages = 0
        self.stopped = False
        self.skills: list[str] = []

    def _close_message(self) -> None:
        if self.current_usage:
            _add_usage(self.usage, self.current_usage)
        self.current_usage = {}

    def feed(self, ev: dict) -> list[dict]:
        t = ev.get("type")
        out: list[dict] = []
        if t == "message_start":
            self._close_message()  # message_stop が来ないまま次が始まっても usage は落とさない
            self.messages += 1
            self.blocks, self.order, self.partial, self.skill_blocks, self.hidden_blocks = {}, [], {}, set(), set()
            self.stop_reason = None
            self.stopped = False
            self.current_usage = dict((ev.get("message") or {}).get("usage") or {})
        elif t == "content_block_start":
            i = ev["index"]
            cb = dict(ev.get("content_block") or {})
            if cb.get("type") == "thinking":
                cb = {"type": "thinking", "thinking": cb.get("thinking") or "", "signature": cb.get("signature") or ""}
            elif cb.get("type") == "text":
                cb = {"type": "text", "text": cb.get("text") or ""}
            elif cb.get("type") == "tool_use":
                if cb.get("name") == SKILL_TOOL:
                    self.skill_blocks.add(i)
                    self.hidden_blocks.add(i)
                elif cb.get("name") == docs.CLI_TOOL_NAME:  # 中継が実行する（ブラウザに渡さない）
                    self.hidden_blocks.add(i)
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
                if i in self.skill_blocks:
                    name = b["input"].get("skill") if isinstance(b["input"], dict) else None
                    if skills.is_enabled(name) and name not in self.skills:
                        self.skills.append(name)
                elif i in self.hidden_blocks:
                    pass
                else:
                    out.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"]})
        elif t == "message_delta":
            self.stop_reason = (ev.get("delta") or {}).get("stop_reason") or self.stop_reason
            self.current_usage.update(ev.get("usage") or {})
        elif t == "message_stop":
            self.stopped = True
            self._close_message()
        return out

    def meta(self, docs_read: list[str] | None = None) -> dict:
        return {"type": "meta", "skills": list(self.skills), "turns": self.messages, "docs": list(docs_read or [])}

    def final(self) -> dict | None:
        """最後の message の block（Skill・read_doc を除く）と全 message の usage の合計。最後の message が
        終わっていなければ None（中継が upstream_incomplete にする）。usage は生の事象から足す（CLI 2.1.283 の
        ResultMessage.usage も全 turn の合計だが、CLI の集計に頼らない。tests/test_ai_agent_sdk_cli.py で両者の
        一致を確かめる）"""
        if not self.stopped:
            return None
        usage = {k: self.usage[k] for k in USAGE_KEYS if k in self.usage}
        if self.usage.get("cache_creation"):
            usage["cache_creation"] = dict(self.usage["cache_creation"])
        return {"type": "final", "content": [dict(self.blocks[i]) for i in self.order if i not in self.hidden_blocks],
                "usage": usage, "stop_reason": self.stop_reason}


def _hook(reader: docs.Reader | None = None):
    """PreToolUse: 一覧にあるスキルの Skill は通す（CLI が SKILL.md を読む）。一覧に無い名前の Skill は deny（turn は
    続く = モデルが別の手で答える）。文書の read_doc（mcp__docs__read_doc ちょうど）は allow（中継の関数が節を返す。
    入力の検査は関数の側）。ただし 1 要求で AI_DOC_MAX_READS 回を超えた read_doc は deny + continue_=False（要求を
    終える = 結果を上流に送らない。予約額の上界の前提。settings の説明）。それ以外（mcp__sim__*）は
    deny + continue_=False（ブラウザが実行する）"""

    async def pre_tool_use(input_data, tool_use_id, context):
        if input_data.get("tool_name") == docs.CLI_TOOL_NAME:
            if reader is None or not reader.permit():
                return {"continue_": False,
                        "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                               "permissionDecisionReason": "read_doc limit reached."}}
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow",
                                           "permissionDecisionReason": "read_doc runs in the relay."}}
        if input_data.get("tool_name") == SKILL_TOOL:
            tool_input = input_data.get("tool_input")
            if skills.is_enabled(tool_input.get("skill") if isinstance(tool_input, dict) else None):
                return {}
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                           "permissionDecisionReason": SKILL_DENY_REASON}}
        return {"continue_": False,
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": DENY_REASON}}

    return pre_tool_use


class AgentSdkGateway:
    """credential: oauth_token / api_key / wif（中継が選んだ 1 種類）。secret: oauth_token・api_key の値。
    wif: WIF の ID（wif のとき）。identity_token: テスト用（Google の ID トークンを返す関数。省略時は
    メタデータサーバー）。
    query_fn: テスト用（claude_agent_sdk.query と同じ形の async generator 関数）。cli_path: テスト用（偽の CLI）。
    extra_env: テスト用（ANTHROPIC_BASE_URL など）。tool_calls: SDK のツールの関数が呼ばれた回数（0 のはず）"""

    def __init__(self, secret: str | None, credential: str = "oauth_token", wif: st.WifIds | None = None,
                 identity_token: Callable[[], str] | None = None, query_fn: Callable | None = None,
                 cli_path: str | None = None, extra_env: dict[str, str] | None = None,
                 monotonic: Callable[[], float] = time.monotonic):
        if credential not in CREDENTIALS or (credential == "wif" and wif is None):
            raise ValueError("credential")
        self._credential = credential
        self._secret = secret
        self._wif = wif
        self._identity_token = identity_token or metadata_identity_token
        self._query_fn = query_fn
        self._cli_path = cli_path
        self._extra_env = dict(extra_env or {})
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self.tool_calls = 0
        quiet_sdk_logs("claude_agent_sdk")

    def __repr__(self) -> str:  # トークン・鍵・WIF の ID を repr に出さない
        return f"AgentSdkGateway(credential={self._credential!r})"

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

    @staticmethod
    def docs_tool(reader: docs.Reader):
        """文書の read_doc（中継の中で実行する SDK MCP のツール。入力の検査と上限は reader）"""
        from claude_agent_sdk import tool as sdk_tool

        d = docs.TOOL_DEFINITION

        async def handler(args):
            text, is_error = reader(args)
            out = {"content": [{"type": "text", "text": text}]}
            if is_error:
                out["is_error"] = True
            return out

        return sdk_tool(d["name"], d["description"], d["input_schema"])(handler)

    def docs_server(self, reader: docs.Reader):
        from claude_agent_sdk import create_sdk_mcp_server

        return create_sdk_mcp_server(name=docs.SERVER, version="1.0.0", tools=[self.docs_tool(reader)])

    def options(self, params: dict, base_dir: str, resume_turn: bool, store=None, session_id: str | None = None,
                identity_token: str | None = None, reader: docs.Reader | None = None):
        from claude_agent_sdk import ClaudeAgentOptions, HookMatcher

        cfg_dir, cwd = f"{base_dir}/cfg", f"{base_dir}/cwd"
        tools = params.get("tools") or []
        kw = {}
        if store is not None:
            kw = {"session_store": store, "resume": session_id}
        servers = {SERVER: self._server(tools)} if tools else {}
        if reader is not None:
            servers[docs.SERVER] = self.docs_server(reader)
        return ClaudeAgentOptions(
            tools=[SKILL_TOOL],  # 組み込みのツールは Skill だけ（Read・Bash などは無い）
            skills=list(skills.ENABLED),
            plugins=[{"type": "local", "path": str(skills.PLUGIN_DIR)}],
            system_prompt=params["system"],
            mcp_servers=servers,
            strict_mcp_config=True,
            setting_sources=[],
            model=params["model"],
            thinking=dict(params["thinking"]),
            effort=(params.get("output_config") or {}).get("effort"),
            include_partial_messages=True,
            verbatim_prompts=True,
            max_turns=st.AI_MAX_TURNS,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[_hook(reader)])]},
            cli_path=self._cli_path,
            cwd=cwd,
            env=child_env(self._credential, self._secret, cfg_dir, params["max_tokens"], resume_turn, self._wif,
                          identity_token, self._extra_env),
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
            identity_token = None
            if self._credential == "wif":
                # 要求ごとに取り直す（Google の ID トークンは約 1 時間で切れる。1 要求 = 1 子 = 1 回の交換）。
                # 取れなければ子を起動しない
                try:
                    identity_token = self._identity_token()
                except IdentityTokenError:
                    q.put(UpstreamError("upstream_auth", None, "IdentityTokenError"))
                    return
            os.mkdir(f"{base}/cfg", 0o700)
            os.mkdir(f"{base}/cwd", 0o700)
            asyncio.run(self._run(params, cancel, stop, q, base, started, identity_token))
        except BaseException as e:  # noqa: BLE001 - 型だけを中継に渡す
            q.put(UpstreamError("upstream_unavailable", None, type(e).__name__))
        finally:
            shutil.rmtree(base, ignore_errors=True)
            q.put(_DONE)

    async def _run(self, params, cancel, stop, q, base, started, identity_token=None) -> None:
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
                await self._consume(params, q, base, started, identity_token)
                tg.cancel_scope.cancel()

    async def _consume(self, params, q, base, started, identity_token=None) -> None:
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
        # 文書の read_doc は relay が定義を入れたときだけ（索引が無ければ入らない）
        idx = docs.index() if any(t.get("name") == docs.TOOL_NAME for t in params.get("server_tools") or []) else None
        reader = docs.Reader(idx) if idx is not None else None
        opts = self.options(params, base, prompt is None, store, session_id, identity_token, reader)

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
        exchange_status = None
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
                        if m.error and exchange_status is None:
                            exchange_status = exchange_failure_status(m.content)
                    elif isinstance(m, ResultMessage):
                        if m.is_error:
                            q.put(asm.meta(reader.read if reader else None))  # turn の上限でも読んだもの・turn をログに
                            status = m.api_error_status if isinstance(m.api_error_status, int) else None
                            etype = f"result:{m.subtype}"
                            if status is None and exchange_status is not None:
                                status, etype = exchange_status, "token_exchange"
                            report(UpstreamError(code_for(status, assistant_error), status, etype))
                        else:
                            final = asm.final()
                            if final is not None:  # final が無ければ中継が upstream_incomplete にする
                                q.put(asm.meta(reader.read if reader else None))
                                report(final)
                except UpstreamError as e:
                    report(e)
        except Exception as e:  # noqa: BLE001
            report(classify_exception(e, assistant_error))
        finally:
            input_done.set()

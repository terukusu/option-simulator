"""要求の本文の許可リスト（docs/ai-advisor.md 論点 1・6、K15）と、送る本文の組み立て直し。純関数。

ブラウザから受けるのは schema_version・kind・context・messages だけ（model・system・tools・max_tokens などは 400）。
context に自由な文字列は無い（列挙・日付・時刻の形だけ）。板の行に JPX のグリーク・bid_iv / ask_iv・数量・建玉・出来高は
無い（許可リストに無いので 400）。IV は simulator の IV（%）。

送る本文は検査済みの値から作り直す: context は sort_keys の JSON（決定的）にして最初の user の先頭の text block に置き、
tool_result の JSON も同じく正規化する。同じ入力 → 同じバイト列（prompt caching の前置きと thinking の履歴を保つ）。
"""

import json
from dataclasses import dataclass

from .shape import DATE, INSTANT, MONTH, Arr, Bad, Bool, Enum, Map, Num, Obj, Str, Text
from .tools import Registry

SCHEMA_VERSION = 1
KINDS = ("chat",)  # 定型の種類。#135・#140 が足す

MAX_PRICE = 10_000_000  # 価格・行使価格・F の上限（円。形の検査の安全弁）
MAX_EXPIRIES = 6
MAX_EXPIRIES_WITH_ROWS = 2
MAX_ROWS = 600
MAX_SMILE = 41
MAX_LEGS = 20
MAX_MESSAGES = 60
MAX_BLOCKS = 20  # 1 件の message の block の数
MAX_USER_TEXT = 4_000  # 利用者の 1 block
MAX_ASSISTANT_TEXT = 20_000  # AI の 1 block（max_tokens 8000 の出力を受け直せる大きさ）
MAX_THINKING_TEXT = 50_000
MAX_OPAQUE = 100_000  # thinking の signature・redacted_thinking の data（Anthropic が付けた不透明な値）
MAX_FREE_TEXT_TOTAL = 100_000  # 自由文（text・thinking）の合計
MAX_TOOL_JSON = 50_000  # tool_result の JSON の字数
CONTEXT_OPEN = "<context>"  # 送る本文で context を包む印（system prompt が参照する）
CONTEXT_CLOSE = "</context>"

POS = Num(0, MAX_PRICE, lo_open=True)
NONNEG = Num(0, MAX_PRICE)
IV = Num(0, 300)
OPT_TYPE = Enum(("C", "P"))

ROW = Obj({"k": POS, "type": OPT_TYPE, "bid": Num(0, MAX_PRICE, nullable=True),
           "ask": Num(0, MAX_PRICE, nullable=True), "iv": Num(0, 300, nullable=True)})
EXPIRY = Obj({
    "expiry": MONTH, "sq_date": DATE, "t_days": Num(0, 400), "forward": POS, "atm_k": POS, "atm_iv": IV,
    "smile": Arr(Obj({"m": Num(-2, 2), "iv": IV}), MAX_SMILE),
    "rows": Arr(ROW, MAX_ROWS),
}, frozenset({"rows"}))
LEG = Obj({
    "product": Enum(("op", "fut_large", "fut_mini", "fut_micro")), "type": OPT_TYPE, "expiry": MONTH, "k": POS,
    "side": Enum(("buy", "sell")), "qty": Num(1, 1000, integer=True), "price": NONNEG,
}, frozenset({"type", "k"}))
SNAPSHOT = Obj({"snapshot_at": INSTANT, "source": Enum(("bigquery", "file", "synthetic", "manual")),
                "delayed_minutes": Num(0, 60, integer=True)})
SCENARIO = Obj({"days": Num(0, 400), "iv_shift_pt": Num(-100, 100), "x_range": Arr(POS, 2, fixed=True)})
CAPITAL = Obj({"capital_yen": Num(0, 1e12), "max_loss_yen": Num(0, 1e12)}, frozenset({"max_loss_yen"}))

TOOL_USE_ID = Str(r"[A-Za-z0-9_-]{1,128}", 128)
OPAQUE = Str(r"[A-Za-z0-9+/=_.-]*", MAX_OPAQUE)
TOOL_ERROR = Obj({"error": Str(r"[a-z_]{1,40}", 40)})


def context_shape(registry: Registry) -> Obj:
    precomputed = Map({name: spec.result_shape for name, spec in registry.items()}, max(len(registry), 1))
    return Obj({
        "snapshot": SNAPSHOT,
        "expiries": Arr(EXPIRY, MAX_EXPIRIES),
        "position": Obj({"legs": Arr(LEG, MAX_LEGS)}),
        "scenario": SCENARIO,
        "capital": CAPITAL,
        "precomputed": precomputed,
    }, frozenset({"expiries", "position", "scenario", "capital", "precomputed"}))


@dataclass(frozen=True)
class AiRequest:
    kind: str
    context: dict
    messages: list[dict]

    def tool_names(self) -> list[str]:
        """会話に出た道具の名前（ログ用。重複なし・出た順）"""
        out: list[str] = []
        for m in self.messages:
            for b in m["content"]:
                if b["type"] == "tool_use" and b["name"] not in out:
                    out.append(b["name"])
        return out


def _reject_constant(name):
    raise ValueError(name)


def loads(raw: bytes):
    """JSON を読む（NaN・Infinity を拒否。重複したキーも拒否 = どちらが効くかの食い違いを作らない）"""

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise ValueError("duplicate key")
            out[k] = v
        return out

    try:
        return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant, object_pairs_hook=pairs)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise Bad("body", "json") from e


def canonical(value) -> str:
    """決定的な JSON（キーの順・区切り・非 ASCII をそのまま）"""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _check_context(raw, registry: Registry) -> dict:
    ctx = context_shape(registry).check(raw, "context")
    with_rows = [i for i, e in enumerate(ctx.get("expiries", [])) if "rows" in e]
    if len(with_rows) > MAX_EXPIRIES_WITH_ROWS:
        raise Bad(f"context.expiries[{with_rows[MAX_EXPIRIES_WITH_ROWS]}].rows", "size")
    for i, leg in enumerate(ctx.get("position", {}).get("legs", [])):
        is_op = leg["product"] == "op"
        if is_op != ("type" in leg) or is_op != ("k" in leg):
            raise Bad(f"context.position.legs[{i}]", "shape")
    return ctx


def _check_tool_json(text, spec, path: str):
    if not isinstance(text, str):
        raise Bad(path, "type")
    if len(text) > MAX_TOOL_JSON:
        raise Bad(path, "size")
    try:
        value = loads(text.encode("utf-8"))
    except Bad as e:
        raise Bad(path, "json") from e
    return spec.check(value, path)


def _user_block(block, path: str, pending: dict[str, str], registry: Registry, seen_text: bool):
    if not isinstance(block, dict):
        raise Bad(path, "type")
    kind = block.get("type")
    if kind == "text":
        Obj({"type": Enum(("text",)), "text": Text(MAX_USER_TEXT, 1)}).check(block, path)
        return {"type": "text", "text": block["text"]}
    if kind == "tool_result":
        if seen_text:
            raise Bad(path, "order")  # tool_result は text より前（Messages API の決まり）
        b = Obj({"type": Enum(("tool_result",)), "tool_use_id": TOOL_USE_ID,
                 "content": Arr(Obj({"type": Enum(("text",)), "text": Text(MAX_TOOL_JSON)}), 1, min_len=1),
                 "is_error": Bool()}, frozenset({"is_error"})).check(block, path)
        name = pending.pop(b["tool_use_id"], None)
        if name is None:
            raise Bad(f"{path}.tool_use_id", "unmatched")
        is_error = b.get("is_error", False)
        spec = TOOL_ERROR if is_error else registry[name].result_shape
        value = _check_tool_json(b["content"][0]["text"], spec, f"{path}.content[0].text")
        out = {"type": "tool_result", "tool_use_id": b["tool_use_id"],
               "content": [{"type": "text", "text": canonical(value)}]}
        if is_error:
            out["is_error"] = True
        return out
    raise Bad(f"{path}.type", "enum")


def _assistant_block(block, path: str, registry: Registry):
    if not isinstance(block, dict):
        raise Bad(path, "type")
    kind = block.get("type")
    if kind == "text":
        Obj({"type": Enum(("text",)), "text": Text(MAX_ASSISTANT_TEXT)}).check(block, path)
        return {"type": "text", "text": block["text"]}
    if kind == "thinking":
        b = Obj({"type": Enum(("thinking",)), "thinking": Text(MAX_THINKING_TEXT),
                 "signature": OPAQUE}).check(block, path)
        return {"type": "thinking", "thinking": b["thinking"], "signature": b["signature"]}
    if kind == "redacted_thinking":
        b = Obj({"type": Enum(("redacted_thinking",)), "data": OPAQUE}).check(block, path)
        return {"type": "redacted_thinking", "data": b["data"]}
    if kind == "tool_use":
        name = block.get("name")
        if not isinstance(name, str) or name not in registry:
            raise Bad(f"{path}.name", "unknown_tool")
        spec = registry[name]
        b = Obj({"type": Enum(("tool_use",)), "id": TOOL_USE_ID, "name": Enum((name,)),
                 "input": spec.input_shape}).check(block, path)
        return {"type": "tool_use", "id": b["id"], "name": name, "input": b["input"]}
    raise Bad(f"{path}.type", "enum")


def _free_text(block) -> int:
    if block["type"] == "text":
        return len(block["text"])
    if block["type"] == "thinking":
        return len(block["thinking"])
    return 0


def _check_messages(raw, registry: Registry) -> list[dict]:
    if not isinstance(raw, list):
        raise Bad("messages", "type")
    if not 1 <= len(raw) <= MAX_MESSAGES:
        raise Bad("messages", "size")
    out: list[dict] = []
    pending: dict[str, str] = {}  # 直前の assistant の tool_use の id → 名前
    total = 0
    for i, m in enumerate(raw):
        path = f"messages[{i}]"
        if not isinstance(m, dict):
            raise Bad(path, "type")
        for k in m:
            if k not in ("role", "content"):
                raise Bad(f"{path}.<unknown>", "unknown_key")
        role = Enum(("user", "assistant")).check(m.get("role"), f"{path}.role")
        if role != ("user" if i % 2 == 0 else "assistant"):
            raise Bad(f"{path}.role", "order")  # user から始まり交互
        content = m.get("content")
        if not isinstance(content, list):
            raise Bad(f"{path}.content", "type")
        if not 1 <= len(content) <= MAX_BLOCKS:
            raise Bad(f"{path}.content", "size")
        blocks = []
        if role == "user":
            seen_text = False
            for j, b in enumerate(content):
                blocks.append(_user_block(b, f"{path}.content[{j}]", pending, registry, seen_text))
                seen_text = seen_text or blocks[-1]["type"] == "text"
            if pending:
                raise Bad(f"{path}.content", "missing_tool_result")
        else:
            for j, b in enumerate(content):
                blocks.append(_assistant_block(b, f"{path}.content[{j}]", registry))
            ids = [b["id"] for b in blocks if b["type"] == "tool_use"]
            if len(set(ids)) != len(ids):
                raise Bad(f"{path}.content", "duplicate_tool_use_id")
            pending = {b["id"]: b["name"] for b in blocks if b["type"] == "tool_use"}
        total += sum(_free_text(b) for b in blocks)
        if total > MAX_FREE_TEXT_TOTAL:
            raise Bad(path, "size")
        out.append({"role": role, "content": blocks})
    if out[-1]["role"] != "user":
        raise Bad("messages", "order")  # 最後は user（AI の続きを書かせない）
    return out


def parse_request(raw: bytes, registry: Registry) -> AiRequest:
    """本文（bytes）を検査して AiRequest を返す。外れたら Bad(path, reason)"""
    body = loads(raw)
    if not isinstance(body, dict):
        raise Bad("body", "type")
    for k in body:
        if k not in ("schema_version", "kind", "context", "messages"):
            raise Bad("body.<unknown>", "unknown_key")
    for k in ("schema_version", "kind", "context", "messages"):
        if k not in body:
            raise Bad(k, "missing")
    Enum((SCHEMA_VERSION,)).check(body["schema_version"], "schema_version")
    kind = Enum(KINDS).check(body["kind"], "kind")
    context = _check_context(body["context"], registry)
    messages = _check_messages(body["messages"], registry)
    return AiRequest(kind=kind, context=context, messages=messages)


def upstream_messages(req: AiRequest) -> list[dict]:
    """送る messages: 検査済みの会話の最初の user の先頭に context の block を足したもの（新しい list / dict）"""
    ctx_block = {"type": "text", "text": f"{CONTEXT_OPEN}{canonical(req.context)}{CONTEXT_CLOSE}"}
    out = [{"role": m["role"], "content": [dict(b) for b in m["content"]]} for m in req.messages]
    out[0]["content"].insert(0, ctx_block)
    return out

"""要求の本文の許可リスト（docs/ai-advisor.md 論点 1・6、K15）と、送る本文の組み立て直し。純関数。

ブラウザから受けるのは schema_version・kind・context・messages と、kind が ask・preset のときだけ topic（model・
system・tools・max_tokens などは 400）。topic は [AI に聞く]（#136）の場所の ID か定型の質問（#140）の ID（どちらも
決まった一覧）で、ログ ai_request に出すだけ（Anthropic には送らない）。
context に自由な文字列は無い（列挙・日付・時刻の形だけ）。例外は利用者が設定に書いた自分の前提 profile.text
（#156。MAX_PROFILE_TEXT 字まで。利用者自身の文で、発言の text と同じ扱い。ログには字数だけ）。
板の行に JPX のグリーク・bid_iv / ask_iv・数量・建玉・出来高は
無い（許可リストに無いので 400）。IV は simulator の IV（%）。

送る本文は検査済みの値から作り直す: context は sort_keys の JSON（決定的）にして最初の user の先頭の text block に置き、
tool_result の JSON も同じく正規化する。同じ入力 → 同じバイト列（prompt caching の前置きと thinking の履歴を保つ）。

会話の途中で板・ポジション・シナリオが変わったら、ブラウザは最初の context を変えずに、新しい user の発言に
`{"type": "context_update", "context": {...}}` の block を 1 つ足す（#135。2 件目以降の user だけ・
tool_result の後ろ）。
中継はそれを context と同じ形で検査し、`<context_update>{決定的な JSON}</context_update>` の text block にしてその位置に
置く。前の messages は変えない（追記だけ = Opus 5.5 の preserved thinking と prompt caching の前置きを保つ。
docs/design.md 14 章）。

利用者の発言には添付（#369 = docs/adr-0010-ai-chat-attachments.md）を置ける: 画像の `image` block（Messages API と
同じ形。検査は読み取り #318 と共用の ai/images.py）とテキストのファイルの `attachment_text` block（名前・種類・
本文）。位置の規則は text と同じ（tool_result の後ろ）。1 件の発言に MAX_ATTACHMENTS まで、会話全体で画像
MAX_IMAGES 枚・テキストの添付の字数の合計 MAX_ATTACH_TEXT_TOTAL まで（自由文の合計 MAX_FREE_TEXT_TOTAL には
数えない）。送る本文では image は検査済みの値から組み立て直し、attachment_text は
`<attachment>{escape した決定的な JSON}</attachment>` の text block にする（本文に `</attachment>`・`</context>`
などを書かれても印を偽装できない）。
"""

import json
import re
from dataclasses import dataclass

from . import images
from .shape import DATE, INSTANT, MONTH, Arr, Bad, Bool, Enum, Map, Num, Obj, Str, Text, TrueOnly
from .tools import Registry

SCHEMA_VERSION = 1
# 定型の種類（diagnose = [このポジションを診断]。#135。ask = 数字・パネルの [AI に聞く]。#136。preset = 定型の質問の
# チップ。#140）
KINDS = ("chat", "diagnose", "ask", "preset")
# [AI に聞く] の場所（#136。ui/view/aiAsk.ts の AI_ASK_TOPICS と同じ並び = tests/ui/aiAsk.test.ts が突き合わせる）
ASK_TOPICS = ("tile.maxProfit", "tile.maxLoss", "tile.bep", "tile.premium", "tile.scenario", "tile.greeks",
              "tile.margin", "tile.room", "readout.date", "readout.expiry", "readout.delta", "readout.premium",
              "tail.pnl", "tail.margin", "iv.history")
# 定型の質問の ID（#140。ui/view/aiPresets.ts の AI_PRESET_IDS と同じ並び = tests/ui/aiPresets.test.ts が突き合わせる）
# shape = 形の一覧のカードの [この形で AI に相談]（#20。チップには出さない）
PRESET_TOPICS = ("crash", "rebut", "board", "hedge", "exit", "iv", "shape")
# topic を持つ kind と、その値の一覧
TOPICS = {"ask": ASK_TOPICS, "preset": PRESET_TOPICS}

MAX_PRICE = 10_000_000  # 価格・行使価格・F の上限（円。形の検査の安全弁）
MAX_EXPIRIES = 6
MAX_EXPIRIES_WITH_ROWS = 2
MAX_ROWS = 600
MAX_SMILE = 41
MAX_LEGS = 20
MAX_QTY = 100_000  # 足の枚数（画面の ui/state.ts の QTY_MAX と同じ）
MAX_MESSAGES = 60
MAX_BLOCKS = 20  # 1 件の message の block の数
MAX_USER_TEXT = 4_000  # 利用者の 1 block
MAX_ASSISTANT_TEXT = 20_000  # AI の 1 block（max_tokens 8000 の出力を受け直せる大きさ）
MAX_THINKING_TEXT = 50_000
MAX_OPAQUE = 100_000  # thinking の signature・redacted_thinking の data（Anthropic が付けた不透明な値）
MAX_FREE_TEXT_TOTAL = 100_000  # 自由文（text・thinking）の合計
MAX_TOOL_JSON = 50_000  # tool_result の JSON の字数
MAX_PROFILE_TEXT = 1_000  # 自分の前提（#156。ui/prefs.ts の AI_PROFILE_MAX と同じ）
CONTEXT_OPEN = "<context>"  # 送る本文で context を包む印（system prompt が参照する）
CONTEXT_CLOSE = "</context>"
UPDATE_OPEN = "<context_update>"  # 会話の途中の文脈の更新（#135）
UPDATE_CLOSE = "</context_update>"
# 会話の添付（#369。ui/view/aiAttach.ts の上限と同じ数 = tests/ui/aiAttach.test.ts が突き合わせる。MAX_IMAGES・
# MAX_ATTACH_TEXT_TOTAL は settings.AI_CHAT_MAX_IMAGES・AI_ATTACH_TEXT_MAX_TOTAL とも同じ = tests/test_ai_settings.py）
MAX_ATTACHMENTS = 3  # 1 件の発言の添付（image + attachment_text）
MAX_IMAGES = 5  # 会話全体の画像
MAX_ATTACH_TEXT = 20_000  # テキストの添付 1 つの字数
MAX_ATTACH_TEXT_TOTAL = 40_000  # 会話全体のテキストの添付の字数の合計
MAX_ATTACH_NAME = 120  # 添付の名前の字数
ATTACH_MEDIA_TYPES = ("text/csv", "text/tab-separated-values", "application/json", "application/xml", "text/xml",
                      "text/plain")
ATTACH_OPEN = "<attachment>"  # 送る本文でテキストの添付を包む印（system prompt が参照する）
ATTACH_CLOSE = "</attachment>"
ATTACH_TYPES = ("image", "attachment_text")
# 再読み込みで外れた添付の代わりにブラウザが置く text（ui/view/aiAttach.ts の DETACHED_TEXT と同じ文。名前は入れない）
DETACHED_TEXT = "［添付は再読み込みで外れました］"
# 名前に入れない文字: C0・DEL・C1 の制御文字とサロゲート
_NAME_BAD = re.compile("[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
# 本文に入れない文字: NUL と \t\n\r 以外の C0・DEL・C1 とサロゲート
_TEXT_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]")

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
# opened_days は #302 で足した任意のキー（前の板で建てた足だけ。建ててから今の板までの暦日）。デプロイ前に開いた画面
# （古い JS）は送らない
LEG = Obj({
    "product": Enum(("op", "fut_large", "fut_mini", "fut_micro")), "type": OPT_TYPE, "expiry": MONTH, "k": POS,
    "side": Enum(("buy", "sell")), "qty": Num(1, MAX_QTY, integer=True), "price": NONNEG,
    "opened_days": Num(0, 10_000, integer=True),
}, frozenset({"type", "k", "opened_days"}))
# held（作業中のタブが保有のときだけ true）・other_held（ほかの保有の数。1 以上のときだけ）は #302 で足した任意のキー
POSITION = Obj({"legs": Arr(LEG, MAX_LEGS), "held": TrueOnly(), "other_held": Num(1, 200, integer=True)},
               frozenset({"held", "other_held"}))
SNAPSHOT = Obj({"snapshot_at": INSTANT, "source": Enum(("bigquery", "file", "synthetic", "manual")),
                "delayed_minutes": Num(0, 60, integer=True)})
# dx_yen・skew_pt・beta・iv_mode は #135 で足した任意のキー（iv_mode が relative なら iv_shift_pt は %）
SCENARIO = Obj({"days": Num(0, 400), "iv_shift_pt": Num(-100, 100), "x_range": Arr(POS, 2, fixed=True),
                "dx_yen": Num(-MAX_PRICE, MAX_PRICE), "skew_pt": Num(-50, 50), "beta": Num(0, 10),
                "iv_mode": Enum(("absolute", "relative"))}, frozenset({"dx_yen", "skew_pt", "beta", "iv_mode"}))
CAPITAL = Obj({"capital_yen": Num(0, 1e12), "max_loss_yen": Num(0, 1e12)}, frozenset({"max_loss_yen"}))
# 利用者が設定に書いた自分の前提（#156。自由記述。空は送らない）
PROFILE = Obj({"text": Text(MAX_PROFILE_TEXT, 1)})

TOOL_USE_ID = Str(r"[A-Za-z0-9_-]{1,128}", 128)
OPAQUE = Str(r"[A-Za-z0-9+/=_.-]*", MAX_OPAQUE)
TOOL_ERROR = Obj({"error": Str(r"[a-z_]{1,40}", 40)})


def context_shape(registry: Registry) -> Obj:
    precomputed = Map({name: spec.result_shape for name, spec in registry.items()}, max(len(registry), 1))
    return Obj({
        "snapshot": SNAPSHOT,
        "expiries": Arr(EXPIRY, MAX_EXPIRIES),
        "position": POSITION,
        "scenario": SCENARIO,
        "capital": CAPITAL,
        "profile": PROFILE,
        "precomputed": precomputed,
    }, frozenset({"expiries", "position", "scenario", "capital", "profile", "precomputed"}))


@dataclass(frozen=True)
class AiRequest:
    kind: str
    context: dict
    messages: list[dict]
    # [AI に聞く] の場所・定型の ID（kind が ask / preset のときだけ。ログ用。Anthropic には送らない）
    topic: str | None = None
    # 会話の画像の枚数（予約額の見積もり用）と、添付の数・画像の生のバイト数の合計・テキストの添付の字数の合計（ログ用。
    # 名前・本文・base64 は出さない。#369）
    n_images: int = 0
    attachment_stats: tuple[int, int, int] = (0, 0, 0)

    def profile_chars(self) -> int:
        """自分の前提の字数（ログ用。本文は出さない。無ければ 0）"""
        return len(self.context.get("profile", {}).get("text", ""))

    def tool_names(self) -> list[str]:
        """会話に出たツールの名前（ログ用。重複なし・出た順）"""
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


def _check_context(raw, registry: Registry, path: str = "context") -> dict:
    ctx = context_shape(registry).check(raw, path)
    with_rows = [i for i, e in enumerate(ctx.get("expiries", [])) if "rows" in e]
    if len(with_rows) > MAX_EXPIRIES_WITH_ROWS:
        raise Bad(f"{path}.expiries[{with_rows[MAX_EXPIRIES_WITH_ROWS]}].rows", "size")
    for i, leg in enumerate(ctx.get("position", {}).get("legs", [])):
        is_op = leg["product"] == "op"
        if is_op != ("type" in leg) or is_op != ("k" in leg):
            raise Bad(f"{path}.position.legs[{i}]", "shape")
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


def _keys(block: dict, path: str, allowed: tuple[str, ...]):
    for k in block:
        if k not in allowed:
            raise Bad(f"{path}.<unknown>", "unknown_key")
    for k in allowed:
        if k not in block:
            raise Bad(f"{path}.{k}", "missing")


def _image_block(block: dict, path: str) -> tuple[dict, int]:
    """画像の block（#369）→ (組み立て直した block, 生のバイト数)"""
    _keys(block, path, ("type", "source"))
    src = block["source"]
    spath = f"{path}.source"
    if not isinstance(src, dict):
        raise Bad(spath, "type")
    _keys(src, spath, ("type", "media_type", "data"))
    Enum(("base64",)).check(src["type"], f"{spath}.type")
    info = images.check_image(src["media_type"], src["data"], spath)
    out = {"type": "image", "source": {"type": "base64", "media_type": src["media_type"], "data": src["data"]}}
    return out, info.n_bytes


def _attachment_text_block(block: dict, path: str) -> dict:
    """テキストのファイルの block（#369）"""
    _keys(block, path, ("type", "name", "media_type", "text"))
    name = Text(MAX_ATTACH_NAME, 1).check(block["name"], f"{path}.name")
    if _NAME_BAD.search(name):
        raise Bad(f"{path}.name", "chars")
    media_type = Enum(ATTACH_MEDIA_TYPES).check(block["media_type"], f"{path}.media_type")
    text = Text(MAX_ATTACH_TEXT, 1).check(block["text"], f"{path}.text")
    if _TEXT_BAD.search(text):
        raise Bad(f"{path}.text", "chars")
    return {"type": "attachment_text", "name": name, "media_type": media_type, "text": text}


def _user_block(block, path: str, pending: dict[str, str], registry: Registry, seen_text: bool):
    """利用者の block → (検査済みの block, 画像の生のバイト数（画像でなければ 0）)"""
    if not isinstance(block, dict):
        raise Bad(path, "type")
    kind = block.get("type")
    if kind == "image":
        return _image_block(block, path)
    if kind == "attachment_text":
        return _attachment_text_block(block, path), 0
    return _user_core_block(block, kind, path, pending, registry, seen_text), 0


def _user_core_block(block: dict, kind, path: str, pending: dict[str, str], registry: Registry, seen_text: bool):
    if kind == "context_update":
        for k in block:
            if k not in ("type", "context"):
                raise Bad(f"{path}.<unknown>", "unknown_key")
        if "context" not in block:
            raise Bad(f"{path}.context", "missing")
        return {"type": "context_update", "context": _check_context(block["context"], registry, f"{path}.context")}
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


def _check_messages(raw, registry: Registry) -> tuple[list[dict], int, tuple[int, int, int]]:
    if not isinstance(raw, list):
        raise Bad("messages", "type")
    if not 1 <= len(raw) <= MAX_MESSAGES:
        raise Bad("messages", "size")
    out: list[dict] = []
    pending: dict[str, str] = {}  # 直前の assistant の tool_use の id → 名前
    total = 0
    n_images = image_bytes = attach_chars = n_attach = 0
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
            here = 0  # この発言の添付の数
            for j, b in enumerate(content):
                bpath = f"{path}.content[{j}]"
                block, n_bytes = _user_block(b, bpath, pending, registry, seen_text)
                blocks.append(block)
                if block["type"] in ATTACH_TYPES:
                    here += 1
                    if here > MAX_ATTACHMENTS:
                        raise Bad(f"{path}.content", "attachments")
                    if block["type"] == "image":
                        n_images += 1
                        image_bytes += n_bytes
                        if n_images > MAX_IMAGES:
                            raise Bad(bpath, "images")
                    else:
                        attach_chars += len(block["text"])
                        if attach_chars > MAX_ATTACH_TEXT_TOTAL:
                            raise Bad(f"{bpath}.text", "total")
                if blocks[-1]["type"] == "context_update" and (i == 0 or any(
                        x["type"] == "context_update" for x in blocks[:-1])):
                    # 最初の発言は context で送る。1 件の発言に 1 つまで
                    raise Bad(f"{path}.content[{j}]", "order")
                seen_text = seen_text or blocks[-1]["type"] != "tool_result"
            if pending:
                raise Bad(f"{path}.content", "missing_tool_result")
            n_attach += here
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
    return out, n_images, (n_attach, image_bytes, attach_chars)


def parse_request(raw: bytes, registry: Registry) -> AiRequest:
    """本文（bytes）を検査して AiRequest を返す。外れたら Bad(path, reason)"""
    body = loads(raw)
    if not isinstance(body, dict):
        raise Bad("body", "type")
    for k in body:
        if k not in ("schema_version", "kind", "context", "messages", "topic"):
            raise Bad("body.<unknown>", "unknown_key")
    for k in ("schema_version", "kind", "context", "messages"):
        if k not in body:
            raise Bad(k, "missing")
    Enum((SCHEMA_VERSION,)).check(body["schema_version"], "schema_version")
    kind = Enum(KINDS).check(body["kind"], "kind")
    # topic は ask・preset のときだけ必須、ほかの kind では付けない（#136・#140）
    topic = None
    if kind in TOPICS:
        if "topic" not in body:
            raise Bad("topic", "missing")
        topic = Enum(TOPICS[kind]).check(body["topic"], "topic")
    elif "topic" in body:
        raise Bad("topic", "unknown_key")
    context = _check_context(body["context"], registry)
    messages, n_images, stats = _check_messages(body["messages"], registry)
    return AiRequest(kind=kind, context=context, messages=messages, topic=topic, n_images=n_images,
                     attachment_stats=stats)


def escaped_json(value) -> str:
    """包みの印の中に置く JSON（canonical の `<`・`>` を \\u003c・\\u003e にした同じ値の JSON。決定的）。中の自由な
    文字列に `</context>`・`<context_update>`・`</attachment>` などの印の文字列を書かれても、印を偽装させない"""
    return canonical(value).replace("<", "\\u003c").replace(">", "\\u003e")


def context_json(ctx: dict) -> str:
    """包みの印の中に置く context の JSON（escaped_json）。自分の前提（#156。自由な文字列）の印を偽装させない。
    ほかの値は `<`・`>` を含まない（列挙・数・日付の形）ので、前提の無い context のバイト列は変わらない"""
    return escaped_json(ctx)


def attachment_text(b: dict) -> str:
    """テキストの添付の送る文（#369）: `<attachment>{"media_type","name","text" の escape した JSON}</attachment>`"""
    body = escaped_json({"media_type": b["media_type"], "name": b["name"], "text": b["text"]})
    return f"{ATTACH_OPEN}{body}{ATTACH_CLOSE}"


def _upstream_block(b: dict) -> dict:
    if b["type"] == "context_update":
        return {"type": "text", "text": f"{UPDATE_OPEN}{context_json(b['context'])}{UPDATE_CLOSE}"}
    if b["type"] == "attachment_text":
        return {"type": "text", "text": attachment_text(b)}
    if b["type"] == "image":
        src = b["source"]
        return {"type": "image", "source": {"type": "base64", "media_type": src["media_type"], "data": src["data"]}}
    return dict(b)


def upstream_messages(req: AiRequest) -> list[dict]:
    """送る messages: 検査済みの会話の最初の user の先頭に context の block を足し、context_update を text block にした
    もの（新しい list / dict）。同じ会話の前の messages は毎回同じバイト列になる（追記だけ）"""
    ctx_block = {"type": "text", "text": f"{CONTEXT_OPEN}{context_json(req.context)}{CONTEXT_CLOSE}"}
    out = [{"role": m["role"], "content": [_upstream_block(b) for b in m["content"]]} for m in req.messages]
    out[0]["content"].insert(0, ctx_block)
    return out

"""建玉の一覧の画像から保有ポジションを読み取る（POST /api/ai/read_positions。#318 =
docs/adr-0009-ai-image-read-positions.md）。純関数（要求の検査・画像の寸法・送る引数・予約額・結果の検査）。
中継の流れは relay.AiRelay.read_positions。

- 要求: {"schema_version": 1, "image": {"media_type": "image/png" | "image/jpeg", "data": <base64>}} だけ
  （知らないキーは 400）。
  画像は生のバイト数 1〜AI_IMAGE_MAX_BYTES、マジックバイトが media_type と一致、長辺 ≤ AI_IMAGE_MAX_EDGE（PNG の IHDR・
  JPEG の SOF を自前で読む。依存を足さない）。外れたら Bad(path, reason)（値は持たない = 応答・ログに反射しない）
- 送るもの: system（READ_SYSTEM）+ user [画像, 決まった文 READ_TEXT] + ツール report_positions 1 本。板・ポジション・
  自分の前提は送らない。会話の system prompt・スキル・文書は使わない（params["mode"] = "read" で送信先が絞る）
- 結果: report_positions の入力を RESULT の形で検査する。知らないキー・自由な文字列（列挙に無い文字列・日付の形でない
  文字列）・型の不正・行の上限超え → 結果全体を Bad（中継は 502 bad_result）。欄の値の範囲外（枚数 0・暦に無い日付など）
  → その欄だけ null。返す行は全欄そろえる（読めない欄は null）
"""

import base64
import binascii
import math
import re
from dataclasses import dataclass
from datetime import date

from .. import settings as st
from . import allowlist, budget
from .shape import Bad

SCHEMA_VERSION = 1
TOOL_NAME = "report_positions"
MEDIA_TYPES = ("image/png", "image/jpeg")
KINDS = ("positions", "not_positions")
PRODUCTS = ("op_large", "fut_large", "fut_mini", "fut_micro", "unknown")
ROW_KEYS = ("product", "expiry_year", "expiry_month", "type", "strike", "side", "qty", "price", "opened_on")
MAX_ROWS = allowlist.MAX_LEGS  # 20（足の上限と同じ）
MAX_QTY = allowlist.MAX_QTY
MAX_PRICE = allowlist.MAX_PRICE
YEAR_MIN, YEAR_MAX = 2000, 2100

PNG_SIG = b"\x89PNG\r\n\x1a\n"
# 寸法を持つ JPEG の SOF（C4 = DHT・C8 = JPG・CC = DAC を除く C0〜CF）
_SOF = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
# 長さを持たないマーカー（TEM・RSTn・SOI）
_NO_LENGTH = frozenset({0x01, *range(0xD0, 0xD9)})
_B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# base64 の字数の上限（生のバイト数の上限から。超えたら復号しない）
_MAX_B64 = -(-st.AI_IMAGE_MAX_BYTES // 3) * 4


@dataclass(frozen=True)
class ReadRequest:
    media_type: str
    data: str  # base64（検査済み。復号すると n_bytes バイト）
    n_bytes: int
    width: int
    height: int


def _png_dims(raw: bytes) -> tuple[int, int]:
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        raise Bad("image.data", "image")
    w = int.from_bytes(raw[16:20], "big")
    h = int.from_bytes(raw[20:24], "big")
    return w, h


def _jpeg_dims(raw: bytes) -> tuple[int, int]:
    i = 2
    n = len(raw)
    while i < n:
        if raw[i] != 0xFF:
            raise Bad("image.data", "image")
        while i < n and raw[i] == 0xFF:  # 詰めの FF
            i += 1
        if i >= n:
            break
        marker = raw[i]
        i += 1
        if marker in _NO_LENGTH:
            continue
        if marker in (0xD9, 0xDA):  # EOI・SOS（寸法の前に画素が始まった）
            break
        if i + 2 > n:
            break
        length = int.from_bytes(raw[i:i + 2], "big")
        if length < 2:
            break
        if marker in _SOF:
            if i + 7 > n:
                break
            h = int.from_bytes(raw[i + 3:i + 5], "big")
            w = int.from_bytes(raw[i + 5:i + 7], "big")
            return w, h
        i += length
    raise Bad("image.data", "image")


def image_info(media_type: str, raw: bytes) -> tuple[int, int]:
    """マジックバイトが media_type と一致することを確かめて (幅, 高さ) を返す。外れたら Bad"""
    if media_type == "image/png":
        if not raw.startswith(PNG_SIG):
            raise Bad("image.data", "image")
        return _png_dims(raw)
    if not raw.startswith(b"\xff\xd8\xff"):
        raise Bad("image.data", "image")
    return _jpeg_dims(raw)


def parse_read_request(raw: bytes) -> ReadRequest:
    """本文（bytes）を検査して ReadRequest を返す。外れたら Bad(path, reason)"""
    body = allowlist.loads(raw)
    if not isinstance(body, dict):
        raise Bad("body", "type")
    for k in body:
        if k not in ("schema_version", "image"):
            raise Bad("body.<unknown>", "unknown_key")
    for k in ("schema_version", "image"):
        if k not in body:
            raise Bad(k, "missing")
    if body["schema_version"] != SCHEMA_VERSION or isinstance(body["schema_version"], bool):
        raise Bad("schema_version", "enum")
    img = body["image"]
    if not isinstance(img, dict):
        raise Bad("image", "type")
    for k in img:
        if k not in ("media_type", "data"):
            raise Bad("image.<unknown>", "unknown_key")
    for k in ("media_type", "data"):
        if k not in img:
            raise Bad(f"image.{k}", "missing")
    media_type = img["media_type"]
    if not isinstance(media_type, str) or media_type not in MEDIA_TYPES:
        raise Bad("image.media_type", "enum")
    data = img["data"]
    if not isinstance(data, str):
        raise Bad("image.data", "type")
    if len(data) > _MAX_B64:
        raise Bad("image.data", "size")
    if not data or len(data) % 4 != 0 or not _B64_RE.fullmatch(data):
        raise Bad("image.data", "base64")
    try:
        decoded = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise Bad("image.data", "base64") from None
    if not 1 <= len(decoded) <= st.AI_IMAGE_MAX_BYTES:
        raise Bad("image.data", "size")
    w, h = image_info(media_type, decoded)
    if w < 1 or h < 1:
        raise Bad("image.data", "image")
    if max(w, h) > st.AI_IMAGE_MAX_EDGE:
        raise Bad("image.data", "dimensions")
    return ReadRequest(media_type=media_type, data=data, n_bytes=len(decoded), width=w, height=h)


# ---------------------------------------------------------------- 送るもの

# 読み取りの指示（サーバーの定数。ブラウザからは受けない）。会話の SYSTEM_PROMPT・スキルとは別（#338 の会話の予約額に
# 触れない）
READ_SYSTEM = f"""あなたは証券会社の画面のスクリーンショットから、日経225 の先物・オプションの建玉（保有している玉）を\
読み取る係です。答えは必ずツール {TOOL_NAME} を 1 回だけ呼んで返します。文章では答えません。

# 読み取る画面
- 建玉の一覧（建玉照会・ポジション一覧など）。1 行 = 1 つの建玉（同じ銘柄が複数行あっても、まとめずに行のまま返す）
- 建玉の一覧でない画像（損益のグラフ・注文の画面・関係のない画像）なら kind を not_positions にし、rows を空にする

# 各欄（読めない・画面に無い欄は null。推測で埋めない）
- product: 日経225オプション（ラージ）= op_large、日経225先物（ラージ）= fut_large、日経225mini = fut_mini、\
日経225マイクロ先物 = fut_micro。それ以外（日経225ミニオプション・週次（Weekly）のオプション・個別株オプション・\
ほかの指数・CFD など）は unknown
- expiry_year・expiry_month: 限月の年（西暦 4 桁）と月（1〜12）。「26/12」「2026年12月限」は 2026 年 12 月。\
年が画面に無い（「12月限」だけ）なら expiry_year は null（年を推測しない）
- type: コール = C、プット = P（オプションだけ。先物は null）
- strike: 行使価格（円。オプションだけ。先物は null）
- side: 売建・売 = sell、買建・買 = buy
- qty: 建玉の数量（枚。残りの数量があればそれ）
- price: 建単価（建値。円）
- opened_on: 建てた日（建日・約定日。YYYY-MM-DD）。年が無ければ null

# 守ること
- 氏名・口座番号・残高・メールアドレスなど、上の欄に無いものは返さない（欄が無い）
- 数字は画面のとおり（桁区切りのカンマは除く）。計算しない
"""
READ_TEXT = f"この画像の建玉を {TOOL_NAME} で報告してください。"

_NULL_INT = {"type": ["integer", "null"]}
_NULL_NUM = {"type": ["number", "null"]}
TOOL_DEFINITION = {
    "name": TOOL_NAME,
    "description": "建玉の一覧の画像から読み取った建玉を報告する（1 回だけ呼ぶ）。読めない欄は null。",
    "input_schema": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": list(KINDS),
                     "description": "positions = 建玉の一覧、not_positions = 建玉の一覧でない画像"},
            "rows": {
                "type": "array",
                "maxItems": MAX_ROWS,
                "items": {
                    "type": "object",
                    "properties": {
                        "product": {"type": "string", "enum": list(PRODUCTS)},
                        "expiry_year": {**_NULL_INT, "description": "限月の年（西暦）。画面に無ければ null"},
                        "expiry_month": {**_NULL_INT, "description": "限月の月（1〜12）"},
                        "type": {"type": ["string", "null"], "enum": ["C", "P", None]},
                        "strike": {**_NULL_NUM, "description": "行使価格（円）。先物は null"},
                        "side": {"type": ["string", "null"], "enum": ["buy", "sell", None]},
                        "qty": {**_NULL_INT, "description": "数量（枚）"},
                        "price": {**_NULL_NUM, "description": "建単価（円）"},
                        "opened_on": {"type": ["string", "null"], "description": "建てた日 YYYY-MM-DD"},
                    },
                    "required": list(ROW_KEYS),
                    "additionalProperties": False,
                },
            },
        },
        "required": ["kind", "rows"],
        "additionalProperties": False,
    },
}
THINKING = {"type": "adaptive"}


def image_block(req: ReadRequest, data: str | None = None) -> dict:
    return {"type": "image",
            "source": {"type": "base64", "media_type": req.media_type, "data": req.data if data is None else data}}


def build_read_params(req: ReadRequest, cfg: st.AiSettings) -> dict:
    """送る引数（mode = read: 送信先は組み込みのツール・スキル・文書なし、turn 1 にする）"""
    return {
        "mode": "read",
        "model": cfg.model,
        "max_tokens": st.AI_READ_MAX_TOKENS,
        "system": READ_SYSTEM,
        "thinking": dict(THINKING),
        "output_config": {"effort": st.AI_READ_EFFORT},
        "tools": [TOOL_DEFINITION],
        "messages": [{"role": "user", "content": [image_block(req), {"type": "text", "text": READ_TEXT}]}],
    }


def read_estimate(params: dict) -> int:
    """入力トークンの見積もり（上界）: 画像の data を空にした本文のバイト数 + 余裕 + CLI の分 + 画像 1 枚の上界。
    base64 のバイト数は数えない（画像のトークンは寸法で決まり、上界は AI_IMAGE_MAX_TOKENS）"""
    # 画像の block だけ data を空にした写しを作る（base64 を複製しない）
    messages = [{**m, "content": [{**b, "source": {**b["source"], "data": ""}} if b.get("type") == "image" else b
                                  for b in m["content"]]} for m in params["messages"]]
    blank = {"system": params["system"], "tools": params["tools"], "messages": messages}
    return budget.estimate_input_tokens(allowlist.canonical(blank)) + st.AI_IMAGE_MAX_TOKENS


def read_reserve(model: str, est: int) -> int:
    """予約額（µUSD）: turn 1・スキルと文書なし（K = 0）・出力の上限 AI_READ_MAX_TOKENS"""
    return budget.reserve_micro_usd(model, est, st.AI_READ_MAX_TOKENS, 1, 0)


# ---------------------------------------------------------------- 結果の検査


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _num(v, path: str, lo: float, hi: float, integer: bool = False, lo_open: bool = False):
    """数の欄: null はそのまま、数でない → Bad（形の不正）、範囲外・整数でない → None（その欄だけ読めない）"""
    if v is None:
        return None
    if not _is_num(v) or (isinstance(v, float) and not math.isfinite(v)):
        raise Bad(path, "type")
    if integer and not float(v).is_integer():
        return None
    if v < lo or v > hi or (lo_open and v == lo):
        return None
    return int(v) if integer else v


def _enum(v, path: str, values: tuple):
    """列挙の欄: null はそのまま、列挙に無い文字列・文字列でない → Bad（自由な文字列を返さない）"""
    if v is None:
        return None
    if isinstance(v, bool) or v not in values:
        raise Bad(path, "enum")
    return v


def _date(v, path: str):
    """日付の欄: null はそのまま、YYYY-MM-DD の形でない → Bad、暦に無い・範囲外の年 → None"""
    if v is None:
        return None
    if not isinstance(v, str) or not _DATE_RE.fullmatch(v):
        raise Bad(path, "format")
    try:
        d = date.fromisoformat(v)
    except ValueError:
        return None
    return v if YEAR_MIN <= d.year <= YEAR_MAX else None


def check_row(row, path: str) -> dict:
    if not isinstance(row, dict):
        raise Bad(path, "type")
    for k in row:
        if k not in ROW_KEYS:
            raise Bad(f"{path}.<unknown>", "unknown_key")
    product = _enum(row.get("product"), f"{path}.product", PRODUCTS)
    return {
        "product": "unknown" if product is None else product,
        "expiry_year": _num(row.get("expiry_year"), f"{path}.expiry_year", YEAR_MIN, YEAR_MAX, integer=True),
        "expiry_month": _num(row.get("expiry_month"), f"{path}.expiry_month", 1, 12, integer=True),
        "type": _enum(row.get("type"), f"{path}.type", ("C", "P")),
        "strike": _num(row.get("strike"), f"{path}.strike", 0, MAX_PRICE, lo_open=True),
        "side": _enum(row.get("side"), f"{path}.side", ("buy", "sell")),
        "qty": _num(row.get("qty"), f"{path}.qty", 1, MAX_QTY, integer=True),
        "price": _num(row.get("price"), f"{path}.price", 0, MAX_PRICE),
        "opened_on": _date(row.get("opened_on"), f"{path}.opened_on"),
    }


def check_result(tool_input) -> dict:
    """report_positions の入力 → {"kind", "rows"}（検査済み・全欄そろえた行）。全体の不正は Bad"""
    path = "result"
    if not isinstance(tool_input, dict):
        raise Bad(path, "type")
    for k in tool_input:
        if k not in ("kind", "rows"):
            raise Bad(f"{path}.<unknown>", "unknown_key")
    if "kind" not in tool_input:
        raise Bad(f"{path}.kind", "missing")
    kind = _enum(tool_input["kind"], f"{path}.kind", KINDS)
    if kind is None:
        raise Bad(f"{path}.kind", "enum")
    rows = tool_input.get("rows", [])
    if not isinstance(rows, list):
        raise Bad(f"{path}.rows", "type")
    if len(rows) > MAX_ROWS:
        raise Bad(f"{path}.rows", "size")
    checked = [check_row(r, f"{path}.rows[{i}]") for i, r in enumerate(rows)]
    return {"kind": kind, "rows": checked if kind == "positions" else []}

"""画像の検査と見積もりの写し（純関数）。建玉の一覧の読み取り（#318 = docs/adr-0009-ai-image-read-positions.md）と
会話の添付（#369 = docs/adr-0010-ai-chat-attachments.md）で共用する。

- check_image(media_type, data, path): base64 の字数・字母・復号・生のバイト数 1〜AI_IMAGE_MAX_BYTES・マジックバイトが
  media_type と一致・長辺 ≤ AI_IMAGE_MAX_EDGE（PNG の IHDR・JPEG の SOF を自前で読む。依存を足さない）。外れたら
  Bad(f"{path}.data" | f"{path}.media_type", reason)（値は持たない = 応答・ログに反射しない）
- blank_images(messages): image の block の data を空にした写し（予約額の見積もり用。base64 を複製しない）
"""

import base64
import binascii
import re
from dataclasses import dataclass

from .. import settings as st
from .shape import Bad

MEDIA_TYPES = ("image/png", "image/jpeg")
PNG_SIG = b"\x89PNG\r\n\x1a\n"
# 寸法を持つ JPEG の SOF（C4 = DHT・C8 = JPG・CC = DAC を除く C0〜CF）
_SOF = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
# 長さを持たないマーカー（TEM・RSTn・SOI）
_NO_LENGTH = frozenset({0x01, *range(0xD0, 0xD9)})
_B64_RE = re.compile(r"[A-Za-z0-9+/]*={0,2}")
# base64 の字数の上限（生のバイト数の上限から。超えたら復号しない）
MAX_B64 = -(-st.AI_IMAGE_MAX_BYTES // 3) * 4


@dataclass(frozen=True)
class ImageInfo:
    n_bytes: int
    width: int
    height: int


def _png_dims(raw: bytes, path: str) -> tuple[int, int]:
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        raise Bad(path, "image")
    w = int.from_bytes(raw[16:20], "big")
    h = int.from_bytes(raw[20:24], "big")
    return w, h


def _jpeg_dims(raw: bytes, path: str) -> tuple[int, int]:
    i = 2
    n = len(raw)
    while i < n:
        if raw[i] != 0xFF:
            raise Bad(path, "image")
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
    raise Bad(path, "image")


def image_info(media_type: str, raw: bytes, path: str = "image.data") -> tuple[int, int]:
    """マジックバイトが media_type と一致することを確かめて (幅, 高さ) を返す。外れたら Bad(path, "image")"""
    if media_type == "image/png":
        if not raw.startswith(PNG_SIG):
            raise Bad(path, "image")
        return _png_dims(raw, path)
    if not raw.startswith(b"\xff\xd8\xff"):
        raise Bad(path, "image")
    return _jpeg_dims(raw, path)


def check_image(media_type, data, path: str) -> ImageInfo:
    """media_type・data（base64）を検査する。path は media_type・data の親の道筋
    （例 image・messages[0].content[1].source）"""
    if not isinstance(media_type, str) or media_type not in MEDIA_TYPES:
        raise Bad(f"{path}.media_type", "enum")
    dpath = f"{path}.data"
    if not isinstance(data, str):
        raise Bad(dpath, "type")
    if len(data) > MAX_B64:
        raise Bad(dpath, "size")
    if not data or len(data) % 4 != 0 or not _B64_RE.fullmatch(data):
        raise Bad(dpath, "base64")
    try:
        decoded = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise Bad(dpath, "base64") from None
    if not 1 <= len(decoded) <= st.AI_IMAGE_MAX_BYTES:
        raise Bad(dpath, "size")
    w, h = image_info(media_type, decoded, dpath)
    if w < 1 or h < 1:
        raise Bad(dpath, "image")
    if max(w, h) > st.AI_IMAGE_MAX_EDGE:
        raise Bad(dpath, "dimensions")
    return ImageInfo(n_bytes=len(decoded), width=w, height=h)


def blank_images(messages: list[dict]) -> list[dict]:
    """image の block だけ data を空にした messages の写し（ほかの block は同じ参照。base64 を複製しない）"""
    return [{**m, "content": [{**b, "source": {**b["source"], "data": ""}} if b.get("type") == "image" else b
                              for b in m["content"]]} for m in messages]

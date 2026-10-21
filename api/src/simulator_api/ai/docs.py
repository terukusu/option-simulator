"""AI の相談役に渡す文書（#137、docs/adr-0007-ai-docs-read-tool.md）: マニュアル（docs/user-guide.md）と設計書
（docs/design.md の 3 章・5 章）を見出しで節に分けた索引、system prompt に載せる目次、節の本文を返すツール read_doc。

- 目次（節の番号と見出しだけ）は system に常に載せ、本文は AI が read_doc で要る節だけを読む（全文を毎回送らない）
- read_doc は **中継の中で実行する** ツール（in-process の SDK MCP ツール。CLI の名前は mcp__docs__read_doc）。
  ブラウザで計算するツール（ai/tools.py。mcp__sim__*）とは別の名前・別の扱い（agent_sdk.py のフックが通す）。
  返すのは索引の節だけで、入力からパスを作らない（file は列挙、section は番号の形、part は整数）
- 節の番号: 見出しに番号（`### 5.4 …`）があればそれ、無ければ親の番号 + 兄弟の順（user-guide の `### 追証マップ`
  は `8.5`、design の `#### JPX グリークの単位` は `5.6.1`）。`## N.` の無い章（目次・付録・変更履歴）と
  コードブロックの中の `#` は節にしない。設計書は FILES の chapters の章だけ（4 章の実測・6 章のワイヤー・
  13 章の決定の経緯・14 章は渡さない）
- 大きさ: 1 回の読みは AI_DOC_READ_MAX_BYTES まで（超える節は part に分ける。全 part をつなぐと節の本文）、
  1 要求の合計は AI_DOC_REQUEST_MAX_BYTES、呼び出しは AI_DOC_MAX_READS 回まで（Reader が要求ごとに数える）。
  予約額の上界は budget.loaded_tokens
- 文書の置き場所は環境変数 AI_DOCS_DIR（イメージは /app/docs）、未設定ならリポジトリの docs/。読めなければ None
  （目次も read_doc も出さない）
"""

import os
import re
import threading
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from .. import settings as st
from ..log import log

SERVER = "docs"  # SDK MCP の server 名（ブラウザのツールの "sim" と分ける）
TOOL_NAME = "read_doc"
CLI_TOOL_NAME = f"mcp__{SERVER}__{TOOL_NAME}"
REPO_DOCS = Path(__file__).resolve().parents[4] / "docs"


@dataclass(frozen=True)
class DocFile:
    key: str  # read_doc の file
    path: str  # 置き場所の中のファイル名
    label: str  # 答えで示す名前
    chapters: tuple[str, ...] | None  # 渡す章（None は全章）


FILES = (
    DocFile("user-guide", "user-guide.md", "マニュアル", None),
    DocFile("design", "design.md", "設計書", ("3", "5")),
)
FILE_KEYS = tuple(f.key for f in FILES)
SECTION_RE = re.compile(r"^[0-9]{1,2}(?:\.[0-9]{1,2}){0,3}$")
PART_MAX = 20
_HEADING_RE = re.compile(r"^(#{2,4}) +(.+?) *#* *$")
_FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")
_NUM_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)*)\.? +(.*)$")
# 見出しの中の開発の経緯（「（#131・#150）」「（K7 → Q2 でオーナー再確認）」）は目次・節の見出しから外す
_HISTORY_RE = re.compile(r"[（(][^（）()]*(?:#[0-9]+|\b[KDQR][0-9]+\b)[^（）()]*[）)]")

TOOL_DEFINITION = {
    "name": TOOL_NAME,
    "description": (
        "マニュアル（file=\"user-guide\"）と設計書（file=\"design\"）の節の本文を読む。section は system の「目次」の"
        "番号（例 \"8.5\"・\"5.4\"）。大きい節は part（1 から）で分かれて返り、続きがあれば本文の末尾に書いてある。"
        "読む節は 1 回の応答でまとめて呼ぶ。1 回の発言で読める量・回数には上限がある"),
    "input_schema": {
        "type": "object",
        "properties": {
            "file": {"type": "string", "enum": list(FILE_KEYS)},
            "section": {"type": "string", "maxLength": 16, "description": "目次の節の番号"},
            "part": {"type": "integer", "minimum": 1, "maximum": PART_MAX},
        },
        "required": ["file", "section"],
        "additionalProperties": False,
    },
}


@dataclass(frozen=True)
class Section:
    file: str
    id: str
    level: int  # 2 = 章、3 = 節、4 = 小節
    title: str  # 番号と開発の経緯を除いた見出し
    text: str  # 見出しの行から次の同じか上の見出しの前まで（子の節を含む）

    def parts(self) -> list[str]:
        # 見出しの行と「続きは」の行（AI_DOC_FRAME_BYTES 以下）を足しても 1 回の読みの上限に収まる大きさ
        return split_parts(self.text, st.AI_DOC_READ_MAX_BYTES - st.AI_DOC_FRAME_BYTES)


@dataclass(frozen=True)
class Index:
    sections: dict[tuple[str, str], Section]  # (file, id) → 節（文書の順）

    def get(self, file: str, section: str) -> Section | None:
        return self.sections.get((file, section))


def clean_title(title: str) -> str:
    return re.sub(r" {2,}", " ", _HISTORY_RE.sub("", title)).strip()


def parse(file: DocFile, text: str) -> list[Section]:
    """markdown → 節の list（文書の順）。file.chapters があればその章だけ"""
    lines = text.splitlines(keepends=True)
    heads: list[tuple[int, int, str]] = []  # (行, level, 見出し)
    fence = False
    for i, line in enumerate(lines):
        if _FENCE_RE.match(line):
            fence = not fence
            continue
        if fence:
            continue
        m = _HEADING_RE.match(line.rstrip("\n"))
        if m:
            heads.append((i, len(m.group(1)), m.group(2)))
    out: list[Section] = []
    stack: list[tuple[int, str]] = []  # (level, id) の祖先
    count: dict[str, int] = {}  # 親の id → 子の数
    chapter_ok = False
    for j, (i, level, raw) in enumerate(heads):
        end = next((k for k, lv, _ in heads[j + 1:] if lv <= level), len(lines))
        while stack and stack[-1][0] >= level:
            stack.pop()
        m = _NUM_RE.match(raw)
        if level == 2:
            stack = []
            if not m or "." in m.group(1):
                chapter_ok = False  # 番号の無い章（目次・付録・変更履歴）は節にしない
                continue
            sid, title = m.group(1), m.group(2)
            chapter_ok = file.chapters is None or sid in file.chapters
        else:
            if not chapter_ok or not stack:
                continue
            parent = stack[-1][1]
            count[parent] = count.get(parent, 0) + 1
            if m and m.group(1).startswith(parent + "."):
                sid, title = m.group(1), m.group(2)
            else:
                sid, title = f"{parent}.{count[parent]}", raw
        if not chapter_ok:
            continue
        stack.append((level, sid))
        out.append(Section(file.key, sid, level, clean_title(title), "".join(lines[i:end]).rstrip("\n") + "\n"))
    return out


def split_parts(text: str, max_bytes: int) -> list[str]:
    """本文を max_bytes 以下の部分に分ける（行の境。空行の後を優先。1 行が長ければ文字の境）。つなぐと元の本文"""
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]
    units: list[str] = []
    for line in text.splitlines(keepends=True):
        if len(line.encode("utf-8")) <= max_bytes:
            units.append(line)
            continue
        buf = ""
        for ch in line:
            if len((buf + ch).encode("utf-8")) > max_bytes:
                units.append(buf)
                buf = ""
            buf += ch
        if buf:
            units.append(buf)
    parts: list[str] = []
    cur: list[str] = []
    size = 0
    for u in units:
        n = len(u.encode("utf-8"))
        while cur and size + n > max_bytes:
            # 後ろ半分にある空行の後で切る（段落・表を途中で割らない）。無ければここで切る
            cut = next((k for k in range(len(cur) - 1, len(cur) // 2, -1) if cur[k].strip() == ""), None)
            if cut is None:
                parts.append("".join(cur))
                cur, size = [], 0
            else:
                parts.append("".join(cur[:cut + 1]))
                cur = cur[cut + 1:]
                size = sum(len(x.encode("utf-8")) for x in cur)
        cur.append(u)
        size += n
    if cur:
        parts.append("".join(cur))
    return parts


def docs_dir() -> Path:
    return Path(os.environ.get(st.AI_DOCS_DIR_ENV) or REPO_DOCS)


@cache
def index() -> Index | None:
    """索引（起動後 1 回）。文書が読めなければ None（目次も read_doc も出さない）"""
    base = docs_dir()
    sections: dict[tuple[str, str], Section] = {}
    try:
        for f in FILES:
            for s in parse(f, (base / f.path).read_text(encoding="utf-8")):
                sections[(s.file, s.id)] = s
    except (OSError, UnicodeDecodeError) as e:
        log("WARNING", "ai_docs_unavailable", error_type=type(e).__name__)
        return None
    if not sections:
        log("WARNING", "ai_docs_unavailable", error_type="empty")
        return None
    return Index(sections)


def toc_text(idx: Index) -> str:
    """system に載せる目次（file ごとに、番号と見出しを字下げで）"""
    out = []
    for f in FILES:
        scope = "全章" if f.chapters is None else "・".join(f"{c} 章" for c in f.chapters) + "だけ"
        out.append(f'## {f.label}（file="{f.key}"。{scope}）')
        for s in idx.sections.values():
            if s.file == f.key:
                out.append(f"{'  ' * (s.level - 2)}- {s.id} {s.title}")
    return "\n".join(out) + "\n"


def label_of(file: str) -> str:
    return next(f.label for f in FILES if f.key == file)


class Reader:
    """要求ごとの read_doc（1 要求の合計の大きさ・回数を数え、読んだ節の番号を記録する）。返すのは文字列だけ"""

    def __init__(self, idx: Index):
        self._idx = idx
        self._lock = threading.Lock()
        self.used_bytes = 0
        self.calls = 0
        self.permits = 0
        self.read: list[str] = []  # 返した節（"<file>:<番号>" と part が 2 以上なら "#<part>"）

    def permit(self) -> bool:
        """フック（PreToolUse）が呼ぶ: この要求で AI_DOC_MAX_READS 回目までなら True。超えたらフックは deny +
        continue_=False で要求を終える（呼び出しの回数 = 結果の数を有限にする。予約額の上界の前提）"""
        with self._lock:
            self.permits += 1
            return self.permits <= st.AI_DOC_MAX_READS

    def __call__(self, args) -> tuple[str, bool]:
        """入力 → (返す文, エラーか)。エラーの文に本文を入れない"""
        with self._lock:
            self.calls += 1
            if self.calls > st.AI_DOC_MAX_READS:
                return "この発言で読める回数の上限に達した。読んだ節だけで答える。", True
            if not isinstance(args, dict) or set(args) - {"file", "section", "part"}:
                return "入力の形が違う（file・section・part だけ）。", True
            file, section, part = args.get("file"), args.get("section"), args.get("part", 1)
            if file not in FILE_KEYS:
                return f"file は {' / '.join(FILE_KEYS)} のどれか。", True
            if not isinstance(section, str) or not SECTION_RE.match(section):
                return "section は目次の節の番号（例 8.5）。", True
            if isinstance(part, bool) or not isinstance(part, int) or not 1 <= part <= PART_MAX:
                return f"part は 1〜{PART_MAX} の整数。", True
            sec = self._idx.get(file, section)
            if sec is None:
                return f"{label_of(file)}の目次に {section} の節は無い。目次の番号を使う。", True
            parts = sec.parts()
            if part > len(parts):
                return f"この節は part {len(parts)} まで。", True
            head = f"[{label_of(file)} {sec.id}「{sec.title}」"
            head += f" part {part}/{len(parts)}]\n" if len(parts) > 1 else "]\n"
            tail = f"\n（続きは part={part + 1}）\n" if part < len(parts) else ""
            text = head + parts[part - 1] + tail
            n = len(text.encode("utf-8"))
            if self.used_bytes + n > st.AI_DOC_REQUEST_MAX_BYTES:
                return "この発言で読める量の上限に達した。読んだ節だけで答える。", True
            self.used_bytes += n
            self.read.append(f"{file}:{section}" + (f"#{part}" if part > 1 else ""))
            return text, False

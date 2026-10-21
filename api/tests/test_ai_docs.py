"""AI に渡す文書の索引・目次・read_doc（#137 AC1・AC2。ai/docs.py）。ネットワークに出ない。"""

import random
import re

import pytest

from simulator_api import settings as st
from simulator_api.ai import docs

UG = docs.FILES[0]
DESIGN = docs.FILES[1]


@pytest.fixture
def idx():
    i = docs.index()
    assert i is not None
    return i


def ids(i, file):
    return [s.id for s in i.sections.values() if s.file == file]


# ---- AC1: 索引と目次 ----

def test_index_ids_unique_and_user_guide_all_chapters(idx):
    for f in docs.FILES:
        got = ids(idx, f.key)
        assert len(got) == len(set(got)) and all(docs.SECTION_RE.match(x) for x in got)
    chapters = [s.id for s in idx.sections.values() if s.file == "user-guide" and s.level == 2]
    assert chapters == [str(n) for n in range(1, 21)]
    assert idx.get("user-guide", "8.5").title == "追証マップ"
    assert idx.get("user-guide", "13.2.1").title == "証拠金（概算）の設定"


def test_design_only_listed_chapters(idx):
    got = ids(idx, "design")
    assert {x.split(".")[0] for x in got} == {"3", "5"}
    assert "3.1" in got and "5.4" in got and "5.6.1" in got
    toc = docs.toc_text(idx)
    for outside in ("データの実際", "画面とユースケース", "決定事項", "AI アドバイザー", "付録", "変更履歴", "目次"):
        assert outside not in toc
    # 章の本文は次の章の前で終わる（4 章の本文が 3 章に入らない）
    assert "## 4. " not in idx.get("design", "3").text and "### 3.1 " in idx.get("design", "3").text


def test_toc_titles_drop_development_history(idx):
    toc = docs.toc_text(idx)
    assert not re.search(r"#[0-9]", toc) and not re.search(r"\b[KDQ][0-9]+\b", toc)
    assert idx.get("design", "5.10").title == "証拠金の概算"
    assert idx.get("design", "5.9").title == "ATM の判定"
    assert idx.get("design", "5.6.1").title == "JPX グリークの単位"
    # 見出しの行（本文の 1 行目）は文書のまま
    assert idx.get("design", "5.10").text.startswith("### 5.10 証拠金の概算（#131・#150）\n")


SAMPLE = """# 題

## 目次

- [1. はじめ](#1)

## 1. はじめ

前置き。

```text
## 2. コードの中は見出しにしない
# これも
```

### 開き方

本文 A。

#### 細目

本文 B。

### 1.9 番号つき（#12）

本文 C。

## 2. 次の章（K7 → Q2）

本文 D。

## 付録 A. 表

本文 E。

### A.1 細目

本文 F。
"""


def test_parse_rules():
    secs = docs.parse(docs.DocFile("x", "x.md", "X", None), SAMPLE)
    assert [(s.id, s.level, s.title) for s in secs] == [
        ("1", 2, "はじめ"), ("1.1", 3, "開き方"), ("1.1.1", 4, "細目"), ("1.9", 3, "番号つき"), ("2", 2, "次の章")]
    one = secs[0].text
    assert one.startswith("## 1. はじめ\n") and "## 2. コードの中は見出しにしない" in one and "本文 C" in one
    assert "本文 D" not in one
    assert secs[1].text == "### 開き方\n\n本文 A。\n\n#### 細目\n\n本文 B。\n"
    assert "付録" not in secs[-1].text and "本文 E" not in secs[-1].text
    only2 = docs.parse(docs.DocFile("x", "x.md", "X", ("2",)), SAMPLE)
    assert [s.id for s in only2] == ["2"]


# ---- 部分に分ける ----

@pytest.mark.parametrize("seed", range(20))
def test_split_parts_roundtrip_and_size(seed):
    r = random.Random(seed)
    words = ["本文", "IV", "|表|列|", "\n", "\n\n", "証拠金の概算", "x" * 50, "長" * 900]
    text = "".join(r.choice(words) for _ in range(r.randint(1, 600)))
    size = r.choice([64, 300, 1024, 8 * 1024])
    parts = docs.split_parts(text, size)
    assert "".join(parts) == text
    assert all(0 < len(p.encode("utf-8")) <= size for p in parts)


def test_large_sections_split(idx):
    for s in idx.sections.values():
        parts = s.parts()
        assert "".join(parts) == s.text
        assert all(len(p.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES for p in parts)
    assert len(idx.get("design", "5.10").parts()) >= 2


# ---- AC2: read_doc ----

def test_read_known_section(idx):
    r = docs.Reader(idx)
    text, err = r({"file": "user-guide", "section": "8.5"})
    assert not err
    assert text == "[マニュアル 8.5「追証マップ」]\n" + idx.get("user-guide", "8.5").text
    assert r.read == ["user-guide:8.5"] and r.used_bytes == len(text.encode("utf-8"))


def test_read_parts_join_back(idx):
    sec = idx.get("design", "5.10")
    n = len(sec.parts())
    got = []
    for p in range(1, n + 1):
        r = docs.Reader(idx)  # 1 要求の上限に掛からないように part ごとに
        text, err = r({"file": "design", "section": "5.10", "part": p})
        assert not err
        head, body = text.split("\n", 1)
        assert head == f"[設計書 5.10「証拠金の概算」 part {p}/{n}]"
        tail = f"\n（続きは part={p + 1}）\n"
        if p < n:
            assert body.endswith(tail)
            body = body[:-len(tail)]
        got.append(body)
    assert "".join(got) == sec.text


@pytest.mark.parametrize(("args", "want"), [
    ({"file": "readme", "section": "1"}, "file は"),
    ({"file": "../design", "section": "1"}, "file は"),
    ({"file": "design", "section": "13"}, "無い"),
    ({"file": "design", "section": "4.1"}, "無い"),
    ({"file": "design", "section": "14"}, "無い"),
    ({"file": "user-guide", "section": "99"}, "無い"),
    ({"file": "user-guide", "section": "../x"}, "番号"),
    ({"file": "user-guide", "section": "8.5 "}, "番号"),
    ({"file": "user-guide", "section": 8.5}, "番号"),
    ({"file": "user-guide"}, "番号"),
    ({"file": "user-guide", "section": "8.5", "part": 0}, "part"),
    ({"file": "user-guide", "section": "8.5", "part": True}, "part"),
    ({"file": "user-guide", "section": "8.5", "part": "1"}, "part"),
    ({"file": "user-guide", "section": "8.5", "part": 2}, "part 1 まで"),
    ({"file": "user-guide", "section": "8.5", "path": "/etc/passwd"}, "形"),
    (None, "形"),
])
def test_read_errors_have_no_body(idx, args, want):
    r = docs.Reader(idx)
    text, err = r(args)
    assert err and want in text
    assert "\n" not in text.strip() and len(text) < 200
    assert r.read == [] and r.used_bytes == 0


def test_request_byte_cap(idx):
    r = docs.Reader(idx)
    total = 0
    for p in range(1, 4):  # 5.10 は 8 KiB 近い part が 2 つ以上 → 3 つ目までに上限
        text, err = r({"file": "design", "section": "5.10", "part": p})
        if err:
            assert "上限" in text
            break
        total += len(text.encode("utf-8"))
    else:
        pytest.fail("上限に達しない")
    assert r.used_bytes == total <= st.AI_DOC_REQUEST_MAX_BYTES
    assert r.read == ["design:5.10"] + [f"design:5.10#{p}" for p in range(2, len(r.read) + 1)]


def test_request_call_cap(idx):
    r = docs.Reader(idx)
    for _ in range(st.AI_DOC_MAX_READS):
        r({"file": "user-guide", "section": "99"})
    text, err = r({"file": "user-guide", "section": "8.5"})
    assert err and "回数の上限" in text and r.read == []


def test_tool_definition_matches_reader():
    schema = docs.TOOL_DEFINITION["input_schema"]
    assert docs.TOOL_DEFINITION["name"] == docs.TOOL_NAME == "read_doc"
    assert docs.CLI_TOOL_NAME == "mcp__docs__read_doc"
    assert schema["properties"]["file"]["enum"] == list(docs.FILE_KEYS) == ["user-guide", "design"]
    assert schema["required"] == ["file", "section"] and schema["additionalProperties"] is False
    assert schema["properties"]["part"]["maximum"] == docs.PART_MAX


# ---- 置き場所 ----

def test_docs_dir_env_and_missing(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv(st.AI_DOCS_DIR_ENV, str(tmp_path))
    docs.index.cache_clear()
    try:
        assert docs.docs_dir() == tmp_path
        assert docs.index() is None
        assert '"event": "ai_docs_unavailable"' in capsys.readouterr().out
        for f in docs.FILES:
            (tmp_path / f.path).write_text("## 1. 題\n\n本文。\n", encoding="utf-8")
        docs.index.cache_clear()
        i = docs.index()
        assert i is not None and [s.id for s in i.sections.values()] == ["1"]  # design は 3・5 章だけ = 無し
    finally:
        monkeypatch.delenv(st.AI_DOCS_DIR_ENV)
        docs.index.cache_clear()
    assert docs.docs_dir() == docs.REPO_DOCS and docs.index() is not None

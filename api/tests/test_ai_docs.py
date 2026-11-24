"""AI に渡す文書の索引・目次・read_doc（#137 AC1・AC2。ai/docs.py）。ネットワークに出ない。"""

import json
import random
import re
import unicodedata
from pathlib import Path

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
        # index() は (file, id) の辞書なので重なりを上書きで隠す → parse() の list で数える（指摘 4）
        listed = [s.id for s in docs.parse(f, (docs.docs_dir() / f.path).read_text(encoding="utf-8"))]
        assert len(listed) == len(set(listed)) and listed == ids(idx, f.key)
        assert all(docs.SECTION_RE.match(x) for x in listed)
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
    assert idx.get("design", "5.10").text.startswith(
        "### 5.10 証拠金の概算（#131・#150。今の必要証拠金は JSCC の計算 = #382）\n")


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
    # #389: 頭（最初の子の見出しの前まで。コードブロックの中の # は子にしない）と子孫の一覧（番号の深さで字下げ）
    assert secs[0].head.startswith("## 1. はじめ\n") and secs[0].head.endswith("```\n") and "開き方" not in secs[0].head
    assert secs[0].outline == "- 1.1 開き方\n  - 1.1.1 細目\n- 1.9 番号つき\n"
    assert secs[1].head == "### 開き方\n\n本文 A。\n" and secs[2].head == secs[2].text and secs[2].outline == ""
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


def direct_children(i, sec):
    return [c for c in i.sections.values()
            if c.file == sec.file and c.id.startswith(sec.id + ".") and c.id.count(".") == sec.id.count(".") + 1]


def test_large_sections_split(idx):
    """#389: part の数は 1 回で読めない節の本文（子が無い）か、子のある大きい節の頭だけで決まる。全部の節で
    頭 + 直接の子の本文 = 節の本文（読めない部分を作らない）"""
    for s in idx.sections.values():
        parts = s.parts()
        assert "".join(parts) == (s.head if s.outlined else s.text), (s.file, s.id)
        assert len(parts) <= docs.PART_MAX  # 後ろの part が読めない節を作らない（指摘 3）
        kids = direct_children(idx, s)
        assert bool(kids) == bool(s.outline) and (s.head == s.text) == (not kids)
        rest = s.text[len(s.head):] if s.text.startswith(s.head) else pytest.fail(f"頭が本文の先頭でない {s.id}")
        for c in kids:  # 子の本文が順に並び、間は空行だけ
            k = rest.index(c.text)
            assert rest[:k].strip() == "", (s.file, s.id, c.id)
            rest = rest[k + len(c.text):]
        assert rest.strip() == ""
        # 一覧は listing_max（本文の上限の 1/4）以下（子孫の数によらず。レビュー N1）
        assert len(s.listing().encode("utf-8")) <= docs.listing_max()
    assert big_leaves(idx)  # 子の無い大きい節は今どおり part
    assert idx.get("design", "5").outlined and not idx.get("design", "5.10.1").outlined


def test_chapter_5_returns_head_and_outline(idx):
    """#389 AC: 設計書の 5 章は 1 回の読み（part なし）で、頭と子孫の番号・見出しの一覧。小節の本文は入らない"""
    r = docs.Reader(idx)
    text, err = r({"file": "design", "section": "5"})
    assert not err and text.startswith("[設計書 5「価格モデル」]\n## 5. 価格モデル\n")
    assert len(idx.get("design", "5").parts()) == 1 and "part" not in text.split("\n", 1)[0]
    for line in ("- 5.1 ", "- 5.10 証拠金の概算\n", "  - 5.10.1 ", "  - 5.6.1 JPX グリークの単位\n", "- 5.15 "):
        assert line in text
    body_5101 = idx.get("design", "5.10.1").text.split("\n", 1)[1].strip()
    assert body_5101[:40] not in text and "### 5.1 " not in text
    assert "小節の番号" in text and len(text.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES
    assert r.read == ["design:5"]


SYNTH = docs.DocFile("design", "x.md", "設計書", None)  # Reader は file の列挙を見るので design の名前で合成する
GROW = """## 1. 章

章の頭の段落。

{kids}
## 2. 次

本文。
"""


@pytest.mark.parametrize("n_kids", [3, 30])
def test_outline_does_not_grow_with_children(n_kids):
    """#389 AC: 子の節を足して親が PART_MAX × 1 回の読みを超えても、親の read は 1 回のまま。子はどれも読める"""
    para = ("価格の例は架空の値。" * 40 + "\n\n") * 6  # 約 7 KB（1 回に収まる）
    kids = "".join(f"### 1.{k} 小節 {k}\n\n{para}" for k in range(1, n_kids + 1))
    secs = docs.parse(SYNTH, GROW.format(kids=kids))
    i = docs.Index({(s.file, s.id): s for s in secs})
    parent = i.get("design", "1")
    if n_kids == 30:
        assert len(parent.text.encode("utf-8")) > docs.PART_MAX * st.AI_DOC_READ_MAX_BYTES
        assert len(docs.split_parts(parent.text, docs.body_max())) > docs.PART_MAX  # 旧い返し方なら読めない part
    assert parent.outlined and len(parent.parts()) == 1
    text, err = docs.Reader(i)({"file": "design", "section": "1"})
    assert not err and "章の頭の段落" in text and f"- 1.{n_kids} 小節 {n_kids}\n" in text and "架空" not in text
    for k in range(1, n_kids + 1):
        sec = i.get("design", f"1.{k}")
        assert not sec.outlined and len(sec.parts()) == 1


def synth_index(text):
    return docs.Index({(s.file, s.id): s for s in docs.parse(SYNTH, text)})


def assert_all_reads_fit(i):
    for s in i.sections.values():
        assert len(s.listing().encode("utf-8")) <= docs.listing_max()
        for p in range(1, len(s.parts()) + 1):
            got, err = docs.Reader(i)({"file": s.file, "section": s.id, "part": p})
            assert not err and len(got.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES, (s.id, p)


def test_outline_many_descendants_lists_direct_children():
    """レビュー N1: 子孫が多く一覧が listing_max を超えるときは直接の子だけ（孫のある子は「（小節 n）」）"""
    para = "本文の段落。" * 100 + "\n\n"
    kids = "".join(f"### 1.{k} 小節 {k}\n\n{para}" + "".join(
        f"#### 1.{k}.{g} 細目 {g}\n\n{para}" for g in range(1, 16)) for k in range(1, 11))
    i = synth_index(GROW.format(kids=kids))
    parent = i.get("design", "1")
    assert len(parent.outline.encode("utf-8")) > docs.listing_max()  # 子孫の全部なら上限を超える
    text, err = docs.Reader(i)({"file": "design", "section": "1"})
    assert not err and "- 1.10 小節 10（小節 15）\n" in text and "1.1.1 " not in text and "ほか" not in text
    child, err = docs.Reader(i)({"file": "design", "section": "1.3"})
    assert not err and "  - 1.3.15 細目 15\n" not in child and "- 1.3.15 細目 15\n" in child  # 孫は子を読むと出る
    assert_all_reads_fit(i)


@pytest.mark.parametrize("n_kids", [60, 99, 400])
def test_outline_many_direct_children_truncated(n_kids):
    """レビュー N1: 直接の子だけでも収まらなければ、収まるだけ +「ほか n 節」。1 回の読みは 8 KiB を超えない"""
    kids = "".join(f"### 1.{k} とても長い見出しの小節 {k}\n\n" + "本文。" * 200 + "\n\n" for k in range(1, n_kids + 1))
    i = synth_index(GROW.format(kids=kids))
    text, err = docs.Reader(i)({"file": "design", "section": "1"})
    m = re.search(r"- ほか ([0-9]+) 節", text)
    shown = len(re.findall(r"^- 1\.[0-9]+ ", text, re.M))
    assert not err and m and shown >= 1 and shown + int(m.group(1)) == n_kids
    assert "- 1.1 とても長い見出しの小節 1\n" in text and len(text.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES
    if n_kids < 100:  # section の番号の形は 2 桁まで（1.100 以降は read_doc で引けない）
        assert_all_reads_fit(i)


def test_outline_head_split_when_head_large():
    """#389: 頭が 1 回に収まらなければ頭だけを part に分け、一覧は最後の part にだけ付く"""
    head = ("頭の段落。" * 60 + "\n\n") * 30  # 約 27 KB
    text = f"## 1. 章\n\n{head}### 1.1 小節\n\n本文。\n"
    secs = docs.parse(SYNTH, text)
    i = docs.Index({(s.file, s.id): s for s in secs})
    parent = i.get("design", "1")
    n = len(parent.parts())
    assert parent.outlined and n >= 4 and "".join(parent.parts()) == parent.head
    for p in range(1, n + 1):
        got, err = docs.Reader(i)({"file": "design", "section": "1", "part": p})
        assert not err and len(got.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES
        assert ("- 1.1 小節" in got) == (p == n) and ("続きは part=" in got) == (p < n)


def test_every_read_fits_read_max_and_two_reads_fit_request(idx):
    """指摘 2: 見出しの行・「続きは」の行を含めた 1 回の返りが AI_DOC_READ_MAX_BYTES 以下 → part を 2 つは必ず読める"""
    assert 2 * st.AI_DOC_READ_MAX_BYTES <= st.AI_DOC_REQUEST_MAX_BYTES
    for s in idx.sections.values():
        for p in range(1, len(s.parts()) + 1):
            text, err = docs.Reader(idx)({"file": s.file, "section": s.id, "part": p})
            assert not err and len(text.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES, (s.file, s.id, p)
    r = docs.Reader(idx)
    leaf = big_leaves(idx)[0]
    for p in (1, 2):
        assert not r({"file": leaf.file, "section": leaf.id, "part": p})[1]


# ---- AC2: read_doc ----

def test_read_known_section(idx):
    r = docs.Reader(idx)
    text, err = r({"file": "user-guide", "section": "8.5"})
    assert not err
    assert text == "[マニュアル 8.5「追証マップ」]\n" + idx.get("user-guide", "8.5").text
    assert r.read == ["user-guide:8.5"] and r.used_bytes == len(text.encode("utf-8"))


def test_read_parts_join_back(idx):
    sec = big_leaves(idx)[0]  # 子の無い大きい節（#389 で子のある大きい節は頭と一覧になった）
    n = len(sec.parts())
    assert n >= 2 and not sec.outline
    got = []
    for p in range(1, n + 1):
        r = docs.Reader(idx)  # 1 要求の上限に掛からないように part ごとに
        text, err = r({"file": sec.file, "section": sec.id, "part": p})
        assert not err
        head, body = text.split("\n", 1)
        assert head == f"[{docs.label_of(sec.file)} {sec.id}「{sec.title}」 part {p}/{n}]"
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
    assert "\n" not in text.strip() and len(text.encode("utf-8")) <= st.AI_DOC_ERROR_MAX_BYTES
    assert r.read == [] and r.used_bytes == 0


def big_leaves(i):
    """子が無く 2 part 以上の節（文書の順）。名指しにしない = 節を小節に分けても文書に依存しない（レビュー N4）"""
    return [s for s in i.sections.values() if not s.outline and len(s.parts()) >= 2]


def big_leaf_reads(i):
    """子の無い大きい節の (file, 節, part) を順に。合計は 1 要求の上限を超える"""
    reads = [(s.file, s.id, p) for s in big_leaves(i) for p in range(1, len(s.parts()) + 1)]
    assert len(reads) * (docs.body_max() // 2) > st.AI_DOC_REQUEST_MAX_BYTES
    return reads


def test_request_byte_cap(idx):
    r = docs.Reader(idx)
    total = 0
    # 子の無い大きい節の part を順に読む → 途中の part で上限（5 章は #389 で頭と一覧の 1 回になった）
    got = []
    for file, sec, p in big_leaf_reads(idx):
        text, err = r({"file": file, "section": sec, "part": p})
        if err:
            assert "上限" in text
            break
        total += len(text.encode("utf-8"))
        got.append(f"{file}:{sec}" + (f"#{p}" if p > 1 else ""))
    else:
        pytest.fail("上限に達しない")
    assert r.used_bytes == total <= st.AI_DOC_REQUEST_MAX_BYTES
    assert r.read == got and len(got) >= 2


def test_overhead_bounds_results(idx):
    """指摘 1: 予約額の枠 AI_DOC_OVERHEAD_TOKENS が read_doc の結果の本文以外（エラーの文・tool_result の枠）の上界。
    回数はフックが AI_DOC_MAX_READS で止める（permit）。エラーの文はどれも AI_DOC_ERROR_MAX_BYTES 以下"""
    assert st.AI_DOC_MAX_READS * (st.AI_DOC_ERROR_MAX_BYTES + st.AI_DOC_RESULT_FRAME_BYTES) <= st.AI_DOC_OVERHEAD_TOKENS
    r = docs.Reader(idx)
    assert [r.permit() for _ in range(st.AI_DOC_MAX_READS + 2)] == [True] * st.AI_DOC_MAX_READS + [False, False]
    # 上限の後のエラーの文（量・回数）も上限以下
    big = docs.Reader(idx)
    for file, sec, p in big_leaf_reads(idx):
        text, err = big({"file": file, "section": sec, "part": p})
        if err:
            break
    errs = [text]
    for _ in range(st.AI_DOC_MAX_READS):
        big({"file": "user-guide", "section": "1"})
    errs.append(big({"file": "user-guide", "section": "1"})[0])
    for e in errs:
        assert "上限" in e and len(e.encode("utf-8")) <= st.AI_DOC_ERROR_MAX_BYTES


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


# ---- #240: 評価の文書の質問（scripts/aiEvalDocs.ts）の想定の節が索引にある（節の番号が変わって黙って外れない） ----

def test_eval_doc_questions_expect_sections_exist(idx):
    src = (Path(__file__).resolve().parents[2] / "scripts" / "aiEvalDocs.ts").read_text(encoding="utf-8")
    expects = re.findall(r"'(user-guide|design):([0-9]+(?:\.[0-9]+)*)'", src)
    assert len(expects) >= 10
    missing = [f"{f}:{s}" for f, s in expects if idx.get(f, s) is None]
    assert missing == []


# ---- #308: 急落時の IV の実測（設計書 5.12）は 1 回の読みに収まる ----

def test_design_5_12_single_read(idx):
    sec = idx.get("design", "5.12")
    assert sec is not None
    assert len(sec.parts()) == 1
    assert "sticky strike" in sec.text and "二重" in sec.text


# ---- #306: シナリオの β の形（設計書 5.13）も 1 回の読みに収まる ----

def test_design_5_13_single_read(idx):
    sec = idx.get("design", "5.13")
    assert sec is not None
    assert len(sec.parts()) == 1
    assert "g(ΔX%)" in sec.text and "40pt" in sec.text and "測り直しの手順" in sec.text


# ---- #354: β の形の角の丸めと上限（設計書 5.15）も 1 回の読みに収まる ----

def test_design_5_15_single_read(idx):
    sec = idx.get("design", "5.15")
    assert sec is not None
    assert len(sec.parts()) == 1
    assert "40pt" in sec.text and "roundKnotPct" in sec.text and "−20.275%" in sec.text


# ---- #307: 過去の急落の再生（設計書 5.14）も 1 回の読みに収まる。マニュアルは 8.6（8.5 の追証マップは変えない） ----

def test_design_5_14_single_read(idx):
    sec = idx.get("design", "5.14")
    assert sec is not None
    assert len(sec.parts()) == 1
    assert "戻らなかった道筋" in sec.text and "入金して持ち続けた前提" in sec.text
    assert idx.get("user-guide", "8.5").title == "追証マップ"
    assert idx.get("user-guide", "8.6").title == "過去の急落の再生"


# ---- #322: 画面（ui/view/manual.ts）の番号の規則との突き合わせ ----

# fixtures/docs/user-guide-sections.json は npm run fixtures が画面の規則（TS）で書く（npm run fixtures:check が TS と
# 一致を確かめる）。ここで Python の parse と同じことを確かめる = TS と Python の番号・見出しの規則が揃う
SECTIONS_JSON = Path(__file__).resolve().parents[2] / "fixtures" / "docs" / "user-guide-sections.json"
_ANY_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_SLUG_KEEP = {"Pc"}


def github_slug(text: str) -> str:
    """GitHub の見出しのアンカー（画面の slug と別に書いた規則）

    小文字化 → 文字・結合文字・数字・連結符（_ など）・空白・- 以外を消す → 空白を -
    """
    s = "".join(c for c in text.strip().lower() if c in " -" or unicodedata.category(c) in _SLUG_KEEP
                or unicodedata.category(c)[0] in "LMN")
    return s.replace(" ", "-")


def heading_anchors(text: str) -> list[tuple[str, str]]:
    """コードブロックの外の見出し 1〜6 の (行, アンカー)。同じアンカーの 2 つ目以降は -1…"""
    out: list[tuple[str, str]] = []
    seen: dict[str, int] = {}
    fence = False
    for line in text.split("\n"):
        if docs._FENCE_RE.match(line):
            fence = not fence
            continue
        m = None if fence else _ANY_HEADING_RE.match(line)
        if not m:
            continue
        base = github_slug(m.group(2))
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.append((line, base if n == 0 else f"{base}-{n}"))
    return out


def test_user_guide_sections_match_ui_rules():
    text = (docs.REPO_DOCS / UG.path).read_text(encoding="utf-8")
    want = json.loads(SECTIONS_JSON.read_text(encoding="utf-8"))
    secs = docs.parse(UG, text)
    heads = heading_anchors(text)
    got = []
    at = 0
    for s in secs:
        first = s.text.split("\n", 1)[0]
        while heads[at][0] != first:
            at += 1
        got.append({"id": s.id, "level": s.level, "title": s.title, "anchor": heads[at][1]})
        at += 1
    assert got == want


@pytest.mark.parametrize(("title", "want"), [
    ("追証マップ（#131・#150）", "追証マップ"),
    ("見出し（K7 → Q2 でオーナー再確認）", "見出し"),
    ("見出し（D3）", "見出し"),
    ("見出し (R12)  の後", "見出し の後"),
    # 和文・英字・数字・_ に続く K7 は経緯の印ではない（tests/ui/manual.test.ts と同じ例）
    ("見出し（オーナーK7）", "見出し（オーナーK7）"),
    ("見出し（AK7）", "見出し（AK7）"),
    ("見出し（K7a）", "見出し（K7a）"),
    ("見出し（_K7）", "見出し（_K7）"),
])
def test_clean_title_same_as_ui(title, want):
    assert docs.clean_title(title) == want


# ---- #385: 証拠金（設計書 5.10）は小節ごとに 1 回の読みに収まり、中身を失わない ----

MARGIN_SUBSECTIONS = [f"5.10.{n}" for n in range(1, 9)]


def margin_subsections(idx):
    return [s for s in idx.sections.values() if s.file == "design" and s.id.startswith("5.10.")]


def test_design_5_10_subsections_single_read(idx):
    """AC1: 5.10 の小節はどれも part 1 つ。AC2: 5.10 の頭（最初の小節の前）は 2 KiB 以下で小節を案内する"""
    subs = margin_subsections(idx)
    assert [s.id for s in subs] == MARGIN_SUBSECTIONS
    for s in subs:
        assert s.level == 4 and len(s.parts()) == 1, s.id
        text, err = docs.Reader(idx)({"file": "design", "section": s.id})
        assert not err and len(text.encode("utf-8")) <= st.AI_DOC_READ_MAX_BYTES, s.id
    lead = idx.get("design", "5.10").text.split("\n#### ", 1)[0]
    assert len(lead.encode("utf-8")) <= 2 * 1024
    assert all(sid in lead for sid in MARGIN_SUBSECTIONS)


def test_ai_ask_margin_design_sections_fit(idx):
    """AC3: [AI に聞く] の証拠金の場所（ui/view/aiAsk.ts）が引く設計書の節はどれも part 1 つ。
    2 つ読んでも 1 要求に収まる"""
    src = (Path(__file__).resolve().parents[2] / "ui" / "view" / "aiAsk.ts").read_text(encoding="utf-8")
    secs = re.findall(r"file: 'design',\s*section: '(5\.10[0-9.]*)'", src)
    assert sorted(secs) == ["5.10.1", "5.10.2", "5.10.4"]
    for a in secs:
        for b in secs:
            if a == b:
                continue
            r = docs.Reader(idx)
            assert not r({"file": "design", "section": a})[1]
            assert not r({"file": "design", "section": b})[1]
            assert r.used_bytes <= st.AI_DOC_REQUEST_MAX_BYTES


def test_design_5_10_keeps_decisions(idx):
    """AC5: 小節に分けて縮めても、AI が答えに要る決定・未確認の点は設計書に残る（どれかの小節にある）"""
    body = "".join(s.text for s in margin_subsections(idx))
    for word in ("戻る先の順", "10 日", "5%", "誤差大", "未確認", "値洗い", "15:45", "二分法", "折れ点",
                 "| 資金（円） |", "| 掛け目 k |", "| 値動き幅 R |", "| IV の上げ u_up |", "| IV の下げ u_down |",
                 "| 買いの OP で減らさない", "margin_exclude_long_options", "0.98〜1.07", "±200 円"):
        assert word in body, word
    # 戻る先の順は 1 か所（重複させない）
    assert body.count("**戻る先の順**（") == 1
    # ADR へ移した経緯は ADR の「詳細」にある（ADR はイメージに入らない = 設計書から参照する）
    adr2 = (docs.REPO_DOCS / "adr-0002-margin-grid-approximation.md").read_text(encoding="utf-8")
    adr13 = (docs.REPO_DOCS / "adr-0013-margin-now-jscc-var.md").read_text(encoding="utf-8")
    assert "margin_iv_up_pt" in adr2.split("## 詳細", 1)[1] and "| 約 26% OTM の put |" in adr2
    assert "LRU 16 件" in adr13.split("## 詳細", 1)[1]
    assert "adr-0002" in body and "adr-0013" in body

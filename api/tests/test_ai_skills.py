"""AI のスキルのファイル（#221 AC1。ai/skills.py・ai/plugin/）。ネットワークに出ない。"""

import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from simulator_api import settings as st
from simulator_api.ai import skills

API_DIR = Path(__file__).resolve().parents[1]


def frontmatter(text: str) -> tuple[dict[str, str], str]:
    """--- で囲んだ先頭の行（key: value）と本文"""
    m = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text, re.S)
    assert m, "frontmatter が無い"
    keys = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        assert sep and k.strip() and not line.startswith((" ", "\t")), f"key: value の 1 行でない: {line!r}"
        keys[k.strip()] = v.strip()
    return keys, m.group(2)


def test_each_listed_skill_has_skill_md():
    assert skills.NAMES and len(set(skills.NAMES)) == len(skills.NAMES)
    assert skills.ENABLED == tuple(f"simulator:{n}" for n in skills.NAMES)
    for name in skills.NAMES:
        assert skills.skill_path(name).is_file()
    # 一覧に無いスキルのディレクトリを置かない（置いたら一覧に足す）
    assert sorted(p.name for p in (skills.PLUGIN_DIR / "skills").iterdir()) == sorted(skills.NAMES)


def test_plugin_manifest_name():
    manifest = json.loads((skills.PLUGIN_DIR / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["name"] == skills.PLUGIN_NAME == "simulator"
    # プラグインはスキルだけ（コマンド・エージェント・フック・MCP を持たない）
    assert sorted(p.name for p in skills.PLUGIN_DIR.iterdir()) == [".claude-plugin", "skills"]
    assert sorted(p.name for p in (skills.PLUGIN_DIR / ".claude-plugin").iterdir()) == ["plugin.json"]
    assert set(manifest) <= {"name", "version", "description"}


@pytest.mark.parametrize("name", skills.NAMES)
def test_frontmatter_only_name_and_description(name):
    keys, body = frontmatter(skills.skill_path(name).read_text(encoding="utf-8"))
    # allowed-tools・context（fork）・model・disable-model-invocation などでツールや別の文脈を与えない
    assert set(keys) == {"name", "description"}
    assert keys["name"] == name and keys["description"]
    assert body.strip()


@pytest.mark.parametrize("name", skills.NAMES)
def test_no_command_injection_or_tool_grants(name):
    text = skills.skill_path(name).read_text(encoding="utf-8")
    # `!` で始まるコマンドの埋め込み（!`cmd` と行頭の !cmd）を書かない
    assert "!`" not in text
    assert not any(line.lstrip().startswith("!") for line in text.splitlines())
    for word in ("allowed-tools", "context:", "$ARGUMENTS"):
        assert word not in text
    # 同じディレクトリに他のファイル（スクリプト・参照）を置かない（SKILL.md 1 枚で完結）
    assert [p.name for p in skills.skill_path(name).parent.iterdir()] == ["SKILL.md"]


def test_presets_has_each_preset_section():
    # 定型の質問（#140 AC4）: 画面のチップの名前（ui/view/aiPresets.ts）ごとに節がある
    from simulator_api.ai import allowlist

    text = skills.skill_path("presets").read_text(encoding="utf-8")
    names = ("崩れ方", "反論", "板の前提", "ヘッジ案", "出口", "今の IV は売り時？")
    assert len(names) == len(allowlist.PRESET_TOPICS)
    for name in names:
        assert f"\n## {name}\n" in text
    assert "simulator:proposals" in text and "simulator:volatility" in text


def test_total_size_under_limit():
    total = sum(skills.skill_path(n).stat().st_size for n in skills.NAMES)
    assert total == skills.total_bytes() <= st.AI_SKILL_MAX_BYTES


def test_is_enabled():
    assert skills.is_enabled("simulator:technicals") and skills.is_enabled("technicals")
    for bad in ("simulator:unknown", "other:technicals", "", None, 1, ["simulator:technicals"]):
        assert not skills.is_enabled(bad)


@pytest.mark.skipif(not (os.environ.get("UV") or shutil.which("uv")), reason="uv が無い")
def test_skills_in_wheel(tmp_path):
    """パッケージのビルド（wheel）にプラグインのファイル（隠しディレクトリ .claude-plugin を含む）が入る
    = イメージ（uv sync --no-editable）にも入る"""
    uv = os.environ.get("UV") or shutil.which("uv")
    subprocess.run([uv, "build", "--wheel", "--offline", "--quiet", "-o", str(tmp_path), str(API_DIR)], check=True,
                   timeout=120)
    (whl,) = tmp_path.glob("*.whl")
    names = set(zipfile.ZipFile(whl).namelist())
    want = {"simulator_api/ai/plugin/.claude-plugin/plugin.json"}
    want |= {f"simulator_api/ai/plugin/skills/{n}/SKILL.md" for n in skills.NAMES}
    assert want <= names

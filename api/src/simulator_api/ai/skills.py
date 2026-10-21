"""AI の相談役のスキル（#221、docs/adr-0006-ai-agent-sdk-only-and-skills.md）。

system prompt に常に載せなくてよい手順（テクニカルの読み方・ポジションの提案・IV の統計の読み方）を Agent Skills の
SKILL.md に切り出し、モデルが要るときだけ CLI の Skill ツールで読む。置き場所はパッケージの中のプラグイン `plugin/`
（`.claude-plugin/plugin.json` の name = PLUGIN_NAME、`skills/<名前>/SKILL.md`）。wheel に入るので、イメージの入力
（Dockerfile・.dockerignore・image.sh）は変えない。イメージの中では読むだけ。

SKILL.md の約束（tests/test_ai_skills.py で固定）: frontmatter は name・description だけ（allowed-tools・context・model
などでツールや別の文脈を与えない）、本文に `!` のコマンドの埋め込みを書かない、合計の大きさは
settings.AI_SKILL_MAX_BYTES 以下、秘密を置かない（スキルは文脈の絞り込みでサンドボックスではない）。
スキルはサーバーの定数で、ブラウザからは受けない。
"""

from functools import cache
from pathlib import Path

PLUGIN_NAME = "simulator"
PLUGIN_DIR = Path(__file__).resolve().parent / "plugin"
# 使うスキル（ディレクトリの名前）。足すときは plugin/skills/<名前>/SKILL.md と一緒にここへ
NAMES = ("technicals", "proposals", "volatility")


def qualified(name: str) -> str:
    """CLI に見せる名前（<プラグイン>:<スキル>）"""
    return f"{PLUGIN_NAME}:{name}"


ENABLED = tuple(qualified(n) for n in NAMES)


def skill_path(name: str) -> Path:
    return PLUGIN_DIR / "skills" / name / "SKILL.md"


def is_enabled(name) -> bool:
    """Skill の入力のスキル名が一覧にあるか（CLI は <プラグイン>:<スキル> の形で渡す。素の名前も一覧の名前なら通す）"""
    if not isinstance(name, str):
        return False
    return name in ENABLED or qualified(name) in ENABLED


@cache
def total_bytes() -> int:
    """SKILL.md の合計の大きさ（予約額の上界に入れる。budget.reserve_micro_usd）"""
    return sum(skill_path(n).stat().st_size for n in NAMES)

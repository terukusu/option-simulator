"""AI の相談役のスキル（#221、docs/adr-0006-ai-agent-sdk-only-and-skills.md）。

system prompt に常に載せなくてよい手順（テクニカルの読み方・ポジションの提案・IV の統計の読み方）を Agent Skills の
SKILL.md に切り出し、モデルが要るときだけ CLI の Skill ツールで読む。置き場所はパッケージの中のプラグイン `plugin/`
（`.claude-plugin/plugin.json` の name = PLUGIN_NAME、`skills/<名前>/SKILL.md`）。wheel に入るので、イメージの入力
（Dockerfile・.dockerignore・image.sh）は変えない。イメージの中では読むだけ。

SKILL.md の約束（tests/test_ai_skills.py で固定）: frontmatter は name・description だけ（allowed-tools・context・model
などでツールや別の文脈を与えない）、本文に `!` のコマンドの埋め込みを書かない、合計の大きさは
settings.AI_SKILL_MAX_BYTES 以下、秘密を置かない（スキルは文脈の絞り込みでサンドボックスではない）。
スキルはサーバーの定数で、ブラウザからは受けない。

守り（#338、SkillGuard。agent_sdk のフックが要求ごとに 1 つ作る）: 1 要求の中で各スキルは 1 回だけ読ませ、args を
付けた呼び出しは通さず、呼び出し（許可・deny の合計）が settings.AI_SKILL_MAX_CALLS を超えたら要求を終える。
予約額の上界 S（budget.skill_tokens = 合計 + 枠の余裕）の前提（docs/adr-0007-ai-docs-read-tool.md の追補）。
"""

import threading
from functools import cache
from pathlib import Path
from typing import Literal

from .. import settings as st

PLUGIN_NAME = "simulator"
PLUGIN_DIR = Path(__file__).resolve().parent / "plugin"
# 使うスキル（ディレクトリの名前）。足すときは plugin/skills/<名前>/SKILL.md と一緒にここへ（presets: 定型。#140）
NAMES = ("technicals", "proposals", "volatility", "presets")


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


def canonical(name: str) -> str:
    """一覧の名前を <プラグイン>:<スキル> の形に（素の名前と修飾名を同じスキルとして数える）。is_enabled の名前だけ"""
    return name if name in ENABLED else qualified(name)


Decision = Literal["allow", "deny", "stop"]
# deny・stop の理由の種類（フックが固定の英文にする。入力は含めない）
UNKNOWN, ARGS, DUP, LIMIT = "unknown", "args", "dup", "limit"


class SkillGuard:
    """要求ごとの Skill の守り（SDK に依存しない。docs.Reader と同じく要求ごとに 1 つ）。順に判定する:
    1. 呼び出し（フックまで届いたもの。CLI がフックより前にエラーで返すものは数えられない = ADR-0007 の追補の
       「残る例外」）を数え、AI_SKILL_MAX_CALLS を超えたら stop（フックは deny + continue_=False = 要求を終える）
    2. 入力が dict でない・一覧に無い名前は deny（turn は続く。回数には数え済み）
    3. キーが skill・args の外にある、または args が空でない（None・"" 以外）は deny（CLI は args を SKILL.md の
       後ろに足す = モデルの出力が次の turn の入力に増える。このスキルは引数を使わない）
    4. 同じスキル（正規化した名前）の 2 回目は deny（CLI は同じスキルを重複を除かずに何度でも入れる）
    5. それ以外は読んだものに足して allow
    loaded: 許可したスキル（正規化した名前・許可した順。ログの ai_request.skills。回数の上限で要求を打ち切ったときは
    本文が上流に届かなかったものも含む）"""

    def __init__(self):
        self._lock = threading.Lock()
        self.calls = 0
        self.loaded: list[str] = []

    def judge(self, tool_input) -> tuple[Decision, str]:
        """(判定, 理由の種類。allow は "")"""
        with self._lock:
            self.calls += 1
            if self.calls > st.AI_SKILL_MAX_CALLS:
                return "stop", LIMIT
            name = tool_input.get("skill") if isinstance(tool_input, dict) else None
            if not is_enabled(name):
                return "deny", UNKNOWN
            if set(tool_input) - {"skill", "args"} or tool_input.get("args") not in (None, ""):
                return "deny", ARGS
            name = canonical(name)
            if name in self.loaded:
                return "deny", DUP
            self.loaded.append(name)
            return "allow", ""

    def decide(self, tool_input) -> Decision:
        return self.judge(tool_input)[0]

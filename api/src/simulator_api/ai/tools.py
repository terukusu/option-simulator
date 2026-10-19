"""道具の登録（docs/ai-advisor.md 論点 5・6）。名前 → 入力の形・結果の形・説明・Anthropic に渡す input_schema。

道具はブラウザの決定論的な計算（K15）。中継は道具を実行しない。AI の tool_use の入力と、ブラウザが返す tool_result の
結果・事前計算（context.precomputed）を、ここの形で検査する。#134 は空の登録と検査の仕組みだけで、
道具の中身（定義・説明）は #135 で足す。
"""

from dataclasses import dataclass

from .shape import Obj, Spec


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_shape: Obj
    result_shape: Spec
    input_schema: dict  # Anthropic の tools[].input_schema（JSON Schema。サーバーの定数）

    def definition(self) -> dict:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


Registry = dict[str, ToolSpec]

REGISTRY: Registry = {}


def definitions(registry: Registry) -> list[dict]:
    """送る tools（名前の順。毎回同じバイト列にして prompt caching の前置きを保つ）"""
    return [registry[name].definition() for name in sorted(registry)]

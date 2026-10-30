"""小さな形の検査（jsonschema は入れない）。値を検査して、検査済みの新しい値（dict / list を作り直したもの）を返す。

外れたら Bad(path, reason)。path はキーと添字の道筋（例 context.expiries[0].rows[3].k）で、**値は持たない**。
知らないキーは名前を出さず <unknown> と書く（利用者が入れたキー名を応答・ログに反射しない）。
真偽値は数として受けない。NaN・無限大は JSON の読み込みで拒否する（allowlist.loads）。
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


class Bad(Exception):
    def __init__(self, path: str, reason: str):
        super().__init__(path, reason)
        self.path = path
        self.reason = reason


class Spec:
    def check(self, value: Any, path: str) -> Any:  # pragma: no cover - 抽象
        raise NotImplementedError

    def keys(self) -> set[str]:
        """この形の中に現れうるキー名（送る本文の検査用）"""
        return set()


@dataclass(frozen=True)
class Num(Spec):
    lo: float
    hi: float
    integer: bool = False
    lo_open: bool = False  # lo を含まない（正の数）
    nullable: bool = False

    def check(self, value, path):
        if value is None and self.nullable:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise Bad(path, "type")
        if isinstance(value, float) and not math.isfinite(value):
            raise Bad(path, "type")
        if self.integer and not (isinstance(value, int) or float(value).is_integer()):
            raise Bad(path, "type")
        if value < self.lo or value > self.hi or (self.lo_open and value == self.lo):
            raise Bad(path, "range")
        return int(value) if self.integer else value


@dataclass(frozen=True)
class Bool(Spec):
    def check(self, value, path):
        if not isinstance(value, bool):
            raise Bad(path, "type")
        return value


@dataclass(frozen=True)
class TrueOnly(Spec):
    """true だけ（#302 の印 position.held。無いことが false なので false は送らせない）"""

    def check(self, value, path):
        if value is not True:
            raise Bad(path, "type")
        return True


@dataclass(frozen=True)
class Nullable(Spec):
    """null か inner（#200。真偽値・文字列の null）"""

    inner: Spec

    def check(self, value, path):
        return None if value is None else self.inner.check(value, path)

    def keys(self):
        return self.inner.keys()


@dataclass(frozen=True)
class Enum(Spec):
    values: tuple

    def check(self, value, path):
        if isinstance(value, bool) or value not in self.values:
            raise Bad(path, "enum")
        return value


@dataclass(frozen=True)
class Str(Spec):
    """正規表現に全体が一致する文字列。valid は追加の検査（日付として読めるか等）"""

    pattern: str
    max_len: int = 64
    valid: Callable[[str], bool] | None = None

    def check(self, value, path):
        if not isinstance(value, str):
            raise Bad(path, "type")
        if len(value) > self.max_len or not re.fullmatch(self.pattern, value):
            raise Bad(path, "format")
        if self.valid is not None and not self.valid(value):
            raise Bad(path, "format")
        return value


@dataclass(frozen=True)
class Text(Spec):
    """自由文（会話の本文だけ）。長さだけ見る"""

    max_len: int
    min_len: int = 0

    def check(self, value, path):
        if not isinstance(value, str):
            raise Bad(path, "type")
        if not self.min_len <= len(value) <= self.max_len:
            raise Bad(path, "size")
        return value


@dataclass(frozen=True)
class Arr(Spec):
    item: Spec
    max_len: int
    min_len: int = 0
    fixed: bool = False  # 長さが max_len ちょうど

    def check(self, value, path):
        if not isinstance(value, list):
            raise Bad(path, "type")
        if len(value) > self.max_len or len(value) < (self.max_len if self.fixed else self.min_len):
            raise Bad(path, "size")
        return [self.item.check(v, f"{path}[{i}]") for i, v in enumerate(value)]

    def keys(self):
        return self.item.keys()


@dataclass(frozen=True)
class Obj(Spec):
    fields: dict[str, Spec]
    optional: frozenset[str] = field(default_factory=frozenset)

    def check(self, value, path):
        if not isinstance(value, dict):
            raise Bad(path, "type")
        for k in value:
            if k not in self.fields:
                raise Bad(f"{path}.<unknown>", "unknown_key")
        out = {}
        for k, spec in self.fields.items():
            if k not in value:
                if k in self.optional:
                    continue
                raise Bad(f"{path}.{k}", "missing")
            out[k] = spec.check(value[k], f"{path}.{k}")
        return out

    def keys(self):
        out = set(self.fields)
        for spec in self.fields.values():
            out |= spec.keys()
        return out


@dataclass(frozen=True)
class Map(Spec):
    """キーが決まった集合の中にある dict（値の形はキーごと）。知らないキーは拒否"""

    values: dict[str, Spec]
    max_len: int

    def check(self, value, path):
        if not isinstance(value, dict):
            raise Bad(path, "type")
        if len(value) > self.max_len:
            raise Bad(path, "size")
        out = {}
        for k, v in value.items():
            if k not in self.values:
                raise Bad(f"{path}.<unknown>", "unknown_key")
            out[k] = self.values[k].check(v, f"{path}.{k}")
        return out

    def keys(self):
        out = set(self.values)
        for spec in self.values.values():
            out |= spec.keys()
        return out


def _is_date(s: str) -> bool:
    try:
        date.fromisoformat(s)
    except ValueError:
        return False
    return True


def _is_instant(s: str) -> bool:
    try:
        return datetime.fromisoformat(s).tzinfo is not None
    except ValueError:
        return False


DATE = Str(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", 10, _is_date)
MONTH = Str(r"[0-9]{4}-(?:0[1-9]|1[0-2])", 7)
INSTANT = Str(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})",
              40, _is_instant)

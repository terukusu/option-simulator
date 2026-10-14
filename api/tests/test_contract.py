"""optionchan との契約（AC-8 = 設計の AC25）。

- 静的: sql/*.sql が contract.py に宣言した列だけを宣言の順で SELECT し、宣言した Relation だけを読む
- 照合: 環境変数 OPTIONCHAN_SCHEMA_DIR（optionchan の固定コミット = api/contract/optionchan_commit.txt の
  schema/tokyo）があれば、宣言の各列が schema JSON にあり型が一致し、コードが非 NULL を前提にする列は REQUIRED。
  変数が無ければ skip（CI はリポジトリ変数 OPTIONCHAN_REPO があるときだけ渡す）。変数があるのに読めなければ fail
"""

import json
import os
import re
from pathlib import Path

import pytest
from conftest import API_ROOT, PKG_DIR

from simulator_api import contract

SCHEMA_DIR = os.environ.get("OPTIONCHAN_SCHEMA_DIR", "")
_SELECT = re.compile(r"^\s*SELECT\s+(.*?)\s+FROM\s+`\$\{project\}\.\$\{dataset\}\.(\w+)`", re.S | re.M)


def sql_text(name):
    text = (PKG_DIR / "sql" / f"{name}.sql").read_text(encoding="utf-8")
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


@pytest.mark.parametrize("name", contract.QUERY_NAMES)
def test_sql_selects_declared_columns(name):
    text = sql_text(name)
    m = _SELECT.search(text)
    assert m, name
    cols = tuple(c.strip() for c in m.group(1).split(","))
    assert cols == contract.column_names(name)
    assert m.group(2) == contract.RELATIONS[name].name
    assert "*" not in text
    # 読むのは宣言した 1 つだけ
    assert re.findall(r"`\$\{project\}\.\$\{dataset\}\.(\w+)`", text) == [contract.RELATIONS[name].name]


def test_sql_files_match_queries():
    assert sorted(p.stem for p in (PKG_DIR / "sql").glob("*.sql")) == sorted(contract.QUERY_NAMES)


def test_required_columns_are_declared():
    for rel in contract.RELATIONS.values():
        assert rel.required <= {c for c, _ in rel.columns}, rel.name


def test_pinned_commit_format():
    text = (API_ROOT / "contract" / "optionchan_commit.txt").read_text(encoding="ascii")
    assert re.fullmatch(r"[0-9a-f]{40}\n", text)


@pytest.mark.skipif(not SCHEMA_DIR, reason="OPTIONCHAN_SCHEMA_DIR（固定コミットの schema/tokyo）のときだけ")
@pytest.mark.parametrize("name", contract.QUERY_NAMES)
def test_contract_matches_optionchan_schema(name):
    rel = contract.RELATIONS[name]
    path = Path(SCHEMA_DIR) / rel.schema_file
    assert path.is_file(), f"{rel.schema_file} が無い（OPTIONCHAN_SCHEMA_DIR を確認）"
    fields = {f["name"]: f for f in json.loads(path.read_text(encoding="utf-8"))}
    for col, typ in rel.columns:
        assert col in fields, f"{rel.name}.{col} が optionchan の schema に無い"
        assert fields[col]["type"] == typ, f"{rel.name}.{col}: {fields[col]['type']} != {typ}"
        if col in rel.required:
            assert fields[col].get("mode") == "REQUIRED", f"{rel.name}.{col} が REQUIRED でない"

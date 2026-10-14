"""optionchan の BigQuery との契約（AC25）: API が読むテーブル関数・ビューと、使う列・型をここ 1 か所に宣言する。

- 照合は tests/test_contract.py（optionchan の固定コミット = api/contract/optionchan_commit.txt の
  schema/tokyo/*.json と。CI はリポジトリ変数 OPTIONCHAN_REPO があるときだけ）と
  tests/test_sql_bq.py（OPTIONCHAN_BQ_TEST=1 のときの dry run の結果の列）
- sql/<query>.sql はここに宣言した列だけを、この順で SELECT する（SELECT * を使わない。test_contract が検査）
- 型の名前は BigQuery の schema JSON の表記（INTEGER / FLOAT / BOOLEAN / ...）
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Relation:
    """optionchan の 1 つのテーブル関数 / ビュー"""

    name: str  # optionchan_tokyo の中の名前
    schema_file: str  # optionchan の schema/tokyo/ のファイル名（テーブル関数は元のテーブルの列をそのまま返す）
    columns: tuple[tuple[str, str], ...]  # (列, 型)。SQL の SELECT の順
    required: frozenset[str]  # コードが非 NULL を前提にする列（schema で REQUIRED であること）


RELATIONS = {
    "latest_runs": Relation(
        name="latest_runs",
        schema_file="ingest_runs.json",
        columns=(("snapshot_at", "TIMESTAMP"), ("rows_option", "INTEGER"), ("finished_at", "TIMESTAMP")),
        required=frozenset({"snapshot_at", "rows_option", "finished_at"}),
    ),
    "option_price": Relation(
        name="option_price_latest",
        schema_file="option_price.json",
        columns=(
            ("type", "INTEGER"),
            ("target_price", "INTEGER"),
            ("last_trading_day", "DATE"),
            ("bid", "INTEGER"),
            ("ask", "INTEGER"),
            ("bid_iv", "FLOAT"),
            ("ask_iv", "FLOAT"),
            ("price", "INTEGER"),
            ("price_time", "DATETIME"),
            ("iv", "FLOAT"),
            ("delta", "FLOAT"),
            ("gamma", "FLOAT"),
            ("theta", "FLOAT"),
            ("vega", "FLOAT"),
            ("quotation", "INTEGER"),
            ("quotation_date", "DATE"),
            ("volume", "INTEGER"),
            ("positions", "INTEGER"),
            ("is_atm", "BOOLEAN"),
            ("created_at", "TIMESTAMP"),
        ),
        required=frozenset({"target_price", "last_trading_day", "created_at"}),
    ),
    "future_price": Relation(
        name="future_price_latest",
        schema_file="future_price.json",
        columns=(("price", "FLOAT"), ("price_time", "DATETIME"), ("contract_month", "DATE")),
        required=frozenset({"contract_month"}),
    ),
    "spot_price": Relation(
        name="spot_price_latest",
        schema_file="spot_price.json",
        columns=(("price", "FLOAT"), ("price_time", "DATETIME")),
        required=frozenset(),
    ),
    "trading_calendar": Relation(
        name="trading_calendar_latest",
        schema_file="trading_calendar.json",
        columns=(
            ("version_at", "TIMESTAMP"),
            ("calendar_date", "DATE"),
            ("is_trading_day", "BOOLEAN"),
            ("status", "STRING"),
            ("name", "STRING"),
            ("covered_until", "DATE"),
            ("listed_until", "DATE"),
        ),
        required=frozenset({"version_at", "calendar_date", "is_trading_day", "covered_until", "listed_until"}),
    ),
}

# クエリの名前（sql/<name>.sql）→ 読む Relation のキー。名前は RELATIONS と同じ
QUERY_NAMES = tuple(RELATIONS)


def column_names(query: str) -> tuple[str, ...]:
    return tuple(c for c, _ in RELATIONS[query].columns)

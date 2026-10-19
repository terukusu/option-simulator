"""optionchan の BigQuery との契約（AC25・#79 AC1）: API が読むテーブル関数・ビュー・表と、使う列・型をここ 1 か所に
宣言する。

- 照合は tests/test_contract.py（optionchan の固定コミット = api/contract/optionchan_commit.txt の
  schema/tokyo/*.json・schema/cm/atm_cm_iv.json と。CI はリポジトリ変数 OPTIONCHAN_REPO があるときだけ）と
  tests/test_sql_bq.py（OPTIONCHAN_BQ_TEST=1 のときの dry run の結果の列）
- sql/<query>.sql はここに宣言した列だけを、この順で SELECT する（SELECT * を使わない。test_contract が検査）。
  集計して返すクエリ（atm_cm_iv・atm_cm_daily）は、結果の列を OUTPUTS に別に宣言する（dry run の列の比較に使う）
- 型の名前は BigQuery の schema JSON の表記（INTEGER / FLOAT / BOOLEAN / ...）
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Relation:
    """optionchan の 1 つのテーブル関数 / ビュー"""

    name: str  # optionchan_tokyo の中の名前
    # optionchan の schema/ からの相対パス（テーブル関数は元のテーブルの列をそのまま返すので、元のテーブルの JSON）
    schema_file: str
    columns: tuple[tuple[str, str], ...]  # (列, 型)。SQL の SELECT の順
    required: frozenset[str]  # コードが非 NULL を前提にする列（schema で REQUIRED であること）


RELATIONS = {
    "latest_runs": Relation(
        name="latest_runs",
        schema_file="tokyo/ingest_runs.json",
        columns=(("snapshot_at", "TIMESTAMP"), ("rows_option", "INTEGER"), ("finished_at", "TIMESTAMP")),
        required=frozenset({"snapshot_at", "rows_option", "finished_at"}),
    ),
    "option_price": Relation(
        name="option_price_latest",
        schema_file="tokyo/option_price.json",
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
        schema_file="tokyo/future_price.json",
        columns=(("price", "FLOAT"), ("price_time", "DATETIME"), ("contract_month", "DATE")),
        required=frozenset({"contract_month"}),
    ),
    "spot_price": Relation(
        name="spot_price_latest",
        schema_file="tokyo/spot_price.json",
        columns=(("price", "FLOAT"), ("price_time", "DATETIME")),
        required=frozenset(),
    ),
    "trading_calendar": Relation(
        name="trading_calendar_latest",
        schema_file="tokyo/trading_calendar.json",
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
    # 30 日固定の ATM IV（#79）。表（テーブル関数は無い）。月パーティション（created_at）で requirePartitionFilter は
    # false なので、sql/atm_cm_iv.sql の created_at の半開区間の絞りは tests/test_atm_iv.py の静的検査で守る（4.1）
    "atm_cm_iv": Relation(
        name="atm_cm_iv",
        schema_file="cm/atm_cm_iv.json",
        columns=(("created_at", "TIMESTAMP"), ("iv30", "FLOAT")),
        required=frozenset({"created_at"}),
    ),
    # 日次の値（/api/atm_daily、#152）。同じ表 atm_cm_iv から日中の終値の iv30 と 1 / 2 限月のフォワード・最終取引日を
    # 読む（method・*_days・*_iv は読まない）。created_at の半開区間の絞りは tests/test_atm_daily.py の静的検査で守る
    "atm_cm_daily": Relation(
        name="atm_cm_iv",
        schema_file="cm/atm_cm_iv.json",
        columns=(
            ("created_at", "TIMESTAMP"),
            ("iv30", "FLOAT"),
            ("m1_last_trading_day", "DATE"),
            ("m1_forward", "FLOAT"),
            ("m2_last_trading_day", "DATE"),
            ("m2_forward", "FLOAT"),
        ),
        required=frozenset({"created_at"}),
    ),
}

# 集計して返すクエリの結果の列（名前 → (列, 型)。dry run の job.schema と比べる）。無いクエリは RELATIONS の columns
OUTPUTS: dict[str, tuple[tuple[str, str], ...]] = {
    "atm_cm_iv": (
        ("started_at", "TIMESTAMP"),
        ("open", "FLOAT"),
        ("high", "FLOAT"),
        ("low", "FLOAT"),
        ("close", "FLOAT"),
        ("last_at", "TIMESTAMP"),
    ),
    "atm_cm_daily": (
        ("day", "DATE"),
        ("close_at", "TIMESTAMP"),
        ("iv30", "FLOAT"),
        ("m1_last_trading_day", "DATE"),
        ("m1_forward", "FLOAT"),
        ("m2_last_trading_day", "DATE"),
        ("m2_forward", "FLOAT"),
    ),
}

# クエリの名前（sql/<name>.sql）→ 読む Relation のキー。名前は RELATIONS と同じ
QUERY_NAMES = tuple(RELATIONS)


def column_names(query: str) -> tuple[str, ...]:
    return tuple(c for c, _ in RELATIONS[query].columns)


def output_columns(query: str) -> tuple[tuple[str, str], ...]:
    """クエリの結果の列（dry run の列の比較に使う）"""
    return OUTPUTS.get(query, RELATIONS[query].columns)

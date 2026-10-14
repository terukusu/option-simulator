"""SQL ファイルの読み込みと BigQuery の実行。

- SQL は sql/*.sql にだけ置く。ファイル中の識別子は ${project}・${dataset} だけで、起動時に設定（環境変数）から埋める
  （リクエストの値は入らない）。値はすべてクエリパラメータ（ScalarQueryParameter）で渡す
- すべてのジョブに maximum_bytes_billed・location・use_legacy_sql=False と待ち上限を付ける
- ジョブごとに課金バイト数をログに出す（bq_job）。SQL・パラメータの値・例外本文は出さない
"""

import re
import time
from datetime import date, datetime
from importlib import resources

from . import settings as st
from .contract import QUERY_NAMES
from .log import log

_PLACEHOLDER = re.compile(r"\$\{(\w+)\}")


def load_sql(name: str, cfg: st.Settings) -> str:
    text = resources.files(__package__).joinpath("sql", f"{name}.sql").read_text(encoding="utf-8")
    names = {"project": cfg.project, "dataset": cfg.dataset}

    def sub(m):
        if m.group(1) not in names:
            raise ValueError(f"{name}.sql: 未知の置換名 {m.group(1)}")
        return names[m.group(1)]

    return _PLACEHOLDER.sub(sub, text)


def param_type(value) -> str:
    # bool は int の派生なので先に弾く（使わない）
    if isinstance(value, bool):
        raise TypeError("BOOL のパラメータは使わない")
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise TypeError("TIMESTAMP のパラメータは aware な datetime にする")
        return "TIMESTAMP"
    if isinstance(value, date):
        return "DATE"
    if isinstance(value, int):
        return "INT64"
    raise TypeError(f"未対応のパラメータの型: {type(value).__name__}")


class BigQueryRunner:
    """名前（sql/<name>.sql）とパラメータの dict を受け取り、行（dict）のリストを返す。"""

    def __init__(self, cfg: st.Settings, client=None, monotonic=time.monotonic):
        self.cfg = cfg
        self.sql = {name: load_sql(name, cfg) for name in QUERY_NAMES}
        self._client = client
        self._monotonic = monotonic

    @property
    def client(self):
        if self._client is None:
            from google.cloud import bigquery

            self._client = bigquery.Client(project=self.cfg.project, location=self.cfg.location)
        return self._client

    def job_config(self, params: dict):
        from google.cloud import bigquery

        return bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter(k, param_type(v), v) for k, v in params.items()],
            maximum_bytes_billed=self.cfg.maximum_bytes_billed,
            use_legacy_sql=False,
            job_timeout_ms=st.JOB_TIMEOUT_SECONDS * 1000,
        )

    def __call__(self, name: str, params: dict) -> list[dict]:
        started = self._monotonic()
        job = self.client.query(self.sql[name], job_config=self.job_config(params), location=self.cfg.location)
        rows = [dict(row.items()) for row in job.result(timeout=st.JOB_TIMEOUT_SECONDS)]
        log("INFO", "bq_job", name=name, total_bytes_billed=job.total_bytes_billed,
            total_bytes_processed=job.total_bytes_processed, cache_hit=job.cache_hit,
            elapsed_ms=round((self._monotonic() - started) * 1000), rows=len(rows))
        return rows

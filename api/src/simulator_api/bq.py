"""SQL ファイルの読み込みと BigQuery の実行。

- SQL は sql/*.sql にだけ置く。ファイル中の識別子は ${project}・${dataset} だけで、起動時に設定（環境変数）から埋める
  （リクエストの値は入らない）。値はすべてクエリパラメータ（ScalarQueryParameter）で渡す
- すべてのジョブに maximum_bytes_billed・location・use_legacy_sql=False と待ち上限を付ける
- 実行は query_and_wait（jobs.query）。ジョブは今どおり作る（監査ログで監視できる。ジョブを作らない設定は使わない）
- ジョブごとに処理バイト数をログに出す（bq_job。課金量は監査ログ）。SQL・パラメータの値・例外本文は出さない
- Client の生成（import・資格情報のトークンの取得）は 1 回だけ（ロック）。warm でワーカーの起動時にバックグラウンドで
  済ませる（BigQuery の API は呼ばない = ジョブ・課金なし）。失敗したら最初の要求で作り直す
"""

import re
import threading
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
        self._client_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(st.BQ_CONCURRENCY)

    def _new_client(self):
        """Client を作る（生成の 1 か所）。資格情報（ADC）のトークンはここで取る（Cloud Run ではメタデータサーバー）"""
        import google.auth
        import google.auth.transport.requests
        from google.cloud import bigquery

        creds, _ = google.auth.default(scopes=bigquery.Client.SCOPE)
        creds.refresh(google.auth.transport.requests.Request())
        return bigquery.Client(project=self.cfg.project, location=self.cfg.location, credentials=creds)

    @property
    def client(self):
        if self._client is None:
            with self._client_lock:  # 並列の最初の呼び出し（と warm）で 2 つ作らない
                if self._client is None:
                    self._client = self._new_client()
        return self._client

    def warm(self) -> None:
        """Client を先に作る（クエリは出さない）。失敗は WARNING（型だけ）にして外に出さない"""
        started = self._monotonic()
        try:
            self.client  # noqa: B018
        except Exception as e:  # noqa: BLE001
            log("WARNING", "bq_warm_failed", error_type=type(e).__name__)
            return
        log("INFO", "bq_warm", elapsed_ms=round((self._monotonic() - started) * 1000))

    def start_warm(self) -> threading.Thread:
        thread = threading.Thread(target=self.warm, name="bq-warm", daemon=True)
        thread.start()
        return thread

    def job_config(self, params: dict):
        from google.cloud import bigquery

        return bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter(k, param_type(v), v) for k, v in params.items()],
            maximum_bytes_billed=self.cfg.maximum_bytes_billed,
            use_legacy_sql=False,
            job_timeout_ms=st.JOB_TIMEOUT_SECONDS * 1000,
        )

    def __call__(self, name: str, params: dict) -> list[dict]:
        with self._slots:
            started = self._monotonic()
            result = self.client.query_and_wait(self.sql[name], job_config=self.job_config(params),
                                                location=self.cfg.location, wait_timeout=st.JOB_TIMEOUT_SECONDS)
            rows = [dict(row.items()) for row in result]
            log("INFO", "bq_job", name=name, total_bytes_processed=result.total_bytes_processed,
                elapsed_ms=round((self._monotonic() - started) * 1000), rows=len(rows))
        return rows

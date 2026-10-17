"""API の設定（環境変数）と、判定・キャッシュの定数（docs/design.md 7.2・7.3・8.3・13.4）。

プロジェクト ID は必須（既定値なし。リポジトリに利用者個人の設定を入れないため）。
データセット・ロケーション・上限は汎用の既定値を持つ。
"""

import os
import re
from dataclasses import dataclass
from datetime import time
from pathlib import Path

# BigQuery のプロジェクト ID / データセット名として許す形（SQL の識別子に埋めるので厳密に検査する）
# ドメイン付きのプロジェクト ID（example.com:my-project）も受け付ける。バッククォート・空白・ドットの連続等は拒否
_PROJECT_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:)?"
                         r"[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_DATASET_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,1023}$")
_LOCATION_RE = re.compile(r"^[A-Za-z0-9-]{2,40}$")
_INT_RE = re.compile(r"^[0-9]{1,20}$")

MiB = 1024**2
# 1 ジョブのクエリ量の上限（既定かつ最大。D8 = 2026-10-14 のオーナー判断。板 1 回は約 152 MiB）
MAX_BYTES_BILLED_LIMIT = 512 * MiB

# ---- 使える板の判定（7.2）。#38 の実測で直すのはこの定数だけ。時刻は snapshot_at の JST ----
SEARCH_DAYS = 14  # latest_runs を探す範囲（年末年始の休場を含む。optionchan のビューアーと同じ）
DAY_SESSION = (time(8, 45), time(15, 40))  # 日中の連続売買の窓（両端含む。15:40 = 日中の板寄せ前の最後）
NIGHT_SESSION = (time(17, 0), time(5, 55))  # 夜間の連続売買の窓（翌 5:55 まで。5:55 = 夜間の板寄せ前の最後）
PRE_OPEN_WINDOWS = ((time(8, 39), time(8, 46)), (time(16, 45), time(17, 0)))  # 寄り前（両端含む）
AFTER_CLOSE_WINDOWS = ((time(15, 41), time(16, 44)), (time(5, 56), time(8, 38)))  # 引け後（両端含む）
CLOSED_AFTER_MINUTES = 45  # 最新の snapshot_at がこれより古ければ closed（土日・休業日・取り込みの停止）
MIN_ROWS = 300  # rows_option の下限（夜間序盤の 522 行を捨てない）
FILL_RATIO = (3, 4)  # 1 限月の先物 ±5% の行のうち両側気配のある割合の下限（分数 = 75%。浮動小数の境界を避ける）
BAND = 0.05  # 先物 ±5%
MAX_BOARD_READS = 3  # 1 リクエストで板（option_price_latest）を読む上限
MAX_FUTURE_READS = 10  # 1 リクエストで候補の先物を読む上限（先物 NULL が続くときの安全弁）

# ---- キャッシュ・待ち時間（13.4） ----
RUNS_TTL_SECONDS = 10  # latest_runs
CALENDAR_TTL_SECONDS = 3600  # trading_calendar_latest
BOARD_CACHE_SIZE = 16  # 板の LRU（キー = (snapshot_at, finished_at)）
REQUEST_BUDGET_SECONDS = 40  # 1 リクエストの BigQuery 待ちの合計（gunicorn の --timeout 60 より短く）
JOB_TIMEOUT_SECONDS = 20  # 1 ジョブの待ち上限
QUERY_THREADS = 4  # 候補内の並列（カレンダー・現物を別のスレッドで読む）。ChainService ごと
# 1 プロセスで同時に走る BigQuery の呼び出しの上限。requests の接続プールの既定の大きさ（DEFAULT_POOLSIZE）と同じにし、
# 要求のスレッド（gunicorn --threads 8）+ QUERY_THREADS が同時に読んでもプールを超えない（超えると urllib3 が WARNING）
BQ_CONCURRENCY = 10
DELAYED_MINUTES = 15  # JPX のページの遅れ（板の JSON の delayed_minutes）

DATA_SOURCES = ("bigquery", "file")


@dataclass(frozen=True)
class Settings:
    data_source: str = "bigquery"
    project: str = ""
    dataset: str = "optionchan_tokyo"
    location: str = "asia-northeast1"
    maximum_bytes_billed: int = MAX_BYTES_BILLED_LIMIT
    chain_file: Path | None = None
    static_dir: Path | None = None

    def __post_init__(self):
        if self.data_source not in DATA_SOURCES:
            raise ValueError("DATA_SOURCE は bigquery か file")
        if self.data_source == "bigquery" and not _PROJECT_RE.match(self.project):
            raise ValueError("GCP_PROJECT の形式が不正")
        if not _DATASET_RE.match(self.dataset):
            raise ValueError("BQ_DATASET の形式が不正")
        if not _LOCATION_RE.match(self.location):
            raise ValueError("BQ_LOCATION の形式が不正")
        if isinstance(self.maximum_bytes_billed, bool) or not isinstance(self.maximum_bytes_billed, int):
            raise ValueError("MAX_BYTES_BILLED は整数のバイト数")
        if not 0 < self.maximum_bytes_billed <= MAX_BYTES_BILLED_LIMIT:
            raise ValueError("MAX_BYTES_BILLED は 1〜536870912（512 MiB）のバイト数")
        if self.data_source == "file" and self.chain_file is None:
            raise ValueError("DATA_SOURCE=file には CHAIN_FILE が必要")


def from_env(env=None) -> Settings:
    env = os.environ if env is None else env
    source = env.get("DATA_SOURCE") or "bigquery"
    kwargs: dict = {"data_source": source}
    if source == "bigquery":
        project = env.get("GCP_PROJECT", "")
        if not project:
            raise RuntimeError("環境変数 GCP_PROJECT（BigQuery のプロジェクト ID）が必要")
        kwargs["project"] = project
    if env.get("BQ_DATASET"):
        kwargs["dataset"] = env["BQ_DATASET"]
    if env.get("BQ_LOCATION"):
        kwargs["location"] = env["BQ_LOCATION"]
    if env.get("MAX_BYTES_BILLED"):
        raw = env["MAX_BYTES_BILLED"].strip()
        if not _INT_RE.match(raw):
            raise ValueError("MAX_BYTES_BILLED は整数のバイト数")
        kwargs["maximum_bytes_billed"] = int(raw)
    if env.get("CHAIN_FILE"):
        kwargs["chain_file"] = Path(env["CHAIN_FILE"])
    if env.get("STATIC_DIR"):
        kwargs["static_dir"] = Path(env["STATIC_DIR"])
    return Settings(**kwargs)

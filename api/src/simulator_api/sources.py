"""供給元のアダプタ（docs/data-sources.md「API の供給元のアダプタ」・docs/adr-0003-data-source-abstraction.md。#154）。

画面が読む /api/chain・/api/calendar・/api/atm_iv・/api/atm_daily・/api/future_bars・/api/option_bars の中身を返すものを
「供給元」（DataSource）とし、環境変数 DATA_SOURCE の値 → 実装の対応をこのファイルの BUILDERS 1 か所に置く。
app.py はここで作った供給元を呼ぶだけ。

- bigquery: optionchan の BigQuery（service.ChainService。読み方・キャッシュ・single-flight・MAX_BYTES_BILLED は
  そのまま）
- file: 板の JSON 版 1 をそのまま返す（service.FileChainService。GCP なしで動かす）
- quotes: 中立の気配の一覧 + 取引カレンダーのファイルから板を組み立てる（service.QuotesFileService・quotes.py）

新しい供給元を足すとき: 下の DataSource を満たすクラスを書き（板は quotes.chain_from_quotes か chain.chain_json で
版 1 の形にする。無いエンドポイントは Unavailable で 503）、settings.DATA_SOURCES と BUILDERS に名前を足す。
"""

import time
from collections.abc import Callable
from typing import Protocol

from . import atm_iv, bq, option_bars
from . import settings as st
from .atm_iv import AtmIvRequest
from .service import ChainResult, ChainService, FileChainService, Payload, QuotesFileService


class DataSource(Protocol):
    """供給元。失敗は service.Unavailable（503。引数は理由の符号だけ）か任意の例外（503・ログは型だけ）"""

    def chain(self) -> ChainResult:
        """/api/chain（板の JSON 版 1。data/chainTypes.ts）"""
        ...

    def calendar(self) -> Payload:
        """/api/calendar（取引カレンダー。data/calendar.ts）"""
        ...

    def atm_iv(self, req: atm_iv.AtmIvRequest) -> Payload:
        """/api/atm_iv（IV 推移）"""
        ...

    def atm_daily(self) -> Payload:
        """/api/atm_daily（日次の値）"""
        ...

    def future_bars(self, req: AtmIvRequest) -> Payload:
        """/api/future_bars（先物推移。#190）"""
        ...

    def option_bars(self, req: option_bars.OptionBarsRequest) -> Payload:
        """/api/option_bars（銘柄の推移。#319）"""
        ...


Builder = Callable[[st.Settings, object, Callable, Callable], DataSource]


def _bigquery(cfg: st.Settings, runner, clock, monotonic) -> DataSource:
    if runner is None:
        runner = bq.BigQueryRunner(cfg)
        runner.start_warm()  # import・Client・トークンをバックグラウンドで（起動プローブ・/ を待たせない）
    return ChainService(runner, clock, monotonic)


def _file(cfg: st.Settings, runner, clock, monotonic) -> DataSource:
    return FileChainService(cfg.chain_file)


def _quotes(cfg: st.Settings, runner, clock, monotonic) -> DataSource:
    return QuotesFileService(cfg.quotes_file, cfg.calendar_file, clock)


# DATA_SOURCE の値 → 実装（キーは settings.DATA_SOURCES と同じ。tests/test_sources.py が検査）
BUILDERS: dict[str, Builder] = {"bigquery": _bigquery, "file": _file, "quotes": _quotes}


def build(cfg: st.Settings, runner=None, clock=None, monotonic=None) -> DataSource:
    """設定の供給元を作る。runner は bigquery の偽の runner（テスト用。省略時は設定の BigQuery）"""
    builder = BUILDERS.get(cfg.data_source)
    if builder is None:
        raise ValueError("未知の DATA_SOURCE")
    return builder(cfg, runner, clock, monotonic or time.monotonic)

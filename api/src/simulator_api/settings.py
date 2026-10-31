"""API の設定（環境変数）と、判定・キャッシュ・AI の中継の定数（docs/design.md 7.2・7.3・8.3・13.4）。

プロジェクト ID は必須（既定値なし。リポジトリに利用者個人の設定を入れないため）。
データセット・ロケーション・上限は汎用の既定値を持つ。
"""

import os
import re
from dataclasses import dataclass, field
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
# 気配の割合は 1 限月の先物 ±5% のうち行使価格が FILL_STRIKE_STEP の倍数の行（call・put を別に）だけで数える（#196）。
# 深夜の薄い夜は細かい刻みから気配が消える（2026-10-20 01:10: 125 円刻みだけの行 0/52・250 円刻み（500 でない）13/26・
# 500 円刻み 25/26）。2026-10-13〜10-20 の候補 5,934 本で、500 円刻みの割合は壊れた板（日中 08:45 の板寄せ直後・
# 板の欠け）が最大 0.38、薄い夜が最小 0.73。下限 3/5 はその間（0.75 だと 10-20 未明の 19/26 が落ち、1/2 だと
# call だけ・put だけの板が通る）。旧（全行で 75%）で採用 → 新で不採用は 0 本
FILL_STRIKE_STEP = 500
FILL_RATIO = (3, 5)  # 上の行のうち両側気配のある割合の下限（分数 = 60%。浮動小数の境界を避ける）
BAND = 0.05  # 先物 ±5%
# 読む上限はキャッシュ済みの評価（不採用として覚えた板）も数える（#245。#196 の後の候補 約 3,600 本で連続した不採用は
# 最長 2 本）
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

# ---- IV 推移（/api/atm_iv。表 atm_cm_iv の iv30、#79。docs/design.md 7.1・7.3・13.4） ----
# 足 → (読む足の秒数, 1 回の最大日数, 右端の既定の日数)。最大はビューアーの BARS_RANGE と同じ。既定は画面の 1 回分と同じ
# （5m・15m は画面が 1m から束ねる）。1d は 1 時間足を読んで取引日に束ねる
ATM_IV_TIMEFRAMES: dict[str, tuple[int, int, int]] = {
    "1m": (60, 3, 3),
    "1h": (3600, 100, 60),
    "1d": (3600, 400, 365),
}
ATM_IV_EPOCH_ISO = "2010-01-01T00:00:00+00:00"  # start の下限（ビューアーの BARS_EPOCH。これより前のデータは無い）
ATM_IV_DAILY_LOOKBEHIND_DAYS = 10  # 日足: start の何日前から 1 時間足を読むか（ビューアーと同じ）
ATM_IV_SETTLED_HOURS = 48  # end がこれより古い範囲は確定（表の作り直し = 毎時 45 分の直近 2 時間・07 時台の前日分の外）
ATM_IV_TTL_SECONDS = 300  # 確定していない範囲（右端を含む）のサーバーのキャッシュ
ATM_IV_SETTLED_TTL_SECONDS = 86400  # 確定した範囲のサーバーのキャッシュ
ATM_IV_CACHE_SIZE = 64  # キャッシュの件数（キー = (tf, start, end)）
ATM_IV_MAX_AGE_SECONDS = 60  # Cache-Control（確定していない範囲）
ATM_IV_SETTLED_MAX_AGE_SECONDS = 3600  # Cache-Control（確定した範囲）

# ---- 先物推移（/api/future_bars。future_price_latest の現在値、#190。docs/design.md 7.1・7.3・13.4） ----
# 要求・最大日数・既定の範囲・キャッシュ・Cache-Control は IV 推移（ATM_IV_*）と同じ。足は price_time で切るので、
# created_at は足の上限よりこの分だけ先まで読む（UTC 0 時 = JST 9:00 の境で created_at が 1〜2 分遅れた行を落とさない）
FUTURE_BARS_READ_AFTER_MINUTES = 10

# ---- 日次の値（/api/atm_daily。表 atm_cm_iv の日中の終値の iv30・1 / 2 限月のフォワード、#152。docs/design.md 7.1・
# 7.3・13.4） ----
ATM_DAILY_CLOSE_WINDOW = (time(9, 0), time(15, 0))  # 日中の終値を取る窓（JST。両端含む。この中の最後の行）
# 範囲の終わり（その日を含まない）が JST の今日になる時刻。表は毎時 45 分に直近 2 時間、JST 7 時台に前日 07:00〜当日
# 07:00 を作り直すので、8:00 には前日の日中が確定している（8:00 前は前日を含めない）
ATM_DAILY_SETTLED_AT = time(8, 0)
ATM_DAILY_TTL_SECONDS = 86400  # サーバーのキャッシュ（中身は確定した日だけ。キー = 範囲の終わり）
ATM_DAILY_CACHE_SIZE = 2  # キャッシュの件数（範囲の終わりが変わる境で新旧 2 件）
ATM_DAILY_MAX_AGE_SECONDS = 3600  # Cache-Control

# クエリごとの maximum_bytes_billed の上限（設定の MAX_BYTES_BILLED との小さい方。#79 の判断 6: 予期しない全期間・全列の
# 読み込みの保険。atm_cm_iv は 2 列で全期間 ≈ 20 MiB、全列 ≈ 112 MiB。atm_cm_daily は 8 列（m1_iv・m2_iv は #307）
# で全期間 ≈ 94 MiB（2026-10-31）、1 年で約 11 MiB 増える = 上限 128 MiB まで約 3 年。越えそうなら範囲を絞るか
# 上限を見直す）
# future_bars（#190）は future_price_latest の 4 列で全期間 ≈ 155 MiB、1d 400 日 + 読み足し ≈ 21 MiB（2026-10-19）
QUERY_MAX_BYTES_BILLED: dict[str, int] = {"atm_cm_iv": 64 * MiB, "atm_cm_daily": 128 * MiB, "future_bars": 64 * MiB}

# ---- 中立の気配の一覧（DATA_SOURCE=quotes。quotes.py・service.QuotesFileService。#154） ----
QUOTES_MAX_FILE_BYTES = 16 * MiB  # QUOTES_FILE・CALENDAR_FILE の大きさの上限（超えたら読まずに 503）
QUOTES_MAX_FUTURE_SECONDS = 300  # snapshot_at が今からこれより先（未来）なら不正（時計・タイムゾーンの誤り）

# ---- AI の中継（/api/ai/messages・/api/ai/status、#134。docs/design.md 8.3・13.4、ai-advisor.md 論点 3・4・6〜8） ----
# 料金表（USD / 100 万トークン を µUSD / 100 万トークン の整数で）。出典（確認日 AI_PRICE_CHECKED）:
# https://platform.claude.com/docs/en/about-claude/pricing 。読み取りは入力の 0.05 倍。
# 料金が変わったらこの表と確認日を直す PR を出す（自動ではない）
AI_PRICE_CHECKED = "2026-10-19"
AI_PRICES: dict[str, dict[str, int]] = {
    "claude-opus-5-5": {
        "input": 4_000_000,
        "cache_write_5m": 5_000_000,
        "cache_write_1h": 8_000_000,
        "cache_read": 200_000,
        "output": 20_000_000,
    },
}
AI_MODEL_DEFAULT = "claude-opus-5-5"  # AI_MODEL で上書きできるのは料金表にあるモデルだけ
AI_DAILY_LIMIT_USD_DEFAULT = 3  # 1 日（JST）の上限（K15）。AI_DAILY_LIMIT_USD で上書き（0 < 値 ≤ 最大）
AI_DAILY_LIMIT_USD_MAX = 20
AI_MAX_TOKENS = 8000  # 出力の上限（thinking を含む）。予約額の出力側。#135 が測って直す
AI_EFFORT = "medium"  # output_config.effort。#135 が測って決める
# 1 要求で上流を呼ぶ回数の上限（#221。Skill を 2 回 + 答え）。超えたら CLI は error_max_turns で終わる
# （SSE は error: upstream_unavailable）。予約額の上界も turn の数で数える（budget.reserve_micro_usd）
AI_MAX_TURNS = 3
# スキル（ai/plugin/skills/*/SKILL.md）の合計の大きさの上限（tests/test_ai_skills.py）。予約額の上界には実際の合計 +
# AI_SKILL_OVERHEAD_TOKENS（Skill の tool_use・tool_result の枠と CLI が足す前置き）を turn ごとに足す
AI_SKILL_MAX_BYTES = 16 * 1024
AI_SKILL_OVERHEAD_TOKENS = 1000
# 文書（マニュアル・設計書の節。#137 = docs/adr-0007-ai-docs-read-tool.md）。中継の中で実行するツール read_doc が返す
# 大きさの上限: 1 回の読み（超える節は part に分ける）・1 要求の合計・1 要求の呼び出しの回数。予約額の上界には
# 1 要求の合計 + AI_DOC_OVERHEAD_TOKENS を足す。
# - 1 回の読みの返り（見出しの行・「続きは」の行を含む）≤ AI_DOC_READ_MAX_BYTES（本文は AI_DOC_FRAME_BYTES を引いた
#   大きさで part に分ける）。2 回 ≤ 1 要求の合計なので、part を 2 つは必ず読める
# - 呼び出しは 1 要求で AI_DOC_MAX_READS 回まで。超えた呼び出しはフックが deny + continue_=False で止める（上流を
#   もう呼ばない = その結果は送られない）。なので read_doc の結果の合計 ≤ 1 要求の合計（本文）+ 回数 ×（エラーの文の
#   上限 AI_DOC_ERROR_MAX_BYTES + tool_result の枠 AI_DOC_RESULT_FRAME_BYTES）≤ 1 要求の合計 + AI_DOC_OVERHEAD_TOKENS
#   （トークン数 ≤ バイト数。tests/test_ai_docs.py で固定）
AI_DOC_READ_MAX_BYTES = 8 * 1024
AI_DOC_REQUEST_MAX_BYTES = 16 * 1024
AI_DOC_FRAME_BYTES = 512
AI_DOC_MAX_READS = 6
AI_DOC_ERROR_MAX_BYTES = 256
AI_DOC_RESULT_FRAME_BYTES = 200  # tool_result の type・tool_use_id・is_error・content の枠
AI_DOC_OVERHEAD_TOKENS = 3000
# 文書の置き場所（イメージは Dockerfile の ENV で /app/docs）。未設定ならリポジトリの docs/（手元・テスト）
AI_DOCS_DIR_ENV = "AI_DOCS_DIR"
# 1 要求の締め切り（_start の頭 = 予約の前から数える）。超えたら error: timeout で閉じる。
# 締め切りの直前に final が来ると精算（Firestore の書き込み、最大 AI_FIRESTORE_TIMEOUT_SECONDS = 5 秒）が
# その後に走るので、最悪 50 + 5 = 55 秒で Cloud Run の 60 秒の内側に収まる
AI_DEADLINE_SECONDS = 50
AI_MAX_BODY_BYTES = 512 * 1024  # 要求の本文の上限（413）
AI_MAX_CONCURRENT = 2  # インスタンスごとに同時に流す本数（gunicorn の 8 スレッドのうち 6 本は /api/chain などに残す）
AI_RATE_PER_MINUTE = 10  # インスタンスごとの 1 分の回数
# 入力トークンの見積もり = 送る本文（system・tools・messages）の UTF-8 のバイト数 + AI_INPUT_OVERHEAD_TOKENS。
# バイト単位の BPE のトークンは 1 つ 1 バイト以上なので、トークン数 ≤ バイト数（数字・記号の多い JSON でも過小にならない
# 上界。ASCII 1 字 = 1、日本語 1 字 = 3）。OVERHEAD は本文に見えない分（message の区切り・ツールを使うときの
# system prompt など。数百トークン）の余裕
AI_INPUT_OVERHEAD_TOKENS = 2000
# CLI（Claude Agent SDK の同梱の CLI。#221）が送る本文に足す分: system の先頭の 2 block（約 135 B）・Skill の
# ツールの定義（約 1.8 KB）・role=system の環境の message（cwd・OS・モデル名・スキルの一覧。約 1.0 KB）。
# CLI 2.1.283 の実測で、送った本文（system・tools・messages の UTF-8）− 中継の本文 = 2,843〜2,884 B
# （tests/test_ai_agent_sdk_cli.py がこの値以下であることを固定する）。見積もり E に足す
AI_CLI_OVERHEAD_TOKENS = 4000
AI_FIRESTORE_DATABASE = "simulator-ai"  # 日の計上の置き場所（Firestore の名前つき DB。infra/bootstrap/ai_budget.tf）
AI_FIRESTORE_COLLECTION = "ai_spend"
AI_FIRESTORE_TIMEOUT_SECONDS = 5.0
AI_FIRESTORE_RETRIES = 3  # 前提条件の失敗（他のインスタンスと競合）の読み直し
# fake は手元とテスト用の偽の送信先（Terraform の変数は通さない）
AI_CREDENTIALS = ("api_key", "oauth_token", "wif", "fake")
# Anthropic の WIF（#184。ADR-0001 の追補・ADR-0006）: 中継が要求ごとに Cloud Run のメタデータサーバーから実行 SA の
# Google の ID トークンを取り、同梱の CLI に ANTHROPIC_IDENTITY_TOKEN で渡す（CLI が Anthropic の短命トークンに
# 交換する）。
# format=full は email の claim を入れる（federation rule は sub と email の両方を固定する）
AI_WIF_AUDIENCE = "https://api.anthropic.com"
AI_IDENTITY_TOKEN_URL = ("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
                         f"?audience={AI_WIF_AUDIENCE}&format=full")  # 公式の手順と同じ形
AI_IDENTITY_TOKEN_TIMEOUT_SECONDS = 3.0
AI_IDENTITY_TOKEN_MAX_BYTES = 16 * 1024
# WIF の ID の形（値は秘密ではないが利用者個人のもの。リポジトリ・ログに書かない）。組織 ID は UUID、他は英数字・_・-
_AI_WIF_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_AI_ORG_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
AI_BUDGET_STORES = ("firestore", "memory")
_AI_LIMIT_RE = re.compile(r"^[0-9]{1,2}(?:\.[0-9]{1,2})?$")

# 供給元（DATA_SOURCE の値）。値 → 実装の表は sources.py の BUILDERS
# （docs/data-sources.md「API の供給元のアダプタ」。#154）
DATA_SOURCES = ("bigquery", "file", "quotes")


@dataclass(frozen=True)
class Settings:
    data_source: str = "bigquery"
    project: str = ""
    dataset: str = "optionchan_tokyo"
    location: str = "asia-northeast1"
    maximum_bytes_billed: int = MAX_BYTES_BILLED_LIMIT
    chain_file: Path | None = None
    quotes_file: Path | None = None  # DATA_SOURCE=quotes の気配の一覧（中立の形。quotes.py）
    calendar_file: Path | None = None  # DATA_SOURCE=quotes の取引カレンダー（/api/calendar と同じ形の JSON）
    static_dir: Path | None = None

    def __post_init__(self):
        if self.data_source not in DATA_SOURCES:
            raise ValueError("DATA_SOURCE は " + " / ".join(DATA_SOURCES) + " のどれか")
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
        if self.data_source == "quotes" and (self.quotes_file is None or self.calendar_file is None):
            raise ValueError("DATA_SOURCE=quotes には QUOTES_FILE と CALENDAR_FILE が必要")


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
    if env.get("QUOTES_FILE"):
        kwargs["quotes_file"] = Path(env["QUOTES_FILE"])
    if env.get("CALENDAR_FILE"):
        kwargs["calendar_file"] = Path(env["CALENDAR_FILE"])
    if env.get("STATIC_DIR"):
        kwargs["static_dir"] = Path(env["STATIC_DIR"])
    return Settings(**kwargs)


@dataclass(frozen=True)
class WifIds:
    """Anthropic の WIF の ID（ANTHROPIC_FEDERATION_RULE_ID・ANTHROPIC_ORGANIZATION_ID は必須、
    ANTHROPIC_SERVICE_ACCOUNT_ID・ANTHROPIC_WORKSPACE_ID は任意 = SDK と同じ）。個人の値なので repr に出さない"""

    federation_rule_id: str = field(repr=False)
    organization_id: str = field(repr=False)
    service_account_id: str | None = field(default=None, repr=False)
    workspace_id: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class AiSettings:
    """AI の中継の設定。credential が None なら AI は無効（disabled は理由の列挙。値は持たない）。
    secret は repr に出さない（ログ・例外に鍵を出さない）"""

    credential: str | None = None
    model: str = AI_MODEL_DEFAULT
    daily_limit_micro_usd: int = AI_DAILY_LIMIT_USD_DEFAULT * 1_000_000
    budget_store: str | None = None  # firestore / memory。oauth_token は数えないので None
    project: str = ""
    deadline_seconds: float = AI_DEADLINE_SECONDS
    disabled: str | None = "not_configured"
    secret: str | None = field(default=None, repr=False)
    wif: WifIds | None = field(default=None, repr=False)  # credential が wif のときだけ

    @property
    def enabled(self) -> bool:
        return self.credential is not None

    @property
    def counted(self) -> bool:
        return self.budget_store is not None


def _ai_disabled(reason: str, warn: bool) -> AiSettings:
    if warn:
        from .log import log

        # 値は出さない（どの設定が駄目かの列挙だけ）
        log("WARNING", "ai_disabled", reason=reason)
    return AiSettings(disabled=reason)


def ai_from_env(env=None) -> AiSettings:
    """AI_CREDENTIAL（none / 未設定は無効）・ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN・WIF の ID（wif のとき）・
    AI_MODEL・AI_DAILY_LIMIT_USD・AI_BUDGET_STORE・GCP_PROJECT から。設定が不正なときは AI だけを無効にする
    （simulator 全体は起動する）。
    SDK に環境変数を読ませず、選んだ種類の資格情報だけを中継が渡す（ADR-0001）"""
    env = os.environ if env is None else env
    credential = (env.get("AI_CREDENTIAL") or "none").strip()
    if credential == "none":
        return AiSettings()
    if credential not in AI_CREDENTIALS:
        return _ai_disabled("ai_credential_invalid", True)
    key, token = env.get("ANTHROPIC_API_KEY") or None, env.get("ANTHROPIC_AUTH_TOKEN") or None
    secret = None
    wif: WifIds | None = None
    if credential == "wif":
        if key is not None or token is not None:
            # 鍵なしで動かすつもりの所に長命の鍵が残っている（取り違えの元）。無効にして気づかせる
            return _ai_disabled("ai_credential_conflict", True)
        ids = {name: (env.get(name) or "").strip() or None for name in (
            "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SERVICE_ACCOUNT_ID",
            "ANTHROPIC_WORKSPACE_ID")}
        rule, org = ids["ANTHROPIC_FEDERATION_RULE_ID"], ids["ANTHROPIC_ORGANIZATION_ID"]
        sa, ws = ids["ANTHROPIC_SERVICE_ACCOUNT_ID"], ids["ANTHROPIC_WORKSPACE_ID"]
        if rule is None or org is None:
            return _ai_disabled("ai_credential_missing", True)
        if (not _AI_ORG_ID_RE.match(org)
                or any(v is not None and not _AI_WIF_ID_RE.match(v) for v in (rule, sa, ws))):
            return _ai_disabled("ai_wif_invalid", True)
        wif = WifIds(federation_rule_id=rule, organization_id=org, service_account_id=sa, workspace_id=ws)
    elif credential != "fake":
        if key is not None and token is not None:
            # 両方あると SDK は X-Api-Key と Authorization の両方を送る（API は拒否する）。取り違えを避けて無効に
            return _ai_disabled("ai_credential_conflict", True)
        secret = key if credential == "api_key" else token
        if secret is None:
            return _ai_disabled("ai_credential_missing", True)
    model = (env.get("AI_MODEL") or AI_MODEL_DEFAULT).strip()
    if model not in AI_PRICES:
        return _ai_disabled("ai_model_unpriced", True)
    limit = AI_DAILY_LIMIT_USD_DEFAULT * 1_000_000
    if env.get("AI_DAILY_LIMIT_USD"):
        raw = env["AI_DAILY_LIMIT_USD"].strip()
        if not _AI_LIMIT_RE.match(raw):
            return _ai_disabled("ai_daily_limit_invalid", True)
        whole, _, frac = raw.partition(".")
        limit = int(whole) * 1_000_000 + int((frac + "00")[:2]) * 10_000
        if not 0 < limit <= AI_DAILY_LIMIT_USD_MAX * 1_000_000:
            return _ai_disabled("ai_daily_limit_invalid", True)
    store: str | None = None
    project = ""
    if credential != "oauth_token":
        store = (env.get("AI_BUDGET_STORE") or ("memory" if credential == "fake" else "firestore")).strip()
        if store not in AI_BUDGET_STORES:
            return _ai_disabled("ai_budget_store_invalid", True)
        if store == "firestore":
            project = env.get("GCP_PROJECT", "")
            if not _PROJECT_RE.match(project):
                return _ai_disabled("ai_budget_project_missing", True)
        elif credential in ("api_key", "wif"):
            from .log import log

            # インスタンスごとのメモリ = 冷えるたびに 0 に戻る（手元の確認用）
            log("WARNING", "ai_budget_memory")
    return AiSettings(credential=credential, model=model, daily_limit_micro_usd=limit, budget_store=store,
                      project=project, disabled=None, secret=secret, wif=wif)

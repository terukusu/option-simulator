# api（板とカレンダーの JSON を返す Flask）

optionchan の BigQuery（データセット `optionchan_tokyo` のテーブル関数 4 本とビュー `trading_calendar_latest`）を **読むだけ** の API。計算（F・補間・ATM）はブラウザの `model/` で行う。設計は `docs/design.md` の 7.1〜7.3・7.5・8.3。

| エンドポイント | 内容 |
|---|---|
| `GET /api/chain` | 使える最新の板（7.2）を JSON 版 1（`data/chainTypes.ts`）で。`reason` = `latest` / `pre_open` / `after_close` / `closed`。`?at=` は後段（400） |
| `GET /api/calendar` | 取引カレンダーの最新版 `{schema_version, source, version_at, covered_until, listed_until, days: [{date, is_trading_day, status, name}]}`（日付の昇順） |
| `GET /healthz` | 設定の読み込みだけ（BigQuery に触れない） |
| `/`・`/assets/<path>` | `STATIC_DIR` があるときだけ、Vite のビルド成果物（`dist/`）を配る |

作り（`src/simulator_api/`）: `usable.py`（使える板の判定。純関数。定数は `settings.py` の上部）、`chain.py`（板の JSON の組み立て）、`calendar.py`（SQ 日の規則と `/api/calendar` の JSON）、`cache.py`（TTL・LRU と single-flight）、`service.py`（BigQuery の読み方とキャッシュ）、`bq.py`（SQL の読み込みと実行）、`contract.py`（optionchan との契約 = 使う列と型）、`sql/*.sql`、`app.py`（Flask・セキュリティヘッダ）、`log.py`（JSON の構造化ログ）。

## 設定（環境変数）

| 名前 | 既定 | 意味 |
|---|---|---|
| `DATA_SOURCE` | `bigquery` | `bigquery` か `file`（`file` は `CHAIN_FILE` の JSON をそのまま `/api/chain` で返す。GCP なしで動かす用。`/api/calendar` は 503） |
| `GCP_PROJECT` | なし（`bigquery` のとき必須） | BigQuery のプロジェクト ID |
| `BQ_DATASET` | `optionchan_tokyo` | データセット |
| `BQ_LOCATION` | `asia-northeast1` | ロケーション |
| `MAX_BYTES_BILLED` | `536870912` | 1 ジョブのクエリ量の上限（バイト。1〜512 MiB。超える値は起動時にエラー） |
| `CHAIN_FILE` | なし | `DATA_SOURCE=file` の板の JSON |
| `STATIC_DIR` | なし | 静的ファイルのディレクトリ（`index.html` と `assets/`） |

実値（プロジェクト ID など）はリポジトリに書かない。

## 手元で動かす

```bash
cd api
uv sync --locked --python 3.13      # uv は 0.12.19（CI と同じ）
# BigQuery（ADC: gcloud auth application-default login）。読み取りのみ。板 1 回は約 152 MiB を読むので数回まで
GCP_PROJECT=<PROJECT_ID> uv run --locked flask --app simulator_api.app run -p 8080
# GCP なし
DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json uv run --locked flask --app simulator_api.app run -p 8080
```

画面は別の端末で `npm run dev`（Vite の `server.proxy` が `/api` を `127.0.0.1:8080` に渡す。同一オリジン）。本番は gunicorn（`simulator_api.app:app`、1 ワーカー・8 スレッド）。イメージはリポジトリ直下の `Dockerfile`（画面の `dist/` を同梱し `STATIC_DIR=/app/static`）、検査は `.github/scripts/image-check.sh`、Cloud Run の設定（環境変数 `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`）は `infra/prod/simulator.tf`、手順は `infra/README.md`「prod（Cloud Run simulator）」。

## テスト

```bash
cd api
uv run --locked ruff check
uv run --locked pytest -q
```

- BigQuery は偽の runner（`tests/support.py` の `FakeRunner`）。板は合成（`fixtures/synthetic/*.json` から作る round-trip と、判定用の小さな合成の板）
- 契約（AC25）: `OPTIONCHAN_SCHEMA_DIR=<optionchan の固定コミットの checkout>/schema/tokyo uv run --locked pytest -q tests/test_contract.py`。固定コミットは `contract/optionchan_commit.txt`（40 桁の SHA）。CI はリポジトリ変数 `OPTIONCHAN_REPO`（`<OWNER>/<REPO>`）があるときだけその SHA を sparse checkout して照合する（未設定なら notice を出してスキップ）
- SQL の dry run（課金 0。CI では動かさない）: `OPTIONCHAN_BQ_TEST=1 OPTIONCHAN_BQ_PROJECT=<PROJECT_ID> uv run --locked pytest -q -s tests/test_sql_bq.py`（ADC。見積もりが 512 MiB 以下で、結果の列・型が `contract.py` と一致）

### 固定コミットの更新

optionchan の `schema/tokyo` が変わったら（列の追加・型の変更）、`contract/optionchan_commit.txt` を optionchan の新しいコミットの SHA にし、上の契約テストと dry run を手元で通してから PR にする。照合に落ちたら `contract.py`・`sql/*.sql`・`chain.py` を直す。

## 本番での `reason` の確認（AC-11。判定は #40）

デプロイ後、ブラウザ（IAP のログイン済み）で `/api/chain` を次の時間帯に開き、`reason` と `snapshot_at` の時刻だけを記録する（価格・URL は記録しない）。

| 時間帯（JST） | 期待 |
|---|---|
| 取引時間中（例 10:00、21:00） | `latest`、`snapshot_at` は約 15 分前 |
| 夜間の寄り前（16:45〜17:00 の板が最新のとき） | `pre_open`、`snapshot_at` は 15:40 以前 |
| 日中の引け後（15:41〜16:44 の板が最新のとき） | `after_close`、`snapshot_at` は 15:40 以前 |
| 夜間の引け後（5:56〜8:38） | `after_close`、`snapshot_at` は 5:55 以前 |
| 土日・休業日 | `closed`、`snapshot_at` は直前の立会の最後 |

あわせて Cloud Logging の `chain_served`（`reason`・`board_reads`）と `bq_job`（`total_bytes_billed`）を見る。同じ `snapshot_at` の 2 回目のリクエストで `bq_job` が `latest_runs` だけなら、キャッシュが効いている。

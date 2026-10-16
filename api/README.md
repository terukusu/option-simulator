# api（板とカレンダーの JSON を返す Flask）

optionchan の BigQuery（データセット `optionchan_tokyo` のテーブル関数 4 本とビュー `trading_calendar_latest`）を **読むだけ** の API。計算（F・補間・ATM）はブラウザの `model/` で行う。設計は `docs/design.md` の 7.1〜7.3・7.5・8.3。

| エンドポイント | 内容 |
|---|---|
| `GET /api/chain` | 使える最新の板（7.2）を JSON 版 1（`data/chainTypes.ts`）で。`reason` = `latest` / `pre_open` / `after_close` / `closed`。`?at=` は後段（400） |
| `GET /api/calendar` | 取引カレンダーの最新版 `{schema_version, source, version_at, covered_until, listed_until, days: [{date, is_trading_day, status, name}]}`（日付の昇順）。画面は本番で開いたときと [最新] で読む（取れなければ同梱の版。#39） |
| `GET /healthz` | 設定の読み込みだけ（BigQuery に触れない） |
| `/`・`/assets/<path>` | `STATIC_DIR` があるときだけ、Vite のビルド成果物（`dist/`）を配る |

作り（`src/simulator_api/`）: `usable.py`（使える板の判定。純関数。定数は `settings.py` の上部）、`chain.py`（板の JSON の組み立て）、`calendar.py`（SQ 日の規則と `/api/calendar` の JSON）、`cache.py`（TTL・LRU と single-flight）、`service.py`（BigQuery の読み方とキャッシュ）、`bq.py`（SQL の読み込みと実行）、`contract.py`（optionchan との契約 = 使う列と型）、`sql/*.sql`、`app.py`（Flask・セキュリティヘッダ）、`log.py`（JSON の構造化ログ）。

## 設定（環境変数）

| 名前 | 既定 | 意味 |
|---|---|---|
| `DATA_SOURCE` | `bigquery` | `bigquery` か `file`（`file` は `CHAIN_FILE` の JSON をそのまま `/api/chain` で返す。GCP なしで動かす用。`/api/calendar` は 503 で、画面は同梱の取引カレンダーを使う） |
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

## 本番での `reason` の確認（AC2）

`reason` は最新の取り込み（`latest_runs` の先頭 = R0）の `snapshot_at` の JST の時刻で決まり、R0 が 45 分（`CLOSED_AFTER_MINUTES`）より古ければ時刻より先に `closed` になる（`docs/design.md` 7.2、`src/simulator_api/usable.py`）。optionchan の取り込みは引け後しばらくで止まり、次の寄り前に再開する（観測（2026-10-14〜16）: 日中は 16:45 に再開、夜間は 8:30 に再開。止まる時刻は optionchan の運用で変わる）ので、引け後の `after_close` は最新の取り込みが 45 分以内のあいだだけになる。

| 時間帯（JST、ブラウザで開いた時刻） | 期待の `reason` | 返す板（`snapshot_at`） |
|---|---|---|
| 取引時間中（例 10:00、21:00） | `latest` | 約 15 分前 |
| 日中の寄り前（8:39〜8:46 の取り込みが最新） | `pre_open` | 5:55（夜間の板寄せ前の最後） |
| 日中の引け後（15:41〜、最新の取り込みが 45 分以内のあいだ。観測上 16:44 ごろまで） | `after_close` | 15:40 以前 |
| 夜間の寄り前（16:45〜17:00 の取り込みが最新） | `pre_open` | 15:40 以前 |
| 夜間の引け後（5:56〜、最新の取り込みが 45 分以内のあいだ。観測上 7:00 ごろまで） | `after_close` | 5:55 |
| 夜間の引け後で取り込みが止まって 45 分を過ぎてから再開まで（観測上 約 7:00〜8:29） | `closed` | 5:55 |
| 取り込みの再開後（8:30〜8:38 の取り込みが最新） | `after_close` | 5:55 |
| 土日・休業日 | `closed` | 直前の立会の最後 |

確かめ方: ブラウザ（IAP のログイン済み）で本番の `/` を開いて [最新] を 1 回押し、画面のヘッダの理由と板の時刻を記録する（価格・URL は記録しない）。その後、その時刻の `chain_served` のログを読んで表と突き合わせる:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND jsonPayload.event="chain_served"' \
  --project="$P" --freshness=1d --format='value(timestamp,jsonPayload.reason,jsonPayload.snapshot_at,jsonPayload.cache)'
```

ログは 1 行 1 件の JSON（`src/simulator_api/log.py`。`message` と `event` がイベント名）。`chain_served` の `cache` は `miss`（板を読んだ）/ `hit`、`board_reads` は板を読んだ回数。`bq_job`（`name`・`elapsed_ms`・`total_bytes_billed`）も同じ形で読める。同じ `snapshot_at` の 2 回目のリクエストで `bq_job` が `latest_runs` だけなら、キャッシュが効いている。

## クエリ量の監視（7.3・D8）

simulator の SA が出した BigQuery のジョブを、日ごと（JST）のジョブ数・課金量・1 ジョブの最大・エラー数に集計する。元は Cloud Logging の BigQuery の監査ログ（Data Access。BigQuery では既定で記録され無料、保持は既定 30 日）の `jobChange`。値は出ない（日付と数字だけ）:

```sh
P=$(gcloud config get-value project)
SA=sa-simulator@$P.iam.gserviceaccount.com
gcloud logging read "protoPayload.serviceName=\"bigquery.googleapis.com\" AND protoPayload.authenticationInfo.principalEmail=\"$SA\" AND protoPayload.metadata.jobChange.after=\"DONE\"" \
  --project="$P" --freshness=7d --limit=10000 --format=json \
  | jq -r 'map({d: (.timestamp | sub("\\.[0-9]+"; "") | fromdateiso8601 + 32400 | strftime("%Y-%m-%d")),
               b: ((.protoPayload.metadata.jobChange.job.jobStats.queryStats.totalBilledBytes // "0") | tonumber),
               e: (.protoPayload.metadata.jobChange.job.jobStatus.errorResult != null)})
           | group_by(.d)[] | "\(.[0].d) jobs=\(length) billed_GiB=\((map(.b) | add) / 1073741824 * 100 | round / 100) max_MiB=\((map(.b) | max) / 1048576 * 10 | round / 10) errors=\(map(select(.e)) | length)"'
```

目安: 1 日の課金量がプロジェクトの 1 日の上限 32 GiB の 10%（3.2 GiB）未満、1 ジョブの最大が 512 MiB（`MAX_BYTES_BILLED_LIMIT`）以下、`errors` が 0。課金量は 1 ジョブ 10 MiB の最小課金を含むので、処理量より大きめに出る（上限の判定では安全側）。`region-asia-northeast1.INFORMATION_SCHEMA.JOBS_BY_PROJECT` は 1 日に絞っても最小のスキャンが 512 MiB を超え、`--maximum_bytes_billed=536870912` の下では読めないので使わない。

# api（板・カレンダー・IV 推移・先物推移・日次の値の JSON を返す Flask と、AI の中継）

optionchan の BigQuery（データセット `optionchan_tokyo` のテーブル関数 4 本とビュー `trading_calendar_latest`、表 `atm_cm_iv`）を **読むだけ** の API と、AI アドバイザーの中継（Anthropic の Messages API。#134）。計算（F・補間・ATM）はブラウザの `model/` で行う。設計は `docs/design.md` の 7.1〜7.3・7.5・8.3・13.4「AI の中継」・14 章。供給元は `DATA_SOURCE` で差し替えられる（下の設定。供給元のアダプタ・板の契約・中立の気配の一覧の形式は `docs/data-sources.md` にある。#154）。

| エンドポイント | 内容 |
|---|---|
| `GET /api/chain` | 使える最新の板（7.2）を板の JSON（形式のバージョン 1。`schema_version: 1`。型は `data/chainTypes.ts`）で返す。`reason` = `latest` / `pre_open` / `after_close` / `closed`。`?at=` は後段（400） |
| `GET /api/calendar` | 取引カレンダーの最新版 `{schema_version, source, version_at, covered_until, listed_until, days: [{date, is_trading_day, status, name}]}`（日付の昇順）。画面は本番で開いたときと [最新] で読む（取れなければ同梱の版。#39） |
| `GET /api/atm_iv?tf=<1m\|1h\|1d>[&start=<ISO>&end=<ISO>]` | IV 推移（#79）: 表 `atm_cm_iv` の `iv30`（30 日固定の ATM IV、%）の足 `{schema_version, tf, start, end, last_at, bars: [{t, o, h, l, c}]}`。`start`・`end` は両方か無し（無ければ右端（最新）までの既定の範囲。1m 3 日・1h 60 日・1d 365 日）、オフセット付きの ISO 8601 で UTC の 0 時ちょうど。1 回の最大は 1m 3 日・1h 100 日・1d 400 日。不正は 400、BigQuery の失敗・`DATA_SOURCE=file` は 503。仕様は `docs/design.md` 7.1・13.4 |
| `GET /api/future_bars?tf=<1m\|1h\|1d>[&start=<ISO>&end=<ISO>]` | 先物推移（#190）: テーブル関数 `future_price_latest` の現在値（ラージ・期近。15 分遅れ）の足 `{schema_version, tf, start, end, last_at, bars: [{t, o, h, l, c, m}]}`（値は円、`m` は限月 `YYYY-MM` = 取引カレンダーから求めた期近）。パラメータ・最大日数・400 / 503・`Cache-Control` は `/api/atm_iv` と同じ。足は `price_time`（約定の分）で切り、`created_at` は範囲の終わりより 10 分先まで読む。`DATA_SOURCE=file` / `quotes` は 503。仕様は `docs/design.md` 7.1・13.4 |
| `GET /api/atm_daily` | 日次の値（#152）: 表 `atm_cm_iv` の JST の日付ごとの日中の終値（JST 9:00〜15:00 の最後の行）の `iv30` と 1 / 2 限月のフォワード・最終取引日 `{schema_version, start, end, days: [{d, t, iv, f1, l1, f2, l2}]}`。パラメータなし（知らないパラメータは無視）。確定した日だけ（`end` = JST の今日（8:00 以降）/ 前日、含まない）。`Cache-Control: private, max-age=3600`・ETag で 304。BigQuery の失敗・`DATA_SOURCE=file` は 503。2 営業日の組はブラウザ（`data/atmDaily.ts`）。仕様は `docs/design.md` 7.1・13.4 |
| `POST /api/ai/messages` | AI の中継（#134）。本文 JSON `{schema_version: 1, kind: "chat" | "diagnose" | "ask" | "preset", context, messages, topic?}`（`topic` は ask・preset のときだけ） を許可リストで検査し、サーバーが固定する引数を付けて Anthropic に送り、SSE（`accepted` → `progress` / `thinking` / `text` / `tool_use` → `done` / `error`）で流す。1 日の上限（予約と精算）・同じオリジン・`Content-Type: application/json`・512 KiB・同時 2 本・1 分 10 回。下の「AI の中継」 |
| `GET /api/ai/status` | AI が使えるか・モデル・資格情報の種類・数えるか・1 日の上限と残り・戻る時刻（`no-store`） |
| `POST /api/ai/read_positions` | 建玉の一覧の画像の読み取り（#318）。本文 JSON `{schema_version: 1, image: {media_type: "image/png" \| "image/jpeg", data: <base64>}}`（768 KiB・画像は生 500,000 B・長辺 2,000 px まで）を検査し、読み取り専用のツール `report_positions` 1 本で 1 turn だけ送り、検査を通った行だけを JSON で返す（`{schema_version, kind, rows, remaining_usd}`。`no-store`）。守り・1 日の上限・同時の本数・1 分の回数は会話と共用。下の「画像の読み取り」 |
| `GET /healthz` | 設定の読み込みだけ（BigQuery・Anthropic・Firestore に触れない） |
| `/`・`/assets/<path>` | `STATIC_DIR` があるときだけ、Vite のビルド成果物（`dist/`）を配る |
| `/manifest.webmanifest`・`/favicon.svg`・`/apple-touch-icon.png`・`/icon-192.png`・`/icon-512.png` | `STATIC_DIR` があるときだけ、`dist/` 直下のこの 5 つの名前だけを配る（`no-cache`。名前の集合は `app.py` の `ROOT_FILES`。他の名前は 404。#90） |

構成（`src/simulator_api/`）: `sources.py`（供給元のインターフェース `DataSource` と `DATA_SOURCE` → 実装の表 `BUILDERS`）、`quotes.py`（中立の気配の一覧 → 板の JSON。純関数。#154）、`usable.py`（使える板の判定。純関数。定数は `settings.py` の上部）、`chain.py`（板の JSON の組み立て）、`calendar.py`（SQ 日の規則と `/api/calendar` の JSON）、`atm_iv.py`（IV 推移の要求の検査・足の集約・JSON。純関数）、`atm_daily.py`（日次の値の確定した範囲・行の検査・JSON。純関数。#152）、`future_bars.py`（先物推移の読み込む範囲・足・限月・JSON。純関数。#190）、`cache.py`（TTL・LRU・期限付きの LRU と single-flight）、`service.py`（BigQuery の読み方とキャッシュ、`file`・`quotes` の供給元）、`bq.py`（SQL の読み込みと実行）、`contract.py`（optionchan との契約 = 使う列と型）、`sql/*.sql`、`app.py`（Flask・セキュリティヘッダ）、`log.py`（JSON の構造化ログ）。AI の中継は `ai/`: `shape.py`（形式の検査）・`tools.py`（ツールの登録。#135 で 6 本）・`allowlist.py`（要求の許可リストと送る本文の組み立て直し。純関数）・`budget.py`（料金表・見積もり・予約 / 精算・JST の日）・`firestore_store.py`（日の計上。REST）・`gateway.py`（SDK の薄い包みと偽の送信先）・`guard.py`（同じオリジン・同時の本数・回数）・`relay.py`（エンドポイントの本体・SSE・ログ）。

## 設定（環境変数）

| 名前 | 既定 | 意味 |
|---|---|---|
| `DATA_SOURCE` | `bigquery` | `bigquery` / `file` / `quotes`。`file` は `CHAIN_FILE` の JSON をそのまま `/api/chain` で返す（GCP なしで動かす用。`/api/calendar` は 503 で、画面は同梱の取引カレンダーを使う）。`quotes` は `QUOTES_FILE` の中立の気配の一覧と `CALENDAR_FILE` から板を組み立てる（`/api/calendar` は `CALENDAR_FILE`。`/api/atm_iv`・`/api/atm_daily`・`/api/future_bars` は 503。データ形式は `docs/data-sources.md` 4 章） |
| `GCP_PROJECT` | なし（`bigquery` のとき必須） | BigQuery のプロジェクト ID |
| `BQ_DATASET` | `optionchan_tokyo` | データセット |
| `BQ_LOCATION` | `asia-northeast1` | ロケーション |
| `MAX_BYTES_BILLED` | `536870912` | 1 ジョブのクエリ量の上限（バイト。1〜512 MiB。超える値は起動時にエラー）。`atm_cm_iv` のジョブはこれと 64 MiB、`atm_cm_daily` のジョブはこれと 128 MiB の小さい方（`settings.QUERY_MAX_BYTES_BILLED`） |
| `CHAIN_FILE` | なし | `DATA_SOURCE=file` の板の JSON |
| `QUOTES_FILE` | なし | `DATA_SOURCE=quotes` の気配の一覧（要求ごとに読む。書き換えれば [最新] で新しい板） |
| `CALENDAR_FILE` | なし | `DATA_SOURCE=quotes` の取引カレンダー（`/api/calendar` と同じデータ形式。同梱の `../data/calendar/calendar.json` を指せる） |
| `STATIC_DIR` | なし | 静的ファイルのディレクトリ（`index.html`・`assets/`・直下の manifest とアイコン） |
| `AI_CREDENTIAL` | `none`（未設定も同じ） | AI の資格情報の種類: `oauth_token`（本番の既定。Claude のサブスクリプションの OAuth トークンを Claude Agent SDK 経由で送る。数えない。規約は自分で確かめる = `docs/adr-0005-ai-oauth-via-agent-sdk.md`）/ `wif` / `api_key`（本番。Terraform の変数 `ai_credential`）/ `fake`（偽の送信先とメモリの計上。手元・テスト用。Anthropic を呼ばない）。不正な値は AI だけを無効にする |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | なし | 選んだ方だけ（本番は Secret Manager の参照）。両方ある・選んだ方が無いときは AI を無効にする（WARNING `ai_disabled`。値は出さない）。中継が読み、SDK には明示で片方だけを渡す（`oauth_token` は CLI の子プロセスに `CLAUDE_CODE_OAUTH_TOKEN` としてだけ渡し、子の `ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_API_KEY` は空で上書きする）。`wif` のときはどちらかがあれば AI を無効にする（`ai_credential_conflict`） |
| `ANTHROPIC_FEDERATION_RULE_ID`・`ANTHROPIC_ORGANIZATION_ID` / `ANTHROPIC_SERVICE_ACCOUNT_ID`・`ANTHROPIC_WORKSPACE_ID` | なし | `wif`（Anthropic の WIF。#184）の ID。前 2 つは必須（無ければ `ai_credential_missing`）、後 2 つは任意。形式（組織 ID は UUID、他は英数字・`_`・`-` の 128 文字まで）が違えば `ai_wif_invalid`。中継が要求ごとにメタデータサーバーから実行 SA の ID トークン（audience `https://api.anthropic.com`・`format=full`）を取り、同梱の CLI の子に WIF の ID と `ANTHROPIC_IDENTITY_TOKEN` だけを渡す（交換は CLI。Cloud Run の中でだけ動く。#221）。値は秘密ではないが個人のものなのでログに出さない |
| `AI_MODEL` | `claude-opus-5-5` | 料金表（`settings.AI_PRICES`）にあるモデルだけ |
| `AI_DAILY_LIMIT_USD` | `3` | 1 日（JST）の上限（USD。0 < 値 ≤ 20、小数 2 桁まで） |
| `AI_BUDGET_STORE` | `firestore`（`fake` は `memory`） | 日の計上の置き場所。`firestore` は名前つき DB `simulator-ai`（`GCP_PROJECT` が要る）、`memory` はインスタンスのメモリ（冷えると 0 に戻る。`api_key` / `wif` で使うと WARNING `ai_budget_memory`）。`oauth_token` は数えない（`wif` は `api_key` と同じく実額で数える） |

実値（プロジェクト ID など）はリポジトリに書かない。

## 手元で動かす

```bash
cd api
uv sync --locked --python 3.13      # uv は 0.12.19（CI と同じ）
# BigQuery（ADC: gcloud auth application-default login）。読み取りのみ。板 1 回は約 152 MiB を読むので数回まで
GCP_PROJECT=<PROJECT_ID> uv run --locked flask --app simulator_api.app run -p 8080
# GCP なし
DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json uv run --locked flask --app simulator_api.app run -p 8080
# 自分の API から書き出した気配の一覧（docs/data-sources.md 4 章のデータ形式）
DATA_SOURCE=quotes QUOTES_FILE=<気配の一覧の JSON> CALENDAR_FILE=../data/calendar/calendar.json uv run --locked flask --app simulator_api.app run -p 8080
# AI の中継（偽の送信先。鍵・GCP なし。応答は決まった文で、Anthropic を呼ばない）
AI_CREDENTIAL=fake DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json uv run --locked flask --app simulator_api.app run -p 8080
```

偽の送信先への要求の例（同じオリジンの `Origin` ヘッダが要る）:

```bash
curl -sN -X POST http://127.0.0.1:8080/api/ai/messages -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8080' \
  -d '{"schema_version":1,"kind":"chat","context":{"snapshot":{"snapshot_at":"2026-10-13T21:31:00+09:00","source":"synthetic","delayed_minutes":15}},"messages":[{"role":"user","content":[{"type":"text","text":"弱点は？"}]}]}'
curl -s http://127.0.0.1:8080/api/ai/status
```

画面は別の端末で `npm run dev`（Vite の `server.proxy` が `/api` を `127.0.0.1:8080` に渡す。同一オリジン）。本番は gunicorn（`simulator_api.app:app`、1 ワーカー・8 スレッド）。イメージはリポジトリ直下の `Dockerfile`（画面の `dist/` を同梱し `STATIC_DIR=/app/static`）、検査は `.github/scripts/image-check.sh`、Cloud Run の設定（環境変数 `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`）は `infra/prod/simulator.tf`、手順は `infra/README.md`「prod（Cloud Run simulator）」。

## テスト

```bash
cd api
uv run --locked ruff check
uv run --locked pytest -q
```

- 供給元のアダプタは `tests/test_sources.py`、中立の気配の一覧は `tests/test_quotes.py`（合成の板から作った一覧 → 板が元と一致・形式の規則・不正入力・`DATA_SOURCE=quotes` の応答。実際の API は呼ばない）
- BigQuery は偽の runner（`tests/support.py` の `FakeRunner`）。板は合成（`fixtures/synthetic/*.json` から作る round-trip と、判定用の小さな合成の板）
- 契約（AC25）: `OPTIONCHAN_SCHEMA_DIR=<optionchan の固定コミットの checkout>/schema uv run --locked pytest -q -rs tests/test_contract.py`（`schema/tokyo` と `schema/cm` を使う。`contract.py` の `schema_file` は `schema/` からの相対パス）。固定コミットは `contract/optionchan_commit.txt`（40 桁の SHA）。CI はリポジトリ変数 `OPTIONCHAN_REPO`（`<OWNER>/<REPO>`）があるときだけその SHA を sparse checkout して照合する（未設定なら notice を出してスキップ）
- SQL の dry run（課金 0。CI では動かさない）: `OPTIONCHAN_BQ_TEST=1 OPTIONCHAN_BQ_PROJECT=<PROJECT_ID> uv run --locked pytest -q -s tests/test_sql_bq.py`（ADC。見積もりが 512 MiB 以下（`atm_cm_iv`・`future_bars` は足ごとの最大の範囲で 64 MiB 以下、`atm_cm_daily` は全期間で 128 MiB 以下。2026-10-19 に約 61.9 MiB）で、結果の列・型が `contract.py`（集計するクエリは `OUTPUTS`）と一致）。ADC が無い手元では、`sql/*.sql` の `${project}`・`${dataset}` を埋めて `bq query --use_legacy_sql=false --dry_run --format=json --parameter=...` に標準入力で渡すと、`statistics.query.totalBytesProcessed` と `schema` で同じことを確かめられる

### 固定コミットの更新

optionchan の `schema/tokyo`・`schema/cm` が変わったら（列の追加・型の変更）、`contract/optionchan_commit.txt` を optionchan の新しいコミットの SHA にし、上の契約テストと dry run を手元で通してから PR にする。照合に落ちたら `contract.py`・`sql/*.sql`・`chain.py`・`atm_iv.py` を直す。上げる前に、今の固定コミットとの差（`gh api repos/<OWNER>/<REPO>/compare/<旧>...<新>` のファイル一覧）で、照合する JSON（`contract.py` の `schema_file`）が変わっていないかを見る。

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

ログは 1 行 1 件の JSON（`src/simulator_api/log.py`。`message` と `event` がイベント名）。`chain_served` の `cache` は `miss`（板を読んだ）/ `hit`、`board_reads` は板を読んだ回数。`elapsed_ms` は要求の始めから応答の組み立てまで（BigQuery の待ちを含む）。`bq_job`（`name`・`elapsed_ms`・`rows`・`total_bytes_processed`。課金量は下の監査ログで見る）も同じ形式で読める。ワーカーの起動時に BigQuery の Client を作る準備（ジョブは出さない）が終わると `bq_warm`（`elapsed_ms`）、失敗すると `bq_warm_failed`（`error_type` だけ。最初の要求で作り直す）。同じ `snapshot_at` の 2 回目のリクエストで `bq_job` が `latest_runs` だけなら、キャッシュが効いている。

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

IV 推移（`/api/atm_iv`。#79）のジョブだけを見るときは、`jq` の最初の `map(...)` の前に `map(select(.protoPayload.metadata.jobChange.job.jobConfig.queryConfig.query // "" | test("atm_cm_iv")))` を挟む（エラーの内訳は `.protoPayload.metadata.jobChange.job.jobStatus.errorResult.reason`。`bytesBilledLimitExceeded` が 64 MiB の上限）。目安は 1 ジョブの最大が 64 MiB 以下（通常は最小課金の 10 MiB。表が変わるまでの同じ要求は結果キャッシュで 0）。

先物推移（`/api/future_bars`。#190）のジョブは `test("traded_at")` で絞る（板の `/api/chain` も `future_price_latest` を読むが、`price_time` を `traded_at` にして集約するのは先物推移だけ）。目安は 1 ジョブ最小課金の 20 MiB（テーブル関数の中で表 2 本）・最大 64 MiB の上限の下（1d 400 日と前後の追加の読み込みで約 22 MiB）。アプリのログでは `jsonPayload.event = "future_bars_served"`（`tf`・`days`・`bars`・`cache`・`contract_mismatch` = 生の `contract_month` と求めた限月が違う足の数）と `bq_job` の `name = "future_bars"`。

`atm_cm_iv` の文字列は IV 推移と日次の値（`/api/atm_daily`。#152）の 2 つのクエリに当たるので、分けるときは `m1_forward` を含むか否かで絞る: IV 推移は `test("atm_cm_iv") and (test("m1_forward") | not)`、日次の値は `test("m1_forward")`。日次の値の目安は 1 ジョブ 約 62 MiB（全期間。1 年で約 8 MiB 増える）で 128 MiB の上限（`bytesBilledLimitExceeded`）の下、回数はインスタンスごと 1 日 1 回 + コールドスタートの回数（範囲の終わりごとのキャッシュ）。アプリのログでは `jsonPayload.event = "atm_daily_served"`（`end`・`days`・`cache`）と `bq_job` の `name = "atm_cm_daily"`（`total_bytes_processed`）。

目安: 1 日の課金量がプロジェクトの 1 日の上限 100 GiB の 10%（10 GiB）未満、1 ジョブの最大が 512 MiB（`MAX_BYTES_BILLED_LIMIT`）以下、`errors` が 0。課金量は 1 ジョブ 10 MiB の最小課金を含むので、処理量より大きめに出る（上限の判定では安全側）。`region-asia-northeast1.INFORMATION_SCHEMA.JOBS_BY_PROJECT` は 1 日に絞っても最小のスキャンが 512 MiB を超え、`--maximum_bytes_billed=536870912` の下では読めないので使わない。

## 本番の latency の確認（AC1）

2.2 の AC1（取引時間中に開くと 3 秒以内。コールドスタートを除く）を本番のログで判定する。コールドスタート = そのインスタンス（`labels.instanceId`）の `STARTUP HTTP probe succeeded` より前に受けた要求で、それ以外（インスタンスで 1 回目の要求を含む）はすべて数える。`/api/chain` のリクエストログ（200 / 304）を、同じインスタンスで受付から応答までの間に出た `chain_served` と組にして、`cache`（`miss` / `hit`）ごとに `httpRequest.latency` の中央値・p90 と `chain_served.elapsed_ms` の中央値を出す。出力は件数と秒だけ（URL・プロジェクトは出さない）:

```sh
P=$(gcloud config get-value project)
cat > /tmp/ac1.jq <<'JQ'
def ts: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
def frac: (capture("\\.(?<f>[0-9]+)Z$").f // "0") | ("0." + .) | tonumber;
def t: (.timestamp | ts) + (.timestamp | frac);
def pct(p): sort as $s | ($s | length) as $n | if $n == 0 then null else $s[(((p * $n) | ceil) - 1) | if . < 0 then 0 else . end] end;
def med: sort as $s | ($s | length) as $n | if $n == 0 then null elif $n % 2 == 1 then $s[($n - 1) / 2] else ($s[$n/2 - 1] + $s[$n/2]) / 2 end;
. as $all
| [ $all[] | select(.textPayload? // "" | test("STARTUP HTTP probe succeeded")) | {i: .labels.instanceId, t: t} ] as $probes
| [ $all[] | select(.jsonPayload.event? == "chain_served") | {i: .labels.instanceId, t: t, cache: .jsonPayload.cache, ms: .jsonPayload.elapsed_ms} ] as $served
| [ $all[] | select(.httpRequest? and (.httpRequest.status == 200 or .httpRequest.status == 304)) | {i: .labels.instanceId, t: t, lat: (.httpRequest.latency | rtrimstr("s") | tonumber)}
    | . as $r
    | ($probes | map(select(.i == $r.i)) | map(.t) | min) as $p
    | ($served | map(select(.i == $r.i and .t >= $r.t and .t <= $r.t + $r.lat + 1)) | first) as $s
    | $r + {cold: ($p == null or $r.t < $p), cache: ($s.cache // "unknown"), ms: $s.ms} ]
| map(select(.cold | not)) as $warm
| ["miss", "hit"][] as $c
| ($warm | map(select(.cache == $c))) as $g
| "\($c) n=\($g | length) median_s=\($g | map(.lat) | med) p90_s=\($g | map(.lat) | pct(0.9)) elapsed_ms_median=\($g | map(.ms // empty) | med)"
JQ
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND (httpRequest.requestUrl:"/api/chain" OR jsonPayload.event="chain_served" OR textPayload:"STARTUP HTTP probe succeeded")' \
  --project="$P" --freshness=3d --limit=5000 --format=json | jq -r -f /tmp/ac1.jq
```

- リクエストログの `timestamp` は受付の時刻。起動プローブのログが保持期間・`--freshness` の外にあるインスタンスの要求はコールドスタート扱い（判定から外れる側）になる
- 特定のリビジョンだけを見るときは、フィルタに `AND resource.labels.revision_name="<REVISION>"` を足す（`gcloud run services describe simulator --region=asia-northeast1 --project="$P" --format='value(status.latestReadyRevisionName)'`）
- 1 要求の BigQuery の内訳は、同じ取得に `OR jsonPayload.event="bq_job"` を足し、受付から `chain_served` までの同じインスタンスの `bq_job` を `name` ごとに数える（`latest_runs`・`future_price`・`option_price`・`spot_price` 各 1、カレンダーのキャッシュが無いときだけ `trading_calendar`。板の読み直しのある要求は候補ごとに `future_price` → `option_price`・`spot_price`）。`option_price` と `spot_price` は同時に走る（`bq_job` の時刻は終了、開始 = 終了 − `elapsed_ms`）

## AI の中継（#134）

設計は `docs/design.md` 7.1・13.4「AI の中継」・14 章、`docs/ai-advisor.md` 論点 1・3・4・6〜8、計上の置き場所は `docs/adr-0004-ai-spend-counter-firestore.md`、資格情報は `docs/adr-0001-ai-credentials-secret-manager.md`、送信経路は `docs/adr-0005-ai-oauth-via-agent-sdk.md`（#186）と `docs/adr-0006-ai-agent-sdk-only-and-skills.md`（#221。一本化とスキル）。

- **送信先**（`AI_CREDENTIAL` で選ぶ）: `oauth_token`・`api_key`・`wif` → `ai/agent_sdk.py` の `AgentSdkGateway`（`claude-agent-sdk` 0.2.160。wheel に同梱の Claude Code CLI 2.1.283 を要求ごとに子プロセスで起動する。#186・#221）、`fake` → `ai/gateway.py` の `FakeGateway`。どれも同じ事象（`thinking`・`text`・`tool_use`・`final`）を返すので、SSE の形式は資格情報によらない。Messages API を直接呼ぶ送信経路は無い（#221 で `anthropic` SDK を外した）
- **送信経路の決まり**（ADR-0005・ADR-0006）: ツールは SDK MCP のツール（CLI では `mcp__sim__<名>`）として見せ、`PreToolUse` フックで実行せずに turn を終える（ブラウザが計算する）。組み込みのツールは `Skill` だけ（`tools=["Skill"]`）、設定・CLAUDE.md を読まない（`setting_sources=[]`）、`@<パス>` をファイルとして読ませない（`verbatim_prompts=True`）、再試行しない（`CLAUDE_CODE_MAX_RETRIES=0`）、出力の上限は `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000`、1 要求で上流を呼ぶのは最大 `AI_MAX_TURNS`（3）回、設定ディレクトリと cwd は要求ごとの一時ディレクトリ（`/tmp`。終わったら消す）、CLI の標準エラーは捨てる。会話の履歴は要求ごとにメモリ上の transcript にして渡す（最後の発言がツールの結果のときは、CLI がその末尾に固定の短い文を 1 つ足す）。中止・締め切り・切断で子を止める。イメージは `CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK=1`（版は `uv.lock` で固定）。SDK の版を上げるときは `tests/test_ai_agent_sdk_cli.py` を必ず通し、ADR-0005・ADR-0006 の版を直す
- **子の資格情報**: CLI が資格情報・送信先の選択として読む変数（`agent_sdk.CREDENTIAL_ENV`）を全部空で上書きし、選んだ種類のものだけを入れる（`oauth_token` → `CLAUDE_CODE_OAUTH_TOKEN`、`api_key` → `ANTHROPIC_API_KEY`、`wif` → WIF の ID と `ANTHROPIC_IDENTITY_TOKEN`）。CLI は WIF の設定を他より優先するので、親の環境の値が子に見えないことが要る
- **文書**（`ai/docs.py`。#137・`docs/adr-0007-ai-docs-read-tool.md`）: マニュアル（`docs/user-guide.md` の全章）と設計書（`docs/design.md` の 3 章・5 章）を見出しで節に分け、目次（番号と見出し）を system の末尾に載せる。本文は **中継の中で実行するツール** `read_doc(file, section, part?)`（`mcp__docs__read_doc`。フックが allow）が要る節だけを返す（1 回 8 KiB・1 要求 16 KiB・6 回まで。7 回目はフックが deny + 要求を終える）。往復は SSE・`done` に出ない。文書の置き場所は `AI_DOCS_DIR`（イメージは `/app/docs`。未設定ならリポジトリの `docs/`）。読めなければ目次も `read_doc` も出さない（WARNING `ai_docs_unavailable`）
- **スキル**（`ai/skills.py`・`ai/plugin/`。#221）: 毎回は要らない手順を `ai/plugin/skills/<名前>/SKILL.md` に置き、モデルが要るときだけ CLI の `Skill` ツールで読む（今は `simulator:technicals`・`simulator:proposals`・`simulator:volatility`・`simulator:presets`（定型の質問。#140））。フックは一覧の名前の `Skill` だけ通す。`Skill` の tool_use は SSE・`done` に出ない（`done` の content は最後の message）。読んだ内容は次の要求に残らない（要れば読み直す）。**足し方**: `ai/plugin/skills/<名前>/SKILL.md` を作り（frontmatter は `name`（ディレクトリと同じ）・`description`（いつ読むか）だけ。本文は手順の文だけ。`allowed-tools`・`context`・`!` のコマンドの埋め込み・他のファイル・秘密を置かない。合計 16 KiB 以下）、`skills.NAMES` に名前を足し、`relay.SYSTEM_PROMPT` の「スキル」の節にいつ読むかを 1 行足す。約束は `tests/test_ai_skills.py` が検査し、wheel（= イメージ）に入ることも確かめる

- **許可リスト**（`ai/allowlist.py`）: ブラウザから受けるのは `schema_version`・`kind`・`context`・`messages` だけ（`model`・`system`・`tools`・`max_tokens` などは 400）。`context` のキー・型・範囲・個数を検査し（自由な文字列は無い。板の行は `k`・`type`・`bid`・`ask`・`iv` だけで、JPX のグリーク・`bid_iv` / `ask_iv`・数量・建玉は 400。保有の情報 `position.held`（true だけ）・`position.other_held`（整数 1〜200）・`position.legs[].opened_days`（整数 0〜10,000）は #302 で足した任意のキーで、無くても受ける）、`messages` は role の交互・block の型（user は `text`・`tool_result`、assistant は `text`・`thinking`・`redacted_thinking`・`tool_use`）・ツールの名前と入出力の形式（`ai/tools.py` の登録）を検査する。送る本文は検査済みの値から組み立て直す（`context` は最初の user の先頭の text block に `<context>…</context>` の決定的な JSON）
- **1 日の上限**（`ai/budget.py`）: 予約（µUSD の整数）は turn ごとの上界の和: turn 0 は E × w + M × o、turn i（1 ≤ i < T）は (E + (i−1)·g) × r（前の turn の要求全体 = キャッシュの読み出し）+ g × w + M × o（g = M + K、w = 書き込みの単価（5 分と 1 時間の大きい方）、r = 読み出しの単価、o = 出力の単価）。E = 入力の見積もり = 送る本文の UTF-8 のバイト数 + 2,000（見えない分）+ 4,000（CLI が足す Skill の定義・環境の message。実測 約 2.9 KB）、M = `max_tokens`、K = SKILL.md の合計のバイト数 + 1,000、T = `AI_MAX_TURNS`。前提は「前の turn の要求がキャッシュから読まれる」（CLI が最後の message に cache_control を付け、次の turn は前の要求をそのまま前置きに持つ = `tests/test_ai_agent_sdk_cli.py`）で、読めなかったとき（追い出し）だけ精算で予約を越えうる。目安（#140 の時点。スキルと文書の目次が増えると上がる）: 本文 25k トークンで 約 $1.36、90k で 約 $1.90（日の上限 $3 で日の始めに拒否されるのは本文 約 220k トークンから）。`計上額 + 予約額 ≤ 上限` のときだけ送り、終わったら `usage`（全 turn の合計）× 料金表で精算、途中で切れたら予約額のまま。計上の場所が読めない・書けないときは 503 で送らない
- **SSE**: `accepted`（検査と予約の直後、Anthropic を呼ぶ前）→ `progress`（`thinking` / `writing` / `tool`）・`thinking`・`text`・`tool_use` → `done`（`stop_reason`・assistant の `content`・`remaining_usd`）か `error`（`timeout`・`upstream_auth`・`upstream_rate_limited`・`upstream_overloaded`・`upstream_bad_request`・`upstream_unavailable`・`upstream_incomplete`・`bad_tool_input`）。締め切りは 50 秒
- **ツール**（`ai/tools.py`。#135）: `position_summary`・`tail_table`・`margin_summary`・`scenario_grid`・`smile_position`（入力なし。[このポジションを診断] ではブラウザが事前計算して `context.precomputed`）と `evaluate_scenario`（`dx_pct` か `x`・`days`・`iv_shift_pt`・任意の `skew_pt`。範囲は画面のシナリオの欄と同じ）、`technicals`（先物のテクニカル。#200・#206）、`iv_stats`（IV の過去の統計。#138・#158）、`strike_scan`・`structure_candidates`・`propose_position`（ポジションの提案。#139）、`strike_quote`（任意の行使価格のスマイルの IV・理論価格・気配。#266）の 12 本。中継はツールを実行せず、入力（`tool_use`）・結果（`tool_result`・`precomputed`）を形式で検査する。計算はブラウザの `ui/view/aiTools.ts` で、生成した見本 `fixtures/synthetic/ai_tools.json` を `tests/test_ai_tools.py` が結果の形式に通す（言語をまたぐ契約）
- **会話の途中の文脈の更新**（#135）: 2 件目以降の user の発言に `{"type": "context_update", "context": {…}}` を 1 つ（`tool_result` の後ろ）。`context` と同じ形式で検査し、`<context_update>…</context_update>` の text block にして同じ位置に置く。最初の `context` と前の messages は変えない（Opus 5.5 の preserved thinking・prompt caching の前置きを保つ）。`kind: "diagnose"` は [このポジションを診断]（system prompt は 1 つ。`relay.DIAGNOSE_TEXT` が最初の発言）。`kind: "preset"` は定型の質問のチップ（#140）で、`topic` は定型の ID（`allowlist.PRESET_TOPICS`: `crash`・`rebut`・`board`・`hedge`・`exit`・`iv`。必須。外れ・自由文・ほかの kind に付けたら 400）。発言は `relay.PRESET_PREFIX`（「［定型］」）で始まり、system prompt の案内でスキル `simulator:presets` を読む
- テストは偽の送信先（`ai/gateway.py` の `FakeGateway`）、偽の Firestore の session、送信経路の偽の `query`・偽の CLI（環境を記録する。`tests/test_ai_agent_sdk.py`）と、同梱の本物の CLI を pytest の中の 127.0.0.1 の偽の Messages API（`tests/fake_messages_api.py`。ダミーの資格情報。スキルの往復・`read_doc` の往復（#137）・turn の上限・turn ごとの usage・WIF の交換のエンドポイント `POST /v1/oauth/token` の脚本がある）に向けた結合（`tests/test_ai_agent_sdk_cli.py`・`tests/test_ai_secrets.py`。同梱の CLI が無いプラットフォームでは skip）。Anthropic・GCP には触れない

### 画像の読み取り（#318）

設計は `docs/design.md` 13.4「AI の中継」の「画像の読み取り」・14 章「画像から建玉を読み取る」、`docs/adr-0009-ai-image-read-positions.md`。

- `ai/read_positions.py`（純関数）: 要求の検査（`parse_read_request`。キーは `schema_version`・`image` だけ、`media_type` は PNG / JPEG、base64 の形・生のバイト数 1〜`AI_IMAGE_MAX_BYTES`・マジックバイトが `media_type` と一致・長辺 ≤ `AI_IMAGE_MAX_EDGE` を PNG の IHDR・JPEG の SOF から読む）、送る引数（`build_read_params`。`mode: "read"`・読み取りの指示 `READ_SYSTEM`・画像・決まった文 `READ_TEXT`・ツール `TOOL_DEFINITION`）、予約額（`read_estimate`・`read_reserve`。T = 1・K = 0・M = `AI_READ_MAX_TOKENS`、E に画像 1 枚の上界 `AI_IMAGE_MAX_TOKENS` を足し base64 は数えない）、結果の検査（`check_result`。知らないキー・自由な文字列・型の不正・行 > 20 は全体を捨てる = 502 `bad_result`、欄の範囲外はその欄だけ null）
- 送信先: `AgentSdkGateway` は `params["mode"] == "read"` のとき組み込みのツール・スキル・プラグインなし・`max_turns` 1。`FakeGateway` は読み取りの既定の台本（`report_positions` の tool_use。架空の値）を返す
- 上限は同梱の CLI が画像を作り直さずにバイトのまま上流へ渡す範囲（CLI 2.1.283 の観測: 長辺 ≤ 2,000 px・生 ≤ 約 512,000 B）の内側。`tests/test_ai_agent_sdk_cli.py` が境の内側のバイト一致・外側の作り直し・CLI が足す `[Image: source: …]` の文が 1 つだけ・要求の後に一時ファイルが残らないことを固定する（SDK の版を上げたら必ず通す）
- 子の環境の `CLAUDE_CODE_TMPDIR` は要求ごとの一時ディレクトリの中（全要求）。CLI は受けた画像をここに書くので、要求の後に一時ディレクトリごと消える
- 応答: 200 `{schema_version: 1, kind: "positions" | "not_positions", rows, remaining_usd}`、失敗は会話の事前の失敗と同じ JSON に 502 `bad_result` / `no_result` / `upstream_*`・504 `timeout`。text・thinking は返さない
- 手元: `AI_CREDENTIAL=fake` で `curl -s -X POST http://127.0.0.1:8080/api/ai/read_positions -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8080' -d "{\"schema_version\":1,\"image\":{\"media_type\":\"image/png\",\"data\":\"$(base64 -w0 <合成の PNG>)\"}}"`（実際の口座の画像は使わない）。テストは `tests/test_ai_read_positions.py`（画像はテストの中で `support.png_bytes`・`jpeg_bytes` で組む）

### ログ

| イベント | いつ | 項目 |
|---|---|---|
| `ai_request` | 1 要求 1 行（失敗も。失敗は WARNING） | `kind`・`topic`（[AI に聞く] の場所・定型の ID。列挙の値だけ。#136・#140）・`profile_chars`（自分の前提の字数。本文は出さない。#156）・`model`・`credential`（種類だけ）・`n_messages`・`request_bytes`・`est_input_tokens`・`reserved_usd`・`accepted_ms`・`first_delta_ms`（最初の thinking / text）・`first_text_ms`（最初の text。K15 の「最初の文字」）・`total_ms`・`stop_reason`・`tools`（会話に出たツールの名前）・`input_tokens`・`cache_creation_input_tokens`・`cache_read_input_tokens`・`output_tokens`・`cost_usd_est`（料金表の概算。`oauth_token` も）・`charged_usd`（計上額。`oauth_token` は 0）・`price_checked`・`remaining_usd`・`error`・`error_type`（例外の型名）・`upstream_status`・`spawn_ms`（送信の開始 → CLI の最初の事象。子の起動・CLI の初期化・上流の応答の始まりを含む）・`skills`（読んだスキルの名前。本文は出さない）・`turns`（上流の message の数。Skill を読むと 2 以上）・`docs`（`read_doc` が返した節 `<file>:<番号>`、part 2 以上は `#<part>`。本文は出さない。#137） |
| `ai_request`（`kind=read_positions`。#318） | 画像の読み取り 1 要求 1 行 | `model`・`credential`・`request_bytes`・`media_type`・`image_bytes`・`width`・`height`・`est_input_tokens`・`reserved_usd`・usage 4 種・`cost_usd_est`・`charged_usd`・`result_kind`・`rows`（行の数）・`stop_reason`・`error`・`result_path` / `result_reason`（結果の検査で捨てたときのキーの道筋と理由。値は出さない）・`total_ms`・`spawn_ms`・`turns`。画像・base64・結果の値・text・thinking は出さない |
| `ai_rejected` | ストリームの前の拒否（400 / 403 / 413 / 415 / 429 / 503 `ai_disabled`） | `status`・`error`・`reason`・`path`（キーのパス。知らないキーは `<unknown>`。値は出さない） |
| `ai_disabled` | 起動時に設定が不正（WARNING） | `reason`（`ai_credential_conflict`・`ai_credential_missing`・`ai_wif_invalid` など） |
| `ai_sdk_warning` | SDK（logger `claude_agent_sdk`）の WARNING 以上（WARNING） | `logger`・`level`・`error_type`・`upstream_status`（SDK の文言は上流のメッセージ・CLI の出力を含みうるので出さない。SDK のログは stderr にも流さない） |
| `ai_status_unavailable` / `ai_settle_failed` | 計上が読めない / 精算が書けない（WARNING） | `error_type` |

出さないもの: 会話の本文・`context` の値・ツールの入出力・鍵・SDK の例外の本文・IAP のヘッダ・WIF の ID トークン・交換したトークン・WIF の ID の値。

`wif` の失敗: 交換（CLI の `POST /v1/oauth/token`）の 401 / 403 は `upstream_auth`（`error_type` `token_exchange`・`upstream_status` に状態。多くはルールの不一致）、ID トークンが取れないときも `upstream_auth`（`error_type` `IdentityTokenError`。子を起動しない）、交換のその他の失敗は `upstream_unavailable`。ID トークンは要求ごとに中継がメタデータサーバーから取り直し、交換したトークンは要求の間で持たない（1 要求 1 回の交換）。上限の turn を超えたら `upstream_unavailable`（`error_type` `result:error_max_turns`）。

24 時間の `first_text_ms` の p50（終了条件 6。押すボタンができる #135 の後に判定する）:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND jsonPayload.event="ai_request" AND jsonPayload.first_text_ms>=0' \
  --project="$P" --freshness=24h --format=json \
  | jq '[.[].jsonPayload.first_text_ms] | sort | if length == 0 then null else .[length/2|floor] end'
```

### デプロイ後の確認（AC11・AC12）

- 未認証で `/api/ai/status` と `POST /api/ai/messages` が 302 / 401 / 403（IAP）。URL は表示・記録しない: `U=$(gcloud run services describe simulator --region=asia-northeast1 --project="$P" --format='value(status.url)'); for m in GET POST; do curl -s -o /dev/null -w "$m %{http_code}\n" -X $m "$U/api/ai/$([ $m = GET ] && echo status || echo messages)"; done; unset U`
- デプロイ後 10 分の ERROR が 0 件（`infra/README.md` の prod の「確認」と同じ）
- `AI_CREDENTIAL` が未設定のまま、ブラウザ（IAP のログイン済み）で `/api/ai/status` を開くと `"enabled":false`
- 有効にした後の 1 回（オーナー）: 画面ができる前は、ブラウザの開発者ツールのコンソール（同じオリジン）で `fetch('/api/ai/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({schema_version:1,kind:'chat',context:{snapshot:{snapshot_at:new Date().toISOString(),source:'bigquery',delayed_minutes:15}},messages:[{role:'user',content:[{type:'text',text:'こんにちは'}]}]})}).then(r=>r.text()).then(console.log)` を 1 回送り、`event: done` が届くこと。続けてログで `ai_request` に `first_text_ms` とトークン量が出て、鍵の形式に一致する文字列が 0 件であること:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND jsonPayload.event="ai_request"' \
  --project="$P" --freshness=1h --format=json \
  | jq -c '.[].jsonPayload | {credential, first_text_ms, input_tokens, output_tokens, cost_usd_est, charged_usd, error}'
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator"' --project="$P" --freshness=1h --format=json \
  | grep -cE 'sk-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}'   # 0
```

`api_key` のときは `infra/README.md`「AI の費用の計上（Firestore）」の 4 で今日の計上が増えたことも確かめる。

`oauth_token` のとき（#186 AC9〜AC12）: `/api/ai/status` が `"credential":"oauth_token","counted":false`。画面で [このポジションを診断] を 1 回、続けてツールを使う質問を 1 回押し、ログで `stop_reason` が `end_turn`（と `tool_use` の後の `end_turn`）・`error` が null・`spawn_ms` ≤ 10,000・`first_delta_ms` ≤ 30,000 を確かめる。`error` が `upstream_auth` / `upstream_rate_limited` なら `infra/README.md` の手順で `wif` に戻す:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND jsonPayload.event="ai_request" AND jsonPayload.credential="oauth_token"' \
  --project="$P" --freshness=15m --format=json \
  | jq -c '.[].jsonPayload | {kind, stop_reason, error, upstream_status, spawn_ms, first_delta_ms, first_text_ms, total_ms}'
```

[AI に聞く]（#136）の聞かれた場所の集計（場所の ID だけ。質問の文・値はログに無い。分かりにくい所を直す材料）:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND jsonPayload.event="ai_request" AND jsonPayload.kind="ask"' \
  --project="$P" --freshness=30d --format=json \
  | jq -r '.[].jsonPayload.topic' | sort | uniq -c | sort -rn
```

定型の質問（#140）の使われ方も同じ方法で集計する（`jsonPayload.kind="preset"`。`topic` は定型の ID）。

## AI の評価（#135）

`npm run ai:eval`（`scripts/aiEval.mjs`）は、合成の板・合成のポジション 10 通り（`scripts/aiEvalCases.ts`）で、画面と同じコード（文脈と事前計算・会話の reducer・ツールの往復）を通して中継に送り、[このポジションを診断] の返答の弱点の数と数字の照合（`ui/view/aiNumbers.ts`）を出す。送り先は手元で起動した中継（`AI_EVAL_BASE`、既定 `http://127.0.0.1:8080`）で、本番の IAP は越えない。資格情報は中継の環境変数だけ（スクリプトは読まない・出さない）。

```bash
# 1) 中継を本物の資格情報で起動（値は表示しない。ログは fixtures/local/ に）
cd api && AI_CREDENTIAL=<種類> <資格情報の環境変数>=… DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json \
  uv run --locked flask --app simulator_api.app run -p 8080 > ../fixtures/local/ai_eval/relay.log 2>&1 &
# 2) 評価（10 通り + 追加の質問 2 件。--cases a,b・--repeat n・--no-followups）
AI_EVAL_RELAY_LOG=fixtures/local/ai_eval/relay.log npm run ai:eval
```

- 費用の上限: 累計の台帳 `fixtures/local/ai_eval/ledger.json`（gitignore）で `AI_EVAL_LIMIT_USD`（既定 6.5）を超える前に止める。数える資格情報は今日の残りの差、数えない資格情報（`oauth_token`）は 0。`AI_CREDENTIAL=fake` は配線の確かめ用で台帳に入れない
- 出力: 標準出力に要約（各組の弱点の数・各弱点の一致の数・不一致の一覧・`stop_reason`・最初の文字と完了の秒・費用）と、`AI_EVAL_RELAY_LOG` があれば `ai_request` のトークン量・概算費用・`dropped_blocks`・`first_text_ms` の中央値。返答の全文は `fixtures/local/ai_eval/<時刻>/` にだけ書く（コミットしない）
- 合格: 全組で弱点 3 つ以上・各弱点に照合が一致した数字 1 つ以上・不一致 0（終了コード 0）
- テクニカルの質問 3 件（#200。`--tech-only` で これだけ）: 合成の先物の足（`scripts/synthFutBars.ts`）をツールの環境に入れ、`technicals` を呼ぶ・不一致 0・方向の断定の言い回し（`DIRECTION_RE`）なしで合格。全文を目でも読む
- IV の統計の質問 3 件（#138・#158。`--iv-only` でこれだけ）: 合成の日次の値と今の IV（dev の `/fixtures/atm_daily`・`/fixtures/atm_iv` と同じ。架空の値）をツールの環境に入れ、`iv_stats` を呼ぶ・不一致 0・IV の上げ下げの断定の言い回し（`DIRECTION_RE`）なし・聞いたこと（分位 / β / HV）に触れるで合格
- 行使価格の理論価格の質問 2 件（#266。`--quote-only` でこれだけ）: 文脈のスマイルの 11 点の外の遠い OTM（合成の板の架空の行使価格）の妥当な値段を聞き、`strike_quote` を呼ぶ・聞いたこと（理論 / 妥当・IV）に触れる・一致 1 以上・不一致 0 で合格
- [AI に聞く] 5 件（#136。`--ask-only` で これだけ）: 画面と同じ表示モデル（`metricsPanel`・`bigReadout`・`ivReadout`）から質問の文を作り、`kind: "ask"` と場所の `topic` で送る（タイル 2・読み取り 1・テール表 1・IV 推移 1。IV 推移の足は架空の値）。節を示す（`CITE_RE`）・経緯を書かない（`HISTORY_RE`）・`AI_EVAL_RELAY_LOG` があれば想定の節（`ASK_DOCS` のどれか）を `read_doc` で読んだこと・`ai_request` の `kind` / `topic`・照合の不一致 0 で合格（照合の出所は画面と同じ = 質問に入れた表示の値とシナリオの β の代表の点（−3%・−6%・−10%）の上乗せ β × g（pt）を含む）
- 定型の質問 7 件（#140。`--preset-only` でこれだけ。6 つ + 足 0 本の板の前提）: 画面のチップと同じ文（`ui/view/aiPresets.ts`）を `kind: "preset"` と定型の ID で送る（崩れ方・反論・板の前提・ヘッジ案・出口・IV の位置。IV の統計を使う問はツールの環境に合成の日次の値）。想定のツールを呼ぶ（崩れ方・出口 = `evaluate_scenario`、反論 = `structure_candidates` か `evaluate_scenario`、板の前提・IV = `iv_stats`、ヘッジ案 = `propose_position`。precomputed のツールは呼んだに数えない）・照合の一致 1 以上と不一致 0・`AI_EVAL_RELAY_LOG` があれば `ai_request` の `kind` / `topic`・[反論] は「## 反論 1〜3」・[出口] は「## 利確の候補」「## 損切りの候補」・[板の前提]・[IV] は IV の上げ下げ（`DIRECTION_RE`）と売り時（`SELL_CALL_RE`）を断定しない・[ヘッジ案] は通った提案のカード（今のタブ）が 1 つ以上で合格
- 自分の前提つきの質問 2 件（#156。`--profile-only` でこれだけ）: 文脈の `profile` に架空の前提を入れて送る。前提の方針が答えに出る（言い回しの検査）・照合の不一致 0（前提の文の数は照合の出所）・前提の金額をツールの入力に使わない、で合格
- 文書の質問 15 件（#137・#240・#308。`--docs-only` で これだけ。問は `scripts/aiEvalDocs.ts`）: 計算の前提 11（β と Δσ・急落のプリセット、30 日固定の ATM IV、証拠金の概算、IV の動き方（sticky strike / moneyness）、テール表の倍率、アンカー IV、残存期間、basis と折れ点、グリークの単位、合成先物 F、β の実測とシナリオの β の違い）・操作の案内 3・文書に無いこと 1。節を示す（`CITE_RE`。「マニュアル 8.5」の形式）・Issue 番号と決定の記号を書かない（`HISTORY_RE`）・無いことは無いと言う（`ABSENT_RE`）で合格。`AI_EVAL_RELAY_LOG` があれば `ai_request` の `docs` で `read_doc` を読んだこと・想定の節（どれか 1 つ）を読んだことも判定する。文書の数は照合できない数字になるので不一致は数えるが失敗にしない。各問は想定の節（`expect`）と答えの要点（`points`）を持ち、返答の全文ファイル `docs-<n>-<id>.md` に並べて書く。内容が節と矛盾しないかは自動では判定しないので、このファイルで見比べる（想定の節が `read_doc` の索引にあることは `tests/test_ai_docs.py` が確かめる）
- 前回との差（#240）: どのモードでも、要約の後に **同じモードの前回の実行** と比べた差（正答 = pass の件数、数値の一致 / 不一致の件数、問ごとの pass → FAIL・FAIL → pass、新しい問 / 無くなった問）を出す。前回が無ければ「前回なし」。モードは問の組を変える引数から作る文字列（`docs`・`tech+iv`・`saved`・`all`、`--*-only` が無いときは `all cases=… repeat=… no-followups` のように診断の組の引数も入れる）で、`summary.json` の `mode` に残す。前回 = `fixtures/local/ai_eval/<時刻>/summary.json` のうち今回より前で `mode` が同じ、かつ偽の送信先（`AI_CREDENTIAL=fake`）かどうかが同じものの最新（`summary.previous` に名前を残す）。`mode` の無い古い summary とは比べない。数値の一致は各問の照合の一致の数の合計、不一致は `unmatched_total` と同じ（文書の問を除く）。計算は `scripts/aiEvalDiff.ts`。問の名前は各行の `id`（`docs:<id>`・`ask:<id>`・`preset:<id>` など。問の組は `scripts/aiEvalQuestions.ts`・`scripts/aiEvalDocs.ts`）で、同じポジションの問が複数あっても取り違えない
- 中継の 1 分の上限（`429 rate_limited`。`AI_RATE_PER_MINUTE`）に当たった問は、`Retry-After`（無ければ 30 秒）待って同じ要求を送り直す（1 要求 3 回まで。`scripts/aiEvalRetry.ts`）。それでも断られたらその問は FAIL で、行の理由に `rate_limited` と出る（前回との差で見かけの pass → FAIL になるので、その問は流し直す）

### 間違えた会話を評価に残す（#159）

AI が数字を間違えた・的外れだった会話を、試験問題として手元に残し、モデル・プロンプトを変えるたびに送り直して悪くなっていないかを確かめる。

1. 画面の AI のチャットで、その返答の行の末尾の小さな **[評価に残す]** を押す。メモ（任意。何が違ったか）を書いて OK を押すと、その返答までの会話が `ai-eval-<日時>.json` としてダウンロードされる（サーバーには送らない・保存しない）。中身は送った文脈・作り直しの材料（読み込んだ板・作業中のタブのポジションと設定・取引カレンダー・証拠金の設定・自分の前提・会話で使ったときだけ先物の足 / IV の日次の値。どれもその発言を送ったときの値）・発言の列・会話・その返答と照合の結果・メモ
2. ダウンロードしたファイルを `fixtures/local/ai_eval/cases/` に置く。**実際の板を含むのでコミットしない**（`fixtures/local/` は gitignore）
3. 中継を起動して（上の 1)）`npm run ai:eval -- --saved`。置いた会話をすべて、ファイルの材料で作り直した同じ文脈で、新しい会話として発言の列を順に送り直す。件ごとに発言の数・文脈が保存のときと同じか（違うのは画面・計算のコードが変わったとき。送りはする）・呼んだツール・照合の一致と不一致（と保存のときの不一致の数）・往復・エラー・メモを出し、要約に `saved: {pass, total}`。期待の答えは持たず、**エラー 0・最後の返答の不一致 0 で合格**。保存のときと今の返答の全文は `fixtures/local/ai_eval/<時刻>/saved-<ファイル名>.md`

- 作り直しの材料は、その返答の発言を送ったときに画面が記録しておいたもの（会話の後にポジション・シナリオ・板を変えても同じ文脈。記録はメモリだけなので、再読み込みで戻した会話だけは押した時点の画面から作る）
- [評価に残す] は 1 回の返答（ツールの往復を終えた最後の答え）に 1 つ。残せないとき（板が無い など）は AI のパネルの足元に理由が出る
- 会話を開き直した（タブを閉じずに再読み込みした）後に押すと、[AI に聞く] の質問は場所の情報が無く、ふつうの質問として送り直す

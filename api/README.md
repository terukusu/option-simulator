# api（板・カレンダー・IV 推移の JSON を返す Flask）

optionchan の BigQuery（データセット `optionchan_tokyo` のテーブル関数 4 本とビュー `trading_calendar_latest`、表 `atm_cm_iv`）を **読むだけ** の API。計算（F・補間・ATM）はブラウザの `model/` で行う。設計は `docs/design.md` の 7.1〜7.3・7.5・8.3。供給元は `DATA_SOURCE` で差し替えられる（下の設定。供給元の口・板の契約・中立の気配の一覧は `docs/data-sources.md`。#154）。

| エンドポイント | 内容 |
|---|---|
| `GET /api/chain` | 使える最新の板（7.2）を JSON 版 1（`data/chainTypes.ts`）で。`reason` = `latest` / `pre_open` / `after_close` / `closed`。`?at=` は後段（400） |
| `GET /api/calendar` | 取引カレンダーの最新版 `{schema_version, source, version_at, covered_until, listed_until, days: [{date, is_trading_day, status, name}]}`（日付の昇順）。画面は本番で開いたときと [最新] で読む（取れなければ同梱の版。#39） |
| `GET /api/atm_iv?tf=<1m\|1h\|1d>[&start=<ISO>&end=<ISO>]` | IV 推移（#79）: 表 `atm_cm_iv` の `iv30`（30 日固定の ATM IV、%）の足 `{schema_version, tf, start, end, last_at, bars: [{t, o, h, l, c}]}`。`start`・`end` は両方か無し（無ければ右端の 1 回分）、オフセット付きの ISO 8601 で UTC の 0 時ちょうど。1 回の最大は 1m 3 日・1h 100 日・1d 400 日。不正は 400、BigQuery の失敗・`DATA_SOURCE=file` は 503。仕様は `docs/design.md` 7.1・13.4 |
| `GET /api/atm_daily` | 日次の値（#152）: 表 `atm_cm_iv` の JST の日付ごとの日中の終値（JST 9:00〜15:00 の最後の行）の `iv30` と 1 / 2 限月のフォワード・最終取引日 `{schema_version, start, end, days: [{d, t, iv, f1, l1, f2, l2}]}`。パラメータなし（知らないパラメータは無視）。確定した日だけ（`end` = JST の今日（8:00 以降）/ 前日、含まない）。`Cache-Control: private, max-age=3600`・ETag で 304。BigQuery の失敗・`DATA_SOURCE=file` は 503。2 営業日の組はブラウザ（`data/atmDaily.ts`）。仕様は `docs/design.md` 7.1・13.4 |
| `GET /healthz` | 設定の読み込みだけ（BigQuery に触れない） |
| `/`・`/assets/<path>` | `STATIC_DIR` があるときだけ、Vite のビルド成果物（`dist/`）を配る |
| `/manifest.webmanifest`・`/favicon.svg`・`/apple-touch-icon.png`・`/icon-192.png`・`/icon-512.png` | `STATIC_DIR` があるときだけ、`dist/` 直下のこの 5 つの名前だけを配る（`no-cache`。名前の集合は `app.py` の `ROOT_FILES`。他の名前は 404。#90） |

作り（`src/simulator_api/`）: `sources.py`（供給元の口 `DataSource` と `DATA_SOURCE` → 実装の表 `BUILDERS`）、`quotes.py`（中立の気配の一覧 → 板の JSON 版 1。純関数。#154）、`usable.py`（使える板の判定。純関数。定数は `settings.py` の上部）、`chain.py`（板の JSON の組み立て）、`calendar.py`（SQ 日の規則と `/api/calendar` の JSON）、`atm_iv.py`（IV 推移の要求の検査・足の束ね・JSON。純関数）、`atm_daily.py`（日次の値の確定した範囲・行の検査・JSON。純関数。#152）、`cache.py`（TTL・LRU・期限付きの LRU と single-flight）、`service.py`（BigQuery の読み方とキャッシュ、`file`・`quotes` の供給元）、`bq.py`（SQL の読み込みと実行）、`contract.py`（optionchan との契約 = 使う列と型）、`sql/*.sql`、`app.py`（Flask・セキュリティヘッダ）、`log.py`（JSON の構造化ログ）。

## 設定（環境変数）

| 名前 | 既定 | 意味 |
|---|---|---|
| `DATA_SOURCE` | `bigquery` | `bigquery` / `file` / `quotes`。`file` は `CHAIN_FILE` の JSON をそのまま `/api/chain` で返す（GCP なしで動かす用。`/api/calendar` は 503 で、画面は同梱の取引カレンダーを使う）。`quotes` は `QUOTES_FILE` の中立の気配の一覧と `CALENDAR_FILE` から板を組み立てる（`/api/calendar` は `CALENDAR_FILE`。`/api/atm_iv`・`/api/atm_daily` は 503。形は `docs/data-sources.md` 4 章） |
| `GCP_PROJECT` | なし（`bigquery` のとき必須） | BigQuery のプロジェクト ID |
| `BQ_DATASET` | `optionchan_tokyo` | データセット |
| `BQ_LOCATION` | `asia-northeast1` | ロケーション |
| `MAX_BYTES_BILLED` | `536870912` | 1 ジョブのクエリ量の上限（バイト。1〜512 MiB。超える値は起動時にエラー）。`atm_cm_iv` のジョブはこれと 64 MiB、`atm_cm_daily` のジョブはこれと 128 MiB の小さい方（`settings.QUERY_MAX_BYTES_BILLED`） |
| `CHAIN_FILE` | なし | `DATA_SOURCE=file` の板の JSON |
| `QUOTES_FILE` | なし | `DATA_SOURCE=quotes` の気配の一覧（要求ごとに読む。書き換えれば [最新] で新しい板） |
| `CALENDAR_FILE` | なし | `DATA_SOURCE=quotes` の取引カレンダー（`/api/calendar` と同じ形。同梱の `../data/calendar/calendar.json` を指せる） |
| `STATIC_DIR` | なし | 静的ファイルのディレクトリ（`index.html`・`assets/`・直下の manifest とアイコン） |

実値（プロジェクト ID など）はリポジトリに書かない。

## 手元で動かす

```bash
cd api
uv sync --locked --python 3.13      # uv は 0.12.19（CI と同じ）
# BigQuery（ADC: gcloud auth application-default login）。読み取りのみ。板 1 回は約 152 MiB を読むので数回まで
GCP_PROJECT=<PROJECT_ID> uv run --locked flask --app simulator_api.app run -p 8080
# GCP なし
DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json uv run --locked flask --app simulator_api.app run -p 8080
# 自分の API から書き出した気配の一覧（docs/data-sources.md 4 章の形）
DATA_SOURCE=quotes QUOTES_FILE=<気配の一覧の JSON> CALENDAR_FILE=../data/calendar/calendar.json uv run --locked flask --app simulator_api.app run -p 8080
```

画面は別の端末で `npm run dev`（Vite の `server.proxy` が `/api` を `127.0.0.1:8080` に渡す。同一オリジン）。本番は gunicorn（`simulator_api.app:app`、1 ワーカー・8 スレッド）。イメージはリポジトリ直下の `Dockerfile`（画面の `dist/` を同梱し `STATIC_DIR=/app/static`）、検査は `.github/scripts/image-check.sh`、Cloud Run の設定（環境変数 `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`）は `infra/prod/simulator.tf`、手順は `infra/README.md`「prod（Cloud Run simulator）」。

## テスト

```bash
cd api
uv run --locked ruff check
uv run --locked pytest -q
```

- 供給元の口は `tests/test_sources.py`、中立の気配の一覧は `tests/test_quotes.py`（合成の板から作った一覧 → 板が元と一致・形の規則・不正入力・`DATA_SOURCE=quotes` の応答。実際の API は呼ばない）
- BigQuery は偽の runner（`tests/support.py` の `FakeRunner`）。板は合成（`fixtures/synthetic/*.json` から作る round-trip と、判定用の小さな合成の板）
- 契約（AC25）: `OPTIONCHAN_SCHEMA_DIR=<optionchan の固定コミットの checkout>/schema uv run --locked pytest -q -rs tests/test_contract.py`（`schema/tokyo` と `schema/cm` を使う。`contract.py` の `schema_file` は `schema/` からの相対パス）。固定コミットは `contract/optionchan_commit.txt`（40 桁の SHA）。CI はリポジトリ変数 `OPTIONCHAN_REPO`（`<OWNER>/<REPO>`）があるときだけその SHA を sparse checkout して照合する（未設定なら notice を出してスキップ）
- SQL の dry run（課金 0。CI では動かさない）: `OPTIONCHAN_BQ_TEST=1 OPTIONCHAN_BQ_PROJECT=<PROJECT_ID> uv run --locked pytest -q -s tests/test_sql_bq.py`（ADC。見積もりが 512 MiB 以下（`atm_cm_iv` は足ごとの最大の範囲で 64 MiB 以下、`atm_cm_daily` は全期間で 128 MiB 以下。2026-10-19 に約 61.9 MiB）で、結果の列・型が `contract.py`（集計するクエリは `OUTPUTS`）と一致）。ADC が無い手元では、`sql/*.sql` の `${project}`・`${dataset}` を埋めて `bq query --use_legacy_sql=false --dry_run --format=json --parameter=...` に標準入力で渡すと、`statistics.query.totalBytesProcessed` と `schema` で同じことを確かめられる

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

ログは 1 行 1 件の JSON（`src/simulator_api/log.py`。`message` と `event` がイベント名）。`chain_served` の `cache` は `miss`（板を読んだ）/ `hit`、`board_reads` は板を読んだ回数。`elapsed_ms` は要求の始めから応答の組み立てまで（BigQuery の待ちを含む）。`bq_job`（`name`・`elapsed_ms`・`rows`・`total_bytes_processed`。課金量は下の監査ログで見る）も同じ形で読める。ワーカーの起動時に BigQuery の Client を作る準備（ジョブは出さない）が終わると `bq_warm`（`elapsed_ms`）、失敗すると `bq_warm_failed`（`error_type` だけ。最初の要求で作り直す）。同じ `snapshot_at` の 2 回目のリクエストで `bq_job` が `latest_runs` だけなら、キャッシュが効いている。

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

`atm_cm_iv` の文字列は IV 推移と日次の値（`/api/atm_daily`。#152）の 2 つのクエリに当たるので、分けるときは `m1_forward` を含むか否かで絞る: IV 推移は `test("atm_cm_iv") and (test("m1_forward") | not)`、日次の値は `test("m1_forward")`。日次の値の目安は 1 ジョブ 約 62 MiB（全期間。1 年で約 8 MiB 増える）で 128 MiB の上限（`bytesBilledLimitExceeded`）の下、回数はインスタンスごと 1 日 1 回 + コールドスタートの回数（範囲の終わりごとのキャッシュ）。アプリのログでは `jsonPayload.event = "atm_daily_served"`（`end`・`days`・`cache`）と `bq_job` の `name = "atm_cm_daily"`（`total_bytes_processed`）。

目安: 1 日の課金量がプロジェクトの 1 日の上限 32 GiB の 10%（3.2 GiB）未満、1 ジョブの最大が 512 MiB（`MAX_BYTES_BILLED_LIMIT`）以下、`errors` が 0。課金量は 1 ジョブ 10 MiB の最小課金を含むので、処理量より大きめに出る（上限の判定では安全側）。`region-asia-northeast1.INFORMATION_SCHEMA.JOBS_BY_PROJECT` は 1 日に絞っても最小のスキャンが 512 MiB を超え、`--maximum_bytes_billed=536870912` の下では読めないので使わない。

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

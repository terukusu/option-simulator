# AI アドバイザーの土台の設計（#132）

EPIC #141（AI アドバイザー）の 1 本目の spike。後続の #133（鍵）・#134（中継）・#135（チャットと [このポジションを診断]）以降が前提にする土台の論点ごとに、選択肢・トレードオフ・推奨を並べる。**決めるのはオーナー**（EPIC #141「前提と制約」の (a)〜(d)）。この文書の「推奨」は推奨であって決定ではなく、各論点の「オーナー判断」は答えが出るまで「未決」のままにする。

本文の価格・ポジション・トークン数・費用の数値例はすべて **架空の値か合成の値**（合成の板 `fixtures/synthetic/` と架空のポジションから作ったもの）で、JPX 由来の実データは写していない。外部の事実（料金・モデル ID・機能・データの保持）の **確認日はすべて 2026-10-19**。リポジトリと本番の観測も同じ日（本番は読み取りだけ。ID・URL は記録しない）。

用語: **ツール**（tool use）= AI が名前と引数を指定して呼び、こちらが計算した結果を返す関数。**中継** = ブラウザと Anthropic API の間に立つ simulator の API（鍵をブラウザに出さないため）。**TTFT**（time to first token）= 要求を送ってから最初の文字が届くまでの時間。**prompt caching** = 要求の前置き（system・ツールの定義など）を Anthropic 側に一時的に置き、次の要求で安く速く読む仕組み。

## 1. 前提（現状の観測）

| 項目 | 観測（2026-10-19、origin/main と本番の読み取り） |
|---|---|
| AI の口 | リポジトリ（docs・.claude を除く）に `anthropic` を含むファイルは 0。API のルートは `/healthz`・`/api/chain`・`/api/calendar`・`/api/atm_iv` と静的ファイルだけ |
| CSP | `api/src/simulator_api/app.py`: `default-src 'none'; script-src 'self'; … connect-src 'self'; …`。ブラウザから外部の API を直接呼べない（呼ぶなら同じオリジンの中継を通す） |
| 計算の場所 | 価格モデル `model/` はブラウザの TypeScript の純関数。API は Python（Flask / gunicorn）で板を返すだけ（design.md 8.2） |
| Cloud Run `simulator` | `infra/prod/simulator.tf`: タイムアウト 60s、同時実行 8（`max_instance_request_concurrency`）、最大 2 インスタンス・最小 0、CPU 1・512Mi、`cpu_idle = true`（CPU は要求を処理している間だけ）、第 1 世代。env は `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION` だけ。本番の describe（読み取り）でもタイムアウト 60・同時実行 8・最大 2 で一致 |
| gunicorn | `Dockerfile`: `--workers 1 --threads 8 --timeout 60`。ストリーミングの応答 1 本は、終わるまでスレッドを 1 本ふさぐ |
| IaC の分け方 | `infra/bootstrap` は所有者が手元で apply。apply SA の権限は `run.admin`（プロジェクト）・state の objectUser・実行 SA の serviceAccountUser など（`infra/bootstrap/iam.tf`）。Secret Manager・Service Usage の権限は無い。`infra/prod` は CI が Environment `prod` の承認後に apply |
| API の有効化 | どちらのスタックにも `google_project_service` は無い（付録 B「simulator 側では宣言しない（optionchan の bootstrap が有効化済み）」）。`gcloud services list --enabled`（読み取り）で **Secret Manager の API は無効**。Cloud Run・IAP・BigQuery・Firestore・Datastore は有効 |
| Firestore | プロジェクトに `(default)` の DB が Datastore モード・asia-northeast1 で 1 つある（用途は未確認。optionchan 側で使っている可能性がある） |
| Python の依存 | `api/pyproject.toml`: flask・gunicorn・google-cloud-bigquery。`exclude-newer = "2026-09-28T00:00:00Z"`。`uv.lock` には requests・google-auth・opentelemetry-api・typing-extensions がある（httpx 系・pydantic・anyio は無い） |
| 文書の大きさ | origin/main 6d29df8 の時点で `docs/design.md` 135,499 文字（ASCII 66,186 / 非 ASCII 69,313）、`docs/user-guide.md` 46,162 文字（ASCII 14,912 / 非 ASCII 31,250）。`python3` で文字を数えた（`wc -c` はバイト数で、日本語は 1 文字 3 バイト） |
| 合成の板 | `fixtures/synthetic/latest.json`: `source: synthetic`、F 67,880（合成）、限月 2026-11（201 行）・2026-12（203 行）、K 30,000〜90,000（合成） |

## 2. 調べた事実（出典と確認日）

料金は USD / 100 万トークン。モデル ID は公式の文字列そのまま（日付の接尾辞なし）。

| # | 事実 | 出典 | 確認日 |
|---|---|---|---|
| F1 | 料金（基本入力 / 5 分キャッシュの書き込み / 1 時間キャッシュの書き込み / キャッシュの読み取り / 出力）: `claude-opus-5-5` 4 / 5 / 8 / 0.20 / 20、`claude-sonnet-5-5` 2 / 2.50 / 4 / 0.10 / 10、`claude-haiku-5-5`（要求が 10 万トークン以下）0.10 / 0.125 / 0.20 / 0.01 / 0.50、同（10 万トークン超）0.50 / 0.625 / 1 / 0.05 / 2.50、`claude-fable-5-1` 10 / 12.50 / 20 / 0.25 / 50。キャッシュの読み取りは Opus 5.5・Sonnet 5.5 が基本入力の 0.05 倍、Fable 5.1 が 0.025 倍、Haiku 5.5 が 0.1 倍。`inference_geo: "us"` は 1.1 倍（既定の global は標準の料金） | https://platform.claude.com/docs/en/about-claude/pricing | 2026-10-19 |
| F2 | ツールを使うときに足される system prompt（tool_choice が auto / none）: Opus 5.5・Sonnet 5.5・Haiku 5.5 とも 286 トークン | 同上 | 2026-10-19 |
| F3 | Opus 5.5 / Sonnet 5.5 は tool_choice の any / tool が 400（auto を使う）。Opus 5.5 は thinking を切れない（調整は effort だけ。既定 medium）。Sonnet 5.5 は `between_tools` で thinking を切れる（effort high 以下）。コンテキスト 1M・最大出力 128K | https://platform.claude.com/docs/en/about-claude/models/overview （Claude Code の claude-api スキルの参照資料でも確認） | 2026-10-19 |
| F4 | ストリーミングは SSE（server-sent events）。`message_start` → `content_block_start` → `content_block_delta`（`text_delta`・`input_json_delta`・`thinking_delta`）→ `content_block_stop` → `message_delta`（`usage` は累積）→ `message_stop`。途中に `ping`・`error` が挟まる | https://platform.claude.com/docs/en/build-with-claude/streaming | 2026-10-19 |
| F5 | Token Counting（`POST /v1/messages/count_tokens`）: 無料、回数制限あり（Start tier 5,000 RPM）、値は見積もり、資格情報（鍵）が要る、prompt caching は使わない | https://platform.claude.com/docs/en/build-with-claude/token-counting | 2026-10-19 |
| F6 | トークンと文字数: 旧来のモデルで 1 トークン ≈ 英字 3.5 文字。Claude 4.7 以降の新しいトークナイザは同じ文で約 30% 多い。正確な数は count_tokens で。**日本語の換算係数は公式に無い** | https://platform.claude.com/docs/en/about-claude/glossary （Tokens の項）と F5 の注記 | 2026-10-19 |
| F7 | データの保持（Claude API の文書）: 保持したデータは明示の許可なくモデルの学習に使わない。会話の内容（プロンプトと出力）は既定では保持しない。例外は 30 日の保持が必須の Covered Models（Fable 5.1・Mythos 5.1・Fable 5・Mythos 5。Opus 5.5・Sonnet 5.5・Haiku 5.5 は含まれない）。ZDR（zero data retention）は組織ごとに営業経由で結ぶ。prompt caching は ZDR の対象で、KV キャッシュはキャッシュの TTL の間だけメモリに置く | https://platform.claude.com/docs/en/manage-claude/api-and-data-retention | 2026-10-19 |
| F8 | データの保持（プライバシーセンターの商用向けの記事）: 入力と出力はバックエンドで受領・生成から 30 日以内に自動で削除する。例外は Files API、合意した条件、利用規約違反の調査、法的要件 | https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data | 2026-10-19 |
| F9 | F7 と F8 は書き方が違う（F7「既定では保持しない」/ F8「30 日以内に削除」）。どちらが組織に当てはまるかは組織の Console の設定（データ保持・ZDR）による → 論点 1 でオーナーが確かめる事項にする | F7・F8 | 2026-10-19 |
| F10 | 費用の上限（Console）: 組織に tier ごとの月の上限（Start $500 / Build $1,000 / Scale $200,000）があり、自分で低い上限を設定できる（Billing）。ワークスペースごとの上限も設定できる（既定のワークスペースには不可）。月の上限は UTC の月初に戻る。tier の上限に達すると 429 `rate_limit_error`（`error.details.error_code = enforced_spend_limit_reached`、`retry-after` なし）、自分で設けた上限は 400 `invalid_request_error`。**日単位の上限は無い** | https://platform.claude.com/docs/en/api/rate-limits | 2026-10-19 |
| F11 | 回数制限（Start tier）: Opus 5.5・Sonnet 5.5・Haiku 5.5 とも 1,000 RPM・入力 2,000,000 トークン / 分・出力 400,000 トークン / 分（キャッシュの読み取りは入力の制限に数えない） | 同上 | 2026-10-19 |
| F12 | prompt caching: 前置きの一致で効く。順序は tools → system → messages。ブレークポイントは最大 4。最小の長さ 512 トークン（Opus 5.5・Sonnet 5.5・Haiku 5.5）。TTL は 5 分（既定。読むと延びる）か 1 時間 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | 2026-10-19 |
| F13 | Workload Identity Federation（WIF）: 長命の API キーの代わりに、外部の OIDC トークンを短命の Anthropic のトークンに交換する。Google Cloud（Cloud Run を含む）はメタデータサーバーの ID トークン（issuer `https://accounts.google.com`、audience を指定、`format=full` で SA の email を含める）を使う。ルール（federation rule）は `sub`（SA の数値の unique ID）と `email` を両方固定し、`subject_prefix` は使わない。トークンの寿命はルールの `token_lifetime_seconds`（60〜86400、既定 3600）と ID トークンの残り × 2 の小さい方。交換と更新は SDK が行う（Python は `WorkloadIdentityCredentials` に ID トークンを返す関数を渡す） | https://platform.claude.com/docs/en/manage-claude/workload-identity-federation 、 https://platform.claude.com/docs/en/manage-claude/wif-providers/gcp | 2026-10-19 |
| F14 | claude-api スキルの参照資料（2026-10-06 時点）は Sonnet 5.5 のキャッシュの読み取りを $0.20 と書くが、公式の料金ページは $0.10（0.05 倍）。**公式を採る** | F1 | 2026-10-19 |
| F15 | Python SDK `anthropic`（PyPI）: 最新は 1.15.0（2026-10-15）。1.x の依存は `anyio`・`docstring-parser`・`httpx2`・`jiter`・`opentelemetry-api`・`pydantic`・`sniffio`・`typing-extensions`。`exclude-newer = 2026-09-28T00:00:00Z` では 1.9.0（2026-09-28 18:04Z 公開）が入らず、1.8.0（2026-09-22）が上限。**#134 で 1.8.0 を採用**（`uv.lock` に固定。1.8.0 の解決では `opentelemetry-api` は入らず、`httpcore2`・`h11`・`truststore` などが入った） | https://pypi.org/project/anthropic/ | 2026-10-19 |

## 3. 論点の一覧

論点 1〜4 は Issue と EPIC #141 の (a)〜(d) でオーナー判断と指定されたもの。論点 5 は EPIC #141 の子の表で「#132 で決める（ブラウザの `model/` を呼ぶ往復の形）」とされ、決め違えたときの作り直しが最も大きいのでオーナー判断にした。論点 6〜8 は既存の規則の延長か実装の選択なので「実装時」（オーナーに異論が無ければ実装の Issue で推奨を起点に決め、design.md 13.4 に記録する）。

| 論点 | 題 | 判断者 | 推奨（要約） |
|---|---|---|---|
| 1 | Anthropic API に送るデータの範囲と JPX データの扱い | オーナー | 許可リスト（正規化した値・ポジション・シナリオ・ツールの出力）。板の行・気配の生の値は送らない |
| 2 | API の鍵の置き場所と IAM | オーナー | WIF（鍵を持たない）。使えなければ Secret Manager を `infra/bootstrap` に |
| 3 | 費用の 1 日上限・使うモデル・上限を実装する場所 | オーナー | `claude-opus-5-5`・1 日 $3・Firestore の日のカウンタ + Console のワークスペースの月の上限 |
| 4 | 応答の速さの目標 | オーナー | 最初の文字の p50 ≤ 3,000 ms、ツールの数字（ブラウザ内）p50 ≤ 300 ms |
| 5 | ツール（simulator の計算）を実行する場所 | オーナー | ブラウザの `model/` を呼ぶ往復 + 定型の 1 アクションは事前計算 |
| 6 | 会話の状態の持ち方 | 実装時 | ブラウザが履歴を持ち毎回送る。中継は届いた履歴を許可リストで検査 |
| 7 | 中継の作り方 | 実装時 | 公式の Python SDK `anthropic` を `api/` に足す |
| 8 | 中継の口の守り | 実装時 | `application/json` だけ受ける + `Sec-Fetch-Site` / `Origin` の検査 |

## 4. 論点

### 論点 1: Anthropic API に送るデータの範囲と JPX データの扱い
- 判断者: オーナー

EPIC #141 の (a)。板そのもの（行の配列・気配の生の値）を送ることは EPIC のスコープ外としてある。ここで決めるのは「何を許可リストに入れるか」と「許可リストの値でも送ってよいか（JPX の情報の利用条件・Anthropic 側の保持）」。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | **許可リスト**: 正規化した値だけを送る。限月ごとの F・残存日数・ATM の行使価格・ATM IV・スマイルの要約（決まった moneyness の点の IV か、傾き・曲率）、ポジションの足（種別・限月・K・売買・枚数・建値・建値の側）、シナリオ（日数・IV の平行移動・横軸の範囲）、資金規模の設定（#131 の後）、ツールの出力（損益・グリーク・テール表の数値）。送らないもの: 板の行の配列（`rows`）、気配の生の値（bid / ask・数量・建玉・出来高）、JPX のグリーク・`bid_iv` / `ask_iv`、スナップショットの生 JSON | 読み解き（最優先のニーズ）に要る値が揃う。中継で形を検査できる（終了条件 3 の pytest）。トークンが少ない | 建値は板の bid / ask から既定が入る（D6）ので、A でも「板から来た値」を足 1 本につき 1 つ送る。提案（#139）で AI が板にない行使価格を挙げないよう、候補の生成はツール側でする必要 | 文脈は約 660 トークン（見積もり）。費用への効きは小さい |
| B | A + 必要な行使価格だけの気配（提案の候補を AI に選ばせる用） | 提案の精度が上がる | 「気配の生の値」を送るので EPIC のスコープ外に当たる。許可リストの検査が複雑になる | 行使価格 1 本あたり数十トークン |
| C | 板をまるごと（`/api/chain` の JSON） | 実装が最も簡単 | EPIC のスコープ外。JPX の情報の第三者への提供に最も近い。AI が板から数字を拾い、ツールの値以外の数字が混ざる（終了条件 2 に弱い） | 約 1,100 行 × 2 限月。gzip で数十 KB（design.md 7.1）= 数万トークン / 回 |
| D | 何も送らない（設計書の説明と一般論だけ） | JPX の情報を外に出さない | 今のポジションの読み解き（最優先のニーズ）ができない。EPIC の価値の大半が無くなる | 最小 |

**オーナーが確かめる事項（JPX の情報）**: こちらからは JPX のサイトを見ないので、確かめる項目だけを並べる。

1. JPX の情報（相場の情報・指数・JPX が算出する IV / グリーク）を、第三者のサービス（海外の AI 事業者を含む）に送ることが、利用条件の「再配布」「第三者への提供」に当たるか
2. 加工した値（F の推定・スマイルの要約・損益の計算値）と、生の値（気配・JPX の IV）とで扱いが違うか
3. 遅延データ（約 15 分遅れ）の利用条件
4. 個人の利用と、業としての利用の違い（本人 1 人の検討用であること）
5. optionchan が取り込んでいる元のページの利用条件
6. 建値（既定は板の bid / ask。D6）を足 1 本につき 1 つ送ることを許すか

**オーナーが確かめる事項（Anthropic 側の保持）**: F7 と F8 で書き方が違う（F9）。組織の Console のデータ保持の設定と、ZDR を結ぶかを確かめる。どちらの書き方でも「明示の許可なく学習に使わない」は共通。Covered Models（`claude-fable-5-1` など）は 30 日の保持が必須なので候補から外す（論点 3）。

#### 推奨

A。送る本文の形は中継で許可リストとして検査する（キー・型・大きさ。外れたら Anthropic を呼ばずに 400。終了条件 3）。B が必要になったら #139 で改めて諮る。上の確かめる事項で「加工した値も送れない」となったら D に落とす（EPIC の範囲を見直す）。

#### オーナー判断

**決定（2026-10-19、オーナー）**: 板も送ってよい。中継の許可リストの検査は残し、板の行（正規化した気配と IV）も許可リストに入れる。

### 論点 2: API の鍵の置き場所と IAM
- 判断者: オーナー

EPIC #141 の (b)。Issue と #120 の当初の方針は「Secret Manager に置く」だが、調べる中で **鍵そのものを持たない** 方式（Anthropic の Workload Identity Federation。以下「Anthropic の WIF」。infra/bootstrap の GitHub Actions → GCP の WIF とは別物。F13）があると分かったので並べる。どの案でも、鍵（または交換したトークン）はブラウザに出さず、応答・ログに出さない（終了条件 5。検査は `repo-values-check.sh`・`csp-check.sh`・`gcloud logging read`）。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | **Secret Manager を `infra/bootstrap`（所有者の apply）に**: `google_project_service`（secretmanager。`disable_on_destroy = false`）、シークレットの入れ物（値は Terraform に入れない。所有者が `gcloud secrets versions add --data-file=-` で標準入力から投入）、`google_secret_manager_secret_iam_member`（シークレット単位・`roles/secretmanager.secretAccessor`・member は実行 SA `sa-simulator`。追加型）。Cloud Run には `infra/prod` の env の `value_source.secret_key_ref`（版は固定の番号か `latest`）で渡す | 実績のある形。apply SA に Secret Manager の権限を足さない（付録 B の方針のまま）。値は tfstate に入らない | 長命の鍵が存在する（漏れたときの影響が大きい）。発行・投入・ローテーションの手作業が続く。付録 B「API の有効化は simulator 側で宣言しない」の例外になる | 本番の IAM: API の有効化 1 件 + シークレット単位の付与 1 件。Secret Manager の費用は無料枠の範囲の見込み |
| B | **Secret Manager を `infra/prod`（CI の apply）に** | 変更が CI の承認の流れに乗る | apply SA にプロジェクト単位の `serviceusage.serviceUsageAdmin` と `secretmanager.admin` が要る = 権限が広がり、付録 B「apply SA の権限を絞る」に反する。長命の鍵は A と同じ | 本番の IAM: apply SA への付与が増える |
| C | **WIF（鍵を持たない）**: Cloud Run の実行 SA のメタデータサーバーから Google の ID トークン（issuer `https://accounts.google.com`、audience `https://api.anthropic.com`、`format=full`）を取り、Anthropic の短命トークンに交換する（F13）。Anthropic 側は Console の「Connect workload」（Google Cloud）で、issuer・Anthropic のサービスアカウント・federation rule（`sub` = 実行 SA の数値の unique ID と `email` を両方固定、audience 固定）を所有者が作る。GCP 側は環境変数でルール ID・組織 ID・サービスアカウント ID・ワークスペース ID を渡すだけ（秘密ではないが個人の値なので、リポジトリに書かず Terraform の変数 / GitHub variables で） | 鍵が存在しないので漏れ・ローテーションが無い。GCP 側の IAM・API の有効化・シークレットが不要。トークンは分単位で失効（ルールの既定 3,600 秒、ウィザードは 600 秒） | Anthropic の組織の admin 権限で所有者が Console のウィザードを回す必要。ID トークンに `email` が入るか（SDK の例の `fetch_id_token` が `format=full` を満たすか）と、Python SDK の `WorkloadIdentityCredentials` が `exclude-newer` の範囲の版（1.8.0 まで。F15）にあるか未確認（論点 7）。clone した人には Anthropic 側の設定の手順が増える。#133 の中身が「Secret Manager を足す」から「WIF の値を env に渡す」に変わる | 本番の IAM の変更なし。Cloud Run の env が数個増える |
| D | Cloud Run の素の環境変数に鍵（GitHub secret → Terraform の変数） | 最も簡単 | tfstate・plan の出力・Cloud Run の設定（`run.viewer` で読める）に鍵が入る | 不採用の扱い |

比べる観点: 本番の IAM の変更量（A: API の有効化 + 付与 1 件 / C: なし）、所有者の手作業（A: 鍵の発行・投入・ローテーション / C: Console のウィザード 1 回）、漏れたときの影響（A: 長命の鍵 / C: 短命のトークン）、clone した人の手順の量、SDK の対応。

#### 推奨

**C**（鍵が存在しないので、漏れ・ローテーション・Secret Manager の API の有効化と IAM の変更が要らない）。C が使えないとき（SDK の版・組織の設定）は A。どちらでも Anthropic の Console でワークスペースを simulator 専用に分ける（論点 3 のワークスペースの月の上限を効かせるため）。C を採るなら #133 の題・受け入れ条件を書き直す（オーナーの回答の後に）。

#### オーナー判断

**決定（2026-10-19、オーナー）**: API キーと OAuth トークン（Claude のサブスクリプションのもの）の **両方** を使えるようにする。トークンを使うときは SDK に **トークンだけ** を渡す（トークンのときはキーを渡さない。**訂正（#134、2026-10-19）**: SDK 1.8.0 はキーを優先するのではなく、両方あると `X-Api-Key` と `Authorization: Bearer` の両方を送る。どちらにしても片方だけを渡す結論は同じ。中継は環境変数を SDK に読ませず選んだ片方を明示で渡し、両方の環境変数があれば AI を無効にする）。WIF は採らない。置き場所は Secret Manager（`infra/bootstrap`、シークレット単位の `secretAccessor`）を基本に #133 で決める。サブスクリプションの OAuth トークンをこの用途で使ってよいかの規約と、トークンの有効期限・更新はオーナーが確かめる（#133）。

#133 で A の形（`infra/bootstrap` に API・シークレット 2 つ・付与、`infra/prod` の変数 `ai_credential` で片方だけを環境変数の参照に）にした。背景は [ADR-0001](adr-0001-ai-credentials-secret-manager.md)、手順は `infra/README.md`「AI の資格情報（Secret Manager）」。

**追記（#184、2026-10-19、オーナー）**: 案 C（Anthropic の WIF）も足す（「WIF は採らない」を改める）。`AI_CREDENTIAL=wif` で、Secret Manager を使わず ID を素の環境変数（GitHub の repository variables から）で渡す。SDK 1.8.0 に `WorkloadIdentityCredentials` があり（F15 の懸念は解消）、ID トークンはメタデータサーバーから `format=full` で取る（`fetch_id_token` ではなく直接 1 回の GET）。費用は `api_key` と同じく実額で数える。ADR-0001 の追補。

**追記（#186、2026-10-19、オーナー）**: サブスクリプションの OAuth トークンは Messages API の直接呼び出しでは 429 になる（観測）。`oauth_token` の送信路を Claude Agent SDK（同梱の Claude Code CLI）に改め、トークンは子プロセスに `CLAUDE_CODE_OAUTH_TOKEN` としてだけ渡す。本番の既定は `oauth_token`、`wif` とは GitHub の variable で切り替える。規約の文面（Agent SDK の文書・Legal and compliance）と、利用者が自己責任で判断することは [ADR-0005](adr-0005-ai-oauth-via-agent-sdk.md)。

### 論点 3: 費用の 1 日上限・使うモデル・上限を実装する場所
- 判断者: オーナー

EPIC #141 の (c)。小問が 3 つ（モデル・上限の値・数え方）あるので、表は案の記号で小問を分けて 1 つにまとめる（M = モデル、L = 上限の値、C = 数え方）。1 回の費用は下の「見積もり」（すべて合成の入力と仮定の係数。為替は仮定 1 USD = 150 円）。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| M1 | モデル `claude-opus-5-5`（既定・最新の Opus） | 最も賢い。読み解き・議論の質 | thinking を切れない（F3）ので最初の文字が遅くなりうる（論点 4） | 診断 1 回 約 $0.09〜0.12（見積もり） |
| M2 | モデル `claude-sonnet-5-5` | `between_tools` で thinking を切れる = 最初の文字が速い候補。費用は Opus の半分 | Opus より推論が浅い | 診断 1 回 約 $0.05〜0.06 |
| M3 | モデル `claude-haiku-5-5` | 最も安く速い | 読み解き・提案の質が落ちる見込み。10 万トークン超の要求は料金が 5 倍（F1。設計書を丸ごと渡すと当たる） | 診断 1 回 約 $0.002〜0.003 |
| L1 | 1 日の上限 $1（150 円） | 最も安全 | Opus で設計書とマニュアルを丸ごと渡す（#137）と、最初の 1 回（キャッシュの書き込み）約 $0.79 で 1 会話ほどで尽きる | 月の最大 約 $31 |
| L2 | 1 日の上限 $3（450 円） | Opus・設計書なしの診断で約 25〜33 回 / 日。#137 の後も温かいキャッシュなら 1 回 約 $0.14 で 20 回ほど | 使い方によっては足りない日がある | 月の最大 約 $93 |
| L3 | 1 日の上限 $5（750 円） | 余裕がある | 暴走したときの 1 日の損が大きい | 月の最大 約 $155 |
| C1 | 数え方: インスタンスのメモリ内のカウンタ | 新しい資源・IAM が要らない | 最大 2 インスタンス、`cpu_idle = true`・最小 0 で落ちると 0 に戻る → 最悪 2 倍以上ずれる | 0 |
| C2 | 数え方: Firestore（Datastore モード）の 1 文書（日付のキー、トランザクションで加算） | インスタンスをまたいで正しい。既に有効な API（プロジェクトに `(default)` の Datastore モードの DB がある） | 実行 SA に `roles/datastore.user` の付与が増える（bootstrap。本番の IAM の変更）。既存の DB の用途が未確認。**プロジェクト単位の付与は既存の `(default)` DB 全体の読み書きに及ぶ**（名前空間は IAM の境界にならない）。付けるなら名前つきの DB を新設し、IAM 条件（`resource.name`）でその DB に絞る | 無料枠の範囲の見込み |
| C3 | 数え方: GCS のオブジェクト 1 つ（世代番号の前提条件つきの書き換え） | インスタンスをまたいで正しい | 新しいバケットが要る（state のバケットとは混ぜない）。IAM の付与が増える | ほぼ 0 |
| C4 | 数え方: Anthropic の Console の上限だけ | 実装が要らない | 月の上限しか無い（F10。日単位は無い）。超えると 400 / 429 で止まるだけで、「押す前に残り」は出せない | 0 |

**「押す前に残り」の出し方**（どの数え方でも）: 送る前にその要求の最大額を **予約** する（入力の見積もり（文字数 × 係数）× 入力の単価 + `max_tokens` × 出力の単価）。上限から引けるときだけ送り、応答の `usage`（`input_tokens`・`cache_creation_input_tokens`・`cache_read_input_tokens`・`output_tokens`）で実額に精算する。残り = 上限 − 精算済み − 予約中。画面は押す前にこの残りを出す。count_tokens（F5。無料・別の回数制限）は往復が 1 回増えるので既定にせず、係数の検証に使う。終了条件 4 の「上限ちょうど / +1 で呼び出し 0 回」はこの予約で判定できる。

#### 推奨

M1（`claude-opus-5-5`。effort は low か medium を #135 で測って決める）、L2（1 日 $3）、C2 + C4（Firestore で日の上限を数え、Console で simulator 専用ワークスペースに月の上限（日の上限 × 31 程度）を設けて二重にする）。M2 は速さ（論点 4）が目標に届かないときの代替。`claude-fable-5-1` は 30 日の保持が必須の Covered Model（F7）で、料金も Opus の 2.5 倍なので候補から外す。

#### オーナー判断

**決定（2026-10-19、オーナー）**: 推奨どおり（`claude-opus-5-5`・1 日 $3・Firestore の日のカウンタ + Console のワークスペースの月の上限）。ただし **サブスクリプションの OAuth トークンで呼んだときは費用 0 として数える**。その場合も、使ったトークン量（`usage` の入力・出力・キャッシュ）と費用（USD）を構造化ログに出す。Messages API の応答は費用（USD）を返さないので、ログの USD は `usage` × 料金表の概算（料金表の確認日をログの項目に持つ）。

### 論点 4: 応答の速さの目標
- 判断者: オーナー

EPIC #141 の (d)。終了条件 6 の値。計る区間は、中継の構造化ログで「要求を受け取った時刻 → 最初の text delta を書き出した時刻」の ms（終了条件 6 の測定手段）。画面の「ツールの数字」は別に計る（論点 5 の推奨ならブラウザ内の計算なので通信は無い）。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | 最初の文字の p50 ≤ 1,500 ms | 体感がとても速い | Opus 5.5 は thinking を切れず、最初の文字は thinking の後になる。Sonnet 5.5（`between_tools`）か Haiku 5.5 が前提になりやすい | モデルの選択を縛る（論点 3） |
| B | 最初の文字の p50 ≤ 3,000 ms | Opus 5.5 の effort low〜medium で届く見込み（未計測）。ツールの数字を先に出せば待ちの体感は短い | 見込みは計測ではない（公式に TTFT の数値は無い）。#134 で外れたら詰める作業が要る | 目標を外れたときの代替（Sonnet 5.5・effort low）がある |
| C | 最初の文字の p50 ≤ 5,000 ms | ほぼ確実に届く | 会話として待ちが長い | 小 |
| D | 目標を置かず、#134 で測ってから決める | 根拠のある値になる | 終了条件 6 の値が #134 まで決まらない（作りの判断の基準が無いまま進む） | 判断が 1 回増える |

根拠と制約:

- 公式の文書に TTFT の数値は無い（Glossary は定義だけ）。Opus 5.5 は thinking を切れない（F3）。thinking の `display` が既定の `omitted` だと thinking の間は空の block しか来ないので、`display: "summarized"` で thinking の要約を先に流す手もある
- コールドスタートは design.md 9 章で +2〜3 秒を許容している（`min_instance_count = 0`）。p50 は温かいインスタンスで決まる見込み
- ストリーミングの方式: 同じオリジンの `POST /api/ai/...`（仮の名前）を `fetch` の ReadableStream で読む SSE の形（`text/event-stream`）。`EventSource` は GET だけなので使わない。CSP は `connect-src 'self'` のまま。応答は gzip しない・`Cache-Control: no-store`。中継は Anthropic の SSE（F4）を、画面に要る event（text の差分・ツールの呼び出し・usage・エラー）だけに絞って流す
- Cloud Run のタイムアウト 60s はストリーミングでも 1 本の要求の全体に掛かる。同時実行 8 × 最大 2 インスタンス、gunicorn は 1 ワーカー 8 スレッドで、ストリーミングの 1 本はスレッドを 1 本ふさぐ。利用者は 1 人なので本数は足りるが、`/api/chain` などと同じ 8 本を分け合う
- 出力 2,500 トークン（見積もり）の生成時間は公式の値が無い。出力の速さを **仮定** 30〜100 トークン / 秒とすると 25〜83 秒で、60 秒を超えうる。対策の案: AI の要求だけ `max_tokens` を抑える / サービスのタイムアウトを延ばす（サービス全体に効く）/ 論点 5 の往復で 1 本の要求を短くする
- 未確認（#134 で確かめる）: gunicorn の `--timeout 60`（gthread のワーカーの無応答の検知）が長いストリームを切るか、IAP（Cloud Run への直接の設定）が SSE をバッファしないか

#### 推奨

B: 最初の文字の p50 ≤ 3,000 ms（温かいインスタンス。中継の受信から最初の text delta まで）、ツールの数字（ブラウザ内の計算）の p50 ≤ 300 ms。#134 の 24 時間の実測が目標を外れたら Sonnet 5.5（`between_tools`）か effort low で詰め、値を見直すなら改めて諮る。

#### オーナー判断

**決定（2026-10-19、オーナー）**: 待っている間の UX が良ければ、答えの完了まで **30 秒程度かかってもよい**。目標を「押してから 1 秒以内に進み具合（ツールの計算・考え中・書き始め）が見える」と「最初の文字 p50 ≤ 30,000 ms」に改める（推奨の 3,000 ms から緩める）。ツールの数字（ブラウザ内の計算）p50 ≤ 300 ms は推奨どおり。

### 論点 5: ツール（simulator の計算）を実行する場所
- 判断者: オーナー

EPIC #141 の前提「計算はすべて simulator（ブラウザの `model/`）。AI に数字を計算させない。任意のコード・クエリを書かせない」をどう実現するか。比べる軸は、数値の出どころ（終了条件 2）、往復の回数とかかる時間、1 本の要求が Cloud Run のタイムアウト 60s に収まるか、実装の重さ、送るデータ（ツールの出力は論点 1 の許可リストの形）。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| (i) | **ブラウザの `model/` をツールとして呼ぶ往復**: 中継は `tool_use` で止めてブラウザに返し、ブラウザが計算して `tool_result` を付けた履歴で次の要求を送る | 数値の出どころが画面と同じ `model/`（終了条件 2 に強い）。1 本の要求 = 1 回の生成なので 60 秒・スレッドの占有に有利 | 往復ごとに中継・IAP・Anthropic の往復と入力の再送がある。診断 1 回で要求 2 本（見積もり） | 入力の再送はキャッシュで安くなる（見積もり） |
| (ii) | サーバーで計算（Python に `model/` を写す） | 往復がサーバーの中で閉じる | 計算が 2 実装になり、画面の数字と食い違うおそれ（終了条件 2 に弱い）。テストも二重 | 実装・保守が重い |
| (iii) | サーバーに Node を足して `model/` をそのまま動かす | 計算は 1 実装のまま | イメージ・`Dockerfile`・`.dockerignore`・image-check の変更が大きい。サーバーが板を持ち直す必要（今はブラウザが持つ） | イメージが大きくなる。コールドスタートが延びうる |
| (iv) | **(i) + 事前計算**: [このポジションを診断] など定型の 1 アクションは、ブラウザが決まったツール（損益の要約・グリーク・テール表・スマイルの比較）を先に計算して最初の要求の文脈に入れる。追加の質問は (i) の往復 | 定型は往復 0 回で生成が始まる（要求 1 本）。画面にツールの数字を先に出せる（「ツールの数字を先に出す」）。数値の出どころは (i) と同じ | 事前計算するツールの組を定型ごとに決める必要（#135・#140） | 診断の入力は (i) より少ない（要求 1 本ぶん） |

#### 推奨

(iv)（定型は事前計算、自由な質問は (i) の往復）。AI に計算させず、ツールは決まった集合だけ（任意のコードを書かせない）。

#### オーナー判断

**決定（2026-10-19、オーナー）**: 計算は **決定論的な手法** で行う。計算はあらかじめコード（simulator の `model/` など）にしておき、AI はそれをツールとして呼ぶだけ。AI に計算・任意のコード・クエリを書かせない。実行の場所は推奨どおり（定型は事前計算、自由な質問はブラウザとの往復）。

### 論点 6: 会話の状態の持ち方
- 判断者: 実装時

design.md 8.2「計算はブラウザ」と、サーバーに状態を持たない今の作りの延長で決められるので実装時にした。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | ブラウザが履歴を持ち、毎回送る（サーバーは状態なし） | 今の作りと同じ。新しい資源・IAM・保持の方針が要らない | 毎回の入力が履歴の分だけ増える（キャッシュで緩和）。届いた履歴を信じられないので検査が要る | キャッシュの読み取りで増分を抑える |
| B | サーバーが会話 ID で持つ（Firestore など） | 送る量が少ない | 新しい資源・IAM・会話の保持期間の方針が要る。会話の本文をこちらのストレージに残すことになる | 本番の変更が増える |
| C | Anthropic の Managed Agents のセッション（状態は Anthropic 側） | 状態の管理を任せられる | ZDR の対象外。中継の作りが大きく変わる。ツールをブラウザで動かす形（論点 5）と合わせにくい | 移行が大きい |

A の決めごと:

- preserved thinking（Opus 5.5・Sonnet 5.5 は前の turn の thinking block を改変すると無効。2026-08-31 以降に作った組織では 400）があるので、**履歴は追記だけ**にし、thinking block（署名つき）はそのまま返す
- 端末に保存するか: **決定（#135、オーナー 2026-10-19）**: ブラウザのタブの間だけ（sessionStorage の 1 キー `optsim.ai.v1`。再読み込みでは残り、タブを閉じたら消える）。保存一覧・URL 共有・書き出しには載せない。[新しい会話] で消す
- 会話の途中で板・ポジション・シナリオが変わったら、最初の文脈は変えずに新しい user の発言に `context_update` の block を足す（中継が `<context_update>` の text にして後ろに置く = 前の履歴のバイト列を変えない。#135）
- 構造化ログに会話の本文を出さない。出すのは model・トークン数・ms・`stop_reason`・ツールの名前だけ（design.md 9 章のログの規則の延長）
- 許可リストの検査（終了条件 3）: 中継は届いた履歴を、role（user / assistant）・block の型（text / tool_use / tool_result / thinking）・ツールの名前（決まった集合）・`tool_result` の中身の形（ツールごとの JSON の型。数値と決まったキーだけ）・最初の文脈の形（論点 1 の A）・大きさの上限で検査し、外れたら Anthropic を呼ばずに 400

#### 推奨

A。

#### オーナー判断

**実装時に決定（#134、2026-10-19）: A**（ブラウザが履歴を持ち毎回全部送る。サーバーは会話を持たない。`done` の `content` を thinking の署名ごとそのまま履歴に足す。送る本文は検査済みの値から決定的に組み立て直す）。定数と詳細は design.md 13.4「AI の中継」

### 論点 7: 中継の作り方
- 判断者: 実装時

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | 公式の Python SDK `anthropic` を `api/` の依存に足す | ストリーミング・ツール・再試行・WIF（`WorkloadIdentityCredentials`）を SDK が扱う。公式の推奨 | 依存が増える（F15。httpx2・pydantic・anyio など。`uv.lock` が大きく変わる）。`exclude-newer` の範囲では 1.8.0 まで | イメージが少し大きくなる |
| B | 生の HTTP（`requests` は google-cloud-bigquery の依存として `uv.lock` に既にある）+ 自前の SSE の解析 | 依存が増えない | SSE の解析・再試行・WIF のトークン交換を自前で書く。仕様の変更を追う負担 | 実装・保守が重い |
| C | 中継を別のサービス（Node など）にする | TypeScript の SDK と `model/` を同じ言語で | サービス・IAP・IaC・デプロイが 1 組増える | 本番の変更が大きい |

エラー・再試行・タイムアウト（A のとき）:

- SDK の既定は再試行 2 回（408 / 409 / 429 / 5xx・接続エラー）・タイムアウト 10 分 → 中継では Cloud Run の 60 秒の内に収まるよう短くする
- 月の上限に達した 429（`enforced_spend_limit_reached`、`retry-after` なし。F10）と、自分で設けた日の上限の 400 は再試行しない
- `stop_reason: "refusal"` を処理する。拒否のときの代替モデル（`fallbacks`）を付けるかは #134 で
- 1.8.0 に `WorkloadIdentityCredentials`・必要なストリーミングの機能があるかは #134 で確かめる。無ければ `exclude-newer` を進める判断（依存の更新）が要る

#### 推奨

A（SDK がある言語では SDK を使い、生の HTTP と混ぜない）。

#### オーナー判断

**実装時に決定（#134、2026-10-19）: A**（公式の Python SDK `anthropic` 1.8.0 を `api/` の依存に固定。`exclude-newer` は据え置き。推移の依存は httpx2・httpcore2・h11・truststore・pydantic・pydantic-core・annotated-types・typing-inspection・jiter・anyio・sniffio・docstring-parser（いずれも MIT / BSD-3-Clause / MIT OR Apache-2.0。`uv.lock` には emscripten だけの httpx2-jsfetch も載るがイメージには入らない）。イメージは約 22 MB 増）。`max_retries=0`、`fallbacks` は付けない。資格情報は中継が選んだ片方を明示で渡す（明示の引数があると SDK は環境変数を読まない）。詳細は design.md 13.4「AI の中継」

**追記（#186、2026-10-19）**: `oauth_token` のときだけ、送信路を Claude Agent SDK（`claude-agent-sdk` 0.2.160、同梱の CLI 2.1.283。MIT・推移の依存 13 個）にした。CLI を要求ごとの子プロセスで動かし、ツールは実行させず（`PreToolUse` フックで止める）、事象は `StreamEvent` から今と同じ形に組み立てる。CLI の内部（transcript の形・未文書の環境変数）に依存するので版を固定し、本物の CLI と 127.0.0.1 の偽の Messages API の結合テストで守る。イメージは約 452 MB。詳細は [ADR-0005](adr-0005-ai-oauth-via-agent-sdk.md)

### 論点 8: 中継の口の守り
- 判断者: 実装時

調べる中で見つけた論点。AI の口は課金が発生する POST。IAP はブラウザのクッキーで通すので、別のサイトのページから利用者のブラウザを経由して「単純な要求」（`text/plain` の POST など、プリフライト（CORS の事前確認）の無い要求）を送られると、IAP を通って費用が使われうる（CSRF = クロスサイトリクエストフォージェリ）。

#### 選択肢

| 案 | 内容 | 利点 | 欠点 | 費用・影響 |
|---|---|---|---|---|
| A | `Content-Type: application/json` だけを受ける（別オリジンからはプリフライトが要り、CORS の許可を返さないので届かない）+ `Sec-Fetch-Site: same-origin` と `Origin` の検査 | 実装が小さい。画面の変更が要らない | 古いブラウザは `Sec-Fetch-*` を付けない（`Origin` の検査で補う） | なし |
| B | CSRF トークン（画面が取得して要求に付ける） | 古典的で確実 | トークンを配る口と状態が要る（サーバーに状態を持たない作りと合わない） | 実装が増える |
| C | 何もしない（IAP と日の上限だけ） | 実装なし | 上限までは他のサイトから費用を使われうる | 日の上限まで |

ほかに: 1 要求の大きさの上限、連打の制限（design.md 7.1 の `?at=` と同じ考え）。送る内容に利用者の自由文が入るので、プロンプトインジェクションの影響は「AI は決まったツールを呼べるだけ・ツールは計算だけ」で限る。

#### 推奨

A（日の上限は最後の砦）。

#### オーナー判断

**実装時に決定（#134、2026-10-19）: A**（`Content-Type: application/json` だけ + `Sec-Fetch-Site: same-origin` か `Origin` が要求のホストと同じ（どちらも無ければ拒否）+ 本文 512 KiB + 同時 2 本・1 分 10 回（インスタンスごと）。CORS の許可は返さない。CSP は変えない）。詳細は design.md 13.4「AI の中継」

## 見積もり

### 求め方

- Anthropic の鍵は手元に無いので Token Counting API（count_tokens。F5）では数えていない。**文字数 × 換算係数** で見積もった
- 係数: ASCII 1 文字 = 1.3 / 3.5 ≈ 0.371 トークン（F6 の「英字 3.5 文字 ≈ 1 トークン」に新しいトークナイザの +30% を掛けた）。非 ASCII（日本語）1 文字 = 1.0 トークン（**仮定**。公式の値が無い。幅 0.8〜1.5 を併記する）
- 入力は **合成の値だけ**（合成の板 `fixtures/synthetic/latest.json` から作った架空の文脈と、架空のポジション）。実データは Anthropic API に送らない。鍵の値は文書にもログにも残さない
- 鍵での実測（count_tokens と応答の `usage`）は #134・#135 で行い、係数を直す
- 為替は **仮定 1 USD = 150 円**。金額は丸めた値
- 出力の生成時間は公式の値が無いので、出力の速さを **仮定** 30〜100 トークン / 秒として扱う（論点 4）

### 代表的な 1 回の [このポジションを診断]

架空のポジション: 合成の板の 2026-11 限で put 64,000 売り 1 枚・call 72,000 売り 1 枚（ストラングル売り。建値は架空）。論点 5 の (i) の往復で数えると要求 2 本（ツールの往復 1 回）。(iv) なら要求 1 本で往復 0 回、入力はほぼ下の要求 2 の分だけになる。

| 部分 | 中身（合成・仮定） | トークン |
|---|---|---|
| システムプロンプト | 約 2,000 字（日本語 1,600 + ASCII 400） | 約 1,750 |
| ツールの定義 6 本 | JSON の ASCII 3,000 字 + 説明の日本語 600 字 + ツールを使うときの system prompt 286（F2） | 約 2,000 |
| 文脈 | 正規化した値・ポジション・シナリオの JSON（ASCII 1,500 字 + 日本語 100 字）。最小の見本（架空の JSON）は 888 字で、余裕を見た値 | 約 660 |
| 要求 1 | 入力 = 上の 3 つの和 + 利用者の指示 約 40。出力 = tool_use 4 本 約 300 + thinking 約 1,000（thinking の量は仮定） | 入力 約 4,450 / 出力 約 1,300 |
| ツールの結果 | JSON の ASCII 2,500 字（最小の見本は 661 字） | 約 930 |
| 要求 2 | 入力 = 要求 1 の入力 + 出力 + ツールの結果。出力 = 最終の回答 日本語 1,500 字 + thinking 約 1,000 | 入力 約 6,680 / 出力 約 2,500 |
| **合計** | ツールの往復 1 回（要求 2 本） | **入力 約 11,100 / 出力 約 3,800** |

### 設計書とマニュアルを丸ごと渡したとき（#137 の前提）

- `docs/design.md`（135,499 文字）約 93,900 トークン + `docs/user-guide.md`（46,162 文字）約 36,800 トークン = **約 130,700 トークン**（日本語の係数 0.8 なら約 110,600、1.5 なら約 181,000）
- どの係数でもコンテキスト 1M（F3）に入る。ただし **`claude-haiku-5-5` は 10 万トークン超の要求で高い料金**（F1）になる
- 費用は日本語の係数にほぼ比例してぶれる（係数 1.5 なら下の表の「診断 + 設計書とマニュアル」の行は約 1.4 倍）

### モデルの候補ごとの 1 回の費用

キャッシュの「冷」= その会話の 1 本目で前置き（system + ツールの定義（+ 文書））を 5 分キャッシュに書き、要求 2 は要求 1 の入力を読んで増分を書く。「温」= 前置きが 5 分以内の前の会話で既にキャッシュにある。値はすべて合成の入力と仮定の係数・為替から計算した見積もり。

| 条件 | モデル | キャッシュなし | キャッシュあり（冷） | キャッシュあり（温） |
|---|---|---|---|---|
| 診断（文書なし） | `claude-opus-5-5` | $0.1205（18.1 円） | $0.1096（16.4 円） | $0.0916（13.7 円） |
| 同 | `claude-sonnet-5-5` | $0.0602（9.0 円） | $0.0548（8.2 円） | $0.0458（6.9 円） |
| 同 | `claude-haiku-5-5` | $0.0030（0.5 円） | $0.0028（0.4 円） | $0.0023（0.3 円） |
| 診断 + 設計書とマニュアル | `claude-opus-5-5` | $1.1660（174.9 円） | $0.7891（118.4 円） | $0.1438（21.6 円） |
| 同 | `claude-sonnet-5-5` | $0.5830（87.4 円） | $0.3946（59.2 円） | $0.0719（10.8 円） |
| 同 | `claude-haiku-5-5`（10 万トークン超の料金） | $0.1457（21.9 円） | $0.1020（15.3 円） | $0.0247（3.7 円） |

検算（Opus・文書なし・キャッシュなし）: 入力 11,121 × $4 / 100 万 = $0.0445、出力 3,800 × $20 / 100 万 = $0.0760、計 $0.1205。

## EPIC #141 の終了条件との対応

| 終了条件 | 決まる論点 | 判定担当 |
|---|---|---|
| 終了条件 2（数字の出どころ） | 論点 5（(iv) / (i) で数字は `model/` の出力）、論点 6（届いた履歴の検査） | #135 |
| 終了条件 3（送るデータ） | 論点 1（許可リスト）、論点 6（届いた履歴の検査）、論点 7（中継の作り） | #134 |
| 終了条件 4（費用の上限） | 論点 3（上限の値・数え方・予約と精算・押す前の残り） | #134 |
| 終了条件 5（鍵と IAP） | 論点 2（WIF / Secret Manager。鍵をブラウザ・ログに出さない）、論点 8（口の守り） | #133・#134 |
| 終了条件 6（速さ） | 論点 4（p50 の目標・計る区間）、論点 5（往復の回数）、論点 3（モデル） | #134 |

終了条件 1・7〜10（読み解き・根拠つきの説明・[AI に聞く]・IV 推移の解析・組み方の提案）は #132 の対象外で、それぞれの子（#135・#137・#136・#138・#139）で決める。

## オーナーが答えた後にすること

1. 各論点の「#### オーナー判断」の「未決」を、日付つきの決定（例: 「2026-10-XX オーナー決定: A（推奨どおり）」）に書き換える
2. 決まった論点を `docs/design.md` 13.1 の決定事項に移し、13.2 の AI1〜AI5 の行を消す。14 章を決定に合わせて書き直す（付録 B の「API の有効化」の扱いも、論点 2 の結果に合わせて直す）
3. 論点 2 で WIF（C）を選んだら、#133 の題・受け入れ条件を書き直す
4. 1〜3 は #133 に着手する前に main が行う

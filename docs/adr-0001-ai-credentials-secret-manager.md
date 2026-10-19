# ADR-0001: AI の資格情報は Secret Manager に置き、入れ物と読み取りの付与は bootstrap で作る

- 状態: 採択（2026-10-19 に追補: Anthropic の WIF を 3 つ目の種類として足した。末尾の「追補（#184）」。`oauth_token` の送信路を Claude Agent SDK に改めた。末尾の「追補（#186）」）
- 日付: 2026-10-19
- 関連: #133・#134・EPIC #141、`docs/ai-advisor.md` 論点 2・3、`docs/design.md` 8.3・14 章・付録 B・13.1 K15、`infra/README.md`「AI の資格情報（Secret Manager）」

## 背景

AI アドバイザー（EPIC #141）の中継（#134）は Cloud Run `simulator` の中から Claude を呼ぶ。資格情報は API キー（従量課金）とサブスクリプションの OAuth トークン（`claude setup-token`。有効期間 1 年）の **両方** に対応し、トークンのときは SDK にトークンだけを渡す（K15。両方あると取り違える。**訂正（#134、2026-10-19）**: 当初「SDK は `ANTHROPIC_API_KEY` を優先する」と書いたが、SDK 1.8.0 の `auth_headers` は両方あると `X-Api-Key` と `Authorization: Bearer` の **両方** を送る（API は拒否する）。片方だけを渡す結論は変わらない）。鍵を持たない Anthropic の Workload Identity Federation は採らない（K15）。

制約:

- 資格情報はブラウザ・応答・ログ・リポジトリ・Terraform の state・plan に出さない
- CI の apply SA（`sa-sim-tf-apply`）の権限を広げない（付録 B）。plan SA は Cloud Run の設定（環境変数の名前・値）を読める
- 付録 B は「API の有効化は simulator 側で宣言しない（optionchan の bootstrap が有効化済み）」としているが、Secret Manager の API は未有効（2026-10-19）で、optionchan は使わない
- Cloud Run の環境変数の Secret の参照はインスタンスの起動時に解決され、取得に失敗するとインスタンスが起動しない。deploy 時に実行 SA の権限が検査される

## 決定

- **置き場所は Secret Manager**。シークレットの入れ物 2 つ（`simulator-anthropic-api-key`・`simulator-anthropic-oauth-token`。複製は `asia-northeast1` だけ、`deletion_policy = "PREVENT"`）
- **API の有効化・入れ物・付与は `infra/bootstrap`（所有者の apply）**。付与はシークレット単位の `roles/secretmanager.secretAccessor` を `sa-simulator` だけに（追加型）。apply SA・plan SA には Secret Manager・Service Usage の権限を付けない
- API の有効化は付録 B の **例外** として bootstrap で宣言する（`disable_on_destroy = false`・`deletion_policy = "ABANDON"` = Terraform から外しても止めない）
- **値（版）は Terraform に一切書かない**（`google_secret_manager_secret_version`・`secret_data` を使わない）。所有者が `read -rs` → `gcloud secrets versions add --data-file=-` で標準入力から登録する
- Cloud Run には **環境変数の Secret の参照**（`value_source.secret_key_ref`）で渡す。`infra/prod` の変数 `ai_credential`（`none` | `api_key` | `oauth_token`、既定 `none`）で **片方だけ** を載せ、素の `AI_CREDENTIAL=<種類>` を添える（中継が種類を知る手段。#134 は `oauth_token` のとき費用を 0 で数える）。`none` なら何も足さない。CI は GitHub の repository variable `AI_CREDENTIAL`（未設定は `none`）を渡す
- 版は変数 `ai_secret_version`（既定 `latest`、番号で固定可。GitHub variable `AI_SECRET_VERSION`）
- コミットへの混入は `repo-values-check.sh` の `sk-ant-` の形の検査で防ぐ

## 検討した選択肢

| 案 | 良い点 | 悪い点 |
|---|---|---|
| A. Secret Manager を bootstrap に（採択） | apply SA の権限が広がらない。値が state・plan・Cloud Run の設定に入らない。付与をシークレット単位に絞れる | 付録 B の「API の有効化を宣言しない」の例外になる。所有者の手作業（apply・値の登録・ローテーション）が要る |
| B. Secret Manager を prod（CI の apply）に | 変更が CI の承認の流れに乗る | apply SA にプロジェクト単位の `serviceusage.serviceUsageAdmin`・`secretmanager.admin` が要る |
| C. Anthropic の WIF（鍵を持たない） | 長命の鍵が無い | OAuth トークンに使えない。K15 で不採用 |
| D. 素の環境変数（GitHub secret → Terraform の変数） | 最も簡単 | state・plan・Cloud Run の設定（plan SA が読める）に値が入る |
| E. Secret をボリュームでマウント | 読むたびに最新の版 | SDK は環境変数を読むので中継に読み込みの処理が要る。ローテーションは年 1 程度で利点が小さい |
| F. キーとトークンを両方とも環境変数に置き、アプリで選ぶ | 切り替えに deploy が要らない | SDK が両方の見出しを送る・取り違える（トークンのつもりでキーの従量課金）。アプリの誤りで両方が使われうる |
| G. API の有効化を README の手作業（`gcloud services enable`）にする | 付録 B の方針を守れる | clone した人の手順が増え、Terraform で状態を追えない |

## 結果

- 良い点: 資格情報の値は Secret Manager の中だけにある。キーとトークンが同時に載らないことを Terraform のテストで保証する。`AI_CREDENTIAL` を設定しない限り prod は変わらない（既定 `none`）
- 悪い点:
  - 版が無い・無効なシークレットを参照すると simulator 全体が起動しない。順序（値の登録 → `AI_CREDENTIAL`、戻すときは `none` の deploy → 版の無効化）を守る必要がある
  - `latest` では、版を足しても古いインスタンスはアイドルで消えるまで旧値（Google は環境変数では番号の固定を推奨）。すぐ切り替えるなら番号で deploy する
  - apply SA は `run.admin` と `sa-simulator` の `serviceAccountUser` を持つので、承認済みの deploy で任意のイメージを `sa-simulator` で動かせば資格情報を読める。新しい付与ではなく、既存の信頼境界（Environment `prod` の承認）の内側にある
  - プロジェクトの owner はプロジェクト単位でシークレットを読める
  - API の有効化の直後は伝搬が間に合わず、1 回目の apply でシークレットの作成が失敗することがある（もう一度 plan → apply）
- OAuth トークンの利用: オーナーは自分専用の利用として、このアプリでサブスクリプションの OAuth トークンを使ってよいと判断した（2026-10-19）。Claude Code の Legal and compliance は製品・サービスを作る開発者に API キーを求めているので、clone して使う人は自分で規約を確かめ、迷うなら `api_key` を使う
- 中継（#134）の渡し方: 環境変数は中継が読み、SDK には選んだ片方だけを明示で渡す（`api_key` → `Anthropic(api_key=…)`、`oauth_token` → `Anthropic(auth_token=…, default_headers={"anthropic-beta": "oauth-2025-04-20"})`。明示の引数があると SDK は環境変数を読まない）。`ANTHROPIC_API_KEY` と `ANTHROPIC_AUTH_TOKEN` が両方ある・選んだ方が無いときは AI を無効にする（WARNING。値は出さない）。pytest で送られる見出しを確かめる
- Messages API をサブスクリプション（Max プラン）の OAuth トークンで呼んで Opus を使えることは、オーナーが確認した（2026-10-19）。**訂正（#186、2026-10-19）**: 中継から Messages API を直接呼ぶと 429 になる。動いたのは Claude Code CLI 経由（末尾の「追補（#186）」）
- 未確認: トークンの失効の方法（#134 では確かめていない）

## 追補（#184、2026-10-19）: Anthropic の WIF（`wif`）を足す

当初は案 C（Anthropic の WIF）を K15 で不採用にしたが、オーナーが Claude Console の Workload identity で Google Cloud のルール（`sub` = `sa-simulator` の数値の unique ID と `email` を完全一致、audience `https://api.anthropic.com`）を作り、3 つ目の種類として足すと決めた（2026-10-19）。不採用の理由だった「OAuth トークンに使えない」は、種類を選べるようにしたので当たらない（Max プランの OAuth トークンは `oauth_token` のまま）。

- 種類: `AI_CREDENTIAL` は `none` / `api_key` / `oauth_token` / `wif`（`infra/prod` の変数 `ai_credential`）
- **Secret Manager は使わない**。Anthropic の WIF の ID（`ANTHROPIC_FEDERATION_RULE_ID`・`ANTHROPIC_ORGANIZATION_ID` は必須、`ANTHROPIC_SERVICE_ACCOUNT_ID`・`ANTHROPIC_WORKSPACE_ID` は任意）は秘密ではないが利用者個人の値なので、リポジトリに書かず GitHub の repository variables → `deploy.yml` / `ci.yml` の `TF_VAR_anthropic_*` → `infra/prod` の変数 → Cloud Run の素の環境変数で渡す。`wif` のときだけ載せ、`wif` のときは Secret の参照を載せない（Terraform のテストで確かめる）
- 中継: Cloud Run のメタデータサーバーから実行 SA の ID トークン（audience `https://api.anthropic.com`・`format=full` = `email` の claim を含む）を取り、SDK 1.8.0 の `WorkloadIdentityCredentials` に渡して `Anthropic(credentials=…)` だけで作る（`api_key` / `auth_token` を渡さない。交換したトークンは SDK の TokenCache が持つ）。`wif` で `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` が環境変数にあれば AI を無効にする（`ai_credential_conflict`）
- 費用: API の従量課金なので `api_key` と同じく実額で数える（予約・精算・Firestore）。数えないのは `oauth_token` だけ
- GCP 側の IAM の付与・API の有効化は要らない（実行 SA は自分の ID トークンを取れる）。起動時に解決するものが無いので、ID の誤りで simulator 全体が起動しなくなることはない（AI だけが失敗する）
- 良い点: 長命の鍵が無い（漏れ・ローテーションが無い）。トークンはルールの有効期間（分単位）で切れる
- 悪い点: 所有者が Console のウィザードを回す必要がある。ルールの `sub` と `email` を両方固定しないと、任意の Google の SA に一致しうる（手順は `infra/README.md`「AI の資格情報」の wif）

## 追補（#186、2026-10-19）: `oauth_token` は Claude Agent SDK 経由で送る

- 観測: `claude setup-token` のトークンを `anthropic` SDK（`auth_token=`・`anthropic-beta: oauth-2025-04-20`）や curl で Messages API に直接渡すと HTTP 429 `rate_limit_error` になる（モデルによらない）。同じトークンを Claude Code CLI に `CLAUDE_CODE_OAUTH_TOKEN` として渡すと応答が返る。上の「Messages API を … 使えることは、オーナーが確認した」は CLI 経由での確認だった
- 決定: `AI_CREDENTIAL=oauth_token` の送信先を Claude Agent SDK（`claude-agent-sdk`。同梱の CLI を子プロセスで動かす）にする。置き場所（Secret `simulator-anthropic-oauth-token`）・環境変数名（`ANTHROPIC_AUTH_TOKEN`）・`ai_credential` の値・数えないことは変えない。中継は値を子に `CLAUDE_CODE_OAUTH_TOKEN` としてだけ渡し、親の `ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_API_KEY` は空で上書きする（CLI はそれらを優先して直接送るため）。詳細は [ADR-0005](adr-0005-ai-oauth-via-agent-sdk.md)
- 規約の文面と出典は ADR-0005 の「規約」。利用者が自分の責任で判断する

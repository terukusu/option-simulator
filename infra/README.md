# infra（Terraform）

option-simulator の GCP リソースを Terraform で管理する（`docs/design.md` 8.3・付録 B）。GCP プロジェクトは optionchan と同じ（データセット `optionchan_tokyo` を同じプロジェクトで読む）。terraform 1.16.4、google プロバイダ 8.4.0 に固定（`versions.tf`、`.terraform.lock.hcl`、`ci.yml`）。ローカルでは `mise exec terraform@1.16.4 -- terraform` で実行する。

| ルート | 中身 | apply する人 | state | state を読める主体 |
|---|---|---|---|---|
| `infra/bootstrap` | tfstate バケット 2 つ（`<PROJECT_ID>-sim-tfstate` / `<PROJECT_ID>-sim-tfstate-bootstrap`）、WIF プール `sim-github` / プロバイダ `github-actions`、SA `sa-sim-tf-plan` / `sa-sim-tf-apply` / `sa-simulator` と権限、Artifact Registry `simulator` とリポジトリ単位の付与、`optionchan_tokyo` の読み取り（`sa-simulator`、非権威的）、IAP の閲覧許可（`simulator_iap_members`）、Secret Manager の API の有効化と AI の資格情報の入れ物 2 つ・`sa-simulator` の読み取り（シークレット単位）、AI の費用の計上の Firestore の名前つき DB `simulator-ai` と `sa-simulator` の条件つきの `datastore.user` | 所有者がローカルから（CI は fmt / validate / test だけ） | `gs://<PROJECT_ID>-sim-tfstate-bootstrap/bootstrap/` | 所有者（+ プロジェクトの Editor を持つ既定の SA） |
| `infra/prod` | Cloud Run `simulator`（IAP）、IAP のサービスエージェントの `run.invoker`、AI の資格情報の参照（変数 `ai_credential`） | CI（`.github/workflows/deploy.yml`。Environment `prod` の承認後） | `gs://<PROJECT_ID>-sim-tfstate/prod/` | `sa-sim-tf-plan`（読み取り）、`sa-sim-tf-apply`（読み書き）、所有者 |

- API の有効化は宣言しない（optionchan の bootstrap が有効化済み。二重管理を避ける）。clone 利用者は iam・iamcredentials・sts・artifactregistry・run・iap・bigquery・cloudresourcemanager が有効であることを先に確かめる（`gcloud services list --enabled --project "$P"`）
- 例外: Secret Manager（`secretmanager.googleapis.com`）だけは `infra/bootstrap` で有効化する。optionchan が使わない API で、simulator の都合で optionchan を変えないため（`docs/adr-0001-ai-credentials-secret-manager.md`）。Terraform から外しても API は止めない（`disable_on_destroy = false`・`deletion_policy = "ABANDON"`）
- 付与はすべて追加型（`*_iam_member`）。権威的な型（`*_iam_policy` / `*_iam_binding`、`google_bigquery_dataset_access`）は既存の付与（optionchan のもの）を消すので使わない
- プロジェクト ID・リポジトリ名はコードに既定値を持たない。`TF_VAR_*` かローカルの `infra/bootstrap/local.auto.tfvars`（`*.tfvars` は gitignore 済み。例は `local.auto.tfvars.example`）で渡す
- state には IAP の閲覧者のメールなどが入る。**state・plan の全文・ログをリポジトリ・Issue・PR に貼らない**（要約はアドレスと操作だけ）。plan ファイル（`*.tfplan`）も gitignore 済み

## 検証（CI と同じ。資格情報なし）

```sh
TF="mise exec terraform@1.16.4 -- terraform"
$TF fmt -check -recursive infra
for d in bootstrap prod; do
  $TF -chdir=infra/$d init -backend=false -input=false
  $TF -chdir=infra/$d validate
  $TF -chdir=infra/$d test     # tests/*.tftest.hcl。モックのプロバイダで、実リソースは作らない
done
```

`terraform test` は、bootstrap では公開になる閲覧者（`allUsers`・`allAuthenticatedUsers`・`domain:`）を変数の検証で拒否すること、apply SA を借用できるのが Environment `prod` の subject だけであること、WIF の条件がリポジトリ ID とオーナー ID の両方を含むこと、データセットの読み取りが非権威的な `dataViewer` であること、AI の資格情報のシークレット 2 つ（東京だけに複製・`PREVENT`）の `secretAccessor` が `sa-simulator` だけ（シークレット単位。apply / plan SA・公開の member に付けない）であること、AI の費用の計上の Firestore の DB `simulator-ai`（Native・東京・削除保護・`ABANDON`）と、`sa-simulator` だけへの DB に絞る条件つきの `datastore.user` であること、などを確かめる。prod では IAP が有効（`iap_enabled`・`ingress = INGRESS_TRAFFIC_ALL`・`invoker_iam_disabled = false`）、`run.invoker` が IAP のサービスエージェント 1 件だけ、イメージが digest か `src-<20hex>` のタグ参照だけ（`:latest`・別リポジトリ・別イメージ名を拒否）、Cloud Run の値が `docs/design.md` 8.3 どおり、`ai_credential` が `none` なら環境変数が 3 つのまま・`api_key` なら `ANTHROPIC_API_KEY` だけ・`oauth_token` なら `ANTHROPIC_AUTH_TOKEN` だけ（キーとトークンを同時に載せない。値は Secret Manager の参照だけ）、を確かめる。

## 共通の変数

リポジトリ直下で設定する。GitHub の数値 ID・プロジェクト番号・WIF プロバイダの完全名は表示しない（変数・パイプで渡す）。`gh repo view` は gh の既定リポジトリを返すので、fork を clone して upstream があると元リポジトリを返すことがある。初回に `gh repo set-default` で自分のリポジトリを選び、表示された値が自分のものであることを確かめる。

```sh
export CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false   # gcloud の構成は CLOUDSDK_ACTIVE_CONFIG_NAME で選ぶ
P=${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
: "${P:?P（GCP プロジェクト ID）を設定する}"; echo "P=$P"            # 自分のプロジェクトであること
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)           # <OWNER>/<REPO>
: "${REPO:?gh repo set-default で自分のリポジトリを選ぶ}"; echo "REPO=$REPO"
R=repos/$REPO
TF="mise exec terraform@1.16.4 -- terraform"
export TF_VAR_project_id=$P TF_VAR_github_repository=$REPO
export TF_VAR_github_repository_id=$(gh api $R --jq .id) TF_VAR_github_owner_id=$(gh api $R --jq .owner.id)
# GitHub の OIDC の sub の形式（2026 年以降の既定は不変 ID 入り = true）。apply SA の subject がこれに合わないと deploy の apply で借用に失敗する
export TF_VAR_github_oidc_immutable_subject=$(gh api $R/actions/oidc/customization/sub --jq '.use_immutable_subject // false')
# ↑ 取得に失敗すると false になるので、値を echo して確かめる。use_default が false（sub のキーを独自に指定）の場合はこの組み立てでは合わない。owner / repo 名の大文字小文字は GitHub の実際の表記に合わせる
echo "immutable_subject=$TF_VAR_github_oidc_immutable_subject"
# ADC が無いときだけトークンを渡す（トークンは 1 時間で切れるので、長い作業では途中で export し直す）
gcloud auth application-default print-access-token > /dev/null 2>&1 \
  || export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
```

## bootstrap の初回 apply

前提: optionchan の BigQuery（データセット `optionchan_tokyo`）が同じプロジェクトにあり、上の API が有効。所有者（プロジェクトの owner。`roles/iap.admin` と、データセットの IAM を変える権限を持つ）の gcloud で行う。

**0. 作業前の記録**（スクラッチに保存し、貼らない）。データセットの access は optionchan の付与を消していないことの確認に使う。

```sh
SCRATCH=$(mktemp -d)
bq show --format=json "$P:optionchan_tokyo" | jq '.access' > "$SCRATCH/access-before.json"
jq length "$SCRATCH/access-before.json"
# authorized view / routine / dataset のエントリが無いこと（0）。google プロバイダの google_bigquery_dataset_iam_member は
# access を IAM ポリシーとして読み書きするので、これらのエントリを保持しない（apply で消える）。1 以上なら apply しない
jq '[.[] | select(has("view") or has("routine") or has("dataset"))] | length' "$SCRATCH/access-before.json"
gcloud iam workload-identity-pools providers list --workload-identity-pool=github --location=global --project="$P" \
  --format='value(name.basename(),attributeCondition)' > "$SCRATCH/optionchan-wif-before.txt" 2>/dev/null || true   # optionchan のプール（あれば）
```

**1. bootstrap 用バケットを作る**（state の置き場。Terraform より先に要るので gcloud で作り、`imports.tf` で取り込む）。

```sh
gcloud storage buckets create "gs://$P-sim-tfstate-bootstrap" --project="$P" --location=asia-northeast1 \
  --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$P-sim-tfstate-bootstrap" --versioning
```

**2. ローカルの変数**: `cp infra/bootstrap/local.auto.tfvars.example infra/bootstrap/local.auto.tfvars`（`simulator_iap_members = []` のまま。サービスが無いうちは付与できない）。

**3. init → plan → 要約を確かめる → apply**

```sh
$TF -chdir=infra/bootstrap init -input=false -backend-config="bucket=$P-sim-tfstate-bootstrap"
$TF -chdir=infra/bootstrap plan -input=false -no-color -out=b.tfplan > "$SCRATCH/b-plan.log"
# 要約（アドレスと操作だけ）
$TF -chdir=infra/bootstrap show -json b.tfplan | jq -r '.resource_changes[]
  | select(.change.actions != ["no-op"] or .change.importing)
  | "\(.address): \(.change.actions | join(","))\(if .change.importing then " (import)" else "" end)"'
$TF -chdir=infra/bootstrap apply -input=false b.tfplan
rm -f infra/bootstrap/b.tfplan
```

要約の目安（1 回目、`simulator_iap_members = []`）: **create 23・import 1**（`google_storage_bucket.tfstate["bootstrap"]`。ライフサイクルルールを足す in-place update を伴う）、それ以外の update / delete / replace は 0。

| アドレス | 操作 |
|---|---|
| `google_storage_bucket.tfstate["bootstrap"]` | import（update） |
| `google_storage_bucket.tfstate["prod"]` | create |
| `google_iam_workload_identity_pool.github`、`google_iam_workload_identity_pool_provider.github_actions` | create 2 |
| `google_service_account.tf_plan` / `tf_apply` / `simulator` | create 3 |
| `google_service_account_iam_member.tf_plan_wif` / `tf_apply_wif` / `tf_apply_act_as_simulator` | create 3 |
| `google_project_iam_member.tf_apply_run_admin` / `tf_plan_run_viewer` / `simulator_job_user` | create 3 |
| `google_bigquery_dataset_iam_member.simulator_reader` | create |
| `google_artifact_registry_repository.simulator` | create |
| `google_artifact_registry_repository_iam_member.tf_apply_writer` / `tf_plan_reader` | create 2 |
| `google_storage_bucket_iam_member.prod_state_plan` / `prod_state_apply` | create 2 |
| `google_project_service.secretmanager` | create |
| `google_secret_manager_secret.ai["api_key"]` / `["oauth_token"]` | create 2 |
| `google_secret_manager_secret_iam_member.simulator_ai["api_key"]` / `["oauth_token"]` | create 2 |

#133 より前に bootstrap を apply 済みなら、AI の資格情報の分は「AI の資格情報（Secret Manager）」の 1 で足す。

目安と違う（特に optionchan のリソースや、ここに無い update / delete / replace が出る）ときは apply しない。optionchan の deploy（`optionchan_tokyo` の IAM を変える apply）と同時に走らせない（データセットの access は読み → 書きで更新されるため）。

**4. 差分 0 の確認**

```sh
$TF -chdir=infra/bootstrap plan -input=false -detailed-exitcode > /dev/null; echo $?   # 0
```

### 確認

ID・メール・プロジェクト番号は表示しない（件数と一致だけを見る）。

```sh
# WIF: 新しいプールのプロバイダの条件がこのリポジトリの数値 ID を含む（1）。optionchan のプロバイダの条件は作業前と同じ（差分なし）
gcloud iam workload-identity-pools providers describe github-actions --workload-identity-pool=sim-github --location=global \
  --project="$P" --format='value(attributeCondition)' | grep -c "$TF_VAR_github_repository_id"
gcloud iam workload-identity-pools providers list --workload-identity-pool=github --location=global --project="$P" \
  --format='value(name.basename(),attributeCondition)' 2>/dev/null | diff -q - "$SCRATCH/optionchan-wif-before.txt" && echo same
# apply SA の借用は 1 件で :environment:prod で終わる
gcloud iam service-accounts get-iam-policy "sa-sim-tf-apply@$P.iam.gserviceaccount.com" --format=json \
  | jq '[.bindings[] | select(.role == "roles/iam.workloadIdentityUser") | .members[]] | (length == 1) and (.[0] | endswith(":environment:prod"))'
# bootstrap 用バケットに CI 用 SA の付与が無い（0）
gcloud storage buckets get-iam-policy "gs://$P-sim-tfstate-bootstrap" --format=json | grep -c 'sa-sim-tf-'
# プロジェクト単位のロール: apply = run.admin、plan = run.viewer、simulator = bigquery.jobUser だけ
for sa in sa-sim-tf-apply sa-sim-tf-plan sa-simulator; do
  printf '%s: ' "$sa"
  gcloud projects get-iam-policy "$P" --flatten=bindings --filter="bindings.members:serviceAccount:$sa@$P.iam.gserviceaccount.com" \
    --format='value(bindings.role)' | paste -sd, -
done
# データセット: 作業前の全エントリを保ったまま sa-simulator の READER が 1 件増える（true）
bq show --format=json "$P:optionchan_tokyo" | jq --slurpfile before "$SCRATCH/access-before.json" \
  '.access as $a | ($before[0] - $a | length) == 0 and ($a - $before[0] | length) == 1 and ([$a[] | select(.role == "READER" and ((.userByEmail // .iamMember // "") | test("sa-simulator@")))] | length) == 1'
```

## GitHub の設定

CI（#36 の plan / apply）が使う値と Environment `prod`。値は表示せず、Terraform の出力からパイプで渡す（WIF プロバイダの完全名はプロジェクト番号を含むので secret にする）。所有者の権限が要る。

```sh
$TF -chdir=infra/bootstrap output -raw wif_provider_name | gh secret set GCP_WIF_PROVIDER -R "$REPO"
$TF -chdir=infra/bootstrap output -raw sa_tf_plan_email  | gh variable set GCP_SA_TF_PLAN -R "$REPO"
$TF -chdir=infra/bootstrap output -raw sa_tf_apply_email | gh variable set GCP_SA_TF_APPLY -R "$REPO"
$TF -chdir=infra/bootstrap output -raw tf_state_bucket   | gh variable set TF_STATE_BUCKET -R "$REPO"
printf '%s' "$P" | gh variable set GCP_PROJECT_ID -R "$REPO"
# Environment prod: main だけ、required reviewer は所有者（自己承認可）
jq -n --argjson id "$(gh api user --jq .id)" '{wait_timer: 0, prevent_self_review: false,
  reviewers: [{type: "User", id: $id}],
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}}' \
  | gh api -X PUT $R/environments/prod --input - > /dev/null
gh api -X POST $R/environments/prod/deployment-branch-policies -f name=main -f type=branch > /dev/null
```

確認（値は表示しない。すべて `true`）:

```sh
gh api $R/actions/variables --jq '[.variables[].name] | contains(["GCP_PROJECT_ID", "GCP_SA_TF_APPLY", "GCP_SA_TF_PLAN", "TF_STATE_BUCKET"])'
gh api $R/actions/secrets --jq '[.secrets[].name] | index("GCP_WIF_PROVIDER") != null'
gh api $R/environments/prod --jq '.deployment_branch_policy == {"protected_branches": false, "custom_branch_policies": true} and ([.protection_rules[] | select(.type == "required_reviewers") | .reviewers[]] | length) == 1'
gh api $R/environments/prod/deployment-branch-policies --jq '[.branch_policies[] | {name, type}] == [{"name": "main", "type": "branch"}]'
gh api $R/branches/main/protection --jq '[.required_status_checks.checks[].context] == ["check"]'   # ブランチ保護は変えない
```

AI を使うときは repository variable `AI_CREDENTIAL`（`api_key` か `oauth_token`）と、任意で `AI_SECRET_VERSION`（版の番号）も設定する。どちらも秘匿値ではない（種類と版の番号だけ。値は Secret Manager）。未設定なら `none`・`latest` として扱う（「AI の資格情報（Secret Manager）」）。

ブランチ保護（`main`、必須 check `check`）はこの手順では変えない。Terraform の検査は `check` job の中にあるので名前は変わらない。

## IAP（OAuth クライアント・サービスエージェント）

- IAP のサービスエージェント（`run.invoker` を付ける先）が無ければ作る（冪等）: `gcloud beta services identity create --service=iap.googleapis.com --project="$P"`
- OAuth クライアントは optionchan のビューアーと共用する。リージョン単位に設定済みかを `gcloud iap settings get --resource-type=cloud-run --region=asia-northeast1 --project="$P"` で確かめる（サービス単位の設定だった場合は `--service=simulator` で同じクライアントを設定する）。**clone して自分のプロジェクトで使う人**で、まだビューアーを作っていなければ、optionchan の runbook「ビューアー」の手順（同意画面・クライアントの作成・`gcloud iap settings set`）が丸ごと要る。クライアントのシークレットは Terraform・リポジトリに入れない
- プロジェクト単位の `roles/iap.httpsResourceAccessor` はサービス simulator にも継承される（`gcloud projects get-iam-policy "$P" --flatten=bindings --filter=bindings.role:roles/iap.httpsResourceAccessor --format='value(bindings.members)' | wc -l` で件数を見る）

## 2 回目の apply（閲覧者）

サービス simulator（`infra/prod`、#36）が作られた後に、IAP 越しに開けるユーザーを入れる。

```sh
# infra/bootstrap/local.auto.tfvars（コミットしない）
#   simulator_iap_members = ["user:<メール>"]
$TF -chdir=infra/bootstrap plan -input=false -no-color -out=b.tfplan > "$SCRATCH/b-plan.log"
$TF -chdir=infra/bootstrap show -json b.tfplan | jq -r '[.resource_changes[] | select(.change.actions != ["no-op"]) | .change.actions | join(",")] | group_by(.) | map("\(.[0]): \(length)") | .[]'
$TF -chdir=infra/bootstrap apply -input=false b.tfplan; rm -f infra/bootstrap/b.tfplan
```

目安は create 1 件 / 閲覧者（`google_iap_web_cloud_run_service_iam_member.simulator_access[...]`）、他 0。アドレスにメールが入るので、要約は件数だけを記録する。`allUsers`・`allAuthenticatedUsers`・`domain:` は変数の検証で拒否される。閲覧者を外すときは一覧から消して同じ手順（delete 1）。

確認は prod の「確認」の閲覧者の種類別の件数（と `allUsers` / `allAuthenticatedUsers` の 0 件）。

## prod（Cloud Run simulator）

`infra/prod/simulator.tf`（#36）。イメージはリポジトリ直下の `Dockerfile`（API と画面の `dist/` を 1 つに）。

| 項目 | 値 |
|---|---|
| サービス | `simulator`（`var.region`、既定 `asia-northeast1`）、`iap_enabled = true`、`ingress = INGRESS_TRAFFIC_ALL`（IAP は run.app の URL に掛かる）、`invoker_iam_disabled = false`、`deletion_protection = false` |
| 実行 | 第 1 世代、CPU 1・512Mi・リクエスト中だけ CPU、同時実行 8、0〜2 インスタンス、60 秒、SA `sa-simulator`、起動プローブ `/healthz`（BigQuery に触れない） |
| イメージ | `<region>-docker.pkg.dev/<PROJECT_ID>/simulator/simulator`。タグは入力パスの git のハッシュ `src-<20hex>`（`.github/scripts/image.sh simulator tag`）、Cloud Run には digest で渡す。gunicorn 1 ワーカー・8 スレッド（API のキャッシュ・single-flight をインスタンス内で共有）、uid 10001、`STATIC_DIR=/app/static` |
| 環境変数 | `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`（Terraform の変数 `project_id`・`bq_dataset`・`bq_location`）。`MAX_BYTES_BILLED`・`DATA_SOURCE` は API の既定。変数 `ai_credential` が `none` 以外のときだけ `AI_CREDENTIAL`（種類）と、`ANTHROPIC_API_KEY` か `ANTHROPIC_AUTH_TOKEN` の片方（Secret Manager の参照。版は `ai_secret_version`） |
| 権限 | `run.invoker` = IAP のサービスエージェント（`service-<番号>@gcp-sa-iap…`。番号は `data "google_project"`）だけ。閲覧者（`iap.httpsResourceAccessor`）は bootstrap の `simulator_iap_members` |

outputs は置かない（サービスの URL はプロジェクト番号由来の文字列を含む）。

### CI / CD の流れ

- **PR**（`ci.yml`）: `check` job が `infra/prod` の validate / test、`.dockerignore` の許可リストと `image.sh simulator paths` の一致、イメージのビルドと検査（`.github/scripts/image-check.sh`。import・非 root・`.git` / `node_modules` / テスト / fixture / `infra` / `.env*` / `*.tfvars` を含まない・同梱の `index.html` の CSP 検査・`/healthz` / `/` / `/assets/*` が 200 で CSP ヘッダ付き）を行う。別 job `terraform-plan` が同じリポジトリのブランチの PR だけ plan SA で `plan -lock=false` し、要約（アドレスと操作・件数、イメージが既存か未作成か）を step summary に書く（必須 check ではない。fork の PR では動かない）
- **deploy**（`deploy.yml`。`main` への push と `workflow_dispatch`、`concurrency: terraform-prod`）: `plan` job（plan SA）→ 差分があるときだけ `apply` job（Environment `prod`。所有者が GitHub で承認）→ イメージが未作成なら GCP の認証より前にビルド・検査 → apply SA で push → digest であることを確かめて `terraform apply`。plan ファイルは artifact で渡さず、承認後にもう一度 plan して適用する。失敗時のログはマスクして末尾だけ
- plan・deploy は repository variables `AI_CREDENTIAL`・`AI_SECRET_VERSION` を `TF_VAR_ai_credential`・`TF_VAR_ai_secret_version` で渡す（未設定は `none`・`latest`）
- repository variables（`GCP_PROJECT_ID`・`TF_STATE_BUCKET`・`GCP_SA_TF_PLAN`）が無い（clone して variables を設定していない）ときは、plan も deploy も notice を出して何もしない

### prod の state の初期化（所有者、一度だけ。最初の PR の前）

`sa-sim-tf-plan` は prod の state を読むだけなので、state が無いと CI の `terraform init` が空の state を書けずに失敗する。所有者の資格情報で一度だけ `init` して空の state を作る（「共通の変数」を設定してから）。

```sh
$TF -chdir=infra/prod init -input=false -backend-config="bucket=$P-sim-tfstate"
gcloud storage ls "gs://$P-sim-tfstate/prod/"   # default.tfstate が 1 件
```

### 初回デプロイ

前提: bootstrap の初回 apply・GitHub の設定・IAP（OAuth クライアントがリージョン単位に設定済み、サービスエージェントが作成済み）・prod の state の初期化が済んでいる。

1. **PR**: `check` が green、`terraform-plan` の要約が下の目安どおりであることを見てからマージする
2. **作業前の記録**（スクラッチに保存し、貼らない）: `SCRATCH=${SCRATCH:-$(mktemp -d)}; gcloud run services list --project="$P" --format='value(metadata.name,status.latestReadyRevisionName)' > "$SCRATCH/run-before.txt"`
3. **deploy**: マージで `deploy` が動く。`plan` job の要約が下の目安どおりなら、所有者が GitHub の Actions の画面で Environment `prod` の `apply` job を承認する。`apply` job がイメージをビルド・検査・push し、digest で apply する
4. **確認**（下の「確認」）→ **bootstrap の 2 回目の apply**（閲覧者。「2 回目の apply（閲覧者）」）

plan の要約の目安:

| 場面 | 要約 |
|---|---|
| 初回（PR・deploy の plan） | create 2（`google_cloud_run_v2_service.simulator`、`google_cloud_run_v2_service_iam_member.simulator_iap_invoker`）、update / delete / replace 0、イメージは「未作成」 |
| apply 後 | 差分なし |
| 以後、アプリ（`ui`・`model`・`data`・`api/src` など入力パス）だけを変えた PR | update 1（`google_cloud_run_v2_service.simulator`）、イメージは「未作成」 |
| Terraform も入力パスも変えない PR | 差分なし（deploy の `apply` job は動かない） |

目安と違う（特に optionchan のサービス `ingest` / `viewer` や、ここに無い delete / replace が出る）ときはマージ・承認しない。

### 確認

URL・プロジェクト番号・メールは表示・記録しない（件数と pass / fail だけ）。

```sh
L=asia-northeast1
# 差分 0（exit 0）。イメージは Artifact Registry の digest
eval "$(GCP_PROJECT_ID=$P .github/scripts/image.sh simulator resolve | grep '^image=')"
TF_VAR_project_id=$P TF_VAR_simulator_image=$image $TF -chdir=infra/prod plan -lock=false -input=false -detailed-exitcode > /dev/null; echo $?
# 構成（v2 API）: true、INGRESS_TRAFFIC_ALL、false、sa-simulator、0、2、true、[GCP_PROJECT,BQ_DATASET,BQ_LOCATION]
# （AI_CREDENTIAL を設定したら envs に AI_CREDENTIAL と ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN の片方、wif なら ANTHROPIC_* の ID が足される）
curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v2/projects/$P/locations/$L/services/simulator" \
  | jq -c '{iap: .iapEnabled, ingress, invoker_check_disabled: (.invokerIamDisabled // false), sa: (.template.serviceAccount | split("@")[0]),
            min: (.template.scaling.minInstanceCount // 0), max: .template.scaling.maxInstanceCount,
            digest: (.template.containers[0].image | test("@sha256:[0-9a-f]{64}$")), envs: [.template.containers[0].env[].name]}'
# run.invoker は IAP のサービスエージェント 1 件だけ: [{"role":"roles/run.invoker","m":["serviceAccount:service-<num>@gcp-sa-iap.iam.gserviceaccount.com"]}]
gcloud run services get-iam-policy simulator --region=$L --project="$P" --format=json \
  | jq -c '[.bindings[] | {role, m: [.members[] | sub("[0-9]+"; "<num>")]}]'
# 未認証の呼び出しが止まる（200 でない）。URL は表示しない。/api/chain と / は IAP の 302（ログインへ）。
# /healthz は Cloud Run の予約パス（末尾が z）なので外からは 404（起動プローブはコンテナの中で届く）
U=$(gcloud run services describe simulator --region=$L --project="$P" --format='value(status.url)')
for path in /healthz /api/chain /; do curl -s -o /dev/null -w '%{http_code}\n' "$U$path"; done
# allUsers / allAuthenticatedUsers がサービス・IAP・プロジェクトの IAM のどれにも無い（0 0 0）
PUB='[.bindings[]?.members[] | select(. == "allUsers" or . == "allAuthenticatedUsers")] | length'
gcloud run services get-iam-policy simulator --region=$L --project="$P" --format=json | jq "$PUB"
gcloud iap web get-iam-policy --resource-type=cloud-run --service=simulator --region=$L --project="$P" --format=json | jq "$PUB"
gcloud projects get-iam-policy "$P" --format=json | jq "$PUB"
# サービス単位の閲覧者（iap.httpsResourceAccessor）の種類別の件数。user: / group: だけで 1 件以上（例 {"user":1}）。メールは出さない
gcloud iap web get-iam-policy --resource-type=cloud-run --service=simulator --region=$L --project="$P" --format=json \
  | jq -c '[.bindings[]? | select(.role == "roles/iap.httpsResourceAccessor") | .members[] | split(":")[0]] | group_by(.) | map({key: .[0], value: length}) | from_entries'
# デプロイ後 10 分の ERROR ログ 0 件
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND severity>=ERROR' \
  --project="$P" --freshness=10m --limit=20 --format='value(timestamp,severity,jsonPayload.message)' | wc -l
# optionchan の ingest / viewer の最新リビジョンが作業前と同じ
gcloud run services list --project="$P" --format='value(metadata.name,status.latestReadyRevisionName)' \
  | grep -vE '^simulator[[:space:]]' | diff -q - <(grep -vE '^simulator[[:space:]]' "$SCRATCH/run-before.txt") && echo same
```

ブラウザ（閲覧者を入れた後。所有者はプロジェクト単位の `iap.httpsResourceAccessor` を継承していれば先に開ける）: `/` と `/api/chain` を開き、開発者ツールのコンソールに CSP の違反（`Refused to …`）が出ないこと、`/api/chain` の `reason` と時刻だけを記録する（`api/README.md`「本番での `reason` の確認」）。

### 更新

アプリの変更は PR → マージ → deploy の `apply` job の承認で反映される（入力パスが変わるとタグが変わり、plan に `simulator` の update 1 が出る）。ベースイメージ（`Dockerfile` の `ARG`）は公開から 2 週間以上たった版の digest にする。

### 切り戻し・撤去

| 段階 | 手段 | 影響 |
|---|---|---|
| 緊急に閉じる | `gcloud run services remove-iam-policy-binding simulator --region=$L --project="$P" --role=roles/run.invoker --member="serviceAccount:service-$(gcloud projects describe "$P" --format='value(projectNumber)')@gcp-sa-iap.iam.gserviceaccount.com"`（IAP を通っても 403 になる）。次の apply で戻るので、続けて撤去か修正の PR を出す | simulator が開けなくなるだけ。optionchan は影響なし |
| 前の版に戻す | 原因のコミットを revert する PR → deploy（タグが前の入力に戻り、Artifact Registry の既存イメージの digest で update 1）。急ぐときは `gcloud run services update-traffic simulator --region=$L --project="$P" --to-revisions=<旧リビジョン>=100`（Terraform のトラフィックは最新 100% なので次の apply で戻る。続けて revert の PR で揃える） | 1 回の apply で新しいリビジョン |
| 初回デプロイが途中で失敗 | サービスはできたが `run.invoker` が無い状態は公開にならない（IAP を通っても 403）。原因を直す PR → deploy。IAP の有効化で失敗したら `gcloud iap settings get --resource-type=cloud-run --region=$L --project="$P"` でクライアントの設定を確かめ、deploy をやり直す | 公開にはならない |
| 撤去 | `infra/prod/simulator.tf` の 2 リソースを消す PR → deploy（delete 2。`deletion_protection = false`）→ bootstrap の `simulator_iap_members` を `[]` にして apply。#36 の PR の revert は `deploy.yml` も消えて apply されないので、撤去には使わない。Artifact Registry のイメージはクリーンアップポリシーで消える | optionchan は影響なし |

## AI の資格情報（Secret Manager）

AI アドバイザー（`docs/ai-advisor.md`）が Claude を呼ぶための資格情報（#133・#184、`docs/adr-0001-ai-credentials-secret-manager.md`）。API キー・サブスクリプションの OAuth トークン（`claude setup-token`）・Anthropic の WIF（鍵なし。下の「wif（Anthropic の WIF）」）に対応し、使うのはどれか 1 つだけ。1〜7 は Secret Manager を使う `api_key` / `oauth_token` の手順。

| 種類（`AI_CREDENTIAL`） | シークレット | Cloud Run の環境変数 |
|---|---|---|
| `none`（既定。未設定も同じ） | — | 何も足さない（AI は無効） |
| `api_key` | `simulator-anthropic-api-key` | `AI_CREDENTIAL=api_key`、`ANTHROPIC_API_KEY`（参照） |
| `oauth_token` | `simulator-anthropic-oauth-token` | `AI_CREDENTIAL=oauth_token`、`ANTHROPIC_AUTH_TOKEN`（参照） |
| `wif`（#184） | —（使わない） | `AI_CREDENTIAL=wif`、`ANTHROPIC_FEDERATION_RULE_ID`・`ANTHROPIC_ORGANIZATION_ID`（必須）・`ANTHROPIC_SERVICE_ACCOUNT_ID`・`ANTHROPIC_WORKSPACE_ID`（任意。空なら載せない）を素の値で |

- シークレットの入れ物 2 つ（東京だけに複製、`deletion_policy = "PREVENT"`）と、シークレット単位の `roles/secretmanager.secretAccessor`（`sa-simulator` だけ）は `infra/bootstrap/ai_credentials.tf`。apply SA・plan SA には Secret Manager の権限を付けない
- **値（版）は Terraform に入れない**（state・plan・Cloud Run の設定に値が載らない）。所有者が標準入力から登録する
- キーとトークンを同時に環境変数に置かない（両方あると SDK は `X-Api-Key` と `Authorization: Bearer` の両方を送り、取り違えの元になる。中継（#134）は両方あると AI を無効にし、WARNING `ai_disabled`（`reason: ai_credential_conflict`）を出す）。`infra/prod` の変数 `ai_credential` 1 つで選び、テストで片方だけであることを確かめる
- Cloud Run は環境変数の参照をインスタンスの起動時に解決する。**参照する版が無い・無効だとインスタンスが起動せず simulator 全体が開けない**。順序は必ず「値の登録 → `AI_CREDENTIAL` の設定」、戻すときは「`none` の deploy → 版の無効化」
- deploy 時に Cloud Run は実行 SA（`sa-simulator`）がシークレットを読めるかを検査する。bootstrap の apply より先に `AI_CREDENTIAL` を設定すると deploy が失敗する（動いているリビジョンはそのまま）

**1. bootstrap の apply**（所有者。「共通の変数」を設定してから）

```sh
SCRATCH=${SCRATCH:-$(mktemp -d)}
$TF -chdir=infra/bootstrap plan -input=false -no-color -out=b.tfplan > "$SCRATCH/b-plan.log"
$TF -chdir=infra/bootstrap show -json b.tfplan | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.address): \(.change.actions | join(","))"'
$TF -chdir=infra/bootstrap apply -input=false b.tfplan; rm -f infra/bootstrap/b.tfplan
$TF -chdir=infra/bootstrap plan -input=false -detailed-exitcode > /dev/null; echo $?   # 0
```

要約の目安: **create 5**（`google_project_service.secretmanager`、`google_secret_manager_secret.ai["api_key"]`・`["oauth_token"]`、`google_secret_manager_secret_iam_member.simulator_ai["api_key"]`・`["oauth_token"]`）、update / delete / replace 0。目安と違うときは apply しない。API の有効化の直後は伝搬が間に合わずシークレットの作成が失敗することがある。そのときは少し待ってもう一度 plan → apply する。

**2. 値の登録**（所有者。使う方だけ。画面・シェルの履歴に出さない）

```sh
# API キー（Claude Console で作ったもの）
read -rs V && printf '%s' "$V" | gcloud secrets versions add simulator-anthropic-api-key --project "$P" --data-file=-; unset V
# OAuth トークン（claude setup-token で出したもの。有効期間は 1 年）
read -rs V && printf '%s' "$V" | gcloud secrets versions add simulator-anthropic-oauth-token --project "$P" --data-file=-; unset V
```

`read -rs` は入力を表示しない。値をコマンドラインの引数・ファイル・`--data-file` のパスで渡さない。

**3. 選んで deploy**（所有者）

```sh
gh variable set AI_CREDENTIAL -R "$REPO" --body api_key      # または oauth_token
# 任意: 版を番号で固定する（下の「版の指定」）
# gh variable set AI_SECRET_VERSION -R "$REPO" --body 1
gh workflow run deploy.yml -R "$REPO" --ref main
```

`plan` job の要約が **update 1**（`google_cloud_run_v2_service.simulator`）、他 0 なら Environment `prod` の `apply` job を承認する。

**4. 確認**（値は表示しない）

```sh
L=asia-northeast1
for s in simulator-anthropic-api-key simulator-anthropic-oauth-token; do
  gcloud secrets describe $s --project "$P" --format='value(name.basename(),replication.userManaged.replicas[0].location)'
  gcloud secrets versions list $s --project "$P" --format='value(name.basename(),state)'   # 使う方に ENABLED が 1 件以上
  # secretAccessor は sa-simulator の 1 件だけ: [{"role":"roles/secretmanager.secretAccessor","n":1,"sim":1}]
  gcloud secrets get-iam-policy $s --project "$P" --format=json \
    | jq -c '[.bindings[]? | {role, n: (.members | length), sim: ([.members[] | select(startswith("serviceAccount:sa-simulator@"))] | length)}]'
done
# 環境変数の名前と、資格情報が参照（valueSource）で値を持たないこと
curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v2/projects/$P/locations/$L/services/simulator" \
  | jq -c '[.template.containers[0].env[] | {name, ref: (.valueSource.secretKeyRef.secret // null | if . then split("/")[-1] else null end), version: .valueSource.secretKeyRef.version, has_value: (.value != null)}]
           | map(select(.name | startswith("A")))'
```

期待（`api_key` のとき）: `AI_CREDENTIAL` が `has_value: true`、`ANTHROPIC_API_KEY` が `ref: "simulator-anthropic-api-key"`・`has_value: false`、`ANTHROPIC_AUTH_TOKEN` は無い。デプロイ後のエラーログ 0 件は prod の「確認」と同じ。

**5. 版の指定とローテーション**

- 既定の `latest` は、インスタンスが起動したときの最新の版を読む。版を足すと新しいインスタンスから新しい値になり、古いインスタンスはアイドルで消える（最小 0 インスタンス）まで旧値のまま。値の差し替えに deploy が要らない
- Google は環境変数では版の番号の固定を推奨している。固定するなら `AI_SECRET_VERSION` に番号を入れて deploy する（版を足すたびに variable と deploy が要るが、どの値で動いているかが deploy で決まる）
- ローテーション: 2 で版を足す → すぐに切り替えたいなら `AI_SECRET_VERSION` を新しい番号にして deploy（`latest` のままなら `gh workflow run` では差分が出ないので、急ぐときは番号で） → 新しい値で動くことを確かめてから旧版を `gcloud secrets versions disable <番号> --secret=<シークレット> --project "$P"`。OAuth トークンは 1 年で切れるので期限の前に作り直す
- `latest` は「最も新しく作った版」を指し、無効な版を飛ばして古い版に戻らない。**最新の版を無効にする（誤った値を登録して disable するなど）ときは、先に `AI_SECRET_VERSION` を有効な版の番号にして deploy するか `AI_CREDENTIAL=none` で deploy する**（`latest` のままだと新しいインスタンスが起動しない）

**6. 切り戻し**

| 状況 | 手段 |
|---|---|
| deploy 後に起動しない・AI を止めたい | `gh variable set AI_CREDENTIAL -R "$REPO" --body none`（または `gh variable delete AI_CREDENTIAL`）→ `gh workflow run deploy.yml` → 承認（環境変数が 3 つに戻る）。急ぐときは prod の「切り戻し・撤去」の `update-traffic` で旧リビジョンへ |
| 鍵・トークンが漏れた | **最初に Anthropic 側で失効**（API キーは Claude Console で無効化。トークンは作り直す）→ `AI_CREDENTIAL=none` で deploy → `gcloud secrets versions disable` / `destroy`。順序を逆にする（版を先に無効にする）と、参照している simulator のインスタンスが起動しなくなる |
| 付与の誤り | 修正の PR → 1 と同じ plan / apply。急ぐときは `gcloud secrets remove-iam-policy-binding`（あとで Terraform と揃える） |

**7. 撤去**（この順で）

1. `AI_CREDENTIAL` を `none` にして deploy する（環境変数が 3 つに戻る）
2. 管理から外す（シークレットは `PREVENT` なので Terraform では消さない）: `$TF -chdir=infra/bootstrap state rm 'google_secret_manager_secret_iam_member.simulator_ai'` と `$TF -chdir=infra/bootstrap state rm 'google_secret_manager_secret.ai'`
3. `ai_credentials.tf` を消す PR をマージし、所有者が plan → apply する。要約は `google_project_service.secretmanager` の delete 1 だけ（`ABANDON`・`disable_on_destroy = false` なので管理から外れるだけで API は止まらない）。他に差分が出たら apply しない
4. `gcloud secrets delete <シークレット> --project "$P"`（付与はシークレットと一緒に消える）。API を止めるなら `gcloud services disable secretmanager.googleapis.com`

### wif（Anthropic の WIF。鍵なし）

Cloud Run の実行 SA（`sa-simulator`）の Google の ID トークン（メタデータサーバーから、audience `https://api.anthropic.com`・`format=full` = `email` の claim を含む）を、中継が SDK の `WorkloadIdentityCredentials` で Anthropic の短命トークンに交換する（#184。公式の手順は Claude のドキュメントの「Use WIF with Google Cloud」）。長命の鍵が無いので、登録・ローテーション・Secret Manager の版の管理が要らない。費用は API の従量課金で、計上（予約・精算・Firestore）は `api_key` と同じ（「AI の費用の計上（Firestore）」の bootstrap が要る）。GCP 側の IAM の付与・API の有効化は要らない（実行 SA は自分の ID トークンをメタデータサーバーから取れる）。

**1. Claude Console**（所有者。Anthropic の組織の admin）: Workload identity の「Connect workload」で Google Cloud のタイルを選び、ウィザードで次を作る。

- issuer: `https://accounts.google.com`（discovery）
- Anthropic のサービスアカウント（simulator 専用。ワークスペースも simulator 専用に分けると月の上限が効く）
- federation rule: audience `https://api.anthropic.com`、claims の `sub` = `sa-simulator` の数値の unique ID と `email` = `sa-simulator` のメールの **両方を完全一致**（`subject_prefix` やワイルドカードは使わない。任意の Google の SA に一致してしまう）

```sh
# unique ID（数値。表示はするが記録・コミットしない）
gcloud iam service-accounts describe "sa-simulator@$P.iam.gserviceaccount.com" --project "$P" --format='value(uniqueId)'
```

**2. 変数の登録と deploy**（所有者。値は Console の ID。秘密ではないが個人の値なのでリポジトリ・Issue に書かない）

```sh
gh variable set ANTHROPIC_FEDERATION_RULE_ID -R "$REPO" --body '<federation rule の ID>'
gh variable set ANTHROPIC_ORGANIZATION_ID -R "$REPO" --body '<組織の UUID>'
gh variable set ANTHROPIC_SERVICE_ACCOUNT_ID -R "$REPO" --body '<サービスアカウントの ID>'   # 任意
gh variable set ANTHROPIC_WORKSPACE_ID -R "$REPO" --body '<ワークスペースの ID>'           # 任意（ルールが複数のワークスペースを持つときは必須）
gh variable set AI_CREDENTIAL -R "$REPO" --body wif
gh workflow run deploy.yml -R "$REPO" --ref main
```

`plan` job の要約が **update 1**（`google_cloud_run_v2_service.simulator`）、他 0 なら `apply` job を承認する。`AI_CREDENTIAL=wif` でルール ID・組織 ID が空、または形が違うと plan が失敗する（動いているリビジョンはそのまま）。`ANTHROPIC_*` の variables は `AI_CREDENTIAL` が `wif` のときだけ環境変数に載り、形の検査も `wif` のときだけなので、残したまま `api_key` / `oauth_token` に切り替えてよい。Terraform は変数の検査に落ちるとエラーに値を表示するので、CI の terraform の job は最初に `.github/scripts/mask-wif-ids.sh`（`::add-mask::`）で ID を伏せ、失敗時のログ末尾の `MASK_SED` も `var.anthropic_* is "…"`・UUID・`fdrl_` などの形を伏せる（`.github/scripts/mask-wif-ids.test.sh`）。

**3. 確認**（ID の値は表示しない）

```sh
L=asia-northeast1
# 環境変数の名前と、Secret の参照が無いこと（AI_CREDENTIAL と ANTHROPIC_* が has_value: true、ref: null）
curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v2/projects/$P/locations/$L/services/simulator" \
  | jq -c '[.template.containers[0].env[] | {name, ref: (.valueSource.secretKeyRef.secret // null), has_value: (.value != null)}] | map(select(.name | startswith("A")))'
# 1 回の要求のあと（ブラウザで AI を使う）: ai_request の error が null、ai_disabled が無い
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND (jsonPayload.event="ai_request" OR jsonPayload.event="ai_disabled")' \
  --project "$P" --freshness=30m --format='value(jsonPayload.event,jsonPayload.credential,jsonPayload.error,jsonPayload.error_type,jsonPayload.reason)'
```

期待: ブラウザ（IAP のログイン済み）で `/api/ai/status` が `"credential":"wif"`・`"counted":true`。`ai_request` が `wif` で `error` が空。`upstream_auth` で `error_type` が `WorkloadIdentityError` ならルールの不一致（Console の Workload identity の認証の履歴に理由が出る。多いのは `email` の claim の欠落と `sub` の取り違え）、`IdentityTokenError` ならメタデータサーバーから ID トークンが取れていない。`ai_disabled` の `reason` が `ai_credential_conflict` なら `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` が残っている、`ai_credential_missing` / `ai_wif_invalid` なら ID が無い・形が違う。

**4. 切り戻し**

| 状況 | 手段 |
|---|---|
| 交換が通らない・AI を止めたい | `gh variable set AI_CREDENTIAL -R "$REPO" --body none`（または前の `api_key` / `oauth_token`。版が登録済みであること）→ `gh workflow run deploy.yml` → 承認。wif は起動時に何も解決しないので、ID の誤りで simulator 全体が起動しなくなることはない（AI だけが失敗する） |
| SA・ルールを止めたい | Claude Console で federation rule を無効化・削除する（交換したトークンはルールの `token_lifetime_seconds` で切れる）→ `AI_CREDENTIAL=none` で deploy |
| 撤去 | `AI_CREDENTIAL=none` で deploy → `gh variable delete ANTHROPIC_FEDERATION_RULE_ID`（他の 3 つも）→ Console でルール・サービスアカウントを削除 |

**注意**: サブスクリプションの OAuth トークンをこのアプリから使ってよいかは Anthropic の規約（Claude Code の Legal and compliance の「Authentication and credential use」）を利用者が確かめる。製品・サービスとして提供する場合は API キーを使う。

## AI の費用の計上（Firestore）

AI の中継（#134）の 1 日の上限（既定 $3、JST の日）を数える場所（`docs/adr-0004-ai-spend-counter-firestore.md`）。最小 0・最大 2 インスタンスの Cloud Run をまたいで数えるため、Firestore の **名前つき DB** `simulator-ai`（Native モード・`asia-northeast1`）の文書 `ai_spend/<YYYY-MM-DD>` に計上額（µUSD の整数）と回数を置く。`AI_CREDENTIAL=api_key` のときに使い（`AI_BUDGET_STORE` の既定 `firestore`）、`oauth_token` は数えない（読み書きしない）。

- DB と付与は `infra/bootstrap/ai_budget.tf`（所有者の apply）。`sa-simulator` に `roles/datastore.user` を **IAM 条件 `resource.name == "projects/<PROJECT_ID>/databases/simulator-ai"` つき** で付ける（追加型。既存の `(default)` DB には及ばない）。apply SA・plan SA には付けない
- DB は削除保護つき（`DELETE_PROTECTION_ENABLED`）、Terraform から外しても消さない（`deletion_policy = "ABANDON"`）
- Firestore の API は optionchan が有効にしている前提（付録 B）。Cloud Run の環境変数は増えない（DB 名は `api/src/simulator_api/settings.py` の定数、プロジェクトは `GCP_PROJECT`）
- 読めない・書けない（付与の誤り・API の停止・5 秒のタイムアウト）ときは、中継は 503 `unavailable` を返して Anthropic を呼ばない（閉じる側）。ログは `ai_request` の `error: unavailable` と例外の型名
- 費用: 名前つき DB は無料枠の外で、1 要求あたり読み 1〜2・書き 1〜2（月に 1 セント未満の見込み）

**1. bootstrap の apply**（所有者。「AI の資格情報」の 1 と同じコマンド）

要約の目安: **create 2**（`google_firestore_database.ai_budget`・`google_project_iam_member.simulator_ai_budget`）。「AI の資格情報」の bootstrap がまだなら、その create 5 と合わせて **create 7**。update / delete / replace 0。目安と違うときは apply しない。

**2. Console の月の上限**（所有者の手作業）: Claude Console で simulator 専用のワークスペースを作り、月の上限（日の上限 × 31 程度。既定なら $93）を設定して、そのワークスペースの API キーを「AI の資格情報」の 2 で登録する。中継の日の上限は Firestore が読めて初めて効くので、二重の安全弁にする

**3. 順序**: bootstrap の apply（Firestore と資格情報の入れ物）→ 値の登録 → Console の月の上限 → `AI_CREDENTIAL` の設定と deploy（「AI の資格情報」の 3）→ 4 の確認

**4. 確認**（値は表示しない）

```sh
gcloud firestore databases describe --database=simulator-ai --project "$P" \
  --format='value(type,locationId,deleteProtectionState)'   # FIRESTORE_NATIVE asia-northeast1 DELETE_PROTECTION_ENABLED
# 付与は sa-simulator の 1 件だけで、条件つき
gcloud projects get-iam-policy "$P" --format=json \
  | jq -c '[.bindings[] | select(.role == "roles/datastore.user") | {n: (.members | length), cond: .condition.expression}]'
# 有効にした後の 1 回の要求のあと: 今日（JST）の計上が増えていること（中身は µUSD の整数）
D=$(TZ=Asia/Tokyo date +%F)
curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/$P/databases/simulator-ai/documents/ai_spend/$D" \
  | jq -c '{charged: .fields.charged_micro_usd.integerValue, requests: .fields.requests.integerValue}'
```

**5. 切り戻し・撤去**

| 状況 | 手段 |
|---|---|
| 中継が 503 `unavailable` を返し続ける | 4 で付与の条件・DB を確かめる。AI を止めるなら「AI の資格情報」の切り戻し（`AI_CREDENTIAL=none` で deploy） |
| 計上を手で戻す（誤った計上） | Console の Firestore（DB `simulator-ai`）で `ai_spend/<日付>` の `charged_micro_usd` を直す。日が変われば新しい文書になる |
| 撤去 | `AI_CREDENTIAL=none` で deploy → `ai_budget.tf` を消す PR → 所有者の plan / apply（付与の delete 1。DB は `ABANDON` で管理から外れるだけ）→ 消すなら `gcloud firestore databases update --database=simulator-ai --delete-protection-state=DISABLED --project "$P"`（変更系。所有者）→ `gcloud firestore databases delete --database=simulator-ai --project "$P"` |

## `run.admin` の影響範囲

Cloud Run のサービスを作るには、プロジェクト単位の `roles/run.admin` が要る（サービス単位の付与では作成できない）。このため `sa-sim-tf-apply` は optionchan のサービス（`ingest` / `viewer`）も変更・削除できる。逆に optionchan の apply SA も simulator を変更できる（対称）。緩和策:

- `sa-sim-tf-apply` を借用できるのは Environment `prod`（`main` のみ・所有者の承認必須）の job だけ（WIF の subject で固定）
- state を分ける（simulator の prod の state には optionchan のリソースが入らないので、Terraform が optionchan のサービスを変えることはない）。plan の要約に optionchan のサービスが出たら承認しない
- `sa-sim-tf-plan` の `roles/run.viewer` もプロジェクト単位なので、optionchan の Cloud Run の設定（環境変数の名前・値を含む）を読める（optionchan の plan SA と同等。秘匿値は環境変数の値に置かない。AI の資格情報は Secret Manager の参照だけで、plan SA が読めるのは参照の名前と版だけ）
- `sa-sim-tf-apply` は `run.admin` と `sa-simulator` の `serviceAccountUser` を持つので、承認済みの deploy で任意のイメージを `sa-simulator` で動かせば AI の資格情報を読める。新しい付与ではなく既存の信頼境界（Environment `prod` の承認）の内側（`docs/adr-0001-ai-credentials-secret-manager.md`）

## 切り戻し・撤去

- 権限の過不足（コードの誤り）: 修正の PR → マージ → 「bootstrap の初回 apply」の 3〜4（plan の要約を確かめてから apply）
- データセットの付与だけを外す: `simulator_reader` を消す PR → apply（delete 1）。急ぐときは所有者が `bq` で `optionchan_tokyo` の access から `sa-simulator` の 1 件を外し、あとで Terraform と揃える
- AI の資格情報の撤去は「AI の資格情報（Secret Manager）」の 7
- 撤去: SA・プール・Artifact Registry は `deletion_policy = "PREVENT"`、バケットは `prevent_destroy` なので Terraform では消えない。`$TF -chdir=infra/bootstrap state rm <アドレス>` で管理から外してから gcloud で削除する（`gcloud iam service-accounts delete` / `gcloud iam workload-identity-pools delete` / `gcloud artifacts repositories delete` / `gcloud storage rm -r`）。WIF のプール・プロバイダは削除後 30 日間 ID が予約される（作り直すなら別の ID）
- GitHub: `gh secret delete GCP_WIF_PROVIDER -R "$REPO"`、`gh variable delete <名前> -R "$REPO"`（4 つ）、`gh api -X DELETE $R/environments/prod`

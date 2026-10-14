# infra（Terraform）

option-simulator の GCP リソースを Terraform で管理する（`docs/design.md` 8.3・付録 B）。GCP プロジェクトは optionchan と同じ（データセット `optionchan_tokyo` を同じプロジェクトで読む）。terraform 1.16.4、google プロバイダ 8.4.0 に固定（`versions.tf`、`.terraform.lock.hcl`、`ci.yml`）。ローカルでは `mise exec terraform@1.16.4 -- terraform` で実行する。

| ルート | 中身 | apply する人 | state | state を読める主体 |
|---|---|---|---|---|
| `infra/bootstrap` | tfstate バケット 2 つ（`<PROJECT_ID>-sim-tfstate` / `<PROJECT_ID>-sim-tfstate-bootstrap`）、WIF プール `sim-github` / プロバイダ `github-actions`、SA `sa-sim-tf-plan` / `sa-sim-tf-apply` / `sa-simulator` と権限、Artifact Registry `simulator` とリポジトリ単位の付与、`optionchan_tokyo` の読み取り（`sa-simulator`、非権威的）、IAP の閲覧許可（`simulator_iap_members`） | 所有者がローカルから（CI は fmt / validate / test だけ） | `gs://<PROJECT_ID>-sim-tfstate-bootstrap/bootstrap/` | 所有者（+ プロジェクトの Editor を持つ既定の SA） |
| `infra/prod` | Cloud Run `simulator`（IAP）、IAP のサービスエージェントの `run.invoker` | CI（`.github/workflows/deploy.yml`。Environment `prod` の承認後） | `gs://<PROJECT_ID>-sim-tfstate/prod/` | `sa-sim-tf-plan`（読み取り）、`sa-sim-tf-apply`（読み書き）、所有者 |

- API の有効化は宣言しない（optionchan の bootstrap が有効化済み。二重管理を避ける）。clone 利用者は iam・iamcredentials・sts・artifactregistry・run・iap・bigquery・cloudresourcemanager が有効であることを先に確かめる（`gcloud services list --enabled --project "$P"`）
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

`terraform test` は、bootstrap では公開になる閲覧者（`allUsers`・`allAuthenticatedUsers`・`domain:`）を変数の検証で拒否すること、apply SA を借用できるのが Environment `prod` の subject だけであること、WIF の条件がリポジトリ ID とオーナー ID の両方を含むこと、データセットの読み取りが非権威的な `dataViewer` であること、などを確かめる。prod では IAP が有効（`iap_enabled`・`ingress = INGRESS_TRAFFIC_ALL`・`invoker_iam_disabled = false`）、`run.invoker` が IAP のサービスエージェント 1 件だけ、イメージが digest か `src-<20hex>` のタグ参照だけ（`:latest`・別リポジトリ・別イメージ名を拒否）、Cloud Run の値が `docs/design.md` 8.3 どおり、を確かめる。

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

要約の目安（1 回目、`simulator_iap_members = []`）: **create 18・import 1**（`google_storage_bucket.tfstate["bootstrap"]`。ライフサイクルルールを足す in-place update を伴う）、それ以外の update / delete / replace は 0。

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

## prod（Cloud Run simulator）

`infra/prod/simulator.tf`（#36）。イメージはリポジトリ直下の `Dockerfile`（API と画面の `dist/` を 1 つに）。

| 項目 | 値 |
|---|---|
| サービス | `simulator`（`var.region`、既定 `asia-northeast1`）、`iap_enabled = true`、`ingress = INGRESS_TRAFFIC_ALL`（IAP は run.app の URL に掛かる）、`invoker_iam_disabled = false`、`deletion_protection = false` |
| 実行 | 第 1 世代、CPU 1・512Mi・リクエスト中だけ CPU、同時実行 8、0〜2 インスタンス、60 秒、SA `sa-simulator`、起動プローブ `/healthz`（BigQuery に触れない） |
| イメージ | `<region>-docker.pkg.dev/<PROJECT_ID>/simulator/simulator`。タグは入力パスの git のハッシュ `src-<20hex>`（`.github/scripts/image.sh simulator tag`）、Cloud Run には digest で渡す。gunicorn 1 ワーカー・8 スレッド（API のキャッシュ・single-flight をインスタンス内で共有）、uid 10001、`STATIC_DIR=/app/static` |
| 環境変数 | `GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`（Terraform の変数 `project_id`・`bq_dataset`・`bq_location`）。`MAX_BYTES_BILLED`・`DATA_SOURCE` は API の既定 |
| 権限 | `run.invoker` = IAP のサービスエージェント（`service-<番号>@gcp-sa-iap…`。番号は `data "google_project"`）だけ。閲覧者（`iap.httpsResourceAccessor`）は bootstrap の `simulator_iap_members` |

outputs は置かない（サービスの URL はプロジェクト番号由来の文字列を含む）。

### CI / CD の流れ

- **PR**（`ci.yml`）: `check` job が `infra/prod` の validate / test、`.dockerignore` の許可リストと `image.sh simulator paths` の一致、イメージのビルドと検査（`.github/scripts/image-check.sh`。import・非 root・`.git` / `node_modules` / テスト / fixture / `infra` / `.env*` / `*.tfvars` を含まない・同梱の `index.html` の CSP 検査・`/healthz` / `/` / `/assets/*` が 200 で CSP ヘッダ付き）を行う。別 job `terraform-plan` が同じリポジトリのブランチの PR だけ plan SA で `plan -lock=false` し、要約（アドレスと操作・件数、イメージが既存か未作成か）を step summary に書く（必須 check ではない。fork の PR では動かない）
- **deploy**（`deploy.yml`。`main` への push と `workflow_dispatch`、`concurrency: terraform-prod`）: `plan` job（plan SA）→ 差分があるときだけ `apply` job（Environment `prod`。所有者が GitHub で承認）→ イメージが未作成なら GCP の認証より前にビルド・検査 → apply SA で push → digest であることを確かめて `terraform apply`。plan ファイルは artifact で渡さず、承認後にもう一度 plan して適用する。失敗時のログはマスクして末尾だけ
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
curl -sf -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://run.googleapis.com/v2/projects/$P/locations/$L/services/simulator" \
  | jq -c '{iap: .iapEnabled, ingress, invoker_check_disabled: (.invokerIamDisabled // false), sa: (.template.serviceAccount | split("@")[0]),
            min: (.template.scaling.minInstanceCount // 0), max: .template.scaling.maxInstanceCount,
            digest: (.template.containers[0].image | test("@sha256:[0-9a-f]{64}$")), envs: [.template.containers[0].env[].name]}'
# run.invoker は IAP のサービスエージェント 1 件だけ: [{"role":"roles/run.invoker","m":["serviceAccount:service-<num>@gcp-sa-iap.iam.gserviceaccount.com"]}]
gcloud run services get-iam-policy simulator --region=$L --project="$P" --format=json \
  | jq -c '[.bindings[] | {role, m: [.members[] | sub("[0-9]+"; "<num>")]}]'
# 未認証の呼び出しが IAP で止まる（302 / 401 / 403。200 でない）。URL は表示しない
U=$(gcloud run services describe simulator --region=$L --project="$P" --format='value(status.url)')
curl -s -o /dev/null -w '%{http_code}\n' "$U/healthz"
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

## `run.admin` の影響範囲

Cloud Run のサービスを作るには、プロジェクト単位の `roles/run.admin` が要る（サービス単位の付与では作成できない）。このため `sa-sim-tf-apply` は optionchan のサービス（`ingest` / `viewer`）も変更・削除できる。逆に optionchan の apply SA も simulator を変更できる（対称）。緩和策:

- `sa-sim-tf-apply` を借用できるのは Environment `prod`（`main` のみ・所有者の承認必須）の job だけ（WIF の subject で固定）
- state を分ける（simulator の prod の state には optionchan のリソースが入らないので、Terraform が optionchan のサービスを変えることはない）。plan の要約に optionchan のサービスが出たら承認しない
- `sa-sim-tf-plan` の `roles/run.viewer` もプロジェクト単位なので、optionchan の Cloud Run の設定（環境変数の名前・値を含む）を読める（optionchan の plan SA と同等。秘匿値は環境変数に置かない）

## 切り戻し・撤去

- 権限の過不足（コードの誤り）: 修正の PR → マージ → 「bootstrap の初回 apply」の 3〜4（plan の要約を確かめてから apply）
- データセットの付与だけを外す: `simulator_reader` を消す PR → apply（delete 1）。急ぐときは所有者が `bq` で `optionchan_tokyo` の access から `sa-simulator` の 1 件を外し、あとで Terraform と揃える
- 撤去: SA・プール・Artifact Registry は `deletion_policy = "PREVENT"`、バケットは `prevent_destroy` なので Terraform では消えない。`$TF -chdir=infra/bootstrap state rm <アドレス>` で管理から外してから gcloud で削除する（`gcloud iam service-accounts delete` / `gcloud iam workload-identity-pools delete` / `gcloud artifacts repositories delete` / `gcloud storage rm -r`）。WIF のプール・プロバイダは削除後 30 日間 ID が予約される（作り直すなら別の ID）
- GitHub: `gh secret delete GCP_WIF_PROVIDER -R "$REPO"`、`gh variable delete <名前> -R "$REPO"`（4 つ）、`gh api -X DELETE $R/environments/prod`

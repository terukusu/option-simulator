# infra（Terraform）

option-simulator の GCP リソースを Terraform で管理する（`docs/design.md` 8.3・付録 B）。GCP プロジェクトは optionchan と同じ（データセット `optionchan_tokyo` を同じプロジェクトで読む）。terraform 1.16.4、google プロバイダ 8.4.0 に固定（`versions.tf`、`.terraform.lock.hcl`、`ci.yml`）。ローカルでは `mise exec terraform@1.16.4 -- terraform` で実行する。

| ルート | 中身 | apply する人 | state | state を読める主体 |
|---|---|---|---|---|
| `infra/bootstrap` | tfstate バケット 2 つ（`<PROJECT_ID>-sim-tfstate` / `<PROJECT_ID>-sim-tfstate-bootstrap`）、WIF プール `sim-github` / プロバイダ `github-actions`、SA `sa-sim-tf-plan` / `sa-sim-tf-apply` / `sa-simulator` と権限、Artifact Registry `simulator` とリポジトリ単位の付与、`optionchan_tokyo` の読み取り（`sa-simulator`、非権威的）、IAP の閲覧許可（`simulator_iap_members`） | 所有者がローカルから（CI は fmt / validate / test だけ） | `gs://<PROJECT_ID>-sim-tfstate-bootstrap/bootstrap/` | 所有者（+ プロジェクトの Editor を持つ既定の SA） |
| `infra/prod`（#36） | Cloud Run `simulator`（IAP）、IAP のサービスエージェントの `run.invoker` | CI（Environment `prod` の承認後） | `gs://<PROJECT_ID>-sim-tfstate/prod/` | `sa-sim-tf-plan`（読み取り）、`sa-sim-tf-apply`（読み書き）、所有者 |

- API の有効化は宣言しない（optionchan の bootstrap が有効化済み。二重管理を避ける）。clone 利用者は iam・iamcredentials・sts・artifactregistry・run・iap・bigquery・cloudresourcemanager が有効であることを先に確かめる（`gcloud services list --enabled --project "$P"`）
- 付与はすべて追加型（`*_iam_member`）。権威的な型（`*_iam_policy` / `*_iam_binding`、`google_bigquery_dataset_access`）は既存の付与（optionchan のもの）を消すので使わない
- プロジェクト ID・リポジトリ名はコードに既定値を持たない。`TF_VAR_*` かローカルの `infra/bootstrap/local.auto.tfvars`（`*.tfvars` は gitignore 済み。例は `local.auto.tfvars.example`）で渡す
- state には IAP の閲覧者のメールなどが入る。**state・plan の全文・ログをリポジトリ・Issue・PR に貼らない**（要約はアドレスと操作だけ）。plan ファイル（`*.tfplan`）も gitignore 済み

## 検証（CI と同じ。資格情報なし）

```sh
TF="mise exec terraform@1.16.4 -- terraform"
$TF fmt -check -recursive infra
$TF -chdir=infra/bootstrap init -backend=false -input=false
$TF -chdir=infra/bootstrap validate
$TF -chdir=infra/bootstrap test     # tests/*.tftest.hcl。モックのプロバイダで、実リソースは作らない
```

`terraform test` は、公開になる閲覧者（`allUsers`・`allAuthenticatedUsers`・`domain:`）を変数の検証で拒否すること、apply SA を借用できるのが Environment `prod` の subject だけであること、WIF の条件がリポジトリ ID とオーナー ID の両方を含むこと、データセットの読み取りが非権威的な `dataViewer` であること、などを確かめる。

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

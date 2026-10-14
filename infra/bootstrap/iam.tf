# Terraform 用 SA（infra/prod を CI で plan / apply する）。付与は追加型（*_iam_member）だけを使う（権威的な型は既存の binding を消す）。
# basic の roles/viewer は使わない（UBLA バケットの既定 IAM で projectViewer が legacy の読み取りを持ち、bootstrap の state まで読めるため）。
# apply SA に roles/iap.admin・projectIamAdmin は付けない（IAP の閲覧許可は simulator.tf で所有者が apply する。docs/design.md 8.3）。

resource "google_service_account" "tf_plan" {
  project         = var.project_id
  account_id      = "sa-sim-tf-plan"
  display_name    = "Terraform plan for simulator (GitHub Actions)"
  description     = "option-simulator の PR と main の terraform plan 用（読み取りのみ）"
  deletion_policy = "PREVENT"
}

resource "google_service_account" "tf_apply" {
  project         = var.project_id
  account_id      = "sa-sim-tf-apply"
  display_name    = "Terraform apply for simulator (GitHub Actions)"
  description     = "option-simulator の Environment prod の承認後の terraform apply 用"
  deletion_policy = "PREVENT"
}

locals {
  pool_name = google_iam_workload_identity_pool.github.name
}

# plan SA: このリポジトリのどの workflow からも借用できる（PR の plan 用）
resource "google_service_account_iam_member" "tf_plan_wif" {
  service_account_id = google_service_account.tf_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool_name}/attribute.repository_id/${var.github_repository_id}"
}

# apply SA: Environment prod の job だけが借用できる（Environment は main のみ・承認必須。infra/README.md「GitHub の設定」）
resource "google_service_account_iam_member" "tf_apply_wif" {
  service_account_id = google_service_account.tf_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${local.pool_name}/subject/repo:${var.github_repository}:environment:prod"
}

# Cloud Run の作成にはプロジェクト単位の run.admin が要る。optionchan のサービス（ingest / viewer）にも及ぶ
# （docs/design.md 付録 B・13.5。Environment の承認と state の分離で緩和。オーナーが受け入れ済み）
resource "google_project_iam_member" "tf_apply_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = google_service_account.tf_apply.member
}

# plan は Cloud Run の読み取りと projects.get（data.google_project）だけ
resource "google_project_iam_member" "tf_plan_run_viewer" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = google_service_account.tf_plan.member
}

# prod の state: plan は読み取り（plan は -lock=false で回す）、apply は state とロックの読み書き。
# bootstrap 用バケットには CI 用 SA の binding を付けない。
resource "google_storage_bucket_iam_member" "prod_state_plan" {
  bucket = google_storage_bucket.tfstate["prod"].name
  role   = "roles/storage.objectViewer"
  member = google_service_account.tf_plan.member
}

resource "google_storage_bucket_iam_member" "prod_state_apply" {
  bucket = google_storage_bucket.tfstate["prod"].name
  role   = "roles/storage.objectUser"
  member = google_service_account.tf_apply.member
}

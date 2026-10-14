# Cloud Run simulator の実行 SA と、プロジェクト単位・データセット単位・SA 単位・IAP の付与。
# サービス simulator と run.invoker（IAP のサービスエージェント）は infra/prod（#36）。

resource "google_service_account" "simulator" {
  project         = var.project_id
  account_id      = "sa-simulator"
  display_name    = "simulator (Cloud Run)"
  description     = "option-simulator の Cloud Run simulator の実行用。optionchan の板の読み取りだけ"
  deletion_policy = "PREVENT"
}

# クエリのジョブを作る（プロジェクト単位でしか付けられない）
resource "google_project_iam_member" "simulator_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = google_service_account.simulator.member
}

# optionchan のデータセットの読み取り（docs/design.md 13.3 R0）。データセットは optionchan の prod が管理するので、
# 非権威的な member で 1 件足すだけにする（optionchan の付与を消さない。google_bigquery_dataset_access / _iam_policy / _iam_binding は使わない）
resource "google_bigquery_dataset_iam_member" "simulator_reader" {
  project    = var.project_id
  dataset_id = var.bq_dataset
  role       = "roles/bigquery.dataViewer"
  member     = google_service_account.simulator.member
}

# sa-sim-tf-apply が Cloud Run simulator に sa-simulator を設定できるように（SA 単位。プロジェクト単位にしない）
resource "google_service_account_iam_member" "tf_apply_act_as_simulator" {
  service_account_id = google_service_account.simulator.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.tf_apply.member
}

# IAP 越しにサービス simulator を開けるユーザー（サービス単位。プロジェクト単位にしない）。付与には roles/iap.admin が要るので、
# apply SA ではなくここ（所有者の apply）に置く（docs/design.md 8.3）。サービス（infra/prod）が無いと付けられないので、
# prod の apply の後に var.simulator_iap_members を入れて apply する（infra/README.md「2 回目の apply（閲覧者）」）
resource "google_iap_web_cloud_run_service_iam_member" "simulator_access" {
  for_each = toset(var.simulator_iap_members)

  project                = var.project_id
  location               = var.region
  cloud_run_service_name = "simulator"
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

# AI の中継（#134）の費用の 1 日上限の計上（docs/adr-0004-ai-spend-counter-firestore.md）。最小 0 インスタンス・最大 2 の
# Cloud Run をまたいで正しく数えるため、Firestore の名前つき DB に日の計上（ai_spend/<JST の日付>）を置く。
# DB の作成と DB 単位の条件つきの付与には apply SA に無い権限が要るので、infra/prod（CI）ではなくここ（所有者の apply）に置く。
# Firestore の API は optionchan の bootstrap が有効にしている前提（docs/design.md 付録 B。ここでは有効化しない）。
# プロジェクトの既存の (default) DB（Datastore モード）には触れない。

locals {
  # api/src/simulator_api/settings.py の AI_FIRESTORE_DATABASE と同じ名前
  ai_budget_database = "simulator-ai"
}

# Native モード・東京。削除保護つき、Terraform から外しても DB は消さない（ABANDON。撤去は infra/README.md「撤去」）
resource "google_firestore_database" "ai_budget" {
  project                 = var.project_id
  name                    = local.ai_budget_database
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
}

# sa-simulator が読み書きできるのはこの DB だけ（IAM 条件で DB に絞る。(default) に及ばない）。追加型（_iam_member）だけ。
# Firestore の付与は DB 単位のリソースが無いので、プロジェクト単位の role に条件を付ける
resource "google_project_iam_member" "simulator_ai_budget" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = google_service_account.simulator.member

  condition {
    title       = "simulator-ai-budget-only"
    description = "AI の費用の計上（Firestore の DB ${local.ai_budget_database}）だけ"
    expression  = "resource.name == \"projects/${var.project_id}/databases/${local.ai_budget_database}\""
  }
}

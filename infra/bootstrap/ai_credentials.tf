# AI アドバイザー（docs/ai-advisor.md）の資格情報の入れ物と、sa-simulator の読み取り（#133、docs/adr-0001-ai-credentials-secret-manager.md）。
# Secret Manager の API の有効化・シークレットの作成・シークレット単位の付与には apply SA に無い権限が要るので、
# infra/prod（CI）ではなくここ（所有者の apply）に置く（apply SA・plan SA に Secret Manager の権限を足さない）。
# 値（版）は Terraform に一切書かない（版のリソース・data source を使わない = state・plan に値が入らない）。
# 値は所有者が gcloud secrets versions add --data-file=- で標準入力から登録する（infra/README.md「AI の資格情報（Secret Manager）」）。

locals {
  # infra/prod/simulator.tf の local.ai_secrets と同じ名前（plan SA はシークレットを読めないので、prod は data source でなく名前で参照する）。
  # 入れ物は両方とも常に作る（版の無いシークレットは無料。値を入れるのは使う方だけでよい）
  ai_secrets = {
    api_key     = "simulator-anthropic-api-key"
    oauth_token = "simulator-anthropic-oauth-token"
  }
}

# API の有効化は optionchan の bootstrap に任せる方針（docs/design.md 付録 B）の例外: Secret Manager は optionchan が使わない API で、
# simulator の都合で別リポジトリを変えないため、ここで宣言する。Terraform から外しても API は止めない（ABANDON・disable_on_destroy = false）
resource "google_project_service" "secretmanager" {
  project            = var.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
  deletion_policy    = "ABANDON"
}

# 複製は var.region だけ（データを東京に置く）。PREVENT: Terraform からの削除を拒む（撤去は infra/README.md「撤去」）
resource "google_secret_manager_secret" "ai" {
  for_each = local.ai_secrets

  project         = var.project_id
  secret_id       = each.value
  deletion_policy = "PREVENT"
  labels = {
    app = "simulator"
  }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  # 有効化の直後は伝搬が間に合わず作成が失敗することがある（もう一度 plan → apply で通る）
  depends_on = [google_project_service.secretmanager]
}

# 値を読めるのは sa-simulator だけ（シークレット単位。プロジェクト単位にしない）。追加型（_iam_member）だけを使う
resource "google_secret_manager_secret_iam_member" "simulator_ai" {
  for_each = google_secret_manager_secret.ai

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.simulator.member
}

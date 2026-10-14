# GitHub Actions から鍵なしで GCP を使うための Workload Identity 連携（docs/design.md 付録 B）。
# optionchan のプール github はプロバイダの条件で optionchan のリポジトリに固定されているので、simulator 用に新設する。
# このリポジトリ（数値 ID で照合。名前の付け替え・再作成で別物にならないように）以外のトークンは受け付けない。
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "sim-github"
  display_name              = "GitHub Actions (simulator)"
  description               = "option-simulator の GitHub Actions 用"
  deletion_policy           = "PREVENT"
}

resource "google_iam_workload_identity_pool_provider" "github_actions" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
  }

  attribute_condition = "assertion.repository_id == '${var.github_repository_id}' && assertion.repository_owner_id == '${var.github_owner_id}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

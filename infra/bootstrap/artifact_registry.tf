# simulator のコンテナイメージ。apply SA にリポジトリ単位の writer を付けるには付与の時点でリポジトリが要るので、
# リポジトリごと bootstrap に置く（prod に置くと apply SA にプロジェクト単位の artifactregistry.admin が要る。docs/design.md 付録 B）。
resource "google_artifact_registry_repository" "simulator" {
  project                = var.project_id
  location               = var.region
  repository_id          = "simulator"
  description            = "option-simulator のコンテナイメージ"
  format                 = "DOCKER"
  cleanup_policy_dry_run = false
  deletion_policy        = "PREVENT"

  docker_config {
    immutable_tags = true
  }

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  # KEEP が DELETE より優先されるので、直近 5 版は 30 日を過ぎても消えない
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s"
    }
  }
}

# apply SA はイメージを push する（承認後の apply job）
resource "google_artifact_registry_repository_iam_member" "tf_apply_writer" {
  project    = var.project_id
  location   = google_artifact_registry_repository.simulator.location
  repository = google_artifact_registry_repository.simulator.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.tf_apply.member
}

# plan SA はタグから digest を引く（infra/prod の plan）
resource "google_artifact_registry_repository_iam_member" "tf_plan_reader" {
  project    = var.project_id
  location   = google_artifact_registry_repository.simulator.location
  repository = google_artifact_registry_repository.simulator.name
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.tf_plan.member
}

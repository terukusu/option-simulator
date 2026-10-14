# プロバイダの完全名はプロジェクト番号を含むので sensitive。画面に出さず gh secret set へパイプで渡す（infra/README.md「GitHub の設定」）。
output "wif_provider_name" {
  value     = google_iam_workload_identity_pool_provider.github_actions.name
  sensitive = true
}

output "sa_tf_plan_email" {
  value = google_service_account.tf_plan.email
}

output "sa_tf_apply_email" {
  value = google_service_account.tf_apply.email
}

output "sa_simulator_email" {
  value = google_service_account.simulator.email
}

# infra/prod の state のバケット（repository variable TF_STATE_BUCKET）
output "tf_state_bucket" {
  value = google_storage_bucket.tfstate["prod"].name
}

output "artifact_registry_repository" {
  value = "${google_artifact_registry_repository.simulator.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.simulator.repository_id}"
}

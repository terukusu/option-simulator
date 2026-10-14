# infra/bootstrap の静的テスト（terraform test）。モックのプロバイダなので資格情報なしで回り、実リソースは作らない。
# command = apply はモックの computed 値（プール名など）を確定させて assert するため（plan だと unknown になる）。
# 値はすべて架空（リポジトリ example-owner/example-repo、数値 ID 123 / 456）。

mock_provider "google" {}

# imports.tf の取り込みはモックでは行えないので、取り込み先を上書きする
override_resource {
  target = google_storage_bucket.tfstate["bootstrap"]
}

# SA の name / member はプロバイダの形式の検証に掛かるので、モックの乱数ではなく SA ごとに架空の値を与える
# （SA ごとに違う値にして、付与先の取り違えを assert で検出できるようにする）
override_resource {
  target = google_service_account.tf_plan
  values = {
    name   = "projects/example-project/serviceAccounts/sa-sim-tf-plan@example-project.iam.gserviceaccount.com"
    email  = "sa-sim-tf-plan@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-sim-tf-plan@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.tf_apply
  values = {
    name   = "projects/example-project/serviceAccounts/sa-sim-tf-apply@example-project.iam.gserviceaccount.com"
    email  = "sa-sim-tf-apply@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-sim-tf-apply@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.simulator
  values = {
    name   = "projects/example-project/serviceAccounts/sa-simulator@example-project.iam.gserviceaccount.com"
    email  = "sa-simulator@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-simulator@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_iam_workload_identity_pool.github
  values = {
    name = "projects/000/locations/global/workloadIdentityPools/sim-github"
  }
}

variables {
  project_id            = "example-project"
  github_repository     = "example-owner/example-repo"
  github_repository_id  = "123"
  github_owner_id       = "456"
  simulator_iap_members = []
}

run "defaults" {
  # (b) apply SA を借用できるのは Environment prod の job だけ（principal 1 件）
  assert {
    condition     = endswith(google_service_account_iam_member.tf_apply_wif.member, "/subject/repo:example-owner@456/example-repo@123:environment:prod")
    error_message = "apply SA の workloadIdentityUser は不変 ID 入りの repo:<OWNER>@<OWNER_ID>/<REPO>@<REPO_ID>:environment:prod の subject 1 件だけ"
  }
  assert {
    condition     = startswith(google_service_account_iam_member.tf_apply_wif.member, "principal://iam.googleapis.com/")
    error_message = "apply SA の借用は principal（単一の subject）。principalSet にしない"
  }
  assert {
    condition     = google_service_account_iam_member.tf_apply_wif.role == "roles/iam.workloadIdentityUser"
    error_message = "apply SA の WIF の role"
  }
  assert {
    condition     = endswith(google_service_account_iam_member.tf_plan_wif.member, "/attribute.repository_id/123")
    error_message = "plan SA はこのリポジトリの数値 ID で借用を許す"
  }

  # (c) プロバイダの条件はリポジトリ ID とオーナー ID の両方（完全一致。|| などで弱めたら落ちる）
  assert {
    condition     = google_iam_workload_identity_pool_provider.github_actions.attribute_condition == "assertion.repository_id == '123' && assertion.repository_owner_id == '456'"
    error_message = "attribute_condition はリポジトリ ID とオーナー ID の両方を && で固定する"
  }
  assert {
    condition     = google_iam_workload_identity_pool.github.workload_identity_pool_id == "sim-github"
    error_message = "プールの ID は optionchan の github と衝突しない sim-github"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github_actions.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "OIDC の issuer"
  }

  # (d) データセットの読み取りは非権威的な dataset_iam_member で dataViewer
  assert {
    condition     = google_bigquery_dataset_iam_member.simulator_reader.role == "roles/bigquery.dataViewer"
    error_message = "sa-simulator のデータセットの role は dataViewer"
  }
  assert {
    condition     = google_bigquery_dataset_iam_member.simulator_reader.dataset_id == "optionchan_tokyo"
    error_message = "既定のデータセットは optionchan_tokyo"
  }
  assert {
    condition     = google_bigquery_dataset_iam_member.simulator_reader.member == google_service_account.simulator.member
    error_message = "データセットの読み取りは sa-simulator に付ける"
  }

  # プロジェクト単位の付与: apply = run.admin、plan = run.viewer、simulator = bigquery.jobUser（それぞれ 1 つだけ）
  assert {
    condition     = google_project_iam_member.tf_apply_run_admin.role == "roles/run.admin" && google_project_iam_member.tf_apply_run_admin.member == google_service_account.tf_apply.member
    error_message = "apply SA のプロジェクト単位の role は run.admin"
  }
  assert {
    condition     = google_project_iam_member.tf_plan_run_viewer.role == "roles/run.viewer" && google_project_iam_member.tf_plan_run_viewer.member == google_service_account.tf_plan.member
    error_message = "plan SA のプロジェクト単位の role は run.viewer"
  }
  assert {
    condition     = google_project_iam_member.simulator_job_user.role == "roles/bigquery.jobUser" && google_project_iam_member.simulator_job_user.member == google_service_account.simulator.member
    error_message = "sa-simulator のプロジェクト単位の role は bigquery.jobUser"
  }
  assert {
    condition     = google_service_account_iam_member.tf_apply_act_as_simulator.role == "roles/iam.serviceAccountUser" && google_service_account_iam_member.tf_apply_act_as_simulator.service_account_id == google_service_account.simulator.name
    error_message = "apply SA の serviceAccountUser は sa-simulator 単位"
  }

  # SA の名前
  assert {
    condition     = google_service_account.tf_plan.account_id == "sa-sim-tf-plan" && google_service_account.tf_apply.account_id == "sa-sim-tf-apply" && google_service_account.simulator.account_id == "sa-simulator"
    error_message = "SA の account_id"
  }

  # IAP の閲覧許可は 1 回目の apply では 0 件
  assert {
    condition     = length(google_iap_web_cloud_run_service_iam_member.simulator_access) == 0
    error_message = "simulator_iap_members = [] なら IAP の付与は 0 件"
  }

  # Artifact Registry: immutable tags、リポジトリ単位の writer（apply）/ reader（plan）
  assert {
    condition     = google_artifact_registry_repository.simulator.repository_id == "simulator" && google_artifact_registry_repository.simulator.format == "DOCKER"
    error_message = "Artifact Registry のリポジトリ"
  }
  assert {
    condition     = google_artifact_registry_repository.simulator.docker_config[0].immutable_tags == true
    error_message = "immutable tags"
  }
  assert {
    condition     = google_artifact_registry_repository_iam_member.tf_apply_writer.role == "roles/artifactregistry.writer" && google_artifact_registry_repository_iam_member.tf_apply_writer.member == google_service_account.tf_apply.member
    error_message = "apply SA はリポジトリ単位の writer"
  }
  assert {
    condition     = google_artifact_registry_repository_iam_member.tf_plan_reader.role == "roles/artifactregistry.reader" && google_artifact_registry_repository_iam_member.tf_plan_reader.member == google_service_account.tf_plan.member
    error_message = "plan SA はリポジトリ単位の reader"
  }

  # state バケット: 名前、公開防止、版管理。CI 用 SA の付与は prod 用バケットだけ
  assert {
    condition     = google_storage_bucket.tfstate["prod"].name == "example-project-sim-tfstate"
    error_message = "prod の state のバケット名"
  }
  assert {
    condition     = google_storage_bucket.tfstate["prod"].public_access_prevention == "enforced" && google_storage_bucket.tfstate["prod"].uniform_bucket_level_access == true
    error_message = "state のバケットは公開防止と UBLA"
  }
  assert {
    condition     = google_storage_bucket.tfstate["prod"].versioning[0].enabled == true
    error_message = "state のバケットは版管理"
  }
  assert {
    condition     = google_storage_bucket_iam_member.prod_state_plan.bucket == google_storage_bucket.tfstate["prod"].name && google_storage_bucket_iam_member.prod_state_plan.role == "roles/storage.objectViewer"
    error_message = "plan SA は prod の state の読み取りだけ"
  }
  assert {
    condition     = google_storage_bucket_iam_member.prod_state_apply.bucket == google_storage_bucket.tfstate["prod"].name && google_storage_bucket_iam_member.prod_state_apply.role == "roles/storage.objectUser"
    error_message = "apply SA は prod の state の読み書き"
  }
}

run "members" {
  variables {
    simulator_iap_members = ["user:someone@example.com", "group:team@example.com"]
  }

  assert {
    condition     = length(google_iap_web_cloud_run_service_iam_member.simulator_access) == 2
    error_message = "閲覧者ごとに 1 件"
  }
  assert {
    condition     = google_iap_web_cloud_run_service_iam_member.simulator_access["user:someone@example.com"].role == "roles/iap.httpsResourceAccessor"
    error_message = "IAP の role"
  }
  assert {
    condition     = google_iap_web_cloud_run_service_iam_member.simulator_access["user:someone@example.com"].cloud_run_service_name == "simulator" && google_iap_web_cloud_run_service_iam_member.simulator_access["user:someone@example.com"].location == "asia-northeast1"
    error_message = "IAP の付与はサービス simulator 単位"
  }
}

# (a) 公開になる member は変数の検証で拒否する
run "reject_all_users" {
  command = plan
  variables {
    simulator_iap_members = ["allUsers"]
  }
  expect_failures = [var.simulator_iap_members]
}

run "reject_all_authenticated_users" {
  command = plan
  variables {
    simulator_iap_members = ["allAuthenticatedUsers"]
  }
  expect_failures = [var.simulator_iap_members]
}

run "reject_domain" {
  command = plan
  variables {
    simulator_iap_members = ["domain:example.com"]
  }
  expect_failures = [var.simulator_iap_members]
}

run "reject_mixed" {
  command = plan
  variables {
    simulator_iap_members = ["user:someone@example.com", "allUsers"]
  }
  expect_failures = [var.simulator_iap_members]
}

run "reject_non_numeric_repository_id" {
  command = plan
  variables {
    github_repository_id = "example-owner/example-repo"
  }
  expect_failures = [var.github_repository_id]
}

run "reject_non_numeric_owner_id" {
  command = plan
  variables {
    github_owner_id = "example-owner"
  }
  expect_failures = [var.github_owner_id]
}

run "reject_bad_repository" {
  command = plan
  variables {
    github_repository = "example-repo"
  }
  expect_failures = [var.github_repository]
}

run "legacy_subject" {
  # GitHub の sub が従来形式（use_immutable_subject = false）のとき
  variables {
    github_oidc_immutable_subject = false
  }
  assert {
    condition     = endswith(google_service_account_iam_member.tf_apply_wif.member, "/subject/repo:example-owner/example-repo:environment:prod")
    error_message = "従来形式の subject は repo:<OWNER>/<REPO>:environment:prod"
  }
}

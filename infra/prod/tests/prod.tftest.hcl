# infra/prod の静的テスト（terraform test）。モックのプロバイダなので資格情報なしで回り、実リソースは作らない。
# command = apply はモックの computed 値を確定させて assert するため（plan だと unknown になる）。
# 値はすべて架空（プロジェクト example-project、プロジェクト番号 123456）。

mock_provider "google" {}

# IAP のサービスエージェントの番号はプロジェクト番号から組み立てる。モックの乱数ではなく架空の番号を与える
override_data {
  target = data.google_project.this
  values = {
    number = "123456"
  }
}

variables {
  project_id      = "example-project"
  simulator_image = "asia-northeast1-docker.pkg.dev/example-project/simulator/simulator@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

run "defaults" {
  command = apply

  # (a) IAP の後ろにだけ置く（IAP を外さない・IAM の検査を無効にしない。ingress は run.app の URL に IAP が掛かる all）
  assert {
    condition     = google_cloud_run_v2_service.simulator.iap_enabled == true
    error_message = "iap_enabled は true"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.ingress == "INGRESS_TRAFFIC_ALL"
    error_message = "ingress は INGRESS_TRAFFIC_ALL（IAP は run.app の URL に掛かる）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.invoker_iam_disabled == false
    error_message = "invoker_iam_disabled は false（IAM の検査を無効にしない）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.name == "simulator" && google_cloud_run_v2_service.simulator.location == "asia-northeast1"
    error_message = "サービス名は simulator、リージョンは asia-northeast1（bootstrap の IAP の閲覧許可と同じ名前）"
  }

  # (b) run.invoker は IAP のサービスエージェント 1 件だけ（allUsers / allAuthenticatedUsers は付けない）
  assert {
    condition     = google_cloud_run_v2_service_iam_member.simulator_iap_invoker.role == "roles/run.invoker"
    error_message = "invoker の付与は roles/run.invoker"
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.simulator_iap_invoker.member == "serviceAccount:service-123456@gcp-sa-iap.iam.gserviceaccount.com"
    error_message = "run.invoker の member は IAP のサービスエージェント（service-<番号>@gcp-sa-iap）"
  }
  assert {
    condition     = google_cloud_run_v2_service_iam_member.simulator_iap_invoker.name == "simulator" && google_cloud_run_v2_service_iam_member.simulator_iap_invoker.location == "asia-northeast1"
    error_message = "run.invoker はサービス simulator に付ける"
  }
  assert {
    condition     = !contains(["allUsers", "allAuthenticatedUsers"], google_cloud_run_v2_service_iam_member.simulator_iap_invoker.member)
    error_message = "allUsers / allAuthenticatedUsers に run.invoker を付けない"
  }

  # (d) docs/design.md 8.3 の値
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].execution_environment == "EXECUTION_ENVIRONMENT_GEN1"
    error_message = "第 1 世代（起動が速い）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].containers[0].resources[0].limits["cpu"] == "1" && google_cloud_run_v2_service.simulator.template[0].containers[0].resources[0].limits["memory"] == "512Mi"
    error_message = "CPU 1・メモリ 512Mi"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].containers[0].resources[0].cpu_idle == true
    error_message = "CPU はリクエスト中だけ（cpu_idle = true）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.simulator.template[0].scaling[0].max_instance_count == 2
    error_message = "インスタンスは 0〜2"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].timeout == "60s"
    error_message = "タイムアウトは 60 秒（gunicorn の --timeout 60 と同じ）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].max_instance_request_concurrency == 8
    error_message = "同時実行は 8（gunicorn の --threads 8 と同じ）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].service_account == "sa-simulator@example-project.iam.gserviceaccount.com"
    error_message = "実行 SA は sa-simulator（infra/bootstrap）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].containers[0].image == var.simulator_image
    error_message = "イメージは var.simulator_image"
  }
  assert {
    condition     = join(",", sort([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.name])) == "BQ_DATASET,BQ_LOCATION,GCP_PROJECT"
    error_message = "環境変数は GCP_PROJECT・BQ_DATASET・BQ_LOCATION の 3 つ（STATIC_DIR はイメージ側）"
  }
  assert {
    condition     = join(",", sort([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : "${e.name}=${e.value}"])) == "BQ_DATASET=optionchan_tokyo,BQ_LOCATION=asia-northeast1,GCP_PROJECT=example-project"
    error_message = "環境変数の値は変数（project_id・bq_dataset・bq_location）から"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.template[0].containers[0].startup_probe[0].http_get[0].path == "/healthz"
    error_message = "起動プローブは /healthz（BigQuery に触れない）"
  }
  assert {
    condition     = google_cloud_run_v2_service.simulator.deletion_protection == false
    error_message = "deletion_protection = false（データを持たないので、撤去を 1 つの PR で行えるようにする）"
  }
}

# (c) イメージの参照: src-<20hex> のタグ参照も受ける（plan で Artifact Registry に未作成のとき）
run "accept_src_tag" {
  command = plan
  variables {
    simulator_image = "asia-northeast1-docker.pkg.dev/example-project/simulator/simulator:src-0123456789abcdef0123"
  }
}

# (c) :latest は拒否（何が動くかがコミットから決まらない）
run "reject_latest" {
  command = plan
  variables {
    simulator_image = "asia-northeast1-docker.pkg.dev/example-project/simulator/simulator:latest"
  }
  expect_failures = [var.simulator_image]
}

# (c) 別のリポジトリ（optionchan のビューアー）は拒否
run "reject_other_repository" {
  command = plan
  variables {
    simulator_image = "asia-northeast1-docker.pkg.dev/example-project/optionchan/viewer@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.simulator_image]
}

# (c) 同じリポジトリの別のイメージ名は拒否
run "reject_other_image" {
  command = plan
  variables {
    simulator_image = "asia-northeast1-docker.pkg.dev/example-project/simulator/other:src-0123456789abcdef0123"
  }
  expect_failures = [var.simulator_image]
}

# (c) Artifact Registry 以外（Docker Hub 等）は拒否
run "reject_other_registry" {
  command = plan
  variables {
    simulator_image = "docker.io/library/simulator@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
  expect_failures = [var.simulator_image]
}

# (c) 短いタグ（src- の 20 桁でない）は拒否
run "reject_short_tag" {
  command = plan
  variables {
    simulator_image = "asia-northeast1-docker.pkg.dev/example-project/simulator/simulator:src-0123"
  }
  expect_failures = [var.simulator_image]
}

# データセット名は英数字と _ だけ（環境変数に入り、API が SQL の識別子に埋める）
run "reject_bad_dataset" {
  command = plan
  variables {
    bq_dataset = "optionchan_tokyo`; --"
  }
  expect_failures = [var.bq_dataset]
}

# AI の資格情報（#133）: api_key のときは ANTHROPIC_API_KEY だけ（ANTHROPIC_AUTH_TOKEN は無い）。値は Secret Manager の参照だけ
run "ai_api_key" {
  command = apply
  variables {
    ai_credential = "api_key"
  }

  assert {
    condition     = join(",", sort([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.name])) == "AI_CREDENTIAL,ANTHROPIC_API_KEY,BQ_DATASET,BQ_LOCATION,GCP_PROJECT"
    error_message = "api_key のときは AI_CREDENTIAL と ANTHROPIC_API_KEY を足す（ANTHROPIC_AUTH_TOKEN は載せない）"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value if e.name == "AI_CREDENTIAL"]) == "api_key"
    error_message = "AI_CREDENTIAL は api_key"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret if e.name == "ANTHROPIC_API_KEY"]) == "simulator-anthropic-api-key"
    error_message = "ANTHROPIC_API_KEY は simulator-anthropic-api-key の参照"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].version if e.name == "ANTHROPIC_API_KEY"]) == "latest"
    error_message = "版の既定は latest"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : (e.value == null || e.value == "") if e.name == "ANTHROPIC_API_KEY"]) == true
    error_message = "ANTHROPIC_API_KEY に素の値を入れない（Secret Manager の参照だけ）"
  }
}

# oauth_token のときは ANTHROPIC_AUTH_TOKEN だけ（ANTHROPIC_API_KEY は無い）。版は番号で固定できる
run "ai_oauth_token" {
  command = apply
  variables {
    ai_credential     = "oauth_token"
    ai_secret_version = "3"
  }

  assert {
    condition     = join(",", sort([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.name])) == "AI_CREDENTIAL,ANTHROPIC_AUTH_TOKEN,BQ_DATASET,BQ_LOCATION,GCP_PROJECT"
    error_message = "oauth_token のときは AI_CREDENTIAL と ANTHROPIC_AUTH_TOKEN を足す（ANTHROPIC_API_KEY は載せない）"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value if e.name == "AI_CREDENTIAL"]) == "oauth_token"
    error_message = "AI_CREDENTIAL は oauth_token"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret if e.name == "ANTHROPIC_AUTH_TOKEN"]) == "simulator-anthropic-oauth-token"
    error_message = "ANTHROPIC_AUTH_TOKEN は simulator-anthropic-oauth-token の参照"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].version if e.name == "ANTHROPIC_AUTH_TOKEN"]) == "3"
    error_message = "版は var.ai_secret_version"
  }
  assert {
    condition     = one([for e in google_cloud_run_v2_service.simulator.template[0].containers[0].env : (e.value == null || e.value == "") if e.name == "ANTHROPIC_AUTH_TOKEN"]) == true
    error_message = "ANTHROPIC_AUTH_TOKEN に素の値を入れない（Secret Manager の参照だけ）"
  }
}

# 種類は 1 つだけ（キーとトークンを同時に選べない）。空・未知の値は拒否
run "reject_ai_credential_both" {
  command = plan
  variables {
    ai_credential = "both"
  }
  expect_failures = [var.ai_credential]
}

run "reject_ai_credential_empty" {
  command = plan
  variables {
    ai_credential = ""
  }
  expect_failures = [var.ai_credential]
}

# GitHub variable の入力ミスの代表（大文字・前後の空白）も拒否
run "reject_ai_credential_upper" {
  command = plan
  variables {
    ai_credential = "API_KEY"
  }
  expect_failures = [var.ai_credential]
}

run "reject_ai_credential_space" {
  command = plan
  variables {
    ai_credential = " api_key"
  }
  expect_failures = [var.ai_credential]
}

run "reject_ai_secret_version_zero" {
  command = plan
  variables {
    ai_credential     = "api_key"
    ai_secret_version = "0"
  }
  expect_failures = [var.ai_secret_version]
}

run "reject_ai_secret_version_word" {
  command = plan
  variables {
    ai_credential     = "api_key"
    ai_secret_version = "abc"
  }
  expect_failures = [var.ai_secret_version]
}

run "accept_ai_secret_version_number" {
  command = plan
  variables {
    ai_credential     = "api_key"
    ai_secret_version = "3"
  }
}

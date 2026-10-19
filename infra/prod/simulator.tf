# Cloud Run simulator（docs/design.md 8.3）: IAP（Cloud Run への直接設定）の後ろにだけ置く。アプリには認証も回数制限も無い。
# IAP を外す・allUsers / allAuthenticatedUsers に run.invoker を付ける・invoker_iam_disabled = true にする、のいずれもしない
# （JPX 由来のデータが公開になり、誰でも optionchan の BigQuery のクエリを回せて課金が増える）。
# SA sa-simulator・データの読み取り・IAP の閲覧許可（roles/iap.httpsResourceAccessor）は infra/bootstrap（所有者が apply）。
# IAP の OAuth クライアントは optionchan のビューアーと共用（リージョン単位の設定。シークレットを state に入れない）。
locals {
  # plan SA は SA を読めないので data source にしない（名前は infra/bootstrap の google_service_account.simulator と同じ）
  sa_simulator = "sa-simulator@${var.project_id}.iam.gserviceaccount.com"

  # AI の資格情報（#133、docs/adr-0001-ai-credentials-secret-manager.md）。シークレットと sa-simulator の読み取りは infra/bootstrap
  # （ai_credentials.tf の local.ai_secrets と同じ名前。plan SA はシークレットを読めないので data source にしない）。
  # var.ai_credential で選んだ 1 つだけを環境変数に載せる。キーとトークンを同時に載せない（SDK は ANTHROPIC_API_KEY を優先するので、
  # 両方あるとトークンを選んだつもりでキーの従量課金になる）
  ai_secrets = {
    api_key     = "simulator-anthropic-api-key"
    oauth_token = "simulator-anthropic-oauth-token"
  }
  ai_env_name = {
    api_key     = "ANTHROPIC_API_KEY"
    oauth_token = "ANTHROPIC_AUTH_TOKEN"
  }
  ai_credentials = var.ai_credential == "none" ? [] : [var.ai_credential]
}

# IAP のサービスエージェント（service-<番号>@gcp-sa-iap）。番号はコードに書かず data source から組み立てる
# （plan SA の roles/run.viewer は resourcemanager.projects.get を含む）
data "google_project" "this" {
  project_id = var.project_id
}

# ingress は all（IAP は run.app の URL で効く。ロードバランサは使わない）。IAM の検査は無効にしない。
# 第 1 世代（起動が速い）・CPU 1・512Mi・リクエスト中だけ CPU。同時実行 8 は gunicorn の --threads 8、タイムアウト 60 秒は
# gunicorn の --timeout 60 と同じ（API の BigQuery 待ちの合計は 40 秒）。gunicorn は 1 ワーカーなので、キャッシュと
# single-flight はインスタンス内で共有される（max 2 インスタンスでは最悪 2 倍の板の読み込み。13.4）。
# deletion_protection = false: データを持たないので、撤去を 1 つの PR で行えるようにする
resource "google_cloud_run_v2_service" "simulator" {
  project              = var.project_id
  name                 = "simulator"
  location             = var.region
  description          = "日経225オプションの損益シミュレーター（IAP の後ろ。optionchan の板を読むだけ）"
  ingress              = "INGRESS_TRAFFIC_ALL"
  iap_enabled          = true
  invoker_iam_disabled = false
  deletion_protection  = false

  template {
    service_account                  = local.sa_simulator
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN1"
    max_instance_request_concurrency = 8
    timeout                          = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.simulator_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # STATIC_DIR（同梱の dist/）・PORT はイメージ側。MAX_BYTES_BILLED・DATA_SOURCE は API の既定（512 MiB・bigquery）
      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }
      env {
        name  = "BQ_DATASET"
        value = var.bq_dataset
      }
      env {
        name  = "BQ_LOCATION"
        value = var.bq_location
      }

      # AI の資格情報（var.ai_credential が none のときは何も足さない）。AI_CREDENTIAL は中継が種類を知るための素の値（秘匿でない）。
      # 資格情報そのものは Secret Manager の参照だけで、値は設定・state・plan に入らない。参照はインスタンスの起動時に解決され、
      # 版が無い・無効だとインスタンスが起動しない（simulator 全体が開けない）ので、値を登録してから AI_CREDENTIAL を設定する。
      # 切り戻しは none でデプロイしてから版を無効にする（infra/README.md「AI の資格情報（Secret Manager）」）
      dynamic "env" {
        for_each = local.ai_credentials
        content {
          name  = "AI_CREDENTIAL"
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.ai_credentials
        content {
          name = local.ai_env_name[env.value]
          value_source {
            secret_key_ref {
              secret  = local.ai_secrets[env.value]
              version = var.ai_secret_version
            }
          }
        }
      }

      # /healthz は設定の読み込みだけで BigQuery に触れない
      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 0
        period_seconds        = 3
        timeout_seconds       = 2
        failure_threshold     = 10
      }
    }
  }
}

# IAP からだけ呼べるようにする（allUsers・allAuthenticatedUsers は付けない）。追加型（_iam_member）だけを使う。
# サービスエージェントは作成済み（infra/README.md「IAP（OAuth クライアント・サービスエージェント）」）
resource "google_cloud_run_v2_service_iam_member" "simulator_iap_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.simulator.location
  name     = google_cloud_run_v2_service.simulator.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

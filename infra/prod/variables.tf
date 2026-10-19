# 既定値は持たない（リポジトリは誰でも clone して自分のプロジェクトで使う前提）。CI は vars.GCP_PROJECT_ID を TF_VAR_project_id で渡す
variable "project_id" {
  description = "GCP プロジェクト ID（optionchan と同じプロジェクト）"
  type        = string
}

variable "region" {
  description = "Cloud Run のリージョン（IAP の OAuth クライアントはこのリージョンの Cloud Run 単位で設定済み）"
  type        = string
  default     = "asia-northeast1"
}

# optionchan の BigQuery のデータセット（infra/bootstrap の bq_dataset と同じもの。sa-simulator の読み取りは bootstrap が付与）。
# API が SQL の識別子に埋めるので英数字と _ だけ
variable "bq_dataset" {
  description = "API（環境変数 BQ_DATASET）が読む optionchan のデータセット"
  type        = string
  default     = "optionchan_tokyo"

  validation {
    condition     = can(regex("^[A-Za-z0-9_]+$", var.bq_dataset))
    error_message = "bq_dataset は英数字と _ だけで指定する。"
  }
}

variable "bq_location" {
  description = "データセットのロケーション（環境変数 BQ_LOCATION）"
  type        = string
  default     = "asia-northeast1"
}

# CI が .github/scripts/image.sh simulator resolve で求めて TF_VAR_simulator_image で渡す。
# plan では Artifact Registry に未作成のタグ参照も許す（初回・入力の変更時）。apply job は digest であることを確かめてから apply する
variable "simulator_image" {
  description = "Cloud Run simulator のイメージ（<region>-docker.pkg.dev/<project>/simulator/simulator@sha256:<digest> か :src-<20hex>）"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z0-9-]+/simulator/simulator(@sha256:[0-9a-f]{64}|:src-[0-9a-f]{20})$", var.simulator_image))
    error_message = "simulator_image は <region>-docker.pkg.dev/<project>/simulator/simulator の digest 参照か src-<20hex> のタグ参照で指定する。"
  }
}

# AI の資格情報の種類（#133、docs/adr-0001-ai-credentials-secret-manager.md）。CI は vars.AI_CREDENTIAL を TF_VAR_ai_credential で渡す（未設定は none）。
# none: 何も載せない（AI は無効）。api_key: ANTHROPIC_API_KEY、oauth_token: ANTHROPIC_AUTH_TOKEN を Secret Manager の参照で載せる（同時には載せない）
variable "ai_credential" {
  description = "AI の資格情報の種類（none | api_key | oauth_token）"
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "api_key", "oauth_token"], var.ai_credential)
    error_message = "ai_credential は none・api_key・oauth_token のどれか。"
  }
}

# 参照するシークレットの版。latest は起動したインスタンスが最新の版を読む（版を足すと、古いインスタンスはアイドルで消えるまで旧値）。
# 番号で固定するとデプロイで切り替わる（Google は環境変数では固定を推奨。トレードオフは infra/README.md「AI の資格情報（Secret Manager）」）
variable "ai_secret_version" {
  description = "AI の資格情報のシークレットの版（latest か 1 以上の番号）"
  type        = string
  default     = "latest"

  validation {
    condition     = can(regex("^(latest|[1-9][0-9]*)$", var.ai_secret_version))
    error_message = "ai_secret_version は latest か 1 以上の番号。"
  }
}

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

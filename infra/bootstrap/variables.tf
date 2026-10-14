# 既定値は持たない（リポジトリは誰でも clone して自分のプロジェクトで使う前提）。TF_VAR_project_id か tfvars で渡す
variable "project_id" {
  description = "GCP プロジェクト ID（optionchan と同じプロジェクト）"
  type        = string
}

variable "region" {
  description = "既定のリージョン（Cloud Run・Artifact Registry）"
  type        = string
  default     = "asia-northeast1"
}

variable "github_repository" {
  description = "WIF で借用を許す GitHub リポジトリ（owner/name）。apply SA の subject に使う"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository は <owner>/<name> の形で指定する。"
  }
}

# GitHub の数値 ID はコード・tfvars に置かない。apply のたびに gh api から TF_VAR_ で渡す（infra/README.md「共通の変数」）。
variable "github_repository_id" {
  description = "GitHub リポジトリの数値 ID（gh api repos/<owner>/<repo> --jq .id）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id は数字だけで指定する。"
  }
}

variable "github_owner_id" {
  description = "GitHub リポジトリ所有者の数値 ID（gh api repos/<owner>/<repo> --jq .owner.id）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id は数字だけで指定する。"
  }
}

# optionchan の BigQuery のデータセット（テーブル関数 4 本とビューがある。docs/design.md 4.1）。sa-simulator に読み取りだけを付ける
variable "bq_dataset" {
  description = "sa-simulator が読む optionchan のデータセット"
  type        = string
  default     = "optionchan_tokyo"

  validation {
    condition     = can(regex("^[A-Za-z0-9_]+$", var.bq_dataset))
    error_message = "bq_dataset は英数字と _ だけで指定する。"
  }
}

# IAP 越しにサービス simulator を開けるユーザー。メールはコード・リポジトリに置かず、
# ローカルの infra/bootstrap/local.auto.tfvars（*.tfvars は gitignore 済み）に書く（infra/README.md「2 回目の apply（閲覧者）」）。
# 既定値は持たない: 既定を [] にすると、ファイルを置き忘れた apply で付与が消えるため（忘れたら plan がエラーで止まる）。
# サービス simulator（infra/prod）が無いうちは付与できないので、prod の apply の前は []、後に ["user:<メール>"] にする。
variable "simulator_iap_members" {
  description = "IAP 越しに simulator を開けるプリンシパル（例: [\"user:<メール>\"]）。サービスの作成前は []"
  type        = list(string)

  validation {
    # allUsers / allAuthenticatedUsers / domain: は不可（JPX 由来のデータを公開しない。誰でも BigQuery の課金を発生させられる状態にしない）
    condition     = alltrue([for m in var.simulator_iap_members : can(regex("^(user|group):[^\\s@]+@[^\\s@]+$", m))])
    error_message = "simulator_iap_members の各要素は user:<メール> か group:<メール>（domain: / allUsers / allAuthenticatedUsers は不可）。"
  }
}

# bootstrap の state は prod と別のバケットに置く（CI 用 SA には読ませない）。
# バケットは初回だけ gcloud で作り、imports.tf で取り込む（infra/README.md「bootstrap の初回 apply」）。
# バケット名（<PROJECT_ID>-sim-tfstate-bootstrap）はプロジェクトごとに違うので部分設定にし、
# terraform init -backend-config="bucket=<PROJECT_ID>-sim-tfstate-bootstrap" で渡す。
terraform {
  backend "gcs" {
    prefix = "bootstrap"
  }
}

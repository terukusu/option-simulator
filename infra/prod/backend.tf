# prod の state は bootstrap が作ったバケット <PROJECT_ID>-sim-tfstate に置く（sa-sim-tf-plan は読み取り、sa-sim-tf-apply は読み書き）。
# バケット名はプロジェクトごとに違うので部分設定にし、terraform init -backend-config="bucket=<PROJECT_ID>-sim-tfstate" で渡す
# （CI は vars.TF_STATE_BUCKET。infra/README.md「prod の state の初期化」）。
terraform {
  backend "gcs" {
    prefix = "prod"
  }
}

# bootstrap 用バケットは state の置き場なので、Terraform より先に gcloud で作って取り込む（infra/README.md「bootstrap の初回 apply」）。
import {
  to = google_storage_bucket.tfstate["bootstrap"]
  id = "${var.project_id}-sim-tfstate-bootstrap"
}

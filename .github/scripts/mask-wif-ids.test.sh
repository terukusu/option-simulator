#!/usr/bin/env bash
# Anthropic の WIF の ID をログで伏せる仕組み（#184）のテスト（ci.yml の check で回す。手元でもそのまま動く）。
# 1. mask-wif-ids.sh: 空でない TF_VAR_anthropic_* ごとに ::add-mask::（前後の空白を落とした形も）を出し、空なら何も出さない
# 2. ci.yml と deploy.yml の MASK_SED が同じで、Terraform の変数の検査のエラー（値を表示する）から ID が消える
# 3. terraform を動かす job（ci.yml の terraform-plan、deploy.yml の plan・apply）が mask-wif-ids.sh を呼ぶ
# 値は架空（fdrl_0example0rule など）。
#
#   mask-wif-ids.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
fails=0
fail() { echo "NG: $1"; fails=$((fails + 1)); }

rule=fdrl_0example0rule
org=00000000-0000-4000-8000-000000000000
sa=svac_0example0account
ws=wrkspc_0example0workspace

# 1. ::add-mask::
out=$(env -u TF_VAR_anthropic_federation_rule_id -u TF_VAR_anthropic_organization_id \
  -u TF_VAR_anthropic_service_account_id -u TF_VAR_anthropic_workspace_id "$here/mask-wif-ids.sh")
[ -z "$out" ] || fail "未設定なのに出力がある"
out=$(TF_VAR_anthropic_federation_rule_id=$rule TF_VAR_anthropic_organization_id="$org " \
  TF_VAR_anthropic_service_account_id= TF_VAR_anthropic_workspace_id=$ws "$here/mask-wif-ids.sh")
want=$(printf '::add-mask::%s\n' "$rule" "$org " "$org" "$ws")
[ "$out" = "$want" ] || fail "::add-mask:: の行が違う: $(printf '%s' "$out" | wc -l) 行"

# 2. MASK_SED（YAML の folded scalar `MASK_SED: >-` の続きの行を空白でつなぐ）
mask_sed() {
  awk '
    /^[[:space:]]*MASK_SED: >-[[:space:]]*$/ { match($0, /^[[:space:]]*/); ind = RLENGTH; on = 1; next }
    on { match($0, /^[[:space:]]*/); if (RLENGTH <= ind || $0 ~ /^[[:space:]]*$/) exit; sub(/^[[:space:]]+/, ""); s = s (s ? " " : "") $0 }
    END { print s }
  ' "$1"
}
ci=$(mask_sed "$root/.github/workflows/ci.yml")
deploy=$(mask_sed "$root/.github/workflows/deploy.yml")
[ -n "$ci" ] || fail "ci.yml の MASK_SED が読めない"
[ "$ci" = "$deploy" ] || fail "ci.yml と deploy.yml の MASK_SED が違う"

# Terraform 1.16 の変数の検査のエラーの形（値を表示する）。末尾の空白・別の形の ID・プロジェクト番号・メールも。
# 番号とメールは repo-values-check.sh に一致しないよう連結で組み立てる
num=123456; num+=789012
mail=owner; mail+=@; mail+=gmail.com
log=$(cat <<LOG
Error: Invalid value for variable

  on variables.tf line 70:
  70: variable "anthropic_organization_id" {
    ├────────────────
    │ var.ai_credential is "wif"
    │ var.anthropic_organization_id is "$org "
    │ var.anthropic_federation_rule_id is "rule \\"quoted\\" $rule"
    │ var.anthropic_workspace_id is "custom-workspace-name"

anthropic_organization_id は UUID（ai_credential = wif のとき必須）。
service-$num@gcp-sa-iap.iam.gserviceaccount.com $mail $sa
LOG
)
masked=$(printf '%s\n' "$log" | sed -E "$ci")
for v in "$org" "$rule" "$sa" "$ws" custom-workspace-name quoted "$num" "$mail"; do
  case "$masked" in *"$v"*) fail "マスクの後に残る: ${v:0:4}…" ;; esac
done
for keep in 'var.ai_credential is "wif"' 'var.anthropic_organization_id is "<masked>"' 'anthropic_organization_id は UUID' \
  '@gcp-sa-iap.iam.gserviceaccount.com' '<email>'; do
  case "$masked" in *"$keep"*) ;; *) fail "マスクで消えすぎ: $keep" ;; esac
done

# 3. terraform を動かす job が呼ぶ
[ "$(grep -c 'run: .github/scripts/mask-wif-ids.sh' "$root/.github/workflows/deploy.yml")" = 2 ] || fail "deploy.yml の plan・apply で呼ばない"
[ "$(grep -c 'run: .github/scripts/mask-wif-ids.sh' "$root/.github/workflows/ci.yml")" = 1 ] || fail "ci.yml の terraform-plan で呼ばない"

if [ "$fails" -gt 0 ]; then
  echo "NG: ${fails} 件"
  exit 1
fi
echo "ok"

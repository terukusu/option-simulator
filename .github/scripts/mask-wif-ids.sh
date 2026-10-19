#!/usr/bin/env bash
# Anthropic の WIF の ID（TF_VAR_anthropic_*。#184）を、この job のログで伏せる（GitHub の ::add-mask::）。
# 値は秘密ではないが利用者個人のもので、repository variables の値は Actions のログに伏せられずに出る。
# Terraform は変数の検査に落ちると値をエラーに表示するので、terraform を動かす job の最初の step で呼ぶ。
# 値そのものは表示しない（::add-mask:: の行はログに出ない）。行ごと・前後の空白を落とした形の両方を伏せる。
#
#   mask-wif-ids.sh
set -euo pipefail

for name in TF_VAR_anthropic_federation_rule_id TF_VAR_anthropic_organization_id \
  TF_VAR_anthropic_service_account_id TF_VAR_anthropic_workspace_id; do
  v=${!name:-}
  [ -n "$v" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    t=$(printf '%s' "$line" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
    [ -n "$t" ] || continue
    if [ "$t" != "$line" ]; then echo "::add-mask::$line"; fi
    echo "::add-mask::$t"
  done <<< "$v"
done

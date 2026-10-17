#!/usr/bin/env bash
# Cloud Run simulator のイメージの中身と起動の検査（GCP の認証は使わない。BigQuery には触れない = /api/* は叩かない）。
# ci.yml の check と deploy.yml の apply job（push の前）で共用する。
#
#   image-check.sh <ローカルのイメージ名>   例: simulator:ci
set -euo pipefail

img="${1:?usage: $0 <image>}"
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
cid=""
cleanup() {
  if [ -n "$cid" ]; then docker rm -f "$cid" > /dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "NG: $*" >&2; exit 1; }

# 1. gunicorn と同じ simulator_api.app:app を作れること（設定の検証。GCP_PROJECT はダミー。BigQuery のクライアントは遅延生成）
docker run --rm -e GCP_PROJECT=example-project "$img" python -c 'from simulator_api.app import app; assert app.name'
echo "ok: import"

# 2. 非 root で動くこと
uid=$(docker run --rm --entrypoint id "$img" -u)
[ "$uid" != 0 ] || fail "root（uid 0）で動く"
echo "ok: uid ${uid}"

# 3. 入れてはいけないものが無いこと。.git・node_modules・Terraform の変数 / state・.env はイメージ全体、
#    テスト・fixture（実データの dump を含みうる fixtures/local/）・infra はアプリの置き場（/app と simulator_api）で探す
found=$(docker run --rm --entrypoint sh "$img" -c '
  find / -xdev \( -name .git -o -name node_modules -o -name "*.tfvars" -o -name "*.tfstate" -o -name "*.tfplan" \
    -o -name .env -o -name ".env.*" \) -print 2>/dev/null
  pkg=$(python -c "import os, simulator_api; print(os.path.dirname(simulator_api.__file__))")
  find /app "$pkg" \( -name tests -o -name fixtures -o -name infra -o -name "*.test.*" \) -print 2>/dev/null
  find /app/static -name "*.json" -print 2>/dev/null
  true')
[ -z "$found" ] || fail "イメージに入れてはいけないものがある: $(printf '%s\n' "$found" | wc -l) 件"$'\n'"$found"
# /app は同梱の dist（static）だけ
top=$(docker run --rm --entrypoint ls "$img" -A /app)
[ "$top" = static ] || fail "/app に static 以外がある: ${top}"
echo "ok: 除外物 0 件"

# 4. 同梱の index.html が ci.yml と同じ CSP 検査を通ること
docker run --rm --entrypoint cat "$img" /app/static/index.html > "$work/index.html"
"$here/csp-check.sh" "$work/index.html"

# 5. 起動して /healthz・/・/assets/* が 200、CSP ヘッダ（script-src 'self'）が付くこと。
#    manifest とアイコン（#90）は Content-Type も見て、manifest は CSP に manifest-src 'self' があること
cid=$(docker run -d -p 127.0.0.1::8080 -e GCP_PROJECT=example-project "$img")
port=$(docker port "$cid" 8080/tcp | head -n 1 | sed 's/.*://')
base="http://127.0.0.1:${port}"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "$base/healthz" 2> /dev/null; then break; fi
  sleep 1
done

check() {  # パス 名前 [Content-Type の前方一致]（ヘッダは $work/<名前>.h）
  local code type
  code=$(curl -sS -o "$work/$2.body" -D "$work/$2.h" -w '%{http_code}' "$base$1") || fail "$1 に接続できない"
  [ "$code" = 200 ] || { docker logs "$cid" 2>&1 | tail -n 20 >&2; fail "$1 が ${code}"; }
  grep -i '^content-security-policy:' "$work/$2.h" | grep -q "script-src 'self'" \
    || fail "$1 に Content-Security-Policy（script-src 'self'）が無い"
  if [ -n "${3:-}" ]; then
    type=$(grep -i '^content-type:' "$work/$2.h" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')
    case "$type" in
      "$3"*) ;;
      *) fail "$1 の Content-Type が ${3} でない: ${type}" ;;
    esac
  fi
  echo "ok: $1 200（CSP あり）"
}
check /healthz healthz
check / index
cmp -s "$work/index.body" "$work/index.html" || fail "/ が同梱の index.html と違う"
asset=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$work/index.html" | head -n 1)
[ -n "$asset" ] || fail "index.html に /assets/*.js が無い"
check "$asset" asset
check /manifest.webmanifest manifest application/manifest+json
grep -i '^content-security-policy:' "$work/manifest.h" | grep -q "manifest-src 'self'" \
  || fail "/manifest.webmanifest の CSP に manifest-src 'self' が無い"
echo "ok: manifest-src 'self'"
check /favicon.svg favicon image/svg+xml
check /apple-touch-icon.png apple-touch-icon image/png
check /icon-192.png icon-192 image/png
check /icon-512.png icon-512 image/png
echo "simulator のイメージの検査: OK"

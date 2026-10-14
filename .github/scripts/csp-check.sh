#!/usr/bin/env bash
# ビルド成果物の index.html の CSP 検査（インライン script・style 要素・style 属性・外部 URL を拒否）。
# ci.yml の check（dist/index.html）と .github/scripts/image-check.sh（イメージに同梱した index.html）で共用する。
#
#   csp-check.sh <index.html>
set -euo pipefail

f="${1:?usage: $0 <index.html>}"
test -s "$f" || { echo "ファイルが無いか空: $f"; exit 1; }
# src の無い <script>（インライン）と <style> 要素
if grep -n '<script' "$f" | grep -v 'src='; then echo "インライン script がある: $f"; exit 1; fi
if grep -n '<style' "$f"; then echo "style 要素がある: $f"; exit 1; fi
if grep -nE '[[:space:]]style=' "$f"; then echo "style 属性がある: $f"; exit 1; fi
if grep -nE 'https?://' "$f"; then echo "外部 URL がある: $f"; exit 1; fi
echo "ok: $f"

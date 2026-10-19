#!/usr/bin/env bash
# ビルド成果物の index.html の CSP 検査（インライン script・style 要素・style 属性・外部 URL を拒否）と、
# 鍵の形（Anthropic の [s]k-ant-<種別>-<本体>。repo-values-check.sh と同じ形）が index.html と隣の assets/ に無いこと（#134）。
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
# [s] はこのファイル自身に一致させないための書き方
key='[s]k-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}'
targets=("$f")
assets="$(dirname "$f")/assets"
if [ -d "$assets" ]; then targets+=("$assets"); fi
if grep -rlsIE -e "$key" -- "${targets[@]}"; then echo "鍵の形がある: ${targets[*]}"; exit 1; fi
echo "ok: $f"

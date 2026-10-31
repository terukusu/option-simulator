#!/usr/bin/env bash
# ビルド成果物の index.html の CSP 検査（インライン script・style 要素・style 属性・外部 URL を拒否）と、
# 鍵の形（Anthropic の [s]k-ant-<種別>-<本体>。repo-values-check.sh と同じ形）が index.html と隣の assets/ に無いこと（#134）。
# index.html のディレクトリにフォントのファイル（.woff / .woff2 / .ttf / .otf）が無く、assets/*.css の @font-face に url() が無いこと（#324）。
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
# フォントは端末のもの（local()）だけ。ファイルを同梱しない・@font-face で url() を読まない（#324。docs/ui-redesign.md §10.1）。
# フォントのファイルは index.html のディレクトリ全体（Vite が ui/public/ を直下に写すので assets/ の外も）を探す
fonts="$(find "$(dirname "$f")" -type f \( -iname '*.woff' -o -iname '*.woff2' -o -iname '*.ttf' -o -iname '*.otf' \))"
if [ -n "$fonts" ]; then echo "$fonts"; echo "フォントのファイルがある: $(dirname "$f")"; exit 1; fi
# CSS は改行を消してから @font-face の { から } までを 1 つの塊として見る（minify の有無によらない）
if [ -d "$assets" ]; then
  for c in "$assets"/*.css; do
    [ -f "$c" ] || continue
    if tr -d '\n\r' < "$c" | grep -qE '@font-face[[:space:]]*\{[^}]*url\('; then
      echo "@font-face に url( がある: $c"
      exit 1
    fi
  done
fi
echo "ok: $f"

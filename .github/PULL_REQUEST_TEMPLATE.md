## Summary
-

## Test plan
<!-- 画面を触る PR は docs/ui-guidelines.md の 6 章「画面を触る PR のチェックリスト」に沿う。下の「機械で確かめる」は出力（要約）を貼る。「目で確かめる」は 6 章の 9〜18 を見て、確かめたことを書く -->

### 機械で確かめる（画面を触る PR）
- [ ] `npm run typecheck && npm run lint && npm run fixtures:check && npm test`（`cssTokens`・`icon`・`pwa` を含む）
- [ ] `npm run ui:check` 既定の実行: 全状態で縦・横スクロール 0px、折り返しの件数を増やしていない、読み取り・切れの検査が通る
- [ ] `npm run ui:check -- --parts --max-wraps 0`（部品を触ったとき）
- [ ] `npm run ui:check -- --flows`（操作・キー・トースト・ダイアログを触ったとき。Long Animation Frame の項目は NG でも合否にしない。出力はそのまま貼る）。板・市場の表示を触ったときは `--quotes-only` も
- [ ] `npm run ui:check -- --cross`（チャートの操作を触ったとき）
- [ ] `npm run perf`（描画の処理・表示モデルを触ったとき。16 ms）
- [ ] 色を足した / 変えた: `tokens.css` のテーマの定義にだけ書き、両テーマにある（`cssTokens` (a)(b)）。設計 §7 の表も直した
- [ ] `git status --porcelain` に実データ・ローカルの設定・スクリーンショットが無い（`fixtures/local/` は gitignore）

### その他
- [ ] api: `cd api && uv run --locked ruff check && uv run --locked pytest -q`（api を触ったとき）
- [ ] 手動確認 / デプロイ後の確認:

## 設計との対応
-

## デプロイ対象
-

Closes #

# option-simulator

日経225オプションの損益シミュレーター（建てる前の戦略検討用）。スマイルを反映した理論損益、日数・原資産・IV（水準・スキュー・急落プリセット）のシナリオ、テール表、ファー OTM を見るための拡大・スクロール、先物（ミニ）の足とデルタヘッジを扱う。

データは optionchan 形式の BigQuery の板（最新スナップショット）か、JSON ファイル・手入力。

設計: [`docs/design.md`](docs/design.md)

状態: 設計済み。縦切り 1（手元で損益が見える）を実装中（価格モデル `model/`、データ `data/` と合成の固定の板まで）。

## 開発

Node 22 を使う（`.node-version`）。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run dev        # 画面の雛形（ui/）
npm run fixtures   # 合成の板 JSON（fixtures/synthetic/）を作り直す。CI は fixtures:check で一致を検査
```

## 板のデータ

- `fixtures/synthetic/*.json`: 開発・テストの既定の板。Black-76 から作った **架空の値**（生成器 `scripts/synthBoard.ts`）。形は `docs/design.md` 7.1
- `fixtures/local/`: 実データ（optionchan の板）の dump を手元で試す置き場。**gitignore 済みで、コミットしない**（JPX 由来のデータを公開リポジトリに置かない）。`/api/chain` と同じ形の JSON を置くと `npm test` が検証・正規化を試し（`tests/data/local.test.ts`。件数だけ出す）。`file` アダプタ（`data/adapter.ts`）でも読める（画面への組み込みは縦切り 1c）。Issue / PR には件数・割合などの要約だけを書く

# option-simulator

日経225オプションの **建てる前の戦略検討** に使う損益シミュレーター（とプレミアムシミュレーター）。データは optionchan（JPX のページから毎分取り込んだ板を BigQuery に蓄積するツール）の最新スナップショットを使う。設計は `docs/design.md`（0 章の決定・13 章の決定事項 / 判断待ち / optionchan への依頼が正）。

## 作り

- `model/`: 価格モデル（Black-76、IV、F の推定、スマイルの補間・外挿、時間、満期損益、シナリオ、グリーク）。**純関数**で DOM・通信に依存しない。vitest で文献値・性質テスト・合成板からの回復を固定する
- `data/`: 板の取得とアダプタ（`file` / `bigquery` / 手入力）、板の正規化
- `ui/`: 画面（TypeScript + Vite）
- `api/`: 板の JSON を返す Python（Flask）。縦切り 2 から
- `infra/`: Terraform（Cloud Run + IAP、縦切り 2 から）

- `tests/`: vitest のテスト（`tests/model/`）と、合成の板の生成器などの補助（`tests/support/`）

計算はすべてブラウザで行い、サーバーは板を返すだけ。

## 開発

- Node は 22（`.node-version`）。依存はバージョン固定（`package-lock.json` をコミット）
- 確認: `npm ci && npm run typecheck && npm run lint && npm test`（CI と同じ。lint は Biome、整形は `npm run format`）
- 画面の雛形: `npm run dev`（Vite の root は `ui/`）、`npm run build` で `dist/`

## リポジトリに置くもの / 置かないもの

このリポジトリは誰でも clone して自分の環境で使える **汎用の作り** にする（公開しても困らない内容だけを置く）。

**置かないもの**（コミットにも Issue / PR 本文にも入れない）:

- 特定の利用者の値（GCP プロジェクト ID・プロジェクト番号、GitHub のオーナー名・リポジトリ名、バケット名、メールアドレス、ホームディレクトリのパス）。コード・設定は変数で受け取り、docs の例は `<PROJECT_ID>`・`$P`・`<OWNER>/<REPO>` などのプレースホルダにする
- アクセストークン、OAuth クライアントのシークレット、サービスアカウント鍵、署名付き URL
- **JPX 由来の実データ**（板の dump など）。テストは Black-76 から生成した合成の板を使う。実データの dump は `fixtures/local/`（gitignore）に置き、件数・割合などの要約だけを Issue / PR に書く
- `.claude/settings.local.json`、作業用ファイル（`.claude/handoff/`、`.claude/worktrees/`、一時ディレクトリ）

コマンドでは、プロジェクトを `gcloud config get-value project` か環境変数 `GCP_PROJECT_ID`、リポジトリを `gh repo view --json nameWithOwner -q .nameWithOwner` で取る。

コミット前に `git status --porcelain` で上記が含まれていないことを確認し、`git add -A` / `git add .` は使わず個別に `git add` する。

## 数値の約束

- 金額は円、乗数はラージ OP / ラージ先物 1,000、ミニ先物 100、マイクロ先物 10
- デルタはラージ換算（枚）とミニ換算の両方で出す。グリークの単位は `docs/design.md` 5.6
- 本文・テストの価格例は **架空の値**（実データを写さない）

# option-simulator

日経225オプションの **建てる前の戦略検討** に使う損益シミュレーター（とプレミアムシミュレーター）。データは optionchan（JPX のページから毎分取り込んだ板を BigQuery に蓄積するツール）の最新スナップショットを使う。設計は `docs/design.md`（0 章の決定・13 章の決定事項 / 判断待ち / optionchan への依頼が正）。

## 作り

- `model/`: 価格モデル（Black-76、IV、F の推定、スマイルの補間・外挿、時間、満期損益、シナリオ、グリーク）。**純関数**で DOM・通信に依存しない。vitest で文献値・性質テスト・合成板からの回復を固定する
- `data/`: 板の JSON の型と検証、アダプタ（`file` / `bigquery` / 手入力の足）、板の正規化（F・スマイル・ATM を `model/` で付ける）
- `data/calendar/`: 取引カレンダー（optionchan の toml から）と国民の祝日（内閣府の CSV から）の JSON。`npm run calendar:sync`（環境変数 `OPTIONCHAN_CALENDAR_URL`。CI では同名の secret。URL はリポジトリに書かない）と定期同期のワークフロー（`.github/workflows/calendar-sync.yml`）が書く生成物で、手で編集しない。形の検査と休業日の集合は `data/calendar.ts`
- `fixtures/synthetic/`: 合成の固定の板（架空の値。`scripts/synthBoard.ts` から `npm run fixtures` で作る。手で編集しない）
- `ui/`: 画面（TypeScript + Vite + Preact 10）。状態と reducer は `ui/state.ts`、表示モデルは `ui/view/` の純関数（Preact に依存しない。`tests/ui/` で確かめる）、グラフの座標は `ui/chart/scale.ts`、部品（`ui/components/`）は表示モデルを描くだけ。板・入力値は JSX のテキスト / 属性で入れ、HTML 文字列を DOM に入れる API と `style` 属性（JSX の style prop を含む）を使わない（CSP）
- `api/`: 板の JSON を返す Python（Flask）。縦切り 2 から
- `infra/`: Terraform（Cloud Run + IAP、縦切り 2 から）

- `tests/`: vitest のテスト（`tests/model/`・`tests/data/`・`tests/ui/`）と、合成の板の生成器などの補助（`tests/support/`）

計算はすべてブラウザで行い、サーバーは板を返すだけ。

## 開発

- Node は 22（`.node-version`）。依存はバージョン固定（`package-lock.json` をコミット）
- 確認: `npm ci && npm run typecheck && npm run lint && npm run fixtures:check && npm test`（CI と同じ。lint は Biome、整形は `npm run format`）
- 画面: `npm run dev`（Vite の root は `ui/`。合成の板は `scripts/devFixtures.mjs` が dev サーバーでだけ配る）、`npm run build` で `dist/`（JSON を入れない）。322 行の板は `npm run fixtures -- --wide`（`fixtures/local/` に書く）

## リポジトリに置くもの / 置かないもの

このリポジトリは誰でも clone して自分の環境で使える **汎用の作り** にする（公開しても困らない内容だけを置く）。

**置くもの**: コード（`model/`・`data/`・`ui/`・`api/`・`infra/`）、テストと合成の fixture、`docs/`、`.claude/skills/`（Issue の起票・実装のスキル）、この `CLAUDE.md`。

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

# option-simulator

日経225オプションの **建てる前の戦略検討** に使う損益シミュレーター（とプレミアムシミュレーター）。データは optionchan（JPX のページから毎分取り込んだ板を BigQuery に蓄積するツール）の最新スナップショットを使う。設計は `docs/design.md`（0 章の決定・13 章の決定事項 / 判断待ち / optionchan への依頼が正）。

## 作り

- `model/`: 価格モデル（Black-76、IV、F の推定、スマイルの補間・外挿、時間、満期損益、シナリオ、グリーク）。**純関数**で DOM・通信に依存しない。vitest で文献値・性質テスト・合成板からの回復を固定する
- `data/`: 板の JSON の型と検証、アダプタ（`file` / `bigquery` / 手入力の足）、板の正規化（F・スマイル・ATM を `model/` で付ける）
- `data/calendar/`: 取引カレンダーの同梱の版（`calendar.json`。`/api/calendar` と同じ形。API から取れないときに使う）。自動更新はせず、手で作り直して PR（手順は README の「取引カレンダー」）。形の検査と休業日の集合は `data/calendar.ts`
- `fixtures/synthetic/`: 合成の固定の板（架空の値。`scripts/synthBoard.ts` から `npm run fixtures` で作る。手で編集しない）
- `ui/`: 画面（TypeScript + Vite + Preact 10）。状態と reducer は `ui/state.ts`、表示モデルは `ui/view/` の純関数（Preact に依存しない。`tests/ui/` で確かめる）、グラフの座標と拡大・パンの規則は `ui/chart/scale.ts`、ジェスチャー（ドラッグ・ピンチ・タップ・損益グラフの長押し / つかむ）の状態機械は `ui/chart/gesture.ts`（どちらも純関数）、DOM のイベントは損益グラフとスマイルで共用のフック `ui/components/useChartGestures.ts`、部品（`ui/next/`）は表示モデルを描くだけ。板・入力値は JSX のテキスト / 属性で入れ、HTML 文字列を DOM に入れる API と `style` 属性（JSX の style prop を含む）を使わない（CSP）
  - 画面は docs/ui-redesign.md の設計で `ui/next/`（歴史的な名前。#91 で既定に切り替え旧画面を削除したので唯一の画面。クエリによらずこの画面を開く。部品の見本は dev だけ `?parts`）。CSS は `ui/next/next.css`（トークンは `ui/next/css/tokens.css`。色はトークンだけ = `tests/ui/cssTokens.test.ts` が `ui/**/*.css` を検査）、共通部品は `ui/next/parts/`、状態と保存は `ui/components/useAppController.ts`（`ui/components/` に残るのは DOM・CSS を持たないフックだけ）、見た目の状態は `ui/view/shell.ts`。規約は docs/ui-redesign.md 10.1
- `api/`: 板（`/api/chain`）・カレンダー（`/api/calendar`）・IV 推移（`/api/atm_iv`。表 `atm_cm_iv` の `iv30`）の JSON を返す Python 3.13（Flask / gunicorn、uv.lock）。optionchan の BigQuery を読むだけ（書き込まない）。使える板の判定は `api/src/simulator_api/usable.py` の純関数（定数は `settings.py` の上部）、optionchan との契約（使う列・型）は `contract.py` に 1 か所。テストは pytest と偽の runner（合成の板）。手順は `api/README.md`
- `infra/`: Terraform（terraform 1.16.4・google 8.4.0）。`infra/bootstrap` は所有者が手元で apply する WIF・SA・state バケット・Artifact Registry・`optionchan_tokyo` の読み取り（非権威的）・IAP の閲覧許可、`infra/prod` は CI（`.github/workflows/deploy.yml`、Environment `prod` の承認後）が apply する Cloud Run `simulator`（IAP）と IAP のサービスエージェントの `run.invoker`。付与は追加型（`*_iam_member`）だけ。テストは `infra/*/tests/`（`terraform test`、モックのプロバイダ）。手順・構成は `infra/README.md`

- `tests/`: vitest のテスト（`tests/model/`・`tests/data/`・`tests/ui/`）と、合成の板の生成器などの補助（`tests/support/`）

計算はすべてブラウザで行い、サーバーは板を返すだけ。

## 開発

- Node は 24（`.node-version`）。依存はバージョン固定（`package-lock.json` をコミット）
- 確認: `npm ci && npm run typecheck && npm run lint && npm run fixtures:check && npm test`（CI と同じ。lint は Biome、整形は `npm run format`）。性能に関わる変更は負荷の低いときに `npm run perf`（16 ms の判定。性能テストの 2 ファイルだけを並列なしで。`npm test`・CI の性能テストは 200 ms）。API は `cd api && uv run --locked ruff check && uv run --locked pytest -q`（uv 0.12.19、Python 3.13）。Terraform は `terraform fmt -check -recursive infra` と、`infra/bootstrap`・`infra/prod` それぞれで `init -backend=false -input=false && validate && test`（手元は `mise exec terraform@1.16.4 -- terraform`。資格情報なし）。イメージ（リポジトリ直下の `Dockerfile`。context に入るものは `.dockerignore` の許可リストで、`.github/scripts/image.sh` の入力パスと同じにする）は `docker build -t simulator:local . && .github/scripts/image-check.sh simulator:local`
- 画面: `npm run dev`（Vite の root は `ui/`。合成の板は `scripts/devFixtures.mjs` が dev サーバーでだけ配る）、`npm run build` で `dist/`（JSON を入れない）。322 行の板は `npm run fixtures -- --wide`（`fixtures/local/` に書く）
- 画面の検査: `npm run ui:check`（Playwright の Chromium。初回に `npx playwright install chromium`。CI に入らない手元の検査で、画面の縦・横スクロール 0px と折り返しの件数を出す。`--parts --max-wraps 0`・`--flows`。旧画面と比べる手順は `scripts/uiCheck.expect.json`（#91 で旧画面から控えた期待値。手で編集しない）と比べる。画面を触る PR には出力を貼る）。色のトークンの検査は `tests/ui/cssTokens.test.ts`（`npm test` に入る）

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

# option-simulator

日経225オプションの損益シミュレーター（建てる前の戦略検討用）。スマイルを反映した理論損益、日数・原資産・IV（水準・スキュー・急落プリセット）のシナリオ、テール表、ファー OTM を見るための拡大・スクロール、先物（ミニ）の足とデルタヘッジを扱う。

データは optionchan 形式の BigQuery の板（最新スナップショット）か、JSON ファイル・手入力。

設計: [`docs/design.md`](docs/design.md)

状態: 設計済み。縦切り 1（手元で損益が見える）を実装中（価格モデル `model/`、データ `data/`、合成の固定の板、画面のヘッダ・板・スマイル・ポジション一覧まで。損益グラフ・シナリオ・指標はこれから）。

## 開発

Node 22 を使う（`.node-version`）。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run dev        # 画面（ui/）。合成の板 latest.json を既定で読み、night_early / pre_open に切替、手元の JSON はファイル選択
npm run build      # dist/（合成の板は入らない。本番の画面は板の JSON をファイル選択で読む）
npm run fixtures   # 合成の板 JSON（fixtures/synthetic/）を作り直す。CI は fixtures:check で一致を検査
npm run fixtures -- --wide  # 322 行 × 2 限月の板を fixtures/local/synthetic_wide.json に書く（性能の確認用。コミットしない）
OPTIONCHAN_CALENDAR_URL=<URL> npm run calendar:sync  # 取引カレンダーと国民の祝日を data/calendar/ に同期（下の「取引カレンダー」）
```

## 板のデータ

- `fixtures/synthetic/*.json`: 開発・テストの既定の板。Black-76 から作った **架空の値**（生成器 `scripts/synthBoard.ts`）。形は `docs/design.md` 7.1
- `fixtures/local/`: 実データ（optionchan の板）の dump を手元で試す置き場。**gitignore 済みで、コミットしない**（JPX 由来のデータを公開リポジトリに置かない）。`/api/chain` と同じ形の JSON を置くと `npm test` が検証・正規化を試し（`tests/data/local.test.ts`。件数だけ出す）。`npm run dev` の画面のファイル選択でも読める。Issue / PR には件数・割合などの要約だけを書く

## 画面（縦切り 1c）

- ヘッダ: 板の時刻・約 N 分遅れ・最新 / 板寄せ前、日経平均・先物、限月ごとの取引最終日・SQ 日・F（合成先物 / 先物で代用）、ATM の基準 A（ラージ先物）/ B（合成先物。既定）の切替と両方の基準価格。基準価格がスナップショットより 30 分以上古ければ「古い」
- 板: 限月タブ、bid を押すと売り・ask を押すと買いの足が入る。「ATM へ戻る」、OTM 度・|Δ| へのジャンプ、ask ≤ 50 円の絞り込み、印（IV 不安定・補間・外挿・JPX の IV 欠損・気配なし）。板の枠が狭い（560px 未満。スマホや 2 ペインの中間幅）ときは call / put 切替で K・bid / ask・IV だけ
- スマイル: OTM 側の bid / ask / mid の IV と σ_smile の線（節点区間は実線、補間・外挿は点線、不安定は ×）、ATM の縦線。横軸は行使価格 / moneyness / デルタ、[−][＋][⟲] で拡大
- ポジション: 足ごとの商品・限月・売買・枚数・建値・IV・Δ（ラージ / ミニ）・Γ・Θ・V・建値ずれ・SQ 日・印。枚数・建値・IV・売買を編集できる。先物の足（既定ミニ）と板の無い限月の OP の足（手入力）を追加できる。保存はまだ無い（再読み込みで消える）
- 板の無い限月の足の SQ 日は取引カレンダー（下）で求める。その限月の第 2 金曜が確定の最終日より後なら「休業日未確定」。ヘッダの前提に同期日と確定の最終日、評価時刻がカレンダーの `covered_until` を過ぎたら「カレンダー期限切れ」

## 取引カレンダー

板の無い限月の SQ 日・取引最終日は、休業日 = 土日 ∪ optionchan の `config/trading_calendar.toml` の `closed_dates` ∪ 国民の祝日で求める（`docs/design.md` 5.2・7.5）。どちらも `data/calendar/` の JSON（`npm run calendar:sync` が書く生成物。手で編集しない）をビルドに入れる。ビルドはネットワークに出ない。

- **同期**: `OPTIONCHAN_CALENDAR_URL=<URL> npm run calendar:sync`。`<URL>` は自分の optionchan のリポジトリの toml の raw URL（例 `https://raw.githubusercontent.com/<OWNER>/<REPO>/<BRANCH>/config/trading_calendar.toml`）。国民の祝日は内閣府の CSV（既定の URL。`HOLIDAYS_CSV_URL` で上書き可）。内容が同じなら書き換えない。取得・形の検査に失敗したら何も書かずに exit 1（2 ファイルはまとめて書き、書き込みの途中で失敗したら元に戻す）。URL は出力しない
- **定期同期**（`.github/workflows/calendar-sync.yml`。毎週月曜 + 手動）: **secret** `OPTIONCHAN_CALENDAR_URL`（必須。`gh secret set OPTIONCHAN_CALENDAR_URL`。Actions のログではマスクされる。未設定ならワークフローは警告だけで成功終了）と、任意でリポジトリ変数 `HOLIDAYS_CSV_URL` を設定し、Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」を有効にする。差分があればブランチ `calendar-sync` の PR ができる（PR は 1 本。差分が無くなれば閉じる）。差分（`covered_until`・`closed_dates`・祝日）を optionchan の toml・内閣府の公表と見比べてマージする
  - `GITHUB_TOKEN` で作った PR には `pull_request` の CI が走らないので、ワークフローが `ci.yml` を `workflow_dispatch` で起動して `check` を付ける。付いていなければ `gh workflow run ci.yml --ref calendar-sync`
  - 同期が失敗したら（toml の形の変更など）ジョブが失敗する。`scripts/calendarSync.ts` の検査と toml を見比べて直す
- **祝日の一覧の更新**: 同じワークフローで自動（内閣府は例年 2 月ごろに翌年分を公表）。収録期間が短くなる CSV は取り込まない

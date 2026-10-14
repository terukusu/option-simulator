# option-simulator

日経225オプションの損益シミュレーター（建てる前の戦略検討用）。スマイルを反映した理論損益、日数・原資産・IV（水準・スキュー・急落プリセット）のシナリオ、テール表、ファー OTM を見るための拡大・スクロール、先物（ミニ）の足とデルタヘッジを扱う。

データは optionchan 形式の BigQuery の板（最新スナップショット）か、JSON ファイル・手入力。

設計: [`docs/design.md`](docs/design.md)

状態: 設計済み。縦切り 1（手元で損益が見える）を実装済み（価格モデル `model/`、データ `data/`、合成の固定の板、画面のヘッダ・板・スマイル・ポジション一覧・損益グラフ（拡大・パン）・シナリオのスライダー・指標・テール表）。縦切り 3 のデルタヘッジ（#19）・先物の basis 固定 / 減衰の切替（#25）を実装済み。縦切り 2 の API（`api/`。板 `/api/chain` とカレンダー `/api/calendar`。#33）を実装済みで、画面からの利用・デプロイはこれから。

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

API（`api/`。Python 3.13 + Flask。uv 0.12.19）。手順の詳細・環境変数は [`api/README.md`](api/README.md)。

```sh
cd api
uv sync --locked --python 3.13
uv run --locked ruff check
uv run --locked pytest -q
GCP_PROJECT=<PROJECT_ID> uv run --locked flask --app simulator_api.app run -p 8080   # ADC で BigQuery を読む（読み取りのみ）
DATA_SOURCE=file CHAIN_FILE=../fixtures/synthetic/latest.json uv run --locked flask --app simulator_api.app run -p 8080  # GCP なし
```

`npm run dev` は `/api` を `127.0.0.1:8080`（手元の Flask）へ渡す（Vite の `server.proxy`）。

## 板のデータ

- `fixtures/synthetic/*.json`: 開発・テストの既定の板。Black-76 から作った **架空の値**（生成器 `scripts/synthBoard.ts`）。形は `docs/design.md` 7.1
- `fixtures/local/`: 実データ（optionchan の板）の dump を手元で試す置き場。**gitignore 済みで、コミットしない**（JPX 由来のデータを公開リポジトリに置かない）。`/api/chain` と同じ形の JSON を置くと `npm test` が検証・正規化を試し（`tests/data/local.test.ts`。件数だけ出す）。`npm run dev` の画面のファイル選択でも読める。Issue / PR には件数・割合などの要約だけを書く

## 画面（縦切り 1c・#11・#6・#19）

- ヘッダ: 板の時刻・約 N 分遅れ・最新 / 板寄せ前、日経平均・先物、限月ごとの取引最終日・SQ 日・F（合成先物 / 先物で代用）、ATM の基準 A（ラージ先物）/ B（合成先物。既定）の切替と両方の基準価格。基準価格がスナップショットより 30 分以上古ければ「古い」
- 板: 限月タブ、bid を押すと売り・ask を押すと買いの足が入る。「ATM へ戻る」、OTM 度・|Δ| へのジャンプ、ask ≤ 50 円の絞り込み、印（IV 不安定・補間・外挿・JPX の IV 欠損・気配なし）。板の枠が狭い（560px 未満。スマホや 2 ペインの中間幅）ときは call / put 切替で K・bid / ask・IV だけ
- 損益グラフ（右ペインの先頭。スマホは板の下）: 横軸 = 基準原資産 X（円）、縦軸 = 損益。線は満期（SQ。折れ点 K − basis_i を頂点に持つ解析解）・指定日 + シナリオ・今日（横軸 1 画素 1 点で再サンプリング）。今日の線はシナリオ IV を掛けない基準の線（d = ΔX = Δσ = Δs = 0。β と sticky の設定は横軸の各点に効く）で、指定日の線は d > 0 または Δσ・Δs ≠ 0 のときだけ描く。印は損益 0 の線、X₀ の縦線、シナリオ点 X₀ + ΔX の縦線、満期の折れ点と BEP
  - 縦軸: 自動（表示中の範囲の線と 0）/ 手動（下端・上端を円で）/ ±N 倍（受取 − 支払の N 倍。既定 5。プレミアム 0 なら自動）。目盛りは 10 万円以上で千円
  - 横軸の初期範囲は X₀・全足の折れ点・満期の BEP + 余白、縮小の上限は板の全限月の行使価格の位置と初期範囲の和（下端は全足の原資産が 0 以上の点）
- シナリオ（損益グラフの下）: スライダー 4 本 + 数値欄（経過日数 d 0〜最遠の足の SQ・1 日 / 原資産 ΔX −40〜+20%・0.5%（円表示は 100 円）/ IV 平行移動 Δσ −10〜+40pt・0.5 / スキュー Δs −5〜+5・0.5）。スライダーにフォーカスして ← → ↑ ↓ で 1 刻み、Shift + 矢印・PageUp / PageDown で 10 刻み、Home / End で端、R でそのスライダーの既定値、+ / − で損益グラフの拡大・縮小。数値欄は範囲外・数でない入力を受け付けない（`−` と先頭の `+` は可）。急落プリセット 3 つ（3 スライダーを同時に設定）、β（既定 1.0pt / 1%、0 で無効）、sticky strike / moneyness、[シナリオをリセット]（β・動き方は保つ）。[basis 固定 / basis 減衰]（先物の足を OP の SQ・指定日に評価するときの basis。減衰は先物の SQ で 0 へ線形。#25）。「SQ 日 9:00」「取引最終日 15:45」は対象の限月（足の限月。既定は SQ が最も近い限月）の時刻に評価時刻を置く d を入れる
- 指標（シナリオの下）: 満期の最大利益・最大損失（解析解。call 側 ∞ のときは put 側の有限値を併記）と BEP、指定日 + シナリオのシナリオ点の理論損益と BEP、合計グリーク（Δ ラージ / ミニ・Γ / 100 円・Θ 円 / 日・V 円 / pt）、足別（`<details>`）、受取 / 支払・手数料・スプレッドコスト・建値ずれ。支払超なら掛け金（支払 − 受取 + 手数料）と利益が掛け金の 1・5・10 倍になる原資産。金額の単位は受取 + 支払が 10 万円未満なら円、以上なら千円（[自動 / 円 / 千円]）。手数料（1 枚あたり円、既定 0）を入れられる
- テール表: 原資産 −5〜−40% の行 × {SQ, 指定日 + シナリオ IV（β 込み）} の損益と倍率 ×|損益 / 基準|（基準は受取超なら受取、支払超なら掛け金）
- 拡大・パン（損益グラフとスマイルで共通。M10）: ホイール = カーソル位置で拡大・縮小（横スクロールはパン）、ドラッグ / 1 本指 = パン、2 本指 = 拡大・縮小、ダブルクリック / ダブルタップ / [⟲] = リセット、[−][＋]。グラフをクリック・Tab でフォーカスしてキー + / − / ← / → / R。グラフの中ではページがスクロールしないので、スマホはグラフの外（ツール行・凡例）でスクロールする
- スマイル: OTM 側の bid / ask / mid の IV と σ_smile の線（節点区間は実線、補間・外挿は点線、不安定は ×）、ATM の縦線。横軸は行使価格 / moneyness / デルタ。点（× を含む）をタップ / クリックすると最寄りの行使価格（12px 以内）を選び、下の操作行「K 64,000 put: [売り（bid）] [買い（ask）]」で板と同じ規則の足が入る（ドラッグでは選ばない。限月の切替・板の読み直しで消える）
- ポジション: 足ごとの商品・限月・売買・枚数・建値・IV・Δ（ラージ / ミニ）・Γ・Θ・V・建値ずれ・SQ 日・印。枚数・建値・IV・売買を編集できる。先物の足（既定ミニ）と板の無い限月の OP の足（手入力）を追加できる。保存はまだ無い（再読み込みで消える）
- デルタヘッジ（ポジションの下。#19）: 目標 Δ（ラージ換算、既定 0）に要るミニ・ラージ先物の枚数（符号つき）と追加後の残りを出し、[追加] で先物の足（既定はミニ・板の先物の限月・建値は板の先物価格）が入る。評価点はシナリオ適用前（ポジション一覧の Δ）/ シナリオ時点（指標のシナリオ点）。限月は板の OP の限月も選べる（建値の初期値はその月の合成先物）。ミニが 0 枚ならマイクロ換算を併記。枚数は足・シナリオ・目標の変更ごとに出し直す（再ヘッジ）
- 板の無い限月の足の SQ 日は取引カレンダー（下）で求める。その限月の第 2 金曜が確定の最終日より後なら「休業日未確定」。ヘッダの前提に同期日と確定の最終日、評価時刻がカレンダーの `covered_until` を過ぎたら「カレンダー期限切れ」

## 取引カレンダー

板の無い限月の SQ 日・取引最終日は、休業日 = 土日 ∪ optionchan の `config/trading_calendar.toml` の `closed_dates` ∪ 国民の祝日で求める（`docs/design.md` 5.2・7.5）。どちらも `data/calendar/` の JSON（`npm run calendar:sync` が書く生成物。手で編集しない）をビルドに入れる。ビルドはネットワークに出ない。

- **同期**: `OPTIONCHAN_CALENDAR_URL=<URL> npm run calendar:sync`。`<URL>` は自分の optionchan のリポジトリの toml の raw URL（例 `https://raw.githubusercontent.com/<OWNER>/<REPO>/<BRANCH>/config/trading_calendar.toml`）。国民の祝日は内閣府の CSV（既定の URL。`HOLIDAYS_CSV_URL` で上書き可）。内容が同じなら書き換えない。取得・形の検査に失敗したら何も書かずに exit 1（2 ファイルはまとめて書き、書き込みの途中で失敗したら元に戻す）。URL は出力しない
- **定期同期**（`.github/workflows/calendar-sync.yml`。毎週月曜 + 手動）: **secret** `OPTIONCHAN_CALENDAR_URL`（必須。`gh secret set OPTIONCHAN_CALENDAR_URL`。Actions のログではマスクされる。未設定ならワークフローは警告だけで成功終了）と、任意でリポジトリ変数 `HOLIDAYS_CSV_URL` を設定し、Settings → Actions → General の「Allow GitHub Actions to create and approve pull requests」を有効にする。差分があればブランチ `calendar-sync` の PR ができる（PR は 1 本。差分が無くなれば閉じる）。差分（`covered_until`・`closed_dates`・祝日）を optionchan の toml・内閣府の公表と見比べてマージする
  - `GITHUB_TOKEN` で作った PR には `pull_request` の CI が走らないので、ワークフローが `ci.yml` を `workflow_dispatch` で起動して `check` を付ける。付いていなければ `gh workflow run ci.yml --ref calendar-sync`
  - 同期が失敗したら（toml の形の変更など）ジョブが失敗する。`scripts/calendarSync.ts` の検査と toml を見比べて直す
- **祝日の一覧の更新**: 同じワークフローで自動（内閣府は例年 2 月ごろに翌年分を公表）。収録期間が短くなる CSV は取り込まない

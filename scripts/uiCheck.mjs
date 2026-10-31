// 画面の検査（`npm run ui:check`。#81、docs/ui-redesign.md §10.1）。Chromium（Playwright）で画面を開き、
// ページの縦・横スクロールと折り返しの件数を数値で出す。CI には入れない（手元で流し、各 PR に出力を貼る）。
//
// 前提: `npm ci` の後に一度 `npx playwright install chromium`（ブラウザは手元のキャッシュに入る。リポジトリには入らない）。
// 板は dev サーバーの合成の板（fixtures/synthetic/ の latest）。足は tests/ui/saved/workspace-v2.json のタブ A（足 2 本）を
// 作業の保存（版 2）として localStorage に入れて開く（UI の操作に依存しない）。
//
//   npm run ui:check                       画面（クエリなし。#91 で既定に切り替え旧画面を削除）: 360 / 390 / 900 / 1440 ×
//                                          ダーク / ライト、
//                                          スマホはシート hidden / peek / full × パネル 5 つ。各状態で舞台の読み取り
//                                          （.readout .ro）が画面内に見えているか（スマホ 3・900 と 1440 で 5。#82・#274）。
//                                          シナリオ（#83）の .stepper .val b・チップが切れていないか（scrollWidth ≤ clientWidth）を
//                                          「モデルの前提」の閉 / 開の両方で（開いた状態は縦・横・折り返し・読み取りも測る）。
//                                          ポジション（#84）の .leg-title（名前・@建値）・枚数の .stepper .val b・⇄・× が切れて
//                                          いないか、詳細を 1 本開いた状態の縦・横・折り返し・読み取り。
//                                          指標（#86）のタイルの .k・.v・テール表の全セル・（開いていれば）内訳の各行が切れて
//                                          いないか（と .panel-body の中で横にはみ出していないか）を、スマホの「指標」peek / full・
//                                          900（ドックで指標を開く）・1440 で。内訳を開いた状態（360 peek・390 full・900・1440）の
//                                          縦・横・折り返し・読み取り。
//                                          副題（#107）: タイルの .s・読み取りの .s の切れがすべて全文のボタン（aria-expanded）の中
//                                          で、ボタンの数がタイル 6・読み取り 0（#274）。既定の足と掛け金の足
//                                          （買い 2 本）は千円（自動）で切れ 0、円固定の足（売り 5 枚）は件数だけ
//                                          証拠金（#131）: 資金あり（prefs の capital_yen）の売り 5 枚 × 4 幅 × ダーク / ライトで
//                                          縦・横・折り返し・読み取り、タイル 6 枚・テール表・テールの証拠金の表が切れない・表が 5 行。
//                                          #274: デルタヘッジの常設の行（1440・360 full で 1 行、空の舞台で 0 行）、1440×900 の
//                                          テール表の全セルと余力のタイルが窓の中
//                                          市場（#85）: 板の列の数（360・390・900・1200×800・1280×800 で 5、1440 で 7、1800×1000 で 9）・
//                                          見えている行のセル・ツールの行・脚注の F / ATM / SQ・スマイルのツールの行・操作行（選択なし / あり）・
//                                          凡例が切れていない・.board-wrap が横にはみ出さない・スマイルの描画域（360 peek で 140px 以上）。
//                                          1200 / 1280 / 1800 は市場の列の中の折り返しを判定（ページ全体は記録）。322 行の板
//                                          （buildWideChainJson を /fixtures/latest.json に差し替え）× 既定の字幅 / 実機相当の字幅
//                                          （--mono を DejaVu Sans Mono = Menlo と同じ 0.6em に。無ければ skip）でも測る
//                                          トップバー（#87 (A)）: 4 幅 × ダーク / ライトの既定の作業と最も混む作業（タブ 6 個・12 字の
//                                          名前 + 保存した最後の板 + 合成の板の読み込みの失敗 = ピルに 読めない・古い板 + 別のタブの
//                                          警告のタグ）で、高さが --top-h・ピルの時刻・F・ATM（スマホは時刻）・[最新]・⋯ が切れず画面内・
//                                          中の折り返し 0。開いた状態（知らせのトースト・⋯ メニュー・ピルのポップオーバー・警告のタグ・
//                                          共有を開く確認。360 / 390 / 1440）の縦・横・折り返しと窓の中。waitReady は市場ピルの
//                                          data-state を待ち、起動時の知らせのトーストを閉じてから測る。
//                                          #87 (B): トップバーの検査に BOX タブ（作業中のチップが帯の矩形と窓の中・全チップの本数が
//                                          切れない・＋ が窓の中・帯にスクロールバーが出ない）、開いた状態にタブのメニュー・
//                                          名前を変える…・共有の URL（writeText を reject に差し替え）・＋ のメニュー（1 個閉じてから）
//                                          #87 (C): 開いた状態に設定・保存一覧（名前 3 つ・1 つは 40 字で保存した後）。タブのメニュー・
//                                          ⋯ メニューは URL をコピーが押せる（URL ができた）のを待ってから撮る
//                                          空の舞台（#111）: 足 0 本（板あり）× 4 幅 × ダーク / ライトで格子 4 本以上・0 の線・横の目盛り
//                                          （数字）2 個以上・縦の目盛りと単位 0・注記が前面・ハンドル / マーカー / X₀ 0・tabindex -1
//                                          面モード（#88 段 A）: 360 / 390（シート hidden / peek）・900・1440 × ダーク / ライトで面に
//                                          切り替えて縦・横・折り返し・読み取り、凡例行の [線 | 面]（ある幅で）・色の見本・±vmax が
//                                          切れず画面内・canvas がある。1280×800・1800×1000 は記録だけ（--shots の撮影用）
//                                          IV 推移（#79 段 B）: 4 幅 × ダーク / ライトで IV 推移を開いた状態（PC は市場の Seg、タブレットは
//                                          ドックの IV → [IV 推移 | スマイル]、スマホは IV のシート peek / hidden / full）の縦・横・
//                                          折り返しと、見出し・ツールの行（足・ローソク / 線・⟳）・読み取りの 1 行・凡例が切れない
//                                          （scrollWidth ≤ clientWidth）・描画域の高さ・進行中の足が 1 本。線のモードも同じ検査。
//                                          段 C で「今」の印 1 個・シナリオの水準の線 1 本（凡例に値が入っても切れない）を足した。
//                                          #130: 各状態で描画域にフォーカスして , → 十字線 2 本・札 2 個が svg の内側・横の札 = 読み取りの
//                                          時刻・縦の札 = 横線の高さの IV。ドックの IV（スマホ 360 / 390・タブレット 900 × ダーク / ライト:
//                                          .lbl が「IV」・切れ / 折り返し 0・スマホでアイコンの svg 1 個）と初めて開いたときの中身
//                                          （aria-label「IV 推移」・Seg の 1 つ目が押されている）。スマホ・タブレットのスマイルの検査は
//                                          パネルの中で [スマイル] を選んでから（smileTab）
//                                          追証マップ（#174）: 資金あり・売り 5 枚 × 360（指標 peek / full）・390・900・1440 ×
//                                          ダーク / ライトで、見出しを枠の下端に置いて開くと描画域が .panel-body の中（見出しと
//                                          一緒に入る幅では見出しも）、/fixtures/atm_daily を止めた間は枠（≥ 200px）の中にスピナー（reduce では
//                                          animation none）と `過去の値動きを読み込み中…`（状態の行に無い・切れない）、読めたら消える、
//                                          閉じても scrollTop を動かさない
//                                          損益グラフの十字線（#201）: 360 / 1440 × ダーク / ライトでマウスを 4 か所に載せ、十字線 2 本・
//                                          札 2 個（svg の内側・文字が矩形に収まる）・読み取り 2〜3 行が描画域の内側・札 = 目盛りの値、
//                                          縦・横・折り返し。--flows: 1440 のホバー（縦線 = マウスの X・横線 = マウスの高さ・外れて 0・
//                                          ドラッグのパン・長押しのシナリオ点）、390 のタッチ（タップで置く・交点のドラッグ・読み取りの
//                                          タップで消す・長押しのシナリオ点・パン・描画域の外のタップで消す）
//   npm run ui:check -- --parts            部品の見本（?parts。dev だけ）
//   npm run ui:check -- --flows            保有の印の手順（#301: 360×780 と 1440×900 で保有のチップの「保」・タブのメニュー・
//                                          ポジションの ⋯ の写しの建て直しと押せない全クリア・保存一覧の「保有」のタグ。折り返し・切れ・
//                                          ページのスクロール 0px。--shots で held-*.png）と
//                                          保存・共有・テーマ・キーボードの手順（#81 AC-11・AC-12）と入口の手順（#91: クエリなし・
//                                          古い ?ui=next と旧画面を開いていた ui の値で同じ画面・部品の見本の ?parts・旧画面のときの
//                                          保存（版 1 / 2）を開く）と舞台の手順
//                                          （#82: ハンドル・IV / 時間レール・キー・足マーカー・Long Animation Frame）とシナリオの手順
//                                          （#83: ステッパーの ± / Shift / スクラブ / ホイール / キー / 数値入力・プリセット・評価時刻・
//                                          前提・#82 のレールとの一致・Long Animation Frame。390×844 と 1440×900）と作業台の手順
//                                          （#84: 枚数・⇄・× と [元に戻す]・全クリアと [元に戻す]・詳細の入力・足の追加ダイアログ・
//                                          ヘッジ・舞台の足マーカー → 行の強調・Long Animation Frame。390×844 と 1440×900）と指標の手順
//                                          （#86: 旧画面から控えた内訳・テール表の値との一致（scripts/uiCheck.expect.json）・内訳の指定日の損益と読み取りの一致・Δσ ±0.5 の追従
//                                          （390 は IV レールの ↑ / ↓）・Long Animation Frame。390×844 と 1440×900）と副題の全文の手順
//                                          （#107: タイル 6 枚（#131 で 6 → 8、#274 で 6）のタップで全文・内訳との一致・Esc でボタンへ戻る・
//                                          外側で閉じる・同時に 1 つ・Tab → Enter / Space・窓と .panel-body の中・読み取りは押せない（#274）・
//                                          Long Animation Frame。390×844 と 1440×900）と市場の手順
//                                          （#85: bid / ask で足が入る・追従・[元に戻す]・ジャンプと強調・ask ≤ 50 円・put / call・限月・
//                                          スマイルの操作。390×844・1440×900・1800×1000。322 行の板の Long Animation Frame・限月の切替の
//                                          時間。限月・種別・絞り込み・横軸が再読み込みと作業の保存に残る）とトップバーの手順
//                                          （#87 (A): [最新] の読み込み中 / 失敗（/api/chain を差し替え）・失敗のトーストが成功で消える・
//                                          ⋯ > ファイルを開く…・限月の切替と旧画面（控え）の F / ATM の一致・全文の数値の列が旧画面（控え）の header.header（前提の区間を除く。#279）
//                                          を含む・復元のトースト 6 秒・壊れた保存の警告のトースト・別のタブの警告のタグ・タブが 6 個の
//                                          共有を開く確認・タブの切り替えで [元に戻す] だけ消える。390×844 と 1440×900）と BOX タブの手順
//                                          （#87 (B) AC-12: ＋ の空 / 複製・クリックと ← → Home End・名前を変える…（B2 / 空 / 重複）・
//                                          閉じる → [元に戻す]（切り替えても残る = AC-15(e)）・6 個で ＋ が disabled・切り替え 10 回の
//                                          Long Animation Frame。390×844 と 1440×900）と URL 共有の手順（AC-13: タブのメニュー・⋯ の
//                                          URL をコピー → トースト・クリップボード・新しいコンテキストで同じ足・拒否 = 共有の URL の
//                                          ダイアログ・?ui=next で開いたページからの URL にも ui なし・上限の確認で前の共有の警告のトーストを消す。1440×900）。
//                                          全クリアの直後の舞台の格子（#111: 1440 で 4 本以上、390 はシート full のミニで 0）と
//                                          設定と保存一覧の手順（#87 (C) AC-14: ATM の基準・単位・手数料がすぐ効いて保存に入る、#275 で
//                                          縦軸は舞台の ⋯、テーマは ☾（スマホは設定）で確かめる、保存 → [上書き]（確認なし）→ [元に戻す] で保存一覧がバイト単位で同じ・
//                                          削除の確認・開く / 新しいタブで開く / 重ねる・保存一覧の書き出し / 読み込み…・Esc でフォーカスが戻る。
//                                          390×844 と 1440×900）とタッチの端末のエミュレーション（AC-19: hasTouch・isMobile の
//                                          390×844 で帯の横スワイプ（CDP の dispatchTouchEvent）・タップの切替とメニュー・
//                                          トーストの外とドックが押せる・⋯ からファイルの選択が開く。iPhone の Safari は手動）と
//                                          面モードの手順（#88 段 A AC-12・AC-14: canvas の矩形・描画域の中 / 外の画素・線が無い・
//                                          色が --gain / --loss（ダーク / ライト）・キーで点が動きラベルと読み取りが一致・IV レールで
//                                          色が変わる・線に戻す・ミニは線・再読み込みで線・Long Animation Frame・DPR 2 の backing。
//                                          390×844 と 1440×900）と面の上のドラッグの手順（#88 段 B AC-13・AC-14: ● のドラッグで
//                                          ΔX と d が同時に動き保存・時間レール・副題と一致・離れた所のクリックで点がそこへ・横軸の
//                                          目盛りが変わらない・線モードは横だけ・足マーカーのタップ・Long Animation Frame。390×844 と
//                                          1440×900。390×844 のタッチのエミュレーションで 2 本目の指で押す前に戻りピンチで狭まる）と
//                                          全体のキーの手順（#89 段 A AC-A4: body から 1〜5 でパネルとスクロールする枠のフォーカス・G で描画域と
//                                          → の ΔX +100・描画域の 0 はリセット・T で反転と prefs・設定 / ⋯ / 数値入力では効かない・
//                                          板の行 / 指標のテール表のクリックと 1 / 5 の後・板の K のボタン（#282）の後の PageDown で枠が動く。
//                                          390×844 と 1440×900、900×1100 は参考）とコマンドパレットの手順（#89 段 B AC-B5:
//                                          Ctrl + K で開く・↑↓ と押せない行・急落・足の追加と [元に戻す]・ATM へ・テーマ / 設定・
//                                          Esc / 背景で閉じてフォーカスが戻る・開いている間の 1 / G / T と 2 つ目・メニュー / 設定の上・
//                                          322 行の板で開く / 打つの Long Animation Frame。390×844 と 1440×900）と動きの手順
//                                          （#91 段 C AC-C1・C2: プリセットの直後の線の transition d 0.22s・ドラッグ中の .live と 0s・
//                                          足マーカーの legmark-in 120ms・シート peek → full の height 0.18s、reducedMotion: 'reduce' で
//                                          0s / なし。AC-C6: 読み直しで ATM へ跳び直さない。AC-C7: 1〜5 の行き先の名前。AC-C3: 連続の
//                                          操作の Long Animation Frame 0 件と離散の変更の件数（参考）。390×844 と 1440×900）
//                                          と IV 推移の手順（#79 段 B AC-10・AC-12: atm_iv への要求の回数 = 起動 0 → 開く 1 → 閉じて開き
//                                          直す 1 → ⟳ 2 → 足の切替（1 分・5 分・15 分は 1 回を共有、読み済みは 0）→ トップバーの [最新] で
//                                          増えない、.iv-bar.progress・.iv-line.progress が 1 個、失敗 → [再試行]。390×844 と 1440×900）
//                                          と IV 推移の追加読み込み・重ね（#79 段 C AC-9・AC-11: 左へパンして端から 10 本で左の 1 回分
//                                          （UTC の 0 時・end = 読み済みの start・読み中は 2 本目なし・左上のバッジ）、前に足しても横の
//                                          目盛りが同じ、空の左 3 回で止まる、「今」の印 1 個 / 表の last_at が板より後なら 0 個、
//                                          PC はシナリオの水準 = 今 + 5.00（Δσ +5）→ [急落] で 今 + 39.45（Δσ 20 + β 1 × g(−10%) = 19.45。#306））
//                                          と IV 推移の十字線（#130 AC-7: 1440×900 のホバーで十字線・札（横線 = マウスの高さ・縦の札 =
//                                          その高さの IV・上端で止まる・外れて 0）・キー , . で端の足まで札が svg の内側、390×844 の
//                                          タッチ（CDP）の長押し 500ms → 横・縦に動かす → 離す → タップで消える・ページとシートが動かない）
//                                          とドックの IV の既定と保持（390×844・900×1100: 起動 0 回 → IV で IV 推移・1 回 → [スマイル] →
//                                          別のパネル → IV でスマイルのまま・タブレットのキー 2）
//                                          先物推移（#190 AC-9）: 4 幅 × ダーク / ライトで先物を開いた状態（PC は市場の Seg、スマホ・
//                                          タブレットは IV のパネルの [IV 推移 | スマイル | 先物]、スマホは peek / hidden / full）の縦・横・
//                                          折り返しと IV 推移と同じ部品の検査（シナリオの水準は無い）・十字線の札（円の整数）。
//                                          --flows: future_bars への要求 = 起動 0 → IV 推移を開いて 0（atm_iv 1）→ 先物 1（atm_iv
//                                          増えない）→ 閉じて開き直し 1 → ⟳ 2 → [最新] で増えない、日足で限月交代の印 ≥ 1・線は交代でもつながる（つなぎ足）・読み取りに
//                                          限月、先物で日足 → IV 推移も日足（足を保つ）。390×844 と 1440×900
//                                          AI のチャット（#135 AC7）: 360 / 390（AI のシート peek / full）・900（ドックの AI）・1440
//                                          （トップバーの [AI] で左の列（市場）を入れ替え。#280）× ダーク / ライトで縦・横・折り返し・舞台の読み取り、
//                                          ドック 6 つ（タブレット 5 つ）の文字が切れない、押す前に残り（$）が見出しに見えて切れない、
//                                          免責の文は初めてだけ（閉じて開き直すと出ない）、偽の SSE の診断の返答を出した状態も測る
//                                          #135 AC6（--flows）: 390×844 と 1440×900 で [このポジションを診断] → 進み具合が出るまで < 1,000 ms・
//                                          考え中 → 書いています → 完了の順・中止で止まる・終端なし（「切断」）で incomplete・追加の質問の
//                                          ツールのカードと [シナリオに適用] → [元に戻す]・提案のカードと [今のタブに適用] →
//                                          [元に戻す]（#139）・再読み込みで会話が残る（sessionStorage）
//                                          [AI に聞く]（#136 AC4）: 4 幅 × ダーク / ライトでタイル（満期 最大損失）・読み取り（Δ）・
//                                          テール表・IV 推移のボタンが窓の中で切れない、押すと AI のパネルで送り（吹き出しに見出し・
//                                          偽の返答）、縦・横 0px。AI が無効なら送らずに入力欄に質問の文と理由。
//                                          #263: 送った吹き出しの上端が枠の内側の上端 ±4px（送った直後と返答の後）・返答の
//                                          流れる間の枠の scrollTop の変化 ≤ 1px（末尾に追従しない）
//                                          #280（EPIC #281 終了条件 12）: 1440×900 で AI を開いた直後と返答の後に、AI が左の列・
//                                          指標のタイル 6 枚とテール表 5 行（18 セル）の下端 ≤ 900px・[AI] がチップ + svg で押されている
//                                          #277: 返答の後の空白が枠の内側の半分以下（返答が短く下詰めを縮めた
//                                          data-hold="end" のときだけ、返答の後の上端の下がりは枠の 55% まで）
//                                          ボタンのアイコン（#292 AC-7・AC-8）: 360×780・390×844 × ダーク / ライトで見えている記号ボタン
//                                          .btn.icon.sm が 32px 以上・中の svg.ic 18px・窓の中、IV 推移・先物推移のツールの行が切れず ⟳ が
//                                          内容の箱の中（既定 / 実機相当の字幅）、指標の内訳・追証マップ・モデルの前提の行 ≥ 36px、
//                                          1440×900 で 26px・svg 14px のまま。390 と 1440 で開閉の印が 90° 回り transition 0s
//   --ai                                   #135・#136 の項目だけ（既定の検査・--flows とも。手元の確かめ用）。
//                                          #242 のツールの結果を待つ間のカードは --ai（--flows なし）でだけ
//   --icons                                #292 のボタンのアイコンの項目だけ（既定の検査。手元の確かめ用）
//   --cross                                #217 の十字線の項目だけ（既定の検査・--flows とも。--flows は #201・#130・#207 のタッチの流れも。手元の確かめ用）
//   --back                                 #320 の戻るの項目だけ（--flows にも入る）: 390×844・1440×900 で、設定・保存一覧・ⓘ の吹き出し・
//                                          ⋯ のメニュー・説明カード・（PC）パレットを開く → 戻る 1 回でそれだけ閉じ URL・フォーカスが Esc と同じ、
//                                          ×・Esc・外のクリック・メニューの項目で閉じた後は戻る 1 回でアプリを離れる、重なり・置き換え・
//                                          進む・再読み込み（空振りの回数を出す）・共有 URL の #p=・履歴を積まない操作（AC-1-2〜AC-1-10）
//   --url <base>                           dev サーバーを起こさず、その URL を使う（例 http://127.0.0.1:5173/?parts）
//   --dom <file>                           body の下の要素の tag.class の並びを書き出す（DOM の変化の比較用）
//   --shots <dir>                          スクリーンショットを書く（合成の板だけ。リポジトリに入れない）
//   --max-wraps <n>                        折り返しが n 件を超えたら失敗にする（渡したときだけ判定）
//   --quotes-only                          #272: 気配だけの板（scripts/synthBoard.ts の quotesOnlyChainJson。気配の IV・JPX グリーク・
//                                          ATM の表示・約定・日経平均が null）で開く。newContext で作る画面の /fixtures/latest.json を
//                                          差し替える（322 行の板の差し替えは後から登録するのでそちらが優先）。IV 推移の「今」の印は
//                                          0 個を期待する（JPX の IV・ATM の表示が無いと iv30 を出さない）
//
// 動き（#91 段 C）: 既定の実行・--parts は reducedMotion: 'reduce'（終わった後の配置を測る）、--flows は no-preference。
// 縦・横 = ページのスクロール量（scrollHeight − innerHeight・scrollWidth − innerWidth）。body が切っている（overflow: hidden）
// はみ出しも数える（body の scrollHeight − clientHeight との大きい方）。
// 既定の実行の全状態（report のすべて）で、旧画面の CSS にだけあったクラス名（scripts/uiCheck.expect.json の old_classes）の
// 要素を数え、1 個でもあれば失敗（#91。EPIC #92 の終了条件 8）。
// 終了コード: 画面（部品の見本を含む）で縦か横が 0 より大きい、旧のクラス名の要素、読み取りの検査の失敗、--max-wraps の超過、
// --flows の fail で 1。
// 折り返しの規則は EPIC #92 の as-is と同じ: 直下のテキストが 40 字以下の要素で、その中身の行（getClientRects の上端）が
// 2 つ以上。P・LI・DD・TEXTAREA・OPTION と .help-popover・[role="tooltip"]・閉じた details の中は除く。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACE_KEY = 'option-simulator.workspace';
const PREFS_KEY = 'option-simulator.prefs';
const SIZES = [
  [360, 780],
  [390, 844],
  [900, 1100],
  [1440, 900],
];
const PHONE_MAX = 719.98;
/**
 * トップバーの [最新]（#87）。PC 幅では前に [AI]（#135。同じ btn sm）があるので `header.top > button.btn` では選ばない（#123）
 */
const LATEST_BTN = 'header.top > button.btn[title="API から板を読み直す"]';

// ---- 引数
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} には値が要る`);
    process.exit(2);
  }
  return v;
};
const known = new Set([
  '--parts',
  '--flows',
  '--url',
  '--dom',
  '--shots',
  '--max-wraps',
  '--ai',
  '--cross',
  '--quotes-only',
  '--icons',
  '--back',
]);
for (const a of args) {
  if (a.startsWith('--') && !known.has(a)) {
    console.error(`知らない引数: ${a}`);
    process.exit(2);
  }
}
const urlArg = value('--url');
const domFile = value('--dom');
const shotsDir = value('--shots');
const maxWrapsArg = value('--max-wraps');
const maxWraps = maxWrapsArg === null ? null : Number(maxWrapsArg);
if (maxWraps !== null && !(Number.isInteger(maxWraps) && maxWraps >= 0)) {
  console.error('--max-wraps は 0 以上の整数');
  process.exit(2);
}
const urlParams = urlArg ? new URL(urlArg).searchParams : new URLSearchParams();
const parts = flag('--parts') || urlParams.has('parts');
const flows = flag('--flows');
const aiOnly = flag('--ai');
const crossOnly = flag('--cross');
const iconsOnly = flag('--icons');
const quotesOnly = flag('--quotes-only');
const backOnly = flag('--back');
const mode = parts ? 'parts' : 'next';

// ---- 足 2 本の作業（版 2）: workspace-v2.json のタブ A だけ（fixture は変えない）
const fixture = JSON.parse(readFileSync(join(root, 'tests/ui/saved/workspace-v2.json'), 'utf8'));
const twoLegs = JSON.stringify({ ...fixture, active: 0, tabs: [fixture.tabs[0]] });
/**
 * 端末の設定（版 1）。extra = 証拠金のキー（#131。capital_yen など）。舞台の操作の案内（#276）は出した扱い
 * （既定の検査の画面を変えない。案内そのものは stageTipAll が stage_hint_seen なしで測る）
 */
const prefsText = (theme, extra = {}) =>
  JSON.stringify({ schema_version: 1, theme, stage_hint_seen: true, ...extra });
const share = JSON.parse(readFileSync(join(root, 'tests/ui/saved/share-v1.json'), 'utf8'));

// ---- 旧画面から控えた期待値（#91。scripts/uiCheck.expect.json）。合成の板・twoLegs の sha256 が控えたときと違えば
// 「期待値が古い」で fail にする（旧画面は消えたので取り直せない。黙って skip しない）
const EXPECT_PATH = join(root, 'scripts/uiCheck.expect.json');
const FIXTURE_PATH = 'fixtures/synthetic/latest.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fixtureSha = () => sha256(readFileSync(join(root, FIXTURE_PATH)));
const twoLegsSha = () => sha256(twoLegs);
const CALENDAR_PATH = 'data/calendar/calendar.json';
/** 控えた commit の同梱カレンダーの sha256（git が無い・浅い clone で commit が無いときは null） */
const calendarShaCache = new Map();
function calendarAtCommit(commit) {
  if (!calendarShaCache.has(commit)) calendarShaCache.set(commit, readCalendarAt(commit));
  return calendarShaCache.get(commit);
}
function readCalendarAt(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) return null;
  try {
    return sha256(
      execFileSync('git', ['show', `${commit}:${CALENDAR_PATH}`], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}
function loadExpect() {
  if (!existsSync(EXPECT_PATH)) return { data: null, why: 'scripts/uiCheck.expect.json が無い' };
  const data = JSON.parse(readFileSync(EXPECT_PATH, 'utf8'));
  const src = data.source ?? {};
  const why = [];
  if (src.fixture_sha256 !== fixtureSha()) why.push(`${FIXTURE_PATH} の sha256`);
  if (src.two_legs_sha256 !== twoLegsSha()) why.push('twoLegs（足 2 本の作業）の sha256');
  // 同梱のカレンダー（ピルの文・残り日数に入る）は控えた commit の版と比べる（#123。控えに sha256 が無いので git で読む）
  const first = !calendarShaCache.has(src.commit);
  const cal = calendarAtCommit(src.commit);
  if (cal === null && first)
    console.log(
      `参考  控えの commit の ${CALENDAR_PATH} を git で読めない（カレンダーの版は照合しない）`,
    );
  else if (cal !== sha256(readFileSync(join(root, CALENDAR_PATH))))
    why.push(`${CALENDAR_PATH} の版`);
  if (why.length)
    return {
      data: null,
      why: `期待値が古い: 合成の板・カレンダーが変わった（${why.join('・')}が控えと違う）。旧画面は消えたので取り直せない。vitest の純関数の比較に寄せるかをその PR で決める`,
    };
  return { data, why: '' };
}

// ---- Playwright（devDependency。無ければ手順を出して終わる）
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が無い。`npm ci` の後に `npx playwright install chromium` を実行する');
  process.exit(2);
}

// ---- dev サーバー（--url が無ければ vite.config.ts で中に起こす）
let server = null;
let base;
if (urlArg) {
  const u = new URL(urlArg);
  base = `${u.origin}${u.pathname}`;
} else {
  const { createServer } = await import('vite');
  server = await createServer({
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5199, strictPort: false },
  });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5199/';
}
const origin = new URL(base).origin;
/** 古い入口（#91 の前の ?ui=next と、旧画面を開いていた ui の値）。#91 からどれも同じ画面で開く */
const OLD_ENTRY_NEXT = '?ui=next';
const OLD_ENTRIES = [OLD_ENTRY_NEXT, '?ui=legacy', '?ui=old', '?a=1&ui=legacy'];
const entryUrl = (search) => {
  const u = new URL(base);
  u.search = search;
  return u.toString();
};
/** 画面はクエリなし（#91）、部品の見本は ?parts */
const pageUrl = (m) => {
  const u = new URL(base);
  u.search = m === 'parts' ? '?parts' : '';
  return u.toString();
};

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error(
    `Chromium を起動できない（\`npx playwright install chromium\` を実行する）: ${e.message}`,
  );
  await server?.close();
  process.exit(2);
}

/**
 * 動き（#91 段 C。§6）のエミュレーション: 既定の実行・--parts は reduce（動きが終わった後の配置を測る。途中の高さ・線で
 * 揺れない）、--flows は no-preference（実際の動きで測る）。コンテキストはすべてこの値で作る
 */
const REDUCED_MOTION = flows ? 'no-preference' : 'reduce';

/** localStorage を入れた新しいコンテキスト（UI を操作しない・再読み込みで入れ直さない） */
async function newContext(viewport, storage, colorScheme = 'dark', extra = {}) {
  const localStorage = Object.entries(storage).map(([name, v]) => ({ name, value: v }));
  const ctx = await browser.newContext({
    viewport,
    colorScheme,
    reducedMotion: REDUCED_MOTION,
    ...extra,
    storageState: { cookies: [], origins: localStorage.length ? [{ origin, localStorage }] : [] },
  });
  if (quotesOnly) await routeQuotesOnly(ctx);
  return ctx;
}

/**
 * 板の読み込みが終わるまで待つ。新しい画面は市場ピルの data-state が ready か failed になるまで（#87）。
 * 新しい画面では起動時の知らせのトースト（復元 6 秒・読み込みの失敗など）を [閉じる] で閉じてから返す
 * （スマホの下の行・読み取りに重なるため。#84 の noToasts と同じ理由）。知らせの手順だけ keepNotes で残す。
 * 閉じるのは要素の click()（フォーカスを動かさない = Tab の順の検査に影響しない）
 */
async function waitReady(page, m, opts = {}) {
  if (m === 'parts') {
    await page.waitForSelector('.parts-gallery', { timeout: 20000 });
  } else {
    await page.waitForSelector('.layout', { timeout: 20000 });
    await page.waitForSelector('.pill[data-state="ready"], .pill[data-state="failed"]', {
      timeout: 20000,
    });
  }
  await page.waitForTimeout(400);
  if (m === 'next' && !opts.keepNotes) await closeNotes(page);
}

/** 知らせのトーストを全部閉じる（#87） */
async function closeNotes(page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.toast.note > button')) b.click();
  });
  await page
    .waitForFunction(() => document.querySelectorAll('.toast.note').length === 0, undefined, {
      timeout: 3000,
    })
    .catch(() => {});
}

/**
 * 動き（#91 段 C）が終わるまで待つ: CSS の transition（線・塗りの d・読み取りの色・シートの高さ）と足マーカーの
 * legmark-in の finished（上限 1 秒）。板の強調（0.9 秒）・トーストは待たない。--flows で動きの直後に配置・線を読む手順に挟む
 */
async function settleMotion(page) {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter(
            (a) =>
              (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) ||
              a.animationName === 'legmark-in',
          )
          .map((a) => a.finished.catch(() => null)),
      ),
      new Promise((r) => setTimeout(r, 1000)),
    ]),
  );
}

/** ページのスクロールと折り返し（EPIC の as-is と同じ規則） */
function measure(page) {
  return page.evaluate(() => {
    // 検査自身の時間（板の 322 行・2 千要素の getComputedStyle で 50ms を超えうる）を Long Animation Frame の件数から
    // 除けるように記録する（loafSinceExcludingChecks）
    const t0 = performance.now();
    const wraps = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const txt = [...el.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join('')
        .trim();
      if (!txt) continue;
      if (['P', 'LI', 'DD', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      if (el.closest('.help-popover,[role="tooltip"],details:not([open])')) continue;
      if (txt.length > 40) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      if (lines.size > 1)
        wraps.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt.slice(0, 20)}」`);
    }
    // ページのスクロール量。body が overflow: hidden なので、body の中で切れて見えない分も足す
    // （ページは動かないが、はみ出しを見逃さない）
    const d = document.documentElement;
    const b = document.body;
    if (Array.isArray(window.__checkRanges)) window.__checkRanges.push([t0, performance.now()]);
    return {
      v: Math.max(d.scrollHeight - window.innerHeight, b.scrollHeight - b.clientHeight),
      h: Math.max(d.scrollWidth - window.innerWidth, b.scrollWidth - b.clientWidth),
      wraps,
    };
  });
}

/** body の下の要素の tag.class の並び */
function domList(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .map((el) => {
        const c = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).join('.');
        return c ? `${el.tagName.toLowerCase()}.${c}` : el.tagName.toLowerCase();
      })
      .join('\n'),
  );
}

let failed = false;
const domOut = [];

/** 旧画面の CSS にだけあったクラス名（#91。控えの old_classes。sha256 によらず使う） */
const OLD_CLASSES = existsSync(EXPECT_PATH)
  ? (JSON.parse(readFileSync(EXPECT_PATH, 'utf8')).old_classes ?? [])
  : [];
const oldClassStats = { states: 0, found: 0 };
/** 旧のクラス名の要素の数（名前ごと。0 個の名前は出さない） */
function oldClassHits(page) {
  return page.evaluate((names) => {
    const t0 = performance.now();
    const hits = [];
    for (const n of names) {
      const k = document.querySelectorAll(`.${CSS.escape(n)}`).length;
      if (k) hits.push(`${n} ${k}`);
    }
    // 検査自身の時間を Long Animation Frame の件数から除けるように記録する（measure と同じ）
    if (Array.isArray(window.__checkRanges)) window.__checkRanges.push([t0, performance.now()]);
    return hits;
  }, OLD_CLASSES);
}

async function report(page, label, w, h, shotName, shot = true) {
  const r = await measure(page);
  const hits = await oldClassHits(page);
  oldClassStats.states++;
  oldClassStats.found += hits.length;
  const bad = r.v > 0 || r.h > 0 || hits.length > 0 || OLD_CLASSES.length === 0;
  const over = maxWraps !== null && r.wraps.length > maxWraps;
  if (bad || over) failed = true;
  const mark = bad || over ? '  ← NG' : '';
  const old =
    OLD_CLASSES.length === 0
      ? '・旧のクラス名の一覧が無い'
      : hits.length
        ? `・旧のクラス名 ${hits.join('、')}`
        : '';
  console.log(
    `${label} ${w}x${h}: 縦 ${r.v}px 横 ${r.h}px 折り返し ${r.wraps.length} 件${old}${mark}`,
  );
  for (const s of r.wraps.slice(0, 30)) console.log(`    ${s}`);
  if (shotsDir && shot) await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
  return !(bad || over);
}

/**
 * 読み取り（大きな数字。#82 AC-12）: 表示している .readout .ro[data-ro] の個数が want、各要素が画面内（幅と高さ > 0）・
 * 中心の elementFromPoint がその要素の中（他の面に隠れていない）・値（.v）が切れていない（scrollWidth ≤ clientWidth）
 */
async function readoutCheck(page, label, want) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const items = [...document.querySelectorAll('.readout .ro[data-ro]')].filter(
      (el) => getComputedStyle(el).display !== 'none',
    );
    const bad = [];
    for (const el of items) {
      const b = el.getBoundingClientRect();
      const inView =
        b.width > 0 && b.height > 0 && b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const onTop = hit !== null && el.contains(hit);
      const v = el.querySelector('.v');
      const cut = !v || v.scrollWidth > v.clientWidth;
      if (!inView || !onTop || cut) {
        bad.push(
          `${el.getAttribute('data-ro')}${inView ? '' : ' 画面外'}${onTop ? '' : ' 隠れ'}${cut ? ' 切れ' : ''}`,
        );
      }
    }
    return { n: items.length, bad };
  });
  const ok = r.n === want && r.bad.length === 0;
  readoutStats.total++;
  if (ok) readoutStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: 読み取り ${r.n} / ${want} つ ${r.bad.join('・')}  ← NG`);
  await subCheck(page, label, 'readout', true);
  return ok;
}
const readoutStats = { pass: 0, total: 0 };

/**
 * 副題の全文（#107 AC-3）: 見えている副題（指標のタイルの .tile .s・読み取りの .readout .ro .s）のうち切れている
 * （scrollWidth > clientWidth）ものがすべて全文のポップオーバーのボタン（button[aria-expanded]）の中にある。
 * ボタンの数: タイルは見えているタイルの数（6）、読み取りは 0（#274 で全文をやめた = 読み取りの副題は切れたら NG）。
 * strict（千円（自動）の足）なら切れの件数 0 も条件。件数は統計に出す（円固定は yen = true で別に数える）
 */
async function subCheck(page, label, scope, strict, yen = false) {
  const r = await page.evaluate(
    ({ scope }) => {
      const vis = (el) => el.getClientRects().length > 0;
      const BTN = 'button[aria-expanded]';
      let items;
      let want;
      if (scope === 'tiles') {
        const sec = document.querySelector('section.metrics');
        if (!sec || !vis(sec)) return null;
        items = [...sec.querySelectorAll('.tile')].filter(vis);
        want = items.length;
      } else {
        items = [...document.querySelectorAll('.readout .ro[data-ro]')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        );
        // #274 で読み取りの全文のポップオーバーをやめた（ボタン 0。副題の切れは全部 NG）
        want = 0;
      }
      const btns = items.filter((el) => el.querySelector(`:scope ${BTN}`)).length;
      const subs = items.flatMap((el) => [...el.querySelectorAll('.s')]).filter(vis);
      const cut = subs.filter((el) => el.scrollWidth > el.clientWidth);
      const bare = cut
        .filter((el) => !el.closest(BTN))
        .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
      return {
        n: subs.length,
        btns,
        want,
        cut: cut.map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`),
        bare,
      };
    },
    { scope },
  );
  if (r === null) return true;
  const ok = r.bare.length === 0 && r.btns === r.want && (!strict || r.cut.length === 0);
  subStats.total++;
  if (ok) subStats.pass++;
  else failed = true;
  subStats.cut += r.cut.length;
  if (yen) subStats.cutYen += r.cut.length;
  const what = scope === 'tiles' ? 'タイル' : '読み取り';
  if (!ok) {
    console.log(
      `${label}: ${what}の副題 ${r.n} 個・ボタン ${r.btns} / ${r.want}・切れ ${r.cut.join('・') || 0}・ボタン外の切れ ${r.bare.join('・') || 0}  ← NG`,
    );
  } else if (r.cut.length > 0) {
    console.log(`${label}: ${what}の副題の切れ（全文あり）${r.cut.join('・')}`);
  }
  return ok;
}
const subStats = { pass: 0, total: 0, cut: 0, cutYen: 0 };

/**
 * シナリオ（#83 AC-9）: 見えている section.scenario の .stepper .val b・.chip が切れていない（scrollWidth ≤ clientWidth）。
 * 要約（.vals）は省略記号で可なので測らない。見えていなければ数えない
 */
async function scenarioCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.scenario');
    if (!sec || sec.getClientRects().length === 0) return null;
    const els = [...sec.querySelectorAll('.stepper .val b, .chip')].filter(
      (el) => el.getClientRects().length > 0,
    );
    const bad = els
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
    return { n: els.length, bad };
  });
  if (r === null) return true;
  const ok = r.n > 0 && r.bad.length === 0;
  scenarioStats.total++;
  if (ok) scenarioStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: シナリオの値・チップ ${r.n} 個 ${r.bad.join('・')}  ← NG`);
  return ok;
}
const scenarioStats = { pass: 0, total: 0 };

/** 「モデルの前提」を開いて測り（縦・横・折り返し・読み取り・シナリオの切れ）、閉じて戻す */
async function advOpenCheck(page, label, w, h, shotName, readouts) {
  const summary = page.locator('section.scenario details.adv summary');
  if ((await summary.count()) === 0 || !(await summary.isVisible())) return;
  await summary.click();
  await page.waitForTimeout(120);
  await report(page, `${label} 前提を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 前提を開く ${w}x${h}`, readouts);
  await scenarioCheck(page, `${label} 前提を開く ${w}x${h}`);
  await summary.click();
  await page.waitForTimeout(80);
}

/**
 * ポジション（#84 AC-10）: 見えている section.positions の .leg-title（名前・@建値）・枚数の .stepper .val b・⇄・× が
 * 切れていない（scrollWidth ≤ clientWidth。.leg-title は本文のボタンの幅にも収まる）。2 段目（.leg-sub）は省略記号で可。
 * 見えていなければ数えない
 */
async function positionsCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.positions');
    if (!sec || sec.getClientRects().length === 0) return null;
    const rows = [...sec.querySelectorAll('li.leg')].filter((el) => el.getClientRects().length > 0);
    const bad = [];
    let n = 0;
    for (const li of rows) {
      const main = li.querySelector('.leg-main');
      const title = li.querySelector('.leg-title');
      const els = [
        title,
        ...li.querySelectorAll('.leg-title .name, .leg-title .px, .stepper .val b, .ops button'),
      ];
      for (const el of els) {
        if (!el) continue;
        n++;
        if (el.scrollWidth > el.clientWidth) {
          bad.push(`「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
        }
      }
      if (main && title && title.scrollWidth > main.clientWidth) {
        bad.push(`本文「${title.textContent}」${title.scrollWidth}/${main.clientWidth}`);
      }
    }
    return { rows: rows.length, n, bad };
  });
  if (r === null) return true;
  const ok = r.bad.length === 0;
  positionsStats.total++;
  if (ok) positionsStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: ポジションの行 ${r.rows} 本 ${r.bad.join('・')}  ← NG`);
  return ok;
}
const positionsStats = { pass: 0, total: 0 };

/** ポジションの詳細を 1 本開いて測り（縦・横・折り返し・読み取り・行の切れ）、閉じて戻す（#84 AC-10） */
async function detailOpenCheck(page, label, w, h, shotName, readouts) {
  const main = page.locator('section.positions li.leg .leg-main').first();
  if ((await main.count()) === 0 || !(await main.isVisible())) {
    failed = true;
    console.log(`${label} 詳細を開く ${w}x${h}: 行が見えない  ← NG`);
    return;
  }
  await main.click();
  await page.waitForTimeout(150);
  const opened = (await main.getAttribute('aria-expanded')) === 'true';
  if (!opened) {
    failed = true;
    console.log(`${label} 詳細を開く ${w}x${h}: aria-expanded が true にならない  ← NG`);
  }
  detailStats.total++;
  if (opened) detailStats.pass++;
  await report(page, `${label} 詳細を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 詳細を開く ${w}x${h}`, readouts);
  await positionsCheck(page, `${label} 詳細を開く ${w}x${h}`);
  await main.click();
  await page.waitForTimeout(100);
}
const detailStats = { pass: 0, total: 0 };

/**
 * 指標（#86 AC-8）: 見えている section.metrics の (a) タイルの .k・.v、テール表の th・td .txt、（開いていれば）内訳の
 * .kv-grid > .k・.v が切れていない（scrollWidth ≤ clientWidth）、(b) .panel-body が横にはみ出していない
 * （overflow: auto なのでページの横スクロールに出ない。別に測る）。見えていなければ数えない
 */
async function metricsCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.metrics');
    if (!sec || sec.getClientRects().length === 0) return null;
    const els = [
      ...sec.querySelectorAll(
        '.tile .k, .tile .v, table.tail th, table.tail td .txt, .kv-grid > .k, .kv-grid > .v',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const bad = els
      .filter((el) => el.scrollWidth > el.clientWidth)
      .map((el) => `「${el.textContent}」${el.scrollWidth}/${el.clientWidth}`);
    const body = sec.querySelector('.panel-body');
    if (body && body.scrollWidth > body.clientWidth) {
      bad.push(`.panel-body ${body.scrollWidth}/${body.clientWidth}`);
    }
    return { n: els.length, bad };
  });
  if (r === null) return true;
  const ok = r.n > 0 && r.bad.length === 0;
  metricsStats.total++;
  if (ok) metricsStats.pass++;
  else failed = true;
  if (!ok) console.log(`${label}: 指標の値 ${r.n} 個 ${r.bad.join('・')}  ← NG`);
  await subCheck(page, label, 'tiles', true);
  return ok;
}
const metricsStats = { pass: 0, total: 0 };

/**
 * デルタヘッジの常設の行（#274 AC9・EPIC #281 終了条件 2）: ポジションの中の .hedge-row の数（visible = 見えているもの
 * だけ数える）が want、ダイアログの外にヘッジの段（.hedge .hl）が 0、各行の結論（.act = → ミニ N 枚）が切れず行の中
 * （scrollWidth ≤ clientWidth・右端 ≤ .txt の右端。再レビュー R5）
 */
async function hedgeRowsCheck(page, label, want, visible = true) {
  const r = await page.evaluate((visible) => {
    const vis = (el) => el.getClientRects().length > 0;
    const rows = [...document.querySelectorAll('section.positions .hedge-row')].filter(
      (el) => !visible || vis(el),
    );
    const lines = [...document.querySelectorAll('.hedge .hl')].filter(
      (el) => !el.closest('dialog'),
    ).length;
    // #274 再レビュー R5: 結論（.act = → ミニ N 枚）が切れていない（縮めない span・行の中に入る）
    const cut = rows
      .map((row) => {
        const act = row.querySelector('.txt > .act');
        const txt = row.querySelector('.txt');
        if (!act || !txt) return null;
        const a = act.getBoundingClientRect();
        const t = txt.getBoundingClientRect();
        return act.scrollWidth > act.clientWidth + 0.5 || a.right > t.right + 0.5
          ? `「${act.textContent}」${act.scrollWidth}/${act.clientWidth}・右端 ${Math.round(a.right)} > ${Math.round(t.right)}`
          : null;
      })
      .filter(Boolean);
    const acts = rows.filter((row) => row.querySelector('.txt > .act')).length;
    return {
      rows: rows.length,
      lines,
      text: rows[0]?.querySelector('.txt')?.getAttribute('title') ?? '',
      cut,
      acts,
    };
  }, visible);
  const ok = r.rows === want && r.lines === 0 && r.cut.length === 0 && r.acts === r.rows;
  hedgeRowStats.total++;
  if (ok) hedgeRowStats.pass++;
  else failed = true;
  console.log(
    `${label}: デルタヘッジの常設の行 ${r.rows} / ${want}${r.text ? `「${r.text}」` : ''}・ダイアログの外の段 ${r.lines}・結論の切れ ${r.cut.join('・') || 0} ${ok ? 'pass' : '← NG'}`,
  );
}
const hedgeRowStats = { pass: 0, total: 0 };

/**
 * 1440×900 の初期表示（#274 AC8・EPIC #281 終了条件 1）: 足 2 本の既定の作業で、テール表（table.tail:not(.margin-tail)）の
 * 全セル（th・td）と余力のタイルの bottom ≤ 窓の高さ（右の列の .panel-body はスクロールしていない初期表示）
 */
async function foldCheck(page, label) {
  const r = await page.evaluate(() => {
    const vh = window.innerHeight;
    const sec = document.querySelector('section.metrics');
    const cells = [
      ...(sec?.querySelectorAll(
        'table.tail:not(.margin-tail) thead th, table.tail:not(.margin-tail) tbody th, table.tail:not(.margin-tail) tbody td',
      ) ?? []),
    ];
    const room = sec?.querySelector('.tile[data-tile="room"]');
    const bottoms = cells.map((el) => el.getBoundingClientRect().bottom);
    const rows = sec?.querySelectorAll('table.tail:not(.margin-tail) tbody tr').length ?? 0;
    return {
      vh,
      rows,
      cells: cells.length,
      max: bottoms.length ? Math.max(...bottoms) : Number.NaN,
      room: room ? room.getBoundingClientRect().bottom : Number.NaN,
      scroll: sec?.querySelector('.panel-body')?.scrollTop ?? -1,
    };
  });
  const ok = r.rows === 5 && r.cells === 18 && r.max <= r.vh && r.room <= r.vh && r.scroll === 0;
  foldStats.total++;
  if (ok) foldStats.pass++;
  else failed = true;
  console.log(
    `${label}: テール表 ${r.rows} 行・セル ${r.cells} 個の下端の最大 ${Math.round(r.max)}px・余力のタイルの下端 ${Math.round(r.room)}px（窓 ${r.vh}px）${ok ? ' pass' : '  ← NG'}`,
  );
}
const foldStats = { pass: 0, total: 0 };

/** 指標の「内訳」を開いて測り（縦・横・折り返し・読み取り・指標の切れ）、閉じて戻す（#86 AC-8） */
async function breakdownOpenCheck(page, label, w, h, shotName, readouts) {
  const btn = page.locator('section.metrics .mx-toggle');
  if ((await btn.count()) === 0 || !(await btn.isVisible())) {
    failed = true;
    console.log(`${label} 内訳を開く ${w}x${h}: ボタンが見えない  ← NG`);
    return;
  }
  await btn.click();
  await page.waitForTimeout(150);
  const opened =
    (await btn.getAttribute('aria-expanded')) === 'true' &&
    (await page.locator('section.metrics .kv-grid > .v').count()) > 0;
  if (!opened) {
    failed = true;
    console.log(`${label} 内訳を開く ${w}x${h}: 開かない  ← NG`);
  }
  breakdownStats.total++;
  if (opened) breakdownStats.pass++;
  await report(page, `${label} 内訳を開く`, w, h, shotName);
  await readoutCheck(page, `${label} 内訳を開く ${w}x${h}`, readouts);
  await metricsCheck(page, `${label} 内訳を開く ${w}x${h}`);
  await btn.click();
  await page.waitForTimeout(100);
}
const breakdownStats = { pass: 0, total: 0 };

const PANELS = ['positions', 'board', 'scenario', 'metrics', 'smile'];

/** スマホの画面の状態（パネル・シート）をドックとつまみで作る（.layout の data-panel / data-sheet を読んで確かめる） */
async function setShell(page, panel, sheet) {
  const st = () =>
    page.evaluate(() => {
      const l = document.querySelector('.layout');
      return { panel: l?.getAttribute('data-panel'), sheet: l?.getAttribute('data-sheet') };
    });
  for (let i = 0; i < 8; i++) {
    const cur = await st();
    if (cur.panel === panel && cur.sheet === sheet) return true;
    if (cur.panel !== panel || cur.sheet === 'hidden') {
      // 別のパネル → そのパネル（hidden なら peek）。同じパネルで hidden → peek
      await page.click(`.dock button[data-panel="${panel}"]`);
    } else if (sheet === 'hidden') {
      await page.click(`.dock button[data-panel="${panel}"]`);
    } else {
      // peek ⇄ full はつまみのタップ
      await page.click('.grabber');
    }
    await page.waitForTimeout(120);
  }
  await settleMotion(page); // シートの高さ（#91 段 C。180ms）
  const cur = await st();
  return cur.panel === panel && cur.sheet === sheet;
}

/**
 * スマホ・タブレットの IV のパネル（smile）の中で [スマイル] を選ぶ（#130。開いたときの既定は IV 推移。押されていれば
 * クリックしない）。スマイルを測る所はこれを呼んでから測る（呼ばないと IV 推移を測ってしまう）。PC では呼ばない
 */
async function smileTab(page) {
  const seg = page.locator('section.smile .panel-head .seg button:has-text("スマイル")');
  if ((await seg.getAttribute('aria-pressed').catch(() => null)) !== 'true') await seg.click();
  await page
    .waitForSelector('section.smile .smile-month:not(.inactive) .smile-wrap', { timeout: 10000 })
    .catch(() => null);
  await page.waitForTimeout(120);
}

const dockStats = { pass: 0, total: 0 };

/**
 * ドックの IV（#130 AC-5）: smile のボタンの .lbl が「IV」・切れ / 折り返し 0（scrollWidth ≤ clientWidth・行が 1 つ）、
 * スマホでアイコン（.ic の svg）が 1 個見えている（タブレットは .ic を隠す）。ボタンの数はスマホ 6・タブレット 5（#135 で AI）
 */
async function dockIvCheck(page, label, phone) {
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.dock > button')];
    const b = document.querySelector('.dock button[data-panel="smile"]');
    const lbl = b?.querySelector('.lbl');
    if (!b || !lbl) return null;
    const lines = new Set([...lbl.getClientRects()].map((q) => Math.round(q.top))).size;
    const ics = [...b.querySelectorAll('.ic svg')].filter((e) => {
      const q = e.getBoundingClientRect();
      return q.width > 0 && q.height > 0;
    }).length;
    return {
      n: btns.length,
      text: (lbl.textContent ?? '').trim(),
      cut: lbl.scrollWidth > lbl.clientWidth || b.scrollWidth > b.clientWidth,
      lines,
      ics,
      name: b.getAttribute('aria-label'),
    };
  });
  dockStats.total++;
  const bad = [];
  if (!r) bad.push('ドックの smile のボタンが無い');
  else {
    if (r.text !== 'IV') bad.push(`ラベル「${r.text}」（IV のはず）`);
    if (r.cut) bad.push('ラベルが切れている');
    if (r.lines !== 1) bad.push(`ラベルが ${r.lines} 行`);
    if (r.n !== (phone ? 6 : 5)) bad.push(`ボタン ${r.n} 個`);
    if (r.ics !== (phone ? 1 : 0)) bad.push(`アイコンの svg が ${r.ics} 個見えている`);
    if (r.name !== 'IV 推移 · スマイル') bad.push(`読み上げの名前「${r.name}」`);
  }
  const ok = bad.length === 0;
  if (ok) dockStats.pass++;
  else failed = true;
  console.log(`${label}: ドックの IV ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`);
}

/** ドックの IV を初めて開いた直後（#130 AC-5）: section.smile の aria-label が「IV 推移」・Seg の 1 つ目が「IV 推移」で押されている */
async function ivFirstOpenCheck(page, label) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.smile');
    const first = sec?.querySelector('.panel-head .seg > button');
    return {
      name: sec?.getAttribute('aria-label') ?? null,
      first: (first?.textContent ?? '').trim(),
      pressed: first?.getAttribute('aria-pressed') ?? null,
      iv: !!sec?.querySelector('.iv-tools'),
    };
  });
  dockStats.total++;
  const ok = r.name === 'IV 推移' && r.first === 'IV 推移' && r.pressed === 'true' && r.iv;
  if (ok) dockStats.pass++;
  else failed = true;
  console.log(
    `${label}: 初めて開いた IV のパネル ${ok ? 'pass' : `aria-label「${r.name}」・1 つ目「${r.first}」 pressed=${r.pressed}・IV 推移 ${r.iv}  ← NG`}`,
  );
}

const h1Stats = { pass: 0, total: 0 };
const legendStats = { pass: 0, total: 0 };

/**
 * #276（EPIC #281 終了条件 6）: 舞台の線の凡例の各項目が省略されていない（見えている名前の scrollWidth ≤ clientWidth）。
 * 舞台の幅 < 560px は 満 / 指 / 今 の 1 字
 */
async function legendCheck(page, label) {
  const r = await page.evaluate(() => {
    const stage = document.querySelector('section.stage');
    const lg = document.querySelector('section.stage .legend');
    if (!stage || !lg) return null;
    const vis = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    const items = [...lg.querySelectorAll(':scope > span[title]')].filter(vis);
    return {
      narrow: stage.getBoundingClientRect().width < 560,
      items: items.map((el) => {
        const t = [...el.querySelectorAll(':scope > span')].find(vis);
        return {
          text: (t?.textContent ?? '').trim(),
          cut: !t || t.scrollWidth > t.clientWidth,
        };
      }),
    };
  });
  legendStats.total++;
  const bad = [];
  if (!r) bad.push('凡例が無い');
  else {
    if (r.items.length < 2) bad.push(`項目 ${r.items.length}`);
    for (const it of r.items) {
      if (it.cut) bad.push(`「${it.text}」が省略`);
      if (r.narrow && !['満', '指', '今'].includes(it.text))
        bad.push(`「${it.text}」が 1 字でない`);
    }
  }
  if (bad.length === 0) legendStats.pass++;
  else {
    failed = true;
    console.log(`${label}: 舞台の凡例 ${bad.join('・')}  ← NG`);
  }
}

const tipStats = { pass: 0, total: 0 };
const stepTapStats = { pass: 0, total: 0 };

/**
 * #276（EPIC #281 終了条件 7）: ステッパーの値を押して離すと入力欄。390 のタッチ（hasTouch）でシナリオの Δσ の値を
 * (1) 短いタップ (2) 1 秒の長押し（CDP の touchStart → 1s → touchEnd）で開いてフォーカスを持つ、(3) 開いた入力欄で ↑ → Δσ +0.5 が
 * すぐ保存され欄は開いたまま、(4) 横に 40px 動かす（スクラブ）では開かない。マウス（1440）のクリックでも開く
 */
async function stepperTapAll() {
  const val = 'section.scenario .stepper[data-name="dSigma"] > .val';
  const input = `${val} input`;
  const dSigma = (page) =>
    page.evaluate((k) => {
      const w = JSON.parse(localStorage.getItem(k) ?? 'null');
      return w?.tabs?.[w.active ?? 0]?.position?.scenario?.dSigma ?? null;
    }, WORKSPACE_KEY);
  const opened = (page) =>
    page.evaluate((sel) => {
      const i = document.querySelector(sel);
      return !!i && document.activeElement === i;
    }, input);
  const results = [];
  {
    const ctx = await newContext(
      { width: 390, height: 844 },
      { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
      'dark',
      { hasTouch: true, isMobile: true },
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await setShell(page, 'scenario', 'peek');
    await page.waitForTimeout(200);
    const esc = async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    };
    await page.tap(val);
    await page.waitForTimeout(500);
    results.push(['390 タッチのタップで開く', await opened(page)]);
    await esc();
    const b = await page.locator(val).boundingBox();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cx, y: cy }],
    });
    await page.waitForTimeout(1000);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
    results.push(['390 タッチの 1 秒の長押しで開く', await opened(page)]);
    // 自動保存は 500ms の debounce
    await page.waitForTimeout(700);
    const before = await dSigma(page);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(800);
    const after = await dSigma(page);
    results.push([
      `390 入力欄の ↑ で +0.5 がすぐ反映・欄は開いたまま（${before} → ${after}）`,
      after !== null && Math.abs(after - (before ?? 0) - 0.5) < 1e-9 && (await opened(page)),
    ]);
    await esc();
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: cx, y: cy }],
    });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx + i * 5, y: cy }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
    results.push([
      '390 横に 40px 動かす（スクラブ）では開かない',
      (await page.locator(input).count()) === 0,
    ]);
    await ctx.close();
  }
  {
    const ctx = await newContext(
      { width: 1440, height: 900 },
      { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await page.click(val);
    await page.waitForTimeout(300);
    results.push(['1440 マウスのクリックで開く', await opened(page)]);
    await ctx.close();
  }
  for (const [label, ok] of results) {
    stepTapStats.total++;
    if (ok) stepTapStats.pass++;
    else {
      failed = true;
      console.log(`next ステッパーの値を押す（#276）${label}  ← NG`);
    }
  }
}

/**
 * #276: 舞台の操作の案内（描画域の中の 1 行）。stage_hint_seen なしの足 2 本 × 360（シート peek）/ 1440 × ダーク / ライト:
 * 案内が 1 行（折り返さない・切れない）で描画域（.chart）の中・前面の操作を妨げない（pointer-events: none）→ 描画域を押すと
 * 消えて prefs に stage_hint_seen: true（ほかのキーは残る）→ 読み込み直しても出ない。面モード・足 0 本では出ない
 */
async function stageTipAll() {
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    for (const theme of ['dark', 'light']) {
      const prefs = JSON.stringify({ schema_version: 1, theme, capital_yen: 3_000_000 });
      const ctx = await newContext(
        { width: w, height: h },
        {
          [WORKSPACE_KEY]: twoLegs,
          [PREFS_KEY]: prefs,
        },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 操作の案内 ${w}x${h}`;
      await report(page, tag, w, h, `next-${w}x${h}-${theme}-stage-tip`);
      const r = await page.evaluate(() => {
        const tip = document.querySelector('section.stage .chart > .stage-tip');
        const chart = document.querySelector('section.stage .chart');
        if (!tip || !chart) return null;
        const t = tip.getBoundingClientRect();
        const c = chart.getBoundingClientRect();
        const lh = Number.parseFloat(getComputedStyle(tip).lineHeight) || 16;
        return {
          oneLine: t.height <= lh + 8,
          cut: tip.scrollWidth > tip.clientWidth,
          inside: t.left >= c.left && t.right <= c.right && t.top >= c.top && t.bottom <= c.bottom,
          passThrough: getComputedStyle(tip).pointerEvents === 'none',
          x: c.left + c.width / 2,
          y: c.top + c.height / 3,
        };
      });
      const bad = [];
      if (!r) bad.push('案内が出ない');
      else {
        if (!r.oneLine) bad.push('折り返し');
        if (r.cut) bad.push('切れ');
        if (!r.inside) bad.push('描画域の外');
        if (!r.passThrough) bad.push('押せてしまう');
        await page.mouse.click(r.x, r.y);
        await page.waitForTimeout(150);
        const after = await page.evaluate((key) => {
          const o = JSON.parse(localStorage.getItem(key) ?? '{}');
          return {
            tip: document.querySelectorAll('.stage-tip').length,
            seen: o.stage_hint_seen === true,
            kept: o.capital_yen === 3_000_000 && o.schema_version === 1,
          };
        }, PREFS_KEY);
        if (after.tip !== 0) bad.push('押しても消えない');
        if (!after.seen) bad.push('stage_hint_seen が書かれない');
        if (!after.kept) bad.push('ほかのキーが消えた');
        await page.reload();
        await waitReady(page, 'next');
        if ((await page.locator('.stage-tip').count()) !== 0) bad.push('読み込み直すと出る');
      }
      tipStats.total++;
      if (bad.length === 0) tipStats.pass++;
      else {
        failed = true;
        console.log(`${tag}: ${bad.join('・')}  ← NG`);
      }
      await ctx.close();
    }
  }
  // 足 0 本・面モードでは出さない（1440 のダーク）
  for (const [storage, what] of [
    [noLegs, '足 0 本'],
    [twoLegs, '面モード'],
  ]) {
    const ctx = await newContext(
      { width: 1440, height: 900 },
      {
        [WORKSPACE_KEY]: storage,
        [PREFS_KEY]: JSON.stringify({ schema_version: 1, theme: 'dark' }),
      },
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    if (what === '面モード') {
      await page.click('section.stage .stage-tools .cm button:has-text("面")');
      await page.waitForTimeout(200);
    }
    const n = await page.locator('.stage-tip').count();
    tipStats.total++;
    if (n === 0) tipStats.pass++;
    else {
      failed = true;
      console.log(`next dark 操作の案内 1440x900 ${what}: 案内が出る  ← NG`);
    }
    await ctx.close();
  }
}

/** #124 AC 3: アクセシビリティツリーに level 1 の見出しが 1 件（スマホはブランドを見た目だけ隠す） */
async function h1Check(page, label) {
  const n = await page.getByRole('heading', { level: 1 }).count();
  h1Stats.total++;
  if (n === 1) h1Stats.pass++;
  else {
    failed = true;
    console.log(`${label}: level 1 の見出しが ${n} 件（1 件のはず）  ← NG`);
  }
}

async function measureAll() {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const themes = ['dark', 'light'];
  for (const [w, h] of SIZES) {
    for (const theme of themes) {
      const storage = { [WORKSPACE_KEY]: twoLegs };
      storage[PREFS_KEY] = prefsText(theme);
      const ctx = await newContext({ width: w, height: h }, storage);
      const page = await ctx.newPage();
      await page.goto(pageUrl(mode));
      await waitReady(page, mode);
      const tag = `${mode} ${theme}`;
      const name = `${mode}-${w}x${h}-${theme}`;
      // トップバー（#87）: 既定の作業
      if (mode === 'next') await topBarCheck(page, `${tag} ${w}x${h}`);
      if (mode === 'next') await h1Check(page, `${tag} ${w}x${h}`);
      if (mode === 'next') await legendCheck(page, `${tag} ${w}x${h}`);
      if (mode === 'next' && w <= PHONE_MAX) {
        // シート 3 段階: peek（既定）→ hidden（開いているドックのボタン）→ full（もう一度で peek、つまみのタップ）
        await report(page, `${tag} peek`, w, h, `${name}-peek`);
        await readoutCheck(page, `${tag} positions/peek ${w}x${h}`, 3);
        await positionsCheck(page, `${tag} positions/peek ${w}x${h}`);
        await detailOpenCheck(page, `${tag} positions/peek`, w, h, `${name}-peek-detail`, 3);
        await page.click('.dock button[data-panel="positions"]');
        await page.waitForTimeout(150);
        await report(page, `${tag} hidden`, w, h, `${name}-hidden`);
        await readoutCheck(page, `${tag} positions/hidden ${w}x${h}`, 3);
        await page.click('.dock button[data-panel="positions"]');
        await page.click('.grabber');
        await page.waitForTimeout(150);
        await report(page, `${tag} full`, w, h, `${name}-full`);
        await readoutCheck(page, `${tag} positions/full ${w}x${h}`, 3);
        if (w === 360) await hedgeRowsCheck(page, `${tag} positions/full ${w}x${h}`, 1);
        await positionsCheck(page, `${tag} positions/full ${w}x${h}`);
        await detailOpenCheck(page, `${tag} positions/full`, w, h, `${name}-full-detail`, 3);
        const stageH = await page.evaluate(
          () => document.querySelector('section.stage')?.getBoundingClientRect().height ?? null,
        );
        if (stageH !== 92) {
          failed = true;
          console.log(
            `${tag} full ${w}x${h}: section.stage の高さ ${stageH}px（92px のはず）  ← NG`,
          );
        }
        await dockIvCheck(page, `${tag} ${w}x${h}`, true);
        // 残りのパネル × シート 3 段階（読み取りと、縦・横・折り返し）
        for (const panel of PANELS.slice(1)) {
          for (const sheet of ['peek', 'hidden', 'full']) {
            const ok = await setShell(page, panel, sheet);
            const lbl = `${tag} ${panel}/${sheet}`;
            if (!ok) {
              failed = true;
              console.log(`${lbl} ${w}x${h}: 画面の状態を作れない  ← NG`);
              continue;
            }
            await page.waitForTimeout(100);
            if (panel === 'smile' && sheet === 'peek') {
              // #130: 初めて開いた IV のパネルは IV 推移。スマイルの検査は [スマイル] を選んでから（hidden・full は保つ）
              await ivFirstOpenCheck(page, `${lbl} ${w}x${h}`);
              await smileTab(page);
            }
            const scn = panel === 'scenario' && sheet !== 'hidden';
            const mx = panel === 'metrics' && sheet !== 'hidden';
            const mk = (panel === 'board' || panel === 'smile') && sheet !== 'hidden';
            await report(page, lbl, w, h, `${name}-${panel}-${sheet}`, scn || mx || mk);
            await readoutCheck(page, `${lbl} ${w}x${h}`, 3);
            await positionsCheck(page, `${lbl} ${w}x${h}`);
            if (scn) {
              await scenarioCheck(page, `${lbl} ${w}x${h}`);
              await advOpenCheck(page, lbl, w, h, `${name}-${panel}-${sheet}-adv`, 3);
            }
            if (mk) {
              // 市場（#85）: 板 5 列・切れ・スマイルの描画域（360 peek で 140px 以上）。スマイルは選択あり / なし
              const smileMin = w === 360 && sheet === 'peek' ? 140 : null;
              await marketCheck(page, `${lbl} ${w}x${h}`, { cols: 5, smileMin });
              if (panel === 'smile') {
                await smilePick(page, true);
                await report(page, `${lbl} 選択あり`, w, h, `${name}-${panel}-${sheet}-pick`);
                await marketCheck(page, `${lbl} 選択あり ${w}x${h}`, { smileMin });
                await smilePick(page, false);
              }
            }
            if (mx) {
              await metricsCheck(page, `${lbl} ${w}x${h}`);
              // 内訳を開いた状態: 360 は peek、390 は full（#86 AC-8）
              if ((w === 360 && sheet === 'peek') || (w === 390 && sheet === 'full')) {
                await breakdownOpenCheck(page, lbl, w, h, `${name}-${panel}-${sheet}-kv`, 3);
              }
            }
          }
        }
      } else {
        await report(page, tag, w, h, name);
        if (mode === 'next') {
          const want = 5;
          await readoutCheck(page, `${tag} ${w}x${h}`, want);
          await scenarioCheck(page, `${tag} ${w}x${h}`);
          await positionsCheck(page, `${tag} ${w}x${h}`);
          await advOpenCheck(page, tag, w, h, `${name}-adv`, want);
          await detailOpenCheck(page, tag, w, h, `${name}-detail`, want);
          if (w >= 1200) {
            // PC は指標が常に見えている
            await hedgeRowsCheck(page, `${tag} ${w}x${h}`, 1);
            if (w === 1440 && h === 900) await foldCheck(page, `${tag} ${w}x${h}`);
            await metricsCheck(page, `${tag} ${w}x${h}`);
            await breakdownOpenCheck(page, tag, w, h, `${name}-kv`, want);
            // 市場（#85）: 板（既定）→ 市場の Seg でスマイル（選択なし / あり）→ 板へ戻す
            await marketCheck(page, `${tag} board ${w}x${h}`, { cols: marketCols(w) });
            await page.click('section.board .panel-head .seg button:has-text("スマイル")');
            await page.waitForTimeout(150);
            await report(page, `${tag} smile`, w, h, `${name}-smile`);
            await readoutCheck(page, `${tag} smile ${w}x${h}`, want);
            await marketCheck(page, `${tag} smile ${w}x${h}`, {});
            // 市場の列がスマイルのときも指標のタイルの副題の検査（#107）が通る
            await metricsCheck(page, `${tag} smile ${w}x${h}`);
            await smilePick(page, true);
            await report(page, `${tag} smile 選択あり`, w, h, `${name}-smile-pick`);
            await marketCheck(page, `${tag} smile 選択あり ${w}x${h}`, {});
            await smilePick(page, false);
            await page.click('section.smile .panel-head .seg button:has-text("板")');
            await page.waitForTimeout(150);
          } else {
            // タブレットはドックで「指標」を開いて測り、「ポジ」で戻す
            await page.click('.dock button[data-panel="metrics"]');
            await page.waitForTimeout(150);
            await report(page, `${tag} metrics`, w, h, `${name}-metrics`);
            await readoutCheck(page, `${tag} metrics ${w}x${h}`, want);
            await metricsCheck(page, `${tag} metrics ${w}x${h}`);
            await breakdownOpenCheck(page, `${tag} metrics`, w, h, `${name}-metrics-kv`, want);
            // 市場（#85）: ドックで「板」「スマイル」（選択なし / あり）。#130: ドックの IV は初めは IV 推移 → [スマイル]
            await dockIvCheck(page, `${tag} ${w}x${h}`, false);
            for (const view of ['board', 'smile']) {
              await page.click(`.dock button[data-panel="${view}"]`);
              await page.waitForTimeout(150);
              if (view === 'smile') {
                await ivFirstOpenCheck(page, `${tag} ${view} ${w}x${h}`);
                await smileTab(page);
              }
              await report(page, `${tag} ${view}`, w, h, `${name}-${view}`);
              await readoutCheck(page, `${tag} ${view} ${w}x${h}`, want);
              await marketCheck(page, `${tag} ${view} ${w}x${h}`, { cols: marketCols(w) });
              if (view === 'smile') {
                await smilePick(page, true);
                await report(page, `${tag} smile 選択あり`, w, h, `${name}-smile-pick`);
                await marketCheck(page, `${tag} smile 選択あり ${w}x${h}`, {});
                await smilePick(page, false);
              }
            }
            await page.click('.dock button[data-panel="positions"]');
            await page.waitForTimeout(150);
          }
        }
      }
      if (domFile) domOut.push(`## ${w}x${h} ${theme}`, await domList(page));
      await ctx.close();
    }
  }
  if (domFile) writeFileSync(domFile, `${domOut.join('\n')}\n`);
  if (mode === 'next') {
    // ピン 3 本の凡例（#82 のレビュー B1）: 各サイズのダークで
    for (const [w, h] of SIZES) {
      await pinCheck(w, h, false);
      // タブの名前が上限（12 文字）の長さ（レビュー block-1 の回帰の検査）
      await pinCheck(w, h, true);
    }
    // ΔX の数値欄の端（+900%・円の最大）の 360px（#144 AC-13）
    await wideDXCheck();
    console.log(`読み取りの検査: ${readoutStats.pass} / ${readoutStats.total} 状態で pass`);
    console.log(
      `シナリオの値・チップの検査: ${scenarioStats.pass} / ${scenarioStats.total} 状態で pass`,
    );
    console.log(
      `ポジションの行の検査: ${positionsStats.pass} / ${positionsStats.total} 状態で pass、詳細を開いた状態 ${detailStats.pass} / ${detailStats.total}`,
    );
    console.log(
      `指標の検査: ${metricsStats.pass} / ${metricsStats.total} 状態で pass、内訳を開いた状態 ${breakdownStats.pass} / ${breakdownStats.total}`,
    );
    // 掛け金の足・円固定の足（#107 AC-3）
    await subtitleAll();
    console.log(
      `副題の検査: ${subStats.pass} / ${subStats.total} 状態で pass、切れ ${subStats.cut} 件（うち円固定 ${subStats.cutYen} 件。すべて全文のボタンの中）`,
    );
    // 資金ありの売り 5 枚（#131 AC18）
    await marginAll();
    console.log(`証拠金の検査（#131）: ${marginStats.pass} / ${marginStats.total} 状態で pass`);
    console.log(
      `追証の線の検査（#131）: ${marginLineStats.pass} / ${marginLineStats.total} 状態で pass`,
    );
    // 追証マップを開いたときのスクロールと待ちのスピナー（#174 AC2・AC3）
    await holdMapAll();
    console.log(`追証マップの検査（#174）: ${holdStats.pass} / ${holdStats.total} 状態で pass`);
    // スマイルの [効率]（#163・#259）: 凡例・右の目盛り・操作行の案内
    await smileEffAll();
    console.log(
      `スマイルの [効率] の検査（#259）: ${effStats.pass} / ${effStats.total} 状態で pass`,
    );
    // 板の K のポップオーバー（#264）: 360（5 列）・1440（7 列）で開いて、縦・横 0px・中身が切れない・枠の中
    await boardKPopAll();
    console.log(
      `板の K のポップオーバーの検査（#264）: ${kpopStats.pass} / ${kpopStats.total} 状態で pass`,
    );
    // 市場の追加の状態（1200 / 1280 / 1800・322 行の板・字幅 2 通り。#85）
    await marketSweep();
    console.log(
      `市場の検査: ${marketStats.pass} / ${marketStats.total} 状態で pass${marketStats.skip ? `（実機相当の字幅は ${marketStats.skip} 幅で skip）` : ''}`,
    );
    // トップバー（#87 (A)）: 最も混む作業（タブ 6 個・保存した板 + 読み込みの失敗・別のタブ）と開いた状態
    await topSweep();
    console.log(`トップバーの検査: ${topStats.pass} / ${topStats.total} 状態で pass`);
    // 保有ポジションの一覧（#302 AC17）
    await holdingsSweep();
    console.log(
      `保有ポジションの一覧の検査（#302）: ${holdingsStats.pass} / ${holdingsStats.total} 状態で pass`,
    );
    console.log(`見出し h1 の検査（#124）: ${h1Stats.pass} / ${h1Stats.total} 状態で pass`);
    console.log(
      `舞台の凡例の省略の検査（#276）: ${legendStats.pass} / ${legendStats.total} 状態で pass`,
    );
    // 舞台の操作の案内（#276）
    await stageTipAll();
    console.log(`舞台の操作の案内の検査（#276）: ${tipStats.pass} / ${tipStats.total} 状態で pass`);
    // ステッパーの値を押す（#276）
    await stepperTapAll();
    console.log(
      `ステッパーの値を押す検査（#276）: ${stepTapStats.pass} / ${stepTapStats.total} で pass`,
    );
    console.log(`開いた状態の検査: ${openStats.pass} / ${openStats.total} で pass`);
    // 空の舞台（#111）: 足 0 本でも格子・横軸の目盛り・0 の線と注記
    await emptyStageAll();
    console.log(
      `空の舞台の検査（#111）: ${emptyStageStats.pass} / ${emptyStageStats.total} 状態で pass`,
    );
    console.log(
      `デルタヘッジの常設の行の検査（#274）: ${hedgeRowStats.pass} / ${hedgeRowStats.total} 状態で pass`,
    );
    console.log(
      `1440×900 のテール表と余力の初期表示の検査（#274）: ${foldStats.pass} / ${foldStats.total} 状態で pass`,
    );
    // 面モード（#88 段 A）
    await surfaceAll();
    console.log(`面モードの検査（#88）: ${surfaceStats.pass} / ${surfaceStats.total} 状態で pass`);
    // コマンドパレット（#89 段 B AC-B6）
    await paletteSweep();
    console.log(
      `コマンドパレットの検査（#89）: ${paletteStats.pass} / ${paletteStats.total} 状態で pass`,
    );
    // 用語の説明カード（#167 AC-9）
    await termCardSweep();
    console.log(
      `説明カードの検査（#167）: ${termCardStats.pass} / ${termCardStats.total} 状態で pass`,
    );
    // IV 推移（#79 段 B AC-13）
    await ivSweep();
    console.log(`IV 推移の検査（#79）: ${ivStats.pass} / ${ivStats.total} 状態で pass`);
    console.log(
      `IV 推移の十字線と札の検査（#130）: ${ivCrossStats.pass} / ${ivCrossStats.total} 状態で pass`,
    );
    console.log(`ドックの IV の検査（#130）: ${dockStats.pass} / ${dockStats.total} で pass`);
    // 先物推移（#190 AC-9）
    await futSweep();
    await futAllPanesSweep();
    await futLineWidthCheck();
    console.log(`先物推移の検査（#190）: ${futStats.pass} / ${futStats.total} 状態で pass`);
    console.log(
      `先物推移の段の操作の検査（#207）: ${paneStats.pass} / ${paneStats.total} 状態で pass`,
    );
    // 損益グラフの十字線（#201 AC-5）
    await pnlCrossAll();
    console.log(
      `損益グラフの十字線の検査（#201）: ${pnlCrossStats.pass} / ${pnlCrossStats.total} 状態で pass`,
    );
    // 十字線をそろえる（#217 AC-5）: スマイル・追証マップ・面のホバー
    await cross217All();
    console.log(
      `十字線（スマイル・追証マップ・面）の検査（#217）: ${cross217Stats.pass} / ${cross217Stats.total} 状態で pass`,
    );
    // AI のチャット（#135 AC7）
    await aiSweep();
    // 数字・パネルから [AI に聞く]（#136 AC4）
    await aiAskSweep();
    // ボタンのアイコン（#292 AC-7・AC-8）
    await iconSweep();
  }
  // 旧のクラス名（#91・EPIC #92 の終了条件 8）: report を通ったすべての状態の合計
  console.log(
    `旧のクラス名の検査（#91）: ${OLD_CLASSES.length} 個の名前 × ${oldClassStats.states} 状態で当たり ${oldClassStats.found} 件${OLD_CLASSES.length === 0 || oldClassStats.found ? '  ← NG' : ''}`,
  );
}

// ---- 市場（#85）: 板の列の数・切れ・スマイルの描画域の高さ
/** 板の列の数の期待（section.board の幅で 9 / 7 / 5。docs/ui-redesign.md §2.4） */
const marketCols = (w) => (w >= 1800 ? 9 : w >= 1440 ? 7 : 5);
/** 市場の検査だけを判定する追加の幅（ページ全体の縦・横・折り返しは記録だけ） */
const MARKET_SIZES = [
  [1200, 800],
  [1280, 800],
  [1800, 1000],
];
const marketStats = { pass: 0, total: 0, skip: 0 };

/**
 * 見えている板・スマイルの (a) 板の列の数（表示中の表の thead th）、(b) 見出し行・ツールの行・見えている行のセル /
 * ボタン・脚注（F / ATM / SQ）・スマイルのツールの行・操作行・凡例が切れていない（scrollWidth ≤ clientWidth）、
 * 表の枠 .board-wrap が横にはみ出していない、(c) スマイルの描画域の高さ（want.smileMin 以上）
 */
async function marketCheck(page, label, want) {
  const r = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const name = (el) =>
      `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().replace(/\s+/g, '.')}「${(el.textContent ?? '').trim().slice(0, 16)}」${el.scrollWidth}/${el.clientWidth}`;
    const bad = [];
    let n = 0;
    const test = (els) => {
      for (const el of els) {
        if (!vis(el)) continue;
        n++;
        if (el.scrollWidth > el.clientWidth) bad.push(name(el));
      }
    };
    const out = { board: null, smile: null };
    const board = document.querySelector('section.board');
    if (vis(board)) {
      const wrap = board.querySelector('.board-month:not(.inactive) .board-wrap:not(.side-hidden)');
      test(
        board.querySelectorAll(
          '.panel-head > h2, .panel-head .seg > button, .board-tools .row, .board-tools .seg > button, .board-tools .chip, .board-tools .btn, .board-foot, .board-foot > .f, .board-foot > .atm, .board-foot > .sq',
        ),
      );
      let rows = 0;
      if (wrap) {
        test([wrap]);
        const wr = wrap.getBoundingClientRect();
        for (const tr of wrap.querySelectorAll('tbody tr')) {
          rows++;
          const rr = tr.getBoundingClientRect();
          if (rr.bottom < wr.top || rr.top > wr.bottom) continue;
          test(tr.querySelectorAll('td, th, button, .legbadge'));
        }
      }
      out.board = { cols: wrap ? wrap.querySelectorAll('thead th').length : 0, rows };
    }
    const smile = document.querySelector('section.smile');
    if (vis(smile)) {
      test(
        smile.querySelectorAll(
          '.panel-head > h2:not(.sr), .panel-head .seg > button, .smile-tools, .smile-tools .seg > button, .smile-act, .smile-act > *, .smile-legend, .smile-legend > span',
        ),
      );
      const plot = smile.querySelector('.smile-month:not(.inactive) .smile-wrap');
      // 凡例の項目（レビュー S2）: 隠さない = 見えている項目が 5（シナリオ ATM があれば 6。#279 で bid / ask を外した）で、どれも凡例の箱の中
      const lg = smile.querySelector('.smile-legend');
      const lb = lg?.getBoundingClientRect();
      const items = [...(lg?.children ?? [])];
      const shown = items.filter((el) => {
        const b = el.getBoundingClientRect();
        return !!lb && b.width > 0 && b.left >= lb.left - 0.5 && b.right <= lb.right + 0.5;
      });
      out.smile = {
        height: plot ? Math.round(plot.getBoundingClientRect().height) : 0,
        picked: !!smile.querySelector('.smile-act .k'),
        legend: shown.length,
        legendWant: lg?.querySelector(':scope > .atm2') ? 6 : 5,
      };
    }
    return { ...out, n, bad };
  });
  if (!r.board && !r.smile) return true;
  const bad = [...r.bad];
  if (r.board && want.cols !== undefined && r.board.cols !== want.cols) {
    bad.push(`列 ${r.board.cols}（${want.cols} のはず）`);
  }
  if (r.board && r.board.rows === 0) bad.push('行が無い');
  if (r.smile && r.smile.legend !== r.smile.legendWant) {
    bad.push(`凡例の項目 ${r.smile.legend}（${r.smile.legendWant} のはず）`);
  }
  if (r.smile && want.smileMin && r.smile.height < want.smileMin) {
    bad.push(`描画域の高さ ${r.smile.height}px（${want.smileMin}px 以上のはず）`);
  }
  const ok = r.n > 0 && bad.length === 0;
  marketStats.total++;
  if (ok) marketStats.pass++;
  else failed = true;
  const what = r.board
    ? `板 ${r.board.cols} 列・${r.board.rows} 行`
    : `スマイル 高さ ${r.smile.height}px・凡例 ${r.smile.legend} 項目${r.smile.picked ? '・選択あり' : ''}`;
  console.log(`${label}: 市場 ${what}・${r.n} 個 ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`);
  return ok;
}

/** スマイルで選択を作る（描画域にフォーカスして . = 市場 ATM から）/ 消す（×） */
async function smilePick(page, on) {
  if (on) {
    const plot = page.locator('section.smile .smile-month:not(.inactive) .smile-wrap');
    await plot.focus();
    await page.keyboard.press('.');
  } else {
    const x = page.locator('section.smile .smile-act button[aria-label="選択を消す"]');
    if ((await x.count()) > 0) await x.click();
  }
  await page.waitForTimeout(120);
}

/** 市場の列（section.board / .smile）の中の折り返し（measure と同じ規則） */
function marketWraps(page) {
  return page.evaluate(() => {
    const wraps = [];
    for (const el of document.querySelectorAll('section.board *, section.smile *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0)
        continue;
      const txt = [...el.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join('')
        .trim();
      if (!txt || txt.length > 40) continue;
      if (['P', 'LI', 'DD', 'TEXTAREA', 'OPTION'].includes(el.tagName)) continue;
      if (el.closest('.help-popover,[role="tooltip"],details:not([open])')) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      if (lines.size > 1) wraps.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt}」`);
    }
    return wraps;
  });
}

/** scripts/synthBoard.ts（Vite のモジュールランナーで 1 回だけ読む。322 行の板と気配だけの板が共用） */
let synthBoardModule = null;
async function synthBoard() {
  if (!synthBoardModule) {
    const { runnerImport } = await import('vite');
    ({ module: synthBoardModule } = await runnerImport(join(root, 'scripts', 'synthBoard.ts'), {
      configFile: false,
      root,
      logLevel: 'error',
    }));
  }
  return synthBoardModule;
}
/** 合成の 322 行 × 2 限月の板（scripts/synthBoard.ts の buildWideChainJson。ファイルを書かない） */
let wideBoardText = null;
async function wideBoard() {
  if (wideBoardText) return wideBoardText;
  const module = await synthBoard();
  wideBoardText = module.serializeChainJson(module.buildWideChainJson());
  return wideBoardText;
}
/** dev の板の応答（/fixtures/latest.json）を 322 行の板に差し替える */
async function routeWide(target) {
  const body = await wideBoard();
  await target.route('**/fixtures/latest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body }),
  );
}

/** 気配だけの板（#272。latest.json から欠けうる項目を消す。ファイルを書かない） */
let quotesOnlyText = null;
async function routeQuotesOnly(target) {
  if (!quotesOnlyText) {
    const module = await synthBoard();
    const latest = JSON.parse(readFileSync(join(root, FIXTURE_PATH), 'utf8'));
    quotesOnlyText = module.serializeChainJson(module.quotesOnlyChainJson(latest));
  }
  const body = quotesOnlyText;
  await target.route('**/fixtures/latest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body }),
  );
}

/** 実機相当の等幅（Menlo / SF Mono と同じ 0.6em の DejaVu Sans Mono）が使えるか */
async function realMonoAvailable(page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    if (!c) return false;
    c.font = '20px "DejaVu Sans Mono", serif';
    const a = c.measureText('0000000000').width;
    const b = c.measureText('iiiiiiiiii').width;
    return Math.abs(a - b) < 0.5 && Math.abs(a / 200 - 0.602) < 0.02;
  });
}
/** --mono を実機相当の字幅に（CSSOM。検査だけ。製品のコードには入らない） */
async function useRealMono(page) {
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--mono', '"DejaVu Sans Mono", monospace'),
  );
  await page.waitForTimeout(300);
}

/**
 * 市場の検査の追加の状態（既定の 4 幅のほか）: (1) 1200×800・1280×800・1800×1000 の板 / スマイル（市場の検査と市場の列の中の
 * 折り返しを判定、ページ全体の縦・横・折り返しは記録）、(2) 322 行の板 × 既定の字幅 / 実機相当の字幅 × 全 7 幅の板 / スマイル
 * （選択なし / あり）。スクリーンショットは 1800 と 322 行の 390 / 1800
 */
async function marketSweep() {
  const sizes = [...SIZES, ...MARKET_SIZES].sort((a, b) => a[0] - b[0]);
  for (const [w, h] of MARKET_SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 市場`;
      for (const view of ['board', 'smile']) {
        if (view === 'smile') {
          await page.click('section.board .panel-head .seg button:has-text("スマイル")');
          await page.waitForTimeout(200);
        }
        const m = await measure(page);
        const mw = await marketWraps(page);
        const lbl = `${tag} ${view} ${w}x${h}`;
        console.log(
          `${lbl}: （記録）ページ 縦 ${m.v}px 横 ${m.h}px 折り返し ${m.wraps.length} 件・市場の列の中の折り返し ${mw.length} 件${mw.length ? '  ← NG' : ''}`,
        );
        for (const s of mw.slice(0, 10)) console.log(`    ${s}`);
        if (mw.length) failed = true;
        await marketCheck(page, lbl, { cols: marketCols(w) });
        if (view === 'smile') {
          await smilePick(page, true);
          await marketCheck(page, `${lbl} 選択あり`, {});
          if (shotsDir)
            await page.screenshot({
              path: join(shotsDir, `next-${w}x${h}-${theme}-smile-pick.png`),
            });
          await smilePick(page, false);
        } else if (shotsDir) {
          await page.screenshot({ path: join(shotsDir, `next-${w}x${h}-${theme}-board.png`) });
        }
      }
      await ctx.close();
    }
  }
  // 322 行の板 × 字幅 2 通り
  for (const mono of ['既定の字幅', '実機相当の字幅']) {
    for (const [w, h] of sizes) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
      );
      await routeWide(ctx);
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      if (mono !== '既定の字幅') {
        if (!(await realMonoAvailable(page))) {
          marketStats.skip++;
          console.log(`322 行 ${mono} ${w}x${h}: DejaVu Sans Mono が無いので skip`);
          await ctx.close();
          continue;
        }
        await useRealMono(page);
      }
      const tag = `next dark 322 行 ${mono}`;
      const phone = w <= PHONE_MAX;
      const tablet = !phone && w < 1200;
      for (const view of ['board', 'smile']) {
        const sheets = phone ? ['peek', 'full'] : [null];
        for (const sheet of sheets) {
          if (phone) {
            await setShell(page, view, sheet);
            if (view === 'smile') await smileTab(page);
          } else if (tablet) {
            await page.click(`.dock button[data-panel="${view}"]`);
            await page.waitForTimeout(150);
            if (view === 'smile') await smileTab(page);
          } else if (view === 'smile') {
            // PC: 市場の Seg で板 → スマイル
            await page.click('section.board .panel-head .seg button:has-text("スマイル")');
            await page.waitForTimeout(150);
          }
          await page.waitForTimeout(250);
          const lbl = `${tag} ${view}${sheet ? `/${sheet}` : ''} ${w}x${h}`;
          await marketCheck(page, lbl, {
            cols: marketCols(w),
            smileMin: w === 360 && sheet === 'peek' ? 140 : null,
          });
          const shotName = `next-${w}x${h}-dark-wide-${mono === '既定の字幅' ? 'default' : 'real'}-${view}${sheet ? `-${sheet}` : ''}`;
          if (view === 'smile') {
            await smilePick(page, true);
            await marketCheck(page, `${lbl} 選択あり`, {
              smileMin: w === 360 && sheet === 'peek' ? 140 : null,
            });
            if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shotName}-pick.png`) });
            await smilePick(page, false);
          } else if (shotsDir && (w === 390 || w === 1800 || w === 1440)) {
            await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
          }
        }
      }
      await ctx.close();
    }
  }
}

// ---- 副題の全文（#107）: 掛け金の足（買い 2 本）と円固定の足（売り 5 枚）。タブ A の足から作る（架空の建値）
const tabA = fixture.tabs[0];
const legsOf = (side, qty) =>
  tabA.position.legs.map((l) => ({ ...l, leg: { ...l.leg, side, qty } }));
const withLegs = (legs, ui = fixture.ui) =>
  JSON.stringify({
    ...fixture,
    ui,
    active: 0,
    tabs: [{ ...tabA, position: { ...tabA.position, legs } }],
  });
/** 買い 2 本（put 63,500 / call 71,000 を 1 枚ずつ。建値 640 / 520）= 掛け金のタイル */
const buyTwo = withLegs(legsOf('buy', 1));
/** 売り 5 枚ずつ・金額の単位を円に固定（桁が増える） */
const sellFiveYen = withLegs(legsOf('sell', 5), { ...fixture.ui, metrics_unit: 'yen' });

/**
 * 副題の検査の追加の状態（#107 AC-3）: 掛け金の足 × 4 幅 × 2 テーマ（千円・自動。切れ 0 が条件）と
 * 円固定の足 × 4 幅 × ダーク（件数だけ）。スマホは「指標」peek と full、900 はドックで指標、1440 はそのまま
 */
async function subtitleAll() {
  const runs = [
    ['掛け金', buyTwo, ['dark', 'light'], true],
    ['円固定', sellFiveYen, ['dark'], false],
  ];
  for (const [name, ws, themes, strict] of runs) {
    for (const [w, h] of SIZES) {
      for (const theme of themes) {
        const ctx = await newContext(
          { width: w, height: h },
          { [WORKSPACE_KEY]: ws, [PREFS_KEY]: prefsText(theme) },
        );
        const page = await ctx.newPage();
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        const tag = `next ${theme} ${name}`;
        const shot = `next-${w}x${h}-${theme}-sub-${strict ? 'stake' : 'yen'}`;
        const states = w <= PHONE_MAX ? ['peek', 'full'] : w >= 1200 ? ['pc'] : ['dock'];
        for (const st of states) {
          if (st === 'peek' || st === 'full') {
            if (!(await setShell(page, 'metrics', st))) {
              failed = true;
              console.log(`${tag} metrics/${st} ${w}x${h}: 画面の状態を作れない  ← NG`);
              continue;
            }
          } else if (st === 'dock') {
            await page.click('.dock button[data-panel="metrics"]');
          }
          await page.waitForTimeout(150);
          const lbl = `${tag} ${st}`;
          const want = w <= PHONE_MAX ? 3 : 5;
          if (strict) {
            await report(page, lbl, w, h, `${shot}-${st}`);
            await readoutCheck(page, `${lbl} ${w}x${h}`, want);
            await metricsCheck(page, `${lbl} ${w}x${h}`);
          } else {
            if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shot}-${st}.png`) });
            await subCheck(page, `${lbl} ${w}x${h}`, 'tiles', false, true);
            await subCheck(page, `${lbl} ${w}x${h}`, 'readout', false, true);
          }
        }
        await ctx.close();
      }
    }
  }
}

/** 架空の資金（#131。端末の設定の capital_yen） */
const MARGIN_CAPITAL = 60_000_000;
/** 売り 5 枚ずつ（千円・自動）= 証拠金の額・余力の桁が大きい足 */
const sellFive = withLegs(legsOf('sell', 5));

/**
 * 証拠金（#131 AC18）: 資金あり（prefs に capital_yen）の売り 5 枚 × 4 幅 × ダーク / ライト。スマホは「指標」peek と
 * full、900 はドックで指標、1440 はそのまま。各状態で縦・横・折り返し・読み取り（report）、タイル 8 枚・テール表・
 * テールの証拠金の表（table.tail.margin-tail）の切れ 0（metricsCheck）、表が 5 行・余力のタイルが — でない。
 * 1440 では内訳を開いた状態も測る（証拠金の群の行）
 */
async function marginAll() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        {
          [WORKSPACE_KEY]: sellFive,
          [PREFS_KEY]: prefsText(theme, { capital_yen: MARGIN_CAPITAL }),
        },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 証拠金`;
      const shot = `next-${w}x${h}-${theme}-margin`;
      const states = w <= PHONE_MAX ? ['peek', 'full'] : w >= 1200 ? ['pc'] : ['dock'];
      for (const st of states) {
        if (st === 'peek' || st === 'full') {
          if (!(await setShell(page, 'metrics', st))) {
            failed = true;
            console.log(`${tag} metrics/${st} ${w}x${h}: 画面の状態を作れない  ← NG`);
            continue;
          }
        } else if (st === 'dock') {
          await page.click('.dock button[data-panel="metrics"]');
        }
        await page.waitForTimeout(150);
        const lbl = `${tag} ${st}`;
        const want = w <= PHONE_MAX ? 3 : 5;
        await report(page, lbl, w, h, `${shot}-${st}`);
        await readoutCheck(page, `${lbl} ${w}x${h}`, want);
        await metricsCheck(page, `${lbl} ${w}x${h}`);
        const r = await page.evaluate(() => {
          const sec = document.querySelector('section.metrics');
          return {
            tiles: sec?.querySelectorAll('.tile').length ?? 0,
            rows: sec?.querySelectorAll('table.tail.margin-tail tbody tr').length ?? 0,
            room: sec?.querySelector('.tile[data-tile="room"] .v > span')?.textContent ?? '',
            margin: sec?.querySelector('.tile[data-tile="margin"] .v > span')?.textContent ?? '',
          };
        });
        const ok = r.tiles === 6 && r.rows === 5 && r.room !== '—' && r.margin !== '—';
        marginStats.total++;
        if (ok) marginStats.pass++;
        else failed = true;
        console.log(
          `${lbl} ${w}x${h}: タイル ${r.tiles}・証拠金の表 ${r.rows} 行・必要証拠金 ${r.margin}・余力 ${r.room} ${ok ? 'pass' : '← NG'}`,
        );
        if (st === 'pc') await breakdownOpenCheck(page, lbl, w, h, `${shot}-kv`, want);
        // 追証の線（#131 段 C）: 舞台が出ている状態（スマホの full は舞台がミニなので除く）
        if (st !== 'full') await marginLineCheck(page, `${lbl} ${w}x${h}`, `${shot}-${st}-line`);
      }
      await ctx.close();
    }
  }
}
const marginStats = { pass: 0, total: 0 };
const marginLineStats = { pass: 0, total: 0 };
const holdStats = { pass: 0, total: 0 };

/** 過去の値動き（dev の /fixtures/atm_daily）を止める route。release() で通す（#174） */
async function holdDailyGate(page) {
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  await page.route('**/fixtures/atm_daily*', async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

const effStats = { pass: 0, total: 0 };

/**
 * スマイルの [効率]（#163・#259）: 売り 5 枚 × 360（スマイル full）・1440 × ダーク / ライト × シナリオ（ΔX = 0 /
 * ΔX ≠ 0・d・Δσ = 今の線とシナリオ ATM も出る）。[効率] を押して線が出てから、縦・横・折り返し（report）、
 * 凡例に効率の項目（ΔX ≠ 0 は今も）があり 2 行以内（PC の ΔX = 0 は 1 行）で切れない、右の目盛りが 0% を含め 4 本以上、
 * 未選択の操作行の案内（.hint.eff）が 2 行（32px）に収まる（scrollHeight ≤ clientHeight）
 */
async function smileEffAll() {
  const moved = JSON.parse(sellFive);
  moved.tabs[0].position.scenario = {
    ...moved.tabs[0].position.scenario,
    dX: -1500,
    days: 10,
    dSigma: 4,
  };
  const still = JSON.parse(sellFive);
  still.tabs[0].position.scenario = {
    ...still.tabs[0].position.scenario,
    dX: 0,
    days: 0,
    dSigma: 0,
    skew: 0,
  };
  const runs = [
    ['ΔX ≠ 0', JSON.stringify(moved), true],
    ['ΔX = 0', JSON.stringify(still), false],
  ];
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    const phone = w <= PHONE_MAX;
    for (const theme of ['dark', 'light']) {
      for (const [sname, ws, now] of runs) {
        const ctx = await newContext(
          { width: w, height: h },
          {
            [WORKSPACE_KEY]: ws,
            [PREFS_KEY]: prefsText(theme),
          },
        );
        const page = await ctx.newPage();
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        const lbl = `next ${theme} スマイルの [効率] ${sname} ${w}x${h}`;
        let ok = true;
        const ng = (why) => {
          ok = false;
          console.log(`${lbl}: ${why}  ← NG`);
        };
        if (phone) {
          if (!(await setShell(page, 'smile', 'full'))) ng('画面の状態を作れない');
          await smileTab(page);
        } else {
          await page.click('section.board .panel-head .seg button:has-text("スマイル")');
          await page
            .waitForSelector('section.smile .smile-month:not(.inactive) .smile-wrap', {
              timeout: 10000,
            })
            .catch(() => null);
        }
        await page.click('section.smile button[aria-label="売りの効率の線"]');
        const drawn = await page
          .waitForSelector('section.smile .smile-month:not(.inactive) .eff-t', { timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (!drawn) ng('効率の線の目盛りが出ない');
        await page.waitForTimeout(300);
        const v = await page.evaluate(() => {
          const sec = document.querySelector('section.smile');
          const lg = sec?.querySelector('.smile-legend');
          const items = lg ? [...lg.querySelectorAll(':scope > span')] : [];
          const rows = new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size;
          const hint = sec?.querySelector('.smile-act > .hint');
          return {
            keys: items.map((i) => i.className),
            rows,
            cut: lg
              ? lg.scrollWidth > lg.clientWidth + 1 || lg.scrollHeight > lg.clientHeight + 1
              : true,
            ticks: [...(sec?.querySelectorAll('.smile-month:not(.inactive) .eff-t') ?? [])].map(
              (t) => t.textContent,
            ),
            hintCls: hint?.className ?? null,
            hintFits: hint ? hint.scrollHeight <= hint.clientHeight + 1 : false,
            hintH: hint ? Math.round(hint.getBoundingClientRect().height) : 0,
          };
        });
        if (!v.keys.includes('eff')) ng(`凡例に効率が無い（${v.keys.join(' ')}）`);
        if (now && !v.keys.includes('eff now')) ng('凡例に今の効率が無い');
        const maxRows = !phone && !now ? 1 : 2;
        if (v.rows > maxRows) ng(`凡例が ${v.rows} 行（${maxRows} 行まで）`);
        if (v.cut) ng('凡例が切れる');
        if (v.ticks.length < 4 || !v.ticks.includes('0%')) ng(`右の目盛り ${v.ticks.join(' ')}`);
        if (v.hintCls !== 'hint eff') ng(`操作行の案内のクラス ${v.hintCls}`);
        if (!v.hintFits || v.hintH > 33) ng(`操作行の案内が 2 行に入らない（${v.hintH}px）`);
        if (
          !(await report(
            page,
            lbl,
            w,
            h,
            `next-${w}x${h}-${theme}-smile-eff-${now ? 'moved' : 'still'}`,
          ))
        )
          ok = false;
        console.log(
          `${lbl}: 凡例 ${v.rows} 行・目盛り ${v.ticks.join(' ')}・案内 ${v.hintH}px ${ok ? 'pass' : '← NG'}`,
        );
        effStats.total++;
        if (ok) effStats.pass++;
        else failed = true;
        await ctx.close();
      }
    }
  }
}

const kpopStats = { pass: 0, total: 0 };

/**
 * 板の K のポップオーバー（#264）: 360×780（板 full・5 列）・1440×900（7 列）× ダーク / ライト × ATM の行・一番下の行
 * （遠い OTM の put。枠の下端で開く）。K を押して開き、見出し + 理論価格の 2 行（+ 印）があり、ポップオーバーが
 * .board-wrap と窓の左右の中、中身が切れない（scrollWidth ≤ clientWidth）、語の途中で折れない（括弧の中・印が 1 行）、
 * K のボタンに aria-haspopup="dialog"・aria-controls、.board-wrap が横にはみ出さない、ページの
 * 縦・横 0px（report）。もう一度押す・Esc・外側で閉じる、別の K で前のものが閉じる（同時に 1 つ）
 */
async function boardKPopAll() {
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    const phone = w <= PHONE_MAX;
    for (const theme of ['dark', 'light']) {
      for (const where of ['atm', 'last']) {
        const ctx = await newContext({ width: w, height: h }, { [PREFS_KEY]: prefsText(theme) });
        const page = await ctx.newPage();
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        const lbl = `next ${theme} 板の K のポップオーバー ${where} ${w}x${h}`;
        let ok = true;
        const ng = (why) => {
          ok = false;
          console.log(`${lbl}: ${why}  ← NG`);
        };
        if (phone && !(await setShell(page, 'board', 'full'))) ng('画面の状態を作れない');
        await page.waitForTimeout(300);
        const sel =
          where === 'atm'
            ? 'section.board .board-month:not(.inactive) .board-wrap:not(.side-hidden) tr.atm th.k .kbtn'
            : 'section.board .board-month:not(.inactive) .board-wrap:not(.side-hidden) tbody tr:last-child th.k .kbtn';
        const btn = page.locator(sel).first();
        await btn.scrollIntoViewIfNeeded().catch(() => null);
        await btn.click().catch(() => ng('K のボタンを押せない'));
        await page.waitForTimeout(200);
        const v = await page.evaluate(() => {
          const pop = document.querySelector('section.board .popover.kpop');
          const wrap = pop?.closest('.board-wrap');
          if (!pop || !wrap) return null;
          const r = pop.getBoundingClientRect();
          const b = wrap.getBoundingClientRect();
          const cut = [pop, ...pop.children].filter((el) => el.scrollWidth > el.clientWidth + 1);
          return {
            n: pop.children.length,
            text: pop.textContent ?? '',
            inWrap: r.left >= b.left - 0.5 && r.right <= b.right + 0.5,
            inWin: r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
            visible: r.bottom <= b.bottom + 0.5 && r.top >= b.top - 0.5,
            cut: cut.map((el) => el.className),
            wrapX: wrap.scrollWidth - wrap.clientWidth,
            expanded: wrap.querySelectorAll('.kbtn[aria-expanded="true"]').length,
            // 語の途中で折れない（#264 の再確認）: 折れるのは「（」の前だけ = 各塊が 1 行
            split: [...pop.querySelectorAll('.kpop-main, .kpop-note, .kpop-mark')]
              .filter((el) => el.getClientRects().length !== 1)
              .map((el) => el.textContent),
            aria: [...wrap.querySelectorAll('.kbtn[aria-expanded="true"]')].map(
              (b) =>
                `${b.getAttribute('aria-haspopup')}:${b.getAttribute('aria-controls') === pop.id}`,
            ),
          };
        });
        if (!v) ng('ポップオーバーが開かない');
        else {
          if (v.n < 3 || !v.text.includes('理論')) ng(`中身が足りない（${v.n} 行）`);
          if (!v.inWrap) ng('板の枠の左右からはみ出す');
          if (!v.inWin) ng('窓の左右からはみ出す');
          if (!v.visible) ng('枠の中で見えていない');
          if (v.cut.length) ng(`中身が切れる（${v.cut.join(' ')}）`);
          if (v.wrapX > 0) ng(`板の枠が横に ${v.wrapX}px はみ出す`);
          if (v.expanded !== 1) ng(`開いている K が ${v.expanded}`);
          if (v.split.length) ng(`語の途中で折れる（${v.split.join(' / ')}）`);
          if (v.aria[0] !== 'dialog:true') ng(`K のボタンの aria（${v.aria.join(' ')}）`);
        }
        if (!(await report(page, lbl, w, h, `next-${w}x${h}-${theme}-board-kpop-${where}`)))
          ok = false;
        // 閉じ方: Esc → もう一度押して開く → 押して閉じる → 開いて外側 → 開いて別の K（前が閉じる）
        const count = () => page.locator('section.board .popover.kpop').count();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        if ((await count()) !== 0) ng('Esc で閉じない');
        await btn.click();
        await page.waitForTimeout(100);
        await btn.click();
        await page.waitForTimeout(100);
        if ((await count()) !== 0) ng('もう一度押して閉じない');
        await btn.click();
        await page.waitForTimeout(100);
        await page.mouse.click(w - 4, 4);
        await page.waitForTimeout(100);
        if ((await count()) !== 0) ng('外側で閉じない');
        await btn.click();
        await page.waitForTimeout(100);
        const other = page
          .locator(
            'section.board .board-month:not(.inactive) .board-wrap:not(.side-hidden) tbody tr:nth-child(2) th.k .kbtn',
          )
          .first();
        await other.click().catch(() => ng('別の K を押せない'));
        await page.waitForTimeout(100);
        if ((await count()) !== 1) ng(`別の K で ${await count()} 個開いている`);
        console.log(`${lbl}: ${v ? v.text.slice(0, 60) : '—'} ${ok ? 'pass' : '← NG'}`);
        kpopStats.total++;
        if (ok) kpopStats.pass++;
        else failed = true;
        await ctx.close();
      }
    }
  }
}

/** 指標の .panel-body を一番下（閉じた見出し = 末尾が枠の下端）までスクロールする（#174） */
const holdScrollBottom = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('section.metrics .panel-body');
    if (host) host.scrollTop = host.scrollHeight;
    return host?.scrollTop ?? -1;
  });

/** 開いた後の見出し・描画域・読み取り（#259）と枠の位置（#174 AC2 (a)） */
const holdPlace = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('section.metrics .panel-body');
    const btn = document.querySelector('section.metrics .hm-toggle');
    const plot = document.querySelector('section.metrics .hm-plot');
    const read = document.querySelector('section.metrics .hm-readout');
    if (!host || !btn || !plot || !read) return null;
    const h = host.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const p = plot.getBoundingClientRect();
    return {
      hostTop: h.top,
      hostBottom: h.bottom,
      btnTop: b.top,
      plotTop: p.top,
      plotBottom: p.bottom,
      readBottom: read.getBoundingClientRect().bottom,
      plotH: p.height,
      scrollTop: host.scrollTop,
      maxTop: host.scrollHeight - host.clientHeight,
    };
  });

/**
 * 開いた後、描画域の高さが useSize の測った幅で決まるまで待つ（#254。負荷が高いと 2 フレームより遅れる）: 枠の svg の
 * width 属性 = .hm-wrap の幅（測った幅）になるまで。3 秒で打ち切り（false）
 */
const holdWidthSettled = (page) =>
  page
    .waitForFunction(
      () => {
        const wrap = document.querySelector('section.metrics .hm-wrap');
        const svg = wrap?.querySelector('svg.hm-svg');
        return !!svg && Number(svg.getAttribute('width')) === Math.floor(wrap.clientWidth);
      },
      undefined,
      { timeout: 3000 },
    )
    .then(() => true)
    .catch(() => false);

/** holdWidthSettled の後に rAF 2 回（部品が測り直して動かした後）の holdPlace。決まらなければ settled: false */
async function holdSettled(page) {
  const settled = await holdWidthSettled(page);
  await twoFrames(page);
  const r = await holdPlace(page);
  return r && { ...r, settled };
}

/**
 * (a): 描画域と読み取りの 1 行（#259 H-2。タップの値）が枠の中（±1px）。描画域 + 読み取りが枠の高さに入らないときは
 * 描画域まで（上端を隠さない）。見出し 〜 その下端が枠の高さに入るなら見出しも枠の中（上に隠れない）。入らない（スマホの
 * peek）ときは描画域を優先
 */
const holdPlaced = (r) => {
  if (!r) return false;
  const hostH = r.hostBottom - r.hostTop;
  const bottom = r.readBottom - r.plotTop <= hostH ? r.readBottom : r.plotBottom;
  const inPlot = bottom <= r.hostBottom + 1 && r.plotTop >= r.hostTop - 1;
  const fits = bottom - r.btnTop <= hostH;
  return inPlot && (!fits || r.btnTop >= r.hostTop - 1);
};

/**
 * 追証マップ（#174 AC2・AC3）: 資金あり・売り 5 枚 × 360（指標 peek / full）・390（peek）・900（ドック）・1440 ×
 * ダーク / ライト。状態ごとに新しいコンテキスト（過去の値動きはセッションで 1 回だけ読むので）。指標の .panel-body を
 * 一番下までスクロール（見出しが枠の下端）→ /fixtures/atm_daily を止めたまま見出しを押す →
 * (a) 描画域の高さが決まった後（holdSettled。既定の実行は reducedMotion reduce = 即時）に描画域と読み取り（#259）が枠の中（見出しと一緒に入る幅では見出しも）
 * (b) 枠（.hm-plot の高さ ≥ 200px）の中に .hm-wait（スピナー + `過去の値動きを読み込み中…`）、状態の行に同じ文字が無い、
 *     .hm-spin の animation-name が none（AC3）、文字が切れない（scrollWidth ≤ clientWidth）、縦・横・折り返し（report）
 * → 通す → .hm-wait が無くなりマスの path が出る → (c) 閉じても scrollTop は動かさない（中身が消えて最大値で切られる分だけ）
 */
async function holdMapAll() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const states =
        w <= PHONE_MAX ? (w < 380 ? ['peek', 'full'] : ['peek']) : w >= 1200 ? ['pc'] : ['dock'];
      for (const st of states) {
        const ctx = await newContext(
          { width: w, height: h },
          {
            [WORKSPACE_KEY]: sellFive,
            [PREFS_KEY]: prefsText(theme, { capital_yen: MARGIN_CAPITAL }),
          },
        );
        const page = await ctx.newPage();
        const release = await holdDailyGate(page);
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        const lbl = `next ${theme} 追証マップ ${st} ${w}x${h}`;
        let ok = true;
        const ng = (why) => {
          ok = false;
          console.log(`${lbl}: ${why}  ← NG`);
        };
        if (st === 'peek' || st === 'full') {
          if (!(await setShell(page, 'metrics', st))) ng('画面の状態を作れない');
        } else if (st === 'dock') {
          await page.click('.dock button[data-panel="metrics"]');
          await page.waitForTimeout(150);
        }
        if (ok) {
          await holdScrollBottom(page);
          await page.waitForTimeout(50);
          await page.click('section.metrics .hm-toggle');
          // 部品は中身の大きさが変わるたびに測って動かす（reduce = 即時。#254）。描画域の高さが決まってから
          const r = await holdSettled(page);
          if (r && !r.settled) ng('描画域の幅が 3 秒で決まらない');
          if (!holdPlaced(r)) ng(`開いた直後の位置 ${JSON.stringify(r)}`);
          await page.waitForSelector('section.metrics .hm-wait', { timeout: 3000 }).catch(() => {});
          const wv = await page.evaluate(() => {
            const sec = document.querySelector('section.metrics');
            const wt = sec?.querySelector('.hm-wait .hm-wait-t');
            const spin = sec?.querySelector('.hm-wait .hm-spin');
            return {
              text: wt?.textContent ?? null,
              cut: wt ? wt.scrollWidth > wt.clientWidth : true,
              anim: spin ? getComputedStyle(spin).animationName : null,
              status: sec?.querySelector('.hm-status')?.textContent ?? '',
              plotH: sec?.querySelector('.hm-plot')?.getBoundingClientRect().height ?? 0,
            };
          });
          if (wv.text !== '過去の値動きを読み込み中…') ng(`待ちの文 ${wv.text}`);
          if (wv.cut) ng('待ちの文が切れる');
          if (wv.anim !== 'none') ng(`reduced-motion でスピナーが回る（${wv.anim}）`);
          if (wv.status.includes('読み込み中') || wv.status.includes('計算中'))
            ng(`状態の行に待ちの文（${wv.status}）`);
          if (!(wv.plotH >= 200)) ng(`枠の高さ ${wv.plotH}px`);
          if (
            !(await report(page, `${lbl} 読み込み中`, w, h, `next-${w}x${h}-${theme}-hold-${st}`))
          )
            ok = false;
          release();
          const done = await page
            .waitForFunction(
              () => {
                const sec = document.querySelector('section.metrics');
                return (
                  !sec?.querySelector('.hm-wait') &&
                  !!sec?.querySelector('.hm-svg .hm-ok, .hm-svg .hm-call')
                );
              },
              undefined,
              { timeout: 8000 },
            )
            .then(() => true)
            .catch(() => false);
          if (!done) ng('読めた後に待ちが消えない / マスが出ない');
          const before = await holdPlace(page);
          await page.click('section.metrics .hm-toggle');
          await twoFrames(page);
          await page.waitForTimeout(100);
          const after = await page.evaluate(() => {
            const host = document.querySelector('section.metrics .panel-body');
            return host
              ? { scrollTop: host.scrollTop, maxTop: host.scrollHeight - host.clientHeight }
              : null;
          });
          const want =
            before && after ? Math.min(before.scrollTop, Math.max(0, after.maxTop)) : null;
          if (!after || want === null || Math.abs(after.scrollTop - want) > 1)
            ng(
              `閉じたときに動いた ${before?.scrollTop} → ${after?.scrollTop}（最大 ${after?.maxTop}）`,
            );
          console.log(
            `${lbl}: 開いた直後 見出し ${r ? Math.round(r.btnTop - r.hostTop) : '?'}px・描画域 / 読み取りの下端の余り ${r ? `${Math.round(r.hostBottom - r.plotBottom)} / ${Math.round(r.hostBottom - r.readBottom)}` : '?'}px・枠 ${Math.round(wv.plotH)}px・待ち「${wv.text}」・スピナー ${wv.anim} ${ok ? 'pass' : '← NG'}`,
          );
        }
        holdStats.total++;
        if (ok) holdStats.pass++;
        else failed = true;
        await ctx.close();
      }
    }
  }
}

/**
 * 追証の線（#131 AC16・AC20 の画面側）: 全域まで縮小して、縦の破線 line.mcall が 1 本以上・札「追証」が同じ数で
 * 舞台の SVG の中（横に切れない）。描画域のキー（]）で d を変えた直後は隠れ（0 本）、止まって 120ms 後に戻る
 */
async function marginLineCheck(page, lbl, shotName) {
  // 全域まで縮小（凡例行の［−］が出ていればそれ、スマホは描画域の上のホイール）
  const btn = page.locator('button[aria-label="縮小"]:visible').first();
  if ((await btn.count()) > 0) {
    for (let i = 0; i < 12; i++) await btn.click();
  } else {
    const b = await page.locator('.chart:not(.mini)').boundingBox();
    if (b) {
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.3);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(30);
      }
    }
  }
  await page.waitForTimeout(400);
  const read = () =>
    page.evaluate(() => {
      const chart = document.querySelector('.chart:not(.mini)');
      const box = chart?.getBoundingClientRect();
      const lines = [...(chart?.querySelectorAll('line.mcall') ?? [])];
      const labels = [...(chart?.querySelectorAll('text.mcall-lbl') ?? [])];
      const cut = labels.filter((t) => {
        const b = t.getBoundingClientRect();
        return !box || b.left < box.left - 0.5 || b.right > box.right + 0.5;
      }).length;
      return {
        lines: lines.length,
        labels: labels.length,
        texts: labels.map((t) => t.textContent),
        cut,
      };
    });
  const r = await read();
  await page.focus('.chart:not(.mini)');
  await page.keyboard.press(']');
  const hidden = (await read()).lines;
  await page.waitForTimeout(400);
  const back = (await read()).lines;
  const ok =
    r.lines >= 1 &&
    r.labels === r.lines &&
    r.texts.every((t) => t === '追証') &&
    r.cut === 0 &&
    hidden === 0 &&
    back >= 1;
  marginLineStats.total++;
  if (ok) marginLineStats.pass++;
  else failed = true;
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `${shotName}.png`) });
  console.log(
    `${lbl}: 追証の線 ${r.lines} 本・札 ${r.labels}（切れ ${r.cut}）・d を変えた直後 ${hidden} 本・止まった後 ${back} 本 ${ok ? 'pass' : '← NG'}`,
  );
}

/** 足 2 本のタブ A + タブ「ヘッジ案」（重ねる相手）の作業 */
const twoTabs = JSON.stringify({ ...fixture, active: 0, tabs: [fixture.tabs[0], fixture.tabs[1]] });
/** 同じ作業で、タブの名前を上限（TAB_NAME_MAX = 12 文字）の長さにしたもの */
const LONG_NAMES = ['長い名前のタブ一二三四五', '別の長いヘッジ案ですよね'];
const twoTabsLong = JSON.stringify({
  ...fixture,
  active: 0,
  tabs: [
    { ...fixture.tabs[0], name: LONG_NAMES[0] },
    { ...fixture.tabs[1], name: LONG_NAMES[1] },
  ],
});

/**
 * ピン 3 本（今の線を残す × 2 + ヘッジ案を重ねる）の凡例: 各ピンの番号と × が凡例行の中に見え（幅 > 0）、× の当たりが
 * 24px 以上・中心の elementFromPoint が × 自身、× を押すとそのピンが外れる。この状態の縦・横・折り返し・読み取りも測る
 */
/**
 * #144 AC-13: 幅 360px で ΔX を数値欄の上端（+900%）と円の最大（⌊9X₀⌋）にした状態でも、シナリオの .stepper .val b・
 * 読み取りの帯が切れず、横スクロールが出ない（シート peek / full）。
 */
async function wideDXCheck() {
  const [w, h] = [360, 780];
  const ctx = await newContext({ width: w, height: h }, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const val = 'section.scenario .stepper[data-name="dX"] > .val';
  const input = `${val} input`;
  const enter = async (text) => {
    await page.click(val);
    await page.waitForSelector(input);
    await page.fill(input, text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
  };
  const measureAll = async (label) => {
    for (const sheet of ['peek', 'full']) {
      const ok = await setShell(page, 'scenario', sheet);
      const lbl = `#144 ${label} scenario/${sheet}`;
      if (!ok) {
        failed = true;
        console.log(`${lbl} ${w}x${h}: 画面の状態を作れない  ← NG`);
        continue;
      }
      await page.waitForTimeout(150);
      await report(page, lbl, w, h, `wide-dx-${label}-${sheet}`);
      await readoutCheck(page, `${lbl} ${w}x${h}`, 3);
      await scenarioCheck(page, `${lbl} ${w}x${h}`);
      const shown = (await page.textContent(`${val} b`).catch(() => null)) ?? '';
      console.log(`${lbl} ${w}x${h}: ΔX の表示「${shown}」`);
    }
  };
  await setShell(page, 'scenario', 'peek');
  await enter('900');
  await measureAll('+900%');
  // 円の最大: 範囲の外を入れて文言の上端を読み、その値を入れる
  await page.click('section.scenario details.adv summary');
  await page.click('section.scenario .seg[aria-label="ΔX の単位"] button:has-text("円")');
  await page.click('section.scenario details.adv summary');
  await page.click(val);
  await page.waitForSelector(input);
  await page.fill(input, '99999999');
  const alert =
    (await page.textContent('section.scenario .scn-err[role="alert"]').catch(() => null)) ?? '';
  const max = /〜([\d,]+) 円/.exec(alert)?.[1] ?? '';
  await page.keyboard.press('Escape');
  if (max === '') {
    failed = true;
    console.log(`#144 円の最大を読めない「${alert}」  ← NG`);
  } else {
    await enter(max);
    await measureAll(`円の最大 ${max}`);
  }
  await ctx.close();
}

async function pinCheck(w, h, long) {
  const ctx = await newContext(
    { width: w, height: h },
    {
      [WORKSPACE_KEY]: long ? twoTabsLong : twoTabs,
      [PREFS_KEY]: prefsText('dark'),
    },
  );
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const add = async (text) => {
    await page.click('button[aria-label="ピン"]');
    await page.click(`[role="menuitem"]:has-text("${text}")`);
    await page.waitForTimeout(150);
  };
  await add('今の線を残す');
  await add(`${long ? LONG_NAMES[1] : 'ヘッジ案'} を重ねる`);
  await add('今の線を残す');
  const tag = `next dark ピン 3 本${long ? '（12 文字の名前）' : ''}`;
  const name = `next-${w}x${h}-dark-pins3${long ? '-long' : ''}`;
  await report(page, tag, w, h, name);
  await readoutCheck(page, `${tag} ${w}x${h}`, w <= PHONE_MAX ? 3 : 5);
  const r = await page.evaluate(() => {
    const head = document.querySelector('.stage-head')?.getBoundingClientRect();
    const stage = document.querySelector('section.stage')?.getBoundingClientRect();
    const chips = [...document.querySelectorAll('.pins .pin-chip')];
    const bad = [];
    for (const c of chips) {
      const no = c.querySelector('.pin-no');
      const x = c.querySelector('.pin-x');
      const nb = no?.getBoundingClientRect();
      const xb = x?.getBoundingClientRect();
      const inside = (b) =>
        !!b && !!head && b.width > 0 && b.left >= head.left && b.right <= head.right + 0.5;
      const label = no?.textContent ?? '?';
      if (!inside(nb)) bad.push(`${label} 番号が見えない`);
      if (!inside(xb)) bad.push(`${label} × が見えない`);
      else {
        if (xb.width < 24 || xb.height < 24)
          bad.push(`${label} × の当たり ${xb.width}x${xb.height}`);
        const hit = document.elementFromPoint(xb.left + xb.width / 2, xb.top + xb.height / 2);
        if (hit !== x) bad.push(`${label} × が隠れている`);
      }
    }
    // 凡例行の右のツール（ピン・拡大縮小・⋯・ⓘ。出しているものすべて）が舞台の中にあって押せる
    const tools = [...document.querySelectorAll('.stage-tools button')].filter(
      (b) => b.getClientRects().length > 0,
    );
    for (const b of tools) {
      const bb = b.getBoundingClientRect();
      const label = b.getAttribute('aria-label') ?? b.textContent ?? '?';
      const inStage =
        !!stage && !!head && bb.width > 0 && bb.left >= stage.left && bb.right <= stage.right + 0.5;
      if (!inStage) {
        bad.push(`ツール「${label}」が舞台の外`);
        continue;
      }
      const hit = document.elementFromPoint(bb.left + bb.width / 2, bb.top + bb.height / 2);
      if (!hit || !b.contains(hit)) bad.push(`ツール「${label}」が押せない`);
    }
    return { n: chips.length, tools: tools.length, bad };
  });
  // ① を押すと中身のポップオーバー（#125）: 画面の中・横スクロール 0・最大損失の行。Esc で閉じる
  if (r.bad.length === 0) {
    await page.click('.pins .pin-chip:nth-child(1) .pin-open');
    await page.waitForTimeout(100);
    const pop = await page.evaluate(() => {
      const el = document.querySelector('.pins .pin-chip:nth-child(1) .popover:not([hidden])');
      const b = el?.getBoundingClientRect();
      // 値が省略記号で切れていない（名前は折り返す。ほかは 1 値 1 行で収まる）
      const cut = [...(el?.querySelectorAll('.fv') ?? [])]
        .filter((v) => v.scrollWidth > v.clientWidth + 0.5)
        .map((v) => v.textContent);
      return {
        shown: !!b && b.width > 0,
        inView: !!b && b.left >= 0 && b.right <= window.innerWidth + 0.5,
        loss: (el?.textContent ?? '').includes('満期の最大損失'),
        hScroll: document.documentElement.scrollWidth - window.innerWidth,
        cut,
      };
    });
    if (!pop.shown || !pop.inView || !pop.loss || pop.hScroll > 0 || pop.cut.length > 0)
      r.bad.push(`① の中身 ${JSON.stringify(pop)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    if ((await page.locator('.pins .popover:not([hidden])').count()) !== 0)
      r.bad.push('① の中身が Esc で閉じない');
  }
  let ok = r.n === 3 && r.tools >= 3 && r.bad.length === 0;
  if (ok) {
    await page.click('.pins .pin-chip:nth-child(2) .pin-x');
    await page.waitForTimeout(150);
    const n = await page.locator('.pins .pin-chip').count();
    const btn = await page.textContent('button[aria-label="ピン"]');
    ok = n === 2 && (btn ?? '').includes('2/3');
    if (!ok) r.bad.push(`× の後 ${n} 本（${btn}）`);
  }
  if (!ok) failed = true;
  console.log(
    `${tag} ${w}x${h}: 凡例のピン ${r.n} 本・× とツール ${r.tools} 個が見えて押せる・① の中身 ${ok ? 'pass' : `NG ${r.bad.join('・')}`}`,
  );
  await ctx.close();
}

// ---- 空の舞台（#111）: 足 0 本（板あり）でも格子・横軸の目盛り・0 の線と注記
const noLegs = withLegs([]);
const emptyStageStats = { pass: 0, total: 0 };

/**
 * 足 0 本（板あり）の舞台 × 4 幅 × ダーク / ライト（スマホは既定のシート peek = ミニでない）: 縦・横・折り返しと、
 * .chart > svg .grid line が 4 本以上・.zero 1 本・.ax .tick-x 2 個以上で数字・.tick-y / .unit 0 個・注記が見えて
 * 中心の elementFromPoint が注記（前面）・.handle-hit / .legmark / .x0 0 個・.chart の tabindex が -1
 */
async function emptyStageAll() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: noLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      await page.waitForTimeout(150);
      const tag = `next ${theme} 空の舞台`;
      await report(page, tag, w, h, `next-${w}x${h}-${theme}-empty-stage`);
      // #274: 足 0 本はデルタヘッジの行を出さない（スマホはシートの中なので DOM の数）
      await hedgeRowsCheck(page, `${tag} ${w}x${h}`, 0, false);
      const r = await page.evaluate(() => {
        const c = document.querySelector('section.stage .chart');
        if (!c) return null;
        const n = (sel) => c.querySelectorAll(sel).length;
        const ticks = [...c.querySelectorAll('.ax .tick-x')].map((t) => t.textContent ?? '');
        const note = c.querySelector(':scope > .note');
        const nr = note?.getBoundingClientRect();
        const visible = !!nr && nr.width > 0 && nr.height > 0;
        const hit = visible
          ? document.elementFromPoint(nr.left + nr.width / 2, nr.top + nr.height / 2)
          : null;
        return {
          grid: c.querySelectorAll(':scope > svg .grid line').length,
          zero: n('.zero'),
          ticks,
          tickY: n('.ax .tick-y'),
          unit: n('.ax .unit'),
          noteFront: visible && !!hit && note.contains(hit),
          extra: n('.handle-hit') + n('.legmark') + n('.x0'),
          tabindex: c.getAttribute('tabindex'),
          mini: c.classList.contains('mini'),
        };
      });
      const num = /^\d{1,3}(,\d{3})*$/;
      const ok =
        !!r &&
        !r.mini &&
        r.grid >= 4 &&
        r.zero === 1 &&
        r.ticks.length >= 2 &&
        r.ticks.every((t) => num.test(t)) &&
        r.tickY === 0 &&
        r.unit === 0 &&
        r.noteFront &&
        r.extra === 0 &&
        r.tabindex === '-1';
      emptyStageStats.total++;
      if (ok) emptyStageStats.pass++;
      else failed = true;
      console.log(
        r
          ? `#111 ${theme} ${w}x${h}: 格子 ${r.grid} 本・0 の線 ${r.zero}・横の目盛り ${r.ticks.length}（${r.ticks.join(' ')}）・縦の目盛り ${r.tickY}・単位 ${r.unit}・注記が前面 ${r.noteFront}・ハンドル / マーカー / X₀ ${r.extra}・tabindex ${r.tabindex} ${ok ? 'pass' : '← NG'}`
          : `#111 ${theme} ${w}x${h}: section.stage .chart が無い  ← NG`,
      );
      await ctx.close();
    }
  }
}

// ---- 面モード（#88 段 A）
const surfaceStats = { pass: 0, total: 0 };
const SURFACE_EXTRA_SIZES = [
  [1280, 800],
  [1800, 1000],
];

/** 面モードに切り替える（凡例行の [線 | 面] が見えればそれ、見えなければ ⋯ の中。押した後は Esc で閉じる） */
async function toSurface(page, chart = '面') {
  const inRow = page.locator(`.stage-tools .cm button:text-is("${chart}")`);
  if (await inRow.isVisible()) {
    await inRow.click();
  } else {
    await page.click('.stage-tools button[aria-label="グラフの設定"]');
    await page.click(`.stage-pop .cm-in button:text-is("${chart}")`);
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(150);
}

/**
 * 面モードの凡例行・描画域: [線 | 面]（見えていれば。幅 < 480px の舞台は ⋯ の中）・色の見本・±vmax が切れず
 * （scrollWidth ≤ clientWidth）画面内、canvas.surface が 1 つ、損益の線 0 本、[面] が押されている
 */
async function surfaceCheck(page, label) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const inView = (el) => {
      const b = el.getBoundingClientRect();
      return (
        b.width > 0 && b.height > 0 && b.left >= 0 && b.top >= 0 && b.right <= vw && b.bottom <= vh
      );
    };
    const cut = (el) => el.scrollWidth > el.clientWidth;
    const bad = [];
    const seg = document.querySelector('.stage-tools .cm .seg');
    const segShown = shown(seg);
    if (segShown) {
      if (!inView(seg)) bad.push('Seg 画面外');
      for (const b of seg.querySelectorAll('button'))
        if (cut(b)) bad.push(`Seg「${b.textContent}」切れ`);
    }
    const sw = document.querySelector('.legend .surf-sw');
    if (!shown(sw) || !inView(sw)) bad.push('色の見本');
    const vmax = document.querySelector('.legend .vmax');
    if (!shown(vmax) || !inView(vmax) || cut(vmax)) bad.push('±vmax');
    // 凡例の行の中で ±vmax が見えている（.legend の矩形の中）
    const lg = document.querySelector('.legend')?.getBoundingClientRect();
    const vb = vmax?.getBoundingClientRect();
    if (lg && vb && (vb.right > lg.right + 0.5 || vb.left < lg.left - 0.5))
      bad.push('±vmax が凡例の外');
    const pressed = document.querySelector(
      '.stage-tools .cm .seg button[aria-pressed="true"], .stage-pop .cm-in .seg button[aria-pressed="true"]',
    )?.textContent;
    const canvases = document.querySelectorAll('.chart > canvas.surface').length;
    const lines = document.querySelectorAll('.chart path.ln').length;
    if (canvases !== 1) bad.push(`canvas ${canvases}`);
    if (lines !== 0) bad.push(`線 ${lines}`);
    return { segShown, vmax: vmax?.textContent ?? null, pressed: pressed ?? null, bad };
  });
  const ok = r.bad.length === 0;
  surfaceStats.total++;
  if (ok) surfaceStats.pass++;
  else failed = true;
  console.log(
    `#88 ${label}: [線 | 面] ${r.segShown ? '凡例行' : '⋯ の中'}・${r.vmax ?? '—'}${ok ? ' pass' : `  ${r.bad.join('・')}  ← NG`}`,
  );
  return ok;
}

/** 面モードの既定の実行: 4 幅 × ダーク / ライト（スマホはシート peek / hidden）。1280 / 1800 は記録だけ */
// ---- コマンドパレット（#89 段 B AC-B6）: 開いた状態の縦・横・折り返し・箱と入力欄が窓の中・行のラベルが 1 行
const PALETTE = 'dialog.palette[open]';
const paletteStats = { total: 0, pass: 0 };

/** Ctrl + K で開いて待つ（開けば true） */
async function openPalette(page) {
  await page.keyboard.press('Control+K');
  return page
    .waitForSelector(`${PALETTE} input`, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}

async function paletteSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const opened = await openPalette(page);
      await page.waitForTimeout(150);
      const label = `next ${theme} パレット`;
      const name = `next-${w}x${h}-${theme}-palette`;
      const ok = await report(page, label, w, h, name);
      const box = opened ? await inWindow(page, `${PALETTE} .pal-box`) : 'パレットが開かない';
      const input = opened ? await inWindow(page, `${PALETTE} input`) : '';
      // 表示中の行のラベルが 1 行（長いラベルは省略記号）
      const lines = await page.evaluate((sel) => {
        const bad = [];
        const list = document.querySelector(`${sel} .pal-list`);
        const lb = list?.getBoundingClientRect();
        for (const el of document.querySelectorAll(`${sel} .pal-lbl`)) {
          const r = el.getBoundingClientRect();
          // 一覧の枠の中に見えている行だけ
          if (!lb || r.bottom < lb.top || r.top > lb.bottom) continue;
          const range = document.createRange();
          range.selectNodeContents(el);
          const tops = new Set(
            [...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)),
          );
          if (tops.size > 1) bad.push(el.textContent);
        }
        return bad;
      }, PALETTE);
      const out = [box, input, lines.length ? `ラベルの折り返し ${lines.join('・')}` : '']
        .filter(Boolean)
        .join(' / ');
      paletteStats.total++;
      if (ok && out === '') paletteStats.pass++;
      else {
        failed = true;
        if (out) console.log(`${label} ${w}x${h}: ${out}  ← NG`);
      }
      await ctx.close();
    }
  }
}

const TERM_CARD = 'dialog.term-card[open]';
const termCardStats = { total: 0, pass: 0 };

/**
 * 説明カード 1 状態の検査（#167 AC-9）: カードが開いて見出しが want、箱が窓の中・中で横にはみ出さない、ページの縦・横 0px
 * （report）、カードの見出しと用語のボタン（.term-link）が切れていない（scrollWidth ≤ clientWidth）
 */
async function termCardCheck(page, label, w, h, shotName, want) {
  const opened = await page
    .waitForSelector(`${TERM_CARD} .tc-head h2`, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(100);
  const ok = await report(page, label, w, h, shotName);
  let out = '';
  if (!opened) out = 'カードが開かない';
  else {
    const title = (await page.textContent(`${TERM_CARD} .tc-head h2`)) ?? '';
    const box = await inWindow(page, `${TERM_CARD} .tc-box`);
    const body = await inWindow(page, `${TERM_CARD} .tc-body`);
    const cut = await page.evaluate((sel) => {
      const bad = [];
      for (const el of document.querySelectorAll(`${sel} .tc-head h2, ${sel} .term-link`)) {
        if (el.getClientRects().length === 0) continue;
        if (el.scrollWidth > el.clientWidth + 0.5) bad.push(el.textContent);
      }
      const d = document.querySelector(sel);
      if (d && d.scrollWidth > d.clientWidth + 0.5) bad.push('dialog の横スクロール');
      return bad;
    }, TERM_CARD);
    const focus = await page.evaluate(
      (sel) => document.querySelector(sel)?.contains(document.activeElement) === true,
      TERM_CARD,
    );
    out = [
      title === want ? '' : `見出し「${title}」≠「${want}」`,
      box,
      body,
      cut.length ? `切れ ${cut.join('・')}` : '',
      focus ? '' : 'フォーカスがカードの外',
    ]
      .filter(Boolean)
      .join(' / ');
  }
  termCardStats.total++;
  if (ok && out === '') termCardStats.pass++;
  else {
    failed = true;
    if (out) console.log(`${label} ${w}x${h}: ${out}  ← NG`);
  }
}

/** Esc で閉じて、カードが消えるのを待つ（閉じなければ NG） */
async function closeTermCard(page, label) {
  await page.keyboard.press('Escape');
  const closed = await page
    .waitForSelector(TERM_CARD, { state: 'detached', timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    failed = true;
    console.log(`${label}: Esc でカードが閉じない  ← NG`);
  }
}

/**
 * 説明カード（#167 AC-9）: 360 / 390 / 900 / 1440 × ダーク / ライト で、(1) パレットの `?追証` → Enter（#275 で ⋯ >
 * 用語集… を外したので、どの幅も Ctrl + K。カードの描き方を幅ごとに測る）で追証の線、(2) その関連する用語の先頭へ移る、(3) シナリオの ⓘ の「用語: Δs」でスキュー Δs
 */
async function termCardSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const phone = w <= PHONE_MAX;
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 説明カード`;
      const name = `next-${w}x${h}-${theme}-term`;
      // (1) パレット（Ctrl + K で `?` を打つ）
      await openPalette(page);
      await page.keyboard.type('?追証');
      await page.waitForTimeout(100);
      await page.keyboard.press('Enter');
      await termCardCheck(page, `${tag} パレット`, w, h, `${name}-palette`, '追証の線');
      // (2) 関連する用語の先頭（余力（概算））へ。中身が替わり、フォーカスはカードの中
      await page.click(`${TERM_CARD} .tc-related .term-link >> nth=0`).catch(() => {});
      await termCardCheck(page, `${tag} 関連する用語`, w, h, `${name}-related`, '余力（概算）');
      await closeTermCard(page, `${tag} ${w}x${h}`);
      // (3) シナリオの ⓘ の「用語: Δs」
      if (phone) await setShell(page, 'scenario', 'full');
      await page.click('section.scenario .panel-head .hintbtn');
      await page
        .click('section.scenario .term-links .term-link[aria-label="用語: スキュー Δs"]')
        .catch(() => {});
      await termCardCheck(page, `${tag} ⓘ`, w, h, `${name}-hint`, 'スキュー Δs');
      await closeTermCard(page, `${tag} ${w}x${h}`);
      // 閉じたらフォーカスは ⓘ（閉じたポップオーバーの中のボタンから戻す先）
      const back = await page.evaluate(
        () =>
          document.activeElement?.classList.contains('hintbtn') === true &&
          document.activeElement.closest('section.scenario') !== null,
      );
      if (!back) {
        failed = true;
        console.log(`${tag} ${w}x${h}: 閉じた後のフォーカスがシナリオの ⓘ でない  ← NG`);
      }
      await ctx.close();
    }
  }
}

async function surfaceAll() {
  for (const [w, h] of [...SIZES, ...SURFACE_EXTRA_SIZES]) {
    const judged = SIZES.some(([sw, sh]) => sw === w && sh === h);
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      await toSurface(page);
      const tag = `next ${theme} 面`;
      const name = `next-${w}x${h}-${theme}-surface`;
      const want = w <= PHONE_MAX ? 3 : 5;
      if (!judged) {
        const r = await measure(page);
        console.log(
          `${tag} ${w}x${h}: 縦 ${r.v}px 横 ${r.h}px 折り返し ${r.wraps.length} 件（記録のみ）`,
        );
        if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) });
        await ctx.close();
        continue;
      }
      if (w <= PHONE_MAX) {
        await report(page, `${tag} peek`, w, h, `${name}-peek`);
        await readoutCheck(page, `${tag} peek ${w}x${h}`, want);
        await surfaceCheck(page, `${theme} peek ${w}x${h}`);
        await page.click('.dock button[data-panel="positions"]');
        await page.waitForTimeout(150);
        await report(page, `${tag} hidden`, w, h, `${name}-hidden`);
        await readoutCheck(page, `${tag} hidden ${w}x${h}`, want);
        await surfaceCheck(page, `${theme} hidden ${w}x${h}`);
      } else {
        await report(page, tag, w, h, name);
        await readoutCheck(page, `${tag} ${w}x${h}`, want);
        await surfaceCheck(page, `${theme} ${w}x${h}`);
      }
      await ctx.close();
    }
  }
}

// ---- IV 推移（#79 段 B）
const ivStats = { pass: 0, total: 0 };

/**
 * IV 推移を開く（PC は市場の Seg、それ以外はドックの IV のパネルの [IV 推移 | スマイル]。#130 で既定は IV 推移 = 押されて
 * いればクリックしない。スマホはシートも作る）
 */
async function openIv(page, w, sheet = 'peek') {
  if (w >= 1200) {
    await closeAiPc(page);
    await page.click('section.board .panel-head .seg button:has-text("IV 推移")');
  } else {
    if (w <= PHONE_MAX) await setShell(page, 'smile', sheet === 'hidden' ? 'peek' : sheet);
    else await page.click('.dock button[data-panel="smile"]');
    await page.waitForTimeout(120);
    const seg = page.locator('section.smile .panel-head .seg button:has-text("IV 推移")');
    if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
    if (w <= PHONE_MAX && sheet === 'hidden') await setShell(page, 'smile', 'hidden');
  }
  await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(150);
}

/**
 * IV 推移の検査（AC-13）: 見出し行・ツールの行（足の Seg・形の Seg・⟳）・読み取りの 1 行・凡例が切れていない
 * （scrollWidth ≤ clientWidth）、ツールの行の要素が section の中、描画域の高さ（want.minHeight 以上）、
 * 進行中の足（ローソクは .iv-bar.progress、線は .iv-line.progress）が 1 個
 */
async function ivCheck(page, label, want = {}) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.smile');
    const vis = (el) => !!el && el.getClientRects().length > 0;
    if (!vis(sec) || !sec.querySelector('.iv-tools')) return null;
    const sb = sec.getBoundingClientRect();
    const bad = [];
    let n = 0;
    for (const el of sec.querySelectorAll(
      '.panel-head > h2, .panel-head .seg > button, .iv-tools, .iv-tools .seg > button, .iv-refresh, .iv-readout, .iv-legend, .iv-legend > span',
    )) {
      if (!vis(el)) continue;
      n++;
      const b = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth || b.right > sb.right + 0.5 || b.left < sb.left - 0.5)
        bad.push(
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim().replace(/\s+/g, '.')}「${(el.textContent ?? '').trim().slice(0, 12)}」${el.scrollWidth}/${el.clientWidth}`,
        );
    }
    const wrap = sec.querySelector('.iv-wrap');
    return {
      n,
      bad,
      height: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
      bars: sec.querySelectorAll('.iv-bar').length,
      progress: sec.querySelectorAll('.iv-bar.progress, .iv-line.progress').length,
      now: sec.querySelectorAll('.iv-now').length,
      scenario: sec.querySelectorAll('.iv-scenario').length,
      svg: !!sec.querySelector('.iv-wrap svg'),
      name: (sec.querySelector('.panel-head > h2')?.textContent ?? '').trim(),
    };
  });
  const stats = want.fut ? futStats : ivStats;
  stats.total++;
  if (!r) {
    failed = true;
    console.log(`${label}: ${want.fut ? '先物推移' : 'IV 推移'}が見えない  ← NG`);
    return false;
  }
  const bad = [...r.bad];
  if (!r.svg) bad.push('描画域に svg が無い');
  if (r.progress !== 1) bad.push(`進行中の足 ${r.progress} 個（1 のはず）`);
  // 段 C: 合成の表の最後の行（板の 50 分前）より新しい板 = 「今」の印 1 個、twoLegs のシナリオ（ΔX −400・Δσ +2）= 水準の線 1 本
  // #190 先物推移: 「今」の印 1 個（表の最後の行 = 板の 2 分前・同じ限月）、シナリオの水準は無い
  // #272 --quotes-only: 板に JPX の IV・ATM の表示が無いので IV 推移の「今」の印は出ない（先物推移は出る）
  const wantNow = quotesOnly && !want.fut ? 0 : 1;
  if (r.now !== wantNow) bad.push(`「今」の印 ${r.now} 個（${wantNow} のはず）`);
  const wantScenario = want.fut ? 0 : 1;
  if (r.scenario !== wantScenario)
    bad.push(`シナリオの水準 ${r.scenario} 本（${wantScenario} のはず）`);
  if (want.fut && r.name !== '先物推移') bad.push(`見出し「${r.name}」`);
  if (want.minHeight && r.height < want.minHeight)
    bad.push(`描画域の高さ ${r.height}px（${want.minHeight}px 以上のはず）`);
  const ok = r.n > 0 && bad.length === 0;
  if (ok) stats.pass++;
  else failed = true;
  console.log(
    `${label}: ${want.fut ? '先物推移' : 'IV 推移'} 高さ ${r.height}px・${r.n} 個 ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
  );
  return ok;
}

const ivCrossStats = { pass: 0, total: 0 };
const futStats = { pass: 0, total: 0 };

/**
 * 十字線と軸の札（#130 AC-5）: 描画域にフォーカスして , （カーソルの足 = 最新の 1 本前）→ 十字線 2 本・札 2 個・札の矩形が
 * svg の内側・横の札 = 読み取りの時刻・縦の札 = 横線の高さの IV（キーだけのときは足の終値の高さ。小数 2 桁）
 */
async function ivCrossCheck(page, label, fut = false) {
  await page.focus('section.smile .iv-wrap');
  await page.keyboard.press(',');
  await page.waitForTimeout(80);
  const st = await ivCrossState(page);
  ivCrossStats.total++;
  const ok =
    st?.lines === 2 &&
    st.tags.length === 2 &&
    st.tags.every((t) => t.inside) &&
    st.xTag === st.time &&
    (fut ? futYTagOk(st) : ivYTagOk(st));
  if (ok) ivCrossStats.pass++;
  else failed = true;
  console.log(
    `${label}: 十字線 ${st?.lines ?? 0} 本・札 ${st ? st.tags.map((t) => `${t.axis}「${t.text}」${t.inside ? '' : '（外）'}`).join(' ') : '-'}・読み取り ${st?.time ?? '-'} ${ok ? 'pass' : '← NG'}`,
  );
}

/** 4 幅 × ダーク / ライトで IV 推移を開いた状態（スマホはシート 3 段階）。線のモードも測る。#130 で十字線と札 */
async function ivSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} IV 推移`;
      const name = `next-${w}x${h}-${theme}-iv`;
      const sheets = w <= PHONE_MAX ? ['peek', 'full', 'hidden'] : [null];
      for (const sheet of sheets) {
        await openIv(page, w, sheet ?? 'peek');
        const lbl = `${tag}${sheet ? ` ${sheet}` : ''}`;
        await report(page, lbl, w, h, `${name}${sheet ? `-${sheet}` : ''}`);
        if (sheet !== 'hidden') {
          // 360 peek は高さの余裕が最も小さい（スマイルと同じ 140px を下限にしない = ツール・読み取りの 2 行の分）
          await ivCheck(page, `${lbl} ${w}x${h}`, {
            minHeight: w <= PHONE_MAX && sheet === 'peek' ? 80 : 160,
          });
          await ivCrossCheck(page, `${lbl} ${w}x${h}`);
        }
      }
      // 線のモード（スマホは peek に戻して）
      if (w <= PHONE_MAX) await openIv(page, w, 'peek');
      await page.click('section.smile .iv-tools button:has-text("線")');
      await page.waitForTimeout(150);
      await report(page, `${tag} 線`, w, h, `${name}-line`);
      await ivCheck(page, `${tag} 線 ${w}x${h}`, {});
      await ivCrossCheck(page, `${tag} 線 ${w}x${h}`);
      await ctx.close();
    }
  }
}

// ---- 先物推移（#190 AC-9）
/** 先物推移を開く（PC は市場の Seg、それ以外は IV のパネルの [IV 推移 | スマイル | 先物]。スマホはシートも作る） */
async function openFut(page, w, sheet = 'peek') {
  if (w >= 1200) {
    await page.click('section.market:visible .panel-head .seg button:text-is("先物")');
  } else {
    if (w <= PHONE_MAX) await setShell(page, 'smile', sheet === 'hidden' ? 'peek' : sheet);
    else await page.click('.dock button[data-panel="smile"]');
    await page.waitForTimeout(120);
    const seg = page.locator('section.smile .panel-head .seg button:text-is("先物")');
    if ((await seg.getAttribute('aria-pressed')) !== 'true') await seg.click();
    if (w <= PHONE_MAX && sheet === 'hidden') await setShell(page, 'smile', 'hidden');
  }
  await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(150);
}

/** 縦軸の札の文字が横線の高さの値（円の整数・桁区切り。目盛りの 2 点から逆に読んだ値と 1 円以内） */
function futYTagOk(st) {
  if (!st || st.hy === null || st.yTag === null || st.ticks.length < 2) return false;
  const num = (t) => Number(t.replace('−', '-').replace(/,/g, ''));
  const [y0, l0] = st.ticks[0];
  const [y1, l1] = st.ticks[st.ticks.length - 1];
  if (!(Math.abs(y1 - y0) > 0)) return false;
  const perPx = Math.abs((num(l1) - num(l0)) / (y1 - y0));
  const v = num(l0) + ((st.hy - y0) * (num(l1) - num(l0))) / (y1 - y0);
  // 許す差: 札の整数の丸め 1 円 + 座標の 0.1px の丸め（横線・目盛りの y の 3 か所 × 0.05px。#206 で EMA の値の行の分だけ
  // 描画域が低くなると 1px あたりの円が大きくなり、1 円だけでは丸めの差で落ちる）
  return /^\d{1,3}(,\d{3})*$/.test(st.yTag) && Math.abs(num(st.yTag) - v) <= 1 + 0.15 * perPx;
}

/**
 * #200: 指標の段の検査。段 3 つ・4 時間が押されている・価格の描画域が 80px 以上・段の幅 = 描画域の幅・段が枠の中
 * （下端が .panel-body の下端以内）・ツールの行と凡例の行が切れない・オシレーターの線が 3 本以上ある。
 * #223: 境目ごとにつまみ（::before の横棒 2 本。横の中央 ±2px）と、境目の線（.ind-sep）の色が背景と違う
 */
async function indCheck(page, label) {
  futStats.total++;
  const r = await page.evaluate(() => {
    const s = document.querySelector('section.smile');
    const panes = [...(s?.querySelectorAll('.ind-pane') ?? [])];
    const wrap = s?.querySelector('.iv-wrap');
    const body = s?.querySelector('.panel-body');
    const cut = (el) => (el ? el.scrollWidth > el.clientWidth + 1 : true);
    const tf = s?.querySelector('.iv-tools button[aria-pressed="true"]')?.textContent ?? '';
    const bodyBottom = body?.getBoundingClientRect().bottom ?? 0;
    return {
      panes: panes.length,
      note: (s?.querySelector('.ind-hidden-note')?.textContent ?? '').trim(),
      tf,
      plotH: wrap?.clientHeight ?? 0,
      wrapW: wrap?.clientWidth ?? 0,
      paneW: panes.map((p) => Math.round(p.getBoundingClientRect().width)),
      paneH: panes.map((p) => Math.round(p.getBoundingClientRect().height)),
      inside: panes.every((p) => p.getBoundingClientRect().bottom <= bodyBottom + 1),
      lines: s?.querySelectorAll('.ind-pane .ind-line[d^="M"]:not([d="M0 0"])').length ?? 0,
      toolsCut: cut(s?.querySelector('.iv-tools')),
      legendCut: cut(s?.querySelector('.iv-legend')),
      // #223 境目: つまみ（::before の横棒 2 本）の大きさ・色・横の位置と、境目の線（.ind-sep）の色 ≠ 背景
      splits: [...(s?.querySelectorAll('.ind-split') ?? [])].map((el) => {
        const cs = getComputedStyle(el, '::before');
        const r = el.getBoundingClientRect();
        const pane = el.nextElementSibling?.getBoundingClientRect();
        return {
          w: Number.parseFloat(cs.width) || 0,
          h: Number.parseFloat(cs.height) || 0,
          top: cs.borderTopWidth,
          bottom: cs.borderBottomWidth,
          color: cs.borderTopColor,
          opacity: Number(cs.opacity),
          cx: r.left + r.width / 2,
          paneCx: pane ? pane.left + pane.width / 2 : null,
        };
      }),
      sep: (() => {
        const line = s?.querySelector('.ind-pane .ind-sep');
        let bg = 'rgba(0, 0, 0, 0)';
        for (let e = line?.closest('.ind-pane') ?? null; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
            bg = c;
            break;
          }
        }
        return { stroke: line ? getComputedStyle(line).stroke : null, bg };
      })(),
    };
  });
  const bad = [];
  // #223: 境目ごとにつまみ（横棒 2 本・幅 > 0・不透明・横の中央 ±2px）、境目の線の色が背景と違う
  if (r.splits.length !== r.panes) bad.push(`境目 ${r.splits.length}（段 ${r.panes}）`);
  for (const [i, g] of r.splits.entries()) {
    const ok =
      g.w > 0 &&
      g.h > 0 &&
      g.top === '1px' &&
      g.bottom === '1px' &&
      g.opacity > 0 &&
      g.color !== 'rgba(0, 0, 0, 0)' &&
      g.paneCx !== null &&
      Math.abs(g.cx - g.paneCx) <= 2;
    if (!ok) bad.push(`つまみ ${i}: ${JSON.stringify(g)}`);
  }
  if (!r.sep.stroke || r.sep.stroke === 'none' || r.sep.stroke === r.sep.bg)
    bad.push(`境目の線 ${r.sep.stroke}（背景 ${r.sep.bg}）`);
  // #207: 高さが足りなければ後ろの段を隠して知らせる（価格が先）
  if (r.panes !== 3 && !(r.panes < 3 && r.note.includes('隠しています')))
    bad.push(`段 ${r.panes}・知らせ「${r.note}」`);
  if (r.tf !== '4時間') bad.push(`足「${r.tf}」`);
  if (r.plotH < 56) bad.push(`描画域 ${r.plotH}px`);
  if (!r.paneW.every((x) => Math.abs(x - r.wrapW) <= 1)) bad.push(`段の幅 ${r.paneW.join('/')}`);
  if (!r.inside) bad.push('段が枠の外');
  if (r.lines < 3) bad.push(`線 ${r.lines}`);
  if (r.toolsCut) bad.push('ツールの行が切れる');
  if (r.legendCut) bad.push('凡例が切れる');
  const ok = bad.length === 0;
  if (ok) futStats.pass++;
  else failed = true;
  console.log(
    `${label}: 段 ${r.panes}（高さ ${r.paneH.join('/')}px）・描画域 ${r.plotH}px・境目のつまみ ${r.splits.length}（線 ${r.sep.stroke}） ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
  );
}

// ---- #207 先物推移の段の高さ・最大化・段の十字線
const paneStats = { pass: 0, total: 0 };
/** 段の状態（段の高さ・価格の描画域・境目の位置・十字線・札・浮いた読み取り・保存の段の高さのキー） */
const paneState = (page) =>
  page.evaluate(() => {
    const s = document.querySelector('section.smile');
    const r = (e) => (e ? e.getBoundingClientRect() : null);
    const panes = [...(s?.querySelectorAll('.ind-pane') ?? [])];
    const stack = r(s?.querySelector('.fut-stack'));
    const wrap = s?.querySelector('.iv-wrap');
    const fl = s?.querySelector('.ind-float');
    const hl = s?.querySelector('.ind-cross .ind-cursor.h');
    const crossPane = hl?.closest('svg');
    let prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem('option-simulator.prefs') ?? '{}');
    } catch {}
    return {
      kinds: panes.map((p) => [...p.classList].find((c) => c !== 'ind-pane')),
      paneH: panes.map((p) => Math.round(r(p).height)),
      paneTop: panes.map((p) => r(p).top),
      paneX: panes.length ? r(panes[0]).left : 0,
      paneW: panes.length ? r(panes[0]).width : 0,
      stackH: stack ? Math.round(stack.height) : 0,
      wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : null,
      splits: s?.querySelectorAll('.ind-split').length ?? 0,
      cross: s?.querySelectorAll('.ind-cross').length ?? 0,
      crossKind: crossPane ? [...crossPane.classList].find((c) => c !== 'ind-pane') : null,
      crossPaneH: crossPane ? Number(crossPane.getAttribute('height')) : null,
      hy: hl ? Number(hl.getAttribute('y1')) : null,
      tag: (s?.querySelector('.ind-tag text')?.textContent ?? '').trim() || null,
      // 十字線のある段の見出し（段の名前とその足の値。#227: 離した後の読み取りは段の中）
      head: crossPane ? (crossPane.querySelector('.ind-head')?.textContent ?? '').trim() : null,
      priceV: s?.querySelectorAll('.iv-cross .iv-cursor.v').length ?? 0,
      priceH: s?.querySelectorAll('.iv-cross .iv-cursor.h').length ?? 0,
      xTag: (s?.querySelector('.iv-tag.x text')?.textContent ?? '').trim() || null,
      time: (s?.querySelector('.iv-readout .time')?.textContent ?? '').trim(),
      float: fl ? (fl.textContent ?? '').trim() : null,
      floatBox: fl
        ? (({ top, bottom, left, right }) => ({ top, bottom, left, right }))(r(fl))
        : null,
      xTick: (s?.querySelector('.iv-wrap .ax .tx')?.textContent ?? '').trim(),
      keys: Object.keys(prefs).filter((k) => k.startsWith('fut_pane_h_')),
      prefs,
    };
  });

/** RSI の段の横線の高さ（段の座標）→ 値（0〜100。段の描画域 = 上 14px・下 4px）。札の文字（小数 1 桁）と比べる */
function rsiTagOk(st) {
  if (st.hy === null || st.tag === null || st.crossPaneH === null) return false;
  const top = 14;
  const bottom = st.crossPaneH - 4;
  const v = (100 * (bottom - st.hy)) / (bottom - top);
  return (
    /^\d{1,3}\.\d$/.test(st.tag) && Math.abs(Number(st.tag) - v) <= 0.06 + 100 / (bottom - top) / 20
  );
}

/**
 * #207 AC1〜AC5（マウス。360 は全開のシート、1440）: 境目 1（RSI | MACD）を下へ 24px → RSI +24・MACD −24 と保存のキー、
 * 境目 0（価格 | RSI）を上へ 30px → RSI +30・価格 −30、境目のダブルクリック → 56px とキーなし、RSI の段のホバー →
 * 段の十字線（横線 = マウスの高さ・札 = その高さの値）・価格は縦線だけ・横軸の札 = 読み取りの時刻、MACD の段のダブル
 * クリック → 最大化（段 1 つ・価格なし・境目なし・枠の全部）、もう一度 → 戻す
 */
async function futPaneCheck(page, label) {
  const bad = [];
  const st0 = await paneState(page);
  if (st0.kinds.join(',') !== 'rsi,macd,stoch') {
    console.log(`${label}: #207 段 ${st0.kinds.join(',')}  ← NG`);
    failed = true;
    paneStats.total++;
    return;
  }
  const midX = st0.paneX + st0.paneW * 0.6;
  const drag = async (y, dy) => {
    await page.mouse.move(midX, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(midX, y + (dy * i) / 6);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  // 境目 1（MACD の上端）
  await drag(st0.paneTop[1] + 1, 24);
  const st1 = await paneState(page);
  if (!(st1.paneH[0] === st0.paneH[0] + 24 && st1.paneH[1] === st0.paneH[1] - 24))
    bad.push(`境目 1 ${st0.paneH.join('/')} → ${st1.paneH.join('/')}`);
  if (st1.prefs.fut_pane_h_rsi !== st1.paneH[0] || st1.prefs.fut_pane_h_macd !== st1.paneH[1])
    bad.push(`保存 ${JSON.stringify(st1.keys.map((k) => [k, st1.prefs[k]]))}`);
  // 境目 0（RSI の上端。帯は段の中の下側）
  await drag(st1.paneTop[0] + 2, -30);
  const st2 = await paneState(page);
  if (!(st2.paneH[0] === st1.paneH[0] + 30 && st2.wrapH === (st1.wrapH ?? 0) - 30))
    bad.push(`境目 0 段 ${st1.paneH[0]} → ${st2.paneH[0]}・価格 ${st1.wrapH} → ${st2.wrapH}`);
  // 境目のダブルクリック → 既定
  await page.mouse.dblclick(midX, st2.paneTop[1] + 1);
  await page.waitForTimeout(200);
  const st3 = await paneState(page);
  if (!(st3.paneH.every((h) => h === 56) && st3.keys.length === 0 && st3.kinds.length === 3))
    bad.push(`既定に戻す ${st3.paneH.join('/')}・キー ${st3.keys.join(',')}`);
  if (st3.kinds.length !== 3) {
    paneStats.total++;
    failed = true;
    console.log(`${label}: #207 ${bad.join('・')}  ← NG`);
    return;
  }
  // 境目 0 の帯（価格の側 3px）のホバー: 十字線なし・row-resize
  await page.mouse.move(midX, st3.paneTop[0] - 3);
  await page.waitForTimeout(120);
  const hb = await paneState(page);
  const cur = await page.evaluate(
    ([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor,
    [midX, st3.paneTop[0] - 3],
  );
  if (!(hb.cross === 0 && hb.priceV === 0 && cur === 'row-resize'))
    bad.push(`帯のホバー 十字線 ${hb.cross}・価格 ${hb.priceV}・カーソル ${cur}`);
  // RSI の段のホバー（段の座標 30px = 描画域の中）
  const hy = st3.paneTop[0] + 30;
  await page.mouse.move(midX, hy);
  await page.waitForTimeout(150);
  const st4 = await paneState(page);
  const crossOk =
    st4.cross === 1 &&
    st4.crossKind === 'rsi' &&
    st4.hy !== null &&
    Math.abs(st4.hy - 30) <= 0.6 &&
    rsiTagOk(st4) &&
    st4.priceV === 1 &&
    st4.priceH === 0 &&
    st4.xTag === st4.time &&
    st4.float === null;
  if (!crossOk)
    bad.push(
      `十字線 ${st4.cross}（${st4.crossKind}・y ${st4.hy}・札 ${st4.tag}）・価格 縦 ${st4.priceV} 横 ${st4.priceH}・時刻 ${st4.xTag} / ${st4.time}・浮き ${st4.float}`,
    );
  // MACD の段のダブルクリック → 最大化
  await page.mouse.dblclick(midX, st4.paneTop[1] + st4.paneH[1] / 2);
  await page.waitForTimeout(250);
  const st5 = await paneState(page);
  if (
    !(
      st5.kinds.join(',') === 'macd' &&
      st5.wrapH === null &&
      st5.splits === 0 &&
      Math.abs(st5.paneH[0] - st5.stackH) <= 1
    )
  )
    bad.push(
      `最大化 ${st5.kinds.join(',')}・${st5.paneH.join('/')} / 枠 ${st5.stackH}・価格 ${st5.wrapH}`,
    );
  await page.mouse.dblclick(midX, st5.paneTop[0] + st5.paneH[0] / 2);
  await page.waitForTimeout(250);
  const st6 = await paneState(page);
  if (
    !(
      st6.kinds.join(',') === 'rsi,macd,stoch' &&
      st6.paneH.every((h) => h === 56) &&
      st6.wrapH !== null
    )
  )
    bad.push(`戻す ${st6.kinds.join(',')}・${st6.paneH.join('/')}`);
  await page.mouse.move(1, 1);
  paneStats.total++;
  const ok = bad.length === 0;
  if (ok) paneStats.pass++;
  else failed = true;
  console.log(
    `${label}: #207 境目 ${st0.paneH.join('/')} → ${st1.paneH.join('/')} → ${st2.paneH.join('/')} → 既定・十字線 RSI ${st4.tag}・最大化 ${st5.paneH[0]}px ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
  );
}

/**
 * #207 はみ出し（オーナーの指摘「てくにかるぜんぶだしたら下端がはみ出した」）: 段 3 つ + EMA を出した先物推移を
 * 360×780・390×844（シートの覗く / 全開）・768×1024・1440×900 で開き、ページ・パネルの本体・価格と段の枠の縦のはみ出しが
 * 0px、段の下端と凡例が本体の中、隠した段があれば知らせがあること
 */
async function futAllPanesSweep() {
  for (const [w, h] of [
    [360, 780],
    [390, 844],
    [768, 1024],
    [1440, 900],
  ]) {
    const ctx = await newContext(
      { width: w, height: h },
      { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await openFut(page, w, 'peek');
    for (const t of ['RSI', 'MACD', 'SO']) {
      await page.click(`section.smile .iv-legend .ind-toggles button:text-is("${t}")`);
    }
    for (const sheet of w <= PHONE_MAX ? ['peek', 'full'] : [null]) {
      if (sheet) await openFut(page, w, sheet);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const s = document.querySelector('section.smile');
        const body = s?.querySelector('.panel-body');
        const stack = s?.querySelector('.fut-stack');
        const bb = body?.getBoundingClientRect().bottom ?? 0;
        const se = document.scrollingElement;
        const panes = [...(s?.querySelectorAll('.ind-pane') ?? [])];
        return {
          ema: s?.querySelector('.iv-readout.ema') !== null,
          page: se ? se.scrollHeight - se.clientHeight : 0,
          body: body ? body.scrollHeight - body.clientHeight : -1,
          stack: stack ? stack.scrollHeight - stack.clientHeight : -1,
          panes: panes.length,
          paneOut: panes.some((p) => p.getBoundingClientRect().bottom > bb + 0.5),
          legendOut:
            (s?.querySelector('.iv-legend')?.getBoundingClientRect().bottom ?? 1e9) > bb + 0.5,
          note: (s?.querySelector('.ind-hidden-note')?.textContent ?? '').trim(),
          plotH: s?.querySelector('.iv-wrap')?.clientHeight ?? 0,
        };
      });
      const bad = [];
      if (!r.ema) bad.push('EMA の行なし');
      if (r.page !== 0) bad.push(`ページ ${r.page}px`);
      if (r.body !== 0) bad.push(`本体 ${r.body}px`);
      if (r.stack !== 0) bad.push(`枠 ${r.stack}px`);
      if (r.paneOut) bad.push('段が本体の外');
      if (r.legendOut) bad.push('凡例が本体の外');
      if (r.panes < 3 && !r.note.includes('隠しています')) bad.push(`段 ${r.panes} で知らせなし`);
      if (r.panes > 0 && r.plotH < 56) bad.push(`価格 ${r.plotH}px`);
      paneStats.total++;
      const ok = bad.length === 0;
      if (ok) paneStats.pass++;
      else failed = true;
      console.log(
        `next dark 先物推移 段 3 つ + EMA${sheet ? ` ${sheet}` : ''} ${w}x${h}: はみ出し ページ ${r.page}・本体 ${r.body}・枠 ${r.stack}px・段 ${r.panes}${r.note ? `（${r.note}）` : ''}・価格 ${r.plotH}px ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
      );
    }
    await ctx.close();
  }
}

/**
 * #214 テクニカルの線の太さ: EMA の 3 本とオシレーターの線（RSI・MACD・シグナル・%K・%D）の画面の太さ（CSS px）が設定の px と同じか。
 * 画面の太さ = computed の stroke-width（non-scaling-stroke なら そのまま、無ければ × svg の画面の拡大率 getScreenCTM().a）。
 * 既定（EMA 1・段 1.25）と設定した値（EMA 3・段 2）を 360×780（覗く）・1440×900 で測る。ヒストの棒は太さを持たない
 */
async function futLineWidthCheck() {
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    for (const [want, extra] of [
      [{ ema: 1, pane: 1.25 }, {}],
      [
        { ema: 3, pane: 2 },
        { tech_ema_width_px: 3, tech_pane_width_px: 2 },
      ],
    ]) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark', extra) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      await openFut(page, w, 'peek');
      for (const t of ['RSI', 'MACD', 'SO']) {
        await page.click(`section.smile .iv-legend .ind-toggles button:text-is("${t}")`);
      }
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const s = document.querySelector('section.smile');
        const px = (el) => {
          const cs = getComputedStyle(el);
          const sw = Number.parseFloat(cs.strokeWidth);
          const k = el.ownerSVGElement?.getScreenCTM()?.a ?? Number.NaN;
          return {
            screen: cs.vectorEffect === 'non-scaling-stroke' ? sw : sw * k,
            k,
            ve: cs.vectorEffect,
          };
        };
        const ema = [...(s?.querySelectorAll('.ema-line') ?? [])].map(px);
        const ind = [...(s?.querySelectorAll('.ind-pane .ind-line') ?? [])].map(px);
        const hist = [...(s?.querySelectorAll('.ind-pane .ind-hist') ?? [])].map(
          (e) => e.getAttribute('stroke-width') ?? '',
        );
        return { ema, ind, hist };
      });
      const bad = [];
      const near = (a, b) => Math.abs(a - b) < 0.01;
      if (r.ema.length !== 3 || !r.ema.every((x) => near(x.screen, want.ema)))
        bad.push(`EMA ${r.ema.map((x) => x.screen).join('/')}`);
      if (r.ind.length < 3 || !r.ind.every((x) => near(x.screen, want.pane)))
        bad.push(`段 ${r.ind.map((x) => x.screen).join('/')}`);
      if (r.hist.some((x) => x !== '')) bad.push(`ヒスト ${r.hist.join('/')}`);
      if (![...r.ema, ...r.ind].every((x) => x.ve === 'non-scaling-stroke'))
        bad.push('non-scaling-stroke なし');
      futStats.total++;
      const ok = bad.length === 0;
      if (ok) futStats.pass++;
      else failed = true;
      const k = [...new Set([...r.ema, ...r.ind].map((x) => x.k))].join('/');
      console.log(
        `next dark 先物推移 線の太さ ${w}x${h}: #214 EMA ${want.ema}px ×${r.ema.length}・段 ${want.pane}px ×${r.ind.length}（svg の拡大率 ${k}） ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
      );
      await ctx.close();
    }
  }
}

/** 4 幅 × ダーク / ライトで先物推移を開いた状態（スマホはシート 3 段階）。線のモードも測る */
async function futSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `next ${theme} 先物推移`;
      const name = `next-${w}x${h}-${theme}-fut`;
      const sheets = w <= PHONE_MAX ? ['peek', 'full', 'hidden'] : [null];
      for (const sheet of sheets) {
        await openFut(page, w, sheet ?? 'peek');
        const lbl = `${tag}${sheet ? ` ${sheet}` : ''}`;
        await report(page, lbl, w, h, `${name}${sheet ? `-${sheet}` : ''}`);
        if (sheet !== 'hidden') {
          await ivCheck(page, `${lbl} ${w}x${h}`, {
            fut: true,
            minHeight: w <= PHONE_MAX && sheet === 'peek' ? 80 : 160,
          });
          await ivCrossCheck(page, `${lbl} ${w}x${h}`, true);
        }
      }
      if (w <= PHONE_MAX) await openFut(page, w, 'peek');
      await page.click('section.smile .iv-tools button:has-text("線")');
      await page.waitForTimeout(150);
      await report(page, `${tag} 線`, w, h, `${name}-line`);
      await ivCheck(page, `${tag} 線 ${w}x${h}`, { fut: true });
      // #200: 4 時間足 + 指標の段 3 つ（凡例の行の切替）。スマホは覗く（最も狭い）と全開
      await page.click('section.smile .iv-tools button:text-is("4時間")');
      for (const t of ['RSI', 'MACD', 'SO']) {
        await page.click(`section.smile .iv-legend .ind-toggles button:text-is("${t}")`);
      }
      for (const sheet of w <= PHONE_MAX ? ['peek', 'full'] : [null]) {
        if (sheet) await openFut(page, w, sheet);
        await page.waitForTimeout(200);
        const lbl = `${tag} 4 時間・段 3 つ${sheet ? ` ${sheet}` : ''}`;
        await report(page, lbl, w, h, `${name}-ind${sheet ? `-${sheet}` : ''}`);
        await indCheck(page, `${lbl} ${w}x${h}`);
      }
      // #207: 境目のドラッグ・既定に戻す・段の十字線・最大化 / 戻す（360 は全開・1440。ダークだけ）
      if (theme === 'dark' && (w === 360 || w === 1440)) {
        await futPaneCheck(page, `${tag} 段の操作 ${w}x${h}`);
      }
      await ctx.close();
    }
  }
}

// ---- #320 第 1 弾: 戻る（スマホの戻るジェスチャー・ブラウザの戻る）で開いているものを一番上から 1 つ閉じる（--back と --flows）
// 「アプリを離れる」= about:blank を開いてからアプリへ goto した文脈で、goBack の後の page.url() が about:blank。
// 段の数は history.state.back（ui/next/backStack.ts が積む）を待って確かめる（固定の待ち時間に頼らない）

/** about:blank → アプリ（戻る 1 回で about:blank に戻る文脈）。hash は共有 URL など */
async function backFresh(page, hash = '') {
  await page.goto('about:blank');
  await page.goto(`${pageUrl('next')}${hash}`);
  await waitReady(page, 'next');
}

/** history.state.back が n になるまで待つ（なれば true。ならなければ今の値を detail に） */
async function backWait(page, n) {
  const ok = await page
    .waitForFunction((want) => (history.state?.back ?? 0) === want, n, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const now = await page.evaluate(() => history.state?.back ?? null).catch(() => null);
  return { ok, now };
}

/** 開いているもの（モーダル / 非モーダルの dialog・吹き出し・メニュー） */
const backOpen = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const d of document.querySelectorAll('dialog[open]')) out.push(`dialog.${d.className}`);
    for (const _ of document.querySelectorAll('.popover:not([hidden])')) out.push('popover');
    for (const _ of document.querySelectorAll('[role="menu"]')) out.push('menu');
    return out;
  });

/** フォーカスの印（要素・名前・属する所） */
const backFocus = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'body';
    const host = a.closest('dialog, section, header');
    return `${a.tagName.toLowerCase()}.${a.className}|${a.getAttribute('aria-label') ?? ''}|${host ? `${host.tagName.toLowerCase()}.${host.className}` : ''}`;
  });

/** 戻る 1 回（同じ文書の移動も、about:blank への移動も） */
async function backGo(page) {
  await page.goBack({ timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(150);
}

/** 戻る 1 回でアプリを離れるか */
async function backLeaves(page) {
  await backGo(page);
  return page.url() === 'about:blank';
}

/** 外側のクリック: 押しても何も起きない所（パネル / トップバーの見出し）の中心 */
async function backOutside(page) {
  const pt = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.panel-head h2, header.top .brand')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const x = r.left + Math.min(r.width / 2, 20);
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit))) continue;
      return { x, y };
    }
    return null;
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
  return pt !== null;
}

/**
 * 戻るの項目（AC-1-2〜AC-1-10）。vp = 390×844 / 1440×900（パレット・テーマのメニュー・市場の切替は PC だけ）
 */
async function backFlows(vp) {
  const phone = vp.width <= PHONE_MAX;
  const tag = `#320 ${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const HINT = 'section.scenario .panel-head .hintbtn';
  const items = [
    {
      name: '設定（ダイアログ）',
      open: () => openFromMore(page, '設定…', SET),
      sel: SET,
      x: `${SET} .sheet-head button[aria-label="閉じる"]`,
    },
    {
      name: '保存一覧（ダイアログ）',
      open: () => openFromMore(page, '保存一覧', BOOK),
      sel: BOOK,
      x: `${BOOK} .sheet-head button[aria-label="閉じる"]`,
    },
    {
      name: 'シナリオの ⓘ の吹き出し',
      prep: () => (phone ? setShell(page, 'scenario', 'full') : null),
      open: () => page.click(HINT),
      sel: 'section.scenario .panel-head .popover:not([hidden])',
      outside: true,
    },
    {
      name: 'トップバーの ⋯ のメニュー',
      open: () => page.click(MORE),
      sel: 'header.top > .menu-wrap [role="menu"]',
      outside: true,
    },
    {
      name: '説明カード（ⓘ の「用語:」）',
      prep: () => (phone ? setShell(page, 'scenario', 'full') : null),
      open: async () => {
        await page.click(HINT);
        await page.click('section.scenario .term-links .term-link[aria-label="用語: スキュー Δs"]');
      },
      sel: TERM_CARD,
      x: `${TERM_CARD} .tc-head button[aria-label="閉じる"]`,
      outside: 'card',
    },
  ];
  if (!phone) items.push({ name: 'コマンドパレット', open: () => openPalette(page), sel: PALETTE });

  for (const it of items) {
    const label = `${tag} ${it.name}`;
    // (1) Esc で閉じたときのフォーカス・Esc の後の戻る 1 回で離れる（AC-1-4）
    await backFresh(page);
    await it.prep?.();
    const url0 = page.url();
    await it.open();
    await page.waitForSelector(it.sel, { timeout: 3000 }).catch(() => {});
    const d1 = await backWait(page, 1);
    await page.keyboard.press('Escape');
    await page.waitForSelector(it.sel, { state: 'detached', timeout: 3000 }).catch(() => {});
    await page
      .waitForFunction((s) => !document.querySelector(s), it.sel, { timeout: 3000 })
      .catch(() => {});
    const escFocus = await backFocus(page);
    const e0 = await backWait(page, 0);
    check(
      `AC-1-4 ${label}: 開いて back 1 → Esc で閉じて back 0 → 戻る 1 回でアプリを離れる`,
      d1.ok && e0.ok && (await backLeaves(page)),
      `back ${d1.now} → ${e0.now}`,
    );

    // (2) 開く → 戻る 1 回でそれだけ閉じ、離れず URL 同じ・フォーカスは Esc と同じ → もう 1 回で離れる（AC-1-2）
    await backFresh(page);
    await it.prep?.();
    await it.open();
    await page.waitForSelector(it.sel, { timeout: 3000 }).catch(() => {});
    const o1 = await backWait(page, 1);
    const opened = (await backOpen(page)).length;
    await backGo(page);
    await page
      .waitForFunction((s) => !document.querySelector(s), it.sel, { timeout: 3000 })
      .catch(() => {});
    const left = await backOpen(page);
    const url1 = page.url();
    const focus = await backFocus(page);
    const b0 = await backWait(page, 0);
    check(
      `AC-1-2 ${label}: 戻る 1 回でそれだけ閉じ、アプリに留まり URL が同じ・フォーカスが Esc と同じ`,
      o1.ok && opened > 0 && left.length === 0 && url1 === url0 && focus === escFocus && b0.ok,
      `開いて back ${o1.now}・閉じた後 ${left.join(',') || 'なし'}・URL ${url1 === url0 ? '同じ' : url1}・フォーカス ${focus === escFocus ? '同じ' : `${focus} ≠ Esc ${escFocus}`}`,
    );
    check(`AC-1-2 ${label}: もう 1 回の戻るでアプリを離れる`, await backLeaves(page));

    // (3) × で閉じた後の戻る 1 回で離れる（AC-1-4）
    if (it.x) {
      await backFresh(page);
      await it.prep?.();
      await it.open();
      await page.waitForSelector(it.sel, { timeout: 3000 }).catch(() => {});
      await backWait(page, 1);
      await page.click(it.x);
      const z = await backWait(page, 0);
      check(
        `AC-1-4 ${label}: × で閉じて back 0 → 戻る 1 回でアプリを離れる`,
        z.ok && (await backLeaves(page)),
        `back ${z.now}`,
      );
    }
    // (4) 外のクリックで閉じた後（AC-1-4）
    if (it.outside) {
      await backFresh(page);
      await it.prep?.();
      await it.open();
      await page.waitForSelector(it.sel, { timeout: 3000 }).catch(() => {});
      await backWait(page, 1);
      let clicked = true;
      if (it.outside === 'card') await page.mouse.click(4, vp.height - 4);
      else clicked = await backOutside(page);
      await page
        .waitForFunction((s) => !document.querySelector(s), it.sel, { timeout: 3000 })
        .catch(() => {});
      const closed = (await page.$(it.sel)) === null;
      const z = await backWait(page, 0);
      check(
        `AC-1-4 ${label}: 外のクリックで閉じて back 0 → 戻る 1 回でアプリを離れる`,
        clicked && closed && z.ok && (await backLeaves(page)),
        `${clicked ? '' : '外の点が無い・'}${closed ? '' : '閉じない・'}back ${z.now}`,
      );
    }
  }

  // AC-1-4 メニューの項目を選ぶ: PC はテーマのメニューの「ダーク」、スマホは ⋯ > 設定… → ×
  await backFresh(page);
  if (!phone) {
    await page.click('button[aria-label="テーマ"]');
    await backWait(page, 1);
    await page.click('[role="menuitemradio"]:has-text("ダーク")');
    const z = await backWait(page, 0);
    check(
      `AC-1-4 ${tag} テーマのメニューの「ダーク」を選ぶ → back 0 → 戻る 1 回でアプリを離れる`,
      z.ok && (await backLeaves(page)),
      `back ${z.now}`,
    );
  } else {
    await openFromMore(page, '設定…', SET);
    const s1 = await backWait(page, 1);
    await page.click(`${SET} .sheet-head button[aria-label="閉じる"]`);
    const z = await backWait(page, 0);
    check(
      `AC-1-4 ${tag} ⋯ の「設定…」を選ぶ（メニュー → ダイアログで back 1）→ × → 戻る 1 回でアプリを離れる`,
      s1.ok && z.ok && (await backLeaves(page)),
      `back ${s1.now} → ${z.now}`,
    );
  }

  // AC-1-3 重なり: 保存一覧 → 見出しの ⓘ → 戻る（吹き出しだけ）→ 戻る（ダイアログ）→ 戻る（離れる）
  {
    await backFresh(page);
    await openFromMore(page, '保存一覧', BOOK);
    await page.click(`${BOOK} .sheet-head .hintbtn`);
    const two = await backWait(page, 2);
    await backGo(page);
    const pop1 = await page.$(`${BOOK} .sheet-head .popover:not([hidden])`);
    const dlg1 = await page.$(BOOK);
    const one = await backWait(page, 1);
    await backGo(page);
    await page.waitForSelector(BOOK, { state: 'detached', timeout: 3000 }).catch(() => {});
    const dlg0 = await page.$(BOOK);
    const zero = await backWait(page, 0);
    check(
      `AC-1-3 ${tag} 保存一覧 → ⓘ（back 2）→ 戻るで吹き出しだけ閉じる → 戻るでダイアログ → 戻るでアプリを離れる`,
      two.ok &&
        pop1 === null &&
        dlg1 !== null &&
        one.ok &&
        dlg0 === null &&
        zero.ok &&
        (await backLeaves(page)),
      `back ${two.now} → ${one.now} → ${zero.now}`,
    );
  }

  // AC-1-5 (a) 吹き出し A を開いたまま別の ⓘ B → 戻る 1 回で何も開いていない → もう 1 回で離れる
  {
    await backFresh(page);
    // スマホはシートを半分（peek）にして、舞台の ⓘ とシナリオの ⓘ が同時に見える状態で
    if (phone) await setShell(page, 'scenario', 'peek');
    await page.click(HINT);
    await backWait(page, 1);
    // B: 見えていて押せる別の ⓘ。押したものの名前を detail に出す
    const B_SEL = '.pop-wrap > button.hintbtn';
    const b = await page.evaluate(
      ({ hint, sel }) => {
        const a = document.querySelector(hint);
        const all = [...document.querySelectorAll(sel)];
        const hit = all.find((b) => {
          if (b === a || b.closest('dialog')) return false;
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === b || b.contains(hit));
        });
        return hit
          ? { index: all.indexOf(hit), name: hit.getAttribute('aria-label') ?? hit.textContent }
          : null;
      },
      { hint: HINT, sel: B_SEL },
    );
    const bIndex = b ? b.index : -1;
    if (b) await page.locator(B_SEL).nth(b.index).click();
    const bOpen = (await backOpen(page)).filter((s) => s === 'popover').length;
    const one = await backWait(page, 1);
    await backGo(page);
    const left = await backOpen(page);
    const zero = await backWait(page, 0);
    check(
      `AC-1-5(a) ${tag} 吹き出し A → 別の ⓘ B（back 1 のまま）→ 戻る 1 回で何も開いていない → もう 1 回で離れる`,
      bIndex >= 0 &&
        bOpen === 1 &&
        one.ok &&
        left.length === 0 &&
        zero.ok &&
        (await backLeaves(page)),
      `${b ? `B「${b.name}」・` : '別の ⓘ が見えない・'}吹き出し ${bOpen}・back ${one.now} → ${zero.now}・残り ${left.join(',') || 'なし'}`,
    );
  }

  // AC-1-5 (b) PC: パレットから「設定…」→ 戻る 1 回で設定が閉じる → もう 1 回で離れる
  if (!phone) {
    await backFresh(page);
    await openPalette(page);
    await page.keyboard.type('設定');
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    const shown = await page
      .waitForSelector(SET, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    const one = await backWait(page, 1);
    await backGo(page);
    await page.waitForSelector(SET, { state: 'detached', timeout: 3000 }).catch(() => {});
    const closed = (await page.$(SET)) === null && (await page.$(PALETTE)) === null;
    const zero = await backWait(page, 0);
    check(
      `AC-1-5(b) ${tag} パレット → 「設定…」（back 1）→ 戻る 1 回で設定が閉じる → もう 1 回で離れる`,
      shown && one.ok && closed && zero.ok && (await backLeaves(page)),
      `${shown ? '' : '設定が開かない・'}back ${one.now} → ${zero.now}`,
    );
  }

  // AC-1-6 進む: 設定 → 戻る → 進む → 何も開かない・URL 同じ → 戻る 1 回で離れる
  {
    await backFresh(page);
    const url0 = page.url();
    await openFromMore(page, '設定…', SET);
    await backWait(page, 1);
    await backGo(page);
    await page.waitForSelector(SET, { state: 'detached', timeout: 3000 }).catch(() => {});
    await page.goForward({ timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);
    const zero = await backWait(page, 0);
    const left = await backOpen(page);
    check(
      `AC-1-6 ${tag} 設定 → 戻る → 進む: 何も開かず URL 同じ（back 0 に戻す）→ 戻る 1 回で離れる`,
      left.length === 0 && page.url() === url0 && zero.ok && (await backLeaves(page)),
      `back ${zero.now}・開いている ${left.join(',') || 'なし'}`,
    );
  }

  // AC-1-7 再読み込み: 設定を開いたまま再読み込み → 何も開いていない → 戻るを最大 3 回（空振りの回数を出す）
  {
    await backFresh(page);
    await openFromMore(page, '設定…', SET);
    await backWait(page, 1);
    await page.reload();
    await waitReady(page, 'next');
    const after = await backOpen(page);
    const err0 = errors.length;
    let leftAt = 0;
    const stray = [];
    for (let i = 1; i <= 3; i++) {
      await backGo(page);
      if (page.url() === 'about:blank') {
        leftAt = i;
        break;
      }
      await waitReady(page, 'next').catch(() => {});
      const o = await backOpen(page);
      if (o.length) stray.push(`${i} 回目: ${o.join(',')}`);
    }
    console.log(
      `参考  AC-1-7 ${tag} 再読み込みの後、${leftAt ? `${leftAt} 回目の戻るで離れた（空振り ${leftAt - 1} 回）` : '3 回の戻るで離れない'}`,
    );
    check(
      `AC-1-7 ${tag} 設定を開いたまま再読み込み → 何も開いていない → 戻る 3 回以内で離れる（開いた層・pageerror なし）`,
      after.length === 0 && leftAt > 0 && stray.length === 0 && errors.length === err0,
      `再読み込みの後 ${after.join(',') || 'なし'}・${leftAt ? `${leftAt} 回目で離れる` : '離れない'}${stray.length ? `・${stray.join(' / ')}` : ''}${errors.length > err0 ? `・pageerror ${errors.slice(err0).join(' / ')}` : ''}`,
    );
  }

  // AC-1-8 共有 URL（#p=）: 消し込みが効く → 設定 → 戻る → URL に #p= が無い → 戻る 1 回で離れる
  {
    await backFresh(page, share.hash);
    const erased = await page
      .waitForFunction(() => location.hash === '', undefined, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await openFromMore(page, '設定…', SET);
    const one = await backWait(page, 1);
    await backGo(page);
    await page.waitForSelector(SET, { state: 'detached', timeout: 3000 }).catch(() => {});
    const closed = (await page.$(SET)) === null;
    const hash = new URL(page.url()).hash;
    const zero = await backWait(page, 0);
    check(
      `AC-1-8 ${tag} 共有 URL の #p= が消える → 設定 → 戻るで閉じて URL に #p= が無い → 戻る 1 回で離れる`,
      erased && one.ok && closed && hash === '' && zero.ok && (await backLeaves(page)),
      `${erased ? '' : '#p= が残る・'}back ${one.now} → ${zero.now}・hash ${hash || 'なし'}`,
    );
  }

  // AC-1-9 起動直後（何も操作しない）の history.length が goto 直後から増えない
  {
    await page.goto('about:blank');
    await page.goto(pageUrl('next'));
    const len0 = await page.evaluate(() => history.length);
    await waitReady(page, 'next', { keepNotes: true });
    await page.waitForTimeout(2000);
    const len1 = await page.evaluate(() => history.length);
    check(
      `AC-1-9 ${tag} 起動して 2 秒（操作なし）: history.length が増えない`,
      len1 === len0,
      `${len0} → ${len1}`,
    );
  }

  // AC-1-10 戻るで取り消さないもの: ステッパー・パネル（スマホはドック、PC は市場の切替）・足の詳細・トースト・作業の
  // タブの切り替え → 履歴を積まない。作業のタブは 2 つ要るので workspace-v2.json のタブ 3 つ（作業の保存を入れ直して開く）
  {
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [WORKSPACE_KEY, JSON.stringify({ ...fixture, active: 0 })],
    );
    await backFresh(page);
    const len0 = await page.evaluate(() => history.length);
    const done = [];
    if (phone) await setShell(page, 'scenario', 'full');
    await page
      .click('section.scenario .stepper[data-name="dSigma"] > button:last-child')
      .then(() => done.push('ステッパー'))
      .catch(() => {});
    if (phone) {
      await setShell(page, 'positions', 'full').then((ok) => ok && done.push('ドックのタブ'));
    } else {
      await page
        .click('[aria-label="市場"] button[aria-pressed="false"] >> nth=0')
        .then(() => done.push('市場の切替'))
        .catch(() => {});
    }
    await page
      .click('section.positions li.leg:nth-child(1) .leg-main')
      .then(() => done.push('足の詳細'))
      .catch(() => {});
    await page
      .click('section.positions li.leg:nth-child(2) button[aria-label$="の足を削除"]')
      .catch(() => {});
    if (
      await page
        .waitForSelector('.toast:not(.note)', { timeout: 2000 })
        .then(() => true)
        .catch(() => false)
    )
      done.push('トースト');
    await page
      .click('.boxtabs [role="tab"]:nth-child(2)')
      .then(() => done.push('作業のタブの切り替え'))
      .catch(() => {});
    await page.waitForTimeout(300);
    const len1 = await page.evaluate(() => history.length);
    const b = await page.evaluate(() => history.state?.back ?? null);
    check(
      `AC-1-10 ${tag} ${done.join('・')} の後も history.length が同じ → 戻る 1 回で離れる`,
      done.length === 5 && len1 === len0 && b === 0 && (await backLeaves(page)),
      `${len0} → ${len1}・back ${b}・行った操作 ${done.length} / 5`,
    );
  }

  // 遅れて届く popstate（UI で閉じた後始末の go(−1)）がフォーカスを奪わない: go を 300ms 遅らせ、⋯ を Esc で閉じた直後
  // （popstate の前）にシナリオの ΔX の数値入力へ入る → popstate の後も入力欄が開いたままでフォーカスがそこにある
  {
    const late = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    await late.addInitScript(() => {
      window.__pops = 0;
      const go = history.go.bind(history);
      history.go = (n) => setTimeout(() => go(n), 300);
      addEventListener('popstate', () => {
        window.__pops++;
      });
    });
    const lp = await late.newPage();
    await lp.goto(pageUrl('next'));
    await waitReady(lp, 'next');
    if (phone) await setShell(lp, 'scenario', 'peek');
    const val = 'section.scenario .stepper[data-name="dX"] > .val';
    await lp.click(MORE);
    await lp
      .waitForSelector('header.top > .menu-wrap [role="menu"]', { timeout: 3000 })
      .catch(() => {});
    await lp.keyboard.press('Escape');
    const before = await lp.evaluate(() => window.__pops);
    await lp.focus(val);
    await lp.keyboard.press('Enter');
    const opened = await lp
      .waitForSelector(`${val} input`, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    const popped = await lp
      .waitForFunction(() => window.__pops > 0, undefined, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    await lp.waitForTimeout(150);
    const inInput = await lp.evaluate(
      (q) => document.activeElement?.matches(q) === true,
      `${val} input`,
    );
    const back = await lp.evaluate(() => history.state?.back ?? null);
    check(
      `${tag} ⋯ を Esc で閉じた直後に数値入力へ入る → 遅れて届く popstate の後も入力欄にフォーカス`,
      before === 0 && opened && popped && inInput && back === 0,
      `popstate ${before === 0 ? '入力の後' : '入力の前'}・入力欄 ${opened ? 'あり' : 'なし'}・フォーカス ${inInput ? '入力欄' : '外'}・back ${back}`,
    );
    await late.close();
  }

  check(
    `${tag} 戻るの手順の間に pageerror なし`,
    errors.length === 0,
    errors.slice(0, 3).join(' / '),
  );
  await ctx.close();
}

// ---- 手順（AC-11・AC-12）
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failed = true;
  console.log(`${ok ? 'pass' : 'fail'}  ${name}${detail ? `（${detail}）` : ''}`);
}

async function runFlows() {
  const phone = { width: 390, height: 844 };
  const pc = { width: 1440, height: 900 };
  const next = pageUrl('next');

  // #207 先物推移の段の高さ・最大化・段の十字線（タッチ。マウスは既定の実行の futSweep）。後ろの手順の既知の止まり
  // （#87 の TimeoutError など）に隠れないよう先に回す
  await futPaneTouchFlow();
  for (const vp of [
    { width: 360, height: 780 },
    { width: 390, height: 844 },
  ])
    await futPanePeekTouchFlow(vp);

  // #301 保有の印（チップ・タブのメニュー・ポジションの ⋯・保存一覧の行。360px と PC）
  for (const vp of [{ width: 360, height: 780 }, pc]) await heldFlows(vp);

  // #320 戻るで開いているものを 1 つ閉じる（--back だけでも流せる）
  for (const vp of [phone, pc]) await backFlows(vp);

  // (a) 開いただけでは作業の保存を書き換えない・ドックのバッジ
  {
    const ctx = await newContext(phone, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    await page.waitForTimeout(2000);
    const after = await page.evaluate((k) => localStorage.getItem(k), WORKSPACE_KEY);
    check('AC-11(a) クエリなしで開いて 2 秒: 作業の保存がバイト単位で同じ', after === twoLegs);
    const badge = await page
      .textContent('.dock button[data-panel="positions"] .cnt', { timeout: 3000 })
      .catch(() => null);
    check('AC-11(a) ドックのポジのバッジが 2', badge === '2', `バッジ ${badge}`);
    await ctx.close();
  }

  // (b) 共有 URL（share-v1、足 3 本）を古い ?ui=next とクエリなしで開く → 足 3 本、URL に ui も hash も無い（#91 AC-A3(a)）
  //     → クエリなしで開き直しても足 3 本・保存 3
  for (const entry of [OLD_ENTRY_NEXT, '']) {
    const ctx = await newContext(phone, {});
    const page = await ctx.newPage();
    await page.goto(`${entryUrl(entry)}${share.hash}`);
    await waitReady(page, 'next');
    const badge = await page
      .waitForFunction(
        () =>
          document.querySelector('.dock button[data-panel="positions"] .cnt')?.textContent === '3',
        undefined,
        { timeout: 5000 },
      )
      .then(() => '3')
      .catch(() => null);
    const label = entry || 'クエリなし';
    check(`AC-11(b) ${label} で共有 URL を開いて足 3 本（バッジ）`, badge === '3');
    const u = new URL(page.url());
    check(
      `AC-11(b) ${label}: URL に ui も hash も無い（#91 AC-A3(a)）`,
      !u.searchParams.has('ui') && u.hash === '',
      `${u.search}${u.hash}` || '(なし)',
    );
    await page.waitForTimeout(1500); // 自動保存（500ms の debounce）
    await page.goto(next);
    await waitReady(page, 'next');
    const rows = await page
      .locator('.dock button[data-panel="positions"] .cnt')
      .textContent({ timeout: 3000 })
      .catch(() => null);
    const saved = await page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return ws?.tabs?.[ws.active]?.position?.legs?.length ?? null;
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);
    check(
      `AC-11(b) ${label} → クエリなしで開き直すと足 3 本`,
      rows === '3' && saved === 3,
      `バッジ ${rows}・保存 ${saved}`,
    );
    await ctx.close();
  }

  // (c) テーマのメニュー: ライト → data-theme・prefs・再読み込み、端末に合わせる → emulateMedia に追従
  {
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: twoLegs }, 'dark');
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
    check(
      'AC-11(c) 既定（端末に合わせる・端末はダーク）で data-theme="dark"',
      (await theme()) === 'dark',
    );
    await page.click('button[aria-label="テーマ"]');
    await page.click('[role="menuitemradio"]:has-text("ライト")');
    check('AC-11(c) 「ライト」で html[data-theme="light"]', (await theme()) === 'light');
    const prefs = await page.evaluate((k) => localStorage.getItem(k), PREFS_KEY);
    let pv = null;
    try {
      pv = JSON.parse(prefs ?? 'null');
    } catch {}
    // #131: 証拠金のキー（margin_*。資金は未設定なので capital_yen は無い）も同じキーに書く（#150 のキー・既定）
    check(
      'AC-11(c) option-simulator.prefs が版 1・theme light（証拠金の既定のキーつき、資金なし）',
      pv?.schema_version === 1 &&
        pv?.theme === 'light' &&
        pv?.margin_k_pct === 100 &&
        !('margin_factor_pct' in (pv ?? {})) &&
        !('capital_yen' in (pv ?? {})),
      String(prefs),
    );
    await page.reload();
    await waitReady(page, 'next');
    check('AC-11(c) 再読み込み後もライト', (await theme()) === 'light');
    await page.click('button[aria-label="テーマ"]');
    await page.click('[role="menuitemradio"]:has-text("端末に合わせる")');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(100);
    const t1 = await theme();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(100);
    const t2 = await theme();
    check(
      'AC-11(c) 端末に合わせる: emulateMedia light / dark に追従',
      t1 === 'light' && t2 === 'dark',
      `${t1} / ${t2}`,
    );
    await ctx.close();
  }

  // (d) 古い入口（?ui=next・旧画面の入口だった ui の値）を prefs = ライトで開く → 新しい画面で html[data-theme="light"]（#91）
  for (const entry of OLD_ENTRIES) {
    const ctx = await newContext(
      pc,
      { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('light') },
      'dark',
    );
    const page = await ctx.newPage();
    await page.goto(entryUrl(entry));
    await waitReady(page, 'next');
    const r = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      layout: !!document.querySelector('main.layout'),
    }));
    check(
      `AC-11(d) ${entry} を prefs = ライトで開くと main.layout と html[data-theme="light"]`,
      r.layout && r.theme === 'light',
      JSON.stringify(r),
    );
    await ctx.close();
  }

  // #91 AC-A1: クエリなし・古い入口のどれでも main.layout があり、旧画面の根（div.app）が無い。dev の部品の見本は
  // ?parts と古い ?ui=next&parts
  for (const entry of ['', ...OLD_ENTRIES]) {
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(entryUrl(entry));
    await waitReady(page, 'next');
    const r = await page.evaluate(() => ({
      layout: document.querySelectorAll('main.layout').length,
      app: document.querySelectorAll('div.app').length,
    }));
    check(
      `#91 AC-A1 ${entry || 'クエリなし'} で main.layout があり div.app が無い`,
      r.layout === 1 && r.app === 0,
      `main.layout ${r.layout}・div.app ${r.app}`,
    );
    await ctx.close();
  }
  for (const entry of ['?parts', `${OLD_ENTRY_NEXT}&parts`]) {
    const ctx = await newContext(pc, {});
    const page = await ctx.newPage();
    await page.goto(entryUrl(entry));
    const ok = await page
      .waitForSelector('.parts-gallery', { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check(`#91 AC-A1 ${entry} で部品の見本（.parts-gallery）`, ok);
    await ctx.close();
  }

  // #91 AC-A3(d): 旧画面のときに書かれた保存（版 2 の全体・版 1）をクエリなしで開く → 警告のトーストが無く、タブ数・足の本数が
  // fixture のとおり。枚数を 1 回変えた後の保存の ui.pnl_folded が fixture の値のまま（旧画面の [たたむ] の状態を捨てない）
  for (const file of ['workspace-v2.json', 'workspace-v1.json']) {
    const text = readFileSync(join(root, 'tests/ui/saved', file), 'utf8');
    const doc = JSON.parse(text);
    const wantTabs = doc.tabs ? doc.tabs.length : 1;
    const wantLegs = (doc.tabs ? doc.tabs[doc.active].position : doc.position).legs.length;
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: text });
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next', { keepNotes: true });
    const r = await page.evaluate(() => ({
      warn: document.querySelectorAll('.toast.note.warn').length,
      tabs: document.querySelectorAll('.boxtabs [role="tab"]').length,
      legs: document.querySelectorAll('section.positions li.leg').length,
    }));
    await page.click('section.positions li.leg:nth-child(1) .stepper > button:last-child');
    await page.waitForTimeout(900); // 自動保存（500ms の debounce）
    const folded = await page.evaluate((k) => {
      try {
        return JSON.parse(localStorage.getItem(k) ?? 'null')?.ui?.pnl_folded ?? null;
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);
    check(
      `#91 AC-A3(d) ${file} をクエリなしで開く: 警告のトースト 0・タブ ${wantTabs}・足 ${wantLegs}、枚数を変えた後の ui.pnl_folded が ${doc.ui.pnl_folded} のまま`,
      r.warn === 0 && r.tabs === wantTabs && r.legs === wantLegs && folded === doc.ui.pnl_folded,
      `警告 ${r.warn}・タブ ${r.tabs}・足 ${r.legs}・pnl_folded ${folded}`,
    );
    await ctx.close();
  }

  // AC-12 キーボード
  {
    const ctx = await newContext(pc, { [WORKSPACE_KEY]: twoLegs }, 'dark');
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const onButton = () =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'テーマ');
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await onButton();
    }
    check('AC-12 Tab でテーマのボタンに届く', reached);
    await page.keyboard.press('Enter');
    const first = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]');
      const items = menu ? [...menu.querySelectorAll('[role^="menuitem"]')] : [];
      return !!menu && document.activeElement === items[0];
    });
    check('AC-12 Enter でメニューが開き最初の項目にフォーカス', first);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const chosen = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      menu: !!document.querySelector('[role="menu"]'),
      onButton: document.activeElement?.getAttribute('aria-label') === 'テーマ',
    }));
    check(
      'AC-12 ↓ ↓ Enter でライトになり、メニューが閉じてボタンへ戻る',
      chosen.theme === 'light' && !chosen.menu && chosen.onButton,
      JSON.stringify(chosen),
    );
    await page.keyboard.press('Enter');
    const opened = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({
      menu: !!document.querySelector('[role="menu"]'),
      onButton: document.activeElement?.getAttribute('aria-label') === 'テーマ',
    }));
    check(
      'AC-12 Esc で閉じてボタンへ戻る',
      opened && !esc.menu && esc.onButton,
      JSON.stringify(esc),
    );
    await page.click('button[aria-label="テーマ"]');
    const opened2 = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    await page.mouse.click(700, 500);
    const outside = await page.evaluate(() => !!document.querySelector('[role="menu"]'));
    check(
      'AC-12 外側のクリックで閉じる',
      opened2 && !outside,
      `開いた ${opened2}・外側の後 ${outside}`,
    );
    await ctx.close();
  }

  // 参考（AC-14 の自動の部分）: ドックとつまみ
  {
    const ctx = await newContext(phone, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(next);
    await waitReady(page, 'next');
    const st = () =>
      page.evaluate(() => {
        const l = document.querySelector('.layout');
        return `${l?.getAttribute('data-panel')}/${l?.getAttribute('data-sheet')}`;
      });
    const seq = [await st()];
    await page.click('.dock button[data-panel="board"]');
    seq.push(await st());
    await page.click('.dock button[data-panel="board"]');
    seq.push(await st());
    await page.click('.dock button[data-panel="scenario"]');
    seq.push(await st());
    const drag = async (dy) => {
      const b = await page.locator('.grabber').boundingBox();
      if (!b) return;
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy, { steps: 4 });
      await page.mouse.up();
      await settleMotion(page); // シートの高さ（#91 段 C）が止まってから次のつまみを測る
    };
    await drag(-60);
    seq.push(await st());
    await drag(60);
    seq.push(await st());
    await drag(30);
    seq.push(await st());
    await drag(60);
    seq.push(await st());
    const want = [
      'positions/peek',
      'board/peek',
      'board/hidden',
      'scenario/peek',
      'scenario/full',
      'scenario/peek',
      'scenario/peek',
      'scenario/hidden',
    ];
    check(
      '参考 ドック（別 → 同じ → 別）とつまみのドラッグ（↑60 ↓60 ↓30 ↓60）',
      JSON.stringify(seq) === JSON.stringify(want),
      seq.join(' → '),
    );
    await ctx.close();
  }

  // #82 舞台の手順（AC-13・AC-14・AC-15）
  for (const vp of [phone, pc]) await stageFlows(vp);
  // #83 シナリオの手順（AC-10・AC-11）
  for (const vp of [phone, pc]) await scenarioFlows(vp);
  // #84 作業台の手順（AC-11・AC-12）
  for (const vp of [phone, pc]) await benchFlows(vp);
  // #86 指標の手順（AC-10・AC-11）
  for (const vp of [phone, pc]) await metricsFlows(vp);
  // #107 副題の全文のポップオーバーの手順（AC-4）
  for (const vp of [phone, pc]) await subtitleFlows(vp);
  // #161 360x780 の peek で証拠金・余力の全文
  await marginFull360();
  // #85 市場の手順（AC-9・AC-10・AC-12）: 5 列（390）・7 列（1440）・9 列（1800）
  const wide = { width: 1800, height: 1000 };
  for (const vp of [phone, pc, wide]) await marketFlows(vp);
  for (const vp of [phone, pc, wide]) await marketWideFlows(vp);
  await marketPersistFlow();
  // #87 (A) トップバーの手順（AC-11・AC-15）
  for (const vp of [phone, pc]) await topFlows(vp);
  // #87 (B) BOX タブの手順（AC-12・AC-15(e)）と URL 共有の手順（AC-13）
  for (const vp of [phone, pc]) await tabFlows(vp);
  await shareFlows(pc);
  // #87 (C) 設定と保存一覧の手順（AC-14）とタッチの端末のエミュレーション（AC-19。Chromium の根拠）
  for (const vp of [phone, pc]) await bookSettingsFlows(vp);
  await touchFlows();
  // #88 段 A 面モードの表示の手順（AC-12・AC-14）
  for (const vp of [phone, pc]) await surfaceFlows(vp);
  await surfaceDprFlow();
  // #88 段 B 面の上のドラッグの手順（AC-13・AC-14 [B]）とタッチのエミュレーション（AC-13(f)）
  for (const vp of [phone, pc]) await surfaceDragFlows(vp);
  await surfaceTouchFlow();
  // #89 段 A 全体のキー 1〜5・G・T の手順（AC-A4）。900 は参考（AC に数えない。vitest の 15 マスが正）
  for (const vp of [phone, pc, { width: 900, height: 1100 }]) await keyFlows(vp);
  // #89 段 B コマンドパレットの手順（AC-B5）
  for (const vp of [phone, pc]) await paletteFlows(vp);
  for (const vp of [phone, pc]) await paletteWideFlow(vp);
  // #124 a11y: トーストの読み上げの領域を作り直さない・パレット / 説明カードの背景・同じフレームの連打
  for (const vp of [phone, pc]) await a11yFlows(vp);
  // #91 段 C 動き（AC-C1・C2・C6・C7）と長いフレーム（AC-C3）
  for (const vp of [phone, pc]) await motionFlows(vp);
  for (const vp of [phone, pc]) await motionFlows(vp, true);
  for (const vp of [phone, pc]) await motionLoafFlow(vp);
  // #79 段 B IV 推移の遅延ロード・最新化・足の切替・進行中の足（AC-10・AC-12）
  for (const vp of [phone, pc]) await ivFlows(vp);
  // #79 段 C IV 推移の追加読み込み・「今」の印・シナリオの水準（AC-9・AC-11）
  for (const vp of [phone, pc]) await ivMoreFlows(vp);
  // #130 IV 推移の十字線と軸の札（AC-7 (a)〜(c)）、ドックの IV の既定と保持（AC-7 (d)）
  await ivCrossFlows(pc);
  await ivCrossTouchFlow();
  for (const vp of [phone, { width: 900, height: 1100 }]) await ivDockFlows(vp);
  // #190 先物推移の遅延ロード・IV 推移と要求が混ざらない・限月交代の印・切替で足を保つ（AC-9）
  for (const vp of [phone, pc]) await futFlows(vp);
  // #201 損益グラフの十字線（PC のホバー・タッチのタップ / 交点のドラッグ / ほかの所のタップ・× で消す（#217。移さない）・長押しとパンは今のまま）
  await pnlCrossFlows(pc);
  await pnlCrossTouchFlow();
  // #217 スマイル・追証マップのタップの十字線（タッチ 360 / 1440）・面はタッチで出さない
  for (const vp of [
    { width: 360, height: 780 },
    { width: 1440, height: 900 },
  ])
    await cross217TouchFlows(vp);
  // #174 追証マップの開閉の時間・開いたときの滑らかなスクロールとスピナー（AC4）
  for (const vp of [pc, phone]) await holdToggleFlow(vp);
  // #135 AI のチャットの進み具合・中止・終端なし・ツールのカード・会話の保存（AC6）
  for (const vp of [phone, pc]) await aiFlows(vp);
}

/**
 * #174 AC4: 追証マップの見出しのクリックから rAF 2 回までの時間（開・閉 各 5 回の中央値 ≤ 100ms）。初めて開いたとき
 * （/fixtures/atm_daily を止めた間）はスピナーが回り（animation-name hm-spin）、滑らかなスクロールが止まった後に描画域が
 * 枠の中（AC2 (a)）。スマホは指標 peek
 */
async function holdToggleFlow(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, {
    [WORKSPACE_KEY]: sellFive,
    [PREFS_KEY]: prefsText('dark', { capital_yen: MARGIN_CAPITAL }),
  });
  const page = await ctx.newPage();
  const release = await holdDailyGate(page);
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (vp.width <= PHONE_MAX)
    check(`#174 ${tag} ドックで「指標」を開く（peek）`, await setShell(page, 'metrics', 'peek'));
  await holdScrollBottom(page);
  await page.waitForTimeout(50);
  await page.click('section.metrics .hm-toggle');
  await page.waitForSelector('section.metrics .hm-wait', { timeout: 3000 }).catch(() => {});
  const anim = await page.evaluate(() => {
    const spin = document.querySelector('section.metrics .hm-wait .hm-spin');
    return spin ? getComputedStyle(spin).animationName : null;
  });
  check(`#174 ${tag} 読み込み中はスピナーが回る`, anim === 'hm-spin', `animation-name ${anim}`);
  // 描画域の高さが決まってから（#254。その後に測り直した 2 回目のスクロールが始まりうる）、滑らかなスクロールが
  // 止まるまで（scrollTop が 3 フレーム変わらない）
  const settled = await holdWidthSettled(page);
  check(`#174 ${tag} 開いた後 描画域の幅が決まる（3 秒以内）`, settled);
  await twoFrames(page);
  await page.evaluate(
    () =>
      new Promise((res) => {
        const host = document.querySelector('section.metrics .panel-body');
        let last = -1;
        let same = 0;
        const t0 = performance.now();
        const tick = () => {
          const v = host?.scrollTop ?? 0;
          same = v === last ? same + 1 : 0;
          last = v;
          if (same >= 3 || performance.now() - t0 > 2000) res(null);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const r = await holdPlace(page);
  check(
    `#174 ${tag} 開いたら（滑らかなスクロールの後）描画域と読み取りが枠の中（入る幅では見出しも）`,
    holdPlaced(r),
    r
      ? `見出し ${Math.round(r.btnTop - r.hostTop)}px・下端の余り 描画域 ${Math.round(r.hostBottom - r.plotBottom)}px / 読み取り ${Math.round(r.hostBottom - r.readBottom)}px`
      : 'なし',
  );
  release();
  await page
    .waitForFunction(() => !document.querySelector('section.metrics .hm-wait'), undefined, {
      timeout: 8000,
    })
    .catch(() => {});
  const times = { open: [], close: [] };
  for (let i = 0; i < 10; i++) {
    const t = await page.evaluate(
      () =>
        new Promise((res) => {
          const b = document.querySelector('section.metrics .hm-toggle');
          const t0 = performance.now();
          b?.click();
          requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0)));
        }),
    );
    // i = 0 は閉じる（開いている）。交互
    (i % 2 === 0 ? times.close : times.open).push(t);
    await page.waitForTimeout(400);
  }
  const median = (a) => {
    const v = [...a].sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)] ?? Number.NaN;
  };
  const mo = median(times.open);
  const mc = median(times.close);
  check(
    `#174 ${tag} 開閉のクリックから rAF 2 回まで（中央値 ≤ 100ms）`,
    mo <= 100 && mc <= 100,
    `開 ${mo.toFixed(1)}ms・閉 ${mc.toFixed(1)}ms（各 5 回）`,
  );
  await ctx.close();
}

// ---- 舞台の手順（#82）
const board = JSON.parse(readFileSync(join(root, 'fixtures/synthetic/latest.json'), 'utf8'));
/** 合成の板のその限月・K の put の bid */
const putBid = (month, k) =>
  board.months.find((m) => m.contract_month === month)?.rows.find((r) => r.k === k)?.put.bid ??
  null;
/** 画面の符号付きの整数（fmtSigned(v, 0) と同じ: +1,234 / −1,234 / 0） */
const signedText = (v) => {
  const s = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(v));
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : '0';
};

/** Long Animation Frame（50ms 超）の数を数える observer（ページより先に入れる） */
const LOAF_INIT = `
  window.__loaf = [];
  window.__loafAt = [];
  window.__checkRanges = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__loaf.push(e.duration);
        window.__loafAt.push([e.startTime, e.startTime + e.duration]);
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
    window.__loafOk = true;
  } catch {
    window.__loafOk = false;
  }
`;

async function stageFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        const pos = ws?.tabs?.[ws.active]?.position;
        return { scenario: pos?.scenario ?? null, legs: pos?.legs ?? [] };
      } catch {
        return { scenario: null, legs: [] };
      }
    }, WORKSPACE_KEY);
  };
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const aria = (sel) =>
    page.evaluate((s) => Number(document.querySelector(s)?.getAttribute('aria-valuenow')), sel);
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const drag = async (from, dx, dy, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
  };
  const axes = new Set();
  const loafs = [];

  // 始めにシナリオを 0 に（描画域にフォーカスして 0）
  await page.focus('.chart');
  await page.keyboard.press('0');
  const s0 = (await saved()).scenario;
  check(
    `#82 ${tag} 描画域の 0 でシナリオが 0 に`,
    s0?.dX === 0 && s0?.days === 0 && s0?.dSigma === 0,
    JSON.stringify(s0),
  );

  // (a) ハンドルを横に 60px → ΔX（10 円の倍数）。保存と読み取りの副題が同じ値
  {
    const h = await box('.chart .handle-hit');
    const mark = await loafMark();
    await drag(h, 60, 0, 30);
    const lf = await loafSince(mark);
    loafs.push(`ハンドル ${lf}`);
    const sc = (await saved()).scenario;
    const sub = await page.textContent('.ro[data-ro="date"] .s');
    const dX = sc?.dX ?? 0;
    const ok = dX !== 0 && dX % 10 === 0 && (sub ?? '').includes(`(${signedText(dX)}/`);
    if (ok) axes.add('ΔX');
    check(`#82 AC-13(a) ${tag} ハンドルを 60px → ΔX ${dX}・副題と同じ`, ok, sub ?? '');
    check(
      `#82 AC-15 ${tag} ハンドルのドラッグ 30 回の move で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
  }

  // (b) IV レールのつまみを上に 40px → Δσ > 0、ダブルクリックで 0
  {
    const k = await box('.ivrail .knob');
    const mark = await loafMark();
    await drag(k, 0, -40, 30);
    const lf = await loafSince(mark);
    loafs.push(`IV レール ${lf}`);
    const now = await aria('.ivrail');
    const sc = (await saved()).scenario;
    const ok = now > 0 && sc?.dSigma === now;
    if (ok) axes.add('Δσ');
    check(`#82 AC-13(b) ${tag} IV レールを上に 40px → Δσ ${now}（保存 ${sc?.dSigma}）`, ok);
    check(
      `#82 AC-15 ${tag} IV レールのドラッグ 30 回で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
    const k2 = await box('.ivrail .knob');
    await page.mouse.dblclick(k2.x, k2.y);
    await page.waitForTimeout(100);
    const z = await aria('.ivrail');
    const sc2 = (await saved()).scenario;
    check(
      `#82 AC-13(b) ${tag} IV レールのダブルクリックで 0`,
      z === 0 && sc2?.dSigma === 0,
      `${z} / ${sc2?.dSigma}`,
    );
  }

  // (c) 時間レールのつまみを右に 60px → d が 1 以上の整数、SQ の目盛りのタップ → daysToTarget の値
  {
    const k = await box('.timerail .knob');
    const mark = await loafMark();
    await drag(k, 60, 0, 30);
    const lf = await loafSince(mark);
    loafs.push(`時間レール ${lf}`);
    const now = await aria('.timerail');
    const sc = (await saved()).scenario;
    const ok = Number.isInteger(now) && now >= 1 && sc?.days === now;
    if (ok) axes.add('d');
    check(`#82 AC-13(c) ${tag} 時間レールを右に 60px → d ${now}（保存 ${sc?.days}）`, ok);
    check(
      `#82 AC-15 ${tag} 時間レールのドラッグ 30 回で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
    const t = await box('.timerail .mark.sq');
    const want = Number(await page.getAttribute('.timerail .mark.sq', 'data-days'));
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(100);
    const got = await aria('.timerail');
    const sc2 = (await saved()).scenario;
    check(
      `#82 AC-13(c) ${tag} SQ の目盛りのタップ → d = daysToTarget`,
      got === want && sc2?.days === want && !Number.isInteger(want),
      `${got} / 期待 ${want}`,
    );
  }

  // (d) キー: 描画域で → ↑ ] → ΔX +100・Δσ +0.5・d +1、IV レールで ↑、時間レールで →
  {
    await page.focus('.chart');
    await page.keyboard.press('0');
    const a = (await saved()).scenario;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press(']');
    const b = (await saved()).scenario;
    check(
      `#82 AC-13(d) ${tag} 描画域の → ↑ ] で ΔX +100・Δσ +0.5・d +1`,
      b?.dX === a.dX + 100 && b?.dSigma === a.dSigma + 0.5 && b?.days === a.days + 1,
      `${JSON.stringify({ dX: b?.dX, dSigma: b?.dSigma, days: b?.days })}`,
    );
    await page.focus('.ivrail');
    await page.keyboard.press('ArrowUp');
    await page.focus('.timerail');
    await page.keyboard.press('ArrowRight');
    const c = (await saved()).scenario;
    check(
      `#82 AC-13(d) ${tag} IV レールの ↑ で Δσ +0.5、時間レールの → で d +1`,
      c?.dSigma === b.dSigma + 0.5 && c?.days === b.days + 1,
      `${c?.dSigma} / ${c?.days}`,
    );
  }
  check(
    `#82 AC-13 ${tag} グラフの上で動かせる軸 ${axes.size} / 3`,
    axes.size === 3,
    [...axes].join('・'),
  );

  // AC-15 ホイール 20 回・パン 30 回
  {
    const c = await box('.chart');
    const mark = await loafMark();
    await page.mouse.move(c.b.x + c.b.width * 0.3, c.b.y + c.b.height * 0.35);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? -60 : 60);
      await page.waitForTimeout(16);
    }
    const lfWheel = await loafSince(mark);
    const mark2 = await loafMark();
    await drag({ x: c.b.x + c.b.width * 0.3, y: c.b.y + c.b.height * 0.35 }, -90, 0, 30);
    const lfPan = await loafSince(mark2);
    loafs.push(`ホイール ${lfWheel}`, `パン ${lfPan}`);
    check(
      `#82 AC-15 ${tag} ホイール 20 回で長いフレーム 0 件`,
      loafOk && lfWheel === 0,
      loafOk ? `${lfWheel} 件` : '未対応',
    );
    check(
      `#82 AC-15 ${tag} パン 30 回で長いフレーム 0 件`,
      loafOk && lfPan === 0,
      loafOk ? `${lfPan} 件` : '未対応',
    );
    console.log(`      ${tag} Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
    await page.focus('.chart');
    await page.keyboard.press('r');
  }

  // AC-14 (a) マーカーのタップ → ポジションのパネルが開き（スマホは peek）、マーカーが強調
  const phoneSize = vp.width <= PHONE_MAX;
  if (phoneSize) {
    await setShell(page, 'board', 'hidden');
    await page.waitForTimeout(150);
  }
  {
    const m = await box('.legmark[data-leg-id="1"]');
    await page.mouse.click(m.x, m.y);
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => {
      const l = document.querySelector('.layout');
      return {
        panel: l?.getAttribute('data-panel'),
        sheet: l?.getAttribute('data-sheet'),
        sel: document.querySelector('.legmark.sel')?.getAttribute('data-leg-id') ?? null,
      };
    });
    check(
      `#82 AC-14(a) ${tag} マーカーのタップ → ポジションのパネル${phoneSize ? '（peek）' : ''}・強調`,
      st.panel === 'positions' && (!phoneSize || st.sheet === 'peek') && st.sel === '1',
      JSON.stringify(st),
    );
  }

  // AC-14 (b) 売りの put のマーカーを長押し 500ms → 1 つ上の行使価格までドラッグ → 離す → [元に戻す]
  {
    const before = (await saved()).legs[0]?.leg;
    const m = await box('.legmark[data-leg-id="1"]');
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await page.waitForTimeout(500);
    const next = 63625;
    let reached = false;
    let label = '';
    for (let i = 1; i <= 80 && !reached; i++) {
      await page.mouse.move(m.x + i, m.y);
      await page.waitForTimeout(20);
      label = (await page.textContent('.chart .legdrag').catch(() => null)) ?? '';
      reached = label === `K ${next.toLocaleString('en-US')}`;
    }
    await page.mouse.up();
    const after = (await saved()).legs[0]?.leg;
    const bid = putBid('2026-11', next);
    const toast = (await page.textContent('.toast:not(.note) .txt').catch(() => null)) ?? '';
    check(
      `#82 AC-14(b) ${tag} マーカーの長押しドラッグで K ${before?.strike} → ${after?.strike}・建値 ${after?.entry}（bid ${bid}）`,
      reached &&
        before?.strike === 63500 &&
        after?.strike === next &&
        after?.entry === bid &&
        toast.includes('63,625'),
      `トースト「${toast}」`,
    );
    await page.click('.toast:not(.note) button');
    const back = (await saved()).legs[0]?.leg;
    check(
      `#82 AC-14(b) ${tag} [元に戻す] で元の strike・entry`,
      back?.strike === before?.strike && back?.entry === before?.entry,
      `${back?.strike} @${back?.entry}`,
    );
  }
  await ctx.close();
}

// ---- シナリオの手順（#83 AC-10・AC-11）
async function scenarioFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (vp.width <= PHONE_MAX) {
    const ok = await setShell(page, 'scenario', 'peek');
    check(`#83 ${tag} ドックで「シナリオ」を開く（peek）`, ok);
  }
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return {
          scenario: ws?.tabs?.[ws.active]?.position?.scenario ?? null,
          basis: ws?.ui?.future_basis ?? null,
        };
      } catch {
        return { scenario: null, basis: null };
      }
    }, WORKSPACE_KEY);
  };
  const st = (f) => `section.scenario .stepper[data-name="${f}"]`;
  const plus = (f) => `${st(f)} > button:last-child`;
  const val = (f) => `${st(f)} > .val`;
  const now = (f) =>
    page.evaluate((s) => Number(document.querySelector(s)?.getAttribute('aria-valuenow')), val(f));
  const center = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
  const loafs = [];

  // 始めにシナリオを 0 に（描画域にフォーカスして 0）
  await page.focus('.chart');
  await page.keyboard.press('0');
  const s0 = (await saved()).scenario;
  check(
    `#83 ${tag} 描画域の 0 でシナリオが 0 に`,
    s0?.dX === 0 && s0?.days === 0 && s0?.dSigma === 0 && s0?.skew === 0,
    JSON.stringify(s0),
  );

  // (a) d の ＋ → +1、Shift + ＋ → +10（上限で止まる）
  let pctHalf = 0;
  {
    await page.click(plus('days'));
    const a = (await saved()).scenario;
    check(`#83 AC-10(a) ${tag} d の ＋ → d +1`, a?.days === 1, `${a?.days}`);
    const max = Number(await page.getAttribute(val('days'), 'aria-valuemax'));
    await page.click(plus('days'), { modifiers: ['Shift'] });
    const b = (await saved()).scenario;
    const want = Math.min(11, max);
    check(
      `#83 AC-10(a) ${tag} Shift + ＋ → d +10（上限 ${max} で止まる）`,
      b?.days === want && (await now('days')) === want,
      `${b?.days} / 期待 ${want}`,
    );
    for (let i = 0; i < 5 && (await page.isEnabled(plus('days'))); i++) {
      await page.click(plus('days'), { modifiers: ['Shift'] });
    }
    const c = (await saved()).scenario;
    check(
      `#83 AC-10(a) ${tag} Shift + ＋ を続けると上限 ${max} で止まる`,
      c?.days === max,
      `${c?.days}`,
    );
    // Δσ の値を右に 40px スクラブ → +2.5pt（5 段）
    const v = await center(val('dSigma'));
    await page.mouse.move(v.x, v.y);
    await page.mouse.down();
    await page.mouse.move(v.x + 40, v.y, { steps: 10 });
    await page.mouse.up();
    const d = (await saved()).scenario;
    check(
      `#83 AC-10(a) ${tag} Δσ の値を右に 40px スクラブ → +2.5pt`,
      d?.dSigma === 2.5 && (await now('dSigma')) === 2.5,
      `${d?.dSigma}`,
    );
    // Δs の値の上でホイール上 1 回 → +0.5
    const k = await center(val('skew'));
    await page.mouse.move(k.x, k.y);
    await page.mouse.wheel(0, -100);
    const e = (await saved()).scenario;
    check(`#83 AC-10(a) ${tag} Δs の値の上でホイール上 1 回 → +0.5`, e?.skew === 0.5, `${e?.skew}`);
    // ΔX にフォーカスして ↑ → +0.5%
    await page.focus(val('dX'));
    await page.keyboard.press('ArrowUp');
    const f = (await saved()).scenario;
    pctHalf = f?.dX ?? 0;
    check(
      `#83 AC-10(a) ${tag} ΔX にフォーカスして ↑ → +0.5%（状態 ${pctHalf} 円）`,
      (await now('dX')) === 0.5 && pctHalf > 0,
    );
  }

  // (b) ΔX の数値入力: -3 Enter → X₀ × −3%、-99 Enter → X₀ × −99%（#144 の数値欄の下端）、-100 → 赤く保存は
  // 変わらない、Esc で元の表示、900 Enter → X₀ × 9 で舞台のハンドル（シナリオ点の縦線）が描画域の中（#144 AC-12）
  {
    // X₀ = ΔX = 0 のときの副題の X'（整数に丸めた値）。合成の板の X₀ は整数でないので、丸めの分を許す
    await page.focus(val('dX'));
    await page.keyboard.press('r');
    await page.waitForTimeout(100);
    const sub = (await page.textContent(`${val('dX')} small`)) ?? '';
    const x0 = Number((/X ([\d,]+)/.exec(sub)?.[1] ?? 'NaN').replaceAll(',', ''));
    const input = `${val('dX')} input`;
    const enter = async (text) => {
      await page.click(val('dX'));
      await page.waitForSelector(input);
      await page.fill(input, text);
      await page.keyboard.press('Enter');
      return (await saved()).scenario?.dX ?? Number.NaN;
    };
    const dX3 = await enter('-3');
    check(
      `#83 AC-10(b) ${tag} ΔX に -3 Enter → 保存の ΔX ${dX3} = X₀ × −3%（X₀ ≈ ${x0}）`,
      close(dX3, pctHalf * -6) && Math.abs(dX3 - x0 * -0.03) <= 0.03 * 0.5 + 0.01,
      `+0.5% の ${pctHalf} × −6 = ${pctHalf * -6}`,
    );
    const dX = await enter('-99');
    check(
      `#144 AC-12 ${tag} ΔX に -99 Enter → 保存の ΔX ${dX} = X₀ × −0.99（X₀ ≈ ${x0}）`,
      close(dX, pctHalf * -198) && Math.abs(dX - x0 * -0.99) <= 0.99 * 0.5 + 0.01,
      `+0.5% の ${pctHalf} × −198 = ${pctHalf * -198}`,
    );
    const shown = await page.textContent(`${val('dX')} b`);
    await page.click(val('dX'));
    await page.waitForSelector(input);
    await page.fill(input, '-100');
    const inv = await page.getAttribute(input, 'aria-invalid');
    const alert =
      (await page.textContent('section.scenario .scn-err[role="alert"]').catch(() => null)) ?? '';
    const b = (await saved()).scenario;
    check(
      `#144 AC-12 ${tag} -100 → aria-invalid="true"・保存は変わらない`,
      inv === 'true' && b?.dX === dX && alert.startsWith('原資産 ΔXは'),
      `「${alert}」`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const back = await page.textContent(`${val('dX')} b`).catch(() => null);
    const gone = (await page.locator(input).count()) === 0;
    const err = await page.locator('section.scenario .scn-err').count();
    check(
      `#83 AC-10(b) ${tag} Esc で元の表示（${back}）`,
      gone && back === shown && err === 0 && (await saved()).scenario?.dX === dX,
    );
    const dX900 = await enter('900');
    await page.waitForTimeout(300);
    const line = await page.evaluate(() => {
      const l = document.querySelector('section.stage .chart line.vline');
      const svg = l?.ownerSVGElement;
      if (!l || !svg) return null;
      const n = (el, k) => Number(el.getAttribute(k));
      const r = l.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      return {
        x: n(l, 'x1'),
        lo: n(svg, 'x'),
        hi: n(svg, 'x') + n(svg, 'width'),
        inBox: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      };
    });
    check(
      `#144 AC-12 ${tag} 900 Enter → 保存の ΔX ${dX900} = X₀ × 9・ハンドルの縦線が描画域の中`,
      close(dX900, pctHalf * 1800) &&
        line !== null &&
        line.x >= line.lo &&
        line.x <= line.hi &&
        line.inBox,
      JSON.stringify(line),
    );
    // 後の手順のために ΔX を 0 に戻す
    await page.focus(val('dX'));
    await page.keyboard.press('r');
    await page.waitForTimeout(100);
  }

  // (e) 前提: β の ＋ → 1.1、sticky moneyness、basis 減衰、ΔX 円（表示は円・状態の ΔX は同じ）
  {
    await page.click('section.scenario details.adv summary');
    await page.click(plus('beta'));
    const a = (await saved()).scenario;
    check(`#83 AC-10(e) ${tag} 前提を開いて β の ＋ → 1.1`, a?.beta === 1.1, `${a?.beta}`);
    await page.click(
      'section.scenario .seg[aria-label="IV の動き方"] button:has-text("sticky moneyness")',
    );
    const b = (await saved()).scenario;
    check(
      `#83 AC-10(e) ${tag} sticky moneyness → ivDynamics = "sticky_moneyness"`,
      b?.ivDynamics === 'sticky_moneyness',
      `${b?.ivDynamics}`,
    );
    await page.click('section.scenario .seg[aria-label="先物の basis"] button:has-text("減衰")');
    const c = await saved();
    check(
      `#83 AC-10(e) ${tag} basis 減衰 → future_basis = "decay"`,
      c.basis === 'decay',
      `${c.basis}`,
    );
    await page.click('section.scenario .seg[aria-label="ΔX の単位"] button:has-text("円")');
    const d = (await saved()).scenario;
    const text = (await page.textContent(`${val('dX')} b`)) ?? '';
    const yen = await now('dX');
    check(
      `#83 AC-10(e) ${tag} ΔX 円 → 表示 ${text}・状態の ΔX は変わらない`,
      text.endsWith(' 円') && yen === d?.dX && d?.dX === c.scenario?.dX,
      `表示 ${yen} / 状態 ${d?.dX}`,
    );
    const vals = await page.textContent('section.scenario details.adv .vals');
    check(
      `#83 AC-10(e) ${tag} 前提の要約`,
      vals === 'β ×1.1 · sticky moneyness · basis 減衰 · ΔX 円',
      `${vals}`,
    );
    await page.click('section.scenario .seg[aria-label="ΔX の単位"] button:has-text("%")');
    await page.click('section.scenario details.adv summary');
  }

  // (c) [急落] → ΔX = X₀ × −10%・Δσ 20・Δs 3、[リセット] → d・ΔX・Δσ・Δs が 0 で β・IV の動き方は前のまま
  {
    await page.click('section.scenario .chip:has-text("急落")');
    const a = (await saved()).scenario;
    const pressed = await page.getAttribute(
      'section.scenario .chip:has-text("急落")',
      'aria-pressed',
    );
    check(
      `#83 AC-10(c) ${tag} [急落] → ΔX ${a?.dX}（X₀ × −10%）・Δσ ${a?.dSigma}・Δs ${a?.skew}`,
      close(a?.dX ?? Number.NaN, pctHalf * -20) &&
        a?.dSigma === 20 &&
        a?.skew === 3 &&
        pressed === 'true',
    );
    await page.click('section.scenario .chip:has-text("リセット")');
    const b = (await saved()).scenario;
    check(
      `#83 AC-10(c) ${tag} [リセット] → d・ΔX・Δσ・Δs が 0、β・IV の動き方は前のまま`,
      b?.days === 0 &&
        b?.dX === 0 &&
        b?.dSigma === 0 &&
        b?.skew === 0 &&
        b?.beta === 1.1 &&
        b?.ivDynamics === 'sticky_moneyness',
      JSON.stringify(b),
    );
  }

  // (d) 評価時刻の「SQ 9:00」→ d が daysToTarget の値で、#82 の時間レールの aria-valuenow と同じ
  {
    await page.click('section.scenario .chip:has-text("SQ 9:00")');
    const a = (await saved()).scenario;
    const rail = Number(await page.getAttribute('.timerail', 'aria-valuenow'));
    const tick = Number(await page.getAttribute('.timerail .mark.sq', 'data-days'));
    const pressed = await page.getAttribute(
      'section.scenario .chip:has-text("SQ 9:00")',
      'aria-pressed',
    );
    check(
      `#83 AC-10(d) ${tag} 評価時刻の「SQ 9:00」→ d ${a?.days}・時間レール ${rail}・目盛り ${tick}`,
      a?.days === rail && a?.days === tick && (await now('days')) === rail && pressed === 'true',
    );

    // レビュー B-1: 端数の d（上限）で数値入力を開き、何も打たずに Enter / フォーカスを外しても d は変わらない
    const input = `${val('days')} input`;
    const focused = () =>
      page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), input);
    await page.click(val('days'));
    await focused();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const b = (await saved()).scenario;
    const closedEnter = (await page.locator(input).count()) === 0;
    await page.click(val('days'));
    await focused();
    await page.focus(val('dSigma'));
    await page.waitForTimeout(100);
    const c = (await saved()).scenario;
    const closedBlur = (await page.locator(input).count()) === 0;
    const errs = await page.locator('section.scenario .scn-err').count();
    const stillPressed = await page.getAttribute(
      'section.scenario .chip:has-text("SQ 9:00")',
      'aria-pressed',
    );
    check(
      `#83 B-1 ${tag} 数値入力を開いて何も打たずに Enter / フォーカスを外す → d ${c?.days} のまま`,
      closedEnter &&
        closedBlur &&
        errs === 0 &&
        b?.days === a?.days &&
        c?.days === a?.days &&
        stillPressed === 'true',
      `Enter ${b?.days}${closedEnter ? '' : '（開いたまま）'}・blur ${c?.days}${closedBlur ? '' : '（開いたまま）'}・エラー ${errs}・押下 ${stillPressed}`,
    );
  }

  // (f) #82 の IV レールを上に 40px → Δσ のステッパー = レール、Δσ の ＋ → レール +0.5
  {
    const k = await center('.ivrail .knob');
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x, k.y - 40, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const rail = Number(await page.getAttribute('.ivrail', 'aria-valuenow'));
    const mine = await now('dSigma');
    check(
      `#83 AC-10(f) ${tag} IV レールを上に 40px → Δσ のステッパー ${mine} = レール ${rail}`,
      rail > 0 && mine === rail && (await saved()).scenario?.dSigma === rail,
    );
    await page.click(plus('dSigma'));
    await page.waitForTimeout(100);
    const rail2 = Number(await page.getAttribute('.ivrail', 'aria-valuenow'));
    check(
      `#83 AC-10(f) ${tag} Δσ のステッパーの ＋ → レール ${rail} → ${rail2}`,
      rail2 === rail + 0.5,
    );
  }

  // レビュー B-2: ステッパーの外の操作（リセット・プリセット・評価時刻のチップ）で値が戻った後の [＋] / [−] と
  // 数値入力の初期値は、今の値から作る（古い送った値を使わない）
  {
    const chip = (t) => page.click(`section.scenario .chip:has-text("${t}")`);
    await chip('リセット');
    await page.click(plus('dSigma'));
    await chip('リセット');
    await page.click(plus('dSigma'));
    const a = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} Δσ: ＋ → リセット → ＋ で 0.5（1 段だけ）`,
      a?.dSigma === 0.5 && (await now('dSigma')) === 0.5,
      `${a?.dSigma}`,
    );
    await chip('リセット');
    await page.click(plus('dX'));
    await chip('急落');
    await page.click(plus('dX'));
    const b = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} ΔX: ＋ → [急落] → ＋ で −9.5%`,
      close(b?.dX ?? Number.NaN, pctHalf * -19) && close(await now('dX'), -9.5, 1e-9),
      `${b?.dX} / 期待 ${pctHalf * -19}`,
    );
    await chip('リセット');
    await page.click(plus('days'));
    await chip('最終日 15:45');
    const lastDays = (await saved()).scenario?.days ?? Number.NaN;
    await page.click(`${st('days')} > button:first-child`);
    const c = (await saved()).scenario;
    check(
      `#83 B-2 ${tag} d: ＋ → 「最終日 15:45」→ − でチップの d − 1（${lastDays} → ${c?.days}）`,
      close(c?.days ?? Number.NaN, lastDays - 1, 1e-9) && !Number.isInteger(lastDays),
    );
    await chip('リセット');
    await page.click(plus('skew'));
    await chip('リセット');
    await page.click(val('skew'));
    const input = `${val('skew')} input`;
    await page.waitForSelector(input);
    const text = await page.inputValue(input);
    await page.keyboard.press('Escape');
    check(`#83 B-2 ${tag} Δs: ＋ → リセット → 数値入力の欄が 0.0`, text === '0.0', `「${text}」`);
  }

  // AC-11 長いフレーム: スクラブ 30 段・[＋] の長押し 2 秒・プリセットの切替 10 回
  {
    await page.click('section.scenario .chip:has-text("リセット")');
    await page.waitForTimeout(100);
    const v = await center(val('dSigma'));
    const mark = await loafMark();
    await page.mouse.move(v.x, v.y);
    await page.mouse.down();
    await page.mouse.move(v.x + 240, v.y, { steps: 60 });
    await page.mouse.up();
    const lfScrub = await loafSince(mark);
    const scrubbed = (await saved()).scenario?.dSigma;
    check(`#83 AC-11 ${tag} スクラブ 240px → Δσ +15（30 段）`, scrubbed === 15, `${scrubbed}`);

    await page.click('section.scenario .chip:has-text("リセット")');
    await page.waitForTimeout(100);
    const p = await center(plus('dSigma'));
    const mark2 = await loafMark();
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(2000);
    await page.mouse.up();
    const lfHold = await loafSince(mark2);
    const held = (await saved()).scenario?.dSigma ?? 0;
    // 2 秒で 22 段（REPEAT_DELAY_MS 400・REPEAT_INTERVAL_MS 80）。タイマーの揺れを ±2 段許す
    check(
      `#83 AC-11 ${tag} [＋] の長押し 2 秒で連続 → Δσ ${held}（22 段 = 11pt の前後）`,
      held >= 10 && held <= 12,
    );

    const mark3 = await loafMark();
    const names = ['急落', '下落', '反発'];
    for (let i = 0; i < 10; i++) {
      await page.click(`section.scenario .chip:has-text("${names[i % 3]}")`);
      await page.waitForTimeout(16);
    }
    const lfPreset = await loafSince(mark3);
    loafs.push(`スクラブ ${lfScrub}`, `長押し ${lfHold}`, `プリセット ${lfPreset}`);
    for (const [name, n] of [
      ['スクラブ 30 段', lfScrub],
      ['[＋] の長押し 2 秒', lfHold],
      ['プリセットの切替 10 回', lfPreset],
    ]) {
      check(
        `#83 AC-11 ${tag} ${name}で長いフレーム 0 件`,
        loafOk && n === 0,
        loafOk ? `${n} 件` : '未対応',
      );
    }
    console.log(`      ${tag} シナリオの Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
  }
  await ctx.close();
}

// ---- 作業台の手順（#84 AC-11・AC-12）
async function benchFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'positions', 'full');
    check(`#84 ${tag} ドックで「ポジ」を開く（full）`, ok);
  }
  const P = 'section.positions';
  const leg = (i) => `${P} li.leg:nth-child(${i})`;
  const saved = async () => {
    await page.waitForTimeout(700); // 自動保存（500ms の debounce）
    return page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return {
          legs: ws?.tabs?.[ws.active]?.position?.legs ?? [],
          hedge: ws?.ui?.hedge ?? null,
        };
      } catch {
        return { legs: [], hedge: null };
      }
    }, WORKSPACE_KEY);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rowCount = () => page.locator(`${P} li.leg`).count();
  const toastText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.toast:not(.note) .txt')].map((t) => t.textContent),
    );
  /** トーストが消えるまで待つ（スマホでは下の行に重なるので、押す前に） */
  const noToasts = () =>
    page
      .waitForFunction(
        () => document.querySelectorAll('.toast:not(.note)').length === 0,
        undefined,
        {
          timeout: 8000,
        },
      )
      .catch(() => {});
  const undoToast = (text) =>
    page.locator('.toast:not(.note)', { hasText: text }).locator('button', { hasText: '元に戻す' });
  const menu = async (item) => {
    await page.click(`${P} button[aria-label="ポジションの操作"]`);
    await page.click(`[role="menuitem"]:has-text("${item}")`);
    await page.waitForTimeout(120);
  };
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const loafs = [];
  const start = await saved();

  // (a) 1 本目の枚数の ＋ → 2、− → 1、qty 1 で − が disabled
  {
    const st = `${leg(1)} .stepper`;
    await page.click(`${st} > button:last-child`);
    const a = (await saved()).legs[0]?.leg.qty;
    const shown = await page.textContent(`${st} .val b`);
    await page.click(`${st} > button:first-child`);
    const b = (await saved()).legs[0]?.leg.qty;
    const dis = await page.isDisabled(`${st} > button:first-child`);
    check(
      `#84 AC-11(a) ${tag} 枚数 ＋ → ${a}（表示 ${shown}）、− → ${b}、1 で − が disabled`,
      a === 2 && shown === '2' && b === 1 && dis,
    );
  }

  // (b) ⇄ → side が反対・entry は同じ・トーストの文（もう一度押して戻す）
  {
    const before = (await saved()).legs[0]?.leg;
    await page.click(`${leg(1)} button[data-op="flip"]`);
    const after = (await saved()).legs[0]?.leg;
    const texts = await toastText();
    const want = '買 P 63,500 に切替（建値は保持）';
    const btn = await page
      .locator('.toast:not(.note)', { hasText: want })
      .locator('button')
      .count();
    check(
      `#84 AC-11(b) ${tag} ⇄ → ${before?.side} → ${after?.side}・建値 ${after?.entry} のまま・トースト（[元に戻す] なし）`,
      before?.side === 'sell' &&
        after?.side === 'buy' &&
        after?.entry === before?.entry &&
        texts.includes(want) &&
        btn === 0,
      texts.join(' / '),
    );
    await page.click(`${leg(1)} button[data-op="flip"]`);
    const back = (await saved()).legs[0]?.leg;
    check(`#84 AC-11(b) ${tag} もう一度 ⇄ で売りに戻る`, back?.side === 'sell');
  }

  // (c) × → 足 1 本・[元に戻す]・確認ダイアログなし → [元に戻す] で保存の legs が消す前と同じ
  {
    await noToasts();
    const before = (await saved()).legs;
    await page.click(`${leg(1)} button[data-op="remove"]`);
    const dlg = await page.locator('dialog[open]').count();
    const mid = (await saved()).legs;
    const rows = await rowCount();
    const u = undoToast('を消した');
    const hasUndo = (await u.count()) === 1;
    if (hasUndo) await u.click();
    const back = (await saved()).legs;
    check(
      `#84 AC-11(c) ${tag} × → 足 ${mid.length} 本（行 ${rows}）・確認ダイアログ ${dlg} 個・[元に戻す] → 足 ${back.length} 本で消す前と同じ`,
      mid.length === 1 && rows === 1 && dlg === 0 && hasUndo && same(back, before),
    );
  }

  // (d) ⋯ > 全クリア → 足 0 本・空の状態 → [元に戻す] → 2 本が元の順
  {
    await noToasts();
    const before = (await saved()).legs;
    await menu('全クリア');
    const mid = (await saved()).legs;
    const empty = await page.isVisible(`${P} .empty-state`);
    // #111 AC-6: 全クリアの直後の舞台の格子（スマホはシート full = 舞台がミニなので格子なしのまま）
    const grid = await page.evaluate(() => ({
      lines: document.querySelectorAll('section.stage .chart > svg .grid line').length,
      mini: !!document.querySelector('section.stage .chart.mini'),
    }));
    check(
      phoneSize
        ? `#111 AC-6 ${tag} 全クリア直後の舞台はミニ（格子 ${grid.lines} 本）`
        : `#111 AC-6 ${tag} 全クリア直後の格子 ${grid.lines} 本`,
      phoneSize ? grid.mini && grid.lines === 0 : !grid.mini && grid.lines >= 4,
    );
    const u = undoToast('足 2 本を消した');
    const hasUndo = (await u.count()) === 1;
    if (hasUndo) await u.click();
    const back = (await saved()).legs;
    check(
      `#84 AC-11(d) ${tag} 全クリア → 足 ${mid.length} 本・空の状態 ${empty} → [元に戻す] → ${back.length} 本が元の順`,
      mid.length === 0 && empty && hasUndo && same(back, before),
    );
  }

  // (e) 詳細: 建値 700 → entry 700、枚数 0 → aria-invalid で保存が変わらない、IV 25 → iv 0.25・印「IV 編集」
  {
    await noToasts();
    const main = page.locator(`${leg(1)} .leg-main`);
    await main.click();
    const expanded = await main.getAttribute('aria-expanded');
    const detail = await page.isVisible(`${leg(1)} .leg-detail`);
    check(
      `#84 AC-11(e) ${tag} 行を押す → aria-expanded=${expanded}・詳細`,
      expanded === 'true' && detail,
    );
    const entry = page.locator(`${leg(1)} input[aria-label$=" の建値"]`);
    await entry.fill('700');
    await entry.press('Enter');
    const e1 = (await saved()).legs[0]?.leg;
    check(`#84 AC-11(e) ${tag} 建値 700 Enter → 保存の entry ${e1?.entry}`, e1?.entry === 700);
    const qty = page.locator(`${leg(1)} input[aria-label$=" の枚数を入力"]`);
    await qty.fill('0');
    await qty.press('Enter');
    const inv = await qty.getAttribute('aria-invalid');
    const alert = await page.locator(`${leg(1)} .leg-detail [role="alert"]`).count();
    const q1 = (await saved()).legs[0]?.leg.qty;
    check(
      `#84 AC-11(e) ${tag} 枚数 0 → aria-invalid=${inv}・文言 ${alert} 件・保存の qty ${q1} のまま`,
      inv === 'true' && alert === 1 && q1 === 1,
    );
    const iv = page.locator(`${leg(1)} input[aria-label$=" の IV（%）"]`);
    await iv.fill('25');
    await iv.press('Enter');
    const i1 = (await saved()).legs[0]?.leg;
    const badge = await page.locator(`${leg(1)} .leg-sub .tag`, { hasText: 'IV 編集' }).count();
    check(
      `#84 AC-11(e) ${tag} IV 25 → 保存の iv ${i1?.iv}・印「IV 編集」`,
      i1?.iv === 0.25 && badge === 1,
    );
    await main.click();
  }

  // (f) 足の追加ダイアログ: 先物（既定のまま）→ 足 3 本・閉じる・トースト。枚数 0 → 開いたまま alert。Esc → ⋯ にフォーカス。
  // 手入力 OP（板に無い限月）→ 足が増えて印「手入力」
  {
    await noToasts();
    await menu('足を追加…');
    const open1 = await page.locator('dialog[open]').count();
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForTimeout(150);
    const s1 = (await saved()).legs;
    const closed = (await page.locator('dialog[open]').count()) === 0;
    const texts = await toastText();
    const last = s1[s1.length - 1]?.leg;
    check(
      `#84 AC-11(f) ${tag} 足を追加…（先物の既定）→ 足 ${s1.length} 本（${last?.product}）・閉じる・トースト`,
      open1 === 1 &&
        s1.length === 3 &&
        last?.product === 'fut_mini' &&
        closed &&
        texts.some((t) => /^ミニ先物 \d{4}-\d{2} 買 ×1 を追加$/.test(t ?? '')),
      texts.join(' / '),
    );
    await menu('足を追加…');
    await page.fill('dialog[open] input[name="qty"]', '0');
    await page.click('dialog[open] button[type="submit"]');
    await page.waitForTimeout(120);
    const stillOpen = await page.locator('dialog[open]').count();
    const alert = (await page.textContent('dialog[open] [role="alert"]').catch(() => null)) ?? '';
    const s2 = (await saved()).legs;
    check(
      `#84 AC-11(f) ${tag} 枚数 0 で [追加] → 開いたまま「${alert}」・足 ${s2.length} 本のまま`,
      stillOpen === 1 && alert === '枚数は 1 以上の整数' && s2.length === 3,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const focus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      `#84 AC-11(f) ${tag} Esc → 閉じて ⋯ にフォーカス（${focus}）`,
      (await page.locator('dialog[open]').count()) === 0 && focus === 'ポジションの操作',
    );
    await menu('足を追加…');
    await page.click('dialog[open] .seg button:has-text("OP（手入力）")');
    await page.fill('dialog[open] input[name="expiry"]', '2027-06');
    await page.fill('dialog[open] input[name="k"]', '66000');
    await page.fill('dialog[open] input[name="entry"]', '300');
    await page.fill('dialog[open] input[name="iv"]', '30');
    await page.press('dialog[open] input[name="iv"]', 'Enter');
    await page.waitForTimeout(150);
    const s3 = (await saved()).legs;
    const m = s3[s3.length - 1];
    const badge = await page
      .locator(`${P} li.leg:last-child .leg-sub .tag`, { hasText: '手入力' })
      .count();
    check(
      `#84 AC-11(f) ${tag} 手入力 OP（2027-06 P 66,000）を Enter → 足 ${s3.length} 本・印「手入力」`,
      s3.length === 4 &&
        m?.leg.expiry === '2027-06' &&
        (m?.marks ?? []).includes('no_board') &&
        badge === 1 &&
        (await page.locator('dialog[open]').count()) === 0,
    );
  }

  // (g) ヘッジ（#274 で常設は 1 行、詳細はダイアログ）: 行の [⋯] でダイアログ → 目標 Δ 1 → 保存の target 1・行と
  // ダイアログの 1 段目が変わる。押せる段の [追加] → 先物の足（枚数 = 段の枚数）。評価点「シナリオ時点」→ 保存の at・行の先頭
  {
    await noToasts();
    const row0 = await page.getAttribute(`${P} .hedge-row .txt`, 'title');
    await page.click(`${P} .hedge-row button[aria-haspopup="dialog"]`);
    await page.waitForSelector('dialog[open] input[name="target"]');
    await page.fill('dialog[open] input[name="target"]', '1');
    const h1 = (await saved()).hedge;
    await page.waitForTimeout(120);
    const head1 = await page.textContent('dialog[open] .hedge .hl.head');
    const row1 = await page.getAttribute(`${P} .hedge-row .txt`, 'title');
    check(
      `#84 AC-11(g) ${tag} 目標 Δ 1 → 保存の target ${h1?.target}・1 段目「${head1}」・行「${row1}」`,
      h1?.target === 1 &&
        (head1 ?? '').endsWith('→ 目標 1') &&
        row1 !== row0 &&
        (row1 ?? '').includes('→ 目標 1 · ミニ'),
    );
    const line = page.locator('dialog[open] .hedge .hl.line', {
      has: page.locator('button:not([disabled])'),
    });
    const n = await line.count();
    const lotsText = n > 0 ? ((await line.first().locator('.txt b').textContent()) ?? '') : '';
    const lots = Math.abs(Number(lotsText.replace(/[^\d−-]/g, '').replace('−', '-')));
    const before = (await saved()).legs;
    if (n > 0) await line.first().locator('button').click();
    const after = (await saved()).legs;
    const added = after[after.length - 1];
    check(
      `#84 AC-11(g) ${tag} ヘッジの [追加]（${lotsText}）→ 足 ${before.length} → ${after.length} 本・枚数 ${added?.leg.qty}`,
      n > 0 &&
        after.length === before.length + 1 &&
        added?.leg.kind === 'future' &&
        added.leg.qty === lots,
    );
    await page.click('dialog[open] .hedge .seg button[aria-label="シナリオ時点"]');
    const h2 = (await saved()).hedge;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    const row2 = await page.getAttribute(`${P} .hedge-row .txt`, 'title');
    check(
      `#84 AC-11(g) ${tag} 評価点「シナリオ時点」→ 保存の at ${h2?.at}・行「${row2}」`,
      h2?.at === 'scenario' && (row2 ?? '').startsWith('シナリオ時点 Δ'),
    );
  }

  // AC-12: 枚数の ＋ 20 回・⇄ 10 回・× と [元に戻す] 5 回の間の Long Animation Frame
  {
    await noToasts();
    const st = `${leg(1)} .stepper > button:last-child`;
    const q0 = (await saved()).legs[0]?.leg.qty ?? 0;
    const m1 = await loafMark();
    for (let i = 0; i < 20; i++) await page.click(st, { delay: 0 });
    const lfQty = await loafSince(m1);
    const q1 = (await saved()).legs[0]?.leg.qty ?? 0;
    check(`#84 AC-12 ${tag} 枚数の ＋ 20 回 → qty ${q0} → ${q1}`, q1 === q0 + 20);
    const m2 = await loafMark();
    for (let i = 0; i < 10; i++) await page.click(`${leg(1)} button[data-op="flip"]`);
    const lfFlip = await loafSince(m2);
    await noToasts();
    const before = (await saved()).legs;
    const m3 = await loafMark();
    for (let i = 0; i < 5; i++) {
      await page.click(`${leg(1)} button[data-op="remove"]`);
      await undoToast('を消した').first().click();
    }
    const lfDel = await loafSince(m3);
    const after = (await saved()).legs;
    check(`#84 AC-12 ${tag} × と [元に戻す] 5 回の後も足は同じ`, same(after, before));
    loafs.push(`枚数 ${lfQty}`, `⇄ ${lfFlip}`, `×・戻す ${lfDel}`);
    for (const [name, v] of [
      ['枚数の ＋ 20 回', lfQty],
      ['⇄ 10 回', lfFlip],
      ['× と [元に戻す] 5 回', lfDel],
    ]) {
      check(
        `#84 AC-12 ${tag} ${name}で長いフレーム 0 件`,
        loafOk && v === 0,
        loafOk ? `${v} 件` : '未対応',
      );
    }
    console.log(`      ${tag} 作業台の Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
  }

  // (h) 舞台の足マーカーのタップ → ポジションのパネルが開き、その足の行が data-selected で .panel-body の見える範囲にある
  {
    await noToasts();
    if (phoneSize) await setShell(page, 'board', 'hidden');
    await page.waitForTimeout(150);
    const pick = await page.evaluate(() => {
      const ms = [...document.querySelectorAll('.legmark[data-leg-id]')].reverse();
      for (const m of ms) {
        const b = m.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (b.width > 0 && hit && (hit === m || m.contains(hit)))
          return { id: m.getAttribute('data-leg-id'), x, y };
      }
      return null;
    });
    if (pick) {
      await page.mouse.click(pick.x, pick.y);
      await page.waitForTimeout(200);
    }
    const st = await page.evaluate((id) => {
      const l = document.querySelector('.layout');
      const body = document.querySelector('section.positions .panel-body');
      const li = document.querySelector(`section.positions li.leg[data-leg-id="${id}"]`);
      const vb = body?.getBoundingClientRect();
      const rb = li?.getBoundingClientRect();
      return {
        panel: l?.getAttribute('data-panel'),
        selected: li?.hasAttribute('data-selected') ?? false,
        inView:
          !!vb && !!rb && rb.height > 0 && rb.top >= vb.top - 0.5 && rb.bottom <= vb.bottom + 0.5,
      };
    }, pick?.id ?? '');
    check(
      `#84 AC-11(h) ${tag} 足マーカー（id ${pick?.id}）のタップ → ポジションのパネル・行が data-selected で見える範囲`,
      pick !== null && st.panel === 'positions' && st.selected && st.inView,
      JSON.stringify(st),
    );
  }
  // 最初の保存と比べて足が増えている（手順の後始末は不要。コンテキストごと捨てる）
  if (start.legs.length !== 2) check(`#84 ${tag} 始めの足は 2 本`, false, `${start.legs.length}`);
  await ctx.close();
}

// ---- 指標の手順（#86 AC-10・AC-11）
/** 数値のトークン（要素ごとに取り出して連ねる。見出しの末尾と値の先頭の数字をつなげない） */
const METRIC_TOKEN = '[+−]?[0-9][0-9,.]*|[+−]∞|なし|—';

/** #87 AC-11(d)(e) の時刻（旧画面の header.header を控えたときと同じ固定の時刻） */
const HEADER_FIXED_TIME = '2026-10-13T21:45:00+09:00';

async function metricsFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ex = phoneSize ? null : loadExpect();
  const old = ex?.data?.metrics?.[tag] ?? null;
  if (ex && !old)
    check(`#86 AC-10 ${tag} 控えた旧画面の指標がある`, false, ex.why || `${tag} が無い`);
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'metrics', 'peek');
    check(`#86 ${tag} ドックで「指標」を開く（peek）`, ok);
  }
  const M = 'section.metrics';
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  /** 読み取りの指定日の損益（#274 でタイル 5 = 指定日 + シナリオを外した。同じ値）・テールの SQ の列・指定日の列（5 個ずつ） */
  const snap = () =>
    page.evaluate((m) => {
      const main = (el) => el?.querySelector(':scope > span')?.textContent ?? null;
      const col = (i) =>
        [...document.querySelectorAll(`${m} table.tail:not(.margin-tail) tbody tr`)].map((tr) => {
          const td = tr.querySelectorAll('td')[i];
          return td
            ? `${main(td.querySelector('.txt'))} ${td.querySelector('.txt small')?.textContent}`
            : null;
        });
      return {
        t5: main(document.querySelector('.ro[data-ro="date"] .v')),
        sq: col(0),
        sc: col(1),
      };
    }, M);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // AC-10: 旧画面から控えた値と同じ（1440×900。scripts/uiCheck.expect.json）
  if (old) {
    const toggle = page.locator(`${M} .mx-toggle`);
    await toggle.click();
    await page.waitForTimeout(150);
    const now = await page.evaluate(
      ({ m, re }) => {
        // 旧画面に無い証拠金の群（#131）より前の行だけ
        const kvs = [];
        for (const el of document.querySelector(`${m} .kv-grid`)?.children ?? []) {
          if (el.classList.contains('grp') && el.textContent === '証拠金（概算・保守寄り）') break;
          if (el.classList.contains('k') || el.classList.contains('v')) kvs.push(el);
        }
        const tokens = kvs.flatMap((el) => el.textContent.match(new RegExp(re, 'g')) ?? []);
        const pair = (el) => [
          el?.querySelector(':scope > span')?.textContent.trim() ?? '',
          el?.querySelector('small')?.textContent.trim() ?? '',
        ];
        const tail = [
          ...document.querySelectorAll(`${m} table.tail:not(.margin-tail) tbody tr`),
        ].flatMap((tr) => [
          ...pair(tr.querySelector('th')),
          ...[...tr.querySelectorAll('td')].flatMap((td) => pair(td.querySelector('.txt'))),
        ]);
        // 内訳の「指定日 + シナリオ」の群の「損益」の行（#274 でタイル 5 を外した。値は単位付き）
        const kEl = [...(document.querySelector(`${m} .kv-grid`)?.children ?? [])].find(
          (el) => el.classList.contains('k') && el.textContent === '損益',
        );
        const t5 = kEl?.nextElementSibling?.textContent?.replace(/ (千円|円)$/, '');
        const ro = document.querySelector('.ro[data-ro="date"] .v > span')?.textContent;
        return { tokens, tail, t5, ro };
      },
      { m: M, re: METRIC_TOKEN },
    );
    // 控えの作業（タブ A）はシナリオ ΔX −400 円・β 1 なので、シナリオ点の損益（index 8）と合計グリーク（index 10〜12・
    // 14・15 = Δ・ミニ・Γ・Θ・V）は β の値で変わる。#306 で β を実測の形の倍率にしたので、この 6 個は比べない
    // （控えは #91 で削除した旧画面から取ったもので作り直せない。シナリオ点の σ・損益・グリークは model のテスト
    // （tests/model/scenario.test.ts・betaShape.test.ts・pnl.test.ts）で確かめている）。ほかの 17 個（index 13 = Γ の単位「/ 100 円」の 100 を含む）は β が効かない
    const BETA_TOKENS = new Set([8, 10, 11, 12, 14, 15]);
    const noBeta = (a) => a.filter((_, i) => !BETA_TOKENS.has(i));
    const nowTok = noBeta(now.tokens);
    const oldTok = noBeta(old.tokens);
    check(
      `#86 AC-10(a) ${tag} 内訳のトークン列が旧画面の dl.metrics-list（控え）と一致（β の効くシナリオ点の損益・グリークの 6 個を除く ${nowTok.length} 個。#306）`,
      now.tokens.length === old.tokens.length && nowTok.length > 15 && same(nowTok, oldTok),
      same(nowTok, oldTok) ? '' : `新 ${now.tokens.join(' ')} / 旧 ${old.tokens.join(' ')}`,
    );
    // テール表は 1 行 6 個（行の見出し 2 個・SQ の列 2 個・指定日の列 2 個）。比べるのは β の効かない行の見出しと満期（SQ）の
    // 列だけ（5 行 × 4 個 = 20 個）。指定日の列は比べない: #306 で β を実測の形の倍率にしたので指定日の値が変わり、控えは
    // 旧画面（#91 で削除）から取ったもので作り直せない。指定日の値は model のテスト（tests/model/pnl.test.ts の 6.1 の
    // ワイヤー・テール表の手計算との一致）で確かめている
    const sqOnly = (a) => a.filter((_, i) => i % 6 < 4);
    const nowSq = sqOnly(now.tail);
    const oldSq = sqOnly(old.tail);
    check(
      `#86 AC-10(b) ${tag} テール表の行の見出しと SQ の列の 20 個が旧画面（控え）と一致（指定日の列は β の形が変わったので比べない。#306）`,
      now.tail.length === 30 && same(nowSq, oldSq),
      same(nowSq, oldSq)
        ? nowSq.slice(0, 4).join(' ')
        : `新 ${nowSq.join(' ')} / 旧 ${oldSq.join(' ')}`,
    );
    check(
      `#86 AC-10(c) ${tag} 内訳の指定日 + シナリオの損益 = 読み取りの指定日の損益（#274 でタイル 5 を外した）`,
      !!now.t5 && now.t5 === now.ro,
      `${now.t5} / ${now.ro}`,
    );
    await toggle.click();
    await page.waitForTimeout(100);
    check(
      `#86 ${tag} 内訳を閉じる（1 回で aria-expanded = false・行が消える）`,
      (await toggle.getAttribute('aria-expanded')) === 'false' &&
        (await page.locator(`${M} .kv-grid`).count()) === 0,
    );
  } else {
    // スマホ: 内訳の開閉が 1 タップで効く
    const toggle = page.locator(`${M} .mx-toggle`);
    await toggle.click();
    await page.waitForTimeout(150);
    const opened =
      (await toggle.getAttribute('aria-expanded')) === 'true' &&
      (await page.locator(`${M} .kv-grid > .v`).count()) > 0;
    await toggle.click();
    await page.waitForTimeout(100);
    const closed = (await toggle.getAttribute('aria-expanded')) === 'false';
    check(`#86 ${tag} 内訳の開閉（開く → 閉じる）`, opened && closed);
  }

  // AC-11 (a)(b): Δσ ＋ 1 回で読み取りの指定日の損益と指定日の列が変わり SQ の列は同じ、− 1 回で元に戻る
  // PC はシナリオのステッパー、スマホは指標のシートとシナリオが同時に見えないので舞台の IV レールの ↑ / ↓（同じ ±0.5）
  const dsPlus = 'section.scenario .stepper[data-name="dSigma"] > button:last-child';
  const dsMinus = 'section.scenario .stepper[data-name="dSigma"] > button:first-child';
  const up = async () => {
    if (phoneSize) {
      await page.focus('.ivrail');
      await page.keyboard.press('ArrowUp');
    } else await page.click(dsPlus);
  };
  const down = async () => {
    if (phoneSize) {
      await page.focus('.ivrail');
      await page.keyboard.press('ArrowDown');
    } else await page.click(dsMinus);
  };
  const how = phoneSize ? 'IV レールの ↑ / ↓' : 'Δσ の ＋ / −';
  {
    const a = await snap();
    await up();
    await page.waitForTimeout(150);
    const b = await snap();
    check(
      `#86 AC-11(a) ${tag} ${how}: ＋ 1 回で読み取りの指定日の損益と指定日の列が変わり SQ の列は同じ`,
      !!a.t5 && a.t5 !== b.t5 && !same(a.sc, b.sc) && same(a.sq, b.sq) && a.sq.length === 5,
      `指定日の損益 ${a.t5} → ${b.t5}・指定日 ${a.sc[0]} → ${b.sc[0]}`,
    );
    await down();
    await page.waitForTimeout(150);
    const c = await snap();
    check(`#86 AC-11(b) ${tag} ${how}: − 1 回で元の値に戻る`, same(a, c), `指定日の損益 ${c.t5}`);
  }

  // AC-11 (c): ＋ の 20 回の連打・舞台のハンドルのドラッグの間の Long Animation Frame（50ms 超）
  {
    const mark = await loafMark();
    if (phoneSize) await page.focus('.ivrail');
    for (let i = 0; i < 20; i++) {
      if (phoneSize) await page.keyboard.press('ArrowUp');
      else await page.click(dsPlus);
      await page.waitForTimeout(16);
    }
    const lfPlus = await loafSince(mark);
    const hb = await page.locator('.chart .handle-hit').first().boundingBox();
    let lfDrag = -1;
    if (hb) {
      const x = hb.x + hb.width / 2;
      const y = hb.y + hb.height / 2;
      const mark2 = await loafMark();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y, { steps: 30 });
      await page.mouse.up();
      lfDrag = await loafSince(mark2);
    }
    for (const [name, n] of [
      [`${phoneSize ? 'IV レールの ↑' : 'Δσ の ＋'} 20 回の連打`, lfPlus],
      ['ハンドルのドラッグ（30 回の move）', lfDrag],
    ]) {
      check(
        `#86 AC-11(c) ${tag} 指標が見えている状態で${name}の長いフレーム 0 件`,
        loafOk && n === 0,
        loafOk ? `${n} 件` : '未対応',
      );
    }
    console.log(
      `      ${tag} 指標の Long Animation Frame（50ms 超）: 連打 ${lfPlus}・ハンドル ${lfDrag}`,
    );
  }
  await ctx.close();
}

// ---- 副題の全文のポップオーバーの手順（#107 AC-4）
/** 開いているポップオーバーの数（#274 で読み取りの全文をやめた。タイル・ⓘ など全部） */
const openPops = (page) =>
  page.evaluate(() => document.querySelectorAll('.popover:not([hidden])').length);

/** そのボタンの全文の行・見た目の値・見出しの点の印（#164）・矩形（#107 AC-4・#161 で共用） */
const popInfoOf = (page, btnSel, hostSel) =>
  page.evaluate(
    ({ btnSel, hostSel }) => {
      const btn = document.querySelector(btnSel);
      const wrap = btn?.closest('.pop-wrap');
      const pop = wrap?.querySelector('.popover');
      if (!btn || !pop) return null;
      const rows = [];
      const cells = [...pop.querySelectorAll('.full > span')];
      for (let i = 0; i + 1 < cells.length; i += 2) {
        rows.push([cells[i].textContent, cells[i + 1].textContent]);
      }
      const v = btn.querySelector('.v');
      const vText = [
        v?.querySelector(':scope > span')?.textContent ?? '',
        v?.querySelector('small')?.textContent ?? '',
      ]
        .filter(Boolean)
        .join(' ');
      const r = pop.getBoundingClientRect();
      const h = btn.closest(hostSel)?.getBoundingClientRect();
      const inWin =
        r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      const inHost =
        !!h &&
        r.left >= h.left - 0.5 &&
        r.top >= h.top - 0.5 &&
        r.right <= h.right + 0.5 &&
        r.bottom <= h.bottom + 0.5;
      return {
        expanded: btn.getAttribute('aria-expanded'),
        hidden: pop.hidden,
        up: pop.classList.contains('up'),
        rows,
        k: btn.querySelector('.k')?.textContent ?? '',
        at: btn.querySelector('.at')?.textContent ?? null,
        vText,
        inWin,
        inHost,
        rect: `${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}`,
      };
    },
    { btnSel, hostSel },
  );

async function subtitleFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: buyTwo });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) {
    const ok = await setShell(page, 'metrics', 'peek');
    check(`#107 ${tag} ドックで「指標」を開く（peek）`, ok);
  }
  const M = 'section.metrics';
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = await page.evaluate(() => window.__loaf.length);

  // 比較の正: 内訳を開いた行（見出し → 値）
  const toggle = page.locator(`${M} .mx-toggle`);
  await toggle.click();
  await page.waitForTimeout(150);
  const kv = await page.evaluate(
    (m) =>
      [...document.querySelectorAll(`${m} .kv-grid > .k`)].map((k) => [
        k.textContent,
        k.nextElementSibling?.textContent ?? '',
      ]),
    M,
  );
  await toggle.click();
  await page.waitForTimeout(100);

  const popInfo = (btnSel, hostSel) => popInfoOf(page, btnSel, hostSel);

  // (a)(f) 各タイルをタップ → 開く・中身が全文（内訳・見た目の値と一致）・窓と .panel-body の中・縦・横 0px
  // #274 でタイルは 6 枚（指定日 + シナリオ・合計グリークは読み取りの帯と内訳だけ）
  const keys = ['maxProfit', 'maxLoss', 'bep', 'premium', 'margin', 'room'];
  const tileBtn = (k) => `${M} .tile[data-tile="${k}"] .tile-btn`;
  const kvHas = (v) => kv.some(([, bv]) => bv.includes(v));
  /** #164: 証拠金・余力のタイルの見出しの点の印と全文のシナリオ点の行 */
  const pointMarks = [];
  for (const k of keys) {
    await page.click(tileBtn(k));
    await page.waitForTimeout(120);
    const i = await popInfo(tileBtn(k), '.panel-body');
    const m = await measure(page);
    if (!i) {
      check(`#107 AC-4(a) ${tag} タイル ${k} のポップオーバー`, false, '無い');
      continue;
    }
    const first = i.rows[0] ?? ['', ''];
    let content =
      i.rows.length > 0 &&
      i.rows.every(([rk, rv]) => rv !== '' && (rk === 'X' || kvHas(rv))) &&
      first[0].startsWith(i.k) &&
      first[1] === i.vText;
    if (k === 'premium') {
      const fee = kv.find(([bk]) => bk === '手数料の合計');
      content =
        content && !!fee && i.rows.some(([rk, rv]) => rk === '手数料の合計' && rv === fee[1]);
    }
    check(
      `#107 AC-4(a) ${tag} タイル ${k} をタップ → 全文（${i.rows.length} 行）が表示モデルの全文と一致`,
      i.expanded === 'true' && !i.hidden && content,
      i.rows.map((r) => r.join(' ')).join(' / '),
    );
    check(
      `#107 AC-4(f) ${tag} タイル ${k} の全文が窓と .panel-body の中・ページの縦・横 0px`,
      i.inWin && i.inHost && m.v === 0 && m.h === 0,
      `${i.rect} 縦 ${m.v} 横 ${m.h}`,
    );
    if (k === 'margin' || k === 'room') {
      pointMarks.push({
        k,
        ok: (i.at ?? '').startsWith('· ') && i.rows.some(([rk]) => rk === 'シナリオ点'),
        detail: `${k}「${i.at}」${i.rows.map((r) => r.join(' ')).join(' / ')}`,
      });
    } else if (i.at !== null) {
      pointMarks.push({ k, ok: false, detail: `${k} に点の印「${i.at}」` });
    }
    // 開いた全文は下のタイルに重なる（押しても閉じない）ので Esc で閉じて次へ
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  check(
    `#164 ${tag} 証拠金・余力のタイルの見出しに点の印、全文にシナリオ点の行`,
    pointMarks.length === 2 && pointMarks.every((x) => x.ok),
    pointMarks.map((x) => x.detail).join('・'),
  );
  // (b) Esc で閉じてそのタイルのボタンへフォーカス
  {
    const k = 'premium';
    await page.click(tileBtn(k));
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const r = await page.evaluate(
      (sel) => ({
        expanded: document.querySelector(sel)?.getAttribute('aria-expanded'),
        focus: document.activeElement === document.querySelector(sel),
      }),
      tileBtn(k),
    );
    check(
      `#107 AC-4(b) ${tag} Esc で閉じてタイルのボタンへフォーカス`,
      r.expanded === 'false' && r.focus,
    );
  }
  // (c) 外側（パネルの見出し）のタップで閉じる
  {
    await page.click(tileBtn('maxLoss'));
    await page.waitForTimeout(100);
    const before = await openPops(page);
    await page.click(`${M} .panel-head h2`);
    await page.waitForTimeout(100);
    check(`#107 AC-4(c) ${tag} 外側のタップで閉じる`, before === 1 && (await openPops(page)) === 0);
  }
  // (d) 別のタイルのタップで前のものが閉じる（同時に 1 つ）
  {
    await page.click(tileBtn('maxProfit'));
    await page.waitForTimeout(100);
    // 開いた全文に重ならない右の列のタイル（#274 で 6 枚 = 旧の greeks の位置は room）
    await page.click(tileBtn('room'));
    await page.waitForTimeout(100);
    const r = await page.evaluate(
      ({ a, b }) => [
        document.querySelector(a)?.getAttribute('aria-expanded'),
        document.querySelector(b)?.getAttribute('aria-expanded'),
      ],
      { a: tileBtn('maxProfit'), b: tileBtn('room') },
    );
    check(
      `#107 AC-4(d) ${tag} 別のタイルのタップで前のものが閉じる（開いているのは 1 つ）`,
      r[0] === 'false' && r[1] === 'true' && (await openPops(page)) === 1,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  // (e) キーボード: パネルの ⓘ から Tab → 最初のタイル、Enter で開く、Space で閉じる
  {
    await page.focus(`${M} .panel-head .hintbtn`);
    await page.keyboard.press('Tab');
    const onTile = await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      tileBtn('maxProfit'),
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const opened = (await page.getAttribute(tileBtn('maxProfit'), 'aria-expanded')) === 'true';
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    const closed = (await page.getAttribute(tileBtn('maxProfit'), 'aria-expanded')) === 'false';
    check(
      `#107 AC-4(e) ${tag} Tab → タイル、Enter で開く、Space で閉じる`,
      onTile && opened && closed,
    );
  }
  // (g) 読み取りは押せない（#274 で全文のポップオーバーをやめた）: ボタン 0 個、損益を押しても何も開かない
  {
    const n = await page.locator('.readout button').count();
    await page.click('.readout .ro[data-ro="date"] .v');
    await page.waitForTimeout(120);
    const m = await measure(page);
    check(
      `#274 ${tag} 読み取りにボタンが無く、損益を押しても吹き出しが開かない・縦・横 0px`,
      n === 0 && (await openPops(page)) === 0 && m.v === 0 && m.h === 0,
      `ボタン ${n} 個`,
    );
  }
  // (h) 開閉の間の Long Animation Frame（50ms 超）
  {
    // 検査の measure（ページ全体の要素を走査する。#85 で板の 322 行が入ると 50ms を超えうる）のフレームは除く
    const n = await page.evaluate((i) => {
      const self = window.__checkRanges ?? [];
      return window.__loaf
        .map((d, j) => [d, window.__loafAt[j]])
        .slice(i)
        .filter(([d, at]) => d > 50 && !self.some(([a, b]) => at[0] < b && a < at[1])).length;
    }, loafMark);
    check(
      `#107 AC-4(h) ${tag} 全文の開閉の間の長いフレーム 0 件`,
      loafOk && n === 0,
      loafOk ? `${n} 件` : '未対応',
    );
  }
  await ctx.close();
}

/**
 * #161: 360x780 の「指標」peek（.panel-body が最も低い幅）で、必要証拠金・余力のタイルの全文が窓と .panel-body の中・
 * ページの縦・横 0px（判定は #107 AC-4(f) と同じ）。足は売り 5 枚（最悪の点の行あり）、シナリオは 4 つとも 0 でない
 * （シナリオ点の行が最も多い = 全文が最も長い）
 */
async function marginFull360() {
  const vp = { width: 360, height: 780 };
  const tag = `${vp.width}x${vp.height}`;
  const sells = JSON.parse(sellFiveYen);
  const t0 = sells.tabs[0];
  sells.tabs[0] = {
    ...t0,
    position: { ...t0.position, scenario: { ...t0.position.scenario, skew: 1 } },
  };
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: JSON.stringify(sells) });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  check(`#161 ${tag} ドックで「指標」を開く（peek）`, await setShell(page, 'metrics', 'peek'));
  const M = 'section.metrics';
  const res = [];
  for (const k of ['margin', 'room']) {
    const sel = `${M} .tile[data-tile="${k}"] .tile-btn`;
    await page.click(sel);
    await page.waitForTimeout(120);
    const i = await popInfoOf(page, sel, '.panel-body');
    const m = await measure(page);
    res.push({
      ok: !!i && i.expanded === 'true' && i.inHost && i.inWin && m.v === 0 && m.h === 0,
      detail: i ? `${k} ${i.rows.length} 行 ${i.rect} 縦 ${m.v} 横 ${m.h}` : `${k} 無い`,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  check(
    `#161 ${tag} タイル margin / room の全文が窓と .panel-body の中`,
    res.length === 2 && res.every((r) => r.ok),
    res.map((r) => r.detail).join('・'),
  );
  // #136 レビュー指摘 5: 全文の末尾の [AI に聞く] も .panel-body の中で押せる。全文を 12 行（FULL_MAX_ROWS）にしても
  // 吹き出しが .panel-body に収まり（全文の中だけが縦にスクロール）、ボタンが見えて押せる。11 行以下は全文がスクロールしない
  const askIn = async (rows12) => {
    const sel = `${M} .tile[data-tile="margin"] .tile-btn`;
    await page.click(sel);
    await page.waitForTimeout(120);
    const r = await page.evaluate(
      ({ sel, rows12 }) => {
        const wrap = document.querySelector(sel)?.closest('.pop-wrap');
        const pop = wrap?.querySelector('.popover');
        const full = pop?.querySelector('.full');
        const ask = pop?.querySelector('button[data-ai-ask]');
        const host = wrap?.closest('.panel-body');
        if (!pop || !full || !ask || !host) return null;
        if (rows12) {
          // 足りない行を同じ形の span で足して 12 行にする（描き直しの前に測る）
          const n = full.querySelectorAll(':scope > span').length / 2;
          for (let i = n; i < 12; i++) {
            const k = document.createElement('span');
            k.className = 'fk';
            k.textContent = '検査の行';
            const v = document.createElement('span');
            v.className = 'fv';
            v.textContent = '−1,234 千円';
            full.append(k, v);
          }
        }
        const rows = full.querySelectorAll(':scope > span').length / 2;
        const within = (q, h) =>
          q.top >= h.top - 0.5 &&
          q.bottom <= h.bottom + 0.5 &&
          q.left >= h.left - 0.5 &&
          q.right <= h.right + 0.5;
        const p = pop.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        const a = ask.getBoundingClientRect();
        const cx = (a.left + a.right) / 2;
        const cy = (a.top + a.bottom) / 2;
        return {
          rows,
          popIn: within(p, h),
          askIn: within(a, h),
          hit: document.elementFromPoint(cx, cy)?.closest('button') === ask,
          scrolls: full.scrollHeight > full.clientHeight + 1,
          spare: Math.round(h.bottom - p.bottom),
        };
      },
      { sel, rows12 },
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    return r;
  };
  const r11 = await askIn(false);
  check(
    `#136 ${tag} 必要証拠金の全文（${r11?.rows ?? '—'} 行）と [AI に聞く] が .panel-body の中で押せる・全文はスクロールしない`,
    !!r11 && r11.popIn && r11.askIn && r11.hit && !r11.scrolls,
    r11 ? `下の余り ${r11.spare}px` : '無い',
  );
  const r12 = await askIn(true);
  check(
    `#136 ${tag} 全文 12 行でも吹き出しが .panel-body の中・[AI に聞く] が押せる（全文の中だけスクロール）`,
    !!r12 && r12.rows === 12 && r12.popIn && r12.askIn && r12.hit && r12.scrolls,
    r12 ? `${r12.rows} 行・下の余り ${r12.spare}px` : '無い',
  );
  await ctx.close();
}

// ---- 市場の手順（#85 AC-9・AC-10・AC-12）
/** ui/view/board.ts のジャンプの規則と data/ の正規化（Vite のモジュールランナーで読む。期待値を画面と別に求める） */
let boardRules = null;
async function rules() {
  if (boardRules) return boardRules;
  const { runnerImport } = await import('vite');
  const load = async (p) =>
    (await runnerImport(join(root, p), { configFile: false, root, logLevel: 'error' })).module;
  const data = await load('data/index.ts');
  const view = await load('ui/view/board.ts');
  boardRules = { normalizeChain: data.normalizeChain, ...view };
  return boardRules;
}
const fmtK = (k) => new Intl.NumberFormat('en-US').format(k);
const twoFrames = (page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))),
  );
const ACTIVE_WRAP = 'section.board .board-month:not(.inactive) .board-wrap:not(.side-hidden)';

async function marketFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const R = await rules();
  const chain = R.normalizeChain(board);
  if (phoneSize)
    check(`#85 ${tag} ドックで「板」を開く（peek）`, await setShell(page, 'board', 'peek'));
  const cols = await page.locator(`${ACTIVE_WRAP} thead th`).count();
  check(
    `#85 ${tag} 板の列の数 ${cols}`,
    cols === marketCols(vp.width),
    `${marketCols(vp.width)} のはず`,
  );

  const counts = () =>
    page.evaluate(() => ({
      rows: document.querySelectorAll('section.positions li.leg').length,
      marks: document.querySelectorAll('.chart .legmark').length,
      sel: document.querySelector('.chart .legmark.sel')?.getAttribute('data-leg-id') ?? null,
      dock:
        document.querySelector('.dock button[data-panel="positions"] .cnt')?.textContent ?? null,
      toast: [...document.querySelectorAll('.toast:not(.note) .txt')].map((t) => t.textContent),
      panel: document.querySelector('.layout')?.getAttribute('data-panel'),
      market: document.querySelector('.layout')?.getAttribute('data-market'),
      boardShown: (document.querySelector('section.board')?.getClientRects().length ?? 0) > 0,
    }));
  const pageScroll = () =>
    page.evaluate(() => ({
      doc: document.scrollingElement?.scrollTop ?? 0,
      body: document.body.scrollTop,
      sec: Math.round(document.querySelector('section.board')?.getBoundingClientRect().top ?? -1),
    }));
  const info = () =>
    page.evaluate((sel) => {
      const wrap = document.querySelector(sel);
      const atm = wrap?.querySelector('tr.atm')?.getAttribute('data-k');
      const foot = document.querySelector('section.board .board-foot > .atm')?.textContent ?? '';
      const month = document
        .querySelector('section.board .board-month:not(.inactive)')
        ?.getAttribute('data-month');
      const target = document.querySelector(
        'section.board [aria-label="対象の種別"] button[aria-pressed="true"]',
      )?.textContent;
      return {
        atm: atm ? Number(atm) : null,
        basis: /（([AB])）/.exec(foot)?.[1] ?? 'B',
        month,
        target,
      };
    }, ACTIVE_WRAP);
  /** その K の行を枠の中央に置いた（スクロールした）うえで、ボタンを押す */
  const centerRow = (k) =>
    page.evaluate(
      ({ sel, k }) => {
        const wrap = document.querySelector(sel);
        const tr = wrap?.querySelector(`tr[data-k="${k}"]`);
        if (!wrap || !tr) return false;
        const r = tr.getBoundingClientRect();
        const b = wrap.getBoundingClientRect();
        wrap.scrollTop += r.top - b.top - wrap.clientHeight / 2;
        return true;
      },
      { sel: ACTIVE_WRAP, k },
    );
  /** 行が枠の中央 ±1 行（端で中央に来られない行は枠の中に見えている） */
  const centered = (k) =>
    page.evaluate(
      ({ sel, k }) => {
        const wrap = document.querySelector(sel);
        const tr = wrap?.querySelector(`tr[data-k="${k}"]`);
        if (!wrap || !tr) return { ok: false, why: '行が無い' };
        const head = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const b = wrap.getBoundingClientRect();
        const r = tr.getBoundingClientRect();
        const mid = b.top + head + (wrap.clientHeight - head) / 2;
        const off = r.top + r.height / 2 - mid;
        const atEdge =
          wrap.scrollTop <= 0 || wrap.scrollTop >= wrap.scrollHeight - wrap.clientHeight - 1;
        const inside = r.top >= b.top + head - 1 && r.bottom <= b.top + wrap.clientHeight + 1;
        return {
          ok: Math.abs(off) <= r.height + 1 || (atEdge && inside),
          why: `中央からの差 ${Math.round(off)}px`,
          hit: tr.classList.contains('hit'),
        };
      },
      { sel: ACTIVE_WRAP, k },
    );

  const start = await counts();
  const i0 = await info();
  const month = chain.months.find((m) => m.id === i0.month);
  const atm = i0.atm;
  // (a) ATM − 2,000 の put の bid
  const k = (atm ?? 0) - 2000;
  if (phoneSize && i0.target !== 'put')
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
  await centerRow(k);
  const bidBtn = page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(k)} put bid "]`);
  const bidText = (await bidBtn.textContent())?.trim() ?? '';
  await bidBtn.click();
  await twoFrames(page);
  const a = await counts();
  const badgeA = await page
    .locator(`${ACTIVE_WRAP} tr[data-k="${k}"] .legbadge.sell`)
    .allTextContents();
  check(
    `#85 AC-9(a) ${tag} ATM−2,000（${fmtK(k)}）の put の bid: 次の描画で 行 +1・マーカー +1（その足が .sel）・バッジ 売1・トースト`,
    a.rows === start.rows + 1 &&
      a.marks === start.marks + 1 &&
      a.sel !== null &&
      a.sel !== start.sel &&
      badgeA.includes('売1') &&
      a.toast.includes(`売 P ${fmtK(k)} @${bidText} を追加`) &&
      (!phoneSize || Number(a.dock) === start.rows + 1),
    `行 ${start.rows}→${a.rows}・マーカー ${start.marks}→${a.marks}・選択 ${a.sel}・バッジ ${badgeA.join(' ')}・ドック ${a.dock}・${a.toast.join(' / ')}`,
  );
  check(
    `#85 AC-9(a) ${tag} 市場のパネルは開いたまま`,
    a.boardShown && (phoneSize ? a.panel === 'board' : a.market === 'board'),
    `${a.panel} / ${a.market}`,
  );
  // (b) 同じ K の call の ask（5 列は call に替えて）
  if (cols === 5) {
    await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
    await twoFrames(page);
  }
  await centerRow(k);
  const askBtn = page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(k)} call ask "]`);
  const askText = (await askBtn.textContent())?.trim() ?? '';
  await askBtn.click();
  await twoFrames(page);
  const b = await counts();
  check(
    `#85 AC-9(b) ${tag} 同じ K の call の ask で 買 C`,
    b.rows === a.rows + 1 &&
      b.marks === a.marks + 1 &&
      b.toast.includes(`買 C ${fmtK(k)} @${askText} を追加`),
    `行 ${b.rows}・${b.toast.join(' / ')}`,
  );
  // (c) [元に戻す]
  await page
    .locator('.toast:not(.note)', { hasText: `買 C ${fmtK(k)}` })
    .locator('button', { hasText: '元に戻す' })
    .click();
  await twoFrames(page);
  const c = await counts();
  const badgeC = await page.locator(`${ACTIVE_WRAP} tr[data-k="${k}"] .legbadge.buy`).count();
  check(
    `#85 AC-9(c) ${tag} トーストの [元に戻す] で足が消える（行・マーカー・バッジが元の数）`,
    c.rows === a.rows && c.marks === a.marks && badgeC === 0 && (!phoneSize || c.dock === a.dock),
    `行 ${c.rows}・マーカー ${c.marks}・買のバッジ ${badgeC}`,
  );
  if (cols === 5) {
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
    await twoFrames(page);
  }
  // レビュー S3: 同じ K に両側の売り・買い（バッジ 4 つ）でも P bid のボタンが押せる（バッジに当たらない）
  if (cols !== 5 && atm !== null) {
    await centerRow(atm);
    for (const lbl of ['call bid', 'call ask', 'put bid', 'put ask']) {
      await page.locator(`${ACTIVE_WRAP} button[aria-label^="${fmtK(atm)} ${lbl} "]`).click();
      await twoFrames(page);
    }
    const before = await counts();
    const geo = await page.evaluate(
      ({ sel, k }) => {
        const tr = document.querySelector(sel)?.querySelector(`tr[data-k="${k}"]`);
        const btn = [...(tr?.querySelectorAll('button') ?? [])].find((b) =>
          b.getAttribute('aria-label')?.includes(' put bid '),
        );
        const badges = [...(tr?.querySelectorAll('.legbadge') ?? [])].map((e) =>
          e.getBoundingClientRect(),
        );
        const b = btn?.getBoundingClientRect();
        if (!b) return null;
        // バッジと重なる所（無ければボタンの左下）を押す
        const over = badges.find((r) => r.right > b.left && r.left < b.right);
        const x = over
          ? (Math.max(over.left, b.left) + Math.min(over.right, b.right)) / 2
          : b.left + 3;
        const y = over ? (over.top + over.bottom) / 2 : b.bottom - 3;
        return { x, y, overlap: !!over, n: badges.length };
      },
      { sel: ACTIVE_WRAP, k: atm },
    );
    if (geo) await page.mouse.click(geo.x, geo.y);
    await twoFrames(page);
    const after = await counts();
    check(
      `#85 レビュー S3 ${tag} バッジ ${geo?.n ?? 0} つの行の P bid を${geo?.overlap ? 'バッジと重なる所で' : ''}押すと足が入る`,
      !!geo &&
        geo.n >= 4 &&
        after.rows === before.rows + 1 &&
        after.toast.some((t) => t?.startsWith(`売 P ${fmtK(atm)} `)),
      `${before.rows} → ${after.rows}`,
    );
  }

  // (d) [ATM]・OTM 20%・|Δ| .10: その K が枠の中央 ±1 行、強調 0.9 秒（±0.3）、ページ・シートは動かない
  if (month) {
    const rows = R.boardRows(chain, month);
    const x0 = R.referencePrice(month, i0.basis);
    const jumps = [
      ['ATM', 'button[aria-label="ATM へ"]', R.atmStrike(month, i0.basis)],
      ['OTM 20%', 'button[aria-label="OTM 20% へ"]', R.jumpToOtm(rows, 'put', x0, 0.2)],
      ['|Δ| .10', 'button[aria-label="|Δ| 0.10 へ"]', R.jumpToDelta(rows, 'put', 0.1)],
    ];
    for (const [name, sel, want] of jumps) {
      // いったん表の先頭へ（ジャンプで動くことを確かめる）
      await page.evaluate((s) => {
        const w = document.querySelector(s);
        if (w) w.scrollTop = 0;
      }, ACTIVE_WRAP);
      const before = await pageScroll();
      await page.click(`section.board .board-tools ${sel}`);
      const t0 = Date.now();
      await twoFrames(page);
      const at = await centered(want);
      let off = null;
      while (Date.now() - t0 < 2000) {
        const st = await centered(want);
        if (!st.hit) {
          off = Date.now() - t0;
          break;
        }
        await page.waitForTimeout(25);
      }
      const after = await pageScroll();
      check(
        `#85 AC-9(d) ${tag} ${name} → ${fmtK(want)}: 枠の中央 ±1 行・強調が付いて ${off ?? '—'}ms で外れる・ページ / シートは動かない`,
        at.ok &&
          at.hit &&
          off !== null &&
          off >= 600 &&
          off <= 1200 &&
          JSON.stringify(before) === JSON.stringify(after),
        `${at.why}・${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      );
    }
  }

  // (e) ask ≤ 50 円: 見えている行の ask がすべて 50 以下、絞り込み中に [ATM] で外れて ATM へ
  {
    const chip = page.locator('section.board .board-tools .chip:has-text("ask ≤ 50 円")');
    await chip.click();
    await twoFrames(page);
    const asks = await page.evaluate((s) => {
      const wrap = document.querySelector(s);
      return [...(wrap?.querySelectorAll('button[aria-label*=" put ask "]') ?? [])].map(
        (b) => b.textContent,
      );
    }, ACTIVE_WRAP);
    const nums = asks.map((t) => Number((t ?? '').replace(/,/g, '')));
    check(
      `#85 AC-9(e) ${tag} ask ≤ 50 円: 行の put の ask がすべて 50 以下（${nums.length} 行）`,
      (await chip.getAttribute('aria-pressed')) === 'true' &&
        nums.length > 0 &&
        nums.every((v) => Number.isFinite(v) && v <= 50),
      nums.slice(0, 8).join(' '),
    );
    await page.click('section.board .board-tools button[aria-label="ATM へ"]');
    await twoFrames(page);
    await twoFrames(page);
    const st = await centered(atm);
    check(
      `#85 AC-9(e) ${tag} 絞り込み中に [ATM] で絞り込みが外れて ATM へ`,
      (await chip.getAttribute('aria-pressed')) === 'false' && st.ok,
      st.why,
    );
  }

  // (f) 5 列で put → call を替えても枠の中央の K が ±1 行
  if (cols === 5) {
    const mid = () =>
      page.evaluate((s) => {
        const wrap = document.querySelector(s);
        if (!wrap) return null;
        const head = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        const b = wrap.getBoundingClientRect();
        const y = b.top + head + (wrap.clientHeight - head) / 2;
        const trs = [...wrap.querySelectorAll('tbody tr')];
        const i = trs.findIndex((tr) => tr.getBoundingClientRect().bottom >= y);
        return { i, k: Number(trs[i]?.getAttribute('data-k')) };
      }, ACTIVE_WRAP);
    await page.evaluate((s) => {
      const w = document.querySelector(s);
      if (w) w.scrollTop += 700;
    }, ACTIVE_WRAP);
    const m0 = await mid();
    await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
    await twoFrames(page);
    await twoFrames(page);
    const m1 = await mid();
    check(
      `#85 AC-9(f) ${tag} 5 列で put → call: 枠の中央の K が ±1 行`,
      !!m0 && !!m1 && Math.abs(m0.i - m1.i) <= 1,
      `${fmtK(m0?.k)} → ${fmtK(m1?.k)}`,
    );
    await page.click('section.board [aria-label="対象の種別"] button:has-text("put")');
    await twoFrames(page);
  }

  // (h) スマイル: タップ・もう一度タップ・長押し + 横ドラッグ・. ・[×]・[売り]・ホイール / ⟲・横軸
  if (phoneSize) {
    await setShell(page, 'smile', 'peek');
    await smileTab(page);
  } else await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.waitForTimeout(250);
  const S = 'section.smile .smile-month:not(.inactive) .smile-wrap';
  const actK = () =>
    page
      .locator('section.smile .smile-act .k')
      .textContent({ timeout: 300 })
      .catch(() => null);
  /** mid の点の中心（画面の座標。ATM の縦線に近いものから） */
  const points = await page.evaluate((s) => {
    const wrap = document.querySelector(s);
    const svg = wrap?.querySelector('svg');
    const d = svg?.querySelector('.pt.mid')?.getAttribute('d') ?? '';
    const atm = Number(svg?.querySelector('line.atm')?.getAttribute('x1') ?? Number.NaN);
    const b = svg?.getBoundingClientRect();
    const pts = [...d.matchAll(/M([\d.]+) ([\d.]+)a2\.5/g)].map((m) => ({
      x: Number(m[1]) + 2.5,
      y: Number(m[2]),
    }));
    if (!b) return [];
    return pts
      .map((p) => ({ x: b.left + p.x, y: b.top + p.y, d: Math.abs(p.x - atm) }))
      .sort((a, c) => a.d - c.d);
  }, S);
  const p0 = points[0];
  if (!p0) check(`#85 AC-9(h) ${tag} スマイルの点`, false, '点が無い');
  else {
    await page.mouse.click(p0.x, p0.y);
    await twoFrames(page);
    const k1 = await actK();
    // 続けて押すとダブルクリック（リセット）になるので間を空ける
    await page.waitForTimeout(600);
    await page.mouse.click(p0.x, p0.y);
    await twoFrames(page);
    const k2 = await actK();
    check(
      `#85 AC-9(h) ${tag} 点のタップで操作行に K、同じ点のタップで解除`,
      !!k1 && k2 === null,
      `${k1} → ${k2}`,
    );
    // 長押し（0.5 秒）して横に 60px ドラッグ
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.waitForTimeout(550);
    const k3 = await actK();
    await page.mouse.move(p0.x + 60, p0.y, { steps: 12 });
    await page.mouse.up();
    await twoFrames(page);
    const k4 = await actK();
    check(
      `#85 AC-9(h) ${tag} 長押し + 横に 60px で選択の K が変わる`,
      !!k3 && !!k4 && k3 !== k4,
      `${k3} → ${k4}`,
    );
    await page.locator(S).focus();
    await page.keyboard.press('.');
    await twoFrames(page);
    const k5 = await actK();
    check(`#85 AC-9(h) ${tag} . で次の K`, !!k5 && k5 !== k4, `${k4} → ${k5}`);
    const before = await counts();
    await page.click('section.smile .smile-act button[aria-label*="を売り"]');
    await twoFrames(page);
    const after = await counts();
    check(
      `#85 AC-9(h) ${tag} [売り] で足 +1 とトースト`,
      after.rows === before.rows + 1 &&
        after.toast.some((t) => /^売 [PC] .* を追加$/.test(t ?? '')),
      `${before.rows} → ${after.rows}・${after.toast.join(' / ')}`,
    );
    await page.click('section.smile .smile-act button[aria-label="選択を消す"]');
    await twoFrames(page);
    check(`#85 AC-9(h) ${tag} [×] で選択が消える`, (await actK()) === null);
    const ticks = () => page.locator(`${S} .ax .tx`).allTextContents();
    const t0 = await ticks();
    const box = await page.locator(S).boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(50);
      }
    }
    await twoFrames(page);
    const t1 = await ticks();
    await page.click('section.smile .panel-head button[aria-label="リセット"]');
    await twoFrames(page);
    const t2 = await ticks();
    check(
      `#85 AC-9(h) ${tag} ホイールで横軸の範囲が狭まり ⟲ で戻る`,
      JSON.stringify(t0) !== JSON.stringify(t1) && JSON.stringify(t0) === JSON.stringify(t2),
      `${t0.at(0)}〜${t0.at(-1)} → ${t1.at(0)}〜${t1.at(-1)} → ${t2.at(0)}〜${t2.at(-1)}`,
    );
    await page.click('section.smile [aria-label="横軸"] button:has-text("moneyness")');
    await twoFrames(page);
    const tm = await ticks();
    await page.click('section.smile [aria-label="横軸"] button[aria-label="デルタ"]');
    await twoFrames(page);
    const td = await ticks();
    await page.click('section.smile [aria-label="横軸"] button:has-text("行使価格")');
    await twoFrames(page);
    check(
      `#85 AC-9(h) ${tag} 横軸の Seg で目盛りの文言が変わる`,
      tm.some((t) => t.includes('%')) && td.some((t) => /^[PC] /.test(t) || t === '0.50'),
      `${tm.slice(0, 3).join(' ')} / ${td.slice(0, 3).join(' ')}`,
    );
  }
  // (g) 限月を替えると板の行とスマイルが別の限月になり、スマイルの選択が消える
  {
    await page.locator(S).focus();
    await page.keyboard.press('.');
    await twoFrames(page);
    const picked = await actK();
    const other = chain.months.find((m) => m.id !== i0.month)?.id;
    await page.click(`section.smile [aria-label="限月"] button[aria-label="${other} 限"]`);
    await twoFrames(page);
    const sm = await page
      .locator('section.smile .smile-month:not(.inactive)')
      .getAttribute('data-month');
    const k6 = await actK();
    if (phoneSize) await setShell(page, 'board', 'peek');
    else await page.click('section.smile .panel-head .seg button:has-text("板")');
    await twoFrames(page);
    const bm = (await info()).month;
    check(
      `#85 AC-9(g) ${tag} 限月の切替: 板とスマイルが ${other}・スマイルの選択が消える`,
      !!picked && sm === other && bm === other && k6 === null,
      `選択 ${picked} → ${k6}・板 ${bm}・スマイル ${sm}`,
    );
    await page.click(`section.board [aria-label="限月"] button[aria-label="${i0.month} 限"]`);
    await twoFrames(page);
  }
  const lf = await page.evaluate(() =>
    window.__loafOk ? window.__loaf.filter((d) => d > 50).length : -1,
  );
  console.log(`      ${tag} 市場の手順の Long Animation Frame（50ms 超・記録）: ${lf} 件`);
  await ctx.close();
}

/** AC-10: 322 行の板（合成）で、行数・各操作の Long Animation Frame 0 件・限月の切替の時間（記録） */
async function marketWideFlows(vp) {
  const tag = `${vp.width}x${vp.height} 322 行`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  await ctx.addInitScript(LOAF_INIT);
  await routeWide(ctx);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  if (phoneSize) await setShell(page, 'board', 'peek');
  await page.waitForTimeout(500);
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const mark = () => page.evaluate(() => window.__loaf.length);
  const since = (i) => page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50), i);
  const rows = await page.locator(`${ACTIVE_WRAP} tbody tr`).count();
  check(`#85 AC-10(a) ${tag} 表の行が 322`, rows === 322, `${rows} 行`);
  const results = [];
  // 隠れた表の空き時間の割り付け（regions/Board.tsx）が済むのを待ってから測る
  const settle = () =>
    page
      .waitForSelector('section.board .board-months[data-warm="done"]', { timeout: 5000 })
      .catch(() => null);
  const run = async (name, fn) => {
    await settle();
    await page.waitForTimeout(300);
    const m = await mark();
    await fn();
    await page.waitForTimeout(300);
    const l = await since(m);
    results.push([name, l]);
  };
  const box = await page.locator(ACTIVE_WRAP).boundingBox();
  await run('板の枠のホイール 20 回', async () => {
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i < 10 ? 240 : -240);
      await page.waitForTimeout(30);
    }
  });
  await run('put / call の切替 10 回', async () => {
    for (let i = 0; i < 10; i++) {
      await page.click(
        `section.board [aria-label="対象の種別"] button:has-text("${i % 2 ? 'put' : 'call'}")`,
      );
      await twoFrames(page);
    }
  });
  const months = await page.locator('section.board [aria-label="限月"] button').count();
  const times = [];
  await run('限月の切替 10 回', async () => {
    for (let i = 0; i < 10; i++) {
      const t = await page.evaluate(
        (n) =>
          new Promise((r) => {
            const b = document.querySelectorAll('section.board [aria-label="限月"] button')[n];
            const t0 = performance.now();
            b?.click();
            requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0)));
          }),
        (i + 1) % months,
      );
      times.push(t);
      await page.waitForTimeout(50);
    }
  });
  const chips = [
    'ATM へ',
    'OTM 10% へ',
    'OTM 20% へ',
    'OTM 30% へ',
    '|Δ| 0.05 へ',
    '|Δ| 0.10 へ',
    '|Δ| 0.20 へ',
    '|Δ| 0.30 へ',
  ];
  await run('ジャンプ 8 回', async () => {
    for (const c of chips) {
      await page.click(`section.board .board-tools button[aria-label="${c}"]`);
      await twoFrames(page);
    }
  });
  await run('bid / ask での追加 5 回', async () => {
    await page.click('section.board .board-tools button[aria-label="ATM へ"]');
    await twoFrames(page);
    const btns = page.locator(`${ACTIVE_WRAP} tr.atm button`);
    const n = await btns.count();
    for (let i = 0; i < 5; i++) {
      await btns.nth(i % n).click();
      await twoFrames(page);
    }
  });
  if (phoneSize) {
    await setShell(page, 'smile', 'peek');
    await smileTab(page);
  } else await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.waitForTimeout(300);
  const sb = await page
    .locator('section.smile .smile-month:not(.inactive) .smile-wrap')
    .boundingBox();
  await run('スマイルのドラッグ（パン）と拡大縮小', async () => {
    if (!sb) return;
    const x = sb.x + sb.width / 2;
    const y = sb.y + sb.height / 2;
    await page.mouse.move(x, y);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -150);
      await page.waitForTimeout(40);
    }
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 20 });
    await page.mouse.up();
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 150);
      await page.waitForTimeout(40);
    }
  });
  for (const [name, l] of results) {
    check(
      `#85 AC-10(b) ${tag} ${name}の Long Animation Frame（50ms 超）0 件`,
      loafOk && l.length === 0,
      loafOk
        ? `${l.length} 件${l.length ? `（${l.map((d) => Math.round(d)).join('・')}ms）` : ''}`
        : '未対応',
    );
  }
  const sorted = [...times].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  console.log(
    `      ${tag} AC-10(c) 限月の切替のクリックから次の描画まで（記録）: 中央値 ${med.toFixed(1)}ms（${sorted.map((t) => t.toFixed(0)).join('・')}）`,
  );
  await ctx.close();
}

/**
 * AC-12: 限月・種別・ask ≤ 50 円・横軸を替え → 再読み込みで残る・作業の保存（版 2）の ui.month_id・ui.target・
 * ui.filter_ask・ui.smile_axis が選んだ値（旧画面が読んでいたのと同じキー。#91 で旧画面と比べる手順を置き換えた）
 */
async function marketPersistFlow() {
  const vp = { width: 1440, height: 900 };
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const monthBtn = page.locator('section.board [aria-label="限月"] button').nth(1);
  const monthText = (await monthBtn.textContent())?.trim();
  const monthLabel = await monthBtn.getAttribute('aria-label');
  await monthBtn.click();
  await page.click('section.board [aria-label="対象の種別"] button:has-text("call")');
  await page.click('section.board .board-tools .chip:has-text("ask ≤ 50 円")');
  await page.click('section.board .panel-head .seg button:has-text("スマイル")');
  await page.click('section.smile [aria-label="横軸"] button:has-text("moneyness")');
  await page.waitForTimeout(800);
  await page.reload();
  await waitReady(page, 'next');
  const pressed = (sel) =>
    page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
  const nextMonth = await pressed('section.board [aria-label="限月"] button[aria-pressed="true"]');
  const nextTarget = await pressed(
    'section.board [aria-label="対象の種別"] button[aria-pressed="true"]',
  );
  const nextFilter = await page
    .locator('section.board .board-tools .chip:has-text("ask ≤ 50 円")')
    .getAttribute('aria-pressed');
  check(
    '#85 AC-12 新しい画面の再読み込みで限月・種別・ask ≤ 50 円が残る',
    nextMonth === monthText && nextTarget === 'call' && nextFilter === 'true',
    `${nextMonth}・${nextTarget}・${nextFilter}`,
  );
  const ws = await page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  }, WORKSPACE_KEY);
  const u = ws?.ui ?? {};
  check(
    '#85 AC-12 再読み込みの後の作業の保存の ui.month_id・target・filter_ask・smile_axis が選んだ値（旧画面が読むキー）',
    `${u.month_id} 限` === monthLabel &&
      u.target === 'call' &&
      u.filter_ask === true &&
      u.smile_axis === 'moneyness',
    JSON.stringify({
      month_id: u.month_id,
      target: u.target,
      filter_ask: u.filter_ask,
      smile_axis: u.smile_axis,
    }),
  );
  await ctx.close();
}

// ---- トップバー（#87 (A)）: トップバーの検査・開いた状態の検査・手順
const BOARD_KEY = 'option-simulator.lastBoard';
const topStats = { pass: 0, total: 0 };
const openStats = { pass: 0, total: 0 };
/** 最も混む作業: タブ 6 個（12 字の名前。先頭は足 2 本）。名前は架空 */
const BUSY_NAMES = [...'一二三四五六'].map((c) => `長いタブの名前ですね${c}号`);
const busyWorkspace = JSON.stringify({
  ...fixture,
  active: 0,
  tabs: BUSY_NAMES.map((name, i) => ({
    ...fixture.tabs[0],
    name,
    position: i === 0 ? fixture.tabs[0].position : { ...fixture.tabs[0].position, legs: [] },
  })),
});
/** 保存した最後の板（合成の latest。取得時刻は架空） */
const BUSY_FETCHED = Date.parse('2026-10-13T21:40:00+09:00');
let savedBoardText = null;
async function savedBoard() {
  if (savedBoardText) return savedBoardText;
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(join(root, 'ui', 'persist.ts'), {
    configFile: false,
    root,
    logLevel: 'error',
  });
  savedBoardText = module.serializeBoard(board, BUSY_FETCHED, 'latest');
  return savedBoardText;
}

/**
 * クリップボードへの書き込みを断る（#87 (B)。Chromium は操作の中なら権限なしでも書けることがあるので差し替えで作る）。
 * 書こうとした文字列を window.__clipTried に残す
 */
const CLIP_REJECT_INIT = `
  if (navigator.clipboard) {
    navigator.clipboard.writeText = (t) => {
      window.__clipTried = t;
      return Promise.reject(new DOMException('', 'NotAllowedError'));
    };
  }
`;

/** 同じコンテキストの別のページで作業の保存を書く（storage イベント → 警告のタグ「別のタブ」） */
async function writeFromOtherPage(ctx, value) {
  const other = await ctx.newPage();
  await other.goto(`${origin}/fixtures/pre_open.json`);
  await other.evaluate(([k, v]) => localStorage.setItem(k, v), [WORKSPACE_KEY, value]);
  await other.close();
}

/**
 * 最も混む作業のページ: タブ 6 個・12 字の名前 + 保存した最後の板 + 合成の板の読み込みの失敗（ピルに 読めない・古い板）
 * + 別のタブ（警告のタグ）。知らせのトースト（復元・読み込みの失敗）は残す
 */
async function busyPage(vp, theme) {
  const ctx = await newContext(vp, {
    [WORKSPACE_KEY]: busyWorkspace,
    [BOARD_KEY]: await savedBoard(),
    [PREFS_KEY]: prefsText(theme),
  });
  await ctx.route('**/fixtures/latest.json', (route) =>
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
  );
  // 共有の URL のダイアログ（#87 (B)）を開くため、クリップボードへの書き込みを断る
  await ctx.addInitScript(CLIP_REJECT_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next', { keepNotes: true });
  await writeFromOtherPage(ctx, `${busyWorkspace} `);
  await page.waitForSelector('.warn-btn', { timeout: 5000 }).catch(() => {});
  return { ctx, page };
}

/** トップバーの検査: 高さ = --top-h、ピルの時刻・F・ATM（スマホは時刻）・[最新]・⋯ が切れず画面内、中の折り返し 0 */
async function topBarCheck(page, label) {
  const r = await page.evaluate((latestSel) => {
    const top = document.querySelector('header.top');
    if (!top) return { bad: ['header.top が無い'], pill: '' };
    const want = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--top-h'),
    );
    const tb = top.getBoundingClientRect();
    const bad = [];
    if (Math.abs(tb.height - want) > 0.5) bad.push(`高さ ${tb.height}px（--top-h ${want}px）`);
    const phone = window.innerWidth < 720;
    const sels = ['.market-pill', '.market-pill .when', latestSel, 'button[aria-label="メニュー"]'];
    if (!phone) sels.push('.market-pill .vals', 'button[aria-label="テーマ"]');
    if (top.querySelector('.warn-btn')) sels.push('.warn-btn');
    // BOX タブ（#87 (B)）: ＋ が窓の中・切れない、作業中のチップが帯の矩形と窓の中、本数が切れない、スクロールバーなし
    sels.push('.boxtabs-add');
    const strip = top.querySelector('.boxtabs');
    const chip = top.querySelector('.boxtabs [aria-selected="true"]');
    if (!strip || !chip) bad.push('BOX タブが無い');
    else {
      const sb = strip.getBoundingClientRect();
      const cb = chip.getBoundingClientRect();
      if (
        cb.left < sb.left - 0.5 ||
        cb.right > sb.right + 0.5 ||
        cb.left < -0.5 ||
        cb.right > window.innerWidth + 0.5
      ) {
        bad.push(
          `作業中のチップが帯の外（${Math.round(cb.left)}–${Math.round(cb.right)} / 帯 ${Math.round(sb.left)}–${Math.round(sb.right)}）`,
        );
      }
      if (strip.offsetHeight !== strip.clientHeight) {
        bad.push(`帯にスクロールバー（${strip.offsetHeight} ≠ ${strip.clientHeight}）`);
      }
      for (const n of strip.querySelectorAll('.boxtab .n')) {
        if (n.scrollWidth > n.clientWidth + 0.5)
          bad.push(`チップの本数が切れている「${n.textContent}」`);
      }
      if (chip.scrollWidth > chip.clientWidth + 0.5) {
        bad.push(`作業中のチップの中が切れている（${chip.scrollWidth} > ${chip.clientWidth}）`);
      }
    }
    for (const sel of sels) {
      const el = top.querySelector(sel);
      if (!el) {
        bad.push(`${sel} が無い`);
        continue;
      }
      const b = el.getBoundingClientRect();
      if (
        b.width <= 0 ||
        b.left < -0.5 ||
        b.right > window.innerWidth + 0.5 ||
        b.top < tb.top - 0.5 ||
        b.bottom > tb.bottom + 0.5
      ) {
        bad.push(`${sel} が画面外（${Math.round(b.left)}–${Math.round(b.right)}）`);
      }
      if (el.scrollWidth > el.clientWidth + 0.5) {
        bad.push(`${sel} が切れている（${el.scrollWidth} > ${el.clientWidth}）`);
      }
    }
    if (phone) {
      const theme = top.querySelector('.top-theme');
      if (theme && getComputedStyle(theme).display !== 'none')
        bad.push('スマホで .top-theme が見えている');
      // ブランド（h1）は見た目だけ隠す（見出しの構造に残す。#124）: display は none でなく、箱は 1px 以下
      const brand = top.querySelector('h1.brand');
      const bb = brand?.getBoundingClientRect();
      if (!brand || getComputedStyle(brand).display === 'none')
        bad.push('スマホで h1.brand が見出しの構造に無い');
      else if (bb && (bb.width > 1.5 || bb.height > 1.5)) bad.push('スマホで .brand が見えている');
    }
    for (const el of top.querySelectorAll('*')) {
      if (el.closest('.popover, .menu')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const txt = [...el.childNodes]
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join('')
        .trim();
      if (!txt) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)),
      );
      if (lines.size > 1)
        bad.push(`折り返し ${el.tagName}.${el.getAttribute('class') ?? ''}「${txt}」`);
    }
    const pill = top.querySelector('.market-pill')?.textContent ?? '';
    return { bad, pill };
  }, LATEST_BTN);
  topStats.total++;
  if (r.bad.length === 0) topStats.pass++;
  else {
    failed = true;
    console.log(`${label}: トップバー ${r.bad.join('、')}  ← NG`);
  }
}

/** 開いたもの（sel）が窓の中に収まり、中で横にはみ出さない */
function inWindow(page, sel) {
  return page.evaluate((s) => {
    const els = [...document.querySelectorAll(s)].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    });
    if (els.length === 0) return `${s} が無い`;
    for (const e of els) {
      const b = e.getBoundingClientRect();
      if (
        b.left < -0.5 ||
        b.top < -0.5 ||
        b.right > innerWidth + 0.5 ||
        b.bottom > innerHeight + 0.5
      ) {
        return `${s} が窓の外（${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)}）`;
      }
      // 中で横にはみ出していない（説明文が折り返さずに切れる・隠れるのを見逃さない）
      if (e.scrollWidth > e.clientWidth + 0.5) {
        return `${s} の中が横にはみ出す（${e.scrollWidth} > ${e.clientWidth}）`;
      }
    }
    return '';
  }, sel);
}

async function openCheck(page, label, w, h, shotName, sel) {
  const ok = await report(page, label, w, h, shotName);
  const out = await inWindow(page, sel);
  openStats.total++;
  if (ok && out === '') openStats.pass++;
  else {
    failed = true;
    if (out) console.log(`${label} ${w}x${h}: ${out}  ← NG`);
  }
}

/** ⋯ の URL をコピーが押せる（URL ができた） */
const MORE_SHARE_READY =
  'header.top > .menu-wrap [role="menuitem"]:has-text("URL をコピー"):not([aria-disabled])';
/** 保存一覧の開いた状態の名前（架空。1 つは 40 字 = 名前の上限） */
const BOOK_NAMES = ['11月 売り 2 本', `${'とても長い保存の名前'.repeat(4)}`, '検査の三'];

/**
 * 最も混む作業のトップバーと、開いた状態（知らせのトースト・⋯・ピル・警告のタグ・共有を開く確認・BOX タブ・
 * 設定・保存一覧（#87 (C)））
 */
async function topSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await busyPage({ width: w, height: h }, theme);
      const tag = `next ${theme} 最も混む作業`;
      const name = `next-busy-${w}x${h}-${theme}`;
      await topBarCheck(page, `${tag} ${w}x${h}`);
      const pill = await page.getAttribute('.market-pill', 'aria-label');
      const warn = await page.getAttribute('.warn-btn', 'aria-label').catch(() => null);
      if (!(pill?.includes('読めない') && pill.includes('古い板') && warn?.includes('別のタブ'))) {
        failed = true;
        console.log(`${tag} ${w}x${h}: 最も混む作業を作れない（ピル ${pill}・警告 ${warn}）  ← NG`);
      }
      if (w === 900) {
        await report(page, tag, w, h, name);
      } else {
        // 開いた状態（360・390・1440。#87 AC-10）
        await openCheck(page, `${tag} 知らせのトースト`, w, h, `${name}-toasts`, '.toast.note');
        await closeNotes(page);
        await report(page, tag, w, h, name);
        await page.click('button[aria-label="メニュー"]');
        // URL ができてから撮る（作っている間の薄い表示で写さない。#87 (B) のレビュー 6）
        await page.waitForSelector(MORE_SHARE_READY, { timeout: 5000 }).catch(() => {});
        await openCheck(
          page,
          `${tag} ⋯ メニュー`,
          w,
          h,
          `${name}-menu`,
          'header.top [role="menu"]',
        );
        await page.keyboard.press('Escape');
        await page.click('.market-pill');
        await openCheck(
          page,
          `${tag} ピルのポップオーバー`,
          w,
          h,
          `${name}-pill`,
          '.pill .popover',
        );
        await page.keyboard.press('Escape');
        await page.click('.warn-btn');
        await openCheck(page, `${tag} 警告のタグ`, w, h, `${name}-warn`, '.warn-tags .popover');
        await page.keyboard.press('Escape');
        await page.evaluate((hash) => {
          location.hash = hash;
        }, share.hash);
        await page.waitForSelector('dialog.sheet[open]', { timeout: 5000 }).catch(() => {});
        await openCheck(page, `${tag} 共有を開く確認`, w, h, `${name}-share`, 'dialog.sheet[open]');
        await page.click('dialog.sheet button:has-text("やめる")').catch(() => {});
        await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
        // BOX タブ（#87 (B)）: タブのメニュー・名前を変える…・共有の URL・＋ のメニュー
        const chip = '.boxtabs [aria-selected="true"]';
        await page.click(chip);
        await page
          .waitForSelector(
            '.boxtabs-wrap > [role="menu"] [role="menuitem"]:has-text("URL をコピー"):not([aria-disabled])',
            { timeout: 5000 },
          )
          .catch(() => {});
        await openCheck(
          page,
          `${tag} タブのメニュー`,
          w,
          h,
          `${name}-tabmenu`,
          '.boxtabs-wrap > [role="menu"]',
        );
        await page.click(
          '.boxtabs-wrap > [role="menu"] [role="menuitem"]:has-text("名前を変える…")',
        );
        await page.waitForSelector('dialog.sheet[open]', { timeout: 3000 }).catch(() => {});
        await openCheck(page, `${tag} 名前を変える…`, w, h, `${name}-rename`, 'dialog.sheet[open]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
        await page.click(chip);
        await page.click(
          '.boxtabs-wrap > [role="menu"] [role="menuitem"]:has-text("URL をコピー"):not([aria-disabled])',
        );
        await page.waitForSelector('dialog.sheet[open]', { timeout: 3000 }).catch(() => {});
        await openCheck(page, `${tag} 共有の URL`, w, h, `${name}-shareurl`, 'dialog.sheet[open]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
        // 設定・保存一覧（#87 (C)）: 保存一覧は名前 3 つ（1 つは 40 字）で保存した状態
        await page.click('button[aria-label="メニュー"]');
        await page.click('header.top > .menu-wrap [role="menuitem"]:has-text("設定…")');
        await page
          .waitForSelector('dialog.sheet.settings[open]', { timeout: 3000 })
          .catch(() => {});
        await openCheck(page, `${tag} 設定`, w, h, `${name}-settings`, 'dialog.sheet[open]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
        await page.click('button[aria-label="メニュー"]');
        await page.click('header.top > .menu-wrap [role="menuitem"]:has-text("保存一覧")');
        await page.waitForSelector('dialog.sheet.book[open]', { timeout: 3000 }).catch(() => {});
        for (const nm of BOOK_NAMES) {
          await page.fill('dialog.sheet.book[open] .bk-save input', nm);
          await page.click('dialog.sheet.book[open] .bk-save button:has-text("保存")');
        }
        await page
          .waitForFunction(
            (n) => document.querySelectorAll('dialog.sheet.book[open] .bk-row').length === n,
            BOOK_NAMES.length,
            { timeout: 3000 },
          )
          .catch(() => {});
        await openCheck(page, `${tag} 保存一覧`, w, h, `${name}-book`, 'dialog.sheet[open]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
        // 6 個では ＋ を押せないので 1 個閉じてから（閉じたトーストも出る）
        await page.click(chip);
        await page.click('.boxtabs-wrap > [role="menu"] [role="menuitem"]:has-text("閉じる")');
        await page.click('.boxtabs-add');
        await openCheck(
          page,
          `${tag} ＋ のメニュー`,
          w,
          h,
          `${name}-addmenu`,
          '.boxtabs-wrap .menu-wrap > [role="menu"]',
        );
        await page.keyboard.press('Escape');
      }
      await ctx.close();
    }
  }
}

// ---- 保有ポジションの一覧（#302 AC17）: 4 幅 × ダーク / ライトで、保有 3 行（うち 1 行は重なりで合計に入れない）+ 合計の
// 行を開いた状態。追証までの距離が「計算中…」でなくなるまで待ってから、ページの縦・横スクロール 0・ダイアログが窓の中で横に
// はみ出さない・行の値（.bk-sum の span）が折り返さず切れない・名前は省略記号 + title・合計の行がある
const holdingsStats = { pass: 0, total: 0 };
/** 保有のタブ 3 つ（12 字の名前。架空の値）: put 売り / call 売り / 両方（put の足が 1 本目と重なる = 合計に入れない） */
const HOLDING_NAMES = [...'一二三'].map((c) => `長い保有の名前ですね${c}号`);
const holdingsWorkspace = (() => {
  const legs = fixture.tabs[0].position.legs;
  const pos = (ls) => ({ ...fixture.tabs[0].position, legs: ls, held: true });
  return JSON.stringify({
    ...fixture,
    active: 1,
    tabs: [
      { name: HOLDING_NAMES[0], position: pos([legs[0]]) },
      { name: HOLDING_NAMES[1], position: pos([legs[1]]) },
      { name: HOLDING_NAMES[2], position: pos(legs) },
    ],
  });
})();
const HOLDINGS = 'dialog.sheet.holdings[open]';

async function holdingsSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        {
          [WORKSPACE_KEY]: holdingsWorkspace,
          [PREFS_KEY]: prefsText(theme, { capital_yen: 3_000_000 }),
        },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const label = `next ${theme} 保有ポジション（#302）`;
      await page.click('button[aria-label="メニュー"]');
      await page.click('header.top > .menu-wrap [role^="menuitem"]:has-text("保有ポジション…")');
      await page.waitForSelector(HOLDINGS, { timeout: 3000 }).catch(() => {});
      await page
        .waitForFunction(
          (sel) => {
            const t = document.querySelector(`${sel} .hl-total`)?.textContent ?? '';
            return t !== '' && !t.includes('計算中');
          },
          HOLDINGS,
          { timeout: 10000 },
        )
        .catch(() => {});
      const ok = await report(page, label, w, h, `holdings-${w}x${h}-${theme}`);
      const out = await inWindow(page, HOLDINGS);
      const view = await page.evaluate((sel) => {
        const rows = [...document.querySelectorAll(`${sel} .bk-row`)];
        return {
          rows: rows.length,
          total: document.querySelector(`${sel} .hl-total`)?.textContent ?? '',
          names: rows.map((r) => {
            const n = r.querySelector('.bk-name');
            return { title: n?.getAttribute('title') ?? null, text: n?.textContent ?? '' };
          }),
          warnTags: [...document.querySelectorAll(`${sel} .tag.warn`)].map((t) => t.textContent),
        };
      }, HOLDINGS);
      const sum = await scopeWraps(page, `${HOLDINGS} .bk-sum`);
      const head = await scopeWraps(page, `${HOLDINGS} .bk-head .bk-name`);
      const good =
        ok &&
        out === '' &&
        view.rows === 4 &&
        view.total.includes('保有全部') &&
        view.total.includes('追証までの距離') &&
        !view.total.includes('計算中') &&
        view.names.slice(0, 3).every((n, i) => n.title === HOLDING_NAMES[i]) &&
        view.warnTags.some((t) => t.includes('合計に入れない')) &&
        sum.wraps.length === 0 &&
        sum.cut.length === 0 &&
        head.cut.length === 0;
      holdingsStats.total++;
      if (good) holdingsStats.pass++;
      else {
        failed = true;
        console.log(
          `${label} ${w}x${h}: ${out} 行 ${view.rows}・合計「${view.total}」・名前 ${JSON.stringify(view.names)}・警告 ${view.warnTags.join(' / ')}・値の折り返し / 切れ ${[...sum.wraps, ...sum.cut, ...head.cut].join(' / ')}  ← NG`,
        );
      }
      await ctx.close();
    }
  }
}

// ---- #87 (A) の手順（AC-11・AC-15）
/** tests/ui/saved/share-v1.json の足の本数（#81 AC-11(b) と同じ） */
const SHARE_LEGS = 3;
const nightEarlyText = readFileSync(join(root, 'fixtures/synthetic/night_early.json'), 'utf8');
/** 板の時刻（JST）→ `MM/DD HH:mm` */
const jstPill = (iso) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
};
/** 数値のトークン（#87 AC-11(e)） */
const PILL_TOKEN = /[+−]?[0-9][0-9,.:/-]*/g;
const tokens = (text) => text.match(PILL_TOKEN) ?? [];
/** a のトークンが b にすべて含まれる（回数も。足りないものを返す） */
function missingTokens(a, b) {
  const count = new Map();
  for (const t of b) count.set(t, (count.get(t) ?? 0) + 1);
  const miss = [];
  for (const t of a) {
    const n = count.get(t) ?? 0;
    if (n === 0) miss.push(t);
    else count.set(t, n - 1);
  }
  return miss;
}

async function topFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const pillLabel = (page) => page.getAttribute('.market-pill', 'aria-label');
  const pillState = (page) => page.getAttribute('.pill', 'data-state');
  const popText = async (page) => {
    await page.click('.market-pill');
    const t = (await page.textContent('.pill .popover')) ?? '';
    await page.keyboard.press('Escape');
    return t;
  };
  const savedLegs = (page) =>
    page.evaluate((k) => {
      try {
        const ws = JSON.parse(localStorage.getItem(k) ?? 'null');
        return JSON.stringify(ws?.tabs?.[ws.active]?.position?.legs ?? null);
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);

  // AC-11 (a)(b) [最新] の読み込み中・失敗、(c) ファイルを開く…
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    await ctx.addInitScript(LOAF_INIT);
    let chain = 'ok';
    await ctx.route('**/api/calendar**', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
    );
    await ctx.route('**/api/chain**', async (route) => {
      if (chain === 'fail') {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: nightEarlyText });
    });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    const legs0 = await savedLegs(page);
    const latest = LATEST_BTN;
    await page.click(latest);
    await page.waitForTimeout(150);
    const during = {
      state: await pillState(page),
      label: await pillLabel(page),
      disabled: await page.isDisabled(latest),
    };
    await page.waitForSelector('.pill[data-state="ready"]', { timeout: 10000 });
    const after = await pillLabel(page);
    const want = `板 ${jstPill(JSON.parse(nightEarlyText).snapshot_at)}`;
    check(
      `#87 AC-11(a) ${tag} [最新] の間はピルが読み込み中…・[最新] が disabled、終わると差し替えた板の時刻`,
      during.state === 'loading' &&
        (during.label ?? '').includes('読み込み中…') &&
        during.disabled &&
        (after ?? '').startsWith(want),
      `${JSON.stringify(during)} → ${after}`,
    );

    chain = 'fail';
    await page.click(latest);
    await page.waitForSelector('.pill[data-state="failed"]', { timeout: 10000 });
    const failLabel = await pillLabel(page);
    const failPop = await popText(page);
    const toast = await page
      .textContent('.toast.note.warn[data-kind="load-failed"] .txt')
      .catch(() => null);
    const legs1 = await savedLegs(page);
    check(
      `#87 AC-11(b) ${tag} 500 → ピルに読めない・ポップオーバーに失敗の文と前の板のまま・警告のトースト・足は同じ`,
      (failLabel ?? '').includes('読めない') &&
        /前の板のまま（取得 \d\d:\d\d）/.test(failPop) &&
        failPop.includes('板を読めない') &&
        (toast ?? '').includes('前の板のまま') &&
        legs1 === legs0,
      `ピル ${failLabel}・トースト ${toast}`,
    );
    // 次に成功したら失敗のトーストを消す（#87 の追加の振る舞い）
    chain = 'ok';
    await page.click(latest);
    await page.waitForSelector('.pill[data-state="ready"]', { timeout: 10000 });
    const gone = await page.locator('.toast.note[data-kind="load-failed"]').count();
    check(
      `#87 ${tag} 読み込みが成功したら失敗の警告のトーストが消える`,
      gone === 0,
      `残り ${gone}`,
    );

    // (c) ⋯ > ファイルを開く…
    const file = join(root, 'fixtures/synthetic/pre_open.json');
    await page.click('button[aria-label="メニュー"]');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.click('[role="menuitem"]:has-text("ファイルを開く…")'),
    ]);
    await chooser.setFiles(file);
    await page
      .waitForFunction(
        () =>
          document
            .querySelector('.market-pill')
            ?.getAttribute('aria-label')
            ?.startsWith('板 10/13 15:40'),
        undefined,
        { timeout: 10000 },
      )
      .catch(() => {});
    const fileLabel = await pillLabel(page);
    const filePop = await popText(page);
    const inputVal = await page.evaluate(
      () => document.querySelector('header.top input[type="file"]')?.value ?? null,
    );
    check(
      `#87 AC-11(c) ${tag} ⋯ > ファイルを開く… でピルの時刻がその板・表示中: pre_open.json・欄は空`,
      (fileLabel ?? '').startsWith('板 10/13 15:40') &&
        filePop.includes('表示中: pre_open.json') &&
        inputVal === '',
      `${fileLabel}`,
    );
    // 板の読み込み（正規化と全体の描画）は含めず、トップバーの操作（ピルのポップオーバー・⋯ メニューの開閉）だけを数える
    const m0 = await page.evaluate(() => (window.__loaf ?? []).length);
    for (let i = 0; i < 3; i++) {
      await page.click('.market-pill');
      await page.waitForTimeout(60);
      await page.keyboard.press('Escape');
      await page.click('button[aria-label="メニュー"]');
      await page.waitForTimeout(60);
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(200);
    const loaf = await page.evaluate(
      (n) => (window.__loaf ?? []).slice(n).filter((d) => d > 50).length,
      m0,
    );
    check(
      `#87 AC-17 ${tag} ピルのポップオーバー・⋯ メニューの開閉 3 回の Long Animation Frame 0 件`,
      loaf === 0,
      `${loaf} 件`,
    );
    await ctx.close();
  }

  // AC-11 (d) 限月の切替でピルの F・ATM がその限月（旧画面の Header の控えと一致）、(e) 全文の数値の列が控えを含む
  {
    const fixed = Date.parse(HEADER_FIXED_TIME);
    const ex = loadExpect();
    const old = ex.data?.header?.[tag] ?? null;
    if (!old) {
      check(
        `#87 AC-11(d)(e) ${tag} 控えた旧画面の header.header がある`,
        false,
        ex.why || `${tag} が無い`,
      );
    }

    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(fixed);
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    if (phoneSize) await setShell(page, 'board', 'peek');
    const second = old?.months[1];
    await page.click(`section.board [aria-label="限月"] button[aria-label="${second?.id} 限"]`);
    await page.waitForTimeout(150);
    const label = (await pillLabel(page)) ?? '';
    const other = old?.months[0];
    check(
      `#87 AC-11(d) ${tag} 限月 ${second?.id} でピルの F・ATM が旧画面（控え）の同じ限月と一致`,
      !!second?.f &&
        !!second.atm &&
        label.includes(`F ${second.f} · ATM ${second.atm}`) &&
        !label.includes(`F ${other?.f} `),
      `${label}／旧 F ${second?.f}・ATM ${second?.atm}`,
    );
    const pop = await popText(page);
    // 前提の一覧（金利・評価時刻・取引カレンダーの値）はピルから設定の末尾へ移した（#279 V-06。tests/ui/settings.test.ts）ので、
    // 控えの「前提: … ⓘ」の区間は比べない（ⓘ の後の説明の段落はピルに残る）
    const oldText = (old?.text ?? '').replace(/前提: .*? ⓘ/, '');
    const miss = missingTokens(tokens(oldText), tokens(pop));
    check(
      `#87 AC-11(e) ${tag} ピルの全文の数値の列が旧画面の header.header の列（控え）をすべて含む`,
      tokens(oldText).length > 20 && miss.length === 0,
      `旧 ${tokens(oldText).length} 個・ピル ${tokens(pop).length} 個${miss.length ? `・足りない ${miss.join(' ')}` : ''}`,
    );
    await ctx.close();
  }

  // AC-15 (a) 復元のトーストが出て 6 秒の後に消える（知らせの行は無い）、(e) タブの切り替えで [元に戻す] だけ消える
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next', { keepNotes: true });
    const t0 = Date.now();
    const restored = await page
      .textContent('.toast.note[data-kind="note-restored"] .txt')
      .catch(() => null);
    const notices = await page.locator('.notices, .notice').count();
    check(
      `#87 AC-15(a) ${tag} 知らせの行が無く、トースト「前回の作業を復元した（足 2 本…」`,
      notices === 0 && (restored ?? '').startsWith('前回の作業を復元した（足 2 本'),
      `${restored}`,
    );
    // (e) 復元のトーストが出ている間に: 足の × → [元に戻す] 付き → 共有 URL を開く（新しいタブ = 作業中のタブが変わる）
    if (phoneSize) await setShell(page, 'positions', 'full');
    await page.click('section.positions li.leg:nth-child(1) button[data-op="remove"]');
    const undoBefore = await page.locator('.toast:not(.note)', { hasText: '元に戻す' }).count();
    await page.evaluate((hash) => {
      location.hash = hash;
    }, share.hash);
    await page
      .waitForSelector('.toast.note[data-kind="note-shared"]', { timeout: 3000 })
      .catch(() => {});
    const e = await page.evaluate(() => ({
      undo: [...document.querySelectorAll('.toast:not(.note)')].filter((t) =>
        t.textContent?.includes('元に戻す'),
      ).length,
      kinds: [...document.querySelectorAll('.toast.note')].map((t) => t.getAttribute('data-kind')),
    }));
    const elapsed = Date.now() - t0;
    check(
      `#87 AC-15(e) ${tag} タブが変わると [元に戻す] 付きは消え、復元・共有を開いた知らせは残る`,
      undoBefore === 1 &&
        e.undo === 0 &&
        e.kinds.includes('note-restored') &&
        e.kinds.includes('note-shared'),
      `前 ${undoBefore}・後 ${e.undo}・${e.kinds.join(' ')}・${elapsed}ms`,
    );
    const rest = Math.max(0, 6500 - (Date.now() - t0));
    await page.waitForTimeout(rest);
    const left = await page.locator('.toast.note[data-kind="note-restored"]').count();
    check(`#87 AC-15(a) ${tag} 復元のトーストは 6 秒の後に消える`, left === 0, `残り ${left}`);
    await ctx.close();
  }

  // AC-15 (b) 壊れた作業の保存 → 警告のトーストが 10 秒後も残り、[閉じる] で消える
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: '{' });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next', { keepNotes: true });
    const sel = '.toast.note.warn[data-kind="note-invalid"]';
    const text = await page.textContent(`${sel} .txt`).catch(() => null);
    await page.waitForTimeout(10000);
    const still = await page.locator(sel).count();
    await page.click(`${sel} button`);
    const after = await page.locator(sel).count();
    check(
      `#87 AC-15(b) ${tag} 壊れた保存の警告のトーストが 10 秒後も残り、[閉じる] で消える`,
      (text ?? '').startsWith('保存した作業を読めなかった') && still === 1 && after === 0,
      `${text}・10 秒後 ${still}・閉じた後 ${after}`,
    );
    await ctx.close();
  }

  // AC-15 (c) 別のページの保存 → 警告のタグ「別のタブ」、押すと全文と [閉じる]、閉じるとタグが消え [最新] へ
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await writeFromOtherPage(ctx, `${twoLegs} `);
    await page.waitForSelector('.warn-btn', { timeout: 5000 }).catch(() => {});
    const btn = (await page.textContent('.warn-btn').catch(() => null)) ?? '';
    await page.click('.warn-btn').catch(() => {});
    const full = (await page.textContent('.warn-tags .popover').catch(() => null)) ?? '';
    await page.click('.warn-tags .popover button:has-text("閉じる")').catch(() => {});
    const after = await page.evaluate(() => ({
      tags: document.querySelectorAll('.warn-tags').length,
      focus: document.activeElement?.textContent?.trim() ?? null,
    }));
    check(
      `#87 AC-15(c) ${tag} 別のタブの保存で警告のタグ、押すと全文と [閉じる]、閉じるとタグが消え [最新] へ`,
      btn.includes('別のタブ') &&
        full.includes('別のタブで作業が保存された') &&
        after.tags === 0 &&
        after.focus === '最新',
      `${btn}・${JSON.stringify(after)}`,
    );
    await ctx.close();
  }

  // AC-15 (d) タブが 6 個のときに共有 URL → 確認のダイアログ。[置き換える] で足が URL の足に、[やめる] で変わらない
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: busyWorkspace });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    const open = async () => {
      await page.evaluate((hash) => {
        location.hash = hash;
      }, share.hash);
      await page.waitForSelector('dialog.sheet[open]', { timeout: 5000 }).catch(() => {});
      return (await page.textContent('dialog.sheet[open]').catch(() => null)) ?? '';
    };
    const t1 = await open();
    await page.click('dialog.sheet[open] button:has-text("置き換える")');
    await page.waitForTimeout(800);
    const replaced = JSON.parse((await savedLegs(page)) ?? 'null');
    const t2 = await open();
    const before = await savedLegs(page);
    await page.click('dialog.sheet[open] button:has-text("やめる")');
    await page.waitForTimeout(800);
    const kept = await savedLegs(page);
    const dialogs = await page.locator('dialog.sheet[open]').count();
    check(
      `#87 AC-15(d) ${tag} 6 個で共有 URL → 確認、[置き換える] で足 ${replaced?.length} 本、[やめる] で変わらない`,
      t1.includes('タブは 6 個まで') &&
        t2.includes('タブは 6 個まで') &&
        replaced?.length === SHARE_LEGS &&
        kept === before &&
        dialogs === 0,
      `足 ${replaced?.length}`,
    );
    await ctx.close();
  }
}

// ---- #87 (B) の手順（AC-12・AC-13・AC-15(e)）
const CHIP = '.boxtabs [aria-selected="true"]';
const ADD = '.boxtabs-add';
const menuItem = (label) => `[role="menu"] [role="menuitem"]:has-text("${label}")`;
/** 作業の保存（自動保存の debounce 500ms を待ってから読む） */
async function savedWorkspace(page) {
  await page.waitForTimeout(700);
  return page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      return null;
    }
  }, WORKSPACE_KEY);
}
/** タブの並び（名前・足・作業中。比べる形） */
const tabsShape = (ws) =>
  JSON.stringify({
    names: ws?.tabs?.map((t) => t.name),
    legs: ws?.tabs?.map((t) => t.position.legs),
    active: ws?.active,
  });

async function tabFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const chipAt = (i) => `.boxtabs [role="tab"]:nth-child(${i + 1})`;

  // (a) ＋ > 空のタブ → 2 個・作業中は新しいタブ・足 0 本。A に戻って ＋ > このタブを複製 → 足が A と同じ
  await page.click(ADD);
  await page.click(menuItem('空のタブ'));
  const a1 = await savedWorkspace(page);
  await page.click(chipAt(0));
  await page.click(ADD);
  await page.click(menuItem('このタブを複製'));
  const a2 = await savedWorkspace(page);
  check(
    `#87 AC-12(a) ${tag} ＋ > 空のタブで 2 個・足 0 本、＋ > このタブを複製で足が同じ`,
    a1?.tabs?.length === 2 &&
      a1.active === 1 &&
      a1.tabs[1].position.legs.length === 0 &&
      a2?.tabs?.length === 3 &&
      a2.active === 1 &&
      a2.tabs[0].position.legs.length === 2 &&
      JSON.stringify(a2.tabs[1].position.legs) === JSON.stringify(a2.tabs[0].position.legs),
    `${a1?.tabs?.length}・${a2?.tabs?.map((t) => `${t.name}:${t.position.legs.length}`).join(' ')}`,
  );

  // (b) クリックと ← → Home End で切り替わる（保存の active）。End の後、作業中のチップが帯の中
  const actives = [];
  await page.click(chipAt(0));
  actives.push((await savedWorkspace(page))?.active);
  for (const key of ['ArrowRight', 'End', 'Home', 'ArrowLeft']) {
    await page.keyboard.press(key);
    actives.push((await savedWorkspace(page))?.active);
    if (key === 'End') {
      const inStrip = await page.evaluate((sel) => {
        const c = document.querySelector(sel)?.getBoundingClientRect();
        const st = document.querySelector('.boxtabs')?.getBoundingClientRect();
        return !!c && !!st && c.left >= st.left - 0.5 && c.right <= st.right + 0.5;
      }, CHIP);
      actives.push(inStrip ? 'in' : 'out');
    }
  }
  const focusTab = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-selected') === 'true',
  );
  check(
    `#87 AC-12(b) ${tag} クリックと ← → Home End で作業中のタブが変わり、End の後のチップは帯の中`,
    JSON.stringify(actives) === JSON.stringify([0, 1, 2, 'in', 0, 2]) && focusTab,
    `${actives.join(' ')}・フォーカス ${focusTab}`,
  );

  // (c) 作業中のチップをもう一度押す → メニュー、名前を変える… → B2、空 / 他のタブと同じ名前は開いたまま alert
  await page.click(CHIP);
  const menuOpen = await page.locator('.boxtabs-wrap > [role="menu"]').count();
  await page.click(menuItem('名前を変える…'));
  const input = 'dialog.sheet[open] input[aria-label="タブの名前"]';
  await page.waitForSelector(input, { timeout: 3000 });
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-label') === 'タブの名前',
  );
  await page.fill(input, 'B2');
  await page.keyboard.press('Enter');
  const c1 = await savedWorkspace(page);
  const closed1 = await page.locator('dialog.sheet[open]').count();
  const back = await page.evaluate(
    () => document.activeElement?.getAttribute('aria-selected') === 'true',
  );
  const tries = [];
  for (const v of ['', c1?.tabs?.[0]?.name ?? 'A']) {
    await page.click(CHIP);
    await page.click(menuItem('名前を変える…'));
    await page.waitForSelector(input, { timeout: 3000 });
    await page.fill(input, v);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    tries.push({
      open: await page.locator('dialog.sheet[open]').count(),
      alert: (await page.textContent('dialog.sheet[open] [role="alert"]').catch(() => null)) ?? '',
    });
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 });
  }
  const c2 = await savedWorkspace(page);
  check(
    `#87 AC-12(c) ${tag} チップをもう一度押すとメニュー、名前を変える… で B2、空 / 同じ名前は開いたまま alert`,
    menuOpen === 1 &&
      focused &&
      c1?.tabs?.[c1.active]?.name === 'B2' &&
      closed1 === 0 &&
      back &&
      tries[0]?.open === 1 &&
      tries[0].alert === '名前を入れる' &&
      tries[1]?.open === 1 &&
      tries[1].alert === '同じ名前のタブがある' &&
      c2?.tabs?.[c2.active]?.name === 'B2',
    `メニュー ${menuOpen}・欄 ${focused}・${c1?.tabs?.map((t) => t.name).join(' ')}・戻り ${back}・${JSON.stringify(tries)}`,
  );

  // (d) 足 2 本のタブ A を閉じる → 確認なし・タブが減る・トースト → 別のチップへ切り替えても残る（AC-15(e)）→
  //     [元に戻す] で並び・名前・足・作業中が閉じる前と同じ
  await page.click(chipAt(0));
  const before = await savedWorkspace(page);
  await page.click(CHIP);
  await page.click(menuItem('閉じる'));
  await page.waitForTimeout(100);
  const d = {
    dialogs: await page.locator('dialog[open]').count(),
    chips: await page.locator('.boxtabs [role="tab"]').count(),
    toast: (await page.textContent('.toast:not(.note) .txt').catch(() => null)) ?? '',
  };
  await page.click(chipAt(1));
  await page.waitForTimeout(100);
  const kept = (await page.textContent('.toast:not(.note) .txt').catch(() => null)) ?? '';
  await page.click('.toast:not(.note) button:has-text("元に戻す")');
  const after = await savedWorkspace(page);
  check(
    `#87 AC-12(d) ${tag} 閉じる（確認なし）→ トースト → [元に戻す] で閉じる前と同じ`,
    d.dialogs === 0 &&
      d.chips === 2 &&
      d.toast === 'タブ A（足 2 本）を閉じた' &&
      tabsShape(after) === tabsShape(before),
    `${JSON.stringify(d)}・${tabsShape(after) === tabsShape(before) ? '同じ' : `違う ${tabsShape(after)} / ${tabsShape(before)}`}`,
  );
  check(
    `#87 AC-15(e) ${tag} 「タブを閉じた」のトーストはタブを切り替えても消えず [元に戻す] が効く`,
    kept === d.toast && tabsShape(after) === tabsShape(before),
    kept,
  );

  // (f) タブの切り替え 10 回（クリック）の Long Animation Frame 0 件
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  await page.waitForTimeout(300);
  const m0 = await page.evaluate(() => window.__loaf.length);
  for (let i = 0; i < 10; i++) {
    await page.click(chipAt(i % 3));
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(200);
  const loaf = await page.evaluate((n) => window.__loaf.slice(n).filter((x) => x > 50).length, m0);
  check(
    `#87 AC-12(f) ${tag} タブの切り替え 10 回の Long Animation Frame 0 件`,
    loafOk && loaf === 0,
    loafOk ? `${loaf} 件` : 'observer が使えない',
  );
  await ctx.close();

  // (e) 6 個で ＋ が disabled（title は上限の文）
  {
    const ctx6 = await newContext(vp, { [WORKSPACE_KEY]: busyWorkspace });
    const p6 = await ctx6.newPage();
    await p6.goto(pageUrl('next'));
    await waitReady(p6, 'next');
    const dis = await p6.isDisabled(ADD);
    const title = await p6.getAttribute(ADD, 'title');
    check(
      `#87 AC-12(e) ${tag} 6 個で ＋ が disabled`,
      dis && title === 'タブは 6 個まで',
      `${dis}・${title}`,
    );
    await ctx6.close();
  }
}

async function shareFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const copied = /^コピーした（[0-9,]+ 字）$/;
  const legsOf = (ws) =>
    JSON.stringify(
      (ws?.tabs?.[ws.active]?.position?.legs ?? []).map((l) => [l.side, l.strike, l.qty, l.entry]),
    );
  // タブのメニューと ⋯ の URL をコピー → トースト・クリップボード（#p= があり ui が無い。#91）→ 新しいコンテキストで同じ足。
  // クエリなしで開いたページと、古い ?ui=next で開いたページ（URL をコピーしても ui が付かない = #91 AC-A3(b)）の両方
  for (const entry of ['', OLD_ENTRY_NEXT]) {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const page = await ctx.newPage();
    await page.goto(entryUrl(entry));
    await waitReady(page, 'next');
    const orig = legsOf(await savedWorkspace(page));
    const copy = async (open) => {
      // 前のコピーの結果（トースト・クリップボード）を読まないように空にする
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page
        .waitForSelector('.toast:not(.note)', { state: 'detached', timeout: 6000 })
        .catch(() => {});
      await open();
      const sel = `${menuItem('URL をコピー')}:not([aria-disabled])`;
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      await page
        .waitForFunction(
          () =>
            [...document.querySelectorAll('.toast:not(.note) .txt')].some((t) =>
              t.textContent?.startsWith('コピーした'),
            ),
          undefined,
          { timeout: 5000 },
        )
        .catch(() => {});
      const toast = (await page.textContent('.toast:not(.note) .txt').catch(() => null)) ?? '';
      const url = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      return { toast, url };
    };
    const viaTab = await copy(() => page.click(CHIP));
    const viaMore = await copy(() => page.click('button[aria-label="メニュー"]'));
    // 古い入口で開いたページは ⋯ からだけ（タブのメニューと同じ makeShareUrl）
    const pairs = entry
      ? [[`${entry} で開いたページの ⋯`, viaMore]]
      : [
          ['タブのメニュー', viaTab],
          ['⋯', viaMore],
        ];
    for (const [name, r] of pairs) {
      let opened = '';
      let hasUi = true;
      try {
        hasUi = new URL(r.url).searchParams.has('ui');
        const c2 = await newContext(vp, {});
        const p2 = await c2.newPage();
        await p2.goto(r.url);
        await waitReady(p2, 'next');
        await p2.waitForTimeout(1500);
        opened = legsOf(await savedWorkspace(p2));
        await c2.close();
      } catch (e) {
        opened = `開けない ${e.message}`;
      }
      check(
        `#87 AC-13 ${tag} ${name}の URL をコピー → トースト・#p= があり ui が無い（#91）・開くと同じ足`,
        copied.test(r.toast) && r.url.includes('#p=') && !hasUi && opened === orig,
        `${r.toast}・ui ${hasUi ? 'あり' : 'なし'}・足 ${opened === orig ? '同じ' : `${opened} / ${orig}`}`,
      );
    }
    await ctx.close();
  }

  // クリップボードを拒否 → 「共有の URL」のダイアログに同じ URL が全文選択で出る
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    await ctx.addInitScript(CLIP_REJECT_INIT);
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await page.click(CHIP);
    const sel = `${menuItem('URL をコピー')}:not([aria-disabled])`;
    await page.waitForSelector(sel, { timeout: 5000 });
    await page.click(sel);
    const field = 'dialog.sheet[open] input[aria-label="共有の URL"]';
    await page.waitForSelector(field, { timeout: 5000 }).catch(() => {});
    const r = await page.evaluate((f) => {
      const el = document.querySelector(f);
      const title = document.querySelector('dialog.sheet[open] h2')?.textContent ?? '';
      return el instanceof HTMLInputElement
        ? {
            title,
            same: el.value === window.__clipTried && el.value.includes('#p='),
            all: el.selectionStart === 0 && el.selectionEnd === el.value.length,
            focus: document.activeElement === el,
          }
        : { title, same: false, all: false, focus: false };
    }, field);
    check(
      `#87 AC-13 ${tag} クリップボードを拒否 → 共有の URL のダイアログに同じ URL が全文選択`,
      r.title === '共有の URL' && r.same && r.all && r.focus,
      JSON.stringify(r),
    );
    await ctx.close();
  }

  // #87 (A) のレビュー: 壊れた共有 URL の警告のトースト → タブ 6 個で正しい共有 URL → 確認が出て前の警告は消える
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: busyWorkspace });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await page.evaluate(() => {
      location.hash = '#p=x';
    });
    const warned = await page
      .waitForSelector('.toast.note[data-kind="note-shared"]', { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, share.hash);
    await page.waitForSelector('dialog.sheet[open]', { timeout: 5000 }).catch(() => {});
    const asking = await page.locator('dialog.sheet[open]').count();
    const left = await page.locator('.toast.note[data-kind="note-shared"]').count();
    check(
      `#87 ${tag} 上限で共有を開く確認に入ると前の共有の警告のトーストが消える`,
      warned && asking === 1 && left === 0,
      `警告 ${warned}・確認 ${asking}・残り ${left}`,
    );
    await ctx.close();
  }
}

// ---- #87 (C) の手順（AC-14・AC-19）
const MORE = 'button[aria-label="メニュー"]';
const moreItem = (label) => `header.top > .menu-wrap [role^="menuitem"]:has-text("${label}")`;
const SET = 'dialog.sheet.settings[open]';
const BOOK = 'dialog.sheet.book[open]';
const BOOK_KEY_LS = 'option-simulator.book';

async function openFromMore(page, label, dialogSel) {
  await page.click(MORE);
  await page.click(moreItem(label));
  if (dialogSel) await page.waitForSelector(dialogSel, { timeout: 3000 }).catch(() => {});
}
async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page
    .waitForSelector('dialog.sheet[open]', { state: 'detached', timeout: 3000 })
    .catch(() => {});
}
const focusLabel = (page) =>
  page.evaluate(() => ({
    label: document.activeElement?.getAttribute('aria-label') ?? null,
    selected: document.activeElement?.getAttribute('aria-selected') ?? null,
    cls: document.activeElement?.getAttribute('class') ?? null,
  }));
const bookText = (page) => page.evaluate((k) => localStorage.getItem(k), BOOK_KEY_LS);

// ---- 保有の印（#301 AC18）: 360×780・1440×900 で、保有のタブのチップの印・タブのメニュー・ポジションの ⋯（写しの建て直し・
// 全クリアが押せない）・保存一覧の行の「保有」のタグが切れず折り返さず、ページの縦・横スクロールが 0px
/** 作業のキーのタブ A（足 2 本）に保有の印を付けたもの（fixture は変えない。ここで組み立てる） */
const heldLegs = JSON.stringify({
  ...fixture,
  active: 0,
  tabs: [{ ...fixture.tabs[0], position: { ...fixture.tabs[0].position, held: true } }],
});

/** scope の中で 2 行以上に折り返した文字（measure と同じ規則）と、文字が切れた要素（scrollWidth > clientWidth） */
function scopeWraps(page, scope) {
  return page.evaluate((sel) => {
    const wraps = [];
    const cut = [];
    for (const root of document.querySelectorAll(sel)) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const txt = [...el.childNodes]
          .filter((c) => c.nodeType === 3)
          .map((c) => c.textContent)
          .join('')
          .trim();
        if (!txt) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (lines.size > 1) wraps.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt}」`);
        // 名前は省略（…）してよい（.nm・.bk-name）。それ以外の文字が切れていないか
        const ellipsis = cs.textOverflow === 'ellipsis';
        if (!ellipsis && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible')
          cut.push(`${el.tagName}.${el.getAttribute('class') ?? ''}「${txt}」`);
      }
    }
    return { wraps, cut };
  }, scope);
}

async function heldFlows(vp) {
  const tag = `#301 ${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: heldLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const shot = async (name) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `held-${vp.width}-${name}.png`) });
  };
  const scroll0 = async (what) => {
    const r = await measure(page);
    check(
      `${tag} ${what}: ページの縦・横スクロール 0px`,
      r.v === 0 && r.h === 0,
      `縦 ${r.v} 横 ${r.h}`,
    );
  };
  const ws = () =>
    page.evaluate((k) => {
      try {
        return JSON.parse(localStorage.getItem(k) ?? 'null');
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);

  // (1) 帯のチップ: 文字「保」の印・aria-label に保有。帯の中で折り返さない
  const chip = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    return {
      hd: c?.querySelector('.hd')?.textContent ?? null,
      label: c?.getAttribute('aria-label') ?? '',
    };
  }, CHIP);
  const strip = await scopeWraps(page, '.boxtabs');
  check(
    `${tag} 保有のチップに「保」の印・aria-label に保有、帯の折り返し 0・切れ 0`,
    chip.hd === '保' &&
      chip.label.includes('保有') &&
      strip.wraps.length === 0 &&
      strip.cut.length === 0,
    `${JSON.stringify(chip)}・${[...strip.wraps, ...strip.cut].join(' / ')}`,
  );
  await scroll0('保有のチップ');
  await shot('chip');

  // (2) タブのメニュー: 「保有を外す」。メニューの行が折り返さない・切れない
  await page.click(CHIP);
  await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});
  const menuRows = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((m) => m.textContent),
  );
  const mw = await scopeWraps(page, '[role="menu"]');
  check(
    `${tag} タブのメニューに「保有を外す」・折り返し 0・切れ 0`,
    menuRows.includes('保有を外す') && mw.wraps.length === 0 && mw.cut.length === 0,
    `${menuRows.join('・')}・${[...mw.wraps, ...mw.cut].join(' / ')}`,
  );
  await scroll0('タブのメニュー');
  await shot('tabmenu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // (3) ポジションの ⋯: 全クリアが押せない・「写しを今の板で建て直す」
  if (phoneSize) await setShell(page, 'positions', 'full');
  const P = 'section.positions';
  await page.click(`${P} button[aria-label="ポジションの操作"]`);
  await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((m) => ({
      text: m.textContent,
      off: m.getAttribute('aria-disabled') === 'true',
      title: m.getAttribute('title'),
    })),
  );
  const pw = await scopeWraps(page, '[role="menu"]');
  const clear = items.find((i) => i.text === '全クリア');
  const copy = items.find((i) => i.text === '写しを今の板で建て直す');
  check(
    `${tag} ポジションの ⋯: 全クリアが押せない（理由つき）・「写しを今の板で建て直す」が押せる・折り返し 0`,
    clear?.off === true && !!clear?.title && copy?.off === false && pw.wraps.length === 0,
    `${JSON.stringify(items)}・${pw.wraps.join(' / ')}`,
  );
  await shot('posmenu');
  // 押す → タブが 1 個増えて切り替わる。元のタブの足（建値・建てた日時）は同じ・印が残る。新しいタブは印なし
  const before = await ws();
  await page.click('[role="menuitem"]:has-text("写しを今の板で建て直す")');
  await page.waitForTimeout(800); // 自動保存（500ms の debounce）
  const after = await ws();
  const origBefore = before?.tabs?.[0]?.position;
  const origAfter = after?.tabs?.[0]?.position;
  const toast = await page
    .locator('.toast:not(.note)', { hasText: '写し' })
    .locator('button', { hasText: '元に戻す' })
    .count();
  check(
    `${tag} 写しの建て直し: タブ ${before?.tabs?.length} → ${after?.tabs?.length}・元のタブの足が同じで保有のまま・新しいタブは印なし・[元に戻す] あり`,
    after?.tabs?.length === 2 &&
      after?.active === 1 &&
      JSON.stringify(origAfter?.legs?.map((l) => l.leg)) ===
        JSON.stringify(origBefore?.legs?.map((l) => l.leg)) &&
      origAfter?.held === true &&
      after?.tabs?.[1]?.position?.held === undefined &&
      toast === 1,
    `toast ${toast}`,
  );
  await scroll0('写しの建て直しの後');
  await shot('rebased');
  if (phoneSize) await setShell(page, 'positions', 'hidden');

  // (4) 保有のタブに戻り、保存一覧に保存 → 行に「保有」のタグ。行が切れない・タグが折り返さない
  await page.click('.boxtabs .boxtab:first-child');
  await page.waitForTimeout(150);
  await openFromMore(page, '保存一覧', BOOK);
  await page.fill(`${BOOK} .bk-save input`, '保有の検査');
  await page.click(`${BOOK} .bk-save button:has-text("保存")`);
  await page.waitForTimeout(150);
  const tags = await page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} .bk-row .bk-head`)].map((h) => ({
        tags: [...h.querySelectorAll('.tag')].map((t) => t.textContent),
      })),
    BOOK,
  );
  const bw = await scopeWraps(page, `${BOOK} .bk-head`);
  check(
    `${tag} 保存一覧の行に「保有」「作業中」のタグ・行の見出しの折り返し 0・切れ 0`,
    tags.some((t) => t.tags[0] === '保有' && t.tags.includes('作業中')) &&
      bw.wraps.length === 0 &&
      bw.cut.length === 0,
    `${JSON.stringify(tags)}・${[...bw.wraps, ...bw.cut].join(' / ')}`,
  );
  await scroll0('保存一覧（保有の行）');
  await shot('book');
  await ctx.close();
}

async function bookSettingsFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const seg = (label, text) =>
    `${SET} [role="group"][aria-label="${label}"] button:text-is("${text}")`;
  const atmOf = (t) => /ATM ([0-9,]+)/.exec(t ?? '')?.[1] ?? null;
  // スマホは板のパネルを開いておく（板の ATM 行を見る。開く描画は Long Animation Frame の数に入れない）
  if (phoneSize) await setShell(page, 'board', 'peek');
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  await page.waitForTimeout(300);
  const m0 = await page.evaluate(() => window.__loaf.length);

  // (a) ATM の基準を A → ピル・板の ATM 行・板の脚注が A のもの、保存の atm_basis が A
  const pillBefore = atmOf(await page.getAttribute('.market-pill', 'aria-label'));
  await openFromMore(page, '設定…', SET);
  await page.waitForTimeout(200);
  // 設定を開く（showModal）までは判定に入れる（m0 → m0b）
  const m0b = await page.evaluate(() => window.__loaf.length);
  await page.click(seg('ATM の基準', 'ラージ先物（A）'));
  await page.waitForTimeout(150);
  const a = await page.evaluate(() => ({
    pill: document.querySelector('.market-pill')?.getAttribute('aria-label') ?? '',
    foot: document.querySelector('section.board .board-foot .atm')?.textContent ?? '',
    row: document.querySelector('section.board tr.atm .kv')?.textContent ?? '',
  }));
  const wsA = await savedWorkspace(page);
  const pillA = atmOf(a.pill);
  check(
    `#87 AC-14(a) ${tag} 設定の ATM の基準を A → ピル・板の ATM 行・脚注が A、保存の atm_basis が A`,
    !!pillA &&
      pillA !== pillBefore &&
      a.foot === `ATM ${pillA}（A）` &&
      a.row === pillA &&
      wsA?.ui?.atm_basis === 'A',
    `ピル ${pillBefore} → ${pillA}・脚注 ${a.foot}・行 ${a.row}・保存 ${wsA?.ui?.atm_basis}`,
  );

  // ATM の基準の切替（m0b → m1）は参考。X₀（横軸の原点）が変わり損益の全体を作り直す（旧画面の Header の切替と同じ計算。
  // #87 (C) で足したものではない）ので、Long Animation Frame は参考として出し、判定は設定を開く + (b)・(c) で行う
  await page.waitForTimeout(200);
  const m1 = await page.evaluate(() => window.__loaf.length);
  const loafAtm = await page.evaluate(
    ([a, b]) =>
      window.__loaf
        .slice(a, b)
        .filter((x) => x > 50)
        .map(Math.round),
    [m0b, m1],
  );
  console.log(
    `参考  #87 ${tag} 設定の ATM の基準の切替の Long Animation Frame（50ms 超）${loafAtm.length} 件${loafAtm.length ? `（${loafAtm.join('・')}ms）` : ''}`,
  );

  // (b) 金額の単位を 円 → 指標の見出しの副題が 円（固定）、保存の metrics_unit が yen
  await page.click(seg('金額の単位', '円'));
  await page.waitForTimeout(100);
  const sub = (await page.textContent('section.metrics .panel-head')) ?? '';
  const wsB = await savedWorkspace(page);
  check(
    `#87 AC-14(b) ${tag} 単位を 円 → 指標の副題が 円（固定）・保存の metrics_unit が yen`,
    sub.includes('円（固定）') && wsB?.ui?.metrics_unit === 'yen',
    `${sub}・${wsB?.ui?.metrics_unit}`,
  );

  // (c) 手数料 300 → 保存 300、abc → alert・保存は 300 のまま（内訳の注記は閉じた後に見る）
  await page.fill(`${SET} input#set-fee`, '300');
  const wsC1 = await savedWorkspace(page);
  await page.fill(`${SET} input#set-fee`, 'abc');
  const alert = (await page.textContent(`${SET} .set-row [role="alert"]`).catch(() => null)) ?? '';
  const wsC2 = await savedWorkspace(page);

  // (d) #275: 別の入口がある行（縦軸・先物の basis・ΔX の単位）が設定に無い。テーマはスマホだけ（☾ を隠す幅の入口）
  const gone = await page.evaluate(
    (q) =>
      [...(document.querySelector(q)?.querySelectorAll('[role="group"]') ?? [])].map((g) =>
        g.getAttribute('aria-label'),
      ),
    SET,
  );
  check(
    `#275 ${tag} 設定に 縦軸・先物の basis・ΔX の単位が無く、テーマは${phoneSize ? 'ある（スマホ）' : '無い'}`,
    !gone.some((g) => ['縦軸', '先物の basis', 'ΔX の単位'].includes(g)) &&
      gone.includes('テーマ') === phoneSize,
    JSON.stringify(gone),
  );
  await closeDialog(page);
  const fSet = await focusLabel(page);
  const loafSet = await page.evaluate(
    ([a, b, c]) =>
      [...window.__loaf.slice(a, b), ...window.__loaf.slice(c)].filter((x) => x > 50).length,
    [m0, m0b, m1],
  );

  // (d) 縦軸（#275 で設定から舞台の ⋯ へ）: 舞台の ⋯ で ±N 倍 → 押された表示・保存の pnl_y.mode
  await page.click('section.stage button[aria-label="グラフの設定"]');
  await page.waitForSelector('section.stage .stage-pop', { timeout: 3000 }).catch(() => {});
  await page.click('section.stage .stage-pop [aria-label="縦軸"] button:text-is("±N 倍")');
  await page.waitForTimeout(100);
  const stageY = await page.evaluate(
    () =>
      document.querySelector(
        'section.stage .stage-pop [aria-label="縦軸"] button[aria-pressed="true"]',
      )?.textContent ?? null,
  );
  const wsD = await savedWorkspace(page);
  await page.keyboard.press('Escape');
  check(
    `#87 AC-14(d)・#275 ${tag} 舞台の ⋯ の縦軸を ±N 倍 → 押された表示・保存の pnl_y.mode が premium`,
    stageY === '±N 倍' && wsD?.ui?.pnl_y?.mode === 'premium',
    `${stageY}・${wsD?.ui?.pnl_y?.mode}`,
  );

  // (f) テーマをライト（#275: スマホは設定のテーマ、PC は ☾）→ html[data-theme="light"]・prefs
  if (phoneSize) {
    await openFromMore(page, '設定…', SET);
    await page.click(seg('テーマ', 'ライト'));
    await page.waitForTimeout(100);
    await closeDialog(page);
  } else {
    await page.click('button[aria-label="テーマ"]');
    await page.click('[role="menuitemradio"]:has-text("ライト")');
    await page.waitForTimeout(100);
  }
  const th = await page.evaluate((k) => {
    let prefs = null;
    try {
      prefs = JSON.parse(localStorage.getItem(k) ?? 'null')?.theme ?? null;
    } catch {}
    return { attr: document.documentElement.dataset.theme ?? null, prefs };
  }, PREFS_KEY);
  check(
    `#87 AC-14(f)・#275 ${tag} テーマをライト（${phoneSize ? '設定' : '☾'}）→ html[data-theme="light"]・prefs の theme が light`,
    th.attr === 'light' && th.prefs === 'light',
    JSON.stringify(th),
  );

  // (c) の続き: 内訳の注記に 手数料 300 円 / 枚
  if (phoneSize) await setShell(page, 'metrics', 'peek');
  await page.click('section.metrics .mx-toggle');
  await page.waitForTimeout(100);
  const note = (await page.textContent('section.metrics .mx-note').catch(() => null)) ?? '';
  check(
    `#87 AC-14(c) ${tag} 手数料 300 → 内訳の注記に 手数料 300 円 / 枚・保存 300、abc → alert・保存は 300 のまま`,
    note.includes('手数料 300 円 / 枚') &&
      wsC1?.ui?.fee_per_lot === 300 &&
      alert === '手数料は 0〜100,000 円 / 枚' &&
      wsC2?.ui?.fee_per_lot === 300,
    `${note}・${wsC1?.ui?.fee_per_lot}・${alert}・${wsC2?.ui?.fee_per_lot}`,
  );
  if (phoneSize) await setShell(page, 'metrics', 'hidden');
  check(
    `#87 AC-14 ${tag} 設定を Esc で閉じると ⋯ へフォーカスが戻る`,
    fSet.label === 'メニュー',
    JSON.stringify(fSet),
  );
  check(
    `#87 AC-17 ${tag} 設定を開く・2 つの変更（単位・手数料。#275 で縦軸・basis・テーマは設定から外した）の Long Animation Frame 0 件`,
    loafOk && loafSet === 0,
    loafOk ? `${loafSet} 件` : 'observer が使えない',
  );

  // (g) ⋯ > 保存一覧… → [保存] → 行が 1 件増える → [上書き]（確認なし）→ トースト → [元に戻す] → バイト単位で同じ
  await openFromMore(page, '保存一覧', BOOK);
  const rows = () => page.locator(`${BOOK} .bk-row`).count();
  const r0 = await rows();
  await page.fill(`${BOOK} .bk-save input`, '検査 A');
  await page.click(`${BOOK} .bk-save button:has-text("保存")`);
  await page.waitForTimeout(100);
  const r1 = await rows();
  const before = await bookText(page);
  await page.click(`${BOOK} button[aria-label="検査 A を作業中の内容で上書き"]`);
  await page.waitForTimeout(100);
  const g = {
    confirm: await page.locator(`${BOOK} .bk-confirm`).count(),
    toast: (await page.textContent(`${BOOK} .toast:not(.note) .txt`).catch(() => null)) ?? '',
    changed: (await bookText(page)) !== before,
  };
  // トーストはダイアログの中（押せる）: 中心の点の要素がトーストの中
  const hit = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    const b = t?.getBoundingClientRect();
    if (!b) return false;
    const el = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    return !!el && t.contains(el);
  }, `${BOOK} .toast:not(.note)`);
  await page.click(`${BOOK} .toast:not(.note) button:has-text("元に戻す")`);
  await page.waitForTimeout(100);
  const restored = (await bookText(page)) === before;
  check(
    `#87 AC-14(g) ${tag} 保存で行が 1 件増え、[上書き] は確認なしでトースト → [元に戻す] で保存一覧がバイト単位で同じ`,
    r1 === r0 + 1 &&
      g.confirm === 0 &&
      g.toast === '「検査 A」を上書きした' &&
      g.changed &&
      hit &&
      restored,
    `${r0} → ${r1}・${JSON.stringify(g)}・押せる ${hit}・戻った ${restored}`,
  );

  // (h) [削除] は行の中の確認を経て消える、[開く]・[新しいタブで開く]・[重ねる] で閉じて反映される
  await page.click(`${BOOK} button[aria-label="検査 A を削除"]`);
  const askDel = await page.locator(`${BOOK} .bk-confirm`).count();
  const rAsk = await rows();
  await page.click(`${BOOK} .bk-confirm button:has-text("削除")`);
  await page.waitForTimeout(100);
  const rDel = await rows();
  await page.fill(`${BOOK} .bk-save input`, '検査 B');
  await page.click(`${BOOK} .bk-save button:has-text("保存")`);
  await page.waitForTimeout(100);
  await page.click(`${BOOK} button[aria-label="検査 B を開く"]`);
  await page.waitForTimeout(150);
  const hOpen = await page.locator('dialog.sheet[open]').count();
  const tabs0 = (await savedWorkspace(page))?.tabs?.length;
  await openFromMore(page, '保存一覧', BOOK);
  await page.click(`${BOOK} button[aria-label="検査 B を新しいタブで開く"]`);
  await page.waitForTimeout(150);
  const hNew = await page.locator('dialog.sheet[open]').count();
  const wsNew = await savedWorkspace(page);
  await openFromMore(page, '保存一覧', BOOK);
  await page.click(`${BOOK} button[aria-label="検査 B を損益グラフに重ねる"]`);
  await page.waitForTimeout(150);
  const hPin = await page.locator('dialog.sheet[open]').count();
  const pins = await page.locator('section.stage .pin-chip').count();
  check(
    `#87 AC-14(h) ${tag} [削除] は行の中の確認の後に消え、[開く]・[新しいタブで開く]・[重ねる] で閉じて反映`,
    askDel === 1 &&
      rAsk === 1 &&
      rDel === 0 &&
      hOpen === 0 &&
      hNew === 0 &&
      wsNew?.tabs?.length === (tabs0 ?? 0) + 1 &&
      wsNew?.tabs?.[wsNew.active]?.position?.legs?.length === 2 &&
      hPin === 0 &&
      pins === 1,
    `確認 ${askDel}・${rAsk} → ${rDel}・開く ${hOpen}・新しいタブ ${hNew}（${tabs0} → ${wsNew?.tabs?.length}）・重ねる ${hPin}（ピン ${pins}）`,
  );

  // Esc で閉じると開く前のボタンへ: ⋯ > 保存一覧… → ⋯、タブのメニューの 保存一覧に保存… → 名前の欄 → チップ
  await openFromMore(page, '保存一覧', BOOK);
  await closeDialog(page);
  const fBook = await focusLabel(page);
  await page.click(CHIP);
  await page.click(menuItem('保存一覧に保存…'));
  await page.waitForSelector(BOOK, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(100);
  const fName = await focusLabel(page);
  await closeDialog(page);
  const fChip = await focusLabel(page);
  check(
    `#87 AC-14 ${tag} 保存一覧を Esc で閉じると ⋯ へ、タブのメニューの 保存一覧に保存… は名前の欄 → Esc でチップへ`,
    fBook.label === 'メニュー' && fName.cls === 'bk-input' && fChip.selected === 'true',
    `${JSON.stringify(fBook)}・${JSON.stringify(fName)}・${JSON.stringify(fChip)}`,
  );

  // (i) #275: 書き出し / 読み込み… は保存一覧のダイアログだけ。[書き出し] → ダウンロード + 知らせ、[読み込み…] で
  // そのファイル → 知らせ（ダイアログの中の .bk-msg）
  const n = JSON.parse((await bookText(page)) ?? '{"entries":[]}').entries.length;
  await openFromMore(page, '保存一覧', BOOK);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click(`${BOOK} button:text-is("書き出し")`),
  ]);
  const file = await download.path();
  await page.waitForTimeout(100);
  const exMsg = (await page.textContent(`${BOOK} .bk-msg`).catch(() => null)) ?? '';
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.click(`${BOOK} label.bk-file`),
  ]);
  await chooser.setFiles(file);
  await page
    .waitForFunction(
      (q) => /件を追加/.test(document.querySelector(q)?.textContent ?? ''),
      `${BOOK} .bk-msg`,
      { timeout: 3000 },
    )
    .catch(() => {});
  const imMsg = (await page.textContent(`${BOOK} .bk-msg`).catch(() => null)) ?? '';
  const n2 = JSON.parse((await bookText(page)) ?? '{"entries":[]}').entries.length;
  const moreRows = await (async () => {
    await closeDialog(page);
    await page.click(MORE);
    const t = await page.$$eval('[role="menu"] [role^="menuitem"]', (els) =>
      els.map((e) => e.textContent?.trim() ?? ''),
    );
    await page.keyboard.press('Escape');
    return t;
  })();
  check(
    `#87 AC-14(i)・#275 ${tag} 保存一覧の [書き出し] でダウンロードと知らせ、[読み込み…] でそのファイルを入れると知らせ。⋯ に書き出し / 読み込み… が無い`,
    !!file &&
      exMsg === `${n} 件を書き出した` &&
      imMsg === `${n} 件を追加` &&
      n2 === n * 2 &&
      download.suggestedFilename().startsWith('option-simulator-positions-') &&
      !moreRows.some((t) => t === '書き出し' || t === '読み込み…'),
    `${exMsg}・${imMsg}・${n} → ${n2}・${download.suggestedFilename()}・⋯ ${moreRows.join(' / ')}`,
  );
  await ctx.close();
}

// ---- 面モードの表示の手順（#88 段 A AC-12・AC-14）

/**
 * canvas.surface の画素を読む: 描画域（.chart > svg .grid の横線の x1〜x2・縦線の y1〜y2。CSS px）を device px に
 * 直し、(a) 中の不透明度 > 0 の画素の数（2 device px おき）と外の画素（描画域を 1 CSS px 広げた外、2 device px おき）の
 * 不透明度 > 0 の数、(b) 中を 16 CSS px おきに読んだ画素（RGBA と位置）、テーマの --gain / --loss の RGB
 */
function surfacePixels(page) {
  return page.evaluate(() => {
    const chart = document.querySelector('section.stage .chart');
    const cv = chart?.querySelector(':scope > canvas.surface');
    if (!chart || !cv) return null;
    const cr = chart.getBoundingClientRect();
    const vr = cv.getBoundingClientRect();
    const lines = [...chart.querySelectorAll(':scope > svg .grid line')].map((l) => ({
      x1: Number(l.getAttribute('x1')),
      x2: Number(l.getAttribute('x2')),
      y1: Number(l.getAttribute('y1')),
      y2: Number(l.getAttribute('y2')),
    }));
    const hz = lines.filter((l) => l.y1 === l.y2);
    const vt = lines.filter((l) => l.x1 === l.x2);
    if (!hz.length || !vt.length) return null;
    const plot = {
      left: Math.min(...hz.map((l) => Math.min(l.x1, l.x2))),
      right: Math.max(...hz.map((l) => Math.max(l.x1, l.x2))),
      top: Math.min(...vt.map((l) => Math.min(l.y1, l.y2))),
      bottom: Math.max(...vt.map((l) => Math.max(l.y1, l.y2))),
    };
    const sx = cv.width / vr.width;
    const sy = cv.height / vr.height;
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const at = (x, y) => {
      const o = (y * cv.width + x) * 4;
      return [img[o], img[o + 1], img[o + 2], img[o + 3]];
    };
    const X0 = Math.round(plot.left * sx);
    const X1 = Math.round(plot.right * sx);
    const Y0 = Math.round(plot.top * sy);
    const Y1 = Math.round(plot.bottom * sy);
    let inside = 0;
    for (let y = Y0; y < Y1; y += 2) for (let x = X0; x < X1; x += 2) if (at(x, y)[3] > 0) inside++;
    const oX0 = Math.floor((plot.left - 1) * sx);
    const oX1 = Math.ceil((plot.right + 1) * sx);
    const oY0 = Math.floor((plot.top - 1) * sy);
    const oY1 = Math.ceil((plot.bottom + 1) * sy);
    let outside = 0;
    let outsideN = 0;
    for (let y = 0; y < cv.height; y += 2) {
      for (let x = 0; x < cv.width; x += 2) {
        if (x >= oX0 && x < oX1 && y >= oY0 && y < oY1) continue;
        outsideN++;
        if (at(x, y)[3] > 0) outside++;
      }
    }
    const samples = [];
    for (let y = plot.top + 8; y < plot.bottom; y += 16) {
      for (let x = plot.left + 8; x < plot.right; x += 16) {
        const px = Math.round(x * sx);
        const py = Math.round(y * sy);
        samples.push({ x: px, y: py, c: at(px, py) });
      }
    }
    const cs = getComputedStyle(document.documentElement);
    const hex = (v) => {
      const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
      return m ? [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16)) : null;
    };
    return {
      rect: {
        canvas: [vr.left, vr.top, vr.width, vr.height],
        chart: [cr.left, cr.top, cr.width, cr.height],
      },
      backing: [cv.width, cv.height],
      plot,
      inside,
      outside,
      outsideN,
      samples,
      gain: hex(cs.getPropertyValue('--gain')),
      loss: hex(cs.getPropertyValue('--loss')),
    };
  });
}

/** (b) の判定: 不透明度が最大の画素の RGB が gain か loss と各成分 ±8、gain に近い画素と loss に近い画素が両方ある */
function surfaceColorJudge(px) {
  if (!px?.gain || !px.loss) return { ok: false, detail: '色のトークンが読めない' };
  const dist = (c, t) => Math.max(...[0, 1, 2].map((i) => Math.abs(c[i] - t[i])));
  const lit = px.samples.filter((s) => s.c[3] > 0);
  let top = null;
  for (const s of lit) if (!top || s.c[3] > top.c[3]) top = s;
  const near = (s) => (dist(s.c, px.gain) <= dist(s.c, px.loss) ? 'gain' : 'loss');
  const kinds = new Set(lit.map(near));
  const dTop = top
    ? Math.min(dist(top.c, px.gain), dist(top.c, px.loss))
    : Number.POSITIVE_INFINITY;
  const ok = !!top && dTop <= 8 && kinds.has('gain') && kinds.has('loss');
  return {
    ok,
    top,
    detail: `最大の不透明度 ${top?.c[3] ?? '—'}・RGB ${top ? top.c.slice(0, 3).join(',') : '—'}（${top ? near(top) : '—'} との差 ${dTop}）・gain ${px.gain.join(',')} / loss ${px.loss.join(',')}・近い色 ${[...kinds].join(' / ')}（${lit.length} / ${px.samples.length} 点）`,
  };
}

const firstNumber = (t) => {
  const m = /[+−-]?[0-9][0-9,]*(\.[0-9]+)?/.exec(t ?? '');
  return m ? Number(m[0].replace('−', '-').replace(/,/g, '')) : Number.NaN;
};

async function surfaceFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const box = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const drag = async (from, dx, dy, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
  };
  // 始めにシナリオを 0 に
  await page.focus('.chart');
  await page.keyboard.press('0');
  const inRow = await page.locator('.stage-tools .cm .seg').isVisible();
  check(
    `#88 AC-12 ${tag} [線 | 面] の置き場所（${phoneSize ? '⋯ の中' : '凡例行'}）`,
    inRow === !phoneSize,
  );
  await toSurface(page);
  await page.waitForTimeout(150);

  // (a) canvas の矩形・描画域の中 / 外の画素・線 / BEP / 交点のラベルが無い
  const px0 = await surfacePixels(page);
  {
    const els = await page.evaluate(() => {
      const c = document.querySelector('section.stage .chart');
      const n = (sel) => c?.querySelectorAll(sel).length ?? -1;
      return {
        ln: n('path.ln'),
        bep: n('.bep'),
        xpt: n('.xpt'),
        lbl: n('.xpt-lbl'),
        pin: n('.ln-pin'),
        fill: n('.fill-gain, .fill-loss'),
        zero: n('.zero'),
      };
    });
    const same = !!px0 && px0.rect.canvas.every((v, i) => Math.abs(v - px0.rect.chart[i]) <= 1);
    check(
      `#88 AC-12(a) ${tag} canvas.surface の矩形が .chart と ±1px・描画域の中に不透明度 > 0 の画素・外はすべて 0・線 / BEP / 交点が無い`,
      same && px0.inside > 0 && px0.outside === 0 && Object.values(els).every((v) => v === 0),
      px0
        ? `canvas ${px0.rect.canvas.map((v) => v.toFixed(1)).join(',')} / chart ${px0.rect.chart.map((v) => v.toFixed(1)).join(',')}・backing ${px0.backing.join('×')}・中 ${px0.inside}・外 ${px0.outside} / ${px0.outsideN}・${JSON.stringify(els)}`
        : 'canvas が無い',
    );
  }
  // (b) 色（ダーク）
  const judgeDark = surfaceColorJudge(px0);
  check(
    `#88 AC-12(b) ${tag} ダーク: 色が --gain / --loss（中央が利益・両側が損失）`,
    judgeDark.ok,
    judgeDark.detail,
  );

  // (c) → と ] → ΔX +100・d +1、点が動き、ラベルの金額と読み取りの「損益 · 指定日」が丸め以内で一致
  {
    const pos = () =>
      page.evaluate(() => {
        const h = document.querySelector('.chart .handle');
        return h ? [Number(h.getAttribute('cx')), Number(h.getAttribute('cy'))] : null;
      });
    const a = await pos();
    await page.focus('.chart');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press(']');
    await page.waitForTimeout(150);
    const b = await pos();
    const lbl = (await page.textContent('.chart text.surf-lbl').catch(() => null)) ?? '';
    const ro = (await page.textContent('.ro[data-ro="date"] .v').catch(() => null)) ?? '';
    const thousand = lbl.includes('千円');
    const tol = thousand ? 0.1 : 1;
    const la = firstNumber(lbl);
    const ra = firstNumber(ro);
    // 自動保存（500ms の debounce）を待って保存した scenario を読む
    await page.waitForTimeout(600);
    const sc = await page.evaluate((k) => {
      try {
        const w = JSON.parse(localStorage.getItem(k) ?? 'null');
        return w?.tabs?.[w.active]?.position?.scenario ?? null;
      } catch {
        return null;
      }
    }, WORKSPACE_KEY);
    const moved = !!a && !!b && a[0] !== b[0] && a[1] !== b[1];
    check(
      `#88 AC-12(c) ${tag} → と ] で ΔX +100・d +1、点の cx / cy が動き、ラベルの金額が読み取りと丸め（${thousand ? '千円 0.1' : '円 1'}）以内`,
      moved &&
        sc?.dX === 100 &&
        sc?.days === 1 &&
        Number.isFinite(la) &&
        Math.abs(la - ra) <= tol + 1e-9 &&
        lbl.includes('d 1'),
      `点 ${JSON.stringify(a)} → ${JSON.stringify(b)}・ラベル「${lbl}」・読み取り「${ro}」・保存 ${JSON.stringify({ dX: sc?.dX, days: sc?.days })}`,
    );
  }

  // (d) IV レールのつまみを上に 40px → 同じ画素（前に不透明度が最大だった画素）の色が変わる
  {
    const before = await surfacePixels(page);
    const k = await box('.ivrail .knob');
    await drag(k, 0, -40, 10);
    await page.waitForTimeout(300);
    const after = await surfacePixels(page);
    const jb = surfaceColorJudge(before);
    const t = jb.top;
    const sameAt = t ? after?.samples.find((s) => s.x === t.x && s.y === t.y) : null;
    const changed = !!t && !!sameAt && sameAt.c.some((v, i) => v !== t.c[i]);
    const nChanged =
      before && after
        ? after.samples.filter((s, i) => s.c.some((v, j) => v !== before.samples[i]?.c[j])).length
        : 0;
    check(
      `#88 AC-12(d) ${tag} IV レールを上に 40px → 同じ画素の色が変わる`,
      changed,
      `画素 (${t?.x}, ${t?.y}) ${t?.c.join(',')} → ${sameAt?.c.join(',')}・変わった点 ${nChanged} / ${after?.samples.length ?? 0}`,
    );
    await page.focus('.chart');
    await page.keyboard.press('0');
    await page.waitForTimeout(200);
  }

  // AC-14 [A]: 面モードで IV レール 30 回・時間レール 30 回・ホイール 20 回・横ホイール 30 回の長いフレーム 0 件
  {
    const loafs = [];
    const run = async (name, fn) => {
      await page.waitForTimeout(250);
      const m = await loafMark();
      await fn();
      await page.waitForTimeout(200);
      const n = await loafSince(m);
      loafs.push(`${name} ${n}`);
      check(
        `#88 AC-14 ${tag} 面モードの${name}で長いフレーム 0 件`,
        loafOk && n === 0,
        loafOk ? `${n} 件` : '未対応',
      );
    };
    await run('IV レールのドラッグ 30 回', async () => {
      const k = await box('.ivrail .knob');
      await drag(k, 0, -30, 30);
    });
    await run('時間レールのドラッグ 30 回', async () => {
      const k = await box('.timerail .knob');
      await drag(k, 60, 0, 30);
    });
    const c = await box('.chart');
    const at = { x: c.b.x + c.b.width * 0.4, y: c.b.y + c.b.height * 0.4 };
    await run('ホイールの拡大縮小 20 回', async () => {
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < 20; i++) {
        await page.mouse.wheel(0, i < 10 ? -60 : 60);
        await page.waitForTimeout(16);
      }
    });
    await run('横ホイールのパン 30 回', async () => {
      await page.mouse.move(at.x, at.y);
      for (let i = 0; i < 30; i++) {
        await page.mouse.wheel(i < 15 ? 30 : -30, 0);
        await page.waitForTimeout(16);
      }
    });
    console.log(`      ${tag} 面モードの Long Animation Frame（50ms 超）: ${loafs.join('・')}`);
    await page.focus('.chart');
    await page.keyboard.press('0');
    await page.keyboard.press('r');
    await page.waitForTimeout(200);
  }

  // (b) ライト: テーマをライトにして同じ判定（#275: PC・タブレットは ☾、スマホは設定のテーマ）
  {
    if (phoneSize) {
      await openFromMore(page, '設定…', SET);
      await page.click(`${SET} [role="group"][aria-label="テーマ"] button:text-is("ライト")`);
      await closeDialog(page);
    } else {
      await page.click('button[aria-label="テーマ"]');
      await page.click('[role="menuitemradio"]:has-text("ライト")');
    }
    await page.waitForTimeout(300);
    const px = await surfacePixels(page);
    const j = surfaceColorJudge(px);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    check(
      `#88 AC-12(b) ${tag} ライト: 色がライトの --gain / --loss`,
      theme === 'light' && j.ok && !!px && px.gain?.join() !== px0?.gain?.join(),
      `${theme}・${j.detail}`,
    );
  }

  // (f) 390: シート full（ミニ）は面モードでも線・canvas なし、peek に戻すと面
  if (phoneSize) {
    await setShell(page, 'positions', 'full');
    await page.waitForTimeout(150);
    const mini = await page.evaluate(() => ({
      ln: document.querySelectorAll('.chart.mini path.ln').length,
      cv: document.querySelectorAll('.chart > canvas.surface').length,
    }));
    await setShell(page, 'positions', 'peek');
    await page.waitForTimeout(200);
    const back = await page.evaluate(
      () => document.querySelectorAll('.chart > canvas.surface').length,
    );
    check(
      `#88 AC-12(f) ${tag} シート full（ミニ）は線（canvas なし）、peek に戻すと面`,
      mini.ln > 0 && mini.cv === 0 && back === 1,
      `${JSON.stringify(mini)}・peek の canvas ${back}`,
    );
  }

  // (e) 線に戻すと canvas が無く線がある
  {
    await toSurface(page, '線');
    const r = await page.evaluate(() => ({
      cv: document.querySelectorAll('.chart > canvas.surface').length,
      ln: document.querySelectorAll('.chart path.ln').length,
    }));
    check(
      `#88 AC-12(e) ${tag} 線に戻すと canvas なし・線あり`,
      r.cv === 0 && r.ln > 0,
      JSON.stringify(r),
    );
  }

  // (g) 面にしてから再読み込み → 線
  {
    await toSurface(page);
    const on = await page.evaluate(
      () => document.querySelectorAll('.chart > canvas.surface').length,
    );
    await page.reload();
    await waitReady(page, 'next');
    const r = await page.evaluate(() => ({
      cv: document.querySelectorAll('.chart > canvas.surface').length,
      ln: document.querySelectorAll('.chart path.ln').length,
    }));
    check(
      `#88 AC-12(g) ${tag} 再読み込みで線モード`,
      on === 1 && r.cv === 0 && r.ln > 0,
      `再読み込み前の canvas ${on}・${JSON.stringify(r)}`,
    );
  }
  await ctx.close();
}

/** 参考（判定に入れる）: DPR 2 の 1440×900 で canvas の backing が CSS px × 2 */
async function surfaceDprFlow() {
  const localStorage = [{ name: WORKSPACE_KEY, value: twoLegs }];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: REDUCED_MOTION,
    storageState: { cookies: [], origins: [{ origin, localStorage }] },
  });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await toSurface(page);
  const r = await page.evaluate(() => {
    const cv = document.querySelector('.chart > canvas.surface');
    const b = cv?.getBoundingClientRect();
    return cv && b ? { w: cv.width, h: cv.height, cw: b.width, ch: b.height } : null;
  });
  const px = await surfacePixels(page);
  check(
    '#88 参考 1440x900 DPR 2: canvas の backing が CSS px × 2・描画域の外は 0',
    !!r &&
      r.w === Math.round(r.cw * 2) &&
      r.h === Math.round(r.ch * 2) &&
      !!px &&
      px.inside > 0 &&
      px.outside === 0,
    `${JSON.stringify(r)}・中 ${px?.inside}・外 ${px?.outside}`,
  );
  await ctx.close();
}

/** 保存した作業の、作業中のタブの scenario（自動保存の 500ms の debounce を待つ） */
async function savedScenario(page) {
  await page.waitForTimeout(700);
  return page.evaluate((k) => {
    try {
      const w = JSON.parse(localStorage.getItem(k) ?? 'null');
      return w?.tabs?.[w.active]?.position?.scenario ?? null;
    } catch {
      return null;
    }
  }, WORKSPACE_KEY);
}

/** 横軸の目盛りの文字（表示範囲の判定。表示範囲は保存されないので目盛りで見る） */
const xTickTexts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section.stage .chart .ax .tick-x')].map((t) => t.textContent),
  );
const tickNum = (t) => Number(String(t ?? '').replace(/,/g, ''));

/** 面の点（●）の中心（ページの座標） */
async function surfaceDot(page) {
  const b = await page.locator('section.stage .chart circle.handle').first().boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
}

/**
 * #88 段 B（AC-13 (a)〜(e)・AC-14 [B]）: 面の上のドラッグで ΔX と d が同時に動く・離れた所のクリックでそこへ・
 * 表示範囲は変わらない・線モードは横だけ・足マーカーのタップは今のまま。
 */
async function surfaceDragFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const loafMark = () => page.evaluate(() => window.__loaf.length);
  const loafSince = (i) =>
    page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50).length, i);
  const aria = (sel, attr = 'aria-valuenow') =>
    page.evaluate(([s, a]) => Number(document.querySelector(s)?.getAttribute(a)), [sel, attr]);
  const drag = async (from, dx, dy, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
  };
  await page.focus('.chart');
  await page.keyboard.press('0');
  await toSurface(page);
  await page.waitForTimeout(150);
  const ticks0 = await xTickTexts(page);
  const maxDays = await aria('.timerail', 'aria-valuemax');

  // (a) ● から右に 60px・上に 40px（30 steps）→ ΔX（10 円の倍数）と d（1 以上の整数か maxDays）が同時に
  {
    const dot = await surfaceDot(page);
    if (!dot) throw new Error('面の点が無い');
    await page.waitForTimeout(250);
    const mark = await loafMark();
    await drag(dot, 60, -40, 30);
    await page.waitForTimeout(200);
    const lf = await loafSince(mark);
    const sc = await savedScenario(page);
    const now = await aria('.timerail');
    const sub = (await page.textContent('.ro[data-ro="date"] .s').catch(() => null)) ?? '';
    const dX = sc?.dX ?? 0;
    const d = sc?.days ?? -1;
    const live = await page.locator('section.stage .chart.live').count();
    check(
      `#88 AC-13(a) ${tag} 面の ● を右 60px・上 40px → ΔX ${dX}・d ${d}（時間レール ${now}・副題と同じ）`,
      dX !== 0 &&
        dX % 10 === 0 &&
        ((Number.isInteger(d) && d >= 1) || d === maxDays) &&
        d === now &&
        sub.includes(`(${signedText(dX)}/`) &&
        live === 0,
      `副題「${sub}」・.live ${live}`,
    );
    check(
      `#88 AC-14 ${tag} 面の上のドラッグ 30 回の move で長いフレーム 0 件`,
      loafOk && lf === 0,
      loafOk ? `${lf} 件` : '未対応',
    );
    console.log(`      ${tag} 面の上のドラッグの Long Animation Frame（50ms 超）: ${lf}`);
  }

  // (b) 点から 100px 以上離れた描画域の点をクリック → ΔX・d がその位置の値へ（● がクリックの位置へ）
  {
    const before = await savedScenario(page);
    const dot = await surfaceDot(page);
    const g = await page.locator('section.stage .chart g.grid').first().boundingBox();
    const xs = await page.evaluate(() =>
      [...document.querySelectorAll('section.stage .chart .ax .tick-x')].map((t) => {
        const r = t.getBoundingClientRect();
        return [Number((t.textContent ?? '').replace(/,/g, '')), (r.left + r.right) / 2];
      }),
    );
    if (!dot || !g || xs.length < 2) throw new Error('描画域・目盛りが無い');
    const [[v1, p1], [v2, p2]] = [xs[0], xs[xs.length - 1]];
    const pxPerYen = Math.abs(p2 - p1) / Math.abs(v2 - v1);
    const pxPerDay = g.height / maxDays;
    const fx = dot.x > g.x + g.width / 2 ? 0.2 : 0.65;
    const fy = dot.y > g.y + g.height / 2 ? 0.25 : 0.7;
    const at = { x: g.x + g.width * fx, y: g.y + g.height * fy };
    const far = Math.hypot(at.x - dot.x, at.y - dot.y);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(150);
    const sc = await savedScenario(page);
    const moved = await surfaceDot(page);
    const ex = moved ? Math.abs(moved.x - at.x) : Number.POSITIVE_INFINITY;
    const ey = moved ? Math.abs(moved.y - at.y) : Number.POSITIVE_INFINITY;
    check(
      `#88 AC-13(b) ${tag} 点から ${far.toFixed(0)}px 離れた位置のクリック → ΔX ${before?.dX} → ${sc?.dX}・d ${before?.days} → ${sc?.days}、● がその位置（横 ${ex.toFixed(1)} ≤ ${(pxPerYen * 10 + 1).toFixed(1)}・縦 ${ey.toFixed(1)} ≤ ${(pxPerDay / 2 + 1).toFixed(1)}）`,
      far >= 100 &&
        sc?.dX !== before?.dX &&
        sc?.days !== before?.days &&
        ex <= pxPerYen * 10 + 1 &&
        ey <= pxPerDay / 2 + 1,
    );
  }

  // (c) ドラッグ・クリックの前後で表示範囲（横軸の目盛り）が同じ
  {
    const ticks1 = await xTickTexts(page);
    check(
      `#88 AC-13(c) ${tag} 面の 1 本のドラッグ・クリックで表示範囲（横軸の目盛り）が変わらない`,
      ticks0.length > 1 && JSON.stringify(ticks0) === JSON.stringify(ticks1),
      `${ticks0.join(' ')} → ${ticks1.join(' ')}`,
    );
  }

  // (d) 線モード: d = 3 にしてハンドルを右 60px・上 40px → ΔX だけ変わり d は 3 のまま
  {
    await toSurface(page, '線');
    await page.focus('.chart');
    await page.keyboard.press('0');
    for (let i = 0; i < 3; i++) await page.keyboard.press(']');
    await page.waitForTimeout(150);
    const h = await page.locator('section.stage .chart .handle-hit').first().boundingBox();
    if (!h) throw new Error('ハンドルが無い');
    await drag({ x: h.x + h.width / 2, y: h.y + h.height / 2 }, 60, -40, 20);
    const sc = await savedScenario(page);
    check(
      `#88 AC-13(d) ${tag} 線モードでハンドルを右 60px・上 40px → ΔX ${sc?.dX} だけ、d ${sc?.days} は前のまま`,
      (sc?.dX ?? 0) !== 0 && sc?.days === 3,
    );
  }

  // (e) 面モードで足マーカーのタップ → ポジションのパネル（スマホは peek）・マーカーが強調（#82 と同じ）
  {
    await toSurface(page);
    if (phoneSize) {
      await setShell(page, 'board', 'hidden');
      await page.waitForTimeout(150);
    }
    const before = await savedScenario(page);
    const m = await page.locator('.legmark[data-leg-id="1"]').first().boundingBox();
    if (!m) throw new Error('マーカーが無い');
    await page.mouse.click(m.x + m.width / 2, m.y + m.height / 2);
    await page.waitForTimeout(150);
    const st = await page.evaluate(() => {
      const l = document.querySelector('.layout');
      return {
        panel: l?.getAttribute('data-panel'),
        sheet: l?.getAttribute('data-sheet'),
        sel: document.querySelector('.legmark.sel')?.getAttribute('data-leg-id') ?? null,
      };
    });
    const after = await savedScenario(page);
    check(
      `#88 AC-13(e) ${tag} 面モードで足マーカーのタップ → ポジションのパネル${phoneSize ? '（peek）' : ''}・強調・点は動かない`,
      st.panel === 'positions' &&
        (!phoneSize || st.sheet === 'peek') &&
        st.sel === '1' &&
        after?.dX === before?.dX &&
        after?.days === before?.days,
      `${JSON.stringify(st)}・${JSON.stringify({ dX: after?.dX, days: after?.days })}`,
    );
  }
  await ctx.close();
}

/**
 * #88 AC-13(f): タッチの端末のエミュレーション（390×844・CDP の Input.dispatchTouchEvent）で 1 本目の指で点を動かした
 * 後に 2 本目の指 → ΔX・d が押す前（0・0）に戻り、2 本の指を広げると表示範囲が狭まる。ページ・シートは動かない。
 */
async function surfaceTouchFlow() {
  const tag = '390x844 touch';
  const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await toSurface(page);
  await page.focus('.chart');
  await page.keyboard.press('0');
  await page.waitForTimeout(200);
  const shell0 = await page.evaluate(() => ({
    sheet: document.querySelector('.layout')?.getAttribute('data-sheet'),
    top: [...document.querySelectorAll('.layout > section')]
      .map((e) => Math.round(e.getBoundingClientRect().top))
      .join(','),
    sy: window.scrollY,
  }));
  const ticks0 = (await xTickTexts(page)).map(tickNum);
  const cx = () =>
    page.evaluate(() =>
      Number(document.querySelector('section.stage .chart circle.handle')?.getAttribute('cx')),
    );
  const cx0 = await cx();
  const dot = await surfaceDot(page);
  const c = await page.locator('section.stage .chart').first().boundingBox();
  if (!dot || !c) throw new Error('面の点・描画域が無い');
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  // 1 本目: ● から右・上へ 10 回
  const a = { x: Math.round(dot.x), y: Math.round(dot.y) };
  await touch('touchStart', [{ x: a.x, y: a.y, id: 0 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: a.x + i * 3, y: a.y - i * 3, id: 0 }]);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(200);
  const cx1 = await cx();
  // 2 本目: 描画域の中（1 本目の左）。2 本を左右に広げる
  const f1 = { x: a.x + 30, y: a.y - 30 };
  const f2 = { x: Math.round(Math.max(c.x + 20, f1.x - 80)), y: f1.y };
  await touch('touchStart', [
    { ...f1, id: 0 },
    { ...f2, id: 1 },
  ]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [
      { x: Math.min(f1.x + i * 4, c.x + c.width - 4), y: f1.y, id: 0 },
      { x: Math.max(f2.x - i * 4, c.x + 4), y: f2.y, id: 1 },
    ]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const sc = await savedScenario(page);
  const ticks1 = (await xTickTexts(page)).map(tickNum);
  const span = (t) => (t.length > 1 ? (t[t.length - 1] ?? 0) - (t[0] ?? 0) : Number.NaN);
  const shell1 = await page.evaluate(() => ({
    sheet: document.querySelector('.layout')?.getAttribute('data-sheet'),
    top: [...document.querySelectorAll('.layout > section')]
      .map((e) => Math.round(e.getBoundingClientRect().top))
      .join(','),
    sy: window.scrollY,
  }));
  check(
    `#88 AC-13(f) ${tag} 1 本目で点が動き（cx ${cx0} → ${cx1}）、2 本目で ΔX・d が押す前に戻り（${sc?.dX}・${sc?.days}）、広げると表示範囲が狭まる（目盛りの幅 ${span(ticks0)} → ${span(ticks1)}）・ページとシートは動かない`,
    cx1 !== cx0 &&
      sc?.dX === 0 &&
      sc?.days === 0 &&
      span(ticks1) < span(ticks0) &&
      shell1.sy === 0 &&
      shell1.sheet === shell0.sheet &&
      shell1.top === shell0.top,
    `${JSON.stringify(shell0)} → ${JSON.stringify(shell1)}`,
  );
  await ctx.close();
}

/** タッチの端末のエミュレーション（hasTouch・isMobile。390×844）。AC-19 の Chromium での根拠（iPhone の Safari は手動） */
async function touchContext(storage, viewport = { width: 390, height: 844 }) {
  const localStorage = Object.entries(storage).map(([name, v]) => ({ name, value: v }));
  return browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: REDUCED_MOTION,
    storageState: { cookies: [], origins: localStorage.length ? [{ origin, localStorage }] : [] },
  });
}

async function touchFlows() {
  const tag = '390x844 touch';
  // (a)(b) BOX タブの帯を横にスワイプ（ページは動かない）、作業中でないチップのタップは切替だけ・2 回目でメニュー
  {
    const ctx = await touchContext({ [WORKSPACE_KEY]: busyWorkspace });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    const strip = await page.evaluate(() => {
      const s = document.querySelector('.boxtabs');
      const b = s?.getBoundingClientRect();
      return b
        ? {
            x: b.left + b.width / 2,
            y: b.top + b.height / 2,
            sl: s.scrollLeft,
            max: s.scrollWidth - s.clientWidth,
          }
        : null;
    });
    const cdp = await ctx.newCDPSession(page);
    // 指のスワイプ（CDP の Input.dispatchTouchEvent。headless の Chromium では synthesizeScrollGesture の touch が
    // 帯を動かさないため、タッチの点を 10 回動かす = コンポジタのタッチスクロールになる）
    const sx = Math.round(strip?.x ?? 100);
    const sy = Math.round(strip?.y ?? 20);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: sx, y: sy }],
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: sx - i * 12, y: sy }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      sl: document.querySelector('.boxtabs')?.scrollLeft ?? 0,
      sx: window.scrollX,
      sy: window.scrollY,
      vx: window.visualViewport?.offsetLeft ?? 0,
      vy: window.visualViewport?.offsetTop ?? 0,
      root: document.scrollingElement?.scrollTop ?? 0,
    }));
    check(
      `#87 AC-19(a) ${tag} 帯を横にスワイプすると帯だけが動き、ページ・visualViewport は動かない`,
      !!strip &&
        strip.max > 0 &&
        after.sl > strip.sl &&
        after.sx === 0 &&
        after.sy === 0 &&
        after.vx === 0 &&
        after.vy === 0 &&
        after.root === 0,
      `帯 ${strip?.sl} → ${after.sl}（最大 ${strip?.max}）・${JSON.stringify(after)}`,
    );
    const chips = page.locator('.boxtabs [role="tab"]');
    const target = chips.nth(1);
    await target.scrollIntoViewIfNeeded();
    await target.tap();
    await page.waitForTimeout(150);
    const b1 = {
      selected: await target.getAttribute('aria-selected'),
      menu: await page.locator('.boxtabs-wrap > [role="menu"]').count(),
    };
    await target.tap();
    await page.waitForTimeout(150);
    const b2 = await page.locator('.boxtabs-wrap > [role="menu"]').count();
    check(
      `#87 AC-19(b) ${tag} 作業中でないチップのタップは切替だけ（メニューなし）、もう一度のタップでメニュー`,
      b1.selected === 'true' && b1.menu === 0 && b2 === 1,
      `${JSON.stringify(b1)} → メニュー ${b2}`,
    );
    await ctx.close();
  }
  // (c) 警告の知らせのトーストと普通のトーストを出した状態で、トーストの外は押せる（ドックのボタン）
  {
    const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs });
    await ctx.route('**/fixtures/latest.json', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next', { keepNotes: true });
    // 全クリアはポジションの ⋯（#275 でトップの ⋯ から外した）
    await page.tap('section.positions button[aria-label="ポジションの操作"]');
    await page.tap('[role="menuitem"]:has-text("全クリア")');
    await page.waitForSelector('.toast:not(.note)', { timeout: 3000 }).catch(() => {});
    const c = await page.evaluate(() => {
      const box = document.querySelector('.toasts')?.getBoundingClientRect();
      const warn = document.querySelector('.toast.note.warn')?.getBoundingClientRect();
      const plain = document.querySelector('.toast:not(.note)');
      const pb = plain?.getBoundingClientRect();
      const dock = document.querySelector('.dock')?.getBoundingClientRect();
      if (!box || !warn || !pb || !dock) return { ok: false, why: 'トースト・ドックが無い' };
      // 箱の中・トーストの外の点（普通のトーストの左の余白）
      const x = Math.max(box.left + 2, pb.left - 6);
      const y = (pb.top + pb.bottom) / 2;
      const outside = x < pb.left;
      const el = document.elementFromPoint(x, y);
      const dockHits = [...document.querySelectorAll('.dock button')].every((b) => {
        const r = b.getBoundingClientRect();
        const e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return !!e && b.contains(e);
      });
      return {
        ok: true,
        outside,
        inBox: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
        hitToasts: !!el?.closest('.toasts'),
        aboveDock: box.bottom <= dock.top + 0.5,
        dockHits,
      };
    });
    await page.tap('.dock button[data-panel="scenario"]');
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => {
      const l = document.querySelector('.layout');
      return { panel: l?.getAttribute('data-panel'), sheet: l?.getAttribute('data-sheet') };
    });
    check(
      `#87 AC-19(c) ${tag} トーストは下中央・ドックの上で、箱の中のトーストの外とドックのボタンは押せる`,
      c.ok &&
        c.outside &&
        c.inBox &&
        !c.hitToasts &&
        c.aboveDock &&
        c.dockHits &&
        opened.panel === 'scenario' &&
        opened.sheet !== 'hidden',
      `${JSON.stringify(c)}・${JSON.stringify(opened)}`,
    );
    await ctx.close();
  }
  // (d) ⋯ > ファイルを開く… でファイルの選択が開く（タップ。読み込み… は #275 で保存一覧のダイアログだけに）
  {
    const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    const opens = [];
    for (const label of ['ファイルを開く…']) {
      await page.tap(MORE);
      const fc = page.waitForEvent('filechooser', { timeout: 3000 }).then(
        () => true,
        () => false,
      );
      await page.tap(moreItem(label));
      opens.push(await fc);
    }
    check(
      `#87 AC-19(d) ${tag} ⋯ > ファイルを開く… のタップでファイルの選択が開く（Chromium。iPhone の Safari は手動）`,
      opens.every(Boolean),
      opens.join(' / '),
    );
    await ctx.close();
  }
}

// ---- #89 段 A 全体のキーの手順（AC-A4。docs/ui-redesign.md §4.6）
/** 1〜5 → パネル（ui/view/keys.ts の PANEL_KEYS と同じ。#275 で板 / IV · スマイル / ポジ / シナリオ / 指標 の順に） */
const KEY_PANELS = [
  ['1', 'board'],
  ['2', 'smile'],
  ['3', 'positions'],
  ['4', 'scenario'],
  ['5', 'metrics'],
];
/** 1〜5 のフォーカスの行き先 = パネルのスクロールする枠（ui/next/useGlobalKeys.ts の PANEL_FOCUS と同じ） */
const KEY_FOCUS = {
  positions: 'main.layout > section.panel.positions > .panel-body',
  board:
    'main.layout > section.panel.board .board-month:not(.inactive) .board-wrap:not(.side-hidden)',
  scenario: 'main.layout > section.panel.scenario > .panel-body',
  metrics: 'main.layout > section.panel.metrics > .panel-body',
  smile: 'main.layout > section.panel.smile > .panel-body',
};

async function keyFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const tier = vp.width <= PHONE_MAX ? 'phone' : vp.width >= 1200 ? 'pc' : 'tablet';
  const ref = tier === 'tablet' ? '参考 ' : '';
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const shellNow = () =>
    page.evaluate(() => {
      const l = document.querySelector('.layout');
      return {
        panel: l?.getAttribute('data-panel') ?? null,
        sheet: l?.getAttribute('data-sheet') ?? null,
        market: l?.getAttribute('data-market') ?? null,
        theme: document.documentElement.dataset.theme ?? null,
      };
    });
  const activeIs = (sel) => page.evaluate((q) => document.activeElement?.matches(q) === true, sel);
  const blur = () =>
    page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  const press = async (key) => {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  };

  // (a) body にフォーカス → 1〜5 を順に。スマホは hidden から始める
  {
    if (tier === 'phone') await setShell(page, 'positions', 'hidden');
    await blur();
    const startBody = await page.evaluate(() => document.activeElement === document.body);
    const rows = [];
    let ok = startBody;
    let prev = await shellNow();
    for (const [key, panel] of KEY_PANELS) {
      await press(key);
      const cur = await shellNow();
      const focused = await activeIs(KEY_FOCUS[panel]);
      let want = true;
      if (tier === 'phone') want = cur.panel === panel && cur.sheet !== 'hidden';
      else if (tier === 'tablet')
        want = panel === 'scenario' ? cur.panel === prev.panel : cur.panel === panel;
      else if (panel === 'board' || panel === 'smile') want = cur.market === panel;
      else want = cur.market === prev.market;
      ok = ok && want && focused;
      rows.push(`${key}:${cur.panel}/${cur.sheet}/${cur.market}${focused ? '' : ' focus×'}`);
      prev = cur;
    }
    check(
      `#89 AC-A4(a) ${ref}${tag} body から 1〜5 → ${
        tier === 'phone'
          ? 'data-panel がそのパネル・sheet が hidden でない'
          : tier === 'pc'
            ? '1 / 2 で data-market が board / smile'
            : '4 以外で data-panel がそのパネル'
      }・activeElement がそのパネルのスクロールする枠`,
      ok,
      rows.join(' '),
    );
  }

  // #280: PC のキー 6 は左の列（市場 ⇄ AI）。3 / 5 は AI を閉じない、1 は市場（板）に戻す、6 で戻すと前の市場の見え方
  if (tier === 'pc') {
    const left = () => page.getAttribute('.layout', 'data-left');
    const seq = [];
    await press('2');
    for (const key of ['6', '3', '5', '6', '6', '1']) {
      await blur();
      await press(key);
      const cur = await shellNow();
      const metrics = await page.isVisible('section.metrics');
      seq.push(`${key}:${await left()}/${cur.market}${metrics ? '' : ' 指標×'}`);
    }
    check(
      `#280 ${tag} キー 6 で左の列が AI ⇄ 市場（戻すと前の見え方）・3 / 5 で AI のまま・1 で板・指標は見えたまま`,
      seq.join(' ') === '6:ai/smile 3:ai/smile 5:ai/smile 6:market/smile 6:ai/smile 1:market/board',
      seq.join(' '),
    );
  }

  // (b) G → 描画域、→ で ΔX +100
  {
    await blur();
    await press('g');
    const onChart = await activeIs('section.stage .chart');
    await press('0');
    const a = await savedScenario(page);
    await press('ArrowRight');
    const b = await savedScenario(page);
    check(
      `#89 AC-A4(b) ${ref}${tag} G で activeElement が .stage .chart、→ で ΔX +100`,
      onChart && a !== null && b !== null && b.dX === a.dX + 100,
      `focus ${onChart} / ΔX ${a?.dX} → ${b?.dX}`,
    );
  }

  // (e) 描画域で 0 = シナリオのリセット、パネルは変わらない
  {
    await page.focus('section.stage .chart');
    const before = await shellNow();
    const a = await savedScenario(page);
    await press('0');
    const after = await shellNow();
    const b = await savedScenario(page);
    check(
      `#89 AC-A4(e) ${ref}${tag} 描画域で 0 → ΔX ${a?.dX} → 0（リセット）・data-panel / data-market は同じ`,
      a?.dX !== 0 &&
        b?.dX === 0 &&
        b?.dSigma === 0 &&
        after.panel === before.panel &&
        after.market === before.market &&
        after.sheet === before.sheet,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
  }

  // (c) T で反転・prefs、もう一度 T で戻る
  {
    await blur();
    const prefs = () =>
      page.evaluate((k) => {
        try {
          return JSON.parse(localStorage.getItem(k) ?? 'null')?.theme ?? null;
        } catch {
          return null;
        }
      }, PREFS_KEY);
    const t0 = (await shellNow()).theme;
    await press('t');
    const t1 = (await shellNow()).theme;
    const p1 = await prefs();
    await press('T');
    const t2 = (await shellNow()).theme;
    const p2 = await prefs();
    check(
      `#89 AC-A4(c) ${ref}${tag} T で data-theme ${t0} → ${t1}（prefs ${p1}）、もう一度 T で ${t2}（prefs ${p2}）`,
      t0 === 'dark' && t1 === 'light' && p1 === 'light' && t2 === 'dark' && p2 === 'dark',
    );
  }

  // (d) 設定ダイアログ / ⋯ メニュー / ステッパーの数値入力では 1・G・T が効かない
  {
    const pressAll = async () => {
      const before = await shellNow();
      await page.evaluate(() => {
        window.__keyFocus = document.activeElement;
      });
      for (const k of ['1', 'g', 't']) await press(k);
      const after = await shellNow();
      const same = await page.evaluate(() => document.activeElement === window.__keyFocus);
      const ok =
        before.panel === after.panel &&
        before.market === after.market &&
        before.sheet === after.sheet &&
        before.theme === after.theme &&
        same;
      return { ok, detail: `${JSON.stringify(before)} → ${JSON.stringify(after)} focus ${same}` };
    };
    // (a) の後は指標（スマホ・タブレットは data-panel）・スマイル（PC は data-market）= 1（板）が効けば変わる

    await openFromMore(page, '設定…', SET);
    const dlgOpen = (await page.$(SET)) !== null;
    const r1 = await pressAll();
    await closeDialog(page);
    check(
      `#89 AC-A4(d) ${ref}${tag} 設定ダイアログを開いた状態で 1・G・T が効かない`,
      dlgOpen && r1.ok,
      r1.detail,
    );

    await page.click(MORE);
    await page.waitForTimeout(120);
    const menuOpen = (await page.$('header.top [role="menu"]')) !== null;
    const r2 = await pressAll();
    const stillOpen = (await page.$('header.top [role="menu"]')) !== null;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    check(
      `#89 AC-A4(d) ${ref}${tag} ⋯ メニューを開いた状態で 1・G・T が効かない（メニューは開いたまま）`,
      menuOpen && stillOpen && r2.ok,
      r2.detail,
    );

    if (tier === 'phone') await setShell(page, 'scenario', 'peek');
    const val = 'section.scenario .stepper[data-name="dX"] > .val';
    await page.focus(val);
    await page.keyboard.press('Enter');
    const input = `${val} input`;
    const hasInput = await page
      .waitForSelector(input, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    const inInput = hasInput && (await activeIs(input));
    const activeNow = await page.evaluate(
      () => `${document.activeElement?.tagName.toLowerCase()}.${document.activeElement?.className}`,
    );
    const r3 = await pressAll();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    check(
      `#89 AC-A4(d) ${ref}${tag} ステッパーの数値入力の欄で 1・G・T が効かない`,
      inInput && r3.ok,
      `入力欄 ${hasInput ? 'あり' : 'なし'}・フォーカス ${inInput ? '入力欄' : activeNow}・${r3.detail}`,
    );
  }

  // (f) 回帰（レビュー R1）: パネルの中をクリック → PageDown で枠が縦に動く。1〜5 の直後の PageDown も動く。
  // 板の K は #264 からボタンなので、ボタンでない所は IV のセル（#282）。K のボタンは下の (g)
  for (const [key, panel, cell] of [
    ['1', 'board', 'tbody tr:nth-child(3) td.iv'],
    ['5', 'metrics', 'table.tail thead th'],
  ]) {
    const box = KEY_FOCUS[panel];
    const top = () => page.evaluate((q) => document.querySelector(q)?.scrollTop ?? -1, box);
    const reset = () =>
      page.evaluate((q) => {
        const el = document.querySelector(q);
        if (el) el.scrollTop = 0;
      }, box);
    await blur();
    await press(key);
    await page.waitForTimeout(200);
    const room = await page.evaluate((q) => {
      const el = document.querySelector(q);
      return el ? el.scrollHeight - el.clientHeight : -1;
    }, box);
    // クリック（ボタンでない所）→ PageDown
    await reset();
    await blur();
    await page.click(`${box} ${cell}`);
    await page.waitForTimeout(120);
    const clickFocus = await activeIs(box);
    await press('PageDown');
    const byClick = await top();
    // キー（1 / 5）→ PageDown
    await reset();
    await blur();
    await press(key);
    await press('PageDown');
    const byKey = await top();
    const what = panel === 'board' ? '板の行' : '指標のテール表';
    if (room <= 0) {
      // 枠が溢れない幅（900 の指標など）は動きようがないので記録だけ
      console.log(`skip  #89 R1 ${ref}${tag} ${what}: 枠が溢れない（余白 ${room}px）`);
      continue;
    }
    check(
      `#89 R1 ${ref}${tag} ${what}をクリック → PageDown・${key} → PageDown で枠の scrollTop が増える`,
      clickFocus && byClick > 0 && byKey > 0,
      `余白 ${room}px・クリックでフォーカス ${clickFocus}・scrollTop ${byClick} / ${byKey}`,
    );
  }

  // (g) 板の K のボタン（#264）をクリック → ポップオーバーが開き、フォーカスは K のボタン（Esc で戻す先）のまま。
  // それでも枠はボタンの祖先なので PageDown で動く（#282）
  {
    const box = KEY_FOCUS.board;
    const kbtn = `${box} tbody tr:nth-child(3) .kbtn`;
    await blur();
    await press('1');
    await page.waitForTimeout(200);
    await page.evaluate((q) => {
      const el = document.querySelector(q);
      if (el) el.scrollTop = 0;
    }, box);
    await blur();
    await page.click(kbtn);
    await page.waitForTimeout(120);
    const popOpen = (await page.$(`${box} .popover.kpop`)) !== null;
    const onK = await activeIs(kbtn);
    const before = await page.evaluate((q) => document.querySelector(q)?.scrollTop ?? -1, box);
    await press('PageDown');
    const after = await page.evaluate((q) => document.querySelector(q)?.scrollTop ?? -1, box);
    // 開いたままだと次の手順のキー（1〜5）が止まるので閉じる
    if (popOpen) await press('Escape');
    check(
      `#89 R1 ${ref}${tag} 板の K のボタンをクリック → ポップオーバーが開きフォーカスは K → PageDown で枠の scrollTop が増える`,
      popOpen && onK && after > before,
      `ポップオーバー ${popOpen}・フォーカス K ${onK}・scrollTop ${before} → ${after}`,
    );
  }
  await ctx.close();
}

// ---- #89 段 B コマンドパレットの手順（AC-B5。docs/ui-redesign.md §4.6）
const PAL_INPUT = `${PALETTE} input`;
const PAL_OPT = `${PALETTE} [role="listbox"] [role="option"]`;

async function paletteFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phone = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('light') });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const act = () => page.getAttribute(PAL_INPUT, 'aria-activedescendant');
  const optIds = (q) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.id), q);
  const isOpen = async () => (await page.$(PALETTE)) !== null;
  const shellNow = () =>
    page.evaluate(() => {
      const l = document.querySelector('.layout');
      return {
        panel: l?.getAttribute('data-panel') ?? null,
        sheet: l?.getAttribute('data-sheet') ?? null,
        market: l?.getAttribute('data-market') ?? null,
        theme: document.documentElement.dataset.theme ?? null,
      };
    });
  const saved = async () => {
    await page.waitForTimeout(700);
    return page.evaluate((k) => {
      try {
        const w = JSON.parse(localStorage.getItem(k) ?? 'null');
        const pos = w?.tabs?.[w.active]?.position;
        return { scenario: pos?.scenario ?? null, legs: pos?.legs?.length ?? -1 };
      } catch {
        return { scenario: null, legs: -1 };
      }
    }, WORKSPACE_KEY);
  };
  const type = async (text) => {
    await page.keyboard.type(text);
    await page.waitForTimeout(120);
  };
  const press = async (key) => {
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
  };
  const closeIt = async () => {
    if (await isOpen()) await press('Escape');
  };
  const blur = () =>
    page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  const steppers = () =>
    page.evaluate(
      (names) =>
        names.map(
          (n) =>
            document.querySelector(`section.scenario .stepper[data-name="${n}"] .val b`)
              ?.textContent ?? null,
        ),
      ['dX', 'dSigma', 'skew'],
    );

  // (a) 開く: 入力欄にフォーカス・先頭の押せる行・option が 1 件以上
  {
    await blur();
    const opened = await openPalette(page);
    const focusIn = await page.evaluate(
      (s) => document.activeElement?.matches(s) === true,
      PAL_INPUT,
    );
    const enabled = await optIds(`${PAL_OPT}:not([aria-disabled="true"])`);
    const all = await optIds(PAL_OPT);
    const a = await act();
    check(
      `#89 AC-B5(a) ${tag} Ctrl + K で開き、入力欄にフォーカス・aria-activedescendant が先頭の押せる行・option が 1 件以上`,
      opened && focusIn && a !== null && a === enabled[0] && all.length > 0,
      `開いた ${opened}・フォーカス ${focusIn}・${a} / ${enabled[0]}・${all.length} 件`,
    );
    // (b) ↓ ↓ ↑ で 2 行目
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowUp');
    const b = await act();
    check(
      `#89 AC-B5(b) ${tag} ↓ ↓ ↑ で aria-activedescendant が 2 行目`,
      b === enabled[1],
      `${b} / ${enabled[1]}`,
    );
    await closeIt();
  }

  // (c) 急落 → Enter: 閉じて、ステッパーの表示がチップの [急落] と同じ
  {
    if (phone) await setShell(page, 'scenario', 'peek');
    await page.click('section.scenario .chip:has-text("急落")');
    await page.waitForTimeout(200);
    const byChip = await steppers();
    await page.click('section.scenario .chip:has-text("リセット")');
    await page.waitForTimeout(200);
    const reset = await steppers();
    await blur();
    await openPalette(page);
    await type('急落');
    const n = (await optIds(PAL_OPT)).length;
    await press('Enter');
    await page.waitForTimeout(150);
    const closed = !(await isOpen());
    const byPal = await steppers();
    check(
      `#89 AC-B5(c) ${tag} 急落 → Enter でパレットが閉じ、ΔX・Δσ・Δs がチップの [急落] と同じ`,
      // #307: 急落は用語「過去の急落の再生」にも当たる（2 件。先頭 = Enter はプリセット = 値がチップと同じで確かめる）
      n === 2 &&
        closed &&
        JSON.stringify(byPal) === JSON.stringify(byChip) &&
        JSON.stringify(byPal) !== JSON.stringify(reset),
      `${n} 件・閉じた ${closed}・${byPal.join(' / ')}（チップ ${byChip.join(' / ')}・リセット ${reset.join(' / ')}）`,
    );
    await page.click('section.scenario .chip:has-text("リセット")').catch(() => {});
    await page.waitForTimeout(150);
  }

  // (d) 売 P → 先頭の足の行を Enter: 足が 1 本増え、トーストの文が <ラベル> を追加、[元に戻す] で戻る
  {
    const before = (await saved()).legs;
    const dock = () =>
      page.evaluate(
        () =>
          document.querySelector('.dock button[data-panel="positions"] .cnt')?.textContent ?? null,
      );
    const dock0 = await dock();
    await blur();
    await openPalette(page);
    await type('売 P');
    const first = await page.evaluate((s) => {
      const id = document.querySelector(s)?.getAttribute('aria-activedescendant');
      return id
        ? (document.getElementById(id)?.querySelector('.pal-lbl')?.textContent ?? null)
        : null;
    }, PAL_INPUT);
    const head = first?.split('（')[0] ?? '';
    await press('Enter');
    await page.waitForTimeout(200);
    const toast = await page.evaluate(() =>
      [...document.querySelectorAll('.toast:not(.note) .txt')].map((t) => t.textContent),
    );
    const after = (await saved()).legs;
    const dock1 = await dock();
    await page.click('.toast:not(.note) button:has-text("元に戻す")').catch(() => {});
    const undone = (await saved()).legs;
    const dockOk = phone ? Number(dock1) === Number(dock0) + 1 : true;
    check(
      `#89 AC-B5(d) ${tag} 売 P の先頭の足の行を Enter → 足 +1${phone ? '・ドックのバッジ +1' : ''}・トーストが「${head} を追加」・[元に戻す] で戻る`,
      head.startsWith('売 P ') &&
        after === before + 1 &&
        dockOk &&
        toast.includes(`${head} を追加`) &&
        undone === before,
      `${first}・足 ${before} → ${after} → ${undone}・ドック ${dock0} → ${dock1}・トースト ${JSON.stringify(toast)}`,
    );
  }

  // (e) ATM へ: 板が見え、ATM の行が表の枠の中（強調も出る）
  {
    if (!phone) {
      await page.evaluate((s) => {
        const w = document.querySelector(s);
        if (w) w.scrollTop = 0;
      }, ACTIVE_WRAP);
    } else await setShell(page, 'positions', 'peek');
    await blur();
    await openPalette(page);
    await type('ATM');
    await press('Enter');
    const seen = await page
      .waitForFunction(
        (s) => {
          const w = document.querySelector(s);
          const tr = w?.querySelector('tr.atm');
          if (!w || !tr) return false;
          const a = w.getBoundingClientRect();
          const b = tr.getBoundingClientRect();
          return (
            a.height > 0 &&
            b.top >= a.top - 0.5 &&
            b.bottom <= a.bottom + 0.5 &&
            tr.classList.contains('hit')
          );
        },
        ACTIVE_WRAP,
        { timeout: 1500 },
      )
      .then(() => true)
      .catch(() => false);
    const sh = await shellNow();
    check(
      `#89 AC-B5(e) ${tag} ATM へ → ${phone ? 'data-panel が board' : 'data-market が board'}・ATM の行が板の枠の中（強調あり）`,
      seen && (phone ? sh.panel === 'board' && sh.sheet !== 'hidden' : sh.market === 'board'),
      `${JSON.stringify(sh)}・枠の中 ${seen}`,
    );
  }

  // (f) テーマ: ダーク・設定…
  {
    const t0 = (await shellNow()).theme;
    await blur();
    await openPalette(page);
    await type('テーマ ダーク');
    await press('Enter');
    const t1 = (await shellNow()).theme;
    await openPalette(page);
    await type('設定');
    await press('Enter');
    const set = await page
      .waitForSelector(SET, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    await closeDialog(page);
    check(
      `#89 AC-B5(f) ${tag} 「テーマ: ダーク」で data-theme ${t0} → ${t1}・「設定…」で設定ダイアログ`,
      t0 === 'light' && t1 === 'dark' && set,
    );
  }

  // (g) Esc / 背景で閉じる: フォーカスが開く前の要素（ステッパー）に戻り、シナリオ・足・パネルが変わらない
  {
    if (phone) await setShell(page, 'scenario', 'peek');
    const val = 'section.scenario .stepper[data-name="dX"] > .val';
    await page.focus(val);
    const sh0 = await shellNow();
    const s0 = await saved();
    await openPalette(page);
    await type('急落');
    await press('Escape');
    const closed = !(await isOpen());
    const back = await page.evaluate((s) => document.activeElement?.matches(s) === true, val);
    const sh1 = await shellNow();
    const s1 = await saved();
    check(
      `#89 AC-B5(g) ${tag} Esc で閉じ、フォーカスがステッパーに戻る・シナリオ・足・パネルが同じ`,
      closed &&
        back &&
        JSON.stringify(sh0) === JSON.stringify(sh1) &&
        JSON.stringify(s0) === JSON.stringify(s1),
      `閉じた ${closed}・戻った ${back}・${JSON.stringify(sh1)}`,
    );
    await openPalette(page);
    await page.mouse.click(10, vp.height - 10);
    await page.waitForTimeout(150);
    const closed2 = !(await isOpen());
    const back2 = await page.evaluate((s) => document.activeElement?.matches(s) === true, val);
    const sh2 = await shellNow();
    check(
      `#89 AC-B5(g) ${tag} 背景のクリックで閉じる（下の要素は押されない・フォーカスが戻る）`,
      closed2 && back2 && JSON.stringify(sh2) === JSON.stringify(sh1),
      `閉じた ${closed2}・戻った ${back2}・${JSON.stringify(sh2)}`,
    );
  }

  // (h) 開いている間の 1・G・T は入力欄の文字、Ctrl + K で 2 つ目が開かない
  {
    await blur();
    const sh0 = await shellNow();
    await openPalette(page);
    for (const k of ['1', 'g', 't']) await press(k);
    const v = await page.inputValue(PAL_INPUT);
    const sh1 = await shellNow();
    // Tab / Shift + Tab は入力欄に留まる（背景へ出ない）
    await press('Tab');
    await press('Shift+Tab');
    const tabStay = await page.evaluate(
      (s) => document.activeElement?.matches(s) === true,
      PAL_INPUT,
    );
    // 背景の要素へフォーカスが移っても入力欄へ戻る（非モーダルのガード。#89 段 B のレビュー 1）
    await page.evaluate(() => {
      document.querySelector('button[aria-label="メニュー"]')?.focus();
    });
    await page.waitForTimeout(120);
    const guard = await page.evaluate(
      (s) => document.activeElement?.matches(s) === true,
      PAL_INPUT,
    );
    const menuNone = (await page.$('[role="menu"]')) === null;
    // 入力欄の Ctrl + K はパレットを閉じる（2 つ目は開かない・ブラウザの既定を止める。レビュー 2）
    const prevented = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const ev = new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      el?.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, PAL_INPUT);
    await page.waitForTimeout(150);
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, PALETTE);
    await closeIt();
    check(
      `#89 AC-B5(h) ${tag} 開いている間の 1・G・T は入力欄の文字（${v}）・パネル / テーマが同じ・Tab で外へ出ない・背景へ移ったフォーカスは入力欄へ戻る・入力欄の Ctrl + K は既定を止めて閉じる（2 つ目は開かない）`,
      v === '1gt' &&
        JSON.stringify(sh0) === JSON.stringify(sh1) &&
        tabStay &&
        guard &&
        menuNone &&
        prevented &&
        n === 0,
      `${JSON.stringify(sh0)} → ${JSON.stringify(sh1)}・Tab ${tabStay}・戻す ${guard}・既定を止めた ${prevented}・dialog ${n}`,
    );
  }

  // (i) ⋯ メニューの上の Ctrl + K はメニューを閉じてパレット、設定ダイアログの上は何もしない
  {
    await page.click(MORE);
    await page.waitForTimeout(120);
    const menu0 = (await page.$('header.top [role="menu"]')) !== null;
    const opened = await openPalette(page);
    const menu1 = (await page.$('[role="menu"]')) !== null;
    await closeIt();
    check(
      `#89 AC-B5(i) ${tag} ⋯ メニューを開いた状態で Ctrl + K → メニューが閉じてパレットが開く`,
      menu0 && opened && !menu1,
      `メニュー ${menu0} → ${menu1}・パレット ${opened}`,
    );
    await openFromMore(page, '設定…', SET);
    const set = (await page.$(SET)) !== null;
    await page.keyboard.press('Control+K');
    await page.waitForTimeout(200);
    const pal = await isOpen();
    const setStill = (await page.$(SET)) !== null;
    await closeDialog(page);
    check(
      `#89 AC-B5(i) ${tag} 設定ダイアログを開いた状態の Ctrl + K は何もしない`,
      set && !pal && setStill,
      `設定 ${set}・パレット ${pal}`,
    );
  }
  await ctx.close();

  // (b) 足 0 本の作業で 全クリア: 押せない行だけ = aria-activedescendant なし、Enter で何も起きない
  // （#167: 「クリア」だけでは用語の JSCC（日本証券クリアリング機構）にも当たるので「全クリア」で引く）
  {
    const c2 = await newContext(vp, {});
    const p2 = await c2.newPage();
    await p2.goto(pageUrl('next'));
    await waitReady(p2, 'next');
    await p2.keyboard.press('Control+K');
    const opened = await p2
      .waitForSelector(PAL_INPUT, { timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    await p2.keyboard.type('全クリア');
    await p2.waitForTimeout(120);
    const a = await p2.getAttribute(PAL_INPUT, 'aria-activedescendant');
    const opts = await p2.evaluate(
      (s) => [...document.querySelectorAll(s)].map((e) => e.getAttribute('aria-disabled')),
      PAL_OPT,
    );
    await p2.keyboard.press('Enter');
    await p2.waitForTimeout(200);
    const still = (await p2.$(PALETTE)) !== null;
    const toasts = await p2.evaluate(() => document.querySelectorAll('.toast:not(.note)').length);
    check(
      `#89 AC-B5(b) ${tag} 足 0 本で 全クリア → 全クリアが押せず aria-activedescendant なし・Enter で何も起きない（開いたまま）`,
      opened && a === null && opts.length === 1 && opts[0] === 'true' && still && toasts === 0,
      `${a}・${JSON.stringify(opts)}・開いたまま ${still}・トースト ${toasts}`,
    );
    await c2.close();
  }
}

/** (j) 322 行の板でパレットを開く・64 と打つの Long Animation Frame（50ms 超）が 0 件 */
async function paletteWideFlow(vp) {
  const tag = `${vp.width}x${vp.height} 322 行`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  await ctx.addInitScript(LOAF_INIT);
  await routeWide(ctx);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page
    .waitForSelector('section.board .board-months[data-warm="done"]', { timeout: 8000 })
    .catch(() => null);
  await page.waitForTimeout(500);
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const mark = () => page.evaluate(() => window.__loaf.length);
  const since = (i) => page.evaluate((n) => window.__loaf.slice(n).filter((d) => d > 50), i);
  const m1 = await mark();
  const opened = await openPalette(page);
  await page.waitForTimeout(400);
  const l1 = await since(m1);
  const rows = await page.evaluate(
    () => document.querySelector('dialog.palette .pal-foot')?.textContent ?? '',
  );
  const m2 = await mark();
  await page.keyboard.type('64');
  await page.waitForTimeout(400);
  const l2 = await since(m2);
  check(
    `#89 AC-B5(j) ${tag} パレットを開く・64 と打つの Long Animation Frame（50ms 超）が 0 件`,
    loafOk && opened && l1.length === 0 && l2.length === 0,
    `${loafOk ? '' : 'LoAF を測れない・'}開く ${l1.map((d) => Math.round(d)).join(',') || 0} 件 / 打つ ${l2.map((d) => Math.round(d)).join(',') || 0} 件・${rows}`,
  );
  // #124 AC 2: 説明カードを開く（パレットの ?追証 → Enter。背景の aria-hidden を含む）も 50ms 超 0 件
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await openPalette(page);
  await page.keyboard.type('?追証');
  await page.waitForTimeout(400);
  const m3 = await mark();
  await page.keyboard.press('Enter');
  const card = await page
    .waitForSelector(`${TERM_CARD} .tc-head h2`, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(400);
  const l3 = await since(m3);
  check(
    `#124 AC 2 ${tag} 説明カードを開くの Long Animation Frame（50ms 超）が 0 件`,
    loafOk && card && l3.length === 0,
    `${loafOk ? '' : 'LoAF を測れない・'}開く ${l3.map((d) => Math.round(d)).join(',') || 0} 件・カード ${card}`,
  );
  await ctx.close();
}

/**
 * #124 a11y と操作の見直し（docs/ui-redesign.md §5・§4.6）:
 * (1) 保存一覧の開閉の前後でトーストの読み上げの領域（.toast-alerts = alert / .toast-log = status）が同じ要素で 1 個ずつ、
 *     開いている間はダイアログの中・閉じたら画面の直下
 * (2) パレット・説明カードを開いている間、画面の直下の兄弟（dialog とトーストの置き場以外）が aria-hidden="true"・
 *     Tab / Shift + Tab を 12 回押してフォーカスが毎回 dialog の中（説明カードは本文をクリックした後も）・
 *     閉じ方（Esc・箱の外のクリック・説明カードの ×）によらず閉じたら aria-hidden が開く前と同じ
 * (3) 1 → 4 を同じフレームで押すと 4 の行き先（指標のスクロールする枠）にフォーカス
 */
async function a11yFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');

  // (1) トーストの読み上げの領域
  {
    const regions = (keep) =>
      page.evaluate((k) => {
        const a = [...document.querySelectorAll('.toast-alerts[role="alert"]')];
        const s = [...document.querySelectorAll('.toast-log[role="status"]')];
        if (k) window.__toastRegions = [a[0] ?? null, s[0] ?? null];
        const [ka, ks] = window.__toastRegions ?? [null, null];
        const dlg = document.querySelector('dialog.sheet.book[open]');
        return {
          n: `${a.length}/${s.length}`,
          same: ka !== null && ks !== null && a[0] === ka && s[0] === ks,
          inBook: dlg !== null && dlg.contains(ka),
          connected: ka?.isConnected === true,
        };
      }, keep);
    const r0 = await regions(true);
    await openFromMore(page, '保存一覧', BOOK);
    const r1 = await regions(false);
    await closeDialog(page);
    const r2 = await regions(false);
    check(
      `#124 AC 1 ${tag} 保存一覧の開閉の前後で role="alert" / role="status" の領域が同じ要素（1 個ずつ・開いている間はダイアログの中）`,
      [r0, r1, r2].every((r) => r.n === '1/1' && r.same && r.connected) &&
        !r0.inBook &&
        r1.inBook &&
        !r2.inBook,
      `前 ${JSON.stringify(r0)} / 開 ${JSON.stringify(r1)} / 閉 ${JSON.stringify(r2)}`,
    );
  }

  // (2) パレット・説明カードの背景
  const bg = (sel) =>
    page.evaluate((s) => {
      const d = document.querySelector(s);
      return [...(document.querySelector('.screen')?.children ?? [])]
        .filter((el) => el !== d && !el.matches('.toast-slot'))
        .map(
          (el) =>
            `${el.tagName}.${el.getAttribute('class') ?? ''}=${el.getAttribute('aria-hidden') ?? '-'}`,
        );
    }, sel);
  const tabInside = async (sel) => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
      const ok = await page.evaluate(
        (s) => document.querySelector(s)?.contains(document.activeElement) === true,
        sel,
      );
      if (!ok)
        out.push(
          await page.evaluate(
            () => `${document.activeElement?.tagName}.${document.activeElement?.className ?? ''}`,
          ),
        );
    }
    return out;
  };
  // 閉じ方ごとに回す（閉じ方によらず背景の aria-hidden が開く前と同じに戻る。Tab の検査は Esc の回だけ）
  const dialogCheck = async (label, sel, open, closes, extra = null) => {
    for (const [how, close] of closes) {
      const withTab = how === 'Esc';
      const before = await bg(sel);
      const opened = await open();
      const during = await bg(sel);
      const out = !opened ? ['開かない'] : withTab ? await tabInside(sel) : [];
      if (opened && withTab && extra) out.push(...(await extra()));
      await close();
      const closed = (await page.$(sel)) === null;
      const after = await bg(sel);
      const allHidden = during.length > 0 && during.every((x) => x.endsWith('=true'));
      check(
        `#124 AC 2 ${tag} ${label}を開いている間は背景が aria-hidden${withTab ? '・Tab / Shift + Tab 12 回で外へ出ない' : ''}・${how}で閉じたら元どおり`,
        opened &&
          closed &&
          allHidden &&
          out.length === 0 &&
          JSON.stringify(before) === JSON.stringify(after) &&
          before.every((x) => !x.endsWith('=true')),
        `開いている間 ${during.join(' ')}・外へ出た ${out.join(',') || 0}・閉じた ${closed}・閉じた後 ${after.join(' ')}`,
      );
    }
  };
  const gone = (sel) =>
    page.waitForSelector(sel, { state: 'detached', timeout: 2000 }).catch(() => {});
  const esc = (sel) => async () => {
    await page.keyboard.press('Escape');
    await gone(sel);
  };
  // 箱の外（箱の左の余白の中、箱の上端から 10px）をクリック
  const outside = (sel, box) => async () => {
    const r = await page.evaluate((q) => {
      const b = document.querySelector(q)?.getBoundingClientRect();
      return b ? { x: Math.max(2, b.left / 2), y: Math.max(2, b.top + 10) } : null;
    }, `${sel} ${box}`);
    if (r) await page.mouse.click(r.x, r.y);
    await gone(sel);
  };
  await dialogCheck('パレット', PALETTE, () => openPalette(page), [
    ['Esc', esc(PALETTE)],
    ['箱の外のクリック', outside(PALETTE, '.pal-box')],
  ]);
  await dialogCheck(
    '説明カード',
    TERM_CARD,
    async () => {
      await openPalette(page);
      await page.keyboard.type('?追証');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      return page
        .waitForSelector(`${TERM_CARD} .tc-head h2`, { timeout: 2000 })
        .then(() => true)
        .catch(() => false);
    },
    [
      ['Esc', esc(TERM_CARD)],
      [
        '×',
        async () => {
          await page.click(`${TERM_CARD} .tc-head button[aria-label="閉じる"]`).catch(() => {});
          await gone(TERM_CARD);
        },
      ],
      ['箱の外のクリック', outside(TERM_CARD, '.tc-box')],
    ],
    // 本文（tabIndex=-1）をクリックしてから Tab / Shift + Tab でも外へ出ない
    async () => {
      const bad = [];
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.click(`${TERM_CARD} .tc-summary`).catch(() => {});
        await page.keyboard.press(key);
        const ok = await page.evaluate(
          (s) => document.querySelector(s)?.contains(document.activeElement) === true,
          TERM_CARD,
        );
        if (!ok) bad.push(`本文から ${key}`);
      }
      return bad;
    },
  );

  // (3) 同じフレームの連打: 1 → 5 を 1 回の evaluate の中で送る = 最後の 5（指標。#275 のキーの並び）の行き先へ
  {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      for (const key of ['1', '5']) {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      }
    });
    await page.waitForTimeout(400);
    const at = await page.evaluate(
      (s) => document.activeElement?.matches(s) === true,
      KEY_FOCUS.metrics,
    );
    const now = await page.evaluate(
      () => `${document.activeElement?.tagName}.${document.activeElement?.className ?? ''}`,
    );
    check(
      `#124 ${tag} 1 → 5 を同じフレームで押すと 5 の行き先（指標のスクロールする枠）にフォーカス`,
      at,
      now,
    );
  }
  await ctx.close();
}

/**
 * #91 AC-C3（終了条件 6）: 動き（§6）を入れても長いフレームが増えないこと。クエリなし・390×844 / 1440×900。
 * 連続の操作（ステッパー 3 本・レール 2 本・描画域のキー × 20 回、ハンドルのドラッグ、ホイールの拡大縮小、描画域のパン、
 * 面の上のドラッグ）は 50ms 超が 0 件で判定。離散の変更（プリセット 5 種 = 急落・下落・反発・リセット・評価時刻の SQ、
 * 枚数 ± 10 回・⇄・タブの切替・ピンの追加）は件数を参考の行に出す（判定しない。動きを入れる前と後の件数を PR に並べる）
 */
async function motionLoafFlow(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoTabs });
  await ctx.addInitScript(LOAF_INIT);
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const loafOk = await page.evaluate(() => window.__loafOk === true);
  const mark = () => page.evaluate(() => window.__loaf.length);
  const since = (i) =>
    page.evaluate(
      (n) =>
        window.__loaf
          .slice(n)
          .filter((d) => d > 50)
          .map(Math.round),
      i,
    );
  const center = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const drag = async (from, dx, dy, steps) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps });
    await page.mouse.up();
  };
  const keys = async (sel, key, n) => {
    await page.focus(sel);
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(16);
    }
  };
  const measureOp = async (fn) => {
    const m = await mark();
    await fn();
    await page.waitForTimeout(400); // 動き（最長 220ms）が終わるまで
    return since(m);
  };
  const reset = async () => {
    await page.focus('.chart');
    await page.keyboard.press('0');
    await page.waitForTimeout(100);
  };
  const cont = [];
  const disc = [];
  if (phoneSize) await setShell(page, 'scenario', 'peek');
  await reset();
  const st = (f) => `section.scenario .stepper[data-name="${f}"] > .val`;
  for (const [name, sel, key] of [
    ['ステッパー Δσ のキー ↑ 20 回', st('dSigma'), 'ArrowUp'],
    ['ステッパー d のキー ↑ 20 回', st('days'), 'ArrowUp'],
    ['ステッパー ΔX のキー ↑ 20 回', st('dX'), 'ArrowUp'],
    ['IV レールのキー ↓ 20 回', '.ivrail', 'ArrowDown'],
    ['時間レールのキー ← 20 回', '.timerail', 'ArrowLeft'],
    ['描画域のキー ← 20 回', '.chart', 'ArrowLeft'],
  ]) {
    cont.push([name, await measureOp(() => keys(sel, key, 20))]);
  }
  await reset();
  cont.push([
    'ハンドルのドラッグ 30 回の move',
    await measureOp(async () => drag(await center('.chart .handle-hit'), 60, 0, 30)),
  ]);
  {
    const c = await center('.chart');
    const at = { x: c.b.x + c.b.width * 0.3, y: c.b.y + c.b.height * 0.35 };
    cont.push([
      'ホイールの拡大縮小 20 回',
      await measureOp(async () => {
        await page.mouse.move(at.x, at.y);
        for (let i = 0; i < 20; i++) {
          await page.mouse.wheel(0, i < 10 ? -60 : 60);
          await page.waitForTimeout(16);
        }
      }),
    ]);
    cont.push(['描画域のパン 30 回の move', await measureOp(() => drag(at, -90, 0, 30))]);
  }
  await page.focus('.chart');
  await page.keyboard.press('r');
  await reset();
  await toSurface(page);
  await page.waitForTimeout(250);
  {
    const dot = await surfaceDot(page);
    cont.push([
      '面の上のドラッグ 30 回の move',
      dot ? await measureOp(() => drag(dot, 60, -40, 30)) : null,
    ]);
  }
  await toSurface(page, '線');
  await reset();
  for (const [name, n] of cont) {
    check(
      `#91 AC-C3 ${tag} ${name}で長いフレーム（50ms 超）0 件`,
      loafOk && Array.isArray(n) && n.length === 0,
      !loafOk
        ? '未対応'
        : n === null
          ? '操作できない'
          : `${n.length} 件${n.length ? ` ${n.join(',')}ms` : ''}`,
    );
  }

  // 離散の変更（参考。判定しない）
  for (const name of ['急落', '下落', '反発', 'リセット']) {
    disc.push([
      `プリセット ${name}`,
      await measureOp(() => page.click(`section.scenario .chip:has-text("${name}")`)),
    ]);
  }
  disc.push([
    'プリセット 評価時刻の SQ',
    await measureOp(() => page.click('section.scenario .chip:has-text("SQ")')),
  ]);
  await reset();
  if (phoneSize) await setShell(page, 'positions', 'peek');
  const qty = 'section.positions li.leg:nth-child(1) .stepper';
  disc.push([
    '枚数 ± 10 回',
    await measureOp(async () => {
      for (let i = 0; i < 10; i++) {
        await page.click(`${qty} > button:${i % 2 === 0 ? 'last-child' : 'first-child'}`);
        await page.waitForTimeout(16);
      }
    }),
  ]);
  disc.push([
    '⇄',
    await measureOp(() =>
      page.click('section.positions li.leg:nth-child(1) button[data-op="flip"]'),
    ),
  ]);
  await page.click('section.positions li.leg:nth-child(1) button[data-op="flip"]');
  await page.waitForTimeout(300);
  disc.push([
    'タブの切替',
    await measureOp(async () => {
      await page.click('.boxtabs [role="tab"]:nth-child(2)');
      await page.waitForTimeout(300);
      await page.click('.boxtabs [role="tab"]:nth-child(1)');
    }),
  ]);
  if (phoneSize) await setShell(page, 'positions', 'hidden');
  disc.push([
    'ピンの追加',
    await measureOp(async () => {
      await page.click('button[aria-label="ピン"]');
      await page.click('[role="menuitem"]:has-text("今の線を残す")');
    }),
  ]);
  console.log(
    `      参考 #91 AC-C3 ${tag} 離散の変更の長いフレーム（50ms 超）: ${disc
      .map(([n, l]) => `${n} ${l.length}${l.length ? `（${l.join(',')}ms）` : ''}`)
      .join('・')}`,
  );
  await ctx.close();
}

/**
 * #91 段 C（AC-C1・C2・C6・C7。docs/ui-redesign.md §6・§10.1「動き」）: クエリなし・390×844 / 1440×900。
 * (a) プリセットを押した直後の線（指定日・満期）の transition が d 0.22s（と読み取りの色 0.2s）(b) ハンドル・IV レール・
 * 時間レールを押してドラッグしている間 .stage-main の .live / [data-live]・線の transition-duration 0s、離して 200ms 後に .live が無い
 * (c) 足を追加した直後の新しい足マーカーに legmark-in（120ms）(d) スマホのシート peek → full の直後に height 0.18s・
 * 終わった後に縦・横 0 (e) reduced = reducedMotion: 'reduce' のコンテキストで (a)(c)(d) が 0s / animation なし
 * (g) パレットの ATM へ → 板を手で 300px → [最新] で読み直しても ATM へ跳び直さない（強調なし）。枠は #85 の規則で ATM ±1px
 * (h) 1〜5 の行き先の名前が空でなく互いに違う
 */
async function motionFlows(vp, reduced = false) {
  const tag = `${vp.width}x${vp.height}${reduced ? ' reduce' : ''}`;
  const ac = reduced ? '#91 AC-C2' : '#91 AC-C1';
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(
    vp,
    { [WORKSPACE_KEY]: twoLegs },
    'dark',
    reduced ? { reducedMotion: 'reduce' } : {},
  );
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const lineStyle = () =>
    page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'section.stage .chart .ln.date, section.stage .chart .ln.expiry',
        ),
      ].map((el) => {
        const cs = getComputedStyle(el);
        return {
          kind: el.classList.contains('date') ? 'date' : 'expiry',
          prop: cs.transitionProperty,
          dur: cs.transitionDuration,
          anims: el.getAnimations().length,
        };
      }),
    );
  const live = () =>
    page.evaluate(
      () =>
        document.querySelector('section.stage .stage-main')?.matches('.live, [data-live]') === true,
    );
  const frames = (n) =>
    page.evaluate(
      (k) =>
        new Promise((r) => {
          const f = (i) => (i <= 0 ? r() : requestAnimationFrame(() => f(i - 1)));
          f(k);
        }),
      n,
    );
  const center = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`${sel} が無い`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const want = reduced ? '0s' : '0.22s';

  // (a) プリセット
  {
    if (phoneSize) await setShell(page, 'scenario', 'peek');
    await page.focus('.chart');
    await page.keyboard.press('0');
    await settleMotion(page);
    // 前の線の変化から LINE_MS（220ms）未満の変更は連打 = 即時（§6）なので、間を空けてから押す
    await page.waitForTimeout(300);
    await page.click('section.scenario .chip:has-text("急落")');
    const ls = await lineStyle();
    const ro = await page.evaluate(() => {
      const el = document.querySelector('section.stage .readout .ro .v');
      return el ? getComputedStyle(el).transitionDuration : null;
    });
    check(
      `${ac}(a) ${tag} プリセットを押した直後の指定日・満期の線の transition が d ${want}`,
      ls.length === 2 &&
        ls.every(
          (l) =>
            l.prop
              .split(',')
              .map((x) => x.trim())
              .includes('d') && l.dur === want,
        ),
      `${ls.map((l) => `${l.kind} ${l.prop} ${l.dur}・animation ${l.anims}`).join(' / ')}`,
    );
    check(
      `${reduced ? '#91 AC-C2' : '#91 §6'} ${tag} 読み取りの数字の色の transition が ${reduced ? '0s' : '0.2s'}`,
      ro === (reduced ? '0s' : '0.2s'),
      `${ro}`,
    );
    await settleMotion(page);
    await page.click('section.scenario .chip:has-text("リセット")');
    await settleMotion(page);
  }

  // (b) 連続の変更の .live（reduce では測らない）
  if (!reduced) {
    for (const [name, sel, dx, dy] of [
      ['ハンドル', '.chart .handle-hit', 20, 0],
      ['IV レール', '.ivrail .knob', 0, -20],
      ['時間レール', '.timerail .knob', 20, 0],
    ]) {
      const at = await center(sel);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dx, at.y + dy, { steps: 5 });
      await frames(2);
      const during = { live: await live(), ls: await lineStyle() };
      await page.mouse.up();
      // 離して 2 フレーム後に hold を外す。ドラッグの最後の線の変化は連打のパルス（LIVE_SETTLE_MS 120ms）でも保つ
      await frames(2);
      await page.waitForTimeout(200);
      const after = await live();
      check(
        `#91 AC-C1(b) ${tag} ${name}のドラッグ中は .stage-main の .live / [data-live]・線の transition-duration 0s、離して 200ms 後に .live なし`,
        during.live && during.ls.length >= 1 && during.ls.every((l) => l.dur === '0s') && !after,
        `中 ${during.live}・${during.ls.map((l) => l.dur).join(',')}・後 ${after}`,
      );
      await settleMotion(page);
    }
    await page.focus('.chart');
    await page.keyboard.press('0');
    await settleMotion(page);
  }

  // (c) 足の追加 → 新しいマーカーに legmark-in
  {
    if (phoneSize) await setShell(page, 'board', 'peek');
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('.chart .legmark')].map((m) => m.getAttribute('data-leg-id')),
    );
    await page.locator(`${ACTIVE_WRAP} tr.atm button[aria-label*=" bid "]`).first().click();
    const anim = await page
      .waitForFunction(
        (ids) => {
          const m = [...document.querySelectorAll('.chart .legmark')].find(
            (x) => !ids.includes(x.getAttribute('data-leg-id')),
          );
          if (!m) return null;
          return m.getAnimations().map((a) => ({
            name: a.animationName ?? '',
            dur: a.effect?.getTiming().duration ?? null,
          }));
        },
        before,
        { timeout: 3000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    const ok = reduced
      ? Array.isArray(anim) && !anim.some((a) => a.name === 'legmark-in')
      : Array.isArray(anim) && anim.some((a) => a.name === 'legmark-in' && a.dur === 120);
    check(
      `${ac}(c) ${tag} 足を追加した直後の新しい足マーカーに ${reduced ? 'animation なし' : 'legmark-in（120ms）'}`,
      ok,
      JSON.stringify(anim),
    );
    await settleMotion(page);
  }

  // (d) スマホのシート peek → full の高さ
  if (phoneSize) {
    await setShell(page, 'scenario', 'peek');
    // #123: 押してから補間が終わるまでの舞台の満期の線（足があれば必ずある）の d の書き換えを数える（補間中は大きさを
    // 反映しない）。0 回は数え損ね（ミニの切替で必ず 1 回は書く）
    const countD = () =>
      page.evaluate(() => {
        window.__dw?.disconnect();
        window.__dn = 0;
        const st = document.querySelector('section.stage');
        if (!st) return;
        window.__dw = new MutationObserver((ms) => {
          for (const m of ms) if (m.target.matches?.('.ln.expiry')) window.__dn += 1;
        });
        window.__dw.observe(st, { subtree: true, attributes: true, attributeFilter: ['d'] });
      });
    const readD = () =>
      page.evaluate(() => {
        window.__dw?.disconnect();
        return window.__dn ?? null;
      });
    // 終わりの反映が来たか: 舞台の svg の幅・高さが描画域（.chart）の clientWidth / clientHeight の切り捨てと同じ
    const svgFits = () =>
      page.evaluate(() => {
        const c = document.querySelector('section.stage .chart');
        const svg = c?.querySelector(':scope > svg');
        if (!c || !svg) return null;
        const want = `${Math.floor(c.clientWidth)}x${Math.floor(c.clientHeight)}`;
        const got = `${svg.getAttribute('width')}x${svg.getAttribute('height')}`;
        return { ok: want === got, want, got };
      });
    await countD();
    await page.click('section.scenario .grabber');
    const t = await page.evaluate(() => {
      const el = document.querySelector('section.scenario');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        prop: cs.transitionProperty,
        dur: cs.transitionDuration,
        running: el
          .getAnimations()
          .filter((a) => a.transitionProperty === 'height')
          .map((a) => a.effect?.getTiming().duration ?? null),
        sheet: document.querySelector('.layout')?.getAttribute('data-sheet'),
      };
    });
    await settleMotion(page);
    const m = await measure(page);
    const wantSheet = reduced ? '0s' : '0.18s';
    check(
      `${ac}(d) ${tag} シート peek → full の直後の高さの transition が ${wantSheet}${reduced ? '' : '（走っている）'}・終わった後に縦 0・横 0`,
      t !== null &&
        t.sheet === 'full' &&
        t.prop
          .split(',')
          .map((x) => x.trim())
          .includes('height') &&
        t.dur === wantSheet &&
        (reduced ? t.running.length === 0 : t.running.length === 1) &&
        m.v === 0 &&
        m.h === 0,
      `${JSON.stringify(t)}・縦 ${m.v}・横 ${m.h}`,
    );
    await page.waitForTimeout(150);
    const toFull = await readD();
    const fitFull = await svgFits();
    await countD();
    await page.click('section.scenario .grabber');
    await settleMotion(page);
    await page.waitForTimeout(150); // 終わりの 1 回の反映（次のフレーム）まで数える
    const toPeek = await readD();
    const fitPeek = await svgFits();
    const sheetNow = await page.evaluate(() =>
      document.querySelector('.layout')?.getAttribute('data-sheet'),
    );
    if (!reduced) {
      check(
        `#123 ${tag} シート peek → full・full → peek の補間の間の舞台の満期の線の d の書き換えがそれぞれ 1〜2 回（ミニの切替 1 + 終わり 1）・終わった後の svg の大きさが描画域と同じ`,
        sheetNow === 'peek' &&
          toFull >= 1 &&
          toFull <= 2 &&
          toPeek >= 1 &&
          toPeek <= 2 &&
          fitFull?.ok === true &&
          fitPeek?.ok === true,
        `→ full ${toFull} 回（svg ${fitFull?.got} / 描画域 ${fitFull?.want}）・→ peek ${toPeek} 回（svg ${fitPeek?.got} / 描画域 ${fitPeek?.want}）（${sheetNow}）`,
      );
    }
    await setShell(page, 'scenario', 'peek');
  }
  if (reduced) {
    await ctx.close();
    return;
  }

  // (g) AC-C6: パレットの ATM へ → 手で 300px → [最新]（読み直し。/api/chain を同じ合成の板に差し替える）。
  //     atmJump の要求は 1 回で消費する = 読み直しの後に ATM への「跳び」（強調 .hit の付く jump）が起きない。
  //     読み直しで板が新しいオブジェクトになると、#85 の規則（初めて見えたときに ATM へ。強調なし）で枠は ATM の位置に
  //     戻る（手のスクロールは保たない）。Issue の AC-C6 は 2026-10-18 にこの言い方へ改訂した（元の「scrollTop が読み直しの
  //     前と同じ」は #85 の規則と矛盾するため）
  {
    const boardText = readFileSync(join(root, FIXTURE_PATH), 'utf8');
    await ctx.route('**/api/calendar**', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
    );
    let chainN = 0;
    await ctx.route('**/api/chain**', (route) => {
      chainN += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: boardText });
    });
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await openPalette(page);
    await page.keyboard.type('ATM');
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200); // 強調（0.9 秒）が消えるまで
    const top = await page.evaluate((sel) => {
      const w = document.querySelector(sel);
      if (!w) return null;
      const atm = w.scrollTop;
      w.scrollTop += 300;
      return { atm, manual: w.scrollTop };
    }, ACTIVE_WRAP);
    await page.waitForTimeout(300);
    // 読み直しの間に板の行へ強調（.hit = atmJump / [ATM] の jump）が付いたら記録する
    await page.evaluate(() => {
      window.__hit = 0;
      const root = document.querySelector('section.board');
      if (!root) return;
      new MutationObserver(() => {
        if (root.querySelector('tr.hit')) window.__hit += 1;
      }).observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
      });
    });
    await page.click(LATEST_BTN);
    await page.waitForSelector('.pill[data-state="loading"]', { timeout: 2000 }).catch(() => null);
    await page.waitForSelector('.pill[data-state="ready"]', { timeout: 10000 });
    await page.waitForTimeout(1000);
    await closeNotes(page);
    const after = await page.evaluate(
      (sel) => ({ top: document.querySelector(sel)?.scrollTop ?? null, hit: window.__hit }),
      ACTIVE_WRAP,
    );
    check(
      `#91 AC-C6 ${tag} パレットの ATM へ → 板を手で 300px → [最新] で読み直しても（板の要求 1 回）ATM へ跳び直さない（強調なし）・枠は #85 の規則の ATM の位置（±1px）`,
      top !== null &&
        after.top !== null &&
        after.hit === 0 &&
        Math.abs(after.top - top.atm) <= 1 &&
        chainN === 1,
      `ATM ${top?.atm}・手 ${top?.manual} → 読み直し後 ${after.top}・強調 ${after.hit} 回・板 ${chainN} 回`,
    );
  }

  // (h) AC-C7: 1〜5 の行き先の名前
  {
    if (phoneSize) await setShell(page, 'positions', 'hidden');
    const names = [];
    for (const key of ['1', '2', '3', '4', '5']) {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      names.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          return {
            role: el?.getAttribute('role') ?? null,
            label: el?.getAttribute('aria-label') ?? '',
          };
        }),
      );
    }
    const labels = names.map((n) => n.label.trim());
    check(
      `#91 AC-C7 ${tag} 1〜5 で移る 5 つの枠の名前が空でなく互いに違う（role group）`,
      labels.every((l) => l.length > 0) &&
        new Set(labels).size === 5 &&
        names.every((n) => n.role === 'group'),
      names.map((n) => `${n.role}「${n.label}」`).join('・'),
    );
  }
  await ctx.close();
}

// ---- IV 推移の手順（#79 段 B AC-10・AC-12）
async function ivFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const isPc = vp.width >= 1200;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  // トップバーの [最新] は合成の板（latest）に差し替える（手元の API を起こさない）
  const latestText = readFileSync(join(root, FIXTURE_PATH), 'utf8');
  // [最新] で実際に読み直したか（#123: 押せていないのに「読み直さない」が pass しないように）
  let chainN = 0;
  await ctx.route('**/api/chain**', (route) => {
    chainN += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: latestText });
  });
  await ctx.route('**/api/calendar**', (route) =>
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
  );
  const page = await ctx.newPage();
  // 右端の 1 回分（範囲なし）だけを数える（段 C: 足が少ない 15 分足などは左の追加読み込み = start= の要求が出る）
  const reqs = [];
  const all = [];
  page.on('request', (r) => {
    if (!r.url().includes('atm_iv')) return;
    const q = new URL(r.url()).search;
    all.push(q);
    if (!q.includes('start=')) reqs.push(q);
  });
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page.waitForTimeout(1500);
  check(
    `#79 AC-10 ${tag} 起動して 1.5 秒: IV のエンドポイントへの要求が 0 回`,
    all.length === 0,
    `${all.length} 回`,
  );

  const toIv = async () => {
    if (isPc) await page.click('section.panel .panel-head .seg button:has-text("IV 推移")');
    else {
      await setShell(page, 'smile', 'peek');
      await page.click('section.smile .panel-head .seg button:has-text("IV 推移")');
    }
  };
  const toSmile = async () => {
    if (isPc) await page.click('section.smile .panel-head .seg button:has-text("板")');
    else await page.click('section.smile .panel-head .seg button:has-text("スマイル")');
  };
  const ready = () =>
    page
      .waitForFunction(
        () =>
          !!document.querySelector('section.smile .iv-wrap svg') &&
          !document.querySelector('section.smile .iv-loading') &&
          document.querySelector('section.smile .iv-refresh')?.disabled === false,
        undefined,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
  await toIv();
  const shown = await ready();
  check(
    `#79 AC-10 ${tag} IV 推移を開くと 1 回（右端 = tf=1h だけ）で描く`,
    shown && all.length === 1 && reqs[0] === '?tf=1h',
    `${all.join(' ')}・描画 ${shown}`,
  );
  const prog = await page.locator('section.smile .iv-bar.progress').count();
  check(`#79 AC-12 ${tag} 右端の進行中の足は .iv-bar.progress（1 個）`, prog === 1, `${prog} 個`);

  // 閉じて開き直す（PC: 市場を板 → IV 推移、スマホ: スマイル → IV 推移・ドックで別のパネル → スマイル）
  await toSmile();
  await page.waitForTimeout(200);
  if (!isPc) {
    await setShell(page, 'positions', 'peek');
    await setShell(page, 'smile', 'peek');
  }
  await toIv();
  await ready();
  await page.waitForTimeout(500);
  check(
    `#79 AC-10 ${tag} 閉じて開き直しても再要求しない（1 回のまま）`,
    all.length === 1,
    `${all.length} 回`,
  );

  await page.click('section.smile .iv-refresh');
  const refreshed = await ready();
  check(
    `#79 AC-10 ${tag} 最新化ボタンで右端の 1 回（2 回）`,
    refreshed && reqs.length === 2 && reqs[1] === '?tf=1h',
    reqs.join(' '),
  );

  // 線のモードの進行中の区間
  await page.click('section.smile .iv-tools button:has-text("線")');
  await page.waitForTimeout(150);
  const lp = await page.locator('section.smile .iv-line.progress').count();
  check(
    `#79 AC-12 ${tag} 線のモードは最後の区間を .iv-line.progress（1 個）`,
    lp === 1,
    `${lp} 個`,
  );
  await page.click('section.smile .iv-tools button:has-text("ローソク")');

  // 足の切替: 1 分 → 1 回、5 分・15 分は 1 分を共有、1 時間は読み済み
  const tfClick = async (label) => {
    await page.click(`section.smile .iv-tools button[aria-label="${label}"]`);
    await ready();
    await page.waitForTimeout(200);
  };
  await tfClick('1 分足');
  const n1 = reqs.length;
  await tfClick('5 分足');
  await tfClick('15 分足');
  await tfClick('1 時間足');
  check(
    `#79 ${tag} 足の切替: 1 分で 1 回、5 分・15 分は 1 分を共有、1 時間は読み済み（右端の要求 3 回。左の追加は別に数える）`,
    n1 === 3 && reqs.length === 3 && reqs[2] === '?tf=1m',
    `${reqs.join(' ')}（左 ${all.length - reqs.length} 回）`,
  );

  // トップバーの [最新] では IV を読み直さない
  const chain0 = chainN;
  await page.click(LATEST_BTN);
  await page.waitForSelector('.pill[data-state="ready"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  check(
    `#79 ${tag} トップバーの [最新] では IV を読み直さない（3 回のまま。板は 1 回読み直す）`,
    reqs.length === 3 && chainN === chain0 + 1,
    `IV ${reqs.length} 回・板 ${chainN - chain0} 回`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-iv-${tag}.png`) });
  await ctx.close();

  // 失敗 → 読み込めませんでした + [再試行] → 成功
  {
    const ctx2 = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    let fail = true;
    await ctx2.route('**/fixtures/atm_iv**', (route) =>
      fail
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"unavailable"}',
          })
        : route.fallback(),
    );
    const p2 = await ctx2.newPage();
    await p2.goto(pageUrl('next'));
    await waitReady(p2, 'next');
    if (isPc) await p2.click('section.panel .panel-head .seg button:has-text("IV 推移")');
    else {
      await setShell(p2, 'smile', 'peek');
      await p2.click('section.smile .panel-head .seg button:has-text("IV 推移")');
    }
    const failedShown = await p2
      .waitForSelector('section.smile .iv-failed button', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    fail = false;
    if (failedShown) await p2.click('section.smile .iv-failed button');
    const ok = await p2
      .waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check(
      `#79 ${tag} 失敗（503）で「読み込めませんでした」と [再試行]、押すと描く`,
      failedShown && ok,
    );
    await ctx2.close();
  }
}

// ---- 先物推移の手順（#190 AC-9）
async function futFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const isPc = vp.width >= 1200;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const latestText = readFileSync(join(root, FIXTURE_PATH), 'utf8');
  // [最新] で実際に読み直したか（#123: 押せていないのに「読み直さない」が pass しないように）
  let chainN = 0;
  await ctx.route('**/api/chain**', (route) => {
    chainN += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: latestText });
  });
  await ctx.route('**/api/calendar**', (route) =>
    route.fulfill({ status: 500, contentType: 'text/plain', body: 'x' }),
  );
  const page = await ctx.newPage();
  const fut = [];
  const iv = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith('/future_bars')) fut.push(u.search);
    if (u.pathname.endsWith('/atm_iv')) iv.push(u.search);
  });
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page.waitForTimeout(1500);
  check(
    `#190 AC-9 ${tag} 起動して 1.5 秒: future_bars・atm_iv への要求が 0 回`,
    fut.length === 0 && iv.length === 0,
    `先物 ${fut.length}・IV ${iv.length}`,
  );
  const seg = (text) =>
    isPc
      ? page.click(`section.market:visible .panel-head .seg button:text-is("${text}")`)
      : page.click(`section.smile .panel-head .seg button:text-is("${text}")`);
  const ready = () =>
    page
      .waitForFunction(
        () =>
          !!document.querySelector('section.smile .iv-wrap svg') &&
          !document.querySelector('section.smile .iv-loading') &&
          document.querySelector('section.smile .iv-refresh')?.disabled === false,
        undefined,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
  if (!isPc) await setShell(page, 'smile', 'peek');
  await seg('IV 推移');
  await ready();
  await page.waitForTimeout(400);
  check(
    `#190 AC-9 ${tag} IV 推移を開くと atm_iv 1 回・future_bars 0 回`,
    iv.length === 1 && fut.length === 0,
    `IV ${iv.join(' ')}・先物 ${fut.length}`,
  );
  await seg('先物');
  const shown = await ready();
  await page.waitForTimeout(400);
  const head = await page.textContent('section.smile .panel-head > h2').catch(() => null);
  check(
    `#190 AC-9 ${tag} 先物を開くと future_bars 1 回（右端 = tf=1h）・atm_iv は増えない・見出し「先物推移」`,
    shown && fut.length === 1 && fut[0] === '?tf=1h' && iv.length === 1 && head === '先物推移',
    `先物 ${fut.join(' ')}・IV ${iv.length}・見出し ${head}`,
  );
  const now = await page.locator('section.smile .iv-now').count();
  check(`#190 ${tag} 「今」の印 1 個（新しい板・同じ限月）`, now === 1, `${now} 個`);

  // 閉じて開き直す（PC: 板 → 先物、スマホ: スマイル → 別のパネル → 先物）
  await seg(isPc ? '板' : 'スマイル');
  await page.waitForTimeout(200);
  if (!isPc) {
    await setShell(page, 'positions', 'peek');
    await setShell(page, 'smile', 'peek');
  }
  await seg('先物');
  await ready();
  await page.waitForTimeout(500);
  check(
    `#190 AC-9 ${tag} 閉じて開き直しても再要求しない（1 回のまま）`,
    fut.length === 1,
    `${fut.length} 回`,
  );
  await page.click('section.smile .iv-refresh');
  const refreshed = await ready();
  check(
    `#190 AC-9 ${tag} ⟳ で右端の 1 回（2 回）`,
    refreshed && fut.length === 2 && fut[1] === '?tf=1h',
    fut.join(' '),
  );

  // 日足: 合成の応答の限月交代（9 月限 → 12 月限）の印と札・読み取りの限月
  await page.click('section.smile .iv-tools button[aria-label="日足"]');
  await ready();
  // 足の切替は見ていた時間（1 時間足の数日）を保つので、R で初期表示（日足 100 本）に戻して交代の日を入れる
  await page.focus('section.smile .iv-wrap');
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  const roll = await page.evaluate(() => {
    const sec = document.querySelector('section.smile');
    return {
      lines: sec?.querySelectorAll('.fut-roll').length ?? 0,
      tags: [...(sec?.querySelectorAll('.fut-roll-tag') ?? [])].map((t) => t.textContent ?? ''),
      contract: (sec?.querySelector('.iv-readout .contract')?.textContent ?? '').trim(),
    };
  });
  check(
    `#190 AC-9 ${tag} 日足で限月交代の縦の点線 ≥ 1・札「12月限」・読み取りに限月`,
    roll.lines >= 1 && roll.tags.includes('12月限') && roll.contract === '12月限',
    `点線 ${roll.lines}・札 ${roll.tags.join(' ')}・読み取り ${roll.contract}`,
  );
  // 線のモード: 期近のつなぎ足 = 交代でも線を切らない（日足の初期表示の 100 本は欠けが無いので M は 1 回）
  await page.click('section.smile .iv-tools button:has-text("線")');
  await page.waitForTimeout(200);
  const ms = await page.evaluate(
    () =>
      (document.querySelector('section.smile .iv-line')?.getAttribute('d') ?? '').match(/M/g)
        ?.length ?? 0,
  );
  check(
    `#190 ${tag} 日足の線は限月交代でもつながる（期近のつなぎ足。M 1 回）`,
    ms === 1,
    `M ${ms} 回`,
  );
  await page.click('section.smile .iv-tools button:has-text("ローソク")');
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-fut-${tag}.png`) });

  // 切替で足を保つ: 先物の日足 → IV 推移も日足（IV の日足の 1 回分を読む）
  await seg('IV 推移');
  await ready();
  await page.waitForTimeout(400);
  const ivTf = await page
    .getAttribute('section.smile .iv-tools button[aria-label="日足"]', 'aria-pressed')
    .catch(() => null);
  check(
    `#190 AC-9 ${tag} 先物 → IV 推移の切替で足（日足）を保つ・IV は日足の 1 回分だけ読む`,
    ivTf === 'true' && iv.length === 2 && iv[1] === '?tf=1d',
    `日足 ${ivTf}・IV ${iv.join(' ')}`,
  );

  // トップバーの [最新] では先物を読み直さない（最後に。[最新] の後は板の出どころが API になる）
  await seg('先物');
  await ready();
  const before = fut.length;
  const chain0 = chainN;
  await page.click(LATEST_BTN);
  await page.waitForSelector('.pill[data-state="ready"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  check(
    `#190 AC-9 ${tag} トップバーの [最新] では読み直さない（future_bars・atm_iv の回数が同じ。板は 1 回読み直す）`,
    fut.length === before && iv.length === 2 && chainN === chain0 + 1,
    `先物 ${before} → ${fut.length}・IV ${iv.length}・板 ${chainN - chain0} 回`,
  );
  await ctx.close();
}

// ---- IV 推移の十字線と軸の札（#130 AC-7）。縦線は足に吸着、横線は指 / マウスの高さ（オーナーの決定 2026-10-18）
/** 十字線・札の状態（svg の座標）。縦軸の目盛り（y → 値）も返す */
const ivCrossState = (page) =>
  page.evaluate(() => {
    const sec = document.querySelector('section.smile');
    const svg = sec?.querySelector('.iv-wrap svg');
    if (!sec || !svg) return null;
    const W = Number(svg.getAttribute('width'));
    const H = Number(svg.getAttribute('height'));
    const tags = [...sec.querySelectorAll('.iv-tag')].map((g) => {
      const r = g.querySelector('rect');
      const x = Number(r?.getAttribute('x'));
      const y = Number(r?.getAttribute('y'));
      const w = Number(r?.getAttribute('width'));
      const h = Number(r?.getAttribute('height'));
      return {
        axis: g.classList.contains('x') ? 'x' : 'y',
        text: (g.querySelector('text')?.textContent ?? '').trim(),
        inside: x >= 0 && y >= 0 && x + w <= W + 0.01 && y + h <= H + 0.01 && w > 0,
      };
    });
    const hl = sec.querySelector('.iv-cross .iv-cursor.h');
    const vl = sec.querySelector('.iv-cross .iv-cursor.v');
    const box = svg.getBoundingClientRect();
    return {
      W,
      H,
      lines: sec.querySelectorAll('.iv-cross .iv-cursor').length,
      tags,
      xTag: tags.find((t) => t.axis === 'x')?.text ?? null,
      yTag: tags.find((t) => t.axis === 'y')?.text ?? null,
      hy: hl ? Number(hl.getAttribute('y1')) : null,
      vx: vl ? Number(vl.getAttribute('x1')) : null,
      time: (sec.querySelector('.iv-readout .time')?.textContent ?? '').trim(),
      ticks: [...sec.querySelectorAll('.iv-wrap .ax .ty')].map((t) => [
        Number(t.getAttribute('y')),
        (t.textContent ?? '').trim(),
      ]),
      left: box.left,
      top: box.top,
    };
  });

/** 縦軸の札の文字が横線の高さの IV（目盛りの 2 点から逆に読んだ値と 0.02 以内・読み取りと同じ小数 2 桁）か */
function ivYTagOk(st) {
  if (!st || st.hy === null || st.yTag === null || st.ticks.length < 2) return false;
  const num = (t) => Number(t.replace('−', '-').replace(/,/g, ''));
  const [y0, l0] = st.ticks[0];
  const [y1, l1] = st.ticks[st.ticks.length - 1];
  if (!(Math.abs(y1 - y0) > 0)) return false;
  const v = num(l0) + ((st.hy - y0) * (num(l1) - num(l0))) / (y1 - y0);
  return /^\d+\.\d{2}$/.test(st.yTag) && Math.abs(num(st.yTag) - v) <= 0.02;
}

/** PC 1440×900: マウスのホバーで十字線・札、外れると消える。キー , . で端の足まで札が svg の内側 */
async function ivCrossFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await openIv(page, vp.width);
  const box = await page.locator('section.smile .iv-wrap').boundingBox();
  if (!box) {
    check(`#130 AC-7(a) ${tag} IV 推移の描画域`, false, '描画域が無い');
    await ctx.close();
    return;
  }
  // (a) ホバー: 2 か所（高さを変える）で十字線 2 本・札 2 個、横の札 = 読み取りの時刻、横線 = マウスの高さ、縦の札 = その高さの IV
  const seen = [];
  for (const [fx, fy] of [
    [0.5, 0.35],
    [0.7, 0.6],
  ]) {
    const mx = box.x + box.width * fx;
    const my = box.y + box.height * fy;
    await page.mouse.move(mx, my);
    await page.waitForTimeout(120);
    const st = await ivCrossState(page);
    seen.push(st);
    const yOk = st && st.hy !== null && Math.abs(st.hy - (my - st.top)) <= 0.6;
    check(
      `#130 AC-7(a) ${tag} ホバー（${fx}, ${fy}）: 十字線 2 本・札 2 個（svg の内側）、横の札 = 読み取りの時刻、横線 = マウスの高さ、縦の札 = その高さの IV（小数 2 桁）`,
      st?.lines === 2 &&
        st.tags.length === 2 &&
        st.tags.every((t) => t.inside) &&
        st.xTag === st.time &&
        yOk &&
        ivYTagOk(st),
      st
        ? `線 ${st.lines}・札 ${st.tags.map((t) => `${t.axis}「${t.text}」${t.inside ? '' : '（外）'}`).join(' ')}・読み取り ${st.time}・横線 y ${st.hy}（マウス ${Math.round((my - st.top) * 10) / 10}）`
        : '描画域が無い',
    );
  }
  check(
    `#130 AC-7(a) ${tag} ホバーの位置を変えると縦の札が変わる（足の値に吸着しない）`,
    seen[0]?.yTag !== seen[1]?.yTag && seen[0]?.hy !== seen[1]?.hy,
    `${seen[0]?.yTag} → ${seen[1]?.yTag}`,
  );
  // 描画域の上の余白（上端より上）にマウス → 横線は上端で止まる
  await page.mouse.move(box.x + box.width * 0.5, box.y + 2);
  await page.waitForTimeout(120);
  const top = await ivCrossState(page);
  check(
    `#130 AC-7(a) ${tag} 描画域の上端より上では横線が上端（y = 10）で止まり、札は svg の内側`,
    top?.hy === 10 && top.tags.every((t) => t.inside),
    `横線 y ${top?.hy}`,
  );
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  await page.waitForTimeout(150);
  const out = await ivCrossState(page);
  check(
    `#130 AC-7(a) ${tag} マウスが外れると十字線 0 本・札 0 個`,
    out?.lines === 0 && out.tags.length === 0,
    `線 ${out?.lines}・札 ${out?.tags.length}`,
  );
  // (c) キー , . を端まで: 右端の足（. = 最新の足）、, を押し続けて見えている左端の足まで。札は常に svg の内側
  await page.focus('section.smile .iv-wrap');
  await page.keyboard.press('.');
  await page.waitForTimeout(80);
  const right = await ivCrossState(page);
  let last = null;
  let bad = 0;
  let steps = 0;
  for (; steps < 400; steps++) {
    await page.keyboard.press(',');
    const st = await ivCrossState(page);
    if (!st || st.lines === 0) break;
    if (!st.tags.every((t) => t.inside) || st.xTag !== st.time) bad++;
    last = st;
  }
  check(
    `#130 AC-7(c) ${tag} キー . で右端の足・, を押し続けて左端の足まで、札は svg の内側で横の札 = 読み取りの時刻（見えている範囲の外へ出たら十字線なし）`,
    right?.lines === 2 &&
      right.tags.every((t) => t.inside) &&
      right.xTag === right.time &&
      last !== null &&
      bad === 0 &&
      steps > 10,
    `右端 ${right?.xTag}（x ${right?.vx}）→ 左端 ${last?.xTag}（x ${last?.vx}）・${steps} 本・外 ${bad} 回`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-iv-cross-${tag}.png`) });
  await ctx.close();
}

/**
 * #207 AC1・AC2・AC4〜AC6（--flows）: 360×780 のタッチ（CDP）・全開のシート・段 3 つ。RSI の段の長押し 500ms → 段の十字線
 * （横線 = 指の高さ・札 = その高さの値）と指から離れた浮いた読み取り（指の位置を含まない）・価格は縦線だけ、長押しの前に
 * 6px 以上動かすとパン（十字線なし・横軸の目盛りが動く）、境目 1 を指で 20px 下へ → RSI +20、境目のダブルタップ →
 * 既定、MACD の段のダブルタップ → 最大化・もう一度 → 戻す。その間ページ・シートが動かない
 */
async function futPaneTouchFlow() {
  const tag = '360x780 touch';
  const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs }, { width: 360, height: 780 });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page.tap('.dock button[data-panel="smile"]');
  await page.waitForTimeout(300);
  await page.tap('section.smile .panel-head .seg button:text-is("先物")');
  await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
  for (const t of ['RSI', 'MACD', 'SO']) {
    await page.tap(`section.smile .iv-legend .ind-toggles button:text-is("${t}")`);
  }
  // 全開（つまみのタップ）
  if ((await page.getAttribute('.layout', 'data-sheet')) !== 'full') await page.tap('.grabber');
  await settleMotion(page);
  await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const tap2 = async (pt) => {
    for (let k = 0; k < 2; k++) {
      await touch('touchStart', [{ ...pt, id: 0 }]);
      await page.waitForTimeout(30);
      await touch('touchEnd', []);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);
  };
  const sheet = () => page.getAttribute('.layout', 'data-sheet');
  const sheet0 = await sheet();
  const st0 = await paneState(page);
  const midX = Math.round(st0.paneX + st0.paneW * 0.6);
  // (a) RSI の段のタップ（段の座標 30px。#217 で長押しからタップに）
  const a = { x: midX, y: Math.round(st0.paneTop[0] + 30) };
  await touch('touchStart', [{ ...a, id: 0 }]);
  await page.waitForTimeout(40);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const st1 = await paneState(page);
  // #227: 指を離した後は浮いた読み取りを出さない（段の中の見出しの値・縦軸の札だけ = PC のホバーと同じ）
  check(
    `#207 AC5・AC6 #217 #227 AC5(a) ${tag} RSI の段のタップで段の十字線（横線 = 指の高さ・札 = その高さの値）・価格は縦線と横軸の札だけ・離した後は浮いた読み取りなし（段の見出しに値）`,
    st1.cross === 1 &&
      st1.crossKind === 'rsi' &&
      st1.hy !== null &&
      Math.abs(st1.hy - (a.y - st0.paneTop[0])) <= 1 &&
      rsiTagOk(st1) &&
      st1.priceV === 1 &&
      st1.priceH === 0 &&
      st1.xTag === st1.time &&
      st1.float === null &&
      /RSI/.test(st1.head ?? '') &&
      /\d\.\d/.test(st1.head ?? ''),
    `十字線 ${st1.cross}・y ${st1.hy}・札 ${st1.tag}・価格 縦 ${st1.priceV} 横 ${st1.priceH}・浮き「${st1.float}」・見出し「${st1.head}」・指 ${a.y}px`,
  );
  // #217: 交点を押してドラッグで動く（パンしない）→ ほかの所のタップで消える（移らない）→ 長押しでは出ない
  // #227: つかんで動かす間だけ浮いた読み取り（指から離れた所）、離したら消える
  const xt0 = st1.xTick;
  await touch('touchStart', [{ x: a.x + 3, y: a.y + 2, id: 0 }]);
  const finger = { x: a.x + 3, y: a.y + 2 };
  for (let i = 1; i <= 4; i++) {
    finger.x = a.x + 3 - i * 10;
    finger.y = a.y + 2 + i * 2;
    await touch('touchMove', [{ ...finger, id: 0 }]);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(120);
  const stG = await paneState(page);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const stR = await paneState(page);
  check(
    `#217 ${tag} 段の十字線の交点を押して左へ 40px・下へ 8px ドラッグで付いて動く（パンしない）`,
    stG.cross === 1 &&
      stG.hy !== null &&
      Math.abs(stG.hy - (st1.hy ?? 0) - 8) <= 1.5 &&
      stG.time !== st1.time &&
      stG.xTick === xt0,
    `y ${st1.hy} → ${stG.hy}・時刻 ${st1.time} → ${stG.time}・目盛り ${xt0} → ${stG.xTick}`,
  );
  const fb = stG.floatBox;
  const awayFromFinger =
    fb !== null &&
    !(
      finger.y >= fb.top - 8 &&
      finger.y <= fb.bottom + 8 &&
      finger.x >= fb.left &&
      finger.x <= fb.right
    );
  check(
    `#227 AC5(b)(c) ${tag} 交点をつかんで動かす間だけ浮いた読み取り（横線の値 = 札・指から離れた所）、離した後は無い（十字線は残る）`,
    (stG.float ?? '').includes(stG.tag ?? '?') &&
      awayFromFinger &&
      stR.float === null &&
      stR.cross === 1 &&
      stR.tag === stG.tag,
    `つかむ間「${stG.float}」${fb ? ` ${Math.round(fb.top)}〜${Math.round(fb.bottom)}px` : ''}・指 ${finger.y}px → 離して「${stR.float}」・十字線 ${stR.cross}`,
  );
  // #227 AC5(d): 段のパン（交点から離れた所のドラッグ）で十字線の足を表示範囲の外へ → 縦線・段の十字線・札・浮いた読み取り
  // なし、読み取りの時刻 = カーソルなし（最新の足）。戻すとまた出る（値の座標に残る）
  const panX0 = Math.round(st0.paneX + st0.paneW * 0.18);
  const panY = Math.round(st0.paneTop[0] + 30);
  const panDx = Math.round(st0.paneW * 0.7);
  const panBy = async (x0, dx) => {
    await touch('touchStart', [{ x: x0, y: panY, id: 0 }]);
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', [{ x: Math.round(x0 + (dx * i) / steps), y: panY, id: 0 }]);
      await page.waitForTimeout(20);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(350);
  };
  await panBy(panX0, panDx);
  const stO = await paneState(page);
  await panBy(panX0 + panDx, -panDx);
  const stB = await paneState(page);
  check(
    `#227 AC5(d) ${tag} 段のパンで十字線の足を表示範囲の外へ → 段の十字線・価格の縦線・札・浮いた読み取りなし・読み取りは最新の足、戻すとまた出る`,
    stO.xTick !== stR.xTick &&
      stO.cross === 0 &&
      stO.priceV === 0 &&
      stO.tag === null &&
      stO.float === null &&
      stO.time === st0.time &&
      stB.cross === 1 &&
      stB.priceV === 1 &&
      stB.time === stR.time,
    `外 十字線 ${stO.cross}・縦 ${stO.priceV}・札 ${stO.tag}・浮き ${stO.float}・時刻 ${stO.time}（カーソルなし ${st0.time}）・目盛り ${stR.xTick} → ${stO.xTick} / 戻して 十字線 ${stB.cross}・縦 ${stB.priceV}・時刻 ${stB.time}（${stR.time}）`,
  );
  await touch('touchStart', [{ x: midX - 80, y: Math.round(st0.paneTop[0] + 12), id: 0 }]);
  await page.waitForTimeout(40);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const stH = await paneState(page);
  await touch('touchStart', [{ ...a, id: 0 }]);
  await page.waitForTimeout(650);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const stL = await paneState(page);
  check(
    `#217 ${tag} 段の十字線はほかの所のタップで消え（移らない）、長押しでは出ない`,
    stH.cross === 0 && stH.priceV === 0 && stL.cross === 0,
    `タップの後 ${stH.cross}・長押しの後 ${stL.cross}`,
  );
  // (b) すぐ 6px 以上動かす = パン
  const before = await paneState(page);
  await touch('touchStart', [{ ...a, id: 0 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: a.x + i * 12, y: a.y, id: 0 }]);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(550);
  const mid = await paneState(page);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  check(
    `#207 AC6 ${tag} 6px 以上動かすとパン（十字線なし・横軸が動く）`,
    before.cross === 0 && mid.cross === 0 && mid.priceV === 0 && mid.xTick !== before.xTick,
    `十字線 ${before.cross} → ${mid.cross}・目盛り ${before.xTick} → ${mid.xTick}`,
  );
  // (c) 境目 1 を指で 20px 下へ
  const b = { x: midX, y: Math.round(st0.paneTop[1] + 2) };
  await touch('touchStart', [{ ...b, id: 0 }]);
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [{ x: b.x, y: b.y + i * 4, id: 0 }]);
    await page.waitForTimeout(30);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  const st2 = await paneState(page);
  check(
    `#207 AC1・AC3 ${tag} 境目（RSI | MACD）を指で 20px 下へ → RSI +20・MACD −20、端末の設定に残る`,
    st2.paneH[0] === st0.paneH[0] + 20 &&
      st2.paneH[1] === st0.paneH[1] - 20 &&
      st2.prefs.fut_pane_h_rsi === st2.paneH[0],
    `${st0.paneH.join('/')} → ${st2.paneH.join('/')}・キー ${st2.keys.join(',')}`,
  );
  // (d) 境目のダブルタップ → 既定
  await tap2({ x: midX, y: Math.round(st2.paneTop[1] + 2) });
  const st3 = await paneState(page);
  check(
    `#207 AC2 ${tag} 境目のダブルタップで既定の高さ（56px）・キーを消す`,
    st3.kinds.length === 3 && st3.paneH.every((h) => h === 56) && st3.keys.length === 0,
    `${st3.kinds.join(',')} ${st3.paneH.join('/')}・キー ${st3.keys.join(',')}`,
  );
  // (d') AC1 の帯の幅: 境目 0（価格 | RSI）と境目 1（RSI | MACD）の ±9px を指で押して 12px 下へ → ドラッグになる
  //（境目 0 の −9px は価格の描画域の中）。1 回ごとに境目のダブルタップで既定に戻す
  const band = [];
  for (const [b, off] of [
    [0, -9],
    [0, 9],
    [1, -9],
    [1, 9],
  ]) {
    const sb = await paneState(page);
    const y0 = Math.round(sb.paneTop[b] + off);
    await touch('touchStart', [{ x: midX, y: y0, id: 0 }]);
    for (let i = 1; i <= 4; i++) {
      await touch('touchMove', [{ x: midX, y: y0 + i * 3, id: 0 }]);
      await page.waitForTimeout(30);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(250);
    const sa = await paneState(page);
    const d = sa.paneH[0] - sb.paneH[0];
    band.push({ b, off, d, ok: d === (b === 0 ? -12 : 12) && sa.cross === 0 });
    await tap2({ x: midX, y: Math.round(sa.paneTop[b]) });
  }
  check(
    `#207 AC1 ${tag} 境目の帯はタッチで ±10px（境目 0・1 の ±9px の押下がドラッグ。境目 0 の上は価格の描画域）`,
    band.every((r) => r.ok),
    band
      .map((r) => `境目 ${r.b} ${r.off > 0 ? '+' : ''}${r.off}px → RSI ${r.d > 0 ? '+' : ''}${r.d}`)
      .join('・'),
  );
  const st3b = await paneState(page);
  // (e) MACD の段のダブルタップ → 最大化、もう一度 → 戻す
  await tap2({ x: midX, y: Math.round(st3b.paneTop[1] + st3b.paneH[1] / 2) });
  const st4 = await paneState(page);
  await tap2({ x: midX, y: Math.round(st4.paneTop[0] + (st4.paneH[0] ?? 0) / 2) });
  const st5 = await paneState(page);
  const sheet1 = await sheet();
  const sy = await page.evaluate(() => window.scrollY);
  check(
    `#207 AC4 #217 ${tag} MACD の段のダブルタップで最大化（段 1 つ・価格なし・枠の全部）、もう一度で戻す（1 回目のタップの十字線は残らない）。シート・ページは動かない`,
    st4.kinds.join(',') === 'macd' &&
      st4.cross === 0 &&
      st5.cross === 0 &&
      st4.wrapH === null &&
      Math.abs((st4.paneH[0] ?? 0) - st4.stackH) <= 1 &&
      st5.kinds.join(',') === 'rsi,macd,stoch' &&
      st5.wrapH !== null &&
      sheet1 === sheet0 &&
      sy === 0,
    `${st4.kinds.join(',')} ${st4.paneH.join('/')} / 枠 ${st4.stackH} → ${st5.kinds.join(',')}・シート ${sheet0} → ${sheet1}・scrollY ${sy}`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-fut-panes-${tag}.png`) });
  await ctx.close();
}

/**
 * #207 再レビュー B2（--flows）: 縦に狭い覗く（段を縮めて描いている）でも境目のドラッグが指に 1:1。
 * (A) 覚えた RSI 120px・RSI だけの段（覗くでは縮めて描く）で境目 0 を指で 20px 下へ → RSI −20・価格 +20
 * (B) 段 3 つ（360 は 30px 前後 × 3・390 は 40px 前後 × 3）で境目 1 を 20px 下へ → RSI +・MACD −（下限 24px で
 *     止まるまで 1:1）・ほかの段と価格は同じ
 * どちらも動かしている間と離した後（保存の値で描き直し）が同じ高さ
 */
async function futPanePeekTouchFlow(vp) {
  const tag = `${vp.width}x${vp.height} touch peek`;
  for (const mode of ['A', 'B']) {
    const prefs = mode === 'A' ? { [PREFS_KEY]: prefsText('dark', { fut_pane_h_rsi: 120 }) } : {};
    const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs, ...prefs }, vp);
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await page.tap('.dock button[data-panel="smile"]');
    await page.waitForTimeout(300);
    await page.tap('section.smile .panel-head .seg button:text-is("先物")');
    await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
    for (const t of mode === 'A' ? ['RSI'] : ['RSI', 'MACD', 'SO']) {
      await page.tap(`section.smile .iv-legend .ind-toggles button:text-is("${t}")`);
    }
    if ((await page.getAttribute('.layout', 'data-sheet')) !== 'peek') await page.tap('.grabber');
    await settleMotion(page);
    await page.waitForTimeout(300);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, touchPoints) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const st0 = await paneState(page);
    const border = mode === 'A' ? 0 : 1;
    const midX = Math.round(st0.paneX + st0.paneW * 0.6);
    const y0 = Math.round(st0.paneTop[border] + 2);
    await touch('touchStart', [{ x: midX, y: y0, id: 0 }]);
    let during = null;
    for (let i = 1; i <= 5; i++) {
      await touch('touchMove', [{ x: midX, y: y0 + i * 4, id: 0 }]);
      await page.waitForTimeout(40);
      if (i === 5) during = await paneState(page);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(300);
    const st1 = await paneState(page);
    const h = st0.paneH;
    const want = mode === 'A' ? 20 : Math.min(20, (h[1] ?? 0) - 24);
    const follows = (st) => {
      if (!st || st.paneH.length !== h.length) return false;
      const d0 = st.paneH[0] - h[0];
      if (mode === 'A')
        return Math.abs(d0 + want) <= 1 && Math.abs(st.wrapH - st0.wrapH - want) <= 1;
      return (
        Math.abs(d0 - want) <= 1 &&
        Math.abs(h[1] - st.paneH[1] - want) <= 1 &&
        st.paneH.slice(2).every((x, i) => x === h[i + 2]) &&
        st.wrapH === st0.wrapH
      );
    };
    const constrained = mode === 'A' ? h[0] < 120 : st0.stackH < 56 + h.length * 56;
    check(
      `#207 B2 ${tag} ${mode === 'A' ? '(A) 覚えた RSI 120px を縮めて描く覗くで境目 0 を指で 20px 下へ → RSI −20・価格 +20' : `(B) 段 ${h.length} つを縮めて描く覗くで境目 1 を指で 20px 下へ → RSI +${want}・MACD −${want}（下限 24px まで）・ほかの段と価格は同じ`}（指に 1:1）、離した後も同じ高さ`,
      constrained && follows(during) && follows(st1),
      `枠 ${st0.stackH}px・${h.join('/')}（価格 ${st0.wrapH}）→ 動かしている間 ${during?.paneH.join('/')}（価格 ${during?.wrapH}）→ 離した後 ${st1.paneH.join('/')}（価格 ${st1.wrapH}）・保存 ${st1.keys.map((k) => `${k}=${st1.prefs[k]}`).join(',')}`,
    );
    await ctx.close();
  }
}

/**
 * 390×844 のタッチ（CDP。#217 の共通の規則）: タップで十字線・札 → 交点のドラッグで時刻が変わる → ほかの所のタップで消える →
 * 長押しでは出ない → ダブルタップの後に残らない。ページ・シートは動かない
 */
async function ivCrossTouchFlow() {
  const tag = '390x844 touch';
  const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page.tap('.dock button[data-panel="smile"]');
  await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(300);
  const box = await page.locator('section.smile .iv-wrap').boundingBox();
  if (!box) {
    check(`#130 AC-7(b) ${tag} IV 推移の描画域`, false, '描画域が無い');
    await ctx.close();
    return;
  }
  const shell = () =>
    page.evaluate(() => ({
      sheet: document.querySelector('.layout')?.getAttribute('data-sheet'),
      body: document.querySelector('section.smile > .panel-body')?.scrollTop ?? null,
      sy: window.scrollY,
    }));
  const s0 = await shell();
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const a = { x: Math.round(box.x + box.width * 0.6), y: Math.round(box.y + box.height * 0.45) };
  const tapAt = async (pt) => {
    await touch('touchStart', [{ ...pt, id: 0 }]);
    await page.waitForTimeout(40);
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
  };
  // (a) タップで置く（#217 で長押しからタップに）
  await tapAt(a);
  const st1 = await ivCrossState(page);
  // (b) 交点を押してドラッグで動く（パンしない）
  const cx = Math.round((st1?.left ?? 0) + (st1?.vx ?? 0));
  const cy = Math.round((st1?.top ?? 0) + (st1?.hy ?? 0));
  await touch('touchStart', [{ x: cx + 2, y: cy + 2, id: 0 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: cx + 2 - i * 10, y: cy + 2 + i * 5, id: 0 }]);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(120);
  const st2 = await ivCrossState(page);
  const s1 = await shell();
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const st3 = await ivCrossState(page);
  // (c) ほかの所のタップで消える（移らない）
  await tapAt({ x: a.x - 120, y: a.y - 20 });
  const st4 = await ivCrossState(page);
  const s2 = await shell();
  // (d) 長押しでは出ない、(e) ダブルタップ（初期表示）の後に十字線が残らない
  await touch('touchStart', [{ ...a, id: 0 }]);
  await page.waitForTimeout(650);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const st5 = await ivCrossState(page);
  for (let k = 0; k < 2; k++) {
    await touch('touchStart', [{ ...a, id: 0 }]);
    await page.waitForTimeout(30);
    await touch('touchEnd', []);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const st6 = await ivCrossState(page);
  const yAt = (st, y) => st && st.hy !== null && Math.abs(st.hy - (y - st.top)) <= 0.6;
  check(
    `#130 AC-7(b) #217 ${tag} タップで十字線 2 本・札 2 個、横の札 = 読み取りの時刻、横線 = 指の高さ、縦の札 = その高さの IV`,
    st1?.lines === 2 &&
      st1.tags.length === 2 &&
      st1.tags.every((t) => t.inside) &&
      st1.xTag === st1.time &&
      yAt(st1, a.y) &&
      ivYTagOk(st1),
    st1
      ? `線 ${st1.lines}・札 ${st1.xTag} / ${st1.yTag}・読み取り ${st1.time}・横線 y ${st1.hy}`
      : '',
  );
  check(
    `#130 AC-7(b) #217 ${tag} 交点を押して左へ 60px・下へ 30px ドラッグで札の時刻と縦の札が変わり、読み取りと一致`,
    st2?.lines === 2 &&
      st2.xTag !== st1?.xTag &&
      st2.xTag === st2.time &&
      st2.yTag !== st1?.yTag &&
      st2.hy !== null &&
      Math.abs(st2.hy - (st1?.hy ?? 0) - 30) <= 1.5,
    `${st1?.xTag} → ${st2?.xTag}・${st1?.yTag} → ${st2?.yTag}・y ${st1?.hy} → ${st2?.hy}`,
  );
  check(
    `#130 AC-7(b) #217 ${tag} 離しても残り、ほかの所のタップで消える。ドラッグの間ページ・シート・.panel-body が動かない`,
    st3?.lines === 2 &&
      st4?.lines === 0 &&
      st4.tags.length === 0 &&
      s1.sheet === s0.sheet &&
      s1.body === s0.body &&
      s1.sy === s0.sy &&
      s2.sheet === s0.sheet &&
      s2.sy === 0,
    `離した後 ${st3?.lines} 本・タップ後 ${st4?.lines} 本・シート ${s0.sheet}→${s1.sheet}→${s2.sheet}・scrollTop ${s0.body}→${s1.body}・scrollY ${s1.sy}`,
  );
  check(
    `#217 ${tag} IV 推移: 長押しでは十字線を出さない、ダブルタップ（初期表示）の後に 1 回目のタップの十字線が残らない`,
    st5?.lines === 0 && st6?.lines === 0,
    `長押し ${st5?.lines} 本・ダブルタップ ${st6?.lines} 本`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-iv-cross-${tag}.png`) });
  await ctx.close();
}

/**
 * スマホ・タブレット（#130 AC-7 (d)）: 起動 → atm_iv 0 回 → ドックの IV で IV 推移・1 回 → [スマイル] → 別のパネル →
 * ドックの IV でスマイルのまま。タブレットはキー 2（#275）でもパネルが開き中身（スマイル）を保つ
 */
async function ivDockFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const phoneSize = vp.width <= PHONE_MAX;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  const reqs = [];
  page.on('request', (r) => {
    if (r.url().includes('atm_iv')) reqs.push(r.url());
  });
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await page.waitForTimeout(1000);
  const n0 = reqs.length;
  const view = () =>
    page.evaluate(() => {
      const sec = document.querySelector('section.smile');
      return {
        name: sec?.getAttribute('aria-label') ?? null,
        iv: !!sec?.querySelector('.iv-tools'),
        smile: !!sec?.querySelector('.smile-wrap'),
        panel: document.querySelector('.layout')?.getAttribute('data-panel'),
      };
    });
  await page.click('.dock button[data-panel="smile"]');
  await page.waitForSelector('section.smile .iv-wrap svg', { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(300);
  const v1 = await view();
  check(
    `#130 AC-7(d) ${tag} 起動直後は atm_iv 0 回、ドックの IV で IV 推移が出て 1 回`,
    n0 === 0 && v1.name === 'IV 推移' && v1.iv && reqs.length === 1,
    `起動 ${n0} 回 → ${reqs.length} 回・${v1.name}`,
  );
  await smileTab(page);
  const v2 = await view();
  await page.click(`.dock button[data-panel="${phoneSize ? 'board' : 'positions'}"]`);
  await page.waitForTimeout(200);
  await page.click('.dock button[data-panel="smile"]');
  await page.waitForTimeout(300);
  const v3 = await view();
  check(
    `#130 AC-7(d) ${tag} [スマイル] → 別のパネル → ドックの IV でスマイルのまま（要求は 1 回のまま）`,
    v2.name === 'スマイル' && v2.smile && v3.name === 'スマイル' && v3.smile && reqs.length === 1,
    `${v2.name} → ${v3.name}・${reqs.length} 回`,
  );
  if (!phoneSize) {
    await page.click('.dock button[data-panel="positions"]');
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press('2');
    await page.waitForTimeout(250);
    const v4 = await view();
    check(
      `#130 AC-7(d) ${tag} キー 2（#275 の並び）で IV のパネルが開き、中身はスマイルのまま`,
      v4.panel === 'smile' && v4.name === 'スマイル' && v4.smile,
      `${v4.panel}・${v4.name}`,
    );
  }
  await ctx.close();
}

// ---- IV 推移の追加読み込み・「今」の印・シナリオの水準（#79 段 C AC-9・AC-11）
async function ivMoreFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const isPc = vp.width >= 1200;
  const isAtmIv = (url) => url.pathname.endsWith('/atm_iv');
  const open = async (page) => {
    if (isPc) await page.click('section.panel .panel-head .seg button:has-text("IV 推移")');
    else {
      await setShell(page, 'smile', 'peek');
      await page.click('section.smile .panel-head .seg button:has-text("IV 推移")');
    }
    return page
      .waitForFunction(
        () =>
          !!document.querySelector('section.smile .iv-wrap svg') &&
          !document.querySelector('section.smile .iv-loading'),
        undefined,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
  };
  /** 横の目盛り（ラベル → x） */
  const ticks = (page) =>
    page.$$eval('section.smile .iv-wrap .ax .tx', (els) =>
      els.map((e) => [e.textContent, Number(e.getAttribute('x'))]),
    );
  const yTicks = (page) =>
    page.$$eval('section.smile .iv-wrap .ax .ty', (els) => els.map((e) => e.textContent).join(' '));
  /** 描画域で ← を押して左へパン（cond が true になるまで。最大 n 回） */
  const panLeft = async (page, cond, n = 80) => {
    await page.focus('section.smile .iv-wrap');
    for (let i = 0; i < n && !cond(); i++) await page.keyboard.press('ArrowLeft');
  };
  const leftOf = (list) => list.filter((q) => q.includes('start='));

  // (a) 左へパンして端から 10 本で左の 1 回分。読み中は 2 本目を出さない・左上のバッジ。前に足しても横の目盛りが同じ
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    const reqs = [];
    let release = null;
    await ctx.route(isAtmIv, async (route) => {
      const q = new URL(route.request().url()).search;
      reqs.push(q);
      if (q.includes('start=') && leftOf(reqs).length === 1) {
        // 最初の左の応答を止めておく（読み中のバッジ・2 本目が出ないこと・応答の前後の目盛りを見る）
        await new Promise((r) => {
          release = r;
        });
      }
      await route.fallback();
    });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    const shown = await open(page);
    await panLeft(page, () => leftOf(reqs).length > 0);
    // デバウンス（250ms）を待つ
    await page
      .waitForFunction(
        () => !!document.querySelector('section.smile .iv-badge.left.iv-loading'),
        undefined,
        {
          timeout: 3000,
        },
      )
      .catch(() => {});
    await page.waitForTimeout(600);
    const left = leftOf(reqs);
    const badge = await page.locator('section.smile .iv-badge.left.iv-loading').count();
    const q = new URLSearchParams(left[0] ?? '');
    const aligned =
      /T00:00:00Z$/.test(q.get('start') ?? '') && /T00:00:00Z$/.test(q.get('end') ?? '');
    check(
      `#79 AC-9 ${tag} 左へパンして端から 10 本で左の 1 回分（tf=1h・UTC の 0 時・end = 読み済みの start 2026-08-15）、読み中は 2 本目なし・左上のバッジ`,
      shown &&
        left.length === 1 &&
        q.get('tf') === '1h' &&
        aligned &&
        q.get('end') === '2026-08-15T00:00:00Z' &&
        badge === 1,
      `${left.join(' ')}・バッジ ${badge}`,
    );
    const before = await ticks(page);
    release?.();
    await page
      .waitForFunction(() => !document.querySelector('section.smile .iv-badge.left'), undefined, {
        timeout: 5000,
      })
      .catch(() => {});
    await page.waitForTimeout(150);
    const after = await ticks(page);
    // 読む前に見えていた足の目盛りは同じ位置のまま（左の余白だった所に前の足が入って目盛りが増えるのはよい）
    const at = new Map(after);
    const kept = before.every(([l, x]) => at.has(l) && Math.abs(at.get(l) - x) < 1);
    const fmt = (t) => t.map(([l, x]) => `${l}@${Math.round(x)}`).join(' ');
    check(
      `#79 AC-9 ${tag} 前に足しても表示の時間範囲が変わらない（読む前の横の目盛りが同じ位置）`,
      before.length > 0 && kept,
      `${fmt(before)} → ${fmt(after)}`,
    );
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-iv-left-${tag}.png`) });
    await ctx.close();
  }

  // (b) 空の左が 3 回続けば止まる（空の後は続けて次を読む）
  {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    const reqs = [];
    await ctx.route(isAtmIv, async (route) => {
      const url = new URL(route.request().url());
      reqs.push(url.search);
      if (!url.searchParams.has('start')) return route.fallback();
      const iso = (v) => `${new Date(Date.parse(v)).toISOString().slice(0, 19)}+00:00`;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schema_version: 1,
          tf: url.searchParams.get('tf'),
          start: iso(url.searchParams.get('start')),
          end: iso(url.searchParams.get('end')),
          last_at: null,
          bars: [],
        }),
      });
    });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await open(page);
    await panLeft(page, () => leftOf(reqs).length > 0);
    await page.waitForTimeout(2000);
    const n3 = leftOf(reqs).length;
    await panLeft(page, () => false, 10);
    await page.waitForTimeout(800);
    check(
      `#79 AC-9 ${tag} 空の左が 3 回続けば止まる（パンし直しても読まない）`,
      n3 === 3 && leftOf(reqs).length === 3,
      `${n3} → ${leftOf(reqs).length} 回`,
    );
    await ctx.close();
  }

  // (c) 「今」の印: 合成の表の last_at（板の 50 分前）より新しい板なら 1 個、last_at が板より後なら 0 個
  for (const late of [false, true]) {
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
    if (late) {
      await ctx.route(isAtmIv, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        body.last_at = '2026-10-13T21:40:00+09:00';
        await route.fulfill({ response: res, body: JSON.stringify(body) });
      });
    }
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await open(page);
    await page.waitForTimeout(300);
    const marks = await page.locator('section.smile .iv-now').count();
    const legend = await page.locator('section.smile .iv-legend .now').count();
    check(
      late
        ? `#79 AC-11 ${tag} 表の last_at が板の snapshot_at より後なら「今」の印は出ない`
        : `#79 AC-11 ${tag} 表の最後の行より新しい板なら「今」の印が 1 個（凡例にも値）`,
      late ? marks === 0 && legend === 0 : marks === 1 && legend === 1,
      `印 ${marks}・凡例 ${legend}`,
    );
    await ctx.close();
  }

  // (d) PC: シナリオの水準 = 今 + 5.00（ΔX 0・Δσ +5）→ [急落]（ΔX −10%・Δσ 20・β 1）で 今 + 39.45（Δσ 20 + g(−10%) 19.45。#306）
  if (isPc) {
    const ws = JSON.parse(twoLegs);
    ws.tabs[0].position.scenario = {
      ...ws.tabs[0].position.scenario,
      dX: 0,
      dSigma: 5,
      beta: 1,
      skew: 0,
    };
    const ctx = await newContext(vp, { [WORKSPACE_KEY]: JSON.stringify(ws) });
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await open(page);
    await page.waitForTimeout(300);
    const num = (sel) =>
      page
        .textContent(sel)
        .then((t) => Number((t ?? '').replace(/[^\d.-]/g, '')))
        .catch(() => Number.NaN);
    const now = await num('section.smile .iv-legend .now');
    const sc = await num('section.smile .iv-legend .sc');
    const y1 = await page.getAttribute('section.smile .iv-scenario', 'y1').catch(() => null);
    const ty1 = await yTicks(page);
    check(
      `#79 AC-11 ${tag} ΔX 0・Δσ +5 でシナリオの水準 = 今 + 5.00（${now} → ${sc}）`,
      Number.isFinite(now) && Math.abs(sc - now - 5) < 0.0051 && y1 !== null,
    );
    await page.click('section.scenario .chip:has-text("急落")');
    await page.waitForTimeout(300);
    const sc2 = await num('section.smile .iv-legend .sc');
    const y2 = await page.getAttribute('section.smile .iv-scenario', 'y1').catch(() => null);
    const ty2 = await yTicks(page);
    // 水準は縦軸に入る（足より上なら縦軸の上端が広がるので、線の y は上端付近のまま目盛りが変わる）
    check(
      `#79 AC-11 ${tag} [急落]（ΔX −10%・Δσ 20・β 1）で水準 = 今 + 39.45（Δσ 20 + g(−10%) 19.45。#306）（${sc2}）、縦軸が水準まで広がる`,
      Math.abs(sc2 - now - 39.45) < 0.0051 && y2 !== null && (y2 !== y1 || ty2 !== ty1),
      `y ${y1} → ${y2}・縦の目盛り ${ty1} → ${ty2}`,
    );
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-iv-scenario-${tag}.png`) });
    await ctx.close();
  }
}

// ---- AI のチャット（#135）
const aiStats = { pass: 0, total: 0 };

/** PC で左の列が AI なら、トップバーの [AI] で市場に戻す（#280） */
async function closeAiPc(page) {
  if ((await page.getAttribute('.layout', 'data-left')) === 'ai') {
    await page.click('.top button[data-ai="top"]');
    await page.waitForTimeout(120);
  }
}

/** AI のパネルを開く（スマホ = ドックの AI でシート sheet、タブレット = ドックの AI、PC = トップバーの [AI]） */
async function openAi(page, w, sheet = 'peek') {
  if (w >= 1200) {
    const on = await page.getAttribute('.layout', 'data-left');
    if (on !== 'ai') await page.click('.top button[data-ai="top"]');
  } else if (w <= PHONE_MAX) {
    if (!(await setShell(page, 'ai', sheet))) return false;
  } else {
    await page.click('.dock button[data-panel="ai"]');
  }
  await page.waitForSelector('section.ai .ai-foot', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(200);
  return true;
}

/**
 * AI のパネルの中（#135 AC7）: 見出しの残り（$ を含む・切れない・窓の中）、[このポジションを診断]・入力欄・送信が窓の中、
 * 定型の質問の行（#140 AC5。6 つ。行は窓の中で、入らない分は行の中を横にスクロール）、
 * 見出し・ボタン・チップ・進み具合の行が切れていない、.panel-body が横にはみ出していない、ドックの 6 つ（5 つ）のラベルが切れない
 */
async function aiCheck(page, label, w) {
  const r = await page.evaluate(() => {
    const sec = document.querySelector('section.ai');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inWin = (el) => {
      if (!el) return false;
      const q = el.getBoundingClientRect();
      return (
        q.width > 0 &&
        q.height > 0 &&
        q.left >= -0.5 &&
        q.right <= vw + 0.5 &&
        q.top >= -0.5 &&
        q.bottom <= vh + 0.5
      );
    };
    const cut = (el) => !!el && el.scrollWidth > el.clientWidth + 0.5;
    const sub = sec?.querySelector('.panel-head .sub');
    const body = sec?.querySelector('.panel-body');
    const dock = [...document.querySelectorAll('.dock > button')].map((b) => ({
      id: b.getAttribute('data-panel'),
      cut: cut(b.querySelector('.lbl')) || cut(b),
    }));
    const heads = [
      ...(sec?.querySelectorAll(
        '.panel-head h2, .panel-head .btn, .ai-actions .btn, .ai-presets .chip, .ai-input .btn, .ai-progress',
      ) ?? []),
    ];
    return {
      remaining: (sub?.textContent ?? '').trim(),
      remainingOk: inWin(sub) && !cut(sub),
      diagnose: inWin(sec?.querySelector('button[data-ai="diagnose"]')),
      presets: inWin(sec?.querySelector('[data-ai="presets"]')),
      presetChips:
        sec?.querySelectorAll('[data-ai="presets"] .chip:not([data-ai="diagnose"])').length ?? 0,
      presetsOver: (() => {
        const row = sec?.querySelector('[data-ai="presets"]');
        return !!row && row.scrollWidth > row.clientWidth + 0.5;
      })(),
      input: inWin(sec?.querySelector('.ai-input textarea')),
      send: inWin(sec?.querySelector('button[data-ai="send"]')),
      cuts: heads.filter(cut).map((e) => (e.textContent ?? '').trim().slice(0, 12)),
      bodyOver: !!body && body.scrollWidth > body.clientWidth + 0.5,
      dock,
      disclaimer: !!sec?.querySelector('[data-ai="disclaimer"]'),
    };
  });
  const bad = [];
  if (!r.remaining.includes('$')) bad.push(`残りの表示「${r.remaining}」`);
  if (!r.remainingOk) bad.push('残りが切れている / 窓の外');
  if (!r.diagnose) bad.push('[このポジションを診断] が窓の外');
  if (!r.presets) bad.push('定型の質問の行が窓の外');
  if (r.presetChips !== 6) bad.push(`定型のチップ ${r.presetChips} 個`);
  if (r.presetsOver) bad.push('定型の質問の行の外枠が横にはみ出す');
  if (!r.input || !r.send) bad.push('入力欄・送信が窓の外');
  if (r.cuts.length) bad.push(`切れ ${r.cuts.join('、')}`);
  if (r.bodyOver) bad.push('.panel-body が横にはみ出す');
  const dockCut = r.dock.filter((d) => d.cut).map((d) => d.id);
  if (dockCut.length) bad.push(`ドックの切れ ${dockCut.join('、')}`);
  if (w < 1200 && r.dock.length !== (w <= PHONE_MAX ? 6 : 5))
    bad.push(`ドック ${r.dock.length} 個`);
  aiStats.total++;
  const ok = bad.length === 0;
  if (ok) aiStats.pass++;
  else failed = true;
  console.log(`${label}: AI のパネル ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`);
  return r;
}

/**
 * #280（EPIC #281 終了条件 12・AC1・AC2・AC6）: PC 1440×900 で AI を開いている間、AI は左の列（市場の列と入れ替わり、
 * 板・スマイルは隠れる）、指標のタイル 6 枚とテール表 5 行（18 セル）の下端が窓の中（右の列はスクロールしていない）、
 * トップバーの [AI] はチップ（.chip）で svg を 1 つ持ち aria-pressed="true"
 */
async function aiSideCheck(page, label) {
  const r = await page.evaluate(() => {
    const vh = window.innerHeight;
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const ai = document.querySelector('section.ai');
    const sec = document.querySelector('section.metrics');
    const tiles = [...(sec?.querySelectorAll('.metric-tiles .tile') ?? [])].filter(vis);
    const cells = [
      ...(sec?.querySelectorAll(
        'table.tail:not(.margin-tail) thead th, table.tail:not(.margin-tail) tbody th, table.tail:not(.margin-tail) tbody td',
      ) ?? []),
    ];
    const bottoms = [...tiles, ...cells].map((el) => el.getBoundingClientRect().bottom);
    const top = document.querySelector('.top button[data-ai="top"]');
    return {
      vh,
      left: ai ? Math.round(ai.getBoundingClientRect().left) : -1,
      market:
        vis(document.querySelector('section.board')) ||
        vis(document.querySelector('section.smile')),
      positions: vis(document.querySelector('section.positions')),
      tiles: tiles.length,
      rows: sec?.querySelectorAll('table.tail:not(.margin-tail) tbody tr').length ?? 0,
      cells: cells.length,
      max: bottoms.length ? Math.max(...bottoms) : Number.NaN,
      scroll: sec?.querySelector('.panel-body')?.scrollTop ?? -1,
      chip: !!top?.classList.contains('chip') && top.querySelectorAll('svg').length === 1,
      pressed: top?.getAttribute('aria-pressed') === 'true',
    };
  });
  const bad = [];
  if (r.left !== 0) bad.push(`AI の左端 ${r.left}px`);
  if (r.market) bad.push('板 / スマイルが見えている');
  if (!r.positions) bad.push('ポジションが見えない');
  if (r.tiles !== 6) bad.push(`タイル ${r.tiles} 枚`);
  if (r.rows !== 5 || r.cells !== 18) bad.push(`テール表 ${r.rows} 行・${r.cells} セル`);
  if (!(r.max <= r.vh)) bad.push(`下端の最大 ${Math.round(r.max)}px`);
  if (r.scroll !== 0) bad.push(`右の列のスクロール ${r.scroll}`);
  if (!r.chip) bad.push('[AI] がチップ + svg でない');
  if (!r.pressed) bad.push('[AI] が押されていない');
  aiStats.total++;
  const ok = bad.length === 0;
  if (ok) aiStats.pass++;
  else failed = true;
  console.log(
    `${label}: #280 AI は左の列・タイル ${r.tiles} 枚とテール表 ${r.rows} 行の下端の最大 ${Math.round(r.max)}px（窓 ${r.vh}px）・[AI] はチップ ${ok ? 'pass' : `${bad.join('・')}  ← NG`}`,
  );
}

/** 診断を押して返答（done）まで待つ（偽の SSE。dev だけ） */
async function aiDiagnoseDone(page) {
  await page.click('section.ai button[data-ai="diagnose"]');
  await page.waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(150);
}

/**
 * 返答の行の [評価に残す]（#159）: 終わった返答の末尾にあり窓の中・横にはみ出さない。押す → メモ（window.prompt）に
 * 書いて OK → ai-eval-*.json がダウンロードされ、版 1 の形・メモ・発言の列（診断）・作り直しの材料（板・ポジション）を持つ
 */
async function aiKeepCheck(page, tag) {
  // #277: [評価に残す] は返答の末尾の ⋯ の中（開くまで見えない）
  const more = page.locator('section.ai .ai-msg.answer details.ai-more').last();
  const btn = more.locator('button[data-ai="keep"]');
  const bad = [];
  if (await btn.isVisible().catch(() => false)) bad.push('⋯ を開く前から見える');
  await more
    .locator('summary')
    .click()
    .catch(() => bad.push('⋯ が無い'));
  const box = await btn.boundingBox().catch(() => null);
  const vw = page.viewportSize()?.width ?? 0;
  if (!box) bad.push('ボタンが無い');
  else if (box.x < 0 || box.x + box.width > vw + 0.5) bad.push('ボタンが窓の外');
  if (box) {
    page.once('dialog', (d) => d.accept('合成の確かめ'));
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), btn.click()]);
    const name = dl.suggestedFilename();
    const p = await dl.path();
    const doc = p ? JSON.parse(readFileSync(p, 'utf8')) : null;
    if (!/^ai-eval-\d{8}-\d{6}\.json$/.test(name)) bad.push(`ファイル名「${name}」`);
    if (doc?.kind !== 'optsim.ai_eval_case' || doc?.v !== 1) bad.push('形');
    if (doc?.note !== '合成の確かめ') bad.push('メモ');
    if (doc?.turns?.[0]?.kind !== 'diagnose') bad.push('発言の列');
    if (!doc?.source?.board || !doc?.source?.position) bad.push('作り直しの材料');
  }
  aiStat(`${tag} #159 評価に残す`, bad.length === 0, bad.join('・'));
}

/** 1 件の判定を数えて出す（aiSweep の項目） */
function aiStat(label, ok, detail = '') {
  aiStats.total++;
  if (ok) aiStats.pass++;
  else failed = true;
  console.log(
    `${label}: ${ok ? 'pass' : 'NG'}${detail ? `（${detail}）` : ''}${ok ? '' : '  ← NG'}`,
  );
}

/**
 * #232: 返答の用語のボタン（最初の 1 つ）を押す → 説明カードがその語の見出しで開き窓の中 → Esc で閉じてボタンへ
 * フォーカスが戻る
 */
async function aiTermCheck(page, tag) {
  const lbl = `${tag} #232 用語のリンク`;
  const btn = page.locator('section.ai .ai-answer .ai-term').first();
  const n = await page.locator('section.ai .ai-answer .ai-term').count();
  if (n === 0) {
    aiStat(lbl, false, '用語のボタンが無い');
    return;
  }
  const word = ((await btn.textContent()) ?? '').replace(/（.*$/, '').trim();
  await btn.click();
  const card = await page
    .waitForSelector('dialog.term-card[open]', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const r = await page.evaluate(() => {
    const d = document.querySelector('dialog.term-card[open]');
    const box = d?.querySelector('.tc-box')?.getBoundingClientRect();
    return {
      title: (d?.querySelector('h2')?.textContent ?? '').trim(),
      inWin:
        !!box &&
        box.left >= -0.5 &&
        box.right <= innerWidth + 0.5 &&
        box.top >= -0.5 &&
        box.bottom <= innerHeight + 0.5,
    };
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const back = await page.evaluate(
    () =>
      !document.querySelector('dialog.term-card[open]') &&
      !!document.activeElement?.classList.contains('ai-term'),
  );
  const ok = card && r.inWin && r.title.toLowerCase().includes(word.toLowerCase()) && back;
  aiStat(
    lbl,
    ok,
    `用語 ${n} 個・「${word}」→ カード「${r.title}」${r.inWin ? '' : '・窓の外'}${back ? '' : '・Esc の後にボタンへ戻らない'}`,
  );
}

/**
 * #234: 「表で」の質問の返答（偽の SSE の 3 列の表 + 7 列の表）。表 2 つ・3 列の表は枠に収まる・数字の列は右揃えで
 * 折り返さない・列の多い表は枠の中だけ横にスクロール（data-more が end → 右端で start）・表のセルの用語・パネルと
 * 画面の横スクロール 0
 */
async function aiTableCheck(page, tag, w, h, theme, want) {
  const lbl = `${tag} #234 返答の表`;
  await page.fill('section.ai .ai-input textarea', '表で比べて');
  await page.press('section.ai .ai-input textarea', 'Enter');
  await page.waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const ans = [...document.querySelectorAll('section.ai .ai-msg.answer')].at(-1);
    const tables = [...(ans?.querySelectorAll('.ai-table') ?? [])];
    const [narrow, wide] = tables;
    const nums = [...(narrow?.querySelectorAll('td.num') ?? [])].map((td) => {
      const s = getComputedStyle(td);
      return s.textAlign === 'right' && s.whiteSpace === 'nowrap';
    });
    const first = narrow?.querySelector('tbody td');
    const lh = first ? Number.parseFloat(getComputedStyle(first).lineHeight) : 0;
    return {
      count: tables.length,
      narrowFits: !!narrow && narrow.scrollWidth <= narrow.clientWidth + 0.5,
      nums: nums.length,
      numsOk: nums.every(Boolean),
      firstWraps: !!first && lh > 0 && first.getBoundingClientRect().height > lh * 1.5,
      wideOver: !!wide && wide.scrollWidth > wide.clientWidth + 0.5,
      wideMore: wide?.getAttribute('data-more') ?? null,
      wideRegion:
        wide?.getAttribute('tabindex') === '0' &&
        wide?.getAttribute('role') === 'region' &&
        !!wide?.getAttribute('aria-label'),
      narrowRegion: narrow?.hasAttribute('tabindex') ?? false,
      cellTerms: ans?.querySelectorAll('.ai-table .ai-term').length ?? 0,
    };
  });
  let endMore = null;
  if (r.wideOver) {
    await page.evaluate(() => {
      const ans = [...document.querySelectorAll('section.ai .ai-msg.answer')].at(-1);
      const wide = ans?.querySelectorAll('.ai-table')[1];
      if (wide) wide.scrollLeft = wide.scrollWidth;
    });
    await page.waitForTimeout(100);
    endMore = await page.evaluate(
      () =>
        [...document.querySelectorAll('section.ai .ai-msg.answer')]
          .at(-1)
          ?.querySelectorAll('.ai-table')[1]
          ?.getAttribute('data-more') ?? null,
    );
  }
  const bad = [];
  if (r.count !== 2) bad.push(`表 ${r.count} 個`);
  if (!r.narrowFits) bad.push('3 列の表が枠からはみ出す');
  if (r.nums !== 4 || !r.numsOk)
    bad.push(`数字の列 ${r.nums} セル・右揃え / 折り返さない ${r.numsOk}`);
  if (w <= PHONE_MAX && !r.firstWraps) bad.push('1 列目が折り返していない');
  if (w <= PHONE_MAX && !r.wideOver) bad.push('列の多い表が枠に収まっている（スマホ）');
  if (r.wideOver && (r.wideMore !== 'end' || endMore !== 'start'))
    bad.push(`端の印 ${r.wideMore} → 右端で ${endMore}`);
  if (!r.wideOver && r.wideMore !== null) bad.push(`収まっているのに端の印 ${r.wideMore}`);
  if (r.wideOver !== r.wideRegion)
    bad.push(`はみ出し ${r.wideOver} と region ${r.wideRegion} が合わない`);
  if (r.narrowRegion) bad.push('収まる表の枠に tabindex');
  if (r.cellTerms === 0) bad.push('表のセルに用語のボタンが無い');
  aiStat(
    lbl,
    bad.length === 0,
    bad.length
      ? bad.join('・')
      : `列の多い表 ${r.wideOver ? `枠の中で横スクロール（${r.wideMore} → ${endMore}）` : '収まる'}`,
  );
  await report(page, `${tag} 返答の表`, w, h, `ai-${w}x${h}-${theme}-table`);
  await readoutCheck(page, `${tag} 返答の表`, want);
  await aiCheck(page, `${tag} 返答の表`, w);
}

async function aiSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const storage = { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) };
      const ctx = await newContext({ width: w, height: h }, storage);
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const tag = `#135 ${theme} ${w}x${h}`;
      const want = w <= PHONE_MAX ? 3 : 5;
      const sheets = w <= PHONE_MAX ? ['peek', 'full'] : [null];
      for (const sheet of sheets) {
        const lbl = sheet ? `${tag} ai/${sheet}` : `${tag} ai`;
        if (!(await openAi(page, w, sheet ?? 'peek'))) {
          failed = true;
          console.log(`${lbl}: AI のパネルを開けない  ← NG`);
          continue;
        }
        await page
          .waitForFunction(
            () =>
              (document.querySelector('section.ai .panel-head .sub')?.textContent ?? '').includes(
                '$',
              ),
            undefined,
            { timeout: 5000 },
          )
          .catch(() => {});
        await report(page, lbl, w, h, `ai-${w}x${h}-${theme}-${sheet ?? 'open'}`);
        await readoutCheck(page, lbl, want);
        const r = await aiCheck(page, lbl, w);
        if (w === 1440 && h === 900) await aiSideCheck(page, lbl);
        if (sheet !== 'full' && !r.disclaimer) {
          failed = true;
          console.log(`${lbl}: 初めて開いたのに免責の文が無い  ← NG`);
        }
      }
      // 免責の文を閉じて開き直す → 出ない（prefs）
      await page.click('section.ai [data-ai="disclaimer"] button');
      await page.reload();
      await waitReady(page, 'next');
      await openAi(page, w, 'peek');
      const again = await page.$('section.ai [data-ai="disclaimer"]');
      aiStats.total++;
      if (again) {
        failed = true;
        console.log(`${tag}: 2 回目に開いても免責の文が出る  ← NG`);
      } else aiStats.pass++;
      // 診断の返答（偽の SSE）を出した状態
      await aiDiagnoseDone(page);
      const lbl = `${tag} 返答あり`;
      await report(page, lbl, w, h, `ai-${w}x${h}-${theme}-answer`);
      await readoutCheck(page, lbl, want);
      await aiCheck(page, lbl, w);
      if (w === 1440 && h === 900) await aiSideCheck(page, lbl);
      await aiTermCheck(page, tag);
      if (theme === 'dark') await aiKeepCheck(page, tag);
      await aiTableCheck(page, tag, w, h, theme, want);
      await ctx.close();
    }
  }
  console.log(`AI のチャットの検査（#135）: ${aiStats.pass} / ${aiStats.total} で pass`);
}

// ---- 数字・パネルから [AI に聞く]（#136 AC4）
const askStats = { pass: 0, total: 0 };
const ASK_PREFIX = '［AI に聞く］';

/** 指標 · テールを見せる（スマホ = ドックの指標の peek、タブレット = ドックの指標、PC = 常に見える（#280）） */
async function showMetrics(page, w) {
  if (w >= 1200) {
    // AI は左の列（#280）なので指標は隠れない
  } else if (w <= PHONE_MAX) {
    await setShell(page, 'metrics', 'peek');
  } else {
    await page.click('.dock button[data-panel="metrics"]');
  }
  await page.waitForSelector('section.metrics .metric-tiles', { state: 'visible', timeout: 5000 });
  await page.waitForTimeout(120);
}

/** ボタンが見えていて窓の中・文字が切れていない（scrollWidth ≤ clientWidth） */
const askButtonInfo = (page, sel) =>
  page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length > 0);
    const b = els[0];
    if (!b) return { ok: false, detail: '無い / 見えない' };
    const r = b.getBoundingClientRect();
    const inWin =
      r.left >= -0.5 &&
      r.top >= -0.5 &&
      r.right <= window.innerWidth + 0.5 &&
      r.bottom <= window.innerHeight + 0.5;
    const cut = b.scrollWidth > b.clientWidth + 0.5;
    const text = (b.textContent ?? '').trim();
    return {
      ok: inWin && !cut && r.width > 0,
      detail: `「${text}」 ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}${inWin ? '' : ' 窓の外'}${cut ? ' 切れ' : ''}`,
    };
  }, sel);

/**
 * #263: 送った吹き出しが会話に入ってから、フレームごとに .ai-body の scrollTop と、吹き出しの上端と枠の内側の上端
 * （枠の上端 + 内側の余白）の差を採る（枠が見えている間だけ。scrollTop と flowGaps は進み具合がある間だけ）。止めると
 * { tops, gaps, flowGaps, hold, blank, frame } を返す
 */
const watchSentScroll = (page, n) =>
  page.evaluate((n) => {
    const rec = { tops: [], gaps: [], flowGaps: [], stop: false };
    window.__aiSentScroll = rec;
    const tick = () => {
      if (rec.stop) return;
      const body = document.querySelector('section.ai .ai-body');
      const users = document.querySelectorAll('section.ai .ai-msg.user');
      if (body && users.length > n && body.clientHeight > 0) {
        const u = users[users.length - 1];
        const pad = Number.parseFloat(getComputedStyle(body).paddingTop) || 0;
        const top = body.getBoundingClientRect().top + body.clientTop + pad;
        // scrollTop は流れの間（進み具合がある間）だけ。終わった後の下詰めの縮み（#277）は gaps と空白で見る
        const gap = u.getBoundingClientRect().top - top;
        if (document.querySelector('section.ai .ai-progress')) {
          rec.tops.push(body.scrollTop);
          rec.flowGaps.push(gap);
        }
        rec.gaps.push(gap);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, n);
const stopSentScroll = (page) =>
  page.evaluate(() => {
    const rec = window.__aiSentScroll ?? { tops: [], gaps: [], flowGaps: [] };
    rec.stop = true;
    // #277: 返答の後の最後の塊の下詰め（data-hold）と、枠の内側の高さに対する返答の後の空白の割合
    const body = document.querySelector('section.ai .ai-body');
    const tail = body?.querySelector('.ai-tail[data-last]');
    const end = tail?.lastElementChild;
    let blank = Number.NaN;
    let frame = Number.NaN;
    if (body && end && body.clientHeight > 0) {
      const cs = getComputedStyle(body);
      const pt = Number.parseFloat(cs.paddingTop) || 0;
      const pb = Number.parseFloat(cs.paddingBottom) || 0;
      frame = body.clientHeight - pt - pb;
      const bottom = body.getBoundingClientRect().top + body.clientTop + pt + frame;
      blank = Math.max(0, bottom - end.getBoundingClientRect().bottom) / frame;
    }
    return {
      tops: rec.tops,
      gaps: rec.gaps,
      flowGaps: rec.flowGaps,
      hold: tail?.getAttribute('data-hold') ?? null,
      blank,
      frame,
    };
  });

/**
 * #263・#277: 送った吹き出しの上端が送った直後に枠の内側の上端 ±4px、流れの間の scrollTop の変化 ≤ 1px、返答の後も
 * 上端 ±4px（返答が短く下詰めを縮めた data-hold="end" のときだけ、下がりは枠の 55% まで）、返答の後の空白が枠の半分以下
 */
function sentKept(sc) {
  const span = sc.tops.length > 0 ? Math.max(...sc.tops) - Math.min(...sc.tops) : Number.NaN;
  // 送った直後 = 流れの最初のフレーム（[もう一度] の前の失敗の行の吹き出しは、返答の後の下詰めで上端からずれうる）
  const g0 = sc.flowGaps[0] ?? sc.gaps[0] ?? Number.NaN;
  const g1 = sc.gaps.at(-1) ?? Number.NaN;
  const after =
    sc.hold === 'end'
      ? // 縮めたときは下に 45cqh だけ空ける = 空白は 45% 前後（余白・間隔の分だけ多い）
        g1 >= -4 && g1 <= 0.55 * sc.frame + 4 && sc.blank >= 0.4
      : Math.abs(g1) <= 4;
  const ok = Math.abs(g0) <= 4 && span <= 1 && after && sc.blank <= 0.5;
  const px = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  const detail = `送った吹き出しの上端 ${px(g0)} → ${px(g1)}px（data-hold ${sc.hold}）・流れの間の scrollTop の変化 ${px(span)}px（${sc.tops.length} フレーム）・返答の後の空白 ${Number.isFinite(sc.blank) ? Math.round(sc.blank * 100) : '—'}%`;
  return { ok, detail };
}

/**
 * 押す → AI のパネルが見え、最後の user の吹き出しに want、返答（偽の SSE）が終わる。
 * #263: 吹き出しの上端が枠の内側の上端 ±4px（送った直後と返答の後）、返答が流れる間の scrollTop の変化 ≤ 1px
 */
async function askAndWait(page, sel, want) {
  const before = await page.$$eval('section.ai .ai-msg.user', (xs) => xs.length);
  await watchSentScroll(page, before);
  await page.locator(sel).first().click();
  const shown = await page
    .waitForSelector('section.ai .ai-foot', { state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  await page
    .waitForFunction(
      (n) => document.querySelectorAll('section.ai .ai-msg.user').length > n,
      before,
      { timeout: 5000 },
    )
    .catch(() => {});
  await page
    .waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(150);
  const sc = await stopSentScroll(page);
  const { ok: seen, detail: kept } = sentKept(sc);
  const r = await page.evaluate(() => {
    const users = [...document.querySelectorAll('section.ai .ai-msg.user .ai-bubble')];
    const answers = [...document.querySelectorAll('section.ai .ai-msg.answer')];
    return {
      user: users.at(-1)?.textContent ?? '',
      answer: (answers.at(-1)?.textContent ?? '').trim(),
      error: !!answers.at(-1)?.querySelector('.ai-error'),
      popOpen: document.querySelectorAll('.pop-wrap .popover:not([hidden])').length,
    };
  });
  const ok =
    shown &&
    r.user.startsWith(ASK_PREFIX) &&
    r.user.includes(want) &&
    r.answer !== '' &&
    !r.error &&
    r.popOpen === 0 &&
    seen;
  return {
    ok,
    detail: `${shown ? '' : 'AI のパネルが見えない・'}吹き出し「${r.user.split('\n')[0]}」・返答 ${r.answer ? 'あり' : 'なし'}${r.error ? '・失敗' : ''}${r.popOpen ? `・吹き出しが ${r.popOpen} 個開いたまま` : ''}・${kept}${seen ? '' : '（#263 / #277 NG）'}`,
  };
}

function askRecord(label, ok, detail) {
  askStats.total++;
  if (ok) askStats.pass++;
  else failed = true;
  console.log(`${label}: ${ok ? 'pass' : `${detail}  ← NG`}${ok && detail ? `（${detail}）` : ''}`);
}

/**
 * #136 AC4: 4 幅 × ダーク / ライトで、タイル（満期 最大損失・受取 − 支払。#274 で読み取り（Δ）から差し替え）・テール表・IV 推移の [AI に聞く] が窓の中で
 * 切れず、押すと AI のパネルが見え、user の吹き出しに場所の見出しが入り、偽の返答が終わる。押した後のページの縦・横
 * スクロール 0px。AI が無効（status を enabled:false に差し替え）のときは送らずに入力欄に質問の文が入り、理由が出る
 */
async function aiAskSweep() {
  for (const [w, h] of SIZES) {
    for (const theme of ['dark', 'light']) {
      const tag = `#136 ${theme} ${w}x${h}`;
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
        theme,
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const steps = [
        {
          name: 'タイル（満期 最大損失）',
          open: async () => {
            await showMetrics(page, w);
            await page.click('section.metrics .tile[data-tile="maxLoss"] .tile-btn');
            await page.waitForTimeout(150);
          },
          sel: 'section.metrics .tile[data-tile="maxLoss"] button[data-ai-ask="tile.maxLoss"]',
          want: '「満期 最大損失」',
        },
        {
          // #274 で読み取りの [AI に聞く] をやめた（全文のポップオーバーごと）。代わりに受取 − 支払のタイル
          name: 'タイル（受取 − 支払）',
          open: async () => {
            await showMetrics(page, w);
            await page.click('section.metrics .tile[data-tile="premium"] .tile-btn');
            await page.waitForTimeout(150);
          },
          sel: 'section.metrics .tile[data-tile="premium"] button[data-ai-ask="tile.premium"]',
          want: '「受取 − 支払」',
        },
        {
          name: 'テール表',
          open: async () => {
            await showMetrics(page, w);
            await page.locator('button[data-ai-ask="tail.pnl"]').scrollIntoViewIfNeeded();
            await page.waitForTimeout(120);
          },
          sel: 'section.metrics button[data-ai-ask="tail.pnl"]',
          want: '「テール表」',
        },
        {
          name: 'IV 推移',
          open: async () => {
            await openIv(page, w);
            await page
              .waitForSelector('button[data-ai-ask="iv.history"]', { timeout: 10000 })
              .catch(() => {});
          },
          sel: 'section.smile button[data-ai-ask="iv.history"]',
          want: '「ATM IV（30 日固定）」',
        },
      ];
      for (const st of steps) {
        const lbl = `${tag} ${st.name}`;
        try {
          await st.open();
          const b = await askButtonInfo(page, st.sel);
          const m0 = await measure(page);
          askRecord(
            `${lbl} [AI に聞く] のボタン`,
            b.ok && m0.v === 0 && m0.h === 0,
            `${b.detail} 縦 ${m0.v} 横 ${m0.h}`,
          );
          if (!b.ok) continue;
          if (theme === 'light' && st.name !== 'タイル（満期 最大損失）') continue;
          const r = await askAndWait(page, st.sel, st.want);
          const m1 = await measure(page);
          askRecord(
            `${lbl} 押すと AI のパネルで送る`,
            r.ok && m1.v === 0 && m1.h === 0,
            `${r.detail} 縦 ${m1.v} 横 ${m1.h}`,
          );
          if (shotsDir)
            await page.screenshot({
              path: join(shotsDir, `ask-${w}x${h}-${theme}-${steps.indexOf(st)}.png`),
            });
        } catch (e) {
          askRecord(lbl, false, `${e?.message ?? e}`.split('\n')[0]);
        }
      }
      await ctx.close();
    }
    // AI が無効: 送らずに入力欄に質問の文・理由（ダークだけ）
    const ctx = await newContext(
      { width: w, height: h },
      { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') },
    );
    const page = await ctx.newPage();
    await page.route('**/fixtures/ai/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          schema_version: 1,
          enabled: false,
          model: null,
          credential: null,
          counted: false,
          limit_usd: null,
          remaining_usd: null,
          resets_at: null,
        }),
      }),
    );
    const lbl = `#136 dark ${w}x${h} AI が無効`;
    try {
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      // AI のパネルを一度も開かずに押す = 状態を読み終わってから判定する（#136 レビュー指摘 1。送らない）
      await showMetrics(page, w);
      await page.click('section.metrics .tile[data-tile="maxLoss"] .tile-btn');
      await page.waitForTimeout(150);
      await page.click('section.metrics button[data-ai-ask="tile.maxLoss"]');
      await page.waitForSelector('section.ai .ai-foot', { state: 'visible', timeout: 5000 });
      await page
        .waitForFunction(
          () => (document.querySelector('section.ai .ai-input textarea')?.value ?? '') !== '',
          undefined,
          { timeout: 5000 },
        )
        .catch(() => {});
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({
        value: document.querySelector('section.ai .ai-input textarea')?.value ?? '',
        reason: document.querySelector('section.ai [data-ai="reason"]')?.textContent ?? '',
        users: document.querySelectorAll('section.ai .ai-msg.user').length,
      }));
      askRecord(
        lbl,
        r.value.startsWith(ASK_PREFIX) &&
          r.value.includes('満期 最大損失') &&
          r.reason.includes('無効') &&
          r.users === 0,
        `入力欄「${r.value.split('\n')[0]}」・理由「${r.reason}」・吹き出し ${r.users}`,
      );
    } catch (e) {
      askRecord(lbl, false, `${e?.message ?? e}`.split('\n')[0]);
    }
    await ctx.close();
  }
  console.log(`[AI に聞く] の検査（#136）: ${askStats.pass} / ${askStats.total} で pass`);
}

/**
 * #242: ツールの結果を待つ間のカード。technicals が先物の足を読む間（/fixtures/future_bars を止める）は
 * 「足を読み込み中…」（「計算できなかった」でない）・data-status="pending"・aria-busy。通すと結果のカードに置き換わる
 */
async function aiToolPendingFlow() {
  const vp = { width: 390, height: 844 };
  const tag = `#242 ${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  const page = await ctx.newPage();
  const held = [];
  const isBars = (u) => u.pathname.endsWith('/future_bars');
  await page.route(isBars, (route) => {
    held.push(route);
  });
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await openAi(page, vp.width, 'full');
  await page.fill('section.ai .ai-input textarea', 'RSI は？');
  await page.press('section.ai .ai-input textarea', 'Enter');
  const sel = 'section.ai .ai-tool[data-ai-tool="technicals"]';
  await page.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  const read = () =>
    page
      .$eval(sel, (el) => ({
        text: el.textContent ?? '',
        status: el.getAttribute('data-status'),
        busy: el.getAttribute('aria-busy'),
      }))
      .catch(() => null);
  const a = await read();
  aiStat(
    `${tag} 足を読む間のツールのカード`,
    a !== null &&
      a.status === 'pending' &&
      a.busy === 'true' &&
      a.text.includes('足を読み込み中…') &&
      !a.text.includes('計算できなかった'),
    a
      ? `「${a.text}」・${a.status}・aria-busy ${a.busy}・止めた要求 ${held.length}`
      : 'カードが無い',
  );
  await page.unroute(isBars);
  for (const r of held) await r.continue().catch(() => {});
  await page.waitForSelector(`${sel}[data-status="ok"]`, { timeout: 10000 }).catch(() => {});
  const b = await read();
  aiStat(
    `${tag} 足を通すと結果のカードに置き換わる`,
    b !== null && b.status === 'ok' && b.busy === null && !b.text.includes('足を読み込み中'),
    b ? `「${b.text}」` : 'カードが無い',
  );
  await ctx.close();
}

/**
 * #135 AC6: 進み具合（押してから表示まで < 1,000 ms・考え中 → 書いています → 完了の順）・中止・終端なし・ツールのカードと
 * [シナリオに適用]・再読み込みで会話が残る
 */
async function aiFlows(vp) {
  const tag = `#135 ${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText('dark') });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await openAi(page, vp.width, 'full');
  await page
    .waitForFunction(
      () => !document.querySelector('section.ai button[data-ai="diagnose"]')?.disabled,
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
  // (a) 押してから進み具合まで・相の順
  const seq = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const phases = [];
        let shownMs = null;
        const t0 = performance.now();
        const obs = new MutationObserver(() => {
          const p = document.querySelector('section.ai .ai-progress');
          if (p && shownMs === null) shownMs = performance.now() - t0;
          const ph = p?.getAttribute('data-ai-phase') ?? 'none';
          if (phases.at(-1) !== ph) phases.push(ph);
          if (!p && shownMs !== null) {
            obs.disconnect();
            resolve({ shownMs, phases });
          }
        });
        obs.observe(document.querySelector('section.ai'), {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-ai-phase'],
        });
        document.querySelector('section.ai button[data-ai="diagnose"]').click();
        setTimeout(() => resolve({ shownMs, phases, timeout: true }), 15000);
      }),
  );
  check(
    `${tag} [このポジションを診断] → 進み具合が出るまで < 1,000 ms`,
    seq.shownMs !== null && seq.shownMs < 1000,
    `${Math.round(seq.shownMs ?? -1)} ms`,
  );
  const order = ['thinking', 'writing', 'none'].map((x) => seq.phases.indexOf(x));
  check(
    `${tag} 考え中 → 書いています → 完了の順`,
    !seq.timeout && order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2],
    seq.phases.join(' → '),
  );
  const weak = await page.$$eval(
    'section.ai .ai-answer h3',
    (hs) => hs.filter((h) => h.textContent.startsWith('弱点')).length,
  );
  check(`${tag} 返答の弱点の見出しが 3 つ`, weak === 3, `${weak}`);
  // #278: 「確かめるとよいこと」のチップ（偽の SSE の診断 = 急落のプリセット・ピン）が窓の中で切れない →
  // [シナリオ: 急落] で Δσ +20 が入る → [元に戻す] で戻る
  const chips = await page.$$eval('section.ai [data-ai="checks"] .chip', (xs) =>
    xs.map((x) => {
      const r = x.getBoundingClientRect();
      return {
        text: x.textContent,
        ok: r.left >= 0 && r.right <= window.innerWidth + 0.5 && x.scrollWidth <= x.clientWidth,
      };
    }),
  );
  check(
    `${tag} #278 返答の「確かめるとよいこと」のチップが 1 つ以上・窓の中で切れない`,
    chips.length >= 1 && chips.every((x) => x.ok),
    chips.map((x) => x.text).join(' / '),
  );
  const scOf = (ws) => ws?.tabs?.[ws.active ?? 0]?.position?.scenario ?? null;
  const wsNow = () =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), WORKSPACE_KEY);
  const crash = page.locator('section.ai [data-ai="checks"] .chip', { hasText: '急落' });
  if ((await crash.count()) > 0) {
    const sc0 = scOf(await wsNow());
    await crash.first().click();
    await page.waitForTimeout(900);
    const sc1 = scOf(await wsNow());
    const undo = await page.$('.toast button:has-text("元に戻す")');
    if (undo) await undo.click();
    await page.waitForTimeout(900);
    const sc2 = scOf(await wsNow());
    check(
      `${tag} #278 [シナリオ: 急落] で Δσ +20 → [元に戻す] で戻る`,
      sc1?.dSigma === 20 && undo !== null && sc2?.dSigma === sc0?.dSigma && sc2?.dX === sc0?.dX,
      `${sc0?.dSigma} → ${sc1?.dSigma} → ${sc2?.dSigma}`,
    );
  } else check(`${tag} #278 [シナリオ: 急落] のチップがある`, false);
  // (b) 中止
  await page.click('section.ai button[data-ai="diagnose"]');
  await page
    .waitForSelector('section.ai .ai-progress[data-ai-phase="thinking"]', { timeout: 5000 })
    .catch(() => {});
  await page.click('section.ai button[data-ai="abort"]');
  const aborted = await page
    .waitForSelector('section.ai .ai-error[data-code="aborted"]', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const progressGone = (await page.$('section.ai .ai-progress')) === null;
  check(`${tag} [中止] で止まる（進み具合が消え「中止しました」）`, aborted && progressGone);
  // (c) 終端なし → incomplete（[もう一度] つき）
  await page.fill('section.ai .ai-input textarea', '切断のテスト');
  await page.press('section.ai .ai-input textarea', 'Enter');
  const inc = await page
    .waitForSelector('section.ai .ai-error[data-code="incomplete"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(`${tag} done の無い終わりは「途中で切れました」`, inc);
  // #263: [もう一度]（失敗の行が消え → 送り直した吹き出し → また失敗の行）でも、送った吹き出しの上端が枠の内側の
  // 上端 ±4px・流れの間の scrollTop の変化 ≤ 1px（failed-user が消える間は数えない = 吹き出しの数 − 1 から見る）
  if (inc) {
    const n = await page.$$eval('section.ai .ai-msg.user', (xs) => xs.length);
    await watchSentScroll(page, n - 1);
    await page.click('section.ai .ai-error[data-code="incomplete"] button');
    await page
      .waitForSelector('section.ai .ai-progress', { state: 'attached', timeout: 3000 })
      .catch(() => {});
    await page
      .waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(150);
    const sc = await stopSentScroll(page);
    const k = sentKept(sc);
    check(
      `${tag} #263 [もう一度] で送り直した吹き出しの上端が枠の上端・流れで動かない（#277 返答の後の空白 ≤ 50%）`,
      k.ok,
      k.detail,
    );
  }
  // (d) 追加の質問 → ツールのカード → [シナリオに適用] → [元に戻す]
  await page.fill('section.ai .ai-input textarea', '−6% なら？');
  await page.press('section.ai .ai-input textarea', 'Enter');
  await page
    .waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 })
    .catch(() => {});
  const card = await page.$(
    'section.ai .ai-tool[data-ai-tool="evaluate_scenario"] button[data-ai="apply"]',
  );
  check(`${tag} 追加の質問でツールのカード（evaluate_scenario）と [シナリオに適用]`, card !== null);
  if (card) {
    const before = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) ?? '{}'),
      WORKSPACE_KEY,
    );
    await card.click();
    await page.waitForTimeout(900);
    const ws = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) ?? '{}'),
      WORKSPACE_KEY,
    );
    const sc = ws?.tabs?.[ws.active ?? 0]?.position?.scenario ?? ws?.position?.scenario ?? null;
    check(
      `${tag} [シナリオに適用] で日数 3・Δσ +5 が入る`,
      sc?.days === 3 && sc?.dSigma === 5,
      JSON.stringify(sc),
    );
    const undo = await page.$('.toast button:has-text("元に戻す")');
    if (undo) await undo.click();
    await page.waitForTimeout(900);
    const ws2 = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k) ?? '{}'),
      WORKSPACE_KEY,
    );
    const sc2 = ws2?.tabs?.[ws2.active ?? 0]?.position?.scenario ?? ws2?.position?.scenario ?? null;
    const sc0 = before?.tabs?.[before.active ?? 0]?.position?.scenario ?? null;
    check(
      `${tag} [元に戻す] でシナリオが戻る`,
      undo !== null && sc2?.days === sc0?.days && sc2?.dSigma === sc0?.dSigma,
    );
  }
  // (d2) ポジションの提案（#139）: 提案のカード → [今のタブに適用] で足が 1 本増える → [元に戻す] で戻る
  await page.fill('section.ai .ai-input textarea', 'ヘッジの足を足して');
  await page.press('section.ai .ai-input textarea', 'Enter');
  await page
    .waitForSelector('section.ai .ai-progress', { state: 'detached', timeout: 15000 })
    .catch(() => {});
  const prop = await page.$(
    'section.ai .ai-prop[data-ai-tool="propose_position"] button[data-ai="propose"]',
  );
  const propLines = await page.$$eval('section.ai .ai-prop .ai-prop-line', (xs) => xs.length);
  check(
    `${tag} 提案のカード（差分 ${propLines} 行）と [今のタブに適用]`,
    prop !== null && propLines >= 1,
  );
  if (prop) {
    const legsOf = async () => {
      const ws = await page.evaluate(
        (k) => JSON.parse(localStorage.getItem(k) ?? '{}'),
        WORKSPACE_KEY,
      );
      const p = ws?.tabs?.[ws.active ?? 0]?.position ?? ws?.position ?? null;
      return Array.isArray(p?.legs) ? p.legs.length : -1;
    };
    const n0 = await legsOf();
    await prop.click();
    await page.waitForTimeout(900);
    const n1 = await legsOf();
    check(`${tag} [今のタブに適用] で足が 1 本増える`, n1 === n0 + 1, `${n0} → ${n1}`);
    const undo = await page.$('.toast button:has-text("元に戻す")');
    if (undo) await undo.click();
    await page.waitForTimeout(900);
    const n2 = await legsOf();
    check(`${tag} 提案の [元に戻す] で足が戻る`, undo !== null && n2 === n0, `${n1} → ${n2}`);
  }
  // (e) 再読み込みで会話が残る（sessionStorage の 1 キー）・保存一覧 / 作業の保存に AI のキーが無い
  const keys = await page.evaluate(() => ({
    s: Object.keys(sessionStorage),
    l: Object.keys(localStorage),
  }));
  check(
    `${tag} 会話は sessionStorage の 1 キーだけ`,
    keys.s.length === 1 && keys.s[0] === 'optsim.ai.v1' && !keys.l.some((k) => k.includes('ai')),
    JSON.stringify(keys),
  );
  await page.reload();
  await waitReady(page, 'next');
  await openAi(page, vp.width, 'full');
  const kept = await page.$$eval('section.ai .ai-msg.user', (xs) => xs.length);
  check(`${tag} 再読み込みで会話が残る`, kept >= 2, `${kept} 件`);
  await page.click('section.ai button[data-ai="reset"]');
  await page.waitForTimeout(200);
  const empty = await page.evaluate(() => ({
    n: document.querySelectorAll('section.ai .ai-msg').length,
    s: sessionStorage.getItem('optsim.ai.v1'),
  }));
  check(`${tag} [新しい会話] で消える`, empty.n === 0 && empty.s === null);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-ai-${vp.width}.png`) });
  await ctx.close();
}

// ---- 損益グラフの十字線（#201）
const pnlCrossStats = { pass: 0, total: 0 };

/**
 * 十字線の状態（svg の座標）: 線・札・点・読み取り（各文字の getBBox が描画域と svg の内側か）と、目盛りから逆に読む
 * 横 / 縦の値（札の確かめ用）
 */
const pnlCrossState = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('section.stage .chart');
    const svg = c?.querySelector(':scope > svg');
    if (!c || !svg) return null;
    const W = Number(svg.getAttribute('width'));
    const H = Number(svg.getAttribute('height'));
    const clip = svg.querySelector('svg.clip');
    const plot = {
      x: Number(clip?.getAttribute('x')),
      y: Number(clip?.getAttribute('y')),
      w: Number(clip?.getAttribute('width')),
      h: Number(clip?.getAttribute('height')),
    };
    const inRect = (b, r, eps = 0.5) =>
      b.x >= r.x - eps &&
      b.y >= r.y - eps &&
      b.x + b.width <= r.x + r.w + eps &&
      b.y + b.height <= r.y + r.h + eps;
    const tags = [...c.querySelectorAll('.xh-tag')].map((g) => {
      const rc = g.querySelector('rect');
      const b = {
        x: Number(rc?.getAttribute('x')),
        y: Number(rc?.getAttribute('y')),
        width: Number(rc?.getAttribute('width')),
        height: Number(rc?.getAttribute('height')),
      };
      const tb = g.querySelector('text')?.getBBox();
      return {
        axis: g.classList.contains('x') ? 'x' : 'y',
        text: (g.querySelector('text')?.textContent ?? '').trim(),
        inside: b.width > 0 && inRect(b, { x: 0, y: 0, w: W, h: H }, 0.01),
        // 文字が札の矩形に収まる（実際の字幅）
        fits: !!tb && tb.width <= b.width + 0.5,
      };
    });
    const reads = [...c.querySelectorAll('.xh-read text')].map((t) => {
      const b = t.getBBox();
      return {
        cls: t.getAttribute('class') ?? '',
        text: (t.textContent ?? '').trim(),
        inPlot: inRect(b, plot),
        inSvg: inRect(b, { x: 0, y: 0, w: W, h: H }),
      };
    });
    const hl = c.querySelector('.xh-line.h');
    const vl = c.querySelector('.xh-line.v');
    const num = (t) => Number(String(t).replace('−', '-').replace(/,/g, ''));
    const ticksX = [...svg.querySelectorAll('.ax .tick-x')].map((t) => [
      Number(t.getAttribute('x')),
      num(t.textContent ?? ''),
    ]);
    const ticksY = [...svg.querySelectorAll('.ax .tick-y')].map((t) => [
      Number(t.getAttribute('y')),
      num(t.textContent ?? ''),
    ]);
    const box = svg.getBoundingClientRect();
    const vline = c.querySelector('line.vline');
    return {
      W,
      H,
      plot,
      lines: c.querySelectorAll('.xh-line').length,
      dots: c.querySelectorAll('.xh-dot').length,
      tags,
      xTag: tags.find((t) => t.axis === 'x')?.text ?? null,
      yTag: tags.find((t) => t.axis === 'y')?.text ?? null,
      reads,
      close: c.querySelectorAll('.xh-close').length,
      hy: hl ? Number(hl.getAttribute('y1')) : null,
      vx: vl ? Number(vl.getAttribute('x1')) : null,
      ticksX,
      ticksY,
      unit: (svg.querySelector('.ax .unit')?.textContent ?? '').trim(),
      handleX: vline ? Number(vline.getAttribute('x1')) : null,
      left: box.left,
      top: box.top,
    };
  });

/** 目盛りの 2 点から画素 → 値 */
function fromTicks(ticks, px) {
  if (ticks.length < 2) return null;
  const [p0, v0] = ticks[0];
  const [p1, v1] = ticks[ticks.length - 1];
  if (!(Math.abs(p1 - p0) > 0)) return null;
  return v0 + ((px - p0) * (v1 - v0)) / (p1 - p0);
}

/**
 * 十字線の検査の共通部分: 線 2 本・札 2 個（svg の内側・文字が矩形に収まる）・読み取り 2〜3 行が描画域と svg の内側・
 * 横の札 = 縦線の位置の X（目盛りから逆に読んだ値と 1 画素 + 10 円以内）・縦の札 = 横線の高さの損益（1 画素以内）
 */
function pnlCrossOk(st) {
  const bad = [];
  if (!st) return ['描画域が無い'];
  if (st.lines !== 2) bad.push(`線 ${st.lines} 本`);
  if (st.tags.length !== 2 || !st.tags.every((t) => t.inside && t.fits)) bad.push('札');
  const vals = st.reads.filter((r) => r.cls.includes('xh-val'));
  if (vals.length < 2 || vals.length > 3) bad.push(`読み取り ${vals.length} 行`);
  if (!st.reads.every((r) => r.inPlot && r.inSvg)) bad.push('読み取りが描画域の外');
  const num = (t) => Number(String(t).replace('−', '-').replace(/,/g, ''));
  if (st.vx !== null && st.xTag !== null && st.ticksX.length >= 2) {
    const want = fromTicks(st.ticksX, st.vx);
    const perPx = Math.abs(
      (st.ticksX[st.ticksX.length - 1][1] - st.ticksX[0][1]) /
        (st.ticksX[st.ticksX.length - 1][0] - st.ticksX[0][0]),
    );
    if (!/^\d{1,3}(,\d{3})*$/.test(st.xTag) || Math.abs(num(st.xTag) - want) > perPx + 10)
      bad.push(`横の札 ${st.xTag}（目盛りから ${Math.round(want)}）`);
  }
  if (st.hy !== null && st.yTag !== null && st.ticksY.length >= 2) {
    const want = fromTicks(st.ticksY, st.hy);
    const perPx = Math.abs(
      (st.ticksY[st.ticksY.length - 1][1] - st.ticksY[0][1]) /
        (st.ticksY[st.ticksY.length - 1][0] - st.ticksY[0][0]),
    );
    if (Math.abs(num(st.yTag) - want) > perPx + 0.1)
      bad.push(`縦の札 ${st.yTag}（目盛りから ${want.toFixed(1)}）`);
  }
  return bad;
}

const pnlCrossDesc = (st) =>
  st
    ? `線 ${st.lines}・札 ${st.tags.map((t) => `${t.axis}「${t.text}」${t.inside ? '' : '（外）'}${t.fits ? '' : '（はみ出し）'}`).join(' ')}・読み取り ${st.reads
        .map((r) => `${r.text}${r.inPlot ? '' : '（外）'}`)
        .join(' / ')}`
    : '-';

/** 既定の実行（#201 AC-5）: 360 / 1440 × ダーク / ライトでマウスを 4 か所に載せ、十字線・札・読み取りと縦・横・折り返し */
async function pnlCrossAll() {
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    for (const theme of ['dark', 'light']) {
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      await page.waitForTimeout(150);
      const st0 = await pnlCrossState(page);
      if (!st0) {
        pnlCrossStats.total++;
        failed = true;
        console.log(`#201 ${theme} ${w}x${h}: 損益グラフが無い  ← NG`);
        await ctx.close();
        continue;
      }
      const { plot } = st0;
      for (const [fx, fy] of [
        [0.12, 0.25],
        [0.88, 0.25],
        [0.5, 0.06],
        [0.3, 0.8],
      ]) {
        await page.mouse.move(st0.left + plot.x + plot.w * fx, st0.top + plot.y + plot.h * fy);
        await page.waitForTimeout(80);
        const st = await pnlCrossState(page);
        const bad = pnlCrossOk(st);
        pnlCrossStats.total++;
        if (bad.length === 0) pnlCrossStats.pass++;
        else failed = true;
        console.log(
          `#201 ${theme} ${w}x${h} ホバー（${fx}, ${fy}）: ${pnlCrossDesc(st)} ${bad.length ? `${bad.join('・')}  ← NG` : 'pass'}`,
        );
        if (fx === 0.88)
          await report(page, `next ${theme} 十字線`, w, h, `next-${w}x${h}-${theme}-pnl-cross`);
      }
      await ctx.close();
    }
  }
}

/** --flows（#201 AC-5）: 1440×900 のホバー（横の札 = X・縦の札 = マウスの高さ・外れて 0）、ドラッグのパン・長押しは今のまま */
async function pnlCrossFlows(vp) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const st0 = await pnlCrossState(page);
  if (!st0) {
    check(`#201 ${tag} 損益グラフ`, false, '描画域が無い');
    await ctx.close();
    return;
  }
  const { plot } = st0;
  const at = (fx, fy) => ({
    x: st0.left + plot.x + plot.w * fx,
    y: st0.top + plot.y + plot.h * fy,
  });
  const seen = [];
  for (const [fx, fy] of [
    [0.3, 0.3],
    [0.7, 0.65],
  ]) {
    const m = at(fx, fy);
    await page.mouse.move(m.x, m.y);
    await page.waitForTimeout(100);
    const st = await pnlCrossState(page);
    seen.push(st);
    const bad = pnlCrossOk(st);
    const yOk = st && st.hy !== null && Math.abs(st.hy - (m.y - st.top)) <= 0.6;
    const xOk = st && st.vx !== null && Math.abs(st.vx - (m.x - st.left)) <= 2;
    check(
      `#201 ${tag} ホバー（${fx}, ${fy}）: 十字線 2 本・札 2 個・読み取りが描画域の内側、縦線 = マウスの X（10 円の格子）・横線 = マウスの高さ、札 = 目盛りの値、× なし`,
      bad.length === 0 && yOk && xOk && st.close === 0,
      `${pnlCrossDesc(st)}${bad.length ? `・${bad.join('・')}` : ''}・横線 y ${st?.hy}（マウス ${m.y - (st?.top ?? 0)}）`,
    );
  }
  check(
    `#201 ${tag} マウスを動かすと横 / 縦の札と読み取りが変わる`,
    seen[0]?.xTag !== seen[1]?.xTag &&
      seen[0]?.yTag !== seen[1]?.yTag &&
      seen[0]?.reads.map((r) => r.text).join() !== seen[1]?.reads.map((r) => r.text).join(),
    `${seen[0]?.xTag} / ${seen[0]?.yTag} → ${seen[1]?.xTag} / ${seen[1]?.yTag}`,
  );
  // 描画域の外（左の目盛りの列）・要素の外で消える
  await page.mouse.move(st0.left + plot.x - 20, st0.top + plot.y + plot.h / 2);
  await page.waitForTimeout(100);
  const axis = await pnlCrossState(page);
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await page.waitForTimeout(80);
  await page.mouse.move(st0.left + plot.x + plot.w / 2, st0.top - 60);
  await page.waitForTimeout(120);
  const out = await pnlCrossState(page);
  check(
    `#201 ${tag} 描画域の外（目盛りの列）・要素の外では十字線 0 本・札 0 個`,
    axis?.lines === 0 && axis.tags.length === 0 && out?.lines === 0 && out.tags.length === 0,
    `目盛りの列 ${axis?.lines} 本・外 ${out?.lines} 本`,
  );
  // ドラッグ = パン（目盛りが変わる）。十字線は値の座標のまま
  const ticks0 = st0.ticksX.map((t) => t[1]).join();
  const a = at(0.4, 0.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 80, a.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const panned = await pnlCrossState(page);
  check(
    `#201 ${tag} ドラッグでパン（横の目盛りが変わる）、ハンドルは動かない`,
    panned !== null && panned.ticksX.map((t) => t[1]).join() !== ticks0,
    `${ticks0} → ${panned?.ticksX.map((t) => t[1]).join()}`,
  );
  // 長押し 600ms でシナリオ点をつかんで動かす（今のまま）。#223: つかんで動かす間（離す前）は十字線を出さない
  const h0 = (await pnlCrossState(page))?.handleX ?? null;
  const b = at(0.2, 0.5);
  await page.mouse.move(b.x, b.y);
  await page.waitForTimeout(100);
  const hover0 = await pnlCrossState(page);
  await page.mouse.down();
  await page.waitForTimeout(600);
  const held = await pnlCrossState(page);
  await page.mouse.move(b.x + 30, b.y, { steps: 4 });
  await page.waitForTimeout(120);
  const during = await pnlCrossState(page);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const grabbed = await pnlCrossState(page);
  check(
    `#223 ${tag} 長押しでつかんで動かす間は十字線 0 本（押す前のホバーは 2 本）`,
    hover0?.lines === 2 && held?.lines === 0 && during?.lines === 0,
    `押す前 ${hover0?.lines} 本・長押し ${held?.lines} 本・動かす間 ${during?.lines} 本`,
  );
  // #223: ハンドル（縦線）を押してすぐ動かす間も 0 本、離してマウスを動かすとまた 2 本
  const hx = st0.left + (grabbed?.handleX ?? 0);
  const hy = at(0.2, 0.6).y;
  await page.mouse.move(hx, hy);
  await page.waitForTimeout(100);
  const hover1 = await pnlCrossState(page);
  await page.mouse.down();
  await page.mouse.move(hx + 40, hy, { steps: 4 });
  await page.waitForTimeout(120);
  const dragging = await pnlCrossState(page);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const released = await pnlCrossState(page);
  await page.mouse.move(hx + 60, hy - 10, { steps: 2 });
  await page.waitForTimeout(120);
  const after = await pnlCrossState(page);
  check(
    `#223 ${tag} ハンドルを押してすぐ動かす間は十字線 0 本、ハンドルは付いて動き、離してマウスを動かすとまた 2 本`,
    hover1?.lines === 2 &&
      dragging?.lines === 0 &&
      (dragging?.handleX ?? 0) - (grabbed?.handleX ?? 0) >= 30 &&
      released?.lines === 0 &&
      after?.lines === 2,
    `押す前 ${hover1?.lines} 本・動かす間 ${dragging?.lines} 本（ハンドル x ${grabbed?.handleX} → ${dragging?.handleX}）・離した直後 ${released?.lines} 本・動かすと ${after?.lines} 本`,
  );
  check(
    `#201 ${tag} 長押しでシナリオ点（ハンドルの縦線）が押した位置へ動く`,
    grabbed?.handleX !== null &&
      h0 !== grabbed?.handleX &&
      Math.abs((grabbed?.handleX ?? 0) - (b.x + 30 - st0.left)) <= 8,
    `ハンドル x ${h0} → ${grabbed?.handleX}（マウス ${Math.round(b.x + 30 - st0.left)}）`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-pnl-cross-${tag}.png`) });
  await ctx.close();
}

/**
 * 390×844 のタッチ（CDP。#201 AC-5）: タップで十字線（× あり）→ 交点をドラッグで動く（ページ・シートは動かない）→
 * 置いてある間のタップ（読み取りの箱の上）で消える（#217。移さない）→ また置いて × のタップで消える → 長押しでシナリオ点・
 * すぐのドラッグでパン（十字線は出ない）・描画域の外のタップで消える → ダブルタップの後に十字線が残らない
 */
async function pnlCrossTouchFlow() {
  const tag = '390x844 touch';
  const ctx = await touchContext({ [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  const st0 = await pnlCrossState(page);
  if (!st0) {
    check(`#201 ${tag} 損益グラフ`, false, '描画域が無い');
    await ctx.close();
    return;
  }
  const { plot } = st0;
  const shell = () =>
    page.evaluate(() => ({
      sheet: document.querySelector('.layout')?.getAttribute('data-sheet'),
      sy: window.scrollY,
    }));
  const s0 = await shell();
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const tapAt = async (p) => {
    await touch('touchStart', [{ ...p, id: 0 }]);
    await page.waitForTimeout(40);
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
  };
  const at = (fx, fy) => ({
    x: Math.round(st0.left + plot.x + plot.w * fx),
    y: Math.round(st0.top + plot.y + plot.h * fy),
  });
  // (a) タップで置く
  const a = at(0.3, 0.45);
  await tapAt(a);
  const st1 = await pnlCrossState(page);
  const bad1 = pnlCrossOk(st1);
  check(
    `#201 ${tag} タップで十字線 2 本・札 2 個・読み取りが描画域の内側・× 1 個、横線 = 指の高さ`,
    bad1.length === 0 &&
      st1.close === 1 &&
      st1.hy !== null &&
      Math.abs(st1.hy - (a.y - st1.top)) <= 0.6,
    `${pnlCrossDesc(st1)}${bad1.length ? `・${bad1.join('・')}` : ''}・× ${st1?.close}`,
  );
  // (b) 交点を押してドラッグ: 十字線が動き、パンしない
  const ticks1 = st1?.ticksX.map((t) => t[1]).join();
  const cx = Math.round((st1?.left ?? 0) + (st1?.vx ?? 0));
  const cy = Math.round((st1?.top ?? 0) + (st1?.hy ?? 0));
  await touch('touchStart', [{ x: cx + 4, y: cy + 3, id: 0 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: cx + 4 + i * 10, y: cy + 3 + i * 4, id: 0 }]);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(100);
  const st2 = await pnlCrossState(page);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const s1 = await shell();
  check(
    `#201 ${tag} 交点を押して右へ 60px・下へ 24px ドラッグで十字線が付いて動く（札・読み取りが変わる）、パンしない、ページ・シートが動かない`,
    st2 !== null &&
      st2.lines === 2 &&
      Math.abs((st2.vx ?? 0) - ((st1?.vx ?? 0) + 60)) <= 3 &&
      Math.abs((st2.hy ?? 0) - ((st1?.hy ?? 0) + 24)) <= 1 &&
      st2.xTag !== st1?.xTag &&
      st2.ticksX.map((t) => t[1]).join() === ticks1 &&
      s1.sheet === s0.sheet &&
      s1.sy === s0.sy,
    `x ${st1?.vx} → ${st2?.vx}・y ${st1?.hy} → ${st2?.hy}・札 ${st1?.xTag} → ${st2?.xTag}・目盛り ${st2?.ticksX.map((t) => t[1]).join() === ticks1 ? '同じ' : '変わった'}`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-pnl-cross-${tag}.png`) });
  // (c) 読み取りの箱（× 以外 = 最後の行）のタップでも消える（#217。移さない）、× のタップで消える
  const center = (sel) =>
    page.evaluate((q) => {
      const els = document.querySelectorAll(q);
      const r = els[els.length - 1]?.getBoundingClientRect();
      return r
        ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        : null;
    }, sel);
  const rb = await center('section.stage .chart .xh-read .xh-val');
  if (rb) await tapAt(rb);
  const stMoved = await pnlCrossState(page);
  check(
    `#201 #217 ${tag} 置いてある間のタップ（読み取りの箱の上）は十字線を消す（移さない）`,
    !!rb && stMoved?.lines === 0,
    `${stMoved?.lines} 本`,
  );
  // 次のタップでまた置き、× のタップで消える
  await tapAt(at(0.3, 0.45));
  const xb = await center('section.stage .chart .xh-close');
  if (xb) await tapAt(xb);
  const st3 = await pnlCrossState(page);
  check(
    `#201 ${tag} × のタップで十字線 0 本・札 0 個`,
    !!xb && st3?.lines === 0 && st3.tags.length === 0,
    `${st3?.lines} 本`,
  );
  // #227: 置いた十字線をパンで表示範囲の外へ出した後のタップは「出ていない」ので置く（§4.1 の共通の規則）。ダブルタップで戻す
  await tapAt(at(0.3, 0.45));
  const pa = at(0.08, 0.75);
  const pdx = Math.round(plot.w * 0.8);
  await touch('touchStart', [{ ...pa, id: 0 }]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [{ x: Math.round(pa.x + (pdx * i) / 12), y: pa.y, id: 0 }]);
    await page.waitForTimeout(20);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(350);
  const stOut = await pnlCrossState(page);
  await tapAt(at(0.5, 0.3));
  const stPut = await pnlCrossState(page);
  const dtr = at(0.6, 0.3);
  for (let k = 0; k < 2; k++) {
    await touch('touchStart', [{ ...dtr, id: 0 }]);
    await page.waitForTimeout(30);
    await touch('touchEnd', []);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const stReset = await pnlCrossState(page);
  check(
    `#227 ${tag} 十字線をパンで表示範囲の外へ（線 0 本）→ タップで置く（2 本）→ ダブルタップで消える`,
    stOut?.lines === 0 && stPut?.lines === 2 && stReset?.lines === 0,
    `外 ${stOut?.lines} 本・タップ ${stPut?.lines} 本・ダブルタップ ${stReset?.lines} 本`,
  );
  // (d) 長押しでシナリオ点（十字線は出ない）
  const h0 = st3?.handleX ?? null;
  const b = at(0.7, 0.5);
  await touch('touchStart', [{ ...b, id: 0 }]);
  await page.waitForTimeout(550);
  for (let i = 1; i <= 3; i++) {
    await touch('touchMove', [{ x: b.x - i * 10, y: b.y, id: 0 }]);
    await page.waitForTimeout(20);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const st4 = await pnlCrossState(page);
  check(
    `#201 ${tag} 長押し → 左へ 30px でシナリオ点（ハンドル）が指の位置へ、十字線は出ない`,
    st4?.lines === 0 &&
      h0 !== st4?.handleX &&
      Math.abs((st4?.handleX ?? 0) - (b.x - 30 - st4.left)) <= 8,
    `ハンドル x ${h0} → ${st4?.handleX}（指 ${b.x - 30 - (st4?.left ?? 0)}）・十字線 ${st4?.lines} 本`,
  );
  // (e) すぐのドラッグはパン（目盛りが変わる）・十字線は出ない
  const t0 = st4?.ticksX.map((t) => t[1]).join();
  const c = at(0.5, 0.3);
  await touch('touchStart', [{ ...c, id: 0 }]);
  for (let i = 1; i <= 6; i++) {
    await touch('touchMove', [{ x: c.x + i * 12, y: c.y, id: 0 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const st5 = await pnlCrossState(page);
  check(
    `#201 ${tag} 1 本指のドラッグはパン（横の目盛りが変わる）、十字線は出ない`,
    st5?.lines === 0 && st5.ticksX.map((t) => t[1]).join() !== t0,
    `${t0} → ${st5?.ticksX.map((t) => t[1]).join()}`,
  );
  // (f) 置き直して、描画域の外（横の目盛りの行）のタップで消える
  await tapAt(at(0.6, 0.4));
  const st6 = await pnlCrossState(page);
  await tapAt({
    x: Math.round(st0.left + plot.x + plot.w * 0.5),
    y: Math.round(st0.top + plot.y + plot.h + 18),
  });
  const st7 = await pnlCrossState(page);
  const s2 = await shell();
  check(
    `#201 ${tag} 置き直した十字線は描画域の外（横の目盛りの行）のタップで消える。ページ・シートは動かない`,
    st6?.lines === 2 && st7?.lines === 0 && s2.sheet === s0.sheet && s2.sy === 0,
    `${st6?.lines} 本 → ${st7?.lines} 本・シート ${s0.sheet}→${s2.sheet}・scrollY ${s2.sy}`,
  );
  // (g) #217: ダブルタップ（表示のリセット）の 1 回目で置いた十字線は残らない
  const dt = at(0.55, 0.35);
  for (let k = 0; k < 2; k++) {
    await touch('touchStart', [{ ...dt, id: 0 }]);
    await page.waitForTimeout(30);
    await touch('touchEnd', []);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(400);
  const st8 = await pnlCrossState(page);
  check(
    `#217 ${tag} 損益グラフのダブルタップの後に十字線が残らない`,
    st8?.lines === 0,
    `${st8?.lines} 本`,
  );
  await ctx.close();
}

// ---- 十字線をそろえる（#217）: スマイル・追証マップ・損益グラフの面
const cross217Stats = { pass: 0, total: 0 };

/** 描画域の svg の中の .xc（十字線）の状態: 線・札（svg の内側・文字が矩形に収まる）・読み取り（svg の内側）と svg の位置 */
const xcState = (page, host) =>
  page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    const g = el.querySelector('.xc');
    const svg = g?.ownerSVGElement ?? el.querySelector('svg');
    if (!svg) return null;
    const W = Number(svg.getAttribute('width'));
    const H = Number(svg.getAttribute('height'));
    const inSvg = (b, eps = 0.5) =>
      b.x >= -eps && b.y >= -eps && b.x + b.width <= W + eps && b.y + b.height <= H + eps;
    const tags = g
      ? [...g.querySelectorAll('.xc-tag')].map((t) => {
          const rc = t.querySelector('rect');
          const b = {
            x: Number(rc?.getAttribute('x')),
            y: Number(rc?.getAttribute('y')),
            width: Number(rc?.getAttribute('width')),
            height: Number(rc?.getAttribute('height')),
          };
          const tb = t.querySelector('text')?.getBBox();
          return {
            axis: t.classList.contains('x') ? 'x' : 'y',
            text: (t.querySelector('text')?.textContent ?? '').trim(),
            inside: b.width > 0 && inSvg(b, 0.01),
            fits: !!tb && tb.width <= b.width + 0.5,
          };
        })
      : [];
    const reads = g
      ? [...g.querySelectorAll('.xc-val')].map((t) => ({
          text: (t.textContent ?? '').trim(),
          inside: inSvg(t.getBBox()),
        }))
      : [];
    const v = g?.querySelector('.xc-line.v');
    const h = g?.querySelector('.xc-line.h');
    const r = svg.getBoundingClientRect();
    return {
      W,
      H,
      left: r.left,
      top: r.top,
      lines: g ? g.querySelectorAll('.xc-line').length : 0,
      tags,
      reads,
      vx: v ? Number(v.getAttribute('x1')) : null,
      hy: h ? Number(h.getAttribute('y1')) : null,
    };
  }, host);

/** 線 2 本・札 2 個（svg の内側・文字が収まる）・読み取りが svg の内側 */
function xcOk(st, wantRead) {
  if (!st) return ['描画域が無い'];
  const bad = [];
  if (st.lines !== 2) bad.push(`線 ${st.lines} 本`);
  if (st.tags.length !== 2 || !st.tags.every((t) => t.inside && t.fits)) bad.push('札');
  if (wantRead && st.reads.length !== 1) bad.push(`読み取り ${st.reads.length}`);
  if (!st.reads.every((r) => r.inside)) bad.push('読み取りが svg の外');
  return bad;
}

const xcDesc = (st) =>
  st
    ? `線 ${st.lines}・札 ${st.tags.map((t) => `${t.axis}「${t.text}」${t.inside ? '' : '（外）'}${t.fits ? '' : '（はみ出し）'}`).join(' ')}・読み取り ${st.reads.map((r) => `${r.text}${r.inside ? '' : '（外）'}`).join(' / ') || '-'}`
    : '-';

const CROSS217_HOST = {
  smile: 'section.smile .smile-month:not(.inactive) .smile-wrap',
  hold: 'section.metrics .hm-wrap',
  surface: 'section.stage .chart',
};
/** 描画域の余白（svg の座標。smile = SMILE_MARGIN・hold = holdMap の M・surface は svg.clip から読む） */
const CROSS217_MARGIN = {
  smile: { left: 38, right: 22, top: 14, bottom: 24 },
  hold: { left: 36, right: 8, top: 6, bottom: 20 },
};

/** そのチャートを見える状態にする（スマホはパネル・シート、追証マップは開いて計算を待ち、描画域を枠の中へ） */
async function cross217Open(page, chart, phoneSize) {
  if (chart === 'smile') {
    if (phoneSize) {
      await setShell(page, 'smile', 'full');
      await smileTab(page);
    } else await page.click('section.board .panel-head .seg button:has-text("スマイル")');
    await page.waitForSelector(CROSS217_HOST.smile, { timeout: 8000 }).catch(() => null);
  } else if (chart === 'hold') {
    if (phoneSize) await setShell(page, 'metrics', 'full');
    await page.click('section.metrics .hm-toggle');
    await page
      .waitForSelector('section.metrics .hm-svg .hm-ok, section.metrics .hm-svg .hm-call', {
        timeout: 10000,
      })
      .catch(() => null);
    await page
      .waitForSelector('section.metrics .hm-wait', { state: 'detached', timeout: 8000 })
      .catch(() => null);
    // 描画域を指標の枠の中へ（枠の scrollTop だけ。ページは動かさない）
    await page.evaluate(() => {
      const host = document.querySelector('section.metrics .panel-body');
      const t = document.querySelector('section.metrics .hm-wrap');
      if (!host || !t) return;
      const h = host.getBoundingClientRect();
      const r = t.getBoundingClientRect();
      host.scrollTop += r.top - h.top - 8;
    });
  } else {
    await toSurface(page);
  }
  await page.waitForTimeout(250);
}

/** 描画域の矩形（画面の座標） */
async function cross217Plot(page, chart) {
  const st = await xcState(page, CROSS217_HOST[chart]);
  if (!st) return null;
  if (chart === 'surface') {
    const clip = await page.evaluate(() => {
      const c = document.querySelector('section.stage .chart svg.clip');
      return c
        ? {
            x: Number(c.getAttribute('x')),
            y: Number(c.getAttribute('y')),
            w: Number(c.getAttribute('width')),
            h: Number(c.getAttribute('height')),
          }
        : null;
    });
    if (!clip) return null;
    return { x: st.left + clip.x, y: st.top + clip.y, w: clip.w, h: clip.h, st };
  }
  const m = CROSS217_MARGIN[chart];
  return {
    x: st.left + m.left,
    y: st.top + m.top,
    w: st.W - m.left - m.right,
    h: st.H - m.top - m.bottom,
    st,
  };
}

/**
 * 既定の実行（#217 AC-5）: 360 / 1440 × ダーク / ライトで、スマイル・追証マップ・面にマウスを 2 か所載せ、十字線 2 本・札 2 個・
 * 読み取りが svg の内側（追証マップは読み取り = 描画域の下の 1 行が「原資産 …」）と縦・横スクロール・折り返し
 */
async function cross217All() {
  for (const [w, h] of [
    [360, 780],
    [1440, 900],
  ]) {
    for (const theme of ['dark', 'light']) {
      for (const chart of ['smile', 'hold', 'surface']) {
        const ctx = await newContext(
          { width: w, height: h },
          {
            [WORKSPACE_KEY]: chart === 'hold' ? sellFive : twoLegs,
            [PREFS_KEY]: prefsText(theme, chart === 'hold' ? { capital_yen: MARGIN_CAPITAL } : {}),
          },
        );
        const page = await ctx.newPage();
        await page.goto(pageUrl('next'));
        await waitReady(page, 'next');
        await cross217Open(page, chart, w <= PHONE_MAX);
        const plot = await cross217Plot(page, chart);
        const lbl = `#217 ${theme} ${w}x${h} ${chart}`;
        if (!plot) {
          cross217Stats.total++;
          failed = true;
          console.log(`${lbl}: 描画域が無い  ← NG`);
          await ctx.close();
          continue;
        }
        for (const [fx, fy] of [
          [0.2, 0.3],
          [0.85, 0.75],
        ]) {
          await page.mouse.move(plot.x + plot.w * fx, plot.y + plot.h * fy);
          await page.waitForTimeout(120);
          const st = await xcState(page, CROSS217_HOST[chart]);
          const bad = xcOk(st, chart !== 'hold');
          if (chart === 'hold') {
            const ro =
              (await page.textContent('section.metrics .hm-readout').catch(() => '')) ?? '';
            if (!ro.startsWith('原資産') || !ro.includes('余力')) bad.push(`読み取り「${ro}」`);
          }
          // 横線 = マウスの高さ（追証マップ・面は格子に吸着するので半マス / 1 日以内）
          const my = plot.y + plot.h * fy - (st?.top ?? 0);
          const tol = chart === 'smile' ? 0.6 : plot.h / 8;
          if (st?.hy !== null && st?.hy !== undefined && Math.abs(st.hy - my) > tol)
            bad.push(`横線 ${st.hy}（マウス ${my.toFixed(1)}）`);
          cross217Stats.total++;
          if (bad.length === 0) cross217Stats.pass++;
          else failed = true;
          console.log(
            `${lbl} ホバー（${fx}, ${fy}）: ${xcDesc(st)} ${bad.length ? `${bad.join('・')}  ← NG` : 'pass'}`,
          );
        }
        await report(
          page,
          `next ${theme} 十字線 ${chart}`,
          w,
          h,
          `next-${w}x${h}-${theme}-cross-${chart}`,
        );
        // 描画域の外へ出すと消える
        await page.mouse.move(2, 2);
        await page.waitForTimeout(120);
        const gone = await xcState(page, CROSS217_HOST[chart]);
        cross217Stats.total++;
        if (gone?.lines === 0) cross217Stats.pass++;
        else failed = true;
        console.log(
          `${lbl} 外へ出して消える: 線 ${gone?.lines} 本${gone?.lines === 0 ? ' pass' : '  ← NG'}`,
        );
        await ctx.close();
      }
    }
  }
}

/**
 * --flows（#217 AC-5）: タッチ（CDP。360×780・1440×900）でスマイル・追証マップのタップで十字線（スマイルは点の選択 + 点に吸着、
 * 追証マップはマスの中心）→ 交点のドラッグで付いて動く（ページ・シート・枠が動かない）→ ほかの所のタップで消える（スマイルは別の点の
 * タップで選択と十字線が移り、十字線の点のタップで解除と一緒に消える）→ すぐのドラッグ・長押しでは出ない → ダブルタップの後に残らない。
 * 面はタッチの押下で十字線を出さない（点をつかむ）
 */
async function cross217TouchFlows(vp) {
  const tag = `${vp.width}x${vp.height} touch`;
  const phoneSize = vp.width <= PHONE_MAX;
  for (const chart of ['smile', 'hold', 'surface']) {
    const ctx = await touchContext(
      {
        [WORKSPACE_KEY]: chart === 'hold' ? sellFive : twoLegs,
        ...(chart === 'hold'
          ? { [PREFS_KEY]: prefsText('dark', { capital_yen: MARGIN_CAPITAL }) }
          : {}),
      },
      vp,
    );
    const page = await ctx.newPage();
    await page.goto(pageUrl('next'));
    await waitReady(page, 'next');
    await cross217Open(page, chart, phoneSize);
    const plot = await cross217Plot(page, chart);
    if (!plot) {
      check(`#217 ${tag} ${chart}`, false, '描画域が無い');
      await ctx.close();
      continue;
    }
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, touchPoints) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const at = (fx, fy) => ({
      x: Math.round(plot.x + plot.w * fx),
      y: Math.round(plot.y + plot.h * fy),
    });
    const scrolls = () =>
      page.evaluate(() => ({
        sy: window.scrollY,
        sheet: document.querySelector('.layout')?.getAttribute('data-sheet') ?? null,
        host: document.querySelector('section.metrics .panel-body')?.scrollTop ?? 0,
      }));
    const host = CROSS217_HOST[chart];
    const readout = () =>
      chart === 'hold'
        ? page.textContent('section.metrics .hm-readout').catch(() => '')
        : page.textContent('section.smile .smile-act').catch(() => '');
    if (chart === 'surface') {
      const a = at(0.4, 0.4);
      await touch('touchStart', [{ ...a, id: 0 }]);
      await page.waitForTimeout(550);
      const st = await xcState(page, host);
      await touch('touchEnd', []);
      await page.waitForTimeout(150);
      check(
        `#217 ${tag} 面: タッチの長押しでは十字線を出さない（点をつかむ）`,
        st?.lines === 0,
        `線 ${st?.lines} 本`,
      );
      await ctx.close();
      continue;
    }
    const s0 = await scrolls();
    const tapAt = async (pt) => {
      await touch('touchStart', [{ ...pt, id: 0 }]);
      await page.waitForTimeout(40);
      await touch('touchEnd', []);
      await page.waitForTimeout(400);
    };
    const smile = chart === 'smile';
    // (a) タップで置く（スマイルは点のタップ = 選択 + 点に吸着、追証マップはマスの中心）
    const a = at(0.35, 0.45);
    await tapAt(a);
    const st1 = await xcState(page, host);
    const ro1 = (await readout()) ?? '';
    const bad1 = xcOk(st1, smile);
    const tol = plot.h / 8;
    check(
      `#217 ${tag} ${chart}: タップで十字線 2 本・札 2 個${smile ? '・点を選ぶ（操作行に put / call）・縦線 = 点' : '・横線 = マスの中心'}`,
      bad1.length === 0 &&
        (smile
          ? /put|call/.test(ro1) && Math.abs((st1?.vx ?? 0) - (a.x - (st1?.left ?? 0))) <= 13
          : st1?.hy !== null && Math.abs((st1?.hy ?? 0) - (a.y - (st1?.top ?? 0))) <= tol),
      `${xcDesc(st1)}${bad1.length ? `・${bad1.join('・')}` : ''}・操作行「${ro1.slice(0, 30)}」`,
    );
    // (b) 交点を押して右へ 60px・下へ 24px ドラッグで付いて動く（パン・スクロールしない）
    const cx = Math.round((st1?.left ?? 0) + (st1?.vx ?? 0));
    const cy = Math.round((st1?.top ?? 0) + (st1?.hy ?? 0));
    await touch('touchStart', [{ x: cx + 2, y: cy + 2, id: 0 }]);
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [{ x: cx + 2 + i * 10, y: cy + 2 + i * 4, id: 0 }]);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(120);
    const st2 = await xcState(page, host);
    await touch('touchEnd', []);
    await page.waitForTimeout(200);
    const s1 = await scrolls();
    const st3 = await xcState(page, host);
    const moved = Math.abs((st2?.vx ?? 0) - (st1?.vx ?? 0));
    check(
      `#217 ${tag} ${chart}: 交点を押して右へ 60px・下へ 24px ドラッグで付いて動き、離しても残る。ページ・シート・枠は動かない`,
      st2?.lines === 2 &&
        moved >= (smile ? 55 : 30) &&
        moved <= 66 &&
        st3?.lines === 2 &&
        s1.sy === s0.sy &&
        s1.sheet === s0.sheet &&
        Math.abs(s1.host - s0.host) <= 1,
      `x ${st1?.vx} → ${st2?.vx}・離して ${st3?.lines} 本・scrollY ${s0.sy}→${s1.sy}・枠 ${s0.host}→${s1.host}`,
    );
    // (c) ほかの所のタップで消える（移らない）。スマイルは点のタップが選択なので、別の点のタップで選択と十字線が移り、
    // 十字線の点のタップ = 選択の解除で消える
    let st4;
    let ro = '';
    if (smile) {
      await tapAt(at(0.6, 0.5));
      const sMove = await xcState(page, host);
      const roMove = (await readout()) ?? '';
      check(
        `#217 ${tag} smile: 別の点のタップで選択が変わり、十字線はその点へ`,
        sMove?.lines === 2 && roMove !== ro1 && /put|call/.test(roMove),
        `${sMove?.lines} 本・操作行「${roMove.slice(0, 24)}」`,
      );
      await tapAt({
        x: Math.round((sMove?.left ?? 0) + (sMove?.vx ?? 0)),
        y: Math.round((sMove?.top ?? 0) + (sMove?.hy ?? 0)),
      });
      st4 = await xcState(page, host);
      ro = (await readout()) ?? '';
    } else {
      await tapAt(at(0.75, 0.2));
      st4 = await xcState(page, host);
      ro = (await readout()) ?? '';
    }
    check(
      `#217 ${tag} ${chart}: ${smile ? '十字線の点のタップで選択の解除と一緒に消える' : 'ほかの所のタップで消える（移らない）・マスの選択は今のまま'}`,
      st4?.lines === 0 && (smile ? !/put|call/.test(ro) : ro.startsWith('原資産')),
      `線 ${st4?.lines} 本・読み取り「${ro.slice(0, 40)}」`,
    );
    // (d) すぐのドラッグ（スマイルはパン・追証マップはスクロール）では出ない
    const c = at(0.5, 0.6);
    await touch('touchStart', [{ ...c, id: 0 }]);
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [{ x: c.x + i * 12, y: c.y, id: 0 }]);
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
    const st5 = await xcState(page, host);
    check(
      `#217 ${tag} ${chart}: すぐのドラッグでは十字線は出ない`,
      st5?.lines === 0,
      `線 ${st5?.lines} 本`,
    );
    // (e) 長押しは今のまま（スマイル = 選択のスクラブ、追証マップ = 何もしない）で十字線は出ない
    await touch('touchStart', [{ ...a, id: 0 }]);
    await page.waitForTimeout(650);
    await touch('touchEnd', []);
    await page.waitForTimeout(400);
    const st6 = await xcState(page, host);
    const ro6 = (await readout()) ?? '';
    check(
      `#217 ${tag} ${chart}: 長押しでは十字線を出さない${smile ? '（選択は長押しで最寄りの点へ = 今のまま）' : ''}`,
      st6?.lines === 0 && (!smile || /put|call/.test(ro6)),
      `線 ${st6?.lines} 本・読み取り「${ro6.slice(0, 24)}」`,
    );
    // (f) ダブルタップの後に 1 回目のタップの十字線が残らない
    const d = at(0.45, 0.3);
    for (let k = 0; k < 2; k++) {
      await touch('touchStart', [{ ...d, id: 0 }]);
      await page.waitForTimeout(30);
      await touch('touchEnd', []);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
    const st7 = await xcState(page, host);
    check(
      `#217 ${tag} ${chart}: ダブルタップの後に十字線が残らない`,
      st7?.lines === 0,
      `線 ${st7?.lines} 本`,
    );
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, `flows-cross217-${chart}-${tag}.png`) });
    await ctx.close();
  }
}

/**
 * #223（--cross --flows）: 1440 のマウスでスマイルにホバー（十字線 2 本）→ 長押し 600ms の選択のスクラブで横へ動かす間（離す前）は
 * 十字線 0 本・選択は最寄りの点へ（今のまま）→ 離してマウスを動かすとまた 2 本
 */
async function smileGrabFlow() {
  const vp = { width: 1440, height: 900 };
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await newContext(vp, { [WORKSPACE_KEY]: twoLegs });
  const page = await ctx.newPage();
  await page.goto(pageUrl('next'));
  await waitReady(page, 'next');
  await cross217Open(page, 'smile', false);
  const plot = await cross217Plot(page, 'smile');
  if (!plot) {
    check(`#223 ${tag} smile`, false, '描画域が無い');
    await ctx.close();
    return;
  }
  const host = CROSS217_HOST.smile;
  const at = (fx, fy) => ({ x: plot.x + plot.w * fx, y: plot.y + plot.h * fy });
  const a = at(0.35, 0.5);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(120);
  const hover = await xcState(page, host);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.move(a.x + 60, a.y, { steps: 5 });
  await page.waitForTimeout(150);
  const during = await xcState(page, host);
  const ro = ((await page.textContent('section.smile .smile-act').catch(() => '')) ?? '').trim();
  await page.mouse.up();
  await page.waitForTimeout(120);
  await page.mouse.move(a.x + 80, a.y - 20, { steps: 2 });
  await page.waitForTimeout(150);
  const after = await xcState(page, host);
  check(
    `#223 ${tag} smile: 長押しの選択のスクラブで動かす間は十字線 0 本（押す前 2 本）、離してマウスを動かすとまた 2 本`,
    hover?.lines === 2 && during?.lines === 0 && after?.lines === 2,
    `押す前 ${hover?.lines} 本・動かす間 ${during?.lines} 本・離して動かすと ${after?.lines} 本・操作行「${ro.slice(0, 24)}」`,
  );
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `flows-grab223-smile-${tag}.png`) });
  await ctx.close();
}

// ---- ボタンのアイコン（#292 AC-7・AC-8）
const iconStats = { pass: 0, total: 0, skip: 0 };

/** 判定の 1 行（detail は NG のときだけ出す） */
function iconRecord(label, ok, detail = '') {
  iconStats.total++;
  if (ok) iconStats.pass++;
  else failed = true;
  console.log(`${label}: ${ok ? 'pass' : `${detail}  ← NG`}`);
}

/** 見えている .btn.icon.sm（箱の大きさ・中の svg.ic の大きさ・右端）と窓の幅 */
const iconButtons = (page) =>
  page.evaluate(() => {
    const list = [];
    for (const b of document.querySelectorAll('.btn.icon.sm')) {
      const r = b.getBoundingClientRect();
      if (b.getClientRects().length === 0 || r.width === 0 || r.height === 0) continue;
      const ic = b.querySelector('svg.ic');
      const ir = ic?.getBoundingClientRect();
      list.push({
        name: b.getAttribute('aria-label') ?? '',
        w: r.width,
        h: r.height,
        right: r.right,
        icW: ir?.width ?? 0,
        icH: ir?.height ?? 0,
      });
    }
    return { list, vw: window.innerWidth };
  });

/**
 * (a) / (d): 見えている .btn.icon.sm がすべて want.box px 以上（PC は want.exact で等しい）で中の svg.ic が want.ic px、
 * 右端 ≤ 窓の幅。want.names の aria-label を含む
 */
async function iconButtonsCheck(page, label, want) {
  const r = await iconButtons(page);
  const bad = [];
  const px = (v) => Math.round(v * 10) / 10;
  for (const b of r.list) {
    const boxOk = want.exact
      ? Math.abs(b.w - want.box) < 0.5 && Math.abs(b.h - want.box) < 0.5
      : b.w >= want.box - 0.5 && b.h >= want.box - 0.5;
    const icOk = Math.abs(b.icW - want.ic) < 0.5 && Math.abs(b.icH - want.ic) < 0.5;
    if (!boxOk || !icOk || b.right > r.vw + 0.5)
      bad.push(
        `「${b.name}」${px(b.w)}×${px(b.h)}・svg ${px(b.icW)}×${px(b.icH)}・右端 ${px(b.right)}`,
      );
  }
  const names = r.list.map((b) => b.name);
  for (const n of want.names ?? []) if (!names.includes(n)) bad.push(`「${n}」が見えない`);
  iconRecord(
    `${label} 記号ボタン ${r.list.length} 個（${want.exact ? '' : '≥ '}${want.box}px・svg ${want.ic}px）`,
    r.list.length > 0 && bad.length === 0,
    bad.join('・') || '見えるボタンが無い',
  );
}

/** (b): 見えている .iv-tools の切れ（scrollWidth ≤ clientWidth）と ⟳ の右端 ≤ ツールの行の内容の箱の右端 */
async function ivToolsIconCheck(page, label) {
  const r = await page.evaluate(() => {
    const t = [...document.querySelectorAll('section.smile .iv-tools')].find(
      (e) => e.getClientRects().length > 0,
    );
    const b = t?.querySelector('.iv-refresh');
    if (!t || !b) return null;
    const tr = t.getBoundingClientRect();
    const inner = tr.right - (Number.parseFloat(getComputedStyle(t).paddingRight) || 0);
    return {
      sw: t.scrollWidth,
      cw: t.clientWidth,
      right: b.getBoundingClientRect().right,
      inner,
      vw: window.innerWidth,
    };
  });
  if (!r) {
    iconRecord(`${label} ツールの行`, false, 'ツールの行 / ⟳ が見えない');
    return;
  }
  const ok = r.sw <= r.cw && r.right <= r.inner + 0.5 && r.right <= r.vw + 0.5;
  iconRecord(
    `${label} ツールの行 ${r.sw}/${r.cw}・⟳ の右端 ${Math.round(r.right * 10) / 10}（内容の箱 ${Math.round(r.inner * 10) / 10}・窓 ${r.vw}）`,
    ok,
    '切れ / ⟳ が内容の箱の外',
  );
}

/** (c): 折りたたみの行の高さ（見えているものの最小）≥ 36px */
async function foldRowHeights(page, sel) {
  return page.evaluate((sel) => {
    const hs = [...document.querySelectorAll(sel)]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => e.getBoundingClientRect().height);
    return hs;
  }, sel);
}

/** 印（svg.ic-chevron）の computed transform が 90°（matrix(0, 1, -1, 0, 0, 0)。±1e-6）か none か */
function chevronAngle(t) {
  if (t === 'none') return 0;
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (!m) return null;
  const [a, b, c, d] = m[1].split(',').map(Number);
  const near = (x, y) => Math.abs(x - y) < 1e-6;
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return 0;
  return null;
}

/**
 * AC-8: 開閉の印。trigger を押す前後で state（aria-expanded / details の open）が false → true、印の transform が
 * none → 90°、transition-duration が 0s（既定の実行は reducedMotion: reduce）。押し直して閉じたら元に戻る
 */
async function chevronFlipCheck(page, label, trigger, stateOf) {
  const read = () =>
    page.evaluate(
      ({ trigger, stateOf }) => {
        const t = [...document.querySelectorAll(trigger)].find(
          (e) => e.getClientRects().length > 0,
        );
        const ic = t?.querySelector('svg.ic-chevron');
        if (!t || !ic) return null;
        const cs = getComputedStyle(ic);
        const open =
          stateOf === 'details'
            ? (t.closest('details')?.open ?? false)
            : t.getAttribute('aria-expanded') === 'true';
        return { open, transform: cs.transform, dur: cs.transitionDuration };
      },
      { trigger, stateOf },
    );
  const before = await read();
  if (!before) {
    iconRecord(`${label} 開閉の印`, false, '押す所 / 印が見えない');
    return;
  }
  await page.locator(trigger).filter({ visible: true }).first().click();
  await page.waitForTimeout(120);
  const after = await read();
  await page.locator(trigger).filter({ visible: true }).first().click();
  await page.waitForTimeout(120);
  const back = await read();
  const ok =
    before.open === false &&
    chevronAngle(before.transform) === 0 &&
    after?.open === true &&
    chevronAngle(after.transform) === 90 &&
    back?.open === false &&
    chevronAngle(back.transform) === 0 &&
    (REDUCED_MOTION !== 'reduce' || before.dur === '0s');
  iconRecord(
    `${label} 開閉の印 ${before.open} → ${after?.open} → ${back?.open}・transform ${before.transform} → ${after?.transform} → ${back?.transform}・transition ${before.dur}`,
    ok,
    '開閉 / 向き / 時間が違う',
  );
}

/**
 * #292 AC-7・AC-8: スマホ（360×780・390×844 × ダーク / ライト）で (a) 見えている記号ボタン .btn.icon.sm が 32×32px 以上・中の
 * svg.ic 18px・窓の中（舞台 + ポジションの peek・IV 推移・先物推移）、(b) IV 推移・先物推移のツールの行が切れず ⟳ が内容の箱の中
 * （既定の字幅と実機相当の字幅）、(c) 指標の「内訳」・追証マップ・シナリオの「モデルの前提」の行の高さ ≥ 36px、
 * (d) 1440×900 で .btn.icon.sm 26×26px・svg 14px（PC の密度は不変）、AC-8: 390×844 と 1440×900 で開閉の印が 90° 回り
 * transition 0s（reduce）
 */
async function iconSweep() {
  for (const [w, h] of [
    [360, 780],
    [390, 844],
    [1440, 900],
  ]) {
    const phone = w <= PHONE_MAX;
    for (const theme of phone ? ['dark', 'light'] : ['dark']) {
      const tag = `#292 ${theme} ${w}x${h}`;
      const ctx = await newContext(
        { width: w, height: h },
        { [WORKSPACE_KEY]: twoLegs, [PREFS_KEY]: prefsText(theme) },
        theme,
      );
      const page = await ctx.newPage();
      await page.goto(pageUrl('next'));
      await waitReady(page, 'next');
      const want = phone ? { box: 32, ic: 18 } : { box: 26, ic: 14, exact: true };
      // 舞台 + ポジション（舞台の ⋯・足の ⇄ ×・ヘッジの ⋯。PC は拡大の − ＋ ⟲ も）
      if (phone) await setShell(page, 'positions', 'peek');
      await iconButtonsCheck(page, `${tag} 舞台・ポジション`, {
        ...want,
        names: ['グラフの設定', 'デルタヘッジの詳細と設定'],
      });
      if (phone) {
        // IV 推移・先物推移（ツールの行の ⟳）
        await openIv(page, w);
        await iconButtonsCheck(page, `${tag} IV 推移`, { ...want, names: ['最新化'] });
        await ivToolsIconCheck(page, `${tag} IV 推移 既定の字幅`);
        await openFut(page, w);
        await iconButtonsCheck(page, `${tag} 先物推移`, { ...want, names: ['最新化'] });
        await ivToolsIconCheck(page, `${tag} 先物推移 既定の字幅`);
        if (await realMonoAvailable(page)) {
          await useRealMono(page);
          await openIv(page, w);
          await ivToolsIconCheck(page, `${tag} IV 推移 実機相当の字幅`);
          await openFut(page, w);
          await ivToolsIconCheck(page, `${tag} 先物推移 実機相当の字幅`);
        } else {
          iconStats.skip++;
          console.log(`${tag} 実機相当の字幅: DejaVu Sans Mono が無いので skip`);
        }
        // (c) 折りたたみの行の高さ
        await setShell(page, 'metrics', 'full');
        for (const sel of ['section.metrics .mx-toggle', 'section.metrics .hm-toggle']) {
          const hs = await foldRowHeights(page, sel);
          iconRecord(
            `${tag} ${sel} 高さ ${hs.map((v) => Math.round(v * 10) / 10).join(', ') || '—'}px`,
            hs.length > 0 && hs.every((v) => v >= 35.5),
            hs.length ? '36px 未満' : '見えない',
          );
        }
        if (w === 390)
          await chevronFlipCheck(page, `${tag} 指標の内訳`, 'section.metrics .mx-toggle', 'aria');
        await setShell(page, 'scenario', 'full');
        const hs = await foldRowHeights(page, 'section.scenario details.adv > summary');
        iconRecord(
          `${tag} details.adv > summary 高さ ${hs.map((v) => Math.round(v * 10) / 10).join(', ') || '—'}px`,
          hs.length > 0 && hs.every((v) => v >= 35.5),
          hs.length ? '36px 未満' : '見えない',
        );
        if (w === 390)
          await chevronFlipCheck(
            page,
            `${tag} シナリオのモデルの前提`,
            'section.scenario details.adv > summary',
            'details',
          );
      } else {
        await chevronFlipCheck(page, `${tag} 指標の内訳`, 'section.metrics .mx-toggle', 'aria');
        await chevronFlipCheck(
          page,
          `${tag} シナリオのモデルの前提`,
          'section.scenario details.adv > summary',
          'details',
        );
      }
      await ctx.close();
    }
  }
  console.log(
    `アイコンの検査（#292）: ${iconStats.pass} / ${iconStats.total} で pass${iconStats.skip ? `（skip ${iconStats.skip}）` : ''}`,
  );
}

// 開く URL（#91: 既定はクエリなし。--parts は ?parts）
console.log(`URL: ${pageUrl(mode)}`);
try {
  if (crossOnly && !parts) {
    if (flows) {
      // #217 で操作を変えたタッチの流れ（損益グラフ・IV 推移・先物推移の段）も
      await pnlCrossTouchFlow();
      await ivCrossTouchFlow();
      await futPaneTouchFlow();
      for (const vp of [
        { width: 360, height: 780 },
        { width: 1440, height: 900 },
      ])
        await cross217TouchFlows(vp);
      // #223: つかんで動かす間はホバーの十字線を出さない（スマイルの選択のスクラブ。損益グラフは --flows の pnlCrossFlows）
      await smileGrabFlow();
    } else {
      await cross217All();
      console.log(
        `十字線（スマイル・追証マップ・面）の検査（#217）: ${cross217Stats.pass} / ${cross217Stats.total} 状態で pass`,
      );
    }
  } else if (iconsOnly && !parts && !flows) {
    await iconSweep();
  } else if (aiOnly && !parts) {
    if (flows)
      for (const vp of [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ])
        await aiFlows(vp);
    else {
      await aiSweep();
      await aiAskSweep();
      await aiToolPendingFlow();
    }
  } else if (backOnly && !parts) {
    for (const vp of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ])
      await backFlows(vp);
  } else if (flows) await runFlows();
  else await measureAll();
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);

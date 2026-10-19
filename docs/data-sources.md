# データの供給元（板の契約と供給元の口）

画面は **板の JSON 版 1**（`GET /api/chain`。型は `data/chainTypes.ts`、検証は `data/chainJson.ts`）の形だけに依存し、価格モデル（F の推定・スマイル・ATM・グリーク・損益）は **気配（bid / ask）からブラウザで計算する**。どこから板を取ってくるか（供給元）は API の中の差し替えられる部品にした（#154・[ADR-0003](adr-0003-data-source-abstraction.md)）。

```
供給元（DATA_SOURCE）              API（api/）                         画面（ui/・model/）
 bigquery: optionchan の BigQuery ─┐
 file:     板の JSON 版 1 のファイル ─┼─ sources.build → /api/chain ─→ 検証 → 正規化（F・スマイル・ATM）→ 損益
 quotes:   中立の気配の一覧 +       ─┘                 /api/calendar
           取引カレンダーのファイル
```

既定は今までどおり `bigquery`（optionchan。`docs/design.md` 4 章）。`quotes` は、利用者が **自分で契約した API（証券会社の API・有料のデータ API）から書き出した気配の一覧** を読む口で、供給元ごとの違いを「気配を取り出してこの形に書く」部分だけにする。

## 1. 候補の比較（確認日 2026-10-19）

日経225オプションの板（行使価格ごとの bid / ask）を、建てる前の検討に使える頻度で取れるかを見た。**どれも実際には呼んでいない**（口座・費用・契約が要るため）。条件は各社の公開ページの記述で、解釈は利用者が各社に確かめること。

| 候補 | 取れる項目（日経225 OP / 先物 / 日経平均） | 頻度 | 動く場所 | 条件（口座・費用・利用規約） | 出典（確認日） |
|---|---|---|---|---|---|
| optionchan（今の既定） | OP の bid / ask・bid / ask の IV・約定・約定 IV・JPX グリーク・取引高・建玉・清算値・ATM の表示、ラージ先物 1 本、日経平均 | 毎分（ページの時刻で約 15 分遅れ） | クラウド（BigQuery） | JPX の公開ページの取り込み。データの利用条件は JPX のサイトの規定による（利用者が確かめる） | `docs/design.md` 4 章（2026-10-19） |
| kabu ステーション API（三菱 UFJ e スマート証券） | `/board/{symbol}` に現値・売買高・最良気配（**Bid と Ask の名前が本来と逆**: `BidPrice` = 最良売気配）・IV・Delta・Gamma・Theta・Vega（「オプション銘柄かつ日通しの場合のみ」）。`/symbolname/option` で限月・行使価格（0 = ATM）から銘柄コード。先物の清算値。建玉残の項目は見当たらない | リアルタイム（REST・PUSH） | **手元の PC**: kabu ステーション（Windows アプリ）を起動し `http://localhost:18080/kabusapi`。トークンはアプリの終了・ログアウト・早朝の強制ログアウトで無効 | 口座。kabu ステーションの Professional プラン以上で無料。情報系は秒間 10 件ほど、**登録銘柄は REST / PUSH 合わせて最大 50 銘柄**（2 限月の全行使価格（数百銘柄）は一度に持てない）。「取得した…内容は、お客さまご自身でご利用いただく場合に限り…**複製、加工、再利用、転載、第三者への販売・再配信・共同利用を禁止**」「**第三者が作成されたプログラム等を利用することを禁止**」 | https://raw.githubusercontent.com/kabucom/kabusapi/master/reference/kabu_STATION_API.yaml 、https://kabu.com/item/kabustation_api/default.html （2026-10-19） |
| 立花証券 e 支店 API | 対象商品は日本株式（現物・信用）。マスタに先物・オプション銘柄の問い合わせはあるが、時価情報が先物・オプションに対応するかは **未確認** | リアルタイム（REQUEST / EVENT（WebSocket）） | クラウドから可（HTTPS。特定の OS・アプリに依らない） | 口座。無料。専用ページに「当社提供情報は、蓄積、編集および加工等は禁止」の記述（ページ内の扱いは要確認） | https://www.e-shiten.jp/api/ 、https://www.e-shiten.jp/e_api/ （v4r10。2026-10-19） |
| J-Quants（JPX 公式） | `/v2/derivatives/bars/daily/options/225`: 四本値（日通し・夜間・日中）・取引高・建玉・限月・行使価格・取引最終日・SQ 日・清算値・理論価格・基準ボラティリティ・原資産価格・IV・金利。**気配（bid / ask）は無い** | 日次（27:00 ごろ更新） | クラウドから可（API キー） | スタンダード以上（検索結果では月 3,300 円・税込。2025-08 の JPX の報道発表。要再確認）。規約本文は未確認 | https://jpx-jquants.com/en/spec/drv-bars-daily-opt-225.md 、https://jpx-jquants.com/en/spec/data-update.md （2026-10-19） |
| 楽天証券 MARKETSPEED II RSS | Excel の関数で先物 OP の時価（IV を含む市況）。関数名・項目は未確認 | リアルタイム | **手元の PC**（Windows・MARKETSPEED II・Excel） | 口座。規約未確認 | https://marketspeed.jp/guide/manual/ms2rss_function.pdf （検索結果のみ。2026-10-19） |
| Interactive Brokers | OSE の先物・オプションの気配（購読） | 遅延は無料・リアルタイムは購読 | 手元の TWS / IB Gateway 経由の API | 口座・データの購読料（非プロの額は未確認）。表示・再配布は購読の規約による | https://www.interactivebrokers.com/ibis/marketData.php （検索結果のみ。2026-10-19） |

読み取れること:

- **板（行使価格ごとの気配）を毎分以上で取れるのは証券会社の API**（kabu・IB。立花は未確認）。J-Quants は日次で気配が無いので、今の画面（気配の mid から F・スマイル）には足りない（清算値と IV で組む「清算値モード」（`docs/design.md` 7.2 の 5。後段）向き）
- kabu は **手元の PC のアプリが要り**（Cloud Run から直接は呼べない）、**50 銘柄の上限**で 2 限月の全行使価格は持てない（ATM の近くに絞る・入れ替えながら読む）。さらに「第三者が作成されたプログラム等の利用の禁止」「加工の禁止」があり、clone した人が本ツールで kabu の値を使う形が条件に合うかは **オーナー判断・証券会社への確認が要る**（#154 の懸念）
- 証券会社の API はどれも口座が前提で、値は「本人が使う」範囲。本ツールは本人の環境（自分の GCP・手元）で動かす前提なので、他人に配る形にはならないが、規約の文言は各社で確かめる

## 2. 板の契約（板の JSON 版 1 の必須 / 欠けうる）

形は版 1 のまま（`schema_version: 1`。キーは省略しない。欠けは null。省略してよいのは `source`・`quotation`・`quotation_date`・`is_atm` だけ。知らないキーは無視）。下の「欠けうる」は、**供給元によって全行 null でよい**項目。

| 項目 | 区分 | 欠けたときの画面 |
|---|---|---|
| `schema_version`・`snapshot_at`（オフセット付き）・`reason` | 必須 | — （無ければ検証で拒否） |
| `delayed_minutes` | 必須（0 可） | 0 なら「遅れなし」、それ以外は「約 N 分遅れ」 |
| `future.contract_month`・`last_trading_day`・`sq_date`、`months[].contract_month`・`last_trading_day`・`sq_date`・`rows[].k` | 必須 | — （限月・満期・先物の足の ID） |
| `call` / `put` の `bid`・`ask` | 必須（キー）。値は null 可 | 画面の計算の元。気配の無い行は「気配なし」。両側気配が 5 組未満の限月は F が先物価格（無ければ NaN → スマイル・ATM なし） |
| `future.price` | 欠けうる（null 可） | F の推定の窓の中心と、合成先物が作れないときの代わりに使う。null なら合成先物だけ。ATM の基準 A（直近四半期のラージ先物）が出ない |
| `bid_iv`・`ask_iv` | 欠けうる | **板全体で 1 つも無ければ**、板の IV 列は気配の価格から Black-76（限月の F・T・r）で求めた値を出し、「JPX の IV 欠損」の印は付けない。一部の行だけ欠ける板（今の optionchan）は従来どおり印を付ける。スマイル・足のアンカー IV はもともと気配の価格から求めている。IV 推移の「今」の 1 点は出ない（下の `is_atm`） |
| `price`・`price_time`（約定） | 欠けうる | 気配の無い行でスマイルの節点を約定価格から作る候補が無くなるだけ |
| `iv`（約定 IV） | 欠けうる | 使っていない（運ぶだけ） |
| `delta`・`gamma`・`theta`・`vega`（JPX グリーク） | 欠けうる | 画面のグリークは Black-76 で自前。手元の照合（AC7。`data/jpxGreeks.ts`）が出ないだけ |
| `volume`・`positions` | 欠けうる | 使っていない（運ぶだけ） |
| `quotation`・`quotation_date` | 任意・欠けうる | 「清算値」モード（後段）用。今は運ぶだけ |
| `is_atm` | 任意・欠けうる | IV 推移の「今」の 1 点（optionchan と同じ定義の iv30。`model/constantMaturity.ts`。`bid_iv`・`ask_iv` も使う）が出ない。ATM の判定は自前（5.9）なので影響なし |
| `spot.price`・`spot.price_time` | 欠けうる（キーは必須） | ヘッダの「日経平均」が — |
| `source` | 任意 | ヘッダの「データ元」に出す |

テスト: `tests/data/quotesOnly.test.ts`（欠けうる項目をすべて null にした合成の板で、検証・F の回復・スマイル・印・板の IV 列・足の評価）。

取引カレンダー（`/api/calendar`）は板とは別のエンドポイント。供給元が返せなければ 503 で、画面は同梱の版（`data/calendar/calendar.json`）を使う。`source` が `bigquery` 以外の API の版は、ヘッダの前提に「API の版」と出す。IV 推移（`/api/atm_iv`）と日次の値（`/api/atm_daily`）は optionchan の表だけから作っており、他の供給元では 503（IV 推移・追証マップの過去の点は「読めない」）。

## 3. API の供給元の口

`api/src/simulator_api/sources.py`:

- `DataSource`（Protocol）: `chain()`（`/api/chain`）・`calendar()`（`/api/calendar`）・`atm_iv(req)`・`atm_daily()`。失敗は `service.Unavailable`（503 `{"error":"unavailable"}`。理由の符号だけをログに）か任意の例外（503・ログは型だけ）
- `BUILDERS`: 環境変数 `DATA_SOURCE` の値 → 実装（`bigquery` = `ChainService`、`file` = `FileChainService`、`quotes` = `QuotesFileService`）。キーは `settings.DATA_SOURCES` と同じ（`api/tests/test_sources.py`）。未知の値は起動時にエラー
- `bigquery` の読み方・クエリ・キャッシュ・single-flight・`MAX_BYTES_BILLED` は #154 で変えていない（`docs/design.md` 7.2・7.3）

## 4. 中立の気配の一覧（`DATA_SOURCE=quotes`。版 1）

`QUOTES_FILE`（この形の JSON）と `CALENDAR_FILE`（`/api/calendar` と同じ形。同梱の `data/calendar/calendar.json` を指せる）を読み、`api/src/simulator_api/quotes.py` が板の JSON 版 1 にする。要求ごとに読み直すので、利用者のスクリプトがファイルを書き換えれば [最新] で新しい板になる。

```json
{
  "quotes_version": 1,
  "source": "my-broker",
  "snapshot_at": "2026-10-13T21:31:00+09:00",
  "delayed_minutes": 0,
  "future": { "contract_month": "2026-12", "price": 67900, "price_time": "2026-10-13T21:30:58+09:00" },
  "spot": null,
  "options": [
    { "contract_month": "2026-11", "type": "put", "k": 67750, "bid": 865, "ask": 880 },
    { "contract_month": "2026-11", "type": "call", "k": 67750, "bid": 1010, "ask": 1025, "volume": 12 }
  ]
}
```

（値は架空。実際は 2 限月の行使価格を並べ、少なくとも 1 限月の先物 ±5% の行を含める）

- 必須: `quotes_version`（1）・`snapshot_at`（オフセット付き）・`delayed_minutes`（≥ 0）・`future.contract_month`・`options`（1 件以上、最大 10,000 件）と各行の `contract_month`・`type`（`call` / `put`）・`k`（整数円）・`bid`・`ask`（キーは必須、値は null 可）
- 任意（省略 = null）: `source`（英数字と `_ . -` の 40 文字まで。既定 `quotes`）、`future.price`・`price_time`、`spot`、各行の `bid_iv`・`ask_iv`・`price`・`price_time`・`iv`・`volume`・`positions`・`delta`〜`vega`・`quotation`・`quotation_date`・`is_atm`（意味・単位は板の JSON 版 1 と同じ。IV は %、グリークは原資産 1 単位あたり）。知らないキーは無視
- サーバーが入れるもの: 限月・先物の `last_trading_day`・`sq_date`（カレンダーの規則。第 2 金曜、休業日なら前へ）、行の並び（行使価格の昇順。同じ (限月, K, 種別) は最初の 1 件）、`reason`（`snapshot_at` が 45 分以内かつ連続売買の窓なら `latest`、それ以外は寄り前 / 引け後 / `closed`。7.2 と同じ窓）
- 使える板の判定は optionchan と同じ（`usable.board_ok`: 先物の価格があり、1 限月の先物 ±5% の両側気配が 75% 以上）。満たさなければ 503。**ATM の近くの行使価格を必ず含める**（kabu の 50 銘柄の上限のような制約があるときも、ATM ±5% を先に）
- 形の誤りは 503（ログ `quotes_file_invalid` に JSON の位置だけ。値は出さない）。`snapshot_at` が今から 5 分より先（未来）も形の誤り（時計・オフセットの誤り）。`QUOTES_FILE`・`CALENDAR_FILE` が 16 MiB を超えたら読まずに 503（ログ `file_too_large`）。`/api/calendar` は `CALENDAR_FILE` を `source: "file"` で返す。`/api/atm_iv`・`/api/atm_daily` は 503

## 5. 新しい供給元の足し方

1. **一番小さい道（コードを足さない）**: 自分の API から気配を取り出して上の中立の形の JSON を書くスクリプトを自分の環境で動かし、API を `DATA_SOURCE=quotes QUOTES_FILE=… CALENDAR_FILE=…` で起動する（`api/README.md`「手元で動かす」）。供給元の API の利用条件（本人の利用に限る・加工の禁止など）は自分で確かめる
2. **API の中に供給元を足す**: `DataSource` を満たすクラスを書き（取得 → `quotes.parse_quotes` / `quotes.chain_from_quotes` で板に。無いエンドポイントは `Unavailable`）、`settings.DATA_SOURCES` と `sources.BUILDERS` に名前を足す。テストは合成の応答（架空の値）で書き、実際の API は CI で呼ばない。費用・回数の上限（クエリ量・流量制限）はキャッシュと single-flight で守る（`service.ChainService` が手本）
3. 板の JSON の形（版 1）は変えない。新しい項目が要るなら版を上げる設計を先に（`docs/design.md` 7.1）

## 6. 未確認・残り

- kabu ステーション API の条件の解釈（第三者のプログラムの利用・加工の禁止）。オーナー判断・証券会社への確認（#154）
- 立花 e 支店 API の先物・オプションの時価の有無、J-Quants・楽天・IB の規約本文と料金
- J-Quants の日次の値（清算値・IV）で板を組む「清算値モード」（後段。別 Issue の候補）

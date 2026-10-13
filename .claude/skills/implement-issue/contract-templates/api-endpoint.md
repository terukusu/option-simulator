# 契約テンプレ: API エンドポイント（`api/`、縦切り 2 から）

対象: `api/` の Flask のエンドポイント。例: `GET /api/chain`、`GET /api/chain?at=<ISO 時刻>`、`GET /healthz`（`docs/design.md` 7 章）。API は **optionchan の BigQuery を読んで板の JSON を返すだけ**（計算はブラウザの `model/`）。書き込みは無い。

判定・変換のロジック（「使える板」の判定 7.2、行の正規化、時間帯の判定）は BigQuery を呼ぶ部分から切り出し、純粋な関数として pytest で固定する。BigQuery を呼ぶ部分は偽の runner でテストする。

## 記入項目

| 項目 | 書き方 |
|---|---|
| メソッド・パス | `GET /api/chain` など |
| 入力 | クエリパラメータとその検証（`at` は ISO 時刻、14 日以内、形式違いは 400）。想定外の入力の扱い。**入力値を応答・ログにそのまま出さない** |
| 認証 | IAP の後ろに置く（アプリ側の認証は無い）。IAP のユーザー ID ヘッダを使うならハッシュをメモリ内にだけ持つ（保存・ログ出力しない） |
| 読むもの | optionchan のテーブル関数（`latest_runs` / `option_price_latest` / `future_price_latest` / `spot_price_latest`）と使う列（`docs/design.md` 4.1 の範囲だけ）。生テーブルは読まない |
| クエリ | パラメータ化（値を文字列で埋め込まない）、時間窓（1 秒の窓など）、`MAX_BYTES_BILLED`（既定 512 MiB）、スキャン量の見積もり（dry run の実測） |
| キャッシュ・抑制 | キャッシュキー（`snapshot_at`）、single-flight、連打制限、`Cache-Control` / `ETag` |
| 応答 | ステータス、`Content-Type`、JSON の形（7.1 の案）、`reason` の値。後方互換が要る消費者（`data/` の `bigquery` アダプタ、`file` アダプタの JSON 形式） |
| 異常系 | BigQuery の失敗・タイムアウト・上限超過で何を返すか（503 など）。例外本文を応答に出さない |
| ログ | 構造化ログ（JSON）。個人情報・資格情報・IAP のメールを出さない |
| 性能 | 応答 3 秒以内（コールドスタート +2〜3 秒を許容） |
| 設定 | 読む環境変数（`GCP_PROJECT`・`BQ_DATASET`・`BQ_LOCATION`・`MAX_BYTES_BILLED`・`DATA_SOURCE`・`CHAIN_FILE` 等。8.3）。実値はコード・docs に書かない |
| 設計との対応 | `docs/design.md` の節・AC 番号 |

## 記入テンプレ

```markdown
### `<METHOD> <path>` (`<ファイルパス>`) — 新規 / 改修

- input: <パラメータと検証> / 想定外入力: <400 / 無視>
- auth: IAP (アプリ側なし) / IAP ヘッダの扱い: <使わない / ハッシュをメモリ内のみ>
- 読むもの: <テーブル関数と列>
- query: <パラメータ化、窓、MAX_BYTES_BILLED、dry run のスキャン量>
- cache: <キー、TTL、single-flight、連打制限、Cache-Control / ETag>
- response: <ステータス、JSON の形、reason>
- 異常系: <BigQuery の失敗時の応答>
- log: <出す項目 / 出さない項目>
- 性能: <見積もり>
- 設定: <環境変数の名前>
- 設計: docs/design.md <節>、<AC 番号>
- 改修の場合の差分:
  - 現契約 (コードとテストから抽出): <現状の入出力>
  - 変更点: <追加 / 変更した入出力>
  - 後方互換: data/ のアダプタと file 形式への影響
```

## 観察可能な AC への落とし方

ローカルでは BigQuery を呼ばずに判定できる形（純粋な関数の pytest と偽の runner）を主にし、本番でしか判定できないものはデプロイ後の確認手順として明記する。

| 契約 | 観察可能な AC |
|---|---|
| 「使える板」の判定 | `合成の候補（両側気配 80% 未満）では次の候補を見て reason = pre_open`（判定関数の pytest） |
| 入力検証 | `at=<不正な文字列> で 400、応答本文に入力値を含まない`（Flask のテストクライアント） |
| クエリのパラメータ化 | `偽の runner が受け取った SQL に at の値が文字列として含まれない` |
| 例外の秘匿 | `runner が例外を投げると 503、応答に例外本文を含まない` |
| 契約（AC25） | CI のスキーマ照合が green、`OPTIONCHAN_BQ_TEST=1` で SQL の dry run が通る |
| スキャン量 | `bq query --dry_run` の見積もりが <MiB> 以下 |
| IAP | デプロイ後、未認証の `curl -s -o /dev/null -w '%{http_code}' <URL>/healthz` が 302 / 401 / 403（URL は表示・記録しない） |
| エラーログ | デプロイ後 `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="simulator" AND severity>=ERROR' --freshness=10m` が 0 件 |

読むもの・書き込み先の **列挙漏れ**（契約 4.1 の外の列・テーブルを読む、どこかに書き込む）は Phase 2 の数値・データ視点・スコープ分解視点が block する対象。

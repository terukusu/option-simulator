# ADR-0004: AI の費用の 1 日上限は Firestore の名前つき DB で数える

- 状態: 採択
- 日付: 2026-10-19
- 関連: #134・EPIC #141、`docs/ai-advisor.md` 論点 3、`docs/design.md` 13.1 K15・13.4「AI の中継」・付録 B、`infra/README.md`「AI の費用の計上（Firestore）」、[ADR-0001](adr-0001-ai-credentials-secret-manager.md)

## 背景

AI の中継（#134）は、API キー（従量課金）のとき 1 日（JST）$3 の上限を守る（K15）。上限に達したら送る前に止め、押す前に残りが分かる必要がある。中継は送る前にその要求の最大額を **予約** し、終わったら `usage` × 料金表で **精算** する（`docs/ai-advisor.md` 論点 3）。

制約:

- Cloud Run `simulator` は最小 0・最大 2 インスタンス。メモリ内の計上はインスタンスをまたがず、冷えるたびに 0 に戻る
- optionchan の BigQuery は読み取り専用（書かない）
- CI の apply SA の権限を広げない（付録 B）。依存を増やしすぎない（`google-cloud-firestore` は grpc 一式を連れてくる）
- 数える場所が読めない・書けないときは送らない（閉じる側に倒す）

## 決定

- **Firestore の名前つき DB `simulator-ai`**（Native モード・`asia-northeast1`・削除保護・`deletion_policy = "ABANDON"`）に、日ごとの文書 `ai_spend/<YYYY-MM-DD（JST）>`（`charged_micro_usd`・`requests`。整数）を置く。プロジェクトの既存の `(default)` DB（Datastore モード）には触れない
- `sa-simulator` に `roles/datastore.user` を **IAM 条件 `resource.name == "projects/<PROJECT_ID>/databases/simulator-ai"` つき** で付ける（`google_project_iam_member`、追加型）。DB と付与は `infra/bootstrap/ai_budget.tf`（所有者の apply）。apply SA・plan SA には付けない
- 中継は Firestore の REST を `google.auth` の `AuthorizedSession` で呼ぶ（`google-auth`・`requests` は既に `uv.lock` にある。新しい依存なし）
  - 予約: 読む → `計上額 + 予約額 ≤ 上限` を判定 → `currentDocument.updateTime`（文書が無ければ `exists=false`）の前提条件つきで書く。前提条件の失敗（他のインスタンスと競合）は 3 回まで読み直す
  - 精算: `commit` の `fieldTransforms.increment`（原子的。足した後の値を応答から読む）
  - 読めない・書けない・5 秒のタイムアウトは 503 `unavailable`（送らない）
- `oauth_token` は数えない（K15。読み書きもしない）。手元・テストは `AI_BUDGET_STORE=memory`
- 二重の安全弁として、Claude Console で simulator 専用のワークスペースに月の上限を設ける（所有者の手作業）

## 検討した選択肢

| 案 | 良い点 | 悪い点 |
|---|---|---|
| A. Firestore の名前つき DB + DB に絞る条件つきの付与（採択） | インスタンスをまたいで正しい。前提条件と increment で競合しても上限を越えない。依存が増えない。K15 の「Firestore の日のカウンタ」のまま | 本番の資源 1・付与 1 が増える。名前つき DB は無料枠の外（読み書きは 1 要求で数回、月に 1 セント未満の見込み）。DB の削除は Terraform の外 |
| B. GCS のオブジェクト 1 つ（世代番号の前提条件つきの書き換え） | 安い・単純 | バケットの新設と付与が要る（state のバケットと混ぜない）。increment が無いので精算も読み直しの往復 |
| C. メモリ内の計上 + Console の月の上限だけ | 本番の資源が増えない | 冷えるたびに日の計上が 0 に戻り、日の上限が実質効かない（止まるのは月の上限だけ） |
| D. C + Cloud Run を最小 1・最大 1 | 資源は増えない | 常時のインスタンスの費用。再起動・デプロイで 0 に戻る。`/api/chain` の台数も 1 になる |
| E. BigQuery に書く | — | optionchan の BigQuery は読み取り専用。費用・整合も悪い |

## 結果

- 良い点: 日の上限がインスタンス・再起動・デプロイをまたいで効く。付与は DB に絞られ `(default)` に及ばない。テストは偽の session で資格情報なしに回る
- 悪い点:
  - 計上の場所が止まると AI も止まる（閉じる側。simulator の他の機能は動く）
  - 途中で切れた要求（締め切り・切断・上流の失敗）は予約額のまま数える（多めに数える側）
  - 上限を越えないのは **予約の時点**（`計上額 + 予約額 ≤ 上限`）。予約額は入力の見積もり（UTF-8 のバイト数 + 2,000 = トークン数の上界）× 5 分の書き込みの単価（初回の自動の prompt caching の単価 = 入力の 1.25 倍）+ `max_tokens` × 出力の単価なので、実額は予約額以下になり、精算後も上限を越えない見込み。見積もりの前提（トークン 1 つは 1 バイト以上・見えない分は 2,000 トークン以内）が外れたときだけ、精算で 1 要求ぶん越えうる（次の要求は 429）
  - IAM 条件 `resource.name` が文書の読み書きに効くこと、Datastore モードの `(default)` があるプロジェクトで Native の名前つき DB を作れることは公式の説明に基づくが、本番の apply 後に確かめる（`infra/README.md` の確認）
- 撤去: `AI_CREDENTIAL=none` で deploy → `ai_budget.tf` を消す PR → 所有者の apply（付与の delete。DB は管理から外れるだけ）→ 削除保護を外して `gcloud firestore databases delete`

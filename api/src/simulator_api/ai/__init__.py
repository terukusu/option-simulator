"""AI の中継（#134。docs/design.md 7.1・13.4・14 章、docs/ai-advisor.md 論点 1・3・4・6〜8）。

- shape: 小さな形の検査（キー・型・範囲・個数・列挙・正規表現）。純関数
- tools: ツールの登録（名前 → 入力・結果の形と説明）。#134 は空、#135 が足す
- allowlist: 要求の本文の検査と、送る本文の組み立て直し。純関数
- budget: 料金表・見積もり・予約 / 精算の額・JST の日。SpendStore と MemoryStore
- firestore_store: 日の計上を Firestore の名前つき DB に（REST）
- gateway: Anthropic の SDK の薄い包み（api_key / oauth_token / wif。wif の ID トークンはメタデータサーバー）と、
  偽の送信先（AI_CREDENTIAL=fake・テスト）
- guard: 口の守り（同じオリジン・Content-Type・大きさ・同時の本数・1 分の回数）
- relay: エンドポイントの本体（SSE のイベントの生成と、精算・ログ）
"""

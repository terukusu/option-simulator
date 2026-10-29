# ADR-0007: AI の相談役にマニュアルと設計書を節ごとに読ませる（目次は system、本文は中継が実行する read_doc）

- 状態: 採択（2026-10-21）
- 日付: 2026-10-21
- 関連: #137・EPIC #141（終了条件 7）・#120（柱 4）、[ADR-0006](adr-0006-ai-agent-sdk-only-and-skills.md)（スキル・フック・turn・予約額の式）、`docs/design.md` 14 章・13.4「AI の中継」、`docs/ai-advisor.md`「設計書とマニュアルを丸ごと渡したとき（#137 の前提）」

## 背景

- 計算の前提（Black-76・β・IV の動き方・30 日固定・証拠金の概算など）を聞かれた AI が一般知識で推測しないように、この simulator の定義が書いてある `docs/design.md`・`docs/user-guide.md` を根拠にさせたい。#91 のレビューでは、マニュアルの説明が改訂前の誤りのまま残っていたのが見つかった（文書を根拠にするなら文書と実装の食い違いも直す）
- 方針（2026-10-21 のオーナーとの会話。#137 のコメント）: **目次（見出しの一覧）だけを毎回渡し、本文は AI がツールで必要な節だけを読む**（全文を毎回送らない）。目的は計算の前提の説明に加えて **操作の案内（使い方のサポート）**。返答には節（ファイルと見出し）を示し、文書に無いことは無いと言う
- 大きさ: 2 つの文書を丸ごと渡すと約 13 万トークン（`docs/ai-advisor.md` の見積もり）。目次だけなら約 3.8 KB（109 節）

## 決定

1. **読む仕組み = 中継の中で実行するツール `read_doc(file, section, part?)`**。in-process の SDK MCP ツール（server 名 `docs` = CLI の名前 `mcp__docs__read_doc`。`api/src/simulator_api/ai/docs.py`・`agent_sdk.py`）。PreToolUse フックが **この名前ちょうどだけ** を allow し、関数が索引の節の本文を返す。ブラウザで計算するツール（`mcp__sim__*`）は今どおり deny + `continue_: False`（ブラウザが実行する）。「中継はツールを実行しない」（`tools.py`・14 章）の唯一の例外で、返すのはリポジトリの文書の節だけ（計算はしない）
2. `read_doc` の往復は Skill と同じ扱い: tool_use は SSE・`done` の content に出さず、ブラウザの履歴に残らない（中継は状態を持たない。要れば次の発言で読み直す。system に 1 行）。ブラウザの許可リスト・SSE の形・画面は変えない
3. **目次の置き場 = system prompt の末尾**（節の番号と見出しだけ。`relay.system_prompt()` = `SYSTEM_PROMPT` + 文書の決まり + 目次）。目次は文書から起動後 1 回組み立てる（文書と食い違わない）。スキルにすると読むたびに 1 turn 遅れる。静的なので prompt caching の前置き（tools → system）は要求の間で同じ
4. **渡す文書**: `docs/user-guide.md` の 1〜20 章（題・目次を除く）と、`docs/design.md` の **3 章（商品仕様）・5 章（価格モデル）だけ**。4 章（optionchan の実測の要約）・6 章（画面のワイヤー）・13 章（決定の経緯・判断待ち）・14 章・付録・変更履歴は渡さない。目次と節の見出しからは開発の経緯（「（#131・#150）」「（K7 → Q2 …）」）を外し、system で「Issue 番号・決定の記号・開発の経緯を答えに書かない」。文書はリポジトリの公開できる内容（個人の値・JPX の実データを置かない = `repo-values-check.sh` の対象）
5. **節の番号**: 見出しに番号（`### 5.4 …`）があればそれ、無ければ親の番号 + 兄弟の順（user-guide の `### 追証マップ` = `8.5`、design の `#### JPX グリークの単位` = `5.6.1`）。`## N.` の無い章とコードブロックの中の `#` は節にしない。答えでは「マニュアル 8.5「追証マップ」」「設計書 5.4「シナリオ（IV の 1 本の式）」」の形で示す
6. **入力の検査**: `file` は `user-guide` / `design` の列挙、`section` は番号の形（`^\d{1,2}(\.\d{1,2}){0,3}$`）、`part` は 1〜20 の整数、ほかのキーは不可。入力からパスを作らない（索引の辞書を引くだけ）。知らない番号・許可リストの外の章は本文を含まない短いエラーの文（`is_error`。turn は続く）
7. **大きさの上限**（`settings.py`）: 1 回の読み `AI_DOC_READ_MAX_BYTES` = 8 KiB（見出しの行・「続きは」の行を含めて。本文は `AI_DOC_FRAME_BYTES` = 512 B を引いた大きさで行の境に part に分ける。空行の後を優先。全 part をつなぐと節の本文）、1 要求の合計 `AI_DOC_REQUEST_MAX_BYTES` = 16 KiB（= 2 回分。part を 2 つは必ず読める）、1 要求の呼び出し `AI_DOC_MAX_READS` = 6。要求ごとの `docs.Reader` が数える。最大の節は設計書 5.10（約 18 KB = 3 part）
   - **呼び出しの回数を有限にする**（レビューの指摘 1）: 7 回目以降の `read_doc` は **フックが deny + `continue_: False`** で要求を終える（`Reader.permit()`。上流をもう呼ばないので、その結果は送られない）。エラーの文に回数を数えずに返し続ける形だと、出力の上限の範囲で結果が何百も返りうる。打ち切りの後の `done` は最後の message の text まで（read_doc の block は出ない）
   - **上界の根拠**: 1 要求で上流に送る `read_doc` の結果 ≤ 本文の合計 16 KiB（`used_bytes`。見出し込み）+ 6 回 ×（エラーの文の上限 `AI_DOC_ERROR_MAX_BYTES` = 256 B + tool_result の枠 `AI_DOC_RESULT_FRAME_BYTES` = 200 B）= 16 KiB + 2,736 B ≤ 16 KiB + `AI_DOC_OVERHEAD_TOKENS`（3,000。トークン数 ≤ バイト数）。`tests/test_ai_docs.py` で固定
8. **turn の上限は 3 のまま**（Skill / read_doc の turn 2 回 + 答え）。system で「読む節は 1 回の応答でまとめて呼ぶ（Skill と並べてよい）」。4 にすると予約額が本文 25k トークンで約 $1.87（日の上限 $3 の 6 割超）になるので採らない。上限を超えたときは今どおり `error_max_turns` → `upstream_unavailable`
9. **予約額**: ADR-0006 の式のまま、K（turn ごとに増える入力の上界）を `budget.loaded_tokens()` = SKILL.md の合計 + `AI_SKILL_OVERHEAD_TOKENS` + `AI_DOC_REQUEST_MAX_BYTES` + `AI_DOC_OVERHEAD_TOKENS`（3,000。決定 7 の上界）にする（K を turn ごとに足すので保守側）。E（入力の見積もり）には目次と `read_doc` の定義が入る（`params["server_tools"]`）。目安（`budget.reserve_micro_usd` の再計算）: 本文 25k トークンで 約 $0.95 → 約 $1.26、90k で 約 $1.49 → 約 $1.81（精算で実額に戻る）
10. **イメージ**: `Dockerfile` の最終段で 2 つの文書を `/app/docs/` に COPY し `ENV AI_DOCS_DIR=/app/docs`。`.dockerignore` の許可リストと `.github/scripts/image.sh` の入力パスに 2 行（ci.yml の突き合わせ）。`image-check.sh` は `/app` が `docs`・`static` だけ、`/app/docs` が 2 つの文書だけ、非 root で索引が組めて節の数を出す。文書だけを変えた PR でもイメージのタグが変わる（中身が変わるので正しい）
11. 文書が読めない（手元で `AI_DOCS_DIR` が無いなど）ときは、目次も `read_doc` も出さない（ログ `ai_docs_unavailable` を 1 回）
12. ログ: `ai_request` に `docs`（返した節の `<file>:<番号>`、part が 2 以上なら `#<part>`）。本文・入力の値は出さない

## 検討した選択肢

| 案 | 良い点 | 悪い点 |
|---|---|---|
| A. 中継が実行する in-process の SDK MCP ツール（採択） | 入力を列挙と番号の形式で検査し、索引の節だけを返す。上限を中継で数えられる。Skill と同じ往復の仕組み（CLI の turn）に乗る | 「中継はツールを実行しない」の例外ができる。フックで allow する名前を 1 つ持つ |
| B. スキル（SKILL.md に目次、本文は組み込みの Read で読ませる） | CLI の仕組みだけで済む | Read を開けると任意のパスの読み取りをフックの文字列検査に頼る（パスの正規化・シンボリックリンク）。節の単位で切れない |
| C. 節ごとのスキル | 一覧から選べる | 節が 109 あり、スキルの一覧（CLI の system の message）が膨らむ。番号の体系を持てない |
| D. 全文を毎回 system に入れる | 仕組みが要らない | 約 13 万トークン。予約額が日の上限を超える。キャッシュが切れると高い |
| E. 目次をスキルに入れる | system が短い | 文書の質問のたびに 1 turn 遅れ、turn の上限 3 を早く使い切る |

## 結果

- 良い点: 計算の前提と操作の質問に、文書の節を示して答えられる（EPIC #141 の終了条件 7）。全文を送らない（目次 約 3.8 KB）。文書を直せば AI の答えも直る（同じ PR・同じイメージ）
- 悪い点:
  - 文書の数（定義・既定値）は画面の数字の照合（`ui/view/aiNumbers.ts`）の外なので「照合できない数字」の点線が付く（照合の値に文書を入れるのはスコープ外）
  - 文書を読む質問は上流を 1 回多く呼ぶ（+2〜4 秒）。読んだ本文は書き込みの単価
  - 予約額が増え（約 1.3 倍）、数える資格情報（`api_key`・`wif`）では日の上限の近くで早めに `budget_exceeded` になる（精算で戻る）
  - 足が 0 本だと AI のパネルから送れない（画面の制約）ので、操作の案内もポジションを組んでから（別 Issue の候補）
  - AI が要る節を読まない・節を示さないと答えの質が落ちる → `npm run ai:eval -- --docs-only`（7 問: 計算の前提 3・操作の案内 3・文書に無いこと 1）で確かめる
- 戻し方: PR の revert → deploy（イメージから文書が抜け、目次と `read_doc` が消える）。急ぐときは旧リビジョンへ `gcloud run services update-traffic`（所有者の承認の上）

## 確かめ方

- 手元（Anthropic を呼ばない）: `api/tests/test_ai_docs.py`（索引・目次・分割・`read_doc` の検査と上限）、`test_ai_agent_sdk.py`（フック・options・Assembler）、`test_ai_agent_sdk_cli.py`（本物の同梱 CLI と偽の Messages API で `read_doc` の往復・Skill と同じ turn・許可リストの外・予約額の前提）、`image-check.sh`
- 評価（Anthropic を呼ぶ。所有者の手元）: 中継を起動し `AI_EVAL_RELAY_LOG=<中継のログ> npm run ai:eval -- --docs-only`。各問が pass（節を示す・Issue 番号を書かない・想定の節を読む・無いことを無いと言う）
- デプロイ後: 操作の質問を 1 回送り、`gcloud logging read 'jsonPayload.event="ai_request"' --freshness=30m --project "$P"` の該当の行に `docs` があり `error` が null

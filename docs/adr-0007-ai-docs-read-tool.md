# ADR-0007: AI の相談役にマニュアルと設計書を節ごとに読ませる（目次は system、本文は中継が実行する read_doc）

- 状態: 採択（2026-10-21。2026-11-03 に追補: 予約額で文書の分を 1 要求に 1 回だけ数え、スキルの守りと大きさの上限を改めた。末尾の「追補（#338）」）
- 日付: 2026-10-21
- 関連: #137・#338・EPIC #141（終了条件 7）・#120（柱 4）、[ADR-0006](adr-0006-ai-agent-sdk-only-and-skills.md)（スキル・フック・turn・予約額の式）、`docs/design.md` 14 章・13.4「AI の中継」、`docs/ai-advisor.md`「設計書とマニュアルを丸ごと渡したとき（#137 の前提）」

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
9. **予約額**: ADR-0006 の式のまま、K（turn ごとに増える入力の上界）を `budget.loaded_tokens()` = SKILL.md の合計 + `AI_SKILL_OVERHEAD_TOKENS` + `AI_DOC_REQUEST_MAX_BYTES` + `AI_DOC_OVERHEAD_TOKENS`（3,000。決定 7 の上界）にする（K を turn ごとに足すので保守側）。E（入力の見積もり）には目次と `read_doc` の定義が入る（`params["server_tools"]`）。目安（`budget.reserve_micro_usd` の再計算）: 本文 25k トークンで 約 $0.95 → 約 $1.26、90k で 約 $1.49 → 約 $1.81（精算で実額に戻る）。→ 文書の分は 1 要求に 1 回だけ数えるよう末尾の「追補（#338）」で改訂
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

## 追補（#338、2026-11-03）: 予約額で文書の分を 1 要求に 1 回だけ数える・スキルの守り・スキルの上限 24 KiB

### 背景

- 決定 9 は K（スキル + 文書の上界）を turn ごとに足していた。T = 3 では文書の分 D を 2 回数える（保守側）。そのため本文 90k の予約が 1,993,806 µUSD（スキルの合計 15,283 B）で、`test_reserve_long_conversation_not_rejected_at_day_start`（< $2.00）の余裕はスキルの文 約 380 B しかなかった（#20 第 2 弾で SKILL.md に節を足すと落ちた）
- 一方、文書は決定 7 のとおり要求ごとの `docs.Reader` が **要求全体で** 大きさ・回数を数えている。スキルの側は「各スキルは 1 turn に 1 回まで」の前提を守るものが無かった（フックは一覧の名前の Skill を何度でも通した。CLI は同じスキルを重複を除かずに入れる）

### 決定（決定 9 と ADR-0006 の決定 5・7・11 を改める）

1. **予約額の式**（`budget.reserve_micro_usd(model, E, M, T, S, D)`）: K を、turn ごとに増えうる分 **S** = SKILL.md の合計 + `AI_SKILL_OVERHEAD_TOKENS`（`budget.skill_tokens()`）と、1 要求の合計で上限がある分 **D** = `AI_DOC_REQUEST_MAX_BYTES` + `AI_DOC_OVERHEAD_TOKENS` = 19,384（`budget.doc_tokens()`）に分ける。D は 1 要求に 1 回だけ足す。根拠は決定 7（Reader の要求ごとの上限）。t = max(T, 1) で
   - 書き込み = E + (t−1)(M + S) + D·[t > 1]
   - 読み出し = (t−1)E + (M + S)(t−1)(t−2)/2 + D·max(t−2, 0)
   - 出力 = t·M
   - 最悪の並びは turn 0 の結果で文書を全部読む形（実額は文書の置き方に線形なので、1 つの turn に全部入れる並びが端点）。T = 1・2 は旧式と同じ値（画像の読み取り `read_positions` の予約 `(E, M, 1, 0)` は変わらない）。T = 3 は D の書き込み 1 回ぶん（D × w）下がる
   - S は turn ごとに数えたまま（保守側）。スキルも式の上で 1 要求に 1 回だけ数える案は見送った（守りが上界の唯一の根拠になり、CLI の Skill の仕組みの変化に弱くなる）
2. **スキルの守り**（`ai/skills.py` の `SkillGuard`。`agent_sdk` の PreToolUse フックが要求ごとに 1 つ作る。状態は要求をまたがない）: Skill の呼び出しを順に判定する
   - 1 要求の呼び出し（許可・deny の合計。一覧に無い名前・入力の形の誤りも数える。ただし数えるのはフックまで届いたものだけで、CLI がフックより前にエラーで返すものは下の「残る例外」）が `AI_SKILL_MAX_CALLS` = 5 を超えたら **deny + `continue_: False`**（要求を終える = その結果は上流に送られない。決定 7 の `read_doc` と同じ）
   - 一覧に無い名前は deny（今どおり。turn は続く）
   - **args が空でない**（None・"" 以外）・`skill`・`args` の外のキーがある呼び出しは deny。CLI は args を SKILL.md の後ろに `ARGUMENTS: <args>` として足すので、モデルの出力が次の turn の入力にそのまま増え、S の上界の外になる（このスキルは引数を使わない）
   - **同じスキルの 2 回目** は deny（turn は続く）。素の名前（`technicals`）と `simulator:technicals` は同じスキルとして数える（CLI は素の名前でも読む）
   - deny の理由は固定の短い英文で、入力を含めない（`agent_sdk.SKILL_DENY_REASONS`）。ログ `ai_request.skills` はフックが許可したスキル（正規化した名前・重複なし。回数の上限で要求を打ち切ったときは、許可したが本文が上流に届かなかったものも含む）
3. **`AI_SKILL_MAX_CALLS` = 5 の根拠**（スキル 4 本 + 予備 1。同梱の CLI 2.1.283 の実測。JSON のバイト = トークン数の上界。`tests/test_ai_agent_sdk_cli.py::test_skill_guard_frames_within_overhead` で固定）: Skill の 1 回の枠は、許可 = tool_result + SKILL.md の block − SKILL.md のファイル ≤ 113 B、deny = tool_result ≤ 161 B（tool_use の id は実際の長さの上界 36 字・理由は最も長い deny の文で数える）。turn ごとの固定分（CLI が足す `<total_tokens>` の block と message の枠）≤ 118 B。5 × 161 + 118 = 923 ≤ `AI_SKILL_OVERHEAD_TOKENS`（1,000）。`AI_SKILL_MAX_CALLS` ≥ スキルの数（`tests/test_ai_agent_sdk.py`）なので、全部のスキルを 1 回ずつは読める。5 本目のスキルを足すと予備が 0 になる
4. **`AI_SKILL_MAX_BYTES` を 16 KiB → 24 KiB**。長い会話のテストは実際の合計ではなく上限ちょうどで計算する（上限の内側ならスキルを足してもテストが落ちない）
5. **閾値 `< $2.00` は据え置く**。根拠: 本文 90k の長い会話でも、日の始めの 1 要求の予約が日の上限 $3 の 2/3 未満（長い会話の 1 要求で 1 日の大半を押さえない）。オーナー判断（一任の方針で推奨どおり）
6. **目安**（`budget.reserve_micro_usd` の計算）: 本文 25k トークンで 約 $1.29（直前は $1.45）、90k で 約 $1.84（直前は $1.99。スキルの合計 15,283 B）。スキルが 24 KiB ちょうどなら 90k で 約 $1.99（1,989,280 µUSD）。日の上限 $3 で日の始めに拒否される本文は 約 228k トークンから（24 KiB ちょうどなら 約 210k から）。スキル 1 B あたりの増分は 16.2 µUSD（変わらない）

### 見送った案

- バイト数 → トークン数の比を実測で詰める: 「トークン数 ≤ バイト数」は証明できる上界で、実測の比は経験値（モデル・トークナイザで変わる）= 予約が実額を下回りうるので採らない
- 長い手順を `read_doc` 側へ移す: 文書の 16 KiB をマニュアルの読みと取り合い、手順を利用者向けの文書に出すことになるので主案にしない
- 閾値を上げる: 1 日上限は守られるが、長い会話の 1 要求で 1 日の大半を押さえることになるので据え置く

### 残る例外（この変更の前からある。#355）

- **CLI がフックより前にエラーで返すツール呼び出しの結果は、予約額の式の外**（実測）: 知らないツール名（`No such tool available: <名前>`）・一覧に無いスキル名（`Unknown skill: <名前>. …`）・Skill の入力の型の誤り（`InputValidationError…`）は、CLI が PreToolUse の前に `<tool_use_error>` で返すので、フックでは数えられない。`read_doc` の MCP の入力の検査のエラー（値をそのまま返す）も `AI_DOC_ERROR_MAX_BYTES` の上界の外（回数は `Reader.permit` で 6 回までに抑えている）
  - 1 回で 約 146〜252 B の枠が、モデルの出力の小さな tool_use ごとに次の turn の入力に入るので、「turn ごとに増える分 ≤ 前の出力 + S + D」が出力 M の範囲で破れうる
  - 予約の時点の「計上額 + 予約 ≤ 上限」は守られる。越えうるのは精算で、その要求 1 本ぶん（次の要求は 429）。キャッシュの追い出しと同じ型の例外（ADR-0004 の「見積もりの前提が外れたとき」）として扱う。モデルが何百もの無効な呼び出しを出すという作為的な並びが要る
  - 案 A（文書を 1 回）は文書にした前提の下では保証を弱めないが、これまで偶然この経路を吸っていた余裕（turn 2 の D の書き込み・読み出し = 約 155,000 µUSD）は無くなる
  - 塞ぎ方（中継で 1 message の tool_use の数を数えて子を止める・式に「前の出力 × 係数」を足す・例外として受け入れてログで見張る）はどれもオーナー判断なので、この Issue では直さない。#355 で扱う

### 確かめ方

- 手元（Anthropic を呼ばない）: `api/tests/test_ai_budget.py`（式の手計算・固定値・上界の性質・追い出しの例外・長い会話）、`test_ai_agent_sdk.py`（守りの単体）、`test_ai_agent_sdk_cli.py`（本物の同梱 CLI と偽の Messages API で、重複が本文を足さないこと・枠の実測 × 回数 ≤ 余裕・回数の上限で打ち切ること・turn ごとに増える分 ≤ S + D・read_doc の結果 ≤ D）
- デプロイ後: 数える資格情報（`api_key`・`wif`）なら `ai_request` の `reserved_usd` が新しい式の値と一致し、`skills` に重複が無く、ERROR が 0 件

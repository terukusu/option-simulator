# ADR-0006: AI の送り口を Claude Agent SDK に一本化し、手順をスキル（Agent Skills）で読み込む

- 状態: 採択（2026-10-21）
- 日付: 2026-10-21
- 関連: #221・EPIC #141・#186・#184・#135・#200、[ADR-0005](adr-0005-ai-oauth-via-agent-sdk.md)（一部改訂）、[ADR-0001](adr-0001-ai-credentials-secret-manager.md)（追補 #184・#186）、[ADR-0004](adr-0004-ai-spend-counter-firestore.md)、`docs/design.md` 13.4「AI の中継」・14 章、`docs/ai-advisor.md` 論点 7。画像の読み取り（#318）も同じ送り口で送る: [ADR-0009](adr-0009-ai-image-read-positions.md)
- 版: `claude-agent-sdk==0.2.160`、同梱の Claude Code CLI **2.1.283**（ADR-0005 と同じ。`uv.lock` で固定）

## 背景

- オーナーの要望（2026-10-21）: AI に頼むことが増えてきた（操作の説明・ポジションの分析・市況・テクニカル など）。全部を system prompt に入れると前置きが膨らむので、知識・手順を必要なときだけ読み込みたい
- 今の作り（#186 まで）: 送り口が 2 つあった。`oauth_token` は Claude Agent SDK（同梱の CLI）、`api_key`・`wif` は `anthropic` SDK 1.8.0 で Messages API を直接呼ぶ（`AnthropicGateway`）。手順の読み込みを作るなら、2 つの送り口の両方に同じ仕組みを作る必要があった
- CLI には Agent Skills（`SKILL.md` を要るときだけ読む `Skill` ツール）がある。SDK の `skills`・`plugins` で、イメージに同梱したスキルだけを見せられる

## 確かめたこと

### 手元の spike（2026-10-21。#221 のコメント）

| 項目 | 結果 |
|---|---|
| Agent Skills を今の構成（`setting_sources=[]`・フックで simulator のツールを止める）のまま使えるか | go。`plugins=[{"type": "local", "path": …}]` + `skills=["<plugin>:<skill>"]` + `tools=["Skill"]` で Skill が呼べ、本文が答えに反映された |
| Skill と simulator のツールが続けて使えるか | go。フックは `Skill` を通し、`mcp__sim__*` は今までどおり deny + `continue_: False` で止まる |
| ほかのスキルが見えないか | go。モデルに見える一覧は指定したスキルだけ |
| `api_key` が CLI 経由で動くか | go（子に `ANTHROPIC_API_KEY` だけを渡す） |
| 起動時間 | 最初の事象まで 2.0〜2.9 秒、スキルを読んで答えるまで 5.5〜6.7 秒（3 turn） |

### W1: `wif` が CLI 経由で動くか（2026-10-21、本番の一回きりの Cloud Run Job。サービス・traffic は無変更）

- 今のイメージ（同梱の CLI 2.1.283）を実行 SA で Job として 1 回動かした。メタデータサーバーから ID トークン（audience `https://api.anthropic.com`・`format=full`）を取り、CLI を `-p --max-turns 1` で。子の資格情報は WIF の ID + `ANTHROPIC_IDENTITY_TOKEN` だけ（`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN` は空）
- 結果: **go**（終了コード 0・`subtype=success`・応答あり・5.8 秒）。Job と値の一時ファイルは削除した（ID・トークンは表示・記録していない）

### W2: 中継の `wif` の e2e（2026-10-21、traffic 0 のタグ付きリビジョン。#228 のデプロイ後）

- タグの URL は未認証で 302（IAP が効く）。`/api/ai/status` は `"credential":"wif","counted":true`。テクニカルの質問 3 回: `ai_request` は 3 件とも `credential=wif`・`error` なし・`skills=["simulator:technicals"]`・`turns=2`・`charged_usd` 計 ≈ $0.19（Firestore に計上）・`spawn_ms` 2.5〜7.3 秒。ERROR 0
- 戻し方は下の「確かめ方」6 の順（タグを外すと traffic が固定に変わることに気づいて直した）

### 結合テスト（#221。本物の同梱 CLI と 127.0.0.1 の偽の Messages API。Anthropic は呼ばない）

- Skill の往復: 1 回目の応答が `Skill`（入力 `{"skill": "simulator:technicals"}`）なら、CLI はフックの許可の後に SKILL.md を読み、2 回目の要求の messages に `Skill` の tool_use と tool_result（`Launching skill: …`）と本文の text（`Base directory for this skill: <パス>` + frontmatter を除いた本文）を足す。読んでいないスキルの本文は送らない
- 一覧はモデルに CLI の role=system の message（「The following skills are available …」）で見える。`Skill` のツールの定義は CLI の文（数百トークン）
- `max_turns` を超えて Skill を呼び続けると `ResultMessage(subtype="error_max_turns", is_error=True)`
- `ResultMessage.usage` は全 turn の合計（生の事象から足した値と一致）
- `wif`: CLI は `ANTHROPIC_BASE_URL` の `POST /v1/oauth/token`（grant `jwt-bearer`、beta `oidc-federation-2026-04-01`）で交換し、交換したトークンの Bearer だけで送る。交換の失敗は `api_error_status` に入らず、`AssistantMessage(error="unknown")` の文（`Token exchange failed with status <3 桁>`）にだけ出る
- prompt caching: CLI は `oauth_token` のとき system・最後の message に `ttl: 1h` を付け、`api_key` のときは 5 分（TTL なし）を付けた

## 決定

1. **送り口を Claude Agent SDK に一本化する**。`AI_CREDENTIAL` の `oauth_token`・`api_key`・`wif` はすべて `api/src/simulator_api/ai/agent_sdk.py` の `AgentSdkGateway`（`fake` だけ `FakeGateway`）。`AnthropicGateway`・`client_kwargs`・`classify` と依存 `anthropic`（と推移の `docstring-parser`・`jiter`）を消す。`AI_CREDENTIAL`・Secret・環境変数名・Terraform の変数は変えない
2. 子の資格情報: CLI が資格情報・送信先の選択として読む変数（`agent_sdk.CREDENTIAL_ENV`。CLI 2.1.283 の文字列から 29 個）を **全部空で上書きし、選んだ種類のものだけを入れる**。`oauth_token` → `CLAUDE_CODE_OAUTH_TOKEN`、`api_key` → `ANTHROPIC_API_KEY`、`wif` → `ANTHROPIC_FEDERATION_RULE_ID`・`ANTHROPIC_ORGANIZATION_ID`（必須）・`ANTHROPIC_SERVICE_ACCOUNT_ID`・`ANTHROPIC_WORKSPACE_ID`（任意。無ければ空）と `ANTHROPIC_IDENTITY_TOKEN`。WIF の設定は CLI の中で他より優先されるので、`oauth_token`・`api_key` のときに WIF の変数が子に見えないことが要る
3. `wif` の ID トークンは中継が **要求ごとに** メタデータサーバーから取る（CLI は自分で取らない）。取れなければ子を起動せず `upstream_auth`（`error_type` `IdentityTokenError`）。交換したトークンのキャッシュ（`ANTHROPIC_CONFIG_DIR`・`CLAUDE_CODE_FEDERATION_CACHE_DIR`）は要求ごとの一時ディレクトリ = 1 要求 1 回の交換。交換の失敗は CLI の文から状態の 3 桁だけを取り（文はログ・応答に出さない）、401 / 403 → `upstream_auth`、他 → `upstream_unavailable`（`error_type` `token_exchange`）
4. **スキル**: パッケージの中のプラグイン `api/src/simulator_api/ai/plugin/`（`.claude-plugin/plugin.json` の `name` は `simulator`、`skills/<名前>/SKILL.md`）と一覧 `ai/skills.py`（`NAMES`）。options は `tools=["Skill"]`（組み込みのツールは Skill だけ。Read・Bash などは無い）・`skills=<一覧>`・`plugins=[<パッケージ内の絶対パス>]`・`setting_sources=[]`。wheel に入る（`uv_build` は隠しディレクトリも入れる）ので、イメージの入力（`Dockerfile`・`.dockerignore`・`image.sh`）は変えない。イメージの中では読むだけ（uid 10001）
5. SKILL.md の約束（`tests/test_ai_skills.py`）: frontmatter は `name`・`description` だけ（`allowed-tools`・`context`・`model` などでツールや別の文脈を与えない）、本文に `!` のコマンドの埋め込みを書かない、1 ディレクトリに SKILL.md 1 枚、合計は `AI_SKILL_MAX_BYTES`（16 KiB）以下、秘密を置かない（スキルは文脈の絞り込みでサンドボックスではない）
6. 最初のスキルは 2 本: `simulator:technicals`（system prompt の「テクニカル」の節）と `simulator:proposals`（「ポジションの提案」の節）。文は変えずに移した。system には「答える前に Skill で読む・前の発言で読んでいても要るなら読み直す」の節を置く。診断・追加の質問・数字の規則・データ・役割は system に残す（診断は最も多い流れで、スキルにすると毎回 1 turn 遅くなる）。system prompt は 3,243 字 → 1,983 字
7. フック（`PreToolUse`）: `Skill` で入力のスキル名が一覧にあれば通す（`{}`）。一覧に無い名前は deny（turn は続く）。それ以外（`mcp__sim__*`）は今どおり deny + `continue_: False`（ブラウザが実行する）。SDK の `skills` の絞り込みとの二重の守り
8. 複数 turn: `max_turns = AI_MAX_TURNS = 3`（Skill 2 回 + 答え）。超えたら `error_max_turns` → SSE は `error: upstream_unavailable`（code の列挙・画面は変えない）。事象は message ごとに組み立て直し、`Skill` の tool_use は SSE に出さず `done` の content にも入れない。`done` の content と `stop_reason` は **最後の message** のもの（Skill の turn で流れた thinking / text は SSE に流れるが、画面は `done` の content で置き換える）
9. Skill の往復は履歴に残さない: 中継は状態を持たず、ブラウザの履歴・許可リスト・SSE の形を変えない。次の要求で要れば読み直す（system に 1 行）。合成して戻す案は CLI の transcript の内部の形への依存が増えるので採らない
10. ログ: `ai_request` に `skills`（読んだスキルの名前。本文は出さない）・`turns`（上流の message の数）。usage は全 turn の合計（生の事象から足す。`cache_creation` の 5 分 / 1 時間の内訳も持つので 1 時間の書き込みを 1 時間の単価で精算する）
11. 費用の 1 日上限の予約額（ADR-0004 の式を改める）: E = 入力の見積もり（本文のバイト数 + 2,000 + CLI が足す本文 `AI_CLI_OVERHEAD_TOKENS` 4,000。CLI 2.1.283 の実測は system の先頭 2 block 約 135 B・Skill の定義 約 1.8 KB・環境の message 約 1.0 KB で計 2,843〜2,884 B）、M = `max_tokens`、K = SKILL.md の合計のバイト数 + `AI_SKILL_OVERHEAD_TOKENS`、g = M + K、T = `AI_MAX_TURNS` として turn 0 は E × w + M × o、turn i（1 ≤ i < T）は (E + (i−1)·g) × r（前の turn の要求全体 = キャッシュの読み出し）+ g × w + M × o（g = M + K、w = 書き込みの単価（5 分と 1 時間の大きい方）、r = 読み出しの単価、o = 出力の単価）。turn i の入力は前の turn の要求 + 前の出力（≤ M）+ Skill の結果（≤ K）を超えない。前提: CLI は各要求の最後の message に cache_control を付け、次の turn の要求は前の turn の要求をそのまま前置きに持つ（system・tools も同じ）ので、前の要求はキャッシュの読み出しになる（`tests/test_ai_agent_sdk_cli.py` の `test_cli_overhead_and_cache_prefix_for_reserve` で固定）。キャッシュから読めなかったとき（追い出し）だけ、精算で予約を越えうる（越える分 ≤ 前の要求 × (w − r)。次の要求は 429。ADR-0004 の「見積もりの前提が外れたとき」と同じ扱い）。書き込みの単価は 5 分と 1 時間の大きい方（CLI は資格情報によって 1 時間の TTL を付ける。`wif` の TTL は手元で確かめられない）。目安: 本文 25k トークンで 1 要求の予約 約 $0.30（#221 の前）→ 約 $0.95、90k で 約 $0.62 → 約 $1.49。日の上限 $3 で日の始めに拒否される本文は 約 269k トークンから（全 turn を書き込みと数える式では 約 90k から = 長い会話が使えなくなるので採らない）。精算（実額）は今どおり usage × 料金表で、日の上限（既定 $3）は変えない

## 検討した選択肢

| 案 | 良い点 | 悪い点 |
|---|---|---|
| A. Agent SDK に一本化して Agent Skills を使う（採択） | 仕組みが 1 つ。CLI のスキルの読み込み（遅延・一覧の絞り込み）をそのまま使える。依存とイメージが少し小さくなる | Messages API を直接呼ぶ逃げ道が無くなる。CLI の内部（Skill の入力の形式・transcript）への依存が増える |
| N2. `oauth_token`・`api_key` は Agent SDK、`wif` だけ Messages API でスキルの本文を system に全部入れる | `wif` が CLI で動かなくても済む | `wif` だけ前置きが長い。送信経路が 2 つのまま。W1 が go なので採らない |
| N1. 2 本立てのまま、自前の `load_skill` ツールを両方の送信経路に作る | CLI のスキルの仕組みに依存しない | 仕組みが 2 つ要る。中継にサーバー側のツールの往復と turn ごとの精算が増える |
| ツールの定義も読み込んだ分だけ足す（遅延読み込み） | 前置きがさらに減る | 要求ごとに tools の組が変わると prompt caching の前置きが切れる。スコープ外（後続） |

## 結果

- 良い点: 手順を足しても system prompt が伸びない（後続の #137・#138・#158・#140・#156 は SKILL.md を足して `skills.NAMES` に名前を足す）。送信経路が 1 つになり、資格情報の切り替えは `AI_CREDENTIAL` だけ。依存が 3 つ減り、イメージは 452 MB → 443 MB
- 悪い点:
  - **Messages API の逃げ道が無くなる**。CLI の不具合・上げた版の破綻のとき、資格情報の切り替えでは逃げられない（戻し方は PR の revert）
  - スキルを読む質問は上流を 1 回多く呼ぶ（+2〜4 秒。締め切り 50 秒の内）。スキルの本文は読むたびに書き込みの単価（数百〜千トークン）
  - 予約額が大きくなり（約 3 倍）、数える資格情報（`api_key`・`wif`）では日の上限の近くで早めに `budget_exceeded` になる（精算で戻る）。キャッシュの追い出しがあると精算で 1 要求ぶん上限を越えうる
  - モデルが要るときに Skill を呼ばないと答えの質が落ちる → `npm run ai:eval -- --tech-only` / `--propose-only` で切り出しの前と比べる
  - Skill の往復を履歴から落とした後の thinking の署名・tool_use の続きを API が受けるかは、偽の API では確かめられない（本物の評価・デプロイ後に確かめる）
  - CLI が Skill の結果に `Base directory for this skill: <パス>` を足す（イメージではパッケージの中のパス。個人の値は入らない）
- 戻し方: 旧リビジョンへ `gcloud run services update-traffic simulator --to-revisions <PREV>=100`、コードは PR の revert → CI の deploy（`anthropic` の依存も戻る）。`AI_CREDENTIAL` の切り替えでは戻らない

## 確かめ方（デプロイ後。W2）

`wif` の e2e は、本番の traffic を動かさずに **traffic 0 のタグ付きリビジョン** で確かめる（本番の変更なので所有者の承認の上で。`$P`・`$REGION`・`<TAG>`・`<PREV>`・`<WIF_REV>` はプレースホルダ。値・URL は表示・記録しない）:

1. 控える: `gcloud run services describe simulator --region "$REGION" --project "$P"` の image（digest）・`status.latestReadyRevisionName`（= `<PREV>`）・traffic（`<PREV>` 100%）
2. 0600 の一時ファイルに `AI_CREDENTIAL=wif` と WIF の ID（GitHub の repository variables から値を表示せずに）を書き、`gcloud run deploy simulator --image <控えた image> --no-traffic --tag <TAG> --env-vars-file <一時ファイル> --remove-secrets ANTHROPIC_AUTH_TOKEN --region "$REGION" --project "$P"` → 一時ファイルを消す（`wif` で `ANTHROPIC_AUTH_TOKEN` が残ると `ai_credential_conflict` で AI が無効になる）
3. 未認証の `curl -s -o /dev/null -w '%{http_code}'` でタグの URL の `/api/ai/status` が 302 / 401 / 403（IAP がタグの URL にも効く）
4. ブラウザ（IAP のログイン）でタグの URL を開き、`/api/ai/status` が `"credential":"wif","counted":true`、スキルを使う質問（テクニカル）を 1 回
5. `gcloud logging read 'jsonPayload.event="ai_request" AND resource.labels.revision_name="<WIF_REV>"' --freshness=30m --project "$P"` で `credential=wif`・`error` が null・usage と `cost_usd_est`・`skills` に名前。`ai_sdk_warning` が 0。`upstream_auth` + `error_type` `token_exchange` はルールの不一致、`IdentityTokenError` は ID トークンが取れていない。`/api/ai/status` の `remaining_usd` が減る（Firestore の計上）
6. 戻す（2026-10-21 の W2 で確かめた順。`infra/prod` は traffic を管理しないので、gcloud で触った traffic は deploy では戻らない）: (a) `gcloud run services update-traffic simulator --remove-tags <TAG> --region "$REGION" --project "$P"`（**これで traffic は「最新に 100%」から「`<PREV>` に固定」に変わる**）→ (b) deploy workflow を `workflow_dispatch` で流し（Environment `prod` の承認）、terraform apply でテンプレートを戻す（oauth の新しいリビジョン `<NEW>` ができる。traffic は (a) の固定のまま `<PREV>`）→ (c) `gcloud run revisions delete <WIF_REV>`（latest でなくなってから消せる。latest のうちは FAILED_PRECONDITION）→ (d) `<NEW>` の env が `AI_CREDENTIAL` と Secret の `ANTHROPIC_AUTH_TOKEN` で、image が `<PREV>` と同じ digest であることを describe で確かめてから `gcloud run services update-traffic simulator --to-latest`（**`<WIF_REV>` を消す前に `--to-latest` を使わない**）→ (e) describe で `spec.traffic` が `latestRevision: true`・100%（次の deploy で traffic が新しいリビジョンに移る形）、ERROR 0 を確かめる

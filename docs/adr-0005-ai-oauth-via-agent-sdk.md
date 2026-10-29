# ADR-0005: `AI_CREDENTIAL=oauth_token` は Claude Agent SDK（同梱の CLI）を送信路にする

- 状態: 採択（2026-10-19）。**一部改訂: [ADR-0006](adr-0006-ai-agent-sdk-only-and-skills.md)（#221、2026-10-21）** = `api_key`・`wif` も同じ送信路に一本化（`anthropic` SDK と `AnthropicGateway` を消した）、`tools=["Skill"]`・`skills`・`plugins` でスキルを読む、`max_turns=1` → `AI_MAX_TURNS`（3）、子の資格情報は CLI が読む変数を全部空で上書きして選んだ種類だけ。下の本文は #186 の時点の記録
- 日付: 2026-10-19
- 関連: #186・#133・#134・#135・#184・EPIC #141、[ADR-0001](adr-0001-ai-credentials-secret-manager.md)（追補 #186）、`docs/design.md` 13.1 K15・13.4「AI の中継」・14 章・付録 B、`docs/ai-advisor.md` 論点 2・7
- 版: `claude-agent-sdk==0.2.160`（`uv.lock` で固定。`exclude-newer = 2026-09-28` の範囲の最新）、同梱の Claude Code CLI **2.1.283**（`claude_agent_sdk/_cli_version.py`）

## 背景

- 観測（2026-10-19）: `claude setup-token` で作ったサブスクリプションの OAuth トークンを、`anthropic` SDK（1.8.0、`auth_token=`・`anthropic-beta: oauth-2025-04-20`）や curl で Messages API に直接渡すと HTTP 429 `rate_limit_error` になる（モデルによらない）。同じトークンを Claude Code CLI に `CLAUDE_CODE_OAUTH_TOKEN` として渡すと応答が返る。そのため本番は暫定で `AI_CREDENTIAL=wif`（従量課金）で動かしていた
- オーナーの決定（2026-10-19）: OAuth トークンを使えるようにし、`wif` と切り替えられるようにする。既定は `oauth_token`（範囲は下の「決定」）
- 制約: ツールの計算はブラウザ（`ui/view/aiTools.ts`）のまま。会話の UX（SSE の事象・ツールの往復・thinking の要約・中止・締め切り）と、中継の残り（許可リスト・system prompt・ツールの登録・締め切り 50 秒・同時 2 本・1 分 10 回・費用の計上・ログ）は変えない。会話の状態はブラウザが持つ（#135。中継は状態を持たない）

## 確かめたこと（spike。Anthropic は呼んでいない）

CLI の送信先を `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` の偽の Messages API（届いた要求を記録し、決まった SSE を返す）にし、トークンはダミー、`CLAUDE_CONFIG_DIR` は毎回の一時ディレクトリにした。版は上の「版」のとおり。

| 項目 | 確かめ方 | 結果 | 判定 |
|---|---|---|---|
| S1 | ツール 2 本を出す脚本で、in-process の SDK MCP ツール（6 本）+ `PreToolUse` フック（matcher なし）。候補（`defer`・`continue_: False` だけ・`deny` だけ・`can_use_tool` の `interrupt`）と比べた | フックが `deny` + `continue_: False` を返すと、上流への POST 1 回・ツールの関数の呼び出し 0・`ResultMessage(subtype=success, stop_reason="tool_use")`。tool_use の id・name（`mcp__sim__<名>`）・input は `StreamEvent` で全部見える。`defer` は 2 本の turn で最後の 1 本しか返らない、`continue_: False` / `deny` だけは CLI が拒否の tool_result を足して上流を呼び直す、`interrupt` は `error_during_execution` で終わる | go（deny + `continue_: False`） |
| S2 | `include_partial_messages=True` の `StreamEvent` の粒度と遅れ | thinking_delta・text_delta・input_json_delta・signature_delta が偽サーバーの送出と同じ粒度で 1 つずつ届く。偽サーバーの最初の delta から SDK で受けるまで約 2 ms。`AssistantMessage` は redacted_thinking を落とす（SDK の型に無い）ので、final の content は `StreamEvent` から組み立てる | go |
| S3 | 署名つき thinking・redacted_thinking・tool_use・tool_result・`context_update` を含む履歴を、要求ごとのメモリ上の `SessionStore`（`load` が履歴から作った transcript の項目を返す）+ `resume=<新しい uuid>` で渡し、偽サーバーに届いた `messages` を `relay.build_params` の `messages` と比べた | 最後の user が text のとき: CLI が足す role=system の message と `cache_control` を除いて **完全一致**（thinking の `thinking`・`signature`、redacted_thinking の `data`、block の順序まで）。最後の user が tool_result のとき（`CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`・prompt なし）: 一致、**ただし最後の user の末尾に text block が 1 つ足される**（`CLAUDE_CODE_RESUME_PROMPT` の文。空にはできない）。system は `[課金の見出し, "You are a Claude agent, built on Anthropic's Claude Agent SDK.", 我々の SYSTEM_PROMPT（バイト一致）]` の 3 block。ツールは我々の 6 本だけ（名前は `mcp__sim__<名>`、説明と JSON Schema は CLI が NFKC 正規化する） | partial → オーナー了承で go（下の「オーナーの確認」） |
| S4 | `docker run --cpus 1 --memory 512m --network none`、python:3.13-slim・uid 10001・ホームなしで 10 回。query の開始 → 偽サーバーに POST が届くまで | **最大 1.161 s**（最小 0.843・中央 0.887）。最初の thinking delta まで最大 1.332 s。ツール 2 本の turn の全体 2.76〜3.13 s（偽の遅延 0.05 s × 12 を含む）。締め切り 50 秒に対し十分 | go |
| S5 | 偽の CLI（環境を記録して本物の CLI を起動する包み）と strace（connect・execve） | 親に `ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_API_KEY` があると CLI は両方を送り OAuth の beta も付かない（= 429 の経路）。SDK の `env` は親に **重ねる** だけで消せないので、空で上書きする → `Authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>` だけ・x-api-key なし・`anthropic-beta` に `oauth-2025-04-20`。接続は 127.0.0.1（偽サーバー）だけ。`setting_sources=[]` で設定・CLAUDE.md を読まない | go（空の上書き） |
| S6 | S4 と同じ条件で cgroup の `memory.peak` | 1 本 190 MB、**同時 2 本（1 プロセスの 2 スレッド）291 MB**（親の Python + SDK・偽サーバーを含む）。CLI の ru_maxrss は 1 本 243〜247 MB だが大半は同梱バイナリのファイル写像で共有される。見積もり 約 380 MB / 512 MiB | go（512Mi のまま） |

ほかの観測:

- 上流に届く値: `model` は指定どおり、`thinking = {"type": "adaptive", "display": "summarized"}`、`output_config.effort = medium`、`max_tokens` は既定 128000 → `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000` で 8000。CLI が足すもの: `context_management.edits`（`clear_thinking_20251015`, keep all）、`metadata.user_id`、system と最後の message の `cache_control`（CLI が自分で prompt caching を掛ける。中継の `cache_control` は渡せない）
- CLI が messages に足す role=system の message（`mid-conversation-system` beta）: 環境（cwd・git か・OS の版）・モデル名・`<total_tokens>`・日付。`verbatim_prompts=True` でも消えない
- 安全: `verbatim_prompts=False` だと user の文の `@<パス>` を CLI がファイルとして読み、中身を上流に送った（`tools=[]` でも）。`verbatim_prompts=True` で 0 件
- 失敗: 既定では CLI が 429 を 100 秒以上再試行する。`CLAUDE_CODE_MAX_RETRIES=0` で上流 1 回。429 → `AssistantMessage.error="rate_limit"`・`ResultMessage(is_error=True, api_error_status=429)`、401 → `authentication_failed`・401。CLI はエラーの文を AssistantMessage の text に入れる（SSE には流さない）
- 後始末: 公開の `query()` は、呼び出し側が途中で抜けても内側の generator を閉じないので、子（CLI）の後始末が走らない。取り消しは anyio の cancel scope で行う（SDK の close は anyio の shield の中で stdin を閉じ → 5 秒待って SIGTERM → SIGKILL。asyncio の `task.cancel()` だけでは段階が飛ばされる）

## 決定

- `AI_CREDENTIAL=oauth_token` の送信先を `api/src/simulator_api/ai/agent_sdk.py` の `AgentSdkGateway` にする。値の名前 `oauth_token`・Secret `simulator-anthropic-oauth-token`・環境変数名 `ANTHROPIC_AUTH_TOKEN`・Terraform の `ai_credential` はそのまま（GitHub の variable・Secret の作り直しは要らない）。`api_key`・`wif`・`fake` は変えない（`anthropic` SDK の直接呼び出しのまま）
- CLI は wheel 同梱のものを使う（別に入れない）。版とハッシュは `uv.lock`（`--locked`）で固定する
- 送信先は `AnthropicGateway` と同じ事象（`thinking`・`text`・`tool_use`・`final`）を返し、最初に `{"type": "meta", "spawn_ms"}` を 1 回返す（中継は `ai_request` に `spawn_ms` を載せるだけ。SSE には出さない）。SSE の形（`data/aiStream.ts` が受けるもの）は変えない
- 固定する値:
  - options: `tools=[]`（組み込みのツール 0 本）・`setting_sources=[]`・`strict_mcp_config=True`・`mcp_servers={"sim": <ツール 6 本。関数は呼ばれない前提で、呼ばれたら計算せずに is_error>}`・`system_prompt=SYSTEM_PROMPT`（文字列。Claude Code の preset を使わない）・`model`・`thinking`・`effort`・`include_partial_messages=True`・**`verbatim_prompts=True`**・`max_turns=1`・`hooks={"PreToolUse": [deny + continue_ False]}`・`stderr` は捨てる・`cwd` は要求ごとの一時ディレクトリ
  - 子の環境（親に重なる）: `CLAUDE_CODE_OAUTH_TOKEN=<秘密>`、**`ANTHROPIC_AUTH_TOKEN=""`・`ANTHROPIC_API_KEY=""`**、**`CLAUDE_CONFIG_DIR=<要求ごとの一時ディレクトリ>`**（履歴のある turn = resume では SDK が `claude-resume-*` の一時ディレクトリに差し替え、終わったら SDK が消す）、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（と `DISABLE_AUTOUPDATER`・`DISABLE_TELEMETRY`・`DISABLE_ERROR_REPORTING`）、**`CLAUDE_CODE_MAX_RETRIES=0`**、**`CLAUDE_CODE_MAX_OUTPUT_TOKENS=<AI_MAX_TOKENS = 8000>`**、`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`（tool_result の turn だけ `1`）・`CLAUDE_CODE_RESUME_PROMPT="Continue from the tool results."`
  - イメージ: `CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK=1`（要求ごとの `claude -v` の子を省く。版は `uv.lock` で固定済み）
- 履歴（S3）: 最後の user が text なら、それより前を transcript の項目にし、最後の user は stream-json の prompt で渡す。最後の user が tool_result なら、全部を transcript に入れ、prompt は空にして CLI に turn を続けさせる。transcript の項目は 1 message = 1 項目（`parentUuid` で鎖）、tool_use の name は `mcp__sim__<名>` に付け直し、出力の tool_use は登録の名前に戻す
- スレッドの作り: gunicorn の gthread のスレッドから同期の generator として呼ぶ。要求ごとに専用のスレッドで event loop を立て（`asyncio.run`）、事象を queue で渡す。中継の `cancel`（締め切り・中止・切断。final の直後にも必ず来る）を 0.05 秒ごとに見て、anyio の cancel scope で query を取り消す。final か失敗を受けた後も途中で抜けず、CLI が終わるか cancel が来るまで読み捨てる（抜けると子の後始末が走らない）
- 失敗の分類: `ResultMessage.api_error_status`・`AssistantMessage.error`・例外の型 → 今の `UpstreamError` の列挙（401 / 403 / `authentication_failed` → `upstream_auth`、429 / `rate_limit` → `upstream_rate_limited`、529 → `upstream_overloaded`、他の 4xx → `upstream_bad_request`、他・`CLINotFoundError`・`ProcessError` → `upstream_unavailable`）。CLI の標準エラー・例外の本文は持ち出さない（型名と状態だけ）。logger `claude_agent_sdk` も `anthropic` と同じく本文なしの `ai_sdk_warning` に置き換える
- 費用: `oauth_token` は今どおり数えない（予約・Firestore なし。`ai_request` に usage と概算 USD を出す）
- Cloud Run のメモリは 512Mi のまま（S6）。`infra/` は変えない
- 本番の既定: GitHub の repository variable `AI_CREDENTIAL=oauth_token`、文書（`infra/README.md`・`api/README.md`）で `oauth_token` を最初の選択肢にする。Terraform の `ai_credential` の既定は `none` のまま（既定を変えると、Secret に版を登録していない clone 利用者の deploy でインスタンスが起動しなくなる = ADR-0001）

## オーナーの確認（2026-10-19）

S3 の差分（partial）を受け入れて go とした。受け入れた点:

1. 最後の user が tool_result の turn で、CLI がその user の末尾に固定の文（`CLAUDE_CODE_RESUME_PROMPT`）の text block を 1 つ足す。ブラウザの履歴にはこの文が残らないので、次の要求ではその文の無い履歴を送る（モデルから見た過去の文脈がわずかに変わり、prompt caching の前置きがそこで切れる）。thinking の署名は assistant の block に掛かるので影響しない見込み（本物の API でしか確かめられない）
2. CLI が system の先頭に 2 block と、messages に role=system の環境の message を足す
3. この仕組みは文書化されていない CLI の環境変数（`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`・`CLAUDE_CODE_RESUME_PROMPT`）と transcript の内部の形に依存する。版の固定と結合テスト（`api/tests/test_ai_agent_sdk_cli.py`）で守る

同時に決まったこと: 「既定は oauth_token」は本番の variable と文書の意味（Terraform の既定は `none` のまま）。メモリは 512Mi のまま。戻し方は variable を `wif` に戻して deploy。

## 規約

Anthropic の文書には次の記述がある（確認日 2026-10-19。原文の抜粋）:

- Claude Agent SDK の overview（https://code.claude.com/docs/en/agent-sdk/overview）: 「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…」
- Claude Code の Legal and compliance（https://code.claude.com/docs/en/legal-and-compliance）: 「Developers building products or services … including those using the Agent SDK, should use API key authentication … Anthropic does not permit … to route requests through Free, Pro, or Max plan credentials on behalf of their users.」

サブスクリプションの OAuth トークンをこの送信経路で使うかは、利用者（デプロイする人）が自分の責任で判断する。このリポジトリのオーナーは自分専用の利用として使うと決めた（2026-10-19）。clone して使う人は自分で規約を確かめ、迷うなら `api_key` か `wif` を使う。

## 検討した選択肢

| 案 | 良い点 | 悪い点 |
|---|---|---|
| A. Agent SDK（同梱の CLI）を送信経路にする（採択） | サブスクリプションのトークンで動く。会話の UX・中継の残りを変えない | 依存とイメージが大きくなる（+14 個、イメージ 約 202 → 452 MB）。CLI の内部の形式・未文書の環境変数に依存する。CLI が system・messages に本文を足す。要求ごとに子プロセス（約 1 秒・約 100〜250 MB） |
| B. `anthropic` SDK の直接呼び出しのまま | 依存が増えない | サブスクリプションのトークンでは 429（観測）で動かない |
| C. 事前計算だけをプロンプトに入れ、ツールの往復をしない | CLI のツールの扱いに依存しない | #135 の追加の質問（tool_use の往復）が変わる。S1 が go なので採らない |
| D. 会話の履歴を Firestore に置いて CLI の session で続ける | transcript を毎回作らない | #135 の「会話の状態はブラウザが持つ」を変える。オーナー決定 3 で採らない |
| E. 履歴を文章に平らにして thinking を送り返さない | transcript の形式に依存しない | #135 AC4（thinking のバイト一致）を変える。オーナー決定 3 で採らない |

## 結果

- 良い点: `AI_CREDENTIAL` の値だけで `oauth_token`（数えない）と `wif` / `api_key`（数える）を切り替えられる（イメージは両方の送信経路を持つ）。会話の UX・SSE の形式・中継の残りは変わらない
- 悪い点:
  - イメージが約 2.2 倍（202 MB → 452,204,381 バイト）。冷えた起動・Artifact Registry の容量が増える
  - 要求ごとに CLI の子プロセスを起動する（偽サーバーで約 0.7〜1 秒、最初の要求は import を含めて約 2.8 秒）。`ai_request` の `spawn_ms` で本番の値を見る
  - SDK を上げるたびに transcript の形式・`CLAUDE_CODE_RESUME_*`・ツールの名前・system の block の数が変わりうる。上げる PR では `tests/test_ai_agent_sdk_cli.py` を必ず通し、この ADR の版を直す
  - 本物のサブスクリプションのトークンで、CLI 経由の任意の system prompt・ツール 6 本が受け付けられるかは手元で確かめられない（デプロイ後に診断・追加の質問で確かめ、認証の失敗・429 なら `wif` に戻す）
  - 同梱の CLI は Anthropic の規約の下で配布される（`claude-agent-sdk` 自体は MIT）
- 戻し方: GitHub の repository variable `AI_CREDENTIAL` を `wif`（または `api_key`）に戻して deploy する（`infra/README.md`）。コードを戻すときは PR の revert（依存の削除でイメージも戻る）

## 依存（`uv.lock` に足したもの）

`claude-agent-sdk` 0.2.160（MIT。manylinux x86_64 の wheel 103,518,762 バイト、sha256 `70d1dd4286b69ecdc334d66e7b9dae8532790803f7cd7e0bf269bd5e407f2259`。同梱の CLI 241,556,664 バイト）と推移の依存 mcp 2.2.0・mcp-types 2.2.0（MIT）・starlette 1.7.0・sse-starlette 3.4.11・uvicorn 0.54.0（BSD-3-Clause）・python-multipart 0.0.32（Apache-2.0）・pyjwt 2.15.0・jsonschema 4.26.0・jsonschema-specifications 2025.9.1・referencing 0.37.0・rpds-py 2026.6.3・attrs 26.1.0（MIT）・pywin32 312（Windows だけ。イメージには入らない）。`exclude-newer` は据え置き。

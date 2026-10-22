// AI の評価（`npm run ai:eval`。#135 AC1・AC2、EPIC #141 終了条件 1・2）。合成の板（fixtures/synthetic/latest.json）と
// 合成のポジション 10 通り（scripts/aiEvalCases.ts）で、画面と同じコード（ui/view/aiContext.ts の文脈と事前計算・
// ui/view/aiChat.ts の会話の reducer とツールの往復・ui/view/aiTools.ts のツール・data/aiStream.ts の SSE）を通して
// 中継（POST /api/ai/messages）に送り、[このポジションを診断] の返答の弱点の数と数字の照合（ui/view/aiNumbers.ts）を出す。
// TypeScript のモジュールは Vite のモジュールランナーで読む（依存を増やさない）。
//
// 送り先は AI_EVAL_BASE（既定 http://127.0.0.1:8080）= 手元で起動した中継。本番の IAP は越えない。資格情報は中継の
// 環境変数（このスクリプトは読まない・出さない）。手順は api/README.md「AI の評価」。
//
//   npm run ai:eval                          10 通りの診断 + 追加の質問 2 件 + テクニカルの質問 4 件（#200）+ 提案の質問 3 件（#139）
//                                            + 文書の質問 14 件（#137・#240）+ [AI に聞く] 5 件（#136）+ IV の統計の質問 3 件（#138・#158）
//                                            + 定型の質問 7 件（#140）+ 自分の前提つきの質問 2 件（#156）+ 行使価格の理論価格 2 件（#266）
//   npm run ai:eval -- --tech-only           テクニカルの質問 4 件だけ（#206 で EMA の質問を足した）
//   npm run ai:eval -- --iv-only             IV の統計の質問 3 件だけ（#138・#158。iv_stats）
//   npm run ai:eval -- --propose-only        ポジションの提案の質問 3 件だけ（#139）
//   npm run ai:eval -- --docs-only           文書（マニュアル・設計書）の質問 14 件だけ（#137・#240。計算の前提 10）
//   npm run ai:eval -- --ask-only            数字・パネルから [AI に聞く] の 5 件だけ（#136。画面と同じ表示モデルから質問を作る）
//   npm run ai:eval -- --profile-only        自分の前提（設定の欄）つきの質問 2 件だけ（#156）
//   npm run ai:eval -- --quote-only          行使価格の理論価格（strike_quote）の質問 2 件だけ（#266。文脈のスマイルの外の遠い OTM）
//   npm run ai:eval -- --preset-only         定型の質問のチップ 7 件だけ（#140。6 つ + 足 0 本の板の前提。画面と同じ文 = ui/view/aiPresets.ts を kind preset で）
//   npm run ai:eval -- --saved               画面の [評価に残す] で保存した会話（fixtures/local/ai_eval/cases/*.json。#159）だけ。
//                                            ファイルの材料で同じ文脈を作り直し、発言の列を順に送り直す。不一致 0・エラー 0 で合格
//   npm run ai:eval -- --cases put_sell,calendar --repeat 2 --no-followups
//
// 費用の上限: 累計の台帳 fixtures/local/ai_eval/ledger.json（gitignore）で AI_EVAL_LIMIT_USD（既定 6.5）を超える前に
// 止める。費用は中継の今日の残り（remaining_usd）の前の値との差（数える資格情報。要求は直列）か、数えない資格情報
// （OAuth）は 0。
// AI_EVAL_RELAY_LOG に中継のログ（標準出力の JSON 行）を指定すると ai_request の cost_usd_est・トークン量・dropped_blocks・
// 読んだスキル（skills）・turn の数
// も集める（ログに会話の本文・鍵は出ない = relay.py）。
// 返答の全文は fixtures/local/ai_eval/<時刻>/ にだけ書く（コミットしない）。標準出力は要約（架空の値）と、同じモードの
// 前回の実行（fixtures/local/ai_eval/<時刻>/summary.json）との差（正答・数値の一致 / 不一致の件数・問ごとの pass ↔ FAIL。
// #240。選び方は scripts/aiEvalDiff.ts）。

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i < 0 ? def : (args[i + 1] ?? def);
};
const base = (process.env.AI_EVAL_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const limitUsd = Number(process.env.AI_EVAL_LIMIT_USD || '6.5');
// 1 要求の予約額の上界（中継の予約の式 budget.reserve_micro_usd。#221 で turn の上限 3・スキル・CLI が足す本文を
// 入れた。#137 で文書の read_doc の 1 要求の上限と目次を足した。#140 のスキル presets の後は本文 25k トークンで約 $1.36、
// 90k で約 $1.90）
const reserveUsd = 2.0;
const repeat = Number(opt('--repeat', '1'));
const followups = !args.includes('--no-followups');
const relayLog = process.env.AI_EVAL_RELAY_LOG || null;
// fixtures/local/ 直下の *.json は板の dump として検査される（tests/data/local.test.ts）ので ai_eval/ の下に置く
const ledgerPath = join(root, 'fixtures', 'local', 'ai_eval', 'ledger.json');
// 問の組（id つき。前回の実行との差の鍵）は scripts/aiEvalQuestions.ts・scripts/aiEvalDocs.ts（#240）。以下の説明は判定の規則
const FOLLOWUPS = [
  { case: 'put_sell', text: '日経が 3 日で −6%、IV が 5pt 上がったら損益はどうなりますか？' },
  { case: 'iron_condor', text: '10 日後に原資産が +4% のときの損益と Δ を教えてください。' },
];

// テクニカルの質問（#200）: 合成の先物の足（scripts/synthFutBars.ts。架空の値）で technicals を呼ぶか・照合の不一致 0・
// 方向の見立てを書くなら「トレンドでは続くことがある」の但し書きを添えているか（言い回しの簡単な検査 + 全文を目で読む）
/** 方向の断定（予想の言い回し）。「〜でしょう」「〜見込み」「〜はず」などを上げ / 下げの動詞と組で見る */
export const DIRECTION_RE =
  /(上が|下が|上昇|下落|反発|反落|戻|崩れ|続伸|続落)[^。\n]{0,8}(でしょう|だろう|見込[みま]|はずです|はずだ|と予想|と予測|可能性が高い)/;
/** 見立ての但し書き（強いトレンドでは過熱のまま続くことがある） */
export const CAVEAT_RE =
  /(続けることが|続くことが|続きうる|続く場合|上がり続け|下がり続け|上げ続け|下げ続け|過熱のまま|過熱したまま)/;
// IV の統計の質問（#138・#158）: 合成の日次の値（dev の /fixtures/atm_daily と同じ。架空の値）で iv_stats を呼ぶか・
// 照合の不一致 0・IV の上げ下げを断定しないか（DIRECTION_RE）・聞いたことに触れるか（mentions）
const techOnly = args.includes('--tech-only');
const ivOnly = args.includes('--iv-only');
const proposeOnly = args.includes('--propose-only');
const docsOnly = args.includes('--docs-only');
const askOnly = args.includes('--ask-only');
const presetOnly = args.includes('--preset-only');
const profileOnly = args.includes('--profile-only');
const quoteOnly = args.includes('--quote-only');
const savedOnly = args.includes('--saved');
const anyOnly =
  techOnly ||
  proposeOnly ||
  docsOnly ||
  askOnly ||
  ivOnly ||
  presetOnly ||
  profileOnly ||
  quoteOnly ||
  savedOnly;

// 自分の前提つきの質問（#156）: 文脈の profile に架空の前提を入れて送る。判定: 前提の方針が答えに出る（mentions）・
// 照合の不一致 0（前提の数は照合の出所 = 画面と同じ numberSources）・前提の数をツールの入力にしない（misuse = ツールの
// 入力の値に前提の金額（円）が出たら失敗。計算の入力は設定の資金・ツールの結果から）

// ポジションの提案の質問（#139）: 候補のツール → propose_position が呼ばれる・提案が板の検査を通る（error でない）・
// カードの表示モデルができる・押した時点の反映の純関数で足が作れる・照合の不一致 0。floor があれば後の最大損失 ≥ floor

// 文書の質問（#137・#240）: 問は scripts/aiEvalDocs.ts（計算の前提 10・操作の案内 3・文書に無いこと 1）。中継の read_doc で
// マニュアル・設計書の節を読み、節を示して答えるか、文書に無いことを無いと言うか。expect は読んでほしい節（どれか 1 つ。
// 中継のログがあるときだけ判定）。判定: 節を示す（「マニュアル 8.5」「設計書 5.4」の形）・Issue 番号（#123）と決定の
// 記号（K7 など）を書かない・absent は「書かれていない」の言い回し。文書の値は照合できない数字になるので不一致は数えるが
// 失敗にしない。内容が節と矛盾しないかは返答の全文ファイルに想定の節と答えの要点（points）を並べて人が見比べる
// [AI に聞く]（#136）: 画面と同じ表示モデル（metricsPanel・bigReadout・ivReadout）から質問の文を作り、kind ask と場所の
// topic で送る。判定: 節を示す・経緯を書かない・想定の節（ASK_DOCS のどれか）を read_doc で読む（ログがあるとき）・ログの
// kind と topic・照合の不一致 0（照合の出所は画面と同じ numberSources = 質問に入れた表示の値と β の 1% あたりを含む）
/** IV 推移の問の架空の足（%。1 時間足 3 本）と今・シナリオの水準 */
const ASK_IV_BARS = [
  { t: 1_760_000_000, o: 19.8, h: 20.6, l: 19.5, c: 20.4 },
  { t: 1_760_003_600, o: 20.4, h: 21.9, l: 20.2, c: 21.7 },
  { t: 1_760_007_200, o: 21.7, h: 22.3, l: 21.1, c: 21.4 },
];

// 定型の質問（#140）: 画面のチップと同じ文（aiPresets.AI_PRESETS）を kind preset と定型の ID で送る。判定: エラーなし・
// want のツールのどれかを呼ぶ（スキルの節が挙げるツール。precomputed のツールは呼んだに数えない）・照合の一致 1 以上・
// 不一致 0・ログ（あれば）の kind / topic。noLegs は足 0 本（板の前提・IV は足が無くても押せる）。headings は返答に要る見出し（[反論] は 3 つ・[出口] は利確 / 損切り）。noCall は IV の上げ下げ・売り時を
// 断定しない（DIRECTION_RE と SELL_CALL_RE）。propose は通った提案のカード（今のタブ）が 1 つ以上
const PRESET_QUESTIONS = [
  { id: 'crash', case: 'put_sell', want: ['evaluate_scenario'] },
  {
    id: 'rebut',
    case: 'iron_condor',
    want: ['structure_candidates', 'evaluate_scenario'],
    headings: [/^## 反論 1/m, /^## 反論 2/m, /^## 反論 3/m],
  },
  { id: 'board', case: 'strangle_sell', want: ['iv_stats'], noCall: true },
  { id: 'board', case: 'strangle_sell', want: ['iv_stats'], noCall: true, noLegs: true },
  { id: 'hedge', case: 'put_sell', want: ['propose_position'], propose: true },
  {
    id: 'exit',
    case: 'bull_put',
    want: ['evaluate_scenario'],
    headings: [/^## 利確の候補/m, /^## 損切りの候補/m],
  },
  { id: 'iv', case: 'iron_condor', want: ['iv_stats'], noCall: true },
];
/** 売り時・買い時の断定（[今の IV は売り時？] で書かない） */
export const SELL_CALL_RE =
  /(売り時です|売り時だ(?!と)|売り時と言え(る|ます)|売るべき|買い時です|買うべき|売りに有利な局面です)/;

/** 節を示す言い回し（「マニュアル 8.5「…」」「設計書 5.4」「マニュアル 10 章」） */
export const CITE_RE = /(マニュアル|設計書)\s*(の\s*)?[0-9]+(\.[0-9]+)*/;
/** 開発の経緯（Issue 番号・決定の記号）。答えに出さない */
export const HISTORY_RE = /#[0-9]+|(?<![A-Za-z])[KDQ][0-9]+(?![0-9])/;
/** 文書に無いことを無いと言う言い回し */
export const ABSENT_RE =
  /(書かれていない|書かれていません|書いていない|書いてありません|記載(が|は)?(ない|なく|ありません)|見当たら|載っていない|載っていません)/;

const load = async (p) =>
  (await runnerImport(join(root, p), { configFile: false, root, logLevel: 'error' })).module;
const cases = await load('scripts/aiEvalCases.ts');
const ctxMod = await load('ui/view/aiContext.ts');
const chatMod = await load('ui/view/aiChat.ts');
const toolsMod = await load('ui/view/aiTools.ts');
const numMod = await load('ui/view/aiNumbers.ts');
const stream = await load('data/aiStream.ts');
const synthFut = await load('scripts/synthFutBars.ts');
const toolsFixture = await load('scripts/aiToolsFixture.ts');
const proposeMod = await load('ui/view/aiPropose.ts');
const askMod = await load('ui/view/aiAsk.ts');
const presetMod = await load('ui/view/aiPresets.ts');
const metricsMod = await load('ui/view/metrics.ts');
const panelMod = await load('ui/view/metricsPanel.ts');
const readoutMod = await load('ui/view/readout.ts');
const stageMod = await load('ui/view/stage.ts');
const ivMod = await load('ui/view/ivHistory.ts');
const evalCaseMod = await load('ui/view/aiEvalCase.ts');
const { DOC_QUESTIONS } = await load('scripts/aiEvalDocs.ts');
const diffMod = await load('scripts/aiEvalDiff.ts');
const retryMod = await load('scripts/aiEvalRetry.ts');
const {
  TECH_QUESTIONS,
  IV_QUESTIONS,
  PROFILE_QUESTIONS,
  PROPOSE_QUESTIONS,
  ASK_QUESTIONS,
  QUOTE_QUESTIONS,
} = await load('scripts/aiEvalQuestions.ts');

const latest = JSON.parse(readFileSync(join(root, 'fixtures', 'synthetic', 'latest.json'), 'utf8'));
const want = opt('--cases');
const selected = cases.AI_EVAL_CASES.filter((c) => !want || want.split(',').includes(c.name));
if (selected.length === 0) {
  console.error('評価の組が無い（--cases の名前）');
  process.exit(2);
}

// ---- 台帳（日をまたいで累計）
const ledger = (() => {
  try {
    return JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch {
    return { total_usd: 0, runs: [] };
  }
})();
const saveLedger = () => {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 1)}\n`);
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(root, 'fixtures', 'local', 'ai_eval', stamp);
mkdirSync(outDir, { recursive: true });

/** 中継へ送る fetch（同じオリジンの見出し。Node の fetch はブラウザの Sec-Fetch-Site を付けない） */
/** 直前の応答の Retry-After（中継の 429 の送り直しの待ち。#240） */
let lastRetryAfter = null;
const relayFetch = async (url, init = {}) => {
  const res = await fetch(`${base}${url}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Origin: base },
  });
  lastRetryAfter = res.headers.get('retry-after');
  return res;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const status = await stream.getAiStatus(relayFetch, '/api/ai/status').catch((e) => {
  console.error(
    `中継の状態を読めない（${e?.code ?? e?.message}）。AI_EVAL_BASE と中継の起動を確かめる`,
  );
  process.exit(2);
});
if (!status.enabled) {
  console.error('中継の AI が無効（AI_CREDENTIAL などの設定）');
  process.exit(2);
}
console.log(
  `中継: ${status.model} · 資格情報 ${status.credential} · ${status.counted ? `数える（残り $${status.remaining_usd}）` : '数えない'}`,
);
console.log(`台帳の累計 $${ledger.total_usd.toFixed(4)} / 上限 $${limitUsd}`);
/** 直前の今日の残り（数える資格情報。done の残り = 精算の後） */
let lastRemaining = status.remaining_usd;

/** 1 回の発言（ツールの往復を含む）。画面の useAiChat と同じ順（begin → 文脈 → send → 要求 → ツール → 要求…） */
async function turn(chat, env, kind, text, topic) {
  const run = {
    requests: 0,
    retries: 0,
    firstTextMs: null,
    totalMs: 0,
    stop: null,
    error: null,
    costUsd: 0,
  };
  const t0 = performance.now();
  let s = chatMod.aiChatReduce(chat, {
    type: 'begin',
    kind,
    text,
    now: Date.now(),
    ...(topic !== undefined && { topic }),
  });
  const context = ctxMod.buildAiContext(env);
  s = chatMod.aiChatReduce(s, { type: 'send', context, key: ctxMod.contextKey(context) });
  for (;;) {
    if (ledger.total_usd + reserveUsd > limitUsd) {
      run.error = 'eval_budget';
      s = chatMod.aiChatReduce(s, { type: 'fail', code: 'eval_budget' });
      break;
    }
    const body = chatMod.requestOf(s);
    if (!body) break;
    run.requests++;
    let after = null;
    // 中継の 1 分の上限（429 rate_limited）は SSE の前に断られる = 事象は届いていないので、待って同じ要求を送り直す
    for (let attempt = 0; ; attempt++) {
      try {
        await stream.postAiMessages(
          body,
          (ev) => {
            if (ev.type === 'text' && run.firstTextMs === null)
              run.firstTextMs = performance.now() - t0;
            if (ev.type === 'done') {
              after = ev.remaining_usd;
              run.stop = ev.stop_reason;
            }
            if (ev.type === 'error' || ev.type === 'incomplete')
              run.error = ev.type === 'error' ? ev.code : 'incomplete';
            s = chatMod.aiChatReduce(s, { type: 'event', event: ev });
          },
          undefined,
          relayFetch,
          '/api/ai/messages',
        );
        break;
      } catch (e) {
        const wait = retryMod.rateLimitWaitMs(e?.code, attempt, lastRetryAfter);
        if (wait !== null) {
          run.retries++;
          console.log(
            `  中継の 1 分の上限（rate_limited）: ${wait / 1000} 秒待って送り直す（${attempt + 1}/${retryMod.RATE_RETRY_MAX}）`,
          );
          await sleep(wait);
          continue;
        }
        run.error = e?.code ?? 'network';
        if (run.error === 'rate_limited')
          console.log(`  rate_limited: ${run.retries} 回送り直しても上限 → この問は FAIL`);
        s = chatMod.aiChatReduce(s, { type: 'fail', code: run.error });
        break;
      }
    }
    // 費用: 数える資格情報は直前の残りと done の残り（精算の後）の差 = 実額。途中で切れたら予約額（上界）で数える。
    // 数えないなら 0
    let cost = 0;
    if (status.counted) {
      if (after !== null && lastRemaining !== null) cost = Math.max(lastRemaining - after, 0);
      else cost = reserveUsd;
      if (after !== null) lastRemaining = after;
    }
    run.costUsd += cost;
    // 偽の送信先（AI_CREDENTIAL=fake。配線の確かめ）は台帳に入れない
    if (status.credential !== 'fake') {
      ledger.total_usd += cost;
      ledger.runs.push({ at: new Date().toISOString(), kind, cost_usd: cost, error: run.error });
      saveLedger();
    }
    if (!s.turn?.awaitingTools) break;
    const blocks = chatMod.toolResultBlocks(s, (name, input) => toolsMod.runTool(name, input, env));
    s = chatMod.aiChatReduce(s, { type: 'toolResults', blocks });
  }
  run.totalMs = performance.now() - t0;
  return { chat: s, run };
}

const answerOf = (chat) => {
  const last = chat.messages.at(-1);
  if (last?.role !== 'assistant') return '';
  return last.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
};

const rows = [];
for (let rep = 0; rep < (anyOnly ? 0 : repeat); rep++) {
  for (const c of selected) {
    const env = ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c));
    const { chat, run } = await turn(
      chatMod.INITIAL_AI_CHAT,
      env,
      'diagnose',
      chatMod.DIAGNOSE_TEXT,
    );
    const text = answerOf(chat);
    const sources = chatMod.numberSources(chat);
    const sections = numMod.sectionsOf(text, sources);
    const check = numMod.checkNumbers(text, sources);
    const weak = sections.filter((x) => x.weakness);
    const unmatched = check.tokens.filter((t) => t.status === 'unmatched').map((t) => t.raw);
    const pass =
      !run.error && weak.length >= 3 && weak.every((w) => w.matched >= 1) && check.unmatched === 0;
    rows.push({
      case: c.name,
      kind: 'diagnose',
      id: `diagnose:${c.name}${rep ? `#${rep}` : ''}`,
      rep,
      pass,
      weaknesses: weak.length,
      matched: weak.map((w) => w.matched),
      unmatched,
      chars: text.length,
      ...run,
    });
    writeFileSync(
      join(outDir, `${c.name}-${rep}.md`),
      `# ${c.label}（${c.name}・${rep}）\n\n${text}\n\n<!-- 照合: ${JSON.stringify({ matched: check.matched, unmatched })} -->\n`,
    );
    console.log(
      `${pass ? 'pass' : 'FAIL'}  ${c.name}#${rep}: 弱点 ${weak.length}（一致 ${weak.map((w) => w.matched).join('/')}）・不一致 ${unmatched.length}${unmatched.length ? `［${unmatched.join('、')}］` : ''}・${run.stop ?? run.error}・最初の文字 ${run.firstTextMs === null ? '—' : `${(run.firstTextMs / 1000).toFixed(1)} 秒`}・完了 ${(run.totalMs / 1000).toFixed(1)} 秒・$${run.costUsd.toFixed(4)}`,
    );
    // 追加の質問（tool_use の往復）
    const fu = followups && rep === 0 ? FOLLOWUPS.find((f) => f.case === c.name) : null;
    if (fu && !run.error) {
      const r2 = await turn(chat, env, 'chat', fu.text);
      const t2 = answerOf(r2.chat);
      const src2 = chatMod.numberSources(r2.chat);
      const ck2 = numMod.checkNumbers(t2, src2);
      const tools = r2.chat.messages
        .flatMap((m) => (m.role === 'assistant' ? m.content : []))
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.name);
      const un2 = ck2.tokens.filter((t) => t.status === 'unmatched').map((t) => t.raw);
      const ok2 = !r2.run.error && ck2.unmatched === 0 && ck2.matched >= 1;
      rows.push({
        case: c.name,
        kind: 'followup',
        id: `followup:${c.name}`,
        rep,
        pass: ok2,
        tools,
        matchedTotal: ck2.matched,
        unmatched: un2,
        chars: t2.length,
        ...r2.run,
      });
      writeFileSync(join(outDir, `${c.name}-followup.md`), `# 追加の質問: ${fu.text}\n\n${t2}\n`);
      console.log(
        `${ok2 ? 'pass' : 'FAIL'}  ${c.name} 追加の質問: ツール ${tools.join(',') || 'なし'}・一致 ${ck2.matched}・不一致 ${un2.length}${un2.length ? `［${un2.join('、')}］` : ''}・往復 ${r2.run.requests}・${r2.run.stop ?? r2.run.error}・完了 ${(r2.run.totalMs / 1000).toFixed(1)} 秒・$${r2.run.costUsd.toFixed(4)}`,
      );
    }
  }
}

// ---- テクニカルの質問（#200）: 新しい会話で 1 問ずつ。ツールの環境に合成の先物の足を入れる
// 合成の足の水準を合成の板の先物の値に合わせる（比で縮める。AI が板とツールの水準の食い違いに気を取られないように）
const techData = (() => {
  const d = synthFut.synthTechnicalsData();
  const k = latest.future.price / d.daily.at(-1).c;
  const scale = (b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k });
  return { daily: d.daily.map(scale), hourly: d.hourly.map(scale) };
})();
for (const q of anyOnly && !techOnly ? [] : TECH_QUESTIONS) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const env = {
    ...ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c)),
    technicals: techData,
  };
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const uses = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  const tools = uses.map((b) => b.name);
  const resultChars = r.chat.messages
    .flatMap((m) => (m.role === 'user' ? m.content : []))
    .filter(
      (b) =>
        b.type === 'tool_result' &&
        uses.some((u) => u.id === b.tool_use_id && u.name === 'technicals'),
    )
    .map((b) => b.content[0]?.text.length ?? 0);
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const direction = t.match(DIRECTION_RE)?.[0] ?? null;
  const caveat = CAVEAT_RE.test(t);
  const mentioned = q.mentions ? q.mentions.test(t) : null;
  const ok =
    !r.run.error &&
    tools.includes('technicals') &&
    ck.unmatched === 0 &&
    (!direction || caveat) &&
    mentioned !== false;
  rows.push({
    case: q.case,
    kind: 'technicals',
    id: `technicals:${q.id}`,
    rep: 0,
    pass: ok,
    tools,
    inputs: uses.filter((u) => u.name === 'technicals').map((u) => u.input),
    result_chars: resultChars,
    matchedTotal: ck.matched,
    unmatched: un,
    direction,
    caveat,
    mentioned,
    chars: t.length,
    ...r.run,
  });
  const techFile = `tech-${q.case}${q.mentions ? '-ema' : ''}.md`;
  writeFileSync(join(outDir, techFile), `# テクニカル: ${q.text}\n\n${t}\n`);
  console.log(
    `${ok ? 'pass' : 'FAIL'}  テクニカル ${q.case}: ツール ${tools.join(',') || 'なし'}・結果 ${resultChars.join('/') || '—'} 字・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・見立て ${direction ?? 'なし'}・但し書き ${caveat ? 'あり' : 'なし'}${mentioned === null ? '' : `・EMA ${mentioned ? 'あり' : 'なし'}`}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- IV の統計（#138・#158）: 新しい会話で 1 問ずつ。ツールの環境に合成の日次の値と今の IV を入れる
const ivData = toolsFixture.synthIvStatsData();
for (const q of anyOnly && !ivOnly ? [] : IV_QUESTIONS) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const env = {
    ...ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c)),
    ivStats: ivData,
  };
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const uses = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  const tools = uses.map((b) => b.name);
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const direction = t.match(DIRECTION_RE)?.[0] ?? null;
  const mentioned = q.mentions.test(t);
  const ok =
    !r.run.error && tools.includes('iv_stats') && ck.unmatched === 0 && !direction && mentioned;
  rows.push({
    case: q.case,
    kind: 'iv_stats',
    id: `iv_stats:${q.id}`,
    rep: 0,
    pass: ok,
    tools,
    inputs: uses.filter((u) => u.name === 'iv_stats').map((u) => u.input),
    matchedTotal: ck.matched,
    unmatched: un,
    direction,
    mentioned,
    chars: t.length,
    ...r.run,
  });
  writeFileSync(join(outDir, `iv-${q.case}.md`), `# IV の統計: ${q.text}\n\n${t}\n`);
  console.log(
    `${ok ? 'pass' : 'FAIL'}  IV の統計 ${q.case}: ツール ${tools.join(',') || 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・断定 ${direction ?? 'なし'}・触れた ${mentioned ? 'あり' : 'なし'}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- ポジションの提案（#139）: 新しい会話で 1 問ずつ
for (const q of anyOnly && !proposeOnly ? [] : PROPOSE_QUESTIONS) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const env = ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c));
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const uses = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  const results = new Map(
    r.chat.messages
      .flatMap((m) => (m.role === 'user' ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => [b.tool_use_id, JSON.parse(b.content[0].text)]),
  );
  const tools = uses.map((b) => b.name);
  const props = uses
    .filter((u) => u.name === 'propose_position')
    .map((u) => {
      const res = results.get(u.id);
      const card = proposeMod.proposalCard(u.input, res);
      const apply = proposeMod.proposalApply(env, u.input, res);
      const after = res && !res.error ? res.after : null;
      return {
        target: u.input.target,
        error: res?.error ?? null,
        card: card !== null,
        apply: !('error' in apply),
        lines: card ? card.lines.map((l) => `${l.mark} ${l.text}`) : [],
        metrics: card ? card.metrics : [],
        max_loss_after: after?.max_loss_yen ?? null,
      };
    });
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  // 板の検査で落ちた提案（error）はカードを出さない設計（返答にも書かない）ので失敗にしない。通った提案は全部
  // カードと反映ができ、頼んだ種類（target）の提案が 1 つ以上あること
  const valid = props.filter((p) => p.error === null);
  const okProps =
    valid.length > 0 &&
    valid.every((p) => p.card && p.apply) &&
    valid.some((p) => p.target === q.target) &&
    (q.floor === undefined ||
      valid.some((p) => p.max_loss_after !== null && p.max_loss_after >= q.floor));
  const ok =
    !r.run.error && (q.want === null || tools.includes(q.want)) && okProps && ck.unmatched === 0;
  rows.push({
    case: q.case,
    kind: 'propose',
    id: `propose:${q.id}`,
    rep: 0,
    pass: ok,
    tools,
    proposals: props,
    matchedTotal: ck.matched,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  writeFileSync(
    join(outDir, `propose-${q.case}.md`),
    `# 提案: ${q.text}\n\n${t}\n\n## カード\n\n${props.map((p) => [`- ${p.target}${p.error ? `（${p.error}）` : ''}`, ...p.lines.map((l) => `  - ${l}`), ...p.metrics.map((m) => `  - ${m}`)].join('\n')).join('\n')}\n`,
  );
  console.log(
    `${ok ? 'pass' : 'FAIL'}  提案 ${q.case}: ツール ${tools.join(',') || 'なし'}・提案 ${props.map((p) => `${p.target}${p.error ? `(${p.error})` : ''}`).join('/') || 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- 文書の質問（#137）: 新しい会話で 1 問ずつ。読んだ節は中継のログ（AI_EVAL_RELAY_LOG）の ai_request の docs
for (const [qi, q] of (anyOnly && !docsOnly ? [] : DOC_QUESTIONS).entries()) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === 'put_sell');
  const env = ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c));
  const before = relayRecords()?.length ?? null;
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const recs = before === null ? null : (relayRecords() ?? []).slice(before);
  const read = recs ? recs.flatMap((x) => (Array.isArray(x.docs) ? x.docs : [])) : null;
  const readIds = read ? read.map((x) => x.replace(/#[0-9]+$/, '')) : null;
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const cited = CITE_RE.test(t);
  const history = t.match(HISTORY_RE)?.[0] ?? null;
  const absent = ABSENT_RE.test(t);
  const hit = readIds && q.expect ? q.expect.some((e) => readIds.includes(e)) : null;
  const ok =
    !r.run.error &&
    !history &&
    (q.kind === 'absent' ? absent : cited) &&
    (readIds === null || readIds.length > 0) &&
    hit !== false;
  rows.push({
    case: c.name,
    kind: 'docs',
    id: `docs:${q.id}`,
    rep: 0,
    pass: ok,
    question: q.kind,
    docs: read,
    hit,
    cited,
    history,
    absent,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  // 人の照合用（EPIC #141 の終了条件 7）: 想定の節と答えの要点を返答と並べる
  writeFileSync(
    join(outDir, `docs-${qi + 1}-${q.id}.md`),
    `# 文書: ${q.text}\n\n種類: ${q.kind}・想定の節: ${q.expect?.join(', ') ?? '—（文書に無い）'}\n\n答えの要点: ${q.points}\n\n## 返答\n\n${t}\n`,
  );
  console.log(
    `${ok ? 'pass' : 'FAIL'}  文書 ${qi + 1}（${q.kind}・${q.id}）: 読んだ節 ${read === null ? '—（中継のログなし）' : read.join(',') || 'なし'}${hit === null ? '' : `・想定の節 ${hit ? 'あり' : 'なし'}`}・節の明示 ${cited ? 'あり' : 'なし'}${q.kind === 'absent' ? `・無いと言う ${absent ? 'あり' : 'なし'}` : ''}・経緯 ${history ?? 'なし'}・照合できない数字 ${un.length}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- [AI に聞く]（#136）: 新しい会話で 1 問ずつ。質問の文は画面と同じ表示モデルから作る
for (const [qi, q] of (anyOnly && !askOnly ? [] : ASK_QUESTIONS).entries()) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const st = cases.caseState(latest, c);
  const env = ctxMod.aiEnvFromState(st, cases.caseMargin(c));
  const m = metricsMod.metricsModel({ base: env.base, scenario: env.scenario, unit: 'auto' });
  const view = panelMod.metricsPanel(m, st.feePerLot);
  let ask = null;
  if (q.where === 'tile') {
    const t = view.tiles.find((x) => x.key === q.key);
    ask = t ? askMod.askTile(t, view.unitSub) : null;
  } else if (q.where === 'readout') {
    const r = readoutMod.readoutModel({ base: env.base, metrics: m, scenario: env.scenario });
    const items = stageMod.bigReadout(
      r,
      m.premium,
      env.base?.ctx.evalTime ?? null,
      env.scenario.dSigma,
    );
    const it = items.find((x) => x.key === q.key);
    ask = it ? askMod.askReadout(it) : null;
  } else if (q.where === 'tail') {
    ask = askMod.askTail(view);
  } else {
    ask = askMod.askIvHistory({
      tfLabel: '1 時間足',
      readout: ivMod.ivReadout(ASK_IV_BARS, '1h', null, false),
      cursor: false,
      now: ivMod.fmtIvPt(21.52),
      scenario: ivMod.fmtIvPt(26.52),
    });
  }
  if (!ask) {
    console.log(`FAIL  [AI に聞く] ${qi + 1}（${q.where}）: 質問を作れない`);
    rows.push({
      case: q.case,
      kind: 'ask',
      id: `ask:${q.id}`,
      rep: 0,
      pass: false,
      unmatched: [],
      costUsd: 0,
    });
    continue;
  }
  const before = relayRecords()?.length ?? null;
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'ask', ask.text, ask.topic);
  const t = answerOf(r.chat);
  const recs = before === null ? null : (relayRecords() ?? []).slice(before);
  const read = recs ? recs.flatMap((x) => (Array.isArray(x.docs) ? x.docs : [])) : null;
  const readIds = read ? read.map((x) => x.replace(/#[0-9]+$/, '')) : null;
  const expect = askMod.ASK_DOCS[ask.topic].map((d) => `${d.file}:${d.section}`);
  const hit = readIds ? expect.some((e) => readIds.includes(e)) : null;
  const logged = recs ? recs.some((x) => x.kind === 'ask' && x.topic === ask.topic) : null;
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const cited = CITE_RE.test(t);
  const history = t.match(HISTORY_RE)?.[0] ?? null;
  const ok =
    !r.run.error && cited && !history && hit !== false && logged !== false && ck.unmatched === 0;
  rows.push({
    case: q.case,
    kind: 'ask',
    id: `ask:${q.id}`,
    rep: 0,
    pass: ok,
    topic: ask.topic,
    docs: read,
    hit,
    logged,
    cited,
    history,
    matchedTotal: ck.matched,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  writeFileSync(
    join(outDir, `ask-${qi + 1}-${ask.topic}.md`),
    `# [AI に聞く]\n\n${ask.text}\n\n---\n\n${t}\n`,
  );
  console.log(
    `${ok ? 'pass' : 'FAIL'}  [AI に聞く] ${qi + 1}（${ask.topic}）: 読んだ節 ${read === null ? '—（中継のログなし）' : read.join(',') || 'なし'}${hit === null ? '' : `・想定の節 ${hit ? 'あり' : 'なし'}`}${logged === null ? '' : `・ログの kind / topic ${logged ? 'あり' : 'なし'}`}・節の明示 ${cited ? 'あり' : 'なし'}・経緯 ${history ?? 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- 自分の前提つきの質問（#156）: 新しい会話で 1 問ずつ。前提は画面と同じく aiEnvFromState の第 3 引数で文脈に入れる
for (const [qi, q] of (anyOnly && !profileOnly ? [] : PROFILE_QUESTIONS).entries()) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const env = ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c), q.profile);
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const inputs = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use')
    .map((b) => JSON.stringify(b.input));
  const misuse = q.misuse.filter((v) => inputs.some((i) => new RegExp(`:${v}(?![0-9])`).test(i)));
  const mentioned = q.mentions.test(t);
  const ok = !r.run.error && mentioned && ck.unmatched === 0 && misuse.length === 0;
  rows.push({
    case: q.case,
    kind: 'profile',
    id: `profile:${q.id}`,
    rep: 0,
    pass: ok,
    mentioned,
    misuse,
    matchedTotal: ck.matched,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  writeFileSync(
    join(outDir, `profile-${qi + 1}-${q.case}.md`),
    `# 前提: ${q.profile}\n\n## 質問\n\n${q.text}\n\n---\n\n${t}\n`,
  );
  console.log(
    `${ok ? 'pass' : 'FAIL'}  前提 ${qi + 1}（${q.case}）: 方針 ${mentioned ? 'あり' : 'なし'}・前提の数をツールの入力に ${misuse.length ? misuse.join(',') : 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- 行使価格の理論価格（#266）: 新しい会話で 1 問ずつ。判定: strike_quote を呼ぶ・エラーなし・聞いたことに触れる
// （mentions）・照合の一致 1 以上・不一致 0（理論価格・IV・気配はツールの結果 = 画面の「理論価格（周りの行から）」と同じ値）
for (const q of anyOnly && !quoteOnly ? [] : QUOTE_QUESTIONS) {
  const c = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const env = ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c));
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'chat', q.text);
  const t = answerOf(r.chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const uses = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  const tools = uses.map((b) => b.name);
  const mentioned = q.mentions.test(t);
  const ok =
    !r.run.error &&
    tools.includes('strike_quote') &&
    mentioned &&
    ck.matched >= 1 &&
    ck.unmatched === 0;
  rows.push({
    case: q.case,
    kind: 'quote',
    id: `quote:${q.id}`,
    rep: 0,
    pass: ok,
    tools,
    inputs: uses.filter((u) => u.name === 'strike_quote').map((u) => u.input),
    mentioned,
    matchedTotal: ck.matched,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  writeFileSync(join(outDir, `quote-${q.id}.md`), `# 理論価格: ${q.text}\n\n${t}\n`);
  console.log(
    `${ok ? 'pass' : 'FAIL'}  理論価格 ${q.id}: ツール ${tools.join(',') || 'なし'}・触れた ${mentioned ? 'あり' : 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

// ---- 定型の質問（#140）: 新しい会話で 1 問ずつ。文は画面のチップと同じ。IV の統計を使う問は合成の日次の値を入れる
for (const q of anyOnly && !presetOnly ? [] : PRESET_QUESTIONS) {
  const preset = presetMod.AI_PRESETS.find((p) => p.id === q.id);
  const c0 = cases.AI_EVAL_CASES.find((x) => x.name === q.case);
  const c = q.noLegs ? { ...c0, legs: [] } : c0;
  const env = {
    ...ctxMod.aiEnvFromState(cases.caseState(latest, c), cases.caseMargin(c)),
    ivStats: ivData,
  };
  const before = relayRecords()?.length ?? null;
  const r = await turn(chatMod.INITIAL_AI_CHAT, env, 'preset', preset.text, preset.id);
  const t = answerOf(r.chat);
  const recs = before === null ? null : (relayRecords() ?? []).slice(before);
  const logged = recs ? recs.some((x) => x.kind === 'preset' && x.topic === preset.id) : null;
  const skillsRead = recs ? recs.flatMap((x) => (Array.isArray(x.skills) ? x.skills : [])) : null;
  const ck = numMod.checkNumbers(t, chatMod.numberSources(r.chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const uses = r.chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  const tools = uses.map((b) => b.name);
  const results = new Map(
    r.chat.messages
      .flatMap((m) => (m.role === 'user' ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => [b.tool_use_id, JSON.parse(b.content[0].text)]),
  );
  const cards = uses
    .filter((u) => u.name === 'propose_position')
    .map((u) => {
      const res = results.get(u.id);
      return {
        target: u.input.target,
        error: res?.error ?? null,
        card: proposeMod.proposalCard(u.input, res) !== null,
      };
    });
  const headingsOk = (q.headings ?? []).every((re) => re.test(t));
  const direction = q.noCall ? (t.match(DIRECTION_RE)?.[0] ?? null) : null;
  const sellCall = q.noCall ? (t.match(SELL_CALL_RE)?.[0] ?? null) : null;
  const proposeOk =
    !q.propose || cards.some((x) => x.error === null && x.card && x.target === 'current');
  const ok =
    !r.run.error &&
    q.want.some((w) => tools.includes(w)) &&
    ck.matched >= 1 &&
    ck.unmatched === 0 &&
    headingsOk &&
    !direction &&
    !sellCall &&
    proposeOk &&
    logged !== false;
  rows.push({
    case: q.noLegs ? `${q.case}(足なし)` : q.case,
    kind: 'preset',
    id: `preset:${q.id}${q.noLegs ? '-nolegs' : ''}`,
    rep: 0,
    pass: ok,
    topic: preset.id,
    tools,
    skills: skillsRead,
    logged,
    headingsOk,
    direction,
    sellCall,
    proposals: cards,
    matchedTotal: ck.matched,
    unmatched: un,
    chars: t.length,
    ...r.run,
  });
  const tag = `${preset.id}${q.noLegs ? '-nolegs' : ''}`;
  writeFileSync(join(outDir, `preset-${tag}.md`), `# 定型: ${preset.label}\n\n${t}\n`);
  console.log(
    `${ok ? 'pass' : 'FAIL'}  定型 ${preset.label}（${q.case}${q.noLegs ? '・足なし' : ''}）: ツール ${tools.join(',') || 'なし'}${skillsRead === null ? '' : `・スキル ${skillsRead.join(',') || 'なし'}`}${logged === null ? '' : `・ログの kind / topic ${logged ? 'あり' : 'なし'}`}${q.headings ? `・見出し ${headingsOk ? 'あり' : 'なし'}` : ''}${q.noCall ? `・断定 ${direction ?? sellCall ?? 'なし'}` : ''}${q.propose ? `・提案 ${cards.map((x) => `${x.target}${x.error ? `(${x.error})` : ''}`).join('/') || 'なし'}` : ''}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}・往復 ${r.run.requests}・${r.run.stop ?? r.run.error}・完了 ${(r.run.totalMs / 1000).toFixed(1)} 秒`,
  );
}

/** 中継のログ（標準出力の JSON 行）の ai_request。ログが無ければ null */
function relayRecords() {
  if (!relayLog) return null;
  try {
    return readFileSync(relayLog, 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r?.event === 'ai_request');
  } catch {
    return null;
  }
}

// ---- 保存した会話（#159）: 画面の [評価に残す] のファイル（実データを含むので fixtures/local/ だけ）。期待の答えは持たない。
// ファイルの材料で文脈を作り直し（画面と同じ関数）、発言の列を新しい会話で順に送り直す。判定: エラーなし・最後の返答の
// 照合の不一致 0。文脈の指紋が保存の文脈と違えば「文脈 違う」と出す（画面・計算のコードが変わった。送りはする）
const casesDir = join(root, 'fixtures', 'local', 'ai_eval', 'cases');
const savedFiles = (() => {
  if (!savedOnly) return [];
  try {
    return readdirSync(casesDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
})();
if (savedOnly && savedFiles.length === 0) {
  console.error(
    '保存した会話が無い（fixtures/local/ai_eval/cases/*.json。手順は api/README.md「AI の評価」）',
  );
  process.exit(2);
}
for (const f of savedFiles) {
  const name = f.replace(/\.json$/, '');
  let doc = null;
  let env = null;
  try {
    doc = evalCaseMod.readAiEvalCase(JSON.parse(readFileSync(join(casesDir, f), 'utf8')));
    if (doc) env = evalCaseMod.aiEnvFromCase(doc.source);
  } catch (e) {
    console.error(`  ${f}: ${e?.message}`);
  }
  if (!doc || !env) {
    rows.push({
      case: name,
      kind: 'saved',
      id: `saved:${name}`,
      rep: 0,
      pass: false,
      error: 'invalid',
      unmatched: [],
      costUsd: 0,
    });
    console.log(`FAIL  保存 ${name}: 読めない（形・版・板・ポジション）`);
    continue;
  }
  const sameContext =
    doc.context === null
      ? null
      : ctxMod.contextKey(ctxMod.buildAiContext(env)) === ctxMod.contextKey(doc.context);
  let chat = chatMod.INITIAL_AI_CHAT;
  const runs = [];
  // ツールの実行などの例外は件の失敗（error exception）にして次の件へ（1 件で全体を止めない）
  let thrown = null;
  for (const t of doc.turns) {
    try {
      const r = await turn(chat, env, t.kind, t.text, t.topic);
      chat = r.chat;
      runs.push(r.run);
      if (r.run.error) break;
    } catch (e) {
      thrown = 'exception';
      console.error(`  ${f}: ${e?.message}`);
      break;
    }
  }
  const t = answerOf(chat);
  const ck = numMod.checkNumbers(t, chatMod.numberSources(chat));
  const un = ck.tokens.filter((x) => x.status === 'unmatched').map((x) => x.raw);
  const tools = chat.messages
    .flatMap((m) => (m.role === 'assistant' ? m.content : []))
    .filter((b) => b.type === 'tool_use')
    .map((b) => b.name);
  const error = thrown ?? runs.find((r) => r.error)?.error ?? null;
  const note = evalCaseMod.noteLine(doc.note);
  const requests = runs.reduce((n, r) => n + r.requests, 0);
  const totalMs = runs.reduce((n, r) => n + r.totalMs, 0);
  const ok = !error && runs.length === doc.turns.length && ck.unmatched === 0;
  rows.push({
    case: name,
    kind: 'saved',
    id: `saved:${name}`,
    rep: 0,
    pass: ok,
    note,
    turns: doc.turns.length,
    same_context: sameContext,
    tools,
    matchedTotal: ck.matched,
    unmatched: un,
    saved_unmatched: doc.answer.unmatched,
    chars: t.length,
    requests,
    totalMs,
    stop: runs.at(-1)?.stop ?? null,
    error,
    costUsd: runs.reduce((n, r) => n + r.costUsd, 0),
  });
  writeFileSync(
    join(outDir, `saved-${name}.md`),
    `# 保存した会話: ${name}\n\nメモ: ${note || '—'}\n\n## 保存したときの返答（不一致 ${doc.answer.unmatched.length}）\n\n${doc.answer.text}\n\n## 今の返答\n\n${t}\n`,
  );
  console.log(
    `${ok ? 'pass' : 'FAIL'}  保存 ${name}: 発言 ${doc.turns.length}・文脈 ${sameContext === null ? '—' : sameContext ? '同じ' : '違う'}・ツール ${tools.join(',') || 'なし'}・一致 ${ck.matched}・不一致 ${un.length}${un.length ? `［${un.join('、')}］` : ''}（保存のとき ${doc.answer.unmatched.length}）・往復 ${requests}・${error ?? runs.at(-1)?.stop ?? '—'}・完了 ${(totalMs / 1000).toFixed(1)} 秒${note ? `・メモ「${note}」` : ''}`,
  );
}

// ---- 中継のログ（任意）: ai_request の概算費用・トークン・落とした block
let relay = null;
if (relayLog) {
  try {
    const recs = relayRecords() ?? [];
    const sum = (k) => recs.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : 0), 0);
    const sorted = (k) =>
      recs
        .map((r) => r[k])
        .filter((v) => typeof v === 'number')
        .sort((a, b) => a - b);
    const p50 = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    relay = {
      requests: recs.length,
      cost_usd_est: Number(sum('cost_usd_est').toFixed(4)),
      input_tokens: sum('input_tokens'),
      cache_read_input_tokens: sum('cache_read_input_tokens'),
      cache_creation_input_tokens: sum('cache_creation_input_tokens'),
      output_tokens: sum('output_tokens'),
      dropped_blocks: sum('dropped_blocks'),
      first_text_ms_p50: p50(sorted('first_text_ms')),
      total_ms_p50: p50(sorted('total_ms')),
      errors: recs.filter((r) => r.error).map((r) => r.error),
      // 読んだスキルの名前ごとの回数と turn の数（#221）
      skills: recs
        .flatMap((r) => (Array.isArray(r.skills) ? r.skills : []))
        .reduce((m, n) => {
          m[n] = (m[n] ?? 0) + 1;
          return m;
        }, {}),
      turns_p50: p50(sorted('turns')),
      // 読んだ文書の節ごとの回数（#137）
      docs: recs
        .flatMap((r) => (Array.isArray(r.docs) ? r.docs : []))
        .reduce((m, n) => {
          m[n] = (m[n] ?? 0) + 1;
          return m;
        }, {}),
    };
  } catch (e) {
    console.error(`中継のログを読めない: ${e?.message}`);
  }
}

const diag = rows.filter((r) => r.kind === 'diagnose');
const fus = rows.filter((r) => r.kind === 'followup');
const techs = rows.filter((r) => r.kind === 'technicals');
const ivRows = rows.filter((r) => r.kind === 'iv_stats');
const proposes = rows.filter((r) => r.kind === 'propose');
const docRows = rows.filter((r) => r.kind === 'docs');
const askRows = rows.filter((r) => r.kind === 'ask');
const presetRows = rows.filter((r) => r.kind === 'preset');
const profileRows = rows.filter((r) => r.kind === 'profile');
const savedRows = rows.filter((r) => r.kind === 'saved');
const quoteRows = rows.filter((r) => r.kind === 'quote');
const mode = diffMod.evalMode(args);
// 前回の実行（同じモード・偽の送信先かどうかが同じ。#240）
const aiEvalDir = dirname(outDir);
const previous = diffMod.pickPrevious(
  readdirSync(aiEvalDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'cases' && d.name !== stamp)
    .map((d) => {
      try {
        return {
          dir: d.name,
          file: JSON.parse(readFileSync(join(aiEvalDir, d.name, 'summary.json'), 'utf8')),
        };
      } catch {
        return { dir: d.name, file: null };
      }
    }),
  { dir: stamp, mode, fake: status.credential === 'fake' },
);
const counts = diffMod.runCounts(rows);
const summary = {
  mode,
  previous: previous?.dir ?? null,
  model: status.model,
  credential: status.credential,
  counted: status.counted,
  diagnose: { pass: diag.filter((r) => r.pass).length, total: diag.length },
  followup: { pass: fus.filter((r) => r.pass).length, total: fus.length },
  technicals: { pass: techs.filter((r) => r.pass).length, total: techs.length },
  iv_stats: { pass: ivRows.filter((r) => r.pass).length, total: ivRows.length },
  propose: { pass: proposes.filter((r) => r.pass).length, total: proposes.length },
  docs: { pass: docRows.filter((r) => r.pass).length, total: docRows.length },
  ask: { pass: askRows.filter((r) => r.pass).length, total: askRows.length },
  preset: { pass: presetRows.filter((r) => r.pass).length, total: presetRows.length },
  profile: { pass: profileRows.filter((r) => r.pass).length, total: profileRows.length },
  saved: { pass: savedRows.filter((r) => r.pass).length, total: savedRows.length },
  quote: { pass: quoteRows.filter((r) => r.pass).length, total: quoteRows.length },
  // 文書の質問の不一致（文書の値）は数えない（照合の対象外。#137）
  unmatched_total: rows
    .filter((r) => r.kind !== 'docs')
    .reduce((n, r) => n + r.unmatched.length, 0),
  matched_total: counts.matched,
  cost_usd: Number(rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
  ledger_total_usd: Number(ledger.total_usd.toFixed(4)),
  relay,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ summary, rows }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
for (const line of diffMod.formatDiff(
  mode,
  previous?.dir ?? null,
  previous ? diffMod.diffRuns(previous.file.rows, rows) : null,
))
  console.log(line);
console.log(`返答の全文: fixtures/local/ai_eval/${stamp}/（コミットしない）`);
const ok =
  summary.diagnose.pass === summary.diagnose.total &&
  summary.followup.pass === summary.followup.total &&
  summary.technicals.pass === summary.technicals.total &&
  summary.iv_stats.pass === summary.iv_stats.total &&
  summary.propose.pass === summary.propose.total &&
  summary.docs.pass === summary.docs.total &&
  summary.ask.pass === summary.ask.total &&
  summary.preset.pass === summary.preset.total &&
  summary.profile.pass === summary.profile.total &&
  summary.saved.pass === summary.saved.total &&
  summary.quote.pass === summary.quote.total;
process.exit(ok ? 0 : 1);

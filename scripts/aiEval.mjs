// AI の評価（`npm run ai:eval`。#135 AC1・AC2、EPIC #141 終了条件 1・2）。合成の板（fixtures/synthetic/latest.json）と
// 合成のポジション 10 通り（scripts/aiEvalCases.ts）で、画面と同じコード（ui/view/aiContext.ts の文脈と事前計算・
// ui/view/aiChat.ts の会話の reducer と道具の往復・ui/view/aiTools.ts の道具・data/aiStream.ts の SSE）を通して
// 中継（POST /api/ai/messages）に送り、[このポジを診断] の返答の弱点の数と数字の照合（ui/view/aiNumbers.ts）を出す。
// TypeScript のモジュールは Vite のモジュールランナーで読む（依存を増やさない）。
//
// 送り先は AI_EVAL_BASE（既定 http://127.0.0.1:8080）= 手元で起動した中継。本番の IAP は越えない。資格情報は中継の
// 環境変数（このスクリプトは読まない・出さない）。手順は api/README.md「AI の評価」。
//
//   npm run ai:eval                          10 通りの診断 + 追加の質問 2 件
//   npm run ai:eval -- --cases put_sell,calendar --repeat 2 --no-followups
//
// 費用の上限: 累計の台帳 fixtures/local/ai_eval/ledger.json（gitignore）で AI_EVAL_LIMIT_USD（既定 6.5）を超える前に
// 止める。費用は中継の今日の残り（remaining_usd）の前の値との差（数える資格情報。要求は直列）か、数えない資格情報
// （OAuth）は 0。
// AI_EVAL_RELAY_LOG に中継のログ（標準出力の JSON 行）を指定すると ai_request の cost_usd_est・トークン量・dropped_blocks
// も集める（ログに会話の本文・鍵は出ない = relay.py）。
// 返答の全文は fixtures/local/ai_eval/<時刻>/ にだけ書く（コミットしない）。標準出力は要約（架空の値）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const reserveUsd = 0.2; // 1 要求の予約額の上界（中継の予約の式。max_tokens 8000 × 出力単価 + 入力）
const repeat = Number(opt('--repeat', '1'));
const followups = !args.includes('--no-followups');
const relayLog = process.env.AI_EVAL_RELAY_LOG || null;
// fixtures/local/ 直下の *.json は板の dump として検査される（tests/data/local.test.ts）ので ai_eval/ の下に置く
const ledgerPath = join(root, 'fixtures', 'local', 'ai_eval', 'ledger.json');
const FOLLOWUPS = [
  { case: 'put_sell', text: '日経が 3 日で −6%、IV が 5pt 上がったら損益はどうなりますか？' },
  { case: 'iron_condor', text: '10 日後に原資産が +4% のときの損益と Δ を教えてください。' },
];

const load = async (p) =>
  (await runnerImport(join(root, p), { configFile: false, root, logLevel: 'error' })).module;
const cases = await load('scripts/aiEvalCases.ts');
const ctxMod = await load('ui/view/aiContext.ts');
const chatMod = await load('ui/view/aiChat.ts');
const toolsMod = await load('ui/view/aiTools.ts');
const numMod = await load('ui/view/aiNumbers.ts');
const stream = await load('data/aiStream.ts');

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
const relayFetch = (url, init = {}) =>
  fetch(`${base}${url}`, { ...init, headers: { ...(init.headers ?? {}), Origin: base } });

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

/** 1 回の発言（道具の往復を含む）。画面の useAiChat と同じ順（begin → 文脈 → send → 要求 → 道具 → 要求…） */
async function turn(chat, env, kind, text) {
  const run = { requests: 0, firstTextMs: null, totalMs: 0, stop: null, error: null, costUsd: 0 };
  const t0 = performance.now();
  let s = chatMod.aiChatReduce(chat, { type: 'begin', kind, text, now: Date.now() });
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
    } catch (e) {
      run.error = e?.code ?? 'network';
      s = chatMod.aiChatReduce(s, { type: 'fail', code: run.error });
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
for (let rep = 0; rep < repeat; rep++) {
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
        `${ok2 ? 'pass' : 'FAIL'}  ${c.name} 追加の質問: 道具 ${tools.join(',') || 'なし'}・一致 ${ck2.matched}・不一致 ${un2.length}${un2.length ? `［${un2.join('、')}］` : ''}・往復 ${r2.run.requests}・${r2.run.stop ?? r2.run.error}・完了 ${(r2.run.totalMs / 1000).toFixed(1)} 秒・$${r2.run.costUsd.toFixed(4)}`,
      );
    }
  }
}

// ---- 中継のログ（任意）: ai_request の概算費用・トークン・落とした block
let relay = null;
if (relayLog) {
  try {
    const recs = readFileSync(relayLog, 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r?.event === 'ai_request');
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
    };
  } catch (e) {
    console.error(`中継のログを読めない: ${e?.message}`);
  }
}

const diag = rows.filter((r) => r.kind === 'diagnose');
const fus = rows.filter((r) => r.kind === 'followup');
const summary = {
  model: status.model,
  credential: status.credential,
  counted: status.counted,
  diagnose: { pass: diag.filter((r) => r.pass).length, total: diag.length },
  followup: { pass: fus.filter((r) => r.pass).length, total: fus.length },
  unmatched_total: rows.reduce((n, r) => n + r.unmatched.length, 0),
  cost_usd: Number(rows.reduce((n, r) => n + r.costUsd, 0).toFixed(4)),
  ledger_total_usd: Number(ledger.total_usd.toFixed(4)),
  relay,
};
writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify({ summary, rows }, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
console.log(`返答の全文: fixtures/local/ai_eval/${stamp}/（コミットしない）`);
const ok =
  summary.diagnose.pass === summary.diagnose.total &&
  summary.followup.pass === summary.followup.total;
process.exit(ok ? 0 : 1);

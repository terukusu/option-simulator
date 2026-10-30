// 評価に残す会話（#159）: 保存の形 → JSON → 読み直し → 同じ文脈の作り直し、発言の列の kind、壊れたファイルを読まない。
// 板は合成（fixtures/synthetic/latest.json）、ポジションは scripts/aiEvalCases の組（架空の値）
import { describe, expect, it } from 'vitest';
import type { AiMessage } from '../../data/aiStream';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { synthIvStatsData } from '../../scripts/aiToolsFixture';
import { synthTechnicalsData } from '../../scripts/synthFutBars';
import { reduce } from '../../ui/state';
import { type AiChatState, DIAGNOSE_TEXT, INITIAL_AI_CHAT } from '../../ui/view/aiChat';
import { aiEnvFromState, buildAiContext, contextKey } from '../../ui/view/aiContext';
import {
  AI_EVAL_CASE_KIND,
  type AiTurnLog,
  aiEnvFromCase,
  aiEvalCase,
  aiEvalFileName,
  aiEvalSource,
  keepKeys,
  noteLine,
  readAiEvalCase,
  recordSource,
  sourceAt,
  turnOf,
  usedTools,
  withToolData,
} from '../../ui/view/aiEvalCase';
import { AI_PRESETS } from '../../ui/view/aiPresets';
import { fixture } from '../support/fixtures';

const latest = fixture('latest');
const c = AI_EVAL_CASES.find((x) => x.name === 'put_sell');
if (!c) throw new Error('case');
const state = caseState(latest, c);
const margin = caseMargin(c);
const PROFILE = '1 回の損失は 1,500 千円まで。';
const env = aiEnvFromState(state, margin, PROFILE);
if (!env) throw new Error('env');
const context = buildAiContext(env);
const NOW = Date.UTC(2026, 9, 22, 6, 30, 0);

const ASK_TEXT = '［AI に聞く］指標 ›「最大損失」\n画面の表示: −1,234 千円';
const preset = AI_PRESETS[0];
if (!preset) throw new Error('preset');
const messages: AiMessage[] = [
  { role: 'user', content: [{ type: 'text', text: DIAGNOSE_TEXT }] },
  { role: 'assistant', content: [{ type: 'text', text: '弱点 1: 急落に弱い。' }] },
  { role: 'user', content: [{ type: 'text', text: ASK_TEXT }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '計算します。' },
      { type: 'tool_use', id: 't1', name: 'evaluate_scenario', input: { days: 3 } },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: '{"pnl_yen":-500000}' }],
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: '損益は −500,000 円、別に 987,654 円。' }] },
  { role: 'user', content: [{ type: 'text', text: preset.text }] },
  { role: 'assistant', content: [{ type: 'text', text: '崩れ方の答え。' }] },
];
const chat: AiChatState = { ...INITIAL_AI_CHAT, context, lastKey: contextKey(context), messages };
const log: AiTurnLog = new Map([[ASK_TEXT, { kind: 'ask' as const, topic: 'tile.maxLoss' }]]);

const source = () => {
  const s = aiEvalSource(state, margin, PROFILE, NOW);
  if (!s) throw new Error('source');
  return s;
};

describe('aiEvalCase（#159）', () => {
  it('保存 → JSON → 読み直し → 作り直した環境の文脈の指紋が元と同じ', () => {
    const doc = aiEvalCase({
      chat,
      answerKey: 'm7b0',
      source: source(),
      note: '数字が違う',
      now: NOW,
      log,
    });
    expect(doc).not.toBeNull();
    const read = readAiEvalCase(JSON.parse(JSON.stringify(doc)));
    expect(read).not.toBeNull();
    if (!read) return;
    expect(read.kind).toBe(AI_EVAL_CASE_KIND);
    expect(read.note).toBe('数字が違う');
    expect(read.source.margin).toEqual(margin);
    expect(read.source.profile).toBe(PROFILE);
    const env2 = aiEnvFromCase(read.source);
    expect(contextKey(buildAiContext(env2))).toBe(contextKey(context));
    expect(read.context && contextKey(read.context)).toBe(contextKey(context));
  });

  it('発言の列: 控えの kind・topic、無ければ診断・定型の文から推定、他は chat', () => {
    const doc = aiEvalCase({ chat, answerKey: 'm7b0', source: source(), note: '', now: NOW, log });
    expect(doc?.turns).toEqual([
      { kind: 'diagnose', text: DIAGNOSE_TEXT },
      { kind: 'ask', text: ASK_TEXT, topic: 'tile.maxLoss' },
      { kind: 'preset', text: preset.text, topic: preset.id },
    ]);
    // 控えが無い（sessionStorage から戻した会話）→ [AI に聞く] は chat
    expect(turnOf(ASK_TEXT).kind).toBe('chat');
    expect(turnOf('ふつうの質問')).toEqual({ kind: 'chat', text: 'ふつうの質問' });
  });

  it('押した返答の message までで切り、その返答の照合（一致・不一致）を入れる', () => {
    const doc = aiEvalCase({ chat, answerKey: 'm5b0', source: source(), note: '', now: NOW, log });
    expect(doc?.messages).toHaveLength(6);
    expect(doc?.turns.map((t) => t.kind)).toEqual(['diagnose', 'ask']);
    expect(doc?.answer.text).toBe('損益は −500,000 円、別に 987,654 円。');
    expect(doc?.answer.matched).toBeGreaterThanOrEqual(1);
    expect(doc?.answer.unmatched).toEqual(['987,654 円']);
    const first = aiEvalCase({ chat, answerKey: 'm1b0', source: source(), note: '', now: NOW });
    expect(first?.messages).toHaveLength(2);
    expect(first?.turns).toEqual([{ kind: 'diagnose', text: DIAGNOSE_TEXT }]);
  });

  it('文脈は最後の context_update（会話の途中で画面を変えた）', () => {
    const updated = { ...context, capital: { capital_yen: 9_000_000 } };
    const ms: AiMessage[] = [
      ...messages.slice(0, 2),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'もう一度' },
          { type: 'context_update', context: updated },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '答え' }] },
    ];
    const doc = aiEvalCase({
      chat: { ...chat, messages: ms },
      answerKey: 'm3b0',
      source: source(),
      note: '',
      now: NOW,
    });
    expect(doc?.context).toEqual(updated);
  });

  it('流れている途中・失敗の行・利用者の行・ツールの block の key では作らない', () => {
    for (const key of ['live-text', 'failed-text', 'm0b0', 'm3b1', 'm99b0']) {
      expect(aiEvalCase({ chat, answerKey: key, source: source(), note: '', now: NOW })).toBeNull();
    }
  });

  it('壊れたファイル・版違い・欄の欠けを読まない', () => {
    const doc = JSON.parse(
      JSON.stringify(
        aiEvalCase({ chat, answerKey: 'm7b0', source: source(), note: '', now: NOW, log }),
      ),
    );
    expect(readAiEvalCase(doc)).not.toBeNull();
    expect(readAiEvalCase(null)).toBeNull();
    expect(readAiEvalCase('x')).toBeNull();
    expect(readAiEvalCase({ ...doc, v: 2 })).toBeNull();
    expect(readAiEvalCase({ ...doc, kind: 'other' })).toBeNull();
    expect(readAiEvalCase({ ...doc, turns: [] })).toBeNull();
    expect(readAiEvalCase({ ...doc, turns: [{ kind: 'bad', text: 'x' }] })).toBeNull();
    expect(readAiEvalCase({ ...doc, answer: { text: 'x' } })).toBeNull();
    const { calendar: _c, ...noCal } = doc.source;
    expect(readAiEvalCase({ ...doc, source: noCal })).toBeNull();
    expect(readAiEvalCase({ ...doc, source: { ...doc.source, board: null } })).toBeNull();
    // 証拠金の不正な値は既定に戻す（読めないにしない）
    const r = readAiEvalCase({ ...doc, source: { ...doc.source, margin: { factorPct: 'x' } } });
    expect(r?.source.margin.factorPct).toBeTypeOf('number');
  });

  it('作り直せないポジションの文書は例外（ai:eval が件の失敗にする）', () => {
    const s = source();
    expect(() =>
      aiEnvFromCase({
        ...s,
        position: { ...s.position, schema_version: 99 } as unknown as typeof s.position,
      }),
    ).toThrow();
  });

  it('先物の足・IV の日次の値は使ったときだけ（usedTools）・ファイル名', () => {
    expect([...usedTools(messages)]).toEqual(['evaluate_scenario']);
    expect(aiEvalFileName(new Date(2026, 9, 22, 15, 4, 5).getTime())).toBe(
      'ai-eval-20261022-150405.json',
    );
    expect(aiEvalSource({ ...state, chain: null }, margin, undefined, NOW)).toBeNull();
  });

  it('[評価に残す] は 1 回の返答の最後の text だけ（前置き・続いている turn には出さない）', () => {
    // m1 = 診断の答え、m3 = 前置き + tool_use（出さない）、m5 = ツールの往復の後の答え、m7 = 定型の答え
    expect([...keepKeys(chat)]).toEqual(['m1b0', 'm5b0', 'm7b0']);
    // 続いている turn（流れている途中・ツールの往復の途中）の最後の返答には出さない
    const live = { ...chat, turn: {} as NonNullable<AiChatState['turn']> };
    expect([...keepKeys(live)]).toEqual(['m1b0', 'm5b0']);
    // 最後が tool_use で止まった（ツールの結果を待つ）返答には出さない
    expect([...keepKeys({ ...chat, messages: messages.slice(0, 4) })]).toEqual(['m1b0']);
    expect([...keepKeys(INITIAL_AI_CHAT)]).toEqual([]);
  });

  it('送ったときの材料の控え: 会話の後に画面を変えても、押した返答の発言を送ったときの材料で同じ文脈', () => {
    const sent = source();
    let log = recordSource([], 0, sent);
    // 2 発言目の後にシナリオ・足を変えた画面（別の材料）
    const moved = reduce(state, { type: 'setScenario', patch: { dX: 1500, days: 3 } });
    const later = aiEvalSource(moved, margin, PROFILE, NOW);
    if (!later) throw new Error('later');
    expect(later.position).not.toEqual(sent.position);
    const tech = synthTechnicalsData();
    log = withToolData(log, tech, null);
    log = recordSource(log, 6, later);
    // m1・m5 は 1 発言目・2 発言目（控えは at 0 だけ）の材料、m7 は at 6 の材料
    const s1 = sourceAt(log, 5);
    expect(s1?.position).toEqual(sent.position);
    expect(s1?.technicals).toBe(tech);
    const env1 = aiEnvFromCase(s1 ?? sent);
    expect(contextKey(buildAiContext(env1))).toBe(contextKey(context));
    expect(sourceAt(log, 7)?.position).toEqual(later.position);
    // 前の控えのツールの材料を引き継ぐ
    expect(sourceAt(log, 7)?.technicals).toBe(tech);
    expect(sourceAt(log, 0)).toBeNull();
    // 失敗して捨てた発言の控え（同じ位置以降）は新しい控えで置き換える
    expect(recordSource(log, 6, sent).map((e) => e.at)).toEqual([0, 6]);
    // 保存 → 読み直しで先物の足・IV の日次の値も通る
    const doc = aiEvalCase({
      chat,
      answerKey: 'm5b0',
      source: { ...(s1 ?? sent), iv_stats: synthIvStatsData() },
      note: '',
      now: NOW,
    });
    const read = readAiEvalCase(JSON.parse(JSON.stringify(doc)));
    expect(read?.source.technicals?.daily.length).toBe(tech.daily.length);
    expect(read?.source.iv_stats?.days.length).toBeGreaterThan(0);
  });

  it('先物の足・IV の日次の値の形が壊れたファイルは読まない', () => {
    const doc = JSON.parse(
      JSON.stringify(aiEvalCase({ chat, answerKey: 'm7b0', source: source(), note: '', now: NOW })),
    );
    const bad = (k: string, v: unknown) =>
      readAiEvalCase({ ...doc, source: { ...doc.source, [k]: v } });
    expect(bad('technicals', {})).toBeNull();
    expect(bad('technicals', { daily: [{ t: 1 }], hourly: [] })).toBeNull();
    expect(bad('iv_stats', { days: 'x', now: null })).toBeNull();
    expect(bad('iv_stats', { days: [], now: { t: 1 } })).toBeNull();
    expect(bad('iv_stats', { days: [], now: null, hourly: [{ t: 1 }] })).toBeNull();
    expect(bad('technicals', JSON.parse(JSON.stringify(synthTechnicalsData())))).not.toBeNull();
  });

  it('メモの表示: 制御文字を空白にして長さを切る', () => {
    expect(noteLine('数字が\n違う\u001b[31m')).toBe('数字が 違う [31m');
    expect(noteLine('あ'.repeat(100), 10)).toBe(`${'あ'.repeat(10)}…`);
  });
});

describe('保有の会話（#302）', () => {
  it('保有のタブ・ほかの保有の数を記録し、作り直した文脈が元と同じ（held・other_held を含む）', () => {
    const held = reduce(state, { type: 'setTabHeld', held: true });
    const envHeld = aiEnvFromState(held, margin, PROFILE, 2);
    if (!envHeld) throw new Error('env');
    const ctx = buildAiContext(envHeld);
    expect(ctx.position?.held).toBe(true);
    expect(ctx.position?.other_held).toBe(2);
    const src = aiEvalSource(held, margin, PROFILE, NOW, 2);
    if (!src) throw new Error('source');
    expect(src.other_held).toBe(2);
    const read = readAiEvalCase(
      JSON.parse(
        JSON.stringify(
          aiEvalCase({
            chat: { ...chat, context: ctx, lastKey: contextKey(ctx) },
            answerKey: 'm7b0',
            source: src,
            note: '',
            now: NOW,
            log,
          }),
        ),
      ),
    );
    if (!read) throw new Error('read');
    expect(read.source.other_held).toBe(2);
    expect(contextKey(buildAiContext(aiEnvFromCase(read.source)))).toBe(contextKey(ctx));
    // 保有でない記録には other_held を書かない（変更前と同じ形）
    expect('other_held' in source()).toBe(false);
  });
});

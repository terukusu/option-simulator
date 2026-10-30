import { describe, expect, it } from 'vitest';
import type { AiContext, AiEvent, AiStatus } from '../../data/aiStream';
import { BOOK_KEY } from '../../ui/book';
import { BOARD_KEY, serializeWorkspace, toSaved, WORKSPACE_KEY } from '../../ui/persist';
import { PREFS_KEY } from '../../ui/prefs';
import { initialState } from '../../ui/state';
import {
  AI_SESSION_KEY,
  type AiChatAction,
  type AiChatState,
  type AiGate,
  aiChatReduce,
  aiErrorText,
  applyDraft,
  askPlan,
  atLimit,
  chatGroups,
  chatItems,
  DIAGNOSE_TEXT,
  decodeAiChat,
  diagnoseBlocked,
  diagnoseProminent,
  encodeAiChat,
  footReason,
  HOLD_END_RATIO,
  holdAfterDone,
  INITIAL_AI_CHAT,
  MAX_MESSAGES,
  MAX_TOOL_ROUNDS,
  nearLimit,
  numberSources,
  remainingText,
  requestOf,
  sendBlocked,
  sentShown,
  TOOL_LIMIT_NOTE,
  toolResultBlocks,
  turnSent,
} from '../../ui/view/aiChat';
import { checkNumbers } from '../../ui/view/aiNumbers';
import { AI_PRESETS, presetBlocked } from '../../ui/view/aiPresets';
import { toolCard } from '../../ui/view/aiTools';

/** Node の fs（@types/node を足さないため型はここで最小限に書く。tests/ui/aiAsk.test.ts と同じ） */
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/**
 * #135 AC8: AI のチャットの状態（ui/view/aiChat.ts）。送信・イベント・ツールの往復・失敗・中止・保存の形・押せない理由。
 * 文脈・値は架空。
 */

const CTX = (days: number): AiContext => ({
  snapshot: { snapshot_at: '2026-10-13T21:31:00+09:00', source: 'synthetic', delayed_minutes: 15 },
  scenario: { days, iv_shift_pt: 0, x_range: [60000, 70000] },
  precomputed: { tail_table: { rows: [{ shock_pct: -10, sq_pnl_yen: -1234567 }] } },
});
const run = (s: AiChatState, ...as: AiChatAction[]) => as.reduce(aiChatReduce, s);
const ev = (event: AiEvent): AiChatAction => ({ type: 'event', event });
const DONE_TEXT = (text: string): AiChatAction =>
  ev({
    type: 'done',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '見る', signature: 'c2ln' },
      { type: 'text', text },
    ],
    remaining_usd: 2.5,
  });
const STATUS: AiStatus = {
  schema_version: 1,
  enabled: true,
  model: 'claude-opus-5-5',
  credential: 'api_key',
  counted: true,
  limit_usd: 3,
  remaining_usd: 2.4,
  resets_at: '2026-10-20T00:00:00+09:00',
};
const GATE: AiGate = { hasChain: true, legCount: 2, status: STATUS };

/** 1 回目の診断を終えた会話 */
const first = run(
  INITIAL_AI_CHAT,
  { type: 'begin', kind: 'diagnose', text: DIAGNOSE_TEXT, now: 1000 },
  { type: 'send', context: CTX(0), key: 'k0' },
  ev({ type: 'accepted', remaining_usd: 2.7, limit_usd: 3, counted: true }),
  ev({ type: 'progress', phase: 'thinking' }),
  ev({ type: 'thinking', text: '見る' }),
  ev({ type: 'text', text: '## 弱点 1: 下落\n−10% で 1,235 千円の損' }),
  DONE_TEXT('## 弱点 1: 下落\n−10% で 1,235 千円の損'),
);

describe('aiChatReduce', () => {
  it('begin → 押した瞬間に「計算中」、send で最初の文脈を固定して発言を足す', () => {
    const a = aiChatReduce(INITIAL_AI_CHAT, {
      type: 'begin',
      kind: 'diagnose',
      text: DIAGNOSE_TEXT,
      now: 5,
    });
    expect(a.turn?.phase).toBe('computing');
    expect(a.messages).toEqual([]);
    const b = aiChatReduce(a, { type: 'send', context: CTX(0), key: 'k0' });
    expect(b.turn?.phase).toBe('sending');
    expect(b.context).toEqual(CTX(0));
    expect(requestOf(b)).toEqual({
      schema_version: 1,
      kind: 'diagnose',
      context: CTX(0),
      messages: [{ role: 'user', content: [{ type: 'text', text: DIAGNOSE_TEXT }] }],
    });
    // 送信中は 2 回目の begin を受けない
    expect(aiChatReduce(b, { type: 'begin', kind: 'chat', text: 'x', now: 6 })).toBe(b);
  });

  it('イベントで進み具合が変わり、done で返答を履歴に足して終わる', () => {
    expect(first.turn).toBeNull();
    expect(first.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(first.remainingUsd).toBe(2.5);
    const items = chatItems(first);
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'answer']);
  });

  it('2 回目: 文脈が変われば context_update を足し、最初の context は変えない。同じなら足さない', () => {
    const changed = run(
      first,
      { type: 'begin', kind: 'chat', text: '日数を変えた', now: 2000 },
      { type: 'send', context: CTX(7), key: 'k7' },
    );
    expect(changed.context).toEqual(CTX(0));
    expect(changed.messages[2]?.content).toEqual([
      { type: 'text', text: '日数を変えた' },
      { type: 'context_update', context: CTX(7) },
    ]);
    expect(changed.lastKey).toBe('k7');
    const same = run(
      first,
      { type: 'begin', kind: 'chat', text: '続けて', now: 2000 },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    expect(same.messages[2]?.content).toEqual([{ type: 'text', text: '続けて' }]);
    // 前の履歴はそのまま（追記だけ）
    expect(JSON.stringify(changed.messages.slice(0, 2))).toBe(JSON.stringify(first.messages));
  });

  it('ツールの往復: tool_use で止まり、結果を足して次の要求。上限で知らせ、超えたら終える', () => {
    let s = run(
      first,
      { type: 'begin', kind: 'chat', text: '−6% なら？', now: 3000 },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    const toolDone = (id: string): AiChatAction =>
      ev({
        type: 'done',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id,
            name: 'evaluate_scenario',
            input: { dx_pct: -6, days: 3, iv_shift_pt: 5 },
          },
        ],
        remaining_usd: 2.2,
      });
    const calls: string[] = [];
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      s = aiChatReduce(s, toolDone(`t${i}`));
      expect(s.turn?.awaitingTools).toBe(true);
      const blocks = toolResultBlocks(s, (name) => {
        calls.push(name);
        return { pnl_yen: -2119796 };
      });
      expect(blocks).toEqual([
        {
          type: 'tool_result',
          tool_use_id: `t${i}`,
          content: [{ type: 'text', text: '{"pnl_yen":-2119796}' }],
        },
      ]);
      s = aiChatReduce(s, { type: 'toolResults', blocks });
      expect(s.turn?.rounds).toBe(i + 1);
    }
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
    // 上限: ツールを実行せずに error と知らせの文
    s = aiChatReduce(s, toolDone('t9'));
    const last = toolResultBlocks(s, () => {
      throw new Error('呼ばない');
    });
    expect(last).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't9',
        content: [{ type: 'text', text: '{"error":"tool_limit"}' }],
        is_error: true,
      },
      { type: 'text', text: TOOL_LIMIT_NOTE },
    ]);
    s = aiChatReduce(s, { type: 'toolResults', blocks: last });
    // ツールのカードは結果と組になる
    const cards = chatItems(s).filter((i) => i.kind === 'tool');
    expect(cards[0]).toMatchObject({ name: 'evaluate_scenario', result: { pnl_yen: -2119796 } });
    // それでもツールを求めたら、その発言の履歴を戻して終える（最後は assistant = 交互の形）
    s = aiChatReduce(s, toolDone('t10'));
    expect(s.turn).toBeNull();
    expect(s.failed).toMatchObject({ code: 'tool_limit', userText: '−6% なら？' });
    expect(s.messages).toEqual(first.messages);
    expect(s.messages.at(-1)?.role).toBe('assistant');
    expect(chatItems(s).at(-1)).toMatchObject({ kind: 'answer', failed: 'tool_limit' });
    // 次の発言の要求は user / assistant の交互（中継の順序の検査を通る形）
    const next = run(
      s,
      { type: 'begin', kind: 'chat', text: '続けて', now: 4000 },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    const roles = requestOf(next)?.messages.map((m) => m.role) ?? [];
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(roles.every((r, i) => r === (i % 2 === 0 ? 'user' : 'assistant'))).toBe(true);
  });

  it('#242 ツールのカード: 結果を待つ間は「計算中…」、返らないまま終われば「結果なし」、エラーだけ「計算できなかった」', () => {
    const useOf = (id: string, name: string) => ({
      type: 'tool_use' as const,
      id,
      name,
      input: name === 'technicals' ? { timeframes: ['daily'] } : {},
    });
    const waiting = run(
      first,
      { type: 'begin', kind: 'chat', text: 'RSI は？', now: 3000 },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({
        type: 'done',
        stop_reason: 'tool_use',
        content: [
          useOf('a', 'technicals'),
          useOf('b', 'evaluate_scenario'),
          useOf('c', 'propose_position'),
        ],
        remaining_usd: 2.2,
      }),
    );
    expect(waiting.turn?.awaitingTools).toBe(true);
    const tools = (s: AiChatState) => chatItems(s).filter((i) => i.kind === 'tool');
    // (1) 待ち: 失敗の文ではなく「足を読み込み中…」/「計算中…」
    const pending = tools(waiting);
    expect(pending.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
    const lines = pending.map((i) => toolCard(i.name, i.input, i.result, i.status));
    expect(lines.map((c) => c.lines)).toEqual([['足を読み込み中…'], ['計算中…'], ['計算中…']]);
    expect(lines.every((c) => c.pending === true)).toBe(true);
    expect(toolCard('iv_stats', {}, null, 'pending').lines).toEqual(['足を読み込み中…']);
    // (2) 結果がエラー: 今どおり「計算できなかった（理由）」/「提案を作れなかった（理由）」
    const blocks = toolResultBlocks(waiting, (name) =>
      name === 'evaluate_scenario' ? { pnl_yen: -1000 } : { error: 'not_on_board' },
    );
    const got = tools(aiChatReduce(waiting, { type: 'toolResults', blocks }));
    expect(got.map((i) => i.status)).toEqual(['error', 'ok', 'error']);
    const cards = got.map((i) => toolCard(i.name, i.input, i.result, i.status));
    expect(cards[0]?.lines).toEqual(['計算できなかった（not_on_board）']);
    expect(cards[2]?.lines).toEqual(['提案を作れなかった（板に無い限月・行使価格）']);
    expect(cards.some((c) => c.pending)).toBe(false);
    // (3) turn が無いのに結果の無い tool_use が残った場合（防御。中止・失敗・上限は fail() が発言ごと戻し、再読み込みは
    // decodeAiChat が末尾の tool_use を落とすので普通は届かない。ここでは restore で直接作る）: 「結果なし」（失敗と言わない）
    const ended = aiChatReduce(INITIAL_AI_CHAT, {
      type: 'restore',
      saved: { context: CTX(0), lastKey: 'k0', messages: waiting.messages },
    });
    const missing = tools(ended);
    expect(missing.map((i) => i.status)).toEqual(['missing', 'missing', 'missing']);
    for (const i of missing) {
      const c = toolCard(i.name, i.input, i.result, i.status);
      expect(c.lines).toEqual(['結果なし']);
      expect(c.pending).toBeUndefined();
    }
  });

  it('失敗・終端なし・中止: その発言の履歴を戻し、途中の文と理由を残す', () => {
    const mid = run(
      first,
      { type: 'begin', kind: 'chat', text: '日数を変えた', now: 2000 },
      { type: 'send', context: CTX(7), key: 'k7' },
      ev({ type: 'text', text: '途中まで' }),
    );
    for (const a of [
      ev({ type: 'incomplete' }),
      ev({ type: 'error', code: 'timeout' }),
      { type: 'fail', code: 'aborted' } as AiChatAction,
    ]) {
      const f = aiChatReduce(mid, a);
      expect(f.turn).toBeNull();
      expect(f.messages).toEqual(first.messages);
      expect(f.lastKey).toBe('k0');
      expect(f.failed?.partial).toBe('途中まで');
      expect(f.failed?.userText).toBe('日数を変えた');
    }
    expect(aiChatReduce(mid, ev({ type: 'incomplete' })).failed?.code).toBe('incomplete');
    const items = chatItems(aiChatReduce(mid, ev({ type: 'error', code: 'timeout' })));
    expect(items.at(-1)).toMatchObject({ kind: 'answer', text: '途中まで', failed: 'timeout' });
    // 事前の失敗（429 の残りつき）
    const r = aiChatReduce(mid, { type: 'fail', code: 'budget_exceeded', remainingUsd: 0.05 });
    expect(r.failed?.remainingUsd).toBe(0.05);
    // 表示の項目まで残りが届き、文言に残りの額が出る（AC8）
    const row = chatItems(r).at(-1);
    expect(row).toMatchObject({ kind: 'answer', failed: 'budget_exceeded', remainingUsd: 0.05 });
    if (row?.kind !== 'answer' || row.failed === null) throw new Error('失敗の行が無い');
    expect(aiErrorText(row.failed, row.remainingUsd ?? null)).toContain('残り $0.05');
  });

  it('stop_reason の refusal / max_tokens は知らせとして残す', () => {
    const s = run(
      first,
      { type: 'begin', kind: 'chat', text: 'x', now: 1 },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({
        type: 'done',
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '長い' }],
        remaining_usd: null,
      }),
    );
    expect(s.stop).toBe('max_tokens');
    expect(s.remainingUsd).toBe(2.5);
  });

  it('[新しい会話] で消える', () => {
    expect(aiChatReduce(first, { type: 'reset' })).toBe(INITIAL_AI_CHAT);
  });

  it('照合の値: 最初の文脈・文脈の更新・ツールの結果', () => {
    const s = run(
      first,
      { type: 'begin', kind: 'chat', text: 'x', now: 1 },
      { type: 'send', context: CTX(7), key: 'k7' },
    );
    const src = numberSources(s);
    expect(src).toHaveLength(2);
    expect(src[1]).toEqual(CTX(7));
  });
});

describe('保存（sessionStorage の 1 キー）', () => {
  it('書いて読める・turn と失敗は書かない', () => {
    const text = encodeAiChat(first);
    expect(decodeAiChat(text)).toEqual({
      context: first.context,
      lastKey: 'k0',
      messages: first.messages,
    });
    const restored = aiChatReduce(INITIAL_AI_CHAT, {
      type: 'restore',
      saved: decodeAiChat(text) as NonNullable<ReturnType<typeof decodeAiChat>>,
    });
    expect(restored.messages).toEqual(first.messages);
    expect(JSON.parse(text)).not.toHaveProperty('turn');
  });

  it('壊れた・版の違う・形の違う値は捨てる。送る途中で閉じた発言は落として次に送れる形に', () => {
    expect(decodeAiChat(null)).toBeNull();
    expect(decodeAiChat('{')).toBeNull();
    expect(
      decodeAiChat(JSON.stringify({ v: 2, context: null, lastKey: null, messages: [] })),
    ).toBeNull();
    expect(
      decodeAiChat(JSON.stringify({ v: 1, context: null, lastKey: null, messages: [1] })),
    ).toBeNull();
    const sending = run(
      first,
      { type: 'begin', kind: 'chat', text: 'x', now: 1 },
      { type: 'send', context: CTX(7), key: 'k7' },
    );
    const d = decodeAiChat(encodeAiChat(sending));
    expect(d?.messages).toEqual(first.messages);
    expect(d?.lastKey).toBeNull();
  });

  it('キーは 1 つで、作業の保存・保存一覧・端末の設定・板と別。作業の保存・URL の形式に AI のキーは無い', () => {
    expect(new Set([AI_SESSION_KEY, WORKSPACE_KEY, BOOK_KEY, PREFS_KEY, BOARD_KEY]).size).toBe(5);
    const ws = serializeWorkspace(initialState, 0);
    const saved = JSON.stringify(toSaved(initialState, 0));
    for (const t of [ws, saved]) {
      expect(t).not.toMatch(/"ai[A-Za-z_]*"|optsim\.ai|"messages"/);
    }
  });
});

describe('#136 AC2 [AI に聞く]（kind ask と場所の topic）', () => {
  const ASK = '［AI に聞く］指標 · テール ›「満期 最大損失」';
  const toolUse: AiChatAction = ev({
    type: 'done',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'tail_table', input: {} }],
    remaining_usd: 2.2,
  });
  it('ask の要求は kind ask と topic を持ち、ツールの往復の後の要求でも保つ', () => {
    let s = run(
      first,
      { type: 'begin', kind: 'ask', text: ASK, now: 2000, topic: 'tile.maxLoss' },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    expect(requestOf(s)).toMatchObject({ kind: 'ask', topic: 'tile.maxLoss' });
    s = run(s, toolUse, {
      type: 'toolResults',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: '{"rows":[]}' }],
        },
      ],
    });
    expect(requestOf(s)).toMatchObject({ kind: 'ask', topic: 'tile.maxLoss' });
  });

  it('chat・diagnose の要求には topic が無い（begin に付けても落とす）', () => {
    const c = run(
      first,
      { type: 'begin', kind: 'chat', text: 'x', now: 2000, topic: 'tile.maxLoss' },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    expect(requestOf(c)).not.toHaveProperty('topic');
    const d = run(
      INITIAL_AI_CHAT,
      { type: 'begin', kind: 'diagnose', text: DIAGNOSE_TEXT, now: 1 },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    expect(requestOf(d)).not.toHaveProperty('topic');
  });

  it('失敗の後の [もう一度] の材料（failed）に kind と topic が残る', () => {
    const f = run(
      first,
      { type: 'begin', kind: 'ask', text: ASK, now: 2000, topic: 'tail.pnl' },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({ type: 'error', code: 'timeout' }),
    );
    expect(f.failed).toMatchObject({ kind: 'ask', topic: 'tail.pnl', userText: ASK });
    // 履歴は戻り、表示は user の吹き出しに質問の文
    expect(f.messages).toEqual(first.messages);
    expect(chatItems(f).find((i) => i.key === 'failed-user')).toMatchObject({ text: ASK });
  });

  it('askPlan: 送れるなら send、送れない理由があれば入力欄に入れる（理由つき）', () => {
    expect(askPlan(INITIAL_AI_CHAT, GATE)).toBe('send');
    // 足 0 本でも質問は送れる（[このポジションを診断] と違う）
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, legCount: 0 })).toBe('send');
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: { ...STATUS, enabled: false } })).toEqual({
      draft: 'AI は無効です（管理者の設定）',
    });
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: { ...STATUS, remaining_usd: 0 } })).toEqual({
      draft: '今日の上限に達しました（日付が変わると戻ります）',
    });
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, hasChain: false })).toEqual({
      draft: '板がありません（板を読んでから送ってください）',
    });
    const sending = run(INITIAL_AI_CHAT, { type: 'begin', kind: 'chat', text: 'x', now: 1 });
    expect(askPlan(sending, GATE)).toEqual({ draft: '送信中です' });
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: { error: 'network' } })).toMatchObject({
      draft: expect.stringContaining('読めません'),
    });
  });

  it('レビュー指摘 1: 状態をまだ読んでいなければ wait（送らない）。ほかの理由があればそれで入力欄へ', () => {
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: null })).toBe('wait');
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: null, hasChain: false })).toEqual({
      draft: '板がありません（板を読んでから送ってください）',
    });
    const sending = run(INITIAL_AI_CHAT, { type: 'begin', kind: 'chat', text: 'x', now: 1 });
    expect(askPlan(sending, { ...GATE, status: null })).toEqual({ draft: '送信中です' });
    // 読み終わった後の判定（無効・上限は送らない）
    expect(askPlan(INITIAL_AI_CHAT, { ...GATE, status: { ...STATUS, enabled: false } })).not.toBe(
      'send',
    );
  });

  it('レビュー指摘 2: 書きかけの文は上書きしない（空・前に入れた質問のまま・同じ文なら入れる）', () => {
    expect(applyDraft('', null, 'Q1')).toBe('set');
    expect(applyDraft('  \n', null, 'Q1')).toBe('set');
    expect(applyDraft('Q1', 'Q1', 'Q2')).toBe('set');
    expect(applyDraft('Q2', null, 'Q2')).toBe('set');
    expect(applyDraft('打ちかけ', null, 'Q1')).toBe('keep');
    expect(applyDraft('Q1 に足した', 'Q1', 'Q2')).toBe('keep');
  });

  it('レビュー指摘 3: 足元の理由は送信の理由（送信中も）、無ければ診断だけの理由', () => {
    expect(footReason(INITIAL_AI_CHAT, GATE)).toBeNull();
    const sending = run(INITIAL_AI_CHAT, { type: 'begin', kind: 'chat', text: 'x', now: 1 });
    expect(footReason(sending, GATE)).toBe('送信中です');
    expect(footReason(INITIAL_AI_CHAT, { ...GATE, hasChain: false })).toBe(
      '板がありません（板を読んでから送ってください）',
    );
    expect(footReason(INITIAL_AI_CHAT, { ...GATE, legCount: 0 })).toContain('足がありません');
  });
});

describe('#136 照合の出所: [AI に聞く] の質問の表示の値・β の代表の点の上乗せ', () => {
  const ASK_Q = [
    '［AI に聞く］指標 · テール ›「合計グリーク」',
    '画面の表示（金額の単位: 千円（自動））:',
    '- 合計グリーク: −0.013 枚（ミニ −0.13）',
    '- Γ: −0.0038 / 100 円',
    '- Θ: +12 千円 / 日',
    '- 原資産 −10%（60,000 円）: SQ −987 千円（×2.5）',
    '聞きたいこと: この値は何を表し、なぜこの値になっているか、今のポジションにとってどういう意味があるかを教えてください。',
    '説明の節: マニュアル 8.1「タイル」・設計書 5.6「損益・指標・グリーク」',
  ].join('\n');
  const ANSWER =
    'Δ は −0.013 枚（ミニ −0.13 枚）、Γ は −0.0038 / 100 円、Θ は +12 千円 / 日です。−10%（60,000 円）の SQ は −987 千円（×2.5）。';
  const conv = (kind: 'ask' | 'chat', text: string, ctx = CTX(0)) =>
    run(
      INITIAL_AI_CHAT,
      { type: 'begin', kind, text, now: 1, topic: 'tile.greeks' },
      { type: 'send', context: ctx, key: 'k0' },
      DONE_TEXT(ANSWER),
    );
  it('[AI に聞く] の質問に入れた表示の値を引いた答えは照合が一致する（不一致 0）', () => {
    const r = checkNumbers(ANSWER, numberSources(conv('ask', ASK_Q)));
    expect(r.tokens.filter((t) => t.status === 'unmatched').map((t) => t.raw)).toEqual([]);
    expect(r.matched).toBeGreaterThanOrEqual(8);
  });
  it('IV 推移の表示の値（単位の無い数）は % で引いても一致する。金額の桁は単位つきの表示だけ', () => {
    const q = [
      '［AI に聞く］IV 推移 ›「ATM IV（30 日固定）」',
      '画面の表示（単位: %）:',
      '- 最新の足（1 時間足）: 10/13 21:00 始 20.40 · 高 21.90 · 安 20.20 · 終 21.40',
      '- 今（今の板から計算）: 21.52',
    ].join('\n');
    const src = numberSources(conv('ask', q));
    expect(checkNumbers('終値は 21.40%、今は 21.52% です', src).unmatched).toBe(0);
    // 単位の無い表示の数を金額としては引かない
    expect(checkNumbers('損益は 21.40 千円', src).unmatched).toBe(1);
  });
  it('#140: ふつうの質問の文の数もその会話の出所にする。ほかの会話の質問は出所にしない', () => {
    const plain = ASK_Q.replace('［AI に聞く］', '');
    expect(checkNumbers(ANSWER, numberSources(conv('chat', plain))).unmatched).toBe(0);
    expect(checkNumbers(ANSWER, numberSources(conv('chat', 'x'))).unmatched).toBeGreaterThan(0);
    // 質問の値と違う数は今どおり不一致
    expect(checkNumbers('Θ は +13 千円 / 日', numberSources(conv('ask', ASK_Q))).unmatched).toBe(1);
  });
  it('β の定義: 実測の形の代表の点の上乗せ β × g（シナリオの β から）は一致し、違う pt は数える', () => {
    const ctx: AiContext = {
      ...CTX(0),
      scenario: { days: 0, iv_shift_pt: 0, x_range: [60000, 70000], beta: 1 },
    };
    const src = numberSources(conv('chat', 'x', ctx));
    // g(−3%) = 0.75・g(−6%) = 3.45・g(−10%) = 19.45（BETA_SHAPE）
    const r = checkNumbers('β 1.0 なので −10% で IV が +19.45pt、−6% で +3.45pt 上がります', src);
    expect(r.tokens.find((t) => t.raw === '+19.45pt')?.status).toBe('matched');
    expect(r.tokens.find((t) => t.raw === '+3.45pt')?.status).toBe('matched');
    expect(
      checkNumbers('−10% で +19.5pt', src).tokens.find((t) => t.raw === '+19.5pt')?.status,
    ).toBe('matched');
    // 直線の読み方（1% あたり β pt = −10% で +10pt）は数える
    expect(
      checkNumbers('−10% で +10.0pt', src).tokens.find((t) => t.raw === '+10.0pt')?.status,
    ).toBe('unmatched');
    // β 2 なら 2 倍
    const src2 = numberSources(
      conv('chat', 'x', { ...ctx, scenario: { ...ctx.scenario, beta: 2 } } as AiContext),
    );
    expect(checkNumbers('+38.9pt', src2).tokens.find((t) => t.raw === '+38.9pt')?.status).toBe(
      'matched',
    );
    // β が無い文脈では足さない
    expect(checkNumbers('+19.45pt', numberSources(conv('chat', 'x'))).tokens[0]?.status).toBe(
      'unmatched',
    );
  });
});

describe('#156 照合の出所: 自分の前提の文の数', () => {
  const PROFILE = '資金 5,000 千円。1 回の損失は 300 千円まで。デルタは 0.5 枚以内';
  const ANS =
    '前提の許容損失 300 千円に対して、資金 5,000 千円の範囲で、デルタは 0.5 枚以内に収めます';
  const conv = (ctx: AiContext) =>
    run(
      INITIAL_AI_CHAT,
      { type: 'begin', kind: 'chat', text: 'x', now: 1 },
      { type: 'send', context: ctx, key: 'k0' },
      DONE_TEXT(ANS),
    );
  it('最初の文脈の前提の数を引いた答えは一致する。前提が無ければ不一致', () => {
    const r = checkNumbers(ANS, numberSources(conv({ ...CTX(0), profile: { text: PROFILE } })));
    expect(r.tokens.filter((t) => t.status === 'unmatched').map((t) => t.raw)).toEqual([]);
    expect(r.matched).toBeGreaterThanOrEqual(3);
    expect(checkNumbers(ANS, numberSources(conv(CTX(0)))).unmatched).toBeGreaterThan(0);
    // 前提と違う数は今どおり不一致
    const src = numberSources(conv({ ...CTX(0), profile: { text: PROFILE } }));
    expect(checkNumbers('損失は 400 千円まで', src).unmatched).toBe(1);
  });
  it('会話の途中の文脈の更新（context_update）の前提の数も出所にする', () => {
    const s = run(
      conv(CTX(0)),
      { type: 'begin', kind: 'chat', text: 'y', now: 2 },
      { type: 'send', context: { ...CTX(0), profile: { text: PROFILE } }, key: 'k1' },
    );
    expect(s.messages.at(-1)?.content.some((b) => b.type === 'context_update')).toBe(true);
    expect(checkNumbers(ANS, numberSources(s)).unmatched).toBe(0);
  });
});

describe('#263 送った発言の位置（発言ごとの塊・送った発言が会話に出たか）', () => {
  const keys = (s: AiChatState) => chatGroups(chatItems(s)).map((g) => g.key);
  it('発言ごとの塊: 会話なしは 0 個、user の項目から次の user の手前まで、ツールの結果だけの user は区切らない', () => {
    expect(chatGroups(chatItems(INITIAL_AI_CHAT))).toEqual([]);
    // 1 回目: user・thinking・answer = 1 塊
    expect(chatGroups(chatItems(first)).map((g) => g.items.map((i) => i.kind))).toEqual([
      ['user', 'thinking', 'answer'],
    ]);
    const second = run(
      first,
      { type: 'begin', kind: 'chat', text: '−6% なら？', now: 2000 },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({
        type: 'done',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'evaluate_scenario', input: { dx_pct: -6 } }],
        remaining_usd: 2.4,
      }),
    );
    const withResult = aiChatReduce(second, {
      type: 'toolResults',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: '{"pnl_yen":-1}' }],
        },
      ],
    });
    expect(withResult.messages.at(-1)?.role).toBe('user');
    const gs = chatGroups(chatItems(withResult));
    expect(gs.map((g) => g.key)).toEqual(['m0', 'm2']);
    expect(gs[1]?.items[0]).toMatchObject({ kind: 'user', text: '−6% なら？' });
    expect(gs[1]?.items.map((i) => i.kind)).toEqual(['user', 'tool']);
    // 新しい発言を送っても前の塊の key は変わらない（作り直さない）
    expect(keys(first)[0]).toBe(gs[0]?.key);
  });

  it('先頭に user の無い部分は key head の塊', () => {
    const gs = chatGroups([
      { kind: 'answer', text: 'a', key: 'x', live: false, failed: null },
      { kind: 'user', text: 'q', updated: false, key: 'm1' },
    ]);
    expect(gs.map((g) => [g.key, g.items.length])).toEqual([
      ['head', 1],
      ['m1', 1],
    ]);
  });

  it('失敗した発言（failed-user）は最後の塊の先頭 = 送ったときと同じ塊の位置', () => {
    const mid = run(
      first,
      { type: 'begin', kind: 'chat', text: '日数を変えた', now: 2000 },
      { type: 'send', context: CTX(7), key: 'k7' },
      ev({ type: 'text', text: '途中まで' }),
    );
    const before = keys(mid);
    const gs = chatGroups(chatItems(aiChatReduce(mid, ev({ type: 'error', code: 'timeout' }))));
    expect(gs).toHaveLength(before.length);
    expect(gs.slice(0, -1).map((g) => g.key)).toEqual(before.slice(0, -1));
    expect(gs.at(-1)?.items[0]).toMatchObject({
      kind: 'user',
      key: 'failed-user',
      text: '日数を変えた',
    });
  });

  it('送った発言が会話に入ったか: turn なし・computing の間は false、send の後は流れの間ずっと true', () => {
    expect(turnSent(INITIAL_AI_CHAT)).toBe(false);
    expect(turnSent(first)).toBe(false);
    const begun = aiChatReduce(first, {
      type: 'begin',
      kind: 'ask',
      text: '［AI に聞く］',
      now: 3,
    });
    expect(turnSent(begun)).toBe(false);
    const sent = aiChatReduce(begun, { type: 'send', context: CTX(0), key: 'k0' });
    expect(turnSent(sent)).toBe(true);
    expect(turnSent(aiChatReduce(sent, ev({ type: 'text', text: '途中' })))).toBe(true);
    expect(turnSent(aiChatReduce(sent, DONE_TEXT('おわり')))).toBe(false);
  });

  it('送った発言が会話に出たか（合わせてよいか）: 流れの途中・終わって失敗が残る（送る前の失敗を含む）は true', () => {
    expect(sentShown(INITIAL_AI_CHAT)).toBe(false);
    expect(sentShown(first)).toBe(false);
    const begun = aiChatReduce(first, { type: 'begin', kind: 'chat', text: '日数', now: 3 });
    expect(sentShown(begun)).toBe(false);
    expect(sentShown(aiChatReduce(begun, { type: 'send', context: CTX(0), key: 'k0' }))).toBe(true);
    // 送る前の失敗（板が無い: send の無いまま終わる）でも failed-user と失敗の行が出る
    const noBoard = aiChatReduce(begun, { type: 'fail', code: 'no_board' });
    expect(turnSent(noBoard)).toBe(false);
    expect(sentShown(noBoard)).toBe(true);
    expect(chatItems(noBoard).at(-2)).toMatchObject({ kind: 'user', key: 'failed-user' });
    // 次の発言を始めると失敗は消える（computing の間は合わせない）
    expect(
      sentShown(aiChatReduce(noBoard, { type: 'begin', kind: 'chat', text: '日数', now: 4 })),
    ).toBe(false);
  });
});

describe('押せない理由', () => {
  const s0 = INITIAL_AI_CHAT;
  it('足 0 本・AI 無効・残り 0・送信中・状態を読めない', () => {
    expect(diagnoseBlocked(s0, GATE)).toBeNull();
    expect(diagnoseBlocked(s0, { ...GATE, legCount: 0 })).toContain('足がありません');
    expect(sendBlocked(s0, { ...GATE, legCount: 0 })).toBeNull();
    expect(diagnoseBlocked(s0, { ...GATE, hasChain: false })).toContain('板がありません');
    expect(diagnoseBlocked(s0, { ...GATE, status: { ...STATUS, enabled: false } })).toBe(
      'AI は無効です（管理者の設定）',
    );
    expect(diagnoseBlocked(s0, { ...GATE, status: { ...STATUS, remaining_usd: 0 } })).toContain(
      '今日の上限',
    );
    // 数えない資格情報（OAuth）は残りで止めない
    expect(
      diagnoseBlocked(s0, {
        ...GATE,
        status: { ...STATUS, counted: false, remaining_usd: null, limit_usd: null },
      }),
    ).toBeNull();
    const sending = run(s0, { type: 'begin', kind: 'diagnose', text: DIAGNOSE_TEXT, now: 1 });
    expect(diagnoseBlocked(sending, GATE)).toBe('送信中です');
    expect(diagnoseBlocked(s0, { ...GATE, status: null })).toContain('読んでいます');
    expect(diagnoseBlocked(s0, { ...GATE, status: { error: 'network' } })).toContain('読めません');
    expect(diagnoseBlocked(s0, { ...GATE, legCount: 21 })).toContain('20 本');
  });

  it('上限（60 件・自由文 10 万字）の手前で新しい会話を促す', () => {
    const msgs = (n: number, len = 1) =>
      Array.from({ length: n }, (_, i) =>
        i % 2 === 0
          ? { role: 'user' as const, content: [{ type: 'text' as const, text: 'あ'.repeat(len) }] }
          : {
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: 'い'.repeat(len) }],
            },
      );
    const at = (n: number, len = 1): AiChatState => ({
      ...s0,
      context: CTX(0),
      messages: msgs(n, len),
    });
    expect(nearLimit(at(46))).toBe(false);
    expect(nearLimit(at(48))).toBe(true);
    expect(atLimit(at(48))).toBe(false);
    expect(atLimit(at(MAX_MESSAGES - 10))).toBe(true);
    expect(diagnoseBlocked(at(MAX_MESSAGES - 10), GATE)).toContain('新しい会話');
    expect(nearLimit(at(10, 8_000))).toBe(true);
    expect(atLimit(at(13, 8_000))).toBe(true);
  });

  it('残りの表示（押す前に見える）', () => {
    expect(remainingText(STATUS, null)).toBe('残り $2.40 / $3.00');
    expect(remainingText(STATUS, 1.234)).toBe('残り $1.23 / $3.00');
    expect(remainingText({ ...STATUS, counted: false }, null)).toBe('残り $—');
    expect(remainingText({ ...STATUS, limit_usd: null }, null)).toBe('残り $—');
    expect(remainingText({ ...STATUS, enabled: false }, null)).toBeNull();
  });
});

describe('#140 AC2 定型の質問（kind preset と定型の ID）', () => {
  const rebut = AI_PRESETS.find((p) => p.id === 'rebut');
  if (!rebut) throw new Error('反論の定型が無い');
  const toolUse: AiChatAction = ev({
    type: 'done',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'smile_position', input: {} }],
    remaining_usd: 2.2,
  });

  it('preset の要求は kind preset と topic（定型の ID）を持ち、ツールの往復の後の要求でも保つ', () => {
    let s = run(
      first,
      { type: 'begin', kind: 'preset', text: rebut.text, now: 2000, topic: rebut.id },
      { type: 'send', context: CTX(0), key: 'k0' },
    );
    expect(requestOf(s)).toMatchObject({ kind: 'preset', topic: 'rebut' });
    expect(s.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: rebut.text }],
    });
    s = run(s, toolUse, {
      type: 'toolResults',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: '{"expiries":[]}' }],
        },
      ],
    });
    expect(requestOf(s)).toMatchObject({ kind: 'preset', topic: 'rebut' });
  });

  it('失敗の後の [もう一度] の材料（failed）に kind preset と topic が残る', () => {
    const f = run(
      first,
      { type: 'begin', kind: 'preset', text: rebut.text, now: 2000, topic: rebut.id },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({ type: 'error', code: 'timeout' }),
    );
    expect(f.failed).toMatchObject({ kind: 'preset', topic: 'rebut', userText: rebut.text });
    expect(f.messages).toEqual(first.messages);
  });

  it('押せない理由: 足の要る 4 つは [このポジションを診断] と同じ、板の前提・IV は自由な質問と同じ', () => {
    expect(AI_PRESETS.filter((p) => p.needsLegs).map((p) => p.id)).toEqual([
      'crash',
      'rebut',
      'hedge',
      'exit',
    ]);
    const sending = run(INITIAL_AI_CHAT, { type: 'begin', kind: 'chat', text: 'x', now: 1 });
    const gates: AiGate[] = [
      GATE,
      { ...GATE, legCount: 0 },
      { ...GATE, hasChain: false },
      { ...GATE, legCount: 21 },
      { ...GATE, status: null },
      { ...GATE, status: { error: 'network' } },
      { ...GATE, status: { ...STATUS, enabled: false } },
      { ...GATE, status: { ...STATUS, remaining_usd: 0 } },
    ];
    for (const p of AI_PRESETS) {
      for (const s of [INITIAL_AI_CHAT, sending]) {
        for (const g of gates) {
          const want = p.needsLegs ? diagnoseBlocked(s, g) : sendBlocked(s, g);
          expect(presetBlocked(s, g, p)).toBe(want);
        }
      }
    }
    // 足 0 本: 崩れ方は押せない（理由つき）、板の前提は押せる
    const noLegs = { ...GATE, legCount: 0 };
    const crash = AI_PRESETS[0];
    const board = AI_PRESETS[2];
    if (!crash || !board) throw new Error('定型が足りない');
    expect(presetBlocked(INITIAL_AI_CHAT, noLegs, crash)).toBe(
      '足がありません（ポジションを組んでから押してください）',
    );
    expect(presetBlocked(INITIAL_AI_CHAT, noLegs, board)).toBeNull();
    expect(presetBlocked(sending, GATE, board)).toBe('送信中です');
  });
});

describe('#140 照合の出所: 利用者の発言の数と AI のツールの入力の値（その会話の中だけ）', () => {
  const toolUse = (input: Record<string, unknown>): AiChatAction =>
    ev({
      type: 'done',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'p1', name: 'propose_position', input }],
      remaining_usd: 2.2,
    });
  const withTool = (text: string) =>
    run(
      INITIAL_AI_CHAT,
      { type: 'begin', kind: 'chat', text, now: 1 },
      { type: 'send', context: CTX(0), key: 'k0' },
      toolUse({
        target: 'current',
        changes: [{ action: 'add', type: 'P', side: 'buy', max_loss_floor_yen: -3_000_000 }],
      }),
      {
        type: 'toolResults',
        blocks: [
          { type: 'tool_result', tool_use_id: 'p1', content: [{ type: 'text', text: '{}' }] },
        ],
      },
    );
  it('AI が渡した上限（max_loss_floor_yen）と質問の上限は一致、違う金額・単位の取り違えは数える', () => {
    const src = numberSources(withTool('最大損失を −1,000 千円に抑えるヘッジの足を足して。'));
    const r = checkNumbers('## 案 1: −1,000 千円以内\n## 案 2: −3,000 千円以内', src);
    expect(r.unmatched).toBe(0);
    expect(r.matched).toBe(2);
    expect(checkNumbers('−2,000 千円以内', src).unmatched).toBe(1);
    expect(checkNumbers('−3,000 円以内', src).unmatched).toBe(1);
  });
  it('ほかの会話（ツールも質問も無い）では出所にならない', () => {
    const src = numberSources(
      run(
        INITIAL_AI_CHAT,
        { type: 'begin', kind: 'chat', text: '弱点は？', now: 1 },
        { type: 'send', context: CTX(0), key: 'k0' },
      ),
    );
    expect(checkNumbers('−1,000 千円・−3,000 千円', src).unmatched).toBe(2);
  });
});

describe('#277 AI パネルの整理（利用者の画面に常に出る開発者向けの要素は残りだけ）', () => {
  /** 2 回目: thinking → ツール → 結果 → thinking → 返答（ツールの往復で thinking が 2 つ） */
  const twoRounds = (() => {
    const s1 = run(
      first,
      { type: 'begin', kind: 'chat', text: '−6% なら？', now: 2000 },
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({
        type: 'done',
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '計算を頼む', signature: 'c2ln' },
          { type: 'tool_use', id: 't1', name: 'evaluate_scenario', input: { dx_pct: -6 } },
        ],
        remaining_usd: 2.4,
      }),
    );
    return aiChatReduce(s1, {
      type: 'toolResults',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: '{"pnl_yen":-1}' }],
        },
      ],
    });
  })();
  const kinds = (s: AiChatState) => chatGroups(chatItems(s)).map((g) => g.items.map((i) => i.kind));

  it('考えた要約は 1 返答に 1 つ（ツールの往復の thinking を最初の位置に段落でつなぐ）', () => {
    const streaming = run(
      twoRounds,
      { type: 'send', context: CTX(0), key: 'k0' },
      ev({ type: 'thinking', text: '結果を読む' }),
    );
    // 流れの間: 前の往復の thinking に流れの thinking をつなぐ（key は最初の thinking のまま）
    const live = chatGroups(chatItems(streaming)).at(-1)?.items ?? [];
    expect(live.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool']);
    expect(live[1]).toMatchObject({ text: '計算を頼む\n\n結果を読む', live: true, key: 'm3b0' });
    const done = aiChatReduce(
      streaming,
      ev({
        type: 'done',
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '結果を読む', signature: 'c2ln' },
          { type: 'text', text: '−6% で −1 円' },
        ],
        remaining_usd: 2.3,
      }),
    );
    expect(kinds(done)).toEqual([
      ['user', 'thinking', 'answer'],
      ['user', 'thinking', 'tool', 'answer'],
    ]);
    const th = chatGroups(chatItems(done))[1]?.items[1];
    expect(th).toMatchObject({
      kind: 'thinking',
      text: '計算を頼む\n\n結果を読む',
      live: false,
      key: 'm3b0',
    });
    // 発言ごとに 1 つ（前の発言の thinking とはつながない）
    for (const g of chatGroups(chatItems(done)))
      expect(g.items.filter((i) => i.kind === 'thinking')).toHaveLength(1);
  });

  it('今日の残りは出したまま（オーナー判断 2026-10-27）', () => {
    expect(remainingText(STATUS, 2.3)).toBe('残り $2.30 / $3.00');
  });

  it('[このポジションを診断] の大きいボタンは会話が空のときだけ（以後は定型の質問の先頭のチップ）', () => {
    expect(diagnoseProminent(chatItems(INITIAL_AI_CHAT))).toBe(true);
    expect(diagnoseProminent(chatItems(first))).toBe(false);
    const noBoard = run(
      INITIAL_AI_CHAT,
      { type: 'begin', kind: 'chat', text: '日数', now: 3 },
      { type: 'fail', code: 'no_board' },
    );
    expect(diagnoseProminent(chatItems(noBoard))).toBe(false);
  });

  it('#263 の空白: 返答の後、塊の中身が枠の 55% 未満なら下詰めを縮める（それ以上は上端に合わせたまま）', () => {
    expect(HOLD_END_RATIO).toBe(0.55);
    expect(holdAfterDone(200, 700)).toBe('end');
    expect(holdAfterDone(0.55 * 700 - 1, 700)).toBe('end');
    expect(holdAfterDone(0.55 * 700, 700)).toBe('true');
    expect(holdAfterDone(900, 700)).toBe('true');
    // 枠が見えない（高さ 0）ときは縮めない
    expect(holdAfterDone(10, 0)).toBe('true');
  });

  it('[評価に残す] は返答の末尾の ⋯（details.ai-more）の中だけ', () => {
    const src = read('ui/next/regions/AiChat.tsx');
    const at = src.indexOf('{AI_EVAL_KEEP_LABEL}');
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf('AI_EVAL_KEEP_LABEL}')).toBe(src.lastIndexOf('AI_EVAL_KEEP_LABEL}'));
    const open = src.lastIndexOf('<details class="ai-more">', at);
    expect(open).toBeGreaterThan(0);
    expect(src.slice(open, at)).not.toContain('</details>');
  });
});

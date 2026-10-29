/**
 * 数字・パネルから [AI に聞く]（#136。EPIC #141 終了条件 8・docs/design.md 14 章）の質問の文。純関数（Preact・DOM・
 * 通信に依存しない）。
 *
 * - 場所（topic）は決まった一覧（AI_ASK_TOPICS）。中継の許可リスト（api/src/simulator_api/ai/allowlist.py の
 *   ASK_TOPICS）と同じ並び（tests/ui/aiAsk.test.ts が突き合わせる）。中継はログ ai_request に場所の ID だけを出し、
 *   質問の文・値は出さない（聞かれた箇所の記録。#120 の案）
 * - 質問の文 = ASK_PREFIX + パネル名と見出し → 画面の表示（表示モデルの文字列のまま。数値を作り直さない）→
 *   聞くこと → 説明の節（マニュアル・設計書の節の番号と見出し。read_doc の索引の規則 = docs/adr-0007 決定 5）
 * - 送る文脈（板の要約・ポジション・シナリオ・事前計算）は今のチャットと同じ（ui/view/aiContext.ts）
 */

import { DASH } from './format';
import type { FullRow, MetricsPanelView, MetricTile, TileKey } from './metricsPanel';

/**
 * tile.scenario・tile.greeks・readout.* は #274 で画面から送らなくなった（タイル 6 枚・読み取りは押せない）。中継の許可リストと
 * 同じ並びのまま残す（開いたままの古い画面からの要求を拒まない）
 */
export const AI_ASK_TOPICS = [
  'tile.maxProfit',
  'tile.maxLoss',
  'tile.bep',
  'tile.premium',
  'tile.scenario',
  'tile.greeks',
  'tile.margin',
  'tile.room',
  'readout.date',
  'readout.expiry',
  'readout.delta',
  'readout.premium',
  'tail.pnl',
  'tail.margin',
  'iv.history',
] as const;

export type AiAskTopic = (typeof AI_ASK_TOPICS)[number];

/** 質問の文の先頭（system prompt の「画面の値」の節が参照する。中継の relay.ASK_PREFIX と同じ文） */
export const ASK_PREFIX = '［AI に聞く］';
/** ボタンの文字 */
export const ASK_BUTTON_TEXT = 'AI に聞く';
/** 聞くこと（全部の場所で同じ文） */
export const ASK_WHAT =
  '聞きたいこと: この値は何を表し、なぜこの値になっているか、今のポジションにとってどういう意味があるかを教えてください。';

export interface AiAsk {
  topic: AiAskTopic;
  /** 場所の見出し（ボタンの読み上げ名・吹き出しの 1 行目） */
  title: string;
  /** 送る文（利用者の発言。≤ MAX_USER_TEXT） */
  text: string;
}

/** 説明の節（file はマニュアル = user-guide / 設計書 = design。番号と見出しは read_doc の索引と同じ） */
export interface AskDoc {
  file: 'user-guide' | 'design';
  section: string;
  title: string;
}

const G_READOUT: AskDoc = { file: 'user-guide', section: '5', title: 'シナリオ点の数値' };
const G_TILE: AskDoc = { file: 'user-guide', section: '8.1', title: 'タイル' };
const G_TAIL: AskDoc = { file: 'user-guide', section: '8.3', title: 'テール表' };
const G_MARGIN: AskDoc = { file: 'user-guide', section: '8.4', title: '証拠金（概算）' };
const G_IV: AskDoc = {
  file: 'user-guide',
  section: '10.4',
  title: 'IV 推移（ATM IV の 30 日固定）',
};
const G_IV_NOW: AskDoc = {
  file: 'user-guide',
  section: '10.7',
  title: '「今」の点とシナリオの水準',
};
const D_PNL: AskDoc = { file: 'design', section: '5.6', title: '損益・指標・グリーク' };
const D_SCENARIO: AskDoc = { file: 'design', section: '5.4', title: 'シナリオ（IV の 1 本の式）' };
const D_MARGIN: AskDoc = { file: 'design', section: '5.10', title: '証拠金の概算' };

/** 場所ごとの説明の節（先頭がマニュアル） */
export const ASK_DOCS: Record<AiAskTopic, readonly AskDoc[]> = {
  'tile.maxProfit': [G_TILE, D_PNL],
  'tile.maxLoss': [G_TILE, D_PNL],
  'tile.bep': [G_TILE, D_PNL],
  'tile.premium': [G_TILE, D_PNL],
  'tile.scenario': [G_TILE, D_SCENARIO],
  'tile.greeks': [G_TILE, D_PNL],
  'tile.margin': [G_MARGIN, D_MARGIN],
  'tile.room': [G_MARGIN, D_MARGIN],
  'readout.date': [G_READOUT, D_SCENARIO],
  'readout.expiry': [G_READOUT, D_PNL],
  'readout.delta': [G_READOUT, D_PNL],
  'readout.premium': [G_READOUT, D_PNL],
  'tail.pnl': [G_TAIL, D_SCENARIO],
  'tail.margin': [G_MARGIN, D_MARGIN],
  'iv.history': [G_IV, G_IV_NOW],
};

const DOC_LABEL = { 'user-guide': 'マニュアル', design: '設計書' } as const;

/** 説明の節の 1 行（「説明の節: マニュアル 8.1「タイル」・設計書 5.6「…」」） */
export function docsLine(topic: AiAskTopic): string {
  const xs = ASK_DOCS[topic].map((d) => `${DOC_LABEL[d.file]} ${d.section}「${d.title}」`);
  return `説明の節: ${xs.join('・')}`;
}

const PANEL_METRICS = '指標 · テール';
const PANEL_IV = 'IV 推移';

/** 全文の行 → 箇条（続きの行（見出しが空）は前の行の続き） */
function rowLines(rows: readonly FullRow[]): string[] {
  return rows.map((r) => (r.k === '' ? `  ${r.v}` : `- ${r.k}: ${r.v}`));
}

function compose(
  topic: AiAskTopic,
  panel: string,
  title: string,
  head: string,
  lines: string[],
): AiAsk {
  const text = [
    `${ASK_PREFIX}${panel} ›「${title}」`,
    head,
    ...lines,
    ASK_WHAT,
    docsLine(topic),
  ].join('\n');
  return { topic, title, text };
}

/** タイルの場所 */
export const TILE_TOPIC: Record<TileKey, AiAskTopic> = {
  maxProfit: 'tile.maxProfit',
  maxLoss: 'tile.maxLoss',
  bep: 'tile.bep',
  premium: 'tile.premium',
  margin: 'tile.margin',
  room: 'tile.room',
};

/** 指標のタイル（全文の行と金額の単位。unitSub は見出し行の副題 `千円（自動）`） */
export function askTile(t: MetricTile, unitSub: string): AiAsk {
  const head = t.at
    ? `画面の表示（金額の単位: ${unitSub}・値の点: ${t.at.replace(/^·\s*/, '')}）:`
    : `画面の表示（金額の単位: ${unitSub}）:`;
  return compose(TILE_TOPIC[t.key], PANEL_METRICS, t.k, head, rowLines(t.full));
}

/** 金額の単位の文字（`千円（自動）` → `千円`） */
const unitOf = (unitSub: string) => unitSub.replace(/（.*$/, '');
/** 表の金額の文字列に単位を付ける（— と ∞ には付けない。答えの「−1,234 千円」と照合できるように。#136） */
const withUnit = (v: string, u: string) => (v === DASH || v.endsWith('∞') ? v : `${v} ${u}`);

/** テール表（5 行 × SQ・指定日 + シナリオ。空なら null）。金額に単位、原資産の水準に円を付ける */
export function askTail(v: MetricsPanelView): AiAsk | null {
  if (v.empty || v.tail.length === 0) return null;
  const u = unitOf(v.unitSub);
  const lines = v.tail.map(
    (r) =>
      `- 原資産 ${r.pct}（${r.x} 円）: SQ ${withUnit(r.sq.pnl, u)}（${r.sq.ratio}）・指定日 + シナリオ ${withUnit(r.scenario.pnl, u)}（${r.scenario.ratio}）`,
  );
  return compose('tail.pnl', PANEL_METRICS, 'テール表', `画面の表示（${v.tailCaption}）:`, lines);
}

/** 証拠金（概算）のテール表（行が無ければ null） */
export function askMarginTail(v: MetricsPanelView, title: string): AiAsk | null {
  if (v.empty || v.marginTail.length === 0) return null;
  const u = unitOf(v.unitSub);
  const lines = v.marginTail.map(
    (r) =>
      `- 原資産 ${r.pct}（${r.x} 円）: 必要証拠金 ${withUnit(r.margin, u)}・余力 ${withUnit(r.room, u)}${r.call ? '（追証）' : ''}`,
  );
  return compose(
    'tail.margin',
    PANEL_METRICS,
    title,
    `画面の表示（${v.marginTailCaption}）:`,
    lines,
  );
}

export interface IvAskInput {
  /** 足の名前（`1 時間足` など） */
  tfLabel: string;
  /** 読み取りの 1 行（ivReadout の出力の文字列） */
  readout: { time: string; o: string; h: string; l: string; c: string; progress: boolean };
  /** カーソルの足か（false = 最新の足） */
  cursor: boolean;
  /** 「今」の値（fmtIvPt の文字列。無ければ null） */
  now: string | null;
  /** シナリオの水準（fmtIvPt の文字列。無ければ null） */
  scenario: string | null;
}

/** IV 推移（読み取りの足・今・シナリオの水準。足が無ければ null） */
export function askIvHistory(p: IvAskInput): AiAsk | null {
  const r = p.readout;
  if (r.c === '' || r.c === DASH) return null;
  const which = p.cursor ? 'カーソルの足' : '最新の足';
  const lines = [
    `- ${which}（${p.tfLabel}）: ${r.time} 始 ${r.o} · 高 ${r.h} · 安 ${r.l} · 終 ${r.c}${r.progress ? '（確定前）' : ''}`,
  ];
  if (p.now !== null) lines.push(`- 今（今の板から計算）: ${p.now}`);
  if (p.scenario !== null) lines.push(`- シナリオの水準: ${p.scenario}`);
  return compose('iv.history', PANEL_IV, 'ATM IV（30 日固定）', '画面の表示（単位: %）:', lines);
}

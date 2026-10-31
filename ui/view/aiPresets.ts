/**
 * AI の定型の質問（#140。docs/design.md 14 章）。AI のパネルの [このポジションを診断] の下のチップが送る決まった文。
 * 純関数（Preact・DOM・通信に依存しない）。
 *
 * - 押すと文（利用者の発言）を 1 回で送る。要求は kind `preset` と定型の ID（topic）。ID の並びは中継の許可リスト
 *   （api/src/simulator_api/ai/allowlist.py の PRESET_TOPICS）と同じ（tests/ui/aiPresets.test.ts が突き合わせる）。
 *   中継はログ ai_request に ID だけを出し、文は出さない
 * - 文の先頭は PRESET_PREFIX（system prompt がこれを見てスキル simulator:presets の手順を読ませる）。答えは既存の
 *   ツールで出す（新しいツールは無い）。文に数字を入れない（照合の出所にしない・評価を乱さない）
 * - 足が要る定型は [このポジションを診断] と同じ押せない理由、要らない定型（板の前提・IV）は自由な質問と同じ
 * - 形の相談（#20 第 2 弾。ID `shape`）はチップに出さない（AI_PRESETS に入れない）。形の一覧のカードの
 *   [この形で AI に相談] が shapePreset で作って送る。文は形の名前・型の ID・限月の ID だけ（距離・行使価格・金額の
 *   数字を入れない = 候補は simulator が作る。#120 柱 5）
 */

import { type AiChatState, type AiGate, diagnoseBlocked, sendBlocked } from './aiChat';
import { type ShapeId, shapeOf } from './templates';

export const AI_PRESET_IDS = ['crash', 'rebut', 'board', 'hedge', 'exit', 'iv', 'shape'] as const;
export type AiPresetId = (typeof AI_PRESET_IDS)[number];

/** 文の先頭（中継の relay.PRESET_PREFIX と同じ文） */
export const PRESET_PREFIX = '［定型］';

export interface AiPreset {
  id: AiPresetId;
  /** チップの文字（文の 1 行目の名前と同じ） */
  label: string;
  /** 送る文（利用者の発言） */
  text: string;
  /** 足が要る（足 0 本では押せない） */
  needsLegs: boolean;
}

const preset = (id: AiPresetId, label: string, ask: string, needsLegs: boolean): AiPreset => ({
  id,
  label,
  text: `${PRESET_PREFIX}${label}\n${ask}`,
  needsLegs,
});

/** チップの並び（AI_PRESET_IDS と同じ順。形の相談 `shape` はチップに出さない） */
export const AI_PRESETS: readonly AiPreset[] = [
  preset(
    'crash',
    '崩れ方',
    'このポジションが短い間に一番崩れるのは、原資産と IV がどう動いたときですか。そのときの損益と合わせて教えてください。',
    true,
  ),
  preset('rebut', '反論', 'この建て方が間違っているとしたら、その理由を三つ挙げてください。', true),
  preset(
    'board',
    '板の前提',
    '今の板が織り込んでいる値動き（ATM の IV）・スキュー・今の IV の過去の中での位置を教えてください。',
    false,
  ),
  preset('hedge', 'ヘッジ案', 'このポジションの弱い所を抑えるヘッジの案を出してください。', true),
  preset(
    'exit',
    '出口',
    'このポジションの利確と損切りの目安になる候補を、計算の数字で教えてください。',
    true,
  ),
  preset(
    'iv',
    'IV の位置',
    '今の IV が売り時かを考える材料を並べてください。判断は自分でします。',
    false,
  ),
];

/** 定型のチップが押せない理由（押せるなら null） */
export function presetBlocked(s: AiChatState, g: AiGate, p: AiPreset): string | null {
  return p.needsLegs ? diagnoseBlocked(s, g) : sendBlocked(s, g);
}

// ---------------------------------------------------------------- 形の相談（#20 第 2 弾）

/** 形の相談の名前（文の 1 行目。スキル simulator:presets の節の見出しと同じ） */
export const SHAPE_PRESET_LABEL = '形の相談';

/**
 * 形の相談の文: `［定型］形の相談` + `<名前>（<型の ID>）・限月 <YYYY-MM>` + 頼みごと。名前は数字の無い短い名前
 * （put レシオの「（1 買 2 売）」を入れない = 限月の ID のほかに照合の対象になる数字を入れない）
 */
export function shapePresetText(shape: ShapeId, monthId: string): string {
  const s = shapeOf(shape);
  return [
    `${PRESET_PREFIX}${SHAPE_PRESET_LABEL}`,
    `${s.short ?? s.name}（${s.id}）・限月 ${monthId}`,
    '今の板でこの形を組む候補（距離の違い）を比べ、提案のカードで出してください。判断は自分でします。',
  ].join('\n');
}

/** 形の相談の定型（kind preset・topic shape。足は要らない = 自由な質問と同じ押せない理由） */
export const shapePreset = (shape: ShapeId, monthId: string): AiPreset => ({
  id: 'shape',
  label: SHAPE_PRESET_LABEL,
  text: shapePresetText(shape, monthId),
  needsLegs: false,
});

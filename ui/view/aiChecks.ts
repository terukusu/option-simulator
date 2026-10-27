/**
 * AI の返答の「確かめるとよいこと」を押せるチップにする（#278。EPIC #281 の A-02）。純関数（Preact・DOM に依存しない）。
 * 部品は ui/next/regions/AiChat.tsx（返答の文の下のチップの行）、押したときの振り分けは NextApp の onAiCheck。
 *
 * - 拾うのは返答の文の「確かめるとよいこと」の見出しから次の見出しまでの行だけ（中継の system prompt の診断の節。
 *   中継の形は変えない）。言葉の言い回しは解釈しない（決まった言葉を含むかだけ）
 * - チップは 4 種だけ: プリセット・ピン・評価時刻・パネル。同じものは 1 つ、MAX_CHECKS まで
 * - 押したときの action は既存の規則（presetChips・evalChips）の結果をそのまま使う（作り直さない）
 */

import type { Action } from '../state';
import { PANEL_NAMES } from './palette';
import { evalChips, PRESET_NAMES, presetChips, type ScenarioRegionInput } from './scenarioRegion';
import type { PanelId } from './shell';

/** チップの見出しの言葉（返答の見出し。中継の system prompt の「## 確かめるとよいこと」） */
export const CHECK_HEADING = '確かめるとよいこと';
/** 1 つの返答に出すチップの数の上限 */
export const MAX_CHECKS = 4;
/** チップの行の名前（読み上げ） */
export const CHECKS_LABEL = '返答の操作を試す';

export type AiCheck =
  | { kind: 'preset'; index: number }
  | { kind: 'pin' }
  /** month: 「N 月」と書かれていればその月番号（無ければ足の一番近い限月） */
  | { kind: 'eval'; at: 'sq' | 'last'; month: number | null }
  | { kind: 'panel'; panel: PanelId };

export interface AiCheckChip {
  /** 一意（種類 + 規則のキー） */
  key: string;
  label: string;
  check: AiCheck;
}

/** パネルの言葉（指標のパネルに出るもの・スマイル） */
const PANEL_WORDS: readonly { re: RegExp; panel: PanelId }[] = [
  // 「経済指標」は画面の指標でない
  { re: /(?<!経済)指標|テール表|追証マップ|証拠金|余力/g, panel: 'metrics' },
  { re: /スマイル/g, panel: 'smile' },
];

/**
 * 言葉の直後がこれなら、その言葉は拾わない（否定・対比。「急落は気にしなくてよい」「反発ではなく下落」）。
 * 言い回しの理解はしない（直後の決まった形だけ）
 */
const NEGATED_RE =
  /^\s*(?:は|を|の)?\s*(?:ではなく|でなく|じゃなく|気にしなく|不要|いらない|要らない)/;

/** re（g つき）に当たる所のうち、直後が否定・対比でないものがある */
function found(line: string, re: RegExp): RegExpExecArray | null {
  for (const m of line.matchAll(re)) {
    if (!NEGATED_RE.test(line.slice(m.index + m[0].length))) return m as RegExpExecArray;
  }
  return null;
}

/** 全角の数字を半角に（「１１月」） */
const halfDigits = (t: string) =>
  t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;

/** 返答の文の「確かめるとよいこと」の節の行（見出しの次から次の見出しの前まで。無ければ空） */
export function checkLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    const h = HEADING_RE.exec(line);
    if (h) {
      inside = (h[1] ?? '').replace(/[*_]/g, '').trim().startsWith(CHECK_HEADING);
      continue;
    }
    if (inside && line.trim() !== '') out.push(line);
  }
  return out;
}

const evalLabel = (at: 'sq' | 'last', month: number | null) =>
  `評価時刻: ${month === null ? '' : `${month}月 `}${at === 'sq' ? 'SQ' : '最終日'}`;

/** 1 行から拾うチップ（プリセット → ピン → 評価時刻 → パネルの順） */
function lineChecks(raw: string): AiCheckChip[] {
  const line = halfDigits(raw);
  const out: AiCheckChip[] = [];
  PRESET_NAMES.forEach((name, index) => {
    if (found(line, new RegExp(name, 'g')))
      out.push({
        key: `preset:${index}`,
        label: `シナリオ: ${name}`,
        check: { kind: 'preset', index },
      });
  });
  // 「ピンリスク」（SQ の行使価格付近のリスク）は画面のピンでない
  if (found(line, /ピン(?!リスク)/g))
    out.push({ key: 'pin', label: 'ピン: 今の線を残す', check: { kind: 'pin' } });
  for (const [at, re] of [
    ['sq', /SQ/g],
    ['last', /最終日/g],
  ] as const) {
    const m = found(line, re);
    if (!m) continue;
    // 言葉の直前の「N 月」（「11 月 SQ」「11月の SQ」「12 月限の SQ」）
    const mm = /(\d{1,2})\s*月\s*(?:限)?(?:\s*の)?\s*(?:取引)?$/.exec(
      line.slice(0, m.index).trimEnd(),
    );
    const n = mm ? Number(mm[1]) : Number.NaN;
    const month = n >= 1 && n <= 12 ? n : null;
    out.push({
      key: `eval:${at}:${month ?? ''}`,
      label: evalLabel(at, month),
      check: { kind: 'eval', at, month },
    });
  }
  for (const w of PANEL_WORDS) {
    if (found(line, w.re))
      out.push({
        key: `panel:${w.panel}`,
        label: `パネル: ${PANEL_NAMES[w.panel]}`,
        check: { kind: 'panel', panel: w.panel },
      });
  }
  return out;
}

/** 返答の文 → チップ（現れた順。同じものは 1 つ、MAX_CHECKS まで。節が無ければ空） */
export function aiCheckChips(text: string): AiCheckChip[] {
  const out: AiCheckChip[] = [];
  const seen = new Set<string>();
  for (const line of checkLines(text)) {
    for (const c of lineChecks(line)) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      out.push(c);
      if (out.length >= MAX_CHECKS) return out;
    }
  }
  return out;
}

export const CHECK_NO_X0_TEXT = '原資産が決まらないので、プリセットを入れられません';
export const CHECK_NO_LEGS_TEXT = '足が無いので、今の線を残せません';
export const CHECK_NO_EVAL_TEXT = '評価時刻に置ける限月がありません（足が無い・過ぎた限月）';

/** 押したときの動作（NextApp が振り分ける） */
export type AiCheckRun =
  /** シナリオを変える（[シナリオに適用] と同じ = [元に戻す] つきの知らせ） */
  | { kind: 'scenario'; action: Action; text: string }
  | { kind: 'pin' }
  | { kind: 'panel'; panel: PanelId }
  /** 押せない（理由を知らせる） */
  | { kind: 'blocked'; text: string };

/**
 * 押したときの動作。scenario は押した時点のシナリオの入力（シナリオのパネルと同じ組み立て）、pinBlocked は
 * 「今の線を残す」が押せない理由（押せれば null）
 */
export function aiCheckRun(
  check: AiCheck,
  scenario: ScenarioRegionInput,
  pinBlocked: string | null,
): AiCheckRun {
  switch (check.kind) {
    case 'preset': {
      const ch = presetChips(scenario).find((c) => c.key === `preset-${check.index}`);
      const name = PRESET_NAMES[check.index] ?? '';
      return ch?.action
        ? { kind: 'scenario', action: ch.action, text: `AI の返答から${name}のプリセットを入れた` }
        : { kind: 'blocked', text: CHECK_NO_X0_TEXT };
    }
    case 'eval': {
      const chips = evalChips(scenario).filter(
        (c) =>
          c.key.endsWith(`:${check.at}`) &&
          c.action !== null &&
          (check.month === null || Number(c.key.slice(5, 7)) === check.month),
      );
      const ch = chips[0];
      return ch?.action
        ? { kind: 'scenario', action: ch.action, text: `評価時刻を${ch.text}にした` }
        : { kind: 'blocked', text: CHECK_NO_EVAL_TEXT };
    }
    case 'pin':
      return pinBlocked === null ? { kind: 'pin' } : { kind: 'blocked', text: pinBlocked };
    case 'panel':
      return { kind: 'panel', panel: check.panel };
  }
}

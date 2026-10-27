import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { CALENDAR } from '../../ui/calendar';
import { PINS_FULL_TEXT } from '../../ui/pins';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import {
  aiCheckChips,
  aiCheckRun,
  CHECK_NO_EVAL_TEXT,
  CHECK_NO_X0_TEXT,
  checkLines,
  MAX_CHECKS,
} from '../../ui/view/aiChecks';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { evalTimeTargets } from '../../ui/view/scenario';
import { evalChips, presetChips, type ScenarioRegionInput } from '../../ui/view/scenarioRegion';
import { fixture } from '../support/fixtures';

/** #278: 返答の「確かめるとよいこと」のチップ（EPIC #281 終了条件 10）。合成の板（架空の値）。 */

/** dev の偽の SSE の診断の返答（scripts/devFixtures.mjs）と同じ形の文。数字は架空 */
const DIAG = [
  '## 弱点 1: 急落で損が膨らむ',
  '下の BEP は 60,000 円です。SQ で −10% なら −1,234 千円と、下げるほど損が加速します。',
  '## 弱点 2: IV の上昇に弱い',
  'V は −31 千円 / pt で、指標のタイルにも出ます。',
  '## 確かめるとよいこと',
  '- 急落のプリセットで、追証の線との距離を見る',
  '- 下側にプットの買いを足したヘッジ案をピンで重ねる',
].join('\n');

describe('aiCheckChips（AC1）', () => {
  it('dev の診断の返答から プリセット・ピン のチップが出る（節の外の SQ・指標は拾わない）', () => {
    const chips = aiCheckChips(DIAG);
    expect(chips.map((c) => c.label)).toEqual(['シナリオ: 急落', 'ピン: 今の線を残す']);
    expect(chips.map((c) => c.check)).toEqual([{ kind: 'preset', index: 0 }, { kind: 'pin' }]);
  });

  it('節が無い返答・空の文は 0', () => {
    expect(aiCheckChips('急落のプリセットとピンと SQ と指標')).toEqual([]);
    expect(aiCheckChips('')).toEqual([]);
    expect(aiCheckChips('## 弱点 1: 急落\n- ピンで重ねる')).toEqual([]);
  });

  it('節は次の見出しで終わる・見出しの階層と強調の印は問わない', () => {
    const t = '### **確かめるとよいこと**\n- ピンで重ねる\n## ほか\n- 急落のプリセット';
    expect(checkLines(t)).toEqual(['- ピンで重ねる']);
    expect(aiCheckChips(t).map((c) => c.key)).toEqual(['pin']);
  });

  it('評価時刻（SQ・最終日。N 月があればその月）とパネル（指標・IV 推移 · スマイル）', () => {
    const t = [
      '## 確かめるとよいこと',
      '- 時間レールを 11 月 SQ の手前に動かし、テール表で見る',
      '- 取引最終日の前に、スマイルの位置を見る',
    ].join('\n');
    const chips = aiCheckChips(t);
    expect(chips.map((c) => c.label)).toEqual([
      '評価時刻: 11月 SQ',
      'パネル: 指標',
      '評価時刻: 最終日',
      'パネル: IV 推移 · スマイル',
    ]);
    expect(chips[0]?.check).toEqual({ kind: 'eval', at: 'sq', month: 11 });
    expect(chips[2]?.check).toEqual({ kind: 'eval', at: 'last', month: null });
  });

  it('否定・対比・別の意味の言葉は拾わない（#278 レビュー指摘 1）', () => {
    const t = [
      '## 確かめるとよいこと',
      '- 急落は気にしなくてよいので、反発ではなく下落を見る',
      '- SQ 付近のピンリスクと経済指標の発表に注意する',
      '- スマイルは不要',
    ].join('\n');
    expect(aiCheckChips(t).map((c) => c.key)).toEqual(['preset:1', 'eval:sq:']);
  });

  it('限月は「限」を挟んでも・全角の数字でも読む（#278 レビュー指摘 2）', () => {
    const t = ['## 確かめるとよいこと', '- 12 月限の SQ に置く', '- １１月の最終日に置く'].join(
      '\n',
    );
    expect(aiCheckChips(t).map((c) => c.check)).toEqual([
      { kind: 'eval', at: 'sq', month: 12 },
      { kind: 'eval', at: 'last', month: 11 },
    ]);
  });

  it('同じものは 1 つ、4 つまで', () => {
    const t = [
      '## 確かめるとよいこと',
      '- 急落のプリセットをピンで重ねる',
      '- 急落と反発をピンで比べる',
      '- 下落のとき、追証マップと余力と SQ を見る',
    ].join('\n');
    const chips = aiCheckChips(t);
    expect(chips).toHaveLength(MAX_CHECKS);
    expect(new Set(chips.map((c) => c.key)).size).toBe(chips.length);
    expect(chips.map((c) => c.key)).toEqual(['preset:0', 'pin', 'preset:2', 'preset:1']);
  });
});

// ---------------------------------------------------------------- 押したときの動作（AC2）

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');
const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = run(initialState, { type: 'loaded', chain, label: 'latest' });
const twoLegs = run(
  loaded,
  { type: 'addBoardLeg', expiry: m1.id, k: 63_500, optionType: 'put', side: 'sell' },
  { type: 'addBoardLeg', expiry: m2.id, k: 71_000, optionType: 'call', side: 'buy' },
);

function inputOf(s: State): ScenarioRegionInput {
  const c = s.chain as Chain;
  const pm = positionModel(c, s.legs, s.atmBasis, s.calendar);
  const base = pnlDomains(c, pm.prepared, pm.ctx);
  return {
    scenario: s.scenario,
    futureBasis: s.futureBasis,
    x0: pm.ctx.x0,
    maxDays: base?.maxDays ?? 0,
    evalTime: base?.ctx.evalTime ?? null,
    targets: evalTimeTargets(c, s.legs, CALENDAR),
    dXUnit: 'pct',
  };
}

describe('aiCheckRun（AC2）', () => {
  const input = inputOf(twoLegs);

  it('プリセット → プリセットのチップと同じ applyPreset（[元に戻す] つきの知らせの文）', () => {
    const r = aiCheckRun({ kind: 'preset', index: 0 }, input, null);
    expect(r).toEqual({
      kind: 'scenario',
      action: presetChips(input).find((c) => c.key === 'preset-0')?.action,
      text: 'AI の返答から急落のプリセットを入れた',
    });
    expect(r.kind === 'scenario' && r.action.type).toBe('applyPreset');
  });

  it('プリセット: 原資産が決まらなければ押せない理由', () => {
    expect(aiCheckRun({ kind: 'preset', index: 1 }, { ...input, x0: Number.NaN }, null)).toEqual({
      kind: 'blocked',
      text: CHECK_NO_X0_TEXT,
    });
  });

  it('評価時刻 → 一番近い限月（月の指定があればその限月）の評価時刻のチップと同じ d', () => {
    const chips = evalChips(input);
    const near = chips.find((c) => c.key === `${m1.id}:sq`);
    const r = aiCheckRun({ kind: 'eval', at: 'sq', month: null }, input, null);
    expect(r).toEqual({
      kind: 'scenario',
      action: near?.action,
      text: `評価時刻を${near?.text}にした`,
    });
    const far = chips.find((c) => c.key === `${m2.id}:last`);
    const month2 = Number(m2.id.slice(5, 7));
    expect(aiCheckRun({ kind: 'eval', at: 'last', month: month2 }, input, null)).toEqual({
      kind: 'scenario',
      action: far?.action,
      text: `評価時刻を${far?.text}にした`,
    });
  });

  it('評価時刻: 足が無い・その月の足が無ければ押せない理由', () => {
    const blocked = { kind: 'blocked', text: CHECK_NO_EVAL_TEXT };
    expect(aiCheckRun({ kind: 'eval', at: 'sq', month: null }, inputOf(loaded), null)).toEqual(
      blocked,
    );
    const held = new Set(input.targets.map((t) => Number(t.id.slice(5, 7))));
    const other = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((m) => !held.has(m)) ?? 1;
    expect(aiCheckRun({ kind: 'eval', at: 'sq', month: other }, input, null)).toEqual(blocked);
  });

  it('ピン・パネル', () => {
    expect(aiCheckRun({ kind: 'pin' }, input, null)).toEqual({ kind: 'pin' });
    expect(aiCheckRun({ kind: 'pin' }, input, PINS_FULL_TEXT)).toEqual({
      kind: 'blocked',
      text: PINS_FULL_TEXT,
    });
    expect(aiCheckRun({ kind: 'panel', panel: 'metrics' }, input, null)).toEqual({
      kind: 'panel',
      panel: 'metrics',
    });
  });

  it('押した action をそのまま reducer に通すとシナリオが変わる', () => {
    const r = aiCheckRun({ kind: 'preset', index: 0 }, input, null);
    if (r.kind !== 'scenario') throw new Error('scenario でない');
    const after = reduce(twoLegs, r.action);
    expect(after.scenario.dX).not.toBe(twoLegs.scenario.dX);
    expect(after.scenario.dSigma).toBe(20);
  });
});

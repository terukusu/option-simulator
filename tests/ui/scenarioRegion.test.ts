import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { CRASH_PRESETS, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { fmtDateTime } from '../../ui/view/format';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import {
  type DXUnit,
  daysToTarget,
  evalInstant,
  evalTimeTargets,
  fromDisplay,
  parseBeta,
  parseSliderInput,
  sliderSpec,
  toDisplay,
} from '../../ui/view/scenario';
import {
  advSummary,
  BETA_SPEC,
  basisAction,
  betaStepper,
  dynamicsAction,
  editText,
  evalChips,
  parseStepperInput,
  presetChips,
  type ScenarioRegionInput,
  scenarioSteppers,
  stepperAction,
} from '../../ui/view/scenarioRegion';
import { stageKey, timeRailTicks } from '../../ui/view/stage';
import { editOutcome, stepperMove } from '../../ui/view/stepper';
import { fixture } from '../support/fixtures';

/** #83: シナリオの領域の表示モデル（AC-3・AC-4・AC-5）。合成の板（架空の値）、足 2 本は 2 限月。 */

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

function inputOf(s: State, dXUnit: DXUnit = 'pct'): ScenarioRegionInput {
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
    dXUnit,
  };
}

const ALLOWED = new Set(['setScenario', 'applyPreset', 'resetScenario', 'setFutureBasis']);
const apply = (s: State, a: Action | null) => {
  if (a === null) throw new Error('action が無い');
  expect(ALLOWED.has(a.type)).toBe(true);
  return reduce(s, a);
};

describe('#83 AC-3 (a) ステッパー 4 つ + β', () => {
  const s = run(twoLegs, {
    type: 'setScenario',
    patch: { days: 4.27, dX: -700, dSigma: 2.5, skew: 0 },
  });
  const input = inputOf(s);

  it('仕様は sliderSpec（d・ΔX % / 円・Δσ・Δs）と β 0〜10・0.1・既定 1、値は toDisplay', () => {
    expect(Number.isFinite(input.x0) && input.x0 > 0).toBe(true);
    expect(input.maxDays).toBeGreaterThan(4.27);
    for (const unit of ['pct', 'yen'] as const) {
      const inp = { ...input, dXUnit: unit };
      const views = scenarioSteppers(inp);
      expect(views.map((v) => v.field)).toEqual(['days', 'dX', 'dSigma', 'skew']);
      for (const v of views) {
        const spec = sliderSpec(v.field as 'days', {
          x0: inp.x0,
          maxDays: inp.maxDays,
          dXUnit: unit,
        });
        expect(v.spec).toEqual({ min: spec.min, max: spec.max, step: spec.step, def: spec.def });
        expect(v.disabled).toBe(false);
        expect(v.value).toBe(
          toDisplay(v.field as 'days', s.scenario[v.field as 'days'], inp.x0, unit),
        );
        expect(v.keepFraction).toBe(v.field === 'days');
      }
    }
    expect(BETA_SPEC).toEqual({ min: 0, max: 10, step: 0.1, def: ZERO_SCENARIO.beta });
    const beta = betaStepper(input);
    expect(beta).toMatchObject({
      field: 'beta',
      value: 1,
      text: '1.0',
      sub: 'pt / 1%',
      hot: false,
    });
  });

  it('ΔX の % ⇄ 円の切替は表示だけ（状態の ΔX は同じ円）', () => {
    const pct = scenarioSteppers({ ...input, dXUnit: 'pct' })[1];
    const yen = scenarioSteppers({ ...input, dXUnit: 'yen' })[1];
    if (!pct || !yen) throw new Error('ΔX が無い');
    expect(fromDisplay('dX', pct.value, input.x0, 'pct')).toBeCloseTo(-700, 9);
    expect(yen.value).toBe(-700);
    expect(yen.text).toBe('−700 円');
    expect(pct.text.endsWith('%')).toBe(true);
    expect(pct.sub).toBe(`−700 円 · X ${Math.round(input.x0 - 700).toLocaleString('en-US')}`);
  });

  it('文字と副題（§5.2）、既定でないものだけ hot、d の副題は evalInstant の日時', () => {
    const [d, dX, dSigma, skew] = scenarioSteppers(input);
    expect(d?.text).toBe('4.27 日');
    const t = fmtDateTime(evalInstant(input.evalTime as number, 4.27));
    expect(d?.sub).toBe(`${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11)}`);
    expect(dSigma).toMatchObject({ text: '+2.5 pt', sub: 'Δσ 平行', hot: true });
    expect(skew).toMatchObject({ text: '0.0', sub: 'pt / 10%', hot: false });
    expect(d?.hot).toBe(true);
    expect(dX?.hot).toBe(true);
    const zero = scenarioSteppers(inputOf(run(twoLegs, { type: 'resetScenario' })));
    expect(zero.map((v) => v.hot)).toEqual([false, false, false, false]);
    expect(betaStepper({ ...input, scenario: { ...input.scenario, beta: 1.5 } }).hot).toBe(true);
  });

  it('足 0 本で d が無効、X₀ が NaN で ΔX が無効・プリセットが押せない（操作しても action が無い）', () => {
    const empty = inputOf(loaded);
    expect(empty.maxDays).toBe(0);
    const d = scenarioSteppers(empty)[0];
    expect(d?.disabled).toBe(true);
    expect(stepperAction('days', 1, empty)).toBeNull();
    const noX0 = { ...input, x0: Number.NaN };
    const dX = scenarioSteppers(noX0)[1];
    expect(dX).toMatchObject({ disabled: true, text: '—', hot: false });
    expect(stepperAction('dX', 1, noX0)).toBeNull();
    const chips = presetChips(noX0);
    expect(chips.slice(0, 3).every((c) => c.disabled && c.action === null)).toBe(true);
    expect(chips[3]).toMatchObject({ text: 'リセット', disabled: false });
  });
});

describe('#83 AC-3 (b) プリセット', () => {
  it('4 つのチップの名前と数（CRASH_PRESETS から）、適用したものだけ pressed、リセットの後はどれも pressed でない', () => {
    const input = inputOf(twoLegs);
    const chips = presetChips(input);
    expect(chips.map((c) => c.text)).toEqual([
      '急落 −10% / +20pt / +3',
      '下落 −5% / +8pt / +1',
      '反発 +5% / −5pt / −1',
      'リセット',
    ]);
    expect(chips[3]?.pressed).toBeUndefined();
    CRASH_PRESETS.forEach((_, i) => {
      const s = apply(twoLegs, presetChips(input)[i]?.action ?? null);
      const pressed = presetChips(inputOf(s)).map((c) => c.pressed === true);
      expect(pressed).toEqual([0, 1, 2, 3].map((j) => j === i));
      const reset = apply(s, presetChips(inputOf(s))[3]?.action ?? null);
      expect(presetChips(inputOf(reset)).some((c) => c.pressed === true)).toBe(false);
      // リセットは β・IV の動き方を保つ
      expect(reset.scenario.beta).toBe(s.scenario.beta);
    });
  });
});

describe('#83 AC-3 (c) 評価時刻のチップ', () => {
  const input = inputOf(twoLegs);

  it('限月 2 つで 4 つ（SQ 昇順・限月ごとに最終日 → SQ）、d は daysToTarget と同じ', () => {
    const chips = evalChips(input);
    const mm = (id: string) => `${Number(id.slice(5, 7))}月`;
    expect(chips.map((c) => c.text)).toEqual([
      `${mm(m1.id)} 最終日 15:45`,
      `${mm(m1.id)} SQ 9:00`,
      `${mm(m2.id)} 最終日 15:45`,
      `${mm(m2.id)} SQ 9:00`,
    ]);
    const ev = input.evalTime as number;
    const want = input.targets.flatMap((t) => [
      daysToTarget(ev, t.lastTradeClose, input.maxDays),
      daysToTarget(ev, t.sqTime, input.maxDays),
    ]);
    expect(chips.map((c) => c.days)).toEqual(want);
    expect(chips.every((c) => !c.disabled && c.pressed === false)).toBe(true);
  });

  it('評価時刻以前のものは押せない、今の d と同じチップだけ pressed、足 0 本で 0 個', () => {
    const t0 = input.targets[0];
    if (!t0) throw new Error('対象が無い');
    const late = { ...input, evalTime: t0.lastTradeClose };
    const chips = evalChips(late);
    expect(chips[0]).toMatchObject({ disabled: true, days: null, action: null });
    expect(chips[1]?.disabled).toBe(false);
    const sq = evalChips(input)[1];
    const s = apply(twoLegs, sq?.action ?? null);
    expect(evalChips(inputOf(s)).map((c) => c.pressed)).toEqual([false, true, false, false]);
    expect(evalChips(inputOf(loaded))).toEqual([]);
  });

  it('同じ月番号が 2 つあれば年を付ける', () => {
    const t = input.targets[0];
    if (!t) throw new Error('対象が無い');
    const next = { ...t, id: `${Number(t.id.slice(0, 4)) + 1}${t.id.slice(4)}` };
    const chips = evalChips({ ...input, targets: [t, next] });
    const m = Number(t.id.slice(5, 7));
    expect(chips[0]?.text).toBe(`${t.id.slice(0, 4)}年${m}月 最終日 15:45`);
    expect(chips[3]?.text).toBe(`${next.id.slice(0, 4)}年${m}月 SQ 9:00`);
  });
});

describe('#83 AC-3 (d) 前提の要約', () => {
  it('β・sticky・basis・ΔX 単位の組み合わせ', () => {
    const input = inputOf(twoLegs);
    expect(advSummary(input)).toBe('β 1.0 · sticky strike · basis 固定 · ΔX %');
    expect(
      advSummary({
        ...input,
        scenario: { ...input.scenario, beta: 2.5, ivDynamics: 'sticky_moneyness' },
        futureBasis: 'decay',
        dXUnit: 'yen',
      }),
    ).toBe('β 2.5 · sticky moneyness · basis 減衰 · ΔX 円');
    expect(advSummary({ ...input, scenario: { ...input.scenario, beta: 0 }, dXUnit: 'yen' })).toBe(
      'β 0.0 · sticky strike · basis 固定 · ΔX 円',
    );
  });
});

describe('#83 AC-4 数値入力', () => {
  const input = inputOf(twoLegs);
  const dXSpec = sliderSpec('dX', { x0: input.x0, maxDays: input.maxDays, dXUnit: 'pct' });

  it('ΔX（%）に -3.5 → 状態の ΔX が fromDisplay(-3.5)、-100・900.5・abc は parseSliderInput と同じ文言で拒否', () => {
    const r = parseStepperInput('dX', '-3.5', input);
    expect(r).toEqual({ ok: true, value: -3.5 });
    const s = apply(twoLegs, r.ok ? stepperAction('dX', r.value, input) : null);
    expect(s.scenario.dX).toBe(fromDisplay('dX', -3.5, input.x0, 'pct'));
    for (const t of ['-100', '900.5', 'NaN', 'Infinity', '', 'abc']) {
      const bad = parseStepperInput('dX', t, input);
      expect(bad).toEqual(parseSliderInput(t, dXSpec));
      expect(bad.ok).toBe(false);
    }
  });

  it('#144 AC-2: ΔX の数値欄は操作の範囲（−90%〜+100%）より広い −99%〜+900%（円は ⌈−0.99X₀⌉〜⌊9X₀⌋）', () => {
    for (const t of ['-99', '-95', '150', '900']) {
      expect(parseStepperInput('dX', t, input)).toEqual({ ok: true, value: Number(t) });
    }
    const s = apply(twoLegs, stepperAction('dX', -99, input));
    expect(s.scenario.dX).toBeCloseTo(-0.99 * input.x0, 9);
    expect(input.x0 + s.scenario.dX).toBeGreaterThan(0);
    const yen = { ...input, dXUnit: 'yen' as const };
    const lo = Math.ceil(-0.99 * input.x0);
    const hi = Math.floor(9 * input.x0);
    expect(parseStepperInput('dX', String(lo), yen)).toEqual({ ok: true, value: lo });
    expect(parseStepperInput('dX', String(hi), yen)).toEqual({ ok: true, value: hi });
    for (const t of [String(lo - 1), String(hi + 1), String(-input.x0), 'NaN', '']) {
      expect(parseStepperInput('dX', t, yen).ok).toBe(false);
    }
  });

  it('β に 2.5 → 2.5、11 は parseBeta と同じ文言で拒否', () => {
    const r = parseStepperInput('beta', '2.5', input);
    expect(r).toEqual({ ok: true, value: 2.5 });
    const s = apply(twoLegs, r.ok ? stepperAction('beta', r.value, input) : null);
    expect(s.scenario.beta).toBe(2.5);
    expect(parseStepperInput('beta', '11', input)).toEqual(parseBeta('11'));
    expect(parseStepperInput('beta', '11', input).ok).toBe(false);
  });

  it('d に 4.25 → 4.25（格子に寄せない）、初期文字列は今の数値欄と同じ', () => {
    const r = parseStepperInput('days', '4.25', input);
    expect(r).toEqual({ ok: true, value: 4.25 });
    const s = apply(twoLegs, r.ok ? stepperAction('days', r.value, input) : null);
    expect(s.scenario.days).toBe(4.25);
    expect(editText('days', 4.25, input)).toBe('4.25');
    expect(editText('dX', -3.5, input)).toBe('−3.5');
    expect(editText('beta', 1, input)).toBe('1.0');
    // 同じ値・非有限は action を作らない
    expect(stepperAction('days', twoLegs.scenario.days, input)).toBeNull();
    expect(stepperAction('dSigma', Number.NaN, input)).toBeNull();
  });
});

describe('#83 AC-5 状態の action だけで動き、#82 の舞台と同じ状態になる', () => {
  const s0 = run(twoLegs, { type: 'setScenario', patch: { days: 4.27, dX: -400, dSigma: 2 } });
  const input = inputOf(s0);
  const ctx = { x0: input.x0, maxDays: input.maxDays };

  it('d +1（端数 4.27 から）: ステッパー = 描画域の ]', () => {
    const view = scenarioSteppers(input)[0];
    if (!view) throw new Error('d が無い');
    const next = stepperMove(view.spec, view.value, 1, view.keepFraction);
    const mine = apply(s0, stepperAction('days', next, input));
    const k = stageKey(']', false, s0.scenario, ctx);
    if (!k || !('patch' in k)) throw new Error('stageKey が patch でない');
    const stage = reduce(s0, { type: 'setScenario', patch: k.patch });
    expect(mine.scenario).toEqual(stage.scenario);
    expect(mine.scenario.days).toBe(5.27);
  });

  it('リセット: チップ = 描画域の 0', () => {
    const mine = apply(s0, presetChips(input)[3]?.action ?? null);
    expect(stageKey('0', false, s0.scenario, ctx)).toEqual({ reset: true });
    const stage = reduce(s0, { type: 'resetScenario' });
    expect(mine.scenario).toEqual(stage.scenario);
  });

  it('SQ の d: 評価時刻のチップ = 時間レールの SQ の目盛り（setDays）', () => {
    const chip = evalChips(input).find((c) => c.key === `${m1.id}:sq`);
    const mine = apply(s0, chip?.action ?? null);
    const tick = timeRailTicks(input.targets, input.evalTime as number, input.maxDays, 600).find(
      (t) => t.kind === 'sq' && t.id === `${m1.id}:sq`,
    );
    if (!tick) throw new Error('目盛りが無い');
    const stage = reduce(s0, { type: 'setDays', days: tick.days });
    expect(mine.scenario).toEqual(stage.scenario);
  });

  it('前提の操作も既存の action（setScenario { ivDynamics }・setFutureBasis）', () => {
    const a = apply(s0, dynamicsAction('sticky_moneyness'));
    expect(a.scenario.ivDynamics).toBe('sticky_moneyness');
    const b = apply(s0, basisAction('decay'));
    expect(b.futureBasis).toBe('decay');
    // ΔX の単位は action を作らない（表示だけ）。同じ状態から作るステッパーの action は単位によらず同じ円
    const pct = stepperAction('dX', -1, { ...input, dXUnit: 'pct' });
    const yen = stepperAction('dX', fromDisplay('dX', -1, input.x0, 'pct'), {
      ...input,
      dXUnit: 'yen',
    });
    expect(pct).toEqual(yen);
  });
});

/**
 * #83 レビュー B-1: 数値入力を開いて何も打たずに Enter / フォーカスを外しても状態を変えない
 * （欄の文字列は丸めた値。確定すると端数の d・上限の d・β 1.25 が変わる / 拒否される）。
 */
describe('#83 B-1 数値入力を開いて何も打たずに確定しても状態は変わらない', () => {
  const input0 = inputOf(twoLegs);
  /** 開く → 何も打たずに確定 → 作る action（keep なら null） */
  const untouched = (field: 'days' | 'beta', s: State) => {
    const input = inputOf(s);
    const display = field === 'beta' ? s.scenario.beta : (scenarioSteppers(input)[0]?.value ?? 0);
    const opened = editText(field, display, input);
    const o = editOutcome(opened, opened, (t) => parseStepperInput(field, t, input));
    return { opened, o, action: o.type === 'set' ? stepperAction(field, o.value, input) : null };
  };

  it('端数の d（最終日 15:45 のチップ）: 欄は 2 桁に丸めた値だが確定しても d とチップの押下は変わらない', () => {
    const chip = evalChips(input0).find((c) => c.key.endsWith(':last'));
    const s = apply(twoLegs, chip?.action ?? null);
    expect(Number.isInteger(s.scenario.days * 100)).toBe(false);
    const { opened, o, action } = untouched('days', s);
    // 丸めた文字列をそのまま parse すると d が変わる（直す前の不具合）
    const raw = parseStepperInput('days', opened, inputOf(s));
    expect(raw.ok && raw.value !== s.scenario.days).toBe(true);
    expect(o).toEqual({ type: 'keep' });
    expect(action).toBeNull();
    expect(evalChips(inputOf(s)).find((c) => c.key === chip?.key)?.pressed).toBe(true);
  });

  it('上限の d（最遠の SQ）: 欄の丸めた値は範囲外だが、確定しても拒否されず d は上限のまま', () => {
    const sq = evalChips(input0)
      .filter((c) => c.key.endsWith(':sq'))
      .at(-1);
    const s = apply(twoLegs, sq?.action ?? null);
    expect(s.scenario.days).toBe(input0.maxDays);
    const { opened, o } = untouched('days', s);
    expect(parseStepperInput('days', opened, inputOf(s)).ok).toBe(false);
    expect(o).toEqual({ type: 'keep' });
  });

  it('β 1.25: 欄は 1.3 だが確定しても 1.25 のまま。打ち直した値は今までどおり確定 / 拒否', () => {
    const s = run(twoLegs, { type: 'setScenario', patch: { beta: 1.25 } });
    const { opened, o, action } = untouched('beta', s);
    expect(opened).toBe('1.3');
    expect(o).toEqual({ type: 'keep' });
    expect(action).toBeNull();
    const parse = (t: string) => parseStepperInput('beta', t, inputOf(s));
    expect(editOutcome(opened, ' 1.3 ', parse)).toEqual({ type: 'keep' });
    expect(editOutcome(opened, '2.5', parse)).toEqual({ type: 'set', value: 2.5 });
    expect(editOutcome(opened, '11', parse)).toEqual({
      type: 'invalid',
      message: 'β は 0〜10（pt / 1%）',
    });
    expect(parseBeta('11')).toEqual({ ok: false, message: 'β は 0〜10（pt / 1%）' });
  });
});

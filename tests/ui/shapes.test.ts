import { describe, expect, it } from 'vitest';
import { type ChainMonth, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, ZERO_SCENARIO } from '../../model';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import {
  type Action,
  activeHeld,
  initialState,
  MAX_TABS,
  reduce,
  type State,
} from '../../ui/state';
import { newTabUndoActions } from '../../ui/view/aiPropose';
import {
  capitalOf,
  type MarginView,
  marginNow,
  marginParamsOf,
  marginPoint,
  marginPointAt,
  marginTail,
} from '../../ui/view/margin';
import { metricsModel } from '../../ui/view/metrics';
import { metricTiles } from '../../ui/view/metricsPanel';
import { pnlDomains, scenarioFull, withScenarioFull } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import {
  initialShapeForm,
  SHAPE_PICK_TEXT,
  type ShapeCardInput,
  type ShapeForm,
  shapeApplyPlan,
  shapeCard,
  shapeList,
  shapeUiLegs,
} from '../../ui/view/shapes';
import { TABS_FULL_TEXT } from '../../ui/view/tabs';
import { SHAPE_FAIL_TEXT, SHAPE_IDS } from '../../ui/view/templates';
import { NO_CHAIN_TEXT } from '../../ui/view/topMenu';
import { fixture } from '../support/fixtures';

/**
 * #20 形の一覧のダイアログの表示モデル（ui/view/shapes.ts）。合成の板（fixtures/synthetic/latest.json。値は架空）。
 * カードの値は、同じ足だけを足 0 本のタブに入れたときの指標のタイル（metricsModel → metricTiles）と同じ文字列。
 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months as [ChainMonth, ChainMonth];
const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = run(initialState, { type: 'loaded', chain, label: 'latest' });
const margin = { ...DEFAULT_MARGIN_PREFS, capitalYen: 30_000_000 };
const params = marginParamsOf(margin);

function inputOf(s: State, o: Partial<ShapeCardInput> = {}): ShapeCardInput {
  return {
    chain: s.chain,
    basis: s.atmBasis,
    legs: s.legs,
    calendar: s.calendar,
    feePerLot: s.feePerLot,
    futureBasis: s.futureBasis,
    unit: s.metricsUnit,
    nowScenario: ZERO_SCENARIO,
    params,
    capital: capitalOf(margin),
    canAddTab: s.tabs.length < MAX_TABS,
    ...o,
  };
}
const form = (o: Partial<ShapeForm>): ShapeForm => ({
  ...initialShapeForm('short_strangle'),
  ...o,
});

describe('一覧', () => {
  it('売り 6・買い 6 の 2 群、読み上げ名は名前 + 一言、図は固定の点列', () => {
    const g = shapeList();
    expect(g.map((x) => [x.title, x.label, x.items.length])).toEqual([
      ['売り', '売りの形', 6],
      ['買い', '買いの形', 6],
    ]);
    expect(g.flatMap((x) => x.items.map((i) => i.id))).toEqual([...SHAPE_IDS]);
    for (const it of g.flatMap((x) => x.items)) {
      expect(it.aria.endsWith(`。${it.note}`)).toBe(true);
      expect(it.aria.startsWith(it.name)).toBe(true);
      expect(it.points).toMatch(/^(\d+(\.\d+)?,\d+(\.\d+)? ?)+$/);
    }
  });

  it('形を選んでいなければカードは null（「形を選ぶと…」の文を出す）', () => {
    expect(shapeCard(inputOf(loaded), initialShapeForm(null))).toBeNull();
    expect(SHAPE_PICK_TEXT.length).toBeGreaterThan(0);
  });
});

describe('カード', () => {
  const card = shapeCard(inputOf(loaded), form({ month: m2.id }));
  if (!card) throw new Error('card');

  it('2 限月・1σ のストラングル売り: 足 2 本（売 P・売 C、×1）、限月の Seg はスマイルと F のある限月', () => {
    expect(card.month).toBe(m2.id);
    expect(card.months.map((o) => o.value)).toEqual([m1.id, m2.id]);
    expect(
      card.legs.map((l) => (l.leg.kind === 'option' ? [l.leg.type, l.leg.side, l.leg.qty] : null)),
    ).toEqual([
      ['put', 'sell', 1],
      ['call', 'sell', 1],
    ]);
    for (const r of card.rows) expect(r.text).toMatch(/^売 [PC] [\d,]+ @[\d,.]+ ×1$/);
    expect(card.reason).toBeNull();
    expect(card.canApply).toBe(true);
    expect(card.canNewTab).toBe(true);
  });

  it('カードの値 = 同じ足だけを足 0 本のタブに入れたときの指標のタイル（受取 / 支払・最大損失・BEP・必要証拠金）', () => {
    // 足 0 本のタブに同じ足を入れる（reducer を通す）
    const s = run(loaded, {
      type: 'replaceLegs',
      legs: card.legs,
      expect: [],
      tab: loaded.activeTab,
    });
    expect(s.legs).toHaveLength(2);
    // 期待値は画面の指標と同じ組み立て（useAppController の positions → pnlBoard → scenarioFull で広げた pnlBase →
    // metricsModel、証拠金は今 = marginNow(pnlBoard)・点 = marginPoint(pnlBase)）。カードの shapeTiles の道筋
    // （evalLegs・point = now）とは別に組む（#20 レビュー N5）
    const settings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot, futureBasis: s.futureBasis };
    const pm = positionModel(chain, s.legs, s.atmBasis, s.calendar, settings);
    const board = pnlDomains(chain, pm.prepared, pm.ctx, settings);
    if (!board) throw new Error('board');
    const base = withScenarioFull(board, scenarioFull(board, s.scenario.dX));
    const model = metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit });
    const { beta, ivDynamics, ivShift } = s.scenario;
    const nowSc = { ...ZERO_SCENARIO, beta, ivDynamics, ivShift };
    const cap = capitalOf(margin);
    const hol = s.calendar.holidays;
    const mv: MarginView = {
      capital: cap,
      params,
      now: marginNow(board, nowSc, params, cap, hol),
      point: marginPoint(base, s.scenario, params, cap, hol),
      at: marginPointAt(base, s.scenario),
      tail: marginTail(board, nowSc, params, cap, hol),
    };
    const tiles = metricTiles(model, mv);
    const tile = (k: string) => tiles.find((t) => t.key === k);
    expect(card.values.map((v) => v.key)).toEqual(['premium', 'maxLoss', 'bep', 'margin']);
    for (const v of card.values) {
      expect(v.v).toBe(tile(v.key)?.v);
      expect(v.unit).toBe(tile(v.key)?.unit);
    }
    expect(card.values.find((v) => v.key === 'premium')?.k).toBe('受取 − 支払');
    expect(card.values.find((v) => v.key === 'margin')?.k).toBe('必要証拠金（概算）');
    // ストラングル売りの満期の最大損失は無限
    expect(card.values.find((v) => v.key === 'maxLoss')?.v).toMatch(/∞/);
    // 受取 − 支払 = 2 本の bid × 乗数 1,000（合成の板から直接。手数料の前）
    const bids = card.legs.map((l) => {
      const leg = l.leg;
      return leg.kind === 'option'
        ? (m2.rows.find((r) => r.k === leg.strike)?.[leg.type].bid ?? Number.NaN)
        : Number.NaN;
    });
    const net = (bids[0] as number) * 1_000 + (bids[1] as number) * 1_000;
    const prem = card.values.find((v) => v.key === 'premium');
    const num = Number(prem?.v.replace(/[+,]/g, '').replace('−', '-'));
    expect(num * (prem?.unit === '千円' ? 1_000 : 1)).toBe(net);
  });

  it('作れない足の理由はその足の種別・限月の文（put の文に決め打ちしない。#20 レビュー N1）', () => {
    const unquoted = (m: ChainMonth) =>
      m.strikes.find((x) => x.call.quote !== 'two_sided')?.k as number;
    const kc = unquoted(m1);
    expect(kc).toBeDefined();
    expect(unquoted(m2)).toBeDefined();
    const call = shapeUiLegs(
      chain,
      [{ type: 'call', k: kc, side: 'buy', mul: 1, expiry: m1.id }],
      1,
    );
    expect(call).toEqual({ ok: false, reason: 'no_quote_call' });
    const k1 = m1.atm.B.pick?.k as number;
    const next = shapeUiLegs(
      chain,
      [
        { type: 'call', k: k1, side: 'sell', mul: 1, expiry: m1.id },
        { type: 'call', k: unquoted(m2), side: 'buy', mul: 1, expiry: m2.id },
      ],
      1,
    );
    expect(next).toEqual({ ok: false, reason: 'no_quote_next' });
    const ok = shapeUiLegs(
      chain,
      [{ type: 'call', k: k1, side: 'sell', mul: 1, expiry: m1.id }],
      2,
    );
    expect(ok.ok && ok.legs[0]?.leg.qty).toBe(2);
  });

  it('枚数 3 で足の枚数が 3、レシオの売り・バタフライの中心は 2 倍', () => {
    const c3 = shapeCard(inputOf(loaded), form({ month: m2.id, qty: 3 }));
    expect(c3?.legs.map((l) => l.leg.qty)).toEqual([3, 3]);
    const ratio = shapeCard(inputOf(loaded), form({ shape: 'put_ratio', month: m2.id, qty: 3 }));
    expect(ratio?.legs.map((l) => l.leg.qty)).toEqual([3, 6]);
    const fly = shapeCard(inputOf(loaded), form({ shape: 'call_butterfly', month: m2.id, qty: 2 }));
    expect(fly?.legs.map((l) => l.leg.qty)).toEqual([2, 4, 2]);
  });

  it('カレンダーの足の行は限月を付ける', () => {
    const cal = shapeCard(inputOf(loaded), form({ shape: 'calendar', month: m1.id }));
    expect(cal?.rows.map((r) => r.text.replace(/^.* ×1/, ''))).toEqual([
      '（11月限）',
      '（12月限）',
    ]);
  });

  it('既定の限月 = 作業中のタブの最初の OP の足の限月、無ければ残存 2 日以上の最初の限月', () => {
    expect(shapeCard(inputOf(loaded), form({}))?.month).toBe(m1.id);
    const one = run(loaded, {
      type: 'addBoardLeg',
      expiry: m2.id,
      k: m2.atm.B.pick?.k as number,
      optionType: 'put',
      side: 'sell',
    });
    expect(shapeCard(inputOf(one), form({}))?.month).toBe(m2.id);
  });

  it('組めない形: 適用のボタンが押せず、理由の文と title', () => {
    const cal = shapeCard(inputOf(loaded), form({ shape: 'calendar', month: m2.id }));
    expect(cal?.reason).toBe(SHAPE_FAIL_TEXT.no_next_month);
    expect(cal?.canApply).toBe(false);
    expect(cal?.applyTitle).toBe(SHAPE_FAIL_TEXT.no_next_month);
    expect(cal?.canNewTab).toBe(false);
    expect(cal?.legs).toEqual([]);
    expect(cal?.values).toEqual([]);
    const none = shapeCard(inputOf(loaded, { chain: null }), form({}));
    expect(none?.reason).toBe(NO_CHAIN_TEXT);
    expect(none?.canApply).toBe(false);
  });

  it('タブ 6 個で [新しいタブに入れる] が押せず title「タブは 6 個まで」（[このタブに足す] は押せる）', () => {
    let s = loaded;
    for (let i = 1; i < MAX_TABS; i++) s = run(s, { type: 'addTab', mode: 'empty' });
    expect(s.tabs.length).toBe(MAX_TABS);
    const c = shapeCard(inputOf(s), form({ month: m2.id }));
    expect(c?.canApply).toBe(true);
    expect(c?.canNewTab).toBe(false);
    expect(c?.newTabTitle).toBe(TABS_FULL_TEXT);
    expect(TABS_FULL_TEXT).toBe('タブは 6 個まで');
    expect(shapeApplyPlan(s, 'short_strangle', c?.legs ?? [], 'new_tab')).toBeNull();
  });
});

describe('適用と [元に戻す]', () => {
  const one = run(loaded, {
    type: 'addBoardLeg',
    expiry: m1.id,
    k: m1.atm.B.pick?.k as number,
    optionType: 'call',
    side: 'buy',
  });
  const card = shapeCard(inputOf(one), form({ month: m2.id }));
  if (!card) throw new Error('card');

  it('[このタブに足す]: replaceLegs（前 + 形、expect = 前）→ [元に戻す] で前の足と同じ列', () => {
    const p = shapeApplyPlan(one, 'short_strangle', card.legs, 'current');
    if (p?.target !== 'current') throw new Error('plan');
    expect(p.action).toMatchObject({ type: 'replaceLegs', expect: one.legs, tab: one.activeTab });
    expect(p.text).toBe('ストラングル売り（2 本）を足した');
    const after = reduce(one, p.action);
    expect(after.legs).toHaveLength(3);
    expect(after.legs.slice(0, 1)).toEqual(one.legs);
    expect(after.legs[1]?.id).toBe(p.pickId);
    expect(after.legs.slice(1).map((l) => l.leg)).toEqual(card.legs.map((l) => l.leg));
    const back = reduce(after, p.undo);
    expect(back.legs).toEqual(one.legs);
  });

  it('保有のタブでも [このタブに足す] の計画が出て足が入る（板から足すのと同じ）', () => {
    const held = run(one, { type: 'setTabHeld', held: true });
    expect(activeHeld(held)).toBe(true);
    const p = shapeApplyPlan(held, 'short_strangle', card.legs, 'current');
    expect(p?.target).toBe('current');
    if (!p) return;
    expect(reduce(held, p.action).legs).toHaveLength(3);
  });

  it('[新しいタブに入れる]: タブ +1・足は形だけ → [元に戻す] で足したタブを閉じて元のタブ', () => {
    const p = shapeApplyPlan(one, 'short_strangle', card.legs, 'new_tab');
    if (p?.target !== 'new_tab') throw new Error('plan');
    expect(p.text).toBe('ストラングル売り（2 本）を新しいタブに入れた');
    const after = reduce(one, p.action);
    expect(after.tabs.length).toBe(one.tabs.length + 1);
    expect(after.legs.map((l) => l.leg)).toEqual(card.legs.map((l) => l.leg));
    expect(p.pickId).toBe(after.legs[0]?.id);
    const acts = newTabUndoActions(after, p.undo);
    if (typeof acts === 'string') throw new Error(acts);
    const back = acts.reduce(reduce, after);
    expect(back.tabs.length).toBe(one.tabs.length);
    expect(back.activeTab).toBe(one.activeTab);
    expect(back.legs).toEqual(one.legs);
  });

  it('足が無ければ計画は null', () => {
    expect(shapeApplyPlan(one, 'short_strangle', [], 'current')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { type Chain, type ChainJson, normalizeChain } from '../../data';
import { CALENDAR } from '../../ui/calendar';
import { refreshLegMarket } from '../../ui/legMarket';
import { bootState, readWorkspace, serializeWorkspace } from '../../ui/persist';
import { type Action, initialState, reduce, type State, type UiLeg } from '../../ui/state';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';

/** 合成の latest を書き換えた板（架空の値） */
function board(edit: (j: ChainJson) => void = () => {}): Chain {
  const j = fixture('latest');
  edit(j);
  return normalizeChain(j);
}

const withFuturePrice = (price: number | null) =>
  board((j) => {
    j.future.price = price;
  });
/** 2026-11 限が無い板（限月が進んだ板の代わり） */
const without11 = () =>
  board((j) => {
    j.months = j.months.filter((m) => m.contract_month !== '2026-11');
  });

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}
function loaded(chain: Chain): State {
  return reduce(initialState, { type: 'loaded', chain, label: 'latest' });
}
function legOf(s: State, id: number): UiLeg {
  const l = s.legs.find((x) => x.id === id);
  if (!l) throw new Error(`足 ${id} が無い`);
  return l;
}

/**
 * #23 オーナー決定: 新しい板を読んだら足の市場を今の板から作り直す（足を追加したときと同じ規則）。
 * 建値・枚数・売買・IV の編集は保存した値のまま。
 */
describe('足の市場の作り直し（loaded）', () => {
  const a = board();

  it('限月違いの先物の足: 価格は新しい板の先物価格。建値・枚数・売買は変えない', () => {
    const s0 = run(
      loaded(a),
      {
        type: 'addFutureLeg',
        input: { product: 'fut_mini', contract: '2027-03', side: 'sell', qty: 2, entry: 67000 },
      },
      { type: 'editLeg', id: 1, patch: { qty: 3 } },
    );
    expect(legOf(s0, 1).futureMarket?.market.price).toBe(67880);
    const s1 = reduce(s0, { type: 'loaded', chain: withFuturePrice(68500), label: 'API' });
    const l = legOf(s1, 1);
    expect(l.futureMarket?.market.price).toBe(68500);
    expect(l.futureMarket?.contract).toBe('2027-03');
    expect(l.leg).toEqual(legOf(s0, 1).leg);
    expect(l.leg).toMatchObject({ entry: 67000, qty: 3, side: 'sell' });
    expect(l.marks).toEqual(['future_manual']);
  });

  it('板の先物の足: 新しい板に先物価格が無ければ建値で評価して「先物価格なし」、戻れば外す', () => {
    const s0 = run(loaded(a), { type: 'addFutureLeg', input: { side: 'buy' } });
    const s1 = reduce(s0, { type: 'loaded', chain: withFuturePrice(null), label: 'API' });
    expect(legOf(s1, 1).marks).toEqual(['no_price']);
    expect(legOf(s1, 1).futureMarket?.market.price).toBe(67880);
    const s2 = reduce(s1, { type: 'loaded', chain: withFuturePrice(68100), label: 'API' });
    expect(legOf(s2, 1).marks).toEqual([]);
    expect(legOf(s2, 1).futureMarket?.market.price).toBe(68100);
    expect(legOf(s2, 1).leg.entry).toBe(67880);
  });

  it('手入力の OP（板に無い限月）: F を省いた足は新しい板の先物価格、F を入れた足は入れた値のまま', () => {
    const s0 = run(
      loaded(a),
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2027-01',
          type: 'call',
          k: 70000,
          side: 'buy',
          entry: 500,
          iv: 0.25,
        },
      },
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2027-02',
          type: 'put',
          k: 60000,
          side: 'sell',
          entry: 300,
          iv: 0.3,
          forward: 69000,
        },
      },
    );
    const s1 = reduce(s0, { type: 'loaded', chain: withFuturePrice(68500), label: 'API' });
    expect(legOf(s1, 1).optionMarket?.market.forward).toBe(68500);
    expect(legOf(s1, 1).marks).toEqual(['no_board', 'forward_from_future']);
    expect(legOf(s1, 2).optionMarket?.market.forward).toBe(69000);
    expect(legOf(s1, 2).marks).toEqual(['no_board']);
    // SQ 時刻は暦（足を入れたときと同じ）
    expect(legOf(s1, 1).optionMarket?.market.sqTime).toBe(legOf(s0, 1).optionMarket?.market.sqTime);
    expect(legOf(s1, 1).leg).toEqual(legOf(s0, 1).leg);
  });

  it('手入力の OP の限月が板に入った: 板の市場で評価（「板なし」を外す。足の市場は持ち続ける）', () => {
    const s0 = run(loaded(without11()), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2026-11',
        type: 'put',
        k: 64000,
        side: 'sell',
        entry: 800,
        iv: 0.2,
      },
    });
    expect(legOf(s0, 1).marks).toContain('no_board');
    const s1 = reduce(s0, { type: 'loaded', chain: a, label: 'API' });
    const l = legOf(s1, 1);
    // 限月の無い板をあとで読んだときに作り直すため持ち続ける（F は代用だったので NaN = 入れていない）
    expect(l.optionMarket?.expiry).toBe('2026-11');
    expect(l.optionMarket?.market.sqTime).toBe(legOf(s0, 1).optionMarket?.market.sqTime);
    expect(l.optionMarket?.market.forward).toBeNaN();
    expect(l.marks).not.toContain('no_board');
    expect(l.leg).toEqual(legOf(s0, 1).leg);
    const row = positionModel(a, s1.legs, 'B', CALENDAR).rows[0];
    expect(row?.error).toBeNull();
    expect(row?.iv).toBeCloseTo(0.2, 12);
  });

  it('手入力の OP: 板に入った → 限月の無い板に戻ると、入れた F・前の市場で評価できる（退行しない）', () => {
    const s0 = run(
      loaded(without11()),
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2026-11',
          type: 'put',
          k: 64000,
          side: 'sell',
          entry: 800,
          iv: 0.2,
          forward: 69000,
        },
      },
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2026-11',
          type: 'call',
          k: 72000,
          side: 'buy',
          entry: 300,
          iv: 0.22,
        },
      },
    );
    const s1 = reduce(s0, { type: 'loaded', chain: a, label: 'API' });
    expect(legOf(s1, 1).optionMarket?.market.forward).toBe(69000);
    expect(legOf(s1, 1).marks).not.toContain('no_board');
    // 古い板・限月の無い板を読み直す（先物価格は 68,200 の架空の値）
    const old = board((j) => {
      j.months = j.months.filter((m) => m.contract_month !== '2026-11');
      j.future.price = 68200;
    });
    const s2 = reduce(s1, { type: 'loaded', chain: old, label: 'file' });
    const l1 = legOf(s2, 1);
    const l2 = legOf(s2, 2);
    // F を入れた足は入れた値、代用だった足は今の板の先物価格。SQ は暦（入れたときと同じ）
    expect(l1.optionMarket?.market.forward).toBe(69000);
    expect(l1.marks).toEqual(['no_board']);
    expect(l2.optionMarket?.market.forward).toBe(68200);
    expect(l2.marks).toEqual(['no_board', 'forward_from_future']);
    expect(l1.optionMarket?.market.sqTime).toBe(legOf(s0, 1).optionMarket?.market.sqTime);
    expect(l1.leg).toEqual(legOf(s0, 1).leg);
    expect(l2.leg).toEqual(legOf(s0, 2).leg);
    const rows = positionModel(old, s2.legs, 'B', CALENDAR).rows;
    expect(rows.map((r) => r.error)).toEqual([null, null]);
    expect(rows[0]?.iv).toBeCloseTo(0.2, 12);
    // F を入れた足は、板に入る前の足（入れたときの市場）を同じ板で評価したものと同じ（F・SQ・IV が戻っている）。
    // 同じ限月の足の市場は限月ごとに 1 つ（positionContext）なので 1 本ずつ比べる
    const after1 = positionModel(old, [l1], 'B', CALENDAR).rows[0];
    const before1 = positionModel(old, [legOf(s0, 1)], 'B', CALENDAR).rows[0];
    expect(after1?.greeks).not.toBeNull();
    expect(after1?.greeks).toEqual(before1?.greeks);
    expect(after1?.sqDate).toBe(before1?.sqDate);
  });

  it('手入力の OP の市場は保存・復元を挟んでも持ち続ける（限月が板にある間）', () => {
    const s0 = run(loaded(without11()), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2026-11',
        type: 'put',
        k: 64000,
        side: 'sell',
        entry: 800,
        iv: 0.2,
        forward: 69000,
      },
    });
    const s1 = reduce(s0, { type: 'loaded', chain: a, label: 'API' });
    const read = readWorkspace(serializeWorkspace(s1, 0));
    if (read.kind !== 'ok') throw new Error('読めない');
    const restored = bootState(read);
    const s2 = reduce(restored, { type: 'loaded', chain: without11(), label: 'file' });
    expect(legOf(s2, 1).optionMarket?.market.forward).toBe(69000);
    expect(positionModel(without11(), s2.legs, 'B', CALENDAR).rows[0]?.error).toBeNull();
  });

  it('限月違いの先物の足: 新しい板にその限月が無くても暦の SQ と先物価格で評価できる', () => {
    const s0 = run(loaded(a), {
      type: 'addFutureLeg',
      input: { product: 'fut_mini', contract: '2026-11', side: 'buy', qty: 1, entry: 67500 },
    });
    const next = board((j) => {
      j.months = j.months.filter((m) => m.contract_month !== '2026-11');
      j.future.price = 68300;
    });
    const s1 = reduce(s0, { type: 'loaded', chain: next, label: 'file' });
    const l = legOf(s1, 1);
    expect(l.futureMarket?.market.price).toBe(68300);
    expect(l.futureMarket?.market.sqTime).toBe(legOf(s0, 1).futureMarket?.market.sqTime);
    expect(l.leg).toEqual(legOf(s0, 1).leg);
    expect(positionModel(next, s1.legs, 'B', CALENDAR).rows[0]?.error).toBeNull();
  });

  it('板の足で限月が無くなった: 作り直せないのでそのまま（既存の行のエラー）', () => {
    const month = a.months[0];
    const k = month?.rows[Math.floor(month.rows.length / 2)]?.k;
    if (!month || k === undefined) throw new Error('行が無い');
    const s0 = run(loaded(a), {
      type: 'addBoardLeg',
      expiry: month.id,
      k,
      optionType: 'put',
      side: 'sell',
    });
    const next = without11();
    const s1 = reduce(s0, { type: 'loaded', chain: next, label: 'API' });
    expect(legOf(s1, 1)).toEqual(legOf(s0, 1));
    const row = positionModel(next, s1.legs, 'B', CALENDAR).rows[0];
    expect(row?.error).toMatch(/板に無い限月（2026-11）/);
  });

  it('板の足の行の印（補間・気配なし等）は足を入れたときのまま', () => {
    const ui: UiLeg = {
      id: 7,
      leg: {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2026-12',
        strike: 64000,
        side: 'sell',
        qty: 1,
        entry: 810,
        mid: 815,
      },
      marks: ['no_quote', 'interpolated', 'forward_from_future'],
    };
    const out = refreshLegMarket(a, ui, CALENDAR.holidays);
    const m = a.months.find((x) => x.id === '2026-12');
    expect(out.marks).toEqual(
      m?.syntheticOk
        ? ['no_quote', 'interpolated']
        : ['no_quote', 'interpolated', 'forward_from_future'],
    );
    expect(out.leg).toBe(ui.leg);
    expect(out.id).toBe(7);
  });
});

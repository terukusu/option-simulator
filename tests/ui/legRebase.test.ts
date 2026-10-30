import { describe, expect, it } from 'vitest';
import { type Chain, type ChainJson, normalizeChain } from '../../data';
import { rebaseLegs } from '../../ui/legRebase';
import {
  type Action,
  initialState,
  reduce,
  type State,
  sameUiLeg,
  type UiLeg,
} from '../../ui/state';
import { fixture } from '../support/fixtures';

/**
 * #298 建値を今の板に合わせる（rebaseLegs）。合成の latest を書き換えた板（架空の値）。
 * 2026-11 限 K = 64,000 のプット: bid 780 / ask 805、2026-12 限 K = 70,000 のコール: bid 1,750 / ask 1,770。
 * 板の先物は 2026-12 限 67,880。
 */

function board(edit: (j: ChainJson) => void = () => {}): Chain {
  const j = fixture('latest');
  edit(j);
  return normalizeChain(j);
}
/** 行の気配を書き換える */
function quote(
  month: string,
  k: number,
  type: 'call' | 'put',
  bid: number | null,
  ask: number | null,
): (j: ChainJson) => void {
  return (j) => {
    const row = j.months.find((m) => m.contract_month === month)?.rows.find((r) => r.k === k);
    if (!row) throw new Error(`行が無い: ${month} ${k}`);
    row[type].bid = bid;
    row[type].ask = ask;
  };
}

const a = board();
const holidays = initialState.calendar.holidays;

const run = (s: State, ...acts: Action[]) => acts.reduce(reduce, s);
const loaded = (c: Chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'x' });
const sellPut64 = {
  type: 'addBoardLeg',
  expiry: '2026-11',
  k: 64000,
  optionType: 'put',
  side: 'sell',
} as const;
const buyCall70 = {
  type: 'addBoardLeg',
  expiry: '2026-12',
  k: 70000,
  optionType: 'call',
  side: 'buy',
} as const;

/** 板 a で足 2 本を入れ、建値を板と違う値にした state */
function stale(): State {
  return run(
    loaded(a),
    sellPut64,
    buyCall70,
    { type: 'editLeg', id: 1, patch: { entry: 700, qty: 3 } },
    { type: 'editLeg', id: 2, patch: { entry: 1900 } },
  );
}

describe('建値を今の板に合わせる（rebaseLegs。#298）', () => {
  it('AC1: 両側気配の売り = bid・買い = ask。id・枚数・売買・並びは変わらない', () => {
    const s = stale();
    const r = rebaseLegs(a, s.legs, holidays);
    expect(r.changed).toBe(2);
    expect(r.kept).toBe(0);
    expect(r.legs.map((l) => l.id)).toEqual([1, 2]);
    expect(r.legs[0]?.leg).toMatchObject({ side: 'sell', qty: 3, strike: 64000, entry: 780 });
    expect(r.legs[1]?.leg).toMatchObject({ side: 'buy', qty: 1, strike: 70000, entry: 1770 });
    expect(r.legs[0]?.leg.kind === 'option' && r.legs[0].leg.mid).toBe((780 + 805) / 2);
  });

  it('AC2: IV を編集した足は建値だけ変わり、編集した IV は残る', () => {
    const s = run(stale(), { type: 'editLeg', id: 1, patch: { iv: 0.31 } });
    const r = rebaseLegs(a, s.legs, holidays);
    const l = r.legs[0]?.leg;
    expect(l?.entry).toBe(780);
    expect(l?.kind === 'option' && l.iv).toBe(0.31);
    // IV を編集していない足に iv のキーを足さない（保存・構造比較が変わらない）
    expect(Object.hasOwn(r.legs[1]?.leg ?? {}, 'iv')).toBe(false);
  });

  it('AC3a: 必要な側だけの片側気配でも建て直す（売り bid_only → bid、買い ask_only → ask）。印は気配なし・mid は null', () => {
    const s = stale();
    const c = board((j) => {
      quote('2026-11', 64000, 'put', 790, null)(j);
      quote('2026-12', 70000, 'call', null, 1760)(j);
    });
    const r = rebaseLegs(c, s.legs, holidays);
    expect(r.changed).toBe(2);
    expect(r.kept).toBe(0);
    for (const [i, entry] of [
      [0, 790],
      [1, 1760],
    ] as const) {
      const ui = r.legs[i];
      expect(ui?.leg.entry).toBe(entry);
      expect(ui?.marks).toContain('no_quote');
      expect(ui?.leg.kind === 'option' && ui.leg.mid).toBeNull();
    }
  });

  it('AC3b: 必要な側が無い行・気配なし・逆転は据え置き（同じ参照）で、据え置きの本数に数える', () => {
    const s = stale();
    const cases: ((j: ChainJson) => void)[][] = [
      // 売りで ask だけ・買いで bid だけ
      [quote('2026-11', 64000, 'put', null, 805), quote('2026-12', 70000, 'call', 1750, null)],
      // 気配なし
      [quote('2026-11', 64000, 'put', null, null), quote('2026-12', 70000, 'call', 0, 0)],
      // 逆転（bid > ask）
      [quote('2026-11', 64000, 'put', 830, 805), quote('2026-12', 70000, 'call', 1800, 1770)],
    ];
    for (const edits of cases) {
      const c = board((j) => {
        for (const e of edits) e(j);
      });
      const r = rebaseLegs(c, s.legs, holidays);
      expect(r).toMatchObject({ changed: 0, kept: 2 });
      r.legs.forEach((l, i) => {
        expect(l).toBe(s.legs[i]);
      });
    }
  });

  it('AC3b: 板に無い限月の板の足・板に無い限月の手入力の足は据え置き', () => {
    const without11 = board((j) => {
      j.months = j.months.filter((m) => m.contract_month !== '2026-11');
    });
    const s0 = run(stale(), {
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
    });
    // 2026-11 限の無い板を読む（足 1 は行のエラーの足になる）
    const s = reduce(s0, { type: 'loaded', chain: without11, label: 'y' });
    const before = s.legs.map((l) => ({ ...l }));
    const r = rebaseLegs(without11, s.legs, holidays);
    expect(r.changed).toBe(1);
    expect(r.kept).toBe(2);
    expect(r.legs[0]).toBe(s.legs[0]);
    expect(r.legs[2]).toBe(s.legs[2]);
    expect(sameUiLeg(r.legs[0] as UiLeg, before[0] as UiLeg)).toBe(true);
    expect(r.legs[1]?.leg.entry).toBe(1770);
  });

  it('AC3b: 限月は板にあるが行使価格が板の行に無い手入力の足は据え置き', () => {
    const s = run(stale(), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2026-12',
        type: 'call',
        k: 70001,
        side: 'sell',
        entry: 1500,
        iv: 0.22,
      },
    });
    const manual = s.legs[2] as UiLeg;
    expect(manual.leg).toMatchObject({ expiry: '2026-12', strike: 70001 });
    const r = rebaseLegs(a, s.legs, holidays);
    expect(r).toMatchObject({ changed: 2, kept: 1 });
    expect(r.legs[2]).toBe(manual);
  });

  it('AC4: 先物の足は板の先物の限月 = 先物価格、限月違い = 合成先物か先物価格。価格が無ければ据え置き', () => {
    const s = run(
      loaded(a),
      { type: 'addFutureLeg', input: { side: 'buy', entry: 67000 } },
      { type: 'addFutureLeg', input: { contract: '2026-11', side: 'sell', entry: 66000 } },
      {
        type: 'addFutureLeg',
        input: { product: 'fut_large', contract: '2027-03', side: 'sell', qty: 2, entry: 66500 },
      },
    );
    const m11 = a.months.find((m) => m.id === '2026-11');
    expect(m11?.syntheticOk).toBe(true);
    const r = rebaseLegs(a, s.legs, holidays);
    expect(r).toMatchObject({ changed: 3, kept: 0 });
    expect(r.legs.map((l) => l.leg.entry)).toEqual([67880, m11?.F, 67880]);
    r.legs.forEach((l, i) => {
      const b = s.legs[i] as UiLeg;
      expect({ ...l.leg, entry: 0 }).toEqual({ ...b.leg, entry: 0 });
      expect(l.marks).toEqual(b.marks);
      expect(l.futureMarket).toEqual(b.futureMarket);
    });

    const noPrice = board((j) => {
      j.future.price = null;
    });
    const s2 = reduce(s, { type: 'loaded', chain: noPrice, label: 'z' });
    const r2 = rebaseLegs(noPrice, s2.legs, holidays);
    // 板の先物の限月と 2027-03 は価格が無く据え置き。2026-11 は合成先物があるので建て直す
    expect(r2.kept).toBe(2);
    expect(r2.legs[0]).toBe(s2.legs[0]);
    expect(r2.legs[2]).toBe(s2.legs[2]);
    expect(r2.legs[1]?.leg.entry).toBe(noPrice.months.find((m) => m.id === '2026-11')?.F);
  });

  it('AC5: 手入力の OP の足は限月・行使価格が今の板にあれば建値を合わせ、手入力の IV と足の市場は保つ', () => {
    const without11 = board((j) => {
      j.months = j.months.filter((m) => m.contract_month !== '2026-11');
    });
    const s0 = run(loaded(without11), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2026-11',
        type: 'put',
        k: 64000,
        side: 'sell',
        entry: 700,
        iv: 0.2,
      },
    });
    const s = reduce(s0, { type: 'loaded', chain: a, label: 'x' });
    const before = s.legs[0] as UiLeg;
    expect(before.optionMarket).toBeDefined();
    const r = rebaseLegs(a, s.legs, holidays);
    expect(r).toMatchObject({ changed: 1, kept: 0 });
    const after = r.legs[0] as UiLeg;
    expect(after.leg).toMatchObject({ entry: 780, iv: 0.2, side: 'sell', strike: 64000 });
    expect(after.leg.kind === 'option' && after.leg.mid).toBe((780 + 805) / 2);
    expect(after.optionMarket).toBe(before.optionMarket);
    expect(after.marks).not.toContain('no_board');
  });

  it('AC6: 板から入れた直後の足は changed 0。建て直しは冪等', () => {
    const fresh = run(loaded(a), sellPut64, buyCall70);
    expect(rebaseLegs(a, fresh.legs, holidays)).toMatchObject({ changed: 0, kept: 0 });
    const once = rebaseLegs(a, stale().legs, holidays);
    expect(rebaseLegs(a, once.legs, holidays).changed).toBe(0);
  });

  it('AC10: 足 0 本・板なしでも例外を投げない', () => {
    expect(rebaseLegs(a, [], holidays)).toEqual({ legs: [], changed: 0, kept: 0 });
    expect(rebaseLegs(null, [], holidays)).toEqual({ legs: [], changed: 0, kept: 0 });
    const s = stale();
    const r = rebaseLegs(null, s.legs, holidays);
    expect(r).toMatchObject({ changed: 0, kept: 2 });
    expect(r.legs).toEqual(s.legs);
    expect(r.legs).not.toBe(s.legs);
  });
});

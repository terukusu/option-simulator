import { describe, expect, it } from 'vitest';
import type { ChainJson } from '../../data';
import {
  boardOptionLeg,
  buildMarketContext,
  futureLeg,
  manualEntryDefault,
  manualOptionLeg,
  quotedSidePrice,
} from '../../data/legs';
import { normalizeChain } from '../../data/normalize';
import { evaluatePosition, preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { fixture } from '../support/fixtures';

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が 2 本ない');

type Month = (typeof chain.months)[number];

/** 条件に合う最初の行（K の昇順）。 */
function findStrike(m: Month, pred: (s: Month['strikes'][number]) => boolean): number {
  const s = m.strikes.find(pred);
  if (!s) throw new Error('条件に合う行が無い');
  return s.k;
}

describe('板の足', () => {
  it('建値の既定は買い = ask、売り = bid（D6）、mid も入る。印なし', () => {
    const k = 64000;
    const row = m1.rows.find((r) => r.k === k);
    const sell = boardOptionLeg(chain, { expiry: m1.id, k, type: 'put', side: 'sell' });
    const buy = boardOptionLeg(chain, { expiry: m1.id, k, type: 'put', side: 'buy', qty: 2 });
    expect(sell.leg).toMatchObject({
      kind: 'option',
      product: 'op_large',
      expiry: '2026-11',
      strike: k,
      side: 'sell',
      qty: 1,
      entry: row?.put.bid,
    });
    expect(buy.leg.entry).toBe(row?.put.ask);
    expect(buy.leg.qty).toBe(2);
    expect(sell.leg.mid).toBe(((row?.put.bid ?? 0) + (row?.put.ask ?? 0)) / 2);
    expect(sell.marks).toEqual([]);
  });

  it('AC16: 不安定な行を足にすると「IV 不安定」、外挿の行は「外挿」の印', () => {
    const k = findStrike(
      m1,
      (s) => s.otmType === 'put' && s.unstable && s.put.quote === 'two_sided',
    );
    const b = boardOptionLeg(chain, { expiry: m1.id, k, type: 'put', side: 'sell' });
    expect(b.marks).toContain('unstable_iv');
    expect(b.marks).toContain('extrapolated');
  });

  it('片側気配の行は「気配なし」の印で、建値の既定は ask − 呼値（5.3 (ii)）', () => {
    const k = findStrike(m1, (s) => s.call.quote === 'ask_only' && s.k > m1.F);
    const ask = m1.rows.find((r) => r.k === k)?.call.ask as number;
    const b = boardOptionLeg(chain, { expiry: m1.id, k, type: 'call', side: 'sell' });
    expect(b.marks).toContain('no_quote');
    expect(b.leg.entry).toBe(Math.max(ask - 1, 0));
    expect(b.leg.mid).toBeNull();
  });

  it('気配の無い行は建値の既定がスマイルの理論価格（呼値に丸め）で、「補間」の印', () => {
    const k = findStrike(m1, (s) => s.call.quote === 'none' && s.put.quote === 'none');
    const b = boardOptionLeg(chain, { expiry: m1.id, k, type: 'put', side: 'buy' });
    // IV が作れない行なので「IV 不安定」は付けない
    expect(b.marks).toEqual(['no_quote', 'interpolated']);
    expect(b.leg.entry).toBe(manualEntryDefault(m1, k, 'put', null, chain.r));
    expect(b.leg.entry).toBeGreaterThan(0);
    expect(Number.isInteger(b.leg.entry)).toBe(true);
  });

  it('板に無い限月・行使価格は例外', () => {
    expect(() =>
      boardOptionLeg(chain, { expiry: '2027-01', k: 64000, type: 'put', side: 'sell' }),
    ).toThrow();
    expect(() =>
      boardOptionLeg(chain, { expiry: m1.id, k: 64001, type: 'put', side: 'sell' }),
    ).toThrow();
  });
});

describe('売買に必要な側の気配（quotedSidePrice。#298）', () => {
  /** 2026-11 限 K = 64,000 のプットの気配だけを書き換えた板（架空の値） */
  function withPut(bid: number | null, ask: number | null) {
    const j: ChainJson = fixture('latest');
    const row = j.months[0]?.rows.find((r) => r.k === 64000);
    if (!row) throw new Error('行が無い');
    row.put.bid = bid;
    row.put.ask = ask;
    return normalizeChain(j);
  }
  const at = (c: typeof chain, side: 'buy' | 'sell') =>
    quotedSidePrice(c, { expiry: '2026-11', k: 64000, type: 'put', side });

  it('両側気配: 売り = bid、買い = ask', () => {
    const c = withPut(780, 805);
    expect(at(c, 'sell')).toBe(780);
    expect(at(c, 'buy')).toBe(805);
  });

  it('片側気配: 必要な側があれば使い、無ければ null', () => {
    const bidOnly = withPut(780, null);
    expect(bidOnly.months[0]?.strikes.find((s) => s.k === 64000)?.put.quote).toBe('bid_only');
    expect(at(bidOnly, 'sell')).toBe(780);
    expect(at(bidOnly, 'buy')).toBeNull();
    const askOnly = withPut(null, 805);
    expect(askOnly.months[0]?.strikes.find((s) => s.k === 64000)?.put.quote).toBe('ask_only');
    expect(at(askOnly, 'sell')).toBeNull();
    expect(at(askOnly, 'buy')).toBe(805);
  });

  it('気配なし・逆転（bid > ask）は両側とも null', () => {
    for (const c of [withPut(null, null), withPut(0, 0), withPut(830, 805)]) {
      expect(c.months[0]?.strikes.find((s) => s.k === 64000)?.put.quote).toBe('none');
      expect(at(c, 'sell')).toBeNull();
      expect(at(c, 'buy')).toBeNull();
    }
  });

  it('板に無い限月・行使価格は null（例外を投げない）', () => {
    expect(
      quotedSidePrice(chain, { expiry: '2027-01', k: 64000, type: 'put', side: 'sell' }),
    ).toBeNull();
    expect(
      quotedSidePrice(chain, { expiry: m1.id, k: 64001, type: 'put', side: 'buy' }),
    ).toBeNull();
  });
});

describe('手入力の足（板の無い限月。5.7 (a)・AC17）', () => {
  const manual = manualOptionLeg(
    chain,
    {
      product: 'op_large',
      expiry: '2027-01',
      type: 'put',
      k: 62000,
      side: 'sell',
      entry: 900,
      iv: 0.27,
    },
    [],
  );

  it('「板なし（手入力）」の印、SQ 日は暦から、F は先物価格（basis 0）', () => {
    expect(manual.marks).toEqual(['no_board', 'forward_from_future']);
    expect(manual.leg).toMatchObject({
      expiry: '2027-01',
      strike: 62000,
      entry: 900,
      iv: 0.27,
      mid: null,
    });
    // 2027-01 の第 2 金曜 = 1 月 8 日（休業日の一覧を渡さないとき）
    expect(manual.market.sqTime).toBe(Date.parse('2027-01-08T09:00:00+09:00'));
    expect(manual.market.forward).toBe(67880);
    expect(manual.market.smile).toBeNull();
  });

  it('休業日を渡すと SQ 日が前営業日に繰り上がる。F を指定すれば先物の代用の印は付かない', () => {
    const m = manualOptionLeg(
      chain,
      {
        product: 'op_large',
        expiry: '2027-01',
        type: 'call',
        k: 72000,
        side: 'buy',
        entry: 500,
        iv: 0.24,
        forward: 67950,
      },
      ['2027-01-08'],
    );
    expect(m.market.sqTime).toBe(Date.parse('2027-01-07T09:00:00+09:00'));
    expect(m.market.forward).toBe(67950);
    expect(m.marks).toEqual(['no_board']);
  });

  it('板にある限月なら板の市場を使い、印は付かない', () => {
    const m = manualOptionLeg(chain, {
      product: 'op_large',
      expiry: m1.id,
      type: 'put',
      k: 64000,
      side: 'sell',
      entry: 800,
      iv: 0.29,
    });
    expect(m.marks).toEqual([]);
    expect(m.market.forward).toBe(m1.F);
    expect(m.market.smile).not.toBeNull();
  });

  it('板にある限月で F を指定すると例外（板の合成先物を使う）', () => {
    expect(() =>
      manualOptionLeg(chain, {
        product: 'op_large',
        expiry: m1.id,
        type: 'put',
        k: 64000,
        side: 'sell',
        entry: 800,
        iv: 0.29,
        forward: 68000,
      }),
    ).toThrow(/forward は指定できない/);
  });

  it('板が無くても（chain = null）F を入れれば足になる。不正な入力は例外', () => {
    const m = manualOptionLeg(null, {
      product: 'op_large',
      expiry: '2027-03',
      type: 'put',
      k: 60000,
      side: 'sell',
      entry: 700,
      iv: 0.3,
      forward: 68000,
    });
    expect(m.marks).toEqual(['no_board']);
    const base = {
      product: 'op_large',
      expiry: '2027-03',
      type: 'put',
      k: 60000,
      side: 'sell',
      entry: 1,
    } as const;
    expect(() => manualOptionLeg(chain, { ...base, iv: 0 })).toThrow(/IV/);
    expect(() => manualOptionLeg(chain, { ...base, iv: 25 / 0 })).toThrow(/IV/);
    expect(() => manualOptionLeg(chain, { ...base, iv: 0.2, k: 0 })).toThrow(/行使価格/);
    expect(() => manualOptionLeg(chain, { ...base, iv: 0.2, entry: -1 })).toThrow(/建値/);
    expect(() => manualOptionLeg(chain, { ...base, iv: 0.2, expiry: '2027-13' })).toThrow(/限月/);
  });
});

describe('先物の足', () => {
  it('既定はミニ先物・板の先物の限月・建値 = 先物価格', () => {
    const f = futureLeg(chain, { side: 'buy' });
    expect(f.leg).toEqual({
      kind: 'future',
      product: 'fut_mini',
      contract: '2026-12',
      side: 'buy',
      qty: 1,
      entry: 67880,
    });
    expect(f.marks).toEqual([]);
    expect(f.market).toEqual({ sqTime: chain.future.sqTime, price: 67880 });
  });

  it('板に無い先物の限月（ミニの毎月限月）は手入力。初期値はその月の合成先物', () => {
    const f = futureLeg(chain, { product: 'fut_mini', contract: '2026-11', side: 'sell', qty: 3 });
    expect(f.marks).toEqual(['future_manual']);
    expect(f.leg.entry).toBe(m1.F);
    expect(f.market.sqTime).toBe(m1.sqTime);
    // 板の限月の SQ 日は板（サーバーのカレンダー）のもの。休業日の一覧を渡しても暦で求め直さない
    expect(
      futureLeg(chain, { contract: '2026-11', side: 'buy' }, ['2026-11-13']).market.sqTime,
    ).toBe(m1.sqTime);
    const g = futureLeg(chain, {
      product: 'fut_micro',
      contract: '2027-03',
      side: 'buy',
      entry: 68000,
    });
    expect(g.leg.entry).toBe(68000);
    expect(g.market.price).toBe(67880);
    expect(g.market.sqTime).toBe(Date.parse('2027-03-12T09:00:00+09:00'));
  });

  it('板に先物価格が無いと「価格なし」の印で、評価価格は建値（NaN を出さない）。建値が無ければ例外', () => {
    const j = fixture('latest');
    j.future.price = null;
    const c = normalizeChain(j);
    const f = futureLeg(c, { side: 'buy', entry: 67900 });
    expect(f.marks).toEqual(['no_price']);
    expect(f.market.price).toBe(67900);
    expect(f.leg.entry).toBe(67900);
    // 板の無い限月でも、合成先物が決まれば価格はある
    expect(futureLeg(c, { contract: '2026-11', side: 'buy' }).marks).toEqual(['future_manual']);
    expect(() => futureLeg(c, { side: 'buy' })).toThrow(/建値の入力が要る/);
    expect(() => futureLeg(c, { contract: '2027-03', side: 'buy' })).toThrow(/建値の入力が要る/);
    // 市場には先物価格の無い限月を入れない（足の market を extraFutures で渡す）
    expect(buildMarketContext(c).futures).toEqual({});
    const ctx = buildMarketContext(c, { extraFutures: { [f.leg.contract]: f.market } });
    expect(ctx.futures[f.leg.contract]?.price).toBe(67900);
  });
});

describe('AC17: 足ごとの商品・限月で市場を組み、乗数と SQ 日が反映される', () => {
  const sellM1 = boardOptionLeg(chain, { expiry: m1.id, k: 64000, type: 'put', side: 'sell' });
  const buyM2 = boardOptionLeg(chain, { expiry: m2.id, k: 64000, type: 'put', side: 'buy' });
  const manual = manualOptionLeg(chain, {
    product: 'op_large',
    expiry: '2027-01',
    type: 'put',
    k: 62000,
    side: 'buy',
    entry: 900,
    iv: 0.27,
  });
  const mini = futureLeg(chain, { side: 'buy' });
  const ctx = buildMarketContext(chain, {
    extraOptions: { [manual.leg.expiry]: manual.market },
  });
  const legs = [sellM1.leg, buyM2.leg, manual.leg, mini.leg];
  const prepared = preparePosition(legs, ctx);

  it('1 限月売り + 2 限月買い + 板の無い限月 + ミニ先物が組める', () => {
    expect(Object.keys(ctx.options).sort()).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(Object.keys(ctx.futures)).toEqual(['2026-12']);
    expect(ctx.x0).toBe(m1.F);
    expect(prepared.map((p) => p.multiplier)).toEqual([1000, 1000, 1000, 100]);
    expect(prepared.map((p) => p.expiryTime)).toEqual([
      m1.sqTime,
      m2.sqTime,
      Date.parse('2027-01-08T09:00:00+09:00'),
      chain.future.sqTime,
    ]);
    expect(prepared[2]?.option?.anchorSource).toBe('manual');
    expect(prepared[2]?.option?.anchor).toBe(0.27);
  });

  it('シナリオ 0（d = 0）: 板の足・先物は 0 円、手入力の足は建値ずれの分だけ', () => {
    const ev = evaluatePosition(prepared, ZERO_SCENARIO, ctx);
    expect(ev.legs.every((l) => Number.isFinite(l.pnl))).toBe(true);
    for (const i of [0, 1, 3]) expect(Math.abs(ev.legs[i]?.pnl ?? 1)).toBeLessThan(1e-6);
    // 手入力（建値 900・IV 27%）は建値と IV が独立なので、理論価格との差が建値ずれとして出る
    const mismatch = prepared[2]?.option?.mismatch ?? 0;
    expect(Math.abs(mismatch)).toBeGreaterThan(1);
    expect(ev.legs[2]?.pnl).toBeCloseTo(-mismatch * 1000, 6);
  });

  it('基準 A なら横軸の X₀ は先物価格', () => {
    expect(buildMarketContext(chain, { atmBasis: 'A' }).x0).toBe(67880);
  });
});

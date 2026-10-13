import { describe, expect, it } from 'vitest';
import { type Chain, manualEntryDefault, normalizeChain } from '../../data';
import type { OptionLeg, OptionType } from '../../model';
import {
  type Action,
  initialState,
  parseContract,
  parseEntry,
  parseIvPct,
  parseQty,
  parseStrike,
  reduce,
  type State,
} from '../../ui/state';
import { fixture } from '../support/fixtures';

function loaded(chain: Chain): State {
  return reduce(initialState, { type: 'loaded', chain, label: 'latest' });
}

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

describe('板の操作（AC-8・M3）', () => {
  const chain = normalizeChain(fixture('latest'));
  const month = chain.months[0];
  if (!month) throw new Error('限月が無い');

  function findRow(type: OptionType, quote: string) {
    const i = month?.strikes.findIndex((s) => s[type].quote === quote) ?? -1;
    const src = month?.source[i];
    if (i < 0 || !src) throw new Error(`${type} の ${quote} の行が無い`);
    return { k: src.k, side: src[type] };
  }

  it.each<OptionType>(['put', 'call'])(
    '両側気配の %s: bid = 売り・建値 bid、ask = 買い・建値 ask',
    (type) => {
      const { k, side } = findRow(type, 'two_sided');
      const s1 = run(loaded(chain), {
        type: 'addBoardLeg',
        expiry: month.id,
        k,
        optionType: type,
        side: 'sell',
      });
      expect(s1.legs).toHaveLength(1);
      const sell = s1.legs[0]?.leg as OptionLeg;
      expect(sell).toMatchObject({
        kind: 'option',
        side: 'sell',
        entry: side.bid,
        strike: k,
        type,
      });
      expect(s1.legs[0]?.marks).not.toContain('no_quote');

      const s2 = run(s1, {
        type: 'addBoardLeg',
        expiry: month.id,
        k,
        optionType: type,
        side: 'buy',
      });
      expect(s2.legs).toHaveLength(2);
      expect(s2.legs[1]?.leg).toMatchObject({ side: 'buy', entry: side.ask });
      expect(s2.legs[1]?.id).not.toBe(s2.legs[0]?.id);
    },
  );

  it('片側気配の行: 「気配なし」の印と manualEntryDefault の建値', () => {
    const idx = month.strikes.findIndex(
      (s) => s.put.quote === 'ask_only' || s.put.quote === 'bid_only',
    );
    const info = month.strikes[idx];
    const src = month.source[idx];
    expect(info).toBeDefined();
    if (!info || !src) return;
    for (const side of ['buy', 'sell'] as const) {
      const s = run(loaded(chain), {
        type: 'addBoardLeg',
        expiry: month.id,
        k: info.k,
        optionType: 'put',
        side,
      });
      expect(s.legs[0]?.marks).toContain('no_quote');
      expect(s.legs[0]?.leg.entry).toBe(
        manualEntryDefault(month, info.k, 'put', src.put.ask, chain.r),
      );
    }
  });
});

describe('reducer', () => {
  const chain = normalizeChain(fixture('latest'));
  const m1 = chain.months[0]?.id as string;
  const k = chain.months[0]?.atm.B.pick?.k as number;

  it('足の編集・削除・全クリア', () => {
    let s = run(
      loaded(chain),
      { type: 'addBoardLeg', expiry: m1, k, optionType: 'put', side: 'sell' },
      { type: 'addBoardLeg', expiry: m1, k, optionType: 'call', side: 'sell' },
    );
    const id = s.legs[0]?.id as number;
    s = reduce(s, { type: 'editLeg', id, patch: { qty: 3, entry: 500, iv: 0.3, side: 'buy' } });
    expect(s.legs[0]?.leg).toMatchObject({ qty: 3, entry: 500, iv: 0.3, side: 'buy' });
    s = reduce(s, { type: 'editLeg', id, patch: { iv: null } });
    expect('iv' in (s.legs[0]?.leg ?? {})).toBe(false);
    s = reduce(s, { type: 'removeLeg', id });
    expect(s.legs).toHaveLength(1);
    s = reduce(s, { type: 'clearLegs' });
    expect(s.legs).toHaveLength(0);
  });

  it('読み直してもポジションは残る。壊れた板では前の板を保持', () => {
    let s = run(
      loaded(chain),
      { type: 'setMonth', monthId: chain.months[1]?.id as string },
      { type: 'addBoardLeg', expiry: m1, k, optionType: 'put', side: 'sell' },
      { type: 'loading' },
      { type: 'loadFailed', error: { message: '板の JSON が不正', errors: ['$: x'] } },
    );
    expect(s.chain).toBe(chain);
    expect(s.loadError?.message).toBe('板の JSON が不正');
    expect(s.loading).toBe(false);
    const other = normalizeChain(fixture('night_early'));
    s = reduce(s, { type: 'loaded', chain: other, label: 'night_early' });
    expect(s.legs).toHaveLength(1);
    expect(s.monthId).toBe(chain.months[1]?.id);
    expect(s.loadError).toBeNull();
  });

  it('data/ の例外は legError に入り、足は増えない', () => {
    const s = reduce(loaded(chain), {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2027-01',
        type: 'put',
        k: 60000,
        side: 'sell',
        entry: 100,
        iv: 0,
      },
    });
    expect(s.legs).toHaveLength(0);
    expect(s.legError).toBe('IV は正の数（小数）');
  });

  it('基準・種別・絞り込み・軸・拡大', () => {
    const s = run(
      loaded(chain),
      { type: 'setBasis', basis: 'A' },
      { type: 'setTarget', target: 'call' },
      { type: 'setFilterAsk', on: true },
      { type: 'setViewport', viewport: [60000, 70000] },
      { type: 'setAxis', axis: 'delta' },
    );
    expect(s).toMatchObject({
      atmBasis: 'A',
      target: 'call',
      filterAsk: true,
      smileAxis: 'delta',
      smileViewport: null, // 軸を変えたら既定の範囲に戻す
    });
  });
});

describe('入力の検証', () => {
  it('枚数・建値・IV・行使価格・限月', () => {
    expect(parseQty('2')).toEqual({ ok: true, value: 2 });
    expect(parseQty('0').ok).toBe(false);
    expect(parseQty('1.5').ok).toBe(false);
    expect(parseEntry('1,234')).toEqual({ ok: true, value: 1234 });
    expect(parseEntry('-1').ok).toBe(false);
    expect(parseIvPct('25', false)).toEqual({ ok: true, value: 0.25 });
    expect(parseIvPct('', true)).toEqual({ ok: true, value: null });
    expect(parseIvPct('', false).ok).toBe(false);
    expect(parseIvPct('0', true).ok).toBe(false);
    expect(parseStrike('64000')).toEqual({ ok: true, value: 64000 });
    expect(parseStrike('abc').ok).toBe(false);
    expect(parseContract('2027-01')).toEqual({ ok: true, value: '2027-01' });
    expect(parseContract('2027-13').ok).toBe(false);
  });
});

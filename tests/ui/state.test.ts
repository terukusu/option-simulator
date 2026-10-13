import { describe, expect, it } from 'vitest';
import { type Chain, manualEntryDefault, normalizeChain } from '../../data';
import type { OptionLeg, OptionType } from '../../model';
import {
  type Action,
  initialState,
  parseContract,
  parseDays,
  parseEntry,
  parseFee,
  parseIvPct,
  parsePremiumN,
  parseQty,
  parseStrike,
  parseYRange,
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

describe('損益グラフの状態（#11 AC-8・AC-11）', () => {
  const chain = normalizeChain(fixture('latest'));
  const m1 = chain.months[0]?.id as string;
  const k = chain.months[0]?.atm.B.pick?.k as number;
  const add: Action = { type: 'addBoardLeg', expiry: m1, k, optionType: 'put', side: 'sell' };

  it('表示範囲: 板の読み直し・全クリアで初期範囲（null）、足の追加・編集・削除では保つ', () => {
    const s = run(loaded(chain), add, { type: 'setPnlViewport', viewport: [60_000, 70_000] });
    expect(s.pnlViewport).toEqual([60_000, 70_000]);
    const id = s.legs[0]?.id as number;
    const kept = run(
      s,
      add,
      { type: 'editLeg', id, patch: { qty: 2 } },
      { type: 'removeLeg', id },
      { type: 'setMonth', monthId: chain.months[1]?.id as string },
    );
    expect(kept.pnlViewport).toEqual([60_000, 70_000]);
    expect(reduce(s, { type: 'loaded', chain, label: 'again' }).pnlViewport).toBeNull();
    expect(reduce(s, { type: 'clearLegs' }).pnlViewport).toBeNull();
    // 1 本ずつ消して 0 本になったときも初期範囲に戻す
    expect(reduce(s, { type: 'removeLeg', id }).pnlViewport).toBeNull();
    expect(reduce(s, { type: 'setPnlViewport', viewport: null }).pnlViewport).toBeNull();
  });

  it('縦軸のモード・N・指定日 d は板の読み直しで保つ', () => {
    const s = run(
      loaded(chain),
      add,
      { type: 'setDays', days: 12.5 },
      { type: 'setPnlY', patch: { mode: 'premium', n: 3 } },
      { type: 'loaded', chain: normalizeChain(fixture('night_early')), label: 'night' },
    );
    expect(s.scenario.days).toBe(12.5);
    expect(s.pnlY).toEqual({ mode: 'premium', manual: null, n: 3 });
    // 他のシナリオの値は 0（#6 まで）
    expect(s.scenario).toMatchObject({ dX: 0, dSigma: 0, skew: 0, beta: 1 });
    const manual = reduce(s, { type: 'setPnlY', patch: { mode: 'manual', manual: [-1, 2] } });
    expect(manual.pnlY).toEqual({ mode: 'manual', manual: [-1, 2], n: 3 });
  });

  it('setDays は 0 以上の有限値だけ（不正なら状態を変えない）', () => {
    const s = run(loaded(chain), { type: 'setDays', days: 3 });
    expect(reduce(s, { type: 'setDays', days: -1 })).toBe(s);
    expect(reduce(s, { type: 'setDays', days: Number.NaN })).toBe(s);
  });

  it('入力の検証: 指定日 d・縦軸の手動の範囲・N', () => {
    expect(parseDays('0', 58.5)).toEqual({ ok: true, value: 0 });
    expect(parseDays('12.25', 58.5)).toEqual({ ok: true, value: 12.25 });
    expect(parseDays('58.5', 58.5)).toEqual({ ok: true, value: 58.5 });
    expect(parseDays('58.6', 58.5).ok).toBe(false);
    expect(parseDays('-1', 58.5).ok).toBe(false);
    expect(parseDays('abc', 58.5).ok).toBe(false);
    expect(parseDays('', 58.5).ok).toBe(false);
    // 足 0 本（上限 0）は 0 しか受け付けない（部品は入力欄を無効にする）
    expect(parseDays('1', 0).ok).toBe(false);
    expect(parseYRange('-150,000', '150000')).toEqual({ ok: true, value: [-150_000, 150_000] });
    expect(parseYRange('5', '5').ok).toBe(false);
    expect(parseYRange('10', '-10').ok).toBe(false);
    expect(parseYRange('x', '10').ok).toBe(false);
    expect(parsePremiumN('5')).toEqual({ ok: true, value: 5 });
    expect(parsePremiumN('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parsePremiumN('0').ok).toBe(false);
    expect(parsePremiumN('1001').ok).toBe(false);
  });
});

describe('シナリオ・手数料・単位の状態（#6）', () => {
  const chain = normalizeChain(fixture('latest'));
  const base = loaded(chain);

  it('setScenario は部分更新。非有限・範囲外を含む更新は丸ごと無視する', () => {
    const s = reduce(base, {
      type: 'setScenario',
      patch: { days: 3.5, dX: -2034.3, dSigma: -3, skew: 1.5, beta: 0 },
    });
    expect(s.scenario).toEqual({
      days: 3.5,
      dX: -2034.3,
      dSigma: -3,
      skew: 1.5,
      beta: 0,
      ivDynamics: 'sticky_strike',
      ivShift: 'absolute',
    });
    const m = reduce(s, { type: 'setScenario', patch: { ivDynamics: 'sticky_moneyness' } });
    expect(m.scenario.ivDynamics).toBe('sticky_moneyness');
    expect(m.scenario.days).toBe(3.5);
    for (const patch of [
      { days: -1 },
      { days: Number.NaN },
      { dX: Number.POSITIVE_INFINITY },
      { dSigma: 40.5 },
      { dSigma: -10.5 },
      { skew: 5.5 },
      { beta: -0.1 },
      { beta: 10.1 },
      { days: 2, dSigma: Number.NaN },
      { ivDynamics: 'x' as 'sticky_strike' },
    ]) {
      expect(reduce(s, { type: 'setScenario', patch })).toBe(s);
    }
  });

  it('シナリオのリセット: d・ΔX・Δσ・Δs を 0 に、β・動き方は保つ', () => {
    const s = run(
      base,
      { type: 'setScenario', patch: { beta: 2, ivDynamics: 'sticky_moneyness' } },
      { type: 'applyPreset', index: 1, x0: 67_810 },
      { type: 'setScenario', patch: { days: 7 } },
      { type: 'resetScenario' },
    );
    expect(s.scenario).toEqual({
      days: 0,
      dX: 0,
      dSigma: 0,
      skew: 0,
      beta: 2,
      ivDynamics: 'sticky_moneyness',
      ivShift: 'absolute',
    });
  });

  it('プリセット「−5% / +8pt / +1」と「反発 +5% / −5pt / −1」は 3 つの値だけを設定する', () => {
    const s = run(base, { type: 'setScenario', patch: { days: 4, beta: 0.5 } });
    expect(reduce(s, { type: 'applyPreset', index: 1, x0: 60_000 }).scenario).toMatchObject({
      days: 4,
      beta: 0.5,
      dX: -3_000,
      dSigma: 8,
      skew: 1,
    });
    expect(reduce(s, { type: 'applyPreset', index: 2, x0: 60_000 }).scenario).toMatchObject({
      dX: 3_000,
      dSigma: -5,
      skew: -1,
    });
  });

  it('手数料: 0〜100,000 円 / 枚（不正なら状態を変えない）、単位の指定。板の読み直しで保つ', () => {
    const s = run(base, { type: 'setFee', fee: 300 }, { type: 'setMetricsUnit', unit: 'thousand' });
    expect(s.feePerLot).toBe(300);
    expect(s.metricsUnit).toBe('thousand');
    expect(reduce(s, { type: 'setFee', fee: -1 })).toBe(s);
    expect(reduce(s, { type: 'setFee', fee: 100_001 })).toBe(s);
    expect(reduce(s, { type: 'setFee', fee: Number.NaN })).toBe(s);
    const again = reduce(s, { type: 'loaded', chain, label: 'again' });
    expect(again.feePerLot).toBe(300);
    expect(again.metricsUnit).toBe('thousand');
    expect(initialState.feePerLot).toBe(0);
    expect(initialState.metricsUnit).toBe('auto');
  });

  it('先物の basis（#25）: 既定は固定。固定 / 減衰の切替、不正値・同値は同じ参照、板の読み直し・リセットで保つ', () => {
    expect(initialState.futureBasis).toBe('fixed');
    expect(base.futureBasis).toBe('fixed');
    const d = reduce(base, { type: 'setFutureBasis', basis: 'decay' });
    expect(d.futureBasis).toBe('decay');
    expect(reduce(d, { type: 'setFutureBasis', basis: 'decay' })).toBe(d);
    expect(reduce(d, { type: 'setFutureBasis', basis: 'x' as 'fixed' })).toBe(d);
    expect(reduce(d, { type: 'setFutureBasis', basis: 'fixed' }).futureBasis).toBe('fixed');
    const kept = run(
      d,
      { type: 'loaded', chain, label: 'again' },
      { type: 'setScenario', patch: { days: 2, dX: -500 } },
      { type: 'resetScenario' },
      { type: 'setFee', fee: 100 },
    );
    expect(kept.futureBasis).toBe('decay');
  });

  it('入力の検証: 手数料、Unicode マイナス・先頭の + を受ける数のパース', () => {
    expect(parseFee('300')).toEqual({ ok: true, value: 300 });
    expect(parseFee(' 1,000 ')).toEqual({ ok: true, value: 1000 });
    expect(parseFee('0')).toEqual({ ok: true, value: 0 });
    expect(parseFee('−1').ok).toBe(false);
    expect(parseFee('100001').ok).toBe(false);
    expect(parseFee('').ok).toBe(false);
    // fmtNum の出力（−）をそのまま入れ直せる
    expect(parseYRange('−150,000', '+150,000')).toEqual({ ok: true, value: [-150_000, 150_000] });
    expect(parseDays('+2', 58.5)).toEqual({ ok: true, value: 2 });
    expect(parseQty('0x10').ok).toBe(false);
  });
});

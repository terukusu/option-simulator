import { describe, expect, it } from 'vitest';
import { type Chain, manualEntryDefault, normalizeChain } from '../../data';
import type { OptionLeg, OptionType } from '../../model';
import {
  type Action,
  initialState,
  type LegPatch,
  MAX_TABS,
  nextTabName,
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
  SCENARIO_PER_TAB,
  type State,
  sanitizeTabName,
  TAB_NAME_MAX,
  type UiLeg,
  validEntry,
} from '../../ui/state';
import { fixture } from '../support/fixtures';
import { rng } from '../support/synthChain';

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
    // 上限は保存の検証と同じ 1e9（入れられた建値が次に開いたときに捨てられない）
    expect(parseEntry('1,000,000,000')).toEqual({ ok: true, value: 1e9 });
    expect(parseEntry('1000000001').ok).toBe(false);
    expect(validEntry(1e9)).toBe(true);
    expect(validEntry(1e9 + 1)).toBe(false);
    expect(validEntry(Number.NaN)).toBe(false);
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

describe('損益グラフのたたむ / ひらく（#61）', () => {
  const chain = normalizeChain(fixture('latest'));
  const m1 = chain.months[0]?.id as string;
  const k = chain.months[0]?.atm.B.pick?.k as number;
  const add: Action = { type: 'addBoardLeg', expiry: m1, k, optionType: 'put', side: 'sell' };

  it('初期はひらいている（false）、setPnlFolded で切り替える', () => {
    expect(initialState.pnlFolded).toBe(false);
    const folded = reduce(loaded(chain), { type: 'setPnlFolded', folded: true });
    expect(folded.pnlFolded).toBe(true);
    expect(reduce(folded, { type: 'setPnlFolded', folded: false }).pnlFolded).toBe(false);
  });

  it('板の読み直し・足の追加・全クリアでは保つ', () => {
    const s = run(loaded(chain), { type: 'setPnlFolded', folded: true }, add);
    expect(s.pnlFolded).toBe(true);
    expect(reduce(s, { type: 'loaded', chain, label: 'again' }).pnlFolded).toBe(true);
    expect(reduce(s, { type: 'clearLegs' }).pnlFolded).toBe(true);
  });

  it('同じ値なら状態を変えない', () => {
    const s = loaded(chain);
    expect(reduce(s, { type: 'setPnlFolded', folded: false })).toBe(s);
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

/** #34 AC-4: 読み直し（[最新]）と失敗時の保持。時計は App が渡す（reducer は読まない）。 */
describe('取得時刻と読み直し（#34）', () => {
  const chain = normalizeChain(fixture('latest'));
  const T1 = Date.parse('2026-10-13T21:47:00+09:00');
  const T2 = Date.parse('2026-10-13T21:52:00+09:00');

  it('初期は取得時刻なし。loaded で入る', () => {
    expect(initialState.fetchedAt).toBeNull();
    const s = reduce(initialState, { type: 'loaded', chain, label: 'API', fetchedAt: T1 });
    expect(s.fetchedAt).toBe(T1);
    expect(s.sourceLabel).toBe('API');
  });

  it('(a) 板があるときの loaded は足・限月の選択を保ち、取得時刻を更新', () => {
    const m2 = chain.months[1]?.id as string;
    const k = chain.months[0]?.source[0]?.k as number;
    let s = run(
      initialState,
      { type: 'loaded', chain, label: 'API', fetchedAt: T1 },
      { type: 'setMonth', monthId: m2 },
      {
        type: 'addBoardLeg',
        expiry: chain.months[0]?.id as string,
        k,
        optionType: 'call',
        side: 'buy',
      },
      { type: 'loading' },
    );
    expect(s.loading).toBe(true);
    const again = normalizeChain(fixture('latest'));
    s = reduce(s, { type: 'loaded', chain: again, label: 'API', fetchedAt: T2 });
    expect(s.chain).toBe(again);
    expect(s.monthId).toBe(m2);
    expect(s.legs).toHaveLength(1);
    expect(s.fetchedAt).toBe(T2);
    expect(s.loading).toBe(false);
    expect(s.loadError).toBeNull();
  });

  it('(b) loadFailed は板・取得時刻・データ元を保ってエラーを入れる', () => {
    const s = run(
      initialState,
      { type: 'loaded', chain, label: 'API', fetchedAt: T1 },
      { type: 'loading' },
      { type: 'loadFailed', error: { message: '板を読めない（通信エラー）', errors: [] } },
    );
    expect(s.chain).toBe(chain);
    expect(s.fetchedAt).toBe(T1);
    expect(s.sourceLabel).toBe('API');
    expect(s.loading).toBe(false);
    expect(s.loadError?.message).toBe('板を読めない（通信エラー）');
  });

  it('最初の読み込みで失敗 → 板も取得時刻も無いまま', () => {
    const s = run(
      initialState,
      { type: 'loading' },
      { type: 'loadFailed', error: { message: 'x', errors: [] } },
    );
    expect(s.chain).toBeNull();
    expect(s.fetchedAt).toBeNull();
    expect(s.loadError?.message).toBe('x');
  });
});

/** #23 AC5: 開いたとき読み込みに失敗して板が無ければ、保存した最後の板を「古い板」として使う。 */
describe('保存した板のフォールバック（#23）', () => {
  const chain = normalizeChain(fixture('latest'));
  const saved = normalizeChain(fixture('night_early'));
  const T0 = Date.parse('2026-10-11T21:47:00+09:00');
  const T1 = Date.parse('2026-10-13T21:47:00+09:00');
  const error = { message: 'API が板を返せない（HTTP 503）', errors: [] };
  const fallback = { chain: saved, label: '保存した板（API）', fetchedAt: T0 };

  it('板が無いときは保存した板を表示し、エラーは出したまま「古い板」', () => {
    const s = run(
      { ...initialState, monthId: '2099-01' },
      { type: 'loading' },
      { type: 'loadFailed', error, fallback },
    );
    expect(s.chain).toBe(saved);
    expect(s.boardStale).toBe(true);
    expect(s.fetchedAt).toBe(T0);
    expect(s.sourceLabel).toBe('保存した板（API）');
    expect(s.loadError).toEqual(error);
    expect(s.loading).toBe(false);
    // 限月は loaded と同じく板に合わせる
    expect(s.monthId).toBe(saved.months[0]?.id);
  });

  it('板があるときの失敗は保存した板を使わない（メモリ内の板の方が新しい）', () => {
    const s = run(
      initialState,
      { type: 'loaded', chain, label: 'API', fetchedAt: T1 },
      { type: 'loading' },
      { type: 'loadFailed', error, fallback },
    );
    expect(s.chain).toBe(chain);
    expect(s.boardStale).toBe(false);
    expect(s.fetchedAt).toBe(T1);
  });

  it('読み込みに成功すると「古い板」の印とエラーが消える。古い板のまま再び失敗しても印は残る', () => {
    const stale = run(initialState, { type: 'loadFailed', error, fallback });
    const again = run(stale, { type: 'loading' }, { type: 'loadFailed', error, fallback });
    expect(again.boardStale).toBe(true);
    expect(again.chain).toBe(saved);
    const ok = reduce(stale, { type: 'loaded', chain, label: 'API', fetchedAt: T1 });
    expect(ok.boardStale).toBe(false);
    expect(ok.loadError).toBeNull();
    expect(ok.chain).toBe(chain);
  });
});

describe('ポジ帳の項目を開く（#70 openPosition）', () => {
  const chain = normalizeChain(fixture('latest'));
  const scenario = { ...initialState.scenario, days: 2, dX: -500 };
  const legA = {
    leg: {
      kind: 'option' as const,
      product: 'op_large' as const,
      type: 'put' as const,
      expiry: '2026-11',
      strike: 64000,
      side: 'sell' as const,
      qty: 1,
      entry: 780,
      mid: 792.5,
    },
    marks: [],
  };
  // 板の足で限月が板に無い（足の市場を持たない）
  const legOff = { ...legA, leg: { ...legA.leg, expiry: '2026-09' } };

  it('足・シナリオ・手数料・basis を置き換え、表示の設定は今のまま。id は 1..n', () => {
    const before = run(
      { ...initialState, atmBasis: 'A', metricsUnit: 'thousand' },
      { type: 'loaded', chain, label: 'latest' },
      { type: 'addBoardLeg', expiry: '2026-12', k: 60000, optionType: 'put', side: 'buy' },
      { type: 'addBoardLeg', expiry: '2026-12', k: 62500, optionType: 'put', side: 'buy' },
      { type: 'setPnlViewport', viewport: [60000, 70000] },
      { type: 'pickSmile', pick: { monthId: '2026-11', k: 64000 } },
    );
    const s = reduce(before, {
      type: 'openPosition',
      legs: [legA, legOff],
      scenario,
      feePerLot: 120,
      futureBasis: 'decay',
    });
    expect(s.legs.map((l) => l.id)).toEqual([1, 2]);
    expect(s.nextId).toBe(3);
    expect(s.legs[0]?.leg).toEqual(legA.leg);
    expect(s.scenario).toEqual(scenario);
    expect(s.feePerLot).toBe(120);
    expect(s.futureBasis).toBe('decay');
    expect(s.atmBasis).toBe('A');
    expect(s.metricsUnit).toBe('thousand');
    expect(s.monthId).toBe(before.monthId);
    expect(s.pnlViewport).toBeNull();
    expect(s.smilePick).toBeNull();
    // 限月が板に無い足は消さずに残す（行のエラー。AC9）
    expect(s.legs[1]?.leg).toEqual(legOff.leg);
  });

  it('板があれば足の市場を今の板から作り直す（手入力の足の F を板の先物で代用）', () => {
    const manual = {
      leg: { ...legA.leg, expiry: '2027-01', type: 'call' as const, strike: 70000, iv: 0.25 },
      marks: ['no_board' as const, 'forward_from_future' as const],
      optionMarket: {
        expiry: '2027-01',
        market: { sqTime: 1799999000000, forward: Number.NaN, smile: null },
      },
    };
    const s = run(
      initialState,
      { type: 'loaded', chain, label: 'latest' },
      { type: 'openPosition', legs: [manual], scenario, feePerLot: 0, futureBasis: 'fixed' },
    );
    expect(s.legs[0]?.optionMarket?.market.forward).toBe(chain.future.price);
    // 板が無ければ保存した市場のまま
    const s0 = reduce(initialState, {
      type: 'openPosition',
      legs: [manual],
      scenario,
      feePerLot: 0,
      futureBasis: 'fixed',
    });
    expect(s0.legs[0]?.optionMarket?.market.forward).toBeNaN();
  });

  it('範囲外の手数料・シナリオは今の値のまま（検証済みの値だけ来るが守る）', () => {
    const s = reduce(
      { ...initialState, feePerLot: 10 },
      {
        type: 'openPosition',
        legs: [legA],
        scenario: { ...scenario, dSigma: 999 },
        feePerLot: -1,
        futureBasis: 'x' as never,
      },
    );
    expect(s.feePerLot).toBe(10);
    expect(s.scenario).toEqual(initialState.scenario);
    expect(s.futureBasis).toBe('fixed');
  });
});

/** #71: 作業中のポジションのタブ（BOX タブ）。 */
describe('作業中のポジションのタブ（#71）', () => {
  const chain = normalizeChain(fixture('latest'));
  const m0 = chain.months[0];
  if (!m0) throw new Error('限月が無い');
  const ks = m0.rows.map((r) => r.k);
  const mid = Math.floor(ks.length / 2);
  const k = (i: number) => ks[mid + i] ?? 0;
  const board = (i: number, optionType: OptionType, side: 'buy' | 'sell'): Action => ({
    type: 'addBoardLeg',
    expiry: m0.id,
    k: k(i),
    optionType,
    side,
  });

  /** 不変条件: 作業中の slot がちょうど 1 つで saved は null、他は非 null、1 ≤ 個数 ≤ MAX_TABS、id は重複なし */
  function invariant(s: State): void {
    const active = s.tabs.filter((t) => t.id === s.activeTab);
    expect(active).toHaveLength(1);
    expect(active[0]?.saved).toBeNull();
    for (const t of s.tabs) if (t.id !== s.activeTab) expect(t.saved).not.toBeNull();
    expect(s.tabs.length).toBeGreaterThanOrEqual(1);
    expect(s.tabs.length).toBeLessThanOrEqual(MAX_TABS);
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(s.tabs.length);
    expect(s.tabs.every((t) => t.id < s.nextTabId)).toBe(true);
    expect(s.legs.map((l) => l.id)).toEqual([...s.legs.map((l) => l.id)].sort((a, b) => a - b));
    expect(s.nextId).toBeGreaterThan(Math.max(0, ...s.legs.map((l) => l.id)));
  }

  /** タブ A に足 2 本（売 P・売 C） */
  function withA(): State {
    return run(loaded(chain), board(-2, 'put', 'sell'), board(2, 'call', 'sell'));
  }

  it('初期状態: タブ「A」1 個が作業中', () => {
    expect(initialState.tabs).toEqual([{ id: 1, name: 'A', saved: null }]);
    expect(initialState.activeTab).toBe(1);
    invariant(initialState);
  });

  it('空のタブを足すと右隣に作って切り替え、A の足・建値は退避される', () => {
    const a = withA();
    const s = reduce(a, { type: 'addTab', mode: 'empty' });
    invariant(s);
    expect(s.tabs.map((t) => t.name)).toEqual(['A', 'B']);
    expect(s.activeTab).toBe(2);
    expect(s.legs).toEqual([]);
    expect(s.nextId).toBe(1);
    expect(s.pnlViewport).toBeNull();
    const savedA = s.tabs[0]?.saved;
    expect(savedA?.legs.map((l) => l.leg)).toEqual(a.legs.map((l) => l.leg));
    expect(savedA?.boardSnapshotAt).toBe(chain.snapshotAt);
    // 板・表示・評価の設定は共通
    expect(s.chain).toBe(a.chain);
    expect(s.monthId).toBe(a.monthId);
    expect(s.feePerLot).toBe(a.feePerLot);
  });

  it('切り替え: B の足は A に混ざらず、戻すと A の足・建値・id 1..n が元のまま（AC3）', () => {
    const a = run(withA(), { type: 'editLeg', id: 1, patch: { entry: 123, qty: 3 } });
    const b = run(a, { type: 'addTab', mode: 'empty' }, board(0, 'put', 'buy'));
    expect(b.legs).toHaveLength(1);
    const back = reduce(b, { type: 'switchTab', id: 1 });
    invariant(back);
    expect(back.activeTab).toBe(1);
    expect(back.legs.map((l) => l.leg)).toEqual(a.legs.map((l) => l.leg));
    expect(back.legs.map((l) => l.id)).toEqual([1, 2]);
    expect(back.nextId).toBe(3);
    expect(back.legs[0]?.leg.entry).toBe(123);
    // B は退避されている（足 1 本）
    expect(back.tabs[1]?.saved?.legs.map((l) => l.leg)).toEqual(b.legs.map((l) => l.leg));
    // 足を追加すると作業中のタブだけに入る
    const more = reduce(back, board(1, 'call', 'buy'));
    expect(more.legs).toHaveLength(3);
    expect(more.tabs[1]?.saved?.legs).toHaveLength(1);
  });

  it('シナリオは共通（既定）: 切り替えてもシナリオは今のまま', () => {
    expect(SCENARIO_PER_TAB).toBe(false);
    const a = run(withA(), { type: 'setScenario', patch: { days: 3, dX: -800 } });
    const b = run(a, { type: 'addTab', mode: 'empty' });
    expect(b.scenario).toEqual(a.scenario);
    const b2 = run(b, { type: 'setScenario', patch: { dSigma: 5 } });
    const back = reduce(b2, { type: 'switchTab', id: 1 });
    expect(back.scenario).toEqual(b2.scenario);
  });

  it('複製: 同じ足で別のタブ、片方の建値を変えても他方は変わらない', () => {
    const a = withA();
    const c = reduce(a, { type: 'addTab', mode: 'copy' });
    invariant(c);
    expect(c.tabs.map((t) => t.name)).toEqual(['A', 'B']);
    expect(c.legs.map((l) => l.leg)).toEqual(a.legs.map((l) => l.leg));
    const edited = reduce(c, { type: 'editLeg', id: 1, patch: { entry: 999 } });
    expect(edited.tabs[0]?.saved?.legs[0]?.leg.entry).toBe(a.legs[0]?.leg.entry);
    const back = reduce(edited, { type: 'switchTab', id: 1 });
    expect(back.legs[0]?.leg.entry).toBe(a.legs[0]?.leg.entry);
    expect(back.tabs[1]?.saved?.legs[0]?.leg.entry).toBe(999);
  });

  it('横軸の表示範囲は切り替えで保ち、足 0 本のタブへ切り替えたら初期範囲。スマイルの選択・足のエラーは消す', () => {
    const a = run(
      withA(),
      { type: 'addTab', mode: 'copy' },
      {
        type: 'setPnlViewport',
        viewport: [60000, 70000],
      },
    );
    const s = run(
      a,
      { type: 'pickSmile', pick: { monthId: m0.id, k: k(0) } },
      {
        type: 'switchTab',
        id: 1,
      },
    );
    expect(s.pnlViewport).toEqual([60000, 70000]);
    expect(s.smilePick).toBeNull();
    const e = run(s, { type: 'addTab', mode: 'empty' });
    expect(e.pnlViewport).toBeNull();
    const toEmpty = run(
      e,
      { type: 'setPnlViewport', viewport: [1, 2] },
      { type: 'switchTab', id: 1 },
    );
    expect(toEmpty.pnlViewport).toEqual([1, 2]);
    const back = reduce(toEmpty, { type: 'switchTab', id: e.activeTab });
    expect(back.legs).toEqual([]);
    expect(back.pnlViewport).toBeNull();
  });

  it(`上限 ${MAX_TABS} 個: それ以上は足さない（新しいタブで開くも）。名前は空いている最初の文字`, () => {
    let s = withA();
    for (let i = 0; i < MAX_TABS + 2; i++) s = reduce(s, { type: 'addTab', mode: 'empty' });
    invariant(s);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs.map((t) => t.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const full = reduce(s, {
      type: 'openPositionInNewTab',
      legs: [],
      scenario: s.scenario,
      feePerLot: 5,
      futureBasis: 'fixed',
    });
    expect(full).toBe(s);
    // B を閉じてから足すと「B」が空いている
    const reopened = run(s, { type: 'closeTab', id: 2 }, { type: 'addTab', mode: 'empty' });
    expect(reopened.tabs.map((t) => t.name)).toContain('B');
    invariant(reopened);
  });

  it('足すタブは作業中のタブの右隣', () => {
    const s = run(
      withA(),
      { type: 'addTab', mode: 'empty' }, // B（id 2）
      { type: 'switchTab', id: 1 },
      { type: 'addTab', mode: 'empty' }, // C は A の右
    );
    expect(s.tabs.map((t) => t.name)).toEqual(['A', 'C', 'B']);
    invariant(s);
  });

  it('閉じる: 最後の 1 個は閉じない。作業中を閉じたら右隣（無ければ左隣）へ。作業中でないタブはそのまま消す', () => {
    const one = withA();
    expect(reduce(one, { type: 'closeTab', id: 1 })).toBe(one);
    expect(reduce(one, { type: 'closeTab', id: 9 })).toBe(one);
    const three = run(
      one,
      { type: 'addTab', mode: 'empty' },
      board(0, 'put', 'buy'),
      { type: 'addTab', mode: 'empty' },
      { type: 'switchTab', id: 2 },
    );
    // B（真ん中・作業中）を閉じる → 右隣の C
    const c = reduce(three, { type: 'closeTab', id: 2 });
    invariant(c);
    expect(c.tabs.map((t) => t.name)).toEqual(['A', 'C']);
    expect(c.activeTab).toBe(3);
    expect(c.legs).toEqual([]);
    // C（右端・作業中）を閉じる → 左隣の A（足 2 本が戻る）
    const a = reduce(c, { type: 'closeTab', id: 3 });
    invariant(a);
    expect(a.activeTab).toBe(1);
    expect(a.legs.map((l) => l.leg)).toEqual(one.legs.map((l) => l.leg));
    // 作業中でないタブを閉じても作業中の足はそのまま
    const other = reduce(three, { type: 'closeTab', id: 1 });
    expect(other.legs).toBe(three.legs);
    expect(other.tabs.map((t) => t.name)).toEqual(['B', 'C']);
  });

  it('名前の変更: 制御文字・双方向の制御を除き 12 字で切る。空・無いタブは state のまま', () => {
    const s = reduce(withA(), {
      type: 'renameTab',
      id: 1,
      name: '  ‮<img src=x onerror=alert(1)>\u0007 ',
    });
    expect(s.tabs[0]?.name).toBe('<img src=x o');
    expect(Array.from(s.tabs[0]?.name ?? '')).toHaveLength(TAB_NAME_MAX);
    const a = withA();
    expect(reduce(a, { type: 'renameTab', id: 1, name: ' ‏ ' })).toBe(a);
    expect(reduce(a, { type: 'renameTab', id: 9, name: 'X' })).toBe(a);
    expect(reduce(a, { type: 'renameTab', id: 1, name: 'A' })).toBe(a);
    expect(sanitizeTabName('😀'.repeat(20))).toBe('😀'.repeat(12));
  });

  it('名前の変更: 他のタブと同じ名前（正規化した後で比べる）は断る。自分の今の名前・空いている名前は変えられる', () => {
    const s = run(withA(), { type: 'addTab', mode: 'empty' }, { type: 'addTab', mode: 'empty' });
    expect(s.tabs.map((t) => t.name)).toEqual(['A', 'B', 'C']);
    expect(reduce(s, { type: 'renameTab', id: 3, name: 'A' })).toBe(s);
    expect(reduce(s, { type: 'renameTab', id: 3, name: ' B\u200e ' })).toBe(s);
    // 作業中でないタブの名前の変更も同じ規則
    expect(reduce(s, { type: 'renameTab', id: 1, name: 'C' })).toBe(s);
    const renamed = run(
      s,
      { type: 'renameTab', id: 3, name: 'ヘッジ案' },
      { type: 'renameTab', id: 1, name: 'C' },
    );
    expect(renamed.tabs.map((t) => t.name)).toEqual(['C', 'B', 'ヘッジ案']);
  });

  it('nextTabName: A〜Z のうち使われていない最初の 1 文字', () => {
    expect(nextTabName([])).toBe('A');
    expect(nextTabName([{ name: 'A' }, { name: 'C' }])).toBe('B');
    expect(nextTabName(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (name) => ({ name })))).toBe('1');
  });

  it('新しいタブで開く: 作業中のタブを残し、右隣に読み込む（手数料・basis・シナリオは置き換え）', () => {
    const a = withA();
    const scenario = { ...a.scenario, days: 4 };
    const legs = a.legs.slice(0, 1).map(({ id: _id, ...rest }) => rest);
    const s = reduce(a, {
      type: 'openPositionInNewTab',
      legs,
      scenario,
      feePerLot: 77,
      futureBasis: 'decay',
    });
    invariant(s);
    expect(s.tabs.map((t) => t.name)).toEqual(['A', 'B']);
    expect(s.legs.map((l) => l.leg)).toEqual(legs.map((l) => l.leg));
    expect(s.legs.map((l) => l.id)).toEqual([1]);
    expect(s.scenario).toEqual(scenario);
    expect(s.feePerLot).toBe(77);
    expect(s.futureBasis).toBe('decay');
    expect(s.tabs[0]?.saved?.legs).toHaveLength(2);
    // [開く]（openPosition）は作業中のタブを置き換え、タブは増えない
    const replaced = reduce(a, {
      type: 'openPosition',
      legs,
      scenario,
      feePerLot: 0,
      futureBasis: 'fixed',
    });
    expect(replaced.tabs).toEqual(a.tabs);
    expect(replaced.legs).toHaveLength(1);
  });

  it('板の読み直しは作業中のタブの足の市場だけ作り直し、他のタブは切り替えたときに今の板で作り直す', () => {
    const manual: Action = {
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
    };
    const s = run(loaded(chain), manual, { type: 'addTab', mode: 'empty' });
    const night = normalizeChain(fixture('night_early'));
    const reloaded = reduce(s, { type: 'loaded', chain: night, label: 'x' });
    // 退避した足は前の板の市場のまま
    expect(reloaded.tabs[0]?.saved?.legs[0]?.optionMarket?.market.forward).toBe(chain.future.price);
    const back = reduce(reloaded, { type: 'switchTab', id: 1 });
    expect(back.legs[0]?.optionMarket?.market.forward).toBe(night.future.price);
  });

  it('性質: ランダムな操作列でも不変条件を保ち、各タブの足の入力値はタブごとのモデルと常に一致する（AC3）', () => {
    // 決まった種の擬似乱数（再現できる。tests/support の mulberry32）
    const next = rng(71);
    const rnd = (n: number) => Math.floor(next() * n);
    /** 足の入力値と、手入力の OP の足の F・限月、先物の足の限月（板は変えないので切り替えても同じになる） */
    type LegView = {
      leg: UiLeg['leg'];
      marks: UiLeg['marks'];
      optionExpiry: string | null;
      forward: number | null;
      futureContract: string | null;
    };
    const view = (l: Omit<UiLeg, 'id'>): LegView => ({
      leg: l.leg,
      marks: l.marks,
      optionExpiry: l.optionMarket?.expiry ?? null,
      forward: l.optionMarket?.market.forward ?? null,
      futureContract: l.futureMarket?.contract ?? null,
    });
    /** reducer とは別に書いた足の編集（テストのモデル） */
    const patched = (v: LegView, p: LegPatch): LegView => {
      const leg = { ...v.leg };
      if (p.qty !== undefined) leg.qty = p.qty;
      if (p.entry !== undefined) leg.entry = p.entry;
      if (p.side !== undefined) leg.side = p.side;
      if (leg.kind === 'option' && p.iv !== undefined) {
        if (p.iv === null) delete leg.iv;
        else leg.iv = p.iv;
      }
      return { ...v, leg };
    };
    const tabLegs = (s: State, id: number): LegView[] => {
      if (id === s.activeTab) return s.legs.map(view);
      return (s.tabs.find((t) => t.id === id)?.saved?.legs ?? []).map(view);
    };

    let s = loaded(chain);
    // モデル: タブ id → 足の入力値（タブの並びは s.tabs と同じ集合）
    const model = new Map<number, LegView[]>([[s.activeTab, []]]);
    const seen = new Set<string>();
    for (let step = 0; step < 600; step++) {
      const before = s;
      const r = rnd(12);
      const ids = s.tabs.map((t) => t.id);
      const pick = ids[rnd(ids.length)] ?? 1;
      const legId = s.legs[rnd(Math.max(s.legs.length, 1))]?.id;
      let a: Action;
      if (r === 0) a = { type: 'addTab', mode: rnd(2) === 0 ? 'empty' : 'copy' };
      else if (r === 1 || r === 2) a = { type: 'switchTab', id: pick };
      else if (r === 3) a = { type: 'closeTab', id: pick };
      else if (r === 4) a = { type: 'renameTab', id: pick, name: `n${rnd(100)}` };
      else if (r === 5 && legId !== undefined) a = { type: 'removeLeg', id: legId };
      else if (r === 6 && legId !== undefined) {
        // 枚数・建値・売買・IV の編集（IV は取り消し = null も）
        const patch: LegPatch = {};
        if (rnd(2) === 0) patch.qty = 1 + rnd(5);
        if (rnd(2) === 0) patch.entry = 1 + rnd(1000);
        if (rnd(2) === 0) patch.side = rnd(2) === 0 ? 'buy' : 'sell';
        if (rnd(2) === 0) patch.iv = rnd(4) === 0 ? null : (10 + rnd(40)) / 100;
        a = { type: 'editLeg', id: legId, patch };
      } else if (r === 7)
        // 手入力の OP の足（板に無い限月。F は板の先物から作る）
        a = {
          type: 'addManualLeg',
          input: {
            product: 'op_large',
            expiry: '2027-01',
            type: rnd(2) === 0 ? 'call' : 'put',
            k: 60000 + 500 * rnd(20),
            side: rnd(2) === 0 ? 'buy' : 'sell',
            entry: 1 + rnd(900),
            iv: (10 + rnd(30)) / 100,
          },
        };
      else if (r === 8)
        // 先物の足（板の先物・限月違い）
        a = {
          type: 'addFutureLeg',
          input:
            rnd(2) === 0
              ? { side: rnd(2) === 0 ? 'buy' : 'sell', qty: 1 + rnd(3) }
              : { product: 'fut_micro', contract: '2027-03', side: 'sell', qty: 1 + rnd(4) },
        };
      else a = board(rnd(9) - 4, rnd(2) === 0 ? 'put' : 'call', rnd(2) === 0 ? 'buy' : 'sell');
      s = reduce(s, a);
      invariant(s);
      expect(s.legError).toBeNull();
      seen.add(a.type);

      // モデルを更新する（reducer の結果を使うのは新しく足した足の中身だけ）
      const cur = model.get(before.activeTab) ?? [];
      switch (a.type) {
        case 'addTab':
          if (before.tabs.length < MAX_TABS)
            model.set(before.nextTabId, a.mode === 'copy' ? cur.slice() : []);
          break;
        case 'closeTab':
          if (before.tabs.length > 1) model.delete(a.id);
          break;
        case 'removeLeg':
          model.set(
            before.activeTab,
            cur.filter((_, i) => before.legs[i]?.id !== a.id),
          );
          break;
        case 'editLeg': {
          const { id, patch } = a;
          model.set(
            before.activeTab,
            cur.map((v, i) => (before.legs[i]?.id === id ? patched(v, patch) : v)),
          );
          break;
        }
        case 'addBoardLeg':
        case 'addManualLeg':
        case 'addFutureLeg': {
          const added = s.legs.slice(before.legs.length);
          expect(added).toHaveLength(1);
          expect(s.legs.slice(0, before.legs.length).map(view)).toEqual(cur);
          model.set(before.activeTab, [...cur, ...added.map(view)]);
          break;
        }
        default:
          break;
      }
      // 全タブ（作業中・退避中とも）の足がモデルと一致する。切り替えて戻した側も含む
      expect([...model.keys()].sort((x, y) => x - y)).toEqual(
        s.tabs.map((t) => t.id).sort((x, y) => x - y),
      );
      for (const t of s.tabs) expect(tabLegs(s, t.id)).toEqual(model.get(t.id));
      // 名前は重複しない（renameTab は他のタブと同じ名前を断る）
      expect(new Set(s.tabs.map((t) => t.name)).size).toBe(s.tabs.length);
      // 切り替え・足す・閉じる以外の操作では、作業中でないタブの中身は同じ参照のまま
      if (a.type !== 'addTab' && a.type !== 'switchTab' && a.type !== 'closeTab') {
        for (const t of s.tabs) {
          if (t.id === s.activeTab) continue;
          expect(t.saved).toBe(before.tabs.find((x) => x.id === t.id)?.saved);
        }
      }
    }
    // 操作列が全種類の操作を含み、手入力の足・先物の足・IV の編集を含むタブを往復している
    expect([...seen].sort()).toEqual(
      [
        'addBoardLeg',
        'addFutureLeg',
        'addManualLeg',
        'addTab',
        'closeTab',
        'editLeg',
        'removeLeg',
        'renameTab',
        'switchTab',
      ].sort(),
    );
    const all = [...model.values()].flat();
    expect(all.some((v) => v.forward !== null)).toBe(true);
    expect(all.some((v) => v.futureContract !== null)).toBe(true);
    expect(all.some((v) => v.leg.kind === 'option' && v.leg.iv !== undefined)).toBe(true);
  });
});

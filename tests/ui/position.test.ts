import { describe, expect, it } from 'vitest';
import { buildCalendar, buildMarketContext, normalizeChain } from '../../data';
import holidaysJson from '../../data/calendar/holidays_jp.json';
import tradingJson from '../../data/calendar/trading_calendar.json';
import {
  discountedIntrinsic,
  evaluatePosition,
  monthlyExpiry,
  prepareLeg,
  theoreticalPnl,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';

/** AC-12・AC-13: ポジション一覧（AC27・AC17）と建値ずれ。合成の板（架空の値）。 */
const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');
const atm1 = m1.atm.B.pick?.k as number;
const atm2 = m2.atm.B.pick?.k as number;

function run(...actions: Action[]): State {
  return actions.reduce(reduce, reduce(initialState, { type: 'loaded', chain, label: 'latest' }));
}

/** 板に無い限月の手入力の足（建値・IV は架空の値） */
function manual(expiry: string) {
  return {
    product: 'op_large' as const,
    expiry,
    type: 'put' as const,
    k: 60000,
    side: 'sell' as const,
    entry: 300,
    iv: 0.3,
  };
}

/** 1 本だけの足のシナリオ 0（X' = X₀）の理論損益（手数料 0）。 */
function pnlAtZero(state: State, i: number): number {
  const model = positionModel(chain, state.legs, 'B', CALENDAR);
  const leg = state.legs[i]?.leg;
  if (!leg) throw new Error('足が無い');
  const p = prepareLeg(leg, model.ctx);
  return theoreticalPnl([p], model.ctx.x0, ZERO_SCENARIO, model.ctx);
}

describe('ポジション一覧', () => {
  const state = run(
    { type: 'addBoardLeg', expiry: m1.id, k: atm1 - 2000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: m2.id, k: atm2 - 2000, optionType: 'put', side: 'buy' },
    { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
    { type: 'addFutureLeg', input: { product: 'fut_micro', side: 'buy', qty: 1 } },
    { type: 'addFutureLeg', input: { product: 'fut_large', side: 'sell', qty: 2 } },
  );
  const model = positionModel(chain, state.legs, 'B', CALENDAR);

  it('各足に 商品・限月・売買・枚数・建値・IV・Δ（ラージ / ミニ）・Γ・Θ・V・印・建値ずれ', () => {
    expect(model.rows).toHaveLength(5);
    const [sell1, buy2, mini, micro, large] = model.rows;
    expect(sell1).toMatchObject({
      productLabel: 'ラージ OP',
      month: m1.id,
      sideLabel: '売り',
      qty: 1,
      optionType: 'P',
      strike: atm1 - 2000,
      sqDate: m1.sqDate,
      calendarUnconfirmed: false,
      error: null,
    });
    expect(buy2).toMatchObject({ productLabel: 'ラージ OP', month: m2.id, sideLabel: '買い' });
    for (const r of [sell1, buy2]) {
      expect(r?.iv).toBeGreaterThan(0);
      expect(r?.greeks).not.toBeNull();
      for (const v of Object.values(r?.greeks ?? {})) expect(Number.isFinite(v)).toBe(true);
      expect(Array.isArray(r?.markLabels)).toBe(true);
      expect(r?.mismatchYen).not.toBeNull();
    }
    // 売り put の Δ は正（ラージ換算）、買い put は負。ミニ換算は 10 倍
    expect(sell1?.greeks?.deltaLarge).toBeGreaterThan(0);
    expect(buy2?.greeks?.deltaLarge).toBeLessThan(0);
    expect(sell1?.greeks?.deltaMini).toBeCloseTo((sell1?.greeks?.deltaLarge as number) * 10, 12);
    expect(mini).toMatchObject({ productLabel: 'ミニ先物', month: chain.future.id, iv: null });
    expect(mini?.greeks?.deltaLarge).toBeCloseTo(0.1, 12);
    expect(mini?.greeks?.deltaMini).toBeCloseTo(1.0, 12);
    expect(micro?.productLabel).toBe('マイクロ先物');
    expect(micro?.greeks?.deltaLarge).toBeCloseTo(0.01, 12);
    expect(micro?.greeks?.deltaMini).toBeCloseTo(0.1, 12);
    expect(large?.productLabel).toBe('ラージ先物');
    expect(large?.greeks?.deltaLarge).toBeCloseTo(-2, 12);
    expect(mini?.sqDate).toBe(chain.future.sqDate);
  });

  it('IV を編集すると Θ・V・建値ずれが model/ の結果に変わる', () => {
    const id = state.legs[0]?.id as number;
    const before = model.rows[0];
    const edited = reduce(state, { type: 'editLeg', id, patch: { iv: 0.4 } });
    const after = positionModel(chain, edited.legs, 'B', CALENDAR);
    const row = after.rows[0];
    // 期待値: 表示モデルを通さず、市場を作り直して model/ を直接呼んだ結果
    const ctx = buildMarketContext(chain, { atmBasis: 'B' });
    const legs = edited.legs.map((l) => l.leg);
    const prepared = legs.map((l) => prepareLeg(l, ctx));
    expect(prepared[0]?.option?.anchor).toBe(0.4);
    const ev = evaluatePosition(prepared, ZERO_SCENARIO, ctx);
    expect(row?.iv).toBe(0.4);
    expect(row?.ivEdited).toBe(true);
    expect(row?.anchorSource).toBe('manual');
    expect(row?.greeks).toEqual(ev.legs[0]?.display);
    expect(row?.greeks?.thetaPerDay).not.toBeCloseTo(before?.greeks?.thetaPerDay as number, 0);
    expect(row?.greeks?.vegaPerPt).not.toBeCloseTo(before?.greeks?.vegaPerPt as number, 0);
    const p = prepared[0];
    expect(row?.mismatchYen).toBeCloseTo(
      -(p?.sign as number) * (p?.option?.mismatch as number) * 1000 * 1,
      9,
    );
    expect(Math.abs(row?.mismatchYen as number)).toBeGreaterThan(1);
    expect(row?.mismatchYen).toBeCloseTo(pnlAtZero(edited, 0), 6);
    expect(row?.mismatchNote).toContain('IV を手で入れた');
  });

  it('板の足（板の限月・板の先物）: SQ 日は板の値（求め直さない）、「休業日未確定」の印なし', () => {
    const [sell1, buy2, mini] = model.rows;
    expect(sell1).toMatchObject({ sqDate: m1.sqDate, calendarUnconfirmed: false });
    expect(buy2).toMatchObject({ sqDate: m2.sqDate, calendarUnconfirmed: false });
    expect(mini).toMatchObject({ sqDate: chain.future.sqDate, calendarUnconfirmed: false });
  });

  it('板の無い限月の手入力の足は、その限月の SQ 日をコミット済みのカレンダーから求める', () => {
    const s = reduce(state, { type: 'addManualLeg', input: manual('2027-01') });
    const row = positionModel(chain, s.legs, 'B', CALENDAR).rows[5];
    expect(row?.markLabels).toContain('板なし（手入力）');
    expect(row?.sqDate).toBe(monthlyExpiry(2027, 1, CALENDAR.holidays).sqDate);
    expect(row?.error).toBeNull();
    expect(row?.greeks).not.toBeNull();
  });

  it('コミット済みのカレンダーで、第 2 金曜が確定の最終日より後の限月には「休業日未確定」', () => {
    // 確定の最終日の翌月以降で最初の限月（同期でカレンダーが延びても成り立つように求める）
    const until = CALENDAR.confirmedUntil as string;
    let y = Number(until.slice(0, 4));
    let m = Number(until.slice(5, 7)) + 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const id = `${y}-${String(m).padStart(2, '0')}`;
    const s = reduce(state, { type: 'addManualLeg', input: manual(id) });
    expect(positionModel(chain, s.legs, 'B', CALENDAR).rows[5]?.calendarUnconfirmed).toBe(true);
  });
});

/** AC-6（#14）: 取引カレンダーの反映。確定の最終日を 2027-06-30 に固定したカレンダー（祝日はコミット済み）。 */
describe('取引カレンダーの反映（SQ 日・休業日未確定）', () => {
  const cal = buildCalendar({ ...tradingJson, covered_until: '2027-06-30' }, holidaysJson);
  const base: State = { ...run(), calendar: cal };

  it('前提: 確定の最終日 = 2027-06-30', () => {
    expect(cal.ok).toBe(true);
    expect(cal.confirmedUntil).toBe('2027-06-30');
  });

  it('板の無い 2027-02 限の手入力の足: SQ 日 2027-02-12（第 2 金曜）、印なし', () => {
    const s = reduce(base, { type: 'addManualLeg', input: manual('2027-02') });
    const row = positionModel(chain, s.legs, 'B', cal).rows[0];
    expect(row?.sqDate).toBe('2027-02-12');
    expect(row?.calendarUnconfirmed).toBe(false);
  });

  it('板と限月違いの 2027-02 の先物の足も祝日を入れたカレンダーから（印なし）', () => {
    const s = reduce(base, {
      type: 'addFutureLeg',
      input: { contract: '2027-02', side: 'buy', entry: 67000 },
    });
    const row = positionModel(chain, s.legs, 'B', cal).rows[0];
    expect(row?.markLabels).toContain('建値は手入力（板の先物と限月違い）');
    expect(row?.sqDate).toBe('2027-02-12');
    expect(row?.calendarUnconfirmed).toBe(false);
  });

  it('reducer が休業日を渡す: 足の SQ 時刻 = カレンダーで求めた SQ 日 9:00（取引最終日は 2/11 を避けて 2/10）', () => {
    const s = reduce(base, { type: 'addManualLeg', input: manual('2027-02') });
    const sqTime = s.legs[0]?.optionMarket?.market.sqTime;
    expect(sqTime).toBe(monthlyExpiry(2027, 2, cal.holidays).sqTime);
    expect(monthlyExpiry(2027, 2, cal.holidays).lastTradingDay).toBe('2027-02-10');
  });

  it('第 2 金曜が確定の最終日より後の 2027-09 限: 手入力の足・板と限月違いの先物の足に「休業日未確定」', () => {
    let s = reduce(base, { type: 'addManualLeg', input: manual('2027-09') });
    s = reduce(s, {
      type: 'addFutureLeg',
      input: { contract: '2027-09', side: 'sell', entry: 67000 },
    });
    const rows = positionModel(chain, s.legs, 'B', cal).rows;
    expect(rows.map((r) => r.calendarUnconfirmed)).toEqual([true, true]);
    expect(rows.map((r) => r.sqDate)).toEqual(['2027-09-10', '2027-09-10']);
  });

  it('壊れたカレンダー: 例外を出さず、SQ 日は土日だけで計算、暦から求めた足は全部「休業日未確定」', () => {
    const broken = buildCalendar({ broken: true }, holidaysJson);
    const b: State = { ...run(), calendar: broken };
    let s = reduce(b, { type: 'addManualLeg', input: manual('2027-02') });
    s = reduce(s, {
      type: 'addBoardLeg',
      expiry: m1.id,
      k: atm1,
      optionType: 'put',
      side: 'sell',
    });
    expect(s.legError).toBeNull();
    const rows = positionModel(chain, s.legs, 'B', broken).rows;
    expect(rows[0]?.sqDate).toBe(monthlyExpiry(2027, 2, []).sqDate);
    expect(rows[0]?.calendarUnconfirmed).toBe(true);
    expect(rows[1]?.calendarUnconfirmed).toBe(false); // 板の足は板の SQ 日
  });
});

describe('ポジション一覧（読み直し）', () => {
  const state = run({
    type: 'addBoardLeg',
    expiry: m1.id,
    k: atm1 - 2000,
    optionType: 'put',
    side: 'sell',
  });

  it('読み直した板に限月が無い足は消さずにエラーを出す', () => {
    const other = normalizeChain(fixture('latest'));
    other.months.splice(0, 1);
    const row = positionModel(other, state.legs, 'B', CALENDAR).rows[0];
    expect(row?.error).toContain('板に無い限月');
    expect(row?.greeks).toBeNull();
  });
});

describe('建値ずれ（AC-13）', () => {
  it('両側気配の板の足は 0 円', () => {
    const s = run(
      { type: 'addBoardLeg', expiry: m1.id, k: atm1, optionType: 'put', side: 'sell' },
      { type: 'addBoardLeg', expiry: m1.id, k: atm1, optionType: 'call', side: 'buy' },
    );
    for (const r of positionModel(chain, s.legs, 'B', CALENDAR).rows) {
      expect(r.anchorSource).toBe('entry');
      expect(r.mismatchYen).toBe(0);
      expect(r.mismatchNote).toBeNull();
    }
  });

  it('建値 ≤ 割引本源的価値の足: 0 でない建値ずれ = シナリオ 0 の理論損益', () => {
    // 深い ITM の put（K = F + 5,000 円付近）を建値 1 円で買う
    const k = m1.strikes.find((s) => s.k > m1.F + 5000)?.k as number;
    expect(1).toBeLessThan(discountedIntrinsic('put', m1.F, k, m1.T, chain.r));
    let s = run({ type: 'addBoardLeg', expiry: m1.id, k, optionType: 'put', side: 'buy' });
    s = reduce(s, { type: 'editLeg', id: s.legs[0]?.id as number, patch: { entry: 1 } });
    const row = positionModel(chain, s.legs, 'B', CALENDAR).rows[0];
    expect(row?.anchorSource).toBe('smile');
    expect(Math.abs(row?.mismatchYen as number)).toBeGreaterThan(1000);
    // 安く買えた分はシナリオ 0 で利益（建値ずれは正）
    expect(row?.mismatchYen).toBeGreaterThan(0);
    expect(row?.mismatchYen).toBeCloseTo(pnlAtZero(s, 0), 6);
    expect(row?.mismatchNote).toContain('割引本源的価値');
  });

  it('IV と建値が整合しない手入力の足: 0 でない建値ずれ（売買で符号が反転）', () => {
    const input = {
      product: 'op_large' as const,
      expiry: '2027-01',
      type: 'put' as const,
      k: 64000,
      entry: 100,
      iv: 0.3,
    };
    const sell = run({ type: 'addManualLeg', input: { ...input, side: 'sell' } });
    const buy = run({ type: 'addManualLeg', input: { ...input, side: 'buy' } });
    const rs = positionModel(chain, sell.legs, 'B', CALENDAR).rows[0];
    const rb = positionModel(chain, buy.legs, 'B', CALENDAR).rows[0];
    expect(Math.abs(rs?.mismatchYen as number)).toBeGreaterThan(1);
    expect(rs?.mismatchYen).toBeCloseTo(-(rb?.mismatchYen as number), 9);
    expect(rs?.mismatchYen).toBeCloseTo(pnlAtZero(sell, 0), 6);
    expect(rb?.mismatchYen).toBeCloseTo(pnlAtZero(buy, 0), 6);
  });
});

import { describe, expect, it } from 'vitest';
import { buildCalendar, buildMarketContext, normalizeChain } from '../../data';
import bundledJson from '../../data/calendar/calendar.json';
import {
  DEFAULT_SETTINGS,
  discountedIntrinsic,
  evaluatePosition,
  jstInstant,
  monthlyExpiry,
  prepareLeg,
  theoreticalPnl,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { markPrice } from '../../ui/view/mark';
import {
  daysSinceOpen,
  fmtEntry,
  heldDaysText,
  jstDay,
  legBadges,
  legName,
  legSummary,
  openedBeforeBoard,
  type PositionRow,
  positionModel,
  stepQty,
  toggledSide,
} from '../../ui/view/position';
import { fixture } from '../support/fixtures';
import { boardsT0AndLater, laterJson } from '../support/laterChain';

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

  it('板の無い限月の手入力の足は、その限月の SQ 日を同梱のカレンダーから求める', () => {
    const s = reduce(state, { type: 'addManualLeg', input: manual('2027-01') });
    const row = positionModel(chain, s.legs, 'B', CALENDAR).rows[5];
    expect(row?.markLabels).toContain('板なし（手入力）');
    expect(row?.sqDate).toBe(monthlyExpiry(2027, 1, CALENDAR.holidays).sqDate);
    expect(row?.error).toBeNull();
    expect(row?.greeks).not.toBeNull();
  });

  it('同梱のカレンダーで、第 2 金曜が確定の最終日より後の限月には「休業日未確定」', () => {
    // 確定の最終日の翌月以降で最初の限月（同梱の版を作り直してカレンダーが延びても成り立つように求める）
    const until = CALENDAR.coveredUntil as string;
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

/** AC-6（#14）・AC-3（#39）: 取引カレンダーの反映。確定の最終日を 2027-06-30 に固定したカレンダー（休業日は同梱の版）。 */
describe('取引カレンダーの反映（SQ 日・休業日未確定）', () => {
  const cal = buildCalendar({ ...bundledJson, covered_until: '2027-06-30' }, 'bundled');
  const base: State = { ...run(), calendar: cal };

  it('前提: 確定の最終日 = 2027-06-30', () => {
    expect(cal.ok).toBe(true);
    expect(cal.coveredUntil).toBe('2027-06-30');
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

  it('掲載範囲（listed_until）より後の 2028-02 限: 土日だけで SQ 日 2028-02-11（祝日は版に無い）、「休業日未確定」', () => {
    expect(cal.listedUntil).toBe('2027-12-31');
    const s = reduce(base, { type: 'addManualLeg', input: manual('2028-02') });
    const row = positionModel(chain, s.legs, 'B', cal).rows[0];
    expect(row?.sqDate).toBe('2028-02-11');
    expect(row?.calendarUnconfirmed).toBe(true);
  });

  it('壊れたカレンダー: 例外を出さず、SQ 日は土日だけで計算、暦から求めた足は全部「休業日未確定」', () => {
    const broken = buildCalendar({ broken: true }, 'bundled');
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

describe('1 行の簡易表示（#62）', () => {
  /** 最小の PositionRow（値は架空） */
  function row(over: Partial<PositionRow>): PositionRow {
    return {
      id: 1,
      kind: 'option',
      product: 'op_large',
      productLabel: 'ラージ OP',
      month: '2026-11',
      optionType: 'P',
      strike: 64000,
      side: 'sell',
      sideLabel: '売り',
      qty: 1,
      entry: 810,
      iv: 0.2,
      ivEdited: false,
      anchorSource: 'entry',
      greeks: null,
      mismatchYen: 0,
      mismatchNote: null,
      marks: [],
      markLabels: [],
      warnings: [],
      sqDate: '2026-11-13',
      calendarUnconfirmed: false,
      state: null,
      error: null,
      openedAt: null,
      openedDate: null,
      daysSinceOpen: null,
      heldBefore: false,
      heldMark: null,
      unrealizedYen: null,
      markMissing: false,
      openedAfterBoard: false,
      ...over,
    };
  }

  it('OP: 売 P 64,000 ×1 @810（限月は文言に入れない）', () => {
    expect(legSummary(row({}))).toBe('売 P 64,000 ×1 @810');
    expect(legSummary(row({ side: 'buy', optionType: 'C', strike: 70000, qty: 1200 }))).toBe(
      '買 C 70,000 ×1,200 @810',
    );
  });

  it('先物: ミニ先物 2026-12 買 ×1 @67,880', () => {
    const f = row({
      kind: 'future',
      product: 'fut_mini',
      productLabel: 'ミニ先物',
      month: '2026-12',
      optionType: null,
      strike: null,
      side: 'buy',
      entry: 67880,
    });
    expect(legSummary(f)).toBe('ミニ先物 2026-12 買 ×1 @67,880');
  });

  it('建値の小数は丸めて別の値に見せない（小数第 2 位まで、末尾 0 なし）', () => {
    expect(fmtEntry(810.5)).toBe('810.5');
    expect(fmtEntry(810.25)).toBe('810.25');
    expect(fmtEntry(1234.125)).toBe('1,234.13');
    expect(fmtEntry(67880)).toBe('67,880');
    expect(fmtEntry(0)).toBe('0');
    expect(legSummary(row({ entry: 810.5 }))).toBe('売 P 64,000 ×1 @810.5');
  });

  it('足の名前（aria-label 用）は売買を含めない', () => {
    expect(legName(row({}))).toBe('2026-11 P 64,000');
    expect(legName(row({ side: 'buy' }))).toBe('2026-11 P 64,000');
    expect(
      legName(
        row({ kind: 'future', productLabel: 'ミニ先物', month: '2026-12', optionType: null }),
      ),
    ).toBe('ミニ先物 2026-12');
  });

  it('行の印: 短縮ラベル、警告は warn', () => {
    expect(legBadges(row({}))).toEqual([]);
    expect(legBadges(row({ marks: ['unstable_iv'] }))).toEqual([{ text: 'IV 不安定', warn: true }]);
    expect(legBadges(row({ marks: ['no_board'], ivEdited: true }))).toEqual([
      { text: '手入力', warn: false },
      { text: 'IV 編集', warn: false },
    ]);
    expect(legBadges(row({ calendarUnconfirmed: true, error: 'x' }))).toEqual([
      { text: '休業日未確定', warn: false },
      { text: 'エラー', warn: true },
    ]);
  });

  it('読み直した板に限月が無い足は行に「エラー」', () => {
    const s = run({ type: 'addBoardLeg', expiry: m1.id, k: atm1, optionType: 'put', side: 'sell' });
    const other = normalizeChain(fixture('latest'));
    other.months.splice(0, 1);
    const r = positionModel(other, s.legs, 'B', CALENDAR).rows[0];
    expect(legBadges(r as PositionRow)).toContainEqual({ text: 'エラー', warn: true });
  });

  it('枚数 ±1: 1 未満・上限超えにしない（parseQty と同じ範囲）', () => {
    expect(stepQty(1, -1)).toBeNull();
    expect(stepQty(1, 1)).toBe(2);
    expect(stepQty(2, -1)).toBe(1);
    expect(stepQty(100_000, 1)).toBeNull();
    expect(stepQty(99_999, 1)).toBe(100_000);
  });

  it('枚数 ±1 を reducer に渡すと足の枚数が変わる', () => {
    let s = run({ type: 'addBoardLeg', expiry: m1.id, k: atm1, optionType: 'put', side: 'sell' });
    const id = s.legs[0]?.id as number;
    s = reduce(s, { type: 'editLeg', id, patch: { qty: stepQty(1, 1) as number } });
    expect(s.legs[0]?.leg.qty).toBe(2);
    expect(positionModel(chain, s.legs, 'B', CALENDAR).rows[0]?.qty).toBe(2);
  });

  it('売⇄買: 建値・IV 編集は変えず、Δ と建値ずれの符号が反転', () => {
    expect(toggledSide('buy')).toBe('sell');
    expect(toggledSide('sell')).toBe('buy');
    const k = atm1 - 2000;
    let s = run({ type: 'addBoardLeg', expiry: m1.id, k, optionType: 'put', side: 'sell' });
    const id = s.legs[0]?.id as number;
    s = reduce(s, { type: 'editLeg', id, patch: { iv: 0.3 } });
    const before = positionModel(chain, s.legs, 'B', CALENDAR).rows[0] as PositionRow;
    s = reduce(s, { type: 'editLeg', id, patch: { side: toggledSide(before.side) } });
    const after = positionModel(chain, s.legs, 'B', CALENDAR).rows[0] as PositionRow;
    expect(after.side).toBe('buy');
    expect(after.sideLabel).toBe('買い');
    expect(after.entry).toBe(before.entry);
    expect(after.ivEdited).toBe(true);
    expect(after.iv).toBeCloseTo(before.iv as number, 12);
    // 売り put の Δ は正、買いでは負
    expect(before.greeks?.deltaLarge).toBeGreaterThan(0);
    expect(after.greeks?.deltaLarge).toBeLessThan(0);
    expect(Math.abs(before.mismatchYen as number)).toBeGreaterThan(1);
    expect(after.mismatchYen).toBeCloseTo(-(before.mismatchYen as number), 6);
    expect(legSummary(after).startsWith('買 P')).toBe(true);
  });
});

// ---------------------------------------------------------------- 前の板で建てた足（#299）

describe('前の板で建てた足を今の板で時価評価する（#299。t₀ と t₀ + 3 日の合成の板）', () => {
  const { t0, later } = boardsT0AndLater();
  const settings = { ...DEFAULT_SETTINGS, feePerLot: 20 };
  const load = (s: State, c: typeof t0) => reduce(s, { type: 'loaded', chain: c, label: 'x' });
  // t₀ で入れる足: 両側気配の売り P・後の板で気配が無くなる行の売り P（今の値段 = スマイルの理論価格）・
  // 買い C（2 枚）・板の先物の買い
  const opened = [
    { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 59000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-12', k: 70000, optionType: 'call', side: 'buy' },
    { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
  ] as const satisfies readonly Action[];
  const atT0 = [
    ...opened,
    { type: 'editLeg', id: 3, patch: { qty: 2 } },
  ] as const satisfies readonly Action[];
  const s0 = atT0.reduce<State>(reduce, load(initialState, t0));
  const s3 = reduce(load(s0, later), {
    type: 'addBoardLeg',
    expiry: '2026-11',
    k: 66000,
    optionType: 'put',
    side: 'sell',
  });
  const model = positionModel(later, s3.legs, 'B', CALENDAR, settings);
  const ev = evaluatePosition(model.prepared, ZERO_SCENARIO, model.ctx, settings);

  it('前提: t₀ の足は t₀ の板の時刻、後で入れた足は後の板の時刻。判定は建てた日時 < 今の板の時刻', () => {
    expect(s3.legs.map((l) => l.leg.openedAt)).toEqual([
      t0.snapshotAt,
      t0.snapshotAt,
      t0.snapshotAt,
      t0.snapshotAt,
      later.snapshotAt,
    ]);
    expect(s3.legs.map((l) => openedBeforeBoard(l.leg, later))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // t₀ の板で見れば前の板の足は無い
    expect(s0.legs.some((l) => openedBeforeBoard(l.leg, t0))).toBe(false);
    expect(positionModel(t0, s0.legs, 'B', CALENDAR).heldDays).toBeNull();
  });

  it('AC7: 各 OP の足のシナリオ 0 の損益 = (今の板の mid か理論価格 − 建値) × 符号 × 枚数 × 乗数 − 手数料、後で入れた足は 0', () => {
    expect(model.rows.every((r) => r.error === null)).toBe(true);
    const theoretical: boolean[] = [];
    for (const [i, ui] of s3.legs.entries()) {
      const leg = ui.leg;
      const e = ev.legs[i];
      if (!e) throw new Error('評価が無い');
      const fee = settings.feePerLot * leg.qty;
      const sign = leg.side === 'buy' ? 1 : -1;
      const mult = leg.kind === 'option' ? 1000 : 100;
      if (i === 4) {
        // 後の板で入れた足: 建値から逆算（シナリオ 0 の損益 0 − 手数料）
        expect(e.pnl).toBeCloseTo(-fee, 6);
        expect(model.rows[i]?.heldMark).toBeNull();
        continue;
      }
      const m =
        leg.kind === 'option'
          ? markPrice(later, leg)
          : { price: later.future.price as number, theoretical: false };
      if (!m) throw new Error('今の値段が無い');
      theoretical.push(m.theoretical);
      expect(e.pnl).toBeCloseTo(sign * leg.qty * mult * (m.price - leg.entry) - fee, 4);
      expect(model.rows[i]?.unrealizedYen).toBeCloseTo(
        sign * leg.qty * mult * (m.price - leg.entry),
        6,
      );
      expect(model.rows[i]?.heldMark).toEqual(m);
      expect(model.rows[i]?.anchorSource ?? 'future').not.toBe('smile');
    }
    // mid の足とスマイルの理論価格の足の両方を含む
    expect(theoretical.slice(0, 3)).toEqual([false, true, false]);
    // 合計 = 含み損益 + 建値ずれ − 手数料（AC3 の恒等式）
    const sum = s3.legs.reduce((a, ui) => a + settings.feePerLot * ui.leg.qty, 0);
    const unreal = model.rows.reduce((a, r) => a + (r.unrealizedYen ?? 0), 0);
    const mism = model.rows.reduce((a, r) => a + (r.mismatchYen ?? 0), 0);
    expect(ev.pnl).toBeCloseTo(unreal + mism - sum, 4);
    expect(Math.abs(unreal)).toBeGreaterThan(1000);
  });

  it('AC7: 足の詳細の行に建てた日・N 日前・今の値段（mid / 理論価格）', () => {
    const r = model.rows;
    expect(r[0]).toMatchObject({
      openedAt: t0.snapshotAt,
      openedDate: '2026-10-13',
      daysSinceOpen: 3,
      heldBefore: true,
      markMissing: false,
    });
    expect(r[4]).toMatchObject({
      openedDate: '2026-10-16',
      daysSinceOpen: 0,
      heldBefore: false,
      unrealizedYen: null,
    });
    expect(model.heldDays).toBe(3);
  });

  it('AC9: 今の値段が取れない足（板に無い限月の手入力の足・スマイル無し）は建値で評価し、印が出る', () => {
    const input = {
      product: 'op_large' as const,
      expiry: '2027-03',
      type: 'put' as const,
      k: 60000,
      side: 'sell' as const,
      entry: 300,
      iv: 0.3,
    };
    const a = reduce(load(initialState, t0), { type: 'addManualLeg', input });
    const b = load(a, later);
    const m = positionModel(later, b.legs, 'B', CALENDAR);
    const row = m.rows[0] as PositionRow;
    expect(row.heldBefore).toBe(true);
    expect(row.markMissing).toBe(true);
    expect(row.heldMark).toBeNull();
    expect(row.unrealizedYen).toBeNull();
    expect(m.prepared[0]?.mark).toBeNull();
    expect(legBadges(row)).toContainEqual({ text: '今の値段なし', warn: true });
    // 評価は今までどおり（今の板で入れた同じ足と同じ）
    const fresh = reduce(load(initialState, later), { type: 'addManualLeg', input });
    const mf = positionModel(later, fresh.legs, 'B', CALENDAR);
    const e1 = evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx);
    const e2 = evaluatePosition(mf.prepared, ZERO_SCENARIO, mf.ctx);
    expect(e1.pnl).toBe(e2.pnl);
    expect(legBadges(mf.rows[0] as PositionRow).some((b) => b.text === '今の値段なし')).toBe(false);
  });

  it('前の板で建てた先物の足で、今の板に先物価格が無い（先物価格なし）: 今の値段なし（建値で代用した値を今の先物価格に見せない）', () => {
    const j = laterJson();
    j.future.price = null;
    j.future.price_time = null;
    const noPrice = normalizeChain(j);
    const a = reduce(load(initialState, t0), {
      type: 'addFutureLeg',
      input: { side: 'buy', qty: 1 },
    });
    const b = load(a, noPrice);
    expect(b.legs[0]?.marks).toContain('no_price');
    const m = positionModel(noPrice, b.legs, 'B', CALENDAR);
    const row = m.rows[0] as PositionRow;
    expect(row.heldBefore).toBe(true);
    expect(row.heldMark).toBeNull();
    expect(row.unrealizedYen).toBeNull();
    expect(row.markMissing).toBe(true);
    expect(m.prepared[0]?.mark).toBeNull();
    expect(legBadges(row)).toContainEqual({ text: '今の値段なし', warn: true });
  });

  it('AC10: 建てた日時が今の板より後の足（保存した古い板を表示）は今の板の足と同じ扱い、N は 0', () => {
    const s = (opened as readonly Action[]).reduce<State>(reduce, load(initialState, later));
    const back = load(s, t0);
    const m = positionModel(t0, back.legs, 'B', CALENDAR);
    expect(m.rows.every((r) => !r.heldBefore && r.heldMark === null)).toBe(true);
    expect(m.rows[0]?.daysSinceOpen).toBe(0);
    expect(m.heldDays).toBeNull();
    const plain = positionModel(
      t0,
      back.legs.map((l) => {
        const { openedAt: _o, ...leg } = l.leg;
        return { ...l, leg };
      }),
      'B',
      CALENDAR,
    );
    expect(evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx).pnl).toBe(
      evaluatePosition(plain.prepared, ZERO_SCENARIO, plain.ctx).pnl,
    );
  });

  it('AC15: 建てた日時の無い足（古い保存）は今までどおり建値から（シナリオ 0 の損益 0）', () => {
    const legs = s0.legs.map((l) => {
      const { openedAt: _o, ...leg } = l.leg;
      return { ...l, leg };
    });
    const m = positionModel(later, legs, 'B', CALENDAR);
    expect(m.heldDays).toBeNull();
    expect(m.rows.every((r) => r.openedDate === null && !r.heldBefore)).toBe(true);
    const e = evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx);
    // OP の足は 0、先物の足は (今の先物価格 − 建値)（今までと同じ）
    const fut = legs[3]?.leg;
    expect(e.pnl).toBeCloseTo(100 * ((later.future.price as number) - (fut?.entry as number)), 4);
  });
});

describe('建ててから N 日（#299。JST の暦日）', () => {
  it('AC17: 2026-11-02 23:59 JST → 2026-11-05 00:00 JST は 3、2026-11-03 00:00 JST は 2', () => {
    const snap = jstInstant('2026-11-05', 0, 0);
    expect(daysSinceOpen(jstInstant('2026-11-02', 23, 59), snap)).toBe(3);
    expect(daysSinceOpen(jstInstant('2026-11-03', 0, 0), snap)).toBe(2);
    expect(jstDay(jstInstant('2026-11-03', 0, 0)) - jstDay(jstInstant('2026-11-02', 23, 59))).toBe(
      1,
    );
    // 建てた日時が今の板より後は 0
    expect(daysSinceOpen(jstInstant('2026-11-06', 9, 0), snap)).toBe(0);
  });

  it('AC17: 建てた日 2026-11-02・今の板 2026-11-05・d = 2 で「建ててから 5 日」。前の板の足が無ければ出ない', () => {
    expect(heldDaysText(3, 2)).toBe('建ててから 5 日');
    expect(heldDaysText(3, 0)).toBe('建ててから 3 日');
    expect(heldDaysText(3, 1.256)).toBe('建ててから 4.26 日');
    expect(heldDaysText(null, 2)).toBeNull();
    expect(heldDaysText(0, Number.NaN)).toBe('建ててから 0 日');
  });

  it('AC17: 足ごとに違うときは最も古い足の N（heldDays）', () => {
    const { t0, later } = boardsT0AndLater(5);
    const mid = boardsT0AndLater(2).later;
    const load = (s: State, c: typeof t0) => reduce(s, { type: 'loaded', chain: c, label: 'x' });
    const leg = {
      type: 'addBoardLeg',
      expiry: '2026-12',
      k: 64000,
      optionType: 'put',
      side: 'sell',
    } as const;
    let s = reduce(load(initialState, t0), leg);
    s = reduce(load(s, mid), { ...leg, k: 65000 });
    s = load(s, later);
    const m = positionModel(later, s.legs, 'B', CALENDAR);
    expect(m.rows.map((r) => r.daysSinceOpen)).toEqual([5, 3]);
    expect(m.heldDays).toBe(5);
  });
});

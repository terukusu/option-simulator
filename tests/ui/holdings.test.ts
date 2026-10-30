import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  DEFAULT_SETTINGS,
  evaluatePosition,
  premiumSummary,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import { addEntry, type BookEntry, type BookRead, EMPTY_BOOK, type OkEntry } from '../../ui/book';
import { toSaved } from '../../ui/persist';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { markToBoard } from '../../ui/view/bookList';
import {
  DISTANCE_CALL_NOW,
  DISTANCE_NONE,
  DISTANCE_PENDING,
  distanceParts,
  distanceText,
  groupHoldings,
  HOLDINGS_EMPTY_TEXT,
  type HoldingsInput,
  holdingSources,
  holdingsModel,
  legFingerprint,
  NO_BOARD_VALUE,
  otherHeldCount,
  sameLegSet,
} from '../../ui/view/holdings';
import { marginLine, marginNow, marginParamsOf } from '../../ui/view/margin';
import { ROOM_NO_CAPITAL_TEXT } from '../../ui/view/metricsPanel';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { TABS_FULL_TEXT } from '../../ui/view/tabs';
import { fixture } from '../support/fixtures';
import { boardsT0AndLater } from '../support/laterChain';

/**
 * #302 保有ポジションの一覧（ui/view/holdings.ts）。合成の板（latest と t₀ + 3 日。値は架空）で、対象・同じ玉の判定・
 * 行と合計の値（指標と同じ組み立てとの一致）・追証までの距離・欠け・シナリオに依らないこと・行の操作を確かめる。
 */

const NOW = Date.parse('2026-10-16T03:00:00.000Z');
const chain: Chain = normalizeChain(fixture('latest'));
const PARAMS = marginParamsOf(DEFAULT_MARGIN_PREFS);
const EMPTY: BookRead = { kind: 'empty' };

const run = (s: State, ...acts: Action[]) => acts.reduce(reduce, s);
const putSell: Action = {
  type: 'addBoardLeg',
  expiry: '2026-11',
  k: 64000,
  optionType: 'put',
  side: 'sell',
};
const callSell: Action = {
  type: 'addBoardLeg',
  expiry: '2026-11',
  k: 70500,
  optionType: 'call',
  side: 'sell',
};
const putBuy: Action = {
  type: 'addBoardLeg',
  expiry: '2026-11',
  k: 62000,
  optionType: 'put',
  side: 'buy',
};
const hold: Action = { type: 'setTabHeld', held: true };
const newTab: Action = { type: 'addTab', mode: 'empty' };

const base0 = (fee = 50): State =>
  run({ ...initialState, feePerLot: fee }, { type: 'loaded', chain, label: 'latest' });

/** タブ A = put の売り（保有）、タブ B = call の売り（保有）。作業中は B */
function twoHeld(fee = 50): State {
  return run(base0(fee), putSell, hold, newTab, callSell, hold);
}

const nowOf = (sc: Scenario): Scenario => ({
  ...ZERO_SCENARIO,
  beta: sc.beta,
  ivDynamics: sc.ivDynamics,
  ivShift: sc.ivShift,
});

function input(s: State, read: BookRead = EMPTY, capital: number | null = null): HoldingsInput {
  return {
    chain: s.chain,
    tabs: s.tabs,
    activeTab: s.activeTab,
    legs: s.legs,
    read,
    atmBasis: s.atmBasis,
    calendar: s.calendar,
    feePerLot: s.feePerLot,
    futureBasis: s.futureBasis,
    unitSetting: 'yen',
    nowScenario: nowOf(s.scenario),
    params: PARAMS,
    capital,
  };
}

function entryOf(s: State, name: string, id: string): OkEntry {
  const r = addEntry(EMPTY_BOOK, toSaved(s, NOW), name, NOW, id);
  if (!r.ok) throw new Error(r.reason);
  const e = r.book.entries[0];
  if (e?.status !== 'ok') throw new Error('読めない');
  return e;
}

const readOf = (...entries: BookEntry[]): BookRead => ({
  kind: 'ok',
  book: { entries },
  chars: 100,
});

/** 指標（useAppController）と同じ組み立て: positions → pnlBoard → marginNow・シナリオ 0 の評価 */
function indicator(s: State, capital: number | null = null) {
  const c = s.chain;
  if (!c) throw new Error('板が無い');
  const settings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot, futureBasis: s.futureBasis };
  const pm = positionModel(c, s.legs, s.atmBasis, s.calendar, settings);
  const base = pnlDomains(c, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('評価できない');
  const calc = marginNow(base, nowOf(s.scenario), PARAMS, capital, s.calendar.holidays);
  const ev = evaluatePosition(base.legs, ZERO_SCENARIO, base.ctx, settings);
  return { base, calc, total: ev.total, pnl: ev.pnl, premium: premiumSummary(base.legs, settings) };
}

const tagTexts = (tags: { text: string }[]) => tags.map((t) => t.text);

describe('対象（AC1）', () => {
  it('保有のタブ（作業中・退避）と保存一覧の保有の項目だけが行になる', () => {
    const s = run(twoHeld(), newTab, putBuy); // タブ C は印なし（作業中）
    const heldEntry = entryOf(run(base0(), putBuy, hold), '保有の項目', 'h');
    const plainEntry = entryOf(run(base0(), putBuy), '検討の項目', 'p');
    const bad: BookEntry = { status: 'invalid', id: 'bad', raw: 1, savedAt: null };
    const newer: BookEntry = { status: 'newer', id: 'nw', raw: {}, savedAt: NOW };
    const v = holdingsModel(input(s, readOf(heldEntry, plainEntry, bad, newer)));
    expect(v.rows.map((r) => r.name)).toEqual(['A', 'B', '保有の項目']);
    expect(v.rows.map((r) => r.key)).toEqual(['tab:1', 'tab:2', 'book:h']);
    expect(tagTexts(v.rows[0]?.tags ?? [])[0]).toBe('タブ');
    expect(tagTexts(v.rows[2]?.tags ?? [])[0]).toBe('保存一覧');
    // 作業中のタブが保有なら「作業中のタブ」
    const v2 = holdingsModel(input(twoHeld()));
    expect(tagTexts(v2.rows[1]?.tags ?? [])[0]).toBe('作業中のタブ');
  });

  it('対象が無ければ空の文', () => {
    const v = holdingsModel(input(run(base0(), putSell)));
    expect(v.empty).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.total).toBeNull();
    expect(HOLDINGS_EMPTY_TEXT).toContain('保有にする');
  });
});

describe('同じ玉の判定（AC2）', () => {
  it('指紋は枚数・IV の編集・mid を含まない', () => {
    const s = run(base0(), putSell);
    const leg = s.legs[0]?.leg;
    if (leg?.kind !== 'option') throw new Error('足が無い');
    expect(legFingerprint({ ...leg, qty: 5, iv: 0.3, mid: 1 })).toBe(legFingerprint(leg));
    expect(legFingerprint({ ...leg, entry: leg.entry + 5 })).not.toBe(legFingerprint(leg));
    expect(legFingerprint({ ...leg, openedAt: 1 })).not.toBe(legFingerprint(leg));
    const a = s.legs;
    expect(
      sameLegSet(
        a,
        a.map((l) => ({ ...l })),
      ),
    ).toBe(true);
    expect(
      sameLegSet(
        a,
        a.map((l) => ({ ...l, leg: { ...l.leg, qty: 2 } })),
      ),
    ).toBe(false);
  });

  it('(a) 保有のタブと足の組が全く同じ項目は 1 行（シナリオ・ΔX だけ違っても）', () => {
    const s = run(base0(), putSell, callSell, hold);
    const moved = run(s, { type: 'setScenario', patch: { dX: -3000, days: 5, dSigma: 4 } });
    const e = entryOf(moved, '写し', 'e');
    const v = holdingsModel(input(s, readOf(e)));
    expect(v.rows).toHaveLength(1);
    expect(tagTexts(v.rows[0]?.tags ?? [])).toContain('保存一覧にもある');
    expect(v.total?.count).toBe(1);
  });

  it('(b) 枚数だけ違う（一部を決済した後のタブ）は行に出して合計に入れない', () => {
    const before = run(base0(), putSell, callSell, hold);
    const e = entryOf(before, '保存した時', 'e');
    const id = before.legs[0]?.id ?? 0;
    const after = run(before, { type: 'editLeg', id, patch: { qty: 2 } });
    const v = holdingsModel(input(after, readOf(e)));
    expect(v.rows.map((r) => r.counted)).toEqual([true, false]);
    expect(tagTexts(v.rows[1]?.tags ?? [])).toContain('タブ A と同じ足 2 本・合計に入れない');
    expect(v.rows[1]?.tags.find((t) => t.text.includes('合計に入れない'))?.warn).toBe(true);
    expect(v.total?.count).toBe(1);
  });

  it('(c) 重ならない項目は合計に入る', () => {
    const s = run(base0(), putSell, hold);
    const e = entryOf(run(base0(), callSell, hold), '別の玉', 'e');
    const v = holdingsModel(input(s, readOf(e)));
    expect(v.rows.map((r) => r.counted)).toEqual([true, true]);
    expect(v.total?.count).toBe(2);
  });

  it('(d) 保有のタブどうしも同じ規則（帯の順が先）', () => {
    // A = put 売り + call 売り（保有）、B = A の写し（保有）→ 1 行に「タブ B にもある」
    const s = run(base0(), putSell, callSell, hold, { type: 'addTab', mode: 'copy' }, hold);
    const v = holdingsModel(input(s));
    expect(v.rows.map((r) => r.name)).toEqual(['A']);
    expect(tagTexts(v.rows[0]?.tags ?? [])).toContain('タブ B にもある');
    // C = put 売りだけ（A と 1 本重なる）
    const s2 = run(
      base0(),
      putSell,
      callSell,
      hold,
      { type: 'addTab', mode: 'copy' },
      { type: 'removeLeg', id: 2 },
      hold,
    );
    const v2 = holdingsModel(input(s2));
    expect(v2.rows.map((r) => [r.name, r.counted])).toEqual([
      ['A', true],
      ['B', false],
    ]);
    expect(tagTexts(v2.rows[1]?.tags ?? [])).toContain('タブ A と同じ足 1 本・合計に入れない');
  });

  it('保存一覧の項目と重なる行は項目の名前を名指しする', () => {
    const e1 = entryOf(run(base0(), putSell, callSell, hold), '前の写し', 'e1');
    const e2 = entryOf(run(base0(), putSell, hold), '片側', 'e2');
    const groups = groupHoldings(holdingSources(initialState.tabs, 1, [], readOf(e1, e2)));
    expect(groups.map((g) => g.counted)).toEqual([true, false]);
    expect(tagTexts(groups[1]?.tags ?? [])).toEqual([
      '保存一覧の「前の写し」と同じ足 1 本・合計に入れない',
    ]);
  });

  it('otherHeldCount: 合計に入れる行のうち作業中のタブ以外（板が無くても数える）', () => {
    const s = twoHeld();
    expect(otherHeldCount(s, EMPTY)).toBe(1);
    const noBoard: State = { ...s, chain: null };
    expect(otherHeldCount(noBoard, EMPTY)).toBe(1);
    const e = entryOf(run(base0(), putBuy, hold), '別', 'e');
    expect(otherHeldCount(s, readOf(e))).toBe(2);
    expect(otherHeldCount(run(base0(), putSell), EMPTY)).toBe(0);
  });
});

describe('行の値（AC3）', () => {
  it('評価損益 = markToBoard、必要証拠金・Δ = そのタブを作業中にしたときの指標の値', () => {
    const s = twoHeld();
    const v = holdingsModel(input(s));
    // B（作業中）
    const b = indicator(s);
    expect(v.rows[1]?.values.margin).toBe(b.calc?.result.margin);
    expect(v.rows[1]?.values.deltaLarge).toBe(b.total.deltaLarge);
    expect(v.rows[1]?.values.deltaMini).toBe(b.total.deltaMini);
    expect(v.rows[1]?.values.mark).toBe(
      markToBoard(
        chain,
        s.legs.map((l) => l.leg),
        50,
      ).pnl,
    );
    // A（退避）→ 切り替えた state の指標と一致
    const a = indicator(run(s, { type: 'switchTab', id: 1 }));
    expect(v.rows[0]?.values.margin).toBeCloseTo(a.calc?.result.margin ?? Number.NaN, 6);
    expect(v.rows[0]?.values.deltaLarge).toBeCloseTo(a.total.deltaLarge, 9);
    expect(v.rows[0]?.values.deltaMini).toBeCloseTo(a.total.deltaMini, 9);
    const aState = run(s, { type: 'switchTab', id: 1 });
    expect(v.rows[0]?.values.mark).toBe(
      markToBoard(
        chain,
        aState.legs.map((l) => l.leg),
        50,
      ).pnl,
    );
    expect(v.rows[0]?.marginText).toMatch(/^[\d,]+$/);
    expect(v.rows[0]?.deltaText).toMatch(/枚（ミニ /);
  });

  it('前の板で建てた保有の作業中のタブ: 評価損益 = シナリオ 0 の損益、建ててから N 日', () => {
    const { t0, later } = boardsT0AndLater();
    const s = run(
      { ...initialState, feePerLot: 50 },
      { type: 'loaded', chain: t0, label: 't0' },
      putSell,
      callSell,
      hold,
      { type: 'loaded', chain: later, label: 'later' },
    );
    const v = holdingsModel(input(s));
    const ind = indicator(s);
    expect(v.rows[0]?.values.mark).toBeCloseTo(ind.pnl, 6);
    expect(v.rows[0]?.values.heldDays).toBe(3);
    expect(v.rows[0]?.heldText).toBe('建ててから 3 日');
    // 今の板で入れた足（建てた日時 = 今の板）は 0 日
    expect(holdingsModel(input(twoHeld())).rows[0]?.heldText).toBe('建ててから 0 日');
  });

  it('建てた日時の無い足だけなら「—」', () => {
    const s = twoHeld();
    const strip = s.legs.map((l) => {
      const { openedAt: _o, ...leg } = l.leg;
      return { ...l, leg };
    });
    const v = holdingsModel({ ...input(s), legs: strip });
    expect(v.rows[1]?.heldText).toBe('建ててから —');
  });
});

describe('合計（AC4）', () => {
  it('put の売り + call の売り: 合計の必要証拠金・余力 = 2 本を 1 つのタブに入れた指標の値（行の和ではない）', () => {
    const capital = 5_000_000;
    const s = twoHeld();
    const v = holdingsModel(input(s, EMPTY, capital));
    const both = indicator(run(base0(), putSell, callSell), capital);
    const t = v.total;
    if (!t) throw new Error('合計が無い');
    expect(t.count).toBe(2);
    expect(t.values.margin).toBeCloseTo(both.calc?.result.margin ?? Number.NaN, 6);
    expect(t.values.room).toBeCloseTo(both.calc?.room ?? Number.NaN, 6);
    expect(t.values.deltaLarge).toBeCloseTo(both.total.deltaLarge, 9);
    const sum = (v.rows[0]?.values.margin ?? 0) + (v.rows[1]?.values.margin ?? 0);
    expect(Math.abs((t.values.margin ?? 0) - sum)).toBeGreaterThan(1);
    // 評価損益は行の和
    expect(t.values.mark).toBeCloseTo(
      (v.rows[0]?.values.mark ?? 0) + (v.rows[1]?.values.mark ?? 0),
      9,
    );
  });

  it('合計に入らない行の足は合計に入らない', () => {
    const s = run(base0(), putSell, hold);
    const e = entryOf(run(base0(), putSell, callSell, hold), '重なる', 'e');
    const v = holdingsModel(input(s, readOf(e)));
    const only = indicator(s);
    expect(v.rows.map((r) => r.counted)).toEqual([true, false]);
    expect(v.total?.values.margin).toBeCloseTo(only.calc?.result.margin ?? Number.NaN, 6);
    expect(v.total?.values.mark).toBe(v.rows[0]?.values.mark);
  });
});

describe('追証までの距離（AC5）', () => {
  it('線の X₀ に最も近い下・上、% = (水準 − X₀) / X₀', () => {
    expect(distanceText(30000, [27000, 29000, 31000, 40000])).toBe(
      '下 −3.3%（29,000 円） · 上 +3.3%（31,000 円）',
    );
    expect(distanceParts(30000, [33000])).toEqual(['下 なし', '上 +10.0%（33,000 円）']);
    expect(distanceParts(30000, [24000])).toEqual(['下 −20.0%（24,000 円）', '上 なし']);
    expect(distanceText(30000, [])).toBe(DISTANCE_NONE);
    expect(distanceText(30000, null)).toBe(DISTANCE_PENDING);
  });

  it('合計の線の入力 = まとめたポジション（d = 0）。marginLine の結果から距離を作る', () => {
    const capital = 3_000_000;
    const v = holdingsModel(input(twoHeld(), EMPTY, capital));
    const line = v.total?.line;
    if (!line) throw new Error('線の入力が無い');
    expect(v.total?.distanceFixed).toBeNull();
    expect(line.scenario.days).toBe(0);
    expect(line.scenario.dX).toBe(0);
    const both = indicator(run(base0(), putSell, callSell), capital);
    const levels = marginLine(line.base, line.scenario, line.params, line.capital, line.holidays);
    const expected = marginLine(
      both.base,
      nowOf(initialState.scenario),
      PARAMS,
      capital,
      initialState.calendar.holidays,
    );
    expect(levels).toEqual(expected);
    expect(levels.length).toBeGreaterThan(0);
    const x0 = v.total?.x0 ?? 0;
    const parts = distanceParts(x0, levels);
    const pct = (l: number) => {
      const p = (Math.round(((l - x0) / x0) * 1000) / 10).toFixed(1);
      return p.startsWith('-') ? `−${p.slice(1)}` : `+${p}`;
    };
    const below = levels.filter((l) => l <= x0);
    const above = levels.filter((l) => l > x0);
    const lo = Math.max(...below);
    expect(below.length).toBeGreaterThan(0);
    expect(parts[0]).toBe(`下 ${pct(lo)}%（${lo.toLocaleString('en-US')} 円）`);
    if (above.length === 0) expect(parts[1]).toBe('上 なし');
    else {
      const hi = Math.min(...above);
      expect(parts[1]).toBe(`上 ${pct(hi)}%（${hi.toLocaleString('en-US')} 円）`);
    }
  });

  it('今すでに余力 < 0 なら「今 追証の側」（警告）、資金が無ければ「資金は ⋯ > 設定…」', () => {
    const neg = holdingsModel(input(twoHeld(), EMPTY, 1000));
    expect(neg.total?.roomWarn).toBe(true);
    expect(neg.total?.distanceFixed).toBe(DISTANCE_CALL_NOW);
    expect(neg.total?.line).toBeNull();
    const none = holdingsModel(input(twoHeld(), EMPTY, null));
    expect(none.total?.roomText).toBe(ROOM_NO_CAPITAL_TEXT);
    expect(none.total?.distanceFixed).toBe(ROOM_NO_CAPITAL_TEXT);
  });
});

describe('金額の単位（レビュー指摘 3）', () => {
  it('自動の単位は合計の余力・評価損益も見る（資金が大きいと千円）', () => {
    // 遠い OTM の put の買い 1 枚（必要証拠金・評価損益が小さい。値は合成の板の架空の値）
    const farBuy: Action = {
      type: 'addBoardLeg',
      expiry: '2026-11',
      k: 50000,
      optionType: 'put',
      side: 'buy',
    };
    const s = run(base0(), farBuy, hold);
    expect(s.legs).toHaveLength(1);
    const auto = (capital: number | null) =>
      holdingsModel({ ...input(s, EMPTY, capital), unitSetting: 'auto' });
    const small = auto(null);
    const maxRow = Math.max(
      Math.abs(small.rows[0]?.values.mark ?? 0),
      Math.abs(small.rows[0]?.values.margin ?? 0),
    );
    // 行の値だけなら円になる組で、資金 5 億円（余力が 10 万円以上）なら千円
    if (maxRow >= 100_000) throw new Error('行の値が大きすぎる（例にならない）');
    expect(small.unit).toBe('yen');
    const big = auto(500_000_000);
    expect(Math.abs(big.total?.values.room ?? 0)).toBeGreaterThanOrEqual(100_000);
    expect(big.unit).toBe('thousand');
  });
});

describe('欠けたとき（AC6）', () => {
  it('板が無い: 値は「—（板を読むと出る）」、名前・本数は出る', () => {
    const s = twoHeld();
    const v = holdingsModel({ ...input(s, EMPTY, 1_000_000), chain: null });
    expect(v.boardText).toBeNull();
    expect(v.rows.map((r) => [r.name, r.legs])).toEqual([
      ['A', '足 1 本'],
      ['B', '足 1 本'],
    ]);
    for (const r of v.rows) {
      expect([r.markText, r.marginText, r.deltaText]).toEqual([
        NO_BOARD_VALUE,
        NO_BOARD_VALUE,
        NO_BOARD_VALUE,
      ]);
    }
    expect(v.total?.marginText).toBe(NO_BOARD_VALUE);
    expect(v.total?.roomText).toBe(NO_BOARD_VALUE);
    expect(v.total?.distanceFixed).toBe(NO_BOARD_VALUE);
  });

  it('評価できない足がある行: 評価損益「—」+ 注記、合計も「—」、必要証拠金は除いた本数の注記', () => {
    const s = run(base0(), putSell, hold);
    const src = entryOf(run(base0(), callSell, putBuy, hold), '板に無い限月', 'e');
    const e = structuredClone(src);
    const first = e.ws.position.legs[0];
    if (first?.leg.kind !== 'option') throw new Error('OP の足が無い');
    first.leg = { ...first.leg, expiry: '2027-01' };
    const v = holdingsModel(input(s, readOf(e)));
    const row = v.rows[1];
    expect(row?.markText).toBe('—');
    expect(row?.markNote).toBe('今の板で値の無い足 1 本');
    expect(row?.note).toBe('一部の足を除く（1 本）');
    expect(tagTexts(row?.tags ?? [])).toContain('板に無い足 1');
    expect(v.total?.markText).toBe('—');
  });

  it('足 0 本の保有のタブ: 「足が無い」、合計に入らない', () => {
    const s = run(base0(), putSell, hold, { type: 'removeLeg', id: 1 }, newTab, callSell, hold);
    const v = holdingsModel(input(s));
    expect(v.rows[0]?.counted).toBe(false);
    expect(tagTexts(v.rows[0]?.tags ?? [])).toContain('足が無い');
    expect(v.total?.count).toBe(1);
  });
});

describe('シナリオに依らない（AC7）', () => {
  it('d・ΔX・Δσ・Δs だけが違う state で出力が同じ', () => {
    const s = twoHeld();
    const moved = run(s, {
      type: 'setScenario',
      patch: { days: 10, dX: -2500, dSigma: 6, skew: 1.5 },
    });
    // 線の入力（base は板の関数を持つ）は値で比べず、それ以外の表示モデルを比べる
    const strip = (v: ReturnType<typeof holdingsModel>) => ({
      ...v,
      total: v.total ? { ...v.total, line: v.total.line !== null } : null,
    });
    const a = holdingsModel(input(moved, EMPTY, 4_000_000));
    const b = holdingsModel(input(s, EMPTY, 4_000_000));
    expect(strip(a)).toEqual(strip(b));
    expect(a.total?.line?.scenario).toEqual(b.total?.line?.scenario);
    expect(a.total?.line?.base.legs.length).toBe(b.total?.line?.base.legs.length);
  });
});

describe('行の操作（AC8）', () => {
  it('タブの行は switchTab（作業中は押せない）、保存一覧だけの行は新しいタブで開く', () => {
    const s = twoHeld();
    const e = entryOf(run(base0(), putBuy, hold), '別', 'e');
    const v = holdingsModel(input(s, readOf(e)));
    expect(v.rows.map((r) => r.action)).toEqual([
      { kind: 'switchTab', tabId: 1 },
      null,
      { kind: 'openNewTab', entryId: 'e', disabled: null },
    ]);
  });

  it('タブが 6 個なら押せず理由「タブは 6 個まで」', () => {
    const s = run(twoHeld(), newTab, newTab, newTab, newTab);
    expect(s.tabs).toHaveLength(6);
    const e = entryOf(run(base0(), putBuy, hold), '別', 'e');
    const v = holdingsModel(input(s, readOf(e)));
    expect(v.rows[2]?.action).toEqual({
      kind: 'openNewTab',
      entryId: 'e',
      disabled: TABS_FULL_TEXT,
    });
  });
});

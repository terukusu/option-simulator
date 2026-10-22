import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type OptionType, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import type { Domain } from '../../ui/chart/scale';
import { persistKey, serializeWorkspace, toSaved } from '../../ui/persist';
import {
  addPin,
  MAX_PINS,
  nextPinNo,
  PIN_MAX_SAMPLES,
  PIN_ZOOM_MAX_SAMPLES,
  PINS_FULL_TEXT,
  type Pin,
  type PinSource,
  pinAddError,
} from '../../ui/pins';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { fmtAmount } from '../../ui/view/metrics';
import {
  cachedPinLines,
  ghostSource,
  overlayBase,
  overlayBases,
  type PinMenuInput,
  type PinTarget,
  pinLabels,
  pinLineData,
  pinLineFn,
  pinListModel,
  pinMenuRows,
  pinPopRows,
  pinSampleCap,
  pinSampleXs,
  resolvePins,
} from '../../ui/view/pins';
import {
  DEFAULT_PNL_Y,
  type PnlBase,
  pnlChartModel,
  pnlDomains,
  pnlViewDomain,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';

/** #22 ピン留め（AC1〜AC7・AC9）。合成の板（架空の値）。 */
const latest = normalizeChain(fixture('latest'));
const other = normalizeChain(fixture('night_early'));
const m0 = latest.months[0];
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

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

function loaded(chain: Chain = latest): State {
  return reduce(initialState, { type: 'loaded', chain, label: 'latest' });
}

/** 画面（App）と同じ道で今の基礎を作る */
function baseOf(s: State): PnlBase | null {
  if (!s.chain) return null;
  const settings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot, futureBasis: s.futureBasis };
  const pm = positionModel(s.chain, s.legs, s.atmBasis, s.calendar, settings);
  return pnlDomains(s.chain, pm.prepared, pm.ctx, settings);
}

/** App の [今の線を残す] と同じ */
function pinGhost(s: State): State {
  const src = ghostSource(
    baseOf(s),
    s.scenario,
    s.tabs.find((t) => t.id === s.activeTab)?.name ?? '',
    s.chain?.snapshotAt ?? null,
  );
  if (!src) throw new Error('ゴーストを作れない');
  return reduce(s, { type: 'addPin', source: src });
}

function targetsOf(s: State): PinTarget[] {
  const settings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot, futureBasis: s.futureBasis };
  const overlays = overlayBases(s.pins, {
    chain: s.chain,
    tabs: s.tabs,
    activeTab: s.activeTab,
    atmBasis: s.atmBasis,
    calendar: s.calendar,
    settings,
  });
  return resolvePins(s.pins, {
    tabs: s.tabs,
    activeTab: s.activeTab,
    scenario: s.scenario,
    overlays,
  });
}

/** タブ A に足 2 本（売 P・売 C） */
function withA(): State {
  return run(loaded(), board(-2, 'put', 'sell'), board(2, 'call', 'sell'));
}

/** 不変条件: 本数 ≤ 3・番号の重複なし・番号は 1〜3・重ねのタブが存在し、同じタブの重ねは 1 本まで */
function invariant(s: State): void {
  expect(s.pins.length).toBeLessThanOrEqual(MAX_PINS);
  const nos = s.pins.map((p) => p.no);
  expect(new Set(nos).size).toBe(nos.length);
  for (const n of nos) expect([1, 2, 3]).toContain(n);
  const tabPins = s.pins.filter((p): p is Extract<Pin, { kind: 'tab' }> => p.kind === 'tab');
  for (const p of tabPins) expect(s.tabs.some((t) => t.id === p.tabId)).toBe(true);
  expect(new Set(tabPins.map((p) => p.tabId)).size).toBe(tabPins.length);
}

const DOMAIN_W = 1000;

describe('ピンの状態（#22 AC2）', () => {
  it('初期状態はピン 0 本・線は期中', () => {
    expect(initialState.pins).toEqual([]);
    expect(initialState.pinLine).toBe('period');
  });

  it('最大 3 本: 4 本目は無視し、理由の文言が出る。外すと空いた番号を使い、他の番号は動かない', () => {
    let s = withA();
    for (let i = 0; i < 4; i++) s = pinGhost(s);
    invariant(s);
    expect(s.pins.map((p) => p.no)).toEqual([1, 2, 3]);
    expect(pinAddError(s.pins)).toBe(PINS_FULL_TEXT);
    const full = s;
    expect(pinGhost(full)).toBe(full);

    s = reduce(s, { type: 'removePin', no: 2 });
    expect(s.pins.map((p) => p.no)).toEqual([1, 3]);
    expect(pinAddError(s.pins)).toBeNull();
    expect(nextPinNo(s.pins)).toBe(2);
    s = pinGhost(s);
    expect(s.pins.map((p) => p.no)).toEqual([1, 3, 2]);
    invariant(s);
    // 無い番号を外しても同じ state
    expect(reduce(s, { type: 'removePin', no: 9 })).toBe(s);
    s = reduce(s, { type: 'clearPins' });
    expect(s.pins).toEqual([]);
    expect(reduce(s, { type: 'clearPins' })).toBe(s);
  });

  it('重ね: 作業中のタブ・無いタブ・同じタブの 2 本目・足の無い保存は足さない', () => {
    const s = run(withA(), { type: 'addTab', mode: 'copy' }); // A(1), B(2) 作業中
    expect(reduce(s, { type: 'addPin', source: { kind: 'tab', tabId: 2 } })).toBe(s);
    expect(reduce(s, { type: 'addPin', source: { kind: 'tab', tabId: 9 } })).toBe(s);
    const one = reduce(s, { type: 'addPin', source: { kind: 'tab', tabId: 1 } });
    expect(one.pins).toHaveLength(1);
    expect(reduce(one, { type: 'addPin', source: { kind: 'tab', tabId: 1 } })).toBe(one);
    expect(reduce(one, { type: 'addPin', source: { kind: 'saved', name: 'x', legs: [] } })).toBe(
      one,
    );
    invariant(one);
  });

  it('タブを閉じたら、そのタブの重ねが外れる（ゴースト・他の重ねは残る）', () => {
    let s = run(withA(), { type: 'addTab', mode: 'copy' }, { type: 'addTab', mode: 'copy' });
    // A(1) B(2) C(3)、作業中 C
    s = run(
      s,
      { type: 'addPin', source: { kind: 'tab', tabId: 1 } },
      { type: 'addPin', source: { kind: 'tab', tabId: 2 } },
    );
    s = pinGhost(s);
    expect(s.pins.map((p) => p.kind)).toEqual(['tab', 'tab', 'ghost']);
    s = reduce(s, { type: 'closeTab', id: 2 });
    invariant(s);
    expect(s.pins.map((p) => p.no)).toEqual([1, 3]);
    // 作業中のタブを閉じても同じ（隣へ切り替えてから外す）
    s = reduce(s, { type: 'closeTab', id: 3 });
    invariant(s);
    expect(s.pins.map((p) => p.kind)).toEqual(['tab', 'ghost']);
  });

  it('線の切替: 期中 / 満期だけ受ける', () => {
    const s = reduce(initialState, { type: 'setPinLine', line: 'expiry' });
    expect(s.pinLine).toBe('expiry');
    expect(reduce(s, { type: 'setPinLine', line: 'expiry' })).toBe(s);
    expect(reduce(s, { type: 'setPinLine', line: 'x' as 'expiry' })).toBe(s);
  });

  it('addPin の純関数は上限で同じ配列を返す', () => {
    const src: PinSource = { kind: 'tab', tabId: 1 };
    const pins: Pin[] = [
      { kind: 'tab', tabId: 2, no: 1 },
      { kind: 'tab', tabId: 3, no: 2 },
      { kind: 'tab', tabId: 4, no: 3 },
    ];
    expect(addPin(pins, src, [1, 2, 3, 4, 5], 5)).toBe(pins);
  });
});

describe('ゴースト（固定。#22 AC1・AC7）', () => {
  it('足・売買・シナリオ・板の読み直し・タブの切り替えのあとも同じ X で同じ値（指標も不変）', () => {
    let s = run(withA(), { type: 'setScenario', patch: { days: 5, dSigma: 2 } });
    s = pinGhost(s);
    const before = targetsOf(s);
    expect(before[0]?.period).toBe('date');
    const domain = pnlViewDomain(baseOf(s) as PnlBase, null);
    const ref = before[0] ? pinLineData(before[0], domain, DOMAIN_W, 'period') : null;
    const refExpiry = before[0] ? pinLineData(before[0], domain, DOMAIN_W, 'expiry') : null;
    const list0 = pinListModel({ targets: before, mode: 'period', scenarioX: 30000, unit: 'yen' });
    expect(ref?.ys.every(Number.isFinite)).toBe(true);

    s = run(
      s,
      board(0, 'put', 'buy'),
      { type: 'removeLeg', id: 1 },
      { type: 'editLeg', id: 2, patch: { side: 'buy', qty: 3 } },
      { type: 'setScenario', patch: { days: 10, dSigma: -5, skew: 1, beta: 3 } },
      { type: 'setFee', fee: 50 },
      { type: 'setFutureBasis', basis: 'decay' },
      { type: 'loaded', chain: other, label: 'night' },
      { type: 'addTab', mode: 'empty' },
    );
    const after = targetsOf(s);
    expect(after[0]?.kind).toBe('ghost');
    const got = after[0] ? pinLineData(after[0], domain, DOMAIN_W, 'period') : null;
    expect(got?.ys).toEqual(ref?.ys);
    expect(after[0] ? pinLineData(after[0], domain, DOMAIN_W, 'expiry')?.ys : null).toEqual(
      refExpiry?.ys,
    );
    const list1 = pinListModel({ targets: after, mode: 'period', scenarioX: 30000, unit: 'yen' });
    expect(list1[0]?.maxLossText).toBe(list0[0]?.maxLossText);
    expect(list1[0]?.premiumText).toBe(list0[0]?.premiumText);
    expect(list1[0]?.atScenarioText).toBe(list0[0]?.atScenarioText);
    expect(list1[0]?.kindLabel).toBe('固定');
    expect(list1[0]?.name).toBe('A');
    expect(list1[0]?.cond).toContain('d 5 日');
    expect(list1[0]?.cond).toContain('Δσ +2.0pt');
    expect(list1[0]?.cond).toContain('期中 = 指定日');
  });

  it('シナリオが 0 のときのゴーストの期中は今日の線', () => {
    const s = pinGhost(withA());
    const t = targetsOf(s)[0];
    expect(t?.period).toBe('today');
    expect(
      pinListModel({ targets: targetsOf(s), mode: 'period', scenarioX: 1, unit: 'yen' })[0]?.cond,
    ).toContain('期中 = 今日');
  });

  it('足が無ければゴーストを作れない', () => {
    expect(ghostSource(null, ZERO_SCENARIO, 'A', null)).toBeNull();
  });
});

describe('重ね（追随。#22 AC3・AC4・AC7）', () => {
  /** A（作業中）に足 2 本、B に別の足 1 本。A に戻して B を重ね、ゴーストも 1 本 */
  function setup(): State {
    let s = run(withA(), { type: 'addTab', mode: 'empty' }, board(0, 'put', 'buy'));
    s = reduce(s, { type: 'switchTab', id: 1 });
    s = pinGhost(run(s, { type: 'setScenario', patch: { days: 3 } }));
    return reduce(s, { type: 'addPin', source: { kind: 'tab', tabId: 2 } });
  }

  it('タブの重ねは今のシナリオで描き直す（スライダーで動く）、ゴーストは動かない', () => {
    const s = setup();
    const domain = pnlViewDomain(baseOf(s) as PnlBase, null);
    const t0 = targetsOf(s);
    expect(t0.map((t) => t.kind)).toEqual(['ghost', 'tab']);
    const moved = reduce(s, { type: 'setScenario', patch: { dSigma: 5 } });
    const t1 = targetsOf(moved);
    const ys = (ts: PinTarget[], i: number) =>
      ts[i] ? pinLineData(ts[i] as PinTarget, domain, DOMAIN_W, 'period')?.ys : null;
    expect(ys(t1, 0)).toEqual(ys(t0, 0));
    expect(ys(t1, 1)).not.toEqual(ys(t0, 1));
    // 重ねは今の板で: 板を読み直すと値が変わる（ゴーストは変わらない）
    const reloaded = reduce(s, { type: 'loaded', chain: other, label: 'night' });
    const t2 = targetsOf(reloaded);
    const d2 = pnlViewDomain(baseOf(reloaded) as PnlBase, null);
    expect(t2[0] ? pinLineData(t2[0], domain, DOMAIN_W, 'period')?.ys : null).toEqual(ys(t0, 0));
    expect(t2[1] ? pinLineData(t2[1], d2, DOMAIN_W, 'period') : null).not.toBeNull();
    expect(t2[1]?.base).not.toBe(t0[1]?.base);
  });

  it('重ねたタブに切り替えると「作業中」で線を描かない。閉じるとピンが外れる', () => {
    const s = reduce(setup(), { type: 'switchTab', id: 2 });
    const t = targetsOf(s);
    expect(t[1]?.active).toBe(true);
    expect(t[1] ? pinLineFn(t[1], 'period') : 'x').toBeNull();
    const rows = pinListModel({ targets: t, mode: 'period', scenarioX: 30000, unit: 'yen' });
    expect(rows[1]?.drawn).toBe(false);
    expect(rows[1]?.note).toBe('作業中（線は今の線）');
    // 戻すと描く
    const back = reduce(s, { type: 'switchTab', id: 1 });
    expect(targetsOf(back)[1]?.active).toBe(false);
    const closed = reduce(back, { type: 'closeTab', id: 2 });
    expect(closed.pins.map((p) => p.kind)).toEqual(['ghost']);
  });

  it('保存の重ねは重ねた時点の足の写し: 板に無い足は除いて本数を出す', () => {
    const a = withA();
    const saved = toSaved(a, 0);
    expect(saved.position.legs).toHaveLength(2);
    // 板に無い限月の足を 1 本混ぜる（今の板で評価できない）
    const legs = [
      ...a.legs.map(({ id: _id, ...rest }) => rest),
      ...a.legs.slice(0, 1).map(({ id: _id, ...rest }) => ({
        ...rest,
        leg: { ...rest.leg, expiry: '2031-01' } as typeof rest.leg,
      })),
    ];
    let s = reduce(a, { type: 'addPin', source: { kind: 'saved', name: '案 1', legs } });
    // 作業中の足を変えても保存の重ねの足は変わらない
    s = run(s, { type: 'clearLegs' }, board(1, 'call', 'buy'));
    const pin = s.pins[0];
    expect(pin?.kind === 'saved' ? pin.legs : null).toBe(legs);
    const t = targetsOf(s);
    expect(t[0]?.legCount).toBe(3);
    expect(t[0]?.excluded).toBe(1);
    const rows = pinListModel({ targets: t, mode: 'period', scenarioX: 30000, unit: 'yen' });
    expect(rows[0]?.note).toBe('一部の足を除く（1 本）');
    expect(rows[0]?.kindLabel).toBe('保存');
    expect(rows[0]?.name).toBe('案 1');
    expect(rows[0]?.cond).toContain('今の設定');
  });

  it('重ねの基礎は今の評価の設定（手数料）を使う', () => {
    const a = withA();
    const legs = a.legs.map(({ id: _id, ...rest }) => rest);
    const b0 = overlayBase(latest, legs, 'B', CALENDAR, DEFAULT_SETTINGS);
    const b1 = overlayBase(latest, legs, 'B', CALENDAR, { ...DEFAULT_SETTINGS, feePerLot: 100 });
    expect(b0.base?.settings.feePerLot).toBe(0);
    expect(b1.base?.settings.feePerLot).toBe(100);
    expect(overlayBase(latest, [], 'B', CALENDAR, DEFAULT_SETTINGS)).toEqual({
      base: null,
      legCount: 0,
      excluded: 0,
    });
  });

  it('シナリオ点での損益 = 線の関数の値（指標の単位）', () => {
    const s = setup();
    const t = targetsOf(s);
    const fn = t[1] ? pinLineFn(t[1], 'period') : null;
    const x = (baseOf(s)?.ctx.x0 ?? 0) - 500;
    const rows = pinListModel({ targets: t, mode: 'period', scenarioX: x, unit: 'yen' });
    expect(fn).not.toBeNull();
    const v = fn ? fn(x) : Number.NaN;
    expect(rows[1]?.atScenarioText).toBe(fmtAmount(v, 'yen', true));
    // 満期に切り替えると満期の値
    const rowsE = pinListModel({ targets: t, mode: 'expiry', scenarioX: x, unit: 'yen' });
    const fe = t[1] ? pinLineFn(t[1], 'expiry') : null;
    expect(rowsE[1]?.atScenarioText).not.toBe(rows[1]?.atScenarioText);
    expect(fe ? fe(x) : null).toBe(t[1]?.base?.expiry(x));
  });
});

describe('線・縦軸・ラベル（#22 AC5・AC6・AC8）', () => {
  const s = pinGhost(run(withA(), { type: 'setScenario', patch: { days: 5 } }));
  const base = baseOf(s) as PnlBase;
  const targets = targetsOf(s);
  const t = targets[0] as PinTarget;

  it('期中の線は 4px ごと・最大 PIN_MAX_SAMPLES 点 + 端、両端を含み昇順。格子は横軸の絶対値に固定', () => {
    const d: Domain = [20003, 30003];
    const wide = pinSampleXs(d, 1000).xs;
    expect(wide.length).toBeLessThanOrEqual(PIN_MAX_SAMPLES + 1);
    expect(wide.length).toBeGreaterThanOrEqual(PIN_MAX_SAMPLES - 1);
    const { xs, step } = pinSampleXs(d, 400);
    expect(xs.length).toBeGreaterThanOrEqual(100);
    expect(xs.length).toBeLessThanOrEqual(102);
    expect(xs[0]).toBe(20003);
    expect(xs[xs.length - 1]).toBe(30003);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i] as number).toBeGreaterThan(xs[i - 1] as number);
    // 内側の点は step の整数倍（パンしても同じ点）
    for (const x of xs.slice(1, -1))
      expect(Math.abs(x / step - Math.round(x / step))).toBeLessThan(1e-9);
    expect(pinSampleXs(d, 1).xs.length).toBeGreaterThanOrEqual(2);
  });

  it('パン（幅が同じ）では重なる点の値を使い回し、使い回さない場合と同じ値', () => {
    const d0 = pnlViewDomain(base, null);
    const w = d0[1] - d0[0];
    const first = pinLineData(t, d0, 600, 'period');
    const d1: Domain = [d0[0] + w * 0.1, d0[1] + w * 0.1];
    const reused = pinLineData(t, d1, 600, 'period', first);
    const fresh = pinLineData(t, d1, 600, 'period');
    expect(reused?.xs).toEqual(fresh?.xs);
    expect(reused?.ys).toEqual(fresh?.ys);
    expect(reused?.grid?.step).toBe(first?.grid?.step);
  });

  it('表示範囲を初期範囲の外へパンしても全域で描く（満期は範囲内の折れ点を頂点に持つ）', () => {
    const w = base.full[1] - base.full[0];
    const far: Domain = [base.full[0], base.full[0] + w * 0.2];
    const data = pinLineData(t, far, 600, 'period');
    expect(data?.xs[0]).toBe(far[0]);
    expect(data?.xs[data.xs.length - 1]).toBe(far[1]);
    expect(data?.ys.every(Number.isFinite)).toBe(true);
    const ex = pinLineData(t, base.initial, 600, 'expiry');
    for (const kk of base.profile.kinks) {
      if (kk > base.initial[0] && kk < base.initial[1]) expect(ex?.xs).toContain(kk);
    }
  });

  it('縦軸が自動のときピンの線の範囲も入る。手動・プレミアム基準は変えない', () => {
    // 今の線より大きく下に出るピン（値を 10 倍にした線）
    const data = pinLineData(t, pnlViewDomain(base, null), 1000, 'period');
    if (!data) throw new Error('線が無い');
    const low = { ...data, ys: data.ys.map((y) => y * 10 - 1_000_000) };
    const input = {
      base,
      scenario: s.scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 200,
    };
    const without = pnlChartModel(input);
    const withPin = pnlChartModel({ ...input, pins: [low] });
    expect(withPin.yDomain[0]).toBeLessThanOrEqual(Math.min(...low.ys));
    expect(without.yDomain[0]).toBeGreaterThan(Math.min(...low.ys));
    expect(withPin.pins).toHaveLength(1);
    expect(withPin.pins[0]?.d.startsWith('M')).toBe(true);
    const manual = { mode: 'manual' as const, manual: [-1000, 1000] as Domain, n: 5 };
    expect(pnlChartModel({ ...input, pnlY: manual, pins: [low] }).yDomain).toEqual([-1000, 1000]);
    const prem = { mode: 'premium' as const, manual: null, n: 5 };
    expect(pnlChartModel({ ...input, pnlY: prem, pins: [low] }).yDomain).toEqual(
      pnlChartModel({ ...input, pnlY: prem }).yDomain,
    );
  });

  it('番号ラベルは右端。縦軸の範囲外なら ↑ / ↓ を付けて端に寄せ、重ならない', () => {
    const data = pinLineData(t, pnlViewDomain(base, null), 1000, 'period');
    if (!data) throw new Error('線が無い');
    const manual = { mode: 'manual' as const, manual: [-1e9, 1e9] as Domain, n: 5 };
    const chart = pnlChartModel({
      base,
      scenario: s.scenario,
      viewport: null,
      pnlY: manual,
      plotWidth: 1000,
      plotHeight: 200,
      pins: [
        { ...data, no: 1 },
        { ...data, no: 2, ys: data.ys.map(() => 2e9) },
        { ...data, no: 3, ys: data.ys.map(() => -2e9) },
      ],
    });
    const labels = pinLabels(chart);
    expect(labels.map((l) => l.text)).toEqual(['①', '↑②', '↓③']);
    expect(labels.map((l) => l.edge)).toEqual([null, 'top', 'bottom']);
    const right = chart.plot.left + chart.plot.width;
    for (const l of labels) {
      expect(l.x).toBeLessThanOrEqual(right);
      expect(l.y).toBeGreaterThanOrEqual(chart.plot.top);
      expect(l.y).toBeLessThanOrEqual(chart.plot.top + chart.plot.height);
    }
    const ys = labels.map((l) => l.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++)
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(12.9);
  });

  it('前回分の使い回し: ゴーストはシナリオで作り直さず、重ねは ΔX 以外で作り直す', () => {
    let st = run(s, { type: 'addTab', mode: 'copy' }, { type: 'switchTab', id: 1 });
    st = reduce(st, { type: 'addPin', source: { kind: 'tab', tabId: 2 } });
    const dom = pnlViewDomain(base, null);
    // App と同じく重ねの基礎は板・足・設定が変わったときだけ作る（ここでは 1 回）
    const overlays = overlayBases(st.pins, {
      chain: st.chain,
      tabs: st.tabs,
      activeTab: st.activeTab,
      atmBasis: st.atmBasis,
      calendar: st.calendar,
      settings: DEFAULT_SETTINGS,
    });
    const at = (patch: Partial<State['scenario']>) =>
      resolvePins(st.pins, {
        tabs: st.tabs,
        activeTab: st.activeTab,
        scenario: { ...st.scenario, ...patch },
        overlays,
      });
    const c0 = cachedPinLines(new Map(), at({}), dom, 1000, 'period');
    // ΔX だけ: 全部使い回す
    const c1 = cachedPinLines(c0, at({ dX: -300 }), dom, 1000, 'period');
    expect(c1.get(1)).toBe(c0.get(1));
    expect(c1.get(2)).toBe(c0.get(2));
    // Δσ: ゴーストは使い回し、重ねは作り直す
    const c2 = cachedPinLines(c1, at({ dSigma: 3 }), dom, 1000, 'period');
    expect(c2.get(1)).toBe(c0.get(1));
    expect(c2.get(2)).not.toBe(c0.get(2));
    // 表示範囲: 全部作り直す
    const c3 = cachedPinLines(c2, at({}), [dom[0] + 100, dom[1] + 100], 1000, 'period');
    expect(c3.get(1)).not.toBe(c2.get(1));
    expect(cachedPinLines(c3, targetsOf(st), null, 1000, 'period').size).toBe(0);
  });
});

describe('拡大縮小のフレーム（#22 S1: 点数を下げ、止まったら通常の点数で描き直す）', () => {
  it('pinSampleCap: 幅が変わるフレームだけ下げる（初回・パン・丸めの差・止まった後は通常）', () => {
    const d: Domain = [20000, 30000];
    expect(pinSampleCap(null, d)).toBe(PIN_MAX_SAMPLES);
    expect(pinSampleCap(10000, null)).toBe(PIN_MAX_SAMPLES);
    expect(pinSampleCap(10000, [20500, 30500])).toBe(PIN_MAX_SAMPLES);
    expect(pinSampleCap(10000 * (1 + 1e-13), d)).toBe(PIN_MAX_SAMPLES);
    expect(pinSampleCap(11000, d)).toBe(PIN_ZOOM_MAX_SAMPLES);
    expect(pinSampleCap(9000, d)).toBe(PIN_ZOOM_MAX_SAMPLES);
    expect(PIN_ZOOM_MAX_SAMPLES).toBeLessThan(PIN_MAX_SAMPLES);
  });

  it('止まった後の線はピンした時点の値と同じ（拡大縮小の途中の粗い線を残さない）。満期は折れ点を頂点に持つ', () => {
    let s = run(withA(), { type: 'setScenario', patch: { days: 5, dSigma: 2 } });
    s = pinGhost(s);
    const base = baseOf(s) as PnlBase;
    const d0 = pnlViewDomain(base, null);
    const w = d0[1] - d0[0];
    // 拡大の 3 フレーム（中心を保って幅を 0.9 倍ずつ）の最後の表示範囲
    const frames: Domain[] = [1, 2, 3].map((i) => {
      const c = (d0[0] + d0[1]) / 2;
      const hw = (w * 0.9 ** i) / 2;
      return [c - hw, c + hw];
    });
    const last = frames[frames.length - 1] as Domain;
    // ピンした時点の値（通常の点数）
    const pinned = targetsOf(s)[0] as PinTarget;
    const ref = pinLineData(pinned, last, DOMAIN_W, 'period');
    const refExpiry = pinLineData(pinned, last, DOMAIN_W, 'expiry');
    // ピンの後に足・シナリオ・設定を変える（ゴーストは変わらない）
    s = run(
      s,
      { type: 'removeLeg', id: 1 },
      { type: 'setScenario', patch: { days: 10, dSigma: -5, skew: 1 } },
      { type: 'setFee', fee: 50 },
    );
    const ts = targetsOf(s);
    for (const mode of ['period', 'expiry'] as const) {
      // 画面（PnlChart）と同じ道: 前回の幅と違えば点数を下げ、止まったら同じ幅で通常の点数
      let span: number | null = d0[1] - d0[0];
      let c = cachedPinLines(new Map(), ts, d0, DOMAIN_W, mode, pinSampleCap(null, d0));
      for (const f of frames) {
        const cap = pinSampleCap(span, f);
        expect(cap).toBe(PIN_ZOOM_MAX_SAMPLES);
        c = cachedPinLines(c, ts, f, DOMAIN_W, mode, cap);
        span = f[1] - f[0];
        const data = c.get(1)?.data;
        expect(data?.xs[0]).toBe(f[0]);
        expect(data?.xs[(data?.xs.length ?? 1) - 1]).toBe(f[1]);
        if (mode === 'period')
          expect(data?.xs.length).toBeLessThanOrEqual(PIN_ZOOM_MAX_SAMPLES + 1);
      }
      const coarse = c.get(1);
      // 止まった後（同じ表示範囲）: 通常の点数で作り直す
      const cap = pinSampleCap(span, last);
      expect(cap).toBe(PIN_MAX_SAMPLES);
      const settled = cachedPinLines(c, ts, last, DOMAIN_W, mode, cap);
      const want = mode === 'period' ? ref : refExpiry;
      if (mode === 'period') expect(settled.get(1)).not.toBe(coarse);
      expect(settled.get(1)?.data?.xs).toEqual(want?.xs);
      expect(settled.get(1)?.data?.ys).toEqual(want?.ys);
      // さらに止まったまま描き直しても使い回す
      expect(cachedPinLines(settled, ts, last, DOMAIN_W, mode, cap).get(1)).toBe(settled.get(1));
    }
    // 満期: 範囲内の折れ点（行使価格）が拡大縮小の途中でも頂点に入る
    const kinks = base.profile.kinks.filter((x) => x > last[0] && x < last[1]);
    expect(kinks.length).toBeGreaterThan(0);
    const coarseExpiry = cachedPinLines(
      new Map(),
      ts,
      last,
      DOMAIN_W,
      'expiry',
      PIN_ZOOM_MAX_SAMPLES,
    ).get(1)?.data;
    for (const x of kinks) expect(coarseExpiry?.xs).toContain(x);
    // 期中の粗い線の点もピンした時点の線の上（同じ関数の値）
    const coarsePeriod = pinLineData(
      ts[0] as PinTarget,
      last,
      DOMAIN_W,
      'period',
      null,
      PIN_ZOOM_MAX_SAMPLES,
    );
    const fn = pinLineFn(pinned, 'period');
    coarsePeriod?.xs.forEach((x, i) => {
      expect(coarsePeriod.ys[i]).toBe(fn?.(x));
    });
  });
});

describe('ピンは保存しない（#22 AC9）', () => {
  it('作業の保存・保存一覧の文書にピンが入らず、persistKey もピンで変わらない', () => {
    const a = run(withA(), { type: 'addTab', mode: 'copy' }, { type: 'switchTab', id: 1 });
    const s = run(
      pinGhost(a),
      { type: 'addPin', source: { kind: 'tab', tabId: 2 } },
      {
        type: 'setPinLine',
        line: 'expiry',
      },
    );
    expect(s.pins).toHaveLength(2);
    expect(serializeWorkspace(s, 0)).toBe(serializeWorkspace(a, 0));
    expect(JSON.stringify(toSaved(s, 0))).toBe(JSON.stringify(toSaved(a, 0)));
    expect(persistKey(s)).toBe(persistKey(a));
    expect(serializeWorkspace(s, 0)).not.toContain('pin');
  });
});

describe('pinMenuRows（#89 段 B AC-B4。舞台の [ピン N/3] とコマンドパレットの行）', () => {
  const target = (no: 1 | 2 | 3, name: string): PinTarget => ({
    no,
    kind: 'ghost',
    name,
    base: null,
    scenario: ZERO_SCENARIO,
    period: 'today',
    active: false,
    legCount: 1,
    excluded: 0,
    boardSnapshotAt: null,
  });
  const tabs = [
    { id: 2, name: 'B', legCount: 2, pinned: false },
    { id: 3, name: 'C', legCount: 0, pinned: false },
    { id: 4, name: 'D', legCount: 1, pinned: true },
  ];
  const base: PinMenuInput = { noLegs: false, pins: [], pinLine: 'period', pinTabs: tabs };
  const byKey = (i: PinMenuInput) => new Map(pinMenuRows(i).map((r) => [r.key, r]));

  it('行の並び・ラベル・checked は舞台の ⋯ の今の項目と同じ', () => {
    const rows = pinMenuRows({ ...base, pins: [target(1, '甲'), target(3, '乙')] });
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ['current', '今の線を残す'],
      ['tab2', 'B を重ねる'],
      ['tab3', 'C を重ねる'],
      ['tab4', 'D を重ねる'],
      ['period', 'ピンの線: 期中'],
      ['expiry', 'ピンの線: 満期'],
      ['remove1', '① 甲 を外す'],
      ['remove3', '③ 乙 を外す'],
      ['clear', '全部外す'],
    ]);
    expect(rows.map((r) => r.checked)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      false,
      undefined,
      undefined,
      undefined,
    ]);
    // 外す・ピンの線は disabled を持たない（舞台の ⋯ の DOM を変えない）
    expect(rows.filter((r) => !('disabled' in r)).map((r) => r.key)).toEqual([
      'period',
      'expiry',
      'remove1',
      'remove3',
    ]);
    const exp = pinMenuRows({ ...base, pinLine: 'expiry' });
    expect(exp.find((r) => r.key === 'expiry')?.checked).toBe(true);
  });

  it('実行の記述は今と同じ action（今の線を残すは pinCurrent）', () => {
    const m = byKey({ ...base, pins: [target(2, '甲')] });
    expect(m.get('current')?.run).toEqual({ kind: 'pinCurrent' });
    expect(m.get('tab2')?.run).toEqual({
      kind: 'action',
      action: { type: 'addPin', source: { kind: 'tab', tabId: 2 } },
    });
    expect(m.get('period')?.run).toEqual({
      kind: 'action',
      action: { type: 'setPinLine', line: 'period' },
    });
    expect(m.get('remove2')?.run).toEqual({ kind: 'action', action: { type: 'removePin', no: 2 } });
    expect(m.get('clear')?.run).toEqual({ kind: 'action', action: { type: 'clearPins' } });
  });

  it('足 0 本: 今の線を残すが押せない（重ねるは押せる）', () => {
    const m = byKey({ ...base, noLegs: true });
    expect(m.get('current')?.disabled).toBe(true);
    expect(m.get('tab2')?.disabled).toBe(false);
  });

  it('上限 3 本: 今の線を残す・重ねるが押せない', () => {
    const pins = [target(1, 'a'), target(2, 'b'), target(3, 'c')];
    expect(pins.length).toBe(MAX_PINS);
    const m = byKey({ ...base, pins });
    expect(m.get('current')?.disabled).toBe(true);
    expect(m.get('tab2')?.disabled).toBe(true);
    expect(m.get('clear')?.disabled).toBe(false);
    // 2 本なら押せる
    const two = byKey({ ...base, pins: pins.slice(0, 2) });
    expect(two.get('current')?.disabled).toBe(false);
    expect(two.get('tab2')?.disabled).toBe(false);
  });

  it('重ねたタブ・足 0 本のタブは押せない', () => {
    const m = byKey(base);
    expect(m.get('tab4')?.disabled).toBe(true);
    expect(m.get('tab3')?.disabled).toBe(true);
    expect(m.get('tab2')?.disabled).toBe(false);
  });

  it('ピン 0 本で全部外すが押せない', () => {
    expect(byKey(base).get('clear')?.disabled).toBe(true);
    expect(byKey({ ...base, pins: [target(1, 'a')] }).get('clear')?.disabled).toBe(false);
  });
});

describe('pinPopRows（#125。凡例の ①②③ のポップオーバーの行）', () => {
  /** A（作業中）にゴースト（d 5 日・Δσ +2）、B（足 1 本）の重ね、保存の重ね */
  function setup(): State {
    let s = run(withA(), { type: 'addTab', mode: 'empty' }, board(0, 'put', 'buy'));
    s = reduce(s, { type: 'switchTab', id: 1 });
    s = pinGhost(run(s, { type: 'setScenario', patch: { days: 5, dSigma: 2 } }));
    s = reduce(s, { type: 'addPin', source: { kind: 'tab', tabId: 2 } });
    const legs = s.legs.map(({ id: _id, ...rest }) => rest);
    return reduce(s, { type: 'addPin', source: { kind: 'saved', name: '案 1', legs } });
  }
  const s = setup();
  const targets = targetsOf(s);
  const x = 30000;
  const map = (rows: { k: string; v: string }[] | undefined) =>
    new Map((rows ?? []).map((r) => [r.k, r.v]));

  it('固定: 種類・名前・板の時刻・シナリオ・期中の線・金額（単位付き）の行。金額は pinListModel と同じ', () => {
    const pop = pinPopRows({ targets, mode: 'period', scenarioX: x, unit: 'yen' });
    expect(pop).toHaveLength(3);
    const list = pinListModel({ targets, mode: 'period', scenarioX: x, unit: 'yen' });
    const g = pop[0];
    expect(g?.[0]).toEqual({ k: '① 固定', v: 'A' });
    const m = map(g);
    expect(m.get('板')).toMatch(/時点$/);
    // 1 値 1 行（値の列の幅に収める）
    expect(m.get('d')).toBe('5 日');
    expect(m.get('Δσ')).toBe('+2.0pt');
    expect(m.get('Δs')).toBe('0.0');
    expect(m.get('ピンの線')).toBe('期中（指定日）');
    // 売 P・売 C の最大損失は −∞（無限は単位を付けない）
    expect(list[0]?.maxLossText).toBe('−∞');
    expect(m.get('満期の最大損失')).toBe('−∞');
    // 売 P・売 C = 受取の超過（掛け金の行は無い）
    expect(m.get('受取')).toMatch(/^[\d,]+ 円$/);
    expect(m.has('掛け金')).toBe(false);
    expect(m.get('シナリオ点の損益')).toMatch(/^[+−]?[\d,]+ 円$/);
    expect(m.get('シナリオ点の損益')).toBe(`${list[0]?.atScenarioText} 円`);
    expect(m.has('注記')).toBe(false);
  });

  it('重ね: 足の本数・今の板・今のシナリオ（保存は今の設定も）。満期の線なら「満期」、千円の単位', () => {
    const pop = pinPopRows({ targets, mode: 'expiry', scenarioX: x, unit: 'thousand' });
    const tab = map(pop[1]);
    expect(pop[1]?.[0]).toEqual({ k: '② タブ', v: 'B' });
    expect(tab.get('足')).toBe('1 本');
    expect(tab.get('条件')).toBe('今の板・今のシナリオ');
    expect(tab.get('ピンの線')).toBe('満期');
    // 買 P 1 枚の最大損失は有限（掛け金）= 単位付き
    expect(tab.get('満期の最大損失')).toMatch(/^−[\d,.]+ 千円$/);
    // 買 P 1 枚 = 掛け金（受取の行は無い）
    expect(tab.get('掛け金')).toMatch(/^[\d,.]+ 千円$/);
    expect(tab.has('受取')).toBe(false);
    const saved = map(pop[2]);
    expect(pop[2]?.[0]).toEqual({ k: '③ 保存', v: '案 1' });
    expect(saved.get('足')).toBe('2 本');
    expect(saved.get('条件')).toBe('今の板・今のシナリオ・今の設定');
    expect(map(pop[0]).get('ピンの線')).toBe('満期');
  });

  it('注記があれば最後の行に出し、値が無い金額（—）には単位を付けない', () => {
    // 重ねたタブ B に切り替えると「作業中」で描かない
    const t = targetsOf(reduce(s, { type: 'switchTab', id: 2 }));
    const pop = pinPopRows({ targets: t, mode: 'period', scenarioX: Number.NaN, unit: 'yen' });
    const rows = pop[1] ?? [];
    expect(rows.at(-1)).toEqual({ k: '注記', v: '作業中（線は今の線）' });
    expect(map(rows).get('シナリオ点の損益')).toBe('—');
    expect(map(rows).get('ピンの線')).toBe('期中');
  });
});

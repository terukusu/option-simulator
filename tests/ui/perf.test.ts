import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { DEFAULT_SETTINGS } from '../../model';
import { preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { buildWideChainJson } from '../../scripts/synthBoard';
import { addEntry, type Book, type BookRead, EMPTY_BOOK, serializeBook } from '../../ui/book';
import { CALENDAR } from '../../ui/calendar';
import { refreshLegMarkets } from '../../ui/legMarket';
import {
  readSavedBoard,
  readWorkspace,
  restoreWorkspace,
  serializeBoard,
  serializeWorkspace,
  toSaved,
} from '../../ui/persist';
import type { PinNo } from '../../ui/pins';
import { type Action, initialState, reduce, type State, type UiLeg } from '../../ui/state';
import { atmStrike, boardRows } from '../../ui/view/board';
import { bookListModel } from '../../ui/view/bookList';
import { headerModel } from '../../ui/view/header';
import { hedgeModel } from '../../ui/view/hedge';
import { metricsModel } from '../../ui/view/metrics';
import { metricsPanel } from '../../ui/view/metricsPanel';
import {
  cachedPinLines,
  type PinLineCacheEntry,
  type PinLineData,
  type PinTarget,
  pinLabels,
  pinListModel,
  pinSampleCap,
} from '../../ui/view/pins';
import {
  DEFAULT_PNL_Y,
  dateLine,
  pnlChartModel,
  pnlDomains,
  pnlViewDomain,
  todayLine,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import {
  hedgeSection,
  legDetail,
  legSpreadCosts,
  positionRows,
  scenarioLegsByRow,
} from '../../ui/view/positionsRegion';
import { readoutModel } from '../../ui/view/readout';
import { scenarioMarks } from '../../ui/view/scenarioMarks';
import {
  advSummary,
  betaStepper,
  evalChips,
  presetChips,
  type ScenarioRegionInput,
  scenarioSteppers,
  stepperAction,
} from '../../ui/view/scenarioRegion';
import { smileModel } from '../../ui/view/smile';
import {
  bigReadout,
  legMarkers,
  stageFill,
  stageHandle,
  stageMarkLabels,
} from '../../ui/view/stage';
import { stepBy } from '../../ui/view/stepper';
import { tabsModel } from '../../ui/view/tabs';
import { M1, M2, makeMarket } from '../support/market';
import { BUDGET_MS, expectWithinBudget, RECORD_RUNS, record } from '../support/perf';
import { PERF_LEGS } from '../support/perfPosition';

/**
 * AC-18 の補助（計算部分）: 322 行の板の限月切替で作り直す表示モデル（板の行・スマイル・ヘッダ）の
 * 生成が予算以内。描画（DOM）はブラウザの Performance で手動確認する。
 * このファイルの閾値は `npm test`・CI が 200 ms（桁違いの悪化だけを落とす）、16 ms の判定は `npm run perf`
 * （負荷の低いときに。性能テストの 2 ファイルだけを並列なしで）。計測の手順は tests/support/perf.ts。
 */

describe('性能（AC-18 の計算部分）', () => {
  const chain = normalizeChain(buildWideChainJson());

  function rebuild(): number {
    let acc = 0;
    for (const m of chain.months) {
      acc += boardRows(chain, m).length;
      acc += atmStrike(m, 'A') ?? 0;
      acc += smileModel(m, 'B', 'delta').points.length;
    }
    acc += headerModel(chain, 'B', CALENDAR).months.length;
    return acc;
  }

  it(`2 限月分の表示モデルの生成が ${BUDGET_MS} ms 以内（20 回の最小値）`, () => {
    expectWithinBudget('AC-18 2 限月分の表示モデル', rebuild, { warmup: 10, runs: 20 });
  });
});

/**
 * #11 AC-13（AC8 のグラフの計算部分）: 足 10 本・描画幅 1,000px・d = 5 の損益グラフの表示モデル
 * （3 本の線・縦軸の自動範囲・目盛り・path）の生成が予算以内。ドラッグ・ホイールの 1 フレームで
 * 走るのはこれだけ（板・スマイル・ポジションは memo で作り直さない）。
 */
describe('性能（#11 AC-13: 損益グラフの表示モデル）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario = { ...ZERO_SCENARIO, days: 5 };
  let shift = 0;

  function redraw(): number {
    // パン中を模して表示範囲を毎回少しずらす
    shift = (shift + 37) % 1000;
    const lo = (base?.initial[0] ?? 0) + shift;
    const m = pnlChartModel({
      base,
      scenario,
      viewport: [lo, lo + 20_000],
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
    });
    return m.lines.length + m.yTicks.length + m.xTicks.length + (m.lines[1]?.d.length ?? 0);
  }

  it(`表示モデルの生成が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(redraw()).toBeGreaterThan(3);
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
    });
    expect(m.lines.map((l) => l.xs.length)).toEqual([m.lines[0]?.xs.length, 1000, 1000]);
    expectWithinBudget('#11 損益グラフの表示モデル', redraw, { warmup: 20, runs: 30 });
  });
});

/**
 * #6 AC-11（AC8 の計算部分）: 足 10 本・描画幅 1,000px で、スライダー 1 回の描き直しに要る計算
 * （損益グラフの表示モデル + 指標 + テール表）が予算以内。今日の線はスライダーで変わらないので部品が memo した
 * 前計算（todayLine）を渡す。表示範囲・β・動き方を変えたとき（今日の線も作り直す）は上の #11 のテスト
 * （3 本の線をすべて作る）と同じ量。
 */
describe('性能（#6 AC-11: スライダー 1 回の描き直し）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario0 = { ...ZERO_SCENARIO, days: 5 };
  const today = todayLine(base, null, 1000, scenario0);
  let tick = 0;

  function slide(): number {
    // ドラッグ中を模して d・ΔX・Δσ・Δs を毎回少しずつ動かす
    tick = (tick + 1) % 40;
    const scenario = {
      ...scenario0,
      days: 5 + tick * 0.5,
      dX: -tick * 100,
      dSigma: tick * 0.5,
      skew: (tick % 10) * 0.5,
    };
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    return (
      m.lines.length + (m.lines[1]?.d.length ?? 0) + mm.tail.rows.length + mm.dateBreakevens.length
    );
  }

  it(`グラフの表示モデル + 指標 + テール表が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(slide()).toBeGreaterThan(8);
    expectWithinBudget('#6 スライダー 1 回の描き直し', slide, { warmup: 20, runs: 30 });
  });
});

/**
 * #52 AC-10: 長押しドラッグの 1 フレーム（ΔX だけが変わる）。部品が memo した今日・指定日の線（todayLine・
 * dateLine）を渡したグラフの表示モデル + 交点のラベル + 指標 + 読み取りの帯が、足 10 本・幅 1,000px で予算以内。
 */
describe('性能（#52 AC-10: 長押しドラッグの 1 フレーム）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario0 = { ...ZERO_SCENARIO, days: 5, dSigma: 2 };
  const today = todayLine(base, null, 1000, scenario0);
  const date = dateLine(base, null, 1000, scenario0);
  let tick = 0;

  function scrubFrame(): number {
    tick = (tick + 1) % 40;
    const scenario = { ...scenario0, dX: -2_000 + tick * 100 };
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
      dateYs: date,
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
    const r = readoutModel({ base, metrics: mm, scenario });
    return m.lines.length + (marks?.marks.length ?? 0) + mm.tail.rows.length + r.text.x.length;
  }

  it(`グラフの表示モデル + 交点 + 指標 + 帯が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(date).not.toBeNull();
    expect(scrubFrame()).toBeGreaterThan(8);
    expectWithinBudget('#52 長押しドラッグの 1 フレーム', scrubFrame, { warmup: 20, runs: 30 });
  });
});

/**
 * #23: 作業の保存（足 10 本の直列化 → 読み取り・検証 → 復元）。保存は操作が止まってから 500ms 後に 1 回
 * （スライダーの 1 フレームでは走らない）だが、1 回の書き込みでも予算に収まること。
 * 板の保存（322 行 × 2 限月）の直列化・読み取りの時間と大きさも出す（読み取りは開いたときの失敗だけ）。
 */
describe('性能（#23 作業・板の保存）', () => {
  const legs: UiLeg[] = PERF_LEGS.map((leg, i) => ({ id: i + 1, leg, marks: [] }));
  const state = { ...initialState, legs, nextId: legs.length + 1 };

  function roundTrip(): number {
    const text = serializeWorkspace(state, 0);
    const r = readWorkspace(text);
    if (r.kind !== 'ok') throw new Error('読めない');
    return restoreWorkspace(initialState, r.saved).legs.length + text.length;
  }

  it(`足 10 本の保存の直列化 + 読み取り + 復元が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(PERF_LEGS).toHaveLength(10);
    expectWithinBudget('#23 作業の保存（足 10 本）', roundTrip, { warmup: 10, runs: 30 });
    console.info(`#23 作業の保存（足 10 本）: ${serializeWorkspace(state, 0).length} 字`);
  });

  it('板（322 行 × 2 限月）の保存の直列化・読み取りの時間と大きさ（記録のみ）', () => {
    const json = buildWideChainJson();
    const text = serializeBoard(json, 0, 'API');
    record('#23 板の保存（322 行 × 2）の直列化', () => serializeBoard(json, 0, 'API'), {
      warmup: 0,
      runs: RECORD_RUNS,
      after: (t) => expect(t).toBe(text),
    });
    record('#23 板の保存（322 行 × 2）の読み取り（検証 + 正規化）', () => readSavedBoard(text), {
      warmup: 0,
      runs: RECORD_RUNS,
      after: (back) => expect(back?.chain.months).toHaveLength(2),
    });
    console.info(`#23 板の保存（322 行 × 2）: ${text.length} 字`);
    expect(text.length).toBeGreaterThan(0);
  });
});

/**
 * #70 AC10: ポジ帳の一覧（50 件 × 足 10 本）の要約（足の市場の作り直し・満期の最大損失・Δ・今の板での評価損益）が
 * 予算以内。ダイアログを開いたとき・板 / 項目が変わったときだけ走る（フレームごとには走らない）。
 */
describe('性能（#70 ポジ帳の一覧の要約）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が足りない');
  const ids: Record<string, string> = { [M1.id]: m1.id, [M2.id]: m2.id, FUT: chain.future.id };
  // 先物の足は足の市場が要る（保存の形の検証）ので今の板から作る
  const raw: UiLeg[] = PERF_LEGS.map((leg, i) => ({
    id: i + 1,
    leg:
      leg.kind === 'option'
        ? { ...leg, expiry: ids[leg.expiry] ?? leg.expiry }
        : { ...leg, contract: ids[leg.contract] ?? leg.contract },
    marks: [],
  }));
  const legs = refreshLegMarkets(chain, raw, CALENDAR.holidays);
  const state = { ...initialState, chain, legs, nextId: legs.length + 1 };
  let book: Book = EMPTY_BOOK;
  for (let i = 0; i < 50; i++) {
    const r = addEntry(book, toSaved(state, i), `P${i}`, i, `id${i}`);
    if (!r.ok) throw new Error(r.reason);
    book = r.book;
  }
  const read: BookRead = { kind: 'ok', book, chars: serializeBook(book).length };

  function list(): number {
    const v = bookListModel({
      chain,
      read,
      atmBasis: 'B',
      calendar: CALENDAR,
      unitSetting: 'auto',
      currentKey: '',
      legCount: 0,
    });
    return v.rows.length;
  }

  it(`50 件 × 足 10 本の一覧の表示モデルが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(list()).toBe(50);
    const v = bookListModel({
      chain,
      read,
      atmBasis: 'B',
      calendar: CALENDAR,
      unitSetting: 'auto',
      currentKey: '',
      legCount: 0,
    });
    // 全ての足が今の板で評価できる（計測が空振りしていない）
    expect(v.rows[0]?.markText).not.toBe('—');
    expect(v.rows[0]?.note).toBeNull();
    expectWithinBudget('#70 ポジ帳の一覧（50 件 × 足 10 本）', list, { warmup: 20, runs: 30 });
    console.info(`#70 ポジ帳の一覧（50 件 × 足 10 本）: ${read.chars} 字`);
  });
});

/**
 * #71 AC9: タブの切り替え 1 回（reduce switchTab = 退避 + 足の市場の作り直し、ポジションの表示モデル・損益グラフの
 * 基礎と 3 本の線・指標・テール表・読み取りの帯・タブの帯）が、322 行 × 2 限月の板・足 10 本 ↔ 足 4 本で予算以内。
 * 足 200 本のタブへの切り替えは記録のみ（回数は `npm run perf` で 5 回、`npm test`・CI で 1 回。RECORD_RUNS）。
 */
describe('性能（#71 タブの切り替え）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が足りない');
  const ids: Record<string, string> = { [M1.id]: m1.id, [M2.id]: m2.id, FUT: chain.future.id };
  // 先物の足は足の市場が要るので今の板から作る（#70 の計測と同じ）
  const legs10 = refreshLegMarkets(
    chain,
    PERF_LEGS.map((leg, i) => ({
      id: i + 1,
      leg:
        leg.kind === 'option'
          ? { ...leg, expiry: ids[leg.expiry] ?? leg.expiry }
          : { ...leg, contract: ids[leg.contract] ?? leg.contract },
      marks: [],
    })),
    CALENDAR.holidays,
  ).map(({ id: _id, ...rest }) => rest);
  const open = (type: 'openPosition' | 'openPositionInNewTab', legs: typeof legs10): Action => ({
    type,
    legs,
    scenario,
    feePerLot: 0,
    futureBasis: 'fixed',
  });
  const scenario = { ...ZERO_SCENARIO, days: 5, dX: -500 };
  // タブ A = 足 10 本、タブ B = 足 4 本
  let state = [
    { type: 'loaded', chain, label: 'perf' } as Action,
    open('openPosition', legs10),
    open('openPositionInNewTab', legs10.slice(0, 4)),
  ].reduce(reduce, initialState);

  function evaluate(s: State): number {
    const pm = positionModel(s.chain ?? chain, s.legs, s.atmBasis, s.calendar);
    const base = pnlDomains(s.chain ?? chain, pm.prepared, pm.ctx);
    if (!base) return pm.rows.length;
    const m = pnlChartModel({
      base,
      scenario: s.scenario,
      viewport: s.pnlViewport,
      pnlY: s.pnlY,
      plotWidth: 1000,
      plotHeight: 260,
    });
    const mm = metricsModel({ base, scenario: s.scenario, unit: 'auto' });
    const r = readoutModel({ base, metrics: mm, scenario: s.scenario });
    const tv = tabsModel(s.tabs, s.activeTab, s.legs.length);
    return pm.rows.length + m.lines.length + mm.tail.rows.length + r.text.x.length + tv.tabs.length;
  }

  function switchOnce(): number {
    const other = state.tabs.find((t) => t.id !== state.activeTab);
    if (!other) throw new Error('タブが無い');
    state = reduce(state, { type: 'switchTab', id: other.id });
    return evaluate(state);
  }

  it(`足 10 本 ↔ 足 4 本の切り替え 1 回が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(state.tabs).toHaveLength(2);
    expect(state.legs).toHaveLength(4);
    switchOnce();
    expect(state.legs).toHaveLength(10);
    expect(state.legs.every((l) => !l.marks.includes('no_board'))).toBe(true);
    expectWithinBudget('#71 タブの切り替え（足 10 本 ↔ 4 本）', switchOnce, {
      warmup: 20,
      runs: 30,
    });
  });

  it('足 200 本のタブへの切り替え（記録のみ）', () => {
    const many = Array.from({ length: 20 }, () => legs10).flat();
    let s = reduce(state, open('openPositionInNewTab', many));
    expect(s.legs).toHaveLength(200);
    const big = s.activeTab;
    const small = s.tabs[0]?.id ?? 1;
    const toSmall = () => {
      s = reduce(s, { type: 'switchTab', id: small });
    };
    const toBig = () => {
      s = reduce(s, { type: 'switchTab', id: big });
      return s;
    };
    // 評価（ポジションの表示モデル・損益グラフ）は足 200 本を 1 つのタブで持つときと同じ量。切り替えの増分は reduce だけ
    record('#71 足 200 本のタブへの切り替え（reduce）', toBig, {
      warmup: 0,
      runs: RECORD_RUNS,
      before: toSmall,
    });
    record('#71 足 200 本のタブへの切り替え（reduce + 評価）', () => evaluate(toBig()), {
      warmup: 0,
      runs: RECORD_RUNS,
      before: toSmall,
    });
    expect(s.legs).toHaveLength(200);
  });
});

/**
 * #22 AC8: ピン 3 本（足 10 本）があるときの 1 フレーム。
 * (1) 重ね 3 本でのスライダー 1 回: ピンの線（重ねは ΔX 以外のシナリオで作り直す。4px ごと・最大 PIN_MAX_SAMPLES = 200 点）+
 *     グラフの表示モデル（今の線 + ピンの path・縦軸の自動）+ 番号ラベル + 凡例の行 + 指標 + テール表
 * (2) ゴースト 3 本でのパン 1 フレーム: 表示範囲を毎回ずらし、ピンの線 3 本と今の 3 本の線を作り直す
 * (3) ゴースト 3 本での拡大縮小 1 フレーム: 表示範囲の幅を毎回変える（点数は PIN_ZOOM_MAX_SAMPLES。S1）
 * 長押しドラッグ（ΔX だけ）はピンの線を作り直さない（cachedPinLines の使い回し。tests/ui/pins.test.ts）。
 */
describe('性能（#22 AC8: ピン 3 本）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  // ピンの基礎は足 10 本ずつ（重ねは別の基礎 = 同じ足を別に準備したもの）
  const pinBases = [1, 2, 3].map(() => {
    const b = pnlDomains(board, preparePosition(PERF_LEGS, ctx), ctx);
    if (!b) throw new Error('ピンの基礎が作れない');
    return b;
  });
  const scenario0 = { ...ZERO_SCENARIO, days: 5 };
  const today = todayLine(base, null, 1000, scenario0);
  const target = (i: number, kind: PinTarget['kind'], sc: typeof scenario0): PinTarget => ({
    no: (i + 1) as PinNo,
    kind,
    name: `P${i}`,
    base: pinBases[i] ?? null,
    scenario: { ...sc, dX: 0 },
    period: 'date',
    active: false,
    legCount: 10,
    excluded: 0,
    boardSnapshotAt: null,
  });
  const linesOf = (cache: Map<PinNo, PinLineCacheEntry>, ts: PinTarget[]): PinLineData[] =>
    ts
      .map((t) => cache.get(t.no)?.data)
      .filter((d): d is PinLineData => d !== null && d !== undefined);

  let tick = 0;
  let cache = new Map<PinNo, PinLineCacheEntry>();
  function slide(): number {
    tick = (tick + 1) % 40;
    const scenario = {
      ...scenario0,
      days: 5 + tick * 0.5,
      dX: -tick * 100,
      dSigma: tick * 0.5,
      skew: (tick % 10) * 0.5,
    };
    const targets = [0, 1, 2].map((i) => target(i, 'tab', scenario));
    const domain = pnlViewDomain(base as NonNullable<typeof base>, null);
    cache = cachedPinLines(cache, targets, domain, 1000, 'period');
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
      pins: linesOf(cache, targets),
    });
    const labels = pinLabels(m);
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const list = pinListModel({
      targets,
      mode: 'period',
      scenarioX: ctx.x0 + scenario.dX,
      unit: mm.unit,
    });
    return m.pins.length + labels.length + list.length + mm.tail.rows.length + m.lines.length;
  }

  it(`重ね 3 本でのスライダー 1 回が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(slide()).toBeGreaterThan(9);
    expectWithinBudget('#22 重ね 3 本でのスライダー 1 回', slide, { warmup: 20, runs: 30 });
  });

  let shift = 0;
  let gcache = new Map<PinNo, PinLineCacheEntry>();
  const ghosts = [0, 1, 2].map((i) => target(i, 'ghost', { ...scenario0, days: 3 + i, dSigma: i }));
  function pan(): number {
    shift = (shift + 37) % 1000;
    const lo = (base?.initial[0] ?? 0) + shift;
    const viewport: [number, number] = [lo, lo + 20_000];
    const domain = pnlViewDomain(base as NonNullable<typeof base>, viewport);
    gcache = cachedPinLines(gcache, ghosts, domain, 1000, 'period');
    const m = pnlChartModel({
      base,
      scenario: scenario0,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      pins: linesOf(gcache, ghosts),
    });
    return m.pins.length + pinLabels(m).length + m.lines.length + (m.pins[0]?.d.length ?? 0);
  }

  it(`ゴースト 3 本でのパン 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(pan()).toBeGreaterThan(8);
    expectWithinBudget('#22 ゴースト 3 本でのパン 1 フレーム', pan, { warmup: 20, runs: 30 });
  });

  // 拡大縮小（ホイール・ピンチ・ボタン）: 表示範囲の幅を毎フレーム変える。格子を使い回せないので、画面と同じく
  // pinSampleCap で点数を PIN_ZOOM_MAX_SAMPLES に下げる（止まった後の通常の点数での描き直しは 1 回だけ。#22 S1）
  let zstep = 0;
  let zspan: number | null = null;
  let zcache = new Map<PinNo, PinLineCacheEntry>();
  function zoomFrame(): number {
    zstep = (zstep + 1) % 20;
    const lo = (base?.initial[0] ?? 0) + zstep * 150;
    const viewport: [number, number] = [lo, lo + 16_000 + zstep * 300];
    const domain = pnlViewDomain(base as NonNullable<typeof base>, viewport);
    const cap = pinSampleCap(zspan, domain);
    zspan = domain[1] - domain[0];
    zcache = cachedPinLines(zcache, ghosts, domain, 1000, 'period', cap);
    const m = pnlChartModel({
      base,
      scenario: scenario0,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      pins: linesOf(zcache, ghosts),
    });
    return m.pins.length + pinLabels(m).length + m.lines.length + (m.pins[0]?.d.length ?? 0);
  }

  it(`ゴースト 3 本での拡大縮小 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(zoomFrame()).toBeGreaterThan(8);
    expectWithinBudget('#22 ゴースト 3 本での拡大縮小 1 フレーム', zoomFrame, {
      warmup: 20,
      runs: 30,
    });
  });

  it(`ピン 3 本での長押しドラッグ 1 フレームが ${BUDGET_MS} ms 以内（ピンの線は使い回し）`, () => {
    const date = dateLine(base, null, 1000, scenario0);
    const targets = [0, 1, 2].map((i) => target(i, i === 0 ? 'ghost' : 'tab', scenario0));
    const domain = pnlViewDomain(base, null);
    let c = cachedPinLines(new Map(), targets, domain, 1000, 'period');
    let t = 0;
    const frame = () => {
      t = (t + 1) % 40;
      const scenario = { ...scenario0, dX: -2_000 + t * 100 };
      const c2 = cachedPinLines(c, targets, domain, 1000, 'period');
      c = c2;
      const m = pnlChartModel({
        base,
        scenario,
        viewport: null,
        pnlY: DEFAULT_PNL_Y,
        plotWidth: 1000,
        plotHeight: 260,
        todayYs: today,
        dateYs: date,
        pins: linesOf(c2, targets),
      });
      const mm = metricsModel({ base, scenario, unit: 'auto' });
      const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
      const r = readoutModel({ base, metrics: mm, scenario });
      const list = pinListModel({
        targets,
        mode: 'period',
        scenarioX: ctx.x0 + scenario.dX,
        unit: mm.unit,
      });
      return (
        m.pins.length +
        (marks?.marks.length ?? 0) +
        r.text.x.length +
        list.length +
        pinLabels(m).length
      );
    };
    expect(frame()).toBeGreaterThan(6);
    expectWithinBudget('#22 ピン 3 本での長押しドラッグ 1 フレーム', frame, {
      warmup: 20,
      runs: 30,
    });
  });
});

/**
 * #82 AC-8: 新しい画面の舞台の 1 フレーム（足 10 本・幅 1,000px・高さ 260px）。ハンドルのドラッグは ΔX だけ変わる
 * （今日・指定日の線は memo 済みを渡す）、レールのドラッグは Δσ・d が変わる（指定日の線を作り直す）。どちらも
 * 表示モデル + 舞台の付属（ハンドル・塗り・足マーカー・ラベルの退避）+ 交点 + 指標 + 読み取り。
 */
describe('性能（#82 AC-8: 舞台の 1 フレーム）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const uiLegs: UiLeg[] = PERF_LEGS.map((leg, i) => ({ id: i + 1, leg, marks: [] }));
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const scenario0 = { ...ZERO_SCENARIO, days: 5, dSigma: 2 };
  const today = todayLine(base, null, 1000, scenario0);
  const date0 = dateLine(base, null, 1000, scenario0);
  let tick = 0;

  function stageFrame(scenario: typeof scenario0, dateYs: number[] | null): number {
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
      dateYs,
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
    const labels = marks ? stageMarkLabels(marks, m) : [];
    const h = stageHandle(m, marks);
    const fill = stageFill(m);
    const ms = legMarkers(uiLegs, base, m, { selected: 1, drag: null });
    const r = readoutModel({ base, metrics: mm, scenario });
    const items = bigReadout(r, mm.premium, base?.ctx.evalTime ?? null, scenario.dSigma);
    return (
      m.lines.length +
      labels.length +
      (h ? 1 : 0) +
      fill.gain.length +
      fill.loss.length +
      ms.length +
      mm.tail.rows.length +
      items.length
    );
  }

  it(`ハンドルのドラッグ（ΔX）の 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const handleFrame = () => {
      tick = (tick + 1) % 40;
      return stageFrame({ ...scenario0, dX: -2_000 + tick * 100 }, date0);
    };
    expect(date0).not.toBeNull();
    expect(handleFrame()).toBeGreaterThan(20);
    expectWithinBudget('#82 舞台のハンドルの 1 フレーム', handleFrame, { warmup: 20, runs: 30 });
  });

  it(`レールのドラッグ（Δσ・d）の 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const railFrame = () => {
      tick = (tick + 1) % 40;
      const scenario = { ...scenario0, dX: -400, dSigma: tick * 0.5, days: tick % 2 === 0 ? 5 : 6 };
      return stageFrame(scenario, dateLine(base, null, 1000, scenario));
    };
    expect(railFrame()).toBeGreaterThan(20);
    expectWithinBudget('#82 舞台のレールの 1 フレーム', railFrame, { warmup: 20, runs: 30 });
  });
});

/**
 * #83 AC-6: 新しい画面のシナリオの 1 回（足 10 本・幅 1,000px・高さ 260px）。ステッパー 1 段（Δσ +0.5 → 指定日の線を
 * 作り直す）とプリセット 1 回（ΔX・Δσ・Δs が変わる）。どちらも reducer + シナリオの表示モデル（ステッパー 4 つ + β・
 * チップ・要約）+ 損益グラフの表示モデル + 舞台の付属 + 交点 + 指標 + 読み取り。
 */
describe('性能（#83 AC-6: シナリオの 1 回）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const uiLegs: UiLeg[] = PERF_LEGS.map((leg, i) => ({ id: i + 1, leg, marks: [] }));
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const DAY = 86_400_000;
  const targets = [M1, M2].map((m) => ({
    id: m.id,
    label: m.id,
    sqTime: ctx.evalTime + m.days * DAY,
    lastTradeClose: ctx.evalTime + (m.days - 1) * DAY,
  }));
  const state0: State = {
    ...initialState,
    scenario: { ...ZERO_SCENARIO, days: 5, dX: -400, dSigma: 2 },
  };
  const today = todayLine(base, null, 1000, state0.scenario);
  let tick = 0;

  function frame(s: State): number {
    const input: ScenarioRegionInput = {
      scenario: s.scenario,
      futureBasis: s.futureBasis,
      x0: ctx.x0,
      maxDays: base?.maxDays ?? 0,
      evalTime: base?.ctx.evalTime ?? null,
      targets,
      dXUnit: 'pct',
    };
    const views = scenarioSteppers(input);
    const beta = betaStepper(input);
    const chips = presetChips(input).length + evalChips(input).length;
    const summary = advSummary(input);
    const scenario = s.scenario;
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: today,
      dateYs: dateLine(base, null, 1000, scenario),
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
    const labels = marks ? stageMarkLabels(marks, m) : [];
    const h = stageHandle(m, marks);
    const fill = stageFill(m);
    const ms = legMarkers(uiLegs, base, m, { selected: 1, drag: null });
    const r = readoutModel({ base, metrics: mm, scenario });
    const items = bigReadout(r, mm.premium, base?.ctx.evalTime ?? null, scenario.dSigma);
    return (
      views.length +
      (beta.hot ? 1 : 0) +
      chips +
      summary.length +
      m.lines.length +
      labels.length +
      (h ? 1 : 0) +
      fill.gain.length +
      fill.loss.length +
      ms.length +
      mm.tail.rows.length +
      items.length
    );
  }

  it(`ステッパー 1 段（Δσ +0.5）の 1 回が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    let s = state0;
    const once = () => {
      tick = (tick + 1) % 40;
      const input: ScenarioRegionInput = {
        scenario: s.scenario,
        futureBasis: s.futureBasis,
        x0: ctx.x0,
        maxDays: base.maxDays,
        evalTime: base.ctx.evalTime,
        targets,
        dXUnit: 'pct',
      };
      const view = scenarioSteppers(input)[2];
      if (!view) throw new Error('Δσ が無い');
      // 上限に着いたら −10 から（毎回 Δσ が変わる = 指定日の線を作り直す）
      const next = view.value >= view.spec.max ? view.spec.min : stepBy(view.spec, view.value, 1);
      const a = stepperAction('dSigma', next, input);
      if (a) s = reduce(s, a);
      return frame(s);
    };
    expect(once()).toBeGreaterThan(20);
    expect(s.scenario.dSigma).toBe(2.5);
    expectWithinBudget('#83 シナリオのステッパー 1 段', once, { warmup: 20, runs: 30 });
  });

  it(`プリセット 1 回（ΔX・Δσ・Δs）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    let s = state0;
    let k = 0;
    const once = () => {
      k = (k + 1) % 3;
      const a: Action = { type: 'applyPreset', index: k, x0: ctx.x0 };
      s = reduce(s, a);
      return frame(s);
    };
    expect(once()).toBeGreaterThan(20);
    expect(s.scenario.dSigma).toBe(8);
    expectWithinBudget('#83 シナリオのプリセット 1 回', once, { warmup: 20, runs: 30 });
  });
});

/**
 * #84 AC-7: 新しい画面の作業台の 1 回（322 行 × 2 限月の板・足 10 本）。
 * (1) ポジションの行の表示モデル + 足別のシナリオ点の対応 + スプレッドコスト + 詳細 1 本 + ヘッジの節
 * （positionModel・hedgeModel から作る。画面では memo の出力を並べ直すだけ）
 * (2) 枚数 ±1 の 1 回（editLeg の reduce + ポジションの表示モデル + 損益グラフの表示モデル + 指標 + 読み取り + (1)）。
 */
describe('性能（#84 AC-7: 作業台の 1 回）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が足りない');
  const ids: Record<string, string> = { [M1.id]: m1.id, [M2.id]: m2.id, FUT: chain.future.id };
  const legs10 = refreshLegMarkets(
    chain,
    PERF_LEGS.map((leg, i) => ({
      id: i + 1,
      leg:
        leg.kind === 'option'
          ? { ...leg, expiry: ids[leg.expiry] ?? leg.expiry }
          : { ...leg, contract: ids[leg.contract] ?? leg.contract },
      marks: [],
    })),
    CALENDAR.holidays,
  ).map(({ id: _id, ...rest }) => rest);
  const state0 = [
    { type: 'loaded', chain, label: 'perf' } as Action,
    {
      type: 'openPosition',
      legs: legs10,
      scenario: { ...ZERO_SCENARIO, days: 5, dX: -500 },
      feePerLot: 0,
      futureBasis: 'fixed',
    } as Action,
  ].reduce(reduce, initialState);

  function bench(s: State) {
    const c = s.chain ?? chain;
    const pm = positionModel(c, s.legs, s.atmBasis, s.calendar);
    const base = pnlDomains(c, pm.prepared, pm.ctx);
    const mm = metricsModel({ base, scenario: s.scenario, unit: 'auto' });
    const hm = hedgeModel({
      chain: c,
      ctx: pm.ctx,
      base,
      settings: base?.settings ?? DEFAULT_SETTINGS,
      scenario: s.scenario,
      hedge: s.hedge,
      holidays: s.calendar.holidays,
    });
    return { pm, base, mm, hm };
  }
  function region(v: ReturnType<typeof bench>): number {
    const rows = positionRows(v.pm);
    const scen = scenarioLegsByRow(v.pm, v.base, v.mm);
    const spread = legSpreadCosts(v.pm, DEFAULT_SETTINGS);
    const row = v.pm.rows[0];
    const d = row ? legDetail(row, scen[0] ?? null, spread[0] ?? null, v.mm.unit) : null;
    const h = hedgeSection(v.hm);
    return rows.length + scen.length + spread.length + (d?.items.length ?? 0) + h.lines.length;
  }

  it(`ポジションの行 + 足別の対応 + ヘッジの節（足 10 本）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(state0.legs).toHaveLength(10);
    const v = bench(state0);
    expect(v.pm.rows.every((r) => r.error === null)).toBe(true);
    const once = () => region(v);
    expect(once()).toBeGreaterThan(30);
    expectWithinBudget('#84 作業台の表示モデル（足 10 本）', once, { warmup: 20, runs: 30 });
  });

  it(`枚数 ±1 の 1 回（reduce + 表示モデル一式）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    let s = state0;
    let k = 0;
    const id = s.legs[0]?.id ?? 1;
    const once = () => {
      k++;
      const qty = (s.legs[0]?.leg.qty ?? 1) + (k % 2 === 1 ? 1 : -1);
      s = reduce(s, { type: 'editLeg', id, patch: { qty } });
      const v = bench(s);
      if (!v.base) return 0;
      const m = pnlChartModel({
        base: v.base,
        scenario: s.scenario,
        viewport: s.pnlViewport,
        pnlY: s.pnlY,
        plotWidth: 1000,
        plotHeight: 260,
      });
      const r = readoutModel({ base: v.base, metrics: v.mm, scenario: s.scenario });
      return region(v) + m.lines.length + v.mm.tail.rows.length + r.text.x.length;
    };
    const q0 = s.legs[0]?.leg.qty ?? 0;
    expect(once()).toBeGreaterThan(30);
    expect(s.legs[0]?.leg.qty).toBe(q0 + 1);
    expectWithinBudget('#84 枚数 ±1 の 1 回（足 10 本）', once, { warmup: 20, runs: 30 });
  });
});

/**
 * #86 AC-5: 新しい画面の指標パネル（足 10 本）。(1) 指標パネルの表示モデルの 1 回（タイル + 内訳 + テール表のバー。
 * metricsModel は useAppController の useMemo の出力を受けるので含めない）。(2) ステッパー 1 段（Δσ +0.5）の 1 回で
 * 指標パネルまで（reduce + 損益グラフの表示モデル（指定日の線を作り直す）+ 指標 + 読み取り + 指標パネル）。
 */
describe('性能（#86 AC-5: 指標パネル）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, legs, ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  const state0: State = {
    ...initialState,
    feePerLot: 300,
    scenario: { ...ZERO_SCENARIO, days: 5, dX: -400, dSigma: 2 },
  };
  const today = todayLine(base, null, 1000, state0.scenario);
  const panelSize = (v: ReturnType<typeof metricsPanel>) =>
    v.tiles.length +
    v.breakdown.length +
    v.tail.reduce((n, r) => n + (r.sq.bar ? 1 : 0) + (r.scenario.bar ? 1 : 0), 0);

  it(`指標パネルの 1 回（足 10 本: タイル + 内訳 + テール表のバー）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const mm = metricsModel({ base, scenario: state0.scenario, unit: 'auto' });
    expect(mm.empty).toBe(false);
    const once = () => panelSize(metricsPanel(mm, state0.feePerLot));
    expect(once()).toBeGreaterThan(20);
    expectWithinBudget('#86 指標パネルの表示モデル（足 10 本）', once, { warmup: 20, runs: 30 });
  });

  it(`ステッパー 1 段（Δσ +0.5）の 1 回で指標パネルまでが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    let s = state0;
    const once = () => {
      // 上限に着いたら 0 から（毎回 Δσ が変わる = 指定日の線と指標を作り直す）
      const next = s.scenario.dSigma >= 20 ? 0 : s.scenario.dSigma + 0.5;
      s = reduce(s, { type: 'setScenario', patch: { dSigma: next } });
      const scenario = s.scenario;
      const m = pnlChartModel({
        base,
        scenario,
        viewport: null,
        pnlY: DEFAULT_PNL_Y,
        plotWidth: 1000,
        plotHeight: 260,
        todayYs: today,
        dateYs: dateLine(base, null, 1000, scenario),
      });
      const mm = metricsModel({ base, scenario, unit: s.metricsUnit });
      const r = readoutModel({ base, metrics: mm, scenario });
      const items = bigReadout(r, mm.premium, base.ctx.evalTime, scenario.dSigma);
      return m.lines.length + items.length + panelSize(metricsPanel(mm, s.feePerLot));
    };
    expect(once()).toBeGreaterThan(20);
    expect(s.scenario.dSigma).toBe(2.5);
    expectWithinBudget('#86 ステッパー 1 段で指標パネルまで', once, { warmup: 20, runs: 30 });
  });
});

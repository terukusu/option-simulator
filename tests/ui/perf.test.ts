import { describe, expect, it } from 'vitest';
import { boardOptionLeg, buildMarketContext, normalizeChain } from '../../data';
import type { AiMessage } from '../../data/aiStream';
import {
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  emaSet,
  holdMapAxes,
  holdMapColumn,
  holdMapPnlColumn,
  indicators,
} from '../../model';
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
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import {
  type Action,
  initialState,
  reduce,
  restoreTabAction,
  type State,
  type UiLeg,
} from '../../ui/state';
import {
  type AiChatState,
  aiChatReduce,
  chatItems,
  INITIAL_AI_CHAT,
  numberSources,
} from '../../ui/view/aiChat';
import { aiEnvFromState, buildAiContext } from '../../ui/view/aiContext';
import { answerModel, markNumbers, parseAiText } from '../../ui/view/aiText';
import { atmStrike, boardRows } from '../../ui/view/board';
import { boardBadges, boardRowTexts } from '../../ui/view/boardPanel';
import { bookListModel } from '../../ui/view/bookList';
import { FUT_SERIES, futEmaOverlays, futRollMarks } from '../../ui/view/futHistory';
import { headerModel, keptBoardNote } from '../../ui/view/header';
import { hedgeModel } from '../../ui/view/hedge';
import { holdMapCalcOf, holdMapInput, holdMapPlot, holdMapResultOf } from '../../ui/view/holdMap';
import { futPaneDrag, futPaneLayout, indPaneModel } from '../../ui/view/indicators';
import {
  ivChartModel,
  ivCrosshair,
  ivFollowViewport,
  ivFullDomain,
  lineSegments,
  resampleBars,
  resolveIvViewport,
} from '../../ui/view/ivHistory';
import {
  type MarginView,
  marginLine,
  marginNow,
  marginPoint,
  marginPointAt,
  marginTail,
} from '../../ui/view/margin';
import { marketPill } from '../../ui/view/marketPill';
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
import { pnlCrosshair } from '../../ui/view/pnlCrosshair';
import {
  surfaceDayTicks,
  surfaceDragPatch,
  surfaceGrid,
  surfaceImage,
  surfaceLegend,
  surfacePoint,
} from '../../ui/view/pnlSurface';
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
  EFF_NOW_SCENARIO,
  type SmileEffBase,
  smileEffPath,
  smileEffPoints,
  smileEffYDomain,
} from '../../ui/view/smileEff';
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
import { barsAt, jst } from '../support/synthIv';

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
 * #201: 損益グラフの十字線。ホバー・交点のドラッグの 1 フレームはカーソルだけが変わり、グラフの表示モデルは作り直さない
 * （PnlPlot の useMemo）。十字線の表示モデル（3 本の値 = 足 10 本の評価 × 2 + 満期、札・読み取りの置き場所）だけを測る。
 */
describe('性能（#201 十字線の 1 フレーム）', () => {
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
  const scenario = { ...ZERO_SCENARIO, days: 5, dSigma: 2 };
  const chart = pnlChartModel({
    base,
    scenario,
    viewport: null,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: 1000,
    plotHeight: 260,
  });
  const [lo, hi] = chart.domain;
  const [ylo, yhi] = chart.yDomain;
  let tick = 0;

  function crossFrame(): number {
    tick = (tick + 1) % 97;
    const c = pnlCrosshair({
      base: base as NonNullable<typeof base>,
      scenario,
      chart,
      cursor: { x: lo + ((hi - lo) * tick) / 97, y: ylo + ((yhi - ylo) * tick) / 97, pinned: true },
      width: 1068,
      height: 296,
      obstacles: [{ x0: 900, x1: 1060, y0: 100, y1: 116 }],
    });
    return (c?.read.items.length ?? 0) + (c?.dots.length ?? 0);
  }

  it(`十字線の表示モデル（足 10 本）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(crossFrame()).toBeGreaterThan(0);
    expectWithinBudget('#201 十字線の 1 フレーム', crossFrame, { warmup: 20, runs: 30 });
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
    const items = bigReadout(r, base?.ctx.evalTime ?? null);
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
    const items = bigReadout(r, base?.ctx.evalTime ?? null);
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
      const items = bigReadout(r, base.ctx.evalTime);
      return m.lines.length + items.length + panelSize(metricsPanel(mm, s.feePerLot));
    };
    expect(once()).toBeGreaterThan(20);
    expect(s.scenario.dSigma).toBe(2.5);
    expectWithinBudget('#86 ステッパー 1 段で指標パネルまで', once, { warmup: 20, runs: 30 });
  });
});

/**
 * #85 AC-5: 新しい画面の板の表示モデル（322 行 × 2 限月・足 10 本）。限月の切替・足の追加で作り直すもの。
 * 行の文字列と印（boardRowTexts）は板が変わったときだけ、バッジ（boardBadges）は足が変わったときだけ作る。
 */
describe('性能（#85 AC-5: 板の表示）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const legs: UiLeg[] = [];
  chain.months.forEach((m, mi) => {
    const atm = m.atm.B.pick?.k ?? m.strikes[Math.floor(m.strikes.length / 2)]?.k ?? 0;
    for (let i = 0; i < 5; i++) {
      const k = atm + (i - 2) * 500;
      const built = boardOptionLeg(chain, {
        expiry: m.id,
        k,
        type: i % 2 ? 'call' : 'put',
        side: i < 3 ? 'sell' : 'buy',
      });
      legs.push({ id: mi * 10 + i + 1, leg: built.leg, marks: built.marks });
    }
  });

  it(`板の表示（322 行 × 2 限月・足 10 本: boardRows + 行の文字列と印 + バッジ）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(chain.months.every((m) => m.strikes.length >= 322)).toBe(true);
    expect(legs.length).toBe(10);
    const once = () => {
      let n = 0;
      for (const m of chain.months) {
        const rows = boardRows(chain, m);
        n += boardRowTexts(chain, m, rows).size + boardBadges(legs, m.id).size;
      }
      return n;
    };
    expect(once()).toBeGreaterThan(644);
    expectWithinBudget('#85 板の表示（322 行 × 2 限月・足 10 本）', once, { warmup: 10, runs: 30 });
  });

  it(`足 1 本の追加でのバッジの作り直し（322 行・足 10 本）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    let s: State = reduce(
      { ...initialState, legs: [...legs], nextId: 100 },
      { type: 'loaded', chain, label: 'wide' },
    );
    const m = chain.months[0];
    if (!m) throw new Error('限月が無い');
    const atm = m.atm.B.pick?.k ?? 0;
    const start = s;
    const once = () => {
      if (s.legs.length > 40) s = start;
      s = reduce(s, { type: 'addBoardLeg', expiry: m.id, k: atm, optionType: 'put', side: 'sell' });
      return boardBadges(s.legs, m.id).size + boardBadges(s.legs, chain.months[1]?.id ?? '').size;
    };
    expect(once()).toBeGreaterThan(0);
    expectWithinBudget('#85 足 1 本の追加でのバッジ', once, { warmup: 10, runs: 30 });
  });
});

/**
 * #87 AC-8: 市場ピルの要約 + 全文の 1 回（322 行 × 2 限月の板）。headerModel は前で 1 回作って含めない
 * （ピルは headerModel の文字列を選ぶだけ。限月の数に比例し、行の数に依らない）。
 */
describe('性能（#87 AC-8: 市場ピル）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const fetchedAt = chain.snapshotAt + 60_000;
  const header = headerModel(chain, 'B', CALENDAR, { fetchedAt, label: 'API', stale: true });
  const load = {
    loading: false,
    error: { message: '板を読めない（HTTP 500）', errors: ['months[0]: 形が違う'] },
    kept: keptBoardNote(fetchedAt, true),
    loaderNote: '表示中: 保存した板（API）',
  };

  it(`市場ピルの要約 + 全文の 1 回（322 行 × 2 限月）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(chain.months.every((m) => m.strikes.length >= 322)).toBe(true);
    const ids = chain.months.map((m) => m.id);
    let i = 0;
    const once = () => {
      const p = marketPill(header, ids[i++ % ids.length] ?? null, load);
      return p.summary.length + p.full.months.length + p.tags.length;
    };
    expect(once()).toBeGreaterThan(0);
    expectWithinBudget('#87 市場ピルの要約 + 全文', once, { warmup: 20, runs: 30 });
  });
});

/**
 * #87 AC-8: タブを閉じて戻す 1 回（足 10 本のタブ 3 個・322 行 × 2 限月の板。作業中の 2 番目を closeTab → restoreTab）。
 * 足の市場の作り直し（switchTab と同じ loadLegs）が 2 回分入る
 */
describe('性能（#87 AC-8: タブを閉じて戻す）', () => {
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
  const open = (type: 'openPosition' | 'openPositionInNewTab'): Action => ({
    type,
    legs: legs10,
    scenario: null,
    feePerLot: null,
    futureBasis: null,
  });
  // タブ A・B・C（どれも足 10 本）、作業中は B
  const start = [
    { type: 'loaded', chain, label: 'perf' } as Action,
    open('openPosition'),
    open('openPositionInNewTab'),
    open('openPositionInNewTab'),
  ].reduce(reduce, initialState);
  const second = start.tabs[1];
  if (!second) throw new Error('タブが足りない');
  const begin = reduce(start, { type: 'switchTab', id: second.id });

  let state = begin;
  function once(): number {
    const action = restoreTabAction(state, state.activeTab);
    if (!action) throw new Error('閉じられない');
    const closed = reduce(state, { type: 'closeTab', id: state.activeTab });
    state = reduce(closed, action);
    return state.tabs.length + state.legs.length;
  }

  it(`タブを閉じて戻す 1 回（足 10 本 × 3 個・322 行 × 2 限月）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(chain.months.every((m) => m.strikes.length >= 322)).toBe(true);
    expect(begin.tabs).toHaveLength(3);
    expect(begin.tabs.every((t) => (t.saved?.legs.length ?? begin.legs.length) === 10)).toBe(true);
    expect(once()).toBe(13);
    expect(state.tabs.map((t) => t.name)).toEqual(begin.tabs.map((t) => t.name));
    expect(state.tabs.findIndex((t) => t.id === state.activeTab)).toBe(1);
    expectWithinBudget('#87 タブを閉じて戻す', once, { warmup: 20, runs: 30 });
  });
});

/**
 * #88 AC-8 (a): 面モードの IV レール（Δσ +0.5）の 1 フレーム。322 行 × 2 限月の板・足 10 本・幅 1,000px・高さ 260px。
 * 面の値の入力が変わるので粗い格子（48 × 24）を作り直し + 色のバッファ + 指定日の線（線の表示モデルは横軸・ハンドルに
 * 使う）+ 損益グラフの表示モデル + 交点 + 指標 + ハンドル + 面の点・縦の目盛り・凡例 + 足マーカー + 読み取り。
 * 記録のみ: 細かい格子（72 × 36）1 回 + 色（足 10 本）、粗い格子 + 色（足 200 本）、足 200 本の線モードの IV レールの 1 フレーム。
 * #88 AC-8 (b)（段 B）: 面の上のドラッグの 1 フレーム（ΔX と d を同時に変える。面の格子・色は作り直さない = 使い回し）。
 * 記録のみ: 面モードのパンの 1 フレーム（表示範囲が変わる = 粗い格子 + 色 + 今日の線 + 指定日の線 + 同じ一式）。
 */
describe('性能（#88 AC-8: 面モードの 1 フレーム）', () => {
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
  const stateOf = (legs: typeof legs10) =>
    [
      { type: 'loaded', chain, label: 'perf' } as Action,
      {
        type: 'openPosition',
        legs,
        scenario: { ...ZERO_SCENARIO, days: 5, dX: -500 },
        feePerLot: 0,
        futureBasis: 'fixed',
      } as Action,
    ].reduce(reduce, initialState);
  const baseOf = (s: State) => {
    const pm = positionModel(s.chain ?? chain, s.legs, s.atmBasis, s.calendar);
    const base = pnlDomains(s.chain ?? chain, pm.prepared, pm.ctx);
    if (!base) throw new Error('損益グラフの基礎が作れない');
    return base;
  };
  const state10 = stateOf(legs10);
  const base10 = baseOf(state10);
  const colors = { gain: [47, 180, 131], loss: [239, 107, 107] } as const;
  const W = 1000;
  const H = 260;

  // 今日の線は Δσ で変わらない（usePnlChartModel が memo する。#82 の計測と同じ）
  const todays = new Map<typeof base10, number[] | null>();
  function frame(base: typeof base10, uiLegs: readonly UiLeg[], dSigma: number, surface: boolean) {
    const scenario = { ...state10.scenario, dSigma };
    if (!todays.has(base)) todays.set(base, todayLine(base, null, W, scenario));
    const today = todays.get(base) ?? null;
    let acc = 0;
    if (surface) {
      const grid = surfaceGrid(base, scenario, null, 'coarse');
      if (!grid) throw new Error('格子が無い');
      acc += surfaceImage(grid, colors).data.length;
      acc += surfaceLegend(grid.vmax, 'thousand').long.length;
    }
    const m = pnlChartModel({
      base,
      scenario,
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: W,
      plotHeight: H,
      todayYs: today,
      dateYs: dateLine(base, null, W, scenario),
    });
    const mm = metricsModel({ base, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base, scenario, chart: m, unit: mm.unit });
    const h = stageHandle(m, marks);
    if (surface) {
      const p = surfacePoint({ base, scenario, chart: m, handle: h, unit: mm.unit });
      acc += (p?.text.length ?? 0) + surfaceDayTicks(m.plot, base.maxDays).length;
    } else {
      const labels = marks ? stageMarkLabels(marks, m) : [];
      const fill = stageFill(m);
      acc += labels.length + fill.gain.length;
    }
    const ms = legMarkers(uiLegs, base, m, { selected: 1, drag: null });
    const r = readoutModel({ base, metrics: mm, scenario });
    const items = bigReadout(r, base.ctx.evalTime);
    return acc + m.lines.length + (h ? 1 : 0) + ms.length + mm.tail.rows.length + items.length;
  }

  it(`面モードの IV レール（Δσ +0.5）の 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(state10.legs).toHaveLength(10);
    expect(base10.legs).toHaveLength(10);
    let tick = 0;
    const ivFrame = () => {
      tick = (tick + 1) % 40;
      return frame(base10, state10.legs, tick * 0.5, true);
    };
    expect(ivFrame()).toBeGreaterThan(1_000);
    expectWithinBudget('#88 面モードの IV レールの 1 フレーム（足 10 本）', ivFrame, {
      warmup: 20,
      runs: 30,
    });
  });

  it('細かい格子 1 回・足 200 本（記録のみ）', () => {
    const scenario = { ...state10.scenario, dSigma: 2 };
    record(
      '#88 細かい格子（72 × 36）1 回 + 色（足 10 本）',
      () => {
        const g = surfaceGrid(base10, scenario, null, 'fine');
        return g ? surfaceImage(g, colors).data.length : 0;
      },
      { warmup: 2, runs: RECORD_RUNS },
    );
    const state200 = stateOf(Array.from({ length: 20 }, () => legs10).flat());
    expect(state200.legs).toHaveLength(200);
    const base200 = baseOf(state200);
    record(
      '#88 粗い格子（48 × 24）+ 色（足 200 本）',
      () => {
        const g = surfaceGrid(base200, scenario, null, 'coarse');
        return g ? surfaceImage(g, colors).data.length : 0;
      },
      { warmup: 1, runs: RECORD_RUNS },
    );
    let tick = 0;
    record(
      '#88 参考: 線モードの IV レールの 1 フレーム（足 200 本）',
      () => {
        tick = (tick + 1) % 40;
        return frame(base200, state200.legs, tick * 0.5, false);
      },
      { warmup: 1, runs: RECORD_RUNS },
    );
  });

  /** 面の上のドラッグ・面モードのパンの 1 フレーム（格子を渡せば使い回し、null なら粗い格子を作る） */
  function surfaceFrame(
    scenario: typeof state10.scenario,
    viewport: [number, number] | null,
    grid: ReturnType<typeof surfaceGrid>,
    today: number[] | null,
  ) {
    let acc = 0;
    const g = grid ?? surfaceGrid(base10, scenario, viewport, 'coarse');
    if (!g) throw new Error('格子が無い');
    if (!grid) acc += surfaceImage(g, colors).data.length;
    const m = pnlChartModel({
      base: base10,
      scenario,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: W,
      plotHeight: H,
      todayYs: today ?? todayLine(base10, viewport, W, scenario),
      dateYs: dateLine(base10, viewport, W, scenario),
    });
    const mm = metricsModel({ base: base10, scenario, unit: 'auto' });
    const marks = scenarioMarks({ base: base10, scenario, chart: m, unit: mm.unit });
    const h = stageHandle(m, marks);
    const p = surfacePoint({ base: base10, scenario, chart: m, handle: h, unit: mm.unit });
    const ticks = surfaceDayTicks(m.plot, base10.maxDays);
    const patch = surfaceDragPatch({
      x: (p?.px ?? 0) + 7,
      y: (p?.py ?? 0) - 5,
      chart: m,
      offsetX: 0,
      offsetY: 0,
      x0: base10.ctx.x0,
      maxDays: base10.maxDays,
      scenario,
      pointPx: p ? { x: p.px, y: p.py } : null,
    });
    const ms = legMarkers(state10.legs, base10, m, { selected: 1, drag: null });
    const r = readoutModel({ base: base10, metrics: mm, scenario });
    const items = bigReadout(r, base10.ctx.evalTime);
    return (
      acc +
      g.values.length +
      m.lines.length +
      (p?.text.length ?? 0) +
      ticks.length +
      (patch ? 1 : 0) +
      ms.length +
      mm.tail.rows.length +
      items.length
    );
  }

  it(`面の上のドラッグ（ΔX と d）の 1 フレームが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const scenario0 = { ...state10.scenario, dSigma: 2 };
    // 面の格子と今日の線は ΔX・d で作り直さない（usePnlSurface・usePnlChartModel の memo）
    const grid = surfaceGrid(base10, scenario0, null, 'fine');
    const today = todayLine(base10, null, W, scenario0);
    let tick = 0;
    const dragFrame = () => {
      tick = (tick + 1) % 40;
      const scenario = { ...scenario0, dX: -500 + tick * 10, days: tick % 20 };
      return surfaceFrame(scenario, null, grid, today);
    };
    expect(grid).not.toBeNull();
    expect(dragFrame()).toBeGreaterThan(1_000);
    expectWithinBudget('#88 面の上のドラッグの 1 フレーム（足 10 本）', dragFrame, {
      warmup: 20,
      runs: 30,
    });
  });

  it('面モードのパンの 1 フレーム（記録のみ）', () => {
    const scenario = { ...state10.scenario, dSigma: 2 };
    const [lo, hi] = pnlViewDomain(base10, null);
    const w = (hi - lo) * 0.6;
    let tick = 0;
    record(
      '#88 面モードのパンの 1 フレーム（粗い格子 + 色 + 線 2 本。足 10 本）',
      () => {
        tick = (tick + 1) % 40;
        const a = lo + (hi - lo - w) * (tick / 40);
        return surfaceFrame(scenario, [a, a + w], null, null);
      },
      { warmup: 5, runs: RECORD_RUNS },
    );
  });
});

/**
 * #79 段 B: IV 推移の描き直しの 1 フレーム（パン・拡大のたびに ivChartModel だけを作り直す。線の区間は足が変わったとき
 * だけ）。最悪のケース = 1 分足を覚える上限 9 日 ≈ 1 万本（立会の 1,140 分 × 9 日）を全域で表示（架空の値）。
 */
describe('性能（#79 IV 推移の 1 フレーム）', () => {
  const times: number[] = [];
  for (let d = 0; times.length < 10_260; d++) {
    const day = jst('2026-10-01T08:45') + d * 86400;
    const wd = new Date((day + 9 * 3600) * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let m = 0; m < 420; m++) times.push(day + m * 60);
    for (let m = 0; m < 780; m++) times.push(day + (8 * 60 + 15) * 60 + m * 60);
  }
  const bars = barsAt(times, 11);
  const ntd = new Set<string>();
  const segments = lineSegments(bars, '1m', ntd);
  const full = ivFullDomain(bars.length);
  const input = (mode: 'candle' | 'line', a: number) => ({
    bars,
    tf: '1m' as const,
    mode,
    viewport: [full[0] + a, full[1] - 40 + a] as const,
    segments,
    width: 900,
    height: 420,
    rightLoaded: true,
  });

  for (const mode of ['candle', 'line'] as const) {
    it(`全域のパンの 1 フレーム（1 分足 ${bars.length.toLocaleString('en-US')} 本・${mode}）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
      let tick = 0;
      const frame = () => {
        tick = (tick + 1) % 40;
        const m = ivChartModel(input(mode, tick));
        return m.candles.length + m.line.length;
      };
      expect(frame()).toBeGreaterThan(1000);
      expectWithinBudget(`#79 IV 推移のパン（${mode}）`, frame, { warmup: 10, runs: 30 });
    });
  }

  it('初期表示（1 時間足 120 本）の 1 フレームと、足を替えたときの束ね直し・線の区間（記録のみ）', () => {
    const view = resolveIvViewport(bars, '1m', null, null);
    record(
      '#79 IV 推移の初期表示の 1 フレーム（240 本）',
      () => ivChartModel({ ...input('candle', 0), viewport: view }).candles.length,
      {
        warmup: 5,
        runs: RECORD_RUNS,
      },
    );
    record(
      '#79 足の切替（1 分 → 5 分の束ね直し + 線の区間）',
      () => lineSegments(resampleBars(bars, 300), '5m', ntd).length,
      { warmup: 3, runs: RECORD_RUNS },
    );
  });

  it('#79 段 C: 「今」の印・シナリオの水準つきのパン（line）が予算内、左に足した後の追従（5 分の束ね直し 2 回 + ivFollowViewport）は記録', () => {
    let tick = 0;
    const frame = () => {
      tick = (tick + 1) % 40;
      const m = ivChartModel({
        ...input('line', tick),
        now: { index: bars.length, iv: 21 },
        scenario: 26,
      });
      return m.line.length + (m.scenarioY ?? 0);
    };
    expectWithinBudget('#79 IV 推移のパン（今・シナリオつき）', frame, { warmup: 10, runs: 30 });
    const head = bars.slice(1140);
    record(
      '#79 左に足した後の追従（1 分足 1 万本 → 5 分の束ね直し 2 回 + 追従）',
      () => ivFollowViewport(resampleBars(head, 300), resampleBars(bars, 300), [10, 200])?.[0] ?? 0,
      { warmup: 3, runs: RECORD_RUNS },
    );
  });

  it(`#130: 十字線の 1 フレーム（ivCrosshair だけ。1 分足 1 万本の全域でカーソルを 40 段動かす）が ${BUDGET_MS} ms 以内`, () => {
    const model = ivChartModel(input('candle', 0));
    const viewport = input('candle', 0).viewport;
    let tick = 0;
    const frame = () => {
      tick = (tick + 1) % 40;
      const c = ivCrosshair({
        bars,
        tf: '1m',
        viewport,
        cursor: 200 + tick * 250,
        y: 40 + tick * 5,
        model,
      });
      return (c?.x ?? 0) + (c?.yTag.w ?? 0);
    };
    expect(frame()).toBeGreaterThan(0);
    expectWithinBudget('#130 IV 推移の十字線', frame, { warmup: 10, runs: 30 });
  });

  // #190 AC-7: 先物推移（同じ部品に円の書式と限月交代の印）。1 分足 1 万本の中ほどで限月交代（架空の値）
  const rollAt = (bars[5000] as (typeof bars)[number]).t;
  const futs = bars.map((b) => ({
    t: b.t,
    o: b.o * 1500,
    h: b.h * 1500,
    l: b.l * 1500,
    c: b.c * 1500,
    m: b.t < rollAt ? '2026-09' : '2026-12',
  }));
  const futSegments = lineSegments(futs, '1m', ntd);
  for (const mode of ['candle', 'line'] as const) {
    it(`#190: 先物推移のパンの 1 フレーム（1 分足 ${futs.length.toLocaleString('en-US')} 本・限月交代つき・${mode}）が ${BUDGET_MS} ms 以内`, () => {
      expect(futSegments).toHaveLength(1); // 期近のつなぎ足（交代で切らない）
      let tick = 0;
      const frame = () => {
        tick = (tick + 1) % 40;
        const m = ivChartModel({
          ...input(mode, tick),
          bars: futs,
          segments: futSegments,
          series: FUT_SERIES,
          now: { index: futs.length, iv: 30_000 },
        });
        const rolls = futRollMarks(futs, input(mode, tick).viewport, m.range);
        return m.candles.length + m.line.length + rolls.length;
      };
      expect(frame()).toBeGreaterThan(1000);
      expectWithinBudget(`#190 先物推移のパン（${mode}）`, frame, { warmup: 10, runs: 30 });
    });
  }

  // #200 AC7: 指標の段 3 つを足したパンの 1 フレーム（指標は足の並びごとに 1 回 = パンでは作り直さない）と、
  // 足の並びが変わったときの指標の計算（1 分足 1 万本）
  it(`#200: 先物推移のパン + 指標の段 3 つ（1 分足 ${futs.length.toLocaleString('en-US')} 本）が ${BUDGET_MS} ms 以内`, () => {
    const ind = indicators(futs);
    let tick = 0;
    const frame = () => {
      tick = (tick + 1) % 40;
      const m = ivChartModel({
        ...input('candle', tick),
        bars: futs,
        segments: futSegments,
        series: FUT_SERIES,
      });
      let n = m.candles.length;
      for (const kind of ['rsi', 'macd', 'stoch'] as const) {
        const pane = indPaneModel({
          ind,
          kind,
          n: futs.length,
          viewport: input('candle', tick).viewport,
          width: 1000,
          marginLeft: FUT_SERIES.marginLeft,
        });
        n += pane.lines.reduce((a, l) => a + l.d.length, 0) + pane.histUp.length;
      }
      return n;
    };
    expect(frame()).toBeGreaterThan(1000);
    expectWithinBudget('#200 先物推移のパン + 段 3 つ', frame, { warmup: 10, runs: 30 });
    expectWithinBudget('#200 指標の計算（1 万本）', () => indicators(futs).rsi.length, {
      warmup: 3,
      runs: 10,
    });
  });

  // #206: EMA の 3 本を重ねたパンの 1 フレーム（EMA は足の並び・期間ごとに 1 回 = パンでは作り直さない）
  it(`#206: 先物推移のパン + EMA の 3 本（1 分足 ${futs.length.toLocaleString('en-US')} 本）が ${BUDGET_MS} ms 以内`, () => {
    const overlays = futEmaOverlays(emaSet(futs.map((b) => b.c)), 1);
    let tick = 0;
    const frame = () => {
      tick = (tick + 1) % 40;
      const m = ivChartModel({
        ...input('candle', tick),
        bars: futs,
        segments: futSegments,
        series: FUT_SERIES,
        overlays,
      });
      return m.candles.length + m.overlays.reduce((a, o) => a + o.d.length, 0);
    };
    expect(frame()).toBeGreaterThan(1000);
    expectWithinBudget('#206 先物推移のパン + EMA の 3 本', frame, { warmup: 10, runs: 30 });
  });

  // #207 AC8: 境目のドラッグの 1 フレーム（高さだけが変わる = 配置 + 価格の描画域を新しい高さで + 段 3 つを新しい高さで。
  // 指標・EMA は作り直さない。DOM 側は requestAnimationFrame で 1 フレーム 1 回）
  it(`#207: 先物推移の境目のドラッグ（1 分足 ${futs.length.toLocaleString('en-US')} 本・段 3 つ・EMA）が ${BUDGET_MS} ms 以内`, () => {
    const ind = indicators(futs);
    const overlays = futEmaOverlays(emaSet(futs.map((b) => b.c)), 1);
    const kinds = ['rsi', 'macd', 'stoch'] as const;
    const stackH = 700;
    const start = futPaneLayout({ stackH, kinds, max: null });
    const viewport = input('candle', 0).viewport;
    let tick = 0;
    const frame = () => {
      tick = (tick + 1) % 60;
      const heights = futPaneDrag(start, tick % 3, (tick % 2 ? -1 : 1) * tick * 3, stackH);
      const layout = futPaneLayout({ stackH, kinds, heights, max: null });
      const m = ivChartModel({
        ...input('candle', 0),
        height: layout.priceH,
        bars: futs,
        segments: futSegments,
        series: FUT_SERIES,
        overlays,
      });
      let n = m.candles.length;
      for (const slot of layout.panes) {
        const pane = indPaneModel({
          ind,
          kind: slot.kind,
          n: futs.length,
          viewport,
          width: 1000,
          marginLeft: FUT_SERIES.marginLeft,
          height: slot.h,
        });
        n += pane.lines.reduce((a, l) => a + l.d.length, 0) + pane.histUp.length;
      }
      return n;
    };
    expect(frame()).toBeGreaterThan(1000);
    expectWithinBudget('#207 先物推移の境目のドラッグ', frame, { warmup: 10, runs: 30 });
  });
});

/**
 * #131 AC17: 証拠金の概算を足した描き直し（足 10 本・幅 1,000px・資金あり）。
 * (1) スライダー 1 回（d・ΔX・Δσ・Δs が毎回変わる）: #6 の計算（グラフの表示モデル + 指標 + テール表）+ 証拠金の
 *     シナリオの点 + テール 5 行 + 指標パネル（タイル・内訳・テールの証拠金の表）。今の証拠金は足・板・β などが変わった
 *     ときだけ（useAppController の memo）、追証の線はスライダーでは作らない（止まってから。useMarginLine）
 * (2) 止まった後の 1 回: 追証の線（板の全域 + 数値欄の範囲の探索）+ 線を入れたグラフの表示モデル（線の値は memo 済み）
 */
describe('性能（#131 AC17: 証拠金と追証の線）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const built = pnlDomains(board, legs, ctx);
  if (!built) throw new Error('損益グラフの基礎が作れない');
  const base = built;
  const { holidays } = CALENDAR;
  const capital = 15_000_000;
  // 全足を評価する重い側（買いの OP でも相殺する。#149 の設定をオフ）で測る
  const params = { ...DEFAULT_MARGIN_PARAMS, ignoreLongOptions: false };
  const scenario0 = { ...ZERO_SCENARIO, days: 5 };
  const today = todayLine(base, null, 1000, scenario0);
  const now = marginNow(base, scenario0, params, capital, holidays);
  let tick = 0;

  function slide(): number {
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
    const mv: MarginView = {
      capital,
      params,
      now,
      point: marginPoint(base, scenario, params, capital, holidays),
      at: marginPointAt(base, scenario),
      tail: marginTail(base, { ...scenario, dX: 0 }, params, capital, holidays),
    };
    const v = metricsPanel(mm, 0, mv);
    return m.lines.length + mm.tail.rows.length + v.tiles.length + mv.tail.length;
  }

  // 止まった後の描き直しでは、指定日の線（dateLine）・今日の線はスライダーの最後のフレームで作った memo のまま
  // （usePnlChartModel）。計測の前（before）に次のシナリオとその指定日の線を用意し、計測には入れない
  const todayFull = todayLine(base, base.full, 1000, scenario0);
  let settleScenario = scenario0;
  let settleDateYs = dateLine(base, base.full, 1000, settleScenario);
  function nextSettle(): void {
    tick = (tick + 1) % 40;
    settleScenario = { ...scenario0, days: 5 + tick * 0.5, dSigma: tick * 0.5 };
    settleDateYs = dateLine(base, base.full, 1000, settleScenario);
  }

  function settle(): number {
    const scenario = settleScenario;
    const xs = marginLine(base, scenario, params, capital, holidays);
    const m = pnlChartModel({
      base,
      scenario,
      // 全域を表示（線が描画域に入る）
      viewport: base.full,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 1000,
      plotHeight: 260,
      todayYs: todayFull,
      dateYs: settleDateYs,
      marginLine: xs,
    });
    return xs.length + m.marginCalls.length;
  }

  it(`スライダー 1 回（#6 + 証拠金のシナリオの点・テール 5 行・指標パネル）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(slide()).toBeGreaterThan(8);
    expectWithinBudget('#131 スライダー 1 回（証拠金つき）', slide, { warmup: 20, runs: 30 });
  });

  it(`止まった後の 1 回（追証の線 + グラフの表示モデル）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    // 資金 1,500 万円で線が板の全域（描画域）の中に出る形（線が無い = 探索だけ、では測らない）
    const xs = marginLine(base, scenario0, params, capital, holidays);
    expect(xs.length).toBeGreaterThan(0);
    expect(settle()).toBeGreaterThan(1);
    expectWithinBudget('#131 追証の線（止まった後）', settle, {
      warmup: 10,
      runs: 30,
      before: nextSettle,
    });
  });
});

/**
 * #152 B8: 追証マップの 1 列（足 10 本・全足を評価する側・21 マス）。画面は列ごとに setTimeout(0) で回すので、
 * 1 列が 1 フレーム（16 ms）に収まること。マップ全体（26 列）は記録だけ。
 */
describe('性能（#152 追証マップ）', () => {
  const { ctx, rows } = makeMarket();
  const legs = preparePosition(PERF_LEGS, ctx);
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const built = pnlDomains(board, legs, ctx);
  if (!built) throw new Error('損益グラフの基礎が作れない');
  // 全足を評価する重い側（買いの OP でも相殺する。#149 の設定をオフ）
  const params = { ...DEFAULT_MARGIN_PARAMS, ignoreLongOptions: false };
  const input = holdMapInput(
    built,
    { ...ZERO_SCENARIO, days: 5 },
    params,
    15_000_000,
    CALENDAR.holidays,
  );
  if (!input) throw new Error('マップの入力が作れない');
  const calc = holdMapCalcOf(input);
  const axes = holdMapAxes([]);
  let col = 0;

  it(`#152 追証マップの 1 列（21 マス）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(axes.cs).toHaveLength(21);
    // 1 列 = 余力と損益（#180。useHoldMap と同じ単位）
    const one = () => {
      col = (col + 1) % axes.us.length;
      const rooms = holdMapColumn(calc, axes, col);
      const pnls = holdMapPnlColumn(calc, axes, col);
      return rooms.length === pnls.length ? rooms.length : -1;
    };
    expect(one()).toBe(21);
    expectWithinBudget('#152 追証マップの 1 列', one, { warmup: 10, runs: 30 });
  });

  it('マップ全体（26 列 × 21 行）と描画の表示モデル（記録のみ）', () => {
    record('#152 追証マップ全体', () => holdMapResultOf(input, axes).rooms.length, {
      warmup: 1,
      runs: RECORD_RUNS,
    });
    const result = holdMapResultOf(input, axes);
    const moves = Array.from({ length: 1800 }, (_, k) => ({
      d0: '2031-01-01',
      d1: '2031-01-03',
      dx: Math.sin(k) * 0.05,
      iv0: 20,
      iv1: 20 * (1 + Math.cos(k) * 0.2),
      ivRatio: 1 + Math.cos(k) * 0.2,
      ivPt: 4 * Math.cos(k),
    }));
    record(
      '#152 追証マップの描画（点 1,800）',
      () => holdMapPlot(result, moves, 400, 1_000_000).cells.length,
      {
        warmup: 2,
        runs: RECORD_RUNS,
      },
    );
  });
});

/**
 * #135: AI のツールの事前計算（[このポジションを診断] を押してから送るまでのブラウザの計算）と、流れの文の描き直しの計算。
 * 足 10 本・322 行 × 2 限月の板・資金あり（追証の水準まで）。事前計算は 300 ms 未満（K15・計画 D10。BUDGET_MS に
 * 依らない固定の閾値）、返答の文（約 1,200 字）の木と数字の照合は描き直しの予算（BUDGET_MS）以内。
 */
describe('性能（#135 AI の事前計算と返答の描き直し）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が無い');
  const add = (expiry: string, k: number, optionType: 'put' | 'call', side: 'buy' | 'sell') =>
    ({ type: 'addBoardLeg', expiry, k, optionType, side }) as Action;
  let s: State = reduce(initialState, { type: 'loaded', chain, label: 'wide' });
  for (const a of [
    add(m1.id, 64000, 'put', 'sell'),
    add(m1.id, 70500, 'call', 'sell'),
    add(m1.id, 60000, 'put', 'buy'),
    add(m1.id, 73000, 'call', 'buy'),
    add(m1.id, 55000, 'put', 'sell'),
    add(m2.id, 62500, 'put', 'sell'),
    add(m2.id, 72500, 'call', 'sell'),
    add(m2.id, 60000, 'put', 'buy'),
    add(m2.id, 75000, 'call', 'buy'),
    add(m2.id, 67500, 'call', 'buy'),
  ]) {
    s = reduce(s, a);
  }
  const env = aiEnvFromState(s, { ...DEFAULT_MARGIN_PREFS, capitalYen: 10_000_000 });
  if (!env?.base) throw new Error('ツールの環境が無い');
  const e = env;

  it('事前計算 5 本 + 文脈の組み立てが 300 ms 未満（10 回の最小値）', () => {
    expect(e.base?.legs).toHaveLength(10);
    const r = record('#135 事前計算 5 本 + 文脈', () => buildAiContext(e), {
      warmup: 2,
      runs: 10,
    });
    expect(r.min).toBeLessThan(300);
  });

  it(`返答 10 件の会話の流れの 1 フレーム（表示の項目 + 流れている返答の木と照合）が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const ctx = buildAiContext(e);
    const para =
      '−10% の SQ で −1,234 千円、IV が +5pt なら −617 千円。Δ は −0.45 枚（ミニ −4.5 枚）です。';
    const reply = Array.from(
      { length: 5 },
      (_, i) => `## 弱点 ${i + 1}: 見出し\n${para}\n${para}\n${para}`,
    ).join('\n');
    const messages: AiMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `質問 ${i}` }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
    }
    let chat: AiChatState = { ...INITIAL_AI_CHAT, context: ctx, lastKey: 'k', messages };
    chat = aiChatReduce(chat, { type: 'begin', kind: 'chat', text: '続けて', now: 0 });
    chat = aiChatReduce(chat, { type: 'send', context: ctx, key: 'k' });
    const sources = numberSources(chat);
    // 終わった返答の木と印は画面が (text, sources) で memo する（1 回だけ作る）
    const done = new Map<string, unknown>();
    const memo = (text: string) => {
      if (!done.has(text)) done.set(text, answerModel(text, sources));
      return done.get(text);
    };
    for (const it of chatItems(chat)) if (it.kind === 'answer') memo(it.text);
    let live = '';
    expectWithinBudget(
      '#135 返答 10 件の会話の流れの 1 フレーム',
      () => {
        live += `${para}\n`;
        chat = aiChatReduce(chat, { type: 'event', event: { type: 'text', text: `${para}\n` } });
        let n = 0;
        for (const it of chatItems(chat)) {
          if (it.kind !== 'answer') continue;
          n += it.live ? answerModel(it.text, sources).length : memo(it.text) ? 1 : 0;
        }
        return n + live.length;
      },
      { warmup: 5, runs: 30 },
    );
    // memo しない場合（全部の返答を毎フレーム作り直す）は記録だけ
    record(
      '#135 返答 10 件を毎フレーム作り直した場合（記録のみ）',
      () =>
        chatItems(chat).reduce(
          (n, it) => n + (it.kind === 'answer' ? answerModel(it.text, sources).length : 0),
          0,
        ),
      { warmup: 2, runs: RECORD_RUNS },
    );
  });

  it(`返答の文（約 1,200 字）の木と数字の照合が ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    const ctx = buildAiContext(e);
    const para =
      '−10% の SQ で −1,234 千円、IV が +5pt なら −617 千円。Δ は −0.45 枚（ミニ −4.5 枚）です。';
    const text = Array.from(
      { length: 5 },
      (_, i) => `## 弱点 ${i + 1}: 見出し\n${para}\n${para}\n${para}`,
    ).join('\n');
    expect(text.length).toBeGreaterThan(1000);
    expectWithinBudget(
      '#135 返答の木 + 数字の照合',
      () =>
        parseAiText(text).reduce(
          (n, b) =>
            n +
            (b.kind === 'p' || b.kind === 'h'
              ? b.inl.reduce((m, x) => m + markNumbers(x.text, [ctx]).length, 0)
              : 0),
          0,
        ),
      { warmup: 5, runs: 30 },
    );
  });

  it(`表と用語を含む返答（約 1,200 字）の answerModel が ${BUDGET_MS} ms 以内（30 回の最小値。#232・#234）`, () => {
    const ctx = buildAiContext(e);
    const para = 'IV が上がると Δσ と β の分だけ損が膨らみ、必要証拠金も増えて追証の線に近づく。';
    const table = [
      '| 足 | 今の建値 | 今の板で建てた場合の建値 |',
      '|---|---|---|',
      ...Array.from(
        { length: 4 },
        () => '| P 62,000 の売り（IV の高い足） | 125 円 | −1,234 千円 |',
      ),
    ].join('\n');
    const text = Array.from(
      { length: 4 },
      (_, i) => `## 弱点 ${i + 1}: 見出し\n${para}\n${table}\n${para}`,
    ).join('\n');
    expect(text.length).toBeGreaterThan(1000);
    expectWithinBudget(
      '#232・#234 表と用語を含む返答の answerModel',
      () => answerModel(text, [ctx], true).length,
      { warmup: 5, runs: 30 },
    );
  });
});

/**
 * #163: スマイルに重ねる売りの効率の線。322 行の板の行の多い限月で、シナリオの点と今の 2 本の点（行使価格ごとに
 * Black-76 と証拠金の格子 30 点）+ 縦軸 + path の作り直しが予算以内。スライダーの連続の操作の間は作らず、止まってから
 * 1 回（ui/components/useSmileEffLine.ts）なので、これはその 1 回（と線を重ねた初回）の重さ
 */
describe('性能（#163 売りの効率の線）', () => {
  const chain = normalizeChain(buildWideChainJson());
  const month = [...chain.months].sort((a, b) => b.strikes.length - a.strikes.length)[0];
  if (!month) throw new Error('合成の板に限月が無い');
  const base: SmileEffBase = {
    ctx: buildMarketContext(chain, { atmBasis: 'B' }),
    settings: DEFAULT_SETTINGS,
    params: DEFAULT_MARGIN_PARAMS,
    holidays: CALENDAR.holidays,
  };
  const model = smileModel(month, 'B', 'k');
  const sc = { ...ZERO_SCENARIO, days: 3, dX: -1500, dSigma: 8, skew: 1 };

  it(`シナリオの点と今の 2 本の作り直しが ${BUDGET_MS} ms 以内（30 回の最小値）`, () => {
    expect(month.strikes.length).toBeGreaterThan(150);
    expectWithinBudget(
      '#163 売りの効率の線 2 本',
      () => {
        const a = smileEffPoints(month, 'B', 'k', base, sc);
        const b = smileEffPoints(month, 'B', 'k', base, EFF_NOW_SCENARIO);
        const y = smileEffYDomain([a, b], model.domain);
        return y ? smileEffPath(a, model.domain, y, 480, 260).length + b.length : 0;
      },
      { warmup: 5, runs: 30 },
    );
  });
});

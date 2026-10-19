import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  businessDaysAhead,
  DAY_MS,
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  MARGIN_HORIZON_BUSINESS_DAYS,
  MARGIN_LINE_SAMPLES,
  type ModelSettings,
  marginAt,
  marginRoom,
  premiumSummary,
  TAIL_SHOCKS,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { PIN_SETTLE_MS } from '../../ui/pins';
import { DEFAULT_MARGIN_PREFS, type MarginPrefs } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { DASH, fmtNum } from '../../ui/view/format';
import {
  capitalOf,
  MARGIN_LINE_OUTER_SAMPLES,
  MARGIN_LINE_SETTLE_MS,
  type MarginView,
  marginCalc,
  marginLine,
  marginLineRanges,
  marginNow,
  marginParamsOf,
  marginPoint,
  marginTail,
} from '../../ui/view/margin';
import { fmtAmount, type MetricsModel, metricsModel } from '../../ui/view/metrics';
import {
  amountText,
  ivScaleText,
  MARGIN_CALL_MARK,
  MARGIN_GROUP_LABEL,
  MARGIN_HINT,
  MARGIN_TAIL_TITLE,
  MARGIN_TILE_LABEL,
  type MetricTile,
  marginParamsText,
  marginTailRows,
  metricsBreakdown,
  metricsPanel,
  metricTiles,
  multipleText,
  ROOM_NO_CAPITAL_TEXT,
  ROOM_TILE_LABEL,
} from '../../ui/view/metricsPanel';
import {
  DEFAULT_PNL_Y,
  MARGIN_CALL_LABEL_PX,
  type PnlBase,
  pnlChartModel,
  pnlDomains,
  scenarioFull,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { DX_INPUT_MAX_RATIO, DX_INPUT_MIN_RATIO } from '../../ui/view/scenario';
import { labelWidth, scenarioMarks } from '../../ui/view/scenarioMarks';
import {
  MARGIN_CALL_LABEL_DY,
  MARGIN_CALL_TEXT,
  marginCallLabels,
  stageMarkLabels,
} from '../../ui/view/stage';
import { fixture } from '../support/fixtures';
import { SUB_MAX_UNITS, widthUnits } from '../support/widthUnits';

/** #131 AC14: 証拠金の概算の表示モデル（タイル・内訳・テールの証拠金の表）。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1] = chain.months;
if (!m1) throw new Error('限月が無い');
const { holidays } = CALENDAR;

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = (c: Chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'latest' });
const add = (k: number, optionType: 'put' | 'call', side: 'buy' | 'sell'): Action => ({
  type: 'addBoardLeg',
  expiry: m1.id,
  k,
  optionType,
  side,
});

function baseOf(s: State): PnlBase {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

const metricsOf = (s: State): MetricsModel =>
  metricsModel({ base: baseOf(s), scenario: s.scenario, unit: s.metricsUnit });

/** useAppController と同じ組み立て（今・シナリオの点・テール） */
function viewOf(s: State, prefs: MarginPrefs): MarginView {
  const base = baseOf(s);
  const params = marginParamsOf(prefs);
  const capital = capitalOf(prefs);
  const tailScenario = { ...s.scenario, dX: 0 };
  return {
    capital,
    params,
    now: marginNow(base, s.scenario, params, capital, holidays),
    point: marginPoint(base, s.scenario, params, capital, holidays),
    tail: marginTail(base, tailScenario, params, capital, holidays),
  };
}

const withCapital = (c: number | null): MarginPrefs => ({ ...DEFAULT_MARGIN_PREFS, capitalYen: c });

const tile = (tiles: MetricTile[], key: MetricTile['key']) => {
  const t = tiles.find((x) => x.key === key);
  if (!t) throw new Error(`タイル ${key} が無い`);
  return t;
};

// 足の組（架空の値）
/** put 売り 1 枚（ATM 近く） */
const putSell = run(loaded(chain), add(67_750, 'put', 'sell'));
/** put 売り + シナリオ（下落・IV 上げ） */
const putSellDown = run(putSell, {
  type: 'setScenario',
  patch: { days: 1, dX: -3000, dSigma: 5 },
});
/** 買いだけ（call 買い + put 買い、手数料 300 円 / 枚） */
const buyOnly = run(loaded(chain), add(71_000, 'call', 'buy'), add(64_000, 'put', 'buy'), {
  type: 'setFee',
  fee: 300,
});
/** 売り 5 枚・円固定 */
const putSell5Yen = run(
  putSell,
  { type: 'editLeg', id: 1, patch: { qty: 5 } },
  { type: 'setMetricsUnit', unit: 'yen' },
);

describe('計算の単位（ui/view/margin.ts）', () => {
  it('設定 → model の単位、資金の未設定・0 は null', () => {
    expect(marginParamsOf(DEFAULT_MARGIN_PREFS)).toEqual(DEFAULT_MARGIN_PARAMS);
    expect(
      marginParamsOf({
        capitalYen: 1,
        factorPct: 150,
        rangePct: 10.5,
        ivUpPct: 12,
        ivDownPct: 0,
        ignoreLongOptions: false,
      }),
    ).toEqual({ range: 0.105, ivUp: 0.12, ivDown: 0, factor: 1.5, ignoreLongOptions: false });
    expect(capitalOf(DEFAULT_MARGIN_PREFS)).toBeNull();
    expect(capitalOf(withCapital(0))).toBeNull();
    expect(capitalOf(withCapital(Number.NaN))).toBeNull();
    expect(capitalOf(withCapital(12_345_678))).toBe(12_345_678);
  });

  it('シナリオの点・今は model の marginAt / marginRoom と同じ値（h = 2 営業日、d は clampDays）', () => {
    const base = baseOf(putSellDown);
    const capital = 20_000_000;
    const sc = putSellDown.scenario;
    const point = marginPoint(base, sc, DEFAULT_MARGIN_PARAMS, capital, holidays);
    if (!point) throw new Error('点が無い');
    const x = base.ctx.x0 + sc.dX;
    const h = businessDaysAhead(
      base.ctx.evalTime + sc.days * DAY_MS,
      MARGIN_HORIZON_BUSINESS_DAYS,
      holidays,
    );
    const r = marginAt(
      base.legs,
      { x, scenario: { ...sc, dX: sc.dX }, horizonDays: h },
      base.ctx,
      base.settings,
      DEFAULT_MARGIN_PARAMS,
    );
    expect(point.x).toBe(x);
    expect(point.result).toEqual(r);
    expect(point.room).toBe(marginRoom(capital, premiumSummary(base.legs, base.settings), r));
    // 今: X₀・d = Δσ = 0
    const now = marginNow(base, sc, DEFAULT_MARGIN_PARAMS, capital, holidays);
    const zero = marginPoint(
      base,
      { ...sc, days: 0, dX: 0, dSigma: 0, skew: 0 },
      DEFAULT_MARGIN_PARAMS,
      capital,
      holidays,
    );
    expect(now).toEqual(zero);
    // シナリオで下落・IV 上げ → 必要証拠金が増え余力が減る
    if (!now || now.room === null || point.room === null) throw new Error('余力が無い');
    expect(point.result.margin).toBeGreaterThan(now.result.margin);
    expect(point.room).toBeLessThan(now.room);
  });

  it('テールの各行は X₀ × (1 + 下落率)（テール表と同じ行）', () => {
    const base = baseOf(putSell);
    const rows = marginTail(base, putSell.scenario, DEFAULT_MARGIN_PARAMS, null, holidays);
    expect(rows.map((r) => r.shock)).toEqual([...TAIL_SHOCKS]);
    for (const r of rows) {
      expect(r.x).toBeCloseTo(base.ctx.x0 * (1 + r.shock), 9);
      expect(r.calc?.room).toBeNull();
      expect(r.calc?.multiple).toBeNull();
    }
    // 下落ほど put 売りの証拠金所要額は増える（#150: 必要証拠金 = k × PFE は深い ITM で R × X に近づき
    // X とともに小さくなりうるので、単調なのは NOV を含む所要額）。必要証拠金はどの行も > 0
    const reqs = rows.map((r) => r.calc?.result.requirement ?? Number.NaN);
    for (let i = 1; i < reqs.length; i++) expect(reqs[i]).toBeGreaterThan(reqs[i - 1] as number);
    for (const r of rows) expect(r.calc?.result.margin).toBeGreaterThan(0);
  });

  it('原資産が有限でない・0 以下なら null（表示は —。レビュー段 A 指摘 1）', () => {
    const base = baseOf(putSell);
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(
        marginCalc(base, x, putSell.scenario, DEFAULT_MARGIN_PARAMS, 1e7, holidays),
      ).toBeNull();
    }
    const nanPoint = marginPoint(
      base,
      { ...putSell.scenario, dX: Number.NaN },
      DEFAULT_MARGIN_PARAMS,
      1e7,
      holidays,
    );
    // ΔX が NaN なら指標と同じく 0 とみなす（今と同じ点）
    expect(nanPoint?.x).toBe(base.ctx.x0);
    const m = metricsOf(putSell);
    const mv: MarginView = {
      capital: 1e7,
      params: DEFAULT_MARGIN_PARAMS,
      now: null,
      point: null,
      tail: [],
    };
    const tiles = metricTiles(m, mv);
    expect(tile(tiles, 'margin').v).toBe(DASH);
    expect(tile(tiles, 'margin').unit).toBe('');
    expect(tile(tiles, 'room').v).toBe(DASH);
    expect(tile(tiles, 'room').tone).toBeNull();
  });
});

describe('タイル（#131 AC14）', () => {
  it('タイル 8 枚: 証拠金の 2 枚は末尾、見出しに「概算」', () => {
    const m = metricsOf(putSell);
    const tiles = metricTiles(m, viewOf(putSell, withCapital(20_000_000)));
    expect(tiles).toHaveLength(8);
    expect(tiles.slice(6).map((t) => t.key)).toEqual(['margin', 'room']);
    expect(tile(tiles, 'margin').k).toBe(MARGIN_TILE_LABEL);
    expect(tile(tiles, 'room').k).toBe(ROOM_TILE_LABEL);
    for (const t of tiles.slice(6)) expect(t.k).toContain('概算');
    expect(MARGIN_GROUP_LABEL).toContain('概算');
    expect(MARGIN_TAIL_TITLE).toContain('概算');
    expect(MARGIN_HINT).toContain('概算');
    expect(MARGIN_HINT).toContain('JSCC');
    expect(MARGIN_HINT).toContain('NOV');
    expect(MARGIN_HINT).toContain('答え合わせ');
    expect(MARGIN_HINT).toContain('未確認');
    expect(MARGIN_HINT).not.toContain('仮置き');
  });

  it('資金あり: 値 = シナリオの点、副題 = 今の余力 · 倍数。余力 ≥ 0 は無色（利益の色にしない）', () => {
    const m = metricsOf(putSellDown);
    const u = m.unit;
    expect(u).toBe('thousand');
    const mv = viewOf(putSellDown, withCapital(50_000_000));
    const { now, point } = mv;
    if (!now || !point || now.room === null || point.room === null) throw new Error('値が無い');
    const tiles = metricTiles(m, mv);
    const tm = tile(tiles, 'margin');
    // #150: タイルの値 = シナリオ点の必要証拠金 = k × PFE（NOV を含まない）
    expect(point.result.margin).toBeCloseTo(mv.params.factor * point.result.pfe, 6);
    expect(point.result.requirement).toBeCloseTo(point.result.margin - point.result.nov, 6);
    expect(tm.v).toBe(fmtAmount(point.result.margin, u));
    expect(tm.unit).toBe('千円');
    expect(tm.s).toBe(`今 ${fmtAmount(now.result.margin, u)}`);
    expect(tm.tone).toBeNull();
    const tr = tile(tiles, 'room');
    expect(point.room).toBeGreaterThan(0);
    expect(tr.v).toBe(fmtAmount(point.room, u));
    expect(tr.tone).toBeNull();
    expect(now.multiple).not.toBeNull();
    expect(Number.isFinite(now.multiple)).toBe(true);
    expect(tr.s).toBe(`今 ${fmtAmount(now.room, u)} · ${fmtNum(now.multiple)} 倍`);
    // 全文: 1 行目は見出し + 値、前提の行
    expect(tm.full[0]).toEqual({ k: MARGIN_TILE_LABEL, v: `${tm.v} 千円` });
    expect(tr.full[0]).toEqual({ k: ROOM_TILE_LABEL, v: `${tr.v} 千円` });
    expect(tm.full.slice(-5)).toEqual([
      { k: '値動き幅 R', v: '±5%' },
      { k: 'IV の幅', v: '×1.5 / ×0.75' },
      { k: '保有期間', v: '2 営業日' },
      { k: '掛け目', v: '100%' },
      { k: '買いの OP', v: '減らさない' },
    ]);
    expect(marginParamsText(mv.params)).toBe(
      'R ±5% · IV ×1.5 / ×0.75 · 2 営業日 · 掛け目 100% · 買い OP 除く',
    );
    // 最悪の点（PFE > 0 の put 売り）: 下落・IV ×1.5
    expect(point.result.pfe).toBeGreaterThan(0);
    const wi = tm.full.findIndex((r) => r.k === '最悪の点');
    expect(wi).toBeGreaterThan(0);
    expect(tm.full[wi]?.v).toBe('X −5.0%');
    expect(tm.full[wi + 1]).toEqual({ k: '', v: 'IV ×1.5' });
    expect(tm.full[wi + 2]?.v).toMatch(/^経過 \+\d+ 日$/);
  });

  it('余力 < 0: 値は − 付き、tone loss（警告の色）', () => {
    const m = metricsOf(putSellDown);
    const mv = viewOf(putSellDown, withCapital(1_000_000));
    const room = mv.point?.room ?? Number.NaN;
    expect(room).toBeLessThan(0);
    const tr = tile(metricTiles(m, mv), 'room');
    expect(tr.v.startsWith('−')).toBe(true);
    expect(tr.tone).toBe('loss');
  });

  it('資金なし: 余力は —（単位なし）、副題は設定への案内、全文の余力・倍数も —', () => {
    const m = metricsOf(putSell);
    const mv = viewOf(putSell, withCapital(null));
    const tiles = metricTiles(m, mv);
    const tr = tile(tiles, 'room');
    expect(tr.v).toBe(DASH);
    expect(tr.unit).toBe('');
    expect(tr.s).toBe(ROOM_NO_CAPITAL_TEXT);
    expect(tr.tone).toBeNull();
    expect(tr.full.find((r) => r.k === '余力（今）')?.v).toBe(DASH);
    expect(tr.full.find((r) => r.k === '倍数（今）')?.v).toBe(DASH);
    // 必要証拠金は資金に依らず出る
    const tm = tile(tiles, 'margin');
    expect(tm.v).toBe(fmtAmount(mv.point?.result.margin ?? Number.NaN, m.unit));
    expect(tm.v).not.toBe(DASH);
  });

  it('円固定: 円の整数で、単位は「円」', () => {
    const m = metricsOf(putSell5Yen);
    expect(m.unit).toBe('yen');
    const mv = viewOf(putSell5Yen, withCapital(200_000_000));
    const tiles = metricTiles(m, mv);
    const tm = tile(tiles, 'margin');
    expect(tm.unit).toBe('円');
    expect(tm.v).toBe(fmtAmount(mv.point?.result.margin ?? Number.NaN, 'yen'));
    expect(tm.v).toMatch(/^[0-9,]+$/);
    // 5 枚は 1 枚の 5 倍（枚数に比例）
    const one = viewOf(putSell, withCapital(200_000_000)).point?.result.margin ?? Number.NaN;
    expect(mv.point?.result.margin).toBeCloseTo(5 * one, 3);
  });

  it('買いだけ（既定 = 買いの OP で減らさない）: 必要証拠金・所要額 0、余力 = 資金 − 支払 − 手数料、倍数は有限、最悪の点の行は出さない（M = 0）', () => {
    const m = metricsOf(buyOnly);
    const capital = 3_000_000;
    const mv = viewOf(buyOnly, withCapital(capital));
    const p = mv.point;
    if (!p || p.room === null) throw new Error('値が無い');
    expect(p.result.margin).toBe(0);
    expect(p.result.requirement).toBe(0);
    expect(p.result.pfe).toBeLessThanOrEqual(p.result.nov);
    const prem = m.premium;
    expect(prem.fees).toBeGreaterThan(0);
    expect(Math.abs(p.room - (capital - prem.paid - prem.fees))).toBeLessThan(1);
    const tiles = metricTiles(m, mv);
    expect(tile(tiles, 'margin').v).toBe(fmtAmount(0, m.unit));
    expect(tile(tiles, 'margin').full.some((r) => r.k.startsWith('最悪の点'))).toBe(false);
    expect(mv.now?.multiple).toBe(Math.floor(capital / (prem.paid + prem.fees)));
  });

  it('副題が幅の単位 27 以下（資金あり・なし、千円・円）', () => {
    for (const [s, c] of [
      [putSellDown, 50_000_000],
      [putSellDown, null],
      [putSell5Yen, 200_000_000],
      [buyOnly, 3_000_000],
    ] as const) {
      const m = metricsOf(s);
      for (const t of metricTiles(m, viewOf(s, withCapital(c))).slice(6)) {
        expect(widthUnits(t.s), `${t.key}: ${t.s}`).toBeLessThanOrEqual(SUB_MAX_UNITS);
      }
    }
  });

  it('倍数の文字列: 上限なし / N 倍 / —、前提の文字列（端数は小数 1 桁）', () => {
    expect(multipleText(Number.POSITIVE_INFINITY)).toBe('上限なし');
    expect(multipleText(3)).toBe('3 倍');
    expect(multipleText(12_345)).toBe('12,345 倍');
    expect(multipleText(null)).toBe(DASH);
    expect(multipleText(Number.NaN)).toBe(DASH);
    expect(
      marginParamsText({
        range: 0.105,
        ivUp: 0.125,
        ivDown: 0,
        factor: 1.5,
        ignoreLongOptions: false,
      }),
    ).toBe('R ±10.5% · IV ×1.125 / ×1 · 2 営業日 · 掛け目 150%');
    // #150: 倍率の文字列（小数 3 桁で丸めて末尾の 0 を落とす）
    expect(ivScaleText(1.5)).toBe('×1.5');
    expect(ivScaleText(0.75)).toBe('×0.75');
    expect(ivScaleText(1)).toBe('×1');
    expect(ivScaleText(1 - 0.9)).toBe('×0.1');
    expect(ivScaleText(1.33333)).toBe('×1.333');
    expect(
      marginParamsText({ range: 0.05, ivUp: 0, ivDown: 0, factor: 1, ignoreLongOptions: true }),
    ).toBe('R ±5% · IV ×1 / ×1 · 2 営業日 · 掛け目 100% · 買い OP 除く');
  });
});

describe('内訳とテールの証拠金の表（#131 AC14）', () => {
  it('内訳に証拠金の群（タイルの全文と同じ行）。証拠金なしなら群を出さない', () => {
    const m = metricsOf(putSellDown);
    const mv = viewOf(putSellDown, withCapital(50_000_000));
    const bd = metricsBreakdown(m, mv);
    const gi = bd.findIndex((r) => r.group && r.k === MARGIN_GROUP_LABEL);
    expect(gi).toBeGreaterThan(0);
    const rows = bd.slice(gi + 1).map((r) => ({ k: r.k, v: r.v }));
    const tm = tile(metricTiles(m, mv), 'margin');
    expect(rows).toEqual(tm.full.slice(1));
    // #150: 必要証拠金・NOV・証拠金所要額・余力 × シナリオ点 / 今（PFE の行は出さない）
    expect(rows.map((r) => r.k).slice(0, 9)).toEqual([
      '必要証拠金（シナリオ点）',
      'NOV（シナリオ点）',
      '証拠金所要額（シナリオ点）',
      '余力（シナリオ点）',
      '必要証拠金（今）',
      'NOV（今）',
      '証拠金所要額（今）',
      '余力（今）',
      '倍数（今）',
    ]);
    expect(rows.map((r) => r.k)).not.toContain('PFE（今）');
    const pt = mv.point?.result;
    if (!pt) throw new Error('値が無い');
    expect(rows[2]?.v).toBe(amountText(pt.requirement, m.unit));
    expect(metricsBreakdown(m).some((r) => r.k === MARGIN_GROUP_LABEL)).toBe(false);
  });

  it('テールの証拠金の表: 5 行、余力 < 0 の行は loss + 追証の印、≥ 0 は無色', () => {
    const m = metricsOf(putSell);
    // 今は余力 > 0、深い下落で負になる資金（架空）
    const probe = viewOf(putSell, withCapital(1e9));
    const nowM = probe.now?.result.margin ?? 0;
    const capital = Math.round(nowM * 2);
    const mv = viewOf(putSell, withCapital(capital));
    const rows = marginTailRows(m, mv);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.key)).toEqual([...TAIL_SHOCKS]);
    for (const [i, r] of rows.entries()) {
      const calc = mv.tail[i]?.calc;
      if (!calc || calc.room === null) throw new Error('値が無い');
      expect(r.margin).toBe(fmtAmount(calc.result.margin, m.unit));
      expect(r.room).toBe(fmtAmount(calc.room, m.unit));
      expect(r.call).toBe(calc.room < 0);
      expect(r.tone).toBe(calc.room < 0 ? 'loss' : null);
      expect(r.x).toBe(fmtNum(mv.tail[i]?.x ?? Number.NaN));
    }
    expect(rows.some((r) => r.call)).toBe(true);
    expect(rows.some((r) => !r.call)).toBe(true);
    expect(MARGIN_CALL_MARK).toBe('追証');
    // パネル全体: 表と注記
    const view = metricsPanel(m, 0, mv);
    expect(view.marginTail).toEqual(rows);
    expect(view.marginTailCaption).toContain('R ±5% · IV ×1.5 / ×0.75');
    expect(view.marginTailCaption).not.toContain('設定…');
  });

  it('資金なし: 余力の列は —、追証の印は出さない、注記に設定への案内。証拠金なし・空なら表は空', () => {
    const m = metricsOf(putSell);
    const mv = viewOf(putSell, withCapital(null));
    const rows = marginTailRows(m, mv);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.room).toBe(DASH);
      expect(r.call).toBe(false);
      expect(r.tone).toBeNull();
      expect(r.margin).not.toBe(DASH);
    }
    expect(metricsPanel(m, 0, mv).marginTailCaption).toContain('資金は ⋯ > 設定…');
    expect(marginTailRows(m, null)).toEqual([]);
    const empty = metricsModel({ base: null, scenario: putSell.scenario, unit: 'auto' });
    expect(metricsPanel(empty, 0, mv).marginTail).toEqual([]);
    expect(metricsPanel(empty, 0, mv).tiles).toEqual([]);
  });
});

describe('追証の線（#131 AC16）', () => {
  const base = baseOf(putSell);
  const { x0 } = base.ctx;
  const sc = putSell.scenario;
  const roomAt = (b: PnlBase, x: number, capital: number, scenario = sc) =>
    marginCalc(b, x, scenario, DEFAULT_MARGIN_PARAMS, capital, holidays)?.room ?? Number.NaN;
  const chart = (line: readonly number[], viewport: [number, number] | null = null) =>
    pnlChartModel({
      base,
      scenario: sc,
      viewport,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: 600,
      plotHeight: 220,
      marginLine: line,
    });

  it('資金ありの put 売り: X₀ より下に 1 本、両側 1 円で余力の符号が変わる。表示モデルが x と画素を返す', () => {
    const capital = 12_000_000;
    const xs = marginLine(base, sc, DEFAULT_MARGIN_PARAMS, capital, holidays);
    expect(xs).toHaveLength(1);
    const x = xs[0] as number;
    expect(x).toBeLessThan(x0);
    expect(Number.isInteger(x)).toBe(true);
    expect(Math.sign(roomAt(base, x - 1, capital))).not.toBe(
      Math.sign(roomAt(base, x + 1, capital)),
    );
    expect(roomAt(base, x - 1, capital)).toBeLessThan(0);
    // 表示モデル: 表示範囲（全域）の中なら x と画素、札は線の右
    const m = chart(xs, [x - 5000, x + 5000]);
    expect(m.marginCalls).toHaveLength(1);
    const c = m.marginCalls[0];
    expect(c?.x).toBe(x);
    expect(c?.px).toBeCloseTo(m.plot.left + m.plot.width / 2, 6);
    expect(c?.anchor).toBe('start');
  });

  it('資金なしでは線を返さない（表示モデルも空）。余力がどこでも正なら空', () => {
    expect(marginLine(base, sc, DEFAULT_MARGIN_PARAMS, null, holidays)).toEqual([]);
    expect(chart([]).marginCalls).toEqual([]);
    // 入力の無い呼び出し（今までの呼び方）も空
    expect(
      pnlChartModel({
        base,
        scenario: sc,
        viewport: null,
        pnlY: DEFAULT_PNL_Y,
        plotWidth: 600,
        plotHeight: 220,
      }).marginCalls,
    ).toEqual([]);
    // 買いだけ: 必要証拠金 0・余力 = 資金 − 支払 − 手数料 > 0（全域で正）
    const buy = baseOf(buyOnly);
    expect(marginLine(buy, buyOnly.scenario, DEFAULT_MARGIN_PARAMS, 50_000_000, holidays)).toEqual(
      [],
    );
  });

  it('資金を減らすと線が上がる（3 段で単調）。ストラングル売りは両側に 1 本ずつ', () => {
    const lines = [20_000_000, 12_000_000, 8_000_000].map(
      (c) => marginLine(base, sc, DEFAULT_MARGIN_PARAMS, c, holidays)[0] as number,
    );
    expect(lines[0]).toBeLessThan(lines[1] as number);
    expect(lines[1]).toBeLessThan(lines[2] as number);
    const strangle = run(putSell, add(70_000, 'call', 'sell'));
    const b2 = baseOf(strangle);
    const xs = marginLine(b2, strangle.scenario, DEFAULT_MARGIN_PARAMS, 12_000_000, holidays);
    expect(xs).toHaveLength(2);
    expect(xs[0]).toBeLessThan(b2.ctx.x0);
    expect(xs[1]).toBeGreaterThan(b2.ctx.x0);
  });

  it('ΔX に依らない（ΔX 以外のシナリオで作る）。d・Δσ を変えると線が動く', () => {
    const capital = 12_000_000;
    const a = marginLine(base, sc, DEFAULT_MARGIN_PARAMS, capital, holidays);
    const b = marginLine(base, { ...sc, dX: -9000 }, DEFAULT_MARGIN_PARAMS, capital, holidays);
    expect(b).toEqual(a);
    const up = { ...sc, days: 3, dSigma: 10 };
    const c = marginLine(base, up, DEFAULT_MARGIN_PARAMS, capital, holidays);
    expect(c).toHaveLength(1);
    // IV を上げると put 売りの余力が減る → 線が上がる
    expect(c[0]).toBeGreaterThan(a[0] as number);
    // その状態で両側の符号が変わる（指定日 + シナリオの曲線）
    const x = c[0] as number;
    expect(Math.sign(roomAt(base, x - 1, capital, up))).not.toBe(
      Math.sign(roomAt(base, x + 1, capital, up)),
    );
  });

  it('探索範囲は板の全域 + ΔX の数値欄が届く範囲（#144）。板の外の線も見つける', () => {
    const rs = marginLineRanges(base);
    const [bLo, bHi] = base.boardFull;
    expect(rs.map((r) => r.samples)).toEqual([
      MARGIN_LINE_OUTER_SAMPLES,
      MARGIN_LINE_SAMPLES,
      MARGIN_LINE_OUTER_SAMPLES,
    ]);
    expect(rs[0]?.lo).toBeCloseTo(Math.max(base.xLo, (1 + DX_INPUT_MIN_RATIO) * x0), 6);
    expect(rs[1]).toMatchObject({ lo: bLo, hi: bHi });
    expect(rs[2]?.hi).toBeCloseTo(x0 * (1 + DX_INPUT_MAX_RATIO), 6);
    // 数値欄の両端の全域（scenarioFull）は探索範囲（の格子の余白を除く）を含む
    const fLo = scenarioFull(base, DX_INPUT_MIN_RATIO * x0)[0];
    const fHi = scenarioFull(base, DX_INPUT_MAX_RATIO * x0)[1];
    expect(fLo).toBeLessThanOrEqual(rs[0]?.lo as number);
    expect(fHi).toBeGreaterThanOrEqual(rs[2]?.hi as number);
    // 大きな資金なら線は板の全域より下（外の区間で見つかる）
    const capital = 50_000_000;
    const xs = marginLine(base, sc, DEFAULT_MARGIN_PARAMS, capital, holidays);
    expect(xs).toHaveLength(1);
    const x = xs[0] as number;
    expect(x).toBeLessThan(bLo);
    expect(Math.sign(roomAt(base, x - 1, capital))).not.toBe(
      Math.sign(roomAt(base, x + 1, capital)),
    );
  });

  it('表示範囲の外は出さない。右端に近い札は線の左へ（anchor end）', () => {
    const x = marginLine(base, sc, DEFAULT_MARGIN_PARAMS, 12_000_000, holidays)[0] as number;
    expect(chart([x], [x + 100, x + 10_000]).marginCalls).toEqual([]);
    expect(chart([x], [x - 10_000, x - 100]).marginCalls).toEqual([]);
    expect(chart([Number.NaN], null).marginCalls).toEqual([]);
    const m = chart([x], [x - 10_000, x + 10]);
    expect(m.marginCalls).toHaveLength(1);
    const c = m.marginCalls[0];
    expect((c?.px as number) > m.plot.left + m.plot.width - MARGIN_CALL_LABEL_PX).toBe(true);
    expect(c?.anchor).toBe('end');
  });

  it('札「追証」は線の横（上端 + 22px）。交点のラベルは札の箱を避ける', () => {
    // シナリオ点 = X₀（満期の線が上端近く = 交点のラベルが札の高さに来る形）。線の X は表示モデルの入力で置く
    const viewport: [number, number] = [x0 - 6000, x0 + 1500];
    const chartAt = (line: number) =>
      pnlChartModel({
        base,
        scenario: sc,
        viewport,
        pnlY: DEFAULT_PNL_Y,
        plotWidth: 600,
        plotHeight: 220,
        marginLine: [line],
      });
    const hits = (
      placed: ReturnType<typeof stageMarkLabels>,
      box: { x0: number; x1: number; y0: number; y1: number },
    ) =>
      placed.some((p) => {
        const w = labelWidth(p.text) * 1.15;
        const [a, b] = p.anchor === 'start' ? [p.labelX, p.labelX + w] : [p.labelX - w, p.labelX];
        return a < box.x1 && box.x0 < b && box.y0 < p.labelY + 7 && p.labelY - 7 < box.y1;
      });
    let clashed = 0;
    for (let off = -400; off <= 100; off += 25) {
      const m = chartAt(x0 + off);
      const ls = marginCallLabels(m);
      expect(ls).toHaveLength(1);
      const l = ls[0];
      if (!l) throw new Error('札が無い');
      expect(l.labelY).toBe(m.plot.top + MARGIN_CALL_LABEL_DY);
      expect(l.labelX).toBeGreaterThan(m.marginCalls[0]?.px as number);
      expect(l.box.x1 - l.box.x0).toBeGreaterThanOrEqual(labelWidth(MARGIN_CALL_TEXT));
      const marks = scenarioMarks({ base, scenario: sc, chart: m, unit: 'thousand' });
      if (!marks) throw new Error('交点が無い');
      // 避けないと重なる位置（この検査が意味を持つこと）を数え、避けると重ならない
      if (hits(stageMarkLabels(marks, m, []), l.box)) clashed++;
      expect(hits(stageMarkLabels(marks, m, [l.box]), l.box)).toBe(false);
    }
    expect(clashed).toBeGreaterThan(0);
  });

  it('止まってから作るまでの時間はピンの線と同じ 120ms', () => {
    expect(MARGIN_LINE_SETTLE_MS).toBe(PIN_SETTLE_MS);
    expect(MARGIN_LINE_SETTLE_MS).toBe(120);
  });
});

describe('#149 買いの OP の設定', () => {
  /** put 売り 2 枚 + 1 本上の put 買い 1 枚（レシオ。架空の値）と、売り 2 枚だけ */
  const sells2 = run(loaded(chain), add(67_750, 'put', 'sell'), {
    type: 'editLeg',
    id: 1,
    patch: { qty: 2 },
  });
  const ratio = run(sells2, add(67_875, 'put', 'buy'));
  const scenario = { ...ratio.scenario, days: 1, dX: -2000, dSigma: 3 };
  const onPrefs = withCapital(30_000_000);
  const offPrefs: MarginPrefs = { ...onPrefs, ignoreLongOptions: false };
  const ON = marginParamsOf(onPrefs);
  const OFF = marginParamsOf(offPrefs);
  const capital = 30_000_000;
  const mOf = (c: { result: { margin: number } } | null) => c?.result.margin ?? Number.NaN;

  it('#149 設定に従う: 今・シナリオ点・テール・追証の線', () => {
    expect(ON.ignoreLongOptions).toBe(true);
    expect(OFF.ignoreLongOptions).toBe(false);
    expect(OFF).toEqual({ ...ON, ignoreLongOptions: false });
    const rb = baseOf(ratio);
    const sb = baseOf(sells2);
    // 今・点: オン = 売り 2 枚だけ（全足の評価でも同じ。相殺なし）、オフ = 全足の model の値
    const nowOn = marginNow(rb, scenario, ON, capital, holidays);
    const nowOff = marginNow(rb, scenario, OFF, capital, holidays);
    const nowSells = marginNow(sb, scenario, OFF, capital, holidays);
    expect(Math.abs(mOf(nowOn) - mOf(nowSells))).toBeLessThanOrEqual(1e-6);
    expect(mOf(nowOff)).toBeLessThan(mOf(nowOn));
    const pOn = marginPoint(rb, scenario, ON, capital, holidays);
    const pOff = marginPoint(rb, scenario, OFF, capital, holidays);
    const pSells = marginPoint(sb, scenario, OFF, capital, holidays);
    expect(Math.abs(mOf(pOn) - mOf(pSells))).toBeLessThanOrEqual(1e-6);
    expect(mOf(pOff)).toBeLessThan(mOf(pOn));
    // model を直に呼んだ値と同じ（式を足さない）
    const x = rb.ctx.x0 + scenario.dX;
    expect(mOf(pOff)).toBe(mOf(marginCalc(rb, x, scenario, OFF, capital, holidays)));
    // 余力（オン）: 買いの支払は引かれる = 売りだけの余力 − 買いの支払 − 手数料（1 円）
    const premR = premiumSummary(rb.legs, rb.settings);
    const premS = premiumSummary(sb.legs, sb.settings);
    const extra = premR.paid - premS.paid + premR.fees - premS.fees;
    expect(extra).toBeGreaterThan(0);
    expect(
      Math.abs((pOn?.room ?? Number.NaN) - ((pSells?.room ?? Number.NaN) - extra)),
    ).toBeLessThanOrEqual(1);
    // テール: 各行で同じ関係
    const tOn = marginTail(rb, { ...scenario, dX: 0 }, ON, capital, holidays);
    const tOff = marginTail(rb, { ...scenario, dX: 0 }, OFF, capital, holidays);
    const tSells = marginTail(sb, { ...scenario, dX: 0 }, OFF, capital, holidays);
    for (const [i, r] of tOn.entries()) {
      expect(Math.abs(mOf(r.calc) - mOf(tSells[i]?.calc ?? null)), `tail ${i}`).toBeLessThanOrEqual(
        1e-6,
      );
      expect(mOf(r.calc), `tail ${i}`).toBeGreaterThanOrEqual(mOf(tOff[i]?.calc ?? null) - 1e-9);
    }
    // 追証の線: オンとオフで違い、オンの線の両側 1 円でオンの余力の符号が変わる
    const lineOn = marginLine(rb, scenario, ON, capital, holidays);
    const lineOff = marginLine(rb, scenario, OFF, capital, holidays);
    expect(lineOn.length).toBeGreaterThanOrEqual(1);
    expect(lineOn).not.toEqual(lineOff);
    const sc0 = { ...scenario, dX: 0 };
    for (const xl of lineOn) {
      const lo = marginCalc(rb, xl - 1, sc0, ON, capital, holidays)?.room ?? Number.NaN;
      const hi = marginCalc(rb, xl + 1, sc0, ON, capital, holidays)?.room ?? Number.NaN;
      expect(Math.sign(lo)).not.toBe(Math.sign(hi));
    }
  });

  it('#149 内訳の前提に買いの OP の行、テールの注記にオンの印', () => {
    const m = metricsOf(ratio);
    const vOn = viewOf(ratio, onPrefs);
    const vOff = viewOf(ratio, offPrefs);
    const rowOf = (mv: MarginView) =>
      tile(metricTiles(m, mv), 'margin').full.find((r) => r.k === '買いの OP')?.v;
    expect(rowOf(vOn)).toBe('減らさない');
    expect(rowOf(vOff)).toBe('相殺する');
    // 掛け目の行の後
    const keys = tile(metricTiles(m, vOn), 'margin').full.map((r) => r.k);
    expect(keys.indexOf('買いの OP')).toBe(keys.indexOf('掛け目') + 1);
    // 内訳の証拠金の群にも同じ行
    const bd = metricsBreakdown(m, vOn);
    expect(bd.find((r) => r.k === '買いの OP')?.v).toBe('減らさない');
    // テールの注記: オンは末尾に印、オフは #131 の文のまま
    expect(metricsPanel(m, 0, vOn).marginTailCaption).toContain('· 買い OP 除く');
    expect(metricsPanel(m, 0, vOff).marginTailCaption).not.toContain('買い OP');
    expect(marginParamsText(vOff.params)).toBe('R ±5% · IV ×1.5 / ×0.75 · 2 営業日 · 掛け目 100%');
  });
});

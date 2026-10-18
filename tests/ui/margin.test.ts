import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  businessDaysAhead,
  DAY_MS,
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  MARGIN_HORIZON_BUSINESS_DAYS,
  type ModelSettings,
  marginAt,
  marginRoom,
  premiumSummary,
  TAIL_SHOCKS,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { DEFAULT_MARGIN_PREFS, type MarginPrefs } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { DASH, fmtNum } from '../../ui/view/format';
import {
  capitalOf,
  type MarginView,
  marginCalc,
  marginNow,
  marginParamsOf,
  marginPoint,
  marginTail,
} from '../../ui/view/margin';
import { fmtAmount, type MetricsModel, metricsModel } from '../../ui/view/metrics';
import {
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
import { type PnlBase, pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
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
      marginParamsOf({ capitalYen: 1, factorPct: 150, rangePct: 10.5, ivUpPt: 12, ivDownPt: 0 }),
    ).toEqual({ range: 0.105, ivUpPt: 12, ivDownPt: 0, factor: 1.5 });
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
    // 下落ほど put 売りの必要証拠金は増える
    const ms = rows.map((r) => r.calc?.result.margin ?? Number.NaN);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThan(ms[i - 1] as number);
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
    expect(MARGIN_HINT).toContain('仮置き');
    expect(MARGIN_HINT).toContain('深い OTM');
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
    expect(tm.full.slice(-4)).toEqual([
      { k: '値動き幅 R', v: '±8%' },
      { k: 'IV の幅', v: '+8 / −4pt' },
      { k: '保有期間', v: '2 営業日' },
      { k: '掛け目', v: '120%' },
    ]);
    expect(marginParamsText(mv.params)).toBe('R ±8% · IV +8 / −4pt · 2 営業日 · 掛け目 120%');
    // 最悪の点（PFE > 0 の put 売り）
    expect(point.result.pfe).toBeGreaterThan(0);
    expect(tm.full.some((r) => r.k === '最悪の点')).toBe(true);
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

  it('買いだけ: 必要証拠金 0（PFE ≤ NOV）、余力 = 資金 − 支払 − 手数料、倍数は有限、最悪の点の行は出さない（M = 0）', () => {
    const m = metricsOf(buyOnly);
    const capital = 3_000_000;
    const mv = viewOf(buyOnly, withCapital(capital));
    const p = mv.point;
    if (!p || p.room === null) throw new Error('値が無い');
    expect(p.result.margin).toBe(0);
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
    expect(marginParamsText({ range: 0.105, ivUpPt: 12.5, ivDownPt: 0, factor: 1.5 })).toBe(
      'R ±10.5% · IV +12.5 / −0pt · 2 営業日 · 掛け目 150%',
    );
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
    expect(rows.map((r) => r.k)).toContain('PFE（今）');
    expect(rows.map((r) => r.k)).toContain('NOV（シナリオ点）');
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
    expect(view.marginTailCaption).toContain('R ±8%');
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

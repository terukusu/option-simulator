import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { DASH, fmtNum, fmtSigned } from '../../ui/view/format';
import {
  capitalOf,
  type MarginView,
  marginNow,
  marginParamsOf,
  marginPoint,
  marginPointAt,
  marginTail,
} from '../../ui/view/margin';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  amountUnit,
  fmtAmount,
  fmtRatio,
  type MetricsModel,
  metricsModel,
} from '../../ui/view/metrics';
import {
  type BreakdownRow,
  fmtXs,
  METRICS_EMPTY_TEXT,
  type MetricTile,
  metricsBreakdown,
  metricsPanel,
  metricTiles,
  TAIL_HINT,
  type TileKey,
  tailRows,
} from '../../ui/view/metricsPanel';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { readoutModel } from '../../ui/view/readout';
import { type BigReadoutKey, bigReadout } from '../../ui/view/stage';
import { fixture } from '../support/fixtures';
import { boardsT0AndLater } from '../support/laterChain';
import { SUB_MAX_UNITS, widthUnits } from '../support/widthUnits';

/** #86 AC-2〜AC-4: 新しい画面の指標パネルの表示モデル。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1] = chain.months;
if (!m1) throw new Error('限月が無い');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = (c: Chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'latest' });

function baseOf(s: State) {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

function metricsOf(s: State): MetricsModel {
  return metricsModel({ base: baseOf(s), scenario: s.scenario, unit: s.metricsUnit });
}

/** 証拠金の概算（#131。資金は架空の 5,000 万円。useAppController と同じ組み立て） */
function marginOf(s: State): MarginView {
  const base = baseOf(s);
  const prefs = { ...DEFAULT_MARGIN_PREFS, capitalYen: 50_000_000 };
  const params = marginParamsOf(prefs);
  const capital = capitalOf(prefs);
  const { holidays } = CALENDAR;
  return {
    capital,
    params,
    now: marginNow(base, s.scenario, params, capital, holidays),
    point: marginPoint(base, s.scenario, params, capital, holidays),
    at: marginPointAt(base, s.scenario),
    tail: marginTail(base, { ...s.scenario, dX: 0 }, params, capital, holidays),
  };
}

const add = (k: number, optionType: 'put' | 'call', side: 'buy' | 'sell'): Action => ({
  type: 'addBoardLeg',
  expiry: m1.id,
  k,
  optionType,
  side,
});
const scen: Action = { type: 'setScenario', patch: { days: 1.5, dX: -400, dSigma: 2 } };

// 足の組（架空の値）
/** 受取超 + 最大損失 −∞（ストラングル売り） */
const strangle = run(loaded(chain), add(64_000, 'put', 'sell'), add(71_000, 'call', 'sell'), scen);
/** 受取超・有限（put のクレジットスプレッド） */
const creditPut = run(loaded(chain), add(64_000, 'put', 'sell'), add(62_000, 'put', 'buy'), scen);
/** 支払超（5 円の put 買い・手数料 300 円 / 枚。N = 1・5・10 の原資産あり） */
const debitPut = run(
  loaded(chain),
  add(39_000, 'put', 'buy'),
  { type: 'editLeg', id: 1, patch: { entry: 5 } },
  { type: 'setFee', fee: 300 },
  scen,
);
/** 最大利益 +∞（call 買い） */
const callBuy = run(loaded(chain), add(71_000, 'call', 'buy'), scen);
/** 最大損失 −∞ で put 側の最小が下端でない（call 売り + put 買い） */
const callSellPutBuy = run(
  loaded(chain),
  add(71_000, 'call', 'sell'),
  add(60_000, 'put', 'buy'),
  scen,
);

const tile = (tiles: MetricTile[], key: MetricTile['key']) => {
  const t = tiles.find((x) => x.key === key);
  if (!t) throw new Error(`タイル ${key} が無い`);
  return t;
};

// ------------------------------------------------ 旧画面の指標（#91 で削除）の dl の文字列の写し

/** 旧 Amount の textContent（金額 + 単位。— と ∞ には単位を付けない） */
function oldAmount(v: number | null, u: AmountUnit, signed = false): string {
  const s = fmtAmount(v, u, signed);
  return s !== DASH && !s.endsWith('∞') ? `${s}${AMOUNT_UNIT_LABEL[u]}` : s;
}

/** 旧 `dl.metrics-list` の dt / dd の textContent（JSX と同じ式・同じ順） */
function oldDlTexts(m: MetricsModel): string[] {
  const u = m.unit;
  const A = (v: number | null, signed = false) => oldAmount(v, u, signed);
  const { expiry, scenarioPoint: sp, premium } = m;
  const g = sp.total;
  const lf = expiry.lossFinite;
  const out = [
    '満期 最大利益',
    `${A(expiry.maxProfit.value, true)}${
      expiry.profitFinite ? ` （call 側 ∞ / put 側 ${A(expiry.profitFinite.value, true)}）` : ''
    }`,
    '満期 最大損失',
    lf
      ? `call 側 −∞ / put 側 ${A(lf.value, true)}${
          lf.x === expiry.xLo ? '（SQ = 下端）' : `（X = ${fmtNum(lf.x)}）`
        }`
      : A(expiry.maxLoss.value, true),
    '満期 BEP',
    fmtXs(expiry.breakevens),
    `指定日 + シナリオd = ${fmtNum(m.days, 2)} 日、X = ${fmtNum(sp.x)}（ΔX ${fmtSigned(sp.dXPct, 1)}%）`,
    `${A(sp.pnl, true)}BEP ${fmtXs(m.dateBreakevens)}`,
    '合計グリーク（シナリオ点）',
    `Δ ${fmtSigned(g.deltaLarge, 3)} 枚（ミニ ${fmtSigned(g.deltaMini, 2)}）、Γ ${fmtSigned(g.gammaPer100, 4)} / 100 円、Θ ${A(g.thetaPerDay, true)} / 日、V ${A(g.vegaPerPt, true)} / pt`,
    '受取 / 支払',
    `${A(premium.received)} / ${A(premium.paid)}差引 ${A(premium.net, true)}（OP の手数料込み ${A(premium.netAfterFees, true)}）、手数料の合計 ${A(premium.fees)}`,
  ];
  if (premium.stake !== null) {
    out.push(
      '掛け金（支払 − 受取 + 手数料）',
      `${A(premium.stake)}${premium.multiples
        .map((x) => `利益が掛け金の ${x.n} 倍になる原資産（満期）: ${fmtXs(x.xs)}`)
        .join('')}`,
    );
  }
  out.push(
    'スプレッドコスト / 建値ずれ',
    `${A(premium.spreadCost, true)} / ${A(premium.entryMismatch, true)}`,
  );
  return out;
}

/** AC-10 と同じ数値のトークン（要素ごとに取り出して連ねる） */
const TOKEN = /[+−]?[0-9][0-9,.]*|[+−]∞|なし|—/g;
const tokensOf = (texts: readonly string[]) => texts.flatMap((t) => t.match(TOKEN) ?? []);
const newTexts = (rows: readonly BreakdownRow[]) =>
  rows.filter((r) => !r.group).flatMap((r) => [r.k, r.v]);

const amt = (v: number | null, u: AmountUnit, signed = false) => {
  const s = fmtAmount(v, u, signed);
  return s === DASH || s.endsWith('∞') ? s : `${s} ${AMOUNT_UNIT_LABEL[u]}`;
};

// ------------------------------------------------ AC-2 タイル

describe('タイル 6 枚（#86 AC-2・#131・#274）', () => {
  it('(a) ストラングル売り（受取超）: 1〜4 の値と最大損失の −∞・put 側・SQ = 下端', () => {
    const m = metricsOf(strangle);
    const u = m.unit;
    expect(u).toBe('thousand');
    const tiles = metricTiles(m);
    expect(tiles.map((t) => t.key)).toEqual([
      'maxProfit',
      'maxLoss',
      'bep',
      'premium',
      'margin',
      'room',
    ]);
    expect(tiles.map((t) => t.k)).toEqual([
      '満期 最大利益',
      '満期 最大損失',
      '満期 BEP',
      '受取 − 支払',
      '必要証拠金',
      '余力',
    ]);
    const t1 = tile(tiles, 'maxProfit');
    expect(t1.v).toBe(fmtAmount(m.expiry.maxProfit.value, u, true));
    expect(t1.unit).toBe('千円');
    const t2 = tile(tiles, 'maxLoss');
    const lf = m.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    expect(lf.x).toBe(m.expiry.xLo);
    expect(t2.v).toBe('−∞');
    expect(t2.unit).toBe('');
    expect(t2.s).toContain('put 側');
    expect(t2.s).toContain(fmtAmount(lf.value, u, true));
    // #107: 副題は「SQ = 」を省く（全文と内訳は「put 側（SQ = 下端）」）
    expect(t2.s).toContain('下端');
    expect(t2.s).toBe(`put 側 ${fmtAmount(lf.value, u, true)} · 下端`);
    const t3 = tile(tiles, 'bep');
    expect(m.expiry.breakevens.length).toBe(2);
    expect(t3.v).toBe(m.expiry.breakevens.map((x) => fmtNum(x)).join(' / '));
    expect(t3.s).toBe(`指定日 ${fmtXs(m.dateBreakevens)}`);
    expect(t3.unit).toBe('');
    const t4 = tile(tiles, 'premium');
    expect(m.premium.stake).toBeNull();
    expect(t4.k).toBe('受取 − 支払');
    expect(t4.v).toBe(fmtAmount(m.premium.net, u, true));
    // #107: 区切りは ` · `
    expect(t4.s).toBe(
      `受取 ${fmtAmount(m.premium.received, u)} · 支払 ${fmtAmount(m.premium.paid, u)}`,
    );
  });

  it('最大利益・最大損失が有限なら副題は X（put のクレジットスプレッド）', () => {
    const m = metricsOf(creditPut);
    const tiles = metricTiles(m);
    expect(m.expiry.profitFinite).toBeNull();
    expect(m.expiry.lossFinite).toBeNull();
    const t1 = tile(tiles, 'maxProfit');
    const t2 = tile(tiles, 'maxLoss');
    expect(t2.v).toBe(fmtAmount(m.expiry.maxLoss.value, m.unit, true));
    expect(t1.s).toBe(m.expiry.maxProfit.x === null ? '' : `X ${fmtNum(m.expiry.maxProfit.x)}`);
    expect(t2.s).toBe(m.expiry.maxLoss.x === null ? '' : `X ${fmtNum(m.expiry.maxLoss.x)}`);
    expect(t2.unit).toBe(AMOUNT_UNIT_LABEL[m.unit]);
  });

  it('−∞ で put 側の最小が下端でなければ副題は X', () => {
    const m = metricsOf(callSellPutBuy);
    const lf = m.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    expect(lf.x).not.toBe(m.expiry.xLo);
    expect(tile(metricTiles(m), 'maxLoss').s).toBe(
      `put 側 ${fmtAmount(lf.value, m.unit, true)} · X ${fmtNum(lf.x)}`,
    );
  });

  it('(b) call 買い（支払超）: 1 の値 +∞・副題に put 側、4 の見出し 掛け金・値 = stake', () => {
    const m = metricsOf(callBuy);
    const u = m.unit;
    const tiles = metricTiles(m);
    const t1 = tile(tiles, 'maxProfit');
    expect(t1.v).toBe('+∞');
    expect(t1.unit).toBe('');
    expect(t1.s).toContain('put 側');
    const pf = m.expiry.profitFinite;
    if (!pf) throw new Error('profitFinite が無い');
    expect(t1.s).toBe(`put 側 ${fmtAmount(pf.value, u, true)}`);
    const t4 = tile(tiles, 'premium');
    expect(m.premium.stake).not.toBeNull();
    expect(t4.k).toBe('掛け金');
    expect(t4.v).toBe(fmtAmount(m.premium.stake, u));
    // #107: 手数料は全文と内訳で読む
    expect(t4.s).toBe(
      `支払 ${fmtAmount(m.premium.paid, u)} · 受取 ${fmtAmount(m.premium.received, u)}`,
    );
  });

  it('(c) 色: 正の金額は gain・負は loss・0 と BEP・掛け金は無色', () => {
    const m = metricsOf(strangle);
    const tiles = metricTiles(m);
    expect(tile(tiles, 'maxProfit').tone).toBe('gain');
    expect(tile(tiles, 'maxLoss').tone).toBe('loss');
    expect(tile(tiles, 'bep').tone).toBeNull();
    expect(tile(tiles, 'premium').tone).toBe('gain');
    // 負の金額（call 買いの最大損失）
    const cb = metricTiles(metricsOf(callBuy));
    expect(tile(cb, 'maxLoss').v.startsWith('−')).toBe(true);
    expect(tile(cb, 'maxLoss').tone).toBe('loss');
    // 掛け金（符号なしの支払いの額）は無色
    expect(tile(cb, 'premium').tone).toBeNull();
    // 0（丸めて 0 を含む）は無色
    const zero: MetricsModel = {
      ...m,
      expiry: { ...m.expiry, maxProfit: { value: 0.3, x: null } },
      scenarioPoint: { ...m.scenarioPoint, pnl: 0 },
    };
    const zt = metricTiles(zero);
    expect(tile(zt, 'maxProfit').v).toBe(fmtAmount(0.3, m.unit, true));
    expect(tile(zt, 'maxProfit').v).toMatch(/^0(\.0+)?$/);
    expect(tile(zt, 'maxProfit').tone).toBeNull();
  });

  it('(d) 単位: 受取 + 支払 99,999 円は円・100,000 円は千円（amountUnit と同じ）、固定 yen が優先で 円（固定）', () => {
    const one = (entry: number, unit?: 'yen') =>
      metricsOf(
        run(
          loaded(chain),
          add(64_000, 'put', 'sell'),
          { type: 'editLeg', id: 1, patch: { entry } },
          ...(unit ? [{ type: 'setMetricsUnit', unit } as Action] : []),
        ),
      );
    const small = one(99.999);
    expect(small.premium.received).toBeCloseTo(99_999, 6);
    expect(small.unit).toBe(amountUnit(small.premium.received, small.premium.paid, 'auto'));
    expect(small.unit).toBe('yen');
    expect(metricsPanel(small, 0).unitSub).toBe('円（自動）');
    expect(tile(metricTiles(small), 'premium').unit).toBe('円');
    const big = one(100);
    expect(big.premium.received).toBe(100_000);
    expect(big.unit).toBe('thousand');
    expect(metricsPanel(big, 0).unitSub).toBe('千円（自動）');
    expect(tile(metricTiles(big), 'premium').v).toBe('+100');
    const fixed = one(100, 'yen');
    expect(fixed.unit).toBe('yen');
    expect(metricsPanel(fixed, 0).unitSub).toBe('円（固定）');
    expect(tile(metricTiles(fixed), 'premium').v).toBe('+100,000');
  });
});

// ------------------------------------------------ AC-3 内訳

describe('内訳（#86 AC-3: 旧 Metrics と同じ順・同じ値）', () => {
  const cases: [string, State][] = [
    ['受取超・−∞（ストラングル売り）', strangle],
    ['受取超・有限（put のクレジットスプレッド）', creditPut],
    ['支払超（手数料 300 円 / 枚・N 倍）', debitPut],
    ['call 買い（+∞）', callBuy],
    ['売りの −∞ で put 側が下端でない', callSellPutBuy],
  ];

  for (const [name, s] of cases) {
    it(`${name}: 数値のトークン列が旧 dl.metrics-list と一致`, () => {
      const m = metricsOf(s);
      const rows = metricsBreakdown(m);
      expect(tokensOf(newTexts(rows))).toEqual(tokensOf(oldDlTexts(m)));
      // 行の値は折り返さない前提の 1 行（改行なし）
      expect(rows.every((r) => !r.v.includes('\n') && !r.k.includes('\n'))).toBe(true);
      // 支払超でなければ掛け金の行が無い
      const hasStake = rows.some((r) => r.k.startsWith('掛け金'));
      expect(hasStake).toBe(m.premium.stake !== null);
    });
  }

  it('ストラングル売り: 行の見出しと値（旧と同じ式）', () => {
    const m = metricsOf(strangle);
    const u = m.unit;
    const A = (v: number | null, signed = false) => amt(v, u, signed);
    const g = m.scenarioPoint.total;
    const lf = m.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    const p = m.premium;
    const r = (k: string, v: string, group = false): BreakdownRow => ({ k, v, group });
    expect(m.expiry.breakevens.length).toBe(2);
    expect(metricsBreakdown(m)).toEqual([
      r('満期 最大利益', A(m.expiry.maxProfit.value, true)),
      r('満期 最大損失', 'call 側 −∞'),
      r('put 側（SQ = 下端）', A(lf.value, true)),
      r('満期 BEP', fmtXs(m.expiry.breakevens)),
      r('指定日 + シナリオ', `d = ${fmtNum(m.days, 2)} 日`),
      r('X', `${fmtNum(m.scenarioPoint.x)}（ΔX ${fmtSigned(m.scenarioPoint.dXPct, 1)}%）`),
      r('損益', A(m.scenarioPoint.pnl, true)),
      r('BEP', fmtXs(m.dateBreakevens)),
      r('合計グリーク（シナリオ点）', '', true),
      {
        ...r('Δ', `${fmtSigned(g.deltaLarge, 3)} 枚（ミニ ${fmtSigned(g.deltaMini, 2)}）`),
        term: 'delta',
      },
      { ...r('Γ', `${fmtSigned(g.gammaPer100, 4)} / 100 円`), term: 'gamma' },
      { ...r('Θ', `${A(g.thetaPerDay, true)} / 日`), term: 'theta' },
      { ...r('V', `${A(g.vegaPerPt, true)} / pt`), term: 'vega' },
      r('受取 / 支払', `${A(p.received)} / ${A(p.paid)}`),
      r('差引', A(p.net, true)),
      r('OP の手数料込み', A(p.netAfterFees, true)),
      r('手数料の合計', A(p.fees)),
      r('スプレッドコスト', A(p.spreadCost, true)),
      r('建値ずれ', A(p.entryMismatch, true)),
    ]);
  });

  it('支払超: 掛け金と N = 1・5・10 の原資産（手数料込み）、注記は手数料 300 円 / 枚', () => {
    const m = metricsOf(debitPut);
    expect(m.premium.stake).toBe(5_300);
    const rows = metricsBreakdown(m);
    const i = rows.findIndex((r) => r.k === '掛け金（支払 − 受取 + 手数料）');
    expect(rows[i]?.v).toBe('5,300 円');
    expect(rows[i + 1]).toEqual({
      k: '利益が掛け金の N 倍になる原資産（満期）',
      v: '',
      group: true,
    });
    expect(rows.slice(i + 2, i + 5)).toEqual(
      m.premium.multiples.map((x) => ({ k: `${x.n} 倍`, v: fmtXs(x.xs), group: false })),
    );
    expect(m.premium.multiples.map((x) => x.n)).toEqual([1, 5, 10]);
    expect(rows.find((r) => r.k === '手数料の合計')?.v).toBe('300 円');
    expect(metricsPanel(m, 300).breakdownNote).toBe('金額の単位 円（自動） · 手数料 300 円 / 枚');
  });

  it('点の並びは 2 点ずつの行に分け、続きの行の見出しは空（無ければ「なし」）', () => {
    const m = metricsOf(strangle);
    const more: MetricsModel = { ...m, expiry: { ...m.expiry, breakevens: [1, 2, 3, 4, 5] } };
    const rows = metricsBreakdown(more);
    const i = rows.findIndex((r) => r.k === '満期 BEP');
    expect(rows.slice(i, i + 3).map((r) => [r.k, r.v])).toEqual([
      ['満期 BEP', '1 / 2'],
      ['', '3 / 4'],
      ['', '5'],
    ]);
    expect(rows[i + 3]?.k).toBe('指定日 + シナリオ');
    const none: MetricsModel = { ...m, dateBreakevens: [] };
    expect(metricsBreakdown(none).find((r) => r.k === 'BEP')?.v).toBe('なし');
    expect(tile(metricTiles(none), 'bep').s).toBe('指定日 なし');
  });

  it('足 0 本は empty で行もタイルもテールも出さない（例外なし）。副題は出す', () => {
    const m = metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'auto' });
    expect(m.empty).toBe(true);
    const v = metricsPanel(m, 0);
    expect(v).toEqual({
      empty: true,
      unitSub: '円（自動）',
      headSub: '円（自動）',
      tiles: [],
      breakdown: [],
      breakdownNote: '金額の単位 円（自動） · 手数料 0 円 / 枚',
      tailCaption: '',
      tail: [],
      marginTailCaption: '',
      marginTail: [],
    });
    expect(metricTiles(m)).toEqual([]);
    expect(metricsBreakdown(m)).toEqual([]);
    expect(tailRows(m)).toEqual([]);
    expect(METRICS_EMPTY_TEXT).toBe('足を追加すると指標が出ます');
    const fixed = metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'thousand' });
    expect(metricsPanel(fixed, 0).unitSub).toBe('千円（固定）');
  });
});

// ------------------------------------------------ AC-4 テール表

describe('テール表とバー（#86 AC-4）', () => {
  it('(a) 5 行 × 2 セルの文字列と行見出し（旧のテール表と同じ）', () => {
    const m = metricsOf(strangle);
    const u = m.unit;
    const rows = tailRows(m);
    expect(rows).toHaveLength(5);
    rows.forEach((r, i) => {
      const src = m.tail.rows[i];
      if (!src) throw new Error('行が無い');
      expect(r.key).toBe(src.shock);
      expect(r.pct).toBe(`${fmtSigned(src.shock * 100, 0)}%`);
      expect(r.x).toBe(fmtNum(src.x));
      expect(r.sq.pnl).toBe(fmtAmount(src.sq.pnl, u, true));
      expect(r.sq.ratio).toBe(fmtRatio(src.sq.ratio));
      expect(r.scenario.pnl).toBe(fmtAmount(src.scenario.pnl, u, true));
      expect(r.scenario.ratio).toBe(fmtRatio(src.scenario.ratio));
    });
    expect(rows.map((r) => r.pct)).toEqual(['−5%', '−10%', '−20%', '−30%', '−40%']);
  });

  it('(b) バーの長さ = |損益| / 10 セルの |損益| の最大 × 100、最大のセルが 100、符号で gain / loss', () => {
    const m = metricsOf(strangle);
    const rows = tailRows(m);
    const pnls = m.tail.rows.flatMap((r) => [r.sq.pnl, r.scenario.pnl]);
    const max = Math.max(...pnls.map(Math.abs));
    expect(max).toBeGreaterThan(0);
    const cells = rows.flatMap((r) => [r.sq, r.scenario]);
    cells.forEach((c, i) => {
      const p = pnls[i] as number;
      if (p === 0) {
        expect(c.bar).toBeNull();
        return;
      }
      expect(c.bar?.width).toBeCloseTo((Math.abs(p) / max) * 100, 12);
      expect(c.bar?.tone).toBe(p > 0 ? 'gain' : 'loss');
      expect(c.bar?.width).toBeGreaterThan(0);
      expect(c.bar?.width).toBeLessThanOrEqual(100);
      // 文字色は整形後の文字列の符号
      expect(c.tone).toBe(c.pnl.startsWith('+') ? 'gain' : c.pnl.startsWith('−') ? 'loss' : null);
    });
    expect(Math.max(...cells.map((c) => c.bar?.width ?? 0))).toBe(100);
  });

  it('(b) pnl = 0 のセルと全部 0 の表はバーなし', () => {
    const m = metricsOf(strangle);
    const first = m.tail.rows[0];
    if (!first) throw new Error('行が無い');
    const oneZero: MetricsModel = {
      ...m,
      tail: {
        ...m.tail,
        rows: [{ ...first, sq: { pnl: 0, ratio: 0 } }, ...m.tail.rows.slice(1)],
      },
    };
    const r0 = tailRows(oneZero)[0];
    expect(r0?.sq.bar).toBeNull();
    expect(r0?.sq.tone).toBeNull();
    expect(r0?.scenario.bar).not.toBeNull();
    const allZero: MetricsModel = {
      ...m,
      tail: {
        ...m.tail,
        rows: m.tail.rows.map((r) => ({
          ...r,
          sq: { pnl: 0, ratio: null },
          scenario: { pnl: 0, ratio: null },
        })),
      },
    };
    expect(tailRows(allZero).every((r) => r.sq.bar === null && r.scenario.bar === null)).toBe(true);
  });

  it('(c) 基準の注記: 受取超は 受取超（受取 − 支払）、支払超は 掛け金、net = 0 は倍率がすべて —', () => {
    const recv = metricsOf(strangle);
    expect(metricsPanel(recv, 0).tailCaption).toBe(
      `損益（千円）と倍率 ×|損益 / 受取超（受取 − 支払）|（基準 ${fmtAmount(recv.tail.premiumBase.amount, recv.unit)}）`,
    );
    const paid = metricsOf(debitPut);
    expect(metricsPanel(paid, 300).tailCaption).toBe(
      '損益（円）と倍率 ×|損益 / 掛け金|（基準 5,300）',
    );
    // 同じ建値の売りと買い（架空の値）: net = 0
    const flat = metricsOf(
      run(
        loaded(chain),
        add(64_000, 'put', 'sell'),
        add(64_000, 'put', 'buy'),
        { type: 'editLeg', id: 1, patch: { entry: 500 } },
        { type: 'editLeg', id: 2, patch: { entry: 500 } },
      ),
    );
    expect(flat.premium.net).toBe(0);
    const v = metricsPanel(flat, 0);
    expect(v.tailCaption).toBe(
      `損益（${AMOUNT_UNIT_LABEL[flat.unit]}）と倍率 ×|損益 / 掛け金|（基準 ${fmtAmount(0, flat.unit)}）`,
    );
    expect(v.tail.every((r) => r.sq.ratio === DASH && r.scenario.ratio === DASH)).toBe(true);
    expect(v.tail.every((r) => r.sq.bar === null && r.scenario.bar === null)).toBe(true);
  });

  it('テールの注記の文は旧の ⓘ と同じ', () => {
    expect(TAIL_HINT).toBe(
      '指定日の列 = d・Δσ・Δs・β・動き方はシナリオのまま、原資産だけを各行の値にして再評価（β は行ごとの下落率で IV を上げる）',
    );
  });

  it('決定的（同じ入力 → 同じ出力）で入力を変えない', () => {
    const m = metricsOf(debitPut);
    const snap = JSON.stringify(m);
    expect(metricsPanel(m, 300)).toEqual(metricsPanel(m, 300));
    expect(JSON.stringify(m)).toBe(snap);
  });
});

// ------------------------------------------------ #107 全文（ポップオーバー）と副題の短縮

/** 買い 2 本（掛け金のタイル。架空の値） */
const buy2 = run(loaded(chain), add(63_500, 'put', 'buy'), add(71_000, 'call', 'buy'), scen);
/** 売り 5 枚のストラングル・単位を円に固定（桁が増える。架空の値） */
const strangleYen = run(
  loaded(chain),
  add(64_000, 'put', 'sell'),
  add(71_000, 'call', 'sell'),
  { type: 'editLeg', id: 1, patch: { qty: 5 } },
  { type: 'editLeg', id: 2, patch: { qty: 5 } },
  { type: 'setMetricsUnit', unit: 'yen' },
  scen,
);

const fr = (k: string, v: string) => ({ k, v });

describe('全文（#107 AC-1）', () => {
  const cases: [string, State][] = [
    ['ストラングル売り', strangle],
    ['put のクレジットスプレッド', creditPut],
    ['支払超（手数料 300 円 / 枚）', debitPut],
    ['call 買い（+∞）', callBuy],
    ['売りの −∞ で put 側が下端でない', callSellPutBuy],
    ['買い 2 本', buy2],
    ['売り 5 枚・円固定', strangleYen],
  ];

  for (const [name, s] of cases) {
    it(`${name}: 6 枚とも全文があり、値は内訳の値の文字列の中にある（finite の X の行を除く）`, () => {
      const m = metricsOf(s);
      const mv = marginOf(s);
      const tiles = metricTiles(m, mv);
      const bd = metricsBreakdown(m, mv);
      expect(tiles).toHaveLength(6);
      for (const t of tiles) {
        expect(t.full.length).toBeGreaterThanOrEqual(1);
        for (const r of t.full) {
          expect(r.v).not.toBe('');
          expect(r.v.includes('\n') || r.k.includes('\n')).toBe(false);
          if (r.k === 'X' || r.k === 'd') continue;
          expect(bd.some((b) => b.v.includes(r.v))).toBe(true);
        }
      }
      // 1 行目は見出し + 値（証拠金の 2 枚は「（概算）」付きの見出し。#274）
      for (const t of tiles.filter((x) => x.key !== 'premium')) {
        expect(t.full[0]?.k).toBe(t.key === 'margin' || t.key === 'room' ? `${t.k}（概算）` : t.k);
      }
    });
  }

  it('ストラングル売り: 4 枚の全文の行（内訳と同じ式・同じ桁）', () => {
    const m = metricsOf(strangle);
    const u = m.unit;
    const A = (v: number | null, signed = false) => amt(v, u, signed);
    const lf = m.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    const p = m.premium;
    const tiles = metricTiles(m);
    expect(tile(tiles, 'maxProfit').full).toEqual([
      fr('満期 最大利益', A(m.expiry.maxProfit.value, true)),
      ...(m.expiry.maxProfit.x === null ? [] : [fr('X', fmtNum(m.expiry.maxProfit.x))]),
    ]);
    expect(tile(tiles, 'maxLoss').full).toEqual([
      fr('満期 最大損失', 'call 側 −∞'),
      fr('put 側（SQ = 下端）', A(lf.value, true)),
    ]);
    expect(tile(tiles, 'bep').full).toEqual([
      fr('満期 BEP', fmtXs(m.expiry.breakevens)),
      fr('指定日 BEP', fmtXs(m.dateBreakevens)),
    ]);
    expect(tile(tiles, 'premium').full).toEqual([
      fr('受取 − 支払', A(p.net, true)),
      fr('受取', A(p.received)),
      fr('支払', A(p.paid)),
      fr('手数料の合計', A(p.fees)),
    ]);
  });

  it('支払超: 掛け金の全文に副題で省いた手数料（内訳の「手数料の合計」と同じ文字列）', () => {
    for (const s of [buy2, debitPut, callBuy]) {
      const m = metricsOf(s);
      const u = m.unit;
      const p = m.premium;
      expect(p.stake).not.toBeNull();
      const t = tile(metricTiles(m), 'premium');
      expect(t.s).not.toContain('手数料');
      expect(t.full).toEqual([
        fr('掛け金（支払 − 受取 + 手数料）', amt(p.stake, u)),
        fr('支払', amt(p.paid, u)),
        fr('受取', amt(p.received, u)),
        fr('手数料の合計', amt(p.fees, u)),
      ]);
      const bd = metricsBreakdown(m);
      expect(bd.find((r) => r.k === '手数料の合計')?.v).toBe(t.full[3]?.v);
      expect(bd.find((r) => r.k === '掛け金（支払 − 受取 + 手数料）')?.v).toBe(t.full[0]?.v);
    }
  });

  it('円固定 5 枚: 内訳の合計グリークに Γ と Θ / V の全桁（円）、最大損失の全文に put 側の全桁', () => {
    const m = metricsOf(strangleYen);
    expect(m.unit).toBe('yen');
    const g = m.scenarioPoint.total;
    const bd = metricsBreakdown(m).map((b) => ({ k: b.k, v: b.v }));
    expect(bd).toContainEqual(fr('Γ', `${fmtSigned(g.gammaPer100, 4)} / 100 円`));
    expect(bd).toContainEqual(fr('Θ', `${fmtAmount(g.thetaPerDay, 'yen', true)} 円 / 日`));
    expect(bd).toContainEqual(fr('V', `${fmtAmount(g.vegaPerPt, 'yen', true)} 円 / pt`));
    // 円の全桁（千円に丸めない）
    expect(fmtAmount(g.thetaPerDay, 'yen', true).replace(/[^0-9]/g, '').length).toBeGreaterThan(3);
    const lf = m.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    expect(tile(metricTiles(m), 'maxLoss').full).toContainEqual(
      fr('put 側（SQ = 下端）', `${fmtAmount(lf.value, 'yen', true)} 円`),
    );
  });

  it('BEP 3 点以上: 全文は 2 点ずつの行（内訳と同じ）で全点を読める', () => {
    const m = metricsOf(strangle);
    const more: MetricsModel = {
      ...m,
      expiry: { ...m.expiry, breakevens: [61_000, 62_500, 66_000, 70_500, 72_000] },
      dateBreakevens: [],
    };
    expect(tile(metricTiles(more), 'bep').full).toEqual([
      fr('満期 BEP', '61,000 / 62,500'),
      fr('', '66,000 / 70,500'),
      fr('', '72,000'),
      fr('指定日 BEP', 'なし'),
    ]);
  });

  it('有限の最大利益 / 損失は X の行（x が null なら出さない）', () => {
    const m = metricsOf(creditPut);
    const u = m.unit;
    const tiles = metricTiles(m);
    const t2 = tile(tiles, 'maxLoss');
    expect(t2.full[0]).toEqual(fr('満期 最大損失', amt(m.expiry.maxLoss.value, u, true)));
    expect(t2.full.slice(1)).toEqual(
      m.expiry.maxLoss.x === null ? [] : [fr('X', fmtNum(m.expiry.maxLoss.x))],
    );
    const noX: MetricsModel = {
      ...m,
      expiry: {
        ...m.expiry,
        maxProfit: { ...m.expiry.maxProfit, x: null },
        maxLoss: { ...m.expiry.maxLoss, x: null },
      },
    };
    const nt = metricTiles(noX);
    expect(tile(nt, 'maxProfit').full).toHaveLength(1);
    expect(tile(nt, 'maxLoss').full).toHaveLength(1);
    // −∞ で put 側が下端でない: put 側の X の行
    const c = metricsOf(callSellPutBuy);
    const lf = c.expiry.lossFinite;
    if (!lf) throw new Error('lossFinite が無い');
    expect(tile(metricTiles(c), 'maxLoss').full).toEqual([
      fr('満期 最大損失', 'call 側 −∞'),
      fr('put 側', amt(lf.value, c.unit, true)),
      fr('put 側の X', fmtNum(lf.x)),
    ]);
  });
});

describe('副題の短縮（#107 AC-2）', () => {
  it('掛け金の副題は `支払 … · 受取 …` で、今までの `支払 … / 受取 … / 手数料 …` より短い', () => {
    for (const s of [buy2, debitPut, callBuy]) {
      const m = metricsOf(s);
      const u = m.unit;
      const p = m.premium;
      const t = tile(metricTiles(m), 'premium');
      expect(t.s).toBe(`支払 ${fmtAmount(p.paid, u)} · 受取 ${fmtAmount(p.received, u)}`);
      const before = `支払 ${fmtAmount(p.paid, u)} / 受取 ${fmtAmount(p.received, u)} / 手数料 ${fmtAmount(p.fees, u)}`;
      expect(widthUnits(t.s)).toBeLessThan(widthUnits(before));
    }
  });

  it(`売り 2 本・買い 2 本（千円・自動）: 6 枚の副題が幅の単位 ${SUB_MAX_UNITS} 以下`, () => {
    for (const s of [strangle, buy2]) {
      const m = metricsOf(s);
      expect(m.unitAuto).toBe(true);
      for (const t of metricTiles(m, marginOf(s))) {
        expect(widthUnits(t.s), `${t.key}: ${t.s}`).toBeLessThanOrEqual(SUB_MAX_UNITS);
      }
    }
  });

  it(`#274 D-03: d と ΔX を動かした点（d 10・ΔX −1,500）で、証拠金の 2 枚の見出し + 点の印が幅の単位 ${SUB_MAX_UNITS} 以下`, () => {
    const s = run(strangle, {
      type: 'setScenario',
      patch: { days: 10, dX: -1500, dSigma: 0 },
    });
    const tiles = metricTiles(metricsOf(s), marginOf(s));
    for (const t of tiles.filter((x) => x.key === 'margin' || x.key === 'room')) {
      const kh = `${t.k} ${t.at}`;
      expect(kh).toMatch(/^(必要証拠金|余力) · d10 · −\d\.\d%$/);
      expect(widthUnits(kh), kh).toBeLessThanOrEqual(SUB_MAX_UNITS);
    }
  });

  it('幅の単位の数え方（ASCII 1・全角 2）', () => {
    expect(widthUnits('支払 1,160 · 受取 0.0')).toBe(2 * 4 + 13);
    expect(widthUnits('ＡＢ')).toBe(4);
    expect(widthUnits('Θ −1')).toBe(4);
  });
});

describe('内訳の用語（#167 AC-6）', () => {
  const TERMED: Record<string, string> = {
    Δ: 'delta',
    Γ: 'gamma',
    Θ: 'theta',
    V: 'vega',
    '必要証拠金（シナリオ点）': 'margin',
    '必要証拠金（今）': 'margin',
    'NOV（シナリオ点）': 'nov',
    'NOV（今）': 'nov',
    '証拠金所要額（シナリオ点）': 'requirement',
    '証拠金所要額（今）': 'requirement',
    '余力（シナリオ点）': 'room',
    '余力（今）': 'room',
  };
  for (const [name, s] of [
    ['ストラングル売り', strangle],
    ['支払超', debitPut],
    ['買い 2 本', buy2],
  ] as const) {
    it(`${name}: Δ・Γ・Θ・V と証拠金の 4 種（シナリオ点・今）の行だけに用語の id`, () => {
      const bd = metricsBreakdown(metricsOf(s), marginOf(s));
      const termed = bd.filter((r) => r.term !== undefined);
      expect(termed.length).toBe(12);
      for (const r of bd) {
        if (r.group) expect(r.term, r.k).toBeUndefined();
        else expect(r.term, r.k).toBe(TERMED[r.k]);
      }
      // 証拠金なしならグリークの 4 行だけ
      expect(metricsBreakdown(metricsOf(s)).filter((r) => r.term !== undefined).length).toBe(4);
    });
  }
});

/**
 * #274 AC1（EPIC #281 終了条件 3）: 読み取りの帯とタイルで同じ値を出す項目が 0。帯の項目とタイルの key を「同じ量」の組
 * （指定日 + シナリオの損益・合計グリーク・受取 − 支払）で突き合わせ、見出しの集合も比べる（PC = 帯 5 つ全部が見える幅）
 */
describe('#274 読み取りの帯とタイルで同じ値を出す項目が 0', () => {
  /** 項目が出す量（帯の key・タイルの key → 量。旧タイル scenario・greeks と旧の帯 premium は帯・タイルの重複だった） */
  const QUANTITY: Record<BigReadoutKey | TileKey | 'scenario' | 'greeks', string> = {
    // 帯
    date: 'scenario-pnl',
    expiry: 'expiry-pnl',
    delta: 'greeks',
    theta: 'greeks',
    vega: 'greeks',
    // タイル
    maxProfit: 'max-profit',
    maxLoss: 'max-loss',
    bep: 'bep',
    premium: 'premium',
    margin: 'margin',
    room: 'room',
    // 旧タイル（#274 で外した。旧の帯の premium は premium と同じ量）
    scenario: 'scenario-pnl',
    greeks: 'greeks',
  };

  it('ストラングル売り・call 買い（証拠金あり）: 量の交差と見出しの交差が空', () => {
    for (const s of [strangle, callBuy]) {
      const m = metricsOf(s);
      const r = readoutModel({ base: baseOf(s), metrics: m, scenario: s.scenario });
      const ro = bigReadout(r, null);
      const tiles = metricTiles(m, marginOf(s));
      expect(ro.map((i) => i.key)).toEqual(['date', 'expiry', 'delta', 'theta', 'vega']);
      expect(tiles.map((t) => t.key)).toEqual([
        'maxProfit',
        'maxLoss',
        'bep',
        'premium',
        'margin',
        'room',
      ]);
      const roQ = new Set(ro.map((i) => QUANTITY[i.key]));
      const tileQ = tiles.map((t) => QUANTITY[t.key]);
      expect(tileQ.filter((q) => roQ.has(q))).toEqual([]);
      const roLabels = new Set(ro.map((i) => i.label));
      expect(tiles.map((t) => t.k).filter((k) => roLabels.has(k))).toEqual([]);
    }
  });
});

describe('含み損益の行（#299 AC11。t₀ で建てて t₀ + 3 日の板で見る）', () => {
  const { t0, later } = boardsT0AndLater();
  const s0 = run(
    { ...initialState, feePerLot: 40 },
    { type: 'loaded', chain: t0, label: 't0' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: '2026-11', k: 70500, optionType: 'call', side: 'sell' },
    { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
  );
  const s3 = run(s0, { type: 'loaded', chain: later, label: 'later' });
  const metricsAt = (c: Chain, s: State) => {
    const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
    const pm = positionModel(c, s.legs, s.atmBasis, CALENDAR, settings);
    const base = pnlDomains(c, pm.prepared, pm.ctx, settings);
    if (!base) throw new Error('基礎が作れない');
    return { pm, m: metricsModel({ base, scenario: ZERO_SCENARIO, unit: 'yen' }) };
  };

  it('内訳に「含み損益」の行（スプレッドコストの前）、合計 = シナリオ 0 の損益 − 建値ずれ + 手数料', () => {
    const { pm, m } = metricsAt(later, s3);
    const rows = metricsBreakdown(m);
    const i = rows.findIndex((r) => r.k === '含み損益');
    expect(i).toBeGreaterThan(0);
    expect(rows[i + 1]?.k).toBe('スプレッドコスト');
    expect(rows[i]?.v).toBe(amt(m.premium.unrealized, 'yen', true));
    expect(m.premium.markedLegs).toBe(3);
    // AC7 と同じ合計（行の含み損益の和）・恒等式
    const sum = pm.rows.reduce((a, r) => a + (r.unrealizedYen ?? 0), 0);
    expect(m.premium.unrealized).toBeCloseTo(sum, 6);
    expect(m.scenarioPoint.pnl).toBeCloseTo(
      m.premium.unrealized + m.premium.entryMismatch - m.premium.fees,
      4,
    );
    expect(Math.abs(m.scenarioPoint.pnl)).toBeGreaterThan(1000);
  });

  it('前の板で建てた足が無ければ含み損益の行は出ない', () => {
    const { m } = metricsAt(t0, s0);
    expect(m.premium.markedLegs).toBe(0);
    expect(metricsBreakdown(m).some((r) => r.k === '含み損益')).toBe(false);
  });
});

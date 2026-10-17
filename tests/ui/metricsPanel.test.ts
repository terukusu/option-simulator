import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { DASH, fmtNum, fmtSigned } from '../../ui/view/format';
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
  tailRows,
} from '../../ui/view/metricsPanel';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';

/** #86 AC-2〜AC-4: 新しい画面の指標パネルの表示モデル。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1] = chain.months;
if (!m1) throw new Error('限月が無い');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = (c: Chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'latest' });

function metricsOf(s: State): MetricsModel {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit });
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

// ------------------------------------------------ 旧 Metrics（ui/components/Metrics.tsx）の dl の文字列の写し

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

describe('タイル 6 枚（#86 AC-2）', () => {
  it('(a) ストラングル売り（受取超）: 1〜6 の値と最大損失の −∞・put 側・SQ = 下端', () => {
    const m = metricsOf(strangle);
    const u = m.unit;
    expect(u).toBe('thousand');
    const tiles = metricTiles(m);
    expect(tiles.map((t) => t.key)).toEqual([
      'maxProfit',
      'maxLoss',
      'bep',
      'premium',
      'scenario',
      'greeks',
    ]);
    expect(tiles.map((t) => t.k)).toEqual([
      '満期 最大利益',
      '満期 最大損失',
      '満期 BEP',
      '受取 − 支払',
      '指定日 + シナリオ',
      '合計グリーク',
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
    expect(t2.s).toContain('SQ = 下端');
    expect(t2.s).toBe(`put 側 ${fmtAmount(lf.value, u, true)} · SQ = 下端`);
    const t3 = tile(tiles, 'bep');
    expect(m.expiry.breakevens.length).toBe(2);
    expect(t3.v).toBe(m.expiry.breakevens.map((x) => fmtNum(x)).join(' / '));
    expect(t3.s).toBe(`指定日 ${fmtXs(m.dateBreakevens)}`);
    expect(t3.unit).toBe('');
    const t4 = tile(tiles, 'premium');
    expect(m.premium.stake).toBeNull();
    expect(t4.k).toBe('受取 − 支払');
    expect(t4.v).toBe(fmtAmount(m.premium.net, u, true));
    expect(t4.s).toBe(
      `受取 ${fmtAmount(m.premium.received, u)} / 支払 ${fmtAmount(m.premium.paid, u)}`,
    );
    const t5 = tile(tiles, 'scenario');
    expect(t5.v).toBe(fmtAmount(m.scenarioPoint.pnl, u, true));
    expect(t5.s).toBe(
      `d ${fmtNum(m.days, 2)} · X ${fmtNum(m.scenarioPoint.x)} (${fmtSigned(m.scenarioPoint.dXPct, 1)}%)`,
    );
    expect(t5.s).toBe(
      `d 1.50 · X ${fmtNum(m.scenarioPoint.x)} (${fmtSigned(m.scenarioPoint.dXPct, 1)}%)`,
    );
    const g = m.scenarioPoint.total;
    const t6 = tile(tiles, 'greeks');
    expect(t6.v).toBe(`Δ ${fmtSigned(g.deltaLarge, 2)} (${fmtSigned(g.deltaMini, 1)})`);
    expect(t6.s).toBe(
      `Γ ${fmtSigned(g.gammaPer100, 3)} · Θ ${fmtAmount(g.thetaPerDay, u, true)} · V ${fmtAmount(g.vegaPerPt, u, true)}`,
    );
    expect(t6.unit).toBe('');
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
    expect(t4.s).toBe(
      `支払 ${fmtAmount(m.premium.paid, u)} / 受取 ${fmtAmount(m.premium.received, u)} / 手数料 ${fmtAmount(m.premium.fees, u)}`,
    );
  });

  it('(c) 色: 正の金額は gain・負は loss・0 と BEP・Δ・掛け金は無色', () => {
    const m = metricsOf(strangle);
    const tiles = metricTiles(m);
    expect(tile(tiles, 'maxProfit').tone).toBe('gain');
    expect(tile(tiles, 'maxLoss').tone).toBe('loss');
    expect(tile(tiles, 'bep').tone).toBeNull();
    expect(tile(tiles, 'premium').tone).toBe('gain');
    expect(tile(tiles, 'greeks').tone).toBeNull();
    const t5 = tile(tiles, 'scenario');
    expect(t5.tone).toBe(
      m.scenarioPoint.pnl > 0 && t5.v.startsWith('+')
        ? 'gain'
        : m.scenarioPoint.pnl < 0 && t5.v.startsWith('−')
          ? 'loss'
          : null,
    );
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
    expect(tile(zt, 'scenario').tone).toBeNull();
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
      r('Δ', `${fmtSigned(g.deltaLarge, 3)} 枚（ミニ ${fmtSigned(g.deltaMini, 2)}）`),
      r('Γ', `${fmtSigned(g.gammaPer100, 4)} / 100 円`),
      r('Θ', `${A(g.thetaPerDay, true)} / 日`),
      r('V', `${A(g.vegaPerPt, true)} / pt`),
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
      tiles: [],
      breakdown: [],
      breakdownNote: '金額の単位 円（自動） · 手数料 0 円 / 枚',
      tailCaption: '',
      tail: [],
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

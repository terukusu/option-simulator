/**
 * 新しい画面の指標パネルの表示モデル（純関数。docs/ui-redesign.md §2・§3・§5・§5.2・§9。#86）。
 *
 * 入力は useAppController の `metrics`（ui/view/metrics.ts の metricsModel の出力）と `state.feePerLot` だけで、
 * metricsModel を呼び直さず数値を作り直さない（fmtAmount・fmtRatio・fmtNum・fmtSigned の出力を連ねるだけ）。
 *
 * - タイル 6 枚: 満期 最大利益・満期 最大損失・満期 BEP・受取 − 支払 or 掛け金・指定日 + シナリオ・合計グリーク
 * - 内訳: 旧画面の内訳の dl（#91 で削除）の項目を同じ順・同じ桁で 2 列の行に
 * - テール表: 5 行 × {SQ, 指定日 + シナリオ}。損益の大きさのバーの長さ（10 セルの |損益| の最大で正規化）
 *
 * 色は整形後の文字列の先頭（+ → gain、− → loss、それ以外 null。丸めて 0 になった値は無色）。
 * 掛け金（符号なしの支払いの額）は無色（読み取りの premium と同じ）。
 */

import { DASH, fmtNum, fmtSigned } from './format';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  fmtAmount,
  fmtRatio,
  type MetricsModel,
} from './metrics';

export type Tone = 'gain' | 'loss' | null;
export type TileKey = 'maxProfit' | 'maxLoss' | 'bep' | 'premium' | 'scenario' | 'greeks';

/** 全文（タイル・読み取りのポップオーバー）の 1 行。見出しと値（値は内訳と同じ関数・同じ桁の文字列） */
export interface FullRow {
  k: string;
  v: string;
}

export interface MetricTile {
  key: TileKey;
  /** 見出し */
  k: string;
  /** 値 */
  v: string;
  /** 値の横に小さく出す単位（— と ∞ には付けない。金額でなければ空） */
  unit: string;
  /** 副題（1 行、入らなければ省略記号） */
  s: string;
  tone: Tone;
  /** 全文（タップ / Enter / Space のポップオーバーの中身。1 行目は見出し + 値。必ず 1 行以上。#107） */
  full: FullRow[];
}

export interface BreakdownRow {
  k: string;
  v: string;
  /** 見出しだけの行（全幅） */
  group: boolean;
}

export interface TailBar {
  /** 0 < width ≤ 100（10 セルの |損益| の最大が 100） */
  width: number;
  tone: 'gain' | 'loss';
}

export interface TailCellView {
  pnl: string;
  ratio: string;
  tone: Tone;
  bar: TailBar | null;
}

export interface TailRowView {
  /** 下落率（キー） */
  key: number;
  pct: string;
  x: string;
  sq: TailCellView;
  scenario: TailCellView;
}

export interface MetricsPanelView {
  empty: boolean;
  /** 見出し行の副題（`千円（自動）` / `円（固定）`） */
  unitSub: string;
  tiles: MetricTile[];
  breakdown: BreakdownRow[];
  /** 内訳の末尾の注記（`金額の単位 … · 手数料 N 円 / 枚`） */
  breakdownNote: string;
  /** テール表の注記（旧 caption と同じ文。empty なら空） */
  tailCaption: string;
  tail: TailRowView[];
}

export const METRICS_EMPTY_TEXT = '足を追加すると指標が出ます';
/** ⓘ の金額の単位の文（旧の「単位の切替で固定にできる」は新しい画面に切替が無いので言い換えた。#87 で設定の文に） */
export const UNIT_HINT =
  '自動: 受取 + 支払が 10 万円以上なら千円、未満なら円。単位の固定・手数料は ⋯ > 設定… で変える。';
/** テール表の指定日の列の説明（旧のテール表の ⓘ と同じ文） */
export const TAIL_HINT =
  '指定日の列 = d・Δσ・Δs・β・動き方はシナリオのまま、原資産だけを各行の値にして再評価（β は行ごとの下落率で IV を上げる）';

/** 原資産の点の並び（旧 Metrics と同じ: 無ければ「なし」、` / ` 区切り） */
export function fmtXs(xs: readonly number[]): string {
  return xs.length === 0 ? 'なし' : xs.map((x) => fmtNum(x)).join(' / ');
}

const fmtPct = (v: number) => `${fmtSigned(v * 100, 0)}%`;

const toneOf = (s: string): Tone =>
  s.startsWith('+') ? 'gain' : s.startsWith('−') ? 'loss' : null;

/** 金額に単位を付けるか（— と ∞ には付けない） */
const unitFor = (value: string, unit: string) =>
  value === DASH || value.endsWith('∞') ? '' : unit;

/** 金額 + 単位の文字列（内訳の値。— と ∞ には単位を付けない） */
export function amountText(v: number | null, u: AmountUnit, signed = false): string {
  const s = fmtAmount(v, u, signed);
  const unit = unitFor(s, AMOUNT_UNIT_LABEL[u]);
  return unit ? `${s} ${unit}` : s;
}

/** 点の並びを 2 点ずつの行に（順は保つ。無ければ「なし」の 1 行） */
function xsChunks(xs: readonly number[]): string[] {
  if (xs.length === 0) return [fmtXs(xs)];
  const out: string[] = [];
  for (let i = 0; i < xs.length; i += 2) out.push(fmtXs(xs.slice(i, i + 2)));
  return out;
}

/** 点の並びの行（2 点ずつ。続きの行の見出しは空。内訳と全文で共用） */
function xsFullRows(k: string, xs: readonly number[]): FullRow[] {
  return xsChunks(xs).map((v, i) => ({ k: i === 0 ? k : '', v }));
}

/** 満期 最大利益の行（内訳と全文で共用。全文は有限の X も出す） */
function maxProfitRows(m: MetricsModel, withX: boolean): FullRow[] {
  const { expiry } = m;
  const rows: FullRow[] = [
    { k: '満期 最大利益', v: amountText(expiry.maxProfit.value, m.unit, true) },
  ];
  if (expiry.profitFinite) {
    rows.push({ k: 'call 側 ∞ / put 側', v: amountText(expiry.profitFinite.value, m.unit, true) });
  } else if (withX && expiry.maxProfit.x !== null) {
    rows.push({ k: 'X', v: fmtNum(expiry.maxProfit.x) });
  }
  return rows;
}

/** 満期 最大損失の行（−∞ なら put 側と SQ = 下端 / X。内訳と全文で共用。全文は有限の X も出す） */
function maxLossRows(m: MetricsModel, withX: boolean): FullRow[] {
  const { expiry } = m;
  const lf = expiry.lossFinite;
  if (lf) {
    const atLo = lf.x === expiry.xLo;
    const rows: FullRow[] = [
      { k: '満期 最大損失', v: 'call 側 −∞' },
      { k: atLo ? 'put 側（SQ = 下端）' : 'put 側', v: amountText(lf.value, m.unit, true) },
    ];
    if (!atLo) rows.push({ k: 'put 側の X', v: fmtNum(lf.x) });
    return rows;
  }
  const rows: FullRow[] = [
    { k: '満期 最大損失', v: amountText(expiry.maxLoss.value, m.unit, true) },
  ];
  if (withX && expiry.maxLoss.x !== null) rows.push({ k: 'X', v: fmtNum(expiry.maxLoss.x) });
  return rows;
}

/** 指定日 + シナリオの d と X の行（内訳と全文で共用） */
function scenarioRows(m: MetricsModel): FullRow[] {
  const sp = m.scenarioPoint;
  return [
    { k: 'd', v: `${fmtNum(m.days, 2)} 日` },
    { k: 'X', v: `${fmtNum(sp.x)}（ΔX ${fmtSigned(sp.dXPct, 1)}%）` },
  ];
}

/** 合計グリーク（シナリオ点）の 4 行（内訳と全文で共用） */
function greekRows(m: MetricsModel): FullRow[] {
  const g = m.scenarioPoint.total;
  const A = (v: number) => amountText(v, m.unit, true);
  return [
    { k: 'Δ', v: `${fmtSigned(g.deltaLarge, 3)} 枚（ミニ ${fmtSigned(g.deltaMini, 2)}）` },
    { k: 'Γ', v: `${fmtSigned(g.gammaPer100, 4)} / 100 円` },
    { k: 'Θ', v: `${A(g.thetaPerDay)} / 日` },
    { k: 'V', v: `${A(g.vegaPerPt)} / pt` },
  ];
}

/**
 * 掛け金 / 受取 − 支払の全文（タイルと舞台の読み取りの premium で共用。値は内訳と同じ桁）。
 * 支払超は掛け金（支払 − 受取 + 手数料）・支払・受取・手数料の合計、受取超は受取 − 支払・受取・支払・手数料の合計
 */
export function premiumFullRows(p: MetricsModel['premium'], u: AmountUnit): FullRow[] {
  const A = (v: number | null, signed = false) => amountText(v, u, signed);
  return p.stake !== null
    ? [
        { k: '掛け金（支払 − 受取 + 手数料）', v: A(p.stake) },
        { k: '支払', v: A(p.paid) },
        { k: '受取', v: A(p.received) },
        { k: '手数料の合計', v: A(p.fees) },
      ]
    : [
        { k: '受取 − 支払', v: A(p.net, true) },
        { k: '受取', v: A(p.received) },
        { k: '支払', v: A(p.paid) },
        { k: '手数料の合計', v: A(p.fees) },
      ];
}

function unitSubOf(m: MetricsModel): string {
  return `${AMOUNT_UNIT_LABEL[m.unit]}${m.unitAuto ? '（自動）' : '（固定）'}`;
}

/** タイル 6 枚（§5 の `.tile`）。empty なら空 */
export function metricTiles(m: MetricsModel): MetricTile[] {
  if (m.empty) return [];
  const u = m.unit;
  const ul = AMOUNT_UNIT_LABEL[u];
  const { expiry, scenarioPoint: sp, premium } = m;
  const g = sp.total;
  const amountTile = (
    key: TileKey,
    k: string,
    v: string,
    s: string,
    full: FullRow[],
    toned = true,
  ): MetricTile => ({
    key,
    k,
    v,
    unit: unitFor(v, ul),
    s,
    tone: toned ? toneOf(v) : null,
    full,
  });

  const maxProfitV = fmtAmount(expiry.maxProfit.value, u, true);
  const maxProfitS = expiry.profitFinite
    ? `put 側 ${fmtAmount(expiry.profitFinite.value, u, true)}`
    : expiry.maxProfit.x !== null
      ? `X ${fmtNum(expiry.maxProfit.x)}`
      : '';

  const maxLossV = fmtAmount(expiry.maxLoss.value, u, true);
  const lf = expiry.lossFinite;
  const maxLossS = lf
    ? `put 側 ${fmtAmount(lf.value, u, true)} · ${lf.x === expiry.xLo ? '下端' : `X ${fmtNum(lf.x)}`}`
    : expiry.maxLoss.x !== null
      ? `X ${fmtNum(expiry.maxLoss.x)}`
      : '';

  const prem =
    premium.stake !== null
      ? amountTile(
          'premium',
          '掛け金',
          fmtAmount(premium.stake, u),
          `支払 ${fmtAmount(premium.paid, u)} · 受取 ${fmtAmount(premium.received, u)}`,
          premiumFullRows(premium, u),
          false,
        )
      : amountTile(
          'premium',
          '受取 − 支払',
          fmtAmount(premium.net, u, true),
          `受取 ${fmtAmount(premium.received, u)} · 支払 ${fmtAmount(premium.paid, u)}`,
          premiumFullRows(premium, u),
        );

  return [
    amountTile('maxProfit', '満期 最大利益', maxProfitV, maxProfitS, maxProfitRows(m, true)),
    amountTile('maxLoss', '満期 最大損失', maxLossV, maxLossS, maxLossRows(m, true)),
    {
      key: 'bep',
      k: '満期 BEP',
      v: fmtXs(expiry.breakevens),
      unit: '',
      s: `指定日 ${fmtXs(m.dateBreakevens)}`,
      tone: null,
      full: [
        ...xsFullRows('満期 BEP', expiry.breakevens),
        ...xsFullRows('指定日 BEP', m.dateBreakevens),
      ],
    },
    prem,
    amountTile(
      'scenario',
      '指定日 + シナリオ',
      fmtAmount(sp.pnl, u, true),
      `d ${fmtNum(m.days, 2)} · X ${fmtNum(sp.x)} (${fmtSigned(sp.dXPct, 1)}%)`,
      [{ k: '指定日 + シナリオ', v: amountText(sp.pnl, u, true) }, ...scenarioRows(m)],
    ),
    {
      key: 'greeks',
      k: '合計グリーク',
      v: `Δ ${fmtSigned(g.deltaLarge, 2)} (${fmtSigned(g.deltaMini, 1)})`,
      unit: '',
      s: `Θ ${fmtAmount(g.thetaPerDay, u, true)} · V ${fmtAmount(g.vegaPerPt, u, true)}`,
      tone: null,
      full: greekRows(m),
    },
  ];
}

/**
 * 内訳の行（旧画面の内訳の dl と同じ順・同じ桁）。1 つの dd に複数の値があった項目は行に分ける。
 * 点の並び（BEP・N 倍の原資産）は 2 点ずつの行に分け、続きの行の見出しは空。empty なら空
 */
export function metricsBreakdown(m: MetricsModel): BreakdownRow[] {
  if (m.empty) return [];
  const u = m.unit;
  const A = (v: number | null, signed = false) => amountText(v, u, signed);
  const { expiry, scenarioPoint: sp, premium } = m;
  const rows: BreakdownRow[] = [];
  const row = (k: string, v: string) => rows.push({ k, v, group: false });
  const group = (k: string) => rows.push({ k, v: '', group: true });
  const add = (rs: readonly FullRow[]) => {
    for (const r of rs) row(r.k, r.v);
  };
  const xsRows = (k: string, xs: readonly number[]) => add(xsFullRows(k, xs));

  // 1 満期 最大利益（+∞ なら反対側を併記）
  add(maxProfitRows(m, false));
  // 2 満期 最大損失（−∞ なら put 側と SQ = 下端 / X）
  add(maxLossRows(m, false));
  // 3 満期 BEP
  xsRows('満期 BEP', expiry.breakevens);
  // 4 指定日 + シナリオ（全文の d の行は「N 日」、内訳は旧と同じ「d = N 日」）
  const [, xRow] = scenarioRows(m);
  row('指定日 + シナリオ', `d = ${fmtNum(m.days, 2)} 日`);
  if (xRow) row(xRow.k, xRow.v);
  row('損益', A(sp.pnl, true));
  xsRows('BEP', m.dateBreakevens);
  // 5 合計グリーク（シナリオ点）
  group('合計グリーク（シナリオ点）');
  add(greekRows(m));
  // 6 受取 / 支払
  row('受取 / 支払', `${A(premium.received)} / ${A(premium.paid)}`);
  row('差引', A(premium.net, true));
  row('OP の手数料込み', A(premium.netAfterFees, true));
  row('手数料の合計', A(premium.fees));
  // 7 支払超のときだけ掛け金と N 倍の原資産
  if (premium.stake !== null) {
    row('掛け金（支払 − 受取 + 手数料）', A(premium.stake));
    if (premium.multiples.length > 0) {
      group('利益が掛け金の N 倍になる原資産（満期）');
      for (const mm of premium.multiples) xsRows(`${mm.n} 倍`, mm.xs);
    }
  }
  // 8 スプレッドコスト / 建値ずれ
  row('スプレッドコスト', A(premium.spreadCost, true));
  row('建値ずれ', A(premium.entryMismatch, true));
  return rows;
}

/** テール表の行（文字列は旧のテール表と同じ）とバーの長さ。empty なら空 */
export function tailRows(m: MetricsModel): TailRowView[] {
  if (m.empty) return [];
  const u = m.unit;
  const rows = m.tail.rows;
  let max = 0;
  for (const r of rows) {
    for (const p of [r.sq.pnl, r.scenario.pnl]) {
      if (Number.isFinite(p) && Math.abs(p) > max) max = Math.abs(p);
    }
  }
  const cell = (pnl: number, ratio: number | null): TailCellView => {
    const s = fmtAmount(pnl, u, true);
    const bar: TailBar | null =
      pnl === 0 || !Number.isFinite(pnl) || max === 0
        ? null
        : { width: (Math.abs(pnl) / max) * 100, tone: pnl > 0 ? 'gain' : 'loss' };
    return { pnl: s, ratio: fmtRatio(ratio), tone: toneOf(s), bar };
  };
  return rows.map((r) => ({
    key: r.shock,
    pct: fmtPct(r.shock),
    x: fmtNum(r.x),
    sq: cell(r.sq.pnl, r.sq.ratio),
    scenario: cell(r.scenario.pnl, r.scenario.ratio),
  }));
}

/** 指標パネル全体の表示モデル */
export function metricsPanel(m: MetricsModel, feePerLot: number): MetricsPanelView {
  const unitSub = unitSubOf(m);
  const breakdownNote = `金額の単位 ${unitSub} · 手数料 ${fmtNum(feePerLot)} 円 / 枚`;
  if (m.empty) {
    return {
      empty: true,
      unitSub,
      tiles: [],
      breakdown: [],
      breakdownNote,
      tailCaption: '',
      tail: [],
    };
  }
  const base = m.tail.premiumBase;
  const tailCaption = `損益（${AMOUNT_UNIT_LABEL[m.unit]}）と倍率 ×|損益 / ${
    base.kind === 'received' ? '受取超（受取 − 支払）' : '掛け金'
  }|（基準 ${fmtAmount(base.amount, m.unit)}）`;
  return {
    empty: false,
    unitSub,
    tiles: metricTiles(m),
    breakdown: metricsBreakdown(m),
    breakdownNote,
    tailCaption,
    tail: tailRows(m),
  };
}

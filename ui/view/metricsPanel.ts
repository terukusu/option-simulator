/**
 * 新しい画面の指標パネルの表示モデル（純関数。docs/ui-redesign.md §2・§3・§5・§5.2・§9。#86）。
 *
 * 入力は useAppController の `metrics`（ui/view/metrics.ts の metricsModel の出力）と `state.feePerLot` だけで、
 * metricsModel を呼び直さず数値を作り直さない（fmtAmount・fmtRatio・fmtNum・fmtSigned の出力を連ねるだけ）。
 *
 * - タイル 6 枚: 満期 最大利益・満期 最大損失・満期 BEP・受取 − 支払 or 掛け金・必要証拠金・余力（#131。値はシナリオの点、
 *   副題は今。計算は ui/view/margin.ts の MarginView）。指定日 + シナリオ・合計グリークは読み取りの帯と同じ値なので
 *   タイルにしない（#274。内訳には残る）。「概算」は見出し行の副題に 1 回（headSub）
 * - 内訳: 旧画面の内訳の dl（#91 で削除）の項目を同じ順・同じ桁で 2 列の行に + 証拠金の群（#131）
 * - テール表: 5 行 × {SQ, 指定日 + シナリオ}。損益の大きさのバーの長さ（10 セルの |損益| の最大で正規化）
 * - テールの証拠金の表（#131）: 5 行 × {必要証拠金, 余力}。余力 < 0 は loss の色と「追証」の印
 *
 * 色は整形後の文字列の先頭（+ → gain、− → loss、それ以外 null。丸めて 0 になった値は無色）。
 * 掛け金（符号なしの支払いの額）は無色（読み取りの premium と同じ）。
 */

import { MARGIN_HORIZON_BUSINESS_DAYS, type MarginParams } from '../../model';
import { DASH, fmtNum, fmtSigned } from './format';
import type { TermId } from './glossary';
import type { MarginCalc, MarginPointAt, MarginView } from './margin';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  amountUnitFor,
  fmtAmount,
  fmtRatio,
  type MetricsModel,
} from './metrics';

export type Tone = 'gain' | 'loss' | null;
/** タイル 6 枚（#274 で 指定日 + シナリオ・合計グリークを外した = 読み取りの帯と同じ値を出さない） */
export type TileKey = 'maxProfit' | 'maxLoss' | 'bep' | 'premium' | 'margin' | 'room';

/** 全文（タイルのポップオーバー）の 1 行。見出しと値（値は内訳と同じ関数・同じ桁の文字列） */
export interface FullRow {
  k: string;
  v: string;
}

export interface MetricTile {
  key: TileKey;
  /** 見出し */
  k: string;
  /**
   * 見出しの横に小さく出す点の印（#164。必要証拠金・余力だけ `· d7 · −4.4%` / `· 今`（#274 で短い形）、他は空。
   * 入らなければ省略記号 = 全文のシナリオ点の行で読む）
   */
  at: string;
  /** 値 */
  v: string;
  /** 値の横に小さく出す単位（— と ∞ には付けない。金額でなければ空） */
  unit: string;
  /** 副題（1 行、入らなければ省略記号） */
  s: string;
  tone: Tone;
  /**
   * 全文（タップ / Enter / Space のポップオーバーの中身。1 行目は見出し + 値。必ず 1 行以上。#107）。
   * FULL_MAX_ROWS 行以下（#161）
   */
  full: FullRow[];
}

/**
 * タイルの全文の行数の上限（#161）。360x780 の「指標」peek の .panel-body は 273px で、吹き出しは
 * 1 行 ≈ 18.9px + 上下の余白 ≈ 22px → 13 行まで入る。余裕を 1 行とって 12
 */
export const FULL_MAX_ROWS = 12;

export interface BreakdownRow {
  k: string;
  v: string;
  /** 見出しだけの行（全幅） */
  group: boolean;
  /**
   * 見出しを押すと開く用語の説明カード（#167。Δ・Γ・Θ・V と証拠金の群の必要証拠金・NOV・証拠金所要額・余力の行だけ。
   * 無ければ押せない今の行のまま）
   */
  term?: TermId;
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

/** テールの証拠金の表の 1 行（#131） */
export interface MarginTailRowView {
  key: number;
  pct: string;
  x: string;
  margin: string;
  /** 余力（資金が未設定なら —） */
  room: string;
  /** 余力 < 0 なら loss（警告の色。≥ 0 は無色 = 利益の色にしない） */
  tone: 'loss' | null;
  /** 余力 < 0（追証の印を出す） */
  call: boolean;
}

export interface MetricsPanelView {
  empty: boolean;
  /** 金額の単位（`千円（自動）` / `円（固定）`。内訳の注記・[AI に聞く] の文） */
  unitSub: string;
  /** 見出し行の副題（unitSub。証拠金があれば ` · 証拠金は概算` を足す。#274） */
  headSub: string;
  tiles: MetricTile[];
  breakdown: BreakdownRow[];
  /** 内訳の末尾の注記（`金額の単位 … · 手数料 N 円 / 枚`） */
  breakdownNote: string;
  /** テール表の注記（旧 caption と同じ文。empty なら空） */
  tailCaption: string;
  tail: TailRowView[];
  /** テールの証拠金の表の注記（#131。empty なら空） */
  marginTailCaption: string;
  marginTail: MarginTailRowView[];
}

export const METRICS_EMPTY_TEXT = '足を追加すると指標が出ます';
/** ⓘ の金額の単位の文（旧の「単位の切替で固定にできる」は新しい画面に切替が無いので言い換えた。#87 で設定の文に） */
export const UNIT_HINT =
  '自動: 受取 + 支払が 10 万円以上なら千円、未満なら円。単位の固定・手数料は ⋯ > 設定… で変える。';
/** テール表の指定日の列の説明（旧のテール表の ⓘ と同じ文） */
export const TAIL_HINT =
  '指定日の列 = d・Δσ・Δs・β・動き方はシナリオのまま、原資産だけを各行の値にして再評価（β は行ごとの下落率で IV を上げる）';

/** 証拠金のタイルの見出し（#274 で「（概算）」はパネルの見出しの副題に 1 回 = MARGIN_APPROX_SUB） */
export const MARGIN_TILE_LABEL = '必要証拠金';
export const ROOM_TILE_LABEL = '余力';
/** 証拠金のタイルの全文の 1 行目（「概算」を常に出す。#131） */
export const MARGIN_FULL_LABEL = '必要証拠金（概算）';
export const ROOM_FULL_LABEL = '余力（概算）';
/** 見出し行の副題の末尾（証拠金があるとき。#274） */
export const MARGIN_APPROX_SUB = ' · 証拠金は概算';
export const MARGIN_GROUP_LABEL = '証拠金（概算・保守寄り）';
export const MARGIN_TAIL_TITLE = '証拠金（概算。指定日 + シナリオ）';
/** 資金が未設定のときの余力のタイルの副題 */
export const ROOM_NO_CAPITAL_TEXT = '資金は ⋯ > 設定…';
/** 余力 < 0 の行の印 */
export const MARGIN_CALL_MARK = '追証';
/** ⓘ の証拠金の文（方式・物差し・NOV・JSCC との違い・既定の決め方・未確認の形・Web 試算で確かめる。設計 5.10・#150） */
export const MARGIN_HINT =
  '必要証拠金は概算: 原資産 ±R・±R/2・0 × 足の今の IV の ×(1 + 上げ) / ×1 / ×(1 − 下げ) × 経過 0 / 2 営業日の格子で、損失の最悪値に掛け目を掛ける。証券会社の建てる前の必要委託証拠金と同じ基準で、受け取るプレミアム（NOV）を含まない。JSCC の VaR 証拠金（過去の値動きとストレスシナリオ）の再現ではない。既定（R 5%・IV +50% / −25%・掛け目 100%）は 1 枚ずつの売りの 6 通りのポジションでの答え合わせ（0.98〜1.07 倍）で決めた。ストレス日・先物との組み合わせなどは未確認で、実額と違いうる。建てる前に JSCC の Web 試算か証券会社の額で確かめ、⋯ > 設定… の幅・掛け目で合わせる。余力 = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 − (必要証拠金 − NOV)。値はシナリオの点（見出しの横に d・ΔX・Δσ・Δs のうち 0 でないもの。全部 0 なら「今」）、副題は今。証券会社の額は前営業日の清算値で 1 日固定（場中に計算し直しても同じ額）、simulator は今の板で計算するので場中の値動きの分だけ違う。';

/** 内訳・全文のシナリオ点の行の見出し（#164） */
export const MARGIN_POINT_ROW_LABEL = 'シナリオ点';
/** タイルの見出しの点の印: 4 つとも 0（今と同じ点。#164） */
export const MARGIN_POINT_NOW_TEXT = '今';
/** シナリオ点の行の値: 4 つとも 0（#164） */
export const MARGIN_POINT_SAME_TEXT = '今と同じ';

/** d の日数（小数 2 桁で丸めて末尾の 0 を落とす: 7 → `7`、1.5 → `1.5`、0.25 → `0.25`） */
const fmtDays = (d: number) => fmtNum(d, 2).replace(/\.?0+$/, '');

/**
 * シナリオの点の部品（#164）: 0 でない d・ΔX・Δσ・Δs だけを順に。ΔX は % の小数 1 桁、% が 0 に丸まるなら円。
 * 4 つとも 0 なら空（今と同じ点。marginNow の条件と同じ）
 */
export function marginPointParts(at: MarginPointAt): string[] {
  const out: string[] = [];
  if (at.days !== 0) out.push(`d ${fmtDays(at.days)} 日`);
  if (at.dX !== 0) {
    const pct = fmtSigned(at.dXPct, 1);
    out.push(/^0(\.0+)?$/.test(pct) ? `ΔX ${fmtSigned(at.dX, 0)} 円` : `ΔX ${pct}%`);
  }
  if (at.dSigma !== 0)
    out.push(`Δσ ${fmtSigned(at.dSigma, 1)}${at.dSigmaUnit === '%' ? '%' : ' pt'}`);
  if (at.skew !== 0) out.push(`Δs ${fmtSigned(at.skew, 1)}`);
  return out;
}

/**
 * タイルの見出しの点の文字列（#164。#274 で短い形 = 2 列のタイルで切れない）: 0 でない d・ΔX・Δσ・Δs を `d10`・`−2.2%`
 * （% が 0 に丸まるなら `+20円`）・`Δσ+3.0`（% の単位なら `Δσ+3.0%`）・`Δs−1.0` にして ` · ` でつなぐ。4 つとも 0 なら「今」
 */
export function marginPointText(at: MarginPointAt): string {
  const out: string[] = [];
  if (at.days !== 0) out.push(`d${fmtDays(at.days)}`);
  if (at.dX !== 0) {
    const pct = fmtSigned(at.dXPct, 1);
    out.push(/^0(\.0+)?$/.test(pct) ? `${fmtSigned(at.dX, 0)}円` : `${pct}%`);
  }
  if (at.dSigma !== 0) out.push(`Δσ${fmtSigned(at.dSigma, 1)}${at.dSigmaUnit === '%' ? '%' : ''}`);
  if (at.skew !== 0) out.push(`Δs${fmtSigned(at.skew, 1)}`);
  return out.length === 0 ? MARGIN_POINT_NOW_TEXT : out.join(' · ');
}

/** 原資産の点の並び（旧 Metrics と同じ: 無ければ「なし」、` / ` 区切り） */
export function fmtXs(xs: readonly number[]): string {
  return xs.length === 0 ? 'なし' : xs.map((x) => fmtNum(x)).join(' / ');
}

const fmtPct = (v: number) => `${fmtSigned(v * 100, 0)}%`;

const toneOf = (s: string): Tone =>
  s.startsWith('+') ? 'gain' : s.startsWith('−') ? 'loss' : null;

/** 金額 + 単位の文字列（内訳の値。— と ∞ には単位を付けない） */
export function amountText(v: number | null, u: AmountUnit, signed = false): string {
  const s = fmtAmount(v, u, signed);
  const unit = amountUnitFor(s, AMOUNT_UNIT_LABEL[u]);
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

/** 指定日 + シナリオの d と X の行（内訳） */
function scenarioRows(m: MetricsModel): FullRow[] {
  const sp = m.scenarioPoint;
  return [
    { k: 'd', v: `${fmtNum(m.days, 2)} 日` },
    { k: 'X', v: `${fmtNum(sp.x)}（ΔX ${fmtSigned(sp.dXPct, 1)}%）` },
  ];
}

/** 合計グリーク（シナリオ点）の 4 行（内訳） */
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
 * 掛け金 / 受取 − 支払の全文（タイル。値は内訳と同じ桁）。
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

/** 数（%・pt）の文字列（整数なら小数なし、端数があれば小数 1 桁） */
const fmtParam = (v: number) => fmtNum(v, Number.isInteger(v) ? 0 : 1);

/** テールの証拠金の表の注記の末尾（買いの OP で減らさない設定のとき。#149） */
export const MARGIN_IGNORE_LONG_MARK = ' · 買い OP 除く';

/** 内訳の前提の「買いの OP」の行の値（#149） */
export const MARGIN_LONG_ROW_TEXT = { ignore: '減らさない', offset: '相殺する' } as const;

/** IV の倍率の文字列（`×` + 小数 3 桁で丸めて末尾の 0 を落とす。1.5 → `×1.5`、0.75 → `×0.75`、1 → `×1`。#150） */
export function ivScaleText(c: number): string {
  return `×${String(Math.round(c * 1000) / 1000)}`;
}

/** IV の幅の文字列（`×1.5 / ×0.75`） */
const ivRangeText = (p: MarginParams) =>
  `${ivScaleText(1 + p.ivUp)} / ${ivScaleText(1 - p.ivDown)}`;

/**
 * 証拠金の前提（`R ±5% · IV ×1.5 / ×0.75 · 2 営業日 · 掛け目 100%`。買いの OP で減らさないなら末尾に
 * ` · 買い OP 除く`）
 */
export function marginParamsText(p: MarginParams): string {
  const r = fmtParam(Math.round(p.range * 1000) / 10);
  const k = fmtParam(Math.round(p.factor * 1000) / 10);
  const long = p.ignoreLongOptions ? MARGIN_IGNORE_LONG_MARK : '';
  return `R ±${r}% · IV ${ivRangeText(p)} · ${MARGIN_HORIZON_BUSINESS_DAYS} 営業日 · 掛け目 ${k}%${long}`;
}

/** 建てられる倍数の文字列（Infinity = 上限なし、資金なし = —） */
export function multipleText(m: number | null): string {
  if (m === null || Number.isNaN(m)) return DASH;
  if (m === Number.POSITIVE_INFINITY) return '上限なし';
  return `${fmtNum(m)} 倍`;
}

/**
 * 格子の最悪の点（X の % · IV の倍率 · 経過の日）。PFE > 0 かつ必要証拠金 > 0 のときだけ
 * （買いだけなど M = 0 のときは最悪の点が額に効かないので出さない。段 A のレビューの指摘 5）
 */
function worstValues(c: MarginCalc | null, p: MarginParams): string[] | null {
  const w = c?.result.worst;
  if (!c || !w || !(c.result.pfe > 0) || !(c.result.margin > 0)) return null;
  const pct = fmtSigned(Math.round(w.priceStep * p.range * 1000) / 10, 1);
  return [`X ${pct}%`, `IV ${ivScaleText(w.ivScale)}`, `経過 +${fmtNum(w.days)} 日`];
}

const marginOf = (c: MarginCalc | null) => (c ? c.result.margin : null);
const roomOf = (c: MarginCalc | null) => (c ? c.room : null);
const roomTone = (v: number | null): 'loss' | null => (v !== null && v < 0 ? 'loss' : null);

/** 状態 1 つ（シナリオ点 / 今）の 4 行 */
interface MarginStateRows {
  margin: FullRow;
  nov: FullRow;
  requirement: FullRow;
  room: FullRow;
}

/**
 * 証拠金の行の群（内訳の群・タイルの全文の材料。#164・#161）: シナリオ点（d・ΔX・Δσ・Δs。今と同じなら 1 行）、
 * シナリオ点と今の必要証拠金（k × PFE）・NOV・証拠金所要額・余力、倍数（今）、最悪の点（シナリオ点）、
 * 前提（R・IV の幅・保有期間・掛け目・買いの OP）。資金が未設定なら余力・倍数は「—」。360px の内訳の 2 列で切れないよう
 * 見出し・値は短く、複数の値は行に分ける（続きの行の見出しは空）
 */
interface MarginGroups {
  point: FullRow[];
  atPoint: MarginStateRows;
  atNow: MarginStateRows;
  multiple: FullRow;
  worst: FullRow[];
  params: FullRow[];
}

function marginGroups(mv: MarginView, u: AmountUnit): MarginGroups {
  const A = (v: number | null) => amountText(v, u);
  const state = (name: string, c: MarginCalc | null): MarginStateRows => ({
    margin: { k: `必要証拠金（${name}）`, v: A(marginOf(c)) },
    nov: { k: `NOV（${name}）`, v: amountText(c ? c.result.nov : null, u, true) },
    requirement: { k: `証拠金所要額（${name}）`, v: A(c ? c.result.requirement : null) },
    room: { k: `余力（${name}）`, v: A(roomOf(c)) },
  });
  const parts = marginPointParts(mv.at);
  const point: FullRow[] =
    parts.length === 0
      ? [{ k: MARGIN_POINT_ROW_LABEL, v: MARGIN_POINT_SAME_TEXT }]
      : parts.map((v, i) => ({ k: i === 0 ? MARGIN_POINT_ROW_LABEL : '', v }));
  const w = worstValues(mv.point, mv.params);
  const p = mv.params;
  return {
    point,
    atPoint: state('シナリオ点', mv.point),
    atNow: state('今', mv.now),
    multiple: { k: '倍数（今）', v: multipleText(mv.now?.multiple ?? null) },
    worst: w === null ? [] : w.map((v, i) => ({ k: i === 0 ? '最悪の点' : '', v })),
    params: [
      { k: '値動き幅 R', v: `±${fmtParam(Math.round(p.range * 1000) / 10)}%` },
      { k: 'IV の幅', v: ivRangeText(p) },
      { k: '保有期間', v: `${MARGIN_HORIZON_BUSINESS_DAYS} 営業日` },
      { k: '掛け目', v: `${fmtParam(Math.round(p.factor * 1000) / 10)}%` },
      {
        k: '買いの OP',
        v: p.ignoreLongOptions ? MARGIN_LONG_ROW_TEXT.ignore : MARGIN_LONG_ROW_TEXT.offset,
      },
    ],
  };
}

const stateList = (s: MarginStateRows): FullRow[] => [s.margin, s.nov, s.requirement, s.room];

/** 合計グリークの 4 行（greekRows の順）の用語（#167） */
const GREEK_TERMS: readonly TermId[] = ['delta', 'gamma', 'theta', 'vega'];
/** 状態 1 つの 4 行（stateList の順）の用語（#167） */
const STATE_TERMS: readonly TermId[] = ['margin', 'nov', 'requirement', 'room'];

/**
 * 必要証拠金のタイルの全文の行（見出しの後。#161）: 値に関わる行だけ、内訳の群と同じ順
 * （シナリオ点・NOV / 証拠金所要額（シナリオ点）・必要証拠金（今）・最悪の点。最大 10 行）
 */
const marginFullRows = (g: MarginGroups): FullRow[] => [
  ...g.point,
  g.atPoint.nov,
  g.atPoint.requirement,
  g.atNow.margin,
  ...g.worst,
];

/** 余力のタイルの全文の行（見出しの後。#161）: シナリオ点・証拠金所要額（シナリオ点）・余力（今）・倍数（今）。最大 7 行 */
const roomFullRows = (g: MarginGroups): FullRow[] => [
  ...g.point,
  g.atPoint.requirement,
  g.atNow.room,
  g.multiple,
];

/** 必要証拠金・余力のタイル（#131。値 = シナリオの点、副題 = 今、見出しの横に点の印 #164） */
function marginTiles(mv: MarginView | null, u: AmountUnit): MetricTile[] {
  const ul = AMOUNT_UNIT_LABEL[u];
  if (!mv) {
    const none = (key: TileKey, k: string, fullK: string): MetricTile => ({
      key,
      k,
      at: '',
      v: DASH,
      unit: '',
      s: '',
      tone: null,
      full: [{ k: fullK, v: DASH }],
    });
    return [
      none('margin', MARGIN_TILE_LABEL, MARGIN_FULL_LABEL),
      none('room', ROOM_TILE_LABEL, ROOM_FULL_LABEL),
    ];
  }
  const g = marginGroups(mv, u);
  const at = `· ${marginPointText(mv.at)}`;
  const mV = fmtAmount(marginOf(mv.point), u);
  const marginTile: MetricTile = {
    key: 'margin',
    k: MARGIN_TILE_LABEL,
    at,
    v: mV,
    unit: amountUnitFor(mV, ul),
    s: `今 ${fmtAmount(marginOf(mv.now), u)}`,
    tone: null,
    full: [{ k: MARGIN_FULL_LABEL, v: amountText(marginOf(mv.point), u) }, ...marginFullRows(g)],
  };
  const room = roomOf(mv.point);
  const rV = mv.capital === null ? DASH : fmtAmount(room, u);
  const roomTile: MetricTile = {
    key: 'room',
    k: ROOM_TILE_LABEL,
    at,
    v: rV,
    unit: amountUnitFor(rV, ul),
    s:
      mv.capital === null
        ? ROOM_NO_CAPITAL_TEXT
        : `今 ${fmtAmount(roomOf(mv.now), u)} · ${multipleText(mv.now?.multiple ?? null)}`,
    tone: roomTone(room),
    full: [
      { k: ROOM_FULL_LABEL, v: mv.capital === null ? DASH : amountText(room, u) },
      ...roomFullRows(g),
    ],
  };
  return [marginTile, roomTile];
}

/** タイル 6 枚（§5 の `.tile`。証拠金の 2 枚は #131。#274 で 8 → 6 枚）。empty なら空 */
export function metricTiles(m: MetricsModel, margin: MarginView | null = null): MetricTile[] {
  if (m.empty) return [];
  const u = m.unit;
  const ul = AMOUNT_UNIT_LABEL[u];
  const { expiry, premium } = m;
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
    at: '',
    v,
    unit: amountUnitFor(v, ul),
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
      at: '',
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
    ...marginTiles(margin, u),
  ];
}

/**
 * 内訳の行（旧画面の内訳の dl と同じ順・同じ桁）。1 つの dd に複数の値があった項目は行に分ける。
 * 点の並び（BEP・N 倍の原資産）は 2 点ずつの行に分け、続きの行の見出しは空。empty なら空
 */
export function metricsBreakdown(
  m: MetricsModel,
  margin: MarginView | null = null,
): BreakdownRow[] {
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
  // 用語の付いた行（#167。rs と terms は同じ順）
  const addTerms = (rs: readonly FullRow[], terms: readonly TermId[]) => {
    rs.forEach((r, i) => {
      const term = terms[i];
      rows.push(
        term === undefined ? { k: r.k, v: r.v, group: false } : { ...r, group: false, term },
      );
    });
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
  addTerms(greekRows(m), GREEK_TERMS);
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
  // 9 証拠金（概算。#131）
  if (margin) {
    group(MARGIN_GROUP_LABEL);
    // シナリオ点・シナリオ点 / 今 × 4・倍数・最悪の点・前提の順。状態の 4 行だけ用語を付ける（#167）
    const g = marginGroups(margin, u);
    add(g.point);
    addTerms(stateList(g.atPoint), STATE_TERMS);
    addTerms(stateList(g.atNow), STATE_TERMS);
    add([g.multiple, ...g.worst, ...g.params]);
  }
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

/** テールの証拠金の表の行（#131。テール表と同じ行・同じ見出し）。empty・証拠金なしなら空 */
export function marginTailRows(m: MetricsModel, margin: MarginView | null): MarginTailRowView[] {
  if (m.empty || !margin) return [];
  const u = m.unit;
  return margin.tail.map((r) => {
    const room = roomOf(r.calc);
    const call = room !== null && room < 0;
    return {
      key: r.shock,
      pct: fmtPct(r.shock),
      x: fmtNum(r.x),
      margin: fmtAmount(marginOf(r.calc), u),
      room: margin.capital === null ? DASH : fmtAmount(room, u),
      tone: roomTone(room),
      call,
    };
  });
}

/** 指標パネル全体の表示モデル（margin = 証拠金の概算。#131。null なら証拠金のタイルは —・表は空） */
export function metricsPanel(
  m: MetricsModel,
  feePerLot: number,
  margin: MarginView | null = null,
): MetricsPanelView {
  const unitSub = unitSubOf(m);
  const headSub = margin ? `${unitSub}${MARGIN_APPROX_SUB}` : unitSub;
  const breakdownNote = `金額の単位 ${unitSub} · 手数料 ${fmtNum(feePerLot)} 円 / 枚`;
  if (m.empty) {
    return {
      empty: true,
      unitSub,
      headSub,
      tiles: [],
      breakdown: [],
      breakdownNote,
      tailCaption: '',
      tail: [],
      marginTailCaption: '',
      marginTail: [],
    };
  }
  const base = m.tail.premiumBase;
  const tailCaption = `損益（${AMOUNT_UNIT_LABEL[m.unit]}）と倍率 ×|損益 / ${
    base.kind === 'received' ? '受取超（受取 − 支払）' : '掛け金'
  }|（基準 ${fmtAmount(base.amount, m.unit)}）`;
  return {
    empty: false,
    unitSub,
    headSub,
    tiles: metricTiles(m, margin),
    breakdown: metricsBreakdown(m, margin),
    breakdownNote,
    tailCaption,
    tail: tailRows(m),
    marginTailCaption: margin
      ? `必要証拠金と余力（${AMOUNT_UNIT_LABEL[m.unit]}）· ${marginParamsText(margin.params)}${
          margin.capital === null ? ' · 資金は ⋯ > 設定…' : ''
        }`
      : '',
    marginTail: marginTailRows(m, margin),
  };
}

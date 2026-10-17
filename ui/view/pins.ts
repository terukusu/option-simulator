/**
 * 損益グラフのピン（#22）の表示モデル（純関数）。設計 docs/design.md M13・6.1・13.4。
 *
 * - 重ね（tab / saved）の基礎: 今の板で足の市場を作り直し（ui/legMarket.ts）、今の評価の設定で positionModel →
 *   pnlDomains（保存一覧の要約 entrySummary と同じ道。手数料・basis は項目の値でなく今の値 = 同じ条件で比べる）
 * - ピンの線は 1 本につき 1 本: 期中（今の線と同じ規則で指定日 + シナリオ、描かない条件なら今日）か満期（全ピン共通の切替）。
 *   期中は PIN_SAMPLE_PX ごと・最大 PIN_MAX_SAMPLES 点で再サンプリング（性能の予算に収める）、満期は解析解の頂点
 * - ゴーストはピンした時点の基礎・シナリオで描く（足・シナリオ・設定・板を後で変えても同じ X で同じ値）。
 *   重ねは今のシナリオ（全タブ共通）で描く。ΔX は線の形に効かない（β は評価点 X' ごと）
 * - 番号ラベル ①②③ は線の右端（縦軸の範囲外なら ↑ / ↓ を付けて端に寄せる）。配置は交点のラベルと同じ規則
 * - 凡例の行: 番号・種類（固定 / タブ / 保存）・名前・条件・満期の最大損失・受取 / 掛け金・シナリオ点での線の損益
 */

import type { Calendar, Chain } from '../../data';
import {
  type AtmBasis,
  type ModelSettings,
  premiumSummary,
  type Scenario,
  theoreticalPnl,
} from '../../model';
import type { Domain } from '../chart/scale';
import { refreshLegMarkets } from '../legMarket';
import {
  type GhostPin,
  PIN_MAX_SAMPLES,
  PIN_SAMPLE_PX,
  PIN_ZOOM_MAX_SAMPLES,
  type Pin,
  type PinLineMode,
  type PinNo,
  type PinPeriodKind,
  pinAddError,
} from '../pins';
import type { Action, TabSlot, UiLeg } from '../state';
import { DASH, fmtNum, fmtSigned, fmtTime } from './format';
import { type AmountUnit, fmtAmount } from './metrics';
import {
  clampDays,
  hasDateLine,
  type PnlBase,
  type PnlChartModel,
  pnlDomains,
  todayScenario,
} from './pnlChart';
import { positionModel } from './position';
import { LABEL_H, placeLabels } from './scenarioMarks';

export const PIN_MARK: Record<PinNo, string> = { 1: '①', 2: '②', 3: '③' };

export const PIN_KIND_LABEL: Record<Pin['kind'], string> = {
  ghost: '固定',
  tab: 'タブ',
  saved: '保存',
};

const PERIOD_LABEL: Record<PinPeriodKind, string> = { date: '指定日', today: '今日' };

// ---------------------------------------------------------------- ゴースト・重ねの基礎

/**
 * 今の線をゴーストにする source（足なし・描ける足が無ければ null）。d は最遠の足の SQ に収め、期中の線の種類は
 * 今の線と同じ規則で決める（ピンした時点で固定）。
 */
export function ghostSource(
  base: PnlBase | null,
  scenario: Scenario,
  tabName: string,
  boardSnapshotAt: number | null,
): GhostPin | null {
  if (!base) return null;
  const { days } = clampDays(scenario, base.maxDays);
  return {
    kind: 'ghost',
    base,
    scenario: { ...scenario, days, dX: 0 },
    period: hasDateLine(scenario, days) ? 'date' : 'today',
    tabName,
    boardSnapshotAt,
  };
}

/** 重ねの基礎（今の板・今の評価の設定）。excluded = 板に無い・評価できない足の本数 */
export interface OverlayBase {
  base: PnlBase | null;
  legCount: number;
  excluded: number;
}

export function overlayBase(
  chain: Chain,
  legs: ReadonlyArray<Omit<UiLeg, 'id'>>,
  atmBasis: AtmBasis,
  calendar: Calendar,
  settings: ModelSettings,
): OverlayBase {
  if (legs.length === 0) return { base: null, legCount: 0, excluded: 0 };
  const ui = refreshLegMarkets(
    chain,
    legs.map((l, i) => ({ ...l, id: i + 1 })),
    calendar.holidays,
  );
  const pm = positionModel(chain, ui, atmBasis, calendar, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  return { base, legCount: legs.length, excluded: legs.length - (base?.legs.length ?? 0) };
}

export interface OverlayInput {
  chain: Chain | null;
  tabs: readonly TabSlot[];
  activeTab: number;
  atmBasis: AtmBasis;
  calendar: Calendar;
  settings: ModelSettings;
}

/**
 * 重ねのピンの基礎（番号 → 基礎）。板・足・評価の設定・タブが変わったときだけ作る（App で memo）。
 * 作業中のタブを指す重ねは作らない（線を描かない。今の線と二重になるため）。
 */
export function overlayBases(
  pins: readonly Pin[],
  input: OverlayInput,
): ReadonlyMap<PinNo, OverlayBase> {
  const out = new Map<PinNo, OverlayBase>();
  const { chain } = input;
  if (!chain) return out;
  for (const p of pins) {
    if (p.kind === 'ghost') continue;
    let legs: ReadonlyArray<Omit<UiLeg, 'id'>> | null;
    if (p.kind === 'saved') legs = p.legs;
    else {
      const slot = input.tabs.find((t) => t.id === p.tabId);
      legs = slot && p.tabId !== input.activeTab ? (slot.saved?.legs ?? null) : null;
    }
    if (legs === null) continue;
    out.set(p.no, overlayBase(chain, legs, input.atmBasis, input.calendar, input.settings));
  }
  return out;
}

// ---------------------------------------------------------------- 描く対象

/** ピン 1 本の描く対象（ゴーストは固定の基礎・シナリオ、重ねは今の板の基礎・今のシナリオ） */
export interface PinTarget {
  no: PinNo;
  kind: Pin['kind'];
  /** タブの名前（ゴーストはピンしたタブ、重ねは今の名前）・保存の名前 */
  name: string;
  base: PnlBase | null;
  /** 線のシナリオ（d は基礎の上限に収めた値。ΔX は 0 = 線の形に効かない） */
  scenario: Scenario;
  period: PinPeriodKind;
  /** 作業中のタブを指す重ね（線を描かない） */
  active: boolean;
  legCount: number;
  excluded: number;
  /** ゴーストの板の時刻（重ねは null） */
  boardSnapshotAt: number | null;
}

export interface ResolveInput {
  tabs: readonly TabSlot[];
  activeTab: number;
  /** 今のシナリオ（重ねに使う。全タブ共通） */
  scenario: Scenario;
  overlays: ReadonlyMap<PinNo, OverlayBase>;
}

export function resolvePins(pins: readonly Pin[], input: ResolveInput): PinTarget[] {
  return pins.map((p): PinTarget => {
    if (p.kind === 'ghost') {
      return {
        no: p.no,
        kind: 'ghost',
        name: p.tabName,
        base: p.base,
        scenario: p.scenario,
        period: p.period,
        active: false,
        legCount: p.base.legs.length,
        excluded: 0,
        boardSnapshotAt: p.boardSnapshotAt,
      };
    }
    const ov = input.overlays.get(p.no);
    const base = ov?.base ?? null;
    const { days } = clampDays(input.scenario, base?.maxDays ?? 0);
    const active = p.kind === 'tab' && p.tabId === input.activeTab;
    const name =
      p.kind === 'tab' ? (input.tabs.find((t) => t.id === p.tabId)?.name ?? DASH) : p.name;
    return {
      no: p.no,
      kind: p.kind,
      name,
      base: active ? null : base,
      scenario: { ...input.scenario, days, dX: 0 },
      period: hasDateLine(input.scenario, days) ? 'date' : 'today',
      active,
      legCount: ov?.legCount ?? (p.kind === 'saved' ? p.legs.length : 0),
      excluded: ov?.excluded ?? 0,
      boardSnapshotAt: null,
    };
  });
}

// ---------------------------------------------------------------- 線

/** ピンの線の関数（描かない = 作業中・基礎なしは null）。 */
export function pinLineFn(t: PinTarget, mode: PinLineMode): ((x: number) => number) | null {
  const b = t.base;
  if (!b || t.active) return null;
  if (mode === 'expiry') return b.expiry;
  const sc = t.period === 'date' ? t.scenario : todayScenario(t.scenario);
  return (x: number) => theoreticalPnl(b.legs, x, sc, b.ctx, b.settings);
}

/**
 * 期中の線の横軸: 表示範囲の両端と、刻み step（表示範囲の幅 / (n − 1)、n = 描画幅 / PIN_SAMPLE_PX + 1、2〜
 * PIN_MAX_SAMPLES）の整数倍の点（横軸の絶対値に固定した格子）。パンでは幅が変わらないので格子が同じになり、
 * 前回の値を使い回せる（新しく入った端の点だけ評価する）。ks = 格子の番号（両端は null）。
 * maxSamples = 点数の上限（拡大縮小の間は PIN_ZOOM_MAX_SAMPLES。pinSampleCap）。
 */
export function pinSampleXs(
  domain: Domain,
  plotWidth: number,
  prevStep?: number,
  maxSamples: number = PIN_MAX_SAMPLES,
): { xs: number[]; ks: Array<number | null>; step: number } {
  const [lo, hi] = domain;
  const n = Math.min(
    Math.max(Math.round(plotWidth / PIN_SAMPLE_PX) + 1, 2),
    Math.max(maxSamples, 2),
  );
  let step = (hi - lo) / (n - 1);
  // パンの丸めの差（幅の最下位桁）では格子を変えない
  if (prevStep !== undefined && Math.abs(prevStep - step) <= step * 1e-9) step = prevStep;
  const xs: number[] = [lo];
  const ks: Array<number | null> = [null];
  if (step > 0 && Number.isFinite(step)) {
    for (let k = Math.ceil(lo / step); k * step < hi; k++) {
      const x = k * step;
      if (x <= lo) continue;
      xs.push(x);
      ks.push(k);
    }
  }
  if (hi > lo) {
    xs.push(hi);
    ks.push(null);
  }
  return { xs, ks, step };
}

export interface PinLineData {
  no: PinNo;
  xs: number[];
  ys: number[];
  /** 期中の線の格子の刻みと、格子の番号 → 値（次のパンで使い回す）。満期は無し */
  grid?: { step: number; vals: Map<number, number> };
}

/**
 * ピンの線の値（表示範囲の全域。描かないなら null）。満期は表示範囲の両端と範囲内の折れ点（解析解）。
 * reuse = 同じ線（基礎・シナリオ・切替・描画幅が同じ）の前回の値。格子が同じなら重なる点を評価しない。
 * maxSamples = 期中の点数の上限（満期は解析解の頂点なので効かない）。
 */
export function pinLineData(
  t: PinTarget,
  domain: Domain,
  plotWidth: number,
  mode: PinLineMode,
  reuse?: PinLineData | null,
  maxSamples: number = PIN_MAX_SAMPLES,
): PinLineData | null {
  const fn = pinLineFn(t, mode);
  const b = t.base;
  if (!fn || !b) return null;
  const [lo, hi] = domain;
  if (mode === 'expiry') {
    const xs = [lo];
    for (const k of b.profile.kinks) if (k > lo && k < hi) xs.push(k);
    xs.push(hi);
    return { no: t.no, xs, ys: xs.map(fn) };
  }
  const prev = reuse?.grid;
  const { xs, ks, step } = pinSampleXs(domain, plotWidth, prev?.step, maxSamples);
  const old = prev && prev.step === step ? prev.vals : null;
  const vals = new Map<number, number>();
  const ys = xs.map((x, i) => {
    const k = ks[i];
    if (k === null || k === undefined) return fn(x);
    const y = old?.get(k) ?? fn(x);
    vals.set(k, y);
    return y;
  });
  return { no: t.no, xs, ys, grid: { step, vals } };
}

/** 線の値の前回分（基礎・シナリオ・表示範囲・幅・切替が同じなら作り直さない） */
export interface PinLineCacheEntry {
  base: PnlBase | null;
  sig: string;
  lo: number;
  hi: number;
  width: number;
  mode: PinLineMode;
  /** 期中の点数の上限（拡大縮小の間の粗い線を、止まった後に通常の点数で作り直すため） */
  max: number;
  data: PinLineData | null;
}

/**
 * 期中の点数の上限: 前回描いた表示範囲の幅（prevSpan）と幅が違う = 拡大縮小のフレームなら PIN_ZOOM_MAX_SAMPLES、
 * それ以外（初回・パン・止まった後の描き直し）は PIN_MAX_SAMPLES。パンの丸めの差（幅の最下位桁）は幅の変化に数えない。
 */
export function pinSampleCap(prevSpan: number | null, domain: Domain | null): number {
  if (!domain || prevSpan === null || !Number.isFinite(prevSpan)) return PIN_MAX_SAMPLES;
  const span = domain[1] - domain[0];
  return Math.abs(span - prevSpan) > Math.abs(span) * 1e-9 ? PIN_ZOOM_MAX_SAMPLES : PIN_MAX_SAMPLES;
}

/** 線の形に効くシナリオの値（ΔX は効かない） */
function lineSig(t: PinTarget): string {
  const s = t.scenario;
  return `${t.active}|${t.period}|${s.days}|${s.dSigma}|${s.skew}|${s.beta}|${s.ivDynamics}|${s.ivShift}`;
}

/**
 * ピンの線の値を前回分を使い回して作る（純関数。戻り値の Map を次回の prev に渡す）。ゴーストはスライダー・
 * 長押しドラッグで作り直さない（基礎・シナリオが同じ）、重ねは ΔX 以外のシナリオが変わったときだけ作り直す。
 * maxSamples = 期中の点数の上限（pinSampleCap）。上限が前回と違えば作り直す（拡大縮小の後の描き直し）。
 */
export function cachedPinLines(
  prev: ReadonlyMap<PinNo, PinLineCacheEntry>,
  targets: readonly PinTarget[],
  domain: Domain | null,
  plotWidth: number,
  mode: PinLineMode,
  maxSamples: number = PIN_MAX_SAMPLES,
): Map<PinNo, PinLineCacheEntry> {
  const out = new Map<PinNo, PinLineCacheEntry>();
  if (!domain) return out;
  const [lo, hi] = domain;
  for (const t of targets) {
    const sig = lineSig(t);
    const p = prev.get(t.no);
    if (
      p &&
      p.base === t.base &&
      p.sig === sig &&
      p.lo === lo &&
      p.hi === hi &&
      p.width === plotWidth &&
      p.mode === mode &&
      p.max === maxSamples
    ) {
      out.set(t.no, p);
      continue;
    }
    out.set(t.no, {
      base: t.base,
      sig,
      lo,
      hi,
      width: plotWidth,
      mode,
      max: maxSamples,
      // 同じ線で表示範囲だけが変わった（パン）なら格子の値を使い回す（刻みが違えば pinLineData が使わない）
      data: pinLineData(
        t,
        domain,
        plotWidth,
        mode,
        p && p.base === t.base && p.sig === sig && p.width === plotWidth && p.mode === mode
          ? p.data
          : null,
        maxSamples,
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 番号ラベル

export interface PinLabel {
  no: PinNo;
  text: string;
  x: number;
  /** 中心の y（dominant-baseline: central） */
  y: number;
  edge: 'top' | 'bottom' | null;
}

/** 線の右端の番号ラベル（縦軸の範囲外は ↑ / ↓ を付けて端に寄せる。重なりは交点のラベルと同じ規則で避ける）。 */
export function pinLabels(chart: Pick<PnlChartModel, 'empty' | 'pins' | 'yDomain' | 'plot'>) {
  if (chart.empty || chart.pins.length === 0) return [];
  const { plot, yDomain } = chart;
  const [y0, y1] = yDomain;
  const items = chart.pins.map((p) => {
    const no = p.no as PinNo;
    const v = p.lastY;
    const edge: PinLabel['edge'] = v > y1 ? 'top' : v < y0 ? 'bottom' : null;
    const raw = Number.isNaN(v)
      ? Number.NaN
      : edge === 'top'
        ? plot.top
        : edge === 'bottom'
          ? plot.top + plot.height
          : plot.top + plot.height - ((v - y0) / (y1 - y0)) * plot.height;
    const arrow = edge === 'top' ? '↑' : edge === 'bottom' ? '↓' : '';
    return { no, edge, py: raw, text: `${arrow}${PIN_MARK[no]}` };
  });
  // 右端に右寄せ（placeLabels は縦線の右に入らなければ左に置く。縦線 = 描画域の右端）
  const placed = placeLabels(
    items.map((it) => ({ py: it.py, text: it.text })),
    plot,
    plot.left + plot.width,
  );
  return items.map(
    (it, i): PinLabel => ({
      no: it.no,
      text: it.text,
      x: placed[i]?.labelX ?? plot.left + plot.width,
      y: placed[i]?.labelY ?? plot.top + LABEL_H / 2,
      edge: it.edge,
    }),
  );
}

// ---------------------------------------------------------------- 凡例の行

export interface PinRowView {
  no: PinNo;
  mark: string;
  kindLabel: string;
  name: string;
  /** 条件（ゴースト: 板の時刻・d・Δσ・Δs・期中の線、重ね: 足の本数・今の板・今のシナリオ） */
  cond: string;
  /** 満期の最大損失 */
  maxLossText: string;
  premiumLabel: string;
  premiumText: string;
  /** シナリオ点 X₀ + ΔX でのピンの線の損益 */
  atScenarioText: string;
  /** 注記（作業中・一部の足を除く・描けない）。無ければ null */
  note: string | null;
  /** 線を描く */
  drawn: boolean;
}

export interface PinListInput {
  targets: readonly PinTarget[];
  mode: PinLineMode;
  /** シナリオ点 X₀ + ΔX（今のポジションの X₀。無ければ NaN） */
  scenarioX: number;
  unit: AmountUnit;
}

function ghostCond(t: PinTarget): string {
  const s = t.scenario;
  return `板 ${fmtTime(t.boardSnapshotAt)} 時点・d ${fmtNum(s.days, s.days % 1 === 0 ? 0 : 2)} 日・Δσ ${fmtSigned(s.dSigma, 1)}pt・Δs ${fmtSigned(s.skew, 1)}・期中 = ${PERIOD_LABEL[t.period]}`;
}

export function pinListModel(input: PinListInput): PinRowView[] {
  const { mode, unit } = input;
  return input.targets.map((t): PinRowView => {
    const b = t.base;
    const fn = pinLineFn(t, mode);
    let premiumLabel = '受取';
    let premiumText = DASH;
    let maxLossText = DASH;
    let atScenarioText = DASH;
    if (b) {
      const prem = premiumSummary(b.legs, b.settings);
      const stake = prem.net < 0;
      premiumLabel = stake ? '掛け金' : '受取';
      premiumText = fmtAmount(stake ? -prem.net + prem.fees : prem.net, unit);
      maxLossText = fmtAmount(b.profile.maxLoss.value, unit, true);
    }
    if (fn && Number.isFinite(input.scenarioX)) {
      atScenarioText = fmtAmount(fn(input.scenarioX), unit, true);
    }
    let note: string | null = null;
    if (t.active) note = '作業中（線は今の線）';
    else if (t.kind !== 'ghost' && t.legCount === 0) note = '足なし';
    else if (t.kind !== 'ghost' && !b) note = '今の板で描けない';
    else if (t.excluded > 0) note = `一部の足を除く（${t.excluded} 本）`;
    const cond =
      t.kind === 'ghost'
        ? ghostCond(t)
        : `足 ${t.legCount} 本・今の板・今のシナリオ${t.kind === 'saved' ? '・今の設定' : ''}`;
    return {
      no: t.no,
      mark: PIN_MARK[t.no],
      kindLabel: PIN_KIND_LABEL[t.kind],
      name: t.name,
      cond,
      maxLossText,
      premiumLabel,
      premiumText,
      atScenarioText,
      note,
      drawn: fn !== null,
    };
  });
}

// ---------------------------------------------------------------- ピンのメニューの行（#89 段 B）

export interface PinMenuInput {
  /** 評価できる足が無い（舞台の noLegs = 基礎が無い） */
  noLegs: boolean;
  pins: readonly PinTarget[];
  pinLine: PinLineMode;
  /** 重ねられるタブ（作業中以外） */
  pinTabs: ReadonlyArray<{ id: number; name: string; legCount: number; pinned: boolean }>;
}

/** 行の実行の記述（データ。今の線を残すは基礎の参照を持つので画面の pinCurrent に任せる） */
export type PinMenuRun = { kind: 'pinCurrent' } | { kind: 'action'; action: Action };

export interface PinMenuRow {
  key: string;
  label: string;
  /** undefined = 押せる（舞台の ⋯ の DOM を変えない） */
  disabled?: boolean;
  /** ピンの線の radio */
  checked?: boolean;
  run: PinMenuRun;
}

/**
 * 舞台の [ピン N/3] のメニューとコマンドパレットのピンの行（同じ規則）: 今の線を残す → `<タブ> を重ねる` →
 * ピンの線: 期中 / 満期 → `<①…> <名前> を外す` → 全部外す。
 * 押せない: 今の線を残す = 足が無い・上限、重ねる = 上限・重ね済み・足 0 本のタブ、全部外す = ピン 0 本。
 */
export function pinMenuRows(i: PinMenuInput): PinMenuRow[] {
  const full = pinAddError(i.pins) !== null;
  return [
    {
      key: 'current',
      label: '今の線を残す',
      disabled: i.noLegs || full,
      run: { kind: 'pinCurrent' },
    },
    ...i.pinTabs.map(
      (t): PinMenuRow => ({
        key: `tab${t.id}`,
        label: `${t.name} を重ねる`,
        disabled: full || t.pinned || t.legCount === 0,
        run: { kind: 'action', action: { type: 'addPin', source: { kind: 'tab', tabId: t.id } } },
      }),
    ),
    {
      key: 'period',
      label: 'ピンの線: 期中',
      checked: i.pinLine === 'period',
      run: { kind: 'action', action: { type: 'setPinLine', line: 'period' } },
    },
    {
      key: 'expiry',
      label: 'ピンの線: 満期',
      checked: i.pinLine === 'expiry',
      run: { kind: 'action', action: { type: 'setPinLine', line: 'expiry' } },
    },
    ...i.pins.map(
      (t): PinMenuRow => ({
        key: `remove${t.no}`,
        label: `${PIN_MARK[t.no]} ${t.name} を外す`,
        run: { kind: 'action', action: { type: 'removePin', no: t.no } },
      }),
    ),
    {
      key: 'clear',
      label: '全部外す',
      disabled: i.pins.length === 0,
      run: { kind: 'action', action: { type: 'clearPins' } },
    },
  ];
}

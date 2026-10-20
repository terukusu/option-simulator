/**
 * 端末の設定（#81。docs/ui-redesign.md §7）。作業の保存（option-simulator.workspace）とは別のキーに置く:
 * テーマは端末の見た目の設定で、ポジションと一緒に保存一覧・書き出し・URL に載せる値ではないため。
 * 純関数だけ（I/O は ui/storage.ts）。読み取りの流儀は ui/persist.ts と同じ
 * （JSON でない・値が不正 → 既定、新しい版 → 読まず、このセッションでは書かない）。
 * #91 より前の旧画面（`?ui=next` なし）はこのキーを読まなかった（#91 で旧画面を削除。どの入口でも読む）。
 *
 * #131 で証拠金の概算の設定（資金・掛け目・値動き幅・IV の上げ / 下げ幅。設計 5.10）を足した。版は 1 のまま
 * （足したキーは省略可・項目ごとに不正ならその項目だけ既定）。版を上げると、ロールバックした旧バンドルが
 * 「新しい版 → 書かない」になりテーマを保存できなくなるため。資金は端末にだけ置く（作業の保存・保存一覧・
 * 書き出し・URL 共有には載せない）。
 * #149 で「買いの OP で証拠金を減らさない」（boolean。既定 true）を足した。版は 1 のまま（無い・boolean でない → 既定）。
 * #150 で IV の幅を pt から比率（%）にし、既定を見直した（R 5%・IV +50% / −25%・掛け目 100%）。掛け目・R・IV の
 * キーを新しくし（margin_k_pct・margin_r_pct・margin_iv_up_pct・margin_iv_down_pct）、古いキー
 * （margin_factor_pct・margin_range_pct・margin_iv_up_pt・margin_iv_down_pt）は読まない・書かない。
 * 書き出しは触っていない項目も既定値で書くので、古い値が利用者の選んだ値か旧既定かを区別できず、読むと新しい
 * 既定が効かないため。資金・買いの OP のキーは今のまま。版は 1 のまま。
 * #135 で「AI の免責の文を見た」（ai_disclaimer_seen。boolean。既定 false。true のときだけ書く）を足した。版は 1 のまま
 * （無い・boolean でない → false。古い画面はこのキーを読まずに書き直すので消えるが、免責の文がもう 1 回出るだけ）。
 * #205 でテクニカル指標の期間（RSI・MACD・ストキャスティクス。model の TechParams）を足した。版は 1 のまま。キーは
 * tech_rsi・tech_macd_fast・tech_macd_slow・tech_macd_signal・tech_stoch_k・tech_stoch_slowing・tech_stoch_d で、既定と
 * 違う項目だけ書く（既定を書き込んで固めない = 既定を見直したら効く）。無い・不正 → 既定（項目ごと）、MACD の短期 ≥ 長期
 * → MACD の 3 つを既定。古い画面はこのキーを読まずに書き直すので消える（期間が既定に戻るだけ）。
 * #206 で EMA の 3 本の期間（tech_ema_short・tech_ema_mid・tech_ema_long）を足した。版は 1 のまま。同じ規則（既定と違う
 * 項目だけ書く、無い・不正 → 項目ごとに既定）で、短期 < 中期 < 長期でなければ EMA の 3 つを既定。#206 より前の保存
 * （キーが無い）は EMA が既定（5・25・75）。
 * #207 で先物推移の指標の段の高さ（fut_pane_h_rsi・fut_pane_h_macd・fut_pane_h_stoch。整数 px・28〜2000）を足した。版は 1 の
 * まま。境目をドラッグしたときに描いている段の高さを書き、既定に戻すとキーを消す。無い・不正 → その段は既定（56px）。
 * 古い画面はこのキーを読まずに書き直すので消える（段の高さが既定に戻るだけ）。
 * #214 でテクニカルの線の太さ（tech_ema_width_px・tech_pane_width_px。px = 1 / 1.25 / 1.5 / 2 / 3。既定と違う項目だけ書く）を
 * 足した。版は 1 のまま。無い（#214 より前の保存）・不正 → 項目ごとに既定。px のキーが無く、作業中の版の段のキー
 * tech_line_width（thin / normal / thick）があれば読み替える（細い → 1、普通 → 既定、太い → 2）。段のキーは書かない。
 * 古い画面はこのキーを読まずに書き直すので消える（既定に戻るだけ）。
 */

import {
  DEFAULT_TECH_PARAMS,
  isEmaOrder,
  isTechParams,
  isTechParamValue,
  TECH_PARAM_KEYS,
  type TechParamKey,
  type TechParams,
} from '../model';
import { IND_KINDS, type IndKind, type IndPaneHeights, isIndPaneH } from './view/indicators';
import {
  DEFAULT_TECH_LINE_WIDTHS,
  isTechLinePx,
  legacyStepWidths,
  TECH_LINE_FIELDS,
  type TechLineKey,
  type TechLineWidths,
} from './view/techLineWidth';

export const PREFS_KEY = 'option-simulator.prefs';
export const PREFS_SCHEMA_VERSION = 1;

/** テーマの設定。auto = 端末に合わせる（prefers-color-scheme） */
export type ThemePref = 'auto' | 'dark' | 'light';
export const THEME_PREFS: readonly ThemePref[] = ['auto', 'dark', 'light'];

/** 証拠金の概算の設定（#131・#150。設計 5.10）。値は画面の単位（%）。model の単位への変換は ui/view/margin.ts */
export interface MarginPrefs {
  /** 資金（円の整数）。null = 未設定（0 も未設定と同じ） */
  capitalYen: number | null;
  /** 掛け目（%。100 = 1 倍） */
  factorPct: number;
  /** 原資産の値動き幅 R（%） */
  rangePct: number;
  /** IV の上げ（%。50 = 状態 S の IV の ×1.5） */
  ivUpPct: number;
  /** IV の下げ（%。25 = 状態 S の IV の ×0.75） */
  ivDownPct: number;
  /** 買いの OP で証拠金を減らさない（true = 売りの OP と先物だけで計算。#149） */
  ignoreLongOptions: boolean;
}

/** 数値の項目（欄で入れるもの。買いの OP の 2 択は除く） */
export type MarginPrefKey = Exclude<keyof MarginPrefs, 'ignoreLongOptions'>;

/** 証拠金の設定の範囲（両端を含む。設計 5.10 の表）。資金は整数 */
export const MARGIN_PREF_RANGE: Record<MarginPrefKey, { min: number; max: number }> = {
  capitalYen: { min: 0, max: 1e12 },
  factorPct: { min: 50, max: 300 },
  rangePct: { min: 1, max: 30 },
  ivUpPct: { min: 0, max: 200 },
  ivDownPct: { min: 0, max: 90 },
};

/** 既定（6 点の答え合わせで決めた。model/margin.ts の DEFAULT_MARGIN_PARAMS と同じ値。資金は未設定。#150） */
export const DEFAULT_MARGIN_PREFS: MarginPrefs = {
  capitalYen: null,
  factorPct: 100,
  rangePct: 5,
  ivUpPct: 50,
  ivDownPct: 25,
  ignoreLongOptions: true,
};

/** 買いの OP の設定の JSON のキー（#149） */
const IGNORE_LONG_JSON_KEY = 'margin_ignore_long_options';

/** JSON のキー（項目ごと。掛け目・R・IV は #150 で新しくした） */
const MARGIN_JSON_KEY: Record<MarginPrefKey, string> = {
  capitalYen: 'capital_yen',
  factorPct: 'margin_k_pct',
  rangePct: 'margin_r_pct',
  ivUpPct: 'margin_iv_up_pct',
  ivDownPct: 'margin_iv_down_pct',
};

/** テクニカル指標の期間の JSON のキー（#205） */
const TECH_JSON_KEY: Record<TechParamKey, string> = {
  rsi: 'tech_rsi',
  macdFast: 'tech_macd_fast',
  macdSlow: 'tech_macd_slow',
  macdSignal: 'tech_macd_signal',
  stochK: 'tech_stoch_k',
  stochSmooth: 'tech_stoch_slowing',
  stochD: 'tech_stoch_d',
  emaShort: 'tech_ema_short',
  emaMid: 'tech_ema_mid',
  emaLong: 'tech_ema_long',
};

export interface Prefs {
  theme: ThemePref;
  margin: MarginPrefs;
  /** テクニカル指標の期間（#205。先物推移の段と AI のツール technicals の両方に使う。無い = 既定。techParamsOfPrefs） */
  technicals?: TechParams;
  /** AI のパネルの免責の文を閉じた（端末で 1 回だけ出す。#135。無い = false） */
  aiDisclaimerSeen?: boolean;
  /** 先物推移の指標の段の高さ（#207。段ごと px。無い段・無い = 既定） */
  futPaneH?: IndPaneHeights;
  /** テクニカルの線の太さ（#214。px。EMA の 3 本と指標の段の線。無い項目・無い = 既定） */
  techLineWidths?: Partial<TechLineWidths>;
}

/** 線の太さの JSON のキー（#214。px） */
const LINE_WIDTH_JSON_KEY: Record<TechLineKey, string> = {
  ema: 'tech_ema_width_px',
  pane: 'tech_pane_width_px',
};
/** 作業中の版の段のキー（thin / normal / thick。読むだけ） */
const LEGACY_LINE_STEP_JSON_KEY = 'tech_line_width';

/** 線の太さを読む（項目ごとに: 無い・不正 → 持たない = 既定。px のキーが 1 つも無ければ段のキーを読み替える）。既定だけなら null */
function readLineWidths(o: Record<string, unknown>): Partial<TechLineWidths> | null {
  const out: Partial<TechLineWidths> = {};
  const hasPx = TECH_LINE_FIELDS.some(({ key }) => LINE_WIDTH_JSON_KEY[key] in o);
  const src: Partial<Record<TechLineKey, unknown>> = hasPx
    ? { ema: o[LINE_WIDTH_JSON_KEY.ema], pane: o[LINE_WIDTH_JSON_KEY.pane] }
    : (legacyStepWidths(o[LEGACY_LINE_STEP_JSON_KEY]) ?? {});
  for (const { key } of TECH_LINE_FIELDS) {
    const v = src[key];
    if (isTechLinePx(v) && v !== DEFAULT_TECH_LINE_WIDTHS[key]) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 段の高さの JSON のキー（#207） */
const PANE_H_JSON_KEY: Record<IndKind, string> = {
  rsi: 'fut_pane_h_rsi',
  macd: 'fut_pane_h_macd',
  stoch: 'fut_pane_h_stoch',
};

/** 段の高さを読む（段ごとに: 無い・不正 → 持たない = 既定）。1 つも無ければ null */
function readPaneH(o: Record<string, unknown>): IndPaneHeights | null {
  const out: IndPaneHeights = {};
  let any = false;
  for (const { value: k } of IND_KINDS) {
    const v = o[PANE_H_JSON_KEY[k]];
    if (isIndPaneH(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/** AI の免責の文を見たかの JSON のキー（#135） */
const AI_DISCLAIMER_JSON_KEY = 'ai_disclaimer_seen';

export const DEFAULT_PREFS: Prefs = { theme: 'auto', margin: { ...DEFAULT_MARGIN_PREFS } };

const defaultPrefs = (): Prefs => ({ theme: 'auto', margin: { ...DEFAULT_MARGIN_PREFS } });

/** 設定のテクニカルの期間（無い・不正 → 既定） */
export function techParamsOfPrefs(p: Prefs): TechParams {
  return techParamsOr(p.technicals);
}

/** 期間の組（無い・不正 → 既定） */
export function techParamsOr(t: TechParams | undefined): TechParams {
  return isTechParams(t) ? t : { ...DEFAULT_TECH_PARAMS };
}

/**
 * 保存したテクニカルの期間を読む（項目ごとに: 無い・不正 → 既定。MACD の短期 ≥ 長期 → MACD の 3 つを既定。
 * EMA が短期 < 中期 < 長期でない → EMA の 3 つを既定。#206）
 */
export function readTechParams(o: Record<string, unknown>): TechParams {
  const t: TechParams = { ...DEFAULT_TECH_PARAMS };
  for (const key of TECH_PARAM_KEYS) {
    const v = o[TECH_JSON_KEY[key]];
    if (isTechParamValue(key, v)) t[key] = v;
  }
  if (t.macdFast >= t.macdSlow) {
    t.macdFast = DEFAULT_TECH_PARAMS.macdFast;
    t.macdSlow = DEFAULT_TECH_PARAMS.macdSlow;
    t.macdSignal = DEFAULT_TECH_PARAMS.macdSignal;
  }
  if (!isEmaOrder(t)) {
    t.emaShort = DEFAULT_TECH_PARAMS.emaShort;
    t.emaMid = DEFAULT_TECH_PARAMS.emaMid;
    t.emaLong = DEFAULT_TECH_PARAMS.emaLong;
  }
  return t;
}

/** 証拠金の項目の値が範囲内か（資金は整数。NaN・∞・数でない値は不可） */
export function isMarginPrefValue(key: MarginPrefKey, v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (key === 'capitalYen' && !Number.isInteger(v)) return false;
  const r = MARGIN_PREF_RANGE[key];
  return v >= r.min && v <= r.max;
}

/** 保存した証拠金の項目を読む（項目ごとに: 無い・不正 → その項目の既定。資金 0 → 未設定） */
function readMargin(o: Record<string, unknown>): MarginPrefs {
  const m: MarginPrefs = { ...DEFAULT_MARGIN_PREFS };
  const cap = o[MARGIN_JSON_KEY.capitalYen];
  m.capitalYen = isMarginPrefValue('capitalYen', cap) && cap > 0 ? cap : null;
  for (const key of ['factorPct', 'rangePct', 'ivUpPct', 'ivDownPct'] as const) {
    const v = o[MARGIN_JSON_KEY[key]];
    if (isMarginPrefValue(key, v)) m[key] = v;
  }
  const ignore = o[IGNORE_LONG_JSON_KEY];
  if (typeof ignore === 'boolean') m.ignoreLongOptions = ignore;
  return m;
}

export interface PrefsRead {
  prefs: Prefs;
  /** false = 新しい版の設定があった（このセッションでは書かない。古い画面が新しい版を上書きしない） */
  writable: boolean;
}

const isThemePref = (v: unknown): v is ThemePref =>
  typeof v === 'string' && (THEME_PREFS as readonly string[]).includes(v);

/** 保存した設定を読む。無い・壊れている → 既定（書いてよい）、版 > 1 → 既定（書かない）。 */
export function readPrefs(text: string | null): PrefsRead {
  const fallback: PrefsRead = { prefs: defaultPrefs(), writable: true };
  if (text === null) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  const version = o.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fallback;
  if (version > PREFS_SCHEMA_VERSION) return { prefs: defaultPrefs(), writable: false };
  if (!isThemePref(o.theme)) return fallback;
  const prefs: Prefs = { theme: o.theme, margin: readMargin(o) };
  // テクニカルの期間（#205）: キーが 1 つも無い（#205 より前の保存・既定のまま）→ 持たない = 既定
  if (TECH_PARAM_KEYS.some((k) => TECH_JSON_KEY[k] in o)) prefs.technicals = readTechParams(o);
  if (o[AI_DISCLAIMER_JSON_KEY] === true) prefs.aiDisclaimerSeen = true;
  const paneH = readPaneH(o);
  if (paneH) prefs.futPaneH = paneH;
  // 線の太さ（#214）: 無い・不正・既定 → 持たない = 既定
  const lw = readLineWidths(o);
  if (lw) prefs.techLineWidths = lw;
  return { prefs, writable: true };
}

/** 書き出す（既知のキーだけ。資金が未設定ならキーを書かない。範囲外・型違いの値は既定にして書く）。 */
export function serializePrefs(p: Prefs): string {
  const out: Record<string, unknown> = { schema_version: PREFS_SCHEMA_VERSION, theme: p.theme };
  const m = p.margin ?? DEFAULT_MARGIN_PREFS;
  if (isMarginPrefValue('capitalYen', m.capitalYen) && m.capitalYen > 0) {
    out[MARGIN_JSON_KEY.capitalYen] = m.capitalYen;
  }
  for (const key of ['factorPct', 'rangePct', 'ivUpPct', 'ivDownPct'] as const) {
    out[MARGIN_JSON_KEY[key]] = isMarginPrefValue(key, m[key]) ? m[key] : DEFAULT_MARGIN_PREFS[key];
  }
  out[IGNORE_LONG_JSON_KEY] =
    typeof m.ignoreLongOptions === 'boolean'
      ? m.ignoreLongOptions
      : DEFAULT_MARGIN_PREFS.ignoreLongOptions;
  if (p.aiDisclaimerSeen === true) out[AI_DISCLAIMER_JSON_KEY] = true;
  // テクニカルの期間は既定と違う項目だけ（組が不正なら書かない = 既定）
  const t = p.technicals;
  if (isTechParams(t)) {
    for (const key of TECH_PARAM_KEYS) {
      if (t[key] !== DEFAULT_TECH_PARAMS[key]) out[TECH_JSON_KEY[key]] = t[key];
    }
  }
  // 段の高さ（#207）は覚えた段だけ（不正な値は書かない = 既定）
  const ph = p.futPaneH;
  if (ph) {
    for (const { value: k } of IND_KINDS) {
      const v = ph[k];
      if (isIndPaneH(v)) out[PANE_H_JSON_KEY[k]] = v;
    }
  }
  // 線の太さ（#214）は既定と違う項目だけ（不正な値は書かない = 既定）
  const lw = p.techLineWidths;
  if (lw) {
    for (const { key } of TECH_LINE_FIELDS) {
      const v = lw[key];
      if (isTechLinePx(v) && v !== DEFAULT_TECH_LINE_WIDTHS[key]) out[LINE_WIDTH_JSON_KEY[key]] = v;
    }
  }
  return JSON.stringify(out);
}

/** `html[data-theme]` に入れる解決した値。auto は端末の設定（prefersLight = prefers-color-scheme: light）。 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  if (pref === 'auto') return prefersLight ? 'light' : 'dark';
  return pref;
}

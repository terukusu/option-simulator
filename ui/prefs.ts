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
 */

export const PREFS_KEY = 'option-simulator.prefs';
export const PREFS_SCHEMA_VERSION = 1;

/** テーマの設定。auto = 端末に合わせる（prefers-color-scheme） */
export type ThemePref = 'auto' | 'dark' | 'light';
export const THEME_PREFS: readonly ThemePref[] = ['auto', 'dark', 'light'];

/** 証拠金の概算の設定（#131。設計 5.10）。値は画面の単位（% と pt）。model の単位への変換は ui/view/margin.ts */
export interface MarginPrefs {
  /** 資金（円の整数）。null = 未設定（0 も未設定と同じ） */
  capitalYen: number | null;
  /** 掛け目（%。120 = 1.2 倍） */
  factorPct: number;
  /** 原資産の値動き幅 R（%） */
  rangePct: number;
  /** IV の上げ幅（pt） */
  ivUpPt: number;
  /** IV の下げ幅（pt） */
  ivDownPt: number;
}

export type MarginPrefKey = keyof MarginPrefs;

/** 証拠金の設定の範囲（両端を含む。設計 5.10 の表）。資金は整数 */
export const MARGIN_PREF_RANGE: Record<MarginPrefKey, { min: number; max: number }> = {
  capitalYen: { min: 0, max: 1e12 },
  factorPct: { min: 50, max: 300 },
  rangePct: { min: 1, max: 30 },
  ivUpPt: { min: 0, max: 50 },
  ivDownPt: { min: 0, max: 30 },
};

/** 既定（仮置き。model/margin.ts の DEFAULT_MARGIN_PARAMS と同じ値。資金は未設定） */
export const DEFAULT_MARGIN_PREFS: MarginPrefs = {
  capitalYen: null,
  factorPct: 120,
  rangePct: 8,
  ivUpPt: 8,
  ivDownPt: 4,
};

/** JSON のキー（項目ごと） */
const MARGIN_JSON_KEY: Record<MarginPrefKey, string> = {
  capitalYen: 'capital_yen',
  factorPct: 'margin_factor_pct',
  rangePct: 'margin_range_pct',
  ivUpPt: 'margin_iv_up_pt',
  ivDownPt: 'margin_iv_down_pt',
};

export interface Prefs {
  theme: ThemePref;
  margin: MarginPrefs;
}

export const DEFAULT_PREFS: Prefs = { theme: 'auto', margin: { ...DEFAULT_MARGIN_PREFS } };

const defaultPrefs = (): Prefs => ({ theme: 'auto', margin: { ...DEFAULT_MARGIN_PREFS } });

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
  for (const key of ['factorPct', 'rangePct', 'ivUpPt', 'ivDownPt'] as const) {
    const v = o[MARGIN_JSON_KEY[key]];
    if (isMarginPrefValue(key, v)) m[key] = v;
  }
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
  return { prefs: { theme: o.theme, margin: readMargin(o) }, writable: true };
}

/** 書き出す（既知のキーだけ。資金が未設定ならキーを書かない。範囲外の値は既定にして書く）。 */
export function serializePrefs(p: Prefs): string {
  const out: Record<string, unknown> = { schema_version: PREFS_SCHEMA_VERSION, theme: p.theme };
  const m = p.margin ?? DEFAULT_MARGIN_PREFS;
  if (isMarginPrefValue('capitalYen', m.capitalYen) && m.capitalYen > 0) {
    out[MARGIN_JSON_KEY.capitalYen] = m.capitalYen;
  }
  for (const key of ['factorPct', 'rangePct', 'ivUpPt', 'ivDownPt'] as const) {
    out[MARGIN_JSON_KEY[key]] = isMarginPrefValue(key, m[key]) ? m[key] : DEFAULT_MARGIN_PREFS[key];
  }
  return JSON.stringify(out);
}

/** `html[data-theme]` に入れる解決した値。auto は端末の設定（prefersLight = prefers-color-scheme: light）。 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  if (pref === 'auto') return prefersLight ? 'light' : 'dark';
  return pref;
}

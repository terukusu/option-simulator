/**
 * 端末の設定（#81。docs/ui-redesign.md §7）。作業の保存（option-simulator.workspace）とは別のキーに置く:
 * テーマは端末の見た目の設定で、ポジションと一緒に保存一覧・書き出し・URL に載せる値ではないため。
 * 純関数だけ（I/O は ui/storage.ts）。読み取りの流儀は ui/persist.ts と同じ
 * （JSON でない・値が不正 → 既定、新しい版 → 読まず、このセッションでは書かない）。
 * #91 より前の旧画面（`?ui=next` なし）はこのキーを読まなかった（#91 で旧画面を削除。どの入口でも読む）。
 */

export const PREFS_KEY = 'option-simulator.prefs';
export const PREFS_SCHEMA_VERSION = 1;

/** テーマの設定。auto = 端末に合わせる（prefers-color-scheme） */
export type ThemePref = 'auto' | 'dark' | 'light';
export const THEME_PREFS: readonly ThemePref[] = ['auto', 'dark', 'light'];

export interface Prefs {
  theme: ThemePref;
}

export const DEFAULT_PREFS: Prefs = { theme: 'auto' };

export interface PrefsRead {
  prefs: Prefs;
  /** false = 新しい版の設定があった（このセッションでは書かない。古い画面が新しい版を上書きしない） */
  writable: boolean;
}

const isThemePref = (v: unknown): v is ThemePref =>
  typeof v === 'string' && (THEME_PREFS as readonly string[]).includes(v);

/** 保存した設定を読む。無い・壊れている → 既定（書いてよい）、版 > 1 → 既定（書かない）。 */
export function readPrefs(text: string | null): PrefsRead {
  const fallback: PrefsRead = { prefs: { ...DEFAULT_PREFS }, writable: true };
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
  if (version > PREFS_SCHEMA_VERSION) return { prefs: { ...DEFAULT_PREFS }, writable: false };
  if (!isThemePref(o.theme)) return fallback;
  return { prefs: { theme: o.theme }, writable: true };
}

/** 書き出す（既知のキーだけ）。 */
export function serializePrefs(p: Prefs): string {
  return JSON.stringify({ schema_version: PREFS_SCHEMA_VERSION, theme: p.theme });
}

/** `html[data-theme]` に入れる解決した値。auto は端末の設定（prefersLight = prefers-color-scheme: light）。 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): 'dark' | 'light' {
  if (pref === 'auto') return prefersLight ? 'light' : 'dark';
  return pref;
}

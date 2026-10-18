import { useLayoutEffect } from 'preact/hooks';
import { useMediaQuery } from '../components/useMediaQuery';
import { resolveTheme, type ThemePref } from '../prefs';

/** 端末のライトの設定（テーマが「端末に合わせる」のときだけ効く） */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * テーマ（#81。docs/ui-redesign.md §7）。設定の値と書き込みは usePrefs（ui/next/usePrefs.ts。#131 で
 * 証拠金の設定と同じキーに全体を書くようにした）。html[data-theme] には解決した値（dark / light）を入れる
 * （color-scheme は tokens.css がテーマに合わせる）。最初の値は ui/main.tsx が描く前に入れる（ちらつかない）。
 */
export function useTheme(pref: ThemePref, choose: (theme: ThemePref) => void) {
  const prefersLight = useMediaQuery(LIGHT_QUERY);
  const resolved = resolveTheme(pref, prefersLight);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return { pref, resolved, choose };
}

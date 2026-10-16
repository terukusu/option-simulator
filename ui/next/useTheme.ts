import { useCallback, useLayoutEffect, useState } from 'preact/hooks';
import { useMediaQuery } from '../components/useMediaQuery';
import { PREFS_KEY, type PrefsRead, resolveTheme, serializePrefs, type ThemePref } from '../prefs';
import { writeKey } from '../storage';

/** 端末のライトの設定（テーマが「端末に合わせる」のときだけ効く） */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * テーマ（#81。docs/ui-redesign.md §7）。設定は端末のキー option-simulator.prefs（ui/prefs.ts）。
 * html[data-theme] には解決した値（dark / light）を入れる（color-scheme は tokens.css がテーマに合わせる）。
 * 最初の値は ui/main.tsx が描く前に入れる（ちらつかない）。別のタブの変更は次に開いたときに反映する。
 */
export function useTheme(initial: PrefsRead, storage: Storage | null) {
  const [pref, setPref] = useState<ThemePref>(initial.prefs.theme);
  const prefersLight = useMediaQuery(LIGHT_QUERY);
  const resolved = resolveTheme(pref, prefersLight);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  const { writable } = initial;
  const choose = useCallback(
    (theme: ThemePref) => {
      setPref(theme);
      // 新しい版の設定があったら書かない（このセッションの見た目だけ変える）。書けなくても画面は続ける
      if (writable) writeKey(storage, PREFS_KEY, serializePrefs({ theme }));
    },
    [storage, writable],
  );
  return { pref, resolved, choose };
}

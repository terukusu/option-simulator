import { useCallback, useRef, useState } from 'preact/hooks';
import {
  type MarginPrefs,
  PREFS_KEY,
  type Prefs,
  type PrefsRead,
  serializePrefs,
  type ThemePref,
} from '../prefs';
import { writeKey } from '../storage';

/**
 * 端末の設定（option-simulator.prefs。ui/prefs.ts）の state（#131）。テーマと証拠金の設定を 1 つの値で持ち、
 * 書くときは全体を serializePrefs で書く（片方だけを書いて他方のキーを消さない）。新しい版の設定があったら
 * 書かない（このセッションの値だけ変える）。書けなくても画面は続ける。別のタブの変更は次に開いたときに反映する。
 */
export function usePrefs(initial: PrefsRead, storage: Storage | null) {
  const [prefs, setPrefs] = useState<Prefs>(initial.prefs);
  // 連続の更新でも最新の値から作る（setState の関数形の中で書き込みの副作用を起こさない）
  const ref = useRef(prefs);
  const { writable } = initial;
  const commit = useCallback(
    (next: Prefs) => {
      ref.current = next;
      setPrefs(next);
      if (writable) writeKey(storage, PREFS_KEY, serializePrefs(next));
    },
    [storage, writable],
  );
  const setTheme = useCallback((theme: ThemePref) => commit({ ...ref.current, theme }), [commit]);
  const setMargin = useCallback(
    (patch: Partial<MarginPrefs>) =>
      commit({ ...ref.current, margin: { ...ref.current.margin, ...patch } }),
    [commit],
  );
  return { prefs, setTheme, setMargin };
}

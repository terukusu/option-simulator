import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { isTechParams, sameTechParams, type TechParams } from '../../model';
import {
  type MarginPrefs,
  PREFS_KEY,
  type Prefs,
  type PrefsRead,
  serializePrefs,
  type ThemePref,
  techParamsOfPrefs,
  techParamsOr,
} from '../prefs';
import { writeKey } from '../storage';

/**
 * 端末の設定（option-simulator.prefs。ui/prefs.ts）の state（#131）。テーマ・証拠金・テクニカルの期間（#205）を 1 つの値で持ち、
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
  const setAiDisclaimerSeen = useCallback(
    () => commit({ ...ref.current, aiDisclaimerSeen: true }),
    [commit],
  );
  // テクニカルの期間（#205）: 組で受け取り、検査は呼ぶ側（設定の欄）。同じ値なら作り直さない（段の再計算を起こさない）
  const setTechnicals = useCallback(
    (patch: Partial<TechParams>) => {
      const cur = techParamsOfPrefs(ref.current);
      const next = { ...cur, ...patch };
      // 組として不正（範囲外・MACD の短期 ≥ 長期）なら保存しない（読むときに 7 つとも既定に戻るのを防ぐ）
      if (!isTechParams(next) || sameTechParams(cur, next)) return;
      commit({ ...ref.current, technicals: next });
    },
    [commit],
  );
  // 段とツールに渡す期間（保存した組が変わったときだけ作り直す = 指標の再計算は期間が変わったときだけ）
  const stored = prefs.technicals;
  const technicals = useMemo(() => techParamsOr(stored), [stored]);
  return { prefs, technicals, setTheme, setMargin, setAiDisclaimerSeen, setTechnicals };
}

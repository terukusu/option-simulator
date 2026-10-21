import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import { isTechParams, sameTechParams, type TechParams } from '../../model';
import {
  isAiProfile,
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
import type { IndPaneHeights } from '../view/indicators';
import {
  DEFAULT_TECH_LINE_WIDTHS,
  TECH_LINE_FIELDS,
  type TechLineWidths,
  techLineWidthsOr,
} from '../view/techLineWidth';

/**
 * 端末の設定（option-simulator.prefs。ui/prefs.ts）の state（#131）。テーマ・証拠金・テクニカルの期間（#205）・線の太さ（#214）・AI に渡す自分の前提（#156）などを 1 つの値で持ち、
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
      // 組として不正（範囲外・MACD の短期 ≥ 長期・EMA の短期 < 中期 < 長期でない）なら保存しない（読むときに既定に戻るのを防ぐ）
      if (!isTechParams(next) || sameTechParams(cur, next)) return;
      commit({ ...ref.current, technicals: next });
    },
    [commit],
  );
  // 先物推移の段の高さ（#207）: 描いている段の高さを足し合わせて書く（ほかの段の値は残す）。null = 既定に戻す（キーを消す）
  const setFutPaneH = useCallback(
    (patch: IndPaneHeights | null) => {
      const { futPaneH: _old, ...rest } = ref.current;
      if (patch === null) {
        if (_old) commit(rest);
        return;
      }
      commit({ ...rest, futPaneH: { ..._old, ...patch } });
    },
    [commit],
  );
  // テクニカルの線の太さ（#214。px）: 既定の項目は持たない（書かない）。同じ値なら書かない
  const setTechLineWidths = useCallback(
    (patch: Partial<TechLineWidths>) => {
      const { techLineWidths: old, ...rest } = ref.current;
      const cur = techLineWidthsOr(old);
      const next = techLineWidthsOr({ ...cur, ...patch });
      if (next.ema === cur.ema && next.pane === cur.pane) return;
      const kept: Partial<TechLineWidths> = {};
      for (const { key } of TECH_LINE_FIELDS) {
        if (next[key] !== DEFAULT_TECH_LINE_WIDTHS[key]) kept[key] = next[key];
      }
      commit(Object.keys(kept).length > 0 ? { ...rest, techLineWidths: kept } : rest);
    },
    [commit],
  );
  // AI に渡す自分の前提（#156）: 空白だけ・空 → キーを消す。上限を超える値は保存しない（検査は呼ぶ側の欄）。同じなら書かない
  const setAiProfile = useCallback(
    (text: string) => {
      const { aiProfile: old, ...rest } = ref.current;
      if (text.trim() === '') {
        if (old !== undefined) commit(rest);
        return;
      }
      if (!isAiProfile(text) || text === old) return;
      commit({ ...rest, aiProfile: text });
    },
    [commit],
  );
  const storedLw = prefs.techLineWidths;
  const techLineWidths = useMemo(() => techLineWidthsOr(storedLw), [storedLw]);
  // 段とツールに渡す期間（保存した組が変わったときだけ作り直す = 指標の再計算は期間が変わったときだけ）
  const stored = prefs.technicals;
  const technicals = useMemo(() => techParamsOr(stored), [stored]);
  return {
    prefs,
    technicals,
    setTheme,
    setMargin,
    setAiDisclaimerSeen,
    setTechnicals,
    setFutPaneH,
    techLineWidths,
    setTechLineWidths,
    setAiProfile,
  };
}

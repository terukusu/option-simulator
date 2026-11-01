/**
 * 銘柄の推移（#319）の読み込みの状態（DOM を持たない常駐のフック。NextApp が持つ = 閉じても最近の分は残る）。
 * 規則は IV 推移・先物推移（useIvHistory）と同じ: 見えている（active）ときに、まだ読んでいないキー（銘柄 × 足）だけを
 * 1 回読む。自動では読み直さない（トップバーの [最新] でも読まない）。失敗は [再試行]、⟳ で読み直す。最近の
 * OPT_MEMO_SIZE キーをメモリに持つ（保存しない）。銘柄の一生を 1 回で読む（左右の追加読み込みは無い）。
 * 表示の形（ローソク / 線）と足はここに持つ（銘柄を替えても保つ。保存しない）。
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { loadOptionBars, type OptionBarsData, type OptionBarsTf } from '../../data';
import { IV_DEFAULT_MODE, type IvMode } from '../view/ivHistory';
import { OPT_DEFAULT_TF, type OptTarget, optKey } from '../view/optHistory';

/** 1 キーの読み込み（loading の間も前の data を持つ = ⟳ の間は前の足を描く） */
export interface OptEntry {
  status: 'loading' | 'ready' | 'failed';
  data: OptionBarsData | null;
}

/** メモリに持つキーの数（最近の分） */
export const OPT_MEMO_SIZE = 8;

export interface OptionBarsCtl {
  tf: OptionBarsTf;
  mode: IvMode;
  /** 今の銘柄 × 足の読み込み（まだ無ければ null） */
  entry: OptEntry | null;
  setTf: (tf: OptionBarsTf) => void;
  setMode: (mode: IvMode) => void;
  retry: () => void;
  refresh: () => void;
}

/**
 * target = 開いている銘柄（無ければ null）、active = 見えている、endpoint = 本番は /api/option_bars（dev の合成の板・
 * ファイルでは /fixtures/option_bars）
 */
export function useOptionBars(
  target: OptTarget | null,
  active: boolean,
  endpoint: string,
): OptionBarsCtl {
  const [tf, setTfState] = useState<OptionBarsTf>(OPT_DEFAULT_TF);
  const [mode, setMode] = useState<IvMode>(IV_DEFAULT_MODE);
  const [memo, setMemo] = useState<ReadonlyMap<string, OptEntry>>(() => new Map());
  const memoRef = useRef(memo);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const inflight = useRef(new Map<string, AbortController>());

  const put = useCallback((key: string, e: OptEntry) => {
    const next = new Map(memoRef.current);
    next.delete(key);
    next.set(key, e);
    while (next.size > OPT_MEMO_SIZE) {
      const oldest = next.keys().next().value as string;
      next.delete(oldest);
      inflight.current.get(oldest)?.abort();
      inflight.current.delete(oldest);
    }
    memoRef.current = next;
    setMemo(next);
  }, []);

  const start = useCallback(
    (t: OptTarget, f: OptionBarsTf) => {
      const key = optKey(t, f);
      if (inflight.current.has(key)) return;
      const prev = memoRef.current.get(key);
      put(key, { status: 'loading', data: prev?.data ?? null });
      const ac = new AbortController();
      inflight.current.set(key, ac);
      loadOptionBars(
        f,
        { ltd: t.ltd, k: t.k, type: t.type },
        { endpoint: endpointRef.current, signal: ac.signal },
      ).then(
        (data) => {
          if (inflight.current.get(key) !== ac) return;
          inflight.current.delete(key);
          put(key, { status: 'ready', data });
        },
        (e: unknown) => {
          if (inflight.current.get(key) !== ac) return;
          inflight.current.delete(key);
          if (e instanceof Error && e.name === 'AbortError') return;
          put(key, { status: 'failed', data: memoRef.current.get(key)?.data ?? null });
        },
      );
    },
    [put],
  );

  const key = target ? optKey(target, tf) : null;
  // 見えたら、まだ読んでいないキーだけを読む（失敗したキーは [再試行] まで読まない）
  useEffect(() => {
    if (!active || !target || key === null) return;
    if (memoRef.current.has(key)) return;
    start(target, tf);
  }, [active, target, tf, key, start]);
  useEffect(
    () => () => {
      for (const ac of inflight.current.values()) ac.abort();
      inflight.current.clear();
    },
    [],
  );

  const targetRef = useRef(target);
  targetRef.current = target;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const reload = useCallback(() => {
    const t = targetRef.current;
    if (t) start(t, tfRef.current);
  }, [start]);
  const setTf = useCallback((f: OptionBarsTf) => setTfState(f), []);

  return {
    tf,
    mode,
    entry: key === null ? null : (memo.get(key) ?? null),
    setTf,
    setMode,
    retry: reload,
    refresh: reload,
  };
}

/**
 * IV 推移（#79）の読み込みと見え方の状態（DOM を持たない常駐のフック。NextApp が持つ = パネルを閉じても残る）。
 * 規則は ui/view/ivLoad.ts（reducer）と ui/view/ivHistory.ts。ここは fetch・AbortController と、表示の形・表示範囲・
 * 足の切替の前の時間の範囲（keep）を持つだけ。保存しない（アプリの再読み込みで消える = 開くたびに最新）。
 *
 * - active（IV 推移が見えている）が true になるたびに open を送る（読むのは初めての 1 回だけ。reducer が決める）
 * - トップバーの [最新] では読み直さない（最新化ボタンだけ。docs/ui-redesign.md §4.7）
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { type IvBar, loadAtmIv } from '../../data';
import type { Domain } from '../chart/scale';
import {
  barsForTf,
  IV_DEFAULT_MODE,
  type IvKeep,
  type IvMode,
  type IvTf,
  ivKeepOf,
  ivSource,
  resolveIvViewport,
} from '../view/ivHistory';
import {
  INITIAL_IV_LOAD,
  type IvLoadAction,
  type IvLoadState,
  type IvRequest,
  ivLoadReduce,
} from '../view/ivLoad';

export interface IvView {
  mode: IvMode;
  /** 明示の表示範囲（index。null = 控えか初期表示） */
  viewport: Domain | null;
  /** 足の切替の前の時間の範囲 */
  keep: IvKeep | null;
}

export interface IvHistoryCtl {
  load: IvLoadState;
  view: IvView;
  refresh: () => void;
  retry: () => void;
  setTf: (tf: IvTf) => void;
  setMode: (mode: IvMode) => void;
  setViewport: (v: Domain | null) => void;
}

const INITIAL_VIEW: IvView = { mode: IV_DEFAULT_MODE, viewport: null, keep: null };

/** 今の足の表示する足（5 分・15 分は 1 分から束ねる） */
function shownBars(s: IvLoadState, tf: IvTf): readonly IvBar[] {
  const e = s.entries[ivSource(tf)];
  return e ? barsForTf(e.bars, tf) : [];
}

/**
 * endpoint は同一オリジンの相対 URL（本番は /api/atm_iv。dev の合成の板・ファイルでは /fixtures/atm_iv）。
 */
export function useIvHistory(active: boolean, endpoint: string): IvHistoryCtl {
  const [load, setLoad] = useState<IvLoadState>(INITIAL_IV_LOAD);
  const [view, setView] = useState<IvView>(INITIAL_VIEW);
  const loadRef = useRef(load);
  const viewRef = useRef(view);
  viewRef.current = view;
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const ctrl = useRef<{ id: number; ac: AbortController } | null>(null);

  const run = useCallback((a: IvLoadAction) => {
    const r = ivLoadReduce(loadRef.current, a);
    if (r.state === loadRef.current && !r.request && r.abort === null) return;
    loadRef.current = r.state;
    setLoad(r.state);
    if (r.abort !== null && ctrl.current?.id === r.abort) {
      ctrl.current.ac.abort();
      ctrl.current = null;
    }
    if (r.request) start(r.request);
  }, []);

  function start(req: IvRequest) {
    const ac = new AbortController();
    ctrl.current = { id: req.id, ac };
    loadAtmIv(req.src, { endpoint: endpointRef.current, signal: ac.signal }).then(
      (data) => {
        if (ctrl.current?.id === req.id) ctrl.current = null;
        run({ type: 'loaded', id: req.id, data });
      },
      (e: unknown) => {
        if (ctrl.current?.id === req.id) ctrl.current = null;
        if (e instanceof Error && e.name === 'AbortError') return;
        run({ type: 'failed', id: req.id });
      },
    );
  }

  useEffect(() => {
    if (active) run({ type: 'open' });
  }, [active, run]);
  useEffect(
    () => () => {
      ctrl.current?.ac.abort();
      ctrl.current = null;
    },
    [],
  );

  const refresh = useCallback(() => run({ type: 'refresh' }), [run]);
  const retry = useCallback(() => run({ type: 'retry' }), [run]);
  const setTf = useCallback(
    (tf: IvTf) => {
      const s = loadRef.current;
      if (tf === s.tf) return;
      // 見ていた時間の範囲を控えてから替える（表示範囲は控えから作り直す）
      const v = viewRef.current;
      const bars = shownBars(s, s.tf);
      const keep =
        bars.length > 0
          ? ivKeepOf(bars, resolveIvViewport(bars, s.tf, v.viewport, v.keep))
          : v.keep;
      setView({ ...v, viewport: null, keep });
      run({ type: 'setTf', tf });
    },
    [run],
  );
  const setMode = useCallback((mode: IvMode) => setView((v) => ({ ...v, mode })), []);
  const setViewport = useCallback(
    (viewport: Domain | null) =>
      setView((v) => ({ ...v, viewport, keep: viewport ? v.keep : null })),
    [],
  );
  return { load, view, refresh, retry, setTf, setMode, setViewport };
}

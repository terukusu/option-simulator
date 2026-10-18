/**
 * IV 推移（#79）の読み込みと見え方の状態（DOM を持たない常駐のフック。NextApp が持つ = パネルを閉じても残る）。
 * 規則は ui/view/ivLoad.ts（reducer）と ui/view/ivHistory.ts。ここは fetch・AbortController と、表示の形・表示範囲・
 * 足の切替の前の時間の範囲（keep）を持つだけ。保存しない（アプリの再読み込みで消える = 開くたびに最新）。
 *
 * - active（IV 推移が見えている）が true になるたびに open を送る（読むのは初めての 1 回だけ。reducer が決める）
 * - トップバーの [最新] では読み直さない（最新化ボタンだけ。docs/ui-redesign.md §4.7）
 * - 追加読み込み（段 C）: 見えている間、表示範囲・足が変わってから IV_EDGE_DEBOUNCE_MS 後に edge（端から IV_EDGE_BARS 本
 *   未満か）を送る。読み込みの後は ivFollowViewport で見ている時刻を保つ（右端に付いていれば右端に付いていく）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type IvBar, loadAtmIv } from '../../data';
import type { Domain } from '../chart/scale';
import {
  barsForTf,
  IV_DEFAULT_MODE,
  IV_LEFT_SLACK,
  type IvKeep,
  type IvMode,
  type IvTf,
  ivEdges,
  ivFollowViewport,
  ivKeepOf,
  ivSource,
  resolveIvViewport,
} from '../view/ivHistory';
import {
  INITIAL_IV_LOAD,
  IV_EDGE_BARS,
  IV_EDGE_DEBOUNCE_MS,
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
  /** 今の足の表示する足（5 分・15 分は 1 分から束ねる） */
  bars: readonly IvBar[];
  /** 表示範囲（resolveIvViewport の結果） */
  viewport: Domain;
  /** 左の余白（本。左に読む余地があれば IV_LEFT_SLACK） */
  leftSlack: number;
  refresh: () => void;
  retry: () => void;
  setTf: (tf: IvTf) => void;
  setMode: (mode: IvMode) => void;
  setViewport: (v: Domain | null) => void;
}

const INITIAL_VIEW: IvView = { mode: IV_DEFAULT_MODE, viewport: null, keep: null };

const EMPTY: readonly IvBar[] = [];

/** 今の足の表示する足（5 分・15 分は 1 分から束ねる） */
function shownBars(s: IvLoadState, tf: IvTf): readonly IvBar[] {
  const e = s.entries[ivSource(tf)];
  return e ? barsForTf(e.bars, tf) : EMPTY;
}

const slackOf = (s: IvLoadState) => {
  const e = s.entries[ivSource(s.tf)];
  return e && !e.leftDone ? IV_LEFT_SLACK : 0;
};

/**
 * endpoint は同一オリジンの相対 URL（本番は /api/atm_iv。dev の合成の板・ファイルでは /fixtures/atm_iv）。
 */
export function useIvHistory(active: boolean, endpoint: string): IvHistoryCtl {
  const [load, setLoad] = useState<IvLoadState>(INITIAL_IV_LOAD);
  const [view, setView] = useState<IvView>(INITIAL_VIEW);
  const loadRef = useRef(load);
  // 表示の状態は ref が正（読み込みの応答の中で読み書きする）。setView は描き直しのため
  const viewRef = useRef(view);
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const ctrl = useRef<{ id: number; ac: AbortController } | null>(null);
  // 利用者が表示範囲を変えた回数（パン・拡大縮小・足の切替）。追加読み込みのきっかけはこれと最初の表示だけ
  const [nudge, setNudge] = useState(0);

  const run = useCallback((a: IvLoadAction) => {
    const prev = loadRef.current;
    const r = ivLoadReduce(prev, a);
    if (r.state === prev && !r.request && r.abort === null) return;
    loadRef.current = r.state;
    setLoad(r.state);
    // 今の足の読み済みが変わったら、見ている時刻を保つ（前に足した・遠い側を捨てた・右端に付いていく）
    const src = ivSource(r.state.tf);
    if (prev.tf === r.state.tf && prev.entries[src] !== r.state.entries[src]) {
      const v = viewRef.current;
      if (v.viewport) {
        const tf = r.state.tf;
        const before = shownBars(prev, tf);
        const viewport = ivFollowViewport(
          before,
          shownBars(r.state, tf),
          resolveIvViewport(before, tf, v.viewport, v.keep, slackOf(prev)),
        );
        const next = { ...v, viewport, keep: viewport ? v.keep : null };
        viewRef.current = next;
        setView(next);
      }
    }
    if (r.abort !== null && ctrl.current?.id === r.abort) {
      ctrl.current.ac.abort();
      ctrl.current = null;
    }
    if (r.request) start(r.request);
  }, []);

  function start(req: IvRequest) {
    const ac = new AbortController();
    ctrl.current = { id: req.id, ac };
    loadAtmIv(req.src, {
      endpoint: endpointRef.current,
      signal: ac.signal,
      ...(req.range ? { range: req.range } : {}),
    }).then(
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
          ? ivKeepOf(bars, resolveIvViewport(bars, s.tf, v.viewport, v.keep, slackOf(s)))
          : v.keep;
      const next = { ...v, viewport: null, keep };
      viewRef.current = next;
      setView(next);
      setNudge((k) => k + 1);
      run({ type: 'setTf', tf, at: keep });
    },
    [run],
  );
  const setMode = useCallback((mode: IvMode) => {
    viewRef.current = { ...viewRef.current, mode };
    setView(viewRef.current);
  }, []);
  const setViewport = useCallback((viewport: Domain | null) => {
    const v = viewRef.current;
    viewRef.current = { ...v, viewport, keep: viewport ? v.keep : null };
    setView(viewRef.current);
    setNudge((k) => k + 1);
  }, []);

  const tf = load.tf;
  const entry = load.entries[ivSource(tf)];
  const bars = useMemo(() => (entry ? barsForTf(entry.bars, tf) : EMPTY), [entry, tf]);
  const leftSlack = entry && !entry.leftDone ? IV_LEFT_SLACK : 0;
  const viewport = useMemo(
    () => resolveIvViewport(bars, tf, view.viewport, view.keep, leftSlack),
    [bars, tf, view.viewport, view.keep, leftSlack],
  );
  // 追加読み込み: 利用者の表示範囲の変化（nudge）か最初の表示（その足の読み済みが出来た）から 250ms 後に端を見る。
  // 読み込みが終わって足が増えただけでは見ない（端に居続けても読み続けない。reducer も同じ nudge では 1 回だけ）
  const latest = useRef({ bars, viewport });
  latest.current = { bars, viewport };
  const hasEntry = !!entry;
  useEffect(() => {
    if (!active || !hasEntry) return;
    const timer = setTimeout(() => {
      const { bars: b, viewport: v } = latest.current;
      run({ type: 'edge', nudge, ...ivEdges(v, b.length, IV_EDGE_BARS) });
    }, IV_EDGE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, hasEntry, tf, nudge, run]);

  return { load, view, bars, viewport, leftSlack, refresh, retry, setTf, setMode, setViewport };
}

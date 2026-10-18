/**
 * IV 推移の読み込みの状態機械（純関数の reducer。#79、docs/ui-redesign.md §4.7）。fetch・AbortController は
 * ui/components/useIvHistory.ts（ここは「出す要求」と「止める要求」を返すだけ）。
 *
 * - 遅延ロード: 起動時は読まない。open（IV 推移が初めて見えた）で今の足の右端（最新）の 1 回分を 1 本。
 *   2 回目以降の open（パネルを閉じて開き直す）は読み直さない（読み済みの足は覚えている。保存しない）
 * - refresh（最新化ボタン）: 今の足の右端の 1 回分をもう 1 本（サーバーのキャッシュを通る）。応答は時刻をキーにつなぐ
 * - setTf（足の切替）: 5 分・15 分は 1 分の読み込みを共有する（覚えるキーは 1m・1h・1d）。実行中の要求は、同じ足を
 *   読むものでなければ止め（abort）、世代（gen）の違う応答は捨てる。読み済みなら要求しない
 * - 同時に 1 本だけ。失敗したら error（[再試行] で同じ要求をもう 1 回）
 * - 左右の追加読み込み・覚える範囲の上限は段 C
 */

import type { AtmIvData, AtmIvSource, IvBar } from '../../data';
import { IV_DEFAULT_TF, type IvTf, ivSource, mergeBars } from './ivHistory';

/** 読み済みの足（時刻は UNIX 秒） */
export interface IvEntry {
  bars: IvBar[];
  /** 読み済みの範囲 [start, end)（応答の start・end の和） */
  start: number;
  end: number;
  /** これまでの応答の last_at の最大（表の最後の行。無ければ null） */
  lastAt: number | null;
  /** 右端（最新）まで読んである（最後の足は進行中） */
  rightLoaded: boolean;
}

export type IvSide = 'right' | 'refresh';

export interface IvRequest {
  id: number;
  src: AtmIvSource;
  side: IvSide;
  gen: number;
}

export interface IvLoadState {
  tf: IvTf;
  /** 足を替えるたびに 1 進む（違う世代の応答は捨てる） */
  gen: number;
  /** 次の要求の id */
  nextId: number;
  /** IV 推移が一度でも見えた */
  opened: boolean;
  entries: Partial<Record<AtmIvSource, IvEntry>>;
  inflight: IvRequest | null;
  /** 失敗した要求（[再試行] で同じ足・同じ側をもう 1 回） */
  error: { src: AtmIvSource; side: IvSide } | null;
}

export const INITIAL_IV_LOAD: IvLoadState = {
  tf: IV_DEFAULT_TF,
  gen: 0,
  nextId: 1,
  opened: false,
  entries: {},
  inflight: null,
  error: null,
};

export type IvLoadAction =
  | { type: 'open' }
  | { type: 'refresh' }
  | { type: 'setTf'; tf: IvTf }
  | { type: 'loaded'; id: number; data: AtmIvData }
  | { type: 'failed'; id: number }
  | { type: 'retry' };

export interface IvLoadResult {
  state: IvLoadState;
  /** 出す要求（無ければ null） */
  request: IvRequest | null;
  /** 止める要求の id（無ければ null） */
  abort: number | null;
}

const none = (state: IvLoadState): IvLoadResult => ({ state, request: null, abort: null });

function issue(s: IvLoadState, src: AtmIvSource, side: IvSide): IvLoadResult {
  const request: IvRequest = { id: s.nextId, src, side, gen: s.gen };
  return {
    state: { ...s, nextId: s.nextId + 1, inflight: request, error: null },
    request,
    abort: null,
  };
}

/** 応答を読み済みの足につなぐ（右端の要求なので rightLoaded） */
function merge(prev: IvEntry | undefined, data: AtmIvData): IvEntry {
  if (!prev) {
    return {
      bars: data.bars,
      start: data.start,
      end: data.end,
      lastAt: data.lastAt,
      rightLoaded: true,
    };
  }
  const lastAt =
    prev.lastAt === null
      ? data.lastAt
      : data.lastAt === null
        ? prev.lastAt
        : Math.max(prev.lastAt, data.lastAt);
  return {
    bars: mergeBars(prev.bars, data.bars),
    start: Math.min(prev.start, data.start),
    end: Math.max(prev.end, data.end),
    lastAt,
    rightLoaded: true,
  };
}

export function ivLoadReduce(s: IvLoadState, a: IvLoadAction): IvLoadResult {
  switch (a.type) {
    case 'open': {
      const src = ivSource(s.tf);
      const opened = s.opened ? s : { ...s, opened: true };
      if (opened.entries[src] || opened.inflight || opened.error) return none(opened);
      return issue(opened, src, 'right');
    }
    case 'refresh': {
      if (!s.opened || s.inflight) return none(s);
      return issue(s, ivSource(s.tf), 'refresh');
    }
    case 'setTf': {
      if (a.tf === s.tf) return none(s);
      const src = ivSource(a.tf);
      const gen = s.gen + 1;
      let next: IvLoadState = { ...s, tf: a.tf, gen, error: null };
      let abort: number | null = null;
      if (s.inflight) {
        if (s.inflight.src === src) next = { ...next, inflight: { ...s.inflight, gen } };
        else {
          abort = s.inflight.id;
          next = { ...next, inflight: null };
        }
      }
      if (!next.opened || next.entries[src] || next.inflight)
        return { state: next, request: null, abort };
      const r = issue(next, src, 'right');
      return { ...r, abort };
    }
    case 'loaded': {
      const f = s.inflight;
      if (!f || f.id !== a.id || f.gen !== s.gen || a.data.tf !== f.src) return none(s);
      return none({
        ...s,
        inflight: null,
        error: null,
        entries: { ...s.entries, [f.src]: merge(s.entries[f.src], a.data) },
      });
    }
    case 'failed': {
      const f = s.inflight;
      if (!f || f.id !== a.id) return none(s);
      return none({ ...s, inflight: null, error: { src: f.src, side: f.side } });
    }
    case 'retry': {
      if (!s.error || s.inflight) return none(s);
      const src = ivSource(s.tf);
      // 失敗の後に足を替えていれば今の足の右端
      return issue(s, src, s.error.src === src ? s.error.side : 'right');
    }
  }
}

/** 今の足の読み済み（無ければ null）・読み中・失敗 */
export function ivLoadView(s: IvLoadState): {
  entry: IvEntry | null;
  loading: boolean;
  failed: boolean;
} {
  const src = ivSource(s.tf);
  return {
    entry: s.entries[src] ?? null,
    loading: s.inflight?.src === src,
    failed: s.error !== null && !s.inflight,
  };
}

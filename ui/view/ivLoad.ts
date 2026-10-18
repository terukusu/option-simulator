/**
 * IV 推移の読み込みの状態機械（純関数の reducer。#79、docs/ui-redesign.md §4.7）。fetch・AbortController・デバウンスは
 * ui/components/useIvHistory.ts（ここは「出す要求」と「止める要求」を返すだけ）。
 *
 * - 遅延ロード: 起動時は読まない。open（IV 推移が初めて見えた）で今の足の右端（最新）の 1 回分を 1 本。
 *   2 回目以降の open（パネルを閉じて開き直す）は読み直さない（読み済みの足は覚えている。保存しない）
 * - refresh（最新化ボタン）: 今の足の右端の 1 回分をもう 1 本（サーバーのキャッシュを通る）。応答は時刻をキーにつなぐ。
 *   読み済みの範囲と離れていれば（数日開きっぱなしで ⟳）、読み済みを捨てて置き換える（読んでいない間を読み済みにしない）
 * - setTf（足の切替）: 5 分・15 分は 1 分の読み込みを共有する（覚えるキーは 1m・1h・1d）。実行中の要求は、同じ足を
 *   読むものでなければ止め（abort）、世代（gen）の違う応答は捨てる。読み済みなら要求しない。見ていた時間の範囲（at）が
 *   読み済みの範囲の外なら、その範囲の終わりを含む 1 回分を読む（右端が見えていたなら右端）
 * - edge（表示範囲が端から IV_EDGE_BARS 本未満。フックが 250ms のデバウンスで送る）: 左が終わっていなければ左の 1 回分
 *   （end = 読み済みの start）、右端まで読んでいなければ右の 1 回分（start = 読み済みの end）。空の左が IV_EMPTY_LIMIT 回
 *   続くか IV_EPOCH に達したら左は終わり。空の左の応答の後は続けて次を読む（デバウンスなし）
 * - 覚える範囲の上限（IV_MAX_DAYS）を超えたら遠い側を捨てる（左を読んだら右、右を読んだら左）。右を捨てたら
 *   rightLoaded = false（右端へ戻ると右を読む）。左を捨てたら左は終わっていない
 * - 範囲は UTC の 0 時にそろえる（サーバーの検査と同じ）。同時に 1 本だけ。失敗したら error（[再試行] で同じ要求）。
 *   失敗の後は edge でも読まない（[再試行] だけ）
 * - 追加読み込みのきっかけは利用者の表示範囲の変化（パン・拡大縮小・足の切替・最初の表示）だけ。フックがそのたびに
 *   nudge を 1 進め、edge は同じ nudge では 1 回しか読まない（読み込みが終わって足が増えただけでは次を読まない =
 *   端に居続けても読み続けない）。例外は空の左の連鎖（IV_EMPTY_LIMIT 回まで）
 */

import type { AtmIvData, AtmIvSource, IvBar } from '../../data';
import { IV_DEFAULT_TF, type IvTf, ivSource, mergeBars } from './ivHistory';

const DAY_S = 86400;

/** 1 回分の日数（ビューアーと同じ。サーバーの 1 回の最大以下） */
export const IV_CHUNK_DAYS: Record<AtmIvSource, number> = { '1m': 3, '1h': 60, '1d': 365 };
/** 覚える範囲の上限（日。ビューアーと同じ。日足は上限なし） */
export const IV_MAX_DAYS: Record<AtmIvSource, number> = {
  '1m': 9,
  '1h': 400,
  '1d': Number.POSITIVE_INFINITY,
};
/** これより前は読まない（サーバーの下限 = ビューアーの BARS_EPOCH。UNIX 秒） */
export const IV_EPOCH = Date.UTC(2010, 0, 1) / 1000;
/** 端から何本未満で追加を読むか */
export const IV_EDGE_BARS = 10;
/** 空の左の応答が何回続いたら左は終わりとみなすか */
export const IV_EMPTY_LIMIT = 3;
/** 表示範囲の変化を見るデバウンス（ms。フックが使う） */
export const IV_EDGE_DEBOUNCE_MS = 250;
/** 表の最後の行からこの秒数のうちは右端の足を進行中とみなす（表は毎時 45 分に直近 2 時間を作り直す） */
export const IV_PROGRESS_SECONDS = 3 * 3600;

const floorDay = (t: number) => Math.floor(t / DAY_S) * DAY_S;
const ceilDay = (t: number) => Math.ceil(t / DAY_S) * DAY_S;

/** 読み済みの足（時刻は UNIX 秒） */
export interface IvEntry {
  bars: IvBar[];
  /** 読み済みの範囲 [start, end)（隙間なし。離れた応答は置き換える） */
  start: number;
  /** 右端まで読んであれば、最後の右端の応答の end（= サーバーの now） */
  end: number;
  /** この足の応答の last_at の最大（表の最後の行。無ければ null） */
  lastAt: number | null;
  /** 右端（最新）まで読んである */
  rightLoaded: boolean;
  /** 左（過去）はもう無い */
  leftDone: boolean;
  /** 空の左の応答が続いた回数 */
  emptyLeft: number;
}

/** right = 右端の 1 回分（範囲なし）、refresh = 最新化、left / next = 左 / 右の追加、jump = 見ていた時間の 1 回分 */
export type IvSide = 'right' | 'refresh' | 'left' | 'next' | 'jump';

export interface IvRange {
  start: number;
  end: number;
}

export interface IvRequest {
  id: number;
  src: AtmIvSource;
  side: IvSide;
  gen: number;
  /** 範囲（無ければ右端の 1 回分） */
  range?: IvRange;
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
  /** 失敗した要求（[再試行] で同じ足・同じ側・同じ範囲をもう 1 回） */
  error: { src: AtmIvSource; side: IvSide; range?: IvRange } | null;
  /** これまでに受け取った応答の last_at の最大（「今」の印を出すかの基準。無ければ null） */
  lastAt: number | null;
  /** 追加読み込みを出した最後の nudge（同じ nudge の edge では読まない。まだなら −1） */
  edgeNudge: number;
}

export const INITIAL_IV_LOAD: IvLoadState = {
  tf: IV_DEFAULT_TF,
  gen: 0,
  nextId: 1,
  opened: false,
  entries: {},
  inflight: null,
  error: null,
  lastAt: null,
  edgeNudge: -1,
};

export type IvLoadAction =
  | { type: 'open' }
  | { type: 'refresh' }
  /** at = 替える前に見ていた時間の範囲（右端が見えていたら right） */
  | { type: 'setTf'; tf: IvTf; at?: { from: number; to: number; right: boolean } | null }
  /** nudge = 利用者が表示範囲を変えた回数（フックが数える。同じ nudge では 1 回だけ読む） */
  | { type: 'edge'; left: boolean; right: boolean; nudge: number }
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

function issue(s: IvLoadState, src: AtmIvSource, side: IvSide, range?: IvRange): IvLoadResult {
  const request: IvRequest = range
    ? { id: s.nextId, src, side, gen: s.gen, range }
    : { id: s.nextId, src, side, gen: s.gen };
  return {
    state: { ...s, nextId: s.nextId + 1, inflight: request, error: null },
    request,
    abort: null,
  };
}

const maxOf = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** 左の 1 回分（end = 読み済みの start。EPOCH に達していれば null） */
export function ivLeftRange(e: IvEntry, src: AtmIvSource): IvRange | null {
  const end = floorDay(e.start);
  if (end <= IV_EPOCH) return null;
  return { start: Math.max(end - IV_CHUNK_DAYS[src] * DAY_S, IV_EPOCH), end };
}

/** 右の 1 回分（start = 読み済みの end） */
export function ivRightRange(e: IvEntry, src: AtmIvSource): IvRange {
  const start = floorDay(e.end);
  return { start, end: start + IV_CHUNK_DAYS[src] * DAY_S };
}

/** t（見ていた範囲の終わり）を含む 1 回分 */
export function ivRangeAt(t: number, src: AtmIvSource): IvRange {
  const end = Math.max(floorDay(t) + DAY_S, IV_EPOCH + DAY_S);
  return { start: Math.max(end - IV_CHUNK_DAYS[src] * DAY_S, IV_EPOCH), end };
}

/**
 * 応答を読み済みの足につなぐ。離れていれば置き換える。覚える範囲の上限を超えたら遠い側を捨てる。
 * 右端に届いたか = 範囲なしの要求か、サーバーが end を縮めた（応答の end < 要求の end）
 */
export function mergeIvEntry(
  prev: IvEntry | undefined,
  data: AtmIvData,
  req: Pick<IvRequest, 'src' | 'side' | 'range'>,
): IvEntry {
  const reached = !req.range || data.end < req.range.end;
  const left = req.side === 'left';
  let e: IvEntry;
  if (!prev || data.start > prev.end || data.end < prev.start) {
    e = {
      bars: data.bars,
      start: data.start,
      end: data.end,
      lastAt: data.lastAt,
      rightLoaded: reached,
      leftDone: data.start <= IV_EPOCH,
      emptyLeft: 0,
    };
  } else {
    const emptyLeft = left ? (data.bars.length === 0 ? prev.emptyLeft + 1 : 0) : prev.emptyLeft;
    e = {
      bars: mergeBars(prev.bars, data.bars),
      start: Math.min(prev.start, data.start),
      end: Math.max(prev.end, data.end),
      lastAt: maxOf(prev.lastAt, data.lastAt),
      rightLoaded:
        data.end > prev.end
          ? reached
          : data.end < prev.end
            ? prev.rightLoaded
            : reached || prev.rightLoaded,
      leftDone:
        prev.leftDone ||
        (left && (data.start <= IV_EPOCH || emptyLeft >= IV_EMPTY_LIMIT)) ||
        Math.min(prev.start, data.start) <= IV_EPOCH,
      emptyLeft,
    };
  }
  const max = IV_MAX_DAYS[req.src] * DAY_S;
  if (e.end - e.start > max) {
    if (left) {
      // 左を読んだ: 右（遠い側）を捨てる
      const cut = e.start + max;
      e = { ...e, bars: e.bars.filter((b) => b.t < cut), end: cut, rightLoaded: false };
    } else {
      const cut = ceilDay(e.end - max);
      e = {
        ...e,
        bars: e.bars.filter((b) => b.t >= cut),
        start: cut,
        leftDone: false,
        emptyLeft: 0,
      };
    }
  }
  return e;
}

/** 範囲 [from, to] が読み済みの範囲と重なるか */
const overlaps = (e: IvEntry, from: number, to: number) => to >= e.start && from < e.end;

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
      if (!next.opened || next.inflight) return { state: next, request: null, abort };
      const e = next.entries[src];
      const at = a.at ?? null;
      // 見ていた時間が読み済みの外（右端が見えていたなら、右端まで読んでいない）なら、その時間の 1 回分
      const inside = e && (!at || (at.right ? e.rightLoaded : overlaps(e, at.from, at.to)));
      if (inside) return { state: next, request: null, abort };
      const r =
        at && !at.right
          ? issue(next, src, 'jump', ivRangeAt(at.to, src))
          : issue(next, src, 'right');
      return { ...r, abort };
    }
    case 'edge': {
      if (!s.opened || s.inflight || s.error || a.nudge <= s.edgeNudge) return none(s);
      const src = ivSource(s.tf);
      const e = s.entries[src];
      if (!e) return none(s);
      const used = { ...s, edgeNudge: a.nudge };
      // 両端が見えているときは、反対側を捨てることになる追加は読まない（左右の読み直しを繰り返さない）
      const max = IV_MAX_DAYS[src] * DAY_S;
      if (a.left && !e.leftDone) {
        const range = ivLeftRange(e, src);
        if (range && !(a.right && e.end - range.start > max))
          return issue(used, src, 'left', range);
      }
      if (a.right && !e.rightLoaded) {
        const range = ivRightRange(e, src);
        if (!(a.left && range.end - e.start > max)) return issue(used, src, 'next', range);
      }
      return none(s);
    }
    case 'loaded': {
      const f = s.inflight;
      if (!f || f.id !== a.id) return none(s);
      // 足の違う応答（サーバーの取り違え）は失敗にする（読み中のままにしない）
      if (a.data.tf !== f.src) {
        return none({
          ...s,
          inflight: null,
          error: { src: f.src, side: f.side, ...(f.range ? { range: f.range } : {}) },
        });
      }
      if (f.gen !== s.gen) return none({ ...s, inflight: null });
      const entry = mergeIvEntry(s.entries[f.src], a.data, f);
      const next: IvLoadState = {
        ...s,
        inflight: null,
        error: null,
        entries: { ...s.entries, [f.src]: entry },
        lastAt: maxOf(s.lastAt, a.data.lastAt),
      };
      // 空の左の後は続けて次を読む（表示範囲は変わらないので左端にいるまま）
      if (f.side === 'left' && a.data.bars.length === 0 && !entry.leftDone) {
        const range = ivLeftRange(entry, f.src);
        if (range) return issue(next, f.src, 'left', range);
      }
      return none(next);
    }
    case 'failed': {
      const f = s.inflight;
      if (!f || f.id !== a.id) return none(s);
      return none({
        ...s,
        inflight: null,
        error: { src: f.src, side: f.side, ...(f.range ? { range: f.range } : {}) },
      });
    }
    case 'retry': {
      if (!s.error || s.inflight) return none(s);
      const src = ivSource(s.tf);
      // 失敗の後に足を替えていれば今の足の右端
      if (s.error.src !== src) return issue(s, src, 'right');
      return issue(s, src, s.error.side, s.error.range);
    }
  }
}

/** 右端の足が進行中か（右端まで読んであり、表の最後の行が最後の右端の応答から IV_PROGRESS_SECONDS 以内） */
export function ivInProgress(e: IvEntry | null): boolean {
  return !!e && e.rightLoaded && e.lastAt !== null && e.end - e.lastAt < IV_PROGRESS_SECONDS;
}

/** 今の足の読み済み（無ければ null）・読み中の側・失敗の側 */
export function ivLoadView(s: IvLoadState): {
  entry: IvEntry | null;
  loading: boolean;
  /** 読み中の要求の側（今の足のとき。無ければ null） */
  pending: IvSide | null;
  failed: boolean;
  /** 失敗した要求の側（無ければ null） */
  failedSide: IvSide | null;
} {
  const src = ivSource(s.tf);
  const pending = s.inflight?.src === src ? s.inflight.side : null;
  const failed = s.error !== null && !s.inflight;
  return {
    entry: s.entries[src] ?? null,
    loading: pending !== null,
    pending,
    failed,
    failedSide: failed ? (s.error?.side ?? null) : null,
  };
}

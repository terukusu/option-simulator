/**
 * 画面の状態と保存の操作（#81 で旧画面の App.tsx から切り出した。中身はそのまま。旧画面は #91 で削除）。
 * 状態（ui/state.ts の reducer）・板とカレンダーの読み込み・自動保存（debounce・別のタブ）・URL 共有（`#p=`）・
 * 保存一覧の操作・表示モデルの useMemo を持ち、JSX を持たない。画面（ui/next/NextApp.tsx）がこのフックを使う
 * （保存の形式・キー・動きは旧画面のときと同じ）。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { axisOrigin, type Chain, type ChainJson, ChainLoadError, monthOf } from '../../data';
import {
  DEFAULT_SETTINGS,
  type MarginParams,
  type ModelSettings,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import {
  addEntry,
  bookKey,
  bookStorageChange,
  clearBook,
  duplicateEntry,
  exportBook,
  IMPORT_MAX_BYTES,
  importIntoBook,
  type OkEntry,
  overwriteEntry,
  removeEntry,
  renameEntry,
  restoreEntry,
} from '../book';
import { type CommitFail, type CommitResult, commitBook, loadBook, newBookId } from '../bookIo';
import { downloadText } from '../download';
import {
  API_LABEL,
  describeLoadError,
  fixtureUrl,
  initialSource,
  loadBoardFromApi,
  loadBoardFromUrl,
  loadCalendarFromApi,
  loadFromFile,
  readsCalendar,
  savedBoardLabel,
} from '../load';
import {
  BOARD_KEY,
  bootState,
  isNewerBoard,
  isNewerWorkspace,
  persistKey,
  type ReadResult,
  readSavedBoard,
  serializeBoard,
  serializeWorkspace,
  storageChange,
  toSaved,
  WORKSPACE_KEY,
} from '../persist';
import { MAX_PINS, PINS_FULL_TEXT } from '../pins';
import { DEFAULT_MARGIN_PREFS, type MarginPrefs } from '../prefs';
import {
  encodeShareUrl,
  isShareHash,
  readShareHash,
  type SharedPosition,
  shareOpenAction,
  shareOpenMode,
  withoutUiParam,
} from '../share';
import { reduce } from '../state';
import { readKey, removeKey, writeKey } from '../storage';
import { BOOK_FAIL_TEXT, bookListModel, exportDoneText, importDoneText } from '../view/bookList';
import { headerModel } from '../view/header';
import { hedgeModel } from '../view/hedge';
import {
  type HoldMapInput,
  holdMapBaseScenario,
  holdMapInput as holdMapInputOf,
} from '../view/holdMap';
import {
  capitalOf,
  type MarginView,
  marginNow,
  marginParamsKeep,
  marginPoint,
  marginPointAt,
  marginTail,
} from '../view/margin';
import { metricsModel } from '../view/metrics';
import {
  bootNote,
  dropNote,
  NEWER_OTHER_TAB_NOTE,
  OTHER_TAB_NOTE,
  type PersistNote,
  type PersistNoteKind,
  pushNote,
  saveFailedNote,
  shareNote,
} from '../view/persistNote';
import { ghostSource, overlayBases, resolvePins } from '../view/pins';
import { pnlDomains, scenarioFull, withScenarioFull, zoomViewport } from '../view/pnlChart';
import { positionModel } from '../view/position';
import { readoutModel } from '../view/readout';
import { clampDXInput, evalTimeTargets } from '../view/scenario';
import { scenarioAtmMark } from '../view/scenarioAtm';
import type { SmileEffBase } from '../view/smileEff';
import { openInNewTabError, tabsModel } from '../view/tabs';
import type { MarginLineInput } from './useMarginLine';

/** dev サーバーだけが配る合成の板（本番のビルドではこの分岐ごと消える） */
export const DEV_FIXTURES: readonly string[] = import.meta.env.DEV
  ? ['latest', 'night_early', 'pre_open']
  : [];

/** 開いたときの localStorage（main.tsx が 1 回だけ読む。#23） */
export interface Boot {
  storage: Storage | null;
  read: ReadResult;
}

const NO_BOOT: Boot = { storage: null, read: { kind: 'empty' } };

/** 保存一覧・書き出し / 読み込みの結果の知らせ（#91 で旧画面の Book.tsx から移した。形は同じ） */
export interface BookMessage {
  text: string;
  warn: boolean;
}

/** 保存一覧の上書きを戻すための写し（#87 (C)。prev = 上書きの直前に読み直した項目、written = 書いた項目） */
export interface OverwriteSnap {
  name: string;
  prev: OkEntry;
  written: OkEntry;
}

/** 作業の保存の debounce（スライダーのドラッグ中は書かない。止まってから 1 回） */
const SAVE_DELAY_MS = 500;

/** 読み込んだ板（json は保存に使う。ファイル選択は保存しないので持たない） */
interface Loaded {
  chain: Chain;
  json?: ChainJson;
}

/**
 * margin = 端末の設定の証拠金の項目（usePrefs。#131）。state.ts の reducer・作業の保存・URL 共有には入れない
 * （資金を保存一覧・書き出し・共有の文字列に載せない）。
 */
export function useAppController(boot: Boot = NO_BOOT, margin: MarginPrefs = DEFAULT_MARGIN_PREFS) {
  const [state, dispatch] = useReducer(reduce, boot.read, bootState);
  const seq = useRef(0);
  const calSeq = useRef(0);
  const { storage } = boot;
  const [notes, setNotes] = useState<PersistNote[]>(() => pushNote([], bootNote(boot.read)));
  const closeNote = useCallback(
    (kind: PersistNoteKind) => setNotes((ns) => ns.filter((n) => n.kind !== kind)),
    [],
  );
  // ---- 保存一覧（ポジ帳。#70）。件数のために開いたとき 1 回読み、操作のたびに読み直してから書く（ui/bookIo.ts）
  const [bookRead, setBookRead] = useState(() => loadBook(storage));
  const [bookOpen, setBookOpen] = useState(false);
  const [bookMsg, setBookMsg] = useState<BookMessage | null>(null);
  // 読み込みの失敗で保存した板を使うかの判定に、その時点の板の有無を読む
  const chainRef = useRef(state.chain);
  chainRef.current = state.chain;

  /**
   * 板を読む。persist = 成功したら最後に取れた板として保存し、板が 1 枚も無いまま失敗したら保存した板を使う
   * （API と dev の合成の板。ファイル選択は過去・手元の板なので使わない。#23）
   */
  const load = useCallback(
    async (label: string, fn: () => Promise<Loaded>, persist: boolean) => {
      const id = ++seq.current;
      dispatch({ type: 'loading' });
      try {
        const { chain, json } = await fn();
        if (id !== seq.current) return;
        // 取得時刻はブラウザの時計（reducer は時計を読まない）
        const fetchedAt = Date.now();
        dispatch({ type: 'loaded', chain, label, fetchedAt });
        if (persist && json) {
          // 板を描いてから書く（20〜35 万字の setItem。容量が足りなければ板は諦める＝作業の保存を優先）
          setTimeout(() => {
            if (writeKey(storage, BOARD_KEY, serializeBoard(json, fetchedAt, label)) === 'quota') {
              removeKey(storage, BOARD_KEY);
            }
          }, 0);
        }
      } catch (e) {
        if (id !== seq.current) return;
        const error = describeLoadError(e);
        if (persist && chainRef.current === null) {
          const text = readKey(storage, BOARD_KEY);
          const saved = readSavedBoard(text);
          if (saved) {
            dispatch({
              type: 'loadFailed',
              error,
              fallback: {
                chain: saved.chain,
                label: savedBoardLabel(saved.label),
                fetchedAt: saved.fetchedAt,
              },
            });
            return;
          }
          // 壊れた・古い版の保存は消す（従来の「板を読めない」の画面）。新しい版の板は残す
          if (text !== null && !isNewerBoard(text)) removeKey(storage, BOARD_KEY);
        }
        dispatch({ type: 'loadFailed', error });
      }
    },
    [storage],
  );

  // 合成の板の読み込みは dev だけ（本番のビルドでは分岐ごと消え、fixture の URL も残らない）
  const onFixture = useCallback(
    (name: string) => {
      if (import.meta.env.DEV) load(name, () => loadBoardFromUrl(fixtureUrl(name)), true);
    },
    [load],
  );
  const onFile = useCallback(
    (file: File) => load(file.name, async () => ({ chain: await loadFromFile(file) }), false),
    [load],
  );
  /**
   * 取引カレンダー（/api/calendar）を読む。板の読み込みと独立（片方の失敗で他方を止めない）。
   * 失敗したら同梱か前の API の版のまま（画面にエラーは出さない。前提の文言で分かる。7.5）
   */
  const loadCalendar = useCallback(async () => {
    const id = ++calSeq.current;
    try {
      const calendar = await loadCalendarFromApi();
      if (id !== calSeq.current) return;
      dispatch({ type: 'calendarLoaded', calendar });
    } catch (e) {
      if (id !== calSeq.current) return;
      if (e instanceof Error && e.name === 'AbortError') return;
      // 本番で気付けるように種別だけを出す（ChainLoadError の文言は応答の本文を含まない）
      console.warn(
        `取引カレンダーを読めない（前の版のまま）: ${e instanceof ChainLoadError ? e.message : '不明なエラー'}`,
      );
      dispatch({ type: 'calendarFailed' });
    }
  }, []);
  // [最新]: API から読み直す（手動だけ。自動ポーリング・タイマーは入れない。7.3 (4)）。
  // カレンダーも並行に読む（本番の初回と [最新]、dev で API に切り替えたとき）
  const onLatest = useCallback(() => {
    if (readsCalendar({ kind: 'api' })) void loadCalendar();
    void load(API_LABEL, () => loadBoardFromApi(), true);
  }, [load, loadCalendar]);

  // ---- 作業の自動保存（#23）。新しい版の保存を見たら（開いたとき・別のタブの保存・書く直前の読み直し）、
  // このセッションでは書かない（開いたままの古い版のタブが新しい版の保存を上書きしない）
  const blocked = useRef(boot.read.kind === 'newer');
  const stateRef = useRef(state);
  stateRef.current = state;
  // 最後に書いた（開いたときは復元した）内容。同じなら書かない（開いているだけのタブは書かない）
  const lastKey = useRef<string | null>(null);
  if (lastKey.current === null) lastKey.current = persistKey(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notified = useRef(new Set<string>());

  const block = useCallback(() => {
    blocked.current = true;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setNotes((ns) => pushNote(dropNote(ns, 'otherTab'), NEWER_OTHER_TAB_NOTE));
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (blocked.current) return;
    const s = stateRef.current;
    const key = persistKey(s);
    if (key === lastKey.current) return;
    // 書く直前に読み直す（storage イベントが届かない場合の守り。数 KB の読み取り 1 回）
    if (isNewerWorkspace(readKey(storage, WORKSPACE_KEY))) {
      block();
      return;
    }
    const text = serializeWorkspace(s, Date.now());
    let result = writeKey(storage, WORKSPACE_KEY, text);
    if (result === 'quota') {
      // 板（大きい方）を消して 1 回だけ再試行（作業を板より優先）
      removeKey(storage, BOARD_KEY);
      result = writeKey(storage, WORKSPACE_KEY, text);
    }
    if (result === 'ok') {
      lastKey.current = key;
      // 前に出した「保存できない」は、書けたら消す（また失敗したらまた知らせる）
      if (notified.current.size > 0) {
        notified.current.clear();
        setNotes((ns) => dropNote(ns, 'saveFailed'));
      }
      return;
    }
    if (!notified.current.has(result)) {
      notified.current.add(result);
      setNotes((ns) => pushNote(ns, saveFailedNote(result)));
    }
  }, [block, storage]);

  // 保存の対象が変わったら debounce で書く（書くのは止まってから 1 回）。
  // 板の読み込みが合わせた分（限月・ヘッジの限月・足の市場）は利用者の変更でないので書かない
  // （開いているだけのタブが他のタブの保存を上書きしない）。比較の文字列は足 10 本で 0.1 ms 未満
  const {
    chain: loadedChain,
    legs,
    scenario: savedScenario,
    atmBasis: savedBasis,
    monthId,
    target,
    filterAsk,
    smileAxis,
    feePerLot: savedFee,
    futureBasis: savedFutureBasis,
    metricsUnit,
    pnlY,
    pnlFolded,
    hedge: savedHedge,
    tabs: savedTabs,
    activeTab,
  } = state;
  const baseChain = useRef(loadedChain);
  // 保存の対象が変わったときだけ走る（値は stateRef から読む）
  useEffect(() => {
    if (blocked.current) return;
    const key = persistKey(stateRef.current);
    const byLoad = loadedChain !== baseChain.current;
    baseChain.current = loadedChain;
    if (byLoad && timer.current === null) {
      lastKey.current = key;
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = key === lastKey.current ? null : setTimeout(flush, SAVE_DELAY_MS);
  }, [
    flush,
    loadedChain,
    legs,
    savedScenario,
    savedBasis,
    monthId,
    target,
    filterAsk,
    smileAxis,
    savedFee,
    savedFutureBasis,
    metricsUnit,
    pnlY,
    pnlFolded,
    savedHedge,
    savedTabs,
    activeTab,
  ]);

  // タブを閉じる・隠すときは保留中の書き込みをすぐ書く（iOS Safari は unload が来ないことがある。
  // beforeunload は bfcache を壊すので使わない）。別のタブの保存は 1 行で知らせる（後勝ち・取り込まない）
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onStorage = (e: StorageEvent) => {
      // ポジ帳は別のキー（#70）。別のタブの変更を読み直す（一覧・件数）
      if (bookStorageChange(e.key)) setBookRead(loadBook(storage));
      if (blocked.current) return;
      const change = storageChange(e.key, e.newValue);
      if (change === 'newer') block();
      else if (change === 'otherTab') setNotes((ns) => pushNote(ns, OTHER_TAB_NOTE));
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('storage', onStorage);
    };
  }, [block, flush, storage]);

  // 保留中の書き込みの timer を後始末する（App はアンマウントしないが、残さない）
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // ---- URL 共有（#72）。開いたとき・フラグメントが変わったときに `#p=` を読む。扱いを決めた時点でフラグメントを消す
  // （再読み込みで二重に開かない・壊れた知らせを繰り返さない。replaceState は hashchange を起こさない）
  const [pendingShare, setPendingShare] = useState<SharedPosition | null>(null);
  const shareSeq = useRef(0);
  // URL から入れるのは足と名前だけ（受け手のシナリオ・手数料・先物の basis・表示の設定は変えない。URL は他人から来る入力）
  const openShared = useCallback((shared: SharedPosition, mode: 'replace' | 'newTab') => {
    dispatch(shareOpenAction(shared, mode));
  }, []);
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (!isShareHash(hash)) return;
      try {
        // `ui` のクエリも落とす（#91。古い `?ui=next#p=…` を開いてもアドレスバーに残さない。他のクエリは残す）
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + withoutUiParam(window.location.search),
        );
      } catch {
        // 消せなくても開く（再読み込みでもう一度開くだけ）
      }
      // 新しい URL を開いたら前の確認の行（上限のときの [置き換える]）は捨てる。壊れた URL でも残さない
      // （残すと [置き換える] で前の URL のポジションが開き、どの URL の確認かが分からなくなる）
      setPendingShare(null);
      const id = ++shareSeq.current;
      readShareHash(hash)
        .catch(() => ({ kind: 'invalid' as const }))
        .then((read) => {
          if (id !== shareSeq.current) return;
          if (read.kind !== 'ok') {
            setNotes((ns) => pushNote(ns, shareNote(read)));
            return;
          }
          const s = stateRef.current;
          const mode = shareOpenMode(s.tabs.length, s.legs.length);
          if (mode === 'full') {
            // タブが上限: 作業中のタブを置き換えるかを知らせの行で確かめる（confirm() を使わない）
            setNotes((ns) => dropNote(ns, 'shared'));
            setPendingShare(read.shared);
            return;
          }
          setPendingShare(null);
          openShared(read.shared, mode);
          setNotes((ns) => pushNote(ns, shareNote(read, mode)));
        });
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openShared]);
  const confirmShare = useCallback(() => {
    if (!pendingShare) return;
    const s = stateRef.current;
    // 確かめている間にタブが減った・作業中のタブが空になったら置き換えずに開く
    const mode = shareOpenMode(s.tabs.length, s.legs.length) === 'newTab' ? 'newTab' : 'replace';
    openShared(pendingShare, mode);
    setPendingShare(null);
    setNotes((ns) => pushNote(ns, shareNote({ kind: 'ok', shared: pendingShare }, mode)));
  }, [pendingShare, openShared]);
  const makeShareUrl = useCallback(() => {
    const s = stateRef.current;
    const name = s.tabs.find((t) => t.id === s.activeTab)?.name ?? '';
    const { origin, pathname, search } = window.location;
    // 受け手は既定の入口で開く（#91。`ui` のクエリを落とす。他のクエリは残す）
    return encodeShareUrl(toSaved(s, Date.now()), name, origin + pathname + withoutUiParam(search));
  }, []);

  // 開いたら 1 回だけ読む（本番 = API、dev = 合成の latest）
  useEffect(() => {
    const first = initialSource(import.meta.env.DEV);
    if (first.kind === 'api') onLatest();
    else onFixture(first.name);
  }, [onFixture, onLatest]);

  const { chain, atmBasis } = state;
  const month = chain && state.monthId ? (monthOf(chain, state.monthId) ?? null) : null;
  const { calendar, fetchedAt, sourceLabel, boardStale } = state;
  const header = useMemo(
    () =>
      chain
        ? headerModel(chain, atmBasis, calendar, {
            fetchedAt,
            label: sourceLabel,
            stale: boardStale,
          })
        : null,
    [chain, atmBasis, calendar, fetchedAt, sourceLabel, boardStale],
  );
  // 手数料（1 枚あたり円）・先物の basis（固定 / 減衰。#25）は評価の設定（損益・指標・テール表・ヘッジに効く）
  const { feePerLot, futureBasis } = state;
  const settings = useMemo<ModelSettings>(
    () => ({ ...DEFAULT_SETTINGS, feePerLot, futureBasis }),
    [feePerLot, futureBasis],
  );
  const positions = useMemo(
    () => (chain ? positionModel(chain, state.legs, atmBasis, calendar, settings) : null),
    [chain, state.legs, atmBasis, calendar, settings],
  );
  // 損益グラフの横軸の範囲・満期の折れ点など（足・板が変わったときだけ。ドラッグ中は作り直さない）
  const pnlBoard = useMemo(
    () =>
      chain && positions ? pnlDomains(chain, positions.prepared, positions.ctx, settings) : null,
    [chain, positions, settings],
  );
  // 全域にシナリオ点 X₀ + ΔX を足す（#144。板の全域の外の点へ縮小・パンで行ける）。端は 0.05X₀ の格子なので
  // ΔX の連続の操作で base が変わる（= 線を作り直す）のは格子を跨ぐときだけ
  const fullExt = pnlBoard ? scenarioFull(pnlBoard, state.scenario.dX) : null;
  const pnlBase = useMemo(
    () => (pnlBoard && fullExt ? withScenarioFull(pnlBoard, fullExt) : null),
    [pnlBoard, fullExt?.[0], fullExt?.[1]],
  );
  const pnlBaseRef = useRef(pnlBase);
  pnlBaseRef.current = pnlBase;
  // 指標・テール表（スライダーの操作ごと。グラフの表示モデルと合わせて 1 フレームの予算に収める）
  const metrics = useMemo(
    () => metricsModel({ base: pnlBase, scenario: state.scenario, unit: state.metricsUnit }),
    [pnlBase, state.scenario, state.metricsUnit],
  );
  // 読み取りの帯（シナリオ点の値。指標の値 + 満期・今日の 2 回の評価。#52）
  const readout = useMemo(
    () => readoutModel({ base: pnlBase, metrics, scenario: state.scenario }),
    [pnlBase, metrics, state.scenario],
  );
  // デルタヘッジ（足・目標・評価点・限月の変更ごと。シナリオは評価点がシナリオ時点のときだけ効く）
  const { hedge, scenario } = state;
  const hedgeScenario = hedge.at === 'scenario' ? scenario : null;
  const hedgeView = useMemo(
    () =>
      chain && positions
        ? hedgeModel({
            chain,
            ctx: positions.ctx,
            base: pnlBase,
            settings,
            scenario: hedgeScenario ?? ZERO_SCENARIO,
            hedge,
            holidays: calendar.holidays,
          })
        : null,
    [chain, positions, pnlBase, settings, hedgeScenario, hedge, calendar],
  );
  const targets = useMemo(
    () => (chain ? evalTimeTargets(chain, state.legs, calendar) : []),
    [chain, state.legs, calendar],
  );
  // 保存・URL から読んだ ΔX・X₀ の変化で数値欄の範囲（−99%〜+900%）の外になった ΔX を端へ寄せる（#144。X ≤ 0 にしない）
  const x0Now = positions?.ctx.x0 ?? Number.NaN;
  const dXNow = state.scenario.dX;
  useEffect(() => {
    if (!(Number.isFinite(x0Now) && x0Now > 0)) return;
    const clamped = clampDXInput(dXNow, x0Now);
    if (clamped !== dXNow) dispatch({ type: 'setScenario', patch: { dX: clamped } });
  }, [x0Now, dXNow]);
  const { pnlViewport } = state;
  const onZoom = useCallback(
    (factor: number) => {
      if (pnlBase) {
        dispatch({ type: 'setPnlViewport', viewport: zoomViewport(pnlBase, pnlViewport, factor) });
      }
    },
    [pnlBase, pnlViewport],
  );
  const { smilePick } = state;
  // 表示中の限月のシナリオ ATM（#26。ΔX ≠ 0 のときだけ。板の ATM・ヘッダ・スマイルの市場 ATM は動かさない）
  const dX = scenario.dX;
  const { basisMode } = settings;
  const scenarioAtmView = useMemo(() => {
    if (!chain || !month) return null;
    const pick = scenarioAtmMark(month, atmBasis, axisOrigin(chain, atmBasis), dX, basisMode);
    return pick ? { monthId: month.id, k: pick.k, F: month.F } : null;
  }, [chain, month, atmBasis, dX, basisMode]);

  // ---- ピン（#22）。重ねの基礎は板・足・評価の設定・タブが変わったときだけ作る（スライダーでは作り直さない）
  const { pins, pinLine } = state;
  const pinOverlays = useMemo(
    () =>
      overlayBases(pins, {
        chain,
        tabs: state.tabs,
        activeTab: state.activeTab,
        atmBasis,
        calendar,
        settings,
      }),
    [pins, chain, state.tabs, state.activeTab, atmBasis, calendar, settings],
  );
  // 重ねの線のシナリオ（今のシナリオ。ΔX は線の形に効かないので追わない = 長押しドラッグで作り直さない）
  const { days, dSigma, skew, beta, ivDynamics, ivShift } = scenario;
  const lineScenario = useMemo<Scenario>(
    () => ({ days, dX: 0, dSigma, skew, beta, ivDynamics, ivShift }),
    [days, dSigma, skew, beta, ivDynamics, ivShift],
  );
  // 証拠金の概算（#131。設計 5.10）: 今 = 足・板・設定・β / 動き方 / IV の入れ方、シナリオの点 = シナリオ、
  // テール = ΔX 以外のシナリオ（重ねの線と同じ lineScenario。ΔX のドラッグではテールを作り直さない）。資金・パラメータは端末の設定
  // パラメータは計算に使う項目が変わったときだけ新しい参照（許容損失など計算に使わない設定では作り直さない。#180）
  const marginParamsRef = useRef<MarginParams | null>(null);
  const marginParams = useMemo(() => {
    marginParamsRef.current = marginParamsKeep(marginParamsRef.current, margin);
    return marginParamsRef.current;
  }, [margin]);
  const capital = capitalOf(margin);
  const { holidays } = calendar;
  const nowScenario = useMemo<Scenario>(
    () => ({ ...ZERO_SCENARIO, beta, ivDynamics, ivShift }),
    [beta, ivDynamics, ivShift],
  );
  // 今・テールは全域（ΔX で広がる）を使わないので板の基礎（pnlBoard）で memo する（ΔX が全域の格子を跨いでも作り直さない）
  const marginNowCalc = useMemo(
    () => (pnlBoard ? marginNow(pnlBoard, nowScenario, marginParams, capital, holidays) : null),
    [pnlBoard, nowScenario, marginParams, capital, holidays],
  );
  const marginTailRows = useMemo(
    () => (pnlBoard ? marginTail(pnlBoard, lineScenario, marginParams, capital, holidays) : []),
    [pnlBoard, lineScenario, marginParams, capital, holidays],
  );
  // 追証の線の入力（段 C）: ΔX 以外のシナリオと板の基礎・資金・パラメータだけ（ΔX・パン・拡大で参照が変わらない）。
  // 線は舞台（useMarginLine）が止まってから作る。資金が未設定なら null（線なし）
  const marginLineInput = useMemo<MarginLineInput | null>(
    () =>
      pnlBoard && capital !== null
        ? { base: pnlBoard, scenario: lineScenario, params: marginParams, capital, holidays }
        : null,
    [pnlBoard, lineScenario, marginParams, capital, holidays],
  );
  // 追証マップの入力（#152）: 板の基礎・d・Δs・動き方・パラメータ・資金・休業日だけ（ΔX・Δσ・β・ivShift・パン・拡大で
  // 参照が変わらない）。マップは useHoldMap が止まってから列ごとに作る。資金が未設定・足なしなら null
  const holdScenario = useMemo(
    () => holdMapBaseScenario({ ...ZERO_SCENARIO, days, skew, ivDynamics }),
    [days, skew, ivDynamics],
  );
  const holdMapInput = useMemo<HoldMapInput | null>(
    () => holdMapInputOf(pnlBoard, holdScenario, marginParams, capital, holidays),
    [pnlBoard, holdScenario, marginParams, capital, holidays],
  );
  const marginView = useMemo<MarginView | null>(
    () =>
      pnlBase
        ? {
            capital,
            params: marginParams,
            now: marginNowCalc,
            point: marginPoint(pnlBase, state.scenario, marginParams, capital, holidays),
            at: marginPointAt(pnlBase, state.scenario),
            tail: marginTailRows,
          }
        : null,
    [pnlBase, state.scenario, marginParams, capital, holidays, marginNowCalc, marginTailRows],
  );
  // スマイルの売りの効率の線（#163）の市場・設定（足が無くても板があれば作る。シナリオは描く側で渡す）
  const positionsCtx = positions?.ctx ?? null;
  const smileEffBase = useMemo<SmileEffBase | null>(
    () => (positionsCtx ? { ctx: positionsCtx, settings, params: marginParams, holidays } : null),
    [positionsCtx, settings, marginParams, holidays],
  );
  const pinTargets = useMemo(
    () =>
      resolvePins(pins, {
        tabs: state.tabs,
        activeTab: state.activeTab,
        scenario: lineScenario,
        overlays: pinOverlays,
      }),
    [pins, state.tabs, state.activeTab, lineScenario, pinOverlays],
  );
  // [今の線を残す]: 今の基礎・シナリオの参照をそのまま持つ（不変オブジェクト。保存しない）
  const pinCurrent = useCallback(() => {
    const s = stateRef.current;
    const src = ghostSource(
      pnlBaseRef.current,
      s.scenario,
      s.tabs.find((t) => t.id === s.activeTab)?.name ?? '',
      s.chain ? s.chain.snapshotAt : null,
    );
    if (src) dispatch({ type: 'addPin', source: src });
  }, []);

  // ---- ポジ帳の操作（読み直し → 純関数 → 書く。失敗したら state を変えず知らせる）
  // commitWith: 書いて bookRead を更新するだけ（知らせは呼び出し側。#87 (C) の上書きを戻すトースト）
  const commitWith = useCallback(
    (op: Parameters<typeof commitBook>[1], opts?: { allowInvalid?: boolean }): CommitResult => {
      const r = commitBook(storage, op, opts);
      setBookRead(r.read);
      return r;
    },
    [storage],
  );
  // commit: commitWith + 一覧の中の知らせ（bookMsg）。成功の文を返さなければ知らせを消す
  const commitMsg = useCallback(
    (
      op: Parameters<typeof commitBook>[1],
      doneText: (r: Extract<CommitResult, { ok: true }>) => string | null,
      opts?: { allowInvalid?: boolean },
    ): BookMessage => {
      const r = commitWith(op, opts);
      if (r.ok) {
        const text = doneText(r);
        const msg = { text: text ?? '', warn: false };
        setBookMsg(text ? msg : null);
        return msg;
      }
      const msg = { text: BOOK_FAIL_TEXT[r.reason], warn: true };
      setBookMsg(msg);
      return msg;
    },
    [commitWith],
  );
  const commit = useCallback(
    (
      op: Parameters<typeof commitBook>[1],
      doneText: (r: Extract<CommitResult, { ok: true }>) => string | null,
      opts?: { allowInvalid?: boolean },
    ): boolean => !commitMsg(op, doneText, opts).warn,
    [commitMsg],
  );
  const openBook = useCallback(() => {
    setBookRead(loadBook(storage));
    setBookMsg(null);
    setBookOpen(true);
  }, [storage]);
  const closeBook = useCallback(() => setBookOpen(false), []);
  const onBookSave = useCallback(
    (name: string) => {
      const now = Date.now();
      return commit(
        (b) => addEntry(b, toSaved(stateRef.current, now), name, now, newBookId()),
        () => '保存した',
      );
    },
    [commit],
  );
  const onBookOverwrite = useCallback(
    (id: string) =>
      commit(
        (b) => overwriteEntry(b, id, toSaved(stateRef.current, Date.now())),
        () => '上書きした',
      ),
    [commit],
  );
  // [上書き] を即実行して戻すための写しを返す（#87 (C)。新しい画面の保存一覧。結果は NextApp のトースト）。
  // 書き込みは onBookOverwrite と同じ。失敗は今と同じ文を一覧の中の知らせに出して null
  const onBookOverwriteForUndo = useCallback(
    (id: string): OverwriteSnap | null => {
      const snap: { v: OverwriteSnap | null } = { v: null };
      const r = commitWith((b) => {
        const prev = b.entries.find((e) => e.id === id);
        const res = overwriteEntry(b, id, toSaved(stateRef.current, Date.now()));
        const written = res.ok ? res.book.entries.find((e) => e.id === id) : undefined;
        snap.v =
          prev?.status === 'ok' && written?.status === 'ok'
            ? { name: prev.name, prev, written }
            : null;
        return res;
      });
      if (!r.ok) {
        setBookMsg({ text: BOOK_FAIL_TEXT[r.reason], warn: true });
        return null;
      }
      setBookMsg(null);
      return snap.v;
    },
    [commitWith],
  );
  // 上書きを戻す（#87 (C)。null = 戻した。理由は呼び出し側のトースト。一覧の中の知らせは触らない）
  const onBookRestoreEntry = useCallback(
    (s: OverwriteSnap): CommitFail | null => {
      const r = commitWith((b) => restoreEntry(b, s.prev, s.written));
      return r.ok ? null : r.reason;
    },
    [commitWith],
  );
  const onBookDuplicate = useCallback(
    (id: string) =>
      commit(
        (b) => duplicateEntry(b, id, Date.now(), newBookId()),
        () => '複製した',
      ),
    [commit],
  );
  const onBookRename = useCallback(
    (id: string, name: string) =>
      commit(
        (b) => renameEntry(b, id, name),
        () => null,
      ),
    [commit],
  );
  const onBookRemove = useCallback(
    (id: string) =>
      commit(
        (b) => removeEntry(b, id),
        () => '削除した',
      ),
    [commit],
  );
  const onBookClear = useCallback(
    () =>
      commit(
        () => clearBook(),
        () => '空にした',
        { allowInvalid: true },
      ),
    [commit],
  );
  const openEntry = useCallback(
    (id: string, type: 'openPosition' | 'openPositionInNewTab') => {
      // [新しいタブで開く] でタブが上限なら一覧を閉じずに理由を出す（reducer は上限で何もしないため）
      const full =
        type === 'openPositionInNewTab' ? openInNewTabError(stateRef.current.tabs.length) : null;
      if (full !== null) {
        setBookMsg({ text: full, warn: true });
        return false;
      }
      // 開く直前に読み直す（別のタブで変わった・消えた項目を開かない）
      const read = loadBook(storage);
      setBookRead(read);
      const e = read.kind === 'ok' ? read.book.entries.find((x) => x.id === id) : undefined;
      if (e?.status !== 'ok') {
        setBookMsg({ text: BOOK_FAIL_TEXT.notFound, warn: true });
        return false;
      }
      dispatch({
        type,
        legs: e.ws.position.legs,
        scenario: e.ws.position.scenario,
        feePerLot: e.ws.ui.feePerLot,
        futureBasis: e.ws.ui.futureBasis,
      });
      setBookOpen(false);
      return true;
    },
    [storage],
  );
  // [開く] は作業中のタブを置き換える。[新しいタブで開く] はタブを足す（#71。上限なら一覧に理由を出して開かない）
  const onBookOpenEntry = useCallback((id: string) => openEntry(id, 'openPosition'), [openEntry]);
  const onBookOpenNewTab = useCallback(
    (id: string) => openEntry(id, 'openPositionInNewTab'),
    [openEntry],
  );
  // [重ねる]（#22）: 保存した足の写しを今の板・今のシナリオ・今の設定で重ねる（ピンが上限なら一覧に理由を出す）
  const onBookOverlay = useCallback(
    (id: string) => {
      if (stateRef.current.pins.length >= MAX_PINS) {
        setBookMsg({ text: PINS_FULL_TEXT, warn: true });
        return false;
      }
      const read = loadBook(storage);
      setBookRead(read);
      const e = read.kind === 'ok' ? read.book.entries.find((x) => x.id === id) : undefined;
      if (e?.status !== 'ok') {
        setBookMsg({ text: BOOK_FAIL_TEXT.notFound, warn: true });
        return false;
      }
      dispatch({
        type: 'addPin',
        source: { kind: 'saved', name: e.name, legs: e.ws.position.legs },
      });
      setBookOpen(false);
      return true;
    },
    [storage],
  );
  // 書き出し / 読み込み: 一覧の中の知らせ（bookMsg）に出し、同じ知らせを返す（#87 (C): ⋯ からはトーストに出す。
  // 旧 Book は戻り値を捨てる）。書き出しは読めなければ何もしないで null
  const onBookExport = useCallback((): BookMessage | null => {
    const read = loadBook(storage);
    setBookRead(read);
    if (read.kind !== 'ok') return null;
    const out = exportBook(read.book, Date.now());
    downloadText(out.text, out.filename);
    const msg = { text: exportDoneText(out.count, out.skipped), warn: false };
    setBookMsg(msg);
    return msg;
  }, [storage]);
  const onBookImport = useCallback(
    (file: File): Promise<BookMessage> => {
      if (file.size > IMPORT_MAX_BYTES) {
        const msg = { text: BOOK_FAIL_TEXT.fileTooLarge, warn: true };
        setBookMsg(msg);
        return Promise.resolve(msg);
      }
      return file.text().then(
        (text) =>
          commitMsg(
            (b) => importIntoBook(b, text, Date.now(), newBookId),
            (r) => importDoneText(r.added ?? 0, r.skipped ?? 0),
          ),
        () => {
          const msg = { text: BOOK_FAIL_TEXT.importInvalid, warn: true };
          setBookMsg(msg);
          return msg;
        },
      );
    },
    [commitMsg],
  );
  // 一覧の要約は開いている間だけ（板・項目・ATM 基準・単位が変わったときだけ作り直す）
  const { legs: curLegs, scenario: curScenario } = state;
  const bookView = useMemo(
    () =>
      bookOpen
        ? bookListModel({
            chain,
            read: bookRead,
            atmBasis,
            calendar,
            unitSetting: metricsUnit,
            currentKey: bookKey(curLegs, curScenario, feePerLot, futureBasis),
            legCount: curLegs.length,
          })
        : null,
    [
      bookOpen,
      chain,
      bookRead,
      atmBasis,
      calendar,
      metricsUnit,
      curLegs,
      curScenario,
      feePerLot,
      futureBasis,
    ],
  );
  // 作業中のポジションのタブ（#71）。PnlChart は浅い比較で描き直しを省くので、表示モデルが変わったときだけ要素を作る
  const tabsView = useMemo(
    () => tabsModel(savedTabs, activeTab, curLegs.length),
    [savedTabs, activeTab, curLegs.length],
  );
  // 作業中のタブの中身（URL に入るもの）が変わったら、⋯ メニューを開いている間だけ URL を作り直す（#72）。
  // 帯（WorkTabs）には props で渡さず購読にする（スライダーの 1 刻みごとに帯の memo を外して描き直さない。
  // メニューを閉じている間は購読者がいないので何もしない）
  const shareListeners = useRef(new Set<() => void>());
  useEffect(() => {
    for (const f of shareListeners.current) f();
  }, [curLegs, curScenario, feePerLot, futureBasis, savedTabs, activeTab]);
  const subscribeShare = useCallback((f: () => void) => {
    shareListeners.current.add(f);
    return () => {
      shareListeners.current.delete(f);
    };
  }, []);
  // 重ねられるタブ（作業中以外）
  const pinTabs = useMemo(
    () =>
      tabsView.tabs
        .filter((t) => !t.active)
        .map((t) => ({
          id: t.id,
          name: t.name,
          legCount: t.legCount,
          pinned: pins.some((p) => p.kind === 'tab' && p.tabId === t.id),
        })),
    [tabsView, pins],
  );
  const bookCount =
    bookRead.kind === 'ok' ? bookRead.book.entries.length : bookRead.kind === 'empty' ? 0 : null;
  return {
    state,
    dispatch,
    storage,
    notes,
    closeNote,
    bookRead,
    bookOpen,
    bookMsg,
    onFixture,
    onFile,
    onLatest,
    pendingShare,
    setPendingShare,
    confirmShare,
    makeShareUrl,
    chain,
    atmBasis,
    month,
    fetchedAt,
    sourceLabel,
    boardStale,
    header,
    feePerLot,
    futureBasis,
    settings,
    positions,
    pnlBase,
    metrics,
    marginView,
    marginLineInput,
    holdMapInput,
    readout,
    hedgeView,
    targets,
    onZoom,
    smilePick,
    scenarioAtmView,
    smileEffBase,
    pins,
    pinLine,
    pinTargets,
    pinCurrent,
    openBook,
    closeBook,
    onBookSave,
    onBookOverwrite,
    onBookOverwriteForUndo,
    onBookRestoreEntry,
    onBookDuplicate,
    onBookRename,
    onBookRemove,
    onBookClear,
    onBookOpenEntry,
    onBookOpenNewTab,
    onBookOverlay,
    onBookExport,
    onBookImport,
    curLegs,
    bookView,
    tabsView,
    activeTab,
    subscribeShare,
    pinTabs,
    bookCount,
  };
}

/** 画面（ui/next/NextApp.tsx）が使う状態と操作 */
export type AppController = ReturnType<typeof useAppController>;

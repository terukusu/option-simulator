import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { axisOrigin, type Chain, type ChainJson, monthOf } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, type Scenario, ZERO_SCENARIO } from '../../model';
import {
  addEntry,
  bookKey,
  bookStorageChange,
  clearBook,
  defaultName,
  duplicateEntry,
  exportBook,
  IMPORT_MAX_BYTES,
  importIntoBook,
  overwriteEntry,
  removeEntry,
  renameEntry,
} from '../book';
import { type CommitResult, commitBook, loadBook, newBookId } from '../bookIo';
import { downloadText } from '../download';
import {
  API_LABEL,
  describeLoadError,
  fixtureUrl,
  initialSource,
  loadBoardFromApi,
  loadBoardFromUrl,
  loadFromFile,
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
import {
  encodeShareUrl,
  isShareHash,
  readShareHash,
  type SharedPosition,
  shareOpenAction,
  shareOpenMode,
  shareSupported,
} from '../share';
import { MAX_TABS, reduce } from '../state';
import { readKey, removeKey, writeKey } from '../storage';
import { BOOK_FAIL_TEXT, bookListModel, exportDoneText, importDoneText } from '../view/bookList';
import { headerModel, keptBoardNote } from '../view/header';
import { hedgeModel } from '../view/hedge';
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
  shareReplaceConfirmText,
} from '../view/persistNote';
import { ghostSource, overlayBases, resolvePins } from '../view/pins';
import { pnlDomains, zoomViewport } from '../view/pnlChart';
import { positionModel } from '../view/position';
import { readoutModel } from '../view/readout';
import { evalTimeTargets } from '../view/scenario';
import { scenarioAtmMark } from '../view/scenarioAtm';
import { openInNewTabError, tabsModel } from '../view/tabs';
import { Board } from './Board';
import { Book, BookButton, type BookMessage } from './Book';
import { Header } from './Header';
import { Hedge } from './Hedge';
import { LegForms } from './LegForms';
import { Loader } from './Loader';
import { Metrics } from './Metrics';
import { PnlChart } from './PnlChart';
import { Positions } from './Positions';
import { ScenarioPanel } from './ScenarioPanel';
import { Smile } from './Smile';
import { WorkTabs } from './WorkTabs';

/** dev サーバーだけが配る合成の板（本番のビルドではこの分岐ごと消える） */
const DEV_FIXTURES: readonly string[] = import.meta.env.DEV
  ? ['latest', 'night_early', 'pre_open']
  : [];

/** 開いたときの localStorage（main.tsx が 1 回だけ読む。#23） */
export interface Boot {
  storage: Storage | null;
  read: ReadResult;
}

const NO_BOOT: Boot = { storage: null, read: { kind: 'empty' } };

/** 作業の保存の debounce（スライダーのドラッグ中は書かない。止まってから 1 回） */
const SAVE_DELAY_MS = 500;

/** 読み込んだ板（json は保存に使う。ファイル選択は保存しないので持たない） */
interface Loaded {
  chain: Chain;
  json?: ChainJson;
}

export function App({ boot = NO_BOOT }: { boot?: Boot }) {
  const [state, dispatch] = useReducer(reduce, boot.read, bootState);
  const seq = useRef(0);
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
  // [最新]: API から読み直す（手動だけ。自動ポーリング・タイマーは入れない。7.3 (4)）
  const onLatest = useCallback(() => load(API_LABEL, () => loadBoardFromApi(), true), [load]);

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
        window.history.replaceState(
          window.history.state,
          '',
          window.location.pathname + window.location.search,
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
    return encodeShareUrl(toSaved(s, Date.now()), name, origin + pathname + search);
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
  const pnlBase = useMemo(
    () =>
      chain && positions ? pnlDomains(chain, positions.prepared, positions.ctx, settings) : null,
    [chain, positions, settings],
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
  const commit = useCallback(
    (
      op: Parameters<typeof commitBook>[1],
      doneText: (r: Extract<CommitResult, { ok: true }>) => string | null,
      opts?: { allowInvalid?: boolean },
    ): boolean => {
      const r = commitBook(storage, op, opts);
      setBookRead(r.read);
      if (r.ok) {
        const text = doneText(r);
        setBookMsg(text ? { text, warn: false } : null);
        return true;
      }
      setBookMsg({ text: BOOK_FAIL_TEXT[r.reason], warn: true });
      return false;
    },
    [storage],
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
  const onBookExport = useCallback(() => {
    const read = loadBook(storage);
    setBookRead(read);
    if (read.kind !== 'ok') return;
    const out = exportBook(read.book, Date.now());
    downloadText(out.text, out.filename);
    setBookMsg({ text: exportDoneText(out.count, out.skipped), warn: false });
  }, [storage]);
  const onBookImport = useCallback(
    (file: File) => {
      if (file.size > IMPORT_MAX_BYTES) {
        setBookMsg({ text: BOOK_FAIL_TEXT.fileTooLarge, warn: true });
        return;
      }
      file.text().then(
        (text) =>
          commit(
            (b) => importIntoBook(b, text, Date.now(), newBookId),
            (r) => importDoneText(r.added ?? 0, r.skipped ?? 0),
          ),
        () => setBookMsg({ text: BOOK_FAIL_TEXT.importInvalid, warn: true }),
      );
    },
    [commit],
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
  const tabsBar = useMemo(
    () => (
      <WorkTabs
        view={tabsView}
        dispatch={dispatch}
        onSaveToBook={openBook}
        makeShareUrl={makeShareUrl}
        shareSupported={shareSupported()}
        subscribeShare={subscribeShare}
      />
    ),
    [tabsView, openBook, makeShareUrl, subscribeShare],
  );
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

  return (
    <div class="app">
      <div class="topbar">
        <h1>OP Simulator</h1>
        <Loader
          fixtures={DEV_FIXTURES}
          sourceLabel={sourceLabel}
          loading={state.loading}
          error={state.loadError}
          kept={chain ? keptBoardNote(fetchedAt, boardStale) : null}
          onFixture={onFixture}
          onFile={onFile}
          onLatest={onLatest}
        />
        {/* 板が無くても保存一覧を開ける（書き出し・削除・名前の変更・読み込み。[開く] は板を読んでから） */}
        <BookButton count={bookCount} onOpen={openBook} />
      </div>
      {(notes.length > 0 || pendingShare) && (
        <div class="persist-notes">
          {pendingShare && (
            <p class="note warn share-confirm" role="alert">
              {shareReplaceConfirmText(
                MAX_TABS,
                pendingShare.legs.length,
                tabsView.active.name,
                curLegs.length,
              )}
              <button type="button" class="danger" onClick={confirmShare}>
                置き換える
              </button>
              <button type="button" onClick={() => setPendingShare(null)}>
                やめる
              </button>
            </p>
          )}
          {notes.map((n) => (
            <p key={n.kind} class={n.warn ? 'note warn' : 'note'} role="status">
              {n.text}
              <button type="button" onClick={() => closeNote(n.kind)}>
                閉じる
              </button>
            </p>
          ))}
        </div>
      )}
      {!chain || !header ? (
        <p class="empty">
          {state.loading
            ? '読み込み中…'
            : state.loadError
              ? '板を読めない。[最新] で読み直すか、板の JSON を選んでください。'
              : '板の JSON を選んでください。'}
        </p>
      ) : (
        <>
          <Header model={header} onBasis={(basis) => dispatch({ type: 'setBasis', basis })} />
          {state.legError && (
            <p class="field-error leg-error" role="alert">
              足を追加できない: {state.legError}{' '}
              <button type="button" onClick={() => dispatch({ type: 'clearLegError' })}>
                閉じる
              </button>
            </p>
          )}
          <nav class="tabs" aria-label="限月">
            {chain.months.map((m) => (
              <button
                type="button"
                key={m.id}
                aria-pressed={m.id === state.monthId}
                onClick={() => dispatch({ type: 'setMonth', monthId: m.id })}
              >
                {m.id} 限
              </button>
            ))}
          </nav>
          <div class="panes">
            <section class="pane pane-board" aria-label="板">
              {chain.months.map((m) => (
                <Board
                  key={m.id}
                  chain={chain}
                  month={m}
                  active={m.id === state.monthId}
                  basis={atmBasis}
                  target={state.target}
                  filterAsk={state.filterAsk}
                  dispatch={dispatch}
                />
              ))}
            </section>
            {/*
              シミュレーター（損益グラフ・凡例・シナリオ）と詳細（ポジション以下）。幅の段階（#61。設計 6.1）:
              スマホ・タブレットは 1 本の列（.pane-sim は display: contents。ドックの sticky はこの列全体で効く）、
              PC（≥ 1200px）は .pane-side を display: contents にしてシミュレーターと詳細を別の列に並べる
            */}
            <div class="pane pane-side">
              <div class="pane-sim">
                <h2>損益グラフ</h2>
                <PnlChart
                  base={pnlBase}
                  legCount={state.legs.length}
                  scenario={state.scenario}
                  viewport={state.pnlViewport}
                  pnlY={state.pnlY}
                  scenarioAtm={scenarioAtmView}
                  amountUnit={metrics.unit}
                  readout={readout}
                  folded={state.pnlFolded}
                  dispatch={dispatch}
                  tabs={tabsBar}
                  pins={pinTargets}
                  pinLine={pinLine}
                  pinTabs={pinTabs}
                  onPinCurrent={pinCurrent}
                />
                <ScenarioPanel
                  scenario={state.scenario}
                  futureBasis={futureBasis}
                  x0={positions?.ctx.x0 ?? Number.NaN}
                  maxDays={pnlBase?.maxDays ?? 0}
                  evalTime={chain.evalTime}
                  targets={targets}
                  dispatch={dispatch}
                  onZoom={onZoom}
                />
              </div>
              <div class="pane pane-detail">
                {/* 行ごとの下書きをタブの間で持ち越さない（足の id はタブごとに 1..n。#71） */}
                <Positions
                  key={activeTab}
                  model={positions}
                  dispatch={dispatch}
                  bookCount={bookCount}
                  onOpenBook={openBook}
                />
                <Metrics
                  model={metrics}
                  unitSetting={state.metricsUnit}
                  feePerLot={feePerLot}
                  dispatch={dispatch}
                />
                <h2>スマイル {month ? `${month.id} 限` : ''}</h2>
                {chain.months.map((m) => {
                  const active = m.id === state.monthId;
                  return (
                    <Smile
                      key={m.id}
                      month={m}
                      active={active}
                      basis={atmBasis}
                      axis={state.smileAxis}
                      viewport={active ? state.smileViewport : null}
                      pick={active && smilePick?.monthId === m.id ? smilePick.k : null}
                      scenarioAtmK={
                        active && scenarioAtmView?.monthId === m.id ? scenarioAtmView.k : null
                      }
                      dispatch={dispatch}
                    />
                  );
                })}
                {hedgeView && <Hedge model={hedgeView} dispatch={dispatch} />}
                <LegForms chain={chain} dispatch={dispatch} />
              </div>
            </div>
          </div>
        </>
      )}
      {bookView && (
        <Book
          view={bookView}
          legCount={curLegs.length}
          hasBoard={chain !== null}
          defaultName={defaultName(curLegs.map((l) => l.leg))}
          message={bookMsg}
          onClose={closeBook}
          onSave={onBookSave}
          onOpen={onBookOpenEntry}
          onOpenNewTab={onBookOpenNewTab}
          canAddTab={tabsView.canAdd}
          onOverlay={onBookOverlay}
          canPin={pins.length < MAX_PINS}
          tabName={tabsView.active.name}
          onOverwrite={onBookOverwrite}
          onDuplicate={onBookDuplicate}
          onRename={onBookRename}
          onRemove={onBookRemove}
          onClear={onBookClear}
          onExport={onBookExport}
          onImport={onBookImport}
        />
      )}
    </div>
  );
}

import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { defaultName } from '../book';
import { loadIvStatsData } from '../components/ivStatsData';
import { loadTechnicalsData } from '../components/technicalsData';
import {
  type Boot,
  DEV_FIXTURES,
  type OverwriteSnap,
  useAppController,
} from '../components/useAppController';
import { useAtmMoves } from '../components/useAtmMoves';
import { useHoldMap } from '../components/useHoldMap';
import { useFutureBars, useIvHistory } from '../components/useIvHistory';
import { useMediaQuery } from '../components/useMediaQuery';
import { API_LABEL, loaderNote } from '../load';
import { MAX_PINS } from '../pins';
import type { PrefsRead } from '../prefs';
import { shareSupported } from '../share';
import { legAtStrike, MAX_TABS, restoreTabAction } from '../state';
import { aiEnvFromState } from '../view/aiContext';
import { aiEvalSource } from '../view/aiEvalCase';
import {
  NEW_TAB_UNDO_TEXT,
  newTabFullText,
  newTabPlan,
  newTabUndoActions,
  PROPOSAL_APPLY_ERROR,
  proposalApply,
} from '../view/aiPropose';
import { marketAddPlan, marketAddToast } from '../view/boardPanel';
import { closedTabText, restoreTabError, type ShareResult, shareResultView } from '../view/boxTabs';
import { fmtNum } from '../view/format';
import { futNowValue } from '../view/futHistory';
import { keptBoardNote } from '../view/header';
import { type IndKind, toggleInd } from '../view/indicators';
import { ivNowValue } from '../view/ivHistory';
import { PC_QUERY, PHONE_QUERY } from '../view/layout';
import { allowedLossOf } from '../view/margin';
import { marketPill } from '../view/marketPill';
import {
  LOAD_FAILED_KIND,
  legErrorToast,
  loadFailedToast,
  noticeRoute,
  warnTagsModel,
} from '../view/notices';
import { type PaletteRun, paletteAtmK, paletteItems } from '../view/palette';
import { shareReplaceConfirmText } from '../view/persistNote';
import { clearUndo } from '../view/positionsRegion';
import type { DXUnit } from '../view/scenario';
import {
  aiVisible,
  benchView,
  type ChartMode,
  chartMode,
  futVisible,
  holdMapActive,
  initialShell,
  ivVisible,
  layoutTier,
  metricsVisible,
  type ShellAction,
  shellReduce,
  smileView,
} from '../view/shell';
import { overwrittenText, restoreEntryFailText } from '../view/topMenu';
import { BookDialog } from './BookDialog';
import type { MarketAdd } from './market/BoardMonth';
import { FutHistory } from './market/FutHistory';
import { IvHistory } from './market/IvHistory';
import { PanelHead } from './PanelHead';
import { useAiAskHandler } from './parts/aiAsk';
import { Palette } from './parts/Palette';
import { TermCard } from './parts/TermCard';
import { ToastSlot, useToastHost, useToasts } from './parts/Toast';
import { openTerm } from './parts/termCard';
import { type AiApply, AiPanel, type AiPanelApi, type AiProposeApply } from './regions/AiChat';
import { Board } from './regions/Board';
import type { HoldBundle } from './regions/HoldMap';
import { Metrics } from './regions/Metrics';
import { Positions } from './regions/Positions';
import { Scenario, scenarioInputOf } from './regions/Scenario';
import { Smile } from './regions/Smile';
import { Stage } from './regions/Stage';
import { SettingsDialog } from './SettingsDialog';
import { Shell } from './Shell';
import { TopBar } from './TopBar';
import { ShareConfirm } from './top/ShareConfirm';
import { ShareUrlDialog } from './top/ShareUrlDialog';
import { focusPanelLater, type GlobalKeysCtx, runGlobalKey, useGlobalKeys } from './useGlobalKeys';
import { usePrefs } from './usePrefs';
import { useTheme } from './useTheme';

/**
 * 画面のルート（docs/ui-redesign.md §2・§10.1。#91 から唯一の画面）。作業の状態・保存・共有は旧画面と同じだった
 * useAppController（キー・形式を変えない）、見た目の状態（パネル・シート・市場）はここのローカル（保存しない）。
 * #81 の器（トップバー・見出し行・ドック）に、#82 で舞台（regions/Stage.tsx）を入れた。
 * 舞台で選んだ足（selectedLeg）はここのローカル（保存しない）。行使価格の変更はトーストの [元に戻す] で戻せる。
 * #83 でシナリオ（regions/Scenario.tsx）を入れた。ΔX の単位はここのローカル（保存しない。#87 の設定も同じ値を触る）。
 * #84 でポジション（regions/Positions.tsx。key = 作業中のタブ）を入れた。タブが変わったら [元に戻す] 付きのトーストを閉じる。
 * #86 で指標 · テール（regions/Metrics.tsx。c.metrics と state.feePerLot だけを渡す = pure が効く）を入れた。
 * #85 で板・スマイル（regions/Board.tsx・Smile.tsx。state の値を個別に渡す = pure が効く）を入れた。板・スマイルから
 * 足を入れたら [元に戻す]（removeLeg）付きのトーストを出し、入れた足を選ぶ（市場のパネルは開いたまま）。
 * #87 (A) で知らせの行をやめ、知らせをトースト / トップバーの警告のタグ / 共有を開く確認のダイアログ / 市場ピルへ
 * 振り分けた（ui/view/notices.ts）。トーストへ振り分けた知らせは push してから c.closeNote で消す（
 * c.notes に残るのは警告のタグのものだけ）。
 * #87 (B) でトップバーに BOX タブを入れた。タブを閉じるのは即実行 + [元に戻す]（keep 付きのトースト。閉じる前の写しを
 * restoreTabAction で控え、押した時点のタブで restoreTabError を先に判定して restoreTab を 1 回 dispatch）。
 * URL をコピーの結果はトースト、クリップボードに書けなければ「共有の URL」のダイアログ（shareResultView）。
 * #87 (C) で ⋯ に保存一覧・設定・書き出し / 読み込み…・全クリアを入れた。保存一覧の [上書き] は即実行 + [元に戻す]
 * （keep 付きのトースト。上書きの直前と書いた項目を控え、restoreEntry で書いたままのときだけ戻す）。保存一覧を
 * 開いている間はトーストをそのダイアログの中に描く（モーダルの外は押せない）。全クリアはポジションの ⋯ と同じ処理。
 * #89 段 A で全体のキー（1〜5・G・T。useGlobalKeys）を入れた。
 * #89 段 B でコマンドパレット（Ctrl / ⌘ + K。parts/Palette.tsx）を入れた。行（ui/view/palette.ts）は開いている間だけ
 * 作り、実行の記述を runPalette が dispatch / send / 既存のコールバックへ振り分ける（新しい state の action は無い）。
 * #79 段 B で IV 推移（market/IvHistory.tsx）を入れた。読み込みの状態は常駐の useIvHistory（パネルを閉じても残る・
 * 保存しない）。見えたら（ivVisible）初めての 1 回だけ右端を読む。データ元が API のときは /api/atm_iv、dev の合成の板・
 * ファイルのときは dev だけ /fixtures/atm_iv（本番のビルドは常に /api/atm_iv）。トップバーの [最新] では読み直さない。
 * 段 C で左右の追加読み込み（useIvHistory）・「今」の 1 点（ivNowValue）・シナリオの水準（state.scenario と舞台の X₀）を足した。
 * #190 で先物推移（market/FutHistory.tsx）を入れた。読み込みは常駐の useFutureBars（IV 推移と同じ規則・別の状態）で、
 * 口は /api/future_bars（dev の合成の板・ファイルは dev だけ /fixtures/future_bars）。IV 推移 ⇄ 先物の切替（市場の Seg）
 * では、離れる側の足と見ていた時間の範囲を入る側に渡す（shellSend）。
 * #152 で指標 · テールに追証マップ（regions/HoldMap.tsx）を入れた。開閉は ShellState.holdMap（保存しない）、過去の点は
 * 常駐の useAtmMoves（指標のパネルが見えたら 1 回だけ /api/atm_daily を先読み。#176）、マスの計算は useHoldMap（止まってから列ごと）。
 * #135 で AI のチャット（regions/AiChat.tsx の AiPanel。会話の状態は AiPanel の中の useAiChat）を入れた。ツールの環境は
 * 送るときに今の state と端末の証拠金の設定から作る（aiEnvFromState）。口は API のときは /api/ai、dev の合成の板は
 * dev だけ /fixtures/ai（偽の SSE）。PC は作業台の列の入れ替え（ShellState.bench・トップバーの [AI]・キー 6）。
 * #136 で数字・パネルの [AI に聞く]（parts/AskAi.tsx → parts/aiAsk.ts の口 → AI のパネルを開いて AiPanelApi.ask）。
 */
const NO_IND_KINDS: readonly IndKind[] = [];

export function NextApp({ boot, prefs }: { boot: Boot; prefs: PrefsRead }) {
  // 端末の設定（テーマ・証拠金。#131）は useAppController より先に（証拠金の項目を渡す）
  const userPrefs = usePrefs(prefs, boot.storage);
  const c = useAppController(boot, userPrefs.prefs.margin);
  const { state, dispatch } = c;
  const theme = useTheme(userPrefs.prefs.theme, userPrefs.setTheme);
  const tier = layoutTier(useMediaQuery(PHONE_QUERY), useMediaQuery(PC_QUERY));
  // 足 0 本で開いたらドックの既定は板（#275）
  const [shell, send] = useReducer(shellReduce, c.curLegs.length, initialShell);
  const ivEndpoint =
    import.meta.env.DEV && state.sourceLabel !== API_LABEL ? '/fixtures/atm_iv' : '/api/atm_iv';
  const iv = useIvHistory(ivVisible(shell, tier), ivEndpoint);
  const futEndpoint =
    import.meta.env.DEV && state.sourceLabel !== API_LABEL
      ? '/fixtures/future_bars'
      : '/api/future_bars';
  const fut = useFutureBars(futVisible(shell, tier), futEndpoint);
  // 先物推移の指標の段（#200。既定はすべて隠す。保存しない = ローソク / 線と同じ）
  const [indKinds, setIndKinds] = useState<readonly IndKind[]>(NO_IND_KINDS);
  const onIndToggle = useCallback((k: IndKind) => setIndKinds((s) => toggleInd(s, k)), []);
  // 先物推移の EMA の 3 本（#206）: 既定は出す（線は高さを使わない）。段の切替と同じく保存しない
  const [showEma, setShowEma] = useState(true);
  const onEmaToggle = useCallback(() => setShowEma((v) => !v), []);
  // IV 推移 ⇄ 先物の切替で足と見ていた時間の範囲を保つ（離れる側に読んだ足があるときだけ渡す）
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const histRef = useRef({ iv, fut });
  histRef.current = { iv, fut };
  const shellSend = useCallback(
    (a: ShellAction) => {
      if (a.type === 'market') {
        const from = smileView(shellRef.current, tier);
        const to = smileView({ ...shellRef.current, market: a.market }, tier);
        const { iv: ivCtl, fut: futCtl } = histRef.current;
        const pair =
          from === 'iv' && to === 'fut'
            ? ([ivCtl, futCtl] as const)
            : from === 'fut' && to === 'iv'
              ? ([futCtl, ivCtl] as const)
              : null;
        if (pair) {
          const snap = pair[0].snapshot();
          if (snap.keep) pair[1].adopt(snap.tf, snap.keep);
        }
      }
      send(a);
    },
    [tier],
  );
  // IV 推移の「今」の 1 点（#79 段 C）: 今の板の生の気配から optionchan と同じ定義の iv30（板・カレンダーが変わったときだけ）
  const boardJson = state.chain?.json ?? null;
  const { nonTradingDays } = state.calendar;
  const ivNow = useMemo(
    () => (boardJson ? ivNowValue(boardJson, nonTradingDays) : null),
    [boardJson, nonTradingDays],
  );
  // 先物推移の「今」の 1 点（#190）: 今の板の先物の値と、スナップショットの時刻から求めた限月
  const sqHolidays = state.calendar.holidays;
  const futNow = useMemo(
    () => (boardJson ? futNowValue(boardJson, sqHolidays, nonTradingDays) : null),
    [boardJson, sqHolidays, nonTradingDays],
  );
  // 追証マップ（#152）: 指標のパネルが見えている間は閉じていても計算する（#274。見出しに結論 = 過去 N 回中 M 回が
  // 追証の側を出す）。過去の値（/api/atm_daily）は指標のパネルが初めて見えたときに 1 回先読みする（#176）。
  // dev の合成の板・ファイルでは dev だけ /fixtures/atm_daily（本番のビルドは常に /api/atm_daily）
  const holdOpen = shell.holdMap ?? false;
  const metricsShown = metricsVisible(shell, tier);
  const { holdMapInput } = c;
  const dailyEndpoint =
    import.meta.env.DEV && state.sourceLabel !== API_LABEL
      ? '/fixtures/atm_daily'
      : '/api/atm_daily';
  const atmMoves = useAtmMoves(
    metricsShown && holdMapInput !== null,
    dailyEndpoint,
    nonTradingDays,
  );
  const holdCtl = useHoldMap(holdMapInput, atmMoves.moves, holdMapActive(shell, tier));
  const onHoldToggle = useCallback(() => send({ type: 'holdMap', open: !holdOpen }), [holdOpen]);
  const holdX0 = c.positions?.ctx.x0 ?? Number.NaN;
  const holdDXRatio = holdX0 > 0 ? state.scenario.dX / holdX0 : 0;
  const holdNoLegs = c.curLegs.length === 0;
  const holdNoCapital = (c.marginView?.capital ?? null) === null;
  const holdDays = c.metrics.days;
  const holdAllowedLoss = allowedLossOf(userPrefs.prefs.margin);
  const hold = useMemo<HoldBundle>(
    () => ({
      open: holdOpen,
      onToggle: onHoldToggle,
      noLegs: holdNoLegs,
      noCapital: holdNoCapital,
      map: holdCtl,
      moves: atmMoves,
      dXRatio: holdDXRatio,
      days: holdDays,
      allowedLoss: holdAllowedLoss,
    }),
    [
      holdOpen,
      onHoldToggle,
      holdNoLegs,
      holdNoCapital,
      holdCtl,
      atmMoves,
      holdDXRatio,
      holdDays,
      holdAllowedLoss,
    ],
  );
  // 全体のキー 1〜5・G・T・Ctrl / ⌘ + K（#89。パレットの行の実行も同じ ctx）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const onPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const keyCtx: GlobalKeysCtx = {
    tier,
    send,
    resolvedTheme: theme.resolved,
    chooseTheme: theme.choose,
    onPalette,
  };
  useGlobalKeys(keyCtx);
  const { pendingShare } = c;
  const toasts = useToasts();
  const [picked, setPicked] = useState<number | null>(null);
  const [dXUnit, setDXUnit] = useState<DXUnit>('pct');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookFocusName, setBookFocusName] = useState(false);
  // 足が消えたら選択を外す
  const selectedLeg = picked !== null && c.curLegs.some((l) => l.id === picked) ? picked : null;
  const onChart = useCallback((chart: ChartMode) => send({ type: 'chart', chart }), []);
  const onSmileEff = useCallback((on: boolean) => send({ type: 'smileEff', on }), []);
  const onPickLeg = useCallback(
    (id: number) => {
      setPicked(id);
      send({ type: 'open', panel: 'positions', tier });
    },
    [tier],
  );
  const { push, dropUndo, drop } = toasts;
  // 閉じたタブの [元に戻す] は押した時点の state で判定する（トーストの undo は push した時点のクロージャ）
  const stateRef = useRef(state);
  stateRef.current = state;
  // ---- AI（#135）。ツールの環境は送るときに今の state・証拠金の設定から作る（参照の変わらない関数）
  const marginRef = useRef(userPrefs.prefs.margin);
  marginRef.current = userPrefs.prefs.margin;
  // AI に渡す自分の前提（#156）も送るときの端末の設定を読む（文脈の profile）
  const profileRef = useRef(userPrefs.prefs.aiProfile);
  profileRef.current = userPrefs.prefs.aiProfile;
  const aiEnv = useCallback(
    () => aiEnvFromState(stateRef.current, marginRef.current, profileRef.current),
    [],
  );
  // 評価に残す（#159）: 押した時点の state・証拠金の設定・前提から文脈の作り直しの材料を作る（ダウンロードだけ）
  const aiEvalSrc = useCallback(
    () => aiEvalSource(stateRef.current, marginRef.current, profileRef.current, Date.now()),
    [],
  );
  // technicals のツール（#200）: 先物推移と同じ口から日足・1 時間足を読む（呼ばれたときだけ・10 分覚える）
  // 期間（#205）は送るときの端末の設定 = 先物推移の段と同じ値をデータに載せる（中継のスキーマは変えない）
  const techRef = useRef(userPrefs.technicals);
  techRef.current = userPrefs.technicals;
  const aiTech = useCallback(
    () => loadTechnicalsData(futEndpoint).then((d) => ({ ...d, params: techRef.current })),
    [futEndpoint],
  );
  // iv_stats のツール（#138・#158）: 追証マップの日次の値と IV 推移の右端と同じ口から読む（呼ばれたときだけ・10 分覚える）
  const aiIvStats = useCallback(
    () => loadIvStatsData(dailyEndpoint, ivEndpoint),
    [dailyEndpoint, ivEndpoint],
  );
  const aiApi = useRef<AiPanelApi | null>(null);
  const aiBase =
    import.meta.env.DEV && state.sourceLabel !== API_LABEL ? '/fixtures/ai' : '/api/ai';
  const onAiApply = useCallback(
    (sc: AiApply) => {
      const before = stateRef.current.scenario;
      dispatch({
        type: 'setScenario',
        patch: { days: sc.days, dX: sc.dX, dSigma: sc.dSigma, skew: sc.skew, ivShift: 'absolute' },
      });
      push({
        kind: 'ai-apply',
        text: 'AI が計算したシナリオを入れた',
        undo: () =>
          dispatch({
            type: 'setScenario',
            patch: {
              days: before.days,
              dX: before.dX,
              dSigma: before.dSigma,
              skew: before.skew,
              ivShift: before.ivShift,
            },
          }),
      });
    },
    [dispatch, push],
  );
  // 提案のカード（#139）: 押した時点の state で作り直し、今のタブは足を丸ごと置き換え（[元に戻す] は前の足へ）、
  // 新しいタブは足して切り替える（[元に戻す] は足したタブを閉じる。タブの切り替えで閉じない keep のトースト）
  const onAiPropose = useCallback<AiProposeApply>(
    (input, result) => {
      const st = stateRef.current;
      const r = proposalApply(aiEnvFromState(st, marginRef.current), input, result);
      if ('error' in r) {
        push({ kind: 'ai-propose', text: PROPOSAL_APPLY_ERROR[r.error], note: 'info' });
        return;
      }
      if (r.target === 'current') {
        const before = st.legs;
        const tab = st.activeTab;
        dispatch({ type: 'replaceLegs', legs: r.legs, expect: before, tab });
        push({
          kind: 'ai-propose',
          text: `AI の提案を今のタブに入れた（足 ${r.legs.length} 本）`,
          undo: () => dispatch({ type: 'replaceLegs', legs: before, expect: r.legs, tab }),
        });
        return;
      }
      const plan = newTabPlan(st, r.legs);
      if (!plan) {
        push({ kind: 'ai-propose', text: newTabFullText(MAX_TABS), note: 'info' });
        return;
      }
      dispatch(plan.action);
      push({
        kind: 'ai-propose',
        text: `AI の提案を新しいタブに入れた（足 ${r.legs.length} 本）`,
        keep: true,
        undo: () => {
          // 押したときのタブに戻り、足したタブだけを閉じる。編集していたら戻さない（#139 レビュー B1）
          const acts = newTabUndoActions(stateRef.current, plan.undo);
          if (typeof acts === 'string') {
            push({ kind: 'ai-propose', text: NEW_TAB_UNDO_TEXT[acts], note: 'info' });
            return;
          }
          for (const a of acts) dispatch(a);
        },
      });
    },
    [dispatch, push],
  );
  const onAi = useCallback(() => send({ type: 'bench' }), []);
  // [AI に聞く]（#136）: AI のパネルを見せて（PC は作業台を AI に）その値の質問を送る（パレットの診断と同じ口）
  useAiAskHandler((a) => {
    send({ type: 'open', panel: 'ai', tier });
    aiApi.current?.ask(a);
    // 押したボタン（閉じた吹き出しの中）からフォーカスを AI のパネルへ（キー 6 と同じ行き先。キーボードで続けて読める）
    focusPanelLater('ai');
  });
  const onCloseTab = useCallback(
    (id: number) => {
      const action = restoreTabAction(stateRef.current, id);
      if (!action) return;
      dispatch({ type: 'closeTab', id });
      push({
        kind: 'tab-closed',
        text: closedTabText(action.name, action.position.legs.length),
        keep: true,
        undo: () => {
          const err = restoreTabError(stateRef.current.tabs, action.name);
          if (err !== null) push({ kind: 'tab-restore', text: err });
          else dispatch(action);
        },
      });
    },
    [dispatch, push],
  );
  // 全クリア（ポジションの ⋯ とパレット。#275 でトップの ⋯ から外した）: 押した時点の state で写しを作り、[元に戻す] 付きのトースト（#84 と同じ）
  const onClearLegs = useCallback(() => {
    const u = clearUndo(stateRef.current);
    if (!u) return;
    dispatch({ type: 'clearLegs' });
    push({
      kind: u.kind,
      text: u.text,
      undo: () => {
        for (const a of u.undo) dispatch(a);
      },
    });
  }, [dispatch, push]);
  // 保存一覧・設定（#87 (C)）
  const { openBook, onBookOverwriteForUndo, onBookRestoreEntry } = c;
  const onOpenBook = useCallback(() => {
    setBookFocusName(false);
    openBook();
  }, [openBook]);
  const onSaveToBook = useCallback(() => {
    setBookFocusName(true);
    openBook();
  }, [openBook]);
  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  // 保存一覧の [上書き]: 即実行 + [元に戻す]（続けて上書きしたら同じ kind の置き換えで最後の 1 つだけ戻せる）
  const onBookOverwrite = useCallback(
    (id: string) => {
      const snap: OverwriteSnap | null = onBookOverwriteForUndo(id);
      if (!snap) return;
      push({
        kind: 'book-overwrite',
        text: overwrittenText(snap.name),
        keep: true,
        undo: () => {
          const r = onBookRestoreEntry(snap);
          if (r !== null)
            push({ kind: 'book-restore', text: restoreEntryFailText(r), note: 'warn' });
        },
      });
    },
    [onBookOverwriteForUndo, onBookRestoreEntry, push],
  );
  // URL をコピー（タブのメニュー・⋯）の結果: トースト、書けなければ「共有の URL」のダイアログ
  const [shareOk] = useState(shareSupported);
  const [shareUrl, setShareUrl] = useState<{ url: string; text: string } | null>(null);
  const onShareResult = useCallback(
    (r: ShareResult) => {
      const v = shareResultView(r);
      if ('toast' in v) push(v.toast);
      else setShareUrl(v.dialog);
    },
    [push],
  );
  const closeShareUrl = useCallback(() => setShareUrl(null), []);
  // 知らせ（#87）: トーストに振り分けるものは出してから消す。警告のタグのものは c.notes に残す
  const { notes, closeNote } = c;
  useEffect(() => {
    for (const n of notes) {
      const r = noticeRoute(n);
      if (r.to !== 'toast') continue;
      push(r.toast);
      closeNote(n.kind);
    }
  }, [notes, closeNote, push]);
  // 読み込みの失敗: 失敗した瞬間に警告のトースト、次に成功したら（loadError が null に戻ったら）消す
  const { loadError, legError } = state;
  const hasChain = state.chain !== null;
  const keptNote = hasChain ? keptBoardNote(state.fetchedAt, state.boardStale) : null;
  const failRef = useRef(loadError);
  useEffect(() => {
    if (failRef.current === loadError) return;
    failRef.current = loadError;
    if (loadError) push(loadFailedToast(hasChain, loadError, keptNote));
    else drop(LOAD_FAILED_KIND);
  }, [loadError, hasChain, keptNote, push, drop]);
  // 足を追加できない: 警告のトーストに出して消す（同じ文がもう一度来ても出す）
  useEffect(() => {
    if (legError === null) return;
    push(legErrorToast(legError));
    dispatch({ type: 'clearLegError' });
  }, [legError, push, dispatch]);
  // タブが変わったら [元に戻す] 付きのトーストを閉じる（別のタブでは restoreLeg が何もしないボタンを残さない。#84）
  const tabRef = useRef(state.activeTab);
  useEffect(() => {
    if (tabRef.current === state.activeTab) return;
    tabRef.current = state.activeTab;
    dropUndo();
  }, [state.activeTab, dropUndo]);
  const onChangeStrike = useCallback(
    (id: number, k: number) => {
      const index = state.legs.findIndex((l) => l.id === id);
      const before = state.legs[index];
      const after = before ? legAtStrike(state.chain, before, k) : null;
      if (!before || !after || before.leg.kind !== 'option') return;
      dispatch({ type: 'changeLegStrike', id, k });
      const tab = state.activeTab;
      const price = (v: number) => fmtNum(v, Number.isInteger(v) ? 0 : 1);
      push({
        kind: 'strike',
        text: `K ${fmtNum(before.leg.strike, 0)} → ${fmtNum(k, 0)} · 建値 ${price(before.leg.entry)} → ${price(after.leg.entry)}`,
        undo: () => dispatch({ type: 'restoreLeg', leg: before, index, expect: after, tab }),
      });
    },
    [state.legs, state.chain, state.activeTab, dispatch, push],
  );
  // 板・スマイルから足を入れる: 入る足を先に求め（reducer と同じ boardOptionLeg）、addBoardLeg は必ず送る
  // （作れなければ reducer が legError を入れる = 今と同じ「足を追加できない: …」）
  // 板の 322 行が持つ関数なので参照を変えない（板・次の id は ref で読む = 足を入れても行を描き直さない）
  const { chain } = state;
  const latest = useRef({ chain, nextId: state.nextId });
  latest.current = { chain, nextId: state.nextId };
  const onMarketAdd = useCallback<MarketAdd>(
    (expiry, k, type, side) => {
      const leg = marketAddPlan(latest.current.chain, { expiry, k, type, side });
      const id = latest.current.nextId;
      dispatch({ type: 'addBoardLeg', expiry, k, optionType: type, side });
      if (!leg) return;
      // 再描画の前にもう一度押されても次の id を指す（reducer は足を入れたら nextId を 1 進める）
      latest.current = { ...latest.current, nextId: id + 1 };
      setPicked(id);
      push({
        kind: 'market-add',
        text: marketAddToast(leg),
        undo: () => dispatch({ type: 'removeLeg', id }),
      });
    },
    [dispatch, push],
  );
  const monthId = c.month?.id ?? chain?.months[0]?.id ?? '';
  // 市場ピル・警告のタグ（#87）: シナリオの操作では入力が変わらない（TopBar は pure）
  const { header } = c;
  const { loading, sourceLabel } = state;
  const pill = useMemo(
    () =>
      marketPill(header, monthId || null, {
        loading,
        error: loadError,
        kept: keptNote,
        loaderNote: loaderNote(loading, sourceLabel),
      }),
    [header, monthId, loading, loadError, keptNote, sourceLabel],
  );
  const warn = useMemo(() => warnTagsModel(notes), [notes]);
  const cancelShare = useCallback(() => c.setPendingShare(null), [c.setPendingShare]);
  // タブが上限で共有を開く確認に入ったら、前の URL の「読めない」警告のトーストを残さない（#87 (A) のレビュー）
  const asking = pendingShare !== null;
  useEffect(() => {
    if (asking) drop('note-shared');
  }, [asking, drop]);
  const emptyMarket = (title: string, seg: ComponentChildren) => (
    <>
      <PanelHead title={title}>{seg}</PanelHead>
      <div class="panel-body" />
    </>
  );
  const mini = tier === 'phone' && shell.sheet === 'full';
  // コマンドパレット（#89 段 B）: 行は開いている間だけ作る（閉じている間は舞台・シナリオの操作に何も足さない）。
  // 依存は行に使う値だけ（c は毎回新しいオブジェクト）
  const [atmJump, setAtmJump] = useState(0);
  /** 消費した atmJump（#91 段 C。Board を作り直しても同じ要求で跳ばない） */
  const atmJumpDone = useRef(0);
  const atmK = paletteOpen ? paletteAtmK(chain, monthId, c.atmBasis) : null;
  const items = useMemo(
    () =>
      paletteOpen
        ? paletteItems({
            chartFocusable: c.pnlBase !== null && !mini,
            chartEmpty: c.pnlBase === null,
            scenario: scenarioInputOf(c, dXUnit),
            pins: {
              noLegs: c.pnlBase === null,
              pins: c.pinTargets,
              pinLine: c.pinLine,
              pinTabs: c.pinTabs,
            },
            chain,
            monthId,
            atmK,
            tabs: c.tabsView,
            legCount: c.curLegs.length,
            bookCount: c.bookCount,
            aiDiagnoseBlocked: aiApi.current?.paletteReason ?? null,
          })
        : [],
    [
      paletteOpen,
      c.pnlBase,
      mini,
      state.scenario,
      state.futureBasis,
      c.positions,
      c.targets,
      dXUnit,
      c.pinTargets,
      c.pinLine,
      c.pinTabs,
      chain,
      monthId,
      atmK,
      c.tabsView,
      c.curLegs.length,
      c.bookCount,
    ],
  );
  const runPalette = (run: PaletteRun) => {
    switch (run.kind) {
      case 'key':
        runGlobalKey(run.key, keyCtx);
        return;
      case 'action':
        dispatch(run.action);
        return;
      case 'shell':
        send(run.action);
        return;
      case 'pinCurrent':
        c.pinCurrent();
        return;
      case 'atm':
        // 板を見せて（キー 1 と同じ）、板の [ATM] と同じジャンプ
        runGlobalKey({ kind: 'panel', panel: 'board' }, keyCtx);
        setAtmJump((n) => n + 1);
        return;
      case 'add':
        onMarketAdd(run.add.expiry, run.add.k, run.add.type, run.add.side);
        return;
      case 'book':
        onOpenBook();
        return;
      case 'saveToBook':
        onSaveToBook();
        return;
      case 'clear':
        onClearLegs();
        return;
      case 'settings':
        onOpenSettings();
        return;
      case 'theme':
        theme.choose(run.theme);
        return;
      case 'term':
        // パレットの finish がフォーカスを戻した後なので、カードの「開く前の要素」はパレットを開く前の要素
        openTerm(run.id);
        return;
      case 'diagnose':
        // AI のパネルを見せて（PC は作業台を AI に）[このポジションを診断]
        send({ type: 'open', panel: 'ai', tier });
        aiApi.current?.diagnose();
        return;
    }
  };
  // 保存一覧を開いている間はそのダイアログの中に置く（1 か所だけ = 読み上げも 1 回。箱は同じ要素を移す = #124）
  const toastHost = useToastHost({
    toasts: toasts.toasts,
    onUndo: toasts.undo,
    onDismiss: toasts.dismiss,
  });
  return (
    <div class="screen">
      <TopBar
        pill={pill}
        warn={warn}
        tier={tier}
        loading={state.loading}
        theme={theme.pref}
        onTheme={theme.choose}
        sourceLabel={sourceLabel}
        fixtures={DEV_FIXTURES}
        onLatest={c.onLatest}
        onFile={c.onFile}
        onFixture={c.onFixture}
        onCloseNote={closeNote}
        tabs={c.tabsView}
        dispatch={dispatch}
        onCloseTab={onCloseTab}
        makeShareUrl={c.makeShareUrl}
        subscribeShare={c.subscribeShare}
        shareSupported={shareOk}
        onShareResult={onShareResult}
        bookCount={c.bookCount}
        onOpenBook={onOpenBook}
        onSaveToBook={onSaveToBook}
        onOpenSettings={onOpenSettings}
        aiOpen={benchView(shell) === 'ai'}
        onAi={onAi}
      />
      <Shell
        tier={tier}
        state={shell}
        send={shellSend}
        legCount={c.curLegs.length}
        stage={
          <Stage
            c={c}
            selectedLeg={selectedLeg}
            mini={mini}
            chart={chartMode(shell)}
            onChart={onChart}
            theme={theme.resolved}
            onPickLeg={onPickLeg}
            onChangeStrike={onChangeStrike}
          />
        }
        scenario={<Scenario c={c} dXUnit={dXUnit} onDXUnit={setDXUnit} />}
        positions={
          <Positions
            key={state.activeTab}
            c={c}
            tier={tier}
            send={send}
            selectedLeg={selectedLeg}
            onSelectLeg={setPicked}
            push={push}
            onClear={onClearLegs}
          />
        }
        metrics={
          <Metrics
            model={c.metrics}
            feePerLot={state.feePerLot}
            margin={c.marginView}
            hold={hold}
          />
        }
        board={(seg) =>
          chain && c.header ? (
            <Board
              chain={chain}
              months={c.header.months}
              monthId={monthId}
              basis={c.atmBasis}
              target={state.target}
              filterAsk={state.filterAsk}
              legs={c.curLegs}
              dispatch={dispatch}
              onAdd={onMarketAdd}
              marketSeg={seg}
              atmJump={atmJump}
              atmJumpDone={atmJumpDone}
            />
          ) : (
            emptyMarket('板', seg)
          )
        }
        smile={(seg) =>
          smileView(shell, tier) === 'fut' ? (
            <FutHistory
              load={fut.load}
              view={fut.view}
              bars={fut.bars}
              viewport={fut.viewport}
              leftSlack={fut.leftSlack}
              now={futNow}
              nonTradingDays={nonTradingDays}
              seg={seg}
              onRefresh={fut.refresh}
              onRetry={fut.retry}
              onTf={fut.setTf}
              onMode={fut.setMode}
              onViewport={fut.setViewport}
              indKinds={indKinds}
              onIndToggle={onIndToggle}
              showEma={showEma}
              onEmaToggle={onEmaToggle}
              techParams={userPrefs.technicals}
              paneH={userPrefs.prefs.futPaneH}
              onPaneH={userPrefs.setFutPaneH}
              lineWidths={userPrefs.techLineWidths}
            />
          ) : smileView(shell, tier) === 'iv' ? (
            <IvHistory
              load={iv.load}
              view={iv.view}
              bars={iv.bars}
              viewport={iv.viewport}
              leftSlack={iv.leftSlack}
              now={ivNow}
              scenario={state.scenario}
              x0={c.positions?.ctx.x0 ?? Number.NaN}
              nonTradingDays={nonTradingDays}
              seg={seg}
              onRefresh={iv.refresh}
              onRetry={iv.retry}
              onTf={iv.setTf}
              onMode={iv.setMode}
              onViewport={iv.setViewport}
            />
          ) : chain ? (
            <Smile
              chain={chain}
              monthId={monthId}
              basis={c.atmBasis}
              axis={state.smileAxis}
              viewport={state.smileViewport}
              pick={state.smilePick}
              scenarioAtm={c.scenarioAtmView}
              effOn={shell.smileEff === true}
              onEff={onSmileEff}
              eff={shell.smileEff ? c.smileEffBase : null}
              scenario={shell.smileEff ? c.smileEffScenario : null}
              unit={c.metrics.unit}
              dispatch={dispatch}
              onAdd={onMarketAdd}
              marketSeg={seg}
            />
          ) : (
            emptyMarket('スマイル', seg)
          )
        }
        ai={
          <AiPanel
            visible={aiVisible(shell, tier)}
            base={aiBase}
            env={aiEnv}
            evalSource={aiEvalSrc}
            tech={aiTech}
            ivStats={aiIvStats}
            hasChain={chain !== null}
            legCount={c.pnlBase?.legs.length ?? 0}
            x0={c.positions?.ctx.x0 ?? Number.NaN}
            disclaimerSeen={userPrefs.prefs.aiDisclaimerSeen === true}
            onDisclaimerSeen={userPrefs.setAiDisclaimerSeen}
            onApplyScenario={onAiApply}
            onApplyProposal={onAiPropose}
            apiRef={aiApi}
          />
        }
      />
      <ShareConfirm
        text={
          pendingShare
            ? shareReplaceConfirmText(
                MAX_TABS,
                pendingShare.legs.length,
                c.tabsView.active.name,
                c.curLegs.length,
              )
            : null
        }
        onReplace={c.confirmShare}
        onCancel={cancelShare}
      />
      <ShareUrlDialog share={shareUrl} onClose={closeShareUrl} />
      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        atmBasis={state.atmBasis}
        metricsUnit={state.metricsUnit}
        feePerLot={state.feePerLot}
        header={c.header}
        dispatch={dispatch}
        tier={tier}
        theme={theme.pref}
        onTheme={theme.choose}
        margin={userPrefs.prefs.margin}
        onMargin={userPrefs.setMargin}
        techParams={userPrefs.technicals}
        onTechParams={userPrefs.setTechnicals}
        techLineWidths={userPrefs.techLineWidths}
        onTechLineWidths={userPrefs.setTechLineWidths}
        aiProfile={userPrefs.prefs.aiProfile ?? ''}
        onAiProfile={userPrefs.setAiProfile}
      />
      <BookDialog
        open={c.bookOpen}
        view={c.bookView}
        legCount={c.curLegs.length}
        hasBoard={chain !== null}
        defaultName={defaultName(c.curLegs.map((l) => l.leg))}
        message={c.bookMsg}
        onClose={c.closeBook}
        onSave={c.onBookSave}
        onOpen={c.onBookOpenEntry}
        onOpenNewTab={c.onBookOpenNewTab}
        canAddTab={c.tabsView.canAdd}
        onOverlay={c.onBookOverlay}
        canPin={c.pins.length < MAX_PINS}
        tabName={c.tabsView.active.name}
        onOverwrite={onBookOverwrite}
        onDuplicate={c.onBookDuplicate}
        onRename={c.onBookRename}
        onRemove={c.onBookRemove}
        onClear={c.onBookClear}
        onExport={c.onBookExport}
        onImport={c.onBookImport}
        toasts={c.bookOpen ? <ToastSlot host={toastHost} /> : null}
        focusName={bookFocusName}
      />
      {!c.bookOpen && <ToastSlot host={toastHost} />}
      <Palette open={paletteOpen} items={items} onClose={closePalette} onRun={runPalette} />
      <TermCard />
    </div>
  );
}

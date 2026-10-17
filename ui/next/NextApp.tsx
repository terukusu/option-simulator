import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { type Boot, DEV_FIXTURES, useAppController } from '../components/useAppController';
import { useMediaQuery } from '../components/useMediaQuery';
import { loaderNote } from '../load';
import type { PrefsRead } from '../prefs';
import { shareSupported } from '../share';
import { legAtStrike, MAX_TABS, restoreTabAction } from '../state';
import { marketAddPlan, marketAddToast } from '../view/boardPanel';
import { closedTabText, restoreTabError, type ShareResult, shareResultView } from '../view/boxTabs';
import { fmtNum } from '../view/format';
import { keptBoardNote } from '../view/header';
import { PC_QUERY, PHONE_QUERY } from '../view/layout';
import { marketPill } from '../view/marketPill';
import {
  LOAD_FAILED_KIND,
  legErrorToast,
  loadFailedToast,
  noticeRoute,
  warnTagsModel,
} from '../view/notices';
import { shareReplaceConfirmText } from '../view/persistNote';
import type { DXUnit } from '../view/scenario';
import { INITIAL_SHELL, layoutTier, shellReduce } from '../view/shell';
import type { MarketAdd } from './market/BoardMonth';
import { PanelHead } from './PanelHead';
import { Toasts, useToasts } from './parts/Toast';
import { Board } from './regions/Board';
import { Metrics } from './regions/Metrics';
import { Positions } from './regions/Positions';
import { Scenario } from './regions/Scenario';
import { Smile } from './regions/Smile';
import { Stage } from './regions/Stage';
import { Shell } from './Shell';
import { TopBar } from './TopBar';
import { ShareConfirm } from './top/ShareConfirm';
import { ShareUrlDialog } from './top/ShareUrlDialog';
import { useTheme } from './useTheme';

/**
 * 新しい画面のルート（`?ui=next`。docs/ui-redesign.md §2・§10.1）。作業の状態・保存・共有は旧画面と同じ
 * useAppController（キー・形式を変えない）、見た目の状態（パネル・シート・市場）はここのローカル（保存しない）。
 * #81 の器（トップバー・見出し行・ドック）に、#82 で舞台（regions/Stage.tsx）を入れた。
 * 舞台で選んだ足（selectedLeg）はここのローカル（保存しない）。行使価格の変更はトーストの [元に戻す] で戻せる。
 * #83 でシナリオ（regions/Scenario.tsx）を入れた。ΔX の単位はここのローカル（保存しない。#87 の設定も同じ値を触る）。
 * #84 でポジション（regions/Positions.tsx。key = 作業中のタブ）を入れた。タブが変わったら [元に戻す] 付きのトーストを閉じる。
 * #86 で指標 · テール（regions/Metrics.tsx。c.metrics と state.feePerLot だけを渡す = pure が効く）を入れた。
 * #85 で板・スマイル（regions/Board.tsx・Smile.tsx。state の値を個別に渡す = pure が効く）を入れた。板・スマイルから
 * 足を入れたら [元に戻す]（removeLeg）付きのトーストを出し、入れた足を選ぶ（市場のパネルは開いたまま）。
 * #87 (A) で知らせの行をやめ、知らせをトースト / トップバーの警告のタグ / 共有を開く確認のダイアログ / 市場ピルへ
 * 振り分けた（ui/view/notices.ts）。トーストへ振り分けた知らせは push してから c.closeNote で消す（新しい画面の
 * c.notes に残るのは警告のタグのものだけ。旧画面は別の useAppController なので変わらない）。
 * #87 (B) でトップバーに BOX タブを入れた。タブを閉じるのは即実行 + [元に戻す]（keep 付きのトースト。閉じる前の写しを
 * restoreTabAction で控え、押した時点のタブで restoreTabError を先に判定して restoreTab を 1 回 dispatch）。
 * URL をコピーの結果はトースト、クリップボードに書けなければ「共有の URL」のダイアログ（shareResultView）。
 */
export function NextApp({ boot, prefs }: { boot: Boot; prefs: PrefsRead }) {
  const c = useAppController(boot);
  const { state, dispatch } = c;
  const theme = useTheme(prefs, boot.storage);
  const tier = layoutTier(useMediaQuery(PHONE_QUERY), useMediaQuery(PC_QUERY));
  const [shell, send] = useReducer(shellReduce, INITIAL_SHELL);
  const { pendingShare } = c;
  const toasts = useToasts();
  const [picked, setPicked] = useState<number | null>(null);
  const [dXUnit, setDXUnit] = useState<DXUnit>('pct');
  // 足が消えたら選択を外す
  const selectedLeg = picked !== null && c.curLegs.some((l) => l.id === picked) ? picked : null;
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
      />
      <Shell
        tier={tier}
        state={shell}
        send={send}
        legCount={c.curLegs.length}
        stage={
          <Stage
            c={c}
            selectedLeg={selectedLeg}
            mini={mini}
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
          />
        }
        metrics={<Metrics model={c.metrics} feePerLot={state.feePerLot} />}
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
            />
          ) : (
            emptyMarket('板', seg)
          )
        }
        smile={(seg) =>
          chain ? (
            <Smile
              chain={chain}
              monthId={monthId}
              basis={c.atmBasis}
              axis={state.smileAxis}
              viewport={state.smileViewport}
              pick={state.smilePick}
              scenarioAtm={c.scenarioAtmView}
              dispatch={dispatch}
              onAdd={onMarketAdd}
              marketSeg={seg}
            />
          ) : (
            emptyMarket('スマイル', seg)
          )
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
      <Toasts toasts={toasts.toasts} onUndo={toasts.undo} onDismiss={toasts.dismiss} />
    </div>
  );
}

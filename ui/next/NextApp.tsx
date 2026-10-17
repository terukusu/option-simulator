import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { type Boot, useAppController } from '../components/useAppController';
import { useMediaQuery } from '../components/useMediaQuery';
import type { PrefsRead } from '../prefs';
import { legAtStrike, MAX_TABS } from '../state';
import { marketAddPlan, marketAddToast } from '../view/boardPanel';
import { fmtNum } from '../view/format';
import { keptBoardNote } from '../view/header';
import { PC_QUERY, PHONE_QUERY } from '../view/layout';
import { shareReplaceConfirmText } from '../view/persistNote';
import type { DXUnit } from '../view/scenario';
import { INITIAL_SHELL, layoutTier, shellReduce } from '../view/shell';
import type { MarketAdd } from './market/BoardMonth';
import { Notices } from './Notices';
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
import { useTheme } from './useTheme';

/** 板の読み込みの知らせ（旧画面と同じ文） */
function boardNotice(
  hasChain: boolean,
  loading: boolean,
  error: { message: string } | null,
  kept: string | null,
): { text: string; warn: boolean } | null {
  if (loading) return { text: '読み込み中…', warn: false };
  if (!hasChain) {
    return error
      ? { text: '板を読めない。[最新] で読み直すか、板の JSON を選んでください。', warn: true }
      : { text: '板の JSON を選んでください。', warn: false };
  }
  if (error) return { text: kept ? `${error.message}。${kept}` : error.message, warn: true };
  return null;
}

/**
 * 新しい画面のルート（`?ui=next`。docs/ui-redesign.md §2・§10.1）。作業の状態・保存・共有は旧画面と同じ
 * useAppController（キー・形式を変えない）、見た目の状態（パネル・シート・市場）はここのローカル（保存しない）。
 * #81 の器（トップバー・知らせの行・見出し行・ドック）に、#82 で舞台（regions/Stage.tsx）を入れた。
 * 舞台で選んだ足（selectedLeg）はここのローカル（保存しない）。行使価格の変更はトーストの [元に戻す] で戻せる。
 * #83 でシナリオ（regions/Scenario.tsx）を入れた。ΔX の単位はここのローカル（保存しない。#87 の設定も同じ値を触る）。
 * #84 でポジション（regions/Positions.tsx。key = 作業中のタブ）を入れた。タブが変わったら [元に戻す] 付きのトーストを閉じる。
 * #86 で指標 · テール（regions/Metrics.tsx。c.metrics と state.feePerLot だけを渡す = pure が効く）を入れた。
 * #85 で板・スマイル（regions/Board.tsx・Smile.tsx。state の値を個別に渡す = pure が効く）を入れた。板・スマイルから
 * 足を入れたら [元に戻す]（removeLeg）付きのトーストを出し、入れた足を選ぶ（市場のパネルは開いたまま）。
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
  const { push, dropUndo } = toasts;
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
        loading={state.loading}
        onLatest={c.onLatest}
        theme={theme.pref}
        onTheme={theme.choose}
      />
      <Notices
        notes={c.notes}
        onCloseNote={c.closeNote}
        shareConfirm={
          pendingShare
            ? shareReplaceConfirmText(
                MAX_TABS,
                pendingShare.legs.length,
                c.tabsView.active.name,
                c.curLegs.length,
              )
            : null
        }
        onConfirmShare={c.confirmShare}
        onCancelShare={() => c.setPendingShare(null)}
        board={boardNotice(
          state.chain !== null,
          state.loading,
          state.loadError,
          state.chain ? keptBoardNote(state.fetchedAt, state.boardStale) : null,
        )}
        legError={state.legError}
        onClearLegError={() => dispatch({ type: 'clearLegError' })}
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
      <Toasts toasts={toasts.toasts} onUndo={toasts.undo} />
    </div>
  );
}

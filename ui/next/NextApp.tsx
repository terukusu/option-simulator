import { useCallback, useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { type Boot, useAppController } from '../components/useAppController';
import { useMediaQuery } from '../components/useMediaQuery';
import type { PrefsRead } from '../prefs';
import { legAtStrike, MAX_TABS } from '../state';
import { fmtNum } from '../view/format';
import { keptBoardNote } from '../view/header';
import { PC_QUERY, PHONE_QUERY } from '../view/layout';
import { shareReplaceConfirmText } from '../view/persistNote';
import type { DXUnit } from '../view/scenario';
import { INITIAL_SHELL, layoutTier, shellReduce } from '../view/shell';
import { Notices } from './Notices';
import { Toasts, useToasts } from './parts/Toast';
import { Metrics } from './regions/Metrics';
import { Positions } from './regions/Positions';
import { Scenario } from './regions/Scenario';
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
      />
      <Toasts toasts={toasts.toasts} onUndo={toasts.undo} />
    </div>
  );
}

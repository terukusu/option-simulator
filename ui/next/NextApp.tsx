import { useReducer } from 'preact/hooks';
import { type Boot, useAppController } from '../components/useAppController';
import { useMediaQuery } from '../components/useMediaQuery';
import type { PrefsRead } from '../prefs';
import { MAX_TABS } from '../state';
import { keptBoardNote } from '../view/header';
import { PC_QUERY, PHONE_QUERY } from '../view/layout';
import { shareReplaceConfirmText } from '../view/persistNote';
import { INITIAL_SHELL, layoutTier, shellReduce } from '../view/shell';
import { Notices } from './Notices';
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
 * #81 の時点は器だけ（トップバー・知らせの行・見出し行・ドック）。
 */
export function NextApp({ boot, prefs }: { boot: Boot; prefs: PrefsRead }) {
  const c = useAppController(boot);
  const { state, dispatch } = c;
  const theme = useTheme(prefs, boot.storage);
  const tier = layoutTier(useMediaQuery(PHONE_QUERY), useMediaQuery(PC_QUERY));
  const [shell, send] = useReducer(shellReduce, INITIAL_SHELL);
  const { pendingShare } = c;
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
      <Shell tier={tier} state={shell} send={send} legCount={c.curLegs.length} />
    </div>
  );
}

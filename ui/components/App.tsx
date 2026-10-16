import { useMemo } from 'preact/hooks';
import { defaultName } from '../book';
import { MAX_PINS } from '../pins';
import { shareSupported } from '../share';
import { MAX_TABS } from '../state';
import { keptBoardNote } from '../view/header';
import { shareReplaceConfirmText } from '../view/persistNote';
import { Board } from './Board';
import { Book, BookButton } from './Book';
import { Header } from './Header';
import { Hedge } from './Hedge';
import { LegForms } from './LegForms';
import { Loader } from './Loader';
import { Metrics } from './Metrics';
import { PnlChart } from './PnlChart';
import { Positions } from './Positions';
import { ScenarioPanel } from './ScenarioPanel';
import { Smile } from './Smile';
import { type Boot, DEV_FIXTURES, useAppController } from './useAppController';
import { WorkTabs } from './WorkTabs';

export type { Boot } from './useAppController';

/** 旧画面（`?ui=next` なし）。状態と保存は useAppController（#81）、ここはレイアウトの JSX だけ */
export function App({ boot }: { boot?: Boot }) {
  const {
    state,
    dispatch,
    notes,
    closeNote,
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
    positions,
    pnlBase,
    metrics,
    readout,
    hedgeView,
    targets,
    onZoom,
    smilePick,
    scenarioAtmView,
    pins,
    pinLine,
    pinTargets,
    pinCurrent,
    openBook,
    closeBook,
    onBookSave,
    onBookOverwrite,
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
  } = useAppController(boot);
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

import { useId, useState } from 'preact/hooks';
import type { ReplayBuild, ReplayEvent } from '../../../data/replay';
import { REPLAY_EVENTS } from '../../../data/replay';
import type { AtmMovesCtl } from '../../components/useAtmMoves';
import type { ReplayCtl } from '../../components/useReplay';
import { HOLD_MAP_RETRY } from '../../view/holdMap';
import type { AmountUnit } from '../../view/metrics';
import {
  REPLAY_BIAS_NOTE,
  REPLAY_CALL_MARK,
  REPLAY_CAPTION,
  REPLAY_COMPUTING,
  REPLAY_EVENT_LABEL,
  REPLAY_METHOD_NOTE,
  REPLAY_NO_RECOVERY_NONE,
  REPLAY_PATHS,
  REPLAY_TITLE,
  type ReplayPathKind,
  replayEventLine,
  replayEventOptions,
  replayHalfNote,
  replayLevelNote,
  replayStatusText,
  replaySummaryText,
  replayTableNotes,
  replayTableRows,
} from '../../view/replay';
import { Icon } from '../parts/Icon';
import { ManualLinks } from '../parts/ManualLinks';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';

/** 指標パネルに渡す過去の急落の再生の束（NextApp の useMemo。参照が同じなら描き直さない） */
export interface ReplayBundle {
  open: boolean;
  onToggle: () => void;
  noLegs: boolean;
  noCapital: boolean;
  /** 過去の値の読み込み（追証マップと共用。失敗の [再試行] も同じ） */
  load: AtmMovesCtl;
  event: ReplayEvent;
  onEvent: (id: string) => void;
  /** 選んだ出来事の道筋（読めていなければ null） */
  build: ReplayBuild | null;
  ctl: ReplayCtl;
  /** 許容損失（円。未設定は null） */
  allowedLoss: number | null;
  /** 今の 30 日の IV（%。無ければ null。注記だけ） */
  ivNow: number | null;
}

const EVENT_OPTIONS = replayEventOptions(REPLAY_EVENTS);

/**
 * 過去の急落の再生（#307。設計 5.14）: 指標 · テールの追証マップの下の折りたたみ（既定は閉・開閉と出来事の選択は
 * ShellState = 保存しない）。中身は出来事の選択・出来事の 1 行・要約 2 行（実際 / 戻らなかった）・日ごとの表
 * （[実際 | 戻らなかった] の切り替えは部品の状態）。表は枠の中だけ横にスクロールする（画面は横にはみ出さない）。
 * 表示モデルは ui/view/replay.ts、計算の時機は ui/components/useReplay.ts
 */
export function Replay({ replay, unit }: { replay: ReplayBundle; unit: AmountUnit }) {
  const id = useId();
  const [kind, setKind] = useState<ReplayPathKind>('actual');
  const { build, ctl, allowedLoss } = replay;
  const status = replayStatusText({
    noLegs: replay.noLegs,
    noCapital: replay.noCapital,
    loadStatus: replay.load.status,
    build,
  });
  const path = build?.status === 'ok' ? build : null;
  const result = ctl.result;
  const noRecovery = result?.noRecovery ?? null;
  const shownKind: ReplayPathKind =
    kind === 'noRecovery' && result && !noRecovery ? 'actual' : kind;
  const rows = result ? (shownKind === 'actual' ? result.actual : noRecovery) : null;
  const end = result ? (shownKind === 'actual' ? result.actualEnd : result.noRecoveryEnd) : null;
  const halfNote = path ? replayHalfNote(path) : null;
  return (
    <>
      <div class="hm-head rp-head">
        <button
          type="button"
          class="hm-toggle"
          aria-expanded={replay.open}
          aria-controls={id}
          onClick={replay.onToggle}
        >
          <Icon name="chevron" />
          <span class="hm-title">{REPLAY_TITLE}</span>
        </button>
        <Popover label="過去の急落の再生の読み方" button={<Icon name="info" />}>
          <p>{REPLAY_CAPTION}</p>
          <p>{REPLAY_METHOD_NOTE}</p>
          {path && <p>{replayLevelNote(path, replay.ivNow)}</p>}
          <p>{REPLAY_BIAS_NOTE}</p>
          <ManualLinks place="replay" />
        </Popover>
      </div>
      {replay.open && (
        <div id={id} class="rp" aria-busy={ctl.computing ? 'true' : 'false'}>
          <label class="rp-ev">
            <span class="lab">{REPLAY_EVENT_LABEL}</span>
            <select
              name="replay-event"
              value={replay.event.id}
              onChange={(e) => replay.onEvent(e.currentTarget.value)}
            >
              {EVENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.text}
                </option>
              ))}
            </select>
          </label>
          {status.main !== null ? (
            <p class="hm-status">
              {status.main}
              {status.retry && (
                <button type="button" class="btn sm hm-retry" onClick={replay.load.retry}>
                  {HOLD_MAP_RETRY}
                </button>
              )}
            </p>
          ) : (
            path && (
              <>
                <p class="rp-line">{replayEventLine(replay.event, path)}</p>
                {halfNote && <p class="rp-note">{halfNote}</p>}
                {result ? (
                  <div class={ctl.computing ? 'rp-res busy' : 'rp-res'}>
                    <dl class="rp-sum">
                      <div>
                        <dt>実際</dt>
                        <dd>
                          {replaySummaryText(result.actual, result.actualEnd, unit, allowedLoss)}
                        </dd>
                      </div>
                      <div>
                        <dt>戻らなかった</dt>
                        <dd>
                          {replaySummaryText(noRecovery, result.noRecoveryEnd, unit, allowedLoss)}
                        </dd>
                      </div>
                    </dl>
                    <div class="rp-seg">
                      <Seg
                        label="表の道筋"
                        value={shownKind}
                        onChange={setKind}
                        options={REPLAY_PATHS.map((o) => ({
                          ...o,
                          disabled: o.value === 'noRecovery' && !noRecovery,
                        }))}
                      />
                    </div>
                    {rows === null ? (
                      <p class="rp-note">{REPLAY_NO_RECOVERY_NONE}</p>
                    ) : (
                      <ReplayTable rows={rows} unit={unit} />
                    )}
                    {rows !== null &&
                      replayTableNotes(rows, end).map((n) => (
                        <p class="rp-note" key={n}>
                          {n}
                        </p>
                      ))}
                  </div>
                ) : (
                  <p class="hm-status">{REPLAY_COMPUTING}</p>
                )}
              </>
            )
          )}
        </div>
      )}
    </>
  );
}

/** 日ごとの表（枠の中だけ横にスクロール。追証の行は余力に印） */
function ReplayTable({
  rows,
  unit,
}: {
  rows: Parameters<typeof replayTableRows>[0];
  unit: AmountUnit;
}) {
  const view = replayTableRows(rows, unit);
  return (
    // 横にはみ出したときにキーボードで動かす枠（名前つきの section = region。画面は横にはみ出さない）
    // biome-ignore lint/a11y/noNoninteractiveTabindex: スクロールする枠にフォーカスを入れて矢印キーで動かす
    <section class="rp-scroll" aria-label="日ごとの余力と損益" tabIndex={0}>
      <table class="tail rp-table">
        <thead>
          <tr>
            <th scope="col">日</th>
            <th scope="col">原資産</th>
            <th scope="col">IV</th>
            <th scope="col">損益</th>
            <th scope="col">余力</th>
          </tr>
        </thead>
        <tbody>
          {view.map((r) => (
            <tr key={r.key} class={r.cont ? 'cont' : undefined}>
              <th scope="row">
                <span>{r.k}</span>
                <small>{r.date}</small>
              </th>
              <td>{r.u}</td>
              <td>{r.c}</td>
              <td>{r.pnl}</td>
              <td class={r.tone ?? undefined}>
                <span class="txt">
                  <span>{r.room}</span>
                  {r.call && <small class="call">{REPLAY_CALL_MARK}</small>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

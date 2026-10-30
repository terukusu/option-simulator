import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Calendar, Chain } from '../../data';
import type { AtmBasis, MarginParams, ModelSettings, Scenario } from '../../model';
import type { BookRead } from '../book';
import type { BookMessage } from '../components/useAppController';
import { useMarginLineState } from '../components/useMarginLine';
import type { MetricsUnitSetting, TabSlot, UiLeg } from '../state';
import {
  DISTANCE_CALL_NOW,
  distanceParts,
  HOLDINGS_EMPTY_TEXT,
  type HoldingsTotalView,
  holdingsModel,
  TOTAL_LABEL,
} from '../view/holdings';
import { MARK_BASIS_TEXT } from '../view/mark';
import { Dialog } from './parts/Dialog';
import { Icon } from './parts/Icon';
import { Popover } from './parts/Popover';

export interface HoldingsDialogProps {
  open: boolean;
  chain: Chain | null;
  tabs: readonly TabSlot[];
  activeTab: number;
  legs: readonly UiLeg[];
  read: BookRead;
  atmBasis: AtmBasis;
  calendar: Calendar;
  feePerLot: number;
  futureBasis: ModelSettings['futureBasis'];
  unitSetting: MetricsUnitSetting;
  /** 今（useAppController の nowScenario。β・動き方・IV の入れ方だけで作り直す参照） */
  nowScenario: Scenario;
  params: MarginParams;
  capital: number | null;
  message: BookMessage | null;
  onClose: () => void;
  onSwitchTab: (id: number) => void;
  onOpenNewTab: (id: string) => boolean;
  /** 開いている間のトースト（モーダルの外は押せないので、ダイアログの中に描く） */
  toasts: ComponentChildren;
}

const NO_BOARD_OPEN = '板が無いので開けない（板を読むと開ける）';

/**
 * 保有ポジションの一覧のダイアログ（#302。docs/design.md 13.4・docs/ui-redesign.md §5）。表示モデル（ui/view/holdings.ts）は
 * 開いている間だけマウントされる HoldingsBody の memo でだけ作る（シナリオは入力に無い = シナリオの操作で作り直さない）。
 * 行は保存一覧の部品のクラス（bk-*）を使い回す。名前は JSX のテキスト / 属性だけ。
 */
export function HoldingsDialog(p: HoldingsDialogProps) {
  return (
    <Dialog
      open={p.open}
      title="保有ポジション"
      class="holdings"
      onClose={p.onClose}
      head={
        <Popover label="保有ポジション" button={<Icon name="info" />}>
          <p>
            保有の印の付いたタブと保存一覧の項目を、今の板・今の時刻（シナリオを動かさない）で並べる。評価損益
            = 保存した建値のまま{MARK_BASIS_TEXT}
            で評価した含み損益（指標の内訳の「含み損益」。手数料の前）から手数料を引いた値（前の板で建てた足では画面のシナリオ
            0 の損益と同じ）。
          </p>
          <p>
            同じ足（商品・限月・行使価格・売買・建値・建てた日時）を持つ行は二重に数えない:
            足の組が全く同じなら 1 行にまとめ、1
            本でも重なる行は出すが合計に入れない（古い方の印を外すか削除すると直る）。
          </p>
          <p>
            {TOTAL_LABEL}
            は合計に入れる行の足を 1 つのポジションにまとめて計算する。必要証拠金は売りと買い・put
            と call が相殺するので行の和にならない。手数料・先物の basis
            は作業中の値。余力は端末の設定の資金に対する値。追証までの距離 = 今の IV
            のまま原資産だけを動かして余力が 0 になる水準のうち今に最も近い下と上（β・IV
            の動き方は画面の設定）。IV の急騰と同時の危なさは追証マップ（作業中のタブ）で見る。
          </p>
        </Popover>
      }
      after={p.toasts}
    >
      <HoldingsBody {...p} />
    </Dialog>
  );
}

function HoldingsBody(p: HoldingsDialogProps) {
  const {
    chain,
    tabs,
    activeTab,
    legs,
    read,
    atmBasis,
    calendar,
    feePerLot,
    futureBasis,
    unitSetting,
    nowScenario,
    params,
    capital,
  } = p;
  const view = useMemo(
    () =>
      holdingsModel({
        chain,
        tabs,
        activeTab,
        legs,
        read,
        atmBasis,
        calendar,
        feePerLot,
        futureBasis,
        unitSetting,
        nowScenario,
        params,
        capital,
      }),
    [
      chain,
      tabs,
      activeTab,
      legs,
      read,
      atmBasis,
      calendar,
      feePerLot,
      futureBasis,
      unitSetting,
      nowScenario,
      params,
      capital,
    ],
  );
  const hasBoard = chain !== null;
  return (
    <div class="bk">
      {p.message && (
        <p class={p.message.warn ? 'bk-msg warn' : 'bk-msg'} role="status">
          {p.message.text}
        </p>
      )}
      <p class="bk-note">
        {view.boardText
          ? `今の板（${view.boardText}）・シナリオ 0 で計算。金額の単位: ${view.unitLabel}`
          : '板が無い（評価損益・必要証拠金・Δ は板を読むと出る）'}
      </p>
      {view.empty ? (
        <p class="bk-note">{HOLDINGS_EMPTY_TEXT}</p>
      ) : (
        <ul class="bk-list">
          {view.rows.map((row) => (
            <li key={row.key} class="bk-row">
              <div class="bk-head">
                <strong class="bk-name" title={row.name}>
                  {row.name}
                </strong>
                {row.tags.map((t) => (
                  <span class={t.warn ? 'tag warn' : 'tag'} key={t.text}>
                    {t.text}
                  </span>
                ))}
              </div>
              <div class="bk-sum">
                <span>
                  {row.months}・{row.legs}
                </span>
                <span>{row.heldText}</span>
                <span>
                  評価損益 <strong>{row.markText}</strong>
                </span>
                {row.markNote && <span class="bk-dim">（{row.markNote}）</span>}
                <span>必要証拠金 {row.marginText}</span>
                <span>Δ {row.deltaText}</span>
                {row.note && <span class="bk-dim">{row.note}</span>}
              </div>
              {row.action && (
                <div class="bk-ops">
                  {row.action.kind === 'switchTab' ? (
                    <button
                      type="button"
                      class="btn sm"
                      aria-label={`${row.name} のタブへ切り替える`}
                      onClick={() => {
                        if (row.action?.kind === 'switchTab') p.onSwitchTab(row.action.tabId);
                      }}
                    >
                      このタブへ
                    </button>
                  ) : (
                    <button
                      type="button"
                      class="btn sm"
                      aria-label={`${row.name} を新しいタブで開く`}
                      disabled={!hasBoard || row.action.disabled !== null}
                      title={!hasBoard ? NO_BOARD_OPEN : (row.action.disabled ?? undefined)}
                      onClick={() => {
                        if (row.action?.kind === 'openNewTab') p.onOpenNewTab(row.action.entryId);
                      }}
                    >
                      新しいタブで開く
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
          {view.total && <TotalRow total={view.total} />}
        </ul>
      )}
    </div>
  );
}

function TotalRow({ total }: { total: HoldingsTotalView }) {
  // 追証までの距離は開いた描画の後に作る（作っている間は「計算中…」。描画をふさがない）
  const levels = useMarginLineState(total.line);
  const distance =
    total.distanceFixed !== null ? [total.distanceFixed] : distanceParts(total.x0, levels);
  return (
    <li class="bk-row hl-total">
      <div class="bk-head">
        <strong class="bk-name">{TOTAL_LABEL}</strong>
        <span class="tag">合計 {total.count} 行</span>
      </div>
      <div class="bk-sum">
        <span>
          評価損益 <strong>{total.markText}</strong>
        </span>
        {total.markNote && <span class="bk-dim">（{total.markNote}）</span>}
        <span>必要証拠金 {total.marginText}</span>
        <span class={total.roomWarn ? 'warn' : undefined}>
          余力 <strong>{total.roomText}</strong>
        </span>
        <span>Δ {total.deltaText}</span>
        {total.note && <span class="bk-dim">{total.note}</span>}
      </div>
      <div class="bk-sum">
        <span>追証までの距離</span>
        {distance.map((d) => (
          <span key={d} class={d === DISTANCE_CALL_NOW ? 'warn' : undefined}>
            {d}
          </span>
        ))}
      </div>
    </li>
  );
}

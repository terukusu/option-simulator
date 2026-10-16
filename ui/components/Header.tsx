import { Fragment } from 'preact';
import type { AtmBasis } from '../../model';
import type { HeaderModel, ReferenceView } from '../view/header';
import { Hint } from './Hint';

function Ref({ r, active }: { r: ReferenceView; active: boolean }) {
  return (
    <span class={active ? 'ref active' : 'ref'}>
      {r.basis === 'A' ? 'A 先物' : 'B 合成先物'} {r.price}
      {r.time !== '—' && <span class="note">（{r.time}）</span>}
      {r.fellBack && <span class="tag">A で代用</span>}
      {r.stale && <span class="tag warn">古い</span>}
    </span>
  );
}

export function Header({
  model,
  onBasis,
}: {
  model: HeaderModel;
  onBasis: (basis: AtmBasis) => void;
}) {
  return (
    <header class="header">
      <p class="head-line">
        <strong>板 {model.snapshot}</strong>（{model.delay}）<span class="tag">{model.reason}</span>
        {model.boardStale && <span class="tag warn">古い板</span>}
        {model.fetched && (
          <span class="note">
            取得 {model.fetched}
            {model.loadedFrom && `（${model.loadedFrom}）`}
          </span>
        )}
        {model.source && <span class="note">データ元: {model.source}</span>}
      </p>
      {model.reasonNote && <p class="note reason-note">{model.reasonNote}</p>}
      <p class="head-line">
        <span>
          日経平均 {model.spot.price}
          <span class="note">（{model.spot.time}）</span>
        </span>
        <span>
          先物 {model.future.contract} 限 {model.future.price}
          <span class="note">
            （約定 {model.future.time}・SQ {model.future.sqDate}）
          </span>
        </span>
      </p>
      <fieldset class="basis">
        <legend>ATM の基準</legend>
        <label>
          <input
            type="radio"
            name="atm-basis"
            checked={model.basis === 'B'}
            onChange={() => onBasis('B')}
          />
          B 合成先物（限月ごと）
        </label>
        <label>
          <input
            type="radio"
            name="atm-basis"
            checked={model.basis === 'A'}
            onChange={() => onBasis('A')}
          />
          A ラージ先物（直近四半期）
        </label>
      </fieldset>
      <div class="head-months">
        {model.months.map((m) => (
          <div class="head-month" key={m.id}>
            <p>
              <strong>{m.id} 限</strong>{' '}
              <span class="note">
                最終 {m.lastTradingDay}・SQ {m.sqDate}
              </span>
            </p>
            <p>
              F {m.forward}{' '}
              <span class={m.noForward ? 'tag warn' : 'tag'}>{m.forwardKindLabel}</span>
            </p>
            <p class="refs">
              <Ref r={m.refA} active={model.basis === 'A'} />
              <Ref r={m.refB} active={model.basis === 'B'} />
            </p>
            <p>
              ATM（{model.basis}） <strong class={m.noAtm ? 'warn' : ''}>{m.atm}</strong>
            </p>
          </div>
        ))}
      </div>
      <p class="note hint-host">
        前提:{' '}
        {model.assumptions.map((a, i) => (
          <Fragment key={a}>
            {i > 0 && ' / '}
            {a === model.calendarWarning ? <strong class="warn">{a}</strong> : a}
          </Fragment>
        ))}{' '}
        <Hint label="計算の前提">
          金利は割引（e^−rT）とプット・コール・パリティに使う年率（価格への影響はおおむね 金利 ×
          残存期間。0.5% なら 1 か月で 0.05% 程度）。評価時刻は残存期間を数える起点で、指定日 d
          はここから数える。取引カレンダーは SQ
          日・取引最終日の休業日の判定に使い、確定の範囲より先は休業日が漏れている可能性がある
        </Hint>
      </p>
    </header>
  );
}

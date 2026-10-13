import { useEffect, useState } from 'preact/hooks';
import { type Action, parseHedgeTarget } from '../state';
import { fmtNum, fmtSigned } from '../view/format';
import {
  HEDGE_AT_LABEL,
  HEDGE_REASON_LABEL,
  type HedgeAt,
  type HedgeLine,
  type HedgeModel,
} from '../view/hedge';
import { PRODUCT_LABEL, SIDE_LABEL } from '../view/position';
import { pure } from './pure';

const SHORT: Record<HedgeLine['product'], string> = { fut_mini: 'ミニ', fut_large: 'ラージ' };

function Line({ line, dispatch }: { line: HedgeLine; dispatch: (a: Action) => void }) {
  const { input } = line;
  return (
    <li class="hedge-line">
      <span class="hedge-lots">
        {SHORT[line.product]} {line.lots === null ? '—' : `${fmtSigned(line.lots)} 枚`}
        {line.residual !== null && <span class="note">（残り {fmtSigned(line.residual, 3)}）</span>}
      </span>
      <button
        type="button"
        disabled={!line.canAdd || input === null}
        aria-label={
          input
            ? `${PRODUCT_LABEL[line.product]} ${input.contract ?? ''} ${SIDE_LABEL[input.side]} ${fmtNum(input.qty ?? 0)} 枚を追加`
            : `${PRODUCT_LABEL[line.product]}を追加（できない）`
        }
        onClick={() => {
          if (input) dispatch({ type: 'addFutureLeg', input });
        }}
      >
        追加
      </button>
      {line.reason &&
        line.reason !== 'no_price' &&
        line.reason !== 'no_leg' &&
        line.reason !== 'settled' && (
          <span class="field-error">{HEDGE_REASON_LABEL[line.reason]}</span>
        )}
    </li>
  );
}

export interface HedgeProps {
  model: HedgeModel;
  dispatch: (a: Action) => void;
}

/** デルタヘッジのパネル（M12・5.8）。値は ui/view/hedge.ts の表示モデル。 */
function HedgeView({ model, dispatch }: HedgeProps) {
  const [targetText, setTargetText] = useState(String(model.target));
  const [targetError, setTargetError] = useState<string | null>(null);
  useEffect(() => {
    const r = parseHedgeTarget(targetText);
    if (!(r.ok && r.value === model.target)) {
      setTargetText(String(model.target));
      setTargetError(null);
    }
  }, [model.target]);
  const onTarget = (t: string) => {
    setTargetText(t);
    const r = parseHedgeTarget(t);
    if (r.ok) {
      setTargetError(null);
      if (r.value !== model.target) dispatch({ type: 'setHedge', patch: { target: r.value } });
    } else setTargetError(r.message);
  };

  const common =
    model.reason === 'no_price' || model.reason === 'no_leg' || model.reason === 'settled'
      ? model.reason
      : null;
  const cur = model.current;

  return (
    <section class="hedge" aria-label="デルタヘッジ">
      <h2>デルタヘッジ</h2>
      <div class="hedge-tools">
        <label>
          目標 Δ（ラージ換算）{' '}
          <input
            type="text"
            inputMode="decimal"
            size={6}
            value={targetText}
            aria-invalid={targetError !== null}
            onInput={(e) => onTarget(e.currentTarget.value)}
          />
        </label>
        <fieldset class="seg" aria-label="評価点">
          {(['base', 'scenario'] as const satisfies readonly HedgeAt[]).map((v) => (
            <button
              type="button"
              key={v}
              aria-pressed={model.at === v}
              onClick={() => dispatch({ type: 'setHedge', patch: { at: v } })}
            >
              {HEDGE_AT_LABEL[v]}
            </button>
          ))}
        </fieldset>
        <label>
          限月{' '}
          <select
            value={model.contract}
            onChange={(e) => {
              const v = e.currentTarget.value;
              dispatch({ type: 'setHedge', patch: { contract: v } });
            }}
          >
            {model.contracts.map((c) => (
              <option key={c} value={c}>
                {c} 限
              </option>
            ))}
          </select>
        </label>
      </div>
      {targetError && (
        <p class="field-error" role="alert">
          {targetError}
        </p>
      )}
      <p class="hedge-current">
        現在 Δ（{HEDGE_AT_LABEL[model.at]}）:{' '}
        {cur
          ? `${fmtSigned(cur.large, 3)} 枚（ラージ）= ${fmtSigned(cur.mini, 2)} 枚（ミニ）`
          : '—'}
      </p>
      {model.contractManual && model.entry !== null && (
        <p class="note">
          建値は手入力（板の先物と限月違い）: 初期値 = {model.contract} 限の合成先物{' '}
          {fmtNum(model.entry)}
        </p>
      )}
      {common ? (
        <p class="warn">{HEDGE_REASON_LABEL[common]}</p>
      ) : (
        <ul class="hedge-lines">
          {model.lines.map((l) => (
            <Line key={l.product} line={l} dispatch={dispatch} />
          ))}
        </ul>
      )}
      {model.micro && (
        <p class="note">
          ミニは 0 枚。マイクロ換算 {fmtSigned(model.micro.lots)} 枚（残り{' '}
          {fmtSigned(model.micro.residual, 3)}。マイクロは足の追加フォームから）
        </p>
      )}
    </section>
  );
}

export const Hedge = pure(HedgeView);

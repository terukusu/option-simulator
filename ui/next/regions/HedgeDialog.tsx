import { useMemo, useState } from 'preact/hooks';
import { type Action, parseHedgeTarget } from '../../state';
import type { HedgeAt, HedgeModel } from '../../view/hedge';
import { HEDGE_AT_OPTIONS, type HedgeLineView, hedgeSection } from '../../view/positionsRegion';
import { Dialog } from '../parts/Dialog';
import { Seg } from '../parts/Seg';

/**
 * ヘッジのダイアログ（docs/ui-redesign.md §3・§4.4・§9 の Hedge。#84）: 評価点（適用前 / シナリオ時点）・現在 Δ と
 * ミニ / ラージの枚数・残り・[追加]・注記（#274 でポジションの節から移した。常設はポジションの 1 行だけ）、目標 Δ（ラージ換算）と限月。
 * 目標 Δ は旧 Hedge と同じく入力ごとに parseHedgeTarget → 通れば setHedge { target }、外れたら role="alert"
 * （閉じても反映済みの値は残る）。限月は select の change で setHedge { contract }。保存は既存の hedge の保存。
 */
export function HedgeDialog(p: {
  open: boolean;
  onClose: () => void;
  model: HedgeModel;
  dispatch: (a: Action) => void;
  onAdd: (l: HedgeLineView) => void;
}) {
  if (!p.open) return null;
  return <HedgeDialogBody {...p} />;
}

function HedgeDialogBody(p: {
  onClose: () => void;
  model: HedgeModel;
  dispatch: (a: Action) => void;
  onAdd: (l: HedgeLineView) => void;
}) {
  const { model, dispatch } = p;
  const view = useMemo(() => hedgeSection(model), [model]);
  const [text, setText] = useState(() => String(model.target));
  const [error, setError] = useState<string | null>(null);
  const onTarget = (t: string) => {
    setText(t);
    const r = parseHedgeTarget(t);
    if (r.ok) {
      setError(null);
      if (r.value !== model.target) dispatch({ type: 'setHedge', patch: { target: r.value } });
    } else setError(r.message);
  };
  return (
    <Dialog open title="デルタヘッジ" onClose={p.onClose}>
      <div class="hedge">
        <div class="hl at">
          <Seg<HedgeAt>
            label="評価点"
            value={model.at}
            options={HEDGE_AT_OPTIONS}
            onChange={(at) => dispatch({ type: 'setHedge', patch: { at } })}
          />
        </div>
        <div class="hl head">{view.head}</div>
        {view.common !== null ? (
          <p class="warn">{view.common}</p>
        ) : (
          view.lines.map((l) => (
            <div class="hl line" key={l.product} data-product={l.product}>
              <span class="txt">
                <b>
                  {l.label} {l.lots}
                </b>
                {l.residual !== null && <span class="faint">（{l.residual}）</span>}
                {l.reason !== null && <span class="why">{l.reason}</span>}
              </span>
              <button
                type="button"
                class="btn sm"
                disabled={!l.canAdd}
                aria-label={l.aria}
                onClick={() => p.onAdd(l)}
              >
                追加
              </button>
            </div>
          ))
        )}
        {view.notes.map((n) => (
          <p class="note" key={n}>
            {n}
          </p>
        ))}
      </div>
      <form
        class="pos-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (error === null) p.onClose();
        }}
      >
        <div class="fields">
          <label class="fld">
            <span class="lab">目標 Δ（ラージ換算）</span>
            <input
              class="input"
              name="target"
              inputMode="decimal"
              value={text}
              aria-invalid={error !== null ? 'true' : 'false'}
              onInput={(e) => onTarget(e.currentTarget.value)}
            />
          </label>
          <label class="fld">
            <span class="lab">限月</span>
            <select
              name="contract"
              value={model.contract}
              onChange={(e) =>
                dispatch({ type: 'setHedge', patch: { contract: e.currentTarget.value } })
              }
            >
              {model.contracts.map((c) => (
                <option key={c} value={c}>
                  {c} 限
                </option>
              ))}
            </select>
          </label>
        </div>
        {error !== null && (
          <p class="form-err" role="alert">
            {error}
          </p>
        )}
        <div class="form-acts">
          <button type="submit" class="btn primary">
            完了
          </button>
        </div>
      </form>
    </Dialog>
  );
}

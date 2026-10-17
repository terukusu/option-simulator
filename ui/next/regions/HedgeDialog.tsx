import { useState } from 'preact/hooks';
import { type Action, parseHedgeTarget } from '../../state';
import type { HedgeModel } from '../../view/hedge';
import { Dialog } from '../parts/Dialog';

/**
 * ヘッジの設定ダイアログ（docs/ui-redesign.md §3・§4.4・§9 の Hedge。#84）: 目標 Δ（ラージ換算）と限月。
 * 目標 Δ は旧 Hedge と同じく入力ごとに parseHedgeTarget → 通れば setHedge { target }、外れたら role="alert"
 * （閉じても反映済みの値は残る）。限月は select の change で setHedge { contract }。保存は既存の hedge の保存。
 */
export function HedgeDialog(p: {
  open: boolean;
  onClose: () => void;
  model: HedgeModel;
  dispatch: (a: Action) => void;
}) {
  if (!p.open) return null;
  return <HedgeDialogBody {...p} />;
}

function HedgeDialogBody(p: {
  onClose: () => void;
  model: HedgeModel;
  dispatch: (a: Action) => void;
}) {
  const { model, dispatch } = p;
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
    <Dialog open title="ヘッジの設定" onClose={p.onClose}>
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

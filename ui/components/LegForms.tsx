import { useState } from 'preact/hooks';
import type { Chain } from '../../data';
import type { FutureProduct, OptionType, Side } from '../../model';
import {
  type Action,
  parseContract,
  parseEntry,
  parseIvPct,
  parseQty,
  parseStrike,
} from '../state';
import { PRODUCT_LABEL } from '../view/position';
import { Hint } from './Hint';

function text(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value : '';
}

/** 先物の足（既定ミニ。K6）と、板の無い限月の OP の足（手入力。5.7）の追加フォーム。 */
export function LegForms({ chain, dispatch }: { chain: Chain; dispatch: (a: Action) => void }) {
  const [futError, setFutError] = useState<string | null>(null);
  const [optError, setOptError] = useState<string | null>(null);

  const addFuture = (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const contract = parseContract(text(form, 'contract'));
    const qty = parseQty(text(form, 'qty'));
    const entryText = text(form, 'entry');
    const entry = entryText.trim() === '' ? null : parseEntry(entryText);
    const bad = [contract, qty, entry].find((r) => r !== null && !r.ok);
    if (bad && !bad.ok) {
      setFutError(bad.message);
      return;
    }
    setFutError(null);
    if (!contract.ok || !qty.ok) return;
    const input: Parameters<typeof dispatchFuture>[0] = {
      product: text(form, 'product') as FutureProduct,
      contract: contract.value,
      side: text(form, 'side') as Side,
      qty: qty.value,
    };
    if (entry?.ok) input.entry = entry.value;
    dispatchFuture(input);
  };
  const dispatchFuture = (input: {
    product: FutureProduct;
    contract: string;
    side: Side;
    qty: number;
    entry?: number;
  }) => dispatch({ type: 'addFutureLeg', input });

  const addOption = (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const expiry = parseContract(text(form, 'expiry'));
    const k = parseStrike(text(form, 'k'));
    const qty = parseQty(text(form, 'qty'));
    const entry = parseEntry(text(form, 'entry'));
    const iv = parseIvPct(text(form, 'iv'), false);
    for (const r of [expiry, k, qty, entry, iv]) {
      if (!r.ok) {
        setOptError(r.message);
        return;
      }
    }
    setOptError(null);
    if (!expiry.ok || !k.ok || !qty.ok || !entry.ok || !iv.ok || iv.value === null) return;
    dispatch({
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: expiry.value,
        type: text(form, 'type') as OptionType,
        k: k.value,
        side: text(form, 'side') as Side,
        qty: qty.value,
        entry: entry.value,
        iv: iv.value,
      },
    });
  };

  return (
    <div class="leg-forms">
      <form class="leg-form" onSubmit={addFuture}>
        <h3>先物の足</h3>
        <label>
          商品
          <select name="product">
            {(['fut_mini', 'fut_large', 'fut_micro'] as const).map((p) => (
              <option key={p} value={p} selected={p === 'fut_mini'}>
                {PRODUCT_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          限月
          <input name="contract" defaultValue={chain.future.id} size={8} />
        </label>
        <label>
          売買
          <select name="side">
            <option value="buy" selected>
              買い
            </option>
            <option value="sell">売り</option>
          </select>
        </label>
        <label>
          枚数
          <input name="qty" defaultValue="1" inputMode="numeric" size={4} />
        </label>
        <label>
          建値
          <input name="entry" placeholder="板の先物" inputMode="decimal" size={8} />
        </label>
        <button type="submit">追加</button>
        {futError && <p class="field-error">{futError}</p>}
      </form>
      <form class="leg-form" onSubmit={addOption}>
        <div class="sub-head hint-host">
          <h3>OP の足（手入力）</h3>
          <Hint label="手入力の OP の足">
            板の無い限月は SQ 日を取引カレンダー（optionchan
            の版か同梱の版）から求める。確定の最終日より後の限月は「休業日未確定」。F
            は板の先物価格で代用。
          </Hint>
        </div>
        <label>
          限月
          <input name="expiry" placeholder="YYYY-MM" size={8} />
        </label>
        <label>
          種別
          <select name="type">
            <option value="put" selected>
              put
            </option>
            <option value="call">call</option>
          </select>
        </label>
        <label>
          K
          <input name="k" inputMode="numeric" size={7} />
        </label>
        <label>
          売買
          <select name="side">
            <option value="sell" selected>
              売り
            </option>
            <option value="buy">買い</option>
          </select>
        </label>
        <label>
          枚数
          <input name="qty" defaultValue="1" inputMode="numeric" size={4} />
        </label>
        <label>
          建値
          <input name="entry" inputMode="decimal" size={6} />
        </label>
        <label>
          IV %
          <input name="iv" inputMode="decimal" size={5} />
        </label>
        <button type="submit">追加</button>
        {optError && <p class="field-error">{optError}</p>}
      </form>
    </div>
  );
}

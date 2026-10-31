import { useState } from 'preact/hooks';
import type { Chain } from '../../../data';
import type { FutureProduct, Holidays, OptionType, Side } from '../../../model';
import type { Action } from '../../state';
import { PRODUCT_LABEL } from '../../view/position';
import {
  type FutureFormValues,
  futureForm,
  futureFormDefault,
  OPTION_FORM_DEFAULT,
  type OptionFormValues,
  optionForm,
} from '../../view/positionsRegion';
import type { ToastInput } from '../../view/toast';
import { Dialog } from '../parts/Dialog';
import { Seg } from '../parts/Seg';
import { focusIfLost } from '../useGlobalKeys';

type Kind = 'future' | 'option';
const KINDS = [
  { value: 'future', text: '先物' },
  { value: 'option', text: 'OP（手入力）' },
] as const;
const FUTURE_PRODUCTS: readonly FutureProduct[] = ['fut_mini', 'fut_large', 'fut_micro'];

/**
 * 足の追加ダイアログ（docs/ui-redesign.md §3・§4.4・§9 の LegForms。#84）。欄・既定値は旧 LegForms と同じ。
 * [追加]（Enter でも）は ui/view/positionsRegion.ts の futureForm / optionForm で先に組み立てて検証し、通れば dispatch →
 * 閉じる → トースト、外れたら開いたまま中に role="alert"（モーダルの後ろの知らせの行に頼らない）。値は開くたびに既定値。
 */
export function LegDialog(p: {
  open: boolean;
  onClose: () => void;
  chain: Chain | null;
  holidays: Holidays;
  dispatch: (a: Action) => void;
  push: (t: ToastInput) => void;
}) {
  if (!p.open || !p.chain) return null;
  return <LegDialogBody {...p} chain={p.chain} />;
}

function LegDialogBody(p: {
  onClose: () => void;
  chain: Chain;
  holidays: Holidays;
  dispatch: (a: Action) => void;
  push: (t: ToastInput) => void;
}) {
  const { chain } = p;
  const [kind, setKind] = useState<Kind>('future');
  const [fut, setFut] = useState<FutureFormValues>(() => futureFormDefault(chain));
  const [opt, setOpt] = useState<OptionFormValues>(OPTION_FORM_DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const futSet = (patch: Partial<FutureFormValues>) => setFut({ ...fut, ...patch });
  const optSet = (patch: Partial<OptionFormValues>) => setOpt({ ...opt, ...patch });
  const val = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement).value;

  const submit = (e: Event) => {
    e.preventDefault();
    const r =
      kind === 'future' ? futureForm(chain, p.holidays, fut) : optionForm(chain, p.holidays, opt);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    p.dispatch(r.action);
    p.onClose();
    // 空の欄の [手入力…] から開いた（開いたボタンが足で消えた）ならフォーカスは入れた足（最後の行）へ（#20 レビュー N3）
    focusIfLost('section.positions li.leg:last-child .leg-main');
    p.push({ kind: 'leg-add', text: r.toast });
  };

  return (
    <Dialog open title="手入力で足を追加" onClose={p.onClose}>
      <form class="pos-form" onSubmit={submit}>
        <Seg<Kind>
          label="足の種類"
          value={kind}
          options={KINDS}
          onChange={(k) => {
            setKind(k);
            setError(null);
          }}
        />
        {kind === 'future' ? (
          <div class="fields">
            <label class="fld">
              <span class="lab">商品</span>
              <select
                name="product"
                value={fut.product}
                onChange={(e) => futSet({ product: val(e) as FutureProduct })}
              >
                {FUTURE_PRODUCTS.map((pr) => (
                  <option key={pr} value={pr}>
                    {PRODUCT_LABEL[pr]}
                  </option>
                ))}
              </select>
            </label>
            <label class="fld">
              <span class="lab">限月</span>
              <input
                class="input"
                name="contract"
                value={fut.contract}
                onInput={(e) => futSet({ contract: val(e) })}
              />
            </label>
            <label class="fld">
              <span class="lab">売買</span>
              <select
                name="side"
                value={fut.side}
                onChange={(e) => futSet({ side: val(e) as Side })}
              >
                <option value="buy">買い</option>
                <option value="sell">売り</option>
              </select>
            </label>
            <label class="fld">
              <span class="lab">枚数</span>
              <input
                class="input"
                name="qty"
                inputMode="numeric"
                value={fut.qty}
                onInput={(e) => futSet({ qty: val(e) })}
              />
            </label>
            <label class="fld">
              <span class="lab">建値</span>
              <input
                class="input"
                name="entry"
                inputMode="decimal"
                placeholder="板の先物"
                value={fut.entry}
                onInput={(e) => futSet({ entry: val(e) })}
              />
            </label>
          </div>
        ) : (
          <>
            <p class="note">
              板の無い限月は SQ 日を取引カレンダー（optionchan
              の版か同梱の版）から求める。確定の最終日より後の限月は「休業日未確定」。F
              は板の先物価格で代用。
            </p>
            <div class="fields">
              <label class="fld">
                <span class="lab">限月</span>
                <input
                  class="input"
                  name="expiry"
                  placeholder="YYYY-MM"
                  value={opt.expiry}
                  onInput={(e) => optSet({ expiry: val(e) })}
                />
              </label>
              <label class="fld">
                <span class="lab">種別</span>
                <select
                  name="type"
                  value={opt.type}
                  onChange={(e) => optSet({ type: val(e) as OptionType })}
                >
                  <option value="put">put</option>
                  <option value="call">call</option>
                </select>
              </label>
              <label class="fld">
                <span class="lab">K</span>
                <input
                  class="input"
                  name="k"
                  inputMode="numeric"
                  value={opt.k}
                  onInput={(e) => optSet({ k: val(e) })}
                />
              </label>
              <label class="fld">
                <span class="lab">売買</span>
                <select
                  name="side"
                  value={opt.side}
                  onChange={(e) => optSet({ side: val(e) as Side })}
                >
                  <option value="sell">売り</option>
                  <option value="buy">買い</option>
                </select>
              </label>
              <label class="fld">
                <span class="lab">枚数</span>
                <input
                  class="input"
                  name="qty"
                  inputMode="numeric"
                  value={opt.qty}
                  onInput={(e) => optSet({ qty: val(e) })}
                />
              </label>
              <label class="fld">
                <span class="lab">建値</span>
                <input
                  class="input"
                  name="entry"
                  inputMode="decimal"
                  value={opt.entry}
                  onInput={(e) => optSet({ entry: val(e) })}
                />
              </label>
              <label class="fld">
                <span class="lab">IV %</span>
                <input
                  class="input"
                  name="iv"
                  inputMode="decimal"
                  value={opt.iv}
                  onInput={(e) => optSet({ iv: val(e) })}
                />
              </label>
            </div>
          </>
        )}
        {error !== null && (
          <p class="form-err" role="alert">
            {error}
          </p>
        )}
        <div class="form-acts">
          <button type="submit" class="btn primary">
            追加
          </button>
        </div>
      </form>
    </Dialog>
  );
}

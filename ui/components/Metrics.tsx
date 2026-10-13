import { useEffect, useState } from 'preact/hooks';
import { type Action, type MetricsUnitSetting, parseFee } from '../state';
import { DASH, fmtIv, fmtNum, fmtSigned } from '../view/format';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  fmtAmount,
  fmtRatio,
  type MetricsModel,
} from '../view/metrics';
import { pure } from './pure';

const UNIT_LABEL: Record<MetricsUnitSetting, string> = {
  auto: '自動',
  yen: '円',
  thousand: '千円',
};

const STATE_LABEL = {
  live: '',
  near_expiry: '満期直前',
  expired: '満期',
  settled_flat: '先物は SQ 済み',
  no_forward: 'F なし',
} as const;

const fmtXs = (xs: readonly number[]) =>
  xs.length === 0 ? 'なし' : xs.map((x) => fmtNum(x)).join(' / ');
const fmtPct = (v: number) => `${fmtSigned(v * 100, 0)}%`;

/** 金額 + 単位（∞ には単位を付けない） */
function Amount({ v, unit, signed }: { v: number | null; unit: AmountUnit; signed?: boolean }) {
  const s = fmtAmount(v, unit, signed);
  return (
    <>
      {s}
      {s !== DASH && !s.endsWith('∞') && <span class="unit">{AMOUNT_UNIT_LABEL[unit]}</span>}
    </>
  );
}

export interface MetricsProps {
  model: MetricsModel;
  unitSetting: MetricsUnitSetting;
  feePerLot: number;
  dispatch: (a: Action) => void;
}

/** 指標とテール表（M6・5.6）。値は ui/view/metrics.ts の表示モデル。 */
function MetricsView({ model, unitSetting, feePerLot, dispatch }: MetricsProps) {
  const [feeText, setFeeText] = useState(String(feePerLot));
  const [feeError, setFeeError] = useState<string | null>(null);
  useEffect(() => {
    const r = parseFee(feeText);
    if (!(r.ok && r.value === feePerLot)) {
      setFeeText(String(feePerLot));
      setFeeError(null);
    }
  }, [feePerLot]);
  const onFee = (t: string) => {
    setFeeText(t);
    const r = parseFee(t);
    if (r.ok) {
      setFeeError(null);
      if (r.value !== feePerLot) dispatch({ type: 'setFee', fee: r.value });
    } else setFeeError(r.message);
  };

  const u = model.unit;
  const { expiry, scenarioPoint: sp, premium, tail } = model;
  const g = sp.total;

  return (
    <div class="metrics">
      <div class="metrics-head">
        <h2>指標</h2>
        <fieldset class="seg" aria-label="金額の単位">
          {(['auto', 'yen', 'thousand'] as const).map((v) => (
            <button
              type="button"
              key={v}
              aria-pressed={unitSetting === v}
              onClick={() => dispatch({ type: 'setMetricsUnit', unit: v })}
            >
              {UNIT_LABEL[v]}
            </button>
          ))}
        </fieldset>
        <label class="metrics-fee">
          手数料{' '}
          <input
            type="text"
            inputMode="numeric"
            size={6}
            value={feeText}
            aria-invalid={feeError !== null}
            onInput={(e) => onFee(e.currentTarget.value)}
          />{' '}
          円 / 枚
        </label>
      </div>
      {feeError && (
        <p class="field-error" role="alert">
          {feeError}
        </p>
      )}
      {model.empty ? (
        <p class="note">足を追加すると指標が出ます</p>
      ) : (
        <>
          <p class="note">
            金額の単位: {AMOUNT_UNIT_LABEL[u]}
            {model.unitAuto ? '（自動: 受取 + 支払が 10 万円以上なら千円）' : '（固定）'}
          </p>
          <dl class="metrics-list">
            <dt>満期 最大利益</dt>
            <dd>
              <Amount v={expiry.maxProfit.value} unit={u} signed />
              {expiry.profitFinite && (
                <span class="note">
                  {' '}
                  （call 側 ∞ / put 側 <Amount v={expiry.profitFinite.value} unit={u} signed />）
                </span>
              )}
            </dd>
            <dt>満期 最大損失</dt>
            <dd>
              {expiry.lossFinite ? (
                <>
                  call 側 −∞ / put 側 <Amount v={expiry.lossFinite.value} unit={u} signed />
                  <span class="note">
                    {expiry.lossFinite.x === expiry.xLo
                      ? '（SQ = 下端）'
                      : `（X = ${fmtNum(expiry.lossFinite.x)}）`}
                  </span>
                </>
              ) : (
                <Amount v={expiry.maxLoss.value} unit={u} signed />
              )}
            </dd>
            <dt>満期 BEP</dt>
            <dd>{fmtXs(expiry.breakevens)}</dd>
            <dt>
              指定日 + シナリオ
              <span class="note block">
                d = {fmtNum(model.days, 2)} 日、X = {fmtNum(sp.x)}（ΔX {fmtSigned(sp.dXPct, 1)}%）
              </span>
            </dt>
            <dd>
              <Amount v={sp.pnl} unit={u} signed />
              <span class="note block">BEP {fmtXs(model.dateBreakevens)}</span>
            </dd>
            <dt>合計グリーク（シナリオ点）</dt>
            <dd>
              Δ {fmtSigned(g.deltaLarge, 3)} 枚（ミニ {fmtSigned(g.deltaMini, 2)}）、Γ{' '}
              {fmtSigned(g.gammaPer100, 4)} / 100 円、Θ <Amount v={g.thetaPerDay} unit={u} signed />{' '}
              / 日、V <Amount v={g.vegaPerPt} unit={u} signed /> / pt
            </dd>
            <dt>受取 / 支払</dt>
            <dd>
              <Amount v={premium.received} unit={u} /> / <Amount v={premium.paid} unit={u} />
              <span class="note block">
                差引 <Amount v={premium.net} unit={u} signed />
                （OP の手数料込み <Amount v={premium.netAfterFees} unit={u} signed />
                ）、手数料の合計 <Amount v={premium.fees} unit={u} />
              </span>
            </dd>
            {premium.stake !== null && (
              <>
                <dt>掛け金（支払 − 受取 + 手数料）</dt>
                <dd>
                  <Amount v={premium.stake} unit={u} />
                  {premium.multiples.map((m) => (
                    <span class="note block" key={m.n}>
                      利益が掛け金の {m.n} 倍になる原資産（満期）: {fmtXs(m.xs)}
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt>スプレッドコスト / 建値ずれ</dt>
            <dd>
              <Amount v={premium.spreadCost} unit={u} signed /> /{' '}
              <Amount v={premium.entryMismatch} unit={u} signed />
            </dd>
          </dl>
          <details class="metrics-legs">
            <summary>足別（シナリオ点）</summary>
            <ul>
              {sp.legs.map((l, i) => (
                <li key={`${i}-${l.label}`}>
                  {l.label}: IV {l.sigma === null ? DASH : `${fmtIv(l.sigma)}%`}、Δ{' '}
                  {fmtSigned(l.display.deltaLarge, 3)}、Γ {fmtSigned(l.display.gammaPer100, 4)}、Θ{' '}
                  {fmtAmount(l.display.thetaPerDay, u, true)}、V{' '}
                  {fmtAmount(l.display.vegaPerPt, u, true)}
                  {STATE_LABEL[l.state] && <span class="tag">{STATE_LABEL[l.state]}</span>}
                </li>
              ))}
            </ul>
          </details>
          <h3>テール表</h3>
          <table class="tail-table">
            <caption class="note">
              損益（{AMOUNT_UNIT_LABEL[u]}）と倍率 ×|損益 /{' '}
              {tail.premiumBase.kind === 'received' ? '受取超（受取 − 支払）' : '掛け金'}|（基準{' '}
              {fmtAmount(tail.premiumBase.amount, u)}）
            </caption>
            <thead>
              <tr>
                <th scope="col">原資産</th>
                <th scope="col">SQ</th>
                <th scope="col">指定日 + シナリオ</th>
              </tr>
            </thead>
            <tbody>
              {tail.rows.map((r) => (
                <tr key={r.shock}>
                  <th scope="row">
                    {fmtPct(r.shock)}
                    <span class="note block">{fmtNum(r.x)}</span>
                  </th>
                  {(
                    [
                      ['sq', r.sq],
                      ['scenario', r.scenario],
                    ] as const
                  ).map(([col, c]) => (
                    <td key={col} class={c.pnl < 0 ? 'neg' : undefined}>
                      {fmtAmount(c.pnl, u, true)}
                      <span class="note block">{fmtRatio(c.ratio)}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p class="note">
            指定日の列 = d・Δσ・Δs・β・動き方はシナリオのまま、原資産だけを各行の値にして再評価（β
            は行ごとの下落率で IV を上げる）
          </p>
        </>
      )}
    </div>
  );
}

/** 指標。props が変わらなければ描き直さない */
export const Metrics = pure(MetricsView);

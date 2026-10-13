import { useState } from 'preact/hooks';
import type { Side } from '../../model';
import {
  type Action,
  type LegPatch,
  type Parsed,
  parseEntry,
  parseIvPct,
  parseQty,
} from '../state';
import { DASH, fmtIv, fmtNum, fmtSigned } from '../view/format';
import type { PositionModel, PositionRow } from '../view/position';

/** 編集できる数値欄（入力中は下書き、確定（change）で検証して反映。範囲外は反映せずエラー）。 */
function NumField(props: {
  label: string;
  value: string;
  parse: (text: string) => Parsed<LegPatch>;
  onCommit: (patch: LegPatch) => void;
  inputMode?: 'numeric' | 'decimal';
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span class="field">
      <input
        aria-label={props.label}
        inputMode={props.inputMode ?? 'decimal'}
        value={draft ?? props.value}
        aria-invalid={error !== null}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onChange={(e) => {
          const res = props.parse(e.currentTarget.value);
          if (res.ok) {
            setError(null);
            setDraft(null);
            props.onCommit(res.value);
          } else setError(res.message);
        }}
      />
      {error && <span class="field-error">{error}</span>}
    </span>
  );
}

const asPatch =
  <T,>(parse: (t: string) => Parsed<T>, key: keyof LegPatch) =>
  (text: string): Parsed<LegPatch> => {
    const r = parse(text);
    return r.ok ? { ok: true, value: { [key]: r.value } as LegPatch } : r;
  };

const parseQtyPatch = asPatch(parseQty, 'qty');
const parseEntryPatch = asPatch(parseEntry, 'entry');

function LegRow({ row, dispatch }: { row: PositionRow; dispatch: (a: Action) => void }) {
  const edit = (patch: LegPatch) => dispatch({ type: 'editLeg', id: row.id, patch });
  const g = row.greeks;
  const name = row.kind === 'option' ? `${row.optionType} ${fmtNum(row.strike)}` : row.productLabel;
  return (
    <tr class={row.warnings.length > 0 || row.error ? 'warn-row' : undefined}>
      <td data-label="商品">{row.productLabel}</td>
      <td data-label="限月">
        {row.month}
        {row.optionType && (
          <>
            {' '}
            <strong>{name}</strong>
          </>
        )}
      </td>
      <td data-label="売買">
        <select
          aria-label="売買"
          value={row.side}
          onChange={(e) => edit({ side: e.currentTarget.value as Side })}
        >
          <option value="buy">買い</option>
          <option value="sell">売り</option>
        </select>
      </td>
      <td data-label="枚数">
        <NumField
          label="枚数"
          inputMode="numeric"
          value={String(row.qty)}
          parse={parseQtyPatch}
          onCommit={edit}
        />
      </td>
      <td data-label="建値">
        <NumField label="建値" value={String(row.entry)} parse={parseEntryPatch} onCommit={edit} />
      </td>
      <td data-label="IV %">
        {row.kind === 'option' ? (
          <NumField
            label="IV（%）"
            value={fmtIv(row.iv)}
            parse={(t) => {
              // 板の足は空欄で編集の取り消し（建値から IV を求める）。手入力の足は IV が要る
              const r = parseIvPct(t, !row.marks.includes('no_board'));
              return r.ok ? { ok: true, value: { iv: r.value } } : r;
            }}
            onCommit={edit}
          />
        ) : (
          DASH
        )}
        {row.ivEdited && <span class="tag">編集</span>}
      </td>
      <td data-label="Δ ラージ（ミニ）">
        {fmtSigned(g?.deltaLarge, 3)}
        <span class="note">（{fmtSigned(g?.deltaMini, 2)}）</span>
      </td>
      <td data-label="Γ / 100 円">{fmtSigned(g?.gammaPer100, 4)}</td>
      <td data-label="Θ 円 / 日">{fmtSigned(g?.thetaPerDay, 0)}</td>
      <td data-label="V 円 / pt">{fmtSigned(g?.vegaPerPt, 0)}</td>
      <td data-label="建値ずれ 円">
        {row.mismatchYen === null ? DASH : row.mismatchNote ? fmtSigned(row.mismatchYen, 0) : '0'}
        {row.mismatchNote && <span class="note block">{row.mismatchNote}</span>}
      </td>
      <td data-label="SQ 日">
        {row.sqDate}
        {row.calendarUnconfirmed && <span class="tag">休業日未確定</span>}
      </td>
      <td data-label="印">
        {row.markLabels.map((m) => (
          <span class={m === 'IV 不安定' ? 'tag warn' : 'tag'} key={m}>
            {m}
          </span>
        ))}
        {row.warnings.map((w) => (
          <span class="warn block" key={w}>
            {w}
          </span>
        ))}
        {row.error && <span class="warn block">{row.error}</span>}
      </td>
      <td>
        <button
          type="button"
          aria-label={`${row.productLabel} ${row.month} の足を削除`}
          onClick={() => dispatch({ type: 'removeLeg', id: row.id })}
        >
          削除
        </button>
      </td>
    </tr>
  );
}

/** ポジション一覧（足ごとの値は ui/view/position.ts）。 */
export function Positions({
  model,
  dispatch,
}: {
  model: PositionModel | null;
  dispatch: (a: Action) => void;
}) {
  const rows = model?.rows ?? [];
  return (
    <div class="positions">
      <div class="positions-head">
        <h2>ポジション</h2>
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={() => dispatch({ type: 'clearLegs' })}
        >
          全クリア
        </button>
      </div>
      {rows.length === 0 ? (
        <p class="note">板の bid / ask を押すか、下のフォームで足を追加する。</p>
      ) : (
        <table class="positions-table">
          <thead>
            <tr>
              <th>商品</th>
              <th>限月</th>
              <th>売買</th>
              <th>枚数</th>
              <th>建値</th>
              <th>IV %</th>
              <th>Δ ラージ（ミニ）</th>
              <th>Γ / 100 円</th>
              <th>Θ 円 / 日</th>
              <th>V 円 / pt</th>
              <th>建値ずれ 円</th>
              <th>SQ 日</th>
              <th>印</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <LegRow key={r.id} row={r} dispatch={dispatch} />
            ))}
          </tbody>
        </table>
      )}
      <p class="note">
        グリークはシナリオ 0（評価時刻 = 板の時刻、X = 基準価格）。建値ずれ = シナリオ 0
        の理論損益への影響（手数料は含めない）。
      </p>
    </div>
  );
}

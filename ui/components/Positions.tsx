import { useState } from 'preact/hooks';
import {
  type Action,
  type LegPatch,
  type Parsed,
  parseEntry,
  parseIvPct,
  parseQty,
} from '../state';
import { DASH, fmtIv, fmtNum, fmtSigned } from '../view/format';
import {
  legBadges,
  legName,
  legSummary,
  type PositionModel,
  type PositionRow,
  SIDE_LABEL,
  stepQty,
  toggledSide,
} from '../view/position';
import { Hint } from './Hint';

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
  // 開閉は部品の state（key = 足の id。途中の足を消しても他の足の開閉はずれない。保存しない）
  const [open, setOpen] = useState(false);
  const edit = (patch: LegPatch) => dispatch({ type: 'editLeg', id: row.id, patch });
  const g = row.greeks;
  const name = legName(row);
  const detailId = `leg-detail-${row.id}`;
  const dec = stepQty(row.qty, -1);
  const inc = stepQty(row.qty, 1);
  const to = toggledSide(row.side);
  return (
    <li class={row.warnings.length > 0 || row.error ? 'leg-row warn-row' : 'leg-row'}>
      <div class="leg-line">
        <button
          type="button"
          class="leg-toggle"
          aria-expanded={open}
          // 閉じているあいだは詳細が DOM に無いので指さない（レビュー N1）
          aria-controls={open ? detailId : undefined}
          onClick={() => setOpen(!open)}
        >
          <span class="leg-summary">{legSummary(row)}</span>
          {row.kind === 'option' && <span class="note leg-month">{row.month}</span>}
          {legBadges(row).map((b) => (
            <span class={b.warn ? 'tag warn leg-badge' : 'tag leg-badge'} key={b.text}>
              {b.text}
            </span>
          ))}
        </button>
        <span class="leg-ops">
          <button
            type="button"
            aria-label={`${name} の枚数を 1 減らす`}
            disabled={dec === null}
            onClick={() => dec !== null && edit({ qty: dec })}
          >
            −
          </button>
          <button
            type="button"
            aria-label={`${name} の枚数を 1 増やす`}
            disabled={inc === null}
            onClick={() => inc !== null && edit({ qty: inc })}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label={`${name} を${SIDE_LABEL[to]}に切り替え`}
            onClick={() => edit({ side: to })}
          >
            売⇄買
          </button>
          <button
            type="button"
            aria-label={`${name} の足を削除`}
            onClick={() => dispatch({ type: 'removeLeg', id: row.id })}
          >
            ×
          </button>
        </span>
      </div>
      {open && (
        <div class="leg-detail" id={detailId}>
          <div data-label="商品・限月">
            {row.productLabel} {row.month}
            {row.optionType && (
              <>
                {' '}
                <strong>
                  {row.optionType} {fmtNum(row.strike)}
                </strong>
              </>
            )}
          </div>
          <div data-label="売買">{row.sideLabel}</div>
          <div data-label="枚数">
            <NumField
              label={`${name} の枚数`}
              inputMode="numeric"
              value={String(row.qty)}
              parse={parseQtyPatch}
              onCommit={edit}
            />
          </div>
          <div data-label="建値">
            <NumField
              label={`${name} の建値`}
              value={String(row.entry)}
              parse={parseEntryPatch}
              onCommit={edit}
            />
          </div>
          <div data-label="IV %">
            {row.kind === 'option' ? (
              <NumField
                label={`${name} の IV（%）`}
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
          </div>
          <div data-label="Δ ラージ（ミニ）">
            {fmtSigned(g?.deltaLarge, 3)}
            <span class="note">（{fmtSigned(g?.deltaMini, 2)}）</span>
          </div>
          <div data-label="Γ / 100 円">{fmtSigned(g?.gammaPer100, 4)}</div>
          <div data-label="Θ 円 / 日">{fmtSigned(g?.thetaPerDay, 0)}</div>
          <div data-label="V 円 / pt">{fmtSigned(g?.vegaPerPt, 0)}</div>
          <div data-label="建値ずれ 円">
            {row.mismatchYen === null
              ? DASH
              : row.mismatchNote
                ? fmtSigned(row.mismatchYen, 0)
                : '0'}
            {row.mismatchNote && <span class="note block">{row.mismatchNote}</span>}
          </div>
          <div data-label="SQ 日">
            {row.sqDate}
            {row.calendarUnconfirmed && <span class="tag">休業日未確定</span>}
          </div>
          {(row.markLabels.length > 0 || row.warnings.length > 0 || row.error) && (
            <div data-label="印" class="leg-marks">
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
            </div>
          )}
        </div>
      )}
    </li>
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
      <div class="positions-head hint-host">
        <h2>ポジション</h2>
        <Hint label="ポジションのグリークと建値ずれ">
          グリークはシナリオ 0（評価時刻 = 板の時刻、X = 基準価格）。建値ずれ = シナリオ 0
          の理論損益への影響（手数料は含めない）。
        </Hint>
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
        <ul class="leg-list">
          {rows.map((r) => (
            <LegRow key={r.id} row={r} dispatch={dispatch} />
          ))}
        </ul>
      )}
    </div>
  );
}

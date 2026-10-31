import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../../components/useAppController';
import type { State } from '../../state';
import { fmtNum } from '../../view/format';
import { newTabUndoActions } from '../../view/newTab';
import {
  DIST_OPTIONS,
  DIST_SPECS,
  initialShapeForm,
  N_SPEC,
  QTY_SPEC,
  SHAPE_NEW_TAB_UNDO_TEXT,
  SHAPE_PICK_TEXT,
  SHAPES_TITLE,
  type ShapeCard,
  type ShapeForm,
  shapeApplyPlan,
  shapeCard,
  shapeList,
  WING_SPEC,
} from '../../view/shapes';
import type { DistKind, ShapeId } from '../../view/templates';
import type { ToastInput } from '../../view/toast';
import { Dialog } from '../parts/Dialog';
import { Seg } from '../parts/Seg';
import { Stepper } from '../parts/Stepper';
import { focusIfLost } from '../useGlobalKeys';

/** 開く要求（形 = パレットの「形: …」、null = 一覧だけ） */
export interface ShapeOpen {
  shape: ShapeId | null;
}

interface Props {
  open: ShapeOpen | null;
  onClose: () => void;
  c: AppController;
  /** 押した時点の state（[このタブに足す] の前の足・[元に戻す] の判定） */
  getState: () => State;
  push: (t: ToastInput) => void;
  /** 足した最初の足を選ぶ（ポジションを見せる） */
  onPick: (id: number) => void;
}

/**
 * 形の一覧（#20。docs/ui-redesign.md「形の一覧」・docs/design.md M7・AC9）: 1 つのダイアログの中で一覧（売り / 買い）→
 * 形のカード（限月・距離・翼・枚数、今の板で組んだ足と値）→ [このタブに足す] / [新しいタブに入れる]。中に層を重ねない
 * （形を押すとカードが替わる。戻る 1 回で閉じる = Dialog の層）。表示モデルは ui/view/shapes.ts、入力はここのローカル
 * （保存しない）。適用は既存の action だけ（replaceLegs / openPositionInNewTab）。
 */
export function ShapeDialog(p: Props) {
  if (p.open === null) return null;
  return <ShapeDialogBody {...p} init={p.open.shape} />;
}

const fmtSigma = (v: number) => `${fmtNum(v, 2)}σ`;
const fmtDelta = (v: number) => fmtNum(v, 2);
const fmtYen = (v: number) => `${fmtNum(v, 0)} 円`;
const fmtN = (v: number) => (v > 0 ? `+${v} 本` : `${v} 本`);
const fmtWing = (v: number) => `${fmtNum(v, Number.isInteger(v) ? 0 : 1)}%`;
const fmtQty = (v: number) => `${fmtNum(v, 0)} 枚`;
const DIST_FMT: Readonly<Record<DistKind, (v: number) => string>> = {
  sigma: fmtSigma,
  delta: fmtDelta,
  yen: fmtYen,
};
const DIST_LABEL: Readonly<Record<DistKind, string>> = {
  sigma: 'σ の倍率',
  delta: '|Δ|',
  yen: '基準価格からの円',
};

function ShapeDialogBody(p: Props & { init: ShapeId | null }) {
  const { c, push } = p;
  const { state } = c;
  const [form, setForm] = useState<ShapeForm>(() => initialShapeForm(p.init));
  const set = (patch: Partial<ShapeForm>) => setForm((f) => ({ ...f, ...patch }));
  const groups = useMemo(() => shapeList(), []);
  const card = useMemo(
    () =>
      shapeCard(
        {
          chain: state.chain,
          basis: c.atmBasis,
          legs: c.curLegs,
          calendar: state.calendar,
          feePerLot: state.feePerLot,
          futureBasis: state.futureBasis,
          unit: state.metricsUnit,
          nowScenario: c.nowScenario,
          params: c.marginParams,
          capital: c.capital,
          canAddTab: c.tabsView.canAdd,
        },
        form,
      ),
    [
      state.chain,
      c.atmBasis,
      c.curLegs,
      state.calendar,
      state.feePerLot,
      state.futureBasis,
      state.metricsUnit,
      c.nowScenario,
      c.marginParams,
      c.capital,
      c.tabsView.canAdd,
      form,
    ],
  );

  // 形を選んだらカードの見出しを .sheet-body の中で見える位置へ（scrollIntoView は外側まで動かしうるので使わない）
  const cardRef = useRef<HTMLElement>(null);
  const shapeId = form.shape;
  useLayoutEffect(() => {
    if (shapeId === null) return;
    const el = cardRef.current;
    const body = el?.closest('.sheet-body');
    if (!el || !(body instanceof HTMLElement)) return;
    const vb = body.getBoundingClientRect();
    const rb = el.getBoundingClientRect();
    if (rb.top >= vb.top && rb.top + Math.min(rb.height, 160) <= vb.bottom) return;
    body.scrollTop += rb.top - vb.top;
  }, [shapeId]);

  const apply = (target: 'current' | 'new_tab') => {
    if (!card || form.shape === null) return;
    const plan = shapeApplyPlan(p.getState(), form.shape, card.legs, target);
    if (!plan) return;
    c.dispatch(plan.action);
    p.onClose();
    if (plan.pickId !== null) {
      p.onPick(plan.pickId);
      // 空の欄から開いた（開いたボタンが消えた）・新しいタブ（ポジションを作り直す）ならフォーカスは足した最初の足の行へ
      focusIfLost(`section.positions li.leg[data-leg-id="${plan.pickId}"] .leg-main`);
    }
    if (plan.target === 'current') {
      const undo = plan.undo;
      push({ kind: 'shape-add', text: plan.text, undo: () => c.dispatch(undo) });
      return;
    }
    const undo = plan.undo;
    push({
      kind: 'shape-add',
      text: plan.text,
      keep: true,
      undo: () => {
        // 押したときのタブに戻り、足したタブだけを閉じる。編集していたら戻さない（AI の提案と同じ）
        const acts = newTabUndoActions(p.getState(), undo);
        if (typeof acts === 'string') {
          push({ kind: 'shape-add', text: SHAPE_NEW_TAB_UNDO_TEXT[acts], note: 'info' });
          return;
        }
        for (const a of acts) c.dispatch(a);
      },
    });
  };

  return (
    <Dialog open title={SHAPES_TITLE} class="shapes" onClose={p.onClose}>
      <div class="shape-list">
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白の癖があるので div + role="group"（Seg と同じ）
          <div class="shape-group" role="group" aria-label={g.label} key={g.group}>
            <h3 class="shape-gh">{g.title}</h3>
            {g.items.map((it) => (
              <button
                type="button"
                class="shape-item"
                key={it.id}
                data-shape={it.id}
                aria-pressed={form.shape === it.id}
                aria-label={it.aria}
                onClick={() => set({ shape: it.id })}
              >
                <span class="shape-name">{it.name}</span>
                <span class="shape-sub">
                  <svg class="shape-fig" viewBox="0 0 32 16" aria-hidden="true">
                    <line class="zero" x1="0" y1="8" x2="32" y2="8" />
                    <polyline points={it.points} />
                  </svg>
                  <span class="shape-note">{it.note}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {card ? (
        <CardView card={card} form={form} set={set} cardRef={cardRef} apply={apply} />
      ) : (
        <p class="shape-empty">{SHAPE_PICK_TEXT}</p>
      )}
    </Dialog>
  );
}

function CardView(p: {
  card: ShapeCard;
  form: ShapeForm;
  set: (patch: Partial<ShapeForm>) => void;
  cardRef: { current: HTMLElement | null };
  apply: (target: 'current' | 'new_tab') => void;
}) {
  const { card, form, set } = p;
  const { shape } = card;
  const distValue = form[form.dist];
  return (
    <section class="shape-card" ref={p.cardRef} aria-label={`${shape.name} のカード`}>
      <h3 class="shape-title">{shape.name}</h3>
      <p class="shape-desc">{shape.note}</p>
      <div class="shape-fields">
        {card.months.length > 0 && (
          <div class="shape-fld">
            <span class="lab">限月</span>
            <Seg
              label="限月"
              value={card.month}
              options={card.months}
              onChange={(month) => set({ month })}
            />
          </div>
        )}
        {shape.place === 'otm' ? (
          <div class="shape-fld">
            <span class="lab">距離</span>
            <span class="ctl">
              <Seg<DistKind>
                label="距離の選び方"
                value={form.dist}
                options={DIST_OPTIONS}
                onChange={(dist) => set({ dist })}
              />
              <Stepper
                name="dist"
                label={DIST_LABEL[form.dist]}
                spec={DIST_SPECS[form.dist]}
                value={distValue}
                format={DIST_FMT[form.dist]}
                onChange={(v) =>
                  set(
                    form.dist === 'sigma'
                      ? { sigma: v }
                      : form.dist === 'delta'
                        ? { delta: v }
                        : { yen: v },
                  )
                }
              />
            </span>
          </div>
        ) : (
          <div class="shape-fld">
            <span class="lab">ATM から</span>
            <Stepper
              name="n"
              label="ATM から何本ずらすか"
              spec={N_SPEC}
              value={form.n}
              format={fmtN}
              onChange={(n) => set({ n })}
            />
          </div>
        )}
        {shape.wing && (
          <div class="shape-fld">
            <span class="lab">翼の幅</span>
            <Stepper
              name="wing"
              label="翼の幅（%）"
              spec={WING_SPEC}
              value={form.wingPct}
              format={fmtWing}
              onChange={(wingPct) => set({ wingPct })}
            />
          </div>
        )}
        <div class="shape-fld">
          <span class="lab">枚数</span>
          <Stepper
            name="qty"
            label="枚数"
            spec={QTY_SPEC}
            value={form.qty}
            format={fmtQty}
            onChange={(qty) => set({ qty })}
          />
        </div>
      </div>
      {card.reason !== null ? (
        <p class="shape-why warn" role="status">
          {card.reason}
        </p>
      ) : (
        <>
          <ul class="shape-legs" aria-label="組んだ足">
            {card.rows.map((r) => (
              <li key={r.key}>
                <span class="side" data-side={r.side}>
                  {r.badge}
                </span>
                <span class="txt">{r.body}</span>
              </li>
            ))}
          </ul>
          <div class="shape-vals">
            {card.values.map((v) => (
              <div class="shape-kv" key={v.key} data-key={v.key}>
                <span class="k">{v.k}</span>
                <span class="v">
                  {/* 値と単位は別の span（字の大きさが違う行の上端のずれを折り返しと数えない） */}
                  <span class="n">{v.v}</span>
                  {v.unit && <span class="u">{v.unit}</span>}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div class="shape-acts">
        <button
          type="button"
          class="btn"
          data-act="new_tab"
          disabled={!card.canNewTab}
          title={card.newTabTitle}
          onClick={() => p.apply('new_tab')}
        >
          新しいタブに入れる
        </button>
        <button
          type="button"
          class="btn primary"
          data-act="current"
          disabled={!card.canApply}
          title={card.applyTitle}
          onClick={() => p.apply('current')}
        >
          このタブに足す
        </button>
      </div>
    </section>
  );
}

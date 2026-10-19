import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../../components/useAppController';
import { type LegPatch, type Parsed, parseEntry, parseIvPct, parseQty } from '../../state';
import { fmtNum } from '../../view/format';
import { HINT_TERMS } from '../../view/glossary';
import type { HedgeAt } from '../../view/hedge';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { type PositionRow, SIDE_LABEL, toggledSide } from '../../view/position';
import {
  type DetailItem,
  flipToast,
  HEDGE_AT_OPTIONS,
  type HedgeSectionView,
  headSub,
  hedgeSection,
  type LegDetailView,
  type LegRowView,
  legDetail,
  legSpreadCosts,
  openBoardActions,
  positionRows,
  qtySpec,
  removeUndo,
  revealScrollTop,
  scenarioLegsByRow,
  type UndoToast,
} from '../../view/positionsRegion';
import type { ShellAction, Tier } from '../../view/shell';
import type { ToastInput } from '../../view/toast';
import { PanelHead } from '../PanelHead';
import { Menu, type MenuItem } from '../parts/Menu';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { Stepper } from '../parts/Stepper';
import { TermLinks } from '../parts/TermLinks';
import { HedgeDialog } from './HedgeDialog';
import { LegDialog } from './LegDialog';

interface Props {
  c: AppController;
  tier: Tier;
  send: (a: ShellAction) => void;
  /** 舞台で選んだ足（#82。NextApp のローカル） */
  selectedLeg: number | null;
  /** 行の詳細を開いたらその足を舞台でも選ぶ */
  onSelectLeg: (id: number) => void;
  push: (t: ToastInput) => void;
  /** 全クリア（#87 (C): トップの ⋯ と同じ処理 = NextApp。[元に戻す] 付きのトースト） */
  onClear: () => void;
}

const fmtQty = (v: number) => fmtNum(v);

/**
 * ポジション（docs/ui-redesign.md §2・§3・§4.4・§5・§9。#84）: 見出し行（副題・ⓘ・⋯）→ 足 1 本 1 行（本文 / 枚数 / ⇄ ×、
 * 本文を押すと詳細）→ デルタヘッジの節。足の追加・ヘッジの設定はダイアログ。表示モデルは ui/view/positionsRegion.ts、
 * 状態は既存の action だけ。行の開閉・入力の下書き・ダイアログはここのローカル（保存しない。NextApp が key = 作業中のタブ）。
 */
export function Positions(p: Props) {
  const { c, push, selectedLeg } = p;
  const { state, dispatch, positions: model, pnlBase, metrics, hedgeView, settings } = c;
  const rows = useMemo(() => (model ? positionRows(model) : []), [model]);
  const scen = useMemo(
    () => (model ? scenarioLegsByRow(model, pnlBase, metrics) : []),
    [model, pnlBase, metrics],
  );
  const spreads = useMemo(() => (model ? legSpreadCosts(model, settings) : []), [model, settings]);
  const hedge = useMemo(() => (hedgeView ? hedgeSection(hedgeView) : null), [hedgeView]);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [dialog, setDialog] = useState<'leg' | 'hedge' | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hasChain = state.chain !== null;

  // 舞台で選んだ足の行を .panel-body の中で見える位置へ（scrollIntoView は overflow: hidden の親まで動かしうるので使わない）
  useLayoutEffect(() => {
    if (selectedLeg === null) return;
    const body = bodyRef.current;
    const li = body?.querySelector(`li.leg[data-leg-id="${selectedLeg}"]`);
    if (!body || !(li instanceof HTMLElement)) return;
    const vb = body.getBoundingClientRect();
    const rb = li.getBoundingClientRect();
    const top = revealScrollTop(rb.top, rb.bottom, vb.top, vb.bottom, body.scrollTop);
    if (top !== body.scrollTop) body.scrollTop = top;
  }, [selectedLeg]);

  const undoToast = (u: UndoToast): ToastInput => ({
    kind: u.kind,
    text: u.text,
    undo: () => {
      for (const a of u.undo) dispatch(a);
    },
  });
  const onRemove = (row: PositionRow) => {
    const u = removeUndo(state, row);
    dispatch({ type: 'removeLeg', id: row.id });
    if (open.has(row.id)) {
      const next = new Set(open);
      next.delete(row.id);
      setOpen(next);
    }
    if (u) push(undoToast(u));
  };
  const onClear = () => {
    p.onClear();
    setOpen(new Set());
  };
  // 足が 0 本になったら開いた行の集合を空にする（トップの ⋯ の全クリアの後の [元に戻す] で行が開いたまま戻らない）
  const empty = rows.length === 0;
  useEffect(() => {
    if (empty) setOpen((o) => (o.size === 0 ? o : new Set()));
  }, [empty]);
  const onFlip = (row: PositionRow) => {
    dispatch({ type: 'editLeg', id: row.id, patch: { side: toggledSide(row.side) } });
    push(flipToast(row));
  };
  const onToggle = (id: number) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      p.onSelectLeg(id);
    }
    setOpen(next);
  };

  const items: MenuItem[] = [
    { key: 'clear', label: '全クリア', disabled: rows.length === 0, onSelect: onClear },
    { key: 'add', label: '足を追加…', disabled: !hasChain, onSelect: () => setDialog('leg') },
    {
      key: 'hedge',
      label: 'ヘッジの設定…',
      disabled: hedgeView === null,
      onSelect: () => setDialog('hedge'),
    },
  ];

  return (
    <>
      <PanelHead title="ポジション" sub={headSub(rows.length, metrics)}>
        <Popover label="ポジションのグリークと建値ずれ" button="ⓘ">
          <p>
            グリークはシナリオ 0（評価時刻 = 板の時刻、X = 基準価格）。建値ずれ = シナリオ 0
            の理論損益への影響（手数料は含めない）。
          </p>
          <p>
            詳細の「シナリオ点（足別）」は指標と同じシナリオ点（d・ΔX・Δσ・Δs を入れた点）の足ごとの
            IV・グリーク・状態（Θ・V は指標の単位）。スプレッドコスト = 建値と足を入れたときの板の
            mid の差 × 枚数 × 乗数（不利な側が +。mid の無い足は —）。
          </p>
          <TermLinks ids={HINT_TERMS.positions} />
        </Popover>
        <Menu label="ポジションの操作" button="⋯" items={items} />
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div
        class="panel-body pos-body"
        ref={bodyRef}
        tabIndex={-1}
        role="group"
        aria-label={PANEL_FOCUS_LABEL.positions}
      >
        {rows.length === 0 ? (
          <div class="empty-state">
            <p>板の bid（売り）/ ask（買い）を押すか、⋯ の「足を追加…」で足を入れる</p>
            <div class="acts">
              <button
                type="button"
                class="btn sm"
                onClick={() => {
                  for (const a of openBoardActions(p.tier)) p.send(a);
                }}
              >
                板を開く
              </button>
              <button
                type="button"
                class="btn sm"
                disabled={!hasChain}
                onClick={() => setDialog('leg')}
              >
                足を追加…
              </button>
            </div>
          </div>
        ) : (
          <ul class="legs">
            {rows.map((r, i) => {
              const row = model?.rows[i];
              if (!row) return null;
              const isOpen = open.has(r.id);
              return (
                <LegItem
                  key={r.id}
                  view={r}
                  row={row}
                  open={isOpen}
                  selected={selectedLeg === r.id}
                  detail={
                    isOpen
                      ? legDetail(row, scen[i] ?? null, spreads[i] ?? null, metrics.unit)
                      : null
                  }
                  onToggle={() => onToggle(r.id)}
                  onQty={(qty) => dispatch({ type: 'editLeg', id: r.id, patch: { qty } })}
                  onEdit={(patch) => dispatch({ type: 'editLeg', id: r.id, patch })}
                  onFlip={() => onFlip(row)}
                  onRemove={() => onRemove(row)}
                />
              );
            })}
          </ul>
        )}
        {hedge && hedgeView && (
          <HedgeSection
            view={hedge}
            at={hedgeView.at}
            onAt={(at) => dispatch({ type: 'setHedge', patch: { at } })}
            onAdd={(i) => {
              const l = hedge.lines[i];
              if (!l?.canAdd || !l.input) return;
              dispatch({ type: 'addFutureLeg', input: l.input });
              if (l.toast) push({ kind: 'leg-add', text: l.toast });
            }}
          />
        )}
      </div>
      <LegDialog
        open={dialog === 'leg'}
        onClose={() => setDialog(null)}
        chain={state.chain}
        holidays={state.calendar.holidays}
        dispatch={dispatch}
        push={push}
      />
      {hedgeView && (
        <HedgeDialog
          open={dialog === 'hedge'}
          onClose={() => setDialog(null)}
          model={hedgeView}
          dispatch={dispatch}
        />
      )}
    </>
  );
}

function LegItem(p: {
  view: LegRowView;
  row: PositionRow;
  open: boolean;
  selected: boolean;
  detail: LegDetailView | null;
  onToggle: () => void;
  onQty: (qty: number) => void;
  onEdit: (patch: LegPatch) => void;
  onFlip: () => void;
  onRemove: () => void;
}) {
  const { view: v, row } = p;
  const detailId = `pos-leg-detail-${v.id}`;
  const to = toggledSide(v.side);
  return (
    <li
      class={v.warn ? 'leg warn' : 'leg'}
      data-leg-id={v.id}
      data-selected={p.selected ? '' : undefined}
    >
      <div class="leg-row">
        <button
          type="button"
          class="leg-main"
          aria-label={v.aria}
          aria-expanded={p.open}
          aria-controls={p.open ? detailId : undefined}
          onClick={p.onToggle}
        >
          <span class="leg-title">
            <span class="side" data-side={v.side}>
              {v.badge}
            </span>
            <span class="name">{v.title}</span>
            <span class="px">{v.entry}</span>
          </span>
          <span class="leg-sub">
            <span>{v.sub.month}</span>
            {v.sub.iv !== null && <span>IV {v.sub.iv}</span>}
            <span>Δ {v.sub.delta}</span>
            {v.badges.map((b) => (
              <span class={b.warn ? 'tag warn' : 'tag'} key={b.text}>
                {b.text}
              </span>
            ))}
          </span>
        </button>
        <Stepper
          name="qty"
          label={`${v.name} の枚数`}
          spec={qtySpec(row.qty)}
          value={row.qty}
          format={fmtQty}
          onChange={p.onQty}
        />
        <span class="ops">
          <button
            type="button"
            class="btn ghost icon sm"
            data-op="flip"
            title="売⇄買"
            aria-label={`${v.name} を${SIDE_LABEL[to]}に切り替え`}
            onClick={p.onFlip}
          >
            ⇄
          </button>
          <button
            type="button"
            class="btn ghost icon sm"
            data-op="remove"
            title="削除"
            aria-label={`${v.name} の足を削除`}
            onClick={p.onRemove}
          >
            ×
          </button>
        </span>
      </div>
      {p.detail && <LegDetail id={detailId} name={v.name} detail={p.detail} onEdit={p.onEdit} />}
    </li>
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

function LegDetail(p: {
  id: string;
  name: string;
  detail: LegDetailView;
  onEdit: (patch: LegPatch) => void;
}) {
  const { detail: d, name } = p;
  const field = (it: DetailItem) => {
    switch (it.field) {
      case 'qty':
        return (
          <DetailField
            label={`${name} の枚数を入力`}
            value={it.value}
            inputMode="numeric"
            parse={parseQtyPatch}
            onCommit={p.onEdit}
          />
        );
      case 'entry':
        return (
          <DetailField
            label={`${name} の建値`}
            value={it.value}
            parse={parseEntryPatch}
            onCommit={p.onEdit}
          />
        );
      case 'iv':
        return (
          <DetailField
            label={`${name} の IV（%）`}
            value={it.value}
            parse={(t) => {
              // 板の足は空欄で編集の取り消し（建値から IV を求める）。手入力の足は IV が要る
              const r = parseIvPct(t, !d.ivRequired);
              return r.ok ? { ok: true, value: { iv: r.value } } : r;
            }}
            onCommit={p.onEdit}
          />
        );
      default:
        return it.value;
    }
  };
  const kv = (it: DetailItem) => (
    <div class={it.note ? 'kv wide' : 'kv'} key={it.key} data-key={it.key}>
      <span class="k">{it.label}</span>
      <span class="v">
        {field(it)}
        {it.tag && <span class="tag">{it.tag}</span>}
      </span>
      {it.note && <p class="note">{it.note}</p>}
    </div>
  );
  return (
    <div class="leg-detail" id={p.id}>
      <div class="kvs">{d.items.map(kv)}</div>
      <h4 class="kv-head">シナリオ点（足別）</h4>
      <div class="kvs">{d.scenario.map(kv)}</div>
      {d.marks.length > 0 && (
        <div class="flags">
          {d.marks.map((m) => (
            <p class={m.warn ? 'warn' : undefined} key={m.text}>
              {m.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 詳細の数値欄（入力中は下書き、確定（change）で検証して反映。外れたら反映せず文言。旧 Positions の NumField と同じ規則） */
function DetailField(p: {
  label: string;
  value: string;
  parse: (text: string) => Parsed<LegPatch>;
  onCommit: (patch: LegPatch) => void;
  inputMode?: 'numeric' | 'decimal';
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <span class="fld-in">
      <input
        class="input"
        type="text"
        aria-label={p.label}
        inputMode={p.inputMode ?? 'decimal'}
        value={draft ?? p.value}
        aria-invalid={error !== null ? 'true' : 'false'}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onChange={(e) => {
          const res = p.parse(e.currentTarget.value);
          if (res.ok) {
            setError(null);
            setDraft(null);
            p.onCommit(res.value);
          } else setError(res.message);
        }}
      />
      {error && (
        <p class="field-err" role="alert">
          {error}
        </p>
      )}
    </span>
  );
}

function HedgeSection(p: {
  view: HedgeSectionView;
  at: HedgeAt;
  onAt: (at: HedgeAt) => void;
  onAdd: (i: number) => void;
}) {
  const { view } = p;
  return (
    <section class="sec hedge-sec" aria-label="デルタヘッジ">
      <div class="sec-head">
        <h3>デルタヘッジ</h3>
        <span class="spacer" />
        <Seg<HedgeAt> label="評価点" value={p.at} options={HEDGE_AT_OPTIONS} onChange={p.onAt} />
      </div>
      <div class="hedge">
        <div class="hl head">{view.head}</div>
        {view.common !== null ? (
          <p class="warn">{view.common}</p>
        ) : (
          view.lines.map((l, i) => (
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
                onClick={() => p.onAdd(i)}
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
    </section>
  );
}

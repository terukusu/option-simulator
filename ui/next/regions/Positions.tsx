import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../../components/useAppController';
import { type LegPatch, type Parsed, parseEntry, parseIvPct, parseQty } from '../../state';
import { fmtNum } from '../../view/format';
import { HINT_TERMS } from '../../view/glossary';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { type OptTarget, optLtdOf, optOpenLabel, optTargetOfLeg } from '../../view/optHistory';
import { type PositionRow, SIDE_LABEL, toggledSide } from '../../view/position';
import {
  type DetailItem,
  EMPTY_LEGS_TEXT,
  flipToast,
  type GreekLine,
  type HedgeLineView,
  type HedgeSummaryView,
  headSub,
  hedgeSummary,
  type LegDetailView,
  type LegRowView,
  legDetail,
  legFairValue,
  legSpreadCosts,
  MANUAL_ADD_SHORT,
  PICK_LABEL,
  positionRows,
  qtySpec,
  removeUndo,
  revealScrollTop,
  scenarioLegsByRow,
  type UndoToast,
} from '../../view/positionsRegion';
import { SHAPES_LABEL } from '../../view/shapes';
import type { ToastInput } from '../../view/toast';
import {
  clearBlockedText,
  NO_CHAIN_TEXT,
  rebaseBlockedText,
  rebaseLabel,
} from '../../view/topMenu';
import { PanelHead } from '../PanelHead';
import { Icon } from '../parts/Icon';
import { ManualLinks } from '../parts/ManualLinks';
import { Menu, type MenuItem } from '../parts/Menu';
import { Popover } from '../parts/Popover';
import { Stepper } from '../parts/Stepper';
import { TermLinks } from '../parts/TermLinks';
import { HedgeDialog } from './HedgeDialog';
import { LegDialog } from './LegDialog';

interface Props {
  c: AppController;
  /**
   * 板から追加（#325。NextApp = パレットと同じ）: スマホ・タブレットは板のパネルと帯（bid / ask で 1 本入ったら
   * ポジションへ戻る）、PC は市場の列を板に
   */
  onPickBoard: () => void;
  /** 舞台で選んだ足（#82。NextApp のローカル） */
  selectedLeg: number | null;
  /** 行の詳細を開いたらその足を舞台でも選ぶ */
  onSelectLeg: (id: number) => void;
  push: (t: ToastInput) => void;
  /** 全クリア（#87 (C)。処理は NextApp = パレットと同じ。[元に戻す] 付きのトースト。#275 でトップの ⋯ から外した） */
  onClear: () => void;
  /** 建値を今の板に合わせる（#298。処理は NextApp = パレットと同じ。[元に戻す] 付きのトースト） */
  onRebase: () => void;
  /** 形から組む（#20。形の一覧のダイアログは NextApp = パレットの「形: …」と同じ） */
  onShapes: () => void;
  /** 銘柄の推移を開く（#319。足の詳細の [推移]。from = 閉じたときにフォーカスを戻すボタン） */
  onOptChart?: (target: OptTarget, from: HTMLElement | null) => void;
}

const fmtQty = (v: number) => fmtNum(v);

/**
 * ポジション（docs/ui-redesign.md §2・§3・§4.4・§5・§9。#84）: 見出し行（副題・ⓘ・⋯）→ 足 1 本 1 行（本文 / 枚数 / ⇄ ×、
 * 本文を押すと詳細）→ デルタヘッジの 1 行（#274。足 0 本は出さない。[⋯] でヘッジのダイアログ = 評価点・ミニ / ラージ・
 * 注記・目標・限月）。足の追加・ヘッジはダイアログ。表示モデルは ui/view/positionsRegion.ts、
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
  const hedge = useMemo(
    () => (hedgeView ? hedgeSummary(hedgeView, rows.length) : null),
    [hedgeView, rows.length],
  );
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
  // 足が 0 本になったら開いた行の集合を空にする（パレットの全クリアの後の [元に戻す] で行が開いたまま戻らない）
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

  const onHedgeAdd = (l: HedgeLineView) => {
    if (!l.canAdd || !l.input) return;
    dispatch({ type: 'addFutureLeg', input: l.input });
    if (l.toast) push({ kind: 'leg-add', text: l.toast });
  };

  // 保有のタブ（#301）: 全クリアは押せない・建て直しは写し（パレットと同じ関数）
  const { held } = c.tabsView.active;
  const rebaseBlocked = rebaseBlockedText(hasChain, c.curLegs.length, held, c.tabsView.canAdd);
  const clearBlocked = clearBlockedText(c.curLegs.length, held);
  // 並びは足す操作が先・消す操作が最後（#325）。「板から追加」は見出しのボタンにあるので置かない（同じ機能の入口は 1 本）
  const items: MenuItem[] = [
    {
      key: 'shapes',
      label: SHAPES_LABEL,
      disabled: !hasChain,
      ...(hasChain ? {} : { title: NO_CHAIN_TEXT }),
      onSelect: p.onShapes,
    },
    {
      key: 'add',
      label: '手入力で足を追加…',
      disabled: !hasChain,
      ...(hasChain ? {} : { title: NO_CHAIN_TEXT }),
      onSelect: () => setDialog('leg'),
    },
    {
      key: 'hedge',
      label: 'デルタヘッジ…',
      disabled: hedgeView === null,
      onSelect: () => setDialog('hedge'),
    },
    {
      key: 'rebase',
      label: rebaseLabel(held),
      disabled: rebaseBlocked !== null,
      ...(rebaseBlocked === null ? {} : { title: rebaseBlocked }),
      onSelect: p.onRebase,
    },
    // 足の本数で決める（板が読めず行が無いときも消せる = #275 でトップの ⋯ の全クリアを外したため）
    {
      key: 'clear',
      label: '全クリア',
      disabled: clearBlocked !== null,
      ...(clearBlocked === null ? {} : { title: clearBlocked }),
      onSelect: onClear,
    },
  ];
  // [＋ 板から追加]（見出し・空の欄で同じ。板が無ければ押せない = 手入力と同じ条件）
  const pickButton = (cls: string) => (
    <button
      type="button"
      class={cls}
      disabled={!hasChain}
      title={hasChain ? undefined : NO_CHAIN_TEXT}
      onClick={p.onPickBoard}
    >
      <Icon name="plus" />
      {/* 文字は span に（アイコンと文字の行の上端が丸めで 1px ずれても折り返しと数えない） */}
      <span>{PICK_LABEL}</span>
    </button>
  );

  return (
    <>
      <PanelHead title="ポジション" sub={headSub(rows.length)}>
        <Popover label="ポジションのグリークと建値ずれ" button={<Icon name="info" />}>
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
          <ManualLinks place="positions" />
        </Popover>
        {pickButton('btn sm pick-btn')}
        <Menu label="ポジションの操作" button={<Icon name="more" />} items={items} />
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
            <p>{EMPTY_LEGS_TEXT}</p>
            <div class="acts">
              {pickButton('btn sm')}
              <button
                type="button"
                class="btn sm"
                disabled={!hasChain}
                title={hasChain ? undefined : NO_CHAIN_TEXT}
                onClick={p.onShapes}
              >
                {SHAPES_LABEL}
              </button>
              <button
                type="button"
                class="btn sm"
                disabled={!hasChain}
                title={hasChain ? undefined : NO_CHAIN_TEXT}
                onClick={() => setDialog('leg')}
              >
                {MANUAL_ADD_SHORT}
              </button>
            </div>
          </div>
        ) : (
          <ul class="legs">
            {rows.map((r, i) => {
              const row = model?.rows[i];
              if (!row) return null;
              const isOpen = open.has(r.id);
              // 推移（#319）はラージの OP の足で、取引最終日が求められるときだけ
              const opt =
                isOpen && p.onOptChart
                  ? optTargetOfLeg(row, (m) =>
                      optLtdOf(m, state.chain?.months ?? [], state.calendar.holidays),
                    )
                  : null;
              return (
                <LegItem
                  key={r.id}
                  view={r}
                  row={row}
                  open={isOpen}
                  selected={selectedLeg === r.id}
                  detail={
                    isOpen
                      ? legDetail(
                          row,
                          scen[i] ?? null,
                          spreads[i] ?? null,
                          metrics.unit,
                          legFairValue(state.chain, row),
                        )
                      : null
                  }
                  opt={opt}
                  onOpt={p.onOptChart ?? null}
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
        {hedge && <HedgeRow view={hedge} onAdd={onHedgeAdd} onMore={() => setDialog('hedge')} />}
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
          onAdd={onHedgeAdd}
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
  /** 推移で開く銘柄（#319。出さない足は null） */
  opt: OptTarget | null;
  onOpt: ((target: OptTarget, from: HTMLElement | null) => void) | null;
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
            <Icon name="swap" />
          </button>
          <button
            type="button"
            class="btn ghost icon sm"
            data-op="remove"
            title="削除"
            aria-label={`${v.name} の足を削除`}
            onClick={p.onRemove}
          >
            <Icon name="close" />
          </button>
        </span>
      </div>
      {p.detail && (
        <LegDetail
          id={detailId}
          name={v.name}
          detail={p.detail}
          onEdit={p.onEdit}
          opt={p.opt && p.onOpt ? { target: p.opt, open: p.onOpt } : null}
        />
      )}
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
  /** 銘柄の推移（#319。ラージの OP の足だけ） */
  opt: { target: OptTarget; open: (target: OptTarget, from: HTMLElement | null) => void } | null;
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
      <div class="kvs fields">{d.fields.map(kv)}</div>
      <GreekRow line={d.greeks} />
      <GreekRow line={d.scenario} />
      <div class="kvs">{d.items.map(kv)}</div>
      {p.opt && (
        <p class="leg-opt">
          <button
            type="button"
            class="btn sm"
            data-op="opt-chart"
            aria-label={optOpenLabel(p.opt.target.month, p.opt.target.k, p.opt.target.type)}
            onClick={(e) => p.opt?.open(p.opt.target, e.currentTarget)}
          >
            <Icon name="chart" />
            推移
          </button>
        </p>
      )}
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

/** グリークの 1 行（#274。項目の境目でだけ折り返す。区切りの「·」は CSS） */
function GreekRow({ line }: { line: GreekLine }) {
  return (
    <div class="gline">
      <span class="k">{line.head}</span>
      <span class="v">
        {line.parts.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </span>
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

/**
 * デルタヘッジの常設の 1 行（#274）: 要約の文 + ミニの [追加] + [⋯]（ヘッジのダイアログ）。共通の理由があれば [追加] なし
 */
function HedgeRow(p: {
  view: HedgeSummaryView;
  onAdd: (l: HedgeLineView) => void;
  onMore: () => void;
}) {
  const { view } = p;
  const line = view.line;
  return (
    <section class="hedge-sec" aria-label="デルタヘッジ">
      <div class="hedge-row">
        <span class="lab">ヘッジ</span>
        {/* 前半（Δ）と理由だけが縮んで省略記号、結論（→ ミニ N 枚）は縮めない（#274 再レビュー R5） */}
        <span class={view.warn ? 'txt warn' : 'txt'} title={view.text}>
          <span class="d">{view.delta}</span>
          {view.action && <span class="act">{view.action}</span>}
          {view.why && <span class="why">{view.why.trim()}</span>}
        </span>
        {line && (
          <button
            type="button"
            class="btn sm"
            disabled={!line.canAdd}
            aria-label={line.aria}
            onClick={() => p.onAdd(line)}
          >
            追加
          </button>
        )}
        <button
          type="button"
          class="btn ghost icon sm"
          aria-haspopup="dialog"
          aria-label="デルタヘッジの詳細と設定"
          title="デルタヘッジの詳細と設定"
          onClick={p.onMore}
        >
          <Icon name="more" />
        </button>
      </div>
    </section>
  );
}

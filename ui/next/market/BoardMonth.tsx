import { Component, type RefObject } from 'preact';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChainMonth } from '../../../data';
import type { OptionType, Side } from '../../../model';
import { pure } from '../../components/pure';
import { type BoardRow, displayRows, filterByAsk } from '../../view/board';
import {
  type BadgePair,
  BOARD_COLUMN_HEADS,
  type BoardBadges,
  type BoardPanelColumns,
  type BoardRowText,
  type BoardSideText,
  boardKPop,
} from '../../view/boardPanel';
import { hintNext, revealDelta } from '../../view/hint';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import { useOverlay } from '../parts/overlay';

/** 板・スマイルから足を入れる（NextApp。トースト・[元に戻す]・入れた足の選択） */
export type MarketAdd = (expiry: string, k: number, type: OptionType, side: Side) => void;
type RowAdd = (k: number, type: OptionType, side: Side) => void;

/** ジャンプの強調（0 = なし。1 / 2 は同じ行を続けて強調するときにアニメーションを掛け直すための交互の印） */
export type Flash = 0 | 1 | 2;

function QuoteCell(p: {
  k: number;
  type: OptionType;
  side: Side;
  text: string;
  label: string;
  title: string;
  noQuote: boolean;
  onAdd: RowAdd;
}) {
  const what = p.side === 'sell' ? 'bid' : 'ask';
  return (
    <td class={`q ${what}`}>
      <button
        type="button"
        class={p.noQuote ? `${what} noquote` : what}
        aria-label={p.label}
        title={p.title}
        onClick={() => p.onAdd(p.k, p.type, p.side)}
      >
        {p.text}
      </button>
    </td>
  );
}

function IvCell({ t, flag }: { t: BoardSideText; flag: boolean }) {
  const full = [
    ...(flag ? ['IV 不安定'] : []),
    ...t.marks.filter((m) => m.kind === 'ivMissing').map((m) => m.full),
  ];
  return (
    <td class="iv" title={full.length ? full.join('・') : undefined}>
      <span class="ivt">{t.iv}</span>
      {flag && (
        <span class="flag" aria-hidden="true">
          ×
        </span>
      )}
      {full.length > 0 && <span class="sr">（{full.join('・')}）</span>}
    </td>
  );
}

function Badges({ pair, side }: { pair: BadgePair; side: 'c' | 'p' }) {
  if (!pair.sell && !pair.buy) return null;
  return (
    <span class={`bg ${side}`}>
      {pair.sell && <span class="legbadge sell">{pair.sell}</span>}
      {pair.buy && <span class="legbadge buy">{pair.buy}</span>}
    </span>
  );
}

/**
 * K のポップオーバー（#264。押した行にだけ描く）。開閉の規則は parts/Popover.tsx と同じ（押すたびに反転・外側の
 * pointerdown で閉じる・Esc で閉じて K のボタンへ戻す・同時に 1 つ = overlay）。位置は CSS だけ（.board-wrap を包含
 * ブロックにして、5 列は枠の左、9 / 7 列は枠の中央 = K の列の中央。縦は K のセルの直下 = top: auto）。開いたら下端が
 * 見えるまで .board-wrap だけをスクロールする（revealDelta）。style 属性は使わない。
 */
function KPop(p: {
  id: string;
  text: BoardRowText;
  btn: RefObject<HTMLButtonElement>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose, btn } = p;
  useLayoutEffect(() => {
    const host = ref.current?.closest('.board-wrap');
    const pop = ref.current;
    if (!(host instanceof HTMLElement) || !pop) return;
    const r = pop.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const d = revealDelta(r.top, r.bottom, h.top, h.bottom);
    if (d > 0) host.scrollTop += d;
  }, []);
  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      const wrap = ref.current?.parentElement;
      if (wrap && e.target instanceof Node && wrap.contains(e.target)) return;
      if (!hintNext(true, 'outside')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const inside = ref.current?.parentElement?.contains(document.activeElement) ?? false;
      if (!hintNext(true, 'escape')) onClose();
      if (inside) btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, btn]);
  const v = boardKPop(p.text);
  return (
    <div class="popover kpop" id={p.id} ref={ref}>
      <p class="kpop-head">{v.head}</p>
      {v.lines.map((l) => (
        <p key={l.main} class="kpop-line">
          <span class="kpop-main">{l.main}</span>
          {l.note && <span class="kpop-note">{l.note}</span>}
        </p>
      ))}
      {v.marks.length > 0 && (
        <p class="kpop-marks">
          {v.marks.map((m, i) => (
            <span key={m} class="kpop-mark">
              {i > 0 ? `・${m}` : m}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

interface RowProps {
  row: BoardRow;
  text: BoardRowText;
  cols: BoardPanelColumns;
  /** 5 列の種別（9 / 7 列は null） */
  only: OptionType | null;
  atm: boolean;
  flash: Flash;
  /** バッジの文字列（売り / 買い × call / put。0 枚は空文字） */
  cs: string;
  cb: string;
  ps: string;
  pb: string;
  onAdd: RowAdd;
  /** K のポップオーバーを開いているか（押した行だけ true） */
  pop: boolean;
  /** ポップオーバーの id（aria-controls） */
  popId: string;
  /** K を押した（開閉の反転） */
  onK: (k: number) => void;
  onPopClose: () => void;
}

/** 1 行（K を key にし、props が変わった行だけ描き直す）。 */
class BoardRowView extends Component<RowProps> {
  override shouldComponentUpdate(n: RowProps): boolean {
    const p = this.props;
    return (
      p.row !== n.row ||
      p.text !== n.text ||
      p.cols !== n.cols ||
      p.only !== n.only ||
      p.atm !== n.atm ||
      p.flash !== n.flash ||
      p.cs !== n.cs ||
      p.cb !== n.cb ||
      p.ps !== n.ps ||
      p.pb !== n.pb ||
      p.onAdd !== n.onAdd ||
      p.pop !== n.pop ||
      p.onK !== n.onK
    );
  }

  private kBtn: RefObject<HTMLButtonElement> = { current: null };

  override render() {
    const { row, text, cols, only, atm, flash, onAdd } = this.props;
    const cls = [atm ? 'atm' : '', flash ? 'hit' : '', flash === 2 ? 'alt' : '']
      .filter(Boolean)
      .join(' ');
    const kFull = text.marks.filter((m) => m.kind !== 'unstable').map((m) => m.full);
    const { pop, popId, onK, onPopClose } = this.props;
    const call = { sell: this.props.cs, buy: this.props.cb };
    const put = { sell: this.props.ps, buy: this.props.pb };
    const hasBadge = only
      ? only === 'call'
        ? call.sell || call.buy
        : put.sell || put.buy
      : call.sell || call.buy || put.sell || put.buy;
    const k = (
      <th scope="row" class={hasBadge ? 'k b' : 'k'}>
        {/* K を押すとその行の理論価格と印の全文（#264）。title は PC のマウス用の要約 */}
        <span class="kcell">
          <button
            type="button"
            class="kbtn"
            ref={this.kBtn}
            title={text.kTitle ?? undefined}
            aria-haspopup="dialog"
            aria-expanded={pop}
            aria-controls={popId}
            onClick={() => onK(row.k)}
          >
            <span class={text.kMark ? `kv ${text.kMark}` : 'kv'}>{text.k}</span>
            {atm && <span class="sr">（ATM）</span>}
            {kFull.length > 0 && <span class="sr">（{kFull.join('・')}）</span>}
            <span class="sr">（理論価格を見る）</span>
          </button>
          {hasBadge && (
            <span class={only ? 'legbadges one' : 'legbadges'}>
              {(only === null || only === 'call') && <Badges pair={call} side="c" />}
              {(only === null || only === 'put') && <Badges pair={put} side="p" />}
            </span>
          )}
        </span>
        {pop && <KPop id={popId} text={text} btn={this.kBtn} onClose={onPopClose} />}
      </th>
    );
    const side = (type: OptionType) => {
      const t = text[type];
      const flag = only ? text.flagSide !== null : text.flagSide === type;
      const bid = (
        <QuoteCell
          k={row.k}
          type={type}
          side="sell"
          text={t.bid}
          label={t.bidTitle}
          title={t.bidTitle}
          noQuote={t.noQuote}
          onAdd={onAdd}
        />
      );
      const ask = (
        <QuoteCell
          k={row.k}
          type={type}
          side="buy"
          text={t.ask}
          label={t.askTitle}
          title={t.askTitle}
          noQuote={t.noQuote}
          onAdd={onAdd}
        />
      );
      const iv = <IvCell t={t} flag={flag} />;
      const delta = <td class="d">{t.delta}</td>;
      return { bid, ask, iv, delta };
    };
    if (only) {
      const s = side(only);
      return (
        <tr data-k={row.k} class={cls || undefined}>
          {k}
          {s.bid}
          {s.ask}
          {s.iv}
          {s.delta}
        </tr>
      );
    }
    const c = side('call');
    const p = side('put');
    return (
      <tr data-k={row.k} class={cls || undefined}>
        {cols === 9 && c.delta}
        {c.iv}
        {c.bid}
        {c.ask}
        {k}
        {p.bid}
        {p.ask}
        {p.iv}
        {cols === 9 && p.delta}
      </tr>
    );
  }
}

interface TableProps {
  rows: readonly BoardRow[];
  texts: Map<number, BoardRowText>;
  cols: BoardPanelColumns;
  only: OptionType | null;
  visible: boolean;
  /** 限月が表示中か（K のポップオーバーを閉じるだけに使う） */
  active: boolean;
  atmK: number | null;
  flashK: number | null;
  flash: Flash;
  badges: BoardBadges | undefined;
  onAdd: RowAdd;
}

const NO_BADGE = { call: undefined, put: undefined };

/** 表 1 枚（5 列は put と call の 2 枚を持ち、表示中でない方は CSS で描画を止めて保つ）。 */
const BoardTable = pure(function BoardTable(p: TableProps) {
  const heads = BOARD_COLUMN_HEADS[p.cols];
  // K のポップオーバー（#264）: 表ごとに 1 つ。開いている行の K だけを持ち、その行だけに描く（全行に置かない）
  const id = useId();
  const { open, setOpen } = useOverlay(id);
  const [popK, setPopK] = useState<number | null>(null);
  const openRef = useRef({ open, popK });
  openRef.current = { open, popK };
  const onK = useCallback(
    (k: number) => {
      const cur = openRef.current;
      const same = cur.open && cur.popK === k;
      setPopK(k);
      setOpen(same ? hintNext(true, 'toggle') : true);
    },
    [setOpen],
  );
  const onPopClose = useCallback(() => setOpen(false), [setOpen]);
  // 見えなくなった表（限月・5 列の種別の切替）では閉じる
  const shownNow = p.visible && p.active;
  useLayoutEffect(() => {
    if (!shownNow) setOpen(false);
  }, [shownNow, setOpen]);
  const shownK = open ? popK : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない）
    <div
      class={p.visible ? 'board-wrap' : 'board-wrap side-hidden'}
      // 全体のキー 2 の行き先・クリックで ↓・PageDown がこの枠を動かす（#89。隠している側は持たない）
      tabIndex={p.visible ? -1 : undefined}
      role="group"
      aria-label={p.visible ? PANEL_FOCUS_LABEL.board : undefined}
      data-side={p.only ?? 'both'}
      aria-hidden={p.visible ? undefined : true}
    >
      <table class={`board c${p.cols}`}>
        <thead>
          <tr>
            {heads.map((h, i) => (
              <th key={i} class={h === 'K' ? 'k' : undefined} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((row) => {
            const text = p.texts.get(row.k);
            if (!text) return null;
            const b = p.badges?.get(row.k) ?? NO_BADGE;
            return (
              <BoardRowView
                key={row.k}
                row={row}
                text={text}
                cols={p.cols}
                only={p.only}
                atm={row.k === p.atmK}
                flash={row.k === p.flashK ? p.flash : 0}
                cs={b.call?.sell ?? ''}
                cb={b.call?.buy ?? ''}
                ps={b.put?.sell ?? ''}
                pb={b.put?.buy ?? ''}
                onAdd={p.onAdd}
                pop={row.k === shownK}
                popId={`${id}-kpop`}
                onK={onK}
                onPopClose={onPopClose}
              />
            );
          })}
        </tbody>
      </table>
      {p.rows.length === 0 && <p class="board-empty">該当する行が無い</p>}
    </div>
  );
});

export interface BoardMonthProps {
  month: ChainMonth;
  /** boardRows(chain, month)（昇順） */
  rows: readonly BoardRow[];
  texts: Map<number, BoardRowText>;
  active: boolean;
  cols: BoardPanelColumns;
  target: OptionType;
  filterAsk: boolean;
  atmK: number | null;
  /** 強調する K（表示中の限月だけ。他は null） */
  flashK: number | null;
  flash: Flash;
  badges: BoardBadges | undefined;
  onAdd: MarketAdd;
}

/**
 * 限月 1 つの板（#85）。表示中でない限月は .inactive（content-visibility: hidden = 描画・フォーカス・読み上げから外れる。
 * inert は付けない: 付け外しで 322 行の style の再計算が切替のフレームに入る）で保ち、
 * 限月の切替で 322 行を作り直さない。行は降順（displayRows）、絞り込みは今の filterByAsk。
 */
function BoardMonthView(p: BoardMonthProps) {
  const desc = useMemo(() => displayRows(p.rows), [p.rows]);
  const putRows = useMemo(
    () => (p.filterAsk ? filterByAsk(desc, 'put') : desc),
    [desc, p.filterAsk],
  );
  const callRows = useMemo(
    () => (p.filterAsk ? filterByAsk(desc, 'call') : desc),
    [desc, p.filterAsk],
  );
  const { onAdd } = p;
  const monthId = p.month.id;
  const rowAdd = useCallback<RowAdd>(
    (k, type, side) => onAdd(monthId, k, type, side),
    [onAdd, monthId],
  );
  const sides: Array<OptionType | null> = p.cols === 5 ? ['put', 'call'] : [null];
  return (
    <div
      class={p.active ? 'board-month' : 'board-month inactive'}
      data-month={monthId}
      aria-hidden={p.active ? undefined : true}
    >
      {sides.map((only) => (
        <BoardTable
          key={only ?? 'both'}
          rows={
            only === 'call'
              ? callRows
              : only === 'put'
                ? putRows
                : p.target === 'put'
                  ? putRows
                  : callRows
          }
          texts={p.texts}
          cols={p.cols}
          only={only}
          visible={only === null || only === p.target}
          active={p.active}
          atmK={p.atmK}
          flashK={p.flashK}
          flash={p.flash}
          badges={p.badges}
          onAdd={rowAdd}
        />
      ))}
    </div>
  );
}

export const BoardMonth = pure(BoardMonthView);

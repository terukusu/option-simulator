import { Component } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Chain, ChainMonth } from '../../data';
import type { AtmBasis, OptionType, Side } from '../../model';
import type { Action } from '../state';
import {
  ASK_FILTER_YEN,
  atmStrike,
  type BoardRow,
  type BoardSideCell,
  boardColumns,
  boardRows,
  DELTA_JUMPS,
  filterByAsk,
  jumpToDelta,
  jumpToOtm,
  OTM_JUMPS,
  referencePrice,
  rowMarkLabels,
  sideMarkLabels,
} from '../view/board';
import { fmtIvPct, fmtNum } from '../view/format';
import { pure } from './pure';

type AddLeg = (k: number, type: OptionType, side: Side) => void;

const TYPE_LABEL: Record<OptionType, string> = { call: 'call', put: 'put' };

function QuoteButton(props: {
  k: number;
  type: OptionType;
  side: Side;
  price: number | null;
  noQuote: boolean;
  onAdd: AddLeg;
}) {
  const { k, type, side, price, onAdd } = props;
  const what = side === 'sell' ? 'bid' : 'ask';
  const label = `${fmtNum(k)} ${TYPE_LABEL[type]} ${what} ${
    price === null ? '気配なし' : fmtNum(price)
  } で${side === 'sell' ? '売り' : '買い'}`;
  return (
    <button
      type="button"
      class={`q ${what}${props.noQuote ? ' noquote' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => onAdd(k, type, side)}
    >
      {fmtNum(price)}
    </button>
  );
}

function sideCells(row: BoardRow, type: OptionType, onAdd: AddLeg, compact = false) {
  const c: BoardSideCell = row[type];
  const tags = sideMarkLabels(c);
  const iv = (
    <td class={`iv ${type}`}>
      {fmtIvPct(c.bidIv)}/{fmtIvPct(c.askIv)}
      {tags.map((t) => (
        <span class="tag" key={t}>
          {t}
        </span>
      ))}
    </td>
  );
  const delta = <td class={`delta ${type}`}>{fmtNum(c.delta, 2)}</td>;
  const bid = (
    <td class={`bid ${type}`}>
      <QuoteButton
        k={row.k}
        type={type}
        side="sell"
        price={c.bid}
        noQuote={c.noQuote}
        onAdd={onAdd}
      />
    </td>
  );
  const ask = (
    <td class={`ask ${type}`}>
      <QuoteButton
        k={row.k}
        type={type}
        side="buy"
        price={c.ask}
        noQuote={c.noQuote}
        onAdd={onAdd}
      />
    </td>
  );
  if (compact) return [bid, ask, iv];
  return type === 'call' ? [delta, iv, bid, ask] : [bid, ask, iv, delta];
}

interface RowProps {
  row: BoardRow;
  /** 枠が狭いときに出す種別（K・bid・ask・IV だけ）。null は 9 列 */
  only: OptionType | null;
  atm: boolean;
  flash: boolean;
  onAdd: AddLeg;
}

/** 1 行（K を key にし、props が変わった行だけ描き直す）。 */
class BoardRowView extends Component<RowProps> {
  override shouldComponentUpdate(next: RowProps): boolean {
    const p = this.props;
    return (
      p.row !== next.row ||
      p.only !== next.only ||
      p.atm !== next.atm ||
      p.flash !== next.flash ||
      p.onAdd !== next.onAdd
    );
  }

  override render() {
    const { row, only, atm, flash, onAdd } = this.props;
    const cls = [atm ? 'atm' : '', flash ? 'flash' : '', row.unstable ? 'unstable' : '']
      .filter(Boolean)
      .join(' ');
    const k = (
      <th scope="row" class="k">
        {fmtNum(row.k)}
        {atm && <span class="sr-only">（ATM）</span>}
        {rowMarkLabels(row).map((t) => (
          <span class={t === 'IV 不安定' ? 'tag warn' : 'tag'} key={t}>
            {t}
          </span>
        ))}
      </th>
    );
    return (
      <tr data-k={row.k} class={cls || undefined}>
        {only ? (
          // 狭い枠: 種別を替えてもセルの並びは同じ（K・bid・ask・IV）。中身の書き換えだけで済む
          <>
            {k}
            {sideCells(row, only, onAdd, true)}
          </>
        ) : (
          <>
            {sideCells(row, 'call', onAdd)}
            {k}
            {sideCells(row, 'put', onAdd)}
          </>
        )}
      </tr>
    );
  }
}

interface BoardTableProps {
  rows: BoardRow[];
  /** 狭い枠の種別（null は 9 列） */
  side: OptionType | null;
  visible: boolean;
  atmK: number | null;
  flashK: number | null;
  onAdd: AddLeg;
}

/** 板の表 1 枚（狭い枠では put と call の 2 枚を持ち、表示中でない方は CSS で描画を止めて保つ）。 */
const BoardTable = pure(function BoardTable(props: BoardTableProps) {
  const { rows, side, visible, atmK, flashK, onAdd } = props;
  return (
    <div
      class={visible ? 'board-scroll' : 'board-scroll side-hidden'}
      aria-hidden={visible ? undefined : true}
      inert={!visible}
    >
      <table class="board-table">
        <thead>
          {side ? (
            <tr>
              <th class="k">K</th>
              <th class={`bid ${side}`}>{side === 'put' ? 'P' : 'C'} bid</th>
              <th class={`ask ${side}`}>{side === 'put' ? 'P' : 'C'} ask</th>
              <th class={`iv ${side}`}>IV</th>
            </tr>
          ) : (
            <tr>
              <th class="delta call">Δ</th>
              <th class="iv call">IV</th>
              <th class="bid call">C bid</th>
              <th class="ask call">C ask</th>
              <th class="k">K</th>
              <th class="bid put">P bid</th>
              <th class="ask put">P ask</th>
              <th class="iv put">IV</th>
              <th class="delta put">Δ</th>
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((row) => (
            <BoardRowView
              key={row.k}
              row={row}
              only={side}
              atm={row.k === atmK}
              flash={row.k === flashK}
              onAdd={onAdd}
            />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p class="note">該当する行が無い</p>}
    </div>
  );
});

export interface BoardProps {
  chain: Chain;
  month: ChainMonth;
  /** 表示中の限月か（限月ごとに板を持ち、表示中でない板は CSS で描画を止めて保つ） */
  active: boolean;
  basis: AtmBasis;
  target: OptionType;
  filterAsk: boolean;
  dispatch: (a: Action) => void;
}

function BoardView({ chain, month, active, basis, target, filterAsk, dispatch }: BoardProps) {
  const rows = useMemo(() => boardRows(chain, month), [chain, month]);
  const putRows = useMemo(() => (filterAsk ? filterByAsk(rows, 'put') : rows), [rows, filterAsk]);
  const callRows = useMemo(() => (filterAsk ? filterByAsk(rows, 'call') : rows), [rows, filterAsk]);
  const shown = target === 'put' ? putRows : callRows;
  const atmK = atmStrike(month, basis);
  const x0 = referencePrice(month, basis);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = boardColumns(width);
  const pending = useRef<{ k: number; flash: boolean } | null>(null);
  const [flashK, setFlashK] = useState<number | null>(null);

  const onAdd = useCallback<AddLeg>(
    (k, type, side) =>
      dispatch({ type: 'addBoardLeg', expiry: month.id, k, optionType: type, side }),
    [dispatch, month.id],
  );

  const visibleBox = () =>
    root.current?.querySelector<HTMLDivElement>('.board-scroll:not(.side-hidden)') ?? null;

  const scrollTo = useCallback((k: number, flash: boolean) => {
    const box = root.current?.querySelector<HTMLDivElement>('.board-scroll:not(.side-hidden)');
    const el = box?.querySelector(`tr[data-k="${k}"]`);
    if (!box || !el) return false;
    // 板の枠の中だけをスクロールする（ページは動かさない）。行を枠の中央に
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    box.scrollTop += r.top - b.top - (box.clientHeight - r.height) / 2;
    if (flash) setFlashK(k);
    return true;
  }, []);

  const jump = (k: number | null) => {
    if (k === null) return;
    if (!shown.some((r) => r.k === k)) {
      // 絞り込みで隠れている行: 絞り込みを外してから移動する
      pending.current = { k, flash: true };
      dispatch({ type: 'setFilterAsk', on: false });
      return;
    }
    scrollTo(k, true);
  };

  /** 狭い枠で種別を替えるとき、いま枠の中央にある行使価格を新しい表でも中央に置く */
  const switchTarget = (t: OptionType) => {
    if (t === target) return;
    const box = visibleBox();
    if (columns === 'compact' && box) {
      const b = box.getBoundingClientRect();
      const mid = b.top + box.clientHeight / 2;
      const row = Array.from(box.querySelectorAll<HTMLTableRowElement>('tbody tr')).find(
        (tr) => tr.getBoundingClientRect().bottom >= mid,
      );
      if (row) pending.current = { k: Number(row.dataset.k), flash: false };
    }
    dispatch({ type: 'setTarget', target: t });
  };

  useEffect(() => {
    const p = pending.current;
    if (p !== null && scrollTo(p.k, p.flash)) pending.current = null;
  });

  // 板を読んだ後、初めて表示したときに ATM へ（限月を切り替えて戻ったときは位置を保つ）
  const shownOnce = useRef<string | null>(null);
  const shownKey = `${columns}:${month.id}`;
  useEffect(() => {
    if (!active || shownOnce.current === shownKey || atmK === null) return;
    if (scrollTo(atmK, false)) shownOnce.current = shownKey;
  });
  // 板を読み直したら（month が新しいオブジェクト）もう一度 ATM へ
  useEffect(() => {
    shownOnce.current = null;
  }, [month]);

  useEffect(() => {
    if (flashK === null) return;
    const t = setTimeout(() => setFlashK(null), 1500);
    return () => clearTimeout(t);
  }, [flashK]);

  const sides: Array<OptionType | null> = columns === 'compact' ? ['put', 'call'] : [null];

  return (
    <div
      ref={root}
      class={`board ${columns}${active ? '' : ' inactive'}`}
      aria-hidden={active ? undefined : true}
      inert={!active}
    >
      <div class="board-tools">
        <button type="button" class="primary" onClick={() => jump(atmK)} disabled={atmK === null}>
          ATM へ戻る
        </button>
        <fieldset class="seg" aria-label="対象の種別">
          {(['put', 'call'] as const).map((t) => (
            <button
              type="button"
              key={t}
              aria-pressed={target === t}
              onClick={() => switchTarget(t)}
            >
              {t}
            </button>
          ))}
        </fieldset>
        <fieldset class="seg" aria-label="OTM 度へジャンプ">
          {OTM_JUMPS.map((p) => (
            <button
              type="button"
              key={p}
              disabled={x0 === null}
              onClick={() => jump(jumpToOtm(rows, target, x0, p))}
            >
              OTM {Math.round(p * 100)}%
            </button>
          ))}
        </fieldset>
        <fieldset class="seg" aria-label="デルタへジャンプ">
          {DELTA_JUMPS.map((d) => (
            <button type="button" key={d} onClick={() => jump(jumpToDelta(rows, target, d))}>
              |Δ| {d.toFixed(2)}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          aria-pressed={filterAsk}
          onClick={() => dispatch({ type: 'setFilterAsk', on: !filterAsk })}
        >
          ask ≤ {ASK_FILTER_YEN} 円
        </button>
      </div>
      <p class="note">bid = 売り、ask = 買い で足を追加。Δ はスマイルの IV での値。</p>
      {sides.map((side) => (
        <BoardTable
          key={side ?? 'full'}
          rows={side === 'call' ? callRows : side === 'put' ? putRows : shown}
          side={side}
          visible={side === null || side === target}
          atmK={atmK}
          flashK={flashK}
          onAdd={onAdd}
        />
      ))}
    </div>
  );
}

/** 板（限月ごと）。props が変わらなければ描き直さない */
export const Board = pure(BoardView);

import type { ComponentChildren } from 'preact';
import type { MutableRef } from 'preact/hooks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Chain } from '../../../data';
import type { AtmBasis, OptionType } from '../../../model';
import { pure } from '../../components/pure';
import type { Action, UiLeg } from '../../state';
import { atmStrike, boardRows, displayRows, filterByAsk, referencePrice } from '../../view/board';
import {
  ASK_FILTER_TEXT,
  BOARD_FLASH_MS,
  BOARD_HINT,
  type BoardBadges,
  type BoardRowText,
  boardBadges,
  boardChips,
  boardFoot,
  boardPanelColumns,
  boardRowTexts,
} from '../../view/boardPanel';
import type { HeaderMonthView } from '../../view/header';
import { PICK_BAND_TEXT } from '../../view/positionsRegion';
import { BoardMonth, type Flash, type MarketAdd } from '../market/BoardMonth';
import { MonthSeg } from '../market/MonthSeg';
import { PanelHead } from '../PanelHead';
import { Chip, ChipRow } from '../parts/Chip';
import { Icon } from '../parts/Icon';
import { ManualLinks } from '../parts/ManualLinks';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';

const NO_TEXTS = new Map<number, BoardRowText>();

function sameBadges(a: BoardBadges, b: BoardBadges): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (
      !w ||
      v.call?.sell !== w.call?.sell ||
      v.call?.buy !== w.call?.buy ||
      v.put?.sell !== w.put?.sell ||
      v.put?.buy !== w.put?.buy
    )
      return false;
  }
  return true;
}

const TARGET_OPTIONS = [
  { value: 'put', text: 'put' },
  { value: 'call', text: 'call' },
] as const;

export interface BoardRegionProps {
  chain: Chain;
  /** headerModel の限月（脚注の F・ATM・SQ） */
  months: readonly HeaderMonthView[];
  monthId: string;
  basis: AtmBasis;
  target: OptionType;
  filterAsk: boolean;
  /** 作業中のタブの足（バッジ） */
  legs: readonly UiLeg[];
  dispatch: (a: Action) => void;
  onAdd: MarketAdd;
  /** 板から追加の帯を出す（#325。スマホ・タブレットで始めた間だけ。案内だけ） */
  pickBand: boolean;
  /** PC の見出しの市場の Seg（Shell が作る。他の段階は null） */
  marketSeg: ComponentChildren;
  /**
   * 外からの「ATM へ」の要求（連番。0 / 省略 = 要求なし。#89 段 B のコマンドパレット）。値が変わったら [ATM] と同じ
   * jump(atmK)。表がまだ無い（板を開いた直後・幅 0）あいだは ATM_JUMP_FRAMES まで次のフレームで試し直す
   */
  atmJump?: number;
  /**
   * 消費した「ATM へ」の連番（#91 段 C。NextApp の ref）。渡すと、連番がこれと違うときだけ 1 回跳び、跳べた・試し直しを
   * 使い切ったらこれに入れる（読み直しなどで Board を作り直しても最後の要求でもう一度跳ばない）。省略時は値が変わるたび
   */
  atmJumpDone?: MutableRef<number>;
}

/** 外からの ATM へで表ができるのを待つフレームの上限 */
const ATM_JUMP_FRAMES = 30;

/**
 * 板（docs/ui-redesign.md §2・§4.3・§11 決定 1・12。#85）: 見出し行（市場の Seg・ⓘ）→ ツールの行 2 段（限月・put / call、
 * [ATM] + ジャンプと絞り込みのチップ）→ 限月ごとの表（market/BoardMonth.tsx）→ 脚注。
 * 列の段階は section.board の幅（枠線込み）で 9 / 7 / 5。ジャンプ・初めて見えたときの ATM・5 列の種別の切替の規則は
 * 旧 Board と同じ（枠 .board-wrap の scrollTop だけを動かす）。強調は 0.9 秒。
 */
function BoardView(p: BoardRegionProps) {
  const { chain, monthId, basis, target, filterAsk, dispatch } = p;
  const month = chain.months.find((m) => m.id === monthId) ?? chain.months[0];
  const bodyRef = useRef<HTMLDivElement>(null);
  // 枠の幅（見えていない = 0 の間は前の値を保つ。初めは測るまで表を描かない）
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const sec = bodyRef.current?.closest('section');
    if (!sec) return;
    const update = () => {
      const w = sec.getBoundingClientRect().width;
      if (w > 0) setWidth((old) => (old === w ? old : w));
    };
    update();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
      }
    });
    ro.observe(sec);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);
  const cols = boardPanelColumns(width);

  // 行・文字列は板が変わったときだけ（限月ごと）。バッジは足が変わったときだけ
  const rowsByMonth = useMemo(
    () => new Map(chain.months.map((m) => [m.id, boardRows(chain, m)])),
    [chain],
  );
  const textsByMonth = useMemo(
    () =>
      new Map(
        chain.months.map((m) => [m.id, boardRowTexts(chain, m, rowsByMonth.get(m.id) ?? [])]),
      ),
    [chain, rowsByMonth],
  );
  const { legs } = p;
  // 中身が前と同じ限月は前の Map を使い回す（足を入れた限月だけ表を描き直す）
  const prevBadges = useRef(new Map<string, BoardBadges>());
  const badgesByMonth = useMemo(() => {
    const next = new Map<string, BoardBadges>();
    for (const m of chain.months) {
      const b = boardBadges(legs, m.id);
      const old = prevBadges.current.get(m.id);
      next.set(m.id, old && sameBadges(old, b) ? old : b);
    }
    prevBadges.current = next;
    return next;
  }, [chain, legs]);

  const rows = (month && rowsByMonth.get(month.id)) || [];
  const atmK = month ? atmStrike(month, basis) : null;
  const x0 = month ? referencePrice(month, basis) : null;
  const chips = useMemo(() => boardChips(rows, target, x0), [rows, target, x0]);
  const shownRows = useMemo(() => {
    const d = displayRows(rows);
    return filterAsk ? filterByAsk(d, target) : d;
  }, [rows, filterAsk, target]);

  const [flash, setFlash] = useState<{ k: number | null; n: Flash }>({ k: null, n: 0 });
  const pending = useRef<{ k: number; flash: boolean } | null>(null);

  const visibleBox = () =>
    bodyRef.current?.querySelector<HTMLDivElement>(
      '.board-month:not(.inactive) .board-wrap:not(.side-hidden)',
    ) ?? null;

  const scrollTo = useCallback((k: number, hit: boolean) => {
    const box = bodyRef.current?.querySelector<HTMLDivElement>(
      '.board-month:not(.inactive) .board-wrap:not(.side-hidden)',
    );
    const el = box?.querySelector(`tr[data-k="${k}"]`);
    if (!box || !el || box.clientHeight === 0) return false;
    // 枠の中だけをスクロールする（ページ・シートは動かさない）。行を枠の中央に（見出しの行の分を除く）
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const head = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    box.scrollTop += r.top - b.top - head - (box.clientHeight - head - r.height) / 2;
    if (hit) setFlash((f) => ({ k, n: f.n === 1 ? 2 : 1 }));
    return true;
  }, []);

  const jump = (k: number | null) => {
    if (k === null) return;
    if (!shownRows.some((r) => r.k === k)) {
      // 絞り込みで隠れている行: 絞り込みを外してから移動する
      pending.current = { k, flash: true };
      dispatch({ type: 'setFilterAsk', on: false });
      return;
    }
    scrollTo(k, true);
  };

  // 外からの ATM へ（#89 段 B）: 最新の jump を ref で読み、表ができるまで次のフレームで試し直す
  const jumpRef = useRef<() => boolean>(() => false);
  jumpRef.current = () => {
    if (atmK === null) return true;
    if (!shownRows.some((r) => r.k === atmK)) {
      jump(atmK);
      return true;
    }
    return scrollTo(atmK, true);
  };
  const { atmJump = 0, atmJumpDone } = p;
  useEffect(() => {
    if (atmJump <= 0 || (atmJumpDone && atmJumpDone.current === atmJump)) return;
    let n = 0;
    let frame = 0;
    const tick = () => {
      frame = 0;
      if (!jumpRef.current() && ++n < ATM_JUMP_FRAMES) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (atmJumpDone) atmJumpDone.current = atmJump;
    };
    tick();
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [atmJump]);

  /** 5 列で種別を替えるとき、いま枠の中央にある行使価格を新しい表でも中央に置く */
  const switchTarget = (t: OptionType) => {
    if (t === target) return;
    const box = visibleBox();
    if (cols === 5 && box) {
      const b = box.getBoundingClientRect();
      const head = box.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      const mid = b.top + head + (box.clientHeight - head) / 2;
      const row = Array.from(box.querySelectorAll<HTMLTableRowElement>('tbody tr')).find(
        (tr) => tr.getBoundingClientRect().bottom >= mid,
      );
      if (row) pending.current = { k: Number(row.dataset.k), flash: false };
    }
    dispatch({ type: 'setTarget', target: t });
  };

  useEffect(() => {
    const q = pending.current;
    if (q !== null && scrollTo(q.k, q.flash)) pending.current = null;
  });

  // 初めて見えたとき（列の段階 × 限月ごと。幅 0 の間は待つ）に ATM へ。限月を替えて戻ったときは位置を保つ
  const shown = useRef(new Set<string>());
  useEffect(() => {
    // 板を読み直したら（chain が新しいオブジェクト）もう一度 ATM へ
    shown.current = new Set();
  }, [chain]);
  useEffect(() => {
    if (!month || width === 0 || atmK === null) return;
    const key = `${cols}:${month.id}`;
    if (shown.current.has(key)) return;
    if (scrollTo(atmK, false)) shown.current.add(key);
  });

  // 表示中でない表（他の限月・5 列の隠れた種別）は content-visibility: hidden で割り付けを飛ばすので、そのままだと
  // 初めて見せたとき（限月・種別の切替）に 322 行の割り付け（≈ 100ms）が 1 フレームに入る。表を作った後（板・列の段階が
  // 変わったとき）の空き時間に 1 枚ずつ割り付けておく（.warm の間だけ content-visibility を外して高さを読む。
  // 割り付けは隠しても保たれる）。一度見せた表は割り付けが残るので、切替のたびにはやらない
  const { onAdd } = p;
  const shownTables = width > 0;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !shownTables) return;
    const months = body.querySelector<HTMLElement>('.board-months');
    months?.removeAttribute('data-warm');
    const later = (fn: () => void) =>
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback(fn, { timeout: 500 })
        : window.setTimeout(fn, 50);
    const cancel = (h: number) =>
      typeof cancelIdleCallback === 'function' ? cancelIdleCallback(h) : window.clearTimeout(h);
    const queue = Array.from(
      body.querySelectorAll<HTMLElement>('.board-month.inactive, .board-wrap.side-hidden'),
    );
    let handle = 0;
    const step = () => {
      const el = queue.shift();
      if (!el) {
        months?.setAttribute('data-warm', 'done');
        return;
      }
      if (el.classList.contains('inactive') || el.classList.contains('side-hidden')) {
        el.classList.add('warm');
        void el.querySelector('table')?.offsetHeight;
        el.classList.remove('warm');
      }
      handle = later(step);
    };
    handle = later(step);
    return () => cancel(handle);
  }, [shownTables, cols, chain]);

  useEffect(() => {
    if (flash.k === null) return;
    const t = setTimeout(() => setFlash((f) => ({ k: null, n: f.n })), BOARD_FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  // [put | call]: 5 列は表の種別なので限月の行、7 / 9 列は C・P を両方出すのでジャンプ・絞り込みの対象 = チップ行の先頭（#276）
  const targetSeg = (
    <Seg label="対象の種別" value={target} options={TARGET_OPTIONS} onChange={switchTarget} />
  );
  const head = month ? p.months.find((m) => m.id === month.id) : undefined;
  const foot = head ? boardFoot(head, basis) : null;

  return (
    <>
      <PanelHead title="板">
        {p.marketSeg}
        <Popover label="板の使い方" button={<Icon name="info" />}>
          {BOARD_HINT.map((t) => (
            <p key={t}>{t}</p>
          ))}
          <ManualLinks place="board" />
        </Popover>
      </PanelHead>
      {/* 常に置き、中身を入れ替える（後から挿した live region は読み上げない端末がある）。空のときは CSS で高さ 0 */}
      <p class="pick-band" role="status">
        {p.pickBand ? PICK_BAND_TEXT : ''}
      </p>
      <div class="panel-body market-body" ref={bodyRef}>
        <div class="board-tools">
          <div class="row">
            <MonthSeg
              months={chain.months}
              value={month?.id ?? ''}
              onChange={(id) => dispatch({ type: 'setMonth', monthId: id })}
            />
            {cols === 5 && targetSeg}
          </div>
          <div class="row">
            <button
              type="button"
              class="btn sm"
              aria-label="ATM へ"
              disabled={atmK === null}
              onClick={() => jump(atmK)}
            >
              ATM
            </button>
            <ChipRow label="ジャンプと絞り込み">
              {cols !== 5 && targetSeg}
              {chips.map((c) => (
                <Chip
                  key={c.key}
                  text={c.text}
                  label={c.label}
                  disabled={c.disabled}
                  onClick={() => jump(c.k)}
                />
              ))}
              <Chip
                text={ASK_FILTER_TEXT}
                warn
                pressed={filterAsk}
                onClick={() => dispatch({ type: 'setFilterAsk', on: !filterAsk })}
              />
            </ChipRow>
          </div>
        </div>
        <div class="board-months">
          {width > 0 &&
            chain.months.map((m) => {
              const active = m.id === month?.id;
              return (
                <BoardMonth
                  key={m.id}
                  month={m}
                  rows={rowsByMonth.get(m.id) ?? []}
                  texts={textsByMonth.get(m.id) ?? NO_TEXTS}
                  active={active}
                  cols={cols}
                  target={target}
                  filterAsk={filterAsk}
                  atmK={atmStrike(m, basis)}
                  flashK={active ? flash.k : null}
                  flash={active ? flash.n : 0}
                  badges={badgesByMonth.get(m.id)}
                  onAdd={onAdd}
                />
              );
            })}
        </div>
        {foot && (
          <div class="board-foot">
            <span class="f">{foot.f}</span>
            <span class="atm">{foot.atm}</span>
            <span class="sq">{foot.sq}</span>
            <span class="marks">{foot.marks}</span>
          </div>
        )}
      </div>
    </>
  );
}

/** 板の領域（props が浅く等しければ描き直さない。舞台のドラッグでは描き直さない） */
export const Board = pure(BoardView);

/**
 * 板の表示モデル（純関数）。設計 docs/design.md M1・M3・M10（板）・M11。
 *
 * - 行（`boardRows`）は板と限月だけで決まる（ATM の基準に依らない）。基準の切替で行の
 *   オブジェクトが変わらないので、画面は強調の変わる行だけを描き直せる
 * - Δ はスマイルの IV（σ_smile(K)）での Black-76 の Δ（`model/` の black76Greeks）
 * - OTM 度: put は 1 − K / X₀,i、call は K / X₀,i − 1（X₀,i = 選択中の基準の基準価格）
 * - 表示の並びは行使価格の降順（`displayRows`、#50）。板のデータ・`boardRows` は昇順のまま
 */

import type { Chain, ChainMonth, QuoteState } from '../../data';
import { type AtmBasis, black76Greeks, type OptionType, type SmileMark } from '../../model';

export interface BoardSideCell {
  bid: number | null;
  ask: number | null;
  /** bid / ask の IV（%。板の気配の IV。持たない供給元の板では気配の価格から求めた値。data/normalize.ts の SideInfo） */
  bidIv: number | null;
  askIv: number | null;
  /** スマイルの IV での Black-76 の Δ（スマイルが無ければ null） */
  delta: number | null;
  quote: QuoteState;
  /** 両側気配が無い（bid / ask の操作では既定の手入力値で足を入れる） */
  noQuote: boolean;
  /** 気配はあるのに JPX の IV が両方無い（板が気配の IV を持たない供給元なら付けない） */
  jpxIvMissing: boolean;
}

export interface BoardRow {
  k: number;
  /** OTM 側の行が IV 不安定 */
  unstable: boolean;
  /** スマイルの節点 / 補間 / 外挿 */
  mark: SmileMark | null;
  /** スマイルの IV（小数） */
  smileIv: number | null;
  call: BoardSideCell;
  put: BoardSideCell;
}

export interface BoardModel {
  monthId: string;
  /** 選択中の基準の ATM の行使価格 */
  atmK: number | null;
  /** 選択中の基準の基準価格 X₀,i */
  x0: number | null;
  rows: BoardRow[];
}

export const MARK_LABEL: Record<SmileMark, string> = {
  node: '',
  interpolated: '補間',
  extrapolated: '外挿',
};

function delta(chain: Chain, month: ChainMonth, k: number, type: OptionType, iv: number | null) {
  if (iv === null || !Number.isFinite(iv) || !Number.isFinite(month.F) || !(month.T > 0)) {
    return null;
  }
  const d = black76Greeks(type, month.F, k, month.T, iv, chain.r).delta;
  return Number.isFinite(d) ? d : null;
}

/** 限月の行（基準に依らない）。 */
export function boardRows(chain: Chain, month: ChainMonth): BoardRow[] {
  return month.strikes.map((info, i) => {
    const src = month.source[i];
    const side = (type: OptionType): BoardSideCell => {
      const s = src?.[type];
      const si = info[type];
      return {
        bid: s?.bid ?? null,
        ask: s?.ask ?? null,
        bidIv: si.bidIv,
        askIv: si.askIv,
        delta: delta(chain, month, info.k, type, info.smileIv),
        quote: si.quote,
        noQuote: si.quote !== 'two_sided',
        jpxIvMissing: si.jpxIvMissing,
      };
    };
    return {
      k: info.k,
      unstable: info.unstable,
      mark: info.mark,
      smileIv: info.smileIv,
      call: side('call'),
      put: side('put'),
    };
  });
}

/**
 * 板の表示順（行使価格の降順、#50）。並べ替えは表示だけで、データ（昇順）は変えない。
 * 入力の配列は変えず、行のオブジェクトは同じ参照のまま（行ごとの描き直しの判定を保つ）。
 */
export function displayRows(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => b.k - a.k);
}

export function atmStrike(month: ChainMonth, basis: AtmBasis): number | null {
  return month.atm[basis].pick?.k ?? null;
}

export function referencePrice(month: ChainMonth, basis: AtmBasis): number | null {
  const p = month.atm[basis].reference.price;
  return p !== null && Number.isFinite(p) ? p : null;
}

/** OTM 度（put は 1 − K / X₀、call は K / X₀ − 1）。 */
export function otmDegree(type: OptionType, k: number, x0: number): number {
  return type === 'put' ? 1 - k / x0 : k / x0 - 1;
}

function nearest<T>(items: readonly T[], value: (t: T) => number | null, target: number) {
  let best: T | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const v = value(it);
    if (v === null || !Number.isFinite(v)) continue;
    const g = Math.abs(v - target);
    if (g < gap) {
      gap = g;
      best = it;
    }
  }
  return best;
}

/** 「OTM 度 n」の行: OTM 度が n に最も近い行（基準価格が無ければ null）。 */
export function jumpToOtm(
  rows: readonly BoardRow[],
  type: OptionType,
  x0: number | null,
  pct: number,
): number | null {
  if (x0 === null || !(x0 > 0)) return null;
  return nearest(rows, (r) => otmDegree(type, r.k, x0), pct)?.k ?? null;
}

/** 「|Δ| n」の行: その種別の |Δ| が n に最も近い行（Δ が無ければ null）。 */
export function jumpToDelta(
  rows: readonly BoardRow[],
  type: OptionType,
  absDelta: number,
): number | null {
  return (
    nearest(
      rows,
      (r) => {
        const d = r[type].delta;
        return d === null ? null : Math.abs(d);
      },
      absDelta,
    )?.k ?? null
  );
}

export const ASK_FILTER_YEN = 50;

/** 「ask ≤ 50 円」: その種別の ask が上限以下の行だけ（ask の無い行は除く）。 */
export function filterByAsk(
  rows: readonly BoardRow[],
  type: OptionType,
  maxAsk = ASK_FILTER_YEN,
): BoardRow[] {
  return rows.filter((r) => {
    const a = r[type].ask;
    return a !== null && a <= maxAsk;
  });
}

export const OTM_JUMPS = [0.1, 0.2, 0.3, 0.4] as const;
export const DELTA_JUMPS = [0.05, 0.1, 0.2, 0.3] as const;

export interface BoardOptions {
  target: OptionType;
  filterAsk: boolean;
}

/** 板の表示モデル（行・ATM・基準価格）。行は表示順（行使価格の降順）。 */
export function boardModel(
  chain: Chain,
  month: ChainMonth,
  basis: AtmBasis,
  opts: BoardOptions = { target: 'put', filterAsk: false },
): BoardModel {
  const all = displayRows(boardRows(chain, month));
  return {
    monthId: month.id,
    atmK: atmStrike(month, basis),
    x0: referencePrice(month, basis),
    rows: opts.filterAsk ? filterByAsk(all, opts.target) : all,
  };
}

/** 行の印（表示の文言）。 */
export function rowMarkLabels(row: BoardRow): string[] {
  const out: string[] = [];
  if (row.unstable) out.push('IV 不安定');
  if (row.mark === 'interpolated' || row.mark === 'extrapolated') out.push(MARK_LABEL[row.mark]);
  return out;
}

/** 種別ごとのセルの印。 */
export function sideMarkLabels(cell: BoardSideCell): string[] {
  const out: string[] = [];
  if (cell.noQuote) out.push('気配なし');
  if (cell.jpxIvMissing) out.push('JPX の IV 欠損');
  return out;
}

/**
 * 板の 9 列（call の Δ・IV・bid・ask、K、put の bid・ask・IV・Δ）が重ならずに収まる板の枠の最小幅（px）。
 * headless Chromium で 322 行・latest の板の各セルの内容幅から決めた（余裕を含む）
 */
export const FULL_BOARD_MIN_WIDTH = 560;

export type BoardColumns = 'full' | 'compact';

/**
 * 板の列の出し方を板の枠の幅で決める（画面幅ではなく枠の幅。2 ペインの中間幅でも重ならない）。
 * compact は対象の種別だけ・列は K・bid / ask・IV（スマホと同じ）。幅が不明（0 以下・非有限）なら full。
 */
export function boardColumns(width: number, minFull = FULL_BOARD_MIN_WIDTH): BoardColumns {
  if (!Number.isFinite(width) || width <= 0) return 'full';
  return width < minFull ? 'compact' : 'full';
}

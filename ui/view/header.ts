/**
 * ヘッダの表示モデル（純関数）。設計 docs/design.md 6.1・5.9・M1。
 * 計算は data/ の正規化結果をそのまま使い、ここは書式と「古い」・カレンダーの期限切れの判定だけ。
 */

import { type Calendar, type Chain, type ChainMonth, isCalendarExpired } from '../../data';
import type { AtmBasis } from '../../model';
import { DASH, fmtDateTime, fmtNum, fmtTime } from './format';

/** 基準価格の時刻がスナップショットよりこの分以上古ければ「古い」 */
export const STALE_MINUTES = 30;

export const REASON_LABEL: Record<Chain['reason'], string> = {
  latest: '最新',
  pre_open: '板寄せ前',
  after_close: '引け後',
  closed: '時間外',
};

/**
 * reason の理由の 1 行（latest は null）。板の時刻を含む。設計 7.1・13.4（文言の見直しは #38）。
 * closed は「45 分より古い（土日・休業日・取り込みの停止）」と「別の立会の板への戻り」の両方を含むので「休場」と言い切らない。
 */
export function reasonNote(chain: Chain): string | null {
  const at = fmtDateTime(chain.snapshotAt);
  switch (chain.reason) {
    case 'latest':
      return null;
    case 'pre_open':
      return `寄り前のため、板寄せ前の最後のスナップショット（${at}）を表示`;
    case 'after_close':
      return `引け後のため、板寄せ前の最後のスナップショット（${at}）を表示`;
    case 'closed':
      return `時間外・休業日、または取り込みの停止のため、最後に使えた板寄せ前のスナップショット（${at}）を表示`;
    default:
      return null;
  }
}

/** 読み込みに失敗したとき、前の板を表示し続けている旨（板が無ければ null）。 */
export function keptBoardNote(fetchedAt: number | null): string | null {
  return fetchedAt === null ? null : `前の板のまま（取得 ${fmtTime(fetchedAt)}）`;
}

/** 読み込みの情報（取得時刻・データ元のラベル）。App の state から渡す */
export interface LoadInfo {
  fetchedAt?: number | null;
  label?: string | null;
}

export type ForwardKind = 'synthetic' | 'future' | 'future_other_month' | 'none';

export const FORWARD_KIND_LABEL: Record<ForwardKind, string> = {
  synthetic: '合成先物',
  future: '先物で代用',
  future_other_month: '先物で代用（限月違い）',
  none: 'F なし',
};

export interface ReferenceView {
  basis: AtmBasis;
  /** 基準価格（円。無ければ「—」） */
  price: string;
  /** 基準価格の時刻（JST HH:mm） */
  time: string;
  /** スナップショットより 30 分以上古い */
  stale: boolean;
  /** B を求めたが合成先物が決まらず A を使った */
  fellBack: boolean;
}

export interface HeaderMonthView {
  id: string;
  lastTradingDay: string;
  sqDate: string;
  /** F_i（`67,810 ±15`）。無ければ「F なし」 */
  forward: string;
  forwardKind: ForwardKind;
  forwardKindLabel: string;
  refA: ReferenceView;
  refB: ReferenceView;
  /** 選択中の基準の ATM（無ければ「ATM なし」） */
  atm: string;
  atmK: number | null;
  noForward: boolean;
  noAtm: boolean;
}

export interface HeaderModel {
  snapshot: string;
  delay: string;
  reason: string;
  /** reason の理由の 1 行（latest は null） */
  reasonNote: string | null;
  source: string | null;
  /** 板を読み込んだ時刻（JST HH:mm。ポーリングしないので開いたままの画面の古さを示す）。未指定は null */
  fetched: string | null;
  /** データ元のラベル（API・fixture 名・ファイル名）。未指定は null */
  loadedFrom: string | null;
  spot: { price: string; time: string };
  future: { contract: string; price: string; time: string; sqDate: string };
  basis: AtmBasis;
  months: HeaderMonthView[];
  /** 前提（常時表示） */
  assumptions: string[];
  /** 評価時刻が取引カレンダーの covered_until より後（またはカレンダーを読めない） */
  calendarExpired: boolean;
  /** 「カレンダー期限切れ…」の文（assumptions にも入る。部品は warn で出す）。期限内なら null */
  calendarWarning: string | null;
}

/** 基準価格の時刻: A = 先物の約定時刻、B = スナップショット時刻（A にフォールバックしたら先物の約定時刻）。 */
export function referenceTime(chain: Chain, month: ChainMonth, basis: AtmBasis): number | null {
  const ref = month.atm[basis].reference;
  if (ref.price === null) return null;
  if (basis === 'B' && !ref.fellBack) return chain.snapshotAt;
  return chain.future.priceTime;
}

export function isStale(chain: Chain, time: number | null): boolean {
  if (time === null || !Number.isFinite(time)) return false;
  return chain.snapshotAt - time >= STALE_MINUTES * 60_000;
}

function forwardKind(chain: Chain, month: ChainMonth): ForwardKind {
  if (!Number.isFinite(month.F)) return 'none';
  if (month.syntheticOk) return 'synthetic';
  return month.sameMonthAsFuture || month.id === chain.future.id ? 'future' : 'future_other_month';
}

function referenceView(chain: Chain, month: ChainMonth, basis: AtmBasis): ReferenceView {
  const ref = month.atm[basis].reference;
  const time = referenceTime(chain, month, basis);
  return {
    basis,
    price: fmtNum(ref.price, 0),
    time: fmtTime(time),
    stale: isStale(chain, time),
    fellBack: ref.fellBack,
  };
}

function forwardText(month: ChainMonth): string {
  if (!Number.isFinite(month.F)) return FORWARD_KIND_LABEL.none;
  const u = month.forward.uncertainty;
  return Number.isFinite(u) ? `${fmtNum(month.F, 0)} ±${fmtNum(u, 0)}` : fmtNum(month.F, 0);
}

/** 前提に出す取引カレンダーの文と、期限切れの警告。設計 7.5。 */
export function calendarAssumption(
  calendar: Calendar,
  evalTime: number,
): { text: string; warning: string | null } {
  if (!calendar.ok) {
    return {
      text: '取引カレンダー: 読めない（SQ 日は土日だけで計算）',
      warning: 'カレンダー期限切れ（カレンダーを読めない）',
    };
  }
  return {
    text: `取引カレンダー: optionchan から同期（${calendar.syncedOn}）・確定 ${calendar.confirmedUntil} まで`,
    warning: isCalendarExpired(calendar, evalTime)
      ? `カレンダー期限切れ（評価時刻が ${calendar.coveredUntil} より後。休業日が漏れている可能性）`
      : null,
  };
}

export function headerModel(
  chain: Chain,
  basis: AtmBasis,
  calendar: Calendar,
  load: LoadInfo = {},
): HeaderModel {
  const cal = calendarAssumption(calendar, chain.evalTime);
  return {
    snapshot: fmtDateTime(chain.snapshotAt),
    delay: Number.isFinite(chain.delayedMinutes) ? `約 ${chain.delayedMinutes} 分遅れ` : DASH,
    reason: REASON_LABEL[chain.reason] ?? chain.reason,
    reasonNote: reasonNote(chain),
    source: chain.source,
    fetched: load.fetchedAt == null ? null : fmtTime(load.fetchedAt),
    loadedFrom: load.label ?? null,
    spot: { price: fmtNum(chain.spot.price, 0), time: fmtTime(chain.spot.priceTime) },
    future: {
      contract: chain.future.id,
      price: fmtNum(chain.future.price, 0),
      time: fmtTime(chain.future.priceTime),
      sqDate: chain.future.sqDate,
    },
    basis,
    months: chain.months.map((m) => {
      const kind = forwardKind(chain, m);
      const pick = m.atm[basis].pick;
      return {
        id: m.id,
        lastTradingDay: m.lastTradingDay,
        sqDate: m.sqDate,
        forward: forwardText(m),
        forwardKind: kind,
        forwardKindLabel: FORWARD_KIND_LABEL[kind],
        refA: referenceView(chain, m, 'A'),
        refB: referenceView(chain, m, 'B'),
        atm: pick ? fmtNum(pick.k, 0) : 'ATM なし',
        atmK: pick ? pick.k : null,
        noForward: kind === 'none',
        noAtm: pick === null,
      };
    }),
    assumptions: [
      `金利 ${fmtNum(chain.r * 100, 1)}%`,
      `評価時刻 = 板の時刻（${fmtDateTime(chain.evalTime)}）`,
      cal.text,
      ...(cal.warning ? [cal.warning] : []),
    ],
    calendarExpired: cal.warning !== null,
    calendarWarning: cal.warning,
  };
}

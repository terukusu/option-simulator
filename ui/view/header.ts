/**
 * ヘッダの表示モデル（純関数）。設計 docs/design.md 6.1・5.9・M1。
 * 計算は data/ の正規化結果をそのまま使い、ここは書式と「古い」の判定だけ。
 */

import type { Chain, ChainMonth } from '../../data';
import type { AtmBasis } from '../../model';
import { DASH, fmtDateTime, fmtNum, fmtTime } from './format';

/** 基準価格の時刻がスナップショットよりこの分以上古ければ「古い」 */
export const STALE_MINUTES = 30;

export const REASON_LABEL: Record<Chain['reason'], string> = {
  latest: '最新',
  pre_open: '板寄せ前',
  after_close: '引け後',
  closed: '休場',
};

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
  source: string | null;
  spot: { price: string; time: string };
  future: { contract: string; price: string; time: string; sqDate: string };
  basis: AtmBasis;
  months: HeaderMonthView[];
  /** 前提（常時表示） */
  assumptions: string[];
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

export function headerModel(chain: Chain, basis: AtmBasis): HeaderModel {
  return {
    snapshot: fmtDateTime(chain.snapshotAt),
    delay: Number.isFinite(chain.delayedMinutes) ? `約 ${chain.delayedMinutes} 分遅れ` : DASH,
    reason: REASON_LABEL[chain.reason] ?? chain.reason,
    source: chain.source,
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
      '取引カレンダー: 休業日未反映',
    ],
  };
}

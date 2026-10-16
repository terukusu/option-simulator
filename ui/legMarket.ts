/**
 * 足の市場を今の板から作り直す（純関数）。設計 docs/design.md 5.7・13.4（#23）。
 *
 * 新しい板を読んだとき（保存した足の復元・[最新]・保存した板での起動）に、足を追加したときと同じ規則で
 * 足の市場（手入力の OP の足の SQ 時刻・F、先物の足の SQ 時刻・価格）と市場の印を求め直す。
 * 建値・枚数・売買・IV の編集・mid と、足を入れたときの行の印（気配なし・IV 不安定・外挿・補間）は変えない。
 *
 * - OP の足で限月が板にある: 板の市場を使う（板の限月は足の市場より優先される）。「板なし（手入力）」を外し、
 *   「F は先物で代用」を板の合成先物に合わせる。手入力の足の市場は捨てずに持ち続ける（あとで限月の無い板を
 *   読んだときに作り直すため。F を入れた足は入れた値、代用だった足は NaN = 「入れていない」）
 * - 手入力の OP の足で限月が板に無い: SQ 時刻は暦から、F は指定値（足を入れたときに F を入れた）か
 *   今の板の先物価格（data/legs.ts の manualOptionLeg と同じ）
 * - 板の足で限月が板に無くなった（足の市場を持たない）: 作り直せないのでそのまま
 *   （positionModel の行のエラー「板に無い限月」）
 * - 先物の足: data/legs.ts の futureLeg と同じ（板の先物の限月は板の価格、限月違いはその月の合成先物か先物価格、
 *   価格が無ければ建値で評価して「先物価格なし」）
 */

import { type Chain, type LegMark, monthOf } from '../data';
import { type Holidays, monthlyExpiry } from '../model';
import type { UiLeg } from './state';

const MARKET_MARKS: ReadonlySet<LegMark> = new Set<LegMark>([
  'no_board',
  'forward_from_future',
  'future_manual',
  'no_price',
]);

/** 行の印（足を入れたときの板の行のもの）だけを残す。 */
function rowMarks(marks: readonly LegMark[]): LegMark[] {
  return marks.filter((m) => !MARKET_MARKS.has(m));
}

/** 'YYYY-MM' の SQ 時刻（暦から。形が違えば null）。 */
function calendarSqTime(id: string, holidays: Holidays): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(id);
  if (!m) return null;
  try {
    return monthlyExpiry(Number(m[1]), Number(m[2]), holidays).sqTime;
  } catch {
    return null;
  }
}

/**
 * 手入力の OP の足の F が利用者の入れた値か。限月が板に無いあいだは印（「F は先物で代用」が無い）で、
 * 限月が板にあるあいだ（「板なし」が無い。印は板の合成先物のもの）は持ち続けた F が数か（代用なら NaN）で決める。
 */
function userForwardOf(ui: UiLeg): boolean {
  if (ui.marks.includes('no_board')) return !ui.marks.includes('forward_from_future');
  return ui.optionMarket !== undefined && Number.isFinite(ui.optionMarket.market.forward);
}

/** 1 本の足の市場と市場の印を今の板から作り直す。 */
export function refreshLegMarket(chain: Chain, ui: UiLeg, holidays: Holidays): UiLeg {
  const leg = ui.leg;
  if (leg.kind === 'option') {
    const month = monthOf(chain, leg.expiry);
    if (month) {
      const marks = rowMarks(ui.marks);
      if (!month.syntheticOk) marks.push('forward_from_future');
      const out: UiLeg = { id: ui.id, leg, marks };
      if (ui.optionMarket) {
        // 手入力の足: 市場を持ち続ける（評価は板の限月が優先）。F は入れた値だけ残す
        const saved = ui.optionMarket.market;
        out.optionMarket = {
          expiry: leg.expiry,
          market: {
            sqTime: saved.sqTime,
            forward: userForwardOf(ui) ? saved.forward : Number.NaN,
            smile: null,
          },
        };
      }
      return out;
    }
    // 板の足で限月が無くなった: 作り直せない（行のエラー）
    if (!ui.optionMarket) return ui;
    const userForward = userForwardOf(ui);
    const saved = ui.optionMarket.market;
    const forward = userForward ? saved.forward : (chain.future.price ?? Number.NaN);
    const sqTime = calendarSqTime(leg.expiry, holidays) ?? saved.sqTime;
    const marks = rowMarks(ui.marks);
    marks.push('no_board');
    if (!userForward) marks.push('forward_from_future');
    return {
      ...ui,
      marks,
      optionMarket: { expiry: leg.expiry, market: { sqTime, forward, smile: null } },
    };
  }

  const contract = leg.contract;
  const marks = rowMarks(ui.marks);
  let sqTime: number | null;
  let price: number | null;
  if (contract === chain.future.id) {
    sqTime = chain.future.sqTime;
    price = chain.future.price;
  } else {
    marks.push('future_manual');
    const opt = monthOf(chain, contract);
    sqTime = opt ? opt.sqTime : calendarSqTime(contract, holidays);
    price = opt?.syntheticOk ? opt.F : chain.future.price;
  }
  if (sqTime === null) return ui;
  if (price === null || !Number.isFinite(price)) {
    marks.push('no_price');
    price = leg.entry;
  }
  return { ...ui, marks, futureMarket: { contract, market: { sqTime, price } } };
}

/** 全ての足の市場を今の板から作り直す（足の順・id・建値は変えない）。 */
export function refreshLegMarkets(
  chain: Chain,
  legs: readonly UiLeg[],
  holidays: Holidays,
): UiLeg[] {
  return legs.map((l) => refreshLegMarket(chain, l, holidays));
}

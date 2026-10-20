/**
 * AI の道具 technicals（#200）の見本・テスト用の合成の先物の足（架空の値。決まった式と種つきの疑似乱数。実データではない）。
 * 日足（取引日の 00:00 JST）約 2 年と、1 時間足（立会の時間だけ。日中 08〜15 時・夜間 17〜翌 05 時）約 120 日。土日は無い
 * （休業日の表は持たない）。限月 m は 3・6・9・12 月の決まった並び（値は限月で跳ばない）。
 */

import type { FutBar } from '../data/futureBars';
import type { TechnicalsData } from '../ui/view/aiTechnicals';

const DAY_S = 86400;
const JST_S = 9 * 3600;

/** 決まった疑似乱数（線形合同法） */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;
const contractOf = (day: number) => {
  const d = new Date(day * DAY_S * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) * 3 + 3;
  return `${d.getUTCFullYear()}-${String(q).padStart(2, '0')}`;
};

/** 終わりの日（JST の暦日の通し番号）から days 暦日ぶんの合成の足 */
export function synthTechnicalsData(
  endDay = Date.UTC(2026, 9, 13) / 1000 / DAY_S,
  dailyDays = 730,
  hourlyDays = 120,
  seed = 7,
): TechnicalsData {
  const r = lcg(seed);
  const daily: FutBar[] = [];
  const hourly: FutBar[] = [];
  let c = 36000;
  for (let day = endDay - dailyDays + 1; day <= endDay; day++) {
    const wd = weekday(day);
    if (wd === 0 || wd === 6) continue;
    const trend = 0.0004 * Math.sin((2 * Math.PI * day) / 90);
    const hoursOf = day > endDay - hourlyDays;
    const o = c;
    let h = c;
    let l = c;
    const hours = [
      8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ];
    for (const hr of hours) {
      const ho = c;
      c = Math.round((c * (1 + trend / hours.length + (r() - 0.5) * 0.004)) / 5) * 5;
      const hh = Math.max(ho, c) + Math.round(r() * 30);
      const hl = Math.min(ho, c) - Math.round(r() * 30);
      h = Math.max(h, hh);
      l = Math.min(l, hl);
      if (hoursOf) {
        hourly.push({
          t: day * DAY_S - JST_S + hr * 3600,
          o: ho,
          h: hh,
          l: hl,
          c,
          m: contractOf(day),
        });
      }
    }
    // 日足の t は取引日の 00:00 JST（夜間は翌日の取引日に入るが、合成では同じ日にまとめる）
    daily.push({ t: day * DAY_S - JST_S, o, h, l, c, m: contractOf(day) });
  }
  return { daily, hourly };
}

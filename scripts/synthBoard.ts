/**
 * 合成の板 JSON（開発の既定・テストの固定の板）を作る。値はすべて架空（JPX の実データは使わない）。
 *
 * Black-76 + SVI のスマイルから理論価格を作り、呼値で丸めて bid / ask を付ける（tests/support/synthChain.ts）。
 * そこに実データの「形」（設計 4 章・付録 A）を真似た欠損を足す:
 * - 2 限月（1 限月は先物と限月違い、2 限月は先物と同じ限月）+ 先物 1 本（直近四半期）
 * - ファー OTM の翼（put は両限月とも −55% まで。call は +30% まで）
 * - 片側気配・気配なし（2 限月の 40% 超の put、20% 超の call は ask だけ）、気配の無い行
 * - JPX の IV（bid_iv / ask_iv）が欠けた行、約定（price・iv・JPX グリーク）は一部の行だけ
 * - 不安定な行（ask ≤ 5 円、IV の分解能の帯 > 5pt）は翼に自然に出る
 *
 * 生成は決定的（種固定）。`npm run fixtures` が fixtures/synthetic/ に書き、
 * `npm run fixtures:check`（CI）がコミット済みのファイルと一致するか検査する。
 */

import { type ChainJson, type ChainRow, type ChainSide, SCHEMA_VERSION } from '../data/chainTypes';
import { black76Greeks, black76Price, type OptionType } from '../model/black76';
import { impliedVol } from '../model/iv';
import { roundOptionPrice } from '../model/tick';
import { jstInstant, sqInstant, yearFraction } from '../model/time';
import type { Quote } from '../model/types';
import { makeSvi, rng, sviTotalVariance, synthChain } from '../tests/support/synthChain';

export interface MonthSpec {
  contractMonth: string;
  lastTradingDay: string;
  sqDate: string;
  /** 真の F（合成先物） */
  F: number;
  /** ATM の IV と 40% OTM put の IV（SVI を決める） */
  atmVol: number;
  leftVol: number;
  /** 行使価格の範囲（F からの割合） */
  lowPct: number;
  highPct: number;
  seed: number;
  spreadTicks?: [number, number];
  /** ATM ±5% のスプレッド（片側の呼値数。夜間の広いスプレッド） */
  atmSpreadTicks?: [number, number];
  /** 気配なしにする行（F からの比 K/F に最も近い行使価格） */
  dropAt?: number[];
  /** JPX の bid_iv / ask_iv を欠かす行（気配はある。OTM 側だけ） */
  ivMissingAt?: number[];
  /** put の OTM 度がこれを超える行は片側・気配なしが混じる（null なら無し） */
  putWingSparseFrom: number | null;
  /** call の OTM 度がこれを超える行は ask だけ */
  callWingAskOnlyFrom: number;
  /** 約定のある側の割合 */
  tradeRatio: number;
  /** 建玉を入れるか（夜間序盤は全行 null） */
  positions: boolean;
}

export interface ChainSpec {
  /** 出力ファイル名（拡張子なし） */
  name: string;
  /** スナップショット時刻（JST の 'YYYY-MM-DD'・時・分） */
  snapshot: { date: string; hour: number; minute: number };
  reason: ChainJson['reason'];
  spot: { price: number; date: string; hour: number; minute: number };
  future: {
    price: number | null;
    /** 先物の約定時刻（スナップショットの何分前か） */
    minutesBefore: number;
    contractMonth: string;
    lastTradingDay: string;
    sqDate: string;
  };
  /** 清算値の日付（null なら清算値を入れない） */
  quotationDate: string | null;
  r: number;
  months: MonthSpec[];
}

const NOV = { contractMonth: '2026-11', lastTradingDay: '2026-11-12', sqDate: '2026-11-13' };
const DEC = { contractMonth: '2026-12', lastTradingDay: '2026-12-10', sqDate: '2026-12-11' };

/** 固定の板のパターン。値は架空（2026-10-13 の板に「似せた」だけ）。 */
export const SPECS: readonly ChainSpec[] = [
  {
    // 夜間 21:31。最新の使える板（開発の既定）
    name: 'latest',
    snapshot: { date: '2026-10-13', hour: 21, minute: 31 },
    reason: 'latest',
    spot: { price: 67777, date: '2026-10-13', hour: 15, minute: 45 },
    future: { price: 67880, minutesBefore: 6, ...DEC },
    quotationDate: '2026-10-13',
    r: 0.005,
    months: [
      {
        ...NOV,
        F: 67810,
        atmVol: 0.25,
        leftVol: 0.62,
        lowPct: 0.55,
        highPct: 0.3,
        seed: 101,
        dropAt: [1.06, 0.88],
        ivMissingAt: [0.95, 1.03],
        putWingSparseFrom: null,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.25,
        positions: true,
      },
      {
        ...DEC,
        F: 67885,
        atmVol: 0.255,
        leftVol: 0.55,
        lowPct: 0.55,
        highPct: 0.3,
        seed: 202,
        dropAt: [0.84],
        ivMissingAt: [0.97],
        putWingSparseFrom: 0.4,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.15,
        positions: true,
      },
    ],
  },
  {
    // 夜間の序盤 17:01。行使価格が少なく、ATM のスプレッドが広い、建玉は全行 null、約定はほぼ無い
    name: 'night_early',
    snapshot: { date: '2026-10-13', hour: 17, minute: 1 },
    reason: 'latest',
    spot: { price: 67777, date: '2026-10-13', hour: 15, minute: 45 },
    future: { price: 67900, minutesBefore: 0, ...DEC },
    quotationDate: '2026-10-13',
    r: 0.005,
    months: [
      {
        ...NOV,
        F: 67830,
        atmVol: 0.252,
        leftVol: 0.7,
        lowPct: 0.25,
        highPct: 0.15,
        seed: 303,
        atmSpreadTicks: [10, 16],
        putWingSparseFrom: null,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.03,
        positions: false,
      },
      {
        ...DEC,
        F: 67905,
        atmVol: 0.256,
        leftVol: 0.55,
        lowPct: 0.25,
        highPct: 0.15,
        seed: 404,
        atmSpreadTicks: [10, 16],
        putWingSparseFrom: 0.4,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.03,
        positions: false,
      },
    ],
  },
  {
    // 寄り前に API が返す「板寄せ前の最後のスナップショット」（日中 15:40。reason = pre_open。設計 7.2・Q5）
    name: 'pre_open',
    snapshot: { date: '2026-10-13', hour: 15, minute: 40 },
    reason: 'pre_open',
    spot: { price: 67720, date: '2026-10-13', hour: 15, minute: 40 },
    future: { price: 67700, minutesBefore: 1, ...DEC },
    quotationDate: '2026-10-09',
    r: 0.005,
    months: [
      {
        ...NOV,
        F: 67640,
        atmVol: 0.248,
        leftVol: 0.62,
        lowPct: 0.55,
        highPct: 0.3,
        seed: 505,
        dropAt: [1.07],
        ivMissingAt: [0.96],
        putWingSparseFrom: null,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.25,
        positions: true,
      },
      {
        ...DEC,
        F: 67705,
        atmVol: 0.253,
        leftVol: 0.55,
        lowPct: 0.55,
        highPct: 0.3,
        seed: 606,
        putWingSparseFrom: 0.4,
        callWingAskOnlyFrom: 0.2,
        tradeRatio: 0.15,
        positions: true,
      },
    ],
  },
];

/** 行使価格: ATM ±10% は 125 円、±25% は 250 円、その外は 1,000 円刻み（実際は 500〜2,500 円の飛び）。 */
export function fixtureStrikes(F: number, lowPct: number, highPct: number): number[] {
  const out: number[] = [];
  const start = Math.floor((F * (1 - lowPct)) / 1000) * 1000;
  const end = F * (1 + highPct);
  for (let k = start; k <= end; ) {
    out.push(k);
    const m = Math.abs(k / F - 1);
    const step = m < 0.1 ? 125 : m < 0.25 ? 250 : 1000;
    // 刻みが変わる境目で格子からずれないよう、次の刻みの倍数に揃える
    k = Math.floor(k / step) * step + step;
  }
  return out;
}

function nearestStrike(strikes: readonly number[], target: number): number {
  let best = strikes[0] as number;
  for (const k of strikes) if (Math.abs(k - target) < Math.abs(best - target)) best = k;
  return best;
}

/** 小数 d 桁に丸める（−0 を出さない）。 */
function round(v: number, d: number): number {
  const s = 10 ** d;
  const x = Math.round(v * s) / s;
  return x === 0 ? 0 : x;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch ミリ秒を JST の ISO 8601（+09:00）に。 */
export function isoJst(t: number): string {
  const d = new Date(t + 9 * 3_600_000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`
  );
}

function ivPct(type: OptionType, price: number | null, F: number, K: number, T: number, r: number) {
  if (price === null || !(price > 0)) return null;
  const res = impliedVol(type, price, F, K, T, r);
  return res.ok ? round(res.sigma * 100, 2) : null;
}

interface SideContext {
  type: OptionType;
  k: number;
  F: number;
  T: number;
  r: number;
  vol: number;
  quote: Quote;
  snapshot: number;
  spec: MonthSpec;
  quotationDate: string | null;
  ivMissing: boolean;
  isAtm: boolean;
  rand: () => number;
}

function makeSide(c: SideContext): ChainSide {
  const { type, k, F, T, r, vol, quote, spec, rand } = c;
  const theo = black76Price(type, F, k, T, vol, r);
  const hasQuote = quote.bid !== null || quote.ask !== null;
  const traded = hasQuote && rand() < spec.tradeRatio;
  const mid =
    quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : (quote.ask ?? null);
  const price = traded && mid !== null ? Math.max(roundOptionPrice(mid), 1) : null;
  const greeks = traded ? black76Greeks(type, F, k, T, vol, r) : null;
  const otm = type === 'put' ? 1 - k / F : k / F - 1;
  // 建玉: ATM 付近と put の翼に厚く、ITM は薄い（架空の形）
  const oi = spec.positions
    ? Math.round((otm >= -0.02 ? 3000 * Math.exp(-Math.abs(otm) * 4) + 200 : 50) * (0.5 + rand()))
    : null;
  return {
    bid: quote.bid,
    ask: quote.ask,
    bid_iv: c.ivMissing ? null : ivPct(type, quote.bid, F, k, T, r),
    ask_iv: c.ivMissing ? null : ivPct(type, quote.ask, F, k, T, r),
    price,
    price_time:
      price === null ? null : isoJst(c.snapshot - (1 + Math.floor(rand() * 120)) * 60_000),
    iv: price === null ? null : ivPct(type, price, F, k, T, r),
    volume: price === null ? null : 1 + Math.floor(rand() * 400),
    positions: oi,
    quotation: c.quotationDate === null ? null : Math.max(roundOptionPrice(theo), 1),
    quotation_date: c.quotationDate,
    // JPX グリークの単位は未確定（AC7）。合成では Black-76 の δ・Γ（1 円あたり）・Θ（円 / 暦日）・V（円 / IV 1pt）
    delta: greeks ? round(greeks.delta, 4) : null,
    gamma: greeks ? round(greeks.gamma, 8) : null,
    theta: greeks ? round(greeks.theta / 365, 4) : null,
    vega: greeks ? round(greeks.vega / 100, 4) : null,
    is_atm: c.isAtm,
  };
}

function buildMonth(spec: MonthSpec, snapshot: number, r: number, quotationDate: string | null) {
  const T = yearFraction(snapshot, sqInstant(spec.sqDate));
  const strikes = fixtureStrikes(spec.F, spec.lowPct, spec.highPct);
  const svi = makeSvi(T, spec.atmVol, spec.leftVol);
  const drop = (spec.dropAt ?? []).map((x) => nearestStrike(strikes, spec.F * x));
  const ivMissing = new Set(
    (spec.ivMissingAt ?? []).map((x) => nearestStrike(strikes, spec.F * x)),
  );
  const atmK = nearestStrike(strikes, spec.F);
  const synthOpts: Parameters<typeof synthChain>[0] = {
    F: spec.F,
    T,
    r,
    strikes,
    svi,
    seed: spec.seed,
    drop,
  };
  if (spec.spreadTicks) synthOpts.spreadTicks = spec.spreadTicks;
  if (spec.atmSpreadTicks) synthOpts.atmSpreadTicks = spec.atmSpreadTicks;
  const chain = synthChain(synthOpts);
  const rand = rng(spec.seed * 7919 + 13);
  const rows: ChainRow[] = chain.rows.map((row) => {
    const vol = Math.sqrt(sviTotalVariance(svi, Math.log(row.k / spec.F)) / T);
    const call = { ...row.call };
    const put = { ...row.put };
    const putOtm = 1 - row.k / spec.F;
    const callOtm = row.k / spec.F - 1;
    if (spec.putWingSparseFrom !== null && putOtm > spec.putWingSparseFrom) {
      // 使えない翼: 両側 3 割、ask だけ 5 割、気配なし 2 割
      const u = rand();
      if (u >= 0.3) put.bid = null;
      if (u >= 0.8) put.ask = null;
    }
    if (callOtm > spec.callWingAskOnlyFrom) call.bid = null;
    const side = (type: OptionType, q: Quote): ChainSide =>
      makeSide({
        type,
        k: row.k,
        F: spec.F,
        T,
        r,
        vol,
        quote: q,
        snapshot,
        spec,
        quotationDate,
        // IV 欠損は OTM 側の気配だけ（K < F は put、それ以外は call）
        ivMissing: ivMissing.has(row.k) && (type === 'put') === row.k < spec.F,
        isAtm: row.k === atmK,
        rand,
      });
    return { k: row.k, call: side('call', call), put: side('put', put) };
  });
  return {
    contract_month: spec.contractMonth,
    last_trading_day: spec.lastTradingDay,
    sq_date: spec.sqDate,
    rows,
  };
}

/** 仕様から板の JSON を作る。 */
export function buildChainJson(spec: ChainSpec): ChainJson {
  const snapshot = jstInstant(spec.snapshot.date, spec.snapshot.hour, spec.snapshot.minute);
  return {
    schema_version: SCHEMA_VERSION,
    snapshot_at: isoJst(snapshot),
    delayed_minutes: 15,
    reason: spec.reason,
    source: 'synthetic',
    spot: {
      price: spec.spot.price,
      price_time: isoJst(jstInstant(spec.spot.date, spec.spot.hour, spec.spot.minute)),
    },
    future: {
      price: spec.future.price,
      price_time:
        spec.future.price === null ? null : isoJst(snapshot - spec.future.minutesBefore * 60_000),
      contract_month: spec.future.contractMonth,
      last_trading_day: spec.future.lastTradingDay,
      sq_date: spec.future.sqDate,
    },
    months: spec.months.map((m) => buildMonth(m, snapshot, spec.r, spec.quotationDate)),
  };
}

/** JSON の書き出し: 見出しは字下げ、行は 1 行 1 行使価格（差分を読みやすく、サイズを抑える）。 */
export function serializeChainJson(json: ChainJson): string {
  const { months, ...head } = json;
  const lines: string[] = ['{'];
  for (const [key, value] of Object.entries(head)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "months": [');
  months.forEach((m, mi) => {
    const { rows, ...mh } = m;
    lines.push('    {');
    for (const [key, value] of Object.entries(mh)) {
      lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    lines.push('      "rows": [');
    rows.forEach((row, ri) => {
      lines.push(`        ${JSON.stringify(row)}${ri + 1 < rows.length ? ',' : ''}`);
    });
    lines.push('      ]');
    lines.push(`    }${mi + 1 < months.length ? ',' : ''}`);
  });
  lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** 書き出すファイル（fixtures/synthetic/ からの相対パス → 中身）。 */
export function buildFixtureFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of SPECS) out[`${spec.name}.json`] = serializeChainJson(buildChainJson(spec));
  return out;
}

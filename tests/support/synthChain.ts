/**
 * テスト用の合成の板（架空の値）。Black-76 + スマイル（SVI の raw 形）+ 呼値丸め + bid / ask スプレッド。
 * 実データ（JPX 由来）は使わない。乱数は種つきで再現可能。
 */

import { black76Price } from '../../model/black76';
import { roundOptionPrice, shiftOptionTicks } from '../../model/tick';
import type { Quote, StrikeRow } from '../../model/types';

/** 種つきの擬似乱数（mulberry32）。[0, 1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  s: number;
}

/** SVI の総分散 w(x) = a + b (ρ (x − m) + √((x − m)² + s²))。 */
export function sviTotalVariance(p: SviParams, x: number): number {
  const d = x - p.m;
  return p.a + p.b * (p.rho * d + Math.sqrt(d * d + p.s * p.s));
}

/**
 * ATM の IV と翼の IV から SVI を決める（ρ・m・s は固定、a・b を 2 点で解く）。
 * 既定は 1 限月らしい形: ATM 25%、40% OTM put で 70% 前後、call 側はほぼ平ら（ρ = −0.7）。
 * ρ を大きく（例 −0.5）すると call の翼の IV が上がる。
 */
export function makeSvi(
  T: number,
  atmVol = 0.25,
  leftVol = 0.7,
  leftX = Math.log(0.6),
  rho = -0.7,
): SviParams {
  const m = 0;
  const s = 0.1;
  const g = (x: number) => rho * (x - m) + Math.sqrt((x - m) ** 2 + s * s);
  const w0 = atmVol * atmVol * T;
  const wl = leftVol * leftVol * T;
  const b = (wl - w0) / (g(leftX) - g(0));
  const a = w0 - b * g(0);
  return { a, b, rho, m, s };
}

/** 行使価格の列: ATM ±10% は 125 円、±25% は 250 円、その外は 500 円刻み（4.4 の刻みに似せる）。 */
export function makeStrikes(F: number, lowPct = 0.45, highPct = 0.25): number[] {
  const out: number[] = [];
  const start = Math.floor((F * (1 - lowPct)) / 500) * 500;
  const end = Math.ceil((F * (1 + highPct)) / 500) * 500;
  for (let k = start; k <= end; ) {
    out.push(k);
    const m = Math.abs(k / F - 1);
    k += m < 0.1 ? 125 : m < 0.25 ? 250 : 500;
  }
  return out;
}

export interface SynthOptions {
  F: number;
  T: number;
  r: number;
  strikes?: number[];
  svi?: SviParams;
  seed?: number;
  /** bid / ask を丸めた理論価格から何呼値ずらすか（片側。既定 1〜3） */
  spreadTicks?: [number, number];
  /** ATM ±5% の行だけスプレッドを広げる（夜間 ATM 150 円 = 30 呼値のケース。片側の呼値数） */
  atmSpreadTicks?: [number, number];
  /** 外れ値: この行使価格の call の bid / ask を shift 円ずらす */
  outlier?: { k: number; shift: number };
  /** これらの行使価格の気配を消す（欠損行） */
  drop?: number[];
  /**
   * 丸めない板: bid / ask = 理論価格 ∓ exactHalfSpread 円（mid = 理論価格）。
   * 呼値丸めは mid の段階で K の凸性を ±2.5 円崩す（ATM のバタフライは 125 円刻みで 1 円程度）ので、
   * 補間器そのものの性質（AC4 の単調性・バタフライ）を見るときに使う
   */
  exactHalfSpread?: number;
}

export interface SynthChain {
  rows: StrikeRow[];
  /** 生成に使った真の IV（行使価格 → σ） */
  trueVol: Map<number, number>;
  svi: SviParams;
}

function quoteFor(theo: number, lo: number, hi: number, rand: () => number): Quote {
  const p = roundOptionPrice(theo);
  const nb = lo + Math.floor(rand() * (hi - lo + 1));
  const na = lo + Math.floor(rand() * (hi - lo + 1));
  const ask = Math.max(shiftOptionTicks(p, na), 1);
  const bidRaw = shiftOptionTicks(p, -nb);
  const bid = bidRaw >= 1 && bidRaw < ask ? bidRaw : null;
  return { bid, ask, last: null };
}

function exactQuote(theo: number, half: number): Quote {
  return { bid: theo - half > 0 ? theo - half : null, ask: theo + half, last: null };
}

export function synthChain(o: SynthOptions): SynthChain {
  const strikes = o.strikes ?? makeStrikes(o.F);
  const svi = o.svi ?? makeSvi(o.T);
  const rand = rng(o.seed ?? 1);
  const [lo, hi] = o.spreadTicks ?? [1, 3];
  const trueVol = new Map<number, number>();
  const rows: StrikeRow[] = strikes.map((k) => {
    const x = Math.log(k / o.F);
    const vol = Math.sqrt(sviTotalVariance(svi, x) / o.T);
    trueVol.set(k, vol);
    const c = black76Price('call', o.F, k, o.T, vol, o.r);
    const p = black76Price('put', o.F, k, o.T, vol, o.r);
    const wide = o.atmSpreadTicks && Math.abs(k / o.F - 1) <= 0.05;
    const [l, h] = wide ? (o.atmSpreadTicks as [number, number]) : [lo, hi];
    const exact = o.exactHalfSpread;
    const call = exact !== undefined ? exactQuote(c, exact) : quoteFor(c, l, h, rand);
    const put = exact !== undefined ? exactQuote(p, exact) : quoteFor(p, l, h, rand);
    if (o.outlier && o.outlier.k === k) {
      if (call.bid !== null) call.bid += o.outlier.shift;
      if (call.ask !== null) call.ask += o.outlier.shift;
    }
    if (o.drop?.includes(k)) {
      return {
        k,
        call: { bid: null, ask: null, last: null },
        put: { bid: null, ask: null, last: null },
      };
    }
    return { k, call, put };
  });
  return { rows, trueVol, svi };
}

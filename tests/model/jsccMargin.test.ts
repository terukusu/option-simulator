/**
 * #382 AC1: JSCC の VaR 証拠金（HS-ES）の計算（model/jsccMargin.ts）。値はすべて架空（種つき乱数の合成の表）。
 *
 * - 独立の参照の実装（並べ替えて 1 本ずつ重み min(1, max(0, t − i)) を掛けて足す素朴な版。分数は BigInt）と
 *   種つき乱数の 1,000 ケースで 1 円も違わない
 * - 性質: 手で計算した値、売り買い同数 → 0、全部 0 → 0、正の倍数、H / S の内側の並べ替え、OP の買いだけ → 0、
 *   OP の売り 1 枚の下限（清算値段 × Contract Size）、入力の検査
 */

import { describe, expect, it } from 'vitest';
import {
  type JsccPosition,
  type JsccScenarioSet,
  jsccEsSigned,
  jsccKeyOfLeg,
  jsccVarMargin,
  type Leg,
} from '../../model';
import { realisticSet, rng, smallSet, synthFuture, synthOption } from '../support/synthJscc';

/** 参照の ES（分数 num / den。符号つき = 損失が正） */
function refEsFraction(v: readonly number[], set: JsccScenarioSet): { num: bigint; den: bigint } {
  const hist = v.filter((_, j) => set.isHist[j]);
  const stress = v.filter((_, j) => !set.isHist[j]).sort((a, b) => a - b);
  const xs = [...hist, ...stress.slice(0, set.nStress)].sort((a, b) => a - b);
  const n = xs.length;
  // t = n × (100 − conf) / 100 を 10^6 倍した整数（信頼水準は 1/10^4 % 単位）
  const q = BigInt(Math.round((100 - set.confidence) * 10_000));
  const T = BigInt(n) * q; // t × 10^6
  let num = 0n;
  xs.forEach((x, i) => {
    // 重み × 10^6 = min(10^6, max(0, T − i × 10^6))
    let w = T - BigInt(i) * 1_000_000n;
    if (w > 1_000_000n) w = 1_000_000n;
    if (w < 0n) w = 0n;
    num += w * BigInt(x);
  });
  return { num: -num, den: T };
}

function ceilFrac(num: bigint, den: bigint): number {
  const q = num / den;
  return Number(num > 0n && q * den !== num ? q + 1n : q);
}

const refEs = (v: readonly number[], set: JsccScenarioSet) => {
  const f = refEsFraction(v, set);
  return ceilFrac(f.num, f.den);
};

describe('jsccEsSigned', () => {
  it('手で計算した値（H 40・S 8・ストレス 2 本・97.5%: n = 42、t = 1.05 本）', () => {
    const set = smallSet(40, 8, 2, 97.5);
    const v = [-100, -50, ...Array(38).fill(0), -200, -10, ...Array(6).fill(0)];
    // 小さい順 −200, −100, …: ES = (1 × 200 + 0.05 × 100) / 1.05 = 195.238… → 196
    expect(jsccEsSigned(v, set)).toBe(196);
    expect(refEs(v, set)).toBe(196);
  });

  it('参照の実装と 1,000 ケースで完全一致（種つき乱数。本数・信頼水準・ストレスの本数・値の大きさを振る）', () => {
    const r = rng(382);
    const confs = [97.5, 99, 95, 99.7, 90.25, 97.53];
    for (let c = 0; c < 1000; c++) {
      const nh = 1 + Math.floor(r() * 200);
      const ns = Math.floor(r() * 40);
      const isHist: boolean[] = [...Array(nh).fill(true), ...Array(ns).fill(false)];
      // H と S を混ぜた並び（本物は H が先だが、関数は並びに依らない）
      if (c % 3 === 0) isHist.reverse();
      const set: JsccScenarioSet = {
        isHist,
        confidence: confs[c % confs.length] as number,
        nStress: Math.floor(r() * (ns + 1)),
      };
      const scale = [10, 1e5, 5e7, 1e11][c % 4] as number;
      const v = set.isHist.map(() => Math.round((r() * 2 - 1) * scale));
      expect(jsccEsSigned(v, set)).toBe(refEs(v, set));
    }
  });

  it('全部 0 → 0、正の倍数 m で ceil(m × ES)、H / S の内側の並べ替えで不変', () => {
    const set = smallSet();
    expect(jsccEsSigned(Array(48).fill(0), set)).toBe(0);
    const r = rng(7);
    for (let c = 0; c < 100; c++) {
      const v = set.isHist.map(() => Math.round((r() * 2 - 1) * 1e6));
      const exact = refEsFraction(v, set);
      for (const m of [1, 2, 3, 7, 1000]) {
        expect(
          jsccEsSigned(
            v.map((x) => x * m),
            set,
          ),
        ).toBe(ceilFrac(exact.num * BigInt(m), exact.den));
      }
      const h = v.slice(0, 40).reverse();
      const s = v.slice(40).sort((a, b) => b - a);
      expect(jsccEsSigned([...h, ...s], set)).toBe(jsccEsSigned(v, set));
    }
  });

  it('入力の検査: 長さ・安全な整数・H が無い・S が足りない・信頼水準', () => {
    const set = smallSet(4, 2, 1);
    expect(() => jsccEsSigned([1, 2, 3], set)).toThrow();
    expect(() => jsccEsSigned([1, 2, 3, 4, 5, 0.5], set)).toThrow();
    expect(() => jsccEsSigned([1, 2, 3, 4, 5, 2 ** 60], set)).toThrow();
    expect(() =>
      jsccEsSigned([1, 2], { isHist: [false, false], confidence: 97.5, nStress: 1 }),
    ).toThrow();
    expect(() =>
      jsccEsSigned([1, 2], { isHist: [true, false], confidence: 97.5, nStress: 2 }),
    ).toThrow();
    expect(() =>
      jsccEsSigned([1, 2], { isHist: [true, false], confidence: 100, nStress: 0 }),
    ).toThrow();
  });
});

describe('jsccVarMargin', () => {
  const set = realisticSet();
  const n = set.isHist.length;

  it('同じ銘柄の売り買い同数 → 0（ES 0・NOV_清算 0）、足が無い → 0', () => {
    const r = rng(1);
    const p = synthOption(n, 250, r);
    const out = jsccVarMargin(
      [
        { inst: p, qty: 3, option: true },
        { inst: p, qty: -3, option: true },
      ],
      set,
    );
    expect(out).toEqual({ esSigned: 0, novSettle: 0, varMargin: 0 });
    expect(jsccVarMargin([], set)).toEqual({ esSigned: 0, novSettle: 0, varMargin: 0 });
  });

  it('OP の買いだけ → 0（評価額 ≥ 0 なので ES ≤ 0）', () => {
    const r = rng(2);
    const pos: JsccPosition[] = [1, 2, 3].map((q, i) => ({
      inst: synthOption(n, 50 + i * 100, r),
      qty: q,
      option: true,
    }));
    const out = jsccVarMargin(pos, set);
    expect(out.esSigned).toBeLessThanOrEqual(0);
    expect(out.varMargin).toBe(0);
    expect(out.novSettle).toBe((50 * 1 + 150 * 2 + 250 * 3) * 1000);
  });

  it('OP の売り 1 枚 = max(0, ceil(ES(−pnl)), 清算値段 × Contract Size)（optionchan の 1 枚の計算と同じ形）', () => {
    const r = rng(3);
    for (let c = 0; c < 50; c++) {
      const price = 1 + Math.floor(r() * 2000);
      // 散らばりの小さい（深い OTM の）銘柄は下限が効く
      const inst = synthOption(n, price, r, c % 2 === 0 ? 0.05 : 0.8);
      const out = jsccVarMargin([{ inst, qty: -1, option: true }], set);
      const es = refEs(
        Array.from(inst.pnl, (x) => -x),
        set,
      );
      expect(out.esSigned).toBe(es);
      expect(out.novSettle).toBe(-price * 1000);
      expect(out.varMargin).toBe(Math.max(0, es, price * 1000));
    }
  });

  it('先物は NOV_清算に入らず、枚数・乗数に比例（ラージ 1 = ミニ 10 のシナリオなら同じ額）', () => {
    const r = rng(4);
    const large = synthFuture(n, 1000, r);
    const mini = { ...large, contractSize: 100, pnl: Float64Array.from(large.pnl, (x) => x / 10) };
    const a = jsccVarMargin([{ inst: large, qty: -1, option: false }], set);
    const b = jsccVarMargin([{ inst: mini, qty: -10, option: false }], set);
    expect(a.novSettle).toBe(0);
    expect(b.varMargin).toBe(a.varMargin);
  });

  it('ポートフォリオ = 銘柄ごとの v の和に同じ計算（劣加法: V(全体) ≤ V(部分 1) + V(部分 2) + 1）', () => {
    const r = rng(5);
    for (let c = 0; c < 30; c++) {
      const a: JsccPosition = { inst: synthOption(n, 300, r), qty: -2, option: true };
      const b: JsccPosition = { inst: synthOption(n, 120, r), qty: 1, option: true };
      const f: JsccPosition = { inst: synthFuture(n, 10, r), qty: 3, option: false };
      const all = jsccVarMargin([a, b, f], set);
      const v = new Array(n)
        .fill(0)
        .map(
          (_, j) =>
            -2 * (a.inst.pnl[j] as number) +
            (b.inst.pnl[j] as number) +
            3 * (f.inst.pnl[j] as number),
        );
      expect(all.esSigned).toBe(refEs(v, set));
      const p1 = jsccVarMargin([a], set);
      const p2 = jsccVarMargin([b, f], set);
      // ES は劣加法（切り上げの 1 円を許す）。下限の項（−NOV）も和で増えない
      expect(all.varMargin).toBeLessThanOrEqual(p1.varMargin + p2.varMargin + 1);
    }
  });

  it('枚数が整数でない・清算値段が無い OP・並びと長さが違うと例外', () => {
    const r = rng(6);
    const inst = synthOption(n, 100, r);
    expect(() => jsccVarMargin([{ inst, qty: 1.5, option: true }], set)).toThrow();
    expect(() =>
      jsccVarMargin([{ inst: { ...inst, price: null }, qty: -1, option: true }], set),
    ).toThrow();
    expect(() =>
      jsccVarMargin([{ inst: { ...inst, pnl: new Float64Array(3) }, qty: -1, option: true }], set),
    ).toThrow();
  });
});

describe('jsccKeyOfLeg', () => {
  const op = (o: Partial<Extract<Leg, { kind: 'option' }>> = {}): Leg => ({
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: '2026-12',
    strike: 50000,
    side: 'sell',
    qty: 1,
    entry: 100,
    ...o,
  });
  it('OP・先物 3 商品のキー（API の i= と同じ形）', () => {
    expect(jsccKeyOfLeg(op())).toBe('NK225E-202612-P-50000');
    expect(jsccKeyOfLeg(op({ type: 'call', strike: 51250 }))).toBe('NK225E-202612-C-51250');
    const fut = (product: 'fut_large' | 'fut_mini' | 'fut_micro'): Leg => ({
      kind: 'future',
      product,
      contract: '2027-03',
      side: 'buy',
      qty: 1,
      entry: 50000,
    });
    expect(jsccKeyOfLeg(fut('fut_large'))).toBe('NK225F-202703');
    expect(jsccKeyOfLeg(fut('fut_mini'))).toBe('NK225MF-202703');
    expect(jsccKeyOfLeg(fut('fut_micro'))).toBe('NK225MCF-202703');
  });
  it('限月の形・行使価格が外れたら null', () => {
    expect(jsccKeyOfLeg(op({ expiry: 'M1' }))).toBeNull();
    expect(jsccKeyOfLeg(op({ expiry: '2026-13' }))).toBeNull();
    expect(jsccKeyOfLeg(op({ strike: 50000.5 }))).toBeNull();
    expect(jsccKeyOfLeg(op({ strike: 0 }))).toBeNull();
  });
});

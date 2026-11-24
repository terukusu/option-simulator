/**
 * #382 AC1: JSCC の VaR 証拠金（HS-ES）の計算（model/jsccMargin.ts）。値はすべて架空（種つき乱数の合成の表）。
 *
 * - 独立の参照の実装（並べ替えて 1 本ずつ重み min(1, max(0, t − i)) を掛けて足す素朴な版。分数は BigInt）と
 *   種つき乱数の 1,000 ケースで 1 円も違わない
 * - 性質: 手で計算した値、売り買い同数 → 0、全部 0 → 0、正の倍数、H / S の内側の並べ替え、OP の買いだけ → 0、
 *   OP の売り 1 枚の下限（清算値段 × Contract Size）、入力の検査
 * - #393: 取引最終日まで K 営業日以内の OP の足を下限の NOV から外す（K・K + 1 の境界、遠い限月、ポートフォリオの混在、
 *   先物）。営業日数の数え方は optionchan に確認した 3 例の日付だけ（JSCC の値は使わない）
 */

import { describe, expect, it } from 'vitest';
import {
  JSCC_NOV_FLOOR_EXEMPT_BUSINESS_DAYS,
  type JsccInstrument,
  type JsccPosition,
  type JsccScenarioSet,
  jsccEsSigned,
  jsccKeyOfLeg,
  jsccNovFloorExempt,
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
    expect(out).toEqual({ esSigned: 0, novSettle: 0, novFloor: 0, varMargin: 0 });
    expect(jsccVarMargin([], set)).toEqual({
      esSigned: 0,
      novSettle: 0,
      novFloor: 0,
      varMargin: 0,
    });
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

describe('#393 VaR 証拠金額の下限を外す OP の足（取引最終日まで K 営業日以内）', () => {
  const K = JSCC_NOV_FLOOR_EXEMPT_BUSINESS_DAYS;
  const set = realisticSet();
  const n = set.isHist.length;
  /** SQ 直前の深い OTM の架空の行: シナリオ後の評価額がどれも清算値段 × 1,000 の 10〜60%（売りの ES < 下限） */
  const decaying = (price: number, r: () => number): JsccInstrument => ({
    aggregationGroup: 'IDX_IDX',
    contractSize: 1000,
    price,
    pnl: Float64Array.from({ length: n }, () => Math.round(price * 1000 * (0.1 + 0.5 * r()))),
  });

  it('K は 3（暫定。optionchan #171 の 22 件に合う中でいちばん小さい）', () => {
    expect(K).toBe(3);
  });

  it('営業日数 = 基準日の翌営業日から取引最終日まで両端を含む（optionchan に確認した 3 例。日付だけ）', () => {
    // 2025-04 限の取引最終日 = 04-10（木）、2026-03 限 = 03-12（木）
    // 2025-04-07（月）→ 04-08・04-09・04-10 の 3 日 = K ちょうど → 外す
    expect(jsccNovFloorExempt('2025-04', '2025-04-07', [], 3)).toBe(true);
    expect(jsccNovFloorExempt('2025-04', '2025-04-07', [], 2)).toBe(false);
    // 2025-04-09 → 04-10 の 1 日
    expect(jsccNovFloorExempt('2025-04', '2025-04-09', [], 1)).toBe(true);
    expect(jsccNovFloorExempt('2025-04', '2025-04-09', [], 0)).toBe(false);
    // 2026-03-11 → 03-12 の 1 日
    expect(jsccNovFloorExempt('2026-03', '2026-03-11', [], 1)).toBe(true);
    expect(jsccNovFloorExempt('2026-03', '2026-03-11', [], 0)).toBe(false);
  });

  it('境界: K 営業日は外す、K + 1 営業日は外さない。週末・休業日は数えない', () => {
    // 2025-04 限（取引最終日 04-10 木）。K + 1 = 4 日前の基準日 = 04-04（金）（04-07・08・09・10 の 4 日）
    expect(jsccNovFloorExempt('2025-04', '2025-04-04', [])).toBe(false);
    expect(jsccNovFloorExempt('2025-04', '2025-04-07', [])).toBe(true);
    // 04-08 を休業日にすると 04-04 からは 3 日 → 外す
    expect(jsccNovFloorExempt('2025-04', '2025-04-04', ['2025-04-08'])).toBe(true);
    // 取引最終日の当日・その後（SQ の前）は 0 日 → 外す
    expect(jsccNovFloorExempt('2025-04', '2025-04-10', [])).toBe(true);
    expect(jsccNovFloorExempt('2025-04', '2025-04-11', [])).toBe(true);
    // 遠い限月（1 年先）は外さない
    expect(jsccNovFloorExempt('2026-04', '2025-04-07', [])).toBe(false);
    // 当月限でも 1 か月前は外さない
    expect(jsccNovFloorExempt('2025-04', '2025-03-10', [])).toBe(false);
  });

  it('休業日の取引最終日（SQ の繰り上げ）も取引カレンダーの規則で決める', () => {
    // 2025-04-11（金。SQ）を休業日にすると SQ = 04-10、取引最終日 = 04-09。04-04 から 04-07・08・09 の 3 日 → 外す
    expect(jsccNovFloorExempt('2025-04', '2025-04-04', ['2025-04-11'])).toBe(true);
    expect(jsccNovFloorExempt('2025-04', '2025-04-03', ['2025-04-11'])).toBe(false);
  });

  it('形が外れた限月・基準日は外さない（下限を残す側）', () => {
    expect(jsccNovFloorExempt('2025-4', '2025-04-09', [])).toBe(false);
    expect(jsccNovFloorExempt('2025-13', '2025-04-09', [])).toBe(false);
    expect(jsccNovFloorExempt('2025-04', '20250409', [])).toBe(false);
  });

  it('外す足の売り 1 枚: 下限なし = max(0, ES)。外さない足は下限あり = max(0, ES, 清算値段 × Contract Size)', () => {
    const r = rng(393);
    let floored = 0;
    for (let c = 0; c < 50; c++) {
      const price = 1 + Math.floor(r() * 500);
      // 半分は SQ 直前の深い OTM（ES が下限を下回る）、半分はふつうの散らばり
      const inst = c % 2 === 0 ? decaying(price, r) : synthOption(n, price, r);
      const es = refEs(
        Array.from(inst.pnl, (x) => -x),
        set,
      );
      const near = jsccVarMargin([{ inst, qty: -1, option: true, floorExempt: true }], set);
      const far = jsccVarMargin([{ inst, qty: -1, option: true, floorExempt: false }], set);
      expect(near.esSigned).toBe(es);
      expect(near.novSettle).toBe(-price * 1000);
      expect(near.novFloor).toBe(0);
      expect(near.varMargin).toBe(Math.max(0, es));
      expect(far.novFloor).toBe(-price * 1000);
      expect(far.varMargin).toBe(Math.max(0, es, price * 1000));
      // 下限を外しても V は増えない（max の項が減るだけ）
      expect(near.varMargin).toBeLessThanOrEqual(far.varMargin);
      if (far.varMargin > near.varMargin) floored++;
    }
    expect(floored).toBeGreaterThan(0); // 下限が効く例が実際にある（テストが空振りしない）
  });

  it('ポートフォリオに混ざる: 外す足の NOV だけが下限から抜け、ES・NOV_清算は全部の足', () => {
    const r = rng(394);
    for (let c = 0; c < 30; c++) {
      const near: JsccPosition = {
        inst: decaying(200, r),
        qty: -2,
        option: true,
        floorExempt: true,
      };
      const far: JsccPosition = {
        inst: decaying(80, r),
        qty: -1,
        option: true,
        floorExempt: false,
      };
      const fut: JsccPosition = { inst: synthFuture(n, 10, r), qty: 1, option: false };
      const all = jsccVarMargin([near, far, fut], set);
      const base = jsccVarMargin(
        [
          { ...near, floorExempt: false },
          { ...far, floorExempt: false },
          { ...fut, floorExempt: true }, // 先物の floorExempt は効かない（NOV に入らない）
        ],
        set,
      );
      expect(all.esSigned).toBe(base.esSigned);
      expect(all.novSettle).toBe(base.novSettle);
      expect(all.novSettle).toBe(-2 * 200 * 1000 - 80 * 1000);
      expect(all.novFloor).toBe(-80 * 1000);
      expect(all.varMargin).toBe(Math.max(0, all.esSigned, 80 * 1000));
      expect(base.varMargin).toBe(Math.max(0, base.esSigned, 480 * 1000));
    }
  });

  it('買いの OP を外すと下限の NOV は小さくなる側（下限が上がりうる）= 足ごとに外すだけ', () => {
    const r = rng(395);
    const sell: JsccPosition = { inst: decaying(300, r), qty: -1, option: true };
    const buyNear: JsccPosition = {
      inst: decaying(100, r),
      qty: 1,
      option: true,
      floorExempt: true,
    };
    const out = jsccVarMargin([sell, buyNear], set);
    expect(out.novSettle).toBe(-300 * 1000 + 100 * 1000);
    expect(out.novFloor).toBe(-300 * 1000);
    expect(out.varMargin).toBeGreaterThanOrEqual(300 * 1000);
  });
});

describe('jsccKeyOfLeg', () => {
  const op = (o: Partial<Extract<Leg, { kind: 'option' }>> = {}): Leg => ({
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: '2026-12',
    strike: 45000,
    side: 'sell',
    qty: 1,
    entry: 100,
    ...o,
  });
  it('OP・先物 3 商品のキー（API の i= と同じ形）', () => {
    expect(jsccKeyOfLeg(op())).toBe('NK225E-202612-P-45000');
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
    expect(jsccKeyOfLeg(op({ strike: 45000.5 }))).toBeNull();
    expect(jsccKeyOfLeg(op({ strike: 0 }))).toBeNull();
  });
});

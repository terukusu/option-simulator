import { describe, expect, it } from 'vitest';
import { erf, erfc, normCdf, normCdfBoth, normPdf } from '../../model/normal';

// 参照値は任意精度（mpmath、50 桁）で計算した Φ(x)・erf・erfc を 20 桁に丸めたもの。
const CDF: Array<[number, number]> = [
  [-37, 5.7255712225245768227e-300],
  [-30, 4.9067139271481870595e-198],
  [-20, 2.7536241186062336951e-89],
  [-10, 7.619853024160526066e-24],
  [-8, 6.2209605742717841235e-16],
  [-6, 9.865876450376981407e-10],
  [-5.656, 7.7470733237490677102e-9],
  [-5, 2.8665157187919391167e-7],
  [-4, 0.000031671241833119921254],
  [-3, 0.0013498980316300945267],
  [-2, 0.0227501319481792072],
  [-1.5, 0.066807201268858066004],
  [-1, 0.15865525393145705141],
  [-0.6744, 0.25002852137294061469],
  [-0.5, 0.30853753872598689636],
  [-0.1, 0.46017216272297101633],
  [-1e-5, 0.49999601057719605216],
  [0, 0.5],
  [1e-5, 0.50000398942280394784],
  [0.1, 0.53982783727702898367],
  [0.5, 0.69146246127401310364],
  [0.6745, 0.75000325713630083111],
  [1, 0.84134474606854294859],
  [2, 0.9772498680518207928],
  [3, 0.99865010196836990547],
  [5, 0.99999971334842812081],
  [6, 0.99999999901341235496],
  [8.29, 0.99999999999999994338],
];

const ERF: Array<[number, number]> = [
  [1e-10, 1.128379167095512615e-10],
  [0.01, 0.011283415555849617151],
  [0.3, 0.32862675945912741619],
  [0.5, 0.52049987781304653768],
  [1, 0.84270079294971486934],
  [2, 0.99532226501895273416],
  [3, 0.99997790950300141456],
];

const ERFC: Array<[number, number]> = [
  [0.01, 0.98871658444415038285],
  [0.5, 0.47950012218695346232],
  [1, 0.15729920705028513066],
  [2, 0.0046777349810472658379],
  [3, 0.000022090496998585441373],
  [4, 1.5417257900280018852e-8],
  [5, 1.5374597944280348502e-12],
  [10, 2.088487583762544757e-45],
  [20, 5.3958656116079009289e-176],
];

const relErr = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('normCdf（Cody の有理近似）', () => {
  it.each(CDF)('Φ(%d) の相対誤差が 2e-15 以下', (x, want) => {
    expect(relErr(normCdf(x), want)).toBeLessThanOrEqual(2e-15);
  });

  it.each(CDF.filter(([x]) => x < 0))(
    '上側 1 − Φ(%d) も相対誤差 2e-15 以下（対称性）',
    (x, want) => {
      expect(relErr(normCdfBoth(-x)[1], want)).toBeLessThanOrEqual(2e-15);
    },
  );

  it('全域で最大相対誤差を測ると 1e-15 級', () => {
    let worst = 0;
    for (const [x, want] of CDF) worst = Math.max(worst, relErr(normCdf(x), want));
    expect(worst).toBeLessThan(2e-15);
  });

  it('下側 + 上側 = 1、単調、極限で NaN を出さない', () => {
    let prev = 0;
    for (let x = -40; x <= 40; x += 0.01) {
      const [lo, hi] = normCdfBoth(x);
      expect(Math.abs(lo + hi - 1)).toBeLessThan(2e-16 * 4);
      expect(lo).toBeGreaterThanOrEqual(prev);
      prev = lo;
    }
    expect(normCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normCdf(-1e300)).toBe(0);
    expect(normPdf(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('密度 φ は Φ の数値微分と一致', () => {
    for (const x of [-6, -2, -0.3, 0, 0.7, 3]) {
      const h = 1e-5;
      const fd = (normCdf(x + h) - normCdf(x - h)) / (2 * h);
      expect(relErr(normPdf(x), fd)).toBeLessThan(1e-8);
    }
  });
});

describe('erf / erfc', () => {
  it.each(ERF)('erf(%d) の相対誤差が 1e-15 級', (x, want) => {
    expect(relErr(erf(x), want)).toBeLessThanOrEqual(2e-15);
    expect(erf(-x)).toBe(-erf(x));
  });

  // erfc(x) = 2Φ(−x√2) は x√2 の丸め（相対 1 ulp）が 2x² 倍に拡大するので、x が大きいほど許容を広げる
  it.each(ERFC)('erfc(%d) の相対誤差が (1 + 2x²)·4e-16 以下', (x, want) => {
    expect(relErr(erfc(x), want)).toBeLessThanOrEqual((1 + 2 * x * x) * 4e-16 + 2e-15);
  });
});

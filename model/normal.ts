/**
 * 標準正規分布の密度・累積分布、erf / erfc。
 *
 * 累積分布は W. J. Cody の有理 Chebyshev 近似（"Rational Chebyshev approximations for the
 * error function", Math. Comp. 23 (1969) 631–637。ACM TOMS Algorithm 715 の ANORM と同じ係数）。
 * erfc 型の評価を x に対して直接行い、exp(−x²/2) は x を 1/16 刻みで分割して桁落ちを抑える。
 * 相対誤差はテスト（tests/model/normal.test.ts）で 1e-15 級に固定している。
 */

const A = [
  2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582, 18154.981253343561249,
  0.065682337918207449113,
] as const;
const B = [
  47.20258190468824187, 976.09855173777669322, 10260.932208618978205, 45507.789335026729956,
] as const;
const C = [
  0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979, 597.27027639480026226,
  2494.5375852903726711, 6848.1904505362823326, 11602.651437647350124, 9842.7148383839780218,
  1.0765576773720192317e-8,
] as const;
const D = [
  22.266688044328115691, 235.38790178262499861, 1519.377599407554805, 6485.558298266760755,
  18615.571640885098091, 34900.952721145977266, 38912.003286093271411, 19685.429676859990727,
] as const;
const P = [
  0.21589853405795699, 0.1274011611602473639, 0.022235277870649807, 0.001421619193227893466,
  2.9112874951168792e-5, 0.02307344176494017303,
] as const;
const Q = [
  1.28426009614491121, 0.468238212480865118, 0.0659881378689285515, 0.00378239633202758244,
  7.29751555083966205e-5,
] as const;

const SQRT_32 = 5.656854249492380195206754896838;
const INV_SQRT_2PI = 0.398942280401432677939946059934;
const HALF_EPS = Number.EPSILON * 0.5;

/** exp(−y²/2) を y の上位（1/16 刻み）と残りに分けて計算する（大きい y で相対精度を保つ）。 */
function expHalfSquare(y: number): number {
  // y < 2 では y²/2 の丸め誤差（相対 ε）が exp の相対誤差 ≤ 2ε にしかならないので 1 回で済ませる
  if (y < 2) return Math.exp(-0.5 * y * y);
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  return Math.exp(-ysq * ysq * 0.5) * Math.exp(-del * 0.5);
}

const CENTRAL = 0.67448975;

/** |x| ≤ 0.674 のときの Φ(x) − 1/2。 */
function centralPart(x: number): number {
  let xnum = 0;
  let xden = 0;
  if (Math.abs(x) > HALF_EPS) {
    const xsq = x * x;
    xnum = A[4] * xsq;
    xden = xsq;
    for (let i = 0; i < 3; i++) {
      xnum = (xnum + (A[i] as number)) * xsq;
      xden = (xden + (B[i] as number)) * xsq;
    }
  }
  return (x * (xnum + A[3])) / (xden + B[3]);
}

/** y > 0.674 のときの小さい側の確率 Φ(−y)（相対精度を保つ）。 */
function tailProb(y: number): number {
  if (y <= SQRT_32) {
    let xnum = C[8] * y;
    let xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + (C[i] as number)) * y;
      xden = (xden + (D[i] as number)) * y;
    }
    return expHalfSquare(y) * ((xnum + C[7]) / (xden + D[7]));
  }
  if (y < 37.5193) {
    const xsq = 1 / (y * y);
    let xnum = P[5] * xsq;
    let xden = xsq;
    for (let i = 0; i < 4; i++) {
      xnum = (xnum + (P[i] as number)) * xsq;
      xden = (xden + (Q[i] as number)) * xsq;
    }
    const temp = (xsq * (xnum + P[4])) / (xden + Q[4]);
    return expHalfSquare(y) * ((INV_SQRT_2PI - temp) / y);
  }
  return 0;
}

/** 標準正規分布の累積分布 Φ(x)。 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const y = Math.abs(x);
  if (y <= CENTRAL) return 0.5 + centralPart(x);
  const t = tailProb(y);
  return x > 0 ? 1 - t : t;
}

/** 下側と上側の確率 [Φ(x), 1 − Φ(x)] を両方とも相対精度を保って返す。 */
export function normCdfBoth(x: number): [number, number] {
  if (Number.isNaN(x)) return [Number.NaN, Number.NaN];
  const y = Math.abs(x);
  if (y <= CENTRAL) {
    const temp = centralPart(x);
    return [0.5 + temp, 0.5 - temp];
  }
  const t = tailProb(y);
  return x > 0 ? [1 - t, t] : [t, 1 - t];
}

/** 標準正規分布の密度 φ(x)。 */
export function normPdf(x: number): number {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? Number.NaN : 0;
  return INV_SQRT_2PI * expHalfSquare(Math.abs(x));
}

/** 相補誤差関数 erfc(x) = 2 Φ(−x√2)。 */
export function erfc(x: number): number {
  return 2 * normCdf(-x * Math.SQRT2);
}

/** 誤差関数 erf(x) = 1 − erfc(x)（|x| が小さいときは Φ の中心部から直接求めて桁落ちを避ける）。 */
export function erf(x: number): number {
  const t = x * Math.SQRT2;
  if (Math.abs(t) <= CENTRAL) return 2 * centralPart(t);
  const [lower, upper] = normCdfBoth(t);
  return x >= 0 ? 1 - 2 * upper : 2 * lower - 1;
}

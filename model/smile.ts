/**
 * スマイル σ_smile(x)（限月ごと 1 本）。設計 docs/design.md 5.3。
 *
 * - 節点は OTM 側の行だけ（K < F は put、K > F は call、K = F は call と put の平均）
 * - 節点の IV は mid（両側）→ 片側（bid / ask）→ 約定 の順
 * - IV の分解能の帯（価格 ±0.5 円）が 5pt 超、または ask ≤ 5 円の行は不安定として節点から外す
 * - x = ln(K / F)、総分散 w = σ²T を区分線形に補間
 * - 翼は w を端の節点から線形に延ばす。傾きはその翼の側の、端から |Δx| ≤ 0.2 の節点の最小二乗（#268）。
 *   端の節点の凹の折れは (C₀ + C₂)/2 − C₁ の不足 ≤ 1 円まで（F を渡したとき）。その後 Lee の上限 2 以下・端の節点で
 *   K 単調性が崩れない上限以下（かつ w が減らない向き）にクランプ。水平も選べる
 * - 補間後に K 単調性とバタフライ ≥ 0 を検査する
 *
 * 後段で SVI 等に差し替えられるよう、評価は Smile インターフェース越しに行う。
 */

import { black76Price, type OptionType } from './black76';
import { impliedVol, ivResolutionBand } from './iv';
import { normCdf, normPdf } from './normal';
import { optionTick } from './tick';
import { hasTwoSided, type Quote, type StrikeRow } from './types';

export type SmileMark = 'node' | 'interpolated' | 'extrapolated';
export type WingMode = 'slope' | 'flat';
export type IvSource = 'mid' | 'bid' | 'ask' | 'trade';

/** スマイルの補間器（差し替え可能）。x = ln(K/F)。 */
export interface Smile {
  readonly T: number;
  /** 総分散 w(x) = σ(x)² T */
  totalVariance(x: number): number;
  /** σ(x) */
  sigma(x: number): number;
  /** その x が節点・補間・外挿のどれか */
  mark(x: number): SmileMark;
}

export interface SmileNode {
  k: number;
  x: number;
  /** 節点の IV */
  iv: number;
  /** 節点に使った側（K < F は put） */
  type: OptionType;
  source: IvSource;
  bidIv: number | null;
  askIv: number | null;
  midIv: number | null;
  /** 分解能の帯の幅（σ 単位。不明なら null） */
  bandWidth: number | null;
  /** 不安定（帯 > 5pt または ask ≤ 5 円）。不安定な行は補間の節点から外す */
  unstable: boolean;
}

export interface SmileBuildOptions {
  wing?: WingMode;
  /** Lee の上限（既定 2） */
  maxWingSlope?: number;
  /** 不安定の閾値: 分解能の帯の幅（既定 0.05 = 5pt） */
  unstableBandWidth?: number;
  /** 不安定の閾値: ask がこの円以下（既定 5） */
  unstableAsk?: number;
  /** 分解能の帯の価格の半幅（既定 0.5 円） */
  bandHalfWidth?: number;
}

/**
 * 点 (x, w) で K 単調性を保つ総分散の傾きの上限（絶対値）。
 * ∂C/∂K ≤ 0 ⟺ w' ≤ 2√w Φ(d₂)/φ(d₂)、∂P/∂K ≥ 0 ⟺ −w' ≤ 2√w Φ(−d₂)/φ(d₂)（d₂ = −x/√w − √w/2）。
 */
export function wingMonotoneBound(x: number, w: number, side: 'left' | 'right'): number {
  if (!(w > 0)) return 0;
  const sw = Math.sqrt(w);
  const d2 = -x / sw - sw / 2;
  const pdf = normPdf(d2);
  if (!(pdf > 0)) return Number.POSITIVE_INFINITY;
  return (2 * sw * normCdf(side === 'right' ? d2 : -d2)) / pdf;
}

/** 翼の傾きの回帰に使う範囲: 端の節点からの x の幅（x = ln(K/F)。0.2 ≈ 行使価格で ±20%） */
export const WING_FIT_WIDTH = 0.2;

/**
 * 翼の総分散の傾き（クランプ前。#268・docs/design.md 5.3）。xs は昇順。
 * その翼の側（左翼は x < 0、右翼は x > 0）の節点のうち、端の節点から |x − x_端| ≤ width の全部で
 * w を x に最小二乗（等しい重み）で回帰した傾き。端の 2 本の差だと、その 2 本の IV の丸めの誤差（呼値 1 円が
 * IV で数 pt）がそのまま傾きになり、遠い翼の価格が気配の外に大きく外れるため。
 * 範囲の節点が 2 本未満なら端の 2 本の傾き（2 本ちょうどなら回帰と同じ）。節点が 1 本以下なら 0。
 */
export function wingRegressionSlope(
  xs: readonly number[],
  ws: readonly number[],
  side: 'left' | 'right',
  width = WING_FIT_WIDTH,
): number {
  const n = xs.length;
  if (n < 2) return 0;
  const end = side === 'left' ? 0 : n - 1;
  const xe = xs[end] as number;
  let m = 0;
  let sx = 0;
  let sw = 0;
  const inRange = (i: number) => {
    const x = xs[i] as number;
    return (side === 'left' ? x < 0 : x > 0) && Math.abs(x - xe) <= width;
  };
  for (let i = 0; i < n; i++) {
    if (!inRange(i)) continue;
    m++;
    sx += xs[i] as number;
    sw += ws[i] as number;
  }
  if (m >= 2) {
    const mx = sx / m;
    const mw = sw / m;
    let sxx = 0;
    let sxw = 0;
    for (let i = 0; i < n; i++) {
      if (!inRange(i)) continue;
      const dx = (xs[i] as number) - mx;
      sxx += dx * dx;
      sxw += dx * ((ws[i] as number) - mw);
    }
    if (sxx > 0) return sxw / sxx;
  }
  const [a, b] = side === 'left' ? [0, 1] : [n - 2, n - 1];
  return ((ws[b] as number) - (ws[a] as number)) / ((xs[b] as number) - (xs[a] as number));
}

/**
 * 端の節点の凹の折れで許すバタフライの不足（円。#268）。回帰の傾きが端の区間の傾きより緩いと、端の節点で w が凹に
 * 折れ、そこでバタフライ < 0 になる。端の区間と同じ間隔 h の格子（K₀ = Kₙ − h・K₁ = Kₙ・K₂ = Kₙ + h）で、
 * **(C₀ + C₂)/2 − C₁ の不足**をこの円以下に抑える（checkArbitrage・性質テストの 1:−2:1 のバタフライ C₀ − 2C₁ + C₂ では
 * その 2 倍 = 2 円）。合成の板（気配 1〜3 呼値）の比較（docs/design.md 5.3）で、1 円なら裁定の検査の印が端の 2 本の
 * ときより増えず、1.5 円では増えた
 */
export const WING_KINK_YEN = 1;

/**
 * 点 (x, w) で、翼の傾きが端の区間の傾きより Δs 小さい（凹に折れる）ときの ∂C/∂K の跳びは φ(d₂)·Δs / (2√w)
 * （d₂ = −x/√w − √w/2。F φ(d₁) = K φ(d₂) から F によらない。put も同じ。割引前の値で、割引後の跳びは e^{−rT} 倍で
 * これ以下 = 下限は安全側）。跳びを jump 以下にする Δs の上限。
 */
export function wingKinkBound(x: number, w: number, jump: number): number {
  if (!(w > 0)) return 0;
  const sw = Math.sqrt(w);
  const pdf = normPdf(-x / sw - sw / 2);
  if (!(pdf > 0)) return Number.POSITIVE_INFINITY;
  return (2 * sw * jump) / pdf;
}

/** 区分線形の総分散スマイル（MVP）。 */
export class PiecewiseLinearSmile implements Smile {
  readonly T: number;
  private readonly xs: number[];
  private readonly ws: number[];
  private readonly leftSlope: number;
  private readonly rightSlope: number;

  /**
   * 節点 (x, w) は x の昇順・重複なし。1 点以上。forward（F。円）を渡すと、端の節点の凹の折れによるバタフライ
   * (C₀ + C₂)/2 − C₁ の不足を WING_KINK_YEN 以下に抑える（翼の傾きの下限）。渡さなければ下限なし（回帰の傾きのまま）
   */
  constructor(
    points: ReadonlyArray<{ x: number; w: number }>,
    T: number,
    wing: WingMode = 'slope',
    maxSlope = 2,
    forward?: number,
  ) {
    if (points.length === 0) throw new Error('スマイルの節点が 0 個');
    const sorted = [...points].sort((a, b) => a.x - b.x);
    this.xs = sorted.map((p) => p.x);
    this.ws = sorted.map((p) => p.w);
    this.T = T;
    const n = sorted.length;
    if (wing === 'flat' || n < 2) {
      this.leftSlope = 0;
      this.rightSlope = 0;
    } else {
      // 傾きは翼の側の複数の節点の回帰（wingRegressionSlope。#268）で、端の節点から延ばす（補間と連続）。
      const xa = this.xs;
      const wa = this.ws;
      const segL =
        ((wa[1] as number) - (wa[0] as number)) / ((xa[1] as number) - (xa[0] as number));
      const segR =
        ((wa[n - 1] as number) - (wa[n - 2] as number)) /
        ((xa[n - 1] as number) - (xa[n - 2] as number));
      // 下限: 端の節点の凹の折れ（回帰の傾きが端の区間より緩い）による (C₀ + C₂)/2 − C₁ の不足を、端の区間の間隔
      // h（円）の格子で WING_KINK_YEN 以下に（不足 ≈ h × ∂C/∂K の跳び / 2。1:−2:1 では 2 倍）。端の区間の傾きは丸めの雑音を含むので、
      // 下限を強くすると端の 2 本の問題が戻る（呼値 1 本が、裁定の印を増やさない範囲で最も緩い）
      const kink = (i: number, j: number) => {
        if (forward === undefined || !(forward > 0)) return Number.POSITIVE_INFINITY;
        const h = forward * Math.abs(Math.exp(xa[j] as number) - Math.exp(xa[i] as number));
        return wingKinkBound(xa[i] as number, wa[i] as number, (2 * WING_KINK_YEN) / h);
      };
      const sL = Math.min(wingRegressionSlope(xa, wa, 'left'), segL + kink(0, 1));
      const sR = Math.max(wingRegressionSlope(xa, wa, 'right'), segR - kink(n - 1, n - 2));
      // 左翼は x が減ると w が増える向き（傾き ≤ 0）、右翼は増える向き（傾き ≥ 0）だけを延ばし、|傾き| ≤ 2。
      // さらに端の節点で K 単調性が崩れない傾き（wingMonotoneBound）以下にする。Lee の上限 2 は
      // x → ∞ の漸近条件で、満期の短い限月では端の近くで call 価格が K に増加することがあるため
      const x0 = this.xs[0] as number;
      const xn = this.xs[n - 1] as number;
      const leftCap = Math.min(maxSlope, wingMonotoneBound(x0, this.ws[0] as number, 'left'));
      const rightCap = Math.min(maxSlope, wingMonotoneBound(xn, this.ws[n - 1] as number, 'right'));
      this.leftSlope = Math.min(0, Math.max(sL, -leftCap));
      this.rightSlope = Math.max(0, Math.min(sR, rightCap));
    }
  }

  get nodes(): ReadonlyArray<{ x: number; w: number }> {
    return this.xs.map((x, i) => ({ x, w: this.ws[i] as number }));
  }

  totalVariance(x: number): number {
    const xs = this.xs;
    const ws = this.ws;
    const n = xs.length;
    const x0 = xs[0] as number;
    const xn = xs[n - 1] as number;
    if (x <= x0) return Math.max((ws[0] as number) + this.leftSlope * (x - x0), 0);
    if (x >= xn) return Math.max((ws[n - 1] as number) + this.rightSlope * (x - xn), 0);
    // 二分探索で区間 [xs[i], xs[i+1]]
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((xs[mid] as number) <= x) lo = mid;
      else hi = mid;
    }
    const xa = xs[lo] as number;
    const xb = xs[hi] as number;
    const t = (x - xa) / (xb - xa);
    return (ws[lo] as number) * (1 - t) + (ws[hi] as number) * t;
  }

  sigma(x: number): number {
    return Math.sqrt(this.totalVariance(x) / this.T);
  }

  mark(x: number): SmileMark {
    const xs = this.xs;
    const n = xs.length;
    const tol = 1e-12;
    if (x < (xs[0] as number) - tol || x > (xs[n - 1] as number) + tol) return 'extrapolated';
    for (const xi of xs) if (Math.abs(xi - x) <= tol) return 'node';
    return 'interpolated';
  }
}

function ivOf(
  type: OptionType,
  price: number | null | undefined,
  F: number,
  K: number,
  T: number,
  r: number,
) {
  if (price === null || price === undefined || !(price > 0)) return null;
  const res = impliedVol(type, price, F, K, T, r);
  return res.ok ? res.sigma : null;
}

/** 1 つの行・1 つの側から節点の候補を作る（不安定の判定込み）。 */
export function buildNode(
  k: number,
  type: OptionType,
  q: Quote,
  F: number,
  T: number,
  r: number,
  opts: SmileBuildOptions = {},
): SmileNode | null {
  const bandLimit = opts.unstableBandWidth ?? 0.05;
  const askLimit = opts.unstableAsk ?? 5;
  const half = opts.bandHalfWidth ?? 0.5;
  const bidIv = ivOf(type, q.bid, F, k, T, r);
  const askIv = ivOf(type, q.ask, F, k, T, r);
  const mid = hasTwoSided(q) ? (q.bid + q.ask) / 2 : null;
  const midIv = ivOf(type, mid, F, k, T, r);
  let iv: number | null = null;
  let source: IvSource = 'mid';
  let price: number | null = null;
  if (midIv !== null) {
    iv = midIv;
    price = mid;
  } else if (bidIv !== null && q.bid) {
    iv = bidIv;
    source = 'bid';
    price = q.bid;
  } else if (askIv !== null && q.ask) {
    iv = askIv;
    source = 'ask';
    price = q.ask;
  } else {
    const lastIv = ivOf(type, q.last, F, k, T, r);
    if (lastIv !== null && q.last) {
      iv = lastIv;
      source = 'trade';
      price = q.last;
    }
  }
  if (iv === null || price === null) return null;
  const band = ivResolutionBand(type, price, F, k, T, r, half);
  const bandWidth = band ? band.width : null;
  const unstable =
    bandWidth === null ||
    bandWidth > bandLimit ||
    (q.ask !== null && q.ask !== undefined && q.ask <= askLimit);
  return { k, x: Math.log(k / F), iv, type, source, bidIv, askIv, midIv, bandWidth, unstable };
}

export interface SmileFit {
  smile: Smile;
  /** OTM 側の全行（不安定な行も含む。K の昇順） */
  nodes: SmileNode[];
}

/**
 * K = F の行の節点: 安定な側だけで平均する。片側だけ安定ならその側、両方不安定なら
 * 両側の平均を不安定として残す。片側しか作れなければその側。
 */
export function atTheForwardNode(c: SmileNode | null, p: SmileNode | null): SmileNode | null {
  if (!c || !p) return c ?? p;
  if (!c.unstable && !p.unstable) return { ...c, iv: (c.iv + p.iv) / 2 };
  if (!c.unstable) return c;
  if (!p.unstable) return p;
  return { ...c, iv: (c.iv + p.iv) / 2, unstable: true };
}

/**
 * 板の 1 限月分から OTM 側のスマイルを作る。安定な節点が 1 つも無ければ null。
 */
export function buildSmile(
  rows: readonly StrikeRow[],
  F: number,
  T: number,
  r: number,
  opts: SmileBuildOptions = {},
): SmileFit | null {
  const nodes: SmileNode[] = [];
  for (const row of [...rows].sort((a, b) => a.k - b.k)) {
    if (row.k < F) {
      const n = buildNode(row.k, 'put', row.put, F, T, r, opts);
      if (n) nodes.push(n);
    } else if (row.k > F) {
      const n = buildNode(row.k, 'call', row.call, F, T, r, opts);
      if (n) nodes.push(n);
    } else {
      const pick = atTheForwardNode(
        buildNode(row.k, 'call', row.call, F, T, r, opts),
        buildNode(row.k, 'put', row.put, F, T, r, opts),
      );
      if (pick) nodes.push(pick);
    }
  }
  const stable = nodes.filter((n) => !n.unstable);
  if (stable.length === 0) return null;
  const smile = new PiecewiseLinearSmile(
    stable.map((n) => ({ x: n.x, w: n.iv * n.iv * T })),
    T,
    opts.wing ?? 'slope',
    opts.maxWingSlope ?? 2,
    F,
  );
  return { smile, nodes };
}

export interface StrikeIv {
  k: number;
  iv: number;
  mark: SmileMark;
  /** その行が節点候補として不安定だったか（節点が無い行は false） */
  unstable: boolean;
}

/** 各行使価格でのスマイルの IV と印（節点 / 補間 / 外挿）。 */
export function smileAtStrikes(fit: SmileFit, strikes: readonly number[], F: number): StrikeIv[] {
  const byK = new Map(fit.nodes.map((n) => [n.k, n]));
  return strikes.map((k) => {
    const x = Math.log(k / F);
    const node = byK.get(k);
    return {
      k,
      iv: fit.smile.sigma(x),
      mark: fit.smile.mark(x),
      unstable: node?.unstable ?? false,
    };
  });
}

export interface ArbitrageViolation {
  kind: 'call_monotonic' | 'put_monotonic' | 'butterfly';
  /** 違反した行使価格（バタフライは中央） */
  k: number;
  /** 違反の大きさ（円） */
  amount: number;
  /** 許容（関係する行の bid–ask 幅の和の半分。気配が無い行は呼値） */
  allowance: number;
}

/**
 * 補間後のスマイルで、行使価格の列について K 単調性（call は減少、put は増加）と
 * バタフライ ≥ 0（call 価格の K に対する凸性）を検査する（設計 5.3・13.4）。
 *
 * 違反とするのは、違反量が「関係する行の bid–ask 幅の和の半分」を超えるときだけ。
 * 幅はスマイルの節点と同じ OTM 側（K < F は put、それ以外は call）の気配で測り、両側気配が
 * 無い行（板に無い行使価格を含む）はその行の理論価格での呼値を使う。
 * バタフライの量は λ = (K₂ − K₁)/(K₂ − K₀) として 2 × (λC₀ + (1 − λ)C₂ − C₁) の符号を反転したもの
 * （等間隔なら C₀ − 2C₁ + C₂ の不足分）。
 */
export function checkArbitrage(
  smile: Smile,
  strikes: readonly number[],
  F: number,
  T: number,
  r: number,
  quotes: readonly StrikeRow[] = [],
): ArbitrageViolation[] {
  const ks = [...new Set(strikes)].sort((a, b) => a - b);
  const byK = new Map(quotes.map((q) => [q.k, q]));
  const call = ks.map((k) => black76Price('call', F, k, T, smile.sigma(Math.log(k / F)), r));
  const put = ks.map((k) => black76Price('put', F, k, T, smile.sigma(Math.log(k / F)), r));
  const width = ks.map((k, i) => {
    const row = byK.get(k);
    const q = row ? (k < F ? row.put : row.call) : null;
    if (q && hasTwoSided(q)) return q.ask - q.bid;
    return optionTick((k < F ? put[i] : call[i]) as number);
  });
  const w = (i: number) => width[i] as number;
  const out: ArbitrageViolation[] = [];
  for (let i = 1; i < ks.length; i++) {
    const allowance = (w(i - 1) + w(i)) / 2;
    const dc = (call[i] as number) - (call[i - 1] as number);
    if (dc > allowance) {
      out.push({ kind: 'call_monotonic', k: ks[i] as number, amount: dc, allowance });
    }
    const dp = (put[i] as number) - (put[i - 1] as number);
    if (-dp > allowance) {
      out.push({ kind: 'put_monotonic', k: ks[i] as number, amount: -dp, allowance });
    }
  }
  for (let i = 1; i + 1 < ks.length; i++) {
    const k0 = ks[i - 1] as number;
    const k1 = ks[i] as number;
    const k2 = ks[i + 1] as number;
    const lambda = (k2 - k1) / (k2 - k0);
    const fly =
      2 *
      (lambda * (call[i - 1] as number) +
        (1 - lambda) * (call[i + 1] as number) -
        (call[i] as number));
    const allowance = (w(i - 1) + w(i) + w(i + 1)) / 2;
    if (-fly > allowance) out.push({ kind: 'butterfly', k: k1, amount: -fly, allowance });
  }
  return out;
}

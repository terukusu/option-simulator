/**
 * グラフの座標（DOM を持たない純関数）。スマイル（#5）と損益グラフ（#11）で共用する。
 * 描画（SVG）とは分け、描画面を差し替えても座標・目盛り・拡大の規則は変えない。
 */

export type Domain = readonly [number, number];

/** 線形スケール: domain → range。domain の幅が 0 なら range の中央に置く。 */
export function linear(domain: Domain, range: Domain): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (!(Math.abs(span) > 0) || !Number.isFinite(span)) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const k = (r1 - r0) / span;
  return (v) => r0 + (v - d0) * k;
}

/** 1・2・5 × 10^n のきりのよい刻み。 */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !Number.isFinite(span) || !(count > 0)) return 0;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** [lo, hi] に入るきりのよい目盛り（おおよそ count 本）。 */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  const step = niceStep(hi - lo, count);
  if (step === 0) return [lo];
  return stepTicks(lo, hi, step);
}

export interface FitTicksOptions {
  /** 刻みの仮数の候補（昇順、1 以上 10 未満）。既定は 1・2・5 */
  mantissas?: readonly number[];
  /** この刻み未満では使わない仮数（例: 2.5 は 10 以上だけ）。仮数ごとの下限 */
  minStepFor?: (mantissa: number) => number;
  /** ラベルの間の最小の余白（px） */
  gapPx?: number;
  /**
   * ラベルの幅の見積もりに加える値（グラフの全域の両端など）。刻みの格子に丸めてからラベルにする。
   * 表示中の目盛りだけで見積もると、範囲の幅を変えずにパンしただけで桁数が変わって刻みが切り替わる（ちらつく）ので、
   * 全域の両端を入れて「幅と全域だけで刻みが決まる」ようにする
   */
  widthSample?: readonly number[];
}

/** ラベルの間の余白の既定（px） */
export const TICK_GAP_PX = 12;

/**
 * 目盛りのラベルの推定幅（px）。グラフの文字は 10px（style.css）。数字は約 0.56em、カンマ・ピリオドは約 0.28em、
 * それ以外（%・+・−・P・C・空白）は 0.65em と見積もる（% 単体は実際より狭いが、+・空白を広めに取るので
 * 「+12.5%」でも誤差は 1px 程度。余白 12px で吸収する）。
 */
export function tickLabelPx(label: string): number {
  let w = 0;
  for (const c of label) w += c >= '0' && c <= '9' ? 5.8 : c === ',' || c === '.' ? 3 : 6.5;
  return w;
}

/**
 * 横軸の目盛り: ラベルが重ならない範囲で最も細かい、きりのよい刻み（#55）。
 * 刻みは「仮数 × 10^n」を細かい方から試し、画面上の間隔（step / 幅 × px）が「最も広いラベルの推定幅（tickLabelPx）+ 余白」以上になる
 * 最初のものにする。本数はグラフの幅で決まる（広い画面ほど細かい）。仮数の比が最大 2.5（1・2・5）/ 2（1・2・2.5・5）なので、
 * 間隔は通常、必要な幅の 2.5 倍未満に収まる（minStepFor の下限で切られたときを除く）。
 */
export function fitTicks(
  lo: number,
  hi: number,
  px: number,
  label: (v: number) => string,
  opts: FitTicksOptions = {},
): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(px > 0) || !Number.isFinite(px)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const mantissas = opts.mantissas ?? [1, 2, 5];
  const gapPx = opts.gapPx ?? TICK_GAP_PX;
  // 1 画素あたりの値より細かい刻みは要らない（そこから粗い方へ試す）
  const e0 = Math.floor(Math.log10(span / px));
  let last: number[] = [lo];
  for (let e = e0; e < e0 + 40; e++) {
    for (const m of mantissas) {
      // 10^e を毎回求める（掛け算の繰り返しで誤差をためない）。負の指数は割り算で 0.1 などをちょうどにする
      const step = e >= 0 ? m * 10 ** e : m / 10 ** -e;
      if (opts.minStepFor && step < opts.minStepFor(m)) continue;
      const stepPx = (step / span) * px;
      // 余白にも足りない刻みはラベルを作らずに飛ばす（ドラッグ中の毎フレームの計算を軽くする）
      if (stepPx < gapPx) continue;
      const ticks = stepTicks(lo, hi, step);
      last = ticks;
      let widest = ticks.reduce((w, v) => Math.max(w, tickLabelPx(label(v))), 0);
      for (const v of opts.widthSample ?? []) {
        if (Number.isFinite(v)) widest = Math.max(widest, tickLabelPx(label(snapTo(v, step))));
      }
      if (stepPx >= widest + gapPx) return ticks;
    }
  }
  return last;
}

/** step の格子に丸めた値（浮動小数の誤差を刻みの桁で落とす）。 */
function snapTo(v: number, step: number): number {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number((Math.round(v / step) * step).toFixed(digits));
}

/** [lo, hi] に入る step の倍数（最大 101 個で打ち切る。間隔は 12px 以上なので、描画幅 1,200px 超でないと届かない）。 */
function stepTicks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    // 浮動小数の誤差を刻みの桁で丸める
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    out.push(Number(v.toFixed(digits)));
    if (out.length > 100) break;
  }
  return out;
}

/** 値の列の範囲（有限値だけ）。無ければ null。 */
export function extent(values: Iterable<number>): Domain | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** 範囲に余白を足す（幅 0 なら pad の絶対値で広げる）。 */
export function padDomain(d: Domain, ratio: number, minPad = 0): Domain {
  const pad = Math.max((d[1] - d[0]) * ratio, minPad);
  return [d[0] - pad, d[1] + pad];
}

/**
 * 表示範囲を全域に収める（拡大・パン・ピンチの共通の規則）。
 * 幅を [min(minWidth, 全幅), 全幅] に収め（幅を変えるときは中心を保つ）、全域の外に出ないよう平行移動する。
 * 幅を変えないときは端の値をそのまま保つ（カーソル固定の拡大で anchor の画素をずらさない）。
 */
export function clampViewport(viewport: Domain, full: Domain, minWidth = 0): Domain {
  const fullWidth = full[1] - full[0];
  if (!(fullWidth > 0) || !Number.isFinite(fullWidth)) return full;
  let lo = Math.min(viewport[0], viewport[1]);
  let hi = Math.max(viewport[0], viewport[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return full;
  const width = hi - lo;
  const minW = Math.min(Math.max(minWidth, 0), fullWidth);
  if (width >= fullWidth) return full;
  if (width < minW) {
    const center = (lo + hi) / 2;
    lo = center - minW / 2;
    hi = center + minW / 2;
  }
  if (lo < full[0]) {
    hi += full[0] - lo;
    lo = full[0];
  }
  if (hi > full[1]) {
    lo -= hi - full[1];
    hi = full[1];
  }
  return [Math.max(lo, full[0]), Math.min(hi, full[1])];
}

/**
 * ボタンでの拡大・縮小: 中心を固定して幅を factor 倍（< 1 で拡大）。
 * 幅は [minWidth, full の幅] に収め、full の外に出ないよう平行移動する。
 */
export function zoom(viewport: Domain, factor: number, full: Domain, minWidth = 0): Domain {
  const center = (viewport[0] + viewport[1]) / 2;
  const half = ((viewport[1] - viewport[0]) * factor) / 2;
  return clampViewport([center - half, center + half], full, minWidth);
}

/**
 * カーソル位置（anchor の値）を固定した拡大・縮小（ホイール）。幅は factor 倍（< 1 で拡大）。
 * 幅が上限・下限に当たっても anchor の相対位置は保ち、全域の端に当たったときだけ平行移動する。
 */
export function zoomAt(
  viewport: Domain,
  factor: number,
  anchor: number,
  full: Domain,
  minWidth = 0,
): Domain {
  const fullWidth = full[1] - full[0];
  const [lo, hi] = viewport;
  const width = hi - lo;
  if (!(fullWidth > 0) || !(width > 0) || !(factor > 0) || !Number.isFinite(anchor)) {
    return clampViewport(viewport, full, minWidth);
  }
  const minW = Math.min(Math.max(minWidth, 0), fullWidth);
  const next = Math.min(Math.max(width * factor, minW), fullWidth);
  const t = (anchor - lo) / width;
  const nlo = anchor - t * next;
  return clampViewport([nlo, nlo + next], full, minWidth);
}

/** 幅を保った平行移動（delta は値の単位。正で右 = 大きい値の側へ）。全域で止まる。 */
export function panBy(viewport: Domain, delta: number, full: Domain): Domain {
  if (!Number.isFinite(delta)) return clampViewport(viewport, full);
  return clampViewport([viewport[0] + delta, viewport[1] + delta], full);
}

/** 画素 → 値（linear の逆）。range の幅が 0 なら domain の下端。 */
export function pixelToValue(domain: Domain, range: Domain, px: number): number {
  const span = range[1] - range[0];
  if (!(Math.abs(span) > 0)) return domain[0];
  return domain[0] + ((px - range[0]) * (domain[1] - domain[0])) / span;
}

/**
 * ピンチ: 開始時の表示範囲 start で 2 本の指の画素 startPx にあった値が、現在の画素 curPx に来る範囲。
 * 指の間隔が 1px 未満（重なった・交差した）なら 2 点の中点の移動だけのパンにする。
 * 幅の上限・下限に当たったら指の中点の値を保って収め、全域の端では平行移動する。
 */
export function pinchViewport(
  start: Domain,
  startPx: readonly [number, number],
  curPx: readonly [number, number],
  range: Domain,
  full: Domain,
  minWidth = 0,
): Domain {
  const [a0, b0] = startPx;
  const [a1, b1] = curPx;
  const rangeWidth = range[1] - range[0];
  const perPx = rangeWidth !== 0 ? (start[1] - start[0]) / rangeWidth : 0;
  const pan = () => panBy(start, -(((a1 + b1) / 2 - (a0 + b0) / 2) * perPx), full);
  if (Math.abs(b0 - a0) < 1 || Math.abs(b1 - a1) < 1 || !(rangeWidth > 0)) return pan();
  const va = pixelToValue(start, range, a0);
  const vb = pixelToValue(start, range, b0);
  const s = (vb - va) / (b1 - a1); // 1 画素あたりの値
  if (!(s > 0) || !Number.isFinite(s)) return pan();
  let lo = va - (a1 - range[0]) * s;
  let width = rangeWidth * s;
  const fullWidth = full[1] - full[0];
  const minW = Math.min(Math.max(minWidth, 0), fullWidth);
  const clamped = Math.min(Math.max(width, minW), fullWidth);
  if (clamped !== width) {
    // 指の中点の値を保って幅を収める
    const mPx = (a1 + b1) / 2;
    const mv = lo + (mPx - range[0]) * s;
    width = clamped;
    lo = mv - ((mPx - range[0]) / rangeWidth) * width;
  }
  return clampViewport([lo, lo + width], full, minWidth);
}

/** ホイールの倍率: exp(deltaY_px × 0.002) を [0.5, 2] に収める（deltaMode 1 = 行 ×16px、2 = ページ）。 */
export const WHEEL_RATE = 0.002;
export function wheelFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  if (!Number.isFinite(px)) return 1;
  return Math.min(Math.max(Math.exp(px * WHEEL_RATE), 0.5), 2);
}

/** 線分 [a, b] を範囲 [lo, hi] に切る（x で切り、y は線形に補間）。範囲に掛からなければ null。 */
export function clipSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lo: number,
  hi: number,
): [number, number, number, number] | null {
  const flip = x2 < x1;
  let ax = flip ? x2 : x1;
  let ay = flip ? y2 : y1;
  let bx = flip ? x1 : x2;
  let by = flip ? y1 : y2;
  if (bx < lo || ax > hi) return null;
  const at = (x: number) => (bx === ax ? ay : ay + ((by - ay) * (x - ax)) / (bx - ax));
  if (ax < lo) {
    ay = at(lo);
    ax = lo;
  }
  if (bx > hi) {
    by = at(hi);
    bx = hi;
  }
  return flip ? [bx, by, ax, ay] : [ax, ay, bx, by];
}

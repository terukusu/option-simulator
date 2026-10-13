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
 * ボタンでの拡大・縮小: 中心を固定して幅を factor 倍（< 1 で拡大）。
 * 幅は [minWidth, full の幅] に収め、full の外に出ないよう平行移動する。
 */
export function zoom(viewport: Domain, factor: number, full: Domain, minWidth = 0): Domain {
  const fullWidth = full[1] - full[0];
  if (!(fullWidth > 0)) return full;
  const center = (viewport[0] + viewport[1]) / 2;
  const width = Math.min(
    Math.max((viewport[1] - viewport[0]) * factor, Math.min(minWidth, fullWidth)),
    fullWidth,
  );
  let lo = center - width / 2;
  let hi = center + width / 2;
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
